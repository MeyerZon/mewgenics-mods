#!/usr/bin/env node
// Test harness for the Mewgenics mod editor core (+ an MCP smoke test).
// Node built-ins only; plain assertions. Exits non-zero on any failure.

import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

import { parse } from "../src/core/gon/parser.ts";
import { toValue, pretty } from "../src/core/gon/value.ts";
import type { VNode, VScalar, VArray } from "../src/core/gon/types.ts";
import { append, deepMerge, patchMerge } from "../src/core/overlay/merge.ts";
import { applyGonOverlay } from "../src/core/overlay/overlay.ts";
import { parsePolicy } from "../src/core/overlay/policy.ts";
import { validateMod } from "../src/core/validate/validator.ts";
import { buildSwf } from "../src/core/art/art-io.ts";
import { previewMerge } from "../src/core/preview-merge.ts";
import { componentCacheStatus } from "../src/core/components.ts";
import { EXTRACTED_DATA, REPO_ROOT, MODS_DIR } from "../src/core/repo.ts";
import { makeTestFilter } from "./filter.ts";
import { runGonRoundTripTests } from "./gon-roundtrip-tests.ts";
import { runGonTests } from "./gon-tests.ts";
import { runOverlayTests } from "./overlay-tests.ts";

/** The harness contract every suite is written against (`runXTests(test, assert, eq)`). */
export type TestFn = (name: string, fn: () => void) => void;
export type AssertFn = (cond: boolean, msg: string) => void;
export type EqFn = (a: unknown, b: unknown, msg?: string) => void;

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
const test: TestFn = (name, fn) => {
  if (!filter.matches(name)) { skipped++; return; }
  try {
    const r = fn() as unknown;
    // test bodies are synchronous: an async body would "pass" before its awaits ran (and its rejection would be
    // lost). Await outside test() and assert inside it.
    if (r && typeof (r as { then?: unknown }).then === "function") {
      (r as Promise<unknown>).catch(() => undefined);
      throw new Error("async test body: test() does not await — do the async work before test() and assert synchronously inside it");
    }
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String(e instanceof Error ? e.message : e)}`);
  }
};
const assert: AssertFn = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const eq: EqFn = (a, b, msg) => {
  if (a !== b) throw new Error(`${msg || "not equal"}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);
};

// ---- helpers ----------------------------------------------------------------
/** Walk an object path through a value tree; null when any step is missing or not an object. */
function getPath(v: VNode | null, path: string[]): VNode | null {
  let cur: VNode | null = v;
  for (const key of path) {
    if (!cur || cur.t !== "obj") return null;
    const e = cur.entries.find((x) => x.key === key);
    if (!e) return null;
    cur = e.value;
  }
  return cur;
}
/** The scalar at a path (throws when the path is missing or not a scalar — the assertion then fails). */
function scalar(v: VNode | null): VScalar {
  if (!v || v.t !== "str") throw new Error(`expected a scalar, got ${v ? v.t : "null"}`);
  return v;
}
/** The array at a path (throws when missing or not an array). */
function arr(v: VNode | null): VArray {
  if (!v || v.t !== "arr") throw new Error(`expected an array, got ${v ? v.t : "null"}`);
  return v;
}
function v(s: string): VNode {
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
      const logs: string[] = [];
      let fails = 0, ran = 0;
      rt.runGonRoundTripTests((_n: string, fn: () => void) => { ran++; try { fn(); } catch { fails++; } }, assert, eq, { extractedDir: empty, log: (l: string) => logs.push(l) });
      eq(fails, 0, "no failing test");
      eq(ran, 0, "no test ran at all (skipped)");
      assert(logs.some((l) => /\(skipped: no \.gon files under/.test(l)), `expected a skip line, got: ${logs.join(" / ")}`);
    });
  }
}

// ---- 1b. GON typing fidelity (T0; the game's tokenizer + parser rules) -------
runGonTests(test, assert, eq);

