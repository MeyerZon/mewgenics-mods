// Cat rig: a cat-shaped character drawn by our own SWF with the slot layout of the game's cat animations — one named
// instance per body part (tail, leg2, arm2, body, leg1, arm1, head) at the depths the main cat animation in
// catanis.swf uses (pinned in test/fixtures/art/cat-rig-slots.json against the installed game). Pure.
//
// Two kinds of rig: a drawn one (each slot is any shape or sprite of the scene; placeholder shapes by default, which the
// game draws as-is on a non-cat character) and a `parts: "game"` one whose slots are EMPTY 1-frame sprites — on a cat,
// CatParts::prerender (0x742350, .analysis/notes-catB.md) fills every named slot with the cat's own part (palette,
// texture, face included) on the slot's first prerender, but only when the slot sprite is hidden or has no children; a
// visible, non-empty slot is taken for an already-converted one and the game crashes (+0x741f5d). Vanilla hides its
// placeholders with an ActionScript setInvisible() the emitter cannot express, so a mod's slots stay empty.

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

/**
 * The back-facing layout, back to front: vanilla `idleB`'s pose (catanis.swf CatTest; T1-pinned in
 * test/fixtures/art/cat-back-facing.json). A `<anim>B` frame places its own pose sprite with the head BEHIND the body
 * and the tail in front, the far limbs swapped. `head_back` is the head slot with the catgen.gon face `back`
 * (`faces { back { back true } }`): CatParts::load_faces 0x73a990 registers the slot name "head_" + <face> for every
 * face, so the game draws the cat's own head from behind there (no face). The visitor's `bhead` spelling (0x742bd0)
 * is used by no vanilla cat frame.
 */
export const CAT_BACK_HEAD = "head_back";
export const CAT_BACK_SLOTS: ReadonlyArray<{ name: string; depth: number }> = [
  { name: CAT_BACK_HEAD, depth: 1 },
  { name: "arm2", depth: 3 },
  { name: "leg2", depth: 5 },
  { name: "body", depth: 7 },
  { name: "arm1", depth: 9 },
  { name: "leg1", depth: 11 },
  { name: "tail", depth: 13 },
];
export const CAT_BACK_SLOT_NAMES = CAT_BACK_SLOTS.map((s) => s.name);
const ANY_SLOT_NAMES = [...new Set([...CAT_SLOT_NAMES, ...CAT_BACK_SLOT_NAMES])];

/** The slot layout of a rig sprite: the back layout for `facing: "back"`, else the front one. */
export function catSlotsFor(sp: { facing?: string } | null | undefined): ReadonlyArray<{ name: string; depth: number }> {
  return sp && sp.facing === "back" ? CAT_BACK_SLOTS : CAT_SLOTS;
}

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

PLACEHOLDER[CAT_BACK_HEAD] = { d: PLACEHOLDER.head!.d, gray: 10 };

const clone = (s: Scene): Scene => JSON.parse(JSON.stringify(s)) as Scene;
const refuse = (scene: Scene, message: string) => ({ scene, findings: [{ severity: "error" as const, code: "cat-rig", message }] });

export interface AddCatRigOptions {
  frames?: number;
  /** fill per slot instead of the gray placeholder levels (e.g. passthrough colours for an in-game check) */
  colours?: Partial<Record<string, string>>;
  /** "game": every slot is an EMPTY 1-frame sprite the game fills with the cat's own part (no placeholder art) */
  parts?: "game";
  /** "back": the back-facing layout (CAT_BACK_SLOTS: head_back behind, tail in front) a `<anim>B` frame places */
  facing?: "back";
}

/** An empty sprite (no layer places anything): the only slot content CatParts accepts from a mod. */
export function isEmptySprite(scene: Scene, ref: string | null | undefined): boolean {
  if (typeof ref !== "string") return false;
  const sp = scene.sprites[ref];
  if (!sp || !Array.isArray(sp.layers)) return false;
  return sp.layers.every((l) => (l.keys || []).every((k) => k.ref === null || k.ref === undefined));
}

/** The slot layers of a cat rig whose placed content is not an empty sprite. */
export function nonEmptySlots(scene: Scene, rigId: string): string[] {
  const sp = scene.sprites[rigId];
  if (!sp || !Array.isArray(sp.layers)) return [];
  return sp.layers.filter((l) => ANY_SLOT_NAMES.includes(l.name || "") && (l.keys || []).some((k) => k.ref !== null && k.ref !== undefined && !isEmptySprite(scene, k.ref))).map((l) => l.name!);
}

