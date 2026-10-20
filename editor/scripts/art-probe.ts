// npm run test:artprobe — the in-game art probe (T2 + T3a): build mods/_artprobe/art/probe.scene.json into
// mods/_artprobe/swfs/probe.swf, run mods/_artprobe/tests/render-probe.mewtest in the real game (hide: false, six
// shots), read every shot with probe-compare.ts and write compare.md + summary.json into the run dir.
// --cat: run render-cat.mewtest instead (an ArtProbeCat enemy drawn by the CatProbe cat rig) and count each slot's
// colour in the shots (cat-summary.json; every slot present = the rig draws in the game).
// Exit 0 when the run passed and the marker was found in at least one shot, 1 otherwise, 2 when the game cannot run.
//   node scripts/art-probe.ts [--json]

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as api from "../src/core/api.ts";
import { buildSwf } from "../src/core/art/art-io.ts";
import { decodePng } from "../src/core/art/png.ts";
import { analyzeProbeShot, summarizeProbe, renderProbeReport, slotColoursPresent } from "../src/core/art/probe-compare.ts";

/** the CatProbe rig's slot colours (mods/_artprobe/art/probe.scene.json) */
export const CAT_PROBE_COLOURS: Record<string, string> = { tail: "#ff8000", leg2: "#8000ff", arm2: "#00a080", body: "#2080ff", leg1: "#ff60a0", arm1: "#a0ff40", head: "#ffd0a0" };

const json = process.argv.includes("--json");
const b = buildSwf("_artprobe", "art/probe.scene.json", {});
if (!b.ok) { console.error(`build failed: ${JSON.stringify(b).slice(0, 400)}`); process.exit(1); }
const cat = process.argv.includes("--cat");
const report = await api.runIngameTest({ mod: "_artprobe", test: cat ? "render-cat" : "render-probe", hide: false });
if (!("verdict" in report)) { console.error(report.error); process.exit(2); }
if (report.verdict === "skipped" || report.verdict === "cannot-run") { console.log(`skipped: ${report.reason}`); process.exit(2); }
if (cat) {
  const shotsC = report.artifacts.shots.filter((s) => s.path);
  const per = shotsC.map((s) => slotColoursPresent(decodePng(readFileSync(s.path!)), CAT_PROBE_COLOURS, { anchor: "body", radius: 350 }));
  const slots: Record<string, number> = {};
  for (const k of Object.keys(CAT_PROBE_COLOURS)) slots[k] = Math.max(0, ...per.map((p) => p[k] || 0));
  const dirC = report.artifacts.runDir!;
  writeFileSync(join(dirC, "cat-summary.json"), JSON.stringify({ slots, perShot: per.map((p, i) => ({ label: shotsC[i]!.label, ...p })) }, null, 2) + "\n");
  const missing = Object.keys(slots).filter((k) => slots[k]! <= 50);
  console.log(`cat rig slots (max pixels per shot): ${Object.entries(slots).map(([k, v]) => `${k} ${v}`).join(", ")}\n${missing.length ? `missing: ${missing.join(", ")}` : "every slot drawn"}\nrun: ${report.verdict} — ${report.reason}\nartifacts: ${dirC}`);
  process.exit(report.verdict === "pass" && !missing.length ? 0 : 1);
}
const shots = report.artifacts.shots.filter((s) => s.path);
const analyzed = shots.map((s) => analyzeProbeShot(decodePng(readFileSync(s.path!))));
const summary = summarizeProbe(analyzed);
const md = renderProbeReport(analyzed, summary, shots.map((s) => s.label));
const dir = report.artifacts.runDir!;
writeFileSync(join(dir, "compare.md"), md);
writeFileSync(join(dir, "summary.json"), JSON.stringify({ summary, shots: analyzed.map((a, i) => ({ label: shots[i]!.label, ...a })) }, null, 2) + "\n");
if (json) console.log(JSON.stringify({ verdict: report.verdict, runDir: dir, summary }));
else console.log(`${md}\nrun: ${report.verdict} — ${report.reason}\nartifacts: ${dir}`);
process.exit(report.verdict === "pass" && summary.found > 0 ? 0 : 1);
