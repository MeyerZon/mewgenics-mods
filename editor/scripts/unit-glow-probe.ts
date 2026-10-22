// npm run test:unitglow — the in-game proof of the native per-unit glow (T2): run mods/dev-sandbox/tests/unit-glow.mewtest
// in the real game (hide: false, two shots: "glow" with FW_SetUnitGlow magenta on the spawned Rat, "noglow" after
// FW_ClearUnitGlow), read both shots with glow-measure.ts and write unit-glow-summary.json into the run dir (the
// OBSERVED fixture editor/test/fixtures/ingame/unit-glow-summary.json is a copy of it).
// Exit 0 when the run passed and the glow shot holds a magenta rim the no-glow shot lacks, 1 otherwise, 2 when the game
// cannot run.
//   node scripts/unit-glow-probe.ts [--json]

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as api from "../src/core/api.ts";
import { decodePng } from "../src/core/art/png.ts";
import { measureGlow, compareGlowShots, GLOW_PROBE_COLOUR, type GlowMeasure } from "../src/core/art/glow-measure.ts";

const json = process.argv.includes("--json");
const report = await api.runIngameTest({ mod: "dev-sandbox", test: "unit-glow", hide: false });
if (!("verdict" in report)) { console.error(report.error); process.exit(2); }
if (report.verdict === "skipped" || report.verdict === "cannot-run") { console.log(`skipped: ${report.reason}`); process.exit(2); }
const shotOf = (label: string) => report.artifacts.shots.find((s) => s.label === label && s.path) || null;
const none: GlowMeasure = { pixels: 0, region: null };
const g = shotOf("glow"), n = shotOf("noglow");
const mg = g ? measureGlow(decodePng(readFileSync(g.path!)), GLOW_PROBE_COLOUR) : none;
const mn = n ? measureGlow(decodePng(readFileSync(n.path!)), GLOW_PROBE_COLOUR) : none;
const cmp = compareGlowShots(mg, mn);
const saveUnchanged = (report.safety.saveCheck ? report.safety.saveCheck.unchanged : true) && (report.safety.saveSet ? report.safety.saveSet.unchanged : true);
const summary = {
  ...cmp,
  colour: GLOW_PROBE_COLOUR,
  verdictRun: report.verdict,
  reason: report.reason,
  saveUnchanged,
  shots: { glow: g ? g.path : null, noglow: n ? n.path : null },
};
const dir = report.artifacts.runDir!;
writeFileSync(join(dir, "unit-glow-summary.json"), JSON.stringify({ summary, observed: "2026-10-22", script: "mods/dev-sandbox/tests/unit-glow.mewtest" }, null, 2) + "\n");
if (json) console.log(JSON.stringify({ verdict: report.verdict, runDir: dir, summary }));
else console.log(`glow shot: ${mg.pixels} magenta px, largest patch ${mg.region ? `${mg.region.count} px at (${mg.region.x0},${mg.region.y0})-(${mg.region.x1},${mg.region.y1})` : "none"}\nnoglow shot: ${mn.pixels} magenta px, largest patch ${mn.region ? `${mn.region.count} px` : "none"}\ndelta ${cmp.delta} -> ${cmp.verdict}\nrun: ${report.verdict} — ${report.reason}\nreal save unchanged: ${saveUnchanged}\nartifacts: ${dir}`);
process.exit(report.verdict === "pass" && cmp.verdict === "glow" ? 0 : 1);