/**
 * Add a cat rig sprite `name` (rig: "cat") with one layer per slot, named `<name>_<slot>`: placeholder shapes (a drawn
 * rig, preview-only art) or, with `parts: "game"`, empty 1-frame sprites the game fills with the cat's own parts.
 * `facing: "back"` lays it out as a back-facing pose (CAT_BACK_SLOTS).
 */
export function addCatRig(scene: Scene, name: string, opts: AddCatRigOptions = {}): { scene: Scene; findings: Finding[] } {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return refuse(scene, `rig name "${name}" must be letters, digits and _`);
  if (scene.sprites[name] || scene.shapes[name]) return refuse(scene, `"${name}" is already a shape or sprite`);
  const out = clone(scene);
  const slots = opts.facing === "back" ? CAT_BACK_SLOTS : CAT_SLOTS;
  for (const s of slots) {
    const id = `${name}_${s.name}`;
    if (out.shapes[id] || out.sprites[id]) return refuse(scene, `placeholder id "${id}" is taken`);
    if (opts.parts === "game") {
      out.sprites[id] = { frames: 1, labels: {}, layers: [] };
      continue;
    }
    const ph = PLACEHOLDER[s.name]!;
    const shape: SceneShape = { paths: [{ d: ph.d, fill: (opts.colours && opts.colours[s.name]) || `gray:${ph.gray}`, fillRule: "nonzero" }] };
    out.shapes[id] = shape;
  }
  const sprite: SceneSprite = {
    frames: Math.max(1, opts.frames ?? 24),
    labels: { idle: 0 },
    rig: "cat",
    ...(opts.parts === "game" ? { parts: "game" as const } : {}),
    ...(opts.facing === "back" ? { facing: "back" as const } : {}),
    layers: slots.map((s) => ({ name: s.name, depth: s.depth, keys: [{ frame: 0, ref: `${name}_${s.name}`, x: 0, y: 0 }] })),
  };
  out.sprites[name] = sprite;
  return { scene: out, findings: [] };
}

/** Point every placing key of a rig slot at `ref` (a shape or another sprite). */
export function assignSlot(scene: Scene, spriteId: string, slot: string, ref: string): { scene: Scene; findings: Finding[] } {
  const sp = scene.sprites[spriteId];
  if (!sp) return refuse(scene, `no sprite "${spriteId}"`);
  const names = catSlotsFor(sp).map((s) => s.name);
  if (!names.includes(slot)) return refuse(scene, `"${slot}" is not a slot of the ${sp.facing === "back" ? "back-facing" : "front"} cat rig "${spriteId}" (${names.join(", ")})`);
  if (!(scene.shapes[ref] || (scene.sprites[ref] && ref !== spriteId))) return refuse(scene, `"${ref}" is not a shape or another sprite`);
  const li = sp.layers.findIndex((l) => l.name === slot);
  if (li < 0) return refuse(scene, `sprite "${spriteId}" has no "${slot}" layer`);
  const out = clone(scene);
  for (const k of out.sprites[spriteId]!.layers[li]!.keys) if (k.ref !== null && k.ref !== undefined) k.ref = ref;
  return { scene: out, findings: [] };
}

// ---- cat animations: labeled facing frames appended to the game's CatTest clip ---------------------------------------
//
// OBSERVED 2026-10-21 (read-only parse of catanis.swf / catanis2.swf, pinned in test/fixtures/art/cat-anim-append.json;
// the driver decompiled in .analysis/notes-catA.md, docs/engine-map.md "CatTest and the cat animation clips"):
// the vanilla cat clip is `CatTest` (854 frames, 776 labels). Labels come in facing pairs `<anim>F` / `<anim>B`
// (`idleF`/`idleB`, `dashF`/`dashB`, …; `LF`/`RF`/`LB`/`RB` for `four_way_animations`); every labeled frame places at
// most one character, always at depth 1 — a nested pose sprite carrying the CAT_SLOTS instances (a B frame its own
// back-facing pose: CAT_BACK_SLOTS, head_back behind, tail in front; newCatAnimation adds <name>PoseBack for it). Character::PlayAnimation
// (0x9abda0 → 0x9ac790) looks up name + facing suffix on the ROOT clip's label map, GotoLabel on the root, then restarts
// the child instance named `ani` (GetClip2 0x9aabb0) — so the placed layer must be named `ani`; vanilla's `pawing` name
// on the early frames is an authoring leftover the engine never reads. `alt_animations [[from to]]` registers
// from+"F" → to+"F" and from+"B" → to+"B" (0x103da0), and a missing label is a silent no-op (no log), so the validator's
// facing check is the only guard. catanis2.swf extends the clip with an export `_Append_CatTest` of the same shape (296
// frames, 239 labels like `crawlingIdleF`). With EMPTY slot sprites a mod-appended frame works on a
// _CAT unit: a static pose (experiment A0, PR #74) and an animated one with keyed slots (the wave probe, 2026-10-22,
// mods/_artprobe render-cat-wave) both get the cat's own parts.

