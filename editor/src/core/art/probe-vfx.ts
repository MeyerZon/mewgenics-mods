// Reads the in-game shots of the VFX probe (mods/_vfxprobe/tests/vfx-probe.mewtest; npm run test:artprobe -- --vfx).
// Two questions, both answered by colour inside the arena (the HUD is ignored):
//  aura    — a NEW particles.gon system (VfxProbeAura) whose clip is this mod's #ff0090 VfxProbeDot, worn by a Rat
//            through EliteParticle: pink pixels in the "aura N" shots and none in the baseline; "drawn" also needs the
//            pink set to MOVE between shots (an emitter, not a static sprite);
//  repoint — the vanilla SparkleBuff system re-pointed by particles.gon.merge to VfxProbeMarker (the _artprobe marker:
//            yellow border, magenta / cyan cells): marker pixels in the "repoint N" shots and none in the baseline.
// The stale-shot caveat (2026-10-22): a capture can hand back the same frame again; when every shot is byte-identical
// no verdict is given ("stale-shots"). Pure: works on any RGBA image (decodePng of the shot).

import { matchTinted, MARKER_COLOURS } from "./probe-compare.ts";
import type { RgbaImageLike, Rgb } from "./probe-compare.ts";

/** VfxProbeDot's fill (mods/_vfxprobe/art/vfx.scene.json) */
export const VFX_DOT_COLOUR = "#ff0090";

const rgb = (hex: string): Rgb => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const DOT = rgb(VFX_DOT_COLOUR);
const MARKER = Object.values(MARKER_COLOURS).map(rgb);

/** the arena: the middle of the screen without the HUD bars (turn order on top, buttons at the bottom) */
export function arenaWindow(img: { width: number; height: number }): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: Math.round(img.width * 0.12), y0: Math.round(img.height * 0.1), x1: Math.round(img.width * 0.88), y1: Math.round(img.height * 0.8) };
}

/** indices of the arena pixels matching any of `colours` (tint-tolerant, like the other probes) */
export function colourMask(img: RgbaImageLike, colours: Rgb[]): Set<number> {
  const w = arenaWindow(img);
  const out = new Set<number>();
  for (let y = w.y0; y < w.y1; y++) for (let x = w.x0; x < w.x1; x++) {
    const i = y * img.width + x;
    if (colours.some((c) => matchTinted(img, i, c))) out.add(i);
  }
  return out;
}

/** every image has the same size and bytes */
export function allIdentical(imgs: RgbaImageLike[]): boolean {
  if (imgs.length < 2) return false;
  const a = imgs[0]!;
  return imgs.every((b) => b.width === a.width && b.height === a.height && b.rgba.length === a.rgba.length && Buffer.compare(Buffer.from(a.rgba.buffer, a.rgba.byteOffset, a.rgba.byteLength), Buffer.from(b.rgba.buffer, b.rgba.byteOffset, b.rgba.byteLength)) === 0);
}

/** 1 − |A∩B| / |A∪B| (0 = the same pixels, 1 = disjoint) */
function jaccardDistance(a: Set<number>, b: Set<number>): number {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const i of a) if (b.has(i)) inter++;
  return 1 - inter / (a.size + b.size - inter);
}

export type VfxOutcome = "drawn" | "static" | "absent" | "inconclusive" | "stale-shots";

export interface VfxSummary {
  identical: boolean;
  /** pixel counts per shot: dot = VfxProbeDot pink, marker = the VfxProbeMarker colours */
  perShot: Array<{ label: string; dot: number; marker: number }>;
  /** mean Jaccard distance of the pink masks of consecutive aura shots (0 = frozen, 1 = all new pixels) */
  auraMotion: number;
  outcomes: { aura: VfxOutcome; repoint: Exclude<VfxOutcome, "static"> };
}

/** a shot "has" the colour from this many arena pixels on (one 24 px dot at combat scale is ~1000) */
export const VFX_MIN_PIXELS = 40;
/** the baseline may carry this many look-alike pixels (lighting noise) and still count as "none" */
export const VFX_BASELINE_MAX = 20;
/** below this mean motion the pink set is a still picture */
export const VFX_MIN_MOTION = 0.2;

/**
 * The VFX probe verdicts from labelled shots: "baseline" (before any spawn), "aura N" (after `spawn VfxProbeAura`),
 * "repoint N" (after `spawn VfxProbeRepoint`). A question needs at least two of its shots over VFX_MIN_PIXELS.
 */
export function measureVfx(shots: Array<{ label: string; img: RgbaImageLike }>): VfxSummary {
  const identical = allIdentical(shots.map((s) => s.img));
  const masks = shots.map((s) => ({ label: s.label, dot: colourMask(s.img, [DOT]), marker: colourMask(s.img, MARKER) }));
  const perShot = masks.map((m) => ({ label: m.label, dot: m.dot.size, marker: m.marker.size }));
  const base = masks.find((m) => m.label === "baseline");
  const aura = masks.filter((m) => /^aura\b/.test(m.label));
  const rep = masks.filter((m) => /^repoint\b/.test(m.label));
  const motions: number[] = [];
  for (let i = 1; i < aura.length; i++) motions.push(jaccardDistance(aura[i - 1]!.dot, aura[i]!.dot));
  const auraMotion = motions.length ? motions.reduce((a, b) => a + b, 0) / motions.length : 0;
  let auraOut: VfxOutcome, repOut: Exclude<VfxOutcome, "static">;
  if (identical) { auraOut = "stale-shots"; repOut = "stale-shots"; }
  else {
    const seen = (xs: typeof aura, k: "dot" | "marker") => xs.filter((m) => m[k].size >= VFX_MIN_PIXELS).length >= Math.min(2, xs.length) && xs.length > 0;
    if (!base || base.dot.size > VFX_BASELINE_MAX) auraOut = "inconclusive";
    else if (!seen(aura, "dot")) auraOut = "absent";
    else auraOut = auraMotion >= VFX_MIN_MOTION ? "drawn" : "static";
    if (!base || base.marker.size > VFX_BASELINE_MAX) repOut = "inconclusive";
    else repOut = seen(rep, "marker") ? "drawn" : "absent";
  }
  return { identical, perShot, auraMotion, outcomes: { aura: auraOut, repoint: repOut } };
}
