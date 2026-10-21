// npm run test:artprobe — the in-game art probe (T2 + T3a): build mods/_artprobe/art/probe.scene.json into
// mods/_artprobe/swfs/probe.swf, run mods/_artprobe/tests/render-probe.mewtest in the real game (hide: false, six
// shots), read every shot with probe-compare.ts and write compare.md + summary.json into the run dir.
// --cat: run render-cat.mewtest instead (an ArtProbeCat enemy drawn by the CatProbe cat rig) and count each slot's
// colour in the shots (cat-summary.json; every slot present = the rig draws in the game).
// --cat-append: experiment A0 (2026-10-21) — run render-cat-append.mewtest (a baseline shot, TomTom as the real-parts
// control, ArtProbeCat as the primer — CatProbe drawn as a plain movieclip — then ArtProbeCatReal: TomTom whose idle is
// our _Append_CatTest frame placing the CatProbe rig), then the two control scripts (render-cat-append-ctl: a vanilla
// appended label; render-cat-append-missing: a label no clip has), and write cat-append-summary.json: per rig shot
// the slot colours left, the marker, and what changed near the marker vs the primer shot (probe-compare.ts
// changedPixelsNear), the same measure for the vanilla cat, the verdicts and crash RVAs. Outcome: filled-by-name
// (marker drawn, slot colours gone) / not-filled (slot colours still there) / no-marker / the verdict when the run
// did not pass (OBSERVED 2026-10-21: crash at Mewgenics.exe+0x741f5d on the spawn; engine-map "CatTest and the cat
// animation clips").
// Exit 0 when the run passed and the marker was found in at least one shot, 1 otherwise, 2 when the game cannot run.
//   node scripts/art-probe.ts [--json]

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as api from "../src/core/api.ts";
import { buildSwf } from "../src/core/art/art-io.ts";
import { decodePng } from "../src/core/art/png.ts";
import { analyzeProbeShot, summarizeProbe, renderProbeReport, slotColoursPresent, largestChangedRegion, changedPixelsNear, MARKER_COLOURS } from "../src/core/art/probe-compare.ts";

/** the CatProbe rig's slot colours (mods/_artprobe/art/probe.scene.json) */
export const CAT_PROBE_COLOURS: Record<string, string> = { tail: "#ff8000", leg2: "#8000ff", arm2: "#00a080", body: "#2080ff", leg1: "#ff60a0", arm1: "#a0ff40", head: "#ffd0a0" };