export const CAT_ANIM_EXPORT = "_Append_CatTest";
/** the child instance PlayAnimation restarts after GotoLabel on the root (the engine reads no other name) */
export const CAT_ANIM_LAYER = "ani";
/** the vanilla cat clip's SymbolClass name; a mod export of that name would shadow it for every cat (global registry) */
export const CAT_CLIP_NAME = "CatTest";
export const CAT_ANIM_DEPTH = 1;
export const CAT_ANIM_FACINGS: ReadonlyArray<string> = ["F", "B"];
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The four-way suffixes (`graphics { four_way_animations true }`): Character_SetOrientation 0x10ce50 appends L/R then
 * F/B and never mirrors the character, so `<anim>LF/RF/LB/RB` are four separate frames (vanilla: MegaFetus, Thump,
 * TracyX, ManglersMonster; T1-pinned in test/fixtures/art/cat-back-facing.json). No CatTest label is four-way.
 */
export const CAT_ANIM_FOUR_WAY: ReadonlyArray<string> = ["LF", "RF", "LB", "RB"];

export interface NewCatAnimationOptions {
  /** reuse this front rig (rig: "cat", not facing back) for the F frames instead of adding `<name>Pose`; its slots must be empty sprites */
  rig?: string;
  /** reuse this back rig (rig: "cat", facing: "back") for the B frames instead of adding `<name>PoseBack` */
  backRig?: string;
  /** frames of the new rigs */
  frames?: number;
  /** emit the four-way quartet `<name>LF/RF/LB/RB` (the L frames mirrored) instead of the `<name>F` / `<name>B` pair */
  fourWay?: boolean;
}

