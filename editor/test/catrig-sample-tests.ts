// The cat rig sample (plan A2.4, 2026-10-22): the DLL route of framework API v5 paired with a data mod.
// native/mods/catrig-sample/ (catrig_sample.dll) calls FW_RegisterCatRig({"RigSampleCat", "RigSampleCatClip"});
// mods/catrig-sample/ ships the entry RigSampleCat (movieclip _CAT, custom_cat_data RigSampleParts) and the art scene
// whose root clip is exported as RigSampleCatClip — not _CatRig_<Entry>, so only the DLL can bind it. Labels idleF/B
// (the yellow marker at 1x) and hitF/B (the marker at 2x); everything else (walk, attack, death …) is missing on
// purpose, to OBSERVE what the game does with a label a swap rig lacks.
// Tests here: the scene / data / native pair agree; the mewtest scripts parse and assert the framework log lines;
// the pure verdicts (probe-compare.ts) and the OBSERVED fixture catrig-sample-summary.json.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODS_DIR, REPO_ROOT, EXTRACTED_DATA } from "../src/core/repo.ts";
import { validateScene } from "../src/core/art/scene.ts";
import { parseScript } from "../src/core/ingame/script.ts";
import { validateMod } from "../src/core/validate/validator.ts";
import * as pc from "../src/core/art/probe-compare.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOD = join(MODS_DIR, "catrig-sample");
const SLOTS = ["tail", "leg2", "arm2", "body", "leg1", "arm1", "head"];

