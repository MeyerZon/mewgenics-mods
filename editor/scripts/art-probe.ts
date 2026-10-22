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
// --raster (2026-10-22): write the big generated PNGs (art/generated/), build art/raster.scene.json, patch its
// missing-font text's class (patchMissingFontClass), run render-raster / render-raster-cat / render-font-missing,
// _bgprobe/render-backdrop and the control render-tileset-control, and write raster-summary.json (probe-raster.ts).
// Exit 0 when the run passed and the marker was found in at least one shot, 1 otherwise, 2 when the game cannot run.
//   node scripts/art-probe.ts [--json]

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as api from "../src/core/api.ts";
import { buildSwf } from "../src/core/art/art-io.ts";
import { decodePng, encodePng } from "../src/core/art/png.ts";
import { writeModBytes } from "../src/core/art/art-io.ts";
import { MODS_DIR, extractedPath } from "../src/core/repo.ts";
import { RASTER_PROBE, rasterProbeImages, patchMissingFontClass, measureRasterShot, measureCatRamp, backdropShare } from "../src/core/art/probe-raster.ts";
import { measureLocText, summarizeLocText, tilesetOutcome } from "../src/core/art/probe-outcomes.ts";
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