export interface NewCatAnimationResult {
  scene: Scene;
  findings: Finding[];
  /** the front rig the F frames place */
  rig?: string;
  /** the back rig the B frames place */
  backRig?: string;
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
 * Add a cat animation `name`: a front rig `<name>Pose` and a back rig `<name>PoseBack` (`facing: "back"`), both
 * `parts: "game"` (empty slot sprites the game fills with the cat's own parts) unless `opts.rig` / `opts.backRig`
 * name existing ones, and the labeled frames on the `_Append_CatTest` donor sprite (`CatAnim_<name>` when the scene
 * has none yet): `<name>F` placing the front rig and `<name>B` the back rig — or, with `fourWay`, `<name>LF` / `RF`
 * (front) and `LB` / `RB` (back), the L frames mirrored (sx −1) since a four-way character is never flipped by the
 * engine — each as the layer `ani` at depth 1, the shape every vanilla CatTest frame has and the child
 * PlayAnimation restarts.
 */
export function newCatAnimation(scene: Scene, name: string, opts: NewCatAnimationOptions = {}): NewCatAnimationResult {
  const no = (message: string): NewCatAnimationResult => ({ scene, findings: [{ severity: "error", code: "cat-anim", message }] });
  if (!NAME_RE.test(name)) return no(`animation name "${name}" must be letters, digits and _ (not starting with a digit)`);
  const exportRef = (scene.exports || {})[CAT_ANIM_EXPORT];
  let donorId = catAnimDonor(scene);
  if (exportRef !== undefined && !donorId) return no(`exports.${CAT_ANIM_EXPORT} points at "${String(exportRef)}", which is not a donor sprite (a plain sprite whose labeled frames place a cat rig)`);
  const suffixes = opts.fourWay ? CAT_ANIM_FOUR_WAY : CAT_ANIM_FACINGS;
  const labels = suffixes.map((f) => `${name}${f}`);
  if (donorId) {
    const have = Object.keys(scene.sprites[donorId]!.labels || {});
    const taken = labels.filter((l) => have.includes(l));
    if (taken.length) return no(`"${donorId}" already has the label${taken.length > 1 ? "s" : ""} ${taken.join(", ")}`);
  } else {
    donorId = `CatAnim_${name}`;
    if (scene.sprites[donorId] || scene.shapes[donorId]) return no(`"${donorId}" is already a shape or sprite`);
  }
  /** an existing rig for one facing: a cat rig of that facing whose slots are empty */
  const reuse = (id: string, back: boolean): string | null => {
    const rig = scene.sprites[id];
    if (!rig || rig.rig !== "cat") return `"${id}" is not a cat rig sprite (rig: "cat")`;
    if ((rig.facing === "back") !== back) return `"${id}" is a ${rig.facing === "back" ? "back-facing" : "front"} rig; the ${back ? "B frames place a back rig (facing: \"back\")" : "F frames place a front rig"}`;
    const held = nonEmptySlots(scene, id);
    if (held.length) return `rig "${id}" slot${held.length > 1 ? "s" : ""} ${held.join(", ")} hold art; a cat animation's slots must be empty sprites the game fills with the cat's own parts (add the rig with parts: "game")`;
    return null;
  };
  for (const [id, back] of [[opts.rig, false], [opts.backRig, true]] as const) {
    if (id === undefined) continue;
    const why = reuse(id, back);
    if (why) return no(why);
  }
  let out = clone(scene);
  const add = (id: string, back: boolean): Finding[] => {
    const r = addCatRig(out, id, { frames: opts.frames, parts: "game", ...(back ? { facing: "back" as const } : {}) });
    if (!r.findings.length) out = r.scene;
    return r.findings;
  };
  const rigId = opts.rig ?? `${name}Pose`;
  const backId = opts.backRig ?? `${name}PoseBack`;
  if (opts.rig === undefined) { const f = add(rigId, false); if (f.length) return { scene, findings: f }; }
  if (opts.backRig === undefined) { const f = add(backId, true); if (f.length) return { scene, findings: f }; }
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
    const suffix = suffixes[i]!;
    donor.labels![label] = frame;
    layer.keys = layer.keys.filter((k) => k.frame !== frame);
    layer.keys.push({ frame, ref: suffix.endsWith("B") ? backId : rigId, x: 0, y: 0, ...(opts.fourWay && suffix.startsWith("L") ? { sx: -1 } : {}) });
  });
  layer.keys.sort((a, b) => a.frame - b.frame);
  donor.frames = first + labels.length;
  out.exports = { ...(out.exports || {}), [CAT_ANIM_EXPORT]: donorId };
  return { scene: out, findings: [], rig: rigId, backRig: backId, donor: donorId };
}

/** What a layer places at `frame` (the latest key at or before it; null when nothing is there). */
function placedAt(layer: SceneLayer, frame: number): string | null {
  let ref: string | null = null;
  let best = -1;
  for (const k of layer.keys || []) if (k.frame <= frame && k.frame > best) { best = k.frame; ref = k.ref ?? null; }
  return ref;
}

/**
 * The four-way groups among a donor's labels: a base with at least one `<base>L?` and one `<base>R?` label (F or B).
 * A two-way animation whose name ends in L or R (`fooL` → `fooLF` / `fooLB`) has no R side and is not one.
 */
export function fourWayGroups(labels: Record<string, number>): Map<string, string[]> {
  const sides = new Map<string, Set<string>>();
  for (const label of Object.keys(labels)) {
    const m = /^(.+)([LR][FB])$/.exec(label);
    if (!m) continue;
    if (!sides.has(m[1]!)) sides.set(m[1]!, new Set());
    sides.get(m[1]!)!.add(m[2]!);
  }
  const out = new Map<string, string[]>();
  for (const [base, s] of sides) if ([...s].some((x) => x[0] === "L") && [...s].some((x) => x[0] === "R")) out.set(base, CAT_ANIM_FOUR_WAY.filter((x) => s.has(x)));
  return out;
}

