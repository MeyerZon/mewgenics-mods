// Timeline baking: layers + keys → per-frame placements, and frame-to-frame diffs.
// Pure (no node, no DOM); shared by the SWF emitter (which turns the diffs into
// PlaceObject2 / RemoveObject2 tags) and the WebGL preview (which draws frame N).
// Because both consume the same baked frames, the preview shows exactly the
// matrices/cxforms the SWF will carry.

import { matrixFromTransform } from "./geometry.ts";

/**
 * @typedef {import('./geometry.ts').Mat} Mat
 * @typedef {import('./scene.ts').Scene} Scene
 * @typedef {import('./scene.ts').SceneSprite} SceneSprite
 * @typedef {import('./scene.ts').SceneKey} SceneKey
 * @typedef {import('./scene.ts').SceneLayer} SceneLayer
 */

/**
 * @typedef {Object} Cxform
 * @property {[number,number,number,number]} mul   r,g,b,a multipliers (1 = identity)
 * @property {[number,number,number,number]} add   r,g,b,a additive terms in 0..1 units (0 = identity)
 */

/**
 * @typedef {Object} Placement
 * @property {number} depth
 * @property {string} ref
 * @property {Mat} matrix
 * @property {Cxform|null} cxform      null = identity
 * @property {number|null} clipDepth
 * @property {string|null} name
 */

/**
 * @typedef {Object} BakedSprite
 * @property {number} frames
 * @property {Placement[][]} placements   placements[frame] sorted by depth ascending
 * @property {Array<string[]>} labels      labels[frame] = label names starting at that frame
 */

/** @type {Cxform} */
export const CXFORM_IDENTITY = { mul: [1, 1, 1, 1], add: [0, 0, 0, 0] };

/**
 * Resolve a key's matrix: raw `matrix` override wins; else x/y/sx/sy/rot/skew.
 * @param {SceneKey} k
 * @returns {Mat}
 */
export function keyMatrix(k) {
  if (k.matrix && k.matrix.length === 6) return /** @type {Mat} */ ([...k.matrix]);
  return matrixFromTransform(k);
}

/**
 * Resolve a key's colour transform (alpha shorthand folds into mul[3]).
 * @param {SceneKey} k
 * @returns {Cxform|null}
 */
export function keyCxform(k) {
  const mul = /** @type {[number,number,number,number]} */ ([...(k.cxform && k.cxform.mul ? k.cxform.mul : [1, 1, 1, 1])]);
  const add = /** @type {[number,number,number,number]} */ ([...(k.cxform && k.cxform.add ? k.cxform.add : [0, 0, 0, 0])]);
  if (typeof k.alpha === "number") mul[3] = mul[3] * k.alpha;
  if (mul.every((v, i) => v === 1) && add.every((v) => v === 0)) return null;
  return { mul, add };
}

/** @param {number} a @param {number} b @param {number} t */
function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Interpolated placement fields between two keys (linear). Interpolates the
 * component fields (x, y, sx, sy, rot, skew, alpha, cxform), not raw matrices, so a
 * rotation tween turns rather than collapsing. Raw `matrix` keys interpolate per element.
 * @param {SceneKey} a @param {SceneKey} b @param {number} t 0..1
 * @returns {{ matrix: Mat, cxform: Cxform|null }}
 */
export function interpolateKeys(a, b, t) {
  /** @type {Mat} */
  let matrix;
  if (a.matrix || b.matrix) {
    const ma = keyMatrix(a);
    const mb = keyMatrix(b);
    matrix = /** @type {Mat} */ (ma.map((v, i) => lerp(v, mb[i], t)));
  } else {
    matrix = matrixFromTransform({
      x: lerp(a.x ?? 0, b.x ?? 0, t),
      y: lerp(a.y ?? 0, b.y ?? 0, t),
      sx: lerp(a.sx ?? 1, b.sx ?? 1, t),
      sy: lerp(a.sy ?? 1, b.sy ?? 1, t),
      rot: lerp(a.rot ?? 0, b.rot ?? 0, t),
      skew: lerp(a.skew ?? 0, b.skew ?? 0, t),
    });
  }
  const ca = keyCxform(a) || CXFORM_IDENTITY;
  const cb = keyCxform(b) || CXFORM_IDENTITY;
  /** @type {Cxform} */
  const cx = {
    mul: /** @type {[number,number,number,number]} */ (ca.mul.map((v, i) => lerp(v, cb.mul[i], t))),
    add: /** @type {[number,number,number,number]} */ (ca.add.map((v, i) => lerp(v, cb.add[i], t))),
  };
  const isId = cx.mul.every((v) => v === 1) && cx.add.every((v) => v === 0);
  return { matrix, cxform: isId ? null : cx };
}

/**
 * Bake a sprite's layers into per-frame placements.
 * Semantics: a key holds until the next key on the same layer; `tween: "linear"` on a
 * key interpolates toward the next key (which must have a non-null ref); a `ref: null`
 * key removes the object from its depth; a ref change at a key swaps the character.
 * @param {SceneSprite} sprite
 * @returns {BakedSprite}
 */
