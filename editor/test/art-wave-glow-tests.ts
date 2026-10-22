// Two in-game probes (2026-10-22) for the T3 cards that had no probe behind them:
//  A. `wave` — a cat animation authored the editor's way (cat-rig.ts newCatAnimation: a parts: "game" rig wavePose
//     with EMPTY slot sprites, labels waveF / waveB on the scene's _Append_CatTest donor) whose arm1 / arm2 / head are
//     keyed over the rig's own timeline, played on a real cat by alt_animations [[idle wave]] (ArtProbeCatWave =
//     TomTom). Question: does an ANIMATED pose get the cat's own parts, and does it move?
//  B. a baked glow (glow.ts bakeGlow, MCP bake_glow) on a square of the ArtProbeGlow clip, a Rat's
//     graphics.movieclip, beside an identical unglowed control square and a swatch of the baked colour. Question:
//     does the game draw the halo — the baked colour next to the silhouette, falling off outward?
// The measures live in src/core/art/probe-outcomes.ts (pure, tested here on synthetic images); the runs are
// `npm run test:artprobe -- --cat-wave` / `-- --glow-arena`, whose summaries are pinned as fixtures.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODS_DIR } from "../src/core/repo.ts";
import { validateScene } from "../src/core/art/scene.ts";
import { bakeGlow } from "../src/core/art/glow.ts";
import { CAT_SLOTS, isEmptySprite, catAnimFindings } from "../src/core/art/cat-rig.ts";
import { parseScript } from "../src/core/ingame/script.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

type Img = { width: number; height: number; rgba: Uint8Array };
type Rgb = [number, number, number];
function solid(w: number, h: number, c: Rgb): Img { const rgba = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) rgba.set([c[0], c[1], c[2], 255], i * 4); return { width: w, height: h, rgba }; }
const copy = (im: Img): Img => ({ width: im.width, height: im.height, rgba: new Uint8Array(im.rgba) });

