#!/usr/bin/env node
// Test harness for the Mewgenics mod editor core (+ an MCP smoke test).
// Node built-ins only; plain assertions. Exits non-zero on any failure.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { parse } from "../src/core/gon/parser.mjs";
import { serialize } from "../src/core/gon/parser.mjs";
import { toValue, pretty } from "../src/core/gon/value.mjs";
import { append, deepMerge, patchMerge } from "../src/core/overlay/merge.mjs";
import { applyGonOverlay } from "../src/core/overlay/overlay.mjs";
import { parsePolicy } from "../src/core/overlay/policy.mjs";
import { validateMod } from "../src/core/validate/validator.mjs";
import { EXTRACTED_DATA, REPO_ROOT, MODS_DIR } from "../src/core/repo.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
/** @param {string} name @param {() => void} fn */
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String(e instanceof Error ? e.message : e)}`);
  }
}
/** @param {boolean} cond @param {string} msg */
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
/** @param {unknown} a @param {unknown} b @param {string} [msg] */
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || "not equal"}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);
}

// ---- helpers ----------------------------------------------------------------
/** @param {any} v @param {string[]} path @returns {any} */
function getPath(v, path) {
  let cur = v;
  for (const key of path) {
    if (!cur || cur.t !== "obj") return null;
    const e = cur.entries.find((/** @type {any} */ x) => x.key === key);
    if (!e) return null;
    cur = e.value;
  }
  return cur;
}
/** @param {string} s */
function v(s) {
  return toValue(parse(s));
}

// ---- 1. GON round-trip ------------------------------------------------------
console.log("\n# GON round-trip (parse -> serialize is byte-exact)");
{
  /** @param {string} dir @param {string[]} acc */
  const listGon = (dir, acc) => {
    if (!existsSync(dir)) return acc;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) listGon(full, acc);
      else if (ent.isFile() && ent.name.endsWith(".gon")) acc.push(full);
    }
    return acc;
  };
  /** @type {string[]} */
  const all = listGon(EXTRACTED_DATA, []);
  if (all.length === 0) {
    test("base data present", () => assert(false, `no .gon files under ${EXTRACTED_DATA}`));
  } else {
    let checked = 0;
    let exact = 0;
    /** @type {string[]} */
    const failures = [];
    for (const f of all) {
      const src = readFileSync(f, "utf8");
      const out = serialize(parse(src));
      checked++;
      if (out === src) exact++;
      else if (failures.length < 5) failures.push(f.slice(EXTRACTED_DATA.length + 1));
    }
    test(`round-trips all ${checked} base .gon files byte-exact`, () =>
      assert(exact === checked, `${checked - exact} differed, e.g. ${failures.join(", ")}`));
  }
}

// ---- 2. Overlay engine fixtures --------------------------------------------
console.log("\n# Overlay engine (Append / DeepMerge / PatchMerge)");
test("append concatenates object children (duplicates allowed)", () => {
  const r = append(v("a 1"), v("b 2 a 9"));
  eq(r.t, "obj");
  const obj = /** @type {any} */ (r);
  eq(obj.entries.length, 3);
  eq(obj.entries[0].key, "a");
  eq(obj.entries[1].key, "b");
  eq(obj.entries[2].key, "a");
});
test("append concatenates arrays", () => {
  const r = /** @type {any} */ (append(v("arr [1 2]"), v("arr [3]")));
  // top-level objects: arr appended as a second entry 'arr'
  eq(r.entries.length, 2);
});
test("deepMerge merges matching fields, appends new, overwrites scalars", () => {
  const r = deepMerge(v("o { a 1 b 2 }"), v("o { b 9 c 3 }"));
  eq(getPath(r, ["o", "a"]).num, 1);
  eq(getPath(r, ["o", "b"]).num, 9);
  eq(getPath(r, ["o", "c"]).num, 3);
});
test("deepMerge overwrites mismatched types", () => {
  const r = deepMerge(v("o { a 1 }"), v('o { a "str" }'));
  eq(getPath(r, ["o", "a"]).raw, "str");
  eq(getPath(r, ["o", "a"]).quoted, true);
});
test("patch .add adds to a number (base + patch)", () => {
  const r = patchMerge(v("x 10"), v("x.add 5"));
  eq(getPath(r, ["x"]).num, 15);
});
test("patch .multiply multiplies a number (base * patch)", () => {
  const r = patchMerge(v("x 10"), v("x.multiply 3"));
  eq(getPath(r, ["x"]).num, 30);
});
test("patch .overwrite replaces a value", () => {
  const r = patchMerge(v("x 10"), v("x.overwrite 2"));
  eq(getPath(r, ["x"]).num, 2);
});
test("patch default (no suffix) deep-merges nested objects", () => {
  const r = patchMerge(v("o { a 1 }"), v("o { b 2 }"));
  eq(getPath(r, ["o", "a"]).num, 1);
  eq(getPath(r, ["o", "b"]).num, 2);
});
test("patch .overwrite on an object replaces it wholesale", () => {
  const r = patchMerge(v("o { a 1 }"), v("o.overwrite { b 2 }"));
  eq(getPath(r, ["o", "a"]), null);
  eq(getPath(r, ["o", "b"]).num, 2);
});
test("patch .append concatenates an array", () => {
  const r = /** @type {any} */ (patchMerge(v("arr [1 2 3]"), v("arr.append [4 5]")));
  const arr = getPath(r, ["arr"]);
  eq(arr.items.length, 5);
  eq(arr.items[4].num, 5);
});
test("patch array default is element-wise by index", () => {
  const r = patchMerge(v("arr [1 2 3]"), v("arr.merge [10 20]"));
  const arr = getPath(r, ["arr"]);
  eq(arr.items[0].num, 10);
  eq(arr.items[1].num, 20);
  eq(arr.items[2].num, 3);
});
test("patch strips policy suffixes when adding a brand-new field", () => {
  const r = patchMerge(v("keep 1"), v("fresh { inner.add 5 }"));
  // 'fresh' did not exist, so it is added with suffixes stripped.
  eq(getPath(r, ["fresh", "inner"]).num, 5);
  eq(getPath(r, ["fresh", "inner.add"]), null);
});
test("parsePolicy matches suffixes in the decompiled order", () => {
  eq(parsePolicy("damage.add").policy, "add");
  eq(parsePolicy("damage.add").name, "damage");
  eq(parsePolicy("x.multiply").policy, "multiply");
  eq(parsePolicy("x.overwrite").policy, "overwrite");
  eq(parsePolicy("boss_health_multiplier").policy, "default");
  eq(parsePolicy("wallet_size").policy, "default");
});

// ---- 3. Real mods against real base ----------------------------------------
console.log("\n# Real overlays applied to extracted base data");
{
  const baseDiff = join(EXTRACTED_DATA, "difficulties.gon");
  const modDiff = join(MODS_DIR, "dev-sandbox", "data", "difficulties.gon.merge");
  if (existsSync(baseDiff) && existsSync(modDiff)) {
    test("dev-sandbox difficulties.gon.merge sets difficulty 0 wallet_size 99 -> 999", () => {
      const { effective } = applyGonOverlay(readFileSync(baseDiff, "utf8"), readFileSync(modDiff, "utf8"), "merge");
      eq(getPath(effective, ["0", "wallet_size"]).num, 999);
      eq(getPath(effective, ["0", "boss_health_multiplier"]).num, 1, "other fields preserved");
    });
  }
  const baseAb = join(EXTRACTED_DATA, "abilities", "fighter_abilities.gon");
  const modAb = join(MODS_DIR, "jokers-luck", "data", "abilities", "fighter_abilities.gon.append");
  if (existsSync(baseAb) && existsSync(modAb)) {
    test("jokers-luck fighter_abilities.gon.append adds JokersGambit (effects JokersLuck 1), keeps Spin", () => {
      const { effective } = applyGonOverlay(readFileSync(baseAb, "utf8"), readFileSync(modAb, "utf8"), "append");
      eq(getPath(effective, ["JokersGambit", "damage_instance", "effects", "JokersLuck"]).num, 1);
      assert(getPath(effective, ["Spin"]) !== null, "base Spin still present");
    });
  }
}

// ---- 4. Validator -----------------------------------------------------------
console.log("\n# Validator");
if (existsSync(join(MODS_DIR, "jokers-luck"))) {
  test("jokers-luck validates with zero errors", () => {
    const r = validateMod("jokers-luck");
    assert(r.ok, `expected ok, got ${r.counts.errors} errors: ${JSON.stringify(r.findings.filter((f) => f.severity === "error"))}`);
  });
}
if (existsSync(join(MODS_DIR, "dev-sandbox"))) {
  test("dev-sandbox validates with zero errors", () => {
    const r = validateMod("dev-sandbox");
    assert(r.ok, `expected ok, got ${r.counts.errors} errors: ${JSON.stringify(r.findings.filter((f) => f.severity === "error"))}`);
  });
  test("broken overlay flags unknown status + missing localization key", () => {
    const broken = `BrokenTest {
  variant_of Spin
  meta { name "ABILITY_DEFINITELY_MISSING_KEY_XYZ" }
  damage_instance { effects { NotARealStatusXYZ 1 } }
}
`;
    const r = validateMod("jokers-luck", { relPath: "data/abilities/__broken.gon.append", text: broken });
    const codes = r.findings.map((f) => f.code);
    assert(codes.includes("unknown-status"), `expected unknown-status, got ${codes.join(",")}`);
    assert(codes.includes("missing-loc-key"), `expected missing-loc-key, got ${codes.join(",")}`);
    assert(!r.ok, "broken overlay should not be ok");
  });
  test("broken .merge onto a non-existent key is flagged", () => {
    const r = validateMod("dev-sandbox", { relPath: "data/difficulties.gon.merge", text: "999 {\n\twallet_size 1\n}\n" });
    const codes = r.findings.map((f) => f.code);
    assert(codes.includes("merge-target-missing"), `expected merge-target-missing, got ${codes.join(",")}`);
  });
}

// ---- 5. MCP smoke test ------------------------------------------------------
async function mcpSmoke() {
  console.log("\n# MCP server smoke (spawn + JSON-RPC)");
  const serverPath = join(REPO_ROOT, "editor", "src", "mcp", "server.mjs");
  const child = spawn(process.argv[0], [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
  /** @type {Map<number, {resolve:(v:any)=>void, reject:(e:any)=>void}>} */
  const pending = new Map();
  let id = 1;
  let buf = "";
  child.stdout.on("data", (/** @type {any} */ chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (p) (msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result));
      }
    }
  });
  child.stderr.on("data", () => {});
  /** @param {string} method @param {any} params */
  const req = (method, params) =>
    new Promise((resolve, reject) => {
      const myId = id++;
      pending.set(myId, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
      setTimeout(() => {
        if (pending.has(myId)) {
          pending.delete(myId);
          reject(new Error(`timeout: ${method}`));
        }
      }, 15000);
    });
  /** @param {string} method @param {any} params */
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

  try {
    const init = /** @type {any} */ (await req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } }));
    test("initialize returns protocol 2025-06-18", () => eq(init.protocolVersion, "2025-06-18"));
    notify("notifications/initialized", {});
    const list = /** @type {any} */ (await req("tools/list", {}));
    test("tools/list returns the 9 editor tools", () => eq(list.tools.length, 9));
    const vres = /** @type {any} */ (await req("tools/call", { name: "validate_mod", arguments: { mod: "jokers-luck" } }));
    test("tools/call validate_mod jokers-luck -> ok", () => {
      const payload = JSON.parse(vres.content[0].text);
      assert(payload.ok === true, `expected ok, got ${JSON.stringify(payload.counts)}`);
    });
    const pres = /** @type {any} */ (await req("tools/call", { name: "preview_merge", arguments: { mod: "jokers-luck", path: "data/abilities/fighter_abilities.gon.append" } }));
    test("tools/call preview_merge jokers-luck -> JokersGambit added", () => {
      const payload = JSON.parse(pres.content[0].text);
      assert(payload.kind === "gon", "expected gon preview");
      assert(payload.touched.some((/** @type {any} */ t) => t.key === "JokersGambit" && t.status === "added"), "JokersGambit should be added");
    });
  } finally {
    child.stdin.end();
    setTimeout(() => child.kill(), 500);
  }
}

await mcpSmoke();

// ---- 6. Art pipeline (scene model, emitter, reader, preview-shared modules) --
{
  const { runArtCoreTests } = await import("./art-core-tests.mjs");
  const { runArtEmitterTests } = await import("./art-emitter-tests.mjs");
  runArtEmitterTests(test, assert, eq);
  runArtCoreTests(test, assert, eq);
}

// ---- summary ----------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
void pretty;
void HERE;
process.exit(failed > 0 ? 1 : 0);
