// Cat rig: a cat-shaped character drawn by our own SWF with the slot layout of the game's cat animations — one named
// instance per body part (tail, leg2, arm2, body, leg1, arm1, head) at the depths the main cat animation in
// catanis.swf uses (pinned in test/fixtures/art/cat-rig-slots.json against the installed game). Pure.
//
// Scope: this authors *our* character in the vanilla layout (each slot is any shape or sprite of the scene). It does
// not add parts to the game's catparts.swf or make the game swap its own parts into our slots — that is engine work.

import type { Scene, SceneSprite, SceneShape, SceneLayer, Finding } from "./scene.ts";

/** The main vanilla cat animation's slots, back to front. */
export const CAT_SLOTS: ReadonlyArray<{ name: string; depth: number }> = [
  { name: "tail", depth: 1 },
  { name: "leg2", depth: 3 },
  { name: "arm2", depth: 5 },
  { name: "body", depth: 7 },
  { name: "leg1", depth: 9 },
  { name: "arm1", depth: 11 },
  { name: "head", depth: 13 },
];
export const CAT_SLOT_NAMES = CAT_SLOTS.map((s) => s.name);

/** Placeholder part geometry (px, the cat standing on y = 0, facing right) and its gray level. */
const PLACEHOLDER: Record<string, { d: string; gray: number }> = {
  tail: { d: "M-38 -38 C-70 -50 -78 -86 -60 -104 L-52 -98 C-64 -82 -58 -60 -34 -48 Z", gray: 6 },
  leg2: { d: "M-24 -22 L-12 -22 L-12 0 L-26 0 Z", gray: 5 },
  arm2: { d: "M14 -22 L26 -22 L26 0 L12 0 Z", gray: 5 },
  body: { d: "M-40 -40 C-40 -62 40 -62 40 -40 C40 -16 -40 -16 -40 -40 Z", gray: 8 },
  leg1: { d: "M-34 -22 L-22 -22 L-20 0 L-34 0 Z", gray: 9 },
  arm1: { d: "M24 -22 L36 -22 L38 0 L24 0 Z", gray: 9 },
  head: { d: "M22 -78 C22 -100 70 -100 70 -78 C70 -56 22 -56 22 -78 Z M26 -92 L30 -112 L42 -96 Z M50 -96 L62 -112 L66 -92 Z", gray: 11 },
};

const clone = (s: Scene): Scene => JSON.parse(JSON.stringify(s)) as Scene;
const refuse = (scene: Scene, message: string) => ({ scene, findings: [{ severity: "error" as const, code: "cat-rig", message }] });

export interface AddCatRigOptions {
  frames?: number;
  /** fill per slot instead of the gray placeholder levels (e.g. passthrough colours for an in-game check) */
  colours?: Partial<Record<string, string>>;
}

/** Add a cat rig sprite `name` (rig: "cat") with one placeholder shape per slot, named `<name>_<slot>`. */
export function addCatRig(scene: Scene, name: string, opts: AddCatRigOptions = {}): { scene: Scene; findings: Finding[] } {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return refuse(scene, `rig name "${name}" must be letters, digits and _`);
  if (scene.sprites[name] || scene.shapes[name]) return refuse(scene, `"${name}" is already a shape or sprite`);
  const out = clone(scene);
  for (const s of CAT_SLOTS) {
    const id = `${name}_${s.name}`;
    if (out.shapes[id] || out.sprites[id]) return refuse(scene, `placeholder id "${id}" is taken`);
    const ph = PLACEHOLDER[s.name]!;
    const shape: SceneShape = { paths: [{ d: ph.d, fill: (opts.colours && opts.colours[s.name]) || `gray:${ph.gray}`, fillRule: "nonzero" }] };
    out.shapes[id] = shape;
  }
  const sprite: SceneSprite = {
    frames: Math.max(1, opts.frames ?? 24),
    labels: { idle: 0 },
    rig: "cat",
    layers: CAT_SLOTS.map((s) => ({ name: s.name, depth: s.depth, keys: [{ frame: 0, ref: `${name}_${s.name}`, x: 0, y: 0 }] })),
  };
  out.sprites[name] = sprite;
  return { scene: out, findings: [] };
}