/**
 * Checks for the `_Append_CatTest` donor (the validator adds them): facing pairs complete (a missing label is a silent
 * no-op in the engine), four-way quartets complete, each labeled frame places a cat rig as the child `ani` at depth 1,
 * a B frame a back-facing rig and an F frame a front one, the rig's slots are empty sprites (CatParts fills them; a
 * visible non-empty slot crashes); plus the notes on what the game draws and on four-way characters.
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
  const quads = fourWayGroups(labels);
  const inQuad = (label: string) => { const m = /^(.+)[LR][FB]$/.exec(label); return !!m && quads.has(m[1]!); };
  for (const [base, have] of quads) {
    for (const s of CAT_ANIM_FOUR_WAY.filter((x) => !have.includes(x))) out.push({ severity: "error", code: "cat-anim-four-way-incomplete", message: `four-way animation "${base}" has ${have.map((x) => base + x).join(", ")} but no "${base}${s}" (a four_way_animations character plays <anim>LF / RF / LB / RB by its facing, and a missing label is a silent no-op)`, path: `${sat}.labels` });
  }
  for (const label of names) {
    if (inQuad(label)) continue;
    const facing = CAT_ANIM_FACINGS.find((f) => label.endsWith(f) && label.length > f.length);
    if (!facing) continue;
    const base = label.slice(0, -facing.length);
    const missing = CAT_ANIM_FACINGS.filter((f) => f !== facing).map((f) => `${base}${f}`).filter((l) => !(l in labels));
    for (const m of missing) out.push({ severity: "error", code: "cat-anim-missing-facing", message: `label "${label}" has no facing partner "${m}" (the engine looks up <anim>F / <anim>B by facing and a missing label is a silent no-op)`, path: `${sat}.labels.${label}` });
  }
  const rigsChecked = new Set<string>();
  for (const label of names) {
    const frame = labels[label]!;
    if (!Number.isInteger(frame)) continue;
    const placing = sp.layers.map((l, li) => ({ l, li, ref: placedAt(l, frame) })).filter((p) => p.ref !== null);
    if (!placing.length) {
      out.push({ severity: "error", code: "cat-anim-layer-not-rig", message: `labeled frame "${label}" (frame ${frame}) places nothing; a cat animation frame places a rig: "cat" sprite at depth ${CAT_ANIM_DEPTH}`, path: `${sat}.labels.${label}` });
      continue;
    }
    const facing = label.endsWith("B") ? "B" : label.endsWith("F") ? "F" : null;
    for (const p of placing) {
      const target = scene.sprites[p.ref!];
      const lat = `${sat}.layers[${p.li}]`;
      if (!target || target.rig !== "cat") out.push({ severity: "error", code: "cat-anim-layer-not-rig", message: `labeled frame "${label}" (frame ${frame}) places "${p.ref}" on layer ${p.l.name || p.li}, which is not a rig: "cat" sprite`, path: lat });
      else {
        if (!rigsChecked.has(p.ref!)) {
          rigsChecked.add(p.ref!);
          const held = nonEmptySlots(scene, p.ref!);
          if (held.length) out.push({ severity: "error", code: "cat-anim-slot-not-empty", message: `cat animation rig "${p.ref}" slot${held.length > 1 ? "s" : ""} ${held.join(", ")} hold art; the game draws the cat's own parts into EMPTY slot sprites, and a visible non-empty slot crashes CatParts::prerender (+0x741f5d) — point the slot at an empty sprite or add the rig with parts: "game"`, path: `sprites.${p.ref}` });
        }
        const back = target.facing === "back";
        if (facing === "B" && !back) out.push({ severity: "warning", code: "cat-anim-back-facing", message: `labeled frame "${label}" (frame ${frame}) faces away but places the front rig "${p.ref}": the game would draw the cat's face and the front stacking on its back; place a back rig (facing: "back" — ${CAT_BACK_HEAD} behind the body, the tail in front, as vanilla idleB; newCatAnimation adds <name>PoseBack)`, path: lat });
        if (facing === "F" && back) out.push({ severity: "warning", code: "cat-anim-back-facing", message: `labeled frame "${label}" (frame ${frame}) faces the camera but places the back rig "${p.ref}" (${CAT_BACK_HEAD}: the head drawn from behind); place a front rig there`, path: lat });
      }
      if (p.l.name !== CAT_ANIM_LAYER) out.push({ severity: "error", code: "cat-anim-layer-name", message: `labeled frame "${label}" places its pose on a layer named "${p.l.name || ""}"; the engine restarts the child instance named "${CAT_ANIM_LAYER}" on every play and reads no other name`, path: `${lat}.name` });
      if (p.l.depth !== CAT_ANIM_DEPTH) out.push({ severity: "warning", code: "cat-anim-depth", message: `labeled frame "${label}" places its pose at depth ${p.l.depth}; every vanilla CatTest frame places it at depth ${CAT_ANIM_DEPTH}`, path: `${lat}.depth` });
    }
  }
  if (quads.size) out.push({ severity: "info", code: "cat-anim-four-way", message: `four-way animation${quads.size > 1 ? "s" : ""} ${[...quads.keys()].join(", ")}: the engine plays <anim>LF / RF / LB / RB only on a character with graphics { four_way_animations true } (Character_SetOrientation 0x10ce50; it never mirrors such a character, so the L frames are drawn mirrored here). Vanilla CatTest has no four-way label, so on a four-way cat every other animation (idle, walk, hit, …) is a silent no-op unless the mod authors its quartet too. Not yet observed on a cat in the game`, path: `${sat}.labels` });
  out.push({ severity: "info", code: "cat-anim-untested", message: `${CAT_ANIM_EXPORT} frames are in the engine's shape (labeled F/B frames on the root, the pose as the child "${CAT_ANIM_LAYER}" at depth ${CAT_ANIM_DEPTH}, empty slot sprites): the game draws the cat's own parts — palette, texture, face — into the empty slots; on a static pose (OBSERVED in PR #74, run 20261022-063637) and on an animated pose whose slots are keyed (OBSERVED 2026-10-22, mods/_artprobe render-cat-wave run 20261022-101117: the arm and head move with the cat's own parts) and on the back rig (OBSERVED 2026-10-22, render-cat-back run 20261022-114912: head_back filled with the cat's head seen from behind, the tail in front); placeholder art is preview-only (docs/engine-map.md "CatTest and the cat animation clips")`, path: at });
  return out;
}

/** Rig checks for a sprite marked rig: "cat" (the validator adds them); with `scene`, a parts: "game" rig's slots must be empty. */
export function rigFindings(sp: SceneSprite, at: string, scene?: Scene): Finding[] {
  const out: Finding[] = [];
  const slots = catSlotsFor(sp).map((s) => s.name);
  if (sp.parts === "game" && scene) {
    for (const l of sp.layers || []) {
      if (!ANY_SLOT_NAMES.includes(l.name || "")) continue;
      const held = (l.keys || []).filter((k) => k.ref !== null && k.ref !== undefined && !isEmptySprite(scene, k.ref)).map((k) => String(k.ref));
      if (held.length) out.push({ severity: "error", code: "rig-slot-not-empty", message: `parts: "game" rig slot "${l.name}" places ${[...new Set(held)].join(", ")}; the game fills a slot with the cat's own part only when the slot sprite is empty (a visible non-empty slot crashes +0x741f5d)`, path: at });
    }
  }
  const names = (sp.layers || []).map((l) => l.name || "");
  if (sp.facing === "back" && names.includes("head")) out.push({ severity: "warning", code: "rig-back-head", message: `back-facing cat rig has a "head" slot: the game draws the cat's face there; a back pose names it "${CAT_BACK_HEAD}" (the head with the catgen.gon face "back", drawn from behind — vanilla idleB)`, path: at });
  for (const s of slots) {
    const n = names.filter((x) => x === s).length;
    if (!n) out.push({ severity: "warning", code: "rig-slot-missing", message: `${sp.facing === "back" ? "back-facing " : ""}cat rig has no "${s}" layer`, path: at });
    if (n > 1) out.push({ severity: "error", code: "rig-slot-dup", message: `cat rig has ${n} "${s}" layers (instance names must be unique)`, path: at });
  }
  const present = (sp.layers || []).filter((l) => slots.includes(l.name || "")).sort((a, b) => a.depth - b.depth).map((l) => l.name!);
  const expected = slots.filter((s) => present.includes(s));
  if (present.join(",") !== [...new Set(present)].join(",") || [...new Set(present)].join(",") !== expected.join(",")) {
    out.push({ severity: "info", code: "rig-depth-order", message: `slot stacking ${[...new Set(present)].join(" < ")} differs from the vanilla ${sp.facing === "back" ? "back-facing " : ""}${expected.join(" < ")}`, path: at });
  }
  return out;
}

