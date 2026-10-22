// npm run test:artprobe — the in-game art probe (T2 + T3a): build mods/_artprobe/art/probe.scene.json into
// mods/_artprobe/swfs/probe.swf, run mods/_artprobe/tests/render-probe.mewtest in the real game (hide: false, six
// shots), read every shot with probe-compare.ts and write compare.md + summary.json into the run dir.
// --cat: run render-cat.mewtest instead (an ArtProbeCat enemy drawn by the CatProbe cat rig) and count each slot's
// colour in the shots (cat-summary.json; every slot present = the rig draws in the game).
// --cat-append: experiment A0 (2026-10-21) — run render-cat-append.mewtest (a settled baseline shot, TomTom as the
// real-parts control, ArtProbeCat as the primer — the coloured CatProbeColours rig as a plain movieclip — then
// ArtProbeCatReal: TomTom whose idle is our _Append_CatTest frame placing the CatProbe rig, whose slots are EMPTY
// sprites the game fills with the cat's own parts), then the two control scripts (render-cat-append-ctl: a vanilla
// appended label; render-cat-append-missing: a label no clip has), and write cat-append-summary.json: per rig shot the
// marker, the slot colours near it, and what changed near the marker vs the primer shot (probe-compare.ts
// changedPixelsNear, per colour: slot / marker colours vs "other" = real cat parts), the same measure for TomTom vs
// the baseline, the verdicts and crash RVAs. Outcome: filled-by-name (marker in every rig shot, real parts near it
// comparable to TomTom's — at least 30 % of the vanilla "other" count — and no slot colour appeared) / not-filled /
// no-marker / the verdict when the run did not pass (the 2026-10-21 crash at Mewgenics.exe+0x741f5d was the
// visible non-empty slot sprite; engine-map "CatTest and the cat animation clips").
// --loctext (2026-10-22): run render-loctext.mewtest (an ArtProbeLoc enemy: the marker plus ten text boxes, probe-outcomes.ts
// LOC_PROBE_BOXES) and write loctext-summary.json: per shot the marker geometry, each box's ink, and per question
// (vanilla / mod key × HTML / plain) whether the key box reads like its English value (substituted) or like its
// look-alike literal. --tileset: run _tileprobe's render-tileset-redirect.mewtest (`alley { Rat ArtProbe }`) and the
// control _artprobe/render-tileset-control.mewtest (no overlay) and write tileset-summary.json: the marker per shot
// (baseline before `spawn Rat`, two after) and the outcome (probe-outcomes.ts tilesetOutcome). `--loctext --from <runDir>`
// re-reads an earlier run's report.json and shots instead of launching the game.
// --cat-wave (2026-10-22): run render-cat-wave.mewtest (TomTom, then ArtProbeCatWave whose idle is the appended,
// keyed `wave` pose) and write cat-wave-summary.json: our marker, the cat's outline under it vs TomTom's, the slot
// colours beyond TomTom's own, and the outline change between wave shots vs the idle TomTom's (probe-outcomes.ts
// catWaveOutcome; exit 0 on `animated`). --glow-arena (2026-10-22): run render-glow-arena.mewtest (ArtProbeGlow: a
// bakeGlow halo, an unglowed control square, a colour swatch) and write glow-arena-summary.json (measureGlowArena /
// glowArenaOutcome; exit 0 on `halo`). Both take `--from <runDir>` too. --cat-back (2026-10-22): run
// render-cat-back.mewtest (TomTom; ArtProbeCatFacing, the probeBack animation at the default facing — the F frame, no
// marker, then turned away with the harness's `face 9 back`; ArtProbeCatBack, facing away from data with properties.lock_orientation [1 0]; ArtProbeCatBackShown, the back rig on both labels;
// our B frames place the back rig at 1.5x, so each new cat is measured by its height over TomTom's) and
// write cat-back-summary.json (probe-outcomes.ts catBackOutcome; exit 0 on `back-facing` / `back-pose-drawn`; `--from <runDir>` too). --vfx (2026-10-22): run _vfxprobe's
// vfx-probe.mewtest (a NEW particles.gon system with our clip, and SparkleBuff re-pointed to our marker clip) and write
// vfx-summary.json (probe-vfx.ts measureVfx; refuses a verdict when every shot is byte-identical); also takes --from.
// --raster (2026-10-22): write the big generated PNGs (art/generated/), build art/raster.scene.json, patch its
// missing-font text's class (patchMissingFontClass), run render-raster / render-raster-cat / render-font-missing,
// _bgprobe/render-backdrop and the control render-tileset-control, and write raster-summary.json (probe-raster.ts).
// --multi-append (2026-10-22): build the _catappendA / _catappendB / _catappendSame probe SWFs, run A alone, B alone,
// A+B, B+A and A+Same, count each marker colour per shot (probe-multiappend.ts) and write multi-append-summary.json
// (pinned as test/fixtures/ingame/multi-append-summary.json).
// Exit 0 when the run passed and the marker was found in at least one shot, 1 otherwise, 2 when the game cannot run, 3 when the run's shots are stale (all byte-identical: no verdict).
//   node scripts/art-probe.ts [--json]

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as api from "../src/core/api.ts";
import { staleShotsRefusal } from "../src/core/ingame/shot.ts";
import { buildSwf } from "../src/core/art/art-io.ts";
import { decodePng, encodePng } from "../src/core/art/png.ts";
import { measureLocText, summarizeLocText, tilesetOutcome, catWaveOutcome, catBackOutcome, CAT_BACK_BIG, measureGlowArena, glowArenaOutcome, GLOW_ARENA_PROBE } from "../src/core/art/probe-outcomes.ts";
import { measureVfx, VFX_DOT_COLOUR } from "../src/core/art/probe-vfx.ts";
import { writeModBytes } from "../src/core/art/art-io.ts";
import { MODS_DIR, extractedPath } from "../src/core/repo.ts";
import { RASTER_PROBE, rasterProbeImages, patchMissingFontClass, measureRasterShot, measureCatRamp, backdropShare } from "../src/core/art/probe-raster.ts";
import { MULTI_APPEND_MOD, measureMultiAppendShot, multiAppendOutcome } from "../src/core/art/probe-multiappend.ts";
import { analyzeProbeShot, summarizeProbe, renderProbeReport, slotColoursPresent, largestChangedRegion, changedPixelsNear, darkPixelsNear, MARKER_COLOURS } from "../src/core/art/probe-compare.ts";