/** Point every placing key of a rig slot at `ref` (a shape or another sprite). */
export function assignSlot(scene: Scene, spriteId: string, slot: string, ref: string): { scene: Scene; findings: Finding[] } {
  const sp = scene.sprites[spriteId];
  if (!sp) return refuse(scene, `no sprite "${spriteId}"`);
  if (!CAT_SLOT_NAMES.includes(slot)) return refuse(scene, `"${slot}" is not a cat slot (${CAT_SLOT_NAMES.join(", ")})`);
  if (!(scene.shapes[ref] || (scene.sprites[ref] && ref !== spriteId))) return refuse(scene, `"${ref}" is not a shape or another sprite`);
  const li = sp.layers.findIndex((l) => l.name === slot);
  if (li < 0) return refuse(scene, `sprite "${spriteId}" has no "${slot}" layer`);
  const out = clone(scene);
  for (const k of out.sprites[spriteId]!.layers[li]!.keys) if (k.ref !== null && k.ref !== undefined) k.ref = ref;
  return { scene: out, findings: [] };
}

// ---- cat animations: labeled facing frames appended to the game's CatTest clip ---------------------------------------
//
// OBSERVED 2026-10-21 (read-only parse of catanis.swf / catanis2.swf; pinned in test/fixtures/art/cat-anim-append.json):
// the vanilla cat clip is `CatTest` (854 frames, 776 labels). Labels come in facing pairs `<anim>F` / `<anim>B`
// (`idleF`/`idleB`, `dashF`/`dashB`, …); every labeled frame places at most one character, always at depth 1 — a nested
// pose sprite carrying the CAT_SLOTS instances, named `pawing` on the idle/walk/hit frames. catanis2.swf extends the
// clip with an export `_Append_CatTest` of the same shape (296 frames, 239 labels like `crawlingIdleF`). Data refers to
// an animation by its bare name (`alt_animations [[idle <name>]]`, an ability's `animation <name>`); the engine adds the
// facing suffix. Whether the game fills the slots of an *appended* frame by name is under test in-game
// (feat/cat-append-probe); this authors the vanilla shape either way.

export const CAT_ANIM_EXPORT = "_Append_CatTest";
export const CAT_ANIM_LAYER = "pawing";
export const CAT_ANIM_DEPTH = 1;
export const CAT_ANIM_FACINGS: ReadonlyArray<string> = ["F", "B"];
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface NewCatAnimationOptions extends AddCatRigOptions {
  /** reuse this rig: "cat" sprite for the pose instead of adding `<name>Pose` */
  rig?: string;
}

export interface NewCatAnimationResult {
  scene: Scene;
  findings: Finding[];
  /** the rig sprite the frames place */
  rig?: string;
  /** the `_Append_CatTest` donor sprite */
  donor?: string;
}

/** The sprite `exports._Append_CatTest` names when it is a usable donor (a non-rig sprite), else null. */
export function catAnimDonor(scene: Scene): string | null {
  const id = (scene.exports || {})[CAT_ANIM_EXPORT];
  if (typeof id !== "string") return null;
  const sp = scene.sprites[id];
  return sp && Array.isArray(sp.layers) && sp.rig === undefined ? id : null;
}

/**
 * Add a cat animation `name`: a rig `<name>Pose` (or `opts.rig`), and the labeled frames `<name>F` / `<name>B` on the
 * `_Append_CatTest` donor sprite (`CatAnim_<name>` when the scene has none yet), each placing the rig as the layer
 * `pawing` at depth 1 — the shape every vanilla CatTest frame has.
 */