// ---- swap rigs (framework API v7, native/framework/src/fw_catrig_rules.h) --------------------------------------------

/** the export-name prefix that declares a swap rig for one character entry: `_CatRig_<Entry>` (FW_CATRIG_EXPORT_PREFIX) */
export const CAT_RIG_EXPORT_PREFIX = "_CatRig_";
/** the longest entry name the framework's registry takes (FW_CATRIG_NAME_MAX) */
export const CAT_RIG_NAME_MAX = 63;
/** the labels a swap rig needs so the cat is not frozen: the idle the state machine plays first, both facings */
export const CAT_RIG_IDLE_LABELS: ReadonlyArray<string> = ["idleF", "idleB"];

/** The entry a `_CatRig_<Entry>` export names ("" when nothing follows the prefix), or null for any other export. */
export function catRigEntry(linkage: string): string | null {
  return linkage.startsWith(CAT_RIG_EXPORT_PREFIX) ? linkage.slice(CAT_RIG_EXPORT_PREFIX.length) : null;
}

/**
 * Swap-rig checks for every `_CatRig_<Entry>` export: the entry name (cat-rig-export-name), a labeled frame that
 * places a rig: "cat" sprite carrying all seven slots (cat-rig-slot-missing: CatParts fills slots by instance name and
 * the rig replaces the whole CatTest clip, so a missing slot is a missing body part), and the idle labels
 * (cat-rig-idle-missing: the state machine starts in idle; a missing label is a silent no-op that freezes the cat).
 * The frames themselves (ani at depth 1, empty slots) get the same checks as `_Append_CatTest` donors via rigFindings.
 */
