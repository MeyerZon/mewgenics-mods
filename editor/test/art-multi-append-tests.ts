// Two mods appending to the same vanilla clip (2026-10-22). The probe (src/core/art/probe-multiappend.ts: the scenes
// committed as mods/_catappendA|B|Same/art/*.scene.json, the probe mods' data and scripts, the shot measure and the
// outcome) and the cross-mod check (src/core/art/append-conflicts.ts + validateMod's `modpaths` option: two enabled
// mods appending the same label, two mods shipping the same swfs/<file>.swf, a mod label shadowing a vanilla one).
// The OBSERVED in-game answer is pinned in test/fixtures/ingame/multi-append-summary.json
// (`npm run test:artprobe -- --multi-append`).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODS_DIR } from "../src/core/repo.ts";
import { validateScene } from "../src/core/art/scene.ts";
import { emitSwf } from "../src/core/art/swf-emitter.ts";
import { parseScript } from "../src/core/ingame/script.ts";
import { validateMod } from "../src/core/validate/validator.ts";
import { vanillaSwfDir } from "../src/core/repo.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
type Img = { width: number; height: number; rgba: Uint8Array };
function img(w: number, h: number, fill: (x: number, y: number) => [number, number, number]): Img {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = fill(x, y); const i = (y * w + x) * 4; rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255; }
  return { width: w, height: h, rgba };
}

