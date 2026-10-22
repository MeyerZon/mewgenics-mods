// npm run test:unitglow — the in-game proof of the native per-unit glow (T2): run mods/dev-sandbox/tests/unit-glow.mewtest
// in the real game (hide: false, three shots: "glow" with FW_SetUnitGlow magenta on the spawned Rat, "noglow" after
// FW_ClearUnitGlow, and — glow v2, per-unit colours — "two" with the Rat magenta and unit 0 cyan at once), read the
// shots with glow-measure.ts and write unit-glow-summary.json into the run dir (the OBSERVED fixture
// editor/test/fixtures/ingame/unit-glow-summary.json is a copy of it).
// Exit 0 when the run passed, the glow shot holds a magenta rim the no-glow shot lacks and the "two" shot holds a
// magenta rim and a cyan rim lying apart (compareTwoColourShot), 1 otherwise, 2 when the game cannot run.
//   node scripts/unit-glow-probe.ts [--json]

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as api from "../src/core/api.ts";
import { decodePng } from "../src/core/art/png.ts";
import { measureGlow, compareGlowShots, compareTwoColourShot, GLOW_PROBE_COLOUR, GLOW_PROBE_COLOUR_B, type GlowMeasure } from "../src/core/art/glow-measure.ts";

const json = process.argv.includes("--json");
const report = await api.runIngameTest({ mod: "dev-sandbox", test: "unit-glow", hide: false });
if (!("verdict" in report)) { console.error(report.error); process.exit(2); }
if (report.verdict === "skipped" || report.verdict === "cannot-run") { console.log(`skipped: ${report.reason}`); process.exit(2); }
const shotOf = (label: string) => report.artifacts.shots.find((s) => s.label === label && s.path) || null;
const none: GlowMeasure = { pixels: 0, region: null };
const g = shotOf("glow"), n = shotOf("noglow"), t2 = shotOf("two");
const img = (s: typeof g) => (s ? decodePng(readFileSync(s.path!)) : null);
const ig = img(g), inn = img(n), it = img(t2);
const mg = ig ? measureGlow(ig, GLOW_PROBE_COLOUR) : none;
const mn = inn ? measureGlow(inn, GLOW_PROBE_COLOUR) : none;
const cmp = compareGlowShots(mg, mn);
// v2: the "two" shot against the no-glow shot, in both colours
const two = compareTwoColourShot(
  { a: it ? measureGlow(it, GLOW_PROBE_COLOUR) : none, b: it ? measureGlow(it, GLOW_PROBE_COLOUR_B) : none },
  { a: mn, b: inn ? measureGlow(inn, GLOW_PROBE_COLOUR_B) : none },
);
const saveUnchanged = (report.safety.saveCheck ? report.safety.saveCheck.unchanged : true) && (report.safety.saveSet ? report.safety.saveSet.unchanged : true);
const summary = {
  ...cmp,
  colour: GLOW_PROBE_COLOUR,
  verdictRun: report.verdict,
  reason: report.reason,
  saveUnchanged,
  shots: { glow: g ? g.path : null, noglow: n ? n.path : null, two: t2 ? t2.path : null },
  two: { ...two, colours: [GLOW_PROBE_COLOUR, GLOW_PROBE_COLOUR_B] },
};
const dir = report.artifacts.runDir!;
writeFileSync(join(dir, "unit-glow-summary.json"), JSON.stringify({ summary, observed: "2026-10-22", script: "mods/dev-sandbox/tests/unit-glow.mewtest" }, null, 2) + "\n");
if (json) console.log(JSON.stringify({ verdict: report.verdict, runDir: dir, summary }));
else console.log(`glow shot: ${mg.pixels} magenta px, largest patch ${mg.region ? `${mg.region.count} px at (${mg.region.x0},${mg.region.y0})-(${mg.region.x1},${mg.region.y1})` : "none"}\nnoglow shot: ${mn.pixels} magenta px, largest patch ${mn.region ? `${mn.region.count} px` : "none"}\ndelta ${cmp.delta} -> ${cmp.verdict}\ntwo shot (v2): magenta ${two.a.glowPixels} px (patch ${two.a.glowRegion ? `${two.a.glowRegion.count} px at (${two.a.glowRegion.x0},${two.a.glowRegion.y0})-(${two.a.glowRegion.x1},${two.a.glowRegion.y1})` : "none"}), cyan ${two.b.glowPixels} px (patch ${two.b.glowRegion ? `${two.b.glowRegion.count} px at (${two.b.glowRegion.x0},${two.b.glowRegion.y0})-(${two.b.glowRegion.x1},${two.b.glowRegion.y1})` : "none"}), apart ${two.apart} -> ${two.verdict}\nrun: ${report.verdict} — ${report.reason}\nreal save unchanged: ${saveUnchanged}\nartifacts: ${dir}`);
process.exit(report.verdict === "pass" && cmp.verdict === "glow" && two.verdict === "two-colour" ? 0 : 1);
