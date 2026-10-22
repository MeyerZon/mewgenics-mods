// The measures behind two in-game probes (2026-10-22; docs/engine-map.md "Localization and text fields" and "SWF
// loader and display path"), read from the 3440×1440 harness shots. Pure.
//
// A. Loc-key text: the ArtProbeLoc clip (mods/_artprobe/art/probe.scene.json) is the probe marker plus ten text boxes
//    in one colour (mint #00ffa0): four KEY boxes (a vanilla key and a key _artprobe's combined.csv.append adds, each
//    in vanilla's HTML wrapper and plain), next to each a same-mode LOOK-ALIKE literal (the key with its last letter
//    changed: not a key, so it is always drawn as written), and the two English VALUES as literals. Per box the ink
//    (mint-ish pixels) is sampled on a grid in clip space, so boxes of the same size compare cell by cell; a key box
//    that looks more like its value than like its look-alike was localized. Crude on purpose: it needs no OCR and no
//    font metrics, only that two different strings in the same font differ more than a string and itself shifted by
//    a few px. Limits: it decides between "the value" and "the key as written" only (a third rendering — HTML tags
//    shown literally, a wrapped line — reads as whichever it is closer to; the ink widths are kept for that), and it
//    needs the marker to place the boxes.
// B. The tilesets.gon redirect: whether our probe marker shows on screen after `spawn Rat` (analyzeProbeShot), with
//    a pre-spawn baseline and a control run without the overlay.

import type { RgbaImageLike } from "./probe-compare.ts";

export interface LocBox { id: string; text: string; html: boolean; x: number; y: number; width: number; height: number }

/** box size and font size shared by every probe text (clip px) */
export const LOC_BOX = { width: 360, height: 40, size: 22, color: "#00ffa0" } as const;

const row = (y: number, left: [string, string, boolean], right: [string, string, boolean]): LocBox[] => [
  { id: left[0], text: left[1], html: left[2], x: 200, y, width: LOC_BOX.width, height: LOC_BOX.height },
  { id: right[0], text: right[1], html: right[2], x: 600, y, width: LOC_BOX.width, height: LOC_BOX.height },
];

/** The ArtProbeLoc layout, clip px relative to the marker's top-left (boxes above it: the clip stands on the floor). */
export const LOC_PROBE_BOXES: readonly LocBox[] = [
  ...row(-60, ["keyVanillaHtml", "ENEMY_TOMTOM_NAME", true], ["litVanillaHtml", "ENEMY_TOMTOM_NAMQ", true]),
  ...row(-120, ["keyVanillaPlain", "ENEMY_TOMTOM_NAME", false], ["litVanillaPlain", "ENEMY_TOMTOM_NAMQ", false]),
  ...row(-180, ["keyModHtml", "ARTPROBE_LOCTEST", true], ["litModHtml", "ARTPROBE_LOCTESQ", true]),
  ...row(-240, ["keyModPlain", "ARTPROBE_LOCTEST", false], ["litModPlain", "ARTPROBE_LOCTESQ", false]),
  ...row(-300, ["valueVanilla", "Tom Tom", true], ["valueMod", "LOCALIZED OK", true]),
];

/** the four questions: key box → (its value box, its look-alike box) */
export const LOC_PAIRS: Record<string, { key: string; value: string; lit: string }> = {
  vanillaHtml: { key: "keyVanillaHtml", value: "valueVanilla", lit: "litVanillaHtml" },
  vanillaPlain: { key: "keyVanillaPlain", value: "valueVanilla", lit: "litVanillaPlain" },
  modHtml: { key: "keyModHtml", value: "valueMod", lit: "litModHtml" },
  modPlain: { key: "keyModPlain", value: "valueMod", lit: "litModPlain" },
};

export interface ShotGeometry { box: { x0: number; y0: number; x1: number; y1: number }; scale: number; mirrored: boolean }
export interface InkMask { w: number; h: number; mask: Uint8Array }
export interface BoxInk { ink: number; inkWidth: number; inkHeight: number }
export type LocOutcome = "substituted" | "literal" | "unreadable";

/** fewer ink cells than this and a box counts as empty */
export const MIN_INK = 40;

