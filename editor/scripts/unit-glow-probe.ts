// npm run test:unitglow — the in-game proof of the native per-unit glow (T2): run mods/dev-sandbox/tests/unit-glow.mewtest
// in the real game (hide: false, three shots: "glow" with FW_SetUnitGlow magenta on the spawned Rat, "noglow" after
// FW_ClearUnitGlow, and — glow v2, per-unit colours — "two" with the Rat magenta and unit 0 cyan at once), read the
// shots with glow-measure.ts and write unit-glow-summary.json into the run dir (the OBSERVED fixture
// editor/test/fixtures/ingame/unit-glow-summary.json is a copy of it).
// Exit 0 when the run passed, the glow shot holds a magenta rim the no-glow shot lacks and the "two" shot holds a
// magenta rim and a cyan rim lying apart (compareTwoColourShot), 1 otherwise, 2 when the game cannot run.
//   node scripts/unit-glow-probe.ts [--json]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as api from "../src/core/api.ts";
import { decodePng } from "../src/core/art/png.ts";
import { parseResults } from "../src/core/ingame/results.ts";
import { measureGlow, compareGlowShots, compareTwoColourShot, compareExpiry, statusInDump, GLOW_PROBE_COLOUR, GLOW_PROBE_COLOUR_B, type GlowMeasure } from "../src/core/art/glow-measure.ts";

//   node scripts/unit-glow-probe.ts --data [--json]
// glow v3, the DATA seam: run mods/fw-glow/tests/data-glow.mewtest instead (no harness `glow` directive: the spawned
// FwGlowRat carries the status FwGlow_ff00ff from its character entry) and compare its "glow" shot with the pre-spawn
// "noglow" shot; writes data-glow-summary.json (fixture editor/test/fixtures/ingame/data-glow-summary.json).
//   node scripts/unit-glow-probe.ts --data-expiry [--json]
// the removal half: run mods/fw-glow/tests/data-glow-expiry.mewtest (FwGlowTempRat gets FwGlow_ff00ff as a Temporary
// that runs out after its first turn) and decide with compareExpiry: a rim in "glow", none in "expired", the status in
// the first dump and not in the last while the rat still lives; writes data-glow-expiry-summary.json (fixture
// editor/test/fixtures/ingame/data-glow-expiry-summary.json). Exit 0 only on verdict "expired".

