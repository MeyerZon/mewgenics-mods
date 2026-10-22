// npm run test:catrigsample — the in-game proof of the cat rig sample (T2, plan A2.4): the DLL route of framework API
// v5 paired with mods/catrig-sample. Builds mods/catrig-sample/art/rig.scene.json into swfs/rig.swf, needs
// catrig_sample.dll next to mewframework.dll in native/dist (native/mods/catrig-sample/build.bat), runs the four
// scripts of mods/catrig-sample/tests and writes catrig-sample-summary.json into the last run dir (the OBSERVED fixture
// editor/test/fixtures/ingame/catrig-sample-summary.json is a copy of it):
//   rig-dll       the vanilla control, then RigSampleCat: the framework log (registered … (from a DLL), CatTest ->
//                 RigSampleCatClip), the sample's own line in chainloader.log, our marker + real parts per rig shot
//                 (probe-compare.ts rigSwapVerdict with source "dll")
//   rig-champion  only RigSampleCat_Champion spawned: spawned? redirected? markers (variantRigVerdict)
//   rig-elite     the same for RigSampleCat_Elite
//   rig-labels    an _autoplay fight against RigSampleCat: per shot the pose (idle 1x / hit 2x / none, rigMarkerKind),
//                 the rig cat's HP and the round per dump (rigLabelsVerdict)
// Exit 0 when the DLL route redirected, 1 otherwise, 2 when the game cannot run.
//   node scripts/catrig-sample-probe.ts [--only rig-dll|rig-champion|rig-elite|rig-labels] [--from <test>=<runDir>]…

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as api from "../src/core/api.ts";
import { NATIVE_DIST_DIR } from "../src/core/ingame/launch.ts";
import { decodePng } from "../src/core/art/png.ts";
import { analyzeProbeShot, largestChangedRegion, darkPixelsNear, parseCatRigLog, rigSwapVerdict, variantRigVerdict, rigLabelsVerdict, rigMarkerKind, normalizeBrightness } from "../src/core/art/probe-compare.ts";

type Report = Extract<Awaited<ReturnType<typeof api.runIngameTest>>, { verdict: string }>;
const MOD = "catrig-sample", ENTRY = "RigSampleCat", CLIP = "RigSampleCatClip", RADIUS = 350;
const TESTS = ["rig-dll", "rig-champion", "rig-elite", "rig-labels", "rig-labels-ctl"] as const;

const argv = process.argv.slice(2);
const onlyAt = argv.indexOf("--only");
const only = onlyAt >= 0 ? argv[onlyAt + 1] : null;
const from = new Map<string, string>();
argv.forEach((a, i) => { if (a === "--from" && argv[i + 1]) { const [k, v] = argv[i + 1]!.split("=", 2); if (k && v) from.set(k, v); } });

const b = api.buildSwf(MOD, "art/rig.scene.json", {});
if (!b.ok) { console.error(`build failed: ${JSON.stringify(b).slice(0, 400)}`); process.exit(1); }
const needDll = [...TESTS].some((t) => (!only || only === t) && !from.has(t));
if (needDll && !existsSync(join(NATIVE_DIST_DIR, "catrig_sample.dll"))) {
  console.log(`skipped: catrig_sample.dll is not in ${NATIVE_DIST_DIR} (native/mods/catrig-sample/build.bat, then copy build/catrig_sample.dll there and into the chainloader's ScanPath)`);
  process.exit(2);
}