export function bakeSprite(sprite) {
  const frames = Math.max(1, sprite.frames | 0);
  /** @type {Placement[][]} */
  const placements = Array.from({ length: frames }, () => []);
  /** @type {Array<string[]>} */
  const labels = Array.from({ length: frames }, () => []);
  for (const [name, fr] of Object.entries(sprite.labels || {})) {
    if (Number.isInteger(fr) && fr >= 0 && fr < frames) labels[fr].push(name);
  }
  for (const layer of sprite.layers || []) {
    const keys = (layer.keys || []).slice().sort((a, b) => a.frame - b.frame);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k.ref === null || k.ref === undefined) continue;
      const next = keys[i + 1];
      const end = next ? next.frame : frames; // exclusive
      const canTween = k.tween === "linear" && next && next.ref !== null && next.ref !== undefined;
      for (let f = Math.max(0, k.frame); f < Math.min(frames, end); f++) {
        /** @type {{ matrix: Mat, cxform: Cxform|null }} */
        let pose;
        if (canTween && next) {
          const span = next.frame - k.frame;
          pose = interpolateKeys(k, next, span > 0 ? (f - k.frame) / span : 0);
        } else {
          pose = { matrix: keyMatrix(k), cxform: keyCxform(k) };
        }
        placements[f].push({
          depth: layer.depth,
          ref: k.ref,
          matrix: pose.matrix,
          cxform: pose.cxform,
          clipDepth: layer.clip ? layer.clipDepth ?? null : null,
          name: layer.name || null,
        });
      }
    }
  }
  for (const list of placements) list.sort((a, b) => a.depth - b.depth);
  return { frames, placements, labels };
}

/**
 * The main timeline as a pseudo-sprite: stage_instances placed on frame 0 and held.
 * @param {Scene} scene
 * @returns {BakedSprite}
 */
export function bakeStage(scene) {
  const inst = scene.stage_instances || [];
  /** @type {SceneSprite} */
  const pseudo = {
    frames: 1,
    labels: {},
    layers: inst.map((si, i) => ({ depth: i + 1, keys: [{ ...si, frame: 0 }] })),
  };
  return bakeSprite(pseudo);
}

/**
 * place: new depth. replace: same depth, different character/clip/name (PlaceObject2
 * Move+HasCharacter). move: same character, matrix and/or cxform changed. remove: depth freed.
 * @typedef {{ op: 'place', p: Placement } | { op: 'replace', p: Placement } | { op: 'move', p: Placement, changedMatrix: boolean, changedCxform: boolean } | { op: 'remove', depth: number }} FrameOp
 */

/**
 * Diff two consecutive frames (by depth). Emitters turn these into tags; `prev` for
 * frame 0 is an empty list.
 * @param {Placement[]} prev @param {Placement[]} cur
 * @returns {FrameOp[]}
 */
export function diffFrames(prev, cur) {
  /** @type {FrameOp[]} */
  const ops = [];
  const prevBy = new Map(prev.map((p) => [p.depth, p]));
  const curBy = new Map(cur.map((p) => [p.depth, p]));
  for (const p of prev) if (!curBy.has(p.depth)) ops.push({ op: "remove", depth: p.depth });
  for (const p of cur) {
    const q = prevBy.get(p.depth);
    if (!q) {
      ops.push({ op: "place", p });
      continue;
    }
    if (q.ref !== p.ref || q.clipDepth !== p.clipDepth || q.name !== p.name) {
      ops.push({ op: "replace", p });
      continue;
    }
    const changedMatrix = !sameMat(q.matrix, p.matrix);
    const changedCxform = !sameCx(q.cxform, p.cxform);
    if (changedMatrix || changedCxform) ops.push({ op: "move", p, changedMatrix, changedCxform });
  }
  return ops;
}

/** @param {Mat} a @param {Mat} b */
export function sameMat(a, b) {
  for (let i = 0; i < 6; i++) if (Math.abs(a[i] - b[i]) > 1e-9) return false;
  return true;
}
/** @param {Cxform|null} a @param {Cxform|null} b */
export function sameCx(a, b) {
  if (!a && !b) return true;
  const x = a || CXFORM_IDENTITY;
  const y = b || CXFORM_IDENTITY;
  for (let i = 0; i < 4; i++) if (Math.abs(x.mul[i] - y.mul[i]) > 1e-9 || Math.abs(x.add[i] - y.add[i]) > 1e-9) return false;
  return true;
}

/**
 * Sorted list of {frame, label} for scrubber ticks.
 * @param {BakedSprite} baked
 */
export function labelList(baked) {
  /** @type {Array<{frame:number, label:string}>} */
  const out = [];
  baked.labels.forEach((names, frame) => names.forEach((label) => out.push({ frame, label })));
  return out;
}