export function newCatAnimation(scene: Scene, name: string, opts: NewCatAnimationOptions = {}): NewCatAnimationResult {
  const no = (message: string): NewCatAnimationResult => ({ scene, findings: [{ severity: "error", code: "cat-anim", message }] });
  if (!NAME_RE.test(name)) return no(`animation name "${name}" must be letters, digits and _ (not starting with a digit)`);
  const exportRef = (scene.exports || {})[CAT_ANIM_EXPORT];
  let donorId = catAnimDonor(scene);
  if (exportRef !== undefined && !donorId) return no(`exports.${CAT_ANIM_EXPORT} points at "${String(exportRef)}", which is not a donor sprite (a plain sprite whose labeled frames place a cat rig)`);
  const labels = CAT_ANIM_FACINGS.map((f) => `${name}${f}`);
  if (donorId) {
    const have = Object.keys(scene.sprites[donorId]!.labels || {});
    const taken = labels.filter((l) => have.includes(l));
    if (taken.length) return no(`"${donorId}" already has the label${taken.length > 1 ? "s" : ""} ${taken.join(", ")}`);
  } else {
    donorId = `CatAnim_${name}`;
    if (scene.sprites[donorId] || scene.shapes[donorId]) return no(`"${donorId}" is already a shape or sprite`);
  }
  let out: Scene;
  let rigId: string;
  if (opts.rig !== undefined) {
    const rig = scene.sprites[opts.rig];
    if (!rig || rig.rig !== "cat") return no(`"${opts.rig}" is not a cat rig sprite (rig: "cat")`);
    rigId = opts.rig;
    out = clone(scene);
  } else {
    rigId = `${name}Pose`;
    const r = addCatRig(scene, rigId, { frames: opts.frames, colours: opts.colours });
    if (r.findings.length) return { scene, findings: r.findings };
    out = r.scene;
  }
  let donor = out.sprites[donorId];
  if (!donor) {
    donor = { frames: 0, labels: {}, layers: [] };
    out.sprites[donorId] = donor;
  }
  donor.labels = donor.labels || {};
  let layer = donor.layers.find((l) => l.name === CAT_ANIM_LAYER);
  if (!layer) {
    const atDepth = donor.layers.find((l) => l.depth === CAT_ANIM_DEPTH);
    if (atDepth) return no(`"${donorId}" has a layer "${atDepth.name || ""}" at depth ${CAT_ANIM_DEPTH} that is not the ${CAT_ANIM_LAYER} layer`);
    layer = { name: CAT_ANIM_LAYER, depth: CAT_ANIM_DEPTH, keys: [] };
    donor.layers.push(layer);
  }
  const first = donor.frames;
  labels.forEach((label, i) => {
    const frame = first + i;
    donor.labels![label] = frame;
    layer.keys = layer.keys.filter((k) => k.frame !== frame);
    layer.keys.push({ frame, ref: rigId, x: 0, y: 0 });
  });
  layer.keys.sort((a, b) => a.frame - b.frame);
  donor.frames = first + labels.length;
  out.exports = { ...(out.exports || {}), [CAT_ANIM_EXPORT]: donorId };
  return { scene: out, findings: [], rig: rigId, donor: donorId };
}

/** What a layer places at `frame` (the latest key at or before it; null when nothing is there). */
function placedAt(layer: SceneLayer, frame: number): string | null {
  let ref: string | null = null;
  let best = -1;
  for (const k of layer.keys || []) if (k.frame <= frame && k.frame > best) { best = k.frame; ref = k.ref ?? null; }
  return ref;
}

/**
 * Checks for the `_Append_CatTest` donor (the validator adds them): facing pairs complete, each labeled frame places a
 * cat rig, at depth 1; plus the standing note that in-game slot filling of appended frames is under test.
 */