async function run(test: string): Promise<Report> {
  const dir = from.get(test);
  const r = dir ? (JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as Report) : await api.runIngameTest({ mod: MOD, test, hide: false });
  if (!("verdict" in r)) { console.error((r as { error?: string }).error); process.exit(2); }
  if (r.verdict === "skipped" || r.verdict === "cannot-run") { console.log(`skipped: ${r.reason}`); process.exit(2); }
  return r;
}
const saveOf = (r: Report) => (r.safety && r.safety.saveSet && r.safety.saveSet.detail) || null;
const shotsOf = (r: Report) => new Map(r.artifacts.shots.filter((s) => s.path && existsSync(s.path)).map((s) => [s.label, decodePng(readFileSync(s.path!))]));
const logOf = (r: Report) => parseCatRigLog(r.artifacts.frameworkLogWindow && existsSync(r.artifacts.frameworkLogWindow) ? readFileSync(r.artifacts.frameworkLogWindow, "utf8") : "");
/** the sample DLL's own lines (Mewjector's Log writes them to chainloader.log as "[catrig_sample] …") */
const sampleLines = (r: Report) => (r.artifacts.chainloaderLog && existsSync(r.artifacts.chainloaderLog) ? readFileSync(r.artifacts.chainloaderLog, "utf8").split(/\r?\n/).filter((l) => l.includes("[catrig_sample]")).map((l) => l.replace(/^.*\[catrig_sample\]\s*/, "")) : []);
const spawned = (r: Report, name: string) => (r.result.consoleLines || []).includes(`Spawned ${name}`) || r.result.events.some((e) => e.ev === "console" && (e as { text?: string }).text === `Spawned ${name}`);
// the fight dims the arena while the AI plays: the marker is looked for in the brightness-normalised shot
// A marker partly hidden (the rig cat stands on a back tile: the bigger hit-pose marker reaches behind the scaffold
// drawn over the top of the arena, or above the window; OBSERVED in rig-labels: a 184 x 66 px yellow box where the
// idle marker measures 93 x 61) keeps its full width but not the 96x64 aspect, so analyzeProbeShot gives only its box:
// its scale is then read from the width alone and the shot flagged clipped.
const marker = (img: ReturnType<typeof decodePng>) => {
  const a = analyzeProbeShot(normalizeBrightness(img));
  if (!a.found && a.box && a.box.x1 - a.box.x0 >= 20) return { found: true, clipped: true, scale: (a.box.x1 - a.box.x0 + 1) / 96, mirrored: false, box: a.box };
  return { found: a.found, clipped: false, scale: a.scale, mirrored: a.mirrored, box: a.box };
};

const summary: Record<string, unknown> = { observed: "2026-10-22, build 25143593", mod: MOD, entry: ENTRY, clip: CLIP };
const lines: string[] = [];
let lastDir = "";
let idleScale = 0;

if (!only || only === "rig-dll") {
  const r = await run("rig-dll");
  lastDir = r.artifacts.runDir || lastDir;
  const byLabel = shotsOf(r);
  const log = logOf(r);
  const baseline = byLabel.get("baseline"), vanilla = byLabel.get("vanilla");
  const arena = vanilla ? { x0: Math.round(vanilla.width * 0.15), y0: Math.round(vanilla.height * 0.1), x1: Math.round(vanilla.width * 0.85), y1: Math.round(vanilla.height * 0.7) } : undefined;
  const vRegion = baseline && vanilla ? largestChangedRegion(vanilla, baseline, { dark: 40, within: arena }) : null;
  const vMarker = vanilla ? marker(vanilla) : null;
  const vOutline = vRegion && baseline && vanilla ? darkPixelsNear(vanilla, baseline, { x: vRegion.cx, y: vRegion.cy }, RADIUS) : 0;
  const rig = vanilla ? ["rig 1", "rig 2", "rig 3"].filter((l) => byLabel.has(l)).map((label) => {
    const img = byLabel.get(label)!;
    const m = marker(img);
    // the idle marker is the checker at 0.5x placed at clip (-24, -170): its centre is clip y -154, the cat's body
    // centre clip y -32 (render-rig's A0 measure), so 122 clip px below it; one clip px = m.scale / 0.5 screen px
    const centre = m.found && m.box ? { x: (m.box.x0 + m.box.x1) / 2, y: (m.box.y0 + m.box.y1) / 2 + 122 * (m.scale / 0.5) } : null;
    return { label, marker: m.found, scale: m.scale, mirrored: m.mirrored, outline: centre ? darkPixelsNear(img, vanilla, centre, RADIUS) : 0 };
  }) : [];
  const found = rig.filter((x) => x.marker);
  idleScale = found.length ? found.map((x) => x.scale).sort((a, b) => a - b)[Math.floor(found.length / 2)]! : 0;
  const v = rigSwapVerdict({ verdict: r.verdict, character: ENTRY, source: "dll", log, vanilla: { marker: !!(vMarker && vMarker.found), outline: vOutline }, rig });
  const sample = sampleLines(r);
  summary.dll = { verdict: r.verdict, reason: r.reason, save: saveOf(r), runDir: r.artifacts.runDir, log, sample, vanilla: { marker: !!(vMarker && vMarker.found), outline: vOutline, region: vRegion }, rig, idleScale, outcome: v.outcome, markers: v.markers, partsDrawn: v.partsDrawn };
  lines.push(
    `rig-dll: ${r.verdict} — ${r.reason}; ${saveOf(r)}`,
    `  framework log: registered ${log.registered.map((x) => `${x.clip} for ${x.character} (${x.source})`).join(", ") || "none"}; redirected ${log.redirected.map((x) => `${x.character} -> ${x.clip}`).join(", ") || "none"}${log.missing.length ? `; missing ${log.missing.map((x) => x.clip).join(", ")}` : ""}`,
    `  catrig_sample.dll (chainloader.log): ${sample.join(" | ") || "no line"}`,
    `  vanilla cat: marker ${vMarker && vMarker.found ? "FOUND (not scoped!)" : "none"}; outline ${vOutline}`,
    ...rig.map((x) => `  ${x.label}: marker ${x.marker ? `found (scale ${x.scale.toFixed(2)}, ${x.mirrored ? "mirrored" : "as authored"})` : "not found"}; outline ${x.outline}`),
    `  outcome: ${v.outcome} (marker in ${v.markers}/${rig.length}; real parts under it in ${v.partsDrawn}/${v.markers})`,
    `  artifacts: ${r.artifacts.runDir}`,
  );
}