export async function runCatRigSampleTests(test: TestFn, assert: AssertFn, eq: EqFn): Promise<void> {
  console.log("\n# Cat rig sample (DLL route, API v5)");
  const read = (rel: string) => readFileSync(join(MOD, rel), "utf8");
  const has = (rel: string) => existsSync(join(MOD, rel));

  test("mods/catrig-sample ships the entry, its parts, the art scene and the T2 scripts", () => {
    for (const f of ["description.json", "data/characters/cat_enemies.gon.append", "data/custom_cats.gon.append", "art/rig.scene.json", "tests/rig-dll.mewtest", "tests/rig-champion.mewtest", "tests/rig-elite.mewtest", "tests/rig-labels.mewtest"]) assert(has(f), `missing mods/catrig-sample/${f}`);
  });
  if (!has("art/rig.scene.json")) return;

  const sceneRaw = JSON.parse(read("art/rig.scene.json"));
  test("the scene validates with no errors and exports RigSampleCatClip — no _CatRig_ export, so the data seam cannot bind it", () => {
    const v = validateScene(sceneRaw);
    assert(v.ok, JSON.stringify(v.findings.filter((f) => f.severity === "error")));
    const exports = Object.keys(sceneRaw.exports || {});
    assert(exports.includes("RigSampleCatClip"), `exports: ${exports.join(", ")}`);
    assert(!exports.some((e) => e.startsWith("_CatRig_")), `a _CatRig_ export would bind from data: ${exports.join(", ")}`);
    assert(!exports.some((e) => e.startsWith("_Append_")), "no append: the vanilla CatTest stays untouched");
  });

  test("the rig root has exactly idleF / idleB / hitF / hitB, each placing a 7-empty-slot rig:cat pose as `ani` at depth 1; walk / attack / death are missing on purpose", () => {
    const rootName = sceneRaw.exports.RigSampleCatClip as string;
    const root = sceneRaw.sprites[rootName];
    eq(Object.keys(root.labels).sort().join(","), "hitB,hitF,idleB,idleF");
    for (const missing of ["walkF", "attackF", "dyingF", "deadF", "knockbackF"]) assert(!(missing in root.labels), missing);
    eq(root.layers.length, 1);
    eq(root.layers[0].name, "ani"); eq(root.layers[0].depth, 1);
    for (const [label, frame] of Object.entries(root.labels as Record<string, number>)) {
      const key = root.layers[0].keys.find((k: { frame: number }) => k.frame === frame);
      assert(key, `${label}: no key at frame ${frame}`);
      const pose = sceneRaw.sprites[key.ref];
      assert(pose && pose.rig === "cat" && pose.parts === "game", `${label}: ${key.ref} is not a parts:"game" cat rig`);
      for (const s of SLOTS) {
        const l = pose.layers.find((x: { name: string }) => x.name === s);
        assert(l, `${label}: slot ${s} missing`);
        const slot = sceneRaw.sprites[l.keys[0].ref];
        eq(slot.layers.length, 0, `${label}: slot ${s} must be EMPTY (CatParts fills it)`);
      }
    }
  });

  test("the hit pose's marker is the idle marker at 2x (the probe tells the labels apart by the marker's scale)", () => {
    const root = sceneRaw.sprites[sceneRaw.exports.RigSampleCatClip];
    const poseOf = (label: string) => sceneRaw.sprites[root.layers[0].keys.find((k: { frame: number }) => k.frame === root.labels[label]).ref];
    const markerScale = (pose: any) => {
      const l = pose.layers.find((x: { name: string }) => x.name === "marker");
      const m = l.keys[0].matrix as number[] | undefined;
      return m ? m[0] : 1;
    };
    eq(markerScale(poseOf("idleF")), 1); eq(markerScale(poseOf("idleB")), 1);
    eq(markerScale(poseOf("hitF")), 2); eq(markerScale(poseOf("hitB")), 2);
  });

  test("the native pair: catrig_sample_rules.c registers RigSampleCat -> RigSampleCatClip, the entry the mod appends (movieclip _CAT, custom_cat_data RigSampleParts) and the clip the scene exports", () => {
    const c = readFileSync(join(REPO_ROOT, "native", "mods", "catrig-sample", "src", "catrig_sample_rules.c"), "utf8");
    assert(/\{\s*"RigSampleCat"\s*,\s*"RigSampleCatClip"\s*\}/.test(c), "CS_RIGS pair");
    const gon = read("data/characters/cat_enemies.gon.append");
    assert(/RigSampleCat\s*\{[\s\S]*?movieclip\s+_CAT[\s\S]*?custom_cat_data\s+RigSampleParts/.test(gon), "RigSampleCat entry");
    assert(/RigSampleVanillaCat\s*\{[\s\S]*?movieclip\s+_CAT[\s\S]*?custom_cat_data\s+RigSampleParts/.test(gon), "the control on the same parts");
    assert(/^RigSampleParts\s*\{/m.test(read("data/custom_cats.gon.append")), "RigSampleParts");
  });

  if (existsSync(join(EXTRACTED_DATA, "characters", "cat_enemies.gon"))) test("T1: catrig-sample validates with zero errors", () => {
    const r = validateMod("catrig-sample", undefined, { nativeBuild: { known: true, matched: { steamBuildId: "25143593" } } as any });
    assert(r.ok, `expected ok, got ${r.counts.errors} errors: ${JSON.stringify(r.findings.filter((f) => f.severity === "error"))}`);
  });
  else console.log("  (skipped: base characters not extracted; catrig-sample validation)");

  const scriptOf = (name: string) => parseScript(read(`tests/${name}.mewtest`), { owningMod: "catrig-sample", name });
  test("rig-dll.mewtest: the vanilla control then RigSampleCat, three shots, and the framework log lines of the DLL route (registered … (from a DLL), CatTest -> RigSampleCatClip)", () => {
    const p = scriptOf("rig-dll");
    assert(p.ok, JSON.stringify(p.errors));
    const fw = p.directives.filter((d) => d.kind === "expect" && d.what === "fwlog").map((d) => (d as { substr: string }).substr);
    assert(fw.includes("catrig: registered RigSampleCatClip for RigSampleCat (from a DLL)"), fw.join(" | "));
    assert(fw.includes("catrig: RigSampleCat: CatTest -> RigSampleCatClip"), fw.join(" | "));
    const shots = p.directives.filter((d) => d.kind === "shot").map((d) => (d as { label: string }).label);
    eq(shots.join(","), "baseline,vanilla,rig 1,rig 2,rig 3");
    assert(p.hide === false, "shots need a visible window");
  });
  for (const [name, entry] of [["rig-champion", "RigSampleCat_Champion"], ["rig-elite", "RigSampleCat_Elite"]] as const) test(`${name}.mewtest spawns only ${entry} (so the redirect line is that spawn's) and shoots it`, () => {
    const p = scriptOf(name);
    assert(p.ok, JSON.stringify(p.errors));
    const cmds = p.directives.filter((d) => d.kind === "cmd").map((d) => (d as { text: string }).text);
    eq(cmds.filter((c) => c.startsWith("spawn ")).join(","), `spawn ${entry}`);
    assert(p.directives.some((d) => d.kind === "shot"), "shots");
  });
  test("rig-labels.mewtest: an autoplay fight against RigSampleCat with many shots and dumps (hit vs the labels the rig lacks)", () => {
    const p = scriptOf("rig-labels");
    assert(p.ok, JSON.stringify(p.errors));
    assert(p.mods.includes("_autoplay"), p.mods.join(","));
    assert(p.directives.filter((d) => d.kind === "shot").length >= 20, "at least 20 shots");
    assert(p.directives.filter((d) => d.kind === "dump").length >= 3, "dumps for the HP series");
  });

  // ---- pure verdicts -------------------------------------------------------------------------------------------
  test("rigMarkerKind: the marker's scale against the idle scale — ~1x idle, ~2x hit, else other; no marker none", () => {
    eq(pc.rigMarkerKind({ marker: false, scale: 0 }, 1.9), "none");
    eq(pc.rigMarkerKind({ marker: true, scale: 1.91 }, 1.9), "idle");
    eq(pc.rigMarkerKind({ marker: true, scale: 1.6 }, 1.9), "idle");
    eq(pc.rigMarkerKind({ marker: true, scale: 3.8 }, 1.9), "hit");
    eq(pc.rigMarkerKind({ marker: true, scale: 3.3 }, 1.9), "hit");
    eq(pc.rigMarkerKind({ marker: true, scale: 2.85 }, 1.9), "other");
    eq(pc.rigMarkerKind({ marker: true, scale: 6 }, 1.9), "other");
    eq(pc.rigMarkerKind({ marker: true, scale: 1.9 }, 0), "other", "no idle reference");
  });
  test("rigSwapVerdict with source: a DLL-route probe needs the registration to come from the DLL (wrong-source otherwise)", () => {
    const log = { registered: [{ clip: "RigSampleCatClip", character: "RigSampleCat", source: "dll" as const }], redirected: [{ character: "RigSampleCat", clip: "RigSampleCatClip" }], missing: [], refused: [] };
    const base = { verdict: "pass", character: "RigSampleCat", log, vanilla: { marker: false, outline: 10000 }, rig: [1, 2, 3].map((i) => ({ label: `rig ${i}`, marker: true, outline: 15000 })) };
    eq(pc.rigSwapVerdict({ ...base, source: "dll" }).outcome, "redirected");
    eq(pc.rigSwapVerdict({ ...base, source: "data" }).outcome, "wrong-source");
    eq(pc.rigSwapVerdict(base).outcome, "redirected", "no source: either route");
  });
  test("variantRigVerdict: a champion / elite spawn is redirected when the run passed, the game spawned it and the log shows the base entry's redirect", () => {
    const log = { registered: [{ clip: "RigSampleCatClip", character: "RigSampleCat", source: "dll" as const }], redirected: [{ character: "RigSampleCat", clip: "RigSampleCatClip" }], missing: [], refused: [] };
    const v = (o: Record<string, unknown>) => pc.variantRigVerdict({ verdict: "pass", spawned: true, character: "RigSampleCat", log, markers: 2, ...o } as any);
    eq(v({}).outcome, "redirected");
    eq(v({ markers: 0 }).outcome, "redirected", "the log decides; markers are reported (a tint can hide the yellow)");
    eq(v({ markers: 0 }).markers, 0);
    eq(v({ spawned: false }).outcome, "not-spawned");
    eq(v({ log: { ...log, redirected: [] } }).outcome, "not-redirected");
    eq(v({ verdict: "fail" }).outcome, "fail");
  });
  test("rigLabelsVerdict: counts idle / hit / none / other shots, HP drops of the rig cat and whether the fight advanced; hit-drawn needs a hit-scale marker", () => {
    const shots = (kinds: string[]) => kinds.map((k, i) => ({ label: `l${i}`, marker: k !== "none", scale: k === "hit" ? 3.8 : k === "idle" ? 1.9 : k === "other" ? 2.8 : 0 }));
    const base = { verdict: "pass", idleScale: 1.9, hp: [30, 30, 24, 18], rounds: { first: 1, last: 3 } };
    const a = pc.rigLabelsVerdict({ ...base, shots: shots(["idle", "hit", "hit", "idle", "none"]) });
    eq(a.outcome, "hit-drawn"); eq(a.counts.idle, 2); eq(a.counts.hit, 2); eq(a.counts.none, 1); eq(a.hpDrops, 2); eq(a.fightAdvanced, true);
    eq(pc.rigLabelsVerdict({ ...base, shots: shots(["idle", "idle"]) }).outcome, "hit-not-caught", "hp dropped, no hit shot");
    eq(pc.rigLabelsVerdict({ ...base, hp: [30, 30], shots: shots(["idle"]) }).outcome, "never-hit");
    eq(pc.rigLabelsVerdict({ ...base, rounds: { first: 1, last: 1 }, shots: shots(["idle"]) }).fightAdvanced, false);
    eq(pc.rigLabelsVerdict({ ...base, verdict: "timeout", shots: shots(["idle"]) }).outcome, "timeout");
  });

  // ---- the OBSERVED fixture ------------------------------------------------------------------------------------
  test("OBSERVED fixture catrig-sample-summary.json (npm run test:catrigsample): the DLL route redirected RigSampleCat (registration from a DLL, none from data), the champion and elite answers and the missing-label observation, all recomputed from the recorded numbers", () => {
    const p = join(HERE, "fixtures", "ingame", "catrig-sample-summary.json");
    assert(existsSync(p), "written by npm run test:catrigsample (copy of the run dir's catrig-sample-summary.json)");
    const j = JSON.parse(readFileSync(p, "utf8"));
    eq(j.dll.verdict, "pass");
    assert(/unchanged/.test(j.dll.save || ""), `save guard: ${j.dll.save}`);
    const regs = j.dll.log.registered.filter((r: { character: string }) => r.character === "RigSampleCat");
    eq(regs.map((r: { source: string }) => r.source).join(","), "dll", "registered once, from the DLL");
    const dll = pc.rigSwapVerdict({ verdict: j.dll.verdict, character: "RigSampleCat", source: "dll", log: j.dll.log, vanilla: j.dll.vanilla, rig: j.dll.rig });
    eq(dll.outcome, j.dll.outcome); eq(dll.outcome, "redirected");
    for (const k of ["champion", "elite"]) {
      const x = j[k];
      eq(pc.variantRigVerdict({ verdict: x.verdict, spawned: x.spawned, character: "RigSampleCat", log: x.log, markers: x.markers }).outcome, x.outcome, k);
    }
    const lv = pc.rigLabelsVerdict({ verdict: j.labels.verdict, idleScale: j.labels.idleScale, shots: j.labels.shots, hp: j.labels.hp, rounds: j.labels.rounds });
    eq(lv.outcome, j.labels.outcome);
    for (const k of ["dllRoute", "championElite", "missingLabel"]) assert(typeof j.answers[k] === "string" && j.answers[k].length > 20, `answers.${k}`);
  });
}
