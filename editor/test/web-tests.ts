// The web layer's T0 (docs/editor-ts-react-plan.md): the React store, the pure UI helpers the
// components use, the zod request schemas shared by the web server and the browser client, and
// the server's request gate (a bad body is a 400 with zod issues, never a stack trace).
// Node built-ins only; the browser-side modules under test are pure TS that Node runs directly.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const EDITOR = join(HERE, "..");

/** A failing import becomes a failing test, not a crashed runner. The module is read loosely on purpose. */
async function load(rel: string): Promise<Record<string, any> & { __error?: string }> {
  try {
    return (await import(rel)) as Record<string, any>;
  } catch (e) {
    return { __error: String(e instanceof Error ? e.message : e) };
  }
}

interface ServerHandle {
  port: number;
  stop: () => Promise<void>;
  stderr: string;
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
  "/api/art/import-bitmap",
  "/api/art/export-svg",
  "/api/art/build",
  "/api/art/asset",
  "/api/art/prepare-swf-gate",
  "/api/mod/pack",
  "/api/mod/install",
  "/api/level",
  "/api/level/validate",
];

/** Start web/server.ts on an OS-chosen port and return { port, stop }. */
function startServer(): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.argv[0], [join(EDITOR, "web", "server.ts")], {
      env: { ...process.env, PORT: "0" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server did not announce a port within 10 s; stderr: ${err.slice(0, 300)}`));
    }, 10_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      err += chunk;
      const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(err);
      if (m && Number(m[1]) > 0) {
        clearTimeout(timer);
        const stop = () => new Promise<void>((done) => { child.on("exit", () => done()); child.kill(); });
        resolve({ port: Number(m[1]), stop, stderr: err });
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (${code}): ${err.slice(0, 300)}`));
    });
  });
}

