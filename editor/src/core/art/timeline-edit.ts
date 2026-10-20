// Animation-clip authoring: pure edit operations on one sprite's timeline (the Timeline tab and agents use these).
// Every op returns { sprite, findings } with a fresh copy; the input is never mutated. A refused op returns the
// sprite unchanged with an error finding. Semantics follow timeline.ts: a key holds until the next key on its layer,
// `tween: "linear"` interpolates the component fields toward the next key, a `ref: null` key removes the object.

import type { SceneSprite, SceneKey, Finding } from "./scene.ts";

export interface EditResult {
  sprite: SceneSprite;
  findings: Finding[];
}

/** The pose a layer shows at a frame (component fields; `ref: null` = nothing there). */
export interface Pose {
  ref: string | null;
  x: number;
  y: number;
  sx: number;
  sy: number;
  rot: number;
  skew: number;
  alpha: number;
}

const LABEL_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const clone = (sp: SceneSprite): SceneSprite & { labels: Record<string, number> } => {
  const c = JSON.parse(JSON.stringify(sp)) as SceneSprite;
  c.labels = c.labels || {};
  return c as SceneSprite & { labels: Record<string, number> };
};
const sorted = (keys: SceneKey[]) => keys.slice().sort((a, b) => a.frame - b.frame);
const refuse = (sp: SceneSprite, message: string, code = "timeline-edit"): EditResult => ({ sprite: sp, findings: [{ severity: "error", code, message }] });
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function layerOk(sp: SceneSprite, li: number): boolean {
  return Number.isInteger(li) && li >= 0 && li < (sp.layers || []).length;
}

/** The key exactly at `frame` on layer `li`, or null. */
export function keyAt(sp: SceneSprite, li: number, frame: number): SceneKey | null {
  if (!layerOk(sp, li)) return null;
  return sp.layers[li]!.keys.find((k) => k.frame === frame) || null;
}

/** The pose of layer `li` at `frame`. */
export function poseAt(sp: SceneSprite, li: number, frame: number): Pose {
  const none: Pose = { ref: null, x: 0, y: 0, sx: 1, sy: 1, rot: 0, skew: 0, alpha: 1 };
  if (!layerOk(sp, li)) return none;
  const keys = sorted(sp.layers[li]!.keys || []);
  let i = -1;
  for (let k = 0; k < keys.length; k++) if (keys[k]!.frame <= frame) i = k;
  if (i < 0) return none;
  const a = keys[i]!;
  if (a.ref === null || a.ref === undefined) return none;
  const of = (k: SceneKey): Pose => ({ ref: k.ref ?? null, x: k.x ?? 0, y: k.y ?? 0, sx: k.sx ?? 1, sy: k.sy ?? 1, rot: k.rot ?? 0, skew: k.skew ?? 0, alpha: k.alpha ?? 1 });
  const pa = of(a);
  const b = keys[i + 1];
  if (a.tween !== "linear" || !b || b.ref === null || b.ref === undefined || b.frame <= a.frame) return pa;
  const pb = of(b);
  const t = (frame - a.frame) / (b.frame - a.frame);
  return { ref: pa.ref, x: lerp(pa.x, pb.x, t), y: lerp(pa.y, pb.y, t), sx: lerp(pa.sx, pb.sx, t), sy: lerp(pa.sy, pb.sy, t), rot: lerp(pa.rot, pb.rot, t), skew: lerp(pa.skew, pb.skew, t), alpha: lerp(pa.alpha, pb.alpha, t) };
}

/**
 * Set fields on the key at `frame`, creating it from the pose shown there when there is none. A key created inside a
 * tween span keeps tweening toward the next key.
 */
