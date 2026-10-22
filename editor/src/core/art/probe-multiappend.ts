// Multi-append probe (2026-10-22): two mods each export `_Append_CatTest` from their own SWF. Does the game merge
// both into CatTest, and what does a label both define resolve to? Pure: the scenes and the shot measure.
//
// mods/_catappendA (catappendA.swf) appends probeAF/probeAB (marker MAGENTA) and the collision label probeCF/probeCB
// (marker BLUE); mods/_catappendB (catappendB.swf) appends probeBF/probeBB (CYAN) and its own probeCF/probeCB
// (GREEN). Each labeled frame places a `parts: "game"` cat rig (seven EMPTY slot sprites at vanilla idleF's slot
// matrices, the A0 layout) as the child `ani`, plus a solid marker box at the non-slot depth 15. ProbeCatA / ProbeCatB
// / ProbeCatC are TomTom with `alt_animations [[idle probeA|probeB|probeC]]`. A shot is read by counting each
// marker colour (passthrough colours: the cat shader remaps only r = g = b).

import type { Scene, SceneSprite } from "./scene.ts";
import type { RgbaImageLike } from "./probe-compare.ts";

export type MultiAppendMod = "A" | "B";

/** marker colours: the mod's own label and its version of the shared label probeC */
export const MULTI_APPEND_MARKERS = {
  A: { own: "#ff00ff", collision: "#0000ff" },
  B: { own: "#00ffff", collision: "#00ff00" },
} as const;

export const MULTI_APPEND_MOD: Record<MultiAppendMod, string> = { A: "_catappendA", B: "_catappendB" };

/** vanilla idleF's slot matrices (the A0 CatProbe rig, pinned T1 against catanis.swf in cat-rig-slots.json) */
const SLOT_MATRICES: Array<{ name: string; depth: number; matrix: [number, number, number, number, number, number]; mul?: number }> = [
  { name: "tail", depth: 1, matrix: [0.599639892578125, 0.16241455078125, -0.16241455078125, 0.599639892578125, -24.45, 10.05] },
  { name: "leg2", depth: 3, matrix: [0.6212615966796875, 0, -0.0479583740234375, 0.6212615966796875, -9.85, 23.65], mul: 0.84765625 },
  { name: "arm2", depth: 5, matrix: [0.6212615966796875, 0, 0, 0.6212615966796875, 17.15, 32.45], mul: 0.84765625 },
  { name: "body", depth: 7, matrix: [0.621307373046875, 0.00445556640625, -0.01177978515625, 0.6211090087890625, -0.4, 16.35] },
  { name: "leg1", depth: 9, matrix: [0.6212615966796875, 0, -0.0883636474609375, 0.6212615966796875, -32.1, 27.1] },
  { name: "arm1", depth: 11, matrix: [0.6212615966796875, 0, 0, 0.6212615966796875, -4.7, 37.25] },
  { name: "head", depth: 13, matrix: [0.6212615966796875, 0, 0, 0.6212615966796875, 10.95, 2.3] },
];

/** the marker box (px, clip space): just above the head, so a cat at the back of the arena keeps it on screen (A0's
 * box 330 px up left the top edge for back-row cats — a "missing" frame that was only off screen) */
export const MULTI_APPEND_BOX = { x: -25, y: -150, size: 50 };

function rig(scene: Scene, id: string, colour: string): void {
  const { x, y, size } = MULTI_APPEND_BOX;
  scene.shapes[`${id}_box`] = { paths: [{ d: `M${x} ${y} L${x + size} ${y} L${x + size} ${y + size} L${x} ${y + size} Z`, fill: colour, fillRule: "nonzero" }] };
  const layers: SceneSprite["layers"] = SLOT_MATRICES.map((s) => {
    scene.sprites[`${id}_${s.name}`] = { frames: 1, labels: {}, layers: [] };
    return { name: s.name, depth: s.depth, keys: [{ frame: 0, ref: `${id}_${s.name}`, matrix: s.matrix, ...(s.mul ? { cxform: { mul: [s.mul, s.mul, s.mul, 1] } } : {}) }] };
  });
  layers.push({ name: "marker", depth: 15, keys: [{ frame: 0, ref: `${id}_box`, x: 0, y: 0 }] });
  scene.sprites[id] = { frames: 24, labels: { idle: 0 }, rig: "cat", parts: "game", layers } as SceneSprite;
}

/** The probe scene of mod A or B: one `_Append_CatTest` donor with the mod's own label pair and the shared probeC pair. */
export function multiAppendScene(which: MultiAppendMod): Scene {
  const name = `catappend${which}`;
  const scene = {
    version: 1,
    name,
    frameRate: 60,
    stage: { width: 1280, height: 720, background: "#000000" },
    preview: { palette: 54 },
    shapes: {},
    bitmaps: {},
    texts: {},
    gradients: {},
    sprites: {},
    exports: {},
  } as unknown as Scene;
  const own = `Probe${which}Rig`;
  const col = `Probe${which}CollRig`;
  rig(scene, own, MULTI_APPEND_MARKERS[which].own);
  rig(scene, col, MULTI_APPEND_MARKERS[which].collision);
  const donor = `CatAppend${which}`;
  const at = { x: 3.85, y: -47.95 }; // vanilla idleF's (77, -959) twips
  scene.sprites[donor] = {
    frames: 4,
    labels: { [`probe${which}F`]: 0, [`probe${which}B`]: 1, probeCF: 2, probeCB: 3 },
    layers: [{ name: "ani", depth: 1, keys: [0, 1, 2, 3].map((frame) => ({ frame, ref: frame < 2 ? own : col, ...at })) }],
  };
  scene.exports = { _Append_CatTest: donor };
  return scene;
}

const hex = (c: string): [number, number, number] => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

/**
 * Pixels whose chromaticity matches `colour` (the pixel scaled to its brightest channel within `tol` per channel,
 * brightest channel >= 90): the arena's lighting and the top-edge fog darken a marker without changing its hue.
 */
export function countColour(img: RgbaImageLike, colour: string, tol = 0.3): number {
  const t = hex(colour).map((v) => v / 255);
  let n = 0;
  for (let i = 0; i < img.width * img.height * 4; i += 4) {
    const r = img.rgba[i]!, g = img.rgba[i + 1]!, b = img.rgba[i + 2]!;
    const m = Math.max(r, g, b);
    if (m < 90) continue;
    if (Math.abs(r / m - t[0]!) <= tol && Math.abs(g / m - t[1]!) <= tol && Math.abs(b / m - t[2]!) <= tol) n++;
  }
  return n;
}

/** a marker counts as present above this many pixels (the 50 px box at game scale is about 9000) */
export const MARKER_MIN_PIXELS = 1500;

export interface MultiAppendShot {
  label: string;
  counts: { A: number; B: number; AC: number; BC: number };
  present: { A: boolean; B: boolean; AC: boolean; BC: boolean };
}

export function measureMultiAppendShot(label: string, img: RgbaImageLike): MultiAppendShot {
  const counts = {
    A: countColour(img, MULTI_APPEND_MARKERS.A.own),
    B: countColour(img, MULTI_APPEND_MARKERS.B.own),
    AC: countColour(img, MULTI_APPEND_MARKERS.A.collision),
    BC: countColour(img, MULTI_APPEND_MARKERS.B.collision),
  };
  const present = { A: counts.A >= MARKER_MIN_PIXELS, B: counts.B >= MARKER_MIN_PIXELS, AC: counts.AC >= MARKER_MIN_PIXELS, BC: counts.BC >= MARKER_MIN_PIXELS };
  return { label, counts, present };
}