const json = process.argv.includes("--json");
if (process.argv.includes("--data-expiry")) {
  const report = await api.runIngameTest({ mod: "fw-glow", test: "data-glow-expiry", hide: false });
  if (!("verdict" in report)) { console.error(report.error); process.exit(2); }
  if (report.verdict === "skipped" || report.verdict === "cannot-run") { console.log(`skipped: ${report.reason}`); process.exit(2); }
  const shot = (label: string) => report.artifacts.shots.find((s) => s.label === label && s.path) || null;
  const none: GlowMeasure = { pixels: 0, region: null };
  const m = (s: ReturnType<typeof shot>) => (s ? measureGlow(decodePng(readFileSync(s.path!)), GLOW_PROBE_COLOUR) : none);
  const g = shot("glow"), e = shot("expired"), n = shot("noglow");
  const dir = report.artifacts.runDir!;
  const resultPath = join(dir, "result.jsonl");
  const events = existsSync(resultPath) ? parseResults(readFileSync(resultPath, "utf8")).events : [];
  const dumps = events.filter((x) => x.ev === "units" && x.available === true);
  const UNIT = "Lil' Rat", STATUS = "FwGlow_ff00ff";
  const atGlow = statusInDump(dumps[0] ?? null, UNIT, STATUS), atExpired = statusInDump(dumps.length > 1 ? dumps[dumps.length - 1]! : null, UNIT, STATUS);
  const perDump = dumps.map((d) => statusInDump(d, UNIT, STATUS));
  const cmp = compareExpiry({ glow: m(g), expired: m(e), noglow: m(n) }, { atGlow, atExpired });
  const saveUnchanged = (report.safety.saveCheck ? report.safety.saveCheck.unchanged : true) && (report.safety.saveSet ? report.safety.saveSet.unchanged : true);
  const summary = { ...cmp, perDump, colour: GLOW_PROBE_COLOUR, verdictRun: report.verdict, reason: report.reason, saveUnchanged, shots: { glow: g ? g.path : null, expired: e ? e.path : null, noglow: n ? n.path : null } };
  writeFileSync(join(dir, "data-glow-expiry-summary.json"), JSON.stringify({ summary, observed: new Date().toISOString().slice(0, 10), script: "mods/fw-glow/tests/data-glow-expiry.mewtest" }, null, 2) + "\n");
  const patch = (c: typeof cmp.glow) => (c.glowRegion ? `${c.glowRegion.count} px at (${c.glowRegion.x0},${c.glowRegion.y0})-(${c.glowRegion.x1},${c.glowRegion.y1})` : "none");
  if (json) console.log(JSON.stringify({ verdict: report.verdict, runDir: dir, summary }));
  else console.log(`data glow expiry (FwGlowTempRat: FwGlow_ff00ff as a Temporary, turns 1):\nglow shot: ${cmp.glow.glowPixels} magenta px, largest patch ${patch(cmp.glow)} -> ${cmp.glow.verdict}\nexpired shot: ${cmp.expired.glowPixels} magenta px, largest patch ${patch(cmp.expired)} -> ${cmp.expired.verdict}\nnoglow (pre-spawn) shot: ${cmp.glow.noglowPixels} magenta px\nstatus per dump (${UNIT} carries ${STATUS}): ${perDump.map((d) => (d.found ? String(d.carries) : "unit missing")).join(", ")}\nexpiry verdict: ${cmp.verdict}\nrun: ${report.verdict} — ${report.reason}\nreal save unchanged: ${saveUnchanged}\nartifacts: ${dir}`);
  process.exit(report.verdict === "pass" && cmp.verdict === "expired" ? 0 : 1);
}
if (process.argv.includes("--data")) {
  const report = await api.runIngameTest({ mod: "fw-glow", test: "data-glow", hide: false });
  if (!("verdict" in report)) { console.error(report.error); process.exit(2); }
  if (report.verdict === "skipped" || report.verdict === "cannot-run") { console.log(`skipped: ${report.reason}`); process.exit(2); }
  const shot = (label: string) => report.artifacts.shots.find((s) => s.label === label && s.path) || null;
  const g = shot("glow"), n = shot("noglow");
  const none: GlowMeasure = { pixels: 0, region: null };
  const mg = g ? measureGlow(decodePng(readFileSync(g.path!)), GLOW_PROBE_COLOUR) : none;
  const mn = n ? measureGlow(decodePng(readFileSync(n.path!)), GLOW_PROBE_COLOUR) : none;
  const cmp = compareGlowShots(mg, mn);
  const saveUnchanged = (report.safety.saveCheck ? report.safety.saveCheck.unchanged : true) && (report.safety.saveSet ? report.safety.saveSet.unchanged : true);
  const summary = { ...cmp, colour: GLOW_PROBE_COLOUR, verdictRun: report.verdict, reason: report.reason, saveUnchanged, shots: { glow: g ? g.path : null, noglow: n ? n.path : null } };
  const dir = report.artifacts.runDir!;
  writeFileSync(join(dir, "data-glow-summary.json"), JSON.stringify({ summary, observed: new Date().toISOString().slice(0, 10), script: "mods/fw-glow/tests/data-glow.mewtest" }, null, 2) + "\n");
  if (json) console.log(JSON.stringify({ verdict: report.verdict, runDir: dir, summary }));
  else console.log(`data glow (FwGlow_ff00ff status from FwGlowRat's character entry):\nglow shot: ${mg.pixels} magenta px, largest patch ${mg.region ? `${mg.region.count} px at (${mg.region.x0},${mg.region.y0})-(${mg.region.x1},${mg.region.y1})` : "none"}\nnoglow (pre-spawn) shot: ${mn.pixels} magenta px\ndelta ${cmp.delta} -> ${cmp.verdict}\nrun: ${report.verdict} — ${report.reason}\nreal save unchanged: ${saveUnchanged}\nartifacts: ${dir}`);
  process.exit(report.verdict === "pass" && cmp.verdict === "glow" ? 0 : 1);
}
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