export async function runArtWaveGlowTests(test: TestFn, assert: AssertFn, eq: EqFn): Promise<void> {
  console.log("\n# Art probes 2026-10-22 (2): an animated cat pose (wave) and a baked glow in the arena");
  let P: Record<string, any> = {};
  let err = "";
  try { P = await import("../src/core/art/probe-outcomes.ts"); } catch (e) { err = e instanceof Error ? e.message : String(e); }
  const need = (...names: string[]) => { if (err) throw new Error(`probe-outcomes.ts: ${err}`); for (const n of names) if (P[n] === undefined) throw new Error(`probe-outcomes.ts exports no ${n}`); };
  const scene = JSON.parse(readFileSync(join(MODS_DIR, "_artprobe", "art", "probe.scene.json"), "utf8"));
  const gon = readFileSync(join(MODS_DIR, "_artprobe", "data", "characters", "enemies.gon.append"), "utf8");
  const script = (name: string) => parseScript(readFileSync(join(MODS_DIR, "_artprobe", "tests", `${name}.mewtest`), "utf8"), { owningMod: "_artprobe", name });

  // ---- A. the wave cat animation ----
  test("probe.scene.json: wavePose is a parts: \"game\" cat rig (newCatAnimation) — seven slot layers at the vanilla depths, each placing an EMPTY sprite, plus the checker marker on a non-slot depth; arm1, arm2 and head carry at least three keys with real motion (rot / y change, linear tweens)", () => {
    const sp = scene.sprites.wavePose;
    assert(!!sp, "sprite wavePose");
    eq(sp.rig, "cat"); eq(sp.parts, "game");
    for (const s of CAT_SLOTS) {
      const l = sp.layers.find((x: any) => x.name === s.name);
      assert(!!l, `slot ${s.name}`);
      eq(l.depth, s.depth, s.name);
      for (const k of l.keys) assert(k.ref === null || isEmptySprite(scene, k.ref), `${s.name}: ${k.ref} is an empty sprite`);
    }
    const marker = sp.layers.find((x: any) => x.keys.some((k: any) => k.ref === "CatProbeMc_marker"));
    assert(!!marker && !CAT_SLOTS.some((s) => s.depth === marker.depth), "marker on a non-slot depth");
    for (const name of ["arm1", "arm2", "head"]) {
      const keys = sp.layers.find((x: any) => x.name === name).keys;
      assert(keys.length >= 3, `${name}: ${keys.length} keys`);
      const poses = new Set(keys.map((k: any) => `${k.rot ?? 0}/${k.y ?? 0}`));
      assert(poses.size >= 2, `${name} moves: ${[...poses].join(" ")}`);
      assert(keys.slice(0, -1).every((k: any) => k.tween === "linear"), `${name}: linear tweens`);
    }
    assert(sp.frames >= 20, `frames ${sp.frames}`);
  });

  test("probe.scene.json: the _Append_CatTest donor carries waveF / waveB (after probeIdleF / probeIdleB), each placing wavePose on the layer `ani` at depth 1 at vanilla idleF's offset; the scene validates with no cat-anim error", () => {
    const donorId = scene.exports._Append_CatTest;
    const d = scene.sprites[donorId];
    assert(!!d, `donor ${donorId}`);
    for (const l of ["probeIdleF", "probeIdleB", "waveF", "waveB"]) assert(Number.isInteger(d.labels[l]), `label ${l}`);
    const ani = d.layers.find((l: any) => l.name === "ani");
    eq(ani.depth, 1);
    for (const l of ["waveF", "waveB"]) {
      const k = ani.keys.find((k: any) => k.frame === d.labels[l]);
      assert(!!k && k.ref === "wavePose" && k.x === 3.85 && k.y === -47.95, `${l}: ${JSON.stringify(k)}`);
    }
    const v = validateScene(scene) as any;
    assert(v.ok, JSON.stringify(v.findings.filter((f: any) => f.severity === "error")));
    const ca = catAnimFindings(scene).filter((f) => f.severity !== "info");
    eq(ca.length, 0, JSON.stringify(ca));
  });

  test("_artprobe: ArtProbeCatWave is TomTom (movieclip _CAT + custom_cat_data TomTom) with alt_animations [[idle wave]]; render-cat-wave.mewtest seeds 42, enters TacticsTest, shoots a baseline, spawns TomTom (the control) then ArtProbeCatWave, and shoots the wave at least four times, without _autoplay (nobody hits or moves the cat: the motion is the animation's)", () => {
    assert(/ArtProbeCatWave\s*\{[\s\S]*?variant_of TomTom[\s\S]*?movieclip _CAT[\s\S]*?custom_cat_data TomTom[\s\S]*?alt_animations \[\[idle wave\]\]/.test(gon), "ArtProbeCatWave in enemies.gon.append");
    const plan = script("render-cat-wave");
    assert(plan.ok, JSON.stringify(plan.errors));
    assert(!plan.mods.includes("_autoplay"), `mods: ${plan.mods.join(",")}`);
    const b = plan.body;
    assert(/seed 42/.test(b) && /enter TacticsTest/.test(b) && /shot "baseline"/.test(b), b);
    assert(b.indexOf("cmd spawn TomTom") > b.indexOf('shot "baseline"') && b.indexOf("cmd spawn ArtProbeCatWave") > b.indexOf('shot "vanilla"'), b);
    assert(/expect console "Spawned ArtProbeCatWave"/.test(b), b);
    eq((b.match(/shot "wave \d"/g) || []).length >= 4, true, b);
  });

  test("catWaveOutcome: animated when our marker is in >= 2 wave shots, every one with real parts under it (outline >= 30 % of TomTom's), no slot colour, and the largest shot-to-shot outline change in the rig's window is >= 200 px and >= 2x the control TomTom's; static / not-filled / no-marker / placeholder-drawn otherwise; a failed run gives its verdict", () => {
    need("catWaveOutcome");
    const ok = { verdict: "pass", markers: 4, partsDrawn: 4, slotMax: 0, motion: 900, controlMotion: 120 };
    eq(P.catWaveOutcome(ok), "animated");
    eq(P.catWaveOutcome({ ...ok, motion: 150 }), "static");
    eq(P.catWaveOutcome({ ...ok, motion: 900, controlMotion: 600 }), "static");
    eq(P.catWaveOutcome({ ...ok, partsDrawn: 3 }), "not-filled");
    eq(P.catWaveOutcome({ ...ok, markers: 1, partsDrawn: 1 }), "no-marker");
    eq(P.catWaveOutcome({ ...ok, slotMax: 400 }), "placeholder-drawn");
    eq(P.catWaveOutcome({ ...ok, verdict: "crash" }), "crash");
  });

  test("OBSERVED 2026-10-22 fixture (artprobe-cat-wave-summary.json): the wave run passed with the real save unchanged; our marker in >= 2 wave shots with real cat parts under it, no slot colour, and the rig's outline changes between shots well beyond the control TomTom's (an animated pose gets the cat's parts and moves)", () => {
    const p = join(HERE, "fixtures", "ingame", "artprobe-cat-wave-summary.json");
    assert(existsSync(p), "written by npm run test:artprobe -- --cat-wave");
    const j = JSON.parse(readFileSync(p, "utf8")) as any;
    eq(j.verdict, "pass");
    assert(/real save file\(s\) unchanged/.test(j.save), String(j.save));
    eq(j.outcome, "animated");
    const ours = j.wave.filter((w: any) => w.marker && w.marker.found);
    assert(ours.length >= 2, `marker in ${ours.length} wave shots`);
    assert(j.vanilla.outline > 1500, `vanilla outline ${j.vanilla.outline}`);
    for (const w of ours) {
      assert(w.outline >= 0.3 * j.vanilla.outline, `${w.label}: outline ${w.outline} vs vanilla ${j.vanilla.outline}`);
      assert(Math.max(0, ...Object.values(w.slots as Record<string, number>)) <= 50, `${w.label}: slot colours ${JSON.stringify(w.slots)}`);
    }
    assert(j.motion.max >= 200 && j.motion.max >= 2 * j.motion.controlMax, JSON.stringify(j.motion));
  });

  // ---- B. the baked glow in the arena ----
  const L = () => P.GLOW_ARENA_PROBE as { glowed: { x: number; y: number }; control: { x: number; y: number }; half: number; swatch: { x: number; y: number; half: number }; blur: number; steps: number; colour: string };

  test("probe.scene.json: ArtProbeGlow (exported) places the marker at the origin, the cxform orientation square at (310, 30), the glowed square glowsrc and the identical control glowctl at GLOW_ARENA_PROBE's centres and the swatch of the baked colour; glowsrc_glow is exactly what bakeGlow bakes (kind glow, the probe's colour / blur / steps) on the layer right under glowsrc; glowctl has no halo; the scene validates", () => {
    need("GLOW_ARENA_PROBE");
    const g = L();
    eq(scene.exports.ArtProbeGlow, "ArtProbeGlow");
    const sp = scene.sprites.ArtProbeGlow;
    const keyOf = (ref: string) => { for (const l of sp.layers) for (const k of l.keys) if (k.ref === ref) return { l, k }; return null; };
    const m = keyOf("checker"), cx = keyOf("sq"), src = keyOf("glowsrc"), ctl = keyOf("glowctl"), halo = keyOf("glowsrc_glow"), sw = keyOf("glowswatch");
    assert(!!m && m.k.x === 0 && m.k.y === 0, "marker at the origin");
    assert(!!cx && cx.k.x === 310 && cx.k.y === 30 && cx.k.cxform && cx.k.cxform.mul.join(",") === "1,0,0,1", "cxform square");
    assert(!!src && src.k.x === g.glowed.x && src.k.y === g.glowed.y, "glowsrc at the glowed centre");
    assert(!!ctl && ctl.k.x === g.control.x && ctl.k.y === g.control.y, "glowctl at the control centre");
    assert(!!sw && sw.k.x === g.swatch.x && sw.k.y === g.swatch.y, "swatch");
    assert(!!halo && halo.k.x === g.glowed.x && halo.k.y === g.glowed.y && halo.l.depth < src.l.depth, "halo under glowsrc");
    eq(JSON.stringify(scene.shapes.glowsrc.paths.map((p: any) => p.d)), JSON.stringify(scene.shapes.glowctl.paths.map((p: any) => p.d)), "identical squares");
    eq(scene.shapes.glowswatch.paths[0].fill, g.colour);
    assert(!sp.layers.some((l: any) => l.keys.some((k: any) => k.ref === "glowctl_glow")) && !scene.shapes.glowctl_glow, "no halo on the control");
    // the committed halo is bakeGlow's own output: re-bake from the scene without it
    const bare = JSON.parse(JSON.stringify(scene));
    delete bare.shapes.glowsrc_glow;
    for (const s of Object.values(bare.sprites) as any[]) s.layers = s.layers.filter((l: any) => !l.keys.some((k: any) => k.ref === "glowsrc_glow"));
    const r = bakeGlow(bare, "glowsrc", { color: g.colour, blur: g.blur, steps: g.steps });
    assert(r.ok, JSON.stringify(r.findings));
    eq(JSON.stringify(r.scene.shapes.glowsrc_glow), JSON.stringify(scene.shapes.glowsrc_glow), "baked halo");
    const v = validateScene(scene) as any;
    assert(v.ok, JSON.stringify(v.findings.filter((f: any) => f.severity === "error")));
  });

  test("_artprobe: ArtProbeGlow is a Rat drawn by the ArtProbeGlow clip; render-glow-arena.mewtest seeds 42, enters TacticsTest, shoots a baseline before `spawn ArtProbeGlow` (the arena behind the halo) and the glow at least three times, without _autoplay", () => {
    assert(/ArtProbeGlow\s*\{[\s\S]*?variant_of Rat[\s\S]*?movieclip ArtProbeGlow/.test(gon), "ArtProbeGlow in enemies.gon.append");
    const plan = script("render-glow-arena");
    assert(plan.ok, JSON.stringify(plan.errors));
    assert(!plan.mods.includes("_autoplay"), `mods: ${plan.mods.join(",")}`);
    const b = plan.body;
    assert(/seed 42/.test(b) && /enter TacticsTest/.test(b) && /expect console "Spawned ArtProbeGlow"/.test(b), b);
    assert(b.indexOf('shot "baseline"') >= 0 && b.indexOf('shot "baseline"') < b.indexOf("cmd spawn ArtProbeGlow"), "baseline before the spawn");
    eq((b.match(/shot "glow \d"/g) || []).length >= 3, true, b);
  });

  /** draw the ArtProbeGlow layout into a synthetic arena: dark squares, the halo bands at `alphas` (outermost last), the swatch */
  const BG: Rgb = [92, 90, 88];
  const geomOf = (mirrored: boolean) => ({ box: { x0: 1000, y0: 200, x1: 1000 + 96 * 2 - 1, y1: 200 + 64 * 2 - 1 }, scale: 2, mirrored });
  function synthGlow(alphas: number[] | null, opts: { mirrored?: boolean; tint?: number; colour?: Rgb } = {}) {
    need("GLOW_ARENA_PROBE");
    const g = L(), geom = geomOf(!!opts.mirrored), t = opts.tint ?? 1;
    const base = solid(2400, 1200, BG), img = copy(base);
    const C: Rgb = (opts.colour || [255, 128, 0]).map((v) => Math.round(v * t)) as Rgb;
    const toScreen = (cx: number, cy: number) => ({ x: geom.mirrored ? geom.box.x1 + 1 - cx * geom.scale : geom.box.x0 + cx * geom.scale, y: geom.box.y0 + cy * geom.scale });
    const W = img.width, H = img.height;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const cx = geom.mirrored ? (geom.box.x1 + 1 - x) / geom.scale : (x - geom.box.x0) / geom.scale, cy = (y - geom.box.y0) / geom.scale;
      const i = (y * W + x) * 4;
      const set = (c: Rgb) => { img.rgba[i] = c[0]; img.rgba[i + 1] = c[1]; img.rgba[i + 2] = c[2]; };
      const cheb = (c: { x: number; y: number }) => Math.max(Math.abs(cx - c.x), Math.abs(cy - c.y));
      if (cheb(g.swatch) <= g.swatch.half) { set(C); continue; }
      for (const c of [g.glowed, g.control]) {
        const d = cheb(c) - g.half;
        if (d <= 0) { set([Math.round(40 * t), Math.round(40 * t), Math.round(44 * t)]); break; }
        if (c === g.glowed && alphas && d <= g.blur) {
          const a = alphas[Math.min(alphas.length - 1, Math.floor((d / g.blur) * alphas.length))]!;
          set([0, 1, 2].map((k) => Math.round(a * C[k]! + (1 - a) * BG[k]!)) as Rgb);
          break;
        }
      }
    }
    void toScreen;
    return { img, base, geom };
  }

  test("measureGlowArena + glowArenaOutcome: a 4-band halo of the swatch's colour around the glowed square and nothing around the control is `halo` (inner band ≈ the swatch, alpha falls off monotonically on all four rays, the bands show as steps); same when mirrored and under the unit tint", () => {
    need("measureGlowArena", "glowArenaOutcome");
    for (const o of [{}, { mirrored: true }, { tint: 0.7 }]) {
      const { img, base, geom } = synthGlow([1, 0.75, 0.5, 0.25], o);
      const m = P.measureGlowArena(img, base, geom);
      assert(m.colourMatch, `${JSON.stringify(o)}: inner ${m.inner} vs swatch ${m.swatch}`);
      assert(m.glowAlpha > 0.45 && m.glowAlpha < 0.8, `${JSON.stringify(o)}: glowAlpha ${m.glowAlpha}`);
      assert(Math.abs(m.controlAlpha) < 0.05, `controlAlpha ${m.controlAlpha}`);
      assert(m.beyondAlpha < 0.05, `beyondAlpha ${m.beyondAlpha}`);
      eq(m.rays.length, 4); eq(m.monotonicRays, 4, JSON.stringify(m.rays.map((r: any) => r.alpha.map((a: number) => a.toFixed(2)).join(" "))));
      assert(m.bandJumps >= 3, `bandJumps ${m.bandJumps}`);
      eq(P.glowArenaOutcome(m), "halo", JSON.stringify(o));
    }
    // a smooth ramp has no jumps
    const smooth = synthGlow(Array.from({ length: 24 }, (_, i) => 1 - i / 24));
    const ms = P.measureGlowArena(smooth.img, smooth.base, smooth.geom);
    eq(P.glowArenaOutcome(ms), "halo"); eq(ms.bandJumps, 0);
  });

  test("glowArenaOutcome: no halo → none; bands out of order → non-monotonic; a halo of another colour than the swatch → wrong-colour; a lit control → control-lit", () => {
    need("measureGlowArena", "glowArenaOutcome");
    const none = synthGlow(null);
    eq(P.glowArenaOutcome(P.measureGlowArena(none.img, none.base, none.geom)), "none");
    const bad = synthGlow([1, 0.2, 0.9, 0.2]);
    eq(P.glowArenaOutcome(P.measureGlowArena(bad.img, bad.base, bad.geom)), "non-monotonic");
    // the halo drawn in green while the swatch stays orange
    const g = synthGlow([1, 0.75, 0.5, 0.25]);
    const green = synthGlow([1, 0.75, 0.5, 0.25], { colour: [0, 200, 60] });
    const L0 = L();
    // paint the orange swatch back into the green image
    const sw = P.measureGlowArena(g.img, g.base, g.geom).swatch as Rgb;
    for (let y = 0; y < green.img.height; y++) for (let x = 0; x < green.img.width; x++) {
      const cx = (x - green.geom.box.x0) / 2, cy = (y - green.geom.box.y0) / 2;
      if (Math.max(Math.abs(cx - L0.swatch.x), Math.abs(cy - L0.swatch.y)) <= L0.swatch.half) green.img.rgba.set(sw, (y * green.img.width + x) * 4);
    }
    eq(P.glowArenaOutcome(P.measureGlowArena(green.img, green.base, green.geom)), "wrong-colour");
    const lit = P.measureGlowArena(g.img, g.base, g.geom);
    eq(P.glowArenaOutcome({ ...lit, controlAlpha: 0.4 }), "control-lit");
  });

  test("OBSERVED 2026-10-22 fixture (artprobe-glow-arena-summary.json): the glow run passed with the real save unchanged; the marker was found and the halo measured `halo` — inner band ≈ the baked colour (swatch), alpha falling off outward on >= 3 of 4 rays, the control square unlit", () => {
    const p = join(HERE, "fixtures", "ingame", "artprobe-glow-arena-summary.json");
    assert(existsSync(p), "written by npm run test:artprobe -- --glow-arena");
    const j = JSON.parse(readFileSync(p, "utf8")) as any;
    eq(j.verdict, "pass");
    assert(/real save file\(s\) unchanged/.test(j.save), String(j.save));
    assert(j.marker && j.marker.found, "marker found");
    eq(j.outcome, "halo");
    const m = j.measure;
    assert(m.colourMatch, `inner ${m.inner} vs swatch ${m.swatch}`);
    assert(m.glowAlpha >= 0.3 && m.controlAlpha <= 0.15 && m.monotonicRays >= 3, JSON.stringify({ g: m.glowAlpha, c: m.controlAlpha, mono: m.monotonicRays }));
  });
}