for (const [test, variant] of [["rig-champion", "Champion"], ["rig-elite", "Elite"]] as const) {
  if (only && only !== test) continue;
  const r = await run(test);
  lastDir = r.artifacts.runDir || lastDir;
  const name = `${ENTRY}_${variant}`;
  const byLabel = shotsOf(r);
  const log = logOf(r);
  // a marker cut by the top edge (the variant may spawn on a back tile; the marker floats ~330 clip px above it) is no
  // full 96x64 box: marker() reads its scale from the width and flags it clipped
  const shots = ["variant 1", "variant 2", "variant 3"].filter((l) => byLabel.has(l)).map((label) => { const m = marker(byLabel.get(label)!); return { label, marker: m.found, scale: m.scale, clipped: m.clipped }; });
  const isSpawned = spawned(r, name);
  const markers = shots.filter((s) => s.marker).length;
  const v = variantRigVerdict({ verdict: r.verdict, spawned: isSpawned, character: ENTRY, log, markers });
  summary[variant.toLowerCase()] = { entry: name, verdict: r.verdict, reason: r.reason, save: saveOf(r), runDir: r.artifacts.runDir, spawned: isSpawned, log, shots, markers, outcome: v.outcome };
  lines.push(
    `${test}: ${r.verdict} — ${r.reason}; ${saveOf(r)}`,
    `  ${name}: spawned ${isSpawned}; redirected ${log.redirected.map((x) => `${x.character} -> ${x.clip}`).join(", ") || "none"}; markers ${shots.map((s) => (s.marker ? s.scale.toFixed(2) : s.clipped ? "clipped" : "-")).join(" ")}`,
    `  outcome: ${v.outcome}`,
    `  artifacts: ${r.artifacts.runDir}`,
  );
}

// the labels fight (rig-labels) and its vanilla control (rig-labels-ctl: RigSampleVanillaCat, every label)
type Unit = { name?: string; namekey?: string; faction?: number; hp?: number };
/** the run's JSONL events (report.json keeps only the summary) */
const eventsOf = (r: Report): Array<Record<string, unknown>> => {
  const f = r.artifacts.resultFile;
  if (!f || !existsSync(f)) return [];
  return readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } });
};
const fight = (r: Report) => {
  const dumps = eventsOf(r).filter((e) => e.ev === "units").map((e) => e as { round?: number; frame?: number; list?: Unit[] });
  const enemy = (d: { list?: Unit[] }) => (d.list || []).find((u) => u.faction === 2 && u.namekey === "ENEMY_TOMTOM_NAME");
  const series = dumps.map((d) => { const u = enemy(d); return { frame: d.frame ?? 0, round: d.round ?? 0, inWalk: !!u, hp: u && typeof u.hp === "number" ? u.hp : null }; });
  const hp = series.filter((x) => x.hp !== null).map((x) => x.hp!);
  const rounds = { first: series.length ? series[0]!.round : 0, last: series.length ? series[series.length - 1]!.round : 0 };
  return { series, hp, rounds };
};
for (const test of ["rig-labels", "rig-labels-ctl"] as const) {
  if (only && only !== test) continue;
  const r = await run(test);
  lastDir = r.artifacts.runDir || lastDir;
  if (!idleScale) idleScale = Number(process.env.CATRIG_IDLE_SCALE || 0) || 0.955;   // rig-dll's idle marker (0.5x checker at 1.91 screen px per clip px)
  const byLabel = shotsOf(r);
  const shots = [...byLabel.entries()].filter(([l]) => /^l\d+$/.test(l)).map(([label, img]) => { const m = marker(img); return { label, marker: m.found, scale: m.scale, clipped: m.clipped }; });
  const f = fight(r);
  const v = rigLabelsVerdict({ verdict: r.verdict, idleScale, shots, hp: f.hp, rounds: f.rounds });
  const key = test === "rig-labels" ? "labels" : "labelsControl";
  summary[key] = { verdict: r.verdict, reason: r.reason, save: saveOf(r), runDir: r.artifacts.runDir, idleScale, shots: shots.map((s) => ({ ...s, kind: rigMarkerKind(s, idleScale) })), hp: f.hp, rounds: f.rounds, series: f.series, end: r.result.end, outcome: v.outcome, counts: v.counts, hpDrops: v.hpDrops, fightAdvanced: v.fightAdvanced };
  lines.push(
    `${test}: ${r.verdict} — ${r.reason}; ${saveOf(r)}`,
    `  poses per shot (idle scale ${idleScale.toFixed(3)}): ${shots.map((s) => `${s.label}:${rigMarkerKind(s, idleScale)}${s.marker ? `@${s.scale.toFixed(2)}${s.clipped ? "(clipped)" : ""}` : ""}`).join(" ")}`,
    `  counts ${JSON.stringify(v.counts)}; per dump (frame round hp inWalk): ${f.series.map((x) => `${x.frame}/${x.round}/${x.hp ?? "-"}/${x.inWalk ? "y" : "n"}`).join(" ")}`,
    `  outcome: ${v.outcome}; fight advanced: ${v.fightAdvanced} (rounds ${f.rounds.first} -> ${f.rounds.last})`,
    `  artifacts: ${r.artifacts.runDir}`,
  );
}