/** mint #00ffa0 under the game's uniform unit tint (0.55..1.15) and anti-aliasing: green clearly dominant, blue at ~0.35..0.9 of it */
function isInk(r: number, g: number, b: number): boolean {
  return g > 90 && g > r + 50 && b > 0.3 * g && b < 0.9 * g + 20;
}

/** Sample a box's ink on a clip-space grid (one cell per screen px) through the marker geometry. */
export function boxInk(img: RgbaImageLike, g: ShotGeometry, b: LocBox): InkMask & BoxInk {
  const w = Math.max(1, Math.round(b.width * g.scale)), h = Math.max(1, Math.round(b.height * g.scale));
  const mask = new Uint8Array(w * h);
  let ink = 0, minI = Infinity, maxI = -1, minJ = Infinity, maxJ = -1;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const cx = b.x - b.width / 2 + i / g.scale, cy = b.y - b.height / 2 + j / g.scale;
    const x = Math.round(g.mirrored ? g.box.x1 + 1 - cx * g.scale : g.box.x0 + cx * g.scale), y = Math.round(g.box.y0 + cy * g.scale);
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
    const k = (y * img.width + x) * 4;
    if (isInk(img.rgba[k]!, img.rgba[k + 1]!, img.rgba[k + 2]!)) {
      mask[j * w + i] = 1; ink++;
      if (i < minI) minI = i; if (i > maxI) maxI = i; if (j < minJ) minJ = j; if (j > maxJ) maxJ = j;
    }
  }
  return { w, h, mask, ink, inkWidth: ink ? (maxI - minI + 1) / g.scale : 0, inkHeight: ink ? (maxJ - minJ + 1) / g.scale : 0 };
}

/**
 * |A xor B| / |A or B| of two same-sized ink masks, minimised over shifts of B by up to `maxShift` cells (the boxes
 * land on different sub-pixel offsets); 0 = the same drawing, 1 = nothing in common, 0 for two empty masks.
 */
export function inkDifference(a: InkMask, b: InkMask, maxShift = 0): number {
  let best = 1;
  const w = Math.min(a.w, b.w), h = Math.min(a.h, b.h);
  for (let dy = -maxShift; dy <= maxShift; dy++) for (let dx = -maxShift; dx <= maxShift; dx++) {
    let x = 0, u = 0;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const p = a.mask[j * a.w + i]!;
      const bi = i + dx, bj = j + dy;
      const q = bi >= 0 && bj >= 0 && bi < b.w && bj < b.h ? b.mask[bj * b.w + bi]! : 0;
      if (p || q) { u++; if (p !== q) x++; }
    }
    const d = u ? x / u : 0;
    if (d < best) best = d;
    if (best === 0) return 0;
  }
  return best;
}

export interface LocTextMeasure {
  boxes: Record<string, BoxInk>;
  /** per question: difference of the key box to its value and to its look-alike */
  pairs: Record<string, { toValue: number; toLiteral: number }>;
  outcomes: Record<string, LocOutcome>;
  /** the plain look-alike has ink: a DefineEditText without the HTML flag is drawn at all */
  plainRenders: boolean;
}

export function measureLocText(img: RgbaImageLike, g: ShotGeometry, maxShift = 3): LocTextMeasure {
  const masks: Record<string, InkMask & BoxInk> = {};
  for (const b of LOC_PROBE_BOXES) masks[b.id] = boxInk(img, g, b);
  const boxes: Record<string, BoxInk> = {};
  for (const [id, m] of Object.entries(masks)) boxes[id] = { ink: m.ink, inkWidth: m.inkWidth, inkHeight: m.inkHeight };
  const pairs: LocTextMeasure["pairs"] = {}, outcomes: LocTextMeasure["outcomes"] = {};
  for (const [q, p] of Object.entries(LOC_PAIRS)) {
    const k = masks[p.key]!, v = masks[p.value]!, l = masks[p.lit]!;
    const toValue = inkDifference(k, v, maxShift), toLiteral = inkDifference(k, l, maxShift);
    pairs[q] = { toValue: Math.round(toValue * 1000) / 1000, toLiteral: Math.round(toLiteral * 1000) / 1000 };
    outcomes[q] = k.ink < MIN_INK || (v.ink < MIN_INK && l.ink < MIN_INK) ? "unreadable" : toValue < toLiteral ? "substituted" : "literal";
  }
  return { boxes, pairs, outcomes, plainRenders: masks.litVanillaPlain!.ink >= MIN_INK };
}

