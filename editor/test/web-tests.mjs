// The web layer's T0 (docs/editor-ts-react-plan.md): the React store, the pure UI helpers the
// components use, the zod request schemas shared by the web server and the browser client, and
// the server's request gate (a bad body is a 400 with zod issues, never a stack trace).
// Node built-ins only; the browser-side modules under test are pure TS that Node runs directly.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EDITOR = join(HERE, "..");

/** A failing import becomes a failing test, not a crashed runner. @param {string} rel */
async function load(rel) {
  try {
    return await import(rel);
  } catch (e) {
    return { __error: String(e instanceof Error ? e.message : e) };
  }
}

/** Every POST route the web server accepts; each needs a body schema in src/core/api-schemas. */
export const POST_ROUTES = [
  "/api/write",
  "/api/validate",
  "/api/preview",
  "/api/template",
  "/api/art/scene",
  "/api/art/new-scene",
  "/api/art/validate",
  "/api/art/import-svg",
  "/api/art/build",
  "/api/art/asset",
  "/api/art/prepare-swf-gate",
];

/**
 * Start web/server.mjs on an OS-chosen port and return { port, stop }.
 * @returns {Promise<{port:number, stop:()=>void, stderr:string}>}
 */
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.argv[0], [join(EDITOR, "web", "server.mjs")], {
      env: { ...process.env, PORT: "0" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server did not announce a port within 10 s; stderr: ${err.slice(0, 300)}`));
    }, 10_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      err += chunk;
      const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(err);
      if (m && Number(m[1]) > 0) {
        clearTimeout(timer);
        resolve({ port: Number(m[1]), stop: () => child.kill(), stderr: err });
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (${code}): ${err.slice(0, 300)}`));
    });
  });
}

/**
 * @param {(name: string, fn: () => void) => void} test
 * @param {(cond: boolean, msg: string) => void} assert
 * @param {(a: unknown, b: unknown, msg?: string) => void} eq
 */