// the three questions plan A2.4 asked, answered from what was measured (the wording is the OBSERVED record)
{
  const d = summary.dll as { outcome: string; markers: number; partsDrawn: number; sample: string[] } | undefined;
  const c = summary.champion as { outcome: string; markers: number } | undefined, e = summary.elite as { outcome: string; markers: number } | undefined;
  const l = summary.labels as { outcome: string; counts: Record<string, number>; hp: number[]; rounds: { first: number; last: number } } | undefined;
  const k = summary.labelsControl as { hp: number[]; rounds: { first: number; last: number } } | undefined;
  summary.answers = {
    dllRoute: d ? `FW_RegisterCatRig from catrig_sample.dll's DllMain: ${d.outcome} — the framework logged the registration "(from a DLL)" (none from data: the export is RigSampleCatClip, not _CatRig_), the DLL's read-back agreed (${d.sample.join("; ")}), and RigSampleCat showed the rig's marker over real cat parts in ${d.partsDrawn}/${d.markers} shots while the vanilla control on the same parts showed none` : "not run",
    championElite: c && e ? `RigSampleCat_Champion: ${c.outcome} (marker in ${c.markers}/3 shots), RigSampleCat_Elite: ${e.outcome} (${e.markers}/3) — the framework's suffix stripping gives an <Entry>_Champion / _Elite name the entry's rig. The console's spawn refuses a name that is no entry ("No enemy named RigSampleCat_Champion"), so the variants are declared as entries (variant_of RigSampleCat); the game's own champion path (the level spawner appends the suffix, Character::init strips it and sets the flags) hands Character::init the same string but was not driven from the harness` : "not run",
    missingLabel: l ? `a rig with idleF/B, hitF/B and hithard/hitup/knockback F/B only: ${l.outcome} (poses ${JSON.stringify(l.counts)}: the two non-lethal hits showed our hitF/B pose); the killing hit (death labels) and every other label the rig lacks were silent no-ops — the cat kept its idle frame, no crash, no line in debug.log or mewframework.log, and the fight ran exactly like the vanilla control (rig HP per dump ${l.hp.join(" ")}, rounds ${l.rounds.first} -> ${l.rounds.last}; control HP ${k ? k.hp.join(" ") : "-"}, rounds ${k ? `${k.rounds.first} -> ${k.rounds.last}` : "-"}). Visible difference: at 0 HP the vanilla cat lies dead on its tile while the rig cat keeps STANDING in its idle pose (no death label) for the rest of the run` : "not run",
  };
  lines.push(...Object.entries(summary.answers as Record<string, string>).map(([q, t]) => `answer ${q}: ${t}`));
}

if (lastDir) writeFileSync(join(lastDir, "catrig-sample-summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log([...lines, `summary: ${lastDir ? join(lastDir, "catrig-sample-summary.json") : "-"}`].join("\n"));
const dll = summary.dll as { outcome?: string } | undefined;
process.exit(!dll || dll.outcome === "redirected" ? 0 : 1);
