#!/usr/bin/env node
// Test harness for the Mewgenics mod editor core (+ an MCP smoke test).
// Node built-ins only; plain assertions. Exits non-zero on any failure.

import { readFileSync, existsSync, readdirSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

import { parse } from "../src/core/gon/parser.mjs";
import { toValue, pretty } from "../src/core/gon/value.mjs";
import { append, deepMerge, patchMerge } from "../src/core/overlay/merge.mjs";
import { applyGonOverlay } from "../src/core/overlay/overlay.mjs";
import { parsePolicy } from "../src/core/overlay/policy.mjs";
import { validateMod } from "../src/core/validate/validator.mjs";
import { EXTRACTED_DATA, REPO_ROOT, MODS_DIR } from "../src/core/repo.mjs";
import { makeTestFilter } from "./filter.mjs";
import { runGonRoundTripTests } from "./gon-roundtrip-tests.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** `npm test -- --only <substring>` or TEST_ONLY=<substring>: run only matching test names (others count as skipped) */
const filter = (() => {
  try { return makeTestFilter(process.argv.slice(2), process.env); }
  catch (e) { console.error(String(e instanceof Error ? e.message : e)); process.exit(2); }
})();
/** base data present? sections 3/4 and two MCP calls need it; without it they log "(skipped: …)" so T0 stays runnable */
const BASE_READY = existsSync(join(EXTRACTED_DATA, "abilities", "fighter_abilities.gon")) && existsSync(join(EXTRACTED_DATA, "difficulties.gon"));

let passed = 0;
let failed = 0;
let skipped = 0;
/** @param {string} name @param {() => void} fn */
function test(name, fn) {
  if (!filter.matches(name)) { skipped++; return; }
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

// ---- 0. Runner self-tests ---------------------------------------------------
console.log("\n# Runner (name filter)");
{
  const fm = { makeTestFilter };
  {
    test("makeTestFilter: no --only and no TEST_ONLY -> everything runs", () => {
      const f = fm.makeTestFilter([], {});
      eq(f.only, null);
      assert(f.matches("anything at all"), "matches");
    });
    test("makeTestFilter: --only <substring> is a case-insensitive substring match; TEST_ONLY is the env form; argv wins", () => {
      const f = fm.makeTestFilter(["--only", "GPAK"], {});
      eq(f.only, "GPAK");
      assert(f.matches("gpak.py list prints offset/size/path") && !f.matches("round-trips all base .gon files"), "substring, case-insensitive");
      eq(fm.makeTestFilter([], { TEST_ONLY: "filter" }).only, "filter");
      eq(fm.makeTestFilter(["--only", "a"], { TEST_ONLY: "b" }).only, "a");
    });
    test("makeTestFilter: a dangling --only is an error (not 'run nothing')", () => {
      let threw = false;
      try { fm.makeTestFilter(["--only"], {}); } catch { threw = true; }
      assert(threw, "expected a throw");
    });
  }
}

// ---- 1. GON round-trip ------------------------------------------------------
{
  const rt = { runGonRoundTripTests };
  {
    rt.runGonRoundTripTests(test, assert, eq);
    test("round-trip suite skips (logs '(skipped: …)', fails nothing) when the extracted dir has no .gon files", () => {
      const empty = mkdtempSync(join(tmpdir(), "mewged-noextracted-"));
      /** @type {string[]} */
      const logs = [];
      let fails = 0, ran = 0;
      rt.runGonRoundTripTests((/** @type {string} */ _n, /** @type {() => void} */ fn) => { ran++; try { fn(); } catch { fails++; } }, assert, eq, { extractedDir: empty, log: (/** @type {string} */ l) => logs.push(l) });
      eq(fails, 0, "no failing test");
      eq(ran, 0, "no test ran at all (skipped)");
      assert(logs.some((l) => /\(skipped: no \.gon files under/.test(l)), `expected a skip line, got: ${logs.join(" / ")}`);
    });
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
  } else console.log(`  (skipped: ${existsSync(baseDiff) ? "mods/dev-sandbox difficulties.gon.merge absent" : "difficulties.gon not extracted"})`);
  const baseAb = join(EXTRACTED_DATA, "abilities", "fighter_abilities.gon");
  const modAb = join(MODS_DIR, "jokers-luck", "data", "abilities", "fighter_abilities.gon.append");
  if (existsSync(baseAb) && existsSync(modAb)) {
    test("jokers-luck fighter_abilities.gon.append adds JokersGambit (effects JokersLuck 1), keeps Spin", () => {
      const { effective } = applyGonOverlay(readFileSync(baseAb, "utf8"), readFileSync(modAb, "utf8"), "append");
      eq(getPath(effective, ["JokersGambit", "damage_instance", "effects", "JokersLuck"]).num, 1);
      assert(getPath(effective, ["Spin"]) !== null, "base Spin still present");
    });
  } else console.log(`  (skipped: ${existsSync(baseAb) ? "mods/jokers-luck fighter_abilities.gon.append absent" : "abilities/fighter_abilities.gon not extracted"})`);
}

// ---- 4. Validator -----------------------------------------------------------
console.log("\n# Validator");
if (!BASE_READY) console.log("  (skipped: base data not extracted; the validator resolves parents/statuses against .extracted/data)");
if (BASE_READY && existsSync(join(MODS_DIR, "jokers-luck"))) {
  test("jokers-luck validates with zero errors", () => {
    const r = validateMod("jokers-luck");
    assert(r.ok, `expected ok, got ${r.counts.errors} errors: ${JSON.stringify(r.findings.filter((f) => f.severity === "error"))}`);
  });
}
if (BASE_READY && existsSync(join(MODS_DIR, "dev-sandbox"))) {
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
  test("native-build-unknown: a mod using a native-registered name warns when the installed exe is not a known build", () => {
    const unknown = { known: false, identity: { timeDateStamp: "0x6b000000", sizeOfImage: "0x01580000" }, matched: null };
    const r = validateMod("jokers-luck", undefined, { nativeBuild: unknown });
    const w = r.findings.filter((f) => f.code === "native-build-unknown");
    assert(w.length >= 1, `expected native-build-unknown, got ${r.findings.map((f) => f.code).join(",")}`);
    eq(w[0].severity, "warning");
    assert(/JokersLuck/.test(w[0].message) && /0x6b000000/.test(w[0].message) && /binding-port/.test(w[0].message), w[0].message);
    assert(r.ok, "a warning keeps the mod valid for the data layer");
    eq(new Set(w.map((f) => f.message)).size, w.length, "one warning per name per file");
  });
  test("native-build-unknown: nothing when the build is known, when no exe is installed, or when the mod uses no native names", () => {
    const codes = (/** @type {any} */ r) => r.findings.map((/** @type {any} */ f) => f.code);
    assert(!codes(validateMod("jokers-luck", undefined, { nativeBuild: { known: true, matched: { steamBuildId: "25143593" } } })).includes("native-build-unknown"), "known");
    assert(!codes(validateMod("jokers-luck", undefined, { nativeBuild: null })).includes("native-build-unknown"), "no exe");
    assert(!codes(validateMod("dev-sandbox", undefined, { nativeBuild: { known: false, identity: null, matched: null } })).includes("native-build-unknown"), "no native names");
    assert(!codes(validateMod("jokers-luck")).includes("native-build-unknown"), "default on this machine (known build or no exe)");
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
    test("tools/list returns the 13 editor tools", () => eq(list.tools.length, 13));
    /** @type {any} */
    let pres2 = null;
    let perr2 = "";
    try { pres2 = await req("tools/call", { name: "port_bindings", arguments: { build: "25143593", dryRun: true } }); } catch (e) { perr2 = String(e); }
    test("tools/call port_bindings (self-port dry run) -> { ok, dryRun, summary, rows, report } (or ok:false skipped without the game)", () => {
      assert(pres2 !== null, perr2);
      const payload = JSON.parse(pres2.content[0].text);
      assert(typeof payload.ok === "boolean", "ok flag");
      if (payload.ok) {
        assert(payload.dryRun === true && payload.summary && Array.isArray(payload.rows) && typeof payload.report === "string", "shape");
        assert(!payload.needsAgent.length, `self-port needs no agent: ${JSON.stringify(payload.needsAgent).slice(0, 200)}`);
      } else assert(payload.skipped === true, JSON.stringify(payload));
    });
    /** @type {any} */
    let cres = null;
    let cerr = "";
    try { cres = await req("tools/call", { name: "check_game_build", arguments: {} }); } catch (e) { cerr = String(e); }
    test("tools/call check_game_build -> { ok, known, build, entries } (or ok:false skipped without the game)", () => {
      assert(cres !== null, cerr);
      const payload = JSON.parse(cres.content[0].text);
      assert(typeof payload.ok === "boolean", "ok flag");
      if (payload.ok) {
        assert(typeof payload.known === "boolean" && Array.isArray(payload.entries) && payload.build, "shape");
      } else assert(payload.skipped === true && typeof payload.reason === "string", JSON.stringify(payload));
    });
    if (!BASE_READY) console.log("  (skipped: validate_mod / preview_merge need extracted base data)");
    else {
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
    }
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

// ---- 7. In-game test harness runner (fake game; never launches Mewgenics) ---
{
  const { runIngameTests } = await import("./ingame-tests.mjs");
  await runIngameTests(test, assert, eq);
}

// ---- 8. Bindings library (PE reader, scanner, manifest, port; fake PE + real exe T1) ---
{
  const { runBindingsTests } = await import("./bindings-tests.mjs");
  await runBindingsTests(test, assert, eq);
}

// ---- 9. tools/gpak.py (synthetic archive; python -I; skips without python) ---
{
  /** @type {any} */
  let gp = null;
  try { gp = await import("./gpak-tests.mjs"); } catch (e) { test("gpak-tests.mjs loads", () => assert(false, String(e instanceof Error ? e.message : e))); }
  if (gp) await gp.runGpakTests(test, assert, eq);
}

// ---- 9b. web layer: React store, pure UI helpers, zod request schemas, server gate ----
{
  /** @type {any} */
  let wt = null;
  try { wt = await import("./web-tests.mjs"); } catch (e) { test("web-tests.mjs loads", () => assert(false, String(e instanceof Error ? e.message : e))); }
  if (wt) await wt.runWebTests(test, assert, eq);
}

// ---- 10. T0 without .extracted/ (nested run; MEWGENICS_EXTRACTED_DATA -> empty dir) ----
if (!process.env.MEWGENICS_EXTRACTED_DATA) {
  console.log("\n# T0 without .extracted/ (nested run with MEWGENICS_EXTRACTED_DATA pointing at an empty dir)");
  test("npm test skips, not fails, when no base data is extracted (CI shape)", () => {
    const empty = mkdtempSync(join(tmpdir(), "mewged-noextracted-"));
    const r = spawnSync(process.argv[0], [join(HERE, "run-tests.mjs")], { env: { ...process.env, MEWGENICS_EXTRACTED_DATA: empty }, encoding: "utf8", timeout: 600000, maxBuffer: 64 << 20 });
    const out = (r.stdout || "") + (r.stderr || "");
    const fails = out.split("\n").filter((/** @type {string} */ l) => l.startsWith("FAIL")).slice(0, 6);
    assert(/\(skipped: no \.gon files under/.test(out), "inner run: expected a '(skipped: no .gon files under …)' line (env override honoured)");
    assert(r.status === 0 && /, 0 failed/.test(out), `inner run exit ${r.status}: ${fails.join(" | ") || out.slice(-300)}`);
  });
}

// ---- summary ----------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed${filter.only ? ` (${skipped} skipped by --only ${JSON.stringify(filter.only)})` : ""}`);
void pretty;
void HERE;
// exitCode, not process.exit(): on Windows, Node 26 fail-fasts (libuv async.c assertion) when exit() runs while
// the undici/fetch and child-process handles from web-tests.mjs are still closing; letting the loop drain is clean.
process.exitCode = failed > 0 ? 1 : 0;