export interface TilesetRun { verdict: string; baseline: { found: boolean } | null; after: Array<{ found: boolean }> }
export type TilesetOutcome = "redirected" | "not-redirected" | "inconclusive" | string;

/**
 * The redirect probe's verdict: our marker after `spawn Rat` with the overlay, none before the spawn and none in the
 * control run (no overlay) → "redirected"; no marker with the overlay → "not-redirected"; a marker where none should
 * be → "inconclusive"; a run that did not pass → its verdict (the control's prefixed `control-`).
 */
export function tilesetOutcome(redirect: TilesetRun, control: TilesetRun): TilesetOutcome {
  if (redirect.verdict !== "pass") return redirect.verdict;
  if (control.verdict !== "pass") return `control-${control.verdict}`;
  if ((redirect.baseline && redirect.baseline.found) || (control.baseline && control.baseline.found) || control.after.some((s) => s.found)) return "inconclusive";
  return redirect.after.some((s) => s.found) ? "redirected" : "not-redirected";
}

export interface LocTextSummary {
  /** per question: the readable shots' unanimous outcome, "mixed" when they disagree, "unreadable" when none is readable */
  outcomes: Record<string, LocOutcome | "mixed">;
  /** per question: how many shots voted */
  votes: Record<string, number>;
  /** some shot drew the plain look-alike */
  plainRenders: boolean;
}

/** a box with less than this share of its best ink across the shots is covered (OBSERVED: the "Battle Start!" banner, the unit) */
export const OCCLUDED_BELOW = 0.6;

/** Combine per-shot measures: a shot votes on a question only when its key, look-alike and value boxes are all uncovered. */
export function summarizeLocText(shots: LocTextMeasure[]): LocTextSummary {
  const best: Record<string, number> = {};
  for (const s of shots) for (const [id, b] of Object.entries(s.boxes)) best[id] = Math.max(best[id] || 0, b.ink);
  const ok = (s: LocTextMeasure, id: string) => { const b = s.boxes[id]; return !!b && b.ink >= MIN_INK && b.ink >= OCCLUDED_BELOW * (best[id] || 0); };
  const outcomes: LocTextSummary["outcomes"] = {}, votes: LocTextSummary["votes"] = {};
  for (const [q, p] of Object.entries(LOC_PAIRS)) {
    const v = shots.filter((s) => ok(s, p.key) && ok(s, p.lit) && ok(s, p.value)).map((s) => s.outcomes[q]!).filter((o) => o !== "unreadable");
    votes[q] = v.length;
    outcomes[q] = !v.length ? "unreadable" : v.every((o) => o === v[0]) ? v[0]! : "mixed";
  }
  return { outcomes, votes, plainRenders: shots.some((s) => s.plainRenders) };
}

// ---- C. the wave probe (2026-10-22): an animated cat pose authored with newCatAnimation ------------------------------
//
// ArtProbeCatWave = TomTom + alt_animations [[idle wave]]; the wave frames place wavePose, a parts: "game" rig whose
// slots are empty and whose arm1 / arm2 / head are keyed over its own timeline (mods/_artprobe/tests/render-cat-wave.mewtest).
// The measures (scripts/art-probe.ts --cat-wave, probe-compare.ts darkPixelsNear): our marker per wave shot; the cat's
// outline under it vs the vanilla shot (real parts, held against TomTom's own outline); the slot placeholder colours
// (must be absent: the slots are empty); and the motion — the near-black pixels that differ between two wave shots in
// the rig's window (both directions), the largest pair, held against the same number in the still TomTom's window
// (whose idle breathes and whose tint the move-range overlay may change: the noise floor).

export interface CatWaveFacts {
  verdict: string;
  /** wave shots that show our marker */
  markers: number;
  /** of those, the ones with real parts under the marker (outline >= 30 % of TomTom's) */
  partsDrawn: number;
  /** the largest count of a slot placeholder colour near the marker in any wave shot */
  slotMax: number;
  /** the largest outline change between two wave shots in the rig's window */
  motion: number;
  /** the same in the control TomTom's window */
  controlMotion: number;
}
export type CatWaveOutcome = "animated" | "static" | "not-filled" | "no-marker" | "placeholder-drawn" | string;
/** the motion must change at least this many outline px … */
export const WAVE_MIN_MOTION = 200;
/** … and this many times the control's */
export const WAVE_MOTION_RATIO = 2;