export function catRigFindings(scene: Scene): Finding[] {
  const out: Finding[] = [];
  for (const [linkage, id] of Object.entries(scene.exports || {})) {
    const entry = catRigEntry(linkage);
    if (entry === null) continue;
    const at = `exports.${linkage}`;
    const bytes = new TextEncoder().encode(entry).length;
    if (!bytes || bytes > CAT_RIG_NAME_MAX) out.push({ severity: "error", code: "cat-rig-export-name", message: bytes ? `${linkage}: the entry name is ${bytes} bytes; the framework's rig registry takes at most ${CAT_RIG_NAME_MAX}` : `${linkage} names no character entry: write ${CAT_RIG_EXPORT_PREFIX}<CharacterEntry>`, path: at });
    const sp = typeof id === "string" ? scene.sprites[id] : undefined;
    if (!sp || !Array.isArray(sp.layers)) continue;   // export-ref already reports a bad target
    const labels = sp.labels || {};
    const missingIdle = CAT_RIG_IDLE_LABELS.filter((l) => !(l in labels));
    if (missingIdle.length) out.push({ severity: "warning", code: "cat-rig-idle-missing", message: `${linkage} root "${id}" has no ${missingIdle.join(" / ")} label${missingIdle.length > 1 ? "s" : ""}; the cat starts in idle (idleF / idleB) and a missing label is a silent no-op, so it stays frozen on frame 0`, path: `sprites.${id}.labels` });
    let best: { rig: string; missing: string[] } | null = null;
    for (const frame of Object.values(labels)) {
      if (!Number.isInteger(frame)) continue;
      for (const l of sp.layers) {
        const ref = placedAt(l, frame);
        const target = ref ? scene.sprites[ref] : undefined;
        if (!target || target.rig !== "cat") continue;
        const names = new Set((target.layers || []).map((x) => x.name || ""));
        const missing = CAT_SLOT_NAMES.filter((s) => !names.has(s));
        if (!best || missing.length < best.missing.length) best = { rig: ref!, missing };
      }
    }
    if (!best) out.push({ severity: "error", code: "cat-rig-slot-missing", message: `${linkage} root "${id}" places no rig: "cat" sprite on any labeled frame; a swap rig replaces the whole CatTest clip, and CatParts draws the cat's parts only into the named slots (${CAT_SLOT_NAMES.join(" ")}) of a pose placed as "${CAT_ANIM_LAYER}"`, path: `sprites.${id}` });
    else if (best.missing.length) out.push({ severity: "error", code: "cat-rig-slot-missing", message: `${linkage}: the rig "${best.rig}" has no ${best.missing.join(", ")} slot; CatParts fills slots by instance name, so the cat would be drawn without that part`, path: `sprites.${best.rig}` });
  }
  return out;
}