const json = process.argv.includes("--json");
const b = buildSwf("_artprobe", "art/probe.scene.json", {});
if (!b.ok) { console.error(`build failed: ${JSON.stringify(b).slice(0, 400)}`); process.exit(1); }
const cat = process.argv.includes("--cat");
const catAppend = process.argv.includes("--cat-append");
const report = await api.runIngameTest({ mod: "_artprobe", test: catAppend ? "render-cat-append" : cat ? "render-cat" : "render-probe", hide: false });
if (!("verdict" in report)) { console.error(report.error); process.exit(2); }
if (report.verdict === "skipped" || report.verdict === "cannot-run") { console.log(`skipped: ${report.reason}`); process.exit(2); }
if (catAppend) {
  /** the cat append probe: screen px around the marker (or the spawned unit) that count as "near" */
  const RADIUS = 350;
  const exclude = { ...CAT_PROBE_COLOURS, ...MARKER_COLOURS };
  const dirA = report.artifacts.runDir!;
  const crashRva = (reason: string) => { const m = /Mewgenics\.exe\+(0x[0-9a-f]+)/i.exec(reason); return m ? m[1]! : null; };
  // the two controls (TomTom with a vanilla appended label; TomTom with a label no clip has) tell a crash of the
  // main script apart from "alt_animations onto an appended frame" and "the label is not found"
  const controls: Record<string, { test: string; verdict: string; reason: string; crashRva: string | null }> = {};
  for (const [key, test] of [["crawlingIdle", "render-cat-append-ctl"], ["missingLabel", "render-cat-append-missing"]] as const) {
    const r = await api.runIngameTest({ mod: "_artprobe", test, hide: false });
    controls[key] = "verdict" in r ? { test, verdict: r.verdict, reason: r.reason, crashRva: crashRva(r.reason) } : { test, verdict: "launch-error", reason: r.error, crashRva: null };
  }
  const byLabel = new Map(report.artifacts.shots.filter((s) => s.path).map((s) => [s.label, decodePng(readFileSync(s.path!))]));
  const baseline = byLabel.get("baseline"), vanilla = byLabel.get("vanilla"), primer = byLabel.get("primer");
  const rigLabels = ["rig 1", "rig 2", "rig 3"].filter((l) => byLabel.has(l));
  const vRegion = baseline && vanilla ? largestChangedRegion(vanilla, baseline) : null;
  const vanillaOut = { label: "vanilla", region: vRegion, near: vRegion && baseline && vanilla ? changedPixelsNear(vanilla, baseline, { x: vRegion.cx, y: vRegion.cy }, RADIUS, { exclude }) : null };
  // the primer shot (ArtProbeCat: CatProbe drawn as a plain movieclip, not appended) is the rig shots' reference
  const ref = primer || vanilla;
  const rig = ref ? rigLabels.map((label) => {
    const img = byLabel.get(label)!;
    const a = analyzeProbeShot(img);
    const marker = a.box ? { found: a.found, box: a.box, scale: a.scale, mirrored: a.mirrored } : null;
    const region = largestChangedRegion(img, ref);
    const centre = a.box ? { x: (a.box.x0 + a.box.x1) / 2, y: (a.box.y0 + a.box.y1) / 2 } : region ? { x: region.cx, y: region.cy } : null;
    const slots = centre ? slotColoursPresent(img, CAT_PROBE_COLOURS, { centre, radius: RADIUS }) : slotColoursPresent(img, CAT_PROBE_COLOURS);
    const near = centre ? changedPixelsNear(img, ref, centre, RADIUS, { exclude }) : null;
    return { label, marker, centredOn: a.box ? "marker" : region ? "largest changed region" : "nothing", centre, slots, near, region };
  }) : [];
  const primerOut = primer && vanilla ? (() => { const a = analyzeProbeShot(primer); const c = a.box ? { x: (a.box.x0 + a.box.x1) / 2, y: (a.box.y0 + a.box.y1) / 2 } : null; return { label: "primer", marker: a.box ? { found: a.found, box: a.box, scale: a.scale, mirrored: a.mirrored } : null, slots: c ? slotColoursPresent(primer, CAT_PROBE_COLOURS, { centre: c, radius: RADIUS }) : null }; })() : null;
  const maxSlot = Math.max(0, ...rig.flatMap((r) => Object.values(r.slots)));
  const markers = rig.filter((r) => r.marker && r.marker.found).length;
  const outcome = report.verdict !== "pass" ? report.verdict : !markers ? "no-marker" : maxSlot <= 50 ? "filled-by-name" : "not-filled";
  const out = { observed: "2026-10-21, build 25143593", verdict: report.verdict, reason: report.reason, crashRva: crashRva(report.reason), controls, radius: RADIUS, slotColours: CAT_PROBE_COLOURS, outcome, shots: [...byLabel.keys()], vanilla: vanillaOut, primer: primerOut, rig };
  writeFileSync(join(dirA, "cat-append-summary.json"), JSON.stringify(out, null, 2) + "\n");
  const fmt = (n: { changed: number; excluded: number; other: number } | null) => (n ? `changed ${n.changed} (slot/marker ${n.excluded}, other ${n.other})` : "-");
  console.log([
    `vanilla TomTom: region ${vRegion ? `${vRegion.n} px at ${vRegion.cx},${vRegion.cy}` : "none"}; near: ${fmt(vanillaOut.near)}`,
    `primer (CatProbe as a plain movieclip): ${primerOut ? `marker ${primerOut.marker && primerOut.marker.found ? "found" : "not found"}; slots ${primerOut.slots ? Object.entries(primerOut.slots).map(([k, v]) => `${k} ${v}`).join(", ") : "-"}` : "no shot"}`,
    ...rig.map((r) => `${r.label}: marker ${r.marker && r.marker.found ? `found (scale ${r.marker.scale.toFixed(2)}, ${r.marker.mirrored ? "mirrored" : "as authored"})` : "not found"}; slots ${Object.entries(r.slots).map(([k, v]) => `${k} ${v}`).join(", ")}; near (${r.centredOn}): ${fmt(r.near)}`),
    `outcome: ${outcome} (max slot px ${maxSlot}, marker in ${markers}/${rig.length} rig shots)`,
    `run: ${report.verdict} — ${report.reason}`,
    ...Object.entries(controls).map(([k, c]) => `control ${k} (${c.test}): ${c.verdict} — ${c.reason}`),
    `artifacts: ${dirA}`,
  ].join("\n"));
  process.exit(report.verdict === "pass" && markers === rig.length ? 0 : 1);
}
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
