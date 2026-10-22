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