export async function runArtMultiAppendTests(test: TestFn, assert: AssertFn, eq: EqFn): Promise<void> {
  console.log("\n# Art: two mods appending to CatTest (the multi-append probe and the cross-mod append check)");
  let P: Record<string, any> = {};
  let C: Record<string, any> = {};
  let err = "";
  try { P = await import("../src/core/art/probe-multiappend.ts"); } catch (e) { err += `probe-multiappend.ts: ${e instanceof Error ? e.message : String(e)} `; }
  try { C = await import("../src/core/art/append-conflicts.ts"); } catch (e) { err += `append-conflicts.ts: ${e instanceof Error ? e.message : String(e)}`; }
  const need = () => { if (err) throw new Error(err); };
  const sceneFile = (mod: string, name: string) => join(MODS_DIR, mod, "art", `${name}.scene.json`);

  test("multiAppendScene A / B / Same validate and are what mods/_catappend{A,B,Same}/art/*.scene.json hold (Same = B's scene under A's file name)", () => {
    need();
    for (const [mod, scene] of [["_catappendA", P.multiAppendScene("A")], ["_catappendB", P.multiAppendScene("B")], ["_catappendSame", P.multiAppendScene("B", { name: "catappendA" })]] as const) {
      const v = validateScene(JSON.parse(JSON.stringify(scene))) as any;
      assert(v.ok, JSON.stringify(v.findings.filter((f: any) => f.severity === "error")));
      const f = sceneFile(mod, scene.name);
      assert(existsSync(f), `${f} committed`);
      eq(JSON.stringify(JSON.parse(readFileSync(f, "utf8"))), JSON.stringify(v.scene), mod);
    }
    eq(P.multiAppendScene("B", { name: "catappendA" }).name, "catappendA");
  });

  test("each probe donor is the _Append_CatTest export with its own facing pair plus the shared probeC pair; the cat-animation checks pass (only the passthrough / untested notes)", () => {
    need();
    for (const w of ["A", "B"]) {
      const sc = P.multiAppendScene(w);
      const donor = sc.exports._Append_CatTest;
      eq(Object.keys(sc.sprites[donor].labels).sort().join(","), [`probe${w}F`, `probe${w}B`, "probeCF", "probeCB"].sort().join(","));
      const v = validateScene(JSON.parse(JSON.stringify(sc))) as any;
      eq(v.findings.filter((f: any) => f.severity !== "info" && f.code !== "passthrough-fill").map((f: any) => f.code).join(","), "");
    }
  });

  test("appendsOfSwf reads the emitted SWF's _Append_ exports and their frame labels (what the game merges)", () => {
    need();
    const out = emitSwf(P.multiAppendScene("A"), {});
    const a = C.appendsOfSwf(out.bytes);
    eq(JSON.stringify(a), JSON.stringify([{ target: "CatTest", labels: ["probeAF", "probeAB", "probeCF", "probeCB"] }]));
    eq(JSON.stringify(C.appendsOfScene(P.multiAppendScene("B"))), JSON.stringify([{ target: "CatTest", labels: ["probeBF", "probeBB", "probeCF", "probeCB"] }]));
  });

  test("countColour: a marker darkened by the arena light still counts (chromaticity), gray / dark / the other markers do not", () => {
    need();
    const im = img(40, 10, (x) => (x < 10 ? [255, 0, 255] : x < 20 ? [150, 10, 150] : x < 30 ? [128, 128, 128] : [0, 255, 255]));
    eq(P.countColour(im, "#ff00ff"), 200);
    eq(P.countColour(im, "#00ffff"), 100);
    eq(P.countColour(img(10, 10, () => [40, 0, 40]), "#ff00ff"), 0, "too dark to call");
    const m = P.measureMultiAppendShot("x", img(100, 100, (x, y) => (y < 50 ? [255, 0, 255] : x < 50 ? [0, 0, 255] : [60, 60, 60])));
    eq(JSON.stringify(m.present), JSON.stringify({ A: true, B: false, AC: true, BC: false }));
  });

  test("multiAppendOutcome: both own markers = merged; the collision winner is whichever probeC marker shows; a lost own marker is named", () => {
    need();
    const shot = (A: number, B: number, AC: number, BC: number) => ({ label: "all", counts: { A, B, AC, BC }, present: { A: A >= P.MARKER_MIN_PIXELS, B: B >= P.MARKER_MIN_PIXELS, AC: AC >= P.MARKER_MIN_PIXELS, BC: BC >= P.MARKER_MIN_PIXELS } });
    eq(JSON.stringify(P.multiAppendOutcome([shot(9000, 9000, 0, 9000)])), JSON.stringify({ own: { A: true, B: true }, collision: "B" }));
    eq(JSON.stringify(P.multiAppendOutcome([shot(9000, 9000, 9000, 0)])), JSON.stringify({ own: { A: true, B: true }, collision: "A" }));
    eq(JSON.stringify(P.multiAppendOutcome([shot(0, 9000, 0, 9000)])), JSON.stringify({ own: { A: false, B: true }, collision: "B" }));
    eq(JSON.stringify(P.multiAppendOutcome([shot(0, 0, 0, 0)])), JSON.stringify({ own: { A: false, B: false }, collision: "none" }));
  });

  test("the probe mods: ProbeCatA/C in _catappendA, ProbeCatB in _catappendB and _catappendSame, each TomTom with alt_animations [[idle probe<X>]]; SWFs named by the scenes", () => {
    for (const [mod, cats] of [["_catappendA", ["A", "C"]], ["_catappendB", ["B"]], ["_catappendSame", ["B"]]] as const) {
      const t = readFileSync(join(MODS_DIR, mod, "data", "characters", "enemies.gon.append"), "utf8");
      for (const c of ["A", "B", "C"]) eq(new RegExp(`ProbeCat${c} \\{[\\s\\S]*?alt_animations \\[\\[idle probe${c}\\]\\]`).test(t), (cats as readonly string[]).includes(c), `${mod} ProbeCat${c}`);
    }
  });

  test("the probe scripts parse; mods headers are A alone, B alone, A+B both orders and A+Same; no _autoplay (nothing hits the cats)", () => {
    const want: Record<string, string> = { "_catappendA/alone-a": "_catappendA", "_catappendB/alone-b": "_catappendB", "_catappendA/multi-append-ab": "_catappendA,_catappendB", "_catappendA/multi-append-ba": "_catappendB,_catappendA", "_catappendSame/same-name": "_catappendA,_catappendSame" };
    for (const [k, mods] of Object.entries(want)) {
      const [mod, name] = k.split("/");
      const p = parseScript(readFileSync(join(MODS_DIR, mod!, "tests", `${name}.mewtest`), "utf8")) as any;
      assert(p.ok !== false && !p.error, `${k}: ${JSON.stringify(p.error || p.errors)}`);
      eq((p.header?.mods || p.mods || []).join(","), mods, k);
    }
  });

  test("crossModAppendFindings: A then B -> cat-append-conflict on probeCF/probeCB (B wins, the later -modpaths mod) + cat-append-shared info; A alone -> nothing", () => {
    need();
    const A = { mod: "_catappendA", files: [{ file: "catappendA.swf", appends: C.appendsOfScene(P.multiAppendScene("A")) }] };
    const B = { mod: "_catappendB", files: [{ file: "catappendB.swf", appends: C.appendsOfScene(P.multiAppendScene("B")) }] };
    const f = C.crossModAppendFindings([A, B]);
    const conflict = f.filter((x: any) => x.code === "cat-append-conflict");
    eq(conflict.length, 1, JSON.stringify(f));
    eq(conflict[0].severity, "warning");
    assert(/probeCF, probeCB/.test(conflict[0].message) && /\(_catappendB wins/.test(conflict[0].message), conflict[0].message);
    eq(f.filter((x: any) => x.code === "cat-append-shared").length, 1);
    eq(f.filter((x: any) => x.code === "cat-append-shared")[0].severity, "info");
    const rev = C.crossModAppendFindings([B, A]).find((x: any) => x.code === "cat-append-conflict");
    assert(/\(_catappendA wins/.test(rev.message), rev.message);
    eq(C.crossModAppendFindings([A]).length, 0);
  });

  test("crossModAppendFindings: two mods shipping the same swfs/<file>.swf -> swf-file-conflict (the later mod's file loads for both; the earlier one's appends never merge)", () => {
    need();
    const A = { mod: "_catappendA", files: [{ file: "catappendA.swf", appends: C.appendsOfScene(P.multiAppendScene("A")) }] };
    const S = { mod: "_catappendSame", files: [{ file: "catappendA.swf", appends: C.appendsOfScene(P.multiAppendScene("B")) }] };
    const f = C.crossModAppendFindings([A, S]);
    const sf = f.find((x: any) => x.code === "swf-file-conflict");
    assert(sf && sf.severity === "warning" && /catappendA\.swf/.test(sf.message) && /_catappendSame/.test(sf.message), JSON.stringify(f));
    eq(f.filter((x: any) => x.code === "cat-append-conflict").length, 0, "the shadowed file's labels never reach the merge");
  });

  test("crossModAppendFindings: a mod label equal to a vanilla label of the target -> cat-append-shadows-vanilla; a mod file named like a vanilla SWF -> swf-file-shadows-vanilla", () => {
    need();
    const M = { mod: "m", files: [{ file: "catanis2.swf", appends: [{ target: "CatTest", labels: ["idleF", "idleB", "mineF", "mineB"] }] }] };
    const f = C.crossModAppendFindings([M], { files: ["catanis.swf", "catanis2.swf"], labels: { CatTest: ["idleF", "idleB", "crawlingIdleF"] } });
    const sv = f.find((x: any) => x.code === "cat-append-shadows-vanilla");
    assert(sv && sv.severity === "warning" && /idleF, idleB/.test(sv.message) && !/mineF/.test(sv.message), JSON.stringify(f));
    assert(f.some((x: any) => x.code === "swf-file-shadows-vanilla" && /catanis2\.swf/.test(x.message)), JSON.stringify(f));
  });

  test("validateMod(mod, undefined, { modpaths }) adds the cross-mod findings from the mods' scenes (built SWFs preferred); without modpaths there are none", () => {
    need();
    const r = validateMod("_catappendA", undefined, { modpaths: ["_catappendA", "_catappendB"], nativeBuild: null } as any);
    assert(r.findings.some((f) => f.code === "cat-append-conflict"), JSON.stringify(r.findings.map((f) => f.code)));
    const s = validateMod("_catappendA", undefined, { modpaths: ["_catappendA", "_catappendSame"], nativeBuild: null } as any);
    assert(s.findings.some((f) => f.code === "swf-file-conflict"), JSON.stringify(s.findings.map((f) => f.code)));
    const alone = validateMod("_catappendA", undefined, { nativeBuild: null });
    eq(alone.findings.filter((f) => /^(cat-append|swf-file)-/.test(f.code)).length, 0);
  });

  test("OBSERVED fixture multi-append-summary.json: both mods' appends coexist in either order, the later -modpaths mod wins the shared label, a same-named SWF drops the earlier mod's appends; multiAppendOutcome re-derives every run's outcome from its counts", () => {
    need();
    const f = join(HERE, "fixtures", "ingame", "multi-append-summary.json");
    assert(existsSync(f), "fixture present");
    const j = JSON.parse(readFileSync(f, "utf8"));
    for (const [k, run] of Object.entries(j.runs) as Array<[string, any]>) {
      eq(run.verdict, "pass", k);
      eq(JSON.stringify(P.multiAppendOutcome(run.shots)), JSON.stringify(run.outcome), k);
    }
    eq(JSON.stringify(j.runs.ab.outcome), JSON.stringify({ own: { A: true, B: true }, collision: "B" }));
    eq(JSON.stringify(j.runs.ba.outcome), JSON.stringify({ own: { A: true, B: true }, collision: "A" }));
    eq(JSON.stringify(j.runs.sameName.outcome), JSON.stringify({ own: { A: false, B: true }, collision: "B" }));
    eq(j.runs.aloneA.outcome.own.A, true);
    eq(j.runs.aloneB.outcome.own.B, true);
  });

  const vdir = vanillaSwfDir();
  if (existsSync(join(vdir, "catanis.swf")) && existsSync(join(vdir, "catanis2.swf"))) {
    test("T1 vanillaAppendLabels('CatTest') = CatTest's 776 labels plus catanis2's 239 appended ones (idleF, crawlingIdleF among them)", () => {
      need();
      const v = C.vanillaAppendLabels("CatTest", vdir);
      assert(v.includes("idleF") && v.includes("crawlingIdleF"), String(v.length));
      eq(v.length, 776 + 239);
      assert(readdirSync(vdir).includes("catanis2.swf"), "catanis2.swf listed");
    });
  } else console.log("  (skipped: T1 vanilla CatTest labels — no extracted catanis.swf / catanis2.swf)");
}