export function catWaveOutcome(f: CatWaveFacts): CatWaveOutcome {
  if (f.verdict !== "pass") return f.verdict;
  if (f.markers < 2) return "no-marker";
  if (f.partsDrawn < f.markers) return "not-filled";
  if (f.slotMax > 50) return "placeholder-drawn";
  return f.motion >= WAVE_MIN_MOTION && f.motion >= WAVE_MOTION_RATIO * f.controlMotion ? "animated" : "static";
}

// ---- D. the baked glow in the arena (2026-10-22) --------------------------------------------------------------------
//
// The ArtProbeGlow clip (probe.scene.json): the checker marker at the origin, the cxform square at (310, 30) (the
// orientation cue analyzeProbeShot reads), a 60 px square `glowsrc` with the halo glow.ts bakeGlow bakes under it,
// the identical unglowed square `glowctl` and a swatch of the baked colour — the colour as the game draws it on this
// unit (the unit tint included), so the comparison needs no model of the tint. Per pixel the halo's alpha is read
// against the baseline shot (the arena with no unit): a = (p - bg)·(S - bg) / |S - bg|², S the swatch colour. Sampled
// along four rays out of each square's edges (each sample the mean over a 24 clip px stretch along the edge).

export const GLOW_ARENA_PROBE = {
  glowed: { x: 150, y: 220 },
  control: { x: 330, y: 220 },
  /** the squares' half size, clip px */
  half: 30,
  swatch: { x: 480, y: 220, half: 15 },
  blur: 24,
  steps: 4,
  colour: "#ff8000",
} as const;

type Rgb3 = [number, number, number];
export interface GlowRay { dir: "right" | "left" | "down" | "up"; alpha: number[] }
export interface GlowArenaMeasure {
  /** the swatch as drawn */
  swatch: Rgb3;
  /** the innermost band's mean colour */
  inner: Rgb3;
  colourMatch: boolean;
  /** mean halo alpha inside the blur around the glowed square / the control square */
  glowAlpha: number;
  controlAlpha: number;
  /** mean alpha just past the blur (should be ~0) */
  beyondAlpha: number;
  /** mean |shot - baseline| inside the blur around the glowed square (RGB distance) */
  glowChange: number;
  /** alpha profiles out of the glowed square, one per clip px from GLOW_EDGE_SKIP to blur + 8 */
  rays: GlowRay[];
  /** rays whose alpha never rises by more than GLOW_MONO_TOL from one px to the next */
  monotonicRays: number;
  /** the most drops larger than GLOW_MONO_TOL in one ray (visible band steps; 0 for a smooth falloff) */
  bandJumps: number;
}
/** clip px next to the square edge skipped (anti-aliasing mixes the dark square in) */
export const GLOW_EDGE_SKIP = 3;
export const GLOW_MONO_TOL = 0.12;
/** per-channel tolerance between the inner band and the swatch */
export const GLOW_COLOUR_TOL = 45;

