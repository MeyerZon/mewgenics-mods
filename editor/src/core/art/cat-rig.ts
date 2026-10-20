// Cat rig: a cat-shaped character drawn by our own SWF with the slot layout of the game's cat animations — one named
// instance per body part (tail, leg2, arm2, body, leg1, arm1, head) at the depths the main cat animation in
// catanis.swf uses (pinned in test/fixtures/art/cat-rig-slots.json against the installed game). Pure.
//
// Scope: this authors *our* character in the vanilla layout (each slot is any shape or sprite of the scene). It does
// not add parts to the game's catparts.swf or make the game swap its own parts into our slots — that is engine work.

import type { Scene, SceneSprite, SceneShape, Finding } from "./scene.ts";

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