export function setKey(sp: SceneSprite, li: number, frame: number, fields: Partial<SceneKey>): EditResult {
  if (!layerOk(sp, li)) return refuse(sp, `no layer ${li}`);
  if (!(Number.isInteger(frame) && frame >= 0 && frame < sp.frames)) return refuse(sp, `frame ${frame} outside 0..${sp.frames - 1}`);
  const out = clone(sp);
  const layer = out.layers[li]!;
  const existing = layer.keys.find((k) => k.frame === frame);
  if (existing) {
    Object.assign(existing, fields, { frame });
    return { sprite: out, findings: [] };
  }
  const pose = poseAt(sp, li, frame);
  const ref = fields.ref !== undefined ? fields.ref : pose.ref;
  if (ref === null || ref === undefined) {
    if (fields.ref === null) {
      layer.keys = sorted([...layer.keys, { frame, ref: null }]);
      return { sprite: out, findings: [] };
    }
    return refuse(sp, `layer ${layer.name || li} shows nothing at frame ${frame}: pass ref to place something`);
  }
  const k: SceneKey = { frame, ref, x: round(pose.x), y: round(pose.y) };
  if (pose.sx !== 1) k.sx = round(pose.sx);
  if (pose.sy !== 1) k.sy = round(pose.sy);
  if (pose.rot !== 0) k.rot = round(pose.rot);
  if (pose.skew !== 0) k.skew = round(pose.skew);
  if (pose.alpha !== 1) k.alpha = round(pose.alpha);
  const prev = sorted(layer.keys).filter((q) => q.frame < frame).pop();
  const next = sorted(layer.keys).find((q) => q.frame > frame);
  if (prev && prev.tween === "linear" && next && next.ref) k.tween = "linear";
  Object.assign(k, fields, { frame });
  layer.keys = sorted([...layer.keys, k]);
  return { sprite: out, findings: [] };
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Remove the key at `frame` (a layer keeps at least one key). */
export function removeKey(sp: SceneSprite, li: number, frame: number): EditResult {
  if (!layerOk(sp, li)) return refuse(sp, `no layer ${li}`);
  const keys = sp.layers[li]!.keys;
  if (!keys.some((k) => k.frame === frame)) return refuse(sp, `no key at frame ${frame}`);
  if (keys.length <= 1) return refuse(sp, "a layer needs at least one key (delete the layer instead)");
  const out = clone(sp);
  out.layers[li]!.keys = out.layers[li]!.keys.filter((k) => k.frame !== frame);
  return { sprite: out, findings: [] };
}

/** Move the key at `from` to the free frame `to`. */
export function moveKey(sp: SceneSprite, li: number, from: number, to: number): EditResult {
  if (!layerOk(sp, li)) return refuse(sp, `no layer ${li}`);
  if (!(Number.isInteger(to) && to >= 0 && to < sp.frames)) return refuse(sp, `frame ${to} outside 0..${sp.frames - 1}`);
  const keys = sp.layers[li]!.keys;
  if (!keys.some((k) => k.frame === from)) return refuse(sp, `no key at frame ${from}`);
  if (from !== to && keys.some((k) => k.frame === to)) return refuse(sp, `frame ${to} already has a key`);
  const out = clone(sp);
  const layer = out.layers[li]!;
  layer.keys.find((k) => k.frame === from)!.frame = to;
  layer.keys = sorted(layer.keys);
  return { sprite: out, findings: [] };
}

/** Set (or move) a frame label. */
export function setLabel(sp: SceneSprite, name: string, frame: number): EditResult {
  if (!LABEL_RE.test(name)) return refuse(sp, `label "${name}" must be letters, digits and _ (not starting with a digit)`);
  if (!(Number.isInteger(frame) && frame >= 0 && frame < sp.frames)) return refuse(sp, `frame ${frame} outside 0..${sp.frames - 1}`);
  const out = clone(sp);
  out.labels = { ...(out.labels || {}), [name]: frame };
  return { sprite: out, findings: [] };
}

export function removeLabel(sp: SceneSprite, name: string): EditResult {
  if (!sp.labels || !(name in sp.labels)) return refuse(sp, `no label "${name}"`);
  const out = clone(sp);
  delete out.labels[name];
  return { sprite: out, findings: [] };
}

/** Insert `n` empty frames before frame `at`: keys and labels at or after it move later. */
export function insertFrames(sp: SceneSprite, at: number, n: number): EditResult {
  if (!(Number.isInteger(n) && n >= 1)) return refuse(sp, "insert at least 1 frame");
  if (!(Number.isInteger(at) && at >= 0 && at <= sp.frames)) return refuse(sp, `frame ${at} outside 0..${sp.frames}`);
  const out = clone(sp);
  out.frames += n;
  for (const l of out.layers) for (const k of l.keys) if (k.frame >= at) k.frame += n;
  for (const [name, f] of Object.entries(out.labels || {})) if (f >= at) out.labels[name] = f + n;
  return { sprite: out, findings: [] };
}

/**
 * Delete frames at..at+n-1: keys and labels inside go, the rest move earlier. When a layer's last key inside the cut
 * was holding into the frames after it, that key moves to the cut point so those frames keep their pose.
 */
export function deleteFrames(sp: SceneSprite, at: number, n: number): EditResult {
  if (!(Number.isInteger(n) && n >= 1)) return refuse(sp, "delete at least 1 frame");
  if (!(Number.isInteger(at) && at >= 0 && at + n <= sp.frames)) return refuse(sp, `frames ${at}..${at + n - 1} are not all inside 0..${sp.frames - 1}`);
  if (n >= sp.frames) return refuse(sp, "a sprite keeps at least 1 frame");
  const out = clone(sp);
  const findings: Finding[] = [];
  const end = at + n; // first frame after the cut (before shifting)
  out.layers = out.layers.filter((l) => {
    const inside = sorted(l.keys.filter((k) => k.frame >= at && k.frame < end));
    let keep = l.keys.filter((k) => k.frame < at || k.frame >= end);
    const carried = inside[inside.length - 1];
    if (carried && end < sp.frames && !keep.some((k) => k.frame === end)) keep.push({ ...carried, frame: end });
    keep = sorted(keep).map((k) => (k.frame >= end ? { ...k, frame: k.frame - n } : k));
    if (!keep.length) {
      findings.push({ severity: "warning", code: "layer-removed", message: `layer ${l.name || l.depth} had keys only inside the deleted frames; removed` });
      return false;
    }
    l.keys = keep;
    return true;
  });
  for (const [name, f] of Object.entries(out.labels || {})) {
    if (f >= at && f < end) {
      delete out.labels[name];
      findings.push({ severity: "warning", code: "label-removed", message: `label "${name}" was on a deleted frame; removed` });
    } else if (f >= end) out.labels[name] = f - n;
  }
  out.frames -= n;
  return { sprite: out, findings };
}

/** Swap a layer with its neighbour in depth order (dir +1 = toward the front). */
export function moveLayer(sp: SceneSprite, li: number, dir: 1 | -1): EditResult {
  if (!layerOk(sp, li)) return refuse(sp, `no layer ${li}`);
  const order = sp.layers.map((l, i) => ({ i, depth: l.depth })).sort((a, b) => a.depth - b.depth);
  const pos = order.findIndex((o) => o.i === li);
  const other = order[pos + dir];
  if (!other) return refuse(sp, dir > 0 ? "already the front layer" : "already the back layer");
  const out = clone(sp);
  const a = out.layers[li]!;
  const b = out.layers[other.i]!;
  const da = a.depth;
  a.depth = b.depth;
  b.depth = da;
  const findings: Finding[] = [];
  if (out.layers.some((l) => l.clip)) findings.push({ severity: "warning", code: "mask-depths", message: "this sprite has mask layers: check their clipDepth after reordering" });
  return { sprite: out, findings };
}