// ---- 2. Overlay engine fixtures --------------------------------------------
console.log("\n# Overlay engine (Append / DeepMerge / PatchMerge)");
test("append concatenates object children (duplicates allowed)", () => {
  const r = append(v("a 1"), v("b 2 a 9"));
  eq(r.t, "obj");
  if (r.t !== "obj") throw new Error("not an object");
  eq(r.entries.length, 3);
  eq(r.entries[0]!.key, "a");
  eq(r.entries[1]!.key, "b");
  eq(r.entries[2]!.key, "a");
});
test("append concatenates arrays", () => {
  const r = append(v("arr [1 2]"), v("arr [3]"));
  if (r.t !== "obj") throw new Error("not an object");
  // top-level objects: arr appended as a second entry 'arr'
  eq(r.entries.length, 2);
});
test("deepMerge merges matching fields, appends new, overwrites scalars", () => {
  const r = deepMerge(v("o { a 1 b 2 }"), v("o { b 9 c 3 }"));
  eq(scalar(getPath(r, ["o", "a"])).num, 1);
  eq(scalar(getPath(r, ["o", "b"])).num, 9);
  eq(scalar(getPath(r, ["o", "c"])).num, 3);
});
test("deepMerge overwrites mismatched types", () => {
  const r = deepMerge(v("o { a 1 }"), v('o { a "str" }'));
  eq(scalar(getPath(r, ["o", "a"])).raw, "str");
  eq(scalar(getPath(r, ["o", "a"])).quoted, true);
});
test("patch .add adds to a number (base + patch)", () => {
  const r = patchMerge(v("x 10"), v("x.add 5"));
  eq(scalar(getPath(r, ["x"])).num, 15);
});
test("patch .multiply multiplies a number (base * patch)", () => {
  const r = patchMerge(v("x 10"), v("x.multiply 3"));
  eq(scalar(getPath(r, ["x"])).num, 30);
});
test("patch .overwrite replaces a value", () => {
  const r = patchMerge(v("x 10"), v("x.overwrite 2"));
  eq(scalar(getPath(r, ["x"])).num, 2);
});
test("patch default (no suffix) deep-merges nested objects", () => {
  const r = patchMerge(v("o { a 1 }"), v("o { b 2 }"));
  eq(scalar(getPath(r, ["o", "a"])).num, 1);
  eq(scalar(getPath(r, ["o", "b"])).num, 2);
});
test("patch .overwrite on an object replaces it wholesale", () => {
  const r = patchMerge(v("o { a 1 }"), v("o.overwrite { b 2 }"));
  eq(getPath(r, ["o", "a"]), null);
  eq(scalar(getPath(r, ["o", "b"])).num, 2);
});
test("patch .append concatenates an array", () => {
  const r = patchMerge(v("arr [1 2 3]"), v("arr.append [4 5]"));
  const a = arr(getPath(r, ["arr"]));
  eq(a.items.length, 5);
  eq(scalar(a.items[4] ?? null).num, 5);
});
test("patch array default is element-wise by index", () => {
  const r = patchMerge(v("arr [1 2 3]"), v("arr.merge [10 20]"));
  const a = arr(getPath(r, ["arr"]));
  eq(scalar(a.items[0] ?? null).num, 10);
  eq(scalar(a.items[1] ?? null).num, 20);
  eq(scalar(a.items[2] ?? null).num, 3);
});
test("patch strips policy suffixes when adding a brand-new field", () => {
  const r = patchMerge(v("keep 1"), v("fresh { inner.add 5 }"));
  // 'fresh' did not exist, so it is added with suffixes stripped.
  eq(scalar(getPath(r, ["fresh", "inner"])).num, 5);
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

// Fixture pairs pinned against the decompiled merge functions (docs/data-mods.md "Fidelity to the decompiled merges").
runOverlayTests(test, assert, eq);

// ---- 3. Real mods against real base ----------------------------------------
console.log("\n# Real overlays applied to extracted base data");
{
  const baseDiff = join(EXTRACTED_DATA, "difficulties.gon");
  const modDiff = join(MODS_DIR, "dev-sandbox", "data", "difficulties.gon.merge");
  if (existsSync(baseDiff) && existsSync(modDiff)) {
    test("dev-sandbox difficulties.gon.merge sets difficulty 0 wallet_size 99 -> 999", () => {
      const { effective } = applyGonOverlay(readFileSync(baseDiff, "utf8"), readFileSync(modDiff, "utf8"), "merge");
      eq(scalar(getPath(effective, ["0", "wallet_size"])).num, 999);
      eq(scalar(getPath(effective, ["0", "boss_health_multiplier"])).num, 1, "other fields preserved");
    });
  } else console.log(`  (skipped: ${existsSync(baseDiff) ? "mods/dev-sandbox difficulties.gon.merge absent" : "difficulties.gon not extracted"})`);
  const baseAb = join(EXTRACTED_DATA, "abilities", "fighter_abilities.gon");
  const modAb = join(MODS_DIR, "jokers-luck", "data", "abilities", "fighter_abilities.gon.append");
  if (existsSync(baseAb) && existsSync(modAb)) {
    test("jokers-luck fighter_abilities.gon.append adds JokersGambit (effects JokersLuck 1), keeps Spin", () => {
      const { effective } = applyGonOverlay(readFileSync(baseAb, "utf8"), readFileSync(modAb, "utf8"), "append");
      eq(scalar(getPath(effective, ["JokersGambit", "damage_instance", "effects", "JokersLuck"])).num, 1);
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
    eq(w[0]!.severity, "warning");
    assert(/JokersLuck/.test(w[0]!.message) && /0x6b000000/.test(w[0]!.message) && /binding-port/.test(w[0]!.message), w[0]!.message);
    assert(r.ok, "a warning keeps the mod valid for the data layer");
    eq(new Set(w.map((f) => f.message)).size, w.length, "one warning per name per file");
  });
  const cache = componentCacheStatus();
  if (cache.ok) test("_jokersluck-test (test-only overlay) validates: JokersLuck resolves as a registered name under StatusOnBattleStart", () => {
    const r = validateMod("_jokersluck-test", undefined, { nativeBuild: { known: true, matched: { steamBuildId: "25143593" } } });
    assert(r.ok, `expected ok, got ${JSON.stringify(r.findings.filter((f) => f.severity === "error"))}`);
    assert(!r.findings.some((f) => f.code === "unknown-status" || f.code === "unknown-component"), r.findings.map((f) => f.code).join(","));
  });
  else console.log(`  (skipped: ${cache.hint}; StatusOnBattleStart cannot be checked as a component)`);
  // The check above needs the git-ignored component-names cache. A fresh worktree has none: the test must then
  // say so with a '(skipped: …)' line, not FAIL (nested run with MEWGENICS_EDITOR_DATA pointing at an empty dir).
  // MEWGENICS_ANALYSIS_DIR -> an empty dir too, so the on-demand distill from list_names.tsv cannot fill the list on
  // a machine that has .analysis/list_names.tsv: the skip path is exercised whatever the machine holds.
  test("component cache absent: the JokersLuck validation check logs '(skipped: … component-names.json …)' and the run stays green", () => {
    const empty = mkdtempSync(join(tmpdir(), "mewged-nocache-"));
    const emptyAnalysis = mkdtempSync(join(tmpdir(), "mewged-noanalysis-"));
    const r = spawnSync(process.argv[0]!, [join(HERE, "run-tests.ts"), "--only", "_jokersluck-test"], {
      env: { ...process.env, MEWGENICS_EDITOR_DATA: empty, MEWGENICS_EXTRACTED_DATA: EXTRACTED_DATA, MEWGENICS_ANALYSIS_DIR: emptyAnalysis },
      encoding: "utf8", timeout: 600000, maxBuffer: 64 << 20,
    });
    const out = (r.stdout || "") + (r.stderr || "");
    const fails = out.split("\n").filter((l) => l.startsWith("FAIL")).slice(0, 6);
    assert(/\(skipped: [^\n]*component-names\.json[^\n]*build:index/.test(out), `inner run: expected a '(skipped: … component-names.json … build:index …)' line, got: ${fails.join(" | ") || out.slice(-400)}`);
    assert(r.status === 0 && /, 0 failed/.test(out), `inner run exit ${r.status}: ${fails.join(" | ") || out.slice(-300)}`);
  });
  test("native-build-unknown: nothing when the build is known, when no exe is installed, or when the mod uses no native names", () => {
    const codes = (r: { findings: { code: string }[] }) => r.findings.map((f) => f.code);
    assert(!codes(validateMod("jokers-luck", undefined, { nativeBuild: { known: true, matched: { steamBuildId: "25143593" } } })).includes("native-build-unknown"), "known");
    assert(!codes(validateMod("jokers-luck", undefined, { nativeBuild: null })).includes("native-build-unknown"), "no exe");
    assert(!codes(validateMod("dev-sandbox", undefined, { nativeBuild: { known: false, identity: null, matched: null } })).includes("native-build-unknown"), "no native names");
    assert(!codes(validateMod("jokers-luck")).includes("native-build-unknown"), "default on this machine (known build or no exe)");
  });
}
// T0: no base data needed (synthetic TSV, redirected cache and data dirs).
test("build:index reads list_names.tsv from MEWGENICS_ANALYSIS_DIR: a synthetic TSV yields exactly its glaiel:: class names", () => {
  const analysis = mkdtempSync(join(tmpdir(), "mewged-analysis-"));
  const cacheDir = mkdtempSync(join(tmpdir(), "mewged-cache-"));
  const noData = mkdtempSync(join(tmpdir(), "mewged-nodata-"));
  writeFileSync(join(analysis, "list_names.tsv"),
    "0x1000\tglaiel::ZetaComponent::Update\n0x1010\tglaiel::AlphaStatus\n0x1020\tnot_a_glaiel_name\n0x1030\tglaiel::ZetaComponent::~ZetaComponent\n");
  const r = spawnSync(process.argv[0]!, [join(HERE, "..", "scripts", "build-index.ts")], {
    env: { ...process.env, MEWGENICS_ANALYSIS_DIR: analysis, MEWGENICS_EDITOR_DATA: cacheDir, MEWGENICS_EXTRACTED_DATA: noData },
    encoding: "utf8", timeout: 120000,
  });
  const out = (r.stdout || "") + (r.stderr || "");
  eq(r.status, 0, out.slice(-300));
  const file = join(cacheDir, "component-names.json");
  assert(existsSync(file), `component-names.json written to the redirected cache dir: ${out.slice(-300)}`);
  eq(JSON.stringify(JSON.parse(readFileSync(file, "utf8"))), JSON.stringify(["AlphaStatus", "ZetaComponent"]));
  assert(/component-names\.json: 2 glaiel:: classes/.test(out), out.slice(-300));
});

// ---- 4c. mods/_autoplay: the auto-resolve overlay (TDD target 3; T1 against the real base) ----
if (BASE_READY) {
  test("_autoplay validates with zero errors (test-only overlay: PlayerCat passives Uncontrollable 1)", () => {
    const r = validateMod("_autoplay");
    assert(r.ok, `expected ok, got ${r.counts.errors} errors: ${JSON.stringify(r.findings.filter((f) => f.severity === "error"))}`);
    assert(!r.findings.some((f) => f.code === "mod-missing" || f.code === "mod-empty"), `mod present and non-empty: ${r.findings.map((f) => f.code).join(",")}`);
  });
  test("_autoplay merge preview: PlayerCat.passives gains Uncontrollable 1 and no other top-level entry is touched", () => {
    const p = previewMerge("_autoplay", "data/characters/player_cat.gon.merge");
    assert(p.ok, `preview: ${JSON.stringify(p)}`);
    if (!p.ok || p.kind !== "gon") throw new Error("gon preview expected");
    eq(p.mode, "merge");
    assert(p.baseExists, "base data/characters/player_cat.gon present");
    eq(p.touched.map((t) => `${t.key}:${t.status}`).join(","), "PlayerCat:changed");
    const eff = p.touched[0]!.effective || "";
    assert(/passives\s*\{[^}]*Uncontrollable\s+1/.test(eff), `effective PlayerCat has passives { Uncontrollable 1 }: ${eff.slice(0, 400)}`);
    assert(!/Uncontrollable/.test(p.touched[0]!.base || ""), "the base PlayerCat has no Uncontrollable passive");
    eq(p.effectiveEntryCount, p.baseEntryCount, "merge changes an entry, adds none");
  });
} else console.log("  (skipped: base data not extracted; _autoplay is checked against data/characters/player_cat.gon)");

// ---- 4e. mods/_artprobe: the in-game art probe (test-only enemy + scene) ----
test("_artprobe: the probe scene validates and builds (dry run): a bitmap, five shapes, three sprites, ArtProbe exported", () => {
  const r = buildSwf("_artprobe", "art/probe.scene.json", { dryRun: true }) as unknown as { ok: boolean; bytes?: number; exports?: string[]; findings?: { severity: string }[]; error?: string };
  assert(r.ok, JSON.stringify(r).slice(0, 400));
  assert((r.findings || []).every((f) => f.severity !== "error"), "no errors");
});
if (BASE_READY) {
  test("_artprobe validates with zero errors (enemies.gon.append: ArtProbe, a Rat variant whose movieclip is our SWF)", () => {
    const r = validateMod("_artprobe");
    assert(r.ok, `expected ok, got ${r.counts.errors} errors: ${JSON.stringify(r.findings.filter((f) => f.severity === "error"))}`);
  });
}
// ---- 4d. mods/_golden-merge: the golden-through-dump overlays (TDD target 8; T1 against the real base) ----
if (BASE_READY) {
  test("_golden-merge validates with zero errors (test-only overlays: Rat .merge, GoldenRat .append, Pooter .patch, two loc rows)", () => {
    const r = validateMod("_golden-merge");
    assert(r.ok, `expected ok, got ${r.counts.errors} errors: ${JSON.stringify(r.findings.filter((f) => f.severity === "error"))}`);
    assert(!r.findings.some((f) => f.code === "mod-missing" || f.code === "mod-empty"), `mod present and non-empty: ${r.findings.map((f) => f.code).join(",")}`);
  });
  test("_golden-merge .merge preview: Rat changed (graphics.name -> GOLDEN_RAT_NAME, properties.faction allies), nothing added", () => {
    const p = previewMerge("_golden-merge", "data/characters/enemies.gon.merge");
    assert(p.ok, `preview: ${JSON.stringify(p)}`);
    if (!p.ok || p.kind !== "gon") throw new Error("gon preview expected");
    eq(p.mode, "merge");
    eq(p.touched.map((t) => `${t.key}:${t.status}`).join(","), "Rat:changed");
    const eff = p.touched[0]!.effective || "";
    assert(/name\s+"GOLDEN_RAT_NAME"/.test(eff) && /faction\s+allies/.test(eff), `effective Rat: ${eff.slice(0, 500)}`);
    assert(/ENEMY_LILRAT_NAME/.test(p.touched[0]!.base || "") && /faction\s+enemies/.test(p.touched[0]!.base || ""), "the base Rat is the vanilla one");
    eq(p.effectiveEntryCount, p.baseEntryCount);
  });
  test("_golden-merge .append preview: GoldenRat added as a new entry (variant_of Rat), base count + 1", () => {
    const p = previewMerge("_golden-merge", "data/characters/enemies.gon.append");
    assert(p.ok, `preview: ${JSON.stringify(p)}`);
    if (!p.ok || p.kind !== "gon") throw new Error("gon preview expected");
    eq(p.mode, "append");
    eq(p.touched.map((t) => `${t.key}:${t.status}`).join(","), "GoldenRat:added");
    eq(p.effectiveEntryCount, p.baseEntryCount + 1);
  });
  test("_golden-merge .patch preview: Pooter changed — faction.overwrite allies, stats.speed.add 10 -> 15 and properties.health.multiply 2 -> 12", () => {
    const p = previewMerge("_golden-merge", "data/characters/enemies.gon.patch");
    assert(p.ok, `preview: ${JSON.stringify(p)}`);
    if (!p.ok || p.kind !== "gon") throw new Error("gon preview expected");
    eq(p.mode, "patch");
    eq(p.touched.map((t) => `${t.key}:${t.status}`).join(","), "Pooter:changed");
    const eff = p.touched[0]!.effective || "";
    assert(/faction\s+allies/.test(eff), `faction overwritten: ${eff.slice(0, 500)}`);
    assert(/speed\s+15\b/.test(eff), `speed 5 + 10 = 15: ${eff.slice(0, 500)}`);
    assert(/health\s+12\b/.test(eff), `health 6 * 2 = 12 (the in-game twin is mods/_golden-merge/tests/numeric.mewtest): ${eff.slice(0, 500)}`);
    eq(p.effectiveEntryCount, p.baseEntryCount);
  });
  test("_golden-merge CSV .append preview: two 12-column loc rows added (GOLDEN_RAT_NAME, APPENDED_RAT_NAME)", () => {
    const p = previewMerge("_golden-merge", "data/text/combined.csv.append");
    assert(p.ok, `preview: ${JSON.stringify(p)}`);
    if (!p.ok || p.kind !== "csv" || !("addedRows" in p)) throw new Error("csv append preview expected");
    eq(p.addedRows.map((r) => r[0]).join(","), "GOLDEN_RAT_NAME,APPENDED_RAT_NAME");
    assert(p.addedRows.every((r) => r.length === 12), JSON.stringify(p.addedRows));
  });
} else console.log("  (skipped: base data not extracted; _golden-merge is checked against data/characters/enemies.gon)");

// ---- 4b. Validator fixtures (synthetic base; one mod per finding code; T0) ----
{
  let vt: typeof import("./validator-tests.ts") | null = null;
  try { vt = await import("./validator-tests.ts"); } catch (e) { test("validator-tests.ts loads", () => assert(false, String(e instanceof Error ? e.message : e))); }
  if (vt) vt.runValidatorTests(test, assert, eq);
}

// ---- 5. MCP smoke test ------------------------------------------------------
/** The `tools/call` result shape the smoke reads (MCP content blocks). */
interface ToolCallResult {
  content: { type: string; text: string }[];
}
interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}
async function mcpSmoke(): Promise<void> {
  console.log("\n# MCP server smoke (spawn + JSON-RPC)");
  const serverPath = join(REPO_ROOT, "editor", "src", "mcp", "server.ts");
  const child = spawn(process.argv[0]!, [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, Pending>();
  let id = 1;
  let buf = "";
  child.stdout.on("data", (chunk: Buffer | string) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number; error?: unknown; result?: unknown };
      try {
        msg = JSON.parse(line) as { id?: number; error?: unknown; result?: unknown };
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
  const req = (method: string, params: unknown): Promise<unknown> =>
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
  const notify = (method: string, params: unknown) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  /** The JSON payload a tool returned in its first text block. */
  const payloadOf = (res: unknown): Record<string, any> => JSON.parse((res as ToolCallResult).content[0]!.text) as Record<string, any>;

  try {
    const init = (await req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } })) as { protocolVersion: string };
    test("initialize returns protocol 2025-06-18", () => eq(init.protocolVersion, "2025-06-18"));
    notify("notifications/initialized", {});
    const list = (await req("tools/list", {})) as { tools: unknown[] };
    test("tools/list returns the 26 editor tools", () => eq(list.tools.length, 26));
    let bres: unknown = null, berr = "";
    try { bres = await req("tools/call", { name: "build_swf", arguments: { mod: "dev-sandbox", path: "art/my_rat.scene.json", dryRun: true } }); } catch (e) { berr = String(e); }
    test("tools/call build_swf (dry run of dev-sandbox/art/my_rat.scene.json) -> ok, bytes > 0, the reader self-check passes", () => {
      assert(bres !== null, berr);
      const p = payloadOf(bres);
      assert(p.ok === true && p.bytes > 0, JSON.stringify(p).slice(0, 300));
    });
    let ires: unknown = null, ierr = "";
    try { ires = await req("tools/call", { name: "import_svg", arguments: { svgText: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4" fill="#888"/></svg>' } }); } catch (e) { ierr = String(e); }
    test("tools/call import_svg { svgText } -> a shape with one path (nothing written)", () => {
      assert(ires !== null, ierr);
      const p = payloadOf(ires);
      assert(p.ok === true && p.shape && p.shape.paths.length === 1, JSON.stringify(p).slice(0, 300));
    });
    let pres2: unknown = null;
    let perr2 = "";
    try { pres2 = await req("tools/call", { name: "port_bindings", arguments: { build: "25143593", dryRun: true } }); } catch (e) { perr2 = String(e); }
    test("tools/call port_bindings (self-port dry run) -> { ok, dryRun, summary, rows, report } (or ok:false skipped without the game)", () => {
      assert(pres2 !== null, perr2);
      const payload = payloadOf(pres2);
      assert(typeof payload.ok === "boolean", "ok flag");
      if (payload.ok) {
        assert(payload.dryRun === true && payload.summary && Array.isArray(payload.rows) && typeof payload.report === "string", "shape");
        assert(!payload.needsAgent.length, `self-port needs no agent: ${JSON.stringify(payload.needsAgent).slice(0, 200)}`);
      } else assert(payload.skipped === true, JSON.stringify(payload));
    });
    let cres: unknown = null;
    let cerr = "";
    try { cres = await req("tools/call", { name: "check_game_build", arguments: {} }); } catch (e) { cerr = String(e); }
    test("tools/call check_game_build -> { ok, known, build, entries } (or ok:false skipped without the game)", () => {
      assert(cres !== null, cerr);
      const payload = payloadOf(cres);
      assert(typeof payload.ok === "boolean", "ok flag");
      if (payload.ok) {
        assert(typeof payload.known === "boolean" && Array.isArray(payload.entries) && payload.build, "shape");
      } else assert(payload.skipped === true && typeof payload.reason === "string", JSON.stringify(payload));
    });
    if (!BASE_READY) console.log("  (skipped: validate_mod / preview_merge need extracted base data)");
    else {
    const vres = await req("tools/call", { name: "validate_mod", arguments: { mod: "jokers-luck" } });
    test("tools/call validate_mod jokers-luck -> ok", () => {
      const payload = payloadOf(vres);
      assert(payload.ok === true, `expected ok, got ${JSON.stringify(payload.counts)}`);
    });
    const pres = await req("tools/call", { name: "preview_merge", arguments: { mod: "jokers-luck", path: "data/abilities/fighter_abilities.gon.append" } });
    test("tools/call preview_merge jokers-luck -> JokersGambit added", () => {
      const payload = payloadOf(pres);
      assert(payload.kind === "gon", "expected gon preview");
      const touched = payload.touched as { key: string; status: string }[];
      assert(touched.some((t) => t.key === "JokersGambit" && t.status === "added"), "JokersGambit should be added");
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
  const { runArtCoreTests } = await import("./art-core-tests.ts");
  const { runArtEmitterTests } = await import("./art-emitter-tests.ts");
  runArtEmitterTests(test, assert, eq);
  runArtCoreTests(test, assert, eq);
  const { runArtGradientTests } = await import("./art-gradient-tests.ts");
  await runArtGradientTests(test, assert, eq);
  const { runArtShape4Tests } = await import("./art-shape4-tests.ts");
  await runArtShape4Tests(test, assert, eq);
  const { runArtPo3Tests } = await import("./art-po3-tests.ts");
  runArtPo3Tests(test, assert, eq);
  const { runArtTimelineEditTests } = await import("./art-timeline-edit-tests.ts");
  await runArtTimelineEditTests(test, assert, eq);
  const { runArtCatRigTests } = await import("./art-catrig-tests.ts");
  await runArtCatRigTests(test, assert, eq);
  const { runArtSvgExportTests } = await import("./art-svg-export-tests.ts");
  await runArtSvgExportTests(test, assert, eq);
  const { runArtSvgReoriginTests } = await import("./art-svg-reorigin-tests.ts");
  await runArtSvgReoriginTests(test, assert, eq);
  const { runArtImportTests } = await import("./art-import-tests.ts");
  runArtImportTests(test, assert, eq);
  const { runArtTextTests } = await import("./art-text-tests.ts");
  await runArtTextTests(test, assert, eq);
  const { runArtGlowTests } = await import("./art-glow-tests.ts");
  await runArtGlowTests(test, assert, eq);
  const { runArtEngineRulesTests } = await import("./art-engine-rules-tests.ts");
  await runArtEngineRulesTests(test, assert, eq);
}

// ---- 7. In-game test harness runner (fake game; never launches Mewgenics) ---
{
  const { runIngameTests } = await import("./ingame-tests.ts");
  await runIngameTests(test, assert, eq);
}

// ---- 8. Bindings library (PE reader, scanner, manifest, port; fake PE + real exe T1) ---
{
  const { runBindingsTests } = await import("./bindings-tests.ts");
  await runBindingsTests(test, assert, eq);
}

// ---- 9. tools/gpak.py (synthetic archive; python -I; skips without python) ---
{
  let gp: typeof import("./gpak-tests.ts") | null = null;
  try { gp = await import("./gpak-tests.ts"); } catch (e) { test("gpak-tests.ts loads", () => assert(false, String(e instanceof Error ? e.message : e))); }
  if (gp) await gp.runGpakTests(test, assert, eq);
}

// ---- 9b. web layer: React store, pure UI helpers, zod request schemas, server gate ----
{
  let wt: typeof import("./web-tests.ts") | null = null;
  try { wt = await import("./web-tests.ts"); } catch (e) { test("web-tests.ts loads", () => assert(false, String(e instanceof Error ? e.message : e))); }
  if (wt) await wt.runWebTests(test, assert, eq);
}

// ---- 9c. TypeScript migration: structural + MCP schemas from zod ----
{
  let mt: typeof import("./ts-migration-tests.ts") | null = null;
  try { mt = await import("./ts-migration-tests.ts"); } catch (e) { test("ts-migration-tests.ts loads", () => assert(false, String(e instanceof Error ? e.message : e))); }
  if (mt) await mt.runTsMigrationTests(test, assert, eq);
}

// ---- 9d. CI policy: the test-change classifier + CLI (editor/scripts/check-test-change.ts) ----
{
  let ct: typeof import("./ci-tests.ts") | null = null;
  try { ct = await import("./ci-tests.ts"); } catch (e) { test("ci-tests.ts loads", () => assert(false, String(e instanceof Error ? e.message : e))); }
  if (ct) await ct.runCiTests(test, assert, eq);
  let pt: typeof import("./probe-tests.ts") | null = null;
  try { pt = await import("./probe-tests.ts"); } catch (e) { test("probe-tests.ts loads", () => assert(false, String(e instanceof Error ? e.message : e))); }
  if (pt) { pt.runProbeTests(test, assert, eq); pt.runProbeFixtureTests(test, assert, eq, (n) => readFileSync(join(HERE, "fixtures", "ingame", n), "utf8")); await pt.runPreviewAgreementTests(test, assert, eq, (n) => readFileSync(join(HERE, "fixtures", "ingame", n), "utf8"), readFileSync(join(HERE, "..", "web", "src", "art", "preview-gl.ts"), "utf8")); }
  let gm: typeof import("./glow-measure-tests.ts") | null = null;
  try { gm = await import("./glow-measure-tests.ts"); } catch (e) { test("glow-measure-tests.ts loads", () => assert(false, String(e instanceof Error ? e.message : e))); }
  if (gm) gm.runGlowMeasureTests(test, assert, eq, (n) => readFileSync(join(HERE, "fixtures", "ingame", n), "utf8"));
  let dt: typeof import("./deps-tests.ts") | null = null;
  try { dt = await import("./deps-tests.ts"); } catch (e) { test("deps-tests.ts loads", () => assert(false, String(e instanceof Error ? e.message : e))); }
  if (dt) await dt.runDepsTests(test, assert, eq);
  // VectorCraft vendoring (scripts/vendor-vectorcraft.ts): pinned-zip verification + the zip reader, no network
  let vt: typeof import("./vendor-vectorcraft-tests.ts") | null = null;
  try { vt = await import("./vendor-vectorcraft-tests.ts"); } catch (e) { test("vendor-vectorcraft-tests.ts loads", () => assert(false, String(e instanceof Error ? e.message : e))); }
  if (vt) await vt.runVendorVectorcraftTests(test, assert, eq);
  // the VectorCraft agent channel (vectorcraft_exec): the pipeline over a fake driver; one headless run that skips when not vendored
  let vx: typeof import("./vectorcraft-exec-tests.ts") | null = null;
  try { vx = await import("./vectorcraft-exec-tests.ts"); } catch (e) { test("vectorcraft-exec-tests.ts loads", () => assert(false, String(e instanceof Error ? e.message : e))); }
  if (vx) await vx.runVectorcraftExecTests(test, assert, eq);
  // repo.ts path constants + the merge preview against an injected base root (a fresh git worktree's needs)
  let rt: typeof import("./repo-tests.ts") | null = null;
  try { rt = await import("./repo-tests.ts"); } catch (e) { test("repo-tests.ts loads", () => assert(false, String(e instanceof Error ? e.message : e))); }
  if (rt) rt.runRepoTests(test, assert, eq);
  let pm: typeof import("./preview-merge-tests.ts") | null = null;
  try { pm = await import("./preview-merge-tests.ts"); } catch (e) { test("preview-merge-tests.ts loads", () => assert(false, String(e instanceof Error ? e.message : e))); }
  if (pm) pm.runPreviewMergeTests(test, assert, eq);
}

// ---- 10. T0 without .extracted/ (nested run; MEWGENICS_EXTRACTED_DATA -> empty dir) ----
if (!process.env.MEWGENICS_EXTRACTED_DATA) {
  console.log("\n# T0 without .extracted/ (nested run with MEWGENICS_EXTRACTED_DATA pointing at an empty dir)");
  test("npm test skips, not fails, when no base data is extracted (CI shape)", () => {
    // an empty extracted ROOT (…/data inside a fresh temp dir), so swfs/ and textures/ resolve empty too
    const empty = join(mkdtempSync(join(tmpdir(), "mewged-noextracted-")), "data");
    mkdirSync(empty);
    const r = spawnSync(process.argv[0]!, [join(HERE, "run-tests.ts")], { env: { ...process.env, MEWGENICS_EXTRACTED_DATA: empty }, encoding: "utf8", timeout: 600000, maxBuffer: 64 << 20 });
    const out = (r.stdout || "") + (r.stderr || "");
    const fails = out.split("\n").filter((l) => l.startsWith("FAIL")).slice(0, 6);
    assert(/\(skipped: no \.gon files under/.test(out), "inner run: expected a '(skipped: no .gon files under …)' line (env override honoured)");
    assert(r.status === 0 && /, 0 failed/.test(out), `inner run exit ${r.status}: ${fails.join(" | ") || out.slice(-300)}`);
  });
}

// ---- summary ----------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed${filter.only ? ` (${skipped} skipped by --only ${JSON.stringify(filter.only)})` : ""}`);
void pretty;
void HERE;
// exitCode, not process.exit(): on Windows, Node 26 fail-fasts (libuv async.c assertion) when exit() runs while
// the undici/fetch and child-process handles from web-tests.ts are still closing; letting the loop drain is clean.
process.exitCode = failed > 0 ? 1 : 0;