export function measureGlowArena(img: RgbaImageLike, base: RgbaImageLike, g: ShotGeometry, L: typeof GLOW_ARENA_PROBE = GLOW_ARENA_PROBE): GlowArenaMeasure {
  const toX = (cx: number) => (g.mirrored ? g.box.x1 + 1 - cx * g.scale : g.box.x0 + cx * g.scale);
  const toY = (cy: number) => g.box.y0 + cy * g.scale;
  const at = (im: RgbaImageLike, cx: number, cy: number): Rgb3 | null => {
    const x = Math.round(toX(cx)), y = Math.round(toY(cy));
    if (x < 0 || y < 0 || x >= im.width || y >= im.height || im.width !== img.width) return null;
    const i = (y * im.width + x) * 4;
    return [im.rgba[i]!, im.rgba[i + 1]!, im.rgba[i + 2]!];
  };
  // the swatch: the mean over its inner half
  let sn = 0;
  const ss = [0, 0, 0];
  for (let dy = -L.swatch.half / 2; dy <= L.swatch.half / 2; dy += 1) for (let dx = -L.swatch.half / 2; dx <= L.swatch.half / 2; dx += 1) {
    const p = at(img, L.swatch.x + dx, L.swatch.y + dy);
    if (p) { ss[0] += p[0]; ss[1] += p[1]; ss[2] += p[2]; sn++; }
  }
  const swatch: Rgb3 = sn ? [Math.round(ss[0]! / sn), Math.round(ss[1]! / sn), Math.round(ss[2]! / sn)] : [0, 0, 0];
  const dirs: Array<[GlowRay["dir"], number, number]> = [["right", 1, 0], ["left", -1, 0], ["down", 0, 1], ["up", 0, -1]];
  /** mean alpha, colour and change at distance d outside the square centred on c, along (ux, uy) */
  const sample = (c: { x: number; y: number }, ux: number, uy: number, d: number) => {
    let n = 0, a = 0, ch = 0;
    const col = [0, 0, 0];
    for (let t = -12; t <= 12; t += 2) {
      const cx = c.x + ux * (L.half + d) + (uy !== 0 ? t : 0), cy = c.y + uy * (L.half + d) + (ux !== 0 ? t : 0);
      const p = at(img, cx, cy), b = at(base, cx, cy);
      if (!p || !b) continue;
      const s = [swatch[0] - b[0], swatch[1] - b[1], swatch[2] - b[2]], q = [p[0] - b[0], p[1] - b[1], p[2] - b[2]];
      const den = s[0]! ** 2 + s[1]! ** 2 + s[2]! ** 2;
      a += den > 0 ? (q[0]! * s[0]! + q[1]! * s[1]! + q[2]! * s[2]!) / den : 0;
      ch += Math.hypot(q[0]!, q[1]!, q[2]!);
      col[0] += p[0]; col[1] += p[1]; col[2] += p[2];
      n++;
    }
    return n ? { a: a / n, ch: ch / n, col: [col[0]! / n, col[1]! / n, col[2]! / n] as Rgb3 } : { a: 0, ch: 0, col: [0, 0, 0] as Rgb3 };
  };
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const band = L.blur / L.steps;
  const rays: GlowRay[] = [];
  const glowA: number[] = [], ctlA: number[] = [], beyond: number[] = [], change: number[] = [];
  const innerCols: Rgb3[] = [];
  for (const [dir, ux, uy] of dirs) {
    const alpha: number[] = [];
    for (let d = GLOW_EDGE_SKIP; d <= L.blur + 8; d++) {
      const s = sample(L.glowed, ux, uy, d + 0.5);
      alpha.push(s.a);
      if (d <= L.blur - 2) { glowA.push(s.a); change.push(s.ch); ctlA.push(sample(L.control, ux, uy, d + 0.5).a); }
      if (d >= L.blur + 4) beyond.push(s.a);
      if (d + 0.5 <= band - 1) innerCols.push(s.col);
    }
    rays.push({ dir, alpha });
  }
  const inner: Rgb3 = innerCols.length ? ([0, 1, 2].map((k) => Math.round(mean(innerCols.map((c) => c[k]!)))) as Rgb3) : [0, 0, 0];
  const colourMatch = innerCols.length > 0 && [0, 1, 2].every((k) => Math.abs(inner[k]! - swatch[k]!) <= GLOW_COLOUR_TOL);
  const monotonicRays = rays.filter((r) => r.alpha.every((a, i) => i === 0 || a <= r.alpha[i - 1]! + GLOW_MONO_TOL)).length;
  const bandJumps = Math.max(0, ...rays.map((r) => r.alpha.filter((a, i) => i > 0 && r.alpha[i - 1]! - a > GLOW_MONO_TOL).length));
  return { swatch, inner, colourMatch, glowAlpha: mean(glowA), controlAlpha: mean(ctlA), beyondAlpha: mean(beyond), glowChange: mean(change), rays, monotonicRays, bandJumps };
}

export type GlowArenaOutcome = "halo" | "none" | "wrong-colour" | "non-monotonic" | "control-lit";

/** halo: the inner band is the swatch's colour, alpha falls off outward on >= 3 of 4 rays, the control is unlit */
export function glowArenaOutcome(m: GlowArenaMeasure): GlowArenaOutcome {
  if (m.controlAlpha > 0.15) return "control-lit";
  if (m.glowChange < 15) return "none";
  if (!m.colourMatch) return "wrong-colour";
  if (m.glowAlpha < 0.15) return "none";
  if (m.monotonicRays < 3) return "non-monotonic";
  return "halo";
}