export async function runWebTests(test: TestFn, assert: AssertFn, eq: EqFn): Promise<void> {
  console.log("\n# web layer: React store, pure UI helpers, zod request schemas, server request gate");

  // ---- store ------------------------------------------------------------------
  const store = await load("../web/src/store.ts");
  test("web/src/store.ts loads (Node runs the TS source directly)", () => assert(!store.__error, store.__error ?? ""));
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
    s.set((cur: { a: number }) => ({ a: cur.a + 10 }));
    eq(s.get().a, 11);
    assert(s.get() !== before, "state identity must change so React sees the update");
    off();
    s.set({ a: 12 });
    eq(n, 1);
  });

  // ---- pure UI helpers ----------------------------------------------------------
  const hl = await load("../web/src/gon-highlight.ts");
  test("web/src/gon-highlight.ts loads", () => assert(!hl.__error, hl.__error ?? ""));
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
  test("web/src/tree.ts loads", () => assert(!tree.__error, tree.__error ?? ""));
  test("buildTree: nests by '/', keeps leaf names and the original fields, preserves order", () => {
    const t = tree.buildTree([
      { relPath: "abilities/a.gon.append", mode: "append" },
      { relPath: "text/combined.csv", mode: "replace" },
      { relPath: "abilities/b.gon", mode: "replace" },
      { relPath: "mod.gon", mode: "replace" },
    ]);
    eq([...t.dirs.keys()].join(","), "abilities,text");
    eq(t.files.map((f: { leaf: string }) => f.leaf).join(","), "mod.gon");
    const ab = t.dirs.get("abilities");
    eq(ab.path, "abilities");
    eq(ab.files.map((f: { leaf: string }) => f.leaf).join(","), "a.gon.append,b.gon");
    eq(ab.files[0].mode, "append");
    eq(ab.files[0].relPath, "abilities/a.gon.append");
  });

  // ---- zod request schemas (shared by web/server.ts and the browser client) ----
  const sch = await load("../src/core/api-schemas.ts");
  test("src/core/api-schemas.ts loads", () => assert(!sch.__error, sch.__error ?? ""));
  test("api-schemas: every POST route has a body schema (API_BODY)", () => {
    for (const r of POST_ROUTES) assert(!!(sch.API_BODY && sch.API_BODY[r]), `missing schema for ${r}`);
    eq(Object.keys(sch.API_BODY).length, POST_ROUTES.length, "no unknown routes");
  });
  test("api-schemas: /api/write needs mod, path, content as strings; the issues name each missing key", () => {
    const r = sch.API_BODY["/api/write"].safeParse({});
    assert(!r.success, "empty body must fail");
    const paths = r.error.issues.map((i: { path: (string | number)[] }) => i.path.join(".")).sort().join(",");
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

  // ---- UI foundations (docs/editor-ts-react-plan.md "UI primitives and conventions") ----
  test("store.shallowEqual: same keys with Object.is-equal values are equal; arrays compare element-wise; anything else is not", () => {
    const se = store.shallowEqual;
    assert(typeof se === "function", "store.ts exports shallowEqual");
    const arr = [1, 2];
    assert(se({ a: 1, b: arr }, { a: 1, b: arr }), "same refs");
    assert(!se({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] }), "a nested fresh array is a different value (shallow)");
    assert(se([1, "x", arr], [1, "x", arr]), "arrays element-wise");
    assert(!se([1, 2], [1, 2, 3]), "array length");
    assert(!se({ a: 1 }, { a: 1, b: undefined }), "key count");
    assert(se(NaN, NaN), "Object.is for primitives");
    assert(!se({ a: 1 }, null), "null");
    assert(typeof store.useStoreShallow === "function", "store.ts exports useStoreShallow");
  });

  const sc = await load("../web/src/shortcuts.ts");
  test("web/src/shortcuts.ts loads", () => assert(!sc.__error, sc.__error ?? ""));
  test("matchShortcut: Ctrl+S / Cmd+S (any case, repeats too) is save; Esc is escape; Alt or a bare key is nothing", () => {
    const k = (key: string, o: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; repeat: boolean }> = {}) =>
      sc.matchShortcut({ key, ctrlKey: false, metaKey: false, altKey: false, repeat: false, ...o });
    eq(k("s", { ctrlKey: true }), "save");
    eq(k("S", { metaKey: true }), "save");
    eq(k("s", { ctrlKey: true, repeat: true }), "save", "a held Ctrl+S still matches, so the browser dialog stays suppressed");
    eq(k("s", { ctrlKey: true, altKey: true }), null);
    eq(k("s"), null);
    eq(k("Escape"), "escape");
    eq(k("Escape", { repeat: true }), null, "a held Esc closes one overlay, not the whole stack");
    eq(k("Enter", { ctrlKey: true }), null);
  });
  test("overlay stack: Esc closes menu > tour > modal > drawer, newest first within a kind; popOverlay removes an entry", () => {
    const log: string[] = [];
    const d = sc.pushOverlay(() => log.push("drawer"), "drawer");
    const m = sc.pushOverlay(() => log.push("modal"), "modal");
    const menu = sc.pushOverlay(() => log.push("menu"), "menu");
    const m2 = sc.pushOverlay(() => log.push("modal2"), "modal");
    assert(sc.closeTopOverlay() === true, "something closed");
    eq(log.join(","), "menu");
    sc.popOverlay(menu);
    sc.closeTopOverlay();
    eq(log.join(","), "menu,modal2");
    sc.popOverlay(m2);
    sc.popOverlay(m);
    sc.closeTopOverlay();
    eq(log.join(","), "menu,modal2,drawer");
    sc.popOverlay(d);
    assert(sc.closeTopOverlay() === false, "an empty stack closes nothing");
  });

  const st = await load("../web/src/state.ts");
  test("web/src/state.ts loads", () => assert(!st.__error, st.__error ?? ""));
  test("pushMessage / expireMessage: a queue, newest last; a repeated text replaces its older copy; expiry removes by id; inputs never mutate", () => {
    const a = { id: 1, text: "one", kind: "info" };
    const b = { id: 2, text: "two", kind: "error" };
    const l0: unknown[] = [];
    const l1 = st.pushMessage(l0, a);
    const l2 = st.pushMessage(l1, b);
    eq(l0.length, 0, "input untouched");
    eq(l2.map((m: { text: string }) => m.text).join(","), "one,two");
    const l3 = st.pushMessage(l2, { id: 3, text: "one", kind: "ok" });
    eq(l3.map((m: { id: number }) => m.id).join(","), "2,3", "the repeat moved to the end with its new id");
    eq(st.expireMessage(l3, 2).map((m: { id: number }) => m.id).join(","), "3");
    eq(st.expireMessage(l3, 99).length, 2, "an unknown id changes nothing");
    let many: unknown[] = [];
    for (let i = 0; i < 20; i++) many = st.pushMessage(many, { id: 100 + i, text: `m${i}`, kind: "info" });
    assert(many.length <= 6, `the queue is capped (${many.length})`);
    eq((many[many.length - 1] as { text: string }).text, "m19", "the newest survives the cap");
  });
  test("toast(): queues {id, text, kind} in S.messages (kind defaults to info) and S.message is gone", () => {
    const before = (st.S.get().messages || []).length;
    st.toast("hello from the test", { ms: 1 });
    st.toast("an error", { kind: "error", ms: 1 });
    const msgs = st.S.get().messages as { id: number; text: string; kind: string }[];
    assert(Array.isArray(msgs), "S.messages is an array");
    eq(msgs.length, before + 2);
    eq(msgs[msgs.length - 2].kind, "info");
    eq(msgs[msgs.length - 1].kind, "error");
    assert(msgs[msgs.length - 2].id !== msgs[msgs.length - 1].id, "ids are unique");
    assert(!("message" in st.S.get()), "no S.message left");
  });
  test("S.busy + setBusy(key, on): a per-action in-flight map", () => {
    eq(JSON.stringify(st.S.get().busy), "{}");
    st.setBusy("save", true);
    eq(st.S.get().busy.save, true);
    st.setBusy("save", false);
    eq(st.S.get().busy.save, undefined, "off removes the key");
  });

  const apiMod = await load("../web/src/api.ts");
  test("web/src/api.ts loads", () => assert(!apiMod.__error, apiMod.__error ?? ""));
  const realFetch = globalThis.fetch;
  const fakeFetch = (status: number, body: unknown, reject = false) =>
    (async () => {
      if (reject) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
  const outcomes: Record<string, { value?: unknown; error?: any }> = {};
  const cases: [string, typeof fetch][] = [
    ["ok", fakeFetch(200, { ok: true, n: 1 })],
    ["bad", fakeFetch(400, { error: "body: mod: Required", issues: [{ path: ["mod"], message: "Required" }] })],
    ["down", fakeFetch(0, null, true)],
  ];
  for (const [name, f] of cases) {
    globalThis.fetch = f;
    try {
      outcomes[name] = { value: apiMod.__error ? undefined : await apiMod.getJson("/api/x") };
    } catch (e) {
      outcomes[name] = { error: e };
    }
  }
  let postOutcome: { value?: unknown; error?: any } = {};
  globalThis.fetch = fakeFetch(404, { error: "no route: POST /api/nope" });
  try { postOutcome = { value: apiMod.__error ? undefined : await apiMod.postJson("/api/nope", {}) }; } catch (e) { postOutcome = { error: e }; }
  globalThis.fetch = realFetch;
  test("apiFetch: a 2xx returns the parsed JSON", () => eq(JSON.stringify(outcomes.ok?.value), '{"ok":true,"n":1}'));
  test("apiFetch: a non-2xx throws ApiError {status, message, issues} and toasts the message as an error", () => {
    const e = outcomes.bad?.error;
    assert(!!apiMod.ApiError && e instanceof apiMod.ApiError, `ApiError thrown (${String(e)})`);
    eq(e.status, 400);
    eq(e.message, "body: mod: Required");
    eq(e.issues?.[0]?.path?.[0], "mod");
    const msgs = (st.S.get().messages || []) as { text: string; kind: string }[];
    assert(msgs.some((m) => m.kind === "error" && m.text === "body: mod: Required"), JSON.stringify(msgs));
    const p = postOutcome.error;
    assert(p instanceof apiMod.ApiError && p.status === 404, "postJson goes through apiFetch too");
  });
  test("apiFetch: a network failure throws ApiError with status 0", () => {
    const e = outcomes.down?.error;
    assert(!!apiMod.ApiError && e instanceof apiMod.ApiError, String(e));
    eq(e.status, 0);
  });

  // PaneBoundary lives in a JSX-free module so Node can load it (ui.tsx re-exports it). React's server renderer does
  // not run error boundaries, so this covers the two halves the boundary is made of: the static
  // getDerivedStateFromError (error → state) and render() for both states, rendered to HTML; reset() clears it.
  const bd = await load("../web/src/components/boundary.ts");
  test("web/src/components/boundary.ts loads", () => assert(!bd.__error, bd.__error ?? ""));
  let rds: Record<string, any> = {};
  let rc: Record<string, any> = {};
  try { rds = await import("react-dom/server"); rc = await import("react"); } catch { /* asserted below */ }
  test("PaneBoundary: getDerivedStateFromError keeps the error; render shows an EmptyState with the message and Reload pane; reset() clears it", () => {
    const PB = bd.PaneBoundary;
    assert(typeof PB === "function", "PaneBoundary exported");
    const st1 = PB.getDerivedStateFromError(new Error("boom in pane"));
    eq(st1.error.message, "boom in pane");
    const child = rc.createElement("p", null, "child ok");
    const inst = new PB({ name: "Explorer", children: child });
    eq(rds.renderToString(inst.render()), "<p>child ok</p>", "no error → the children");
    inst.state = { ...inst.state, ...st1 };
    const html = rds.renderToString(inst.render());
    assert(/emptystate/.test(html), html);
    assert(/boom in pane/.test(html), html);
    assert(/Reload pane/.test(html), html);
    assert(/Explorer/.test(html), "names the pane");
    inst.setState = (s: object) => { inst.state = { ...inst.state, ...s }; };
    inst.reset();
    eq(inst.state.error, null);
  });

  // ---- server request gate (spawns web/server.ts on an OS-chosen port) --------------
  let srv: ServerHandle | null = null;
  try {
    srv = await startServer();
  } catch (e) {
    test("web/server.ts starts on PORT=0 and announces the bound port on stderr", () => assert(false, String(e instanceof Error ? e.message : e)));
  }
  if (srv) {
    const base = `http://127.0.0.1:${srv.port}`;
    let w: { status: number; json: any; text: string } = { status: 0, json: null, text: "" };
    try {
      const r = await fetch(`${base}/api/write`, { method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: "{}" });
      w = { status: r.status, text: await r.text(), json: null };
      try { w.json = JSON.parse(w.text); } catch { /* asserted below */ }
    } catch (e) {
      w.text = String(e instanceof Error ? e.message : e);
    }
    test("server: POST /api/write with {} is a 400 whose JSON names the missing keys in `issues` (zod gate)", () => {
      eq(w.status, 400, `status (body: ${w.text.slice(0, 200)})`);
      assert(w.json && typeof w.json.error === "string", "error string");
      assert(Array.isArray(w.json.issues), "issues array");
      const paths = (w.json.issues as { path?: (string | number)[] }[]).map((i) => (i.path || []).join(".")).sort().join(",");
      eq(paths, "content,mod,path");
    });
    let nf: { status: number; text: string } = { status: 0, text: "" };
    try {
      const r = await fetch(`${base}/api/nope`, { headers: { Connection: "close" } });
      nf = { status: r.status, text: await r.text() };
    } catch (e) {
      nf.text = String(e instanceof Error ? e.message : e);
    }
    test("server: an unknown /api route is a 404 JSON error", () => {
      eq(nf.status, 404, nf.text.slice(0, 200));
    });
    {
      const bad: { status: number; type: string; body: string }[] = [];
      for (const q of ["../../x.swf", "saves/x.swf", "nope.swf"]) {
        try {
          const r = await fetch(`${base}/api/art/vanilla-swf?name=${encodeURIComponent(q)}`, { headers: { Connection: "close" } });
          bad.push({ status: r.status, type: r.headers.get("content-type") || "", body: await r.text() });
        } catch (e) { bad.push({ status: 0, type: "", body: String(e) }); }
      }
      let list = { status: 0, body: "" };
      try { const r = await fetch(`${base}/api/art/vanilla-swfs`, { headers: { Connection: "close" } }); list = { status: r.status, body: await r.text() }; } catch (e) { list.body = String(e); }
      test("server: /api/art/vanilla-swfs lists; /api/art/vanilla-swf refuses traversal, saves paths and absent files with a JSON error (never bytes)", () => {
        eq(list.status, 200, list.body);
        assert(Array.isArray((JSON.parse(list.body) as { files?: unknown[] }).files), list.body);
        for (const b of bad) {
          assert(b.status >= 400 && b.status < 500 && /application\/json/.test(b.type), JSON.stringify(b));
          assert(/"ok":false/.test(b.body), b.body);
        }
      });
    }
    const dist = join(EDITOR, "web", "dist", "index.html");
    if (existsSync(dist)) {
      let idx: { status: number; text: string } = { status: 0, text: "" };
      try {
        const r = await fetch(`${base}/`, { headers: { Connection: "close" } });
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
    await srv.stop();
  }
}