export function catAnimFindings(scene: Scene): Finding[] {
  const out: Finding[] = [];
  const id = (scene.exports || {})[CAT_ANIM_EXPORT];
  if (id === undefined) return out;
  const at = `exports.${CAT_ANIM_EXPORT}`;
  const sp = typeof id === "string" ? scene.sprites[id] : undefined;
  if (!sp || !Array.isArray(sp.layers)) {
    if (typeof id === "string" && (scene.shapes[id] || !scene.sprites[id])) out.push({ severity: "error", code: "cat-anim-donor", message: `${CAT_ANIM_EXPORT} must point at a donor sprite whose labeled frames place a cat rig; "${id}" is ${scene.shapes[id] ? "a shape" : "not a sprite"}`, path: at });
    return out;
  }
  const sat = `sprites.${id}`;
  if (sp.rig !== undefined) {
    out.push({ severity: "error", code: "cat-anim-donor", message: `${CAT_ANIM_EXPORT} points at the cat rig "${id}" itself; it must point at a donor sprite whose labeled frames place the rig`, path: at });
    return out;
  }
  const labels = sp.labels || {};
  const names = Object.keys(labels);
  for (const label of names) {
    const facing = CAT_ANIM_FACINGS.find((f) => label.endsWith(f) && label.length > f.length);
    if (!facing) continue;
    const base = label.slice(0, -facing.length);
    const missing = CAT_ANIM_FACINGS.filter((f) => f !== facing).map((f) => `${base}${f}`).filter((l) => !(l in labels));
    for (const m of missing) out.push({ severity: "error", code: "cat-anim-missing-facing", message: `label "${label}" has no facing partner "${m}" (the engine picks <anim>F / <anim>B by facing)`, path: `${sat}.labels.${label}` });
  }
  for (const label of names) {
    const frame = labels[label]!;
    if (!Number.isInteger(frame)) continue;
    const placing = sp.layers.map((l, li) => ({ l, li, ref: placedAt(l, frame) })).filter((p) => p.ref !== null);
    if (!placing.length) {
      out.push({ severity: "error", code: "cat-anim-layer-not-rig", message: `labeled frame "${label}" (frame ${frame}) places nothing; a cat animation frame places a rig: "cat" sprite at depth ${CAT_ANIM_DEPTH}`, path: `${sat}.labels.${label}` });
      continue;
    }
    for (const p of placing) {
      const target = scene.sprites[p.ref!];
      const lat = `${sat}.layers[${p.li}]`;
      if (!target || target.rig !== "cat") out.push({ severity: "error", code: "cat-anim-layer-not-rig", message: `labeled frame "${label}" (frame ${frame}) places "${p.ref}" on layer ${p.l.name || p.li}, which is not a rig: "cat" sprite`, path: lat });
      if (p.l.depth !== CAT_ANIM_DEPTH) out.push({ severity: "warning", code: "cat-anim-depth", message: `labeled frame "${label}" places its pose at depth ${p.l.depth}; every vanilla CatTest frame places it at depth ${CAT_ANIM_DEPTH}`, path: `${lat}.depth` });
    }
  }
  out.push({ severity: "info", code: "cat-anim-untested", message: `${CAT_ANIM_EXPORT} frames are authored in the vanilla shape (labeled F/B frames, a pose sprite at depth ${CAT_ANIM_DEPTH}); whether the game fills an appended frame's slots by name is under test in-game (2026-10-21, feat/cat-append-probe)`, path: at });
  return out;
}

/** Rig checks for a sprite marked rig: "cat" (the validator adds them). */
export function rigFindings(sp: SceneSprite, at: string): Finding[] {
  const out: Finding[] = [];
  const names = (sp.layers || []).map((l) => l.name || "");
  for (const s of CAT_SLOT_NAMES) {
    const n = names.filter((x) => x === s).length;
    if (!n) out.push({ severity: "warning", code: "rig-slot-missing", message: `cat rig has no "${s}" layer`, path: at });
    if (n > 1) out.push({ severity: "error", code: "rig-slot-dup", message: `cat rig has ${n} "${s}" layers (instance names must be unique)`, path: at });
  }
  const present = (sp.layers || []).filter((l) => CAT_SLOT_NAMES.includes(l.name || "")).sort((a, b) => a.depth - b.depth).map((l) => l.name!);
  const expected = CAT_SLOT_NAMES.filter((s) => present.includes(s));
  if (present.join(",") !== [...new Set(present)].join(",") || [...new Set(present)].join(",") !== expected.join(",")) {
    out.push({ severity: "info", code: "rig-depth-order", message: `slot stacking ${[...new Set(present)].join(" < ")} differs from the vanilla ${expected.join(" < ")}`, path: at });
  }
  return out;
}
