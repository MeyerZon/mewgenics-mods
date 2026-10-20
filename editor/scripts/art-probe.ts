// npm run test:artprobe — the in-game art probe (T2 + T3a): build mods/_artprobe/art/probe.scene.json into
// mods/_artprobe/swfs/probe.swf, run mods/_artprobe/tests/render-probe.mewtest in the real game (hide: false, six
// shots), read every shot with probe-compare.ts and write compare.md + summary.json into the run dir.
// Exit 0 when the run passed and the marker was found in at least one shot, 1 otherwise, 2 when the game cannot run.
//   node scripts/art-probe.ts [--json]

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as api from "../src/core/api.ts";
import { buildSwf } from "../src/core/art/art-io.ts";
import { decodePng } from "../src/core/art/png.ts";
import { analyzeProbeShot, summarizeProbe, renderProbeReport } from "../src/core/art/probe-compare.ts";

const json = process.argv.includes("--json");
const b = buildSwf("_artprobe", "art/probe.scene.json", {});
if (!b.ok) { console.error(`build failed: ${JSON.stringify(b).slice(0, 400)}`); process.exit(1); }
const report = await api.runIngameTest({ mod: "_artprobe", test: "render-probe", hide: false });
if (!("verdict" in report)) { console.error(report.error); process.exit(2); }
if (report.verdict === "skipped" || report.verdict === "cannot-run") { console.log(`skipped: ${report.reason}`); process.exit(2); }
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