/** the CatProbe rig's slot colours (mods/_artprobe/art/probe.scene.json) */
export const CAT_PROBE_COLOURS: Record<string, string> = { tail: "#ff8000", leg2: "#8000ff", arm2: "#00a080", body: "#2080ff", leg1: "#ff60a0", arm1: "#a0ff40", head: "#ffd0a0" };

const json = process.argv.includes("--json");
const b = buildSwf("_artprobe", "art/probe.scene.json", {});
if (!b.ok) { console.error(`build failed: ${JSON.stringify(b).slice(0, 400)}`); process.exit(1); }
const cat = process.argv.includes("--cat");
const catAppend = process.argv.includes("--cat-append");
/** the harness's save guard line ("1 real save file(s) unchanged (…)") */
const saveOf = (r: { safety?: { saveSet?: { detail?: string } | null } }) => (r.safety && r.safety.saveSet && r.safety.saveSet.detail) || null;
const geomOf = (a: ReturnType<typeof analyzeProbeShot>) => (a.box ? { found: a.found, box: a.box, scale: a.scale, mirrored: a.mirrored } : null);
if (process.argv.includes("--tileset")) {
  const runs: Record<string, { mod: string; test: string; verdict: string; reason: string; save: string | null; runDir: string | null; baseline: { found: boolean; box: unknown } | null; after: Array<{ label: string; found: boolean; box: unknown; scale: number; mirrored: boolean }> }> = {};
  for (const [key, mod, test] of [["redirect", "_tileprobe", "render-tileset-redirect"], ["control", "_artprobe", "render-tileset-control"]] as const) {
    const r = await api.runIngameTest({ mod, test, hide: false });
    if (!("verdict" in r)) { console.error(r.error); process.exit(2); }
    if (r.verdict === "skipped" || r.verdict === "cannot-run") { console.log(`skipped: ${r.reason}`); process.exit(2); }
    { const stale = staleShotsRefusal(r); if (stale) { console.log(stale); process.exit(3); } }
    const shots = r.artifacts.shots.filter((s) => s.path).map((s) => ({ label: s.label, a: analyzeProbeShot(decodePng(readFileSync(s.path!))) }));
    const base = shots.find((s) => s.label === "baseline");
    runs[key] = { mod, test, verdict: r.verdict, reason: r.reason, save: saveOf(r), runDir: r.artifacts.runDir || null, baseline: base ? { found: base.a.found, box: base.a.box } : null, after: shots.filter((s) => s.label !== "baseline").map((s) => ({ label: s.label, found: s.a.found, box: s.a.box, scale: s.a.scale, mirrored: s.a.mirrored })) };
  }
  const outcome = tilesetOutcome(runs.redirect!, runs.control!);
  const out = { observed: "2026-10-22, build 25143593", overlay: "alley { Rat ArtProbe }", outcome, redirect: runs.redirect, control: runs.control };
  writeFileSync(join(runs.redirect!.runDir || ".", "tileset-summary.json"), JSON.stringify(out, null, 2) + "\n");
  const line = (k: string) => { const r = runs[k]!; return `${k} (${r.mod}/${r.test}): ${r.verdict} — ${r.reason}; ${r.save}\n  baseline marker ${r.baseline ? (r.baseline.found ? "FOUND" : "none") : "no shot"}; after spawn: ${r.after.map((s) => `${s.label} ${s.found ? `FOUND (scale ${s.scale.toFixed(2)}, ${s.mirrored ? "mirrored" : "as authored"})` : "none"}`).join(", ")}\n  artifacts: ${r.runDir}`; };
  console.log([line("redirect"), line("control"), `outcome: ${outcome}`].join("\n"));
  process.exit(outcome === "redirected" ? 0 : 1);
}
if (process.argv.includes("--vfx")) {
  // the VFX probe (2026-10-22): mods/_vfxprobe — a NEW particles.gon system with our clip, and the vanilla SparkleBuff
  // re-pointed to our marker clip, each worn by a Rat through EliteParticle (probe-vfx.ts measureVfx)
  const bv = buildSwf("_vfxprobe", "art/vfx.scene.json", {});
  if (!bv.ok) { console.error(`build failed: ${JSON.stringify(bv).slice(0, 400)}`); process.exit(1); }
  const fromAt = process.argv.indexOf("--from");
  const r = fromAt > 0 ? (JSON.parse(readFileSync(join(process.argv[fromAt + 1]!, "report.json"), "utf8")) as Awaited<ReturnType<typeof api.runIngameTest>>) : await api.runIngameTest({ mod: "_vfxprobe", test: "vfx-probe", hide: false });
  if (!("verdict" in r)) { console.error(r.error); process.exit(2); }
  if (r.verdict === "skipped" || r.verdict === "cannot-run") { console.log(`skipped: ${r.reason}`); process.exit(2); }
  const shots = r.artifacts.shots.filter((s) => s.path).map((s) => ({ label: s.label, img: decodePng(readFileSync(s.path!)) }));
  const m = measureVfx(shots);
  const out = { observed: "2026-10-22, build 25143593", verdict: r.verdict, reason: r.reason, save: saveOf(r), runDir: r.artifacts.runDir || null, dotColour: VFX_DOT_COLOUR, ...m };
  writeFileSync(join(r.artifacts.runDir || ".", "vfx-summary.json"), JSON.stringify(out, null, 2) + "\n");
  console.log([
    ...m.perShot.map((s) => `${s.label}: dot ${s.dot} px, marker ${s.marker} px`),
    `aura motion ${m.auraMotion.toFixed(2)}${m.identical ? " (every shot byte-identical: no verdict)" : ""}`,
    `outcomes: aura ${m.outcomes.aura}, repoint ${m.outcomes.repoint}`,
    `run: ${r.verdict} — ${r.reason}; ${out.save}`,
    `artifacts: ${r.artifacts.runDir}`,
  ].join("\n"));
  process.exit(r.verdict === "pass" && m.outcomes.aura === "drawn" && m.outcomes.repoint === "drawn" ? 0 : 1);
}
if (process.argv.includes("--multi-append")) {
  // two mods appending to CatTest (2026-10-22): build the three probe SWFs, run A alone, B alone, A+B, B+A and
  // A+Same (Same ships B's content under A's file name), count each marker colour per shot and write
  // multi-append-summary.json (pinned as test/fixtures/ingame/multi-append-summary.json)
  for (const [mod, scene] of [[MULTI_APPEND_MOD.A, "catappendA"], [MULTI_APPEND_MOD.B, "catappendB"], ["_catappendSame", "catappendA"]] as const) {
    const r = buildSwf(mod, `art/${scene}.scene.json`, {});
    if (!r.ok) { console.error(`${mod} build failed: ${r.error}`); process.exit(1); }
  }
  const plan = [["aloneA", "_catappendA", "alone-a"], ["aloneB", "_catappendB", "alone-b"], ["ab", "_catappendA", "multi-append-ab"], ["ba", "_catappendA", "multi-append-ba"], ["sameName", "_catappendSame", "same-name"]] as const;
  const runs: Record<string, unknown> = {};
  let first: string | null = null;
  for (const [key, mod, test] of plan) {
    const r = await api.runIngameTest({ mod, test });
    if (!("verdict" in r)) { console.error(r.error); process.exit(2); }
    if (r.verdict === "skipped" || r.verdict === "cannot-run") { console.log(`skipped: ${r.reason}`); process.exit(2); }
    first = first || r.artifacts.runDir || null;
    const shots = r.artifacts.shots.filter((x) => x.path && x.label !== "baseline").map((x) => measureMultiAppendShot(x.label, decodePng(readFileSync(x.path!))));
    const outcome = multiAppendOutcome(shots);
    runs[key] = { mod, test, verdict: r.verdict, reason: r.reason, save: saveOf(r), runDir: r.artifacts.runDir || null, shots, outcome };
    console.log(`${key} (${mod}/${test}): ${r.verdict}; own A ${outcome.own.A}, own B ${outcome.own.B}, probeC -> ${outcome.collision}; ${saveOf(r)}`);
  }
  const out = { observed: "2026-10-22, build 25143593", note: "own A/B = the mod's own appended frame drew its marker; collision = whose probeC frame the shared label showed", runs };
  writeFileSync(join(first || ".", "multi-append-summary.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`summary: ${join(first || ".", "multi-append-summary.json")}`);
  process.exit(0);
}
if (process.argv.includes("--raster")) {
  // 1. the big generated PNGs (git-ignored art/generated/), 2. build raster.scene.json, 3. patch the missing-font text
  const imgs = rasterProbeImages();
  for (const [n, im] of Object.entries(imgs.generated)) {
    const w = writeModBytes("_artprobe", `art/generated/${n}.png`, encodePng(im.width, im.height, im.rgba));
    if (!w.ok) { console.error(w.error); process.exit(1); }
  }
  const rb = buildSwf("_artprobe", "art/raster.scene.json", {});
  if (!rb.ok) { console.error(`raster build failed: ${JSON.stringify(rb.findings).slice(0, 600)}`); process.exit(1); }
  const swfPath = join(MODS_DIR, "_artprobe", "swfs", "raster.swf");
  const pt = patchMissingFontClass(new Uint8Array(readFileSync(swfPath)));
  if (pt.patched !== 1) { console.error(`patchMissingFontClass patched ${pt.patched} strings, expected 1`); process.exit(1); }
  writeFileSync(swfPath, pt.bytes);
  // palette row 54 (the cat's) from the game's palette.png, for the ramp measure
  const pal = decodePng(new Uint8Array(readFileSync(extractedPath("textures", "palette.png"))));
  const row = RASTER_PROBE.cat.palette;
  const palRow = Array.from({ length: 16 }, (_, n) => { const i = (row * pal.width + n) * 4; return [pal.rgba[i]!, pal.rgba[i + 1]!, pal.rgba[i + 2]!] as [number, number, number]; });
  const crashRva = (reason: string) => { const m = /Mewgenics\.exe\+(0x[0-9a-f]+)/i.exec(reason); return m ? m[1]! : null; };
  const run = async (mod: string, test: string) => {
    const r = await api.runIngameTest({ mod, test, hide: false });
    if (!("verdict" in r)) return { mod, test, verdict: "launch-error", reason: r.error, crashRva: null, save: null, runDir: null, shots: [] as Array<{ label: string; img: ReturnType<typeof decodePng> }> };
    return { mod, test, verdict: r.verdict, reason: r.reason, crashRva: crashRva(r.reason), save: saveOf(r), runDir: r.artifacts.runDir || null, shots: r.artifacts.shots.filter((s) => s.path).map((s) => ({ label: s.label, img: decodePng(readFileSync(s.path!)) })) };
  };
  const strip = ({ shots: _shots, ...rest }: Awaited<ReturnType<typeof run>>) => rest;
  const raster = await run("_artprobe", "render-raster");
  if (raster.verdict === "skipped" || raster.verdict === "cannot-run") { console.log(`skipped: ${raster.reason}`); process.exit(2); }
  const rasterShots = raster.shots.map((s) => { const a = analyzeProbeShot(s.img); const g = geomOf(a); return { label: s.label, marker: g, measure: g && g.found ? measureRasterShot(s.img, g) : null }; });
  const catRun = await run("_artprobe", "render-raster-cat");
  const catShots = catRun.shots.map((s) => { const a = analyzeProbeShot(s.img); const g = geomOf(a); return { label: s.label, marker: g, measure: g && g.found ? measureCatRamp(s.img, g, palRow) : null }; });
  const fm = await run("_artprobe", "render-font-missing");
  const fmShots = fm.shots.map((s) => { const a = analyzeProbeShot(s.img); const g = geomOf(a); return { label: s.label, marker: g, measure: g && g.found ? measureRasterShot(s.img, g).font : null }; });
  const bg = await run("_bgprobe", "render-backdrop");
  const ctl = await run("_artprobe", "render-tileset-control");
  const bgShares = bg.shots.map((s) => ({ label: s.label, ...backdropShare(s.img) }));
  const ctlBase = ctl.shots.find((s) => s.label === "baseline");
  const ctlShare = ctlBase ? backdropShare(ctlBase.img) : null;
  const vote = <T extends string>(xs: Array<T | undefined>) => { const c = new Map<T, number>(); for (const x of xs) if (x) c.set(x, (c.get(x) || 0) + 1); return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "no-marker"; };
  const rm = rasterShots.map((s) => s.measure).filter((m): m is NonNullable<typeof m> => !!m);
  const cm = catShots.map((s) => s.measure).filter((m): m is NonNullable<typeof m> => !!m);
  const outcomes = {
    rasterSprite: raster.verdict !== "pass" ? raster.verdict : rm.some((m) => m.quad.ok) ? "drawn" : "not-drawn",
    sampling: vote(rm.map((m) => m.stripes.verdict)),
    repeat: vote(rm.map((m) => m.tile.verdict)),
    minified: vote(rm.map((m) => m.big.verdict)),
    embeddedFont: vote(rm.map((m) => m.font.verdict)),
    missingGlyph: vote(rm.map((m) => (m.fontMissingGlyph.blobs.length === 2 ? "skipped" : m.fontMissingGlyph.blobs.length === 3 ? "fallback-glyph" : m.fontMissingGlyph.verdict === "nothing" ? "nothing" : `blobs-${m.fontMissingGlyph.blobs.length}`))),
    missingFont: fm.verdict !== "pass" ? `${fm.verdict}${fm.crashRva ? ` at ${fm.crashRva}` : ""}` : vote(fmShots.map((s) => s.measure?.verdict)),
    catBitmapGray: catRun.verdict !== "pass" ? catRun.verdict : vote(cm.map((m) => m.bitmap)),
    catVectorGray: catRun.verdict !== "pass" ? catRun.verdict : vote(cm.map((m) => m.vector)),
    backdrop: bg.verdict !== "pass" ? bg.verdict : bgShares.some((s) => s.left > 0.02 && s.right > 0.02) && (!ctlShare || ctlShare.left + ctlShare.right < 0.005) ? "drawn" : "not-drawn",
  };
  const out = { observed: "2026-10-22, build 25143593", outcomes, raster: { ...strip(raster), shots: rasterShots }, cat: { ...strip(catRun), palette: row, palRow, shots: catShots }, fontMissing: { ...strip(fm), shots: fmShots }, backdrop: { ...strip(bg), shares: bgShares }, control: { ...strip(ctl), baselineShare: ctlShare } };
  writeFileSync(join(raster.runDir || ".", "raster-summary.json"), JSON.stringify(out, null, 2) + "\n");
  const line = (r: { mod: string; test: string; verdict: string; reason: string; save: string | null; runDir: string | null }) => `${r.mod}/${r.test}: ${r.verdict} — ${r.reason}; ${r.save}\n  artifacts: ${r.runDir}`;
  console.log([line(raster), line(catRun), line(fm), line(bg), line(ctl), `outcomes: ${JSON.stringify(outcomes, null, 1)}`, `summary: ${join(raster.runDir || ".", "raster-summary.json")}`].join("\n"));
  process.exit(raster.verdict === "pass" && rm.length ? 0 : 1);
}
if (process.argv.includes("--loctext")) {
  const fromAt = process.argv.indexOf("--from");
  const r = fromAt > 0 ? (JSON.parse(readFileSync(join(process.argv[fromAt + 1]!, "report.json"), "utf8")) as Awaited<ReturnType<typeof api.runIngameTest>>) : await api.runIngameTest({ mod: "_artprobe", test: "render-loctext", hide: false });
  if (!("verdict" in r)) { console.error(r.error); process.exit(2); }
  if (r.verdict === "skipped" || r.verdict === "cannot-run") { console.log(`skipped: ${r.reason}`); process.exit(2); }
  { const stale = staleShotsRefusal(r); if (stale) { console.log(stale); process.exit(3); } }
  const shots = r.artifacts.shots.filter((s) => s.path).map((s) => { const img = decodePng(readFileSync(s.path!)); const a = analyzeProbeShot(img); const g = geomOf(a); return { label: s.label, marker: g, measure: g && g.found ? measureLocText(img, g) : null }; });
  // every shot with the marker votes on the questions whose three boxes it shows uncovered (summarizeLocText)
  const first = shots.find((s) => s.measure);
  const sum = summarizeLocText(shots.filter((s) => s.measure).map((s) => s.measure!));
  const out = { observed: "2026-10-22, build 25143593", verdict: r.verdict, reason: r.reason, save: saveOf(r), runDir: r.artifacts.runDir || null, marker: first ? first.marker : null, outcomes: sum.outcomes, votes: sum.votes, plainRenders: sum.plainRenders, shots };
  writeFileSync(join(r.artifacts.runDir || ".", "loctext-summary.json"), JSON.stringify(out, null, 2) + "\n");
  console.log([
    ...shots.map((s) => `${s.label}: marker ${s.marker && s.marker.found ? `found (scale ${s.marker.scale.toFixed(2)}, ${s.marker.mirrored ? "mirrored" : "as authored"})` : "not found"}${s.measure ? `; ${Object.entries(s.measure.outcomes).map(([k, v]) => `${k} ${v} (value ${s.measure!.pairs[k]!.toValue} / literal ${s.measure!.pairs[k]!.toLiteral})`).join(", ")}; ink ${Object.entries(s.measure.boxes).map(([k, b]) => `${k} ${b.ink}/${b.inkWidth.toFixed(0)}w`).join(" ")}` : ""}`),
    `outcomes: ${JSON.stringify(out.outcomes)} (votes ${JSON.stringify(out.votes)}; plain text drawn: ${out.plainRenders})`,
    `run: ${r.verdict} — ${r.reason}; ${out.save}`,
    `artifacts: ${r.artifacts.runDir}`,
  ].join("\n"));
  process.exit(r.verdict === "pass" && first ? 0 : 1);
}
/** a finished run: launched now, or re-read from `--from <runDir>` (report.json + its shots) */
async function runOrReread(test: string) {
  const fromAt = process.argv.indexOf("--from");
  const r = fromAt > 0 ? (JSON.parse(readFileSync(join(process.argv[fromAt + 1]!, "report.json"), "utf8")) as Awaited<ReturnType<typeof api.runIngameTest>>) : await api.runIngameTest({ mod: "_artprobe", test, hide: false });
  if (!("verdict" in r)) { console.error(r.error); process.exit(2); }
  if (r.verdict === "skipped" || r.verdict === "cannot-run") { console.log(`skipped: ${r.reason}`); process.exit(2); }
  return r;
}
if (process.argv.includes("--cat-wave")) {
  // the wave probe (2026-10-22): render-cat-wave.mewtest — baseline, vanilla (TomTom), then ArtProbeCatWave five times
  const r = await runOrReread("render-cat-wave");
  const byLabel = new Map(r.artifacts.shots.filter((s) => s.path).map((s) => [s.label, decodePng(readFileSync(s.path!))]));
  const baseline = byLabel.get("baseline"), vanilla = byLabel.get("vanilla");
  const waveLabels = [...byLabel.keys()].filter((l) => /^wave \d$/.test(l));
  const arena = vanilla ? { x0: Math.round(vanilla.width * 0.15), y0: Math.round(vanilla.height * 0.1), x1: Math.round(vanilla.width * 0.85), y1: Math.round(vanilla.height * 0.7) } : undefined;
  /** a window around a changed region: its centre and a radius covering it with margin (the arm sweeps past the body) */
  const windowOf = (g: { x0: number; y0: number; x1: number; y1: number; cx: number; cy: number }) => ({ x: g.cx, y: g.cy, r: Math.round(Math.max(g.x1 - g.x0, g.y1 - g.y0) * 0.65) + 20 });
  // TomTom (the control): the largest new dark blob vs the baseline inside the arena (as --cat-append)
  const vRegion = baseline && vanilla ? largestChangedRegion(vanilla, baseline, { dark: 40, within: arena }) : null;
  const vWin = vRegion ? windowOf(vRegion) : null;
  const vanillaOutline = vWin && baseline && vanilla ? darkPixelsNear(vanilla, baseline, vWin, vWin.r) : 0;
  // our cat: the largest new dark blob vs the vanilla shot below our marker (the marker sits above the cat's head)
  const first = waveLabels.map((l) => ({ l, img: byLabel.get(l)!, a: analyzeProbeShot(byLabel.get(l)!) })).find((s) => s.a.found);
  let rigWin: { x: number; y: number; r: number } | null = null, rigRegion = null;
  if (first && vanilla && first.a.box) {
    const b = first.a.box, w = b.x1 - b.x0, h = b.y1 - b.y0;
    const search = { x0: Math.max(0, b.x0 - w), y0: b.y0, x1: Math.min(vanilla.width - 1, b.x1 + w), y1: Math.min(vanilla.height - 1, b.y1 + 6 * h) };
    rigRegion = largestChangedRegion(first.img, vanilla, { dark: 40, within: search });
    if (rigRegion) rigWin = windowOf(rigRegion);
  }
  // the slot colours are matched tint-tolerantly, so a real cat hits them too (OBSERVED 2026-10-22: TomTom's light fur
  // reads as the head slot's peach, ~2.7k px): a slot colour counts only beyond twice what TomTom's own window holds
  const vanillaSlots: Record<string, number> = vWin && vanilla ? slotColoursPresent(vanilla, CAT_PROBE_COLOURS, { centre: vWin, radius: vWin.r }) : {};
  const wave = waveLabels.map((label) => {
    const img = byLabel.get(label)!;
    const a = analyzeProbeShot(img);
    const slots = rigWin ? slotColoursPresent(img, CAT_PROBE_COLOURS, { centre: rigWin, radius: rigWin.r }) : slotColoursPresent(img, CAT_PROBE_COLOURS);
    const slotsExcess = Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, Math.max(0, v - 2 * (vanillaSlots[k] || 0))]));
    return { label, marker: geomOf(a), outline: rigWin && vanilla ? darkPixelsNear(img, vanilla, rigWin, rigWin.r) : 0, slots, slotsExcess };
  });
  // motion: new dark pixels both ways between every pair of wave shots, in our window and in TomTom's
  const pairs: Array<{ a: string; b: string; rig: number; control: number }> = [];
  for (let i = 0; i < waveLabels.length; i++) for (let j = i + 1; j < waveLabels.length; j++) {
    const A = byLabel.get(waveLabels[i]!)!, B = byLabel.get(waveLabels[j]!)!;
    const both = (w: { x: number; y: number; r: number } | null) => (w ? darkPixelsNear(B, A, w, w.r) + darkPixelsNear(A, B, w, w.r) : 0);
    pairs.push({ a: waveLabels[i]!, b: waveLabels[j]!, rig: both(rigWin), control: both(vWin) });
  }
  const motion = { pairs, max: Math.max(0, ...pairs.map((p) => p.rig)), controlMax: Math.max(0, ...pairs.map((p) => p.control)) };
  const marked = wave.filter((w) => w.marker && w.marker.found);
  const outcome = catWaveOutcome({ verdict: r.verdict, markers: marked.length, partsDrawn: marked.filter((w) => vanillaOutline > 0 && w.outline >= 0.3 * vanillaOutline).length, slotMax: Math.max(0, ...wave.flatMap((w) => Object.values(w.slotsExcess))), motion: motion.max, controlMotion: motion.controlMax });
  const out = { observed: "2026-10-22, build 25143593", verdict: r.verdict, reason: r.reason, save: saveOf(r), runDir: r.artifacts.runDir || null, outcome, shots: [...byLabel.keys()], vanilla: { region: vRegion, window: vWin, outline: vanillaOutline, slots: vanillaSlots }, rig: { region: rigRegion, window: rigWin }, wave, motion };
  writeFileSync(join(r.artifacts.runDir || ".", "cat-wave-summary.json"), JSON.stringify(out, null, 2) + "\n");
  console.log([
    `vanilla TomTom: ${vRegion ? `dark region ${vRegion.n} px at ${vRegion.cx},${vRegion.cy}, window r ${vWin!.r}` : "not found"}; outline ${vanillaOutline}`,
    `rig window: ${rigWin ? `${rigWin.x},${rigWin.y} r ${rigWin.r}` : "not found"}`,
    ...wave.map((w) => `${w.label}: marker ${w.marker && w.marker.found ? `found (scale ${w.marker.scale.toFixed(2)}, ${w.marker.mirrored ? "mirrored" : "as authored"})` : "not found"}; outline ${w.outline}; slot px max ${Math.max(0, ...Object.values(w.slots))} (beyond 2x TomTom: ${Math.max(0, ...Object.values(w.slotsExcess))})`),
    `motion (outline px changed between wave shots): rig max ${motion.max}, control TomTom max ${motion.controlMax} — ${pairs.map((p) => `${p.a.slice(5)}/${p.b.slice(5)} ${p.rig}:${p.control}`).join(", ")}`,
    `outcome: ${outcome}`,
    `run: ${r.verdict} — ${r.reason}; ${out.save}`,
    `artifacts: ${r.artifacts.runDir}`,
  ].join("\n"));
  process.exit(outcome === "animated" ? 0 : 1);
}
if (process.argv.includes("--cat-back")) {
  // the back-facing probe (2026-10-22): render-cat-back.mewtest — baseline, vanilla (TomTom), front (the control
  // ArtProbeCatFacing: probeBack at the default facing), back 1..3 (ArtProbeCatFacing after `face 9 back`), locked 1..2
  // (ArtProbeCatBack, properties.lock_orientation [1 0]), shown 1..2 (ArtProbeCatBackShown: the back rig on both labels). Our B frames place the
  // back rig at 1.5x, so each new cat is measured by its height over TomTom's. The back rig's marker sat 1.5x as far
  // above the feet as the front rigs' and was cut by the window's top edge (OBSERVED 2026-10-22, run 124301
  // shot-shown-2); it now sits at clip y -220 (the same donor height, -377.95, as the front rigs' -330 at 1x), and a
  // marker cut by the frame is reported as clipped instead of missing.
  const r = await runOrReread("render-cat-back");
  const byLabel = new Map(r.artifacts.shots.filter((s) => s.path).map((s) => [s.label, decodePng(readFileSync(s.path!))]));
  const baseline = byLabel.get("baseline"), vanilla = byLabel.get("vanilla"), front = byLabel.get("front");
  const backLabels = [...byLabel.keys()].filter((l) => /^back \d$/.test(l));
  const shownLabels = [...byLabel.keys()].filter((l) => /^shown \d$/.test(l));
  const arena = vanilla ? { x0: Math.round(vanilla.width * 0.15), y0: Math.round(vanilla.height * 0.1), x1: Math.round(vanilla.width * 0.85), y1: Math.round(vanilla.height * 0.7) } : undefined;
  // TomTom (the size control): the largest new dark blob vs the baseline inside the arena (as --cat-wave)
  const vRegion = baseline && vanilla ? largestChangedRegion(vanilla, baseline, { dark: 40, within: arena }) : null;
  const vH = vRegion ? vRegion.y1 - vRegion.y0 + 1 : 0;
  /** a new cat in `img`: the largest new dark blob vs `ref` (the shot before it spawned) and its height over TomTom's */
  const measure = (label: string, img: typeof vanilla, ref: typeof vanilla) => {
    const region = img && ref ? largestChangedRegion(img, ref, { dark: 40, within: arena }) : null;
    return { label, region, ratio: region && vH ? Math.round(((region.y1 - region.y0 + 1) / vH) * 1000) / 1000 : null };
  };
  const frontM = measure("front", front, vanilla);
  // back 1..3: the same ArtProbeCatFacing after `face 9 back` (Character::Face), so it is new against the vanilla shot
  const back = backLabels.map((l) => measure(l, byLabel.get(l), vanilla));
  const lastBack = byLabel.get(backLabels[backLabels.length - 1] || "") || front || vanilla;
  // locked 1..2: ArtProbeCatBack (properties.lock_orientation [1 0]) spawns facing away, and `face 10 front` cannot turn
  // it (the lock replaces the direction): our 1.5x back rig both times, new against the last back shot
  const lockedLabels = [...byLabel.keys()].filter((l) => /^locked \d$/.test(l));
  const locked = lockedLabels.map((l) => measure(l, byLabel.get(l), lastBack));
  const lastLocked = byLabel.get(lockedLabels[lockedLabels.length - 1] || "") || lastBack;
  const shown = shownLabels.map((l) => measure(l, byLabel.get(l), lastLocked));
  // the turn pair (needs no vanilla shot): `face 9 front` between "shown 2" and "turned back" swaps unit 9's 1.5x back
  // rig for its 1x front rig in place — the height of what vanished over the height of what appeared
  const s2 = byLabel.get("shown 2"), tb = byLabel.get("turned back");
  const goneB = s2 && tb ? largestChangedRegion(s2, tb, { dark: 40, within: arena }) : null;
  const cameF = s2 && tb ? largestChangedRegion(tb, s2, { dark: 40, within: arena }) : null;
  const turnRatio = goneB && cameF ? Math.round(((goneB.y1 - goneB.y0 + 1) / (cameF.y1 - cameF.y0 + 1)) * 1000) / 1000 : null;
  const capture = r.artifacts.shots.map((s) => `${s.label}: ${(s as { note?: string }).note ?? "?"}`);
  const markerOf = new Map([...byLabel.entries()].filter(([l]) => l !== "baseline").map(([l, img]) => [l, analyzeProbeShot(img)] as const));
  const markers = [...markerOf.keys()].filter((l) => markerOf.get(l)!.found);
  const markerAt = [...markerOf.entries()].map(([l, a]) => ({ label: l, found: a.found, scale: a.found ? Math.round(a.scale * 1000) / 1000 : null, clipped: a.clipped, box: a.box }));
  // what the harness saw: the face events and the facing of the turned units (units events)
  const evs = (r.result.events || []) as Array<Record<string, unknown>>;
  const faces = evs.filter((e) => e.ev === "face").map((e) => ({ line: e.line, unit: e.unit, arg: e.arg, dir: e.dir, effective: e.effective, expect: e.expect, facing: e.facing, flip: e.flip, ok: e.ok }));
  const facingOf = (i: number) => evs.filter((e) => e.ev === "units").map((e) => ((e.list as Array<Record<string, unknown>>) || []).find((u) => u.i === i)).filter(Boolean).map((u) => ({ facing: u!.facing, dir: u!.dir, lock: u!.lock, sign: u!.sign, flip: u!.flip }));
  const expects = evs.filter((e) => e.ev === "expect").map((e) => `${e.ok ? "ok" : "FAIL"} line ${e.line}: ${e.kind} ${e.arg} (${e.detail})`);
  const outcome = catBackOutcome({ verdict: r.verdict, front: frontM.ratio, back: back.map((s) => s.ratio), shown: shown.map((s) => s.ratio), turn: turnRatio });
  const out = { observed: "2026-10-22, build 25143593", verdict: r.verdict, reason: r.reason, save: saveOf(r), runDir: r.artifacts.runDir || null, outcome, big: CAT_BACK_BIG, turn: "face 9 back (Character::Face 0x10ce50, instant) on ArtProbeCatFacing; ArtProbeCatBack faces away from data (properties.lock_orientation [1 0]) and face 10 front leaves it on B (the lock replaces the direction); #105's runs had the keys under graphics, which Character::init never reads", faces, facing: { 9: facingOf(9), 10: facingOf(10) }, expects, markerShots: markers, markers: markerAt, shots: [...byLabel.keys()], vanilla: { region: vRegion, height: vH }, front: frontM, back, locked, shown, turnPair: { backGone: goneB, frontCame: cameF, ratio: turnRatio }, capture };
  writeFileSync(join(r.artifacts.runDir || ".", "cat-back-summary.json"), JSON.stringify(out, null, 2) + "\n");
  const line = (s: { label: string; region: { cx: number; cy: number; n: number } | null; ratio: number | null }) => `${s.label}: ${s.region ? `new cat at ${s.region.cx},${s.region.cy} (${s.region.n} px), height ${s.ratio}x TomTom's${s.ratio !== null && s.ratio >= CAT_BACK_BIG ? " — OUR 1.5x back rig" : ""}` : "no new cat found"}`;
  console.log([
    `vanilla TomTom: ${vRegion ? `dark region ${vRegion.n} px at ${vRegion.cx},${vRegion.cy}, height ${vH}` : "not found"}`,
    line(frontM), ...back.map(line), ...locked.map(line), ...shown.map(line),
    ...faces.map((f) => `face line ${f.line}: unit ${f.unit} "${f.arg}" dir ${JSON.stringify(f.dir)} effective ${JSON.stringify(f.effective)} -> facing ${f.facing} (rule: ${f.expect}), flip ${f.flip}, ok ${f.ok}`),
    ...expects,
    `turn pair (face 9 front between shown 2 and turned back): ${turnRatio === null ? "not measurable" : `the vanished B pose is ${turnRatio}x the height of the F pose that replaced it${turnRatio >= CAT_BACK_BIG ? " — OUR 1.5x back rig was drawn on the back-facing unit" : ""}`}`,
    `checker marker in: ${markers.join(", ") || "no shot"}`,
    ...markerAt.filter((m) => m.found || m.clipped).map((m) => `  ${m.label}: ${m.found ? `found, scale ${m.scale} px per clip px` : `cut by the ${m.clipped} edge (drawn, out of frame)`} at ${m.box ? `${m.box.x0},${m.box.y0}-${m.box.x1},${m.box.y1}` : "?"}`),
    `outcome: ${outcome}`,
    `run: ${r.verdict} — ${r.reason}; ${out.save}`,
    `artifacts: ${r.artifacts.runDir}`,
  ].join("\n"));
  process.exit(outcome === "back-facing" || outcome === "back-pose-drawn" ? 0 : 1);
}
if (process.argv.includes("--glow-arena")) {
  // the baked-glow probe (2026-10-22): render-glow-arena.mewtest — baseline (no unit), then ArtProbeGlow three times
  const r = await runOrReread("render-glow-arena");
  const byLabel = new Map(r.artifacts.shots.filter((s) => s.path).map((s) => [s.label, decodePng(readFileSync(s.path!))]));
  const baseline = byLabel.get("baseline");
  const shots = [...byLabel.keys()].filter((l) => /^glow \d$/.test(l)).map((label) => {
    const img = byLabel.get(label)!;
    const g = geomOf(analyzeProbeShot(img));
    const measure = g && g.found && baseline ? measureGlowArena(img, baseline, g) : null;
    return { label, marker: g, measure, outcome: measure ? glowArenaOutcome(measure) : "no-marker" };
  });
  const firstM = shots.find((s) => s.measure);
  const outcome = r.verdict !== "pass" ? r.verdict : firstM ? firstM.outcome : "no-marker";
  const out = { observed: "2026-10-22, build 25143593", verdict: r.verdict, reason: r.reason, save: saveOf(r), runDir: r.artifacts.runDir || null, probe: GLOW_ARENA_PROBE, outcome, marker: firstM ? firstM.marker : null, measure: firstM ? firstM.measure : null, shots };
  writeFileSync(join(r.artifacts.runDir || ".", "glow-arena-summary.json"), JSON.stringify(out, null, 2) + "\n");
  const f2 = (n: number) => n.toFixed(2);
  console.log([
    ...shots.map((s) => `${s.label}: marker ${s.marker && s.marker.found ? `found (scale ${s.marker.scale.toFixed(2)}, ${s.marker.mirrored ? "mirrored" : "as authored"})` : "not found"}${s.measure ? `; ${s.outcome}: halo alpha ${f2(s.measure.glowAlpha)} (control ${f2(s.measure.controlAlpha)}, beyond ${f2(s.measure.beyondAlpha)}), inner ${s.measure.inner.join(",")} vs swatch ${s.measure.swatch.join(",")} (${s.measure.colourMatch ? "match" : "MISMATCH"}), monotonic rays ${s.measure.monotonicRays}/4, band steps ${s.measure.bandJumps}\n    ${s.measure.rays.map((ray) => `${ray.dir}: ${ray.alpha.map(f2).join(" ")}`).join("\n    ")}` : ""}`),
    `outcome: ${outcome}`,
    `run: ${r.verdict} — ${r.reason}; ${out.save}`,
    `artifacts: ${r.artifacts.runDir}`,
  ].join("\n"));
  process.exit(outcome === "halo" ? 0 : 1);
}
const report = await api.runIngameTest({ mod: "_artprobe", test: catAppend ?"render-cat-append" : cat ? "render-cat" : "render-probe", hide: false });
if (!("verdict" in report)) { console.error(report.error); process.exit(2); }
if (report.verdict === "skipped" || report.verdict === "cannot-run") { console.log(`skipped: ${report.reason}`); process.exit(2); }
{ const stale = staleShotsRefusal(report); if (stale) { console.log(stale); process.exit(3); } }
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
  // TomTom vs the baseline: the largest blob of NEW near-black pixels is his outline (the plain diff's largest blob is
  // the arena whenever the move-range overlay toggles between shots, OBSERVED twice); `outline` = new dark px around it
  // searched inside the arena only: the HUD (OBSERVED: the End Turn button, the turn-order portraits) animates too
  const arena = vanilla ? { x0: Math.round(vanilla.width * 0.15), y0: Math.round(vanilla.height * 0.1), x1: Math.round(vanilla.width * 0.85), y1: Math.round(vanilla.height * 0.7) } : undefined;
  const vRegion = baseline && vanilla ? largestChangedRegion(vanilla, baseline, { dark: 40, within: arena }) : null;
  const vanillaOut = { label: "vanilla", region: vRegion, near: vRegion && baseline && vanilla ? changedPixelsNear(vanilla, baseline, { x: vRegion.cx, y: vRegion.cy }, RADIUS, { exclude, perColour: true }) : null, outline: vRegion && baseline && vanilla ? darkPixelsNear(vanilla, baseline, { x: vRegion.cx, y: vRegion.cy }, RADIUS) : null };
  // the primer shot (ArtProbeCat: the coloured rig drawn as a plain movieclip, not appended) is the rig shots' reference
  const ref = primer || vanilla;
  const primerOut = primer && vanilla ? (() => { const a = analyzeProbeShot(primer); const c = a.box ? { x: (a.box.x0 + a.box.x1) / 2, y: (a.box.y0 + a.box.y1) / 2 } : null; return { label: "primer", marker: a.box ? { found: a.found, box: a.box, scale: a.scale, mirrored: a.mirrored } : null, slots: c ? slotColoursPresent(primer, CAT_PROBE_COLOURS, { centre: c, radius: RADIUS }) : null }; })() : null;
  const sameBox = (a: { x0: number; y0: number; x1: number; y1: number } | null | undefined, b: { x0: number; y0: number; x1: number; y1: number } | null | undefined) => !!a && !!b && a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;
  const rig = ref ? rigLabels.map((label) => {
    const img = byLabel.get(label)!;
    const a = analyzeProbeShot(img);
    const marker = a.box ? { found: a.found, box: a.box, scale: a.scale, mirrored: a.mirrored } : null;
    // the primer's coloured rig keeps its own marker on screen: a rig shot's marker is OURS only when its box is not
    // the primer's (OBSERVED: once the rig cat died, the primer's marker was the largest yellow blob left)
    const ours = !!marker && marker.found && !sameBox(marker.box, primerOut && primerOut.marker ? primerOut.marker.box : null);
    const region = largestChangedRegion(img, ref, { dark: 40, within: arena });
    // our marker sits at clip (-48, -330) above the frame origin (the cat's feet), i.e. its centre is 266 clip px
    // above the cat's body centre (vanilla idleF: body at -32): the window is centred on the cat, not the marker
    const centre = ours ? { x: (a.box!.x0 + a.box!.x1) / 2, y: (a.box!.y0 + a.box!.y1) / 2 + 266 * a.scale } : a.box ? { x: (a.box.x0 + a.box.x1) / 2, y: (a.box.y0 + a.box.y1) / 2 } : region ? { x: region.cx, y: region.cy } : null;
    const slots = centre ? slotColoursPresent(img, CAT_PROBE_COLOURS, { centre, radius: RADIUS }) : slotColoursPresent(img, CAT_PROBE_COLOURS);
    const near = centre ? changedPixelsNear(img, ref, centre, RADIUS, { exclude, perColour: true }) : null;
    const outline = centre ? darkPixelsNear(img, ref, centre, RADIUS) : 0;
    return { label, marker, ours, centredOn: ours ? "the cat under our marker" : a.box ? "the primer's marker" : region ? "largest new dark region" : "nothing", centre, outline, slots, near, region };
  }) : [];
  const maxSlot = Math.max(0, ...rig.flatMap((r) => Object.values(r.slots)));
  const markers = rig.filter((r) => r.ours).length;
  // real parts: new near-black pixels (a cat's outline) near our marker vs the primer shot, held against TomTom's own
  // outline vs the baseline; the colour / plain-diff measures stay in the record but decide nothing (overlay noise)
  const vanillaOutline = vanillaOut.outline || 0;
  const partsDrawn = rig.filter((r) => r.ours && vanillaOutline > 0 && r.outline >= 0.3 * vanillaOutline).length;
  const outcome = report.verdict !== "pass" ? report.verdict : markers < 2 ? "no-marker" : partsDrawn === markers ? "filled-by-name" : "not-filled";
  const out = { observed: "2026-10-22, build 25143593", verdict: report.verdict, reason: report.reason, crashRva: crashRva(report.reason), controls, radius: RADIUS, slotColours: CAT_PROBE_COLOURS, outcome, shots: [...byLabel.keys()], vanilla: vanillaOut, primer: primerOut, rig };
  writeFileSync(join(dirA, "cat-append-summary.json"), JSON.stringify(out, null, 2) + "\n");
  const fmt = (n: { changed: number; excluded: number; other: number } | null) => (n ? `changed ${n.changed} (slot/marker ${n.excluded}, other ${n.other})` : "-");
  console.log([
    `vanilla TomTom: new dark region ${vRegion ? `${vRegion.n} px at ${vRegion.cx},${vRegion.cy}` : "none"}; outline ${vanillaOut.outline ?? "-"}; near: ${fmt(vanillaOut.near)}`,
    `primer (CatProbeColours as a plain movieclip): ${primerOut ? `marker ${primerOut.marker && primerOut.marker.found ? "found" : "not found"}; slots ${primerOut.slots ? Object.entries(primerOut.slots).map(([k, v]) => `${k} ${v}`).join(", ") : "-"}` : "no shot"}`,
    ...rig.map((r) => `${r.label}: marker ${r.marker && r.marker.found ? `found (scale ${r.marker.scale.toFixed(2)}, ${r.marker.mirrored ? "mirrored" : "as authored"}, ${r.ours ? "ours" : "the primer's"})` : "not found"}; outline ${r.outline}; slots ${Object.entries(r.slots).map(([k, v]) => `${k} ${v}`).join(", ")}; near (${r.centredOn}): ${fmt(r.near)}`),
    `outcome: ${outcome} (our marker in ${markers}/${rig.length} rig shots; real parts under it in ${partsDrawn}/${markers} — outline px ${rig.map((r) => r.outline).join("/")} vs vanilla ${vanillaOutline}; slot px in the window max ${maxSlot})`,
    `run: ${report.verdict} — ${report.reason}`,
    ...Object.entries(controls).map(([k, c]) => `control ${k} (${c.test}): ${c.verdict} — ${c.reason}`),
    `artifacts: ${dirA}`,
  ].join("\n"));
  process.exit(outcome === "filled-by-name" ? 0 : 1);
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