export async function runWebTests(test, assert, eq) {
  console.log("\n# web layer: React store, pure UI helpers, zod request schemas, server request gate");

  // ---- store ------------------------------------------------------------------
  const store = await load("../web/src/store.ts");
  test("web/src/store.ts loads (Node runs the TS source directly)", () => assert(!store.__error, store.__error));
  test("createStore: get() returns the initial state", () => {
    const s = store.createStore({ a: 1, b: "x" });
    eq(s.get().a, 1);
    eq(s.get().b, "x");
  });
  test("createStore: set(patch) merges, keeps untouched keys and notifies each subscriber once", () => {
    const s = store.createStore({ a: 1, b: "x" });
    let n = 0;
    s.subscribe(() => n++);
    s.set({ a: 2 });
    eq(s.get().a, 2);
    eq(s.get().b, "x");
    eq(n, 1, "notifications");
  });
  test("createStore: a patch that changes no key does not notify (same-value dedupe, as van.state did)", () => {
    const s = store.createStore({ a: 1 });
    let n = 0;
    s.subscribe(() => n++);
    s.set({ a: 1 });
    eq(n, 0);
  });
  test("createStore: set(fn) sees the current state; unsubscribe stops notifications; get() is a new object after a change", () => {
    const s = store.createStore({ a: 1 });
    const before = s.get();
    let n = 0;
    const off = s.subscribe(() => n++);
    s.set((/** @type {{a:number}} */ cur) => ({ a: cur.a + 10 }));
    eq(s.get().a, 11);
    assert(s.get() !== before, "state identity must change so React sees the update");
    off();
    s.set({ a: 12 });
    eq(n, 1);
  });

  // ---- pure UI helpers ----------------------------------------------------------
  const hl = await load("../web/src/gon-highlight.ts");
  test("web/src/gon-highlight.ts loads", () => assert(!hl.__error, hl.__error));
  test("highlightGon: stripping the spans gives back the escaped input (nothing is ever hidden)", () => {
    const src = 'Foo { variant_of = "Spin" // c <b>\n  x = -1.5e3; y = [1, 2] }\n';
    const out = hl.highlightGon(src);
    const stripped = out.replace(/<span class="[a-z]+">/g, "").replace(/<\/span>/g, "");
    eq(stripped, src.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
  });
  test("highlightGon: keyword kw, Capitalized cls, string s, number n, comment c, punctuation p, other k", () => {
    const out = hl.highlightGon('Foo { variant_of = "Spin" // c\n x = -1.5 }');
    assert(out.includes('<span class="cls">Foo</span>'), "cls");
    assert(out.includes('<span class="kw">variant_of</span>'), "kw");
    assert(out.includes('<span class="s">&quot;Spin&quot;</span>') || out.includes('<span class="s">"Spin"</span>'), "s");
    assert(out.includes('<span class="c">// c</span>'), "c");
    assert(out.includes('<span class="n">-1.5</span>'), "n");
    assert(out.includes('<span class="p">{</span>'), "p");
    assert(out.includes('<span class="k">x</span>'), "k");
  });
  const tree = await load("../web/src/tree.ts");
  test("web/src/tree.ts loads", () => assert(!tree.__error, tree.__error));
  test("buildTree: nests by '/', keeps leaf names and the original fields, preserves order", () => {
    const t = tree.buildTree([
      { relPath: "abilities/a.gon.append", mode: "append" },
      { relPath: "text/combined.csv", mode: "replace" },
      { relPath: "abilities/b.gon", mode: "replace" },
      { relPath: "mod.gon", mode: "replace" },
    ]);
    eq([...t.dirs.keys()].join(","), "abilities,text");
    eq(t.files.map((/** @type {any} */ f) => f.leaf).join(","), "mod.gon");
    const ab = t.dirs.get("abilities");
    eq(ab.path, "abilities");
    eq(ab.files.map((/** @type {any} */ f) => f.leaf).join(","), "a.gon.append,b.gon");
    eq(ab.files[0].mode, "append");
    eq(ab.files[0].relPath, "abilities/a.gon.append");
  });

  // ---- zod request schemas (shared by web/server.mjs and the browser client) ----
  const sch = await load("../src/core/api-schemas.ts");
  test("src/core/api-schemas.ts loads", () => assert(!sch.__error, sch.__error));
  test("api-schemas: every POST route has a body schema (API_BODY)", () => {
    for (const r of POST_ROUTES) assert(!!(sch.API_BODY && sch.API_BODY[r]), `missing schema for ${r}`);
    eq(Object.keys(sch.API_BODY).length, POST_ROUTES.length, "no unknown routes");
  });
  test("api-schemas: /api/write needs mod, path, content as strings; the issues name each missing key", () => {
    const r = sch.API_BODY["/api/write"].safeParse({});
    assert(!r.success, "empty body must fail");
    const paths = r.error.issues.map((/** @type {any} */ i) => i.path.join(".")).sort().join(",");
    eq(paths, "content,mod,path");
    const ok = sch.API_BODY["/api/write"].safeParse({ mod: "m", path: "abilities/x.gon.append", content: "X {}" });
    assert(ok.success, "valid body");
    const bad = sch.API_BODY["/api/write"].safeParse({ mod: "m", path: 1, content: "" });
    assert(!bad.success, "path must be a string");
  });
  test("api-schemas: /api/validate takes {mod} alone or {mod, path, text}; path without text is rejected", () => {
    const s = sch.API_BODY["/api/validate"];
    assert(s.safeParse({ mod: "m" }).success, "mod alone");
    assert(s.safeParse({ mod: "m", path: "a.gon", text: "A {}" }).success, "override pair");
    assert(!s.safeParse({ mod: "m", path: "a.gon" }).success, "path without text");
    assert(!s.safeParse({}).success, "mod required");
  });
  test("api-schemas: /api/template defaults options to {} and requires mod, kind, name", () => {
    const s = sch.API_BODY["/api/template"];
    const r = s.safeParse({ mod: "m", kind: "ability", name: "Foo" });
    assert(r.success, "minimal");
    eq(JSON.stringify(r.data.options), "{}");
    assert(!s.safeParse({ mod: "m", kind: "ability" }).success, "name required");
  });
  test("api-schemas: /api/art/build: mod + path required; dryRun/writeSwflist booleans; abc string; scene any object", () => {
    const s = sch.API_BODY["/api/art/build"];
    assert(s.safeParse({ mod: "m", path: "art/a.scene.json" }).success, "minimal");
    assert(s.safeParse({ mod: "m", path: "p", dryRun: true, abc: "none", scene: { shapes: [] } }).success, "full");
    assert(!s.safeParse({ mod: "m", path: "p", dryRun: "yes" }).success, "dryRun must be boolean");
  });
  test("api-schemas: /api/art/asset needs a base64 string; /api/art/prepare-swf-gate takes an optional mod and variant", () => {
    assert(sch.API_BODY["/api/art/asset"].safeParse({ mod: "m", path: "art/x.svg", base64: "AA==" }).success, "asset ok");
    assert(!sch.API_BODY["/api/art/asset"].safeParse({ mod: "m", path: "art/x.svg" }).success, "base64 required");
    const g = sch.API_BODY["/api/art/prepare-swf-gate"].safeParse({});
    assert(g.success, "gate: everything optional");
    eq(g.data.variant, "flat", "gate: variant defaults to flat");
  });

  // ---- server request gate (spawns web/server.mjs on an OS-chosen port) --------------
  /** @type {{port:number, stop:()=>void, stderr:string}|null} */
  let srv = null;
  try {
    srv = await startServer();
  } catch (e) {
    test("web/server.mjs starts on PORT=0 and announces the bound port on stderr", () => assert(false, String(e instanceof Error ? e.message : e)));
  }
  if (srv) {
    const base = `http://127.0.0.1:${srv.port}`;
    /** @type {{status:number, json:any, text:string}} */
    let w = { status: 0, json: null, text: "" };
    try {
      const r = await fetch(`${base}/api/write`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      w = { status: r.status, text: await r.text(), json: null };
      try { w.json = JSON.parse(w.text); } catch { /* asserted below */ }
    } catch (e) {
      w.text = String(e instanceof Error ? e.message : e);
    }
    test("server: POST /api/write with {} is a 400 whose JSON names the missing keys in `issues` (zod gate)", () => {
      eq(w.status, 400, `status (body: ${w.text.slice(0, 200)})`);
      assert(w.json && typeof w.json.error === "string", "error string");
      assert(Array.isArray(w.json.issues), "issues array");
      const paths = w.json.issues.map((/** @type {any} */ i) => (i.path || []).join(".")).sort().join(",");
      eq(paths, "content,mod,path");
    });
    /** @type {{status:number, text:string}} */
    let nf = { status: 0, text: "" };
    try {
      const r = await fetch(`${base}/api/nope`);
      nf = { status: r.status, text: await r.text() };
    } catch (e) {
      nf.text = String(e instanceof Error ? e.message : e);
    }
    test("server: an unknown /api route is a 404 JSON error", () => {
      eq(nf.status, 404, nf.text.slice(0, 200));
    });
    const dist = join(EDITOR, "web", "dist", "index.html");
    if (existsSync(dist)) {
      /** @type {{status:number, text:string}} */
      let idx = { status: 0, text: "" };
      try {
        const r = await fetch(`${base}/`);
        idx = { status: r.status, text: await r.text() };
      } catch (e) {
        idx.text = String(e instanceof Error ? e.message : e);
      }
      test("server: GET / serves the Vite build (web/dist/index.html), not the source page", () => {
        eq(idx.status, 200);
        eq(idx.text, readFileSync(dist, "utf8"));
      });
    } else {
      console.log("  (skipped: web/dist/index.html missing — run `npm run build` to test the served page)");
    }
    srv.stop();
  }
}
