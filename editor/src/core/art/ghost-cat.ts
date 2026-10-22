// Ghost cat: preview-only placeholder silhouettes for the EMPTY slots of a `parts: "game"` cat rig. Pure (browser-safe).
//
// In-game, CatParts fills every named slot of such a rig with the cat's own part (cat-rig.ts; docs/engine-map.md "How a
// cat clip's slots are filled"), so the scene itself has nothing to draw there and the editor's preview shows an empty
// stage. The ghost is a translucent outline of the part the game will draw — tail → CatTail, arms and legs → CatLeg
// (CatParts' holders +0x8f8..+0x940, .analysis/notes-catB.md), body → CatBody, head → CatHead — placed with the slot's
// own baked matrix, so keyframed motion reads. Outlines come from catparts.swf when the extracted game files are present
// (ghost-cat-swf.ts, served by /api/art/ghost-parts) and from the built-in shapes below otherwise.
//
// Nothing here touches the scene: the emitter, the validator and build_swf never see a ghost (pinned by
// test/art-ghostcat-tests.ts against the _artprobe / dev-sandbox builds).

import { normalizePath, flattenSubpath, boundsOf, unionBounds, multiply, apply, IDENTITY } from "./geometry.ts";
import type { Mat, Bounds } from "./geometry.ts";
import { bakeSprite, bakeStage } from "./timeline.ts";
import type { BakedSprite } from "./timeline.ts";
import { nestedFrame } from "./engine-behaviour.ts";
import { CAT_SLOT_NAMES, isEmptySprite } from "./cat-rig.ts";
import type { Scene, SceneSprite } from "./scene.ts";

export type GhostPartName = "CatBody" | "CatHead" | "CatLeg" | "CatTail";
export const GHOST_PART_NAMES: ReadonlyArray<GhostPartName> = ["CatBody", "CatHead", "CatLeg", "CatTail"];

/** The catparts.swf part CatParts draws into each slot (OBSERVED, CatParts::prerender's slot visitor 0x742bd0). */
export const GHOST_SLOT_PART: Readonly<Record<string, GhostPartName>> = {
  tail: "CatTail",
  leg2: "CatLeg",
  arm2: "CatLeg",
  body: "CatBody",
  leg1: "CatLeg",
  arm1: "CatLeg",
  head: "CatHead",
};

export interface GhostOutline {
  /** SVG path data in the slot's local px (y down), as the part sits under the slot's matrix */
  d: string;
  bounds: Bounds;
  fillRule?: "nonzero" | "evenodd";
}

export interface GhostParts {
  source: "catparts.swf" | "builtin";
  parts: Record<GhostPartName, GhostOutline>;
  /** why the built-ins are used (no extracted catparts.swf, or it could not be read) */
  note?: string;
}

export interface GhostSlot {
  /** the parts: "game" rig sprite the slot belongs to */
  rig: string;
  slot: string;
  depth: number;
  part: GhostPartName;
  d: string;
  fillRule: "nonzero" | "evenodd";
  /** the part outline's own bounds (slot-local px) */
  bounds: Bounds;
  /** slot-local px → target px: the slot's baked matrix under every enclosing placement */
  matrix: Mat;
  /** the placement alpha (cxform mul[3]) under every enclosing placement */
  alpha: number;
  source: GhostParts["source"];
  /** the slot name, drawn as the ghost's label */
  label: string;
  /** where the label goes: the outline's centre in target px */
  at: [number, number];
}

const ellipse = (cx: number, cy: number, rx: number, ry: number): string =>
  `M${cx - rx} ${cy} A${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;

/** Bounds of a path's flattened outline (px). */
export function outlineBounds(d: string): Bounds {
  let b: Bounds | null = null;
  for (const sub of normalizePath(d)) b = unionBounds(b, boundsOf(flattenSubpath(sub, 0.25)));
  return b || { xmin: 0, ymin: 0, xmax: 0, ymax: 0 };
}

const outline = (d: string): GhostOutline => ({ d, bounds: outlineBounds(d), fillRule: "nonzero" });

/**
 * The fallback silhouettes: our own simple shapes (no game art), sized and placed like frame 1 of the vanilla parts
 * relative to their origin (measured 2026-10-22 from catparts.swf's mask shapes, px: CatBody −55..41 × −27..38,
 * CatHead −43..43 × −40..40, CatLeg −3..7 × −3..30, CatTail −24..8 × −62..10; the T1 test keeps them close).
 */
export const BUILTIN_GHOST_PARTS: GhostParts = {
  source: "builtin",
  parts: {
    CatBody: outline(ellipse(-7, 5.5, 48, 32.5)),
    CatHead: outline(`${ellipse(0, 4, 42, 35)} M-36 -14 L-30 -40 L-12 -30 Z M36 -14 L30 -40 L12 -30 Z`),
    CatLeg: outline("M-3 2 A5 5 0 0 1 7 2 L7 25 A5 5 0 0 1 -3 25 Z"),
    CatTail: outline("M8 8 C2 -14 -16 -24 -20 -56 L-14 -62 C-6 -34 4 -26 8 -6 Z"),
  },
};

/** A sprite the ghost cat applies to: a cat rig whose slots the game fills (`parts: "game"`). */
export function isGhostRig(sp: SceneSprite | undefined | null): boolean {
  return !!sp && sp.rig === "cat" && sp.parts === "game" && Array.isArray(sp.layers);
}

const MAX_NEST = 32;

function slotGhosts(scene: Scene, rigId: string, baked: BakedSprite, frame: number, parent: Mat, parentAlpha: number, parts: GhostParts, out: GhostSlot[]): void {
  const f = Math.min(baked.frames - 1, Math.max(0, frame | 0));
  for (const p of baked.placements[f] || []) {
    const slot = p.name || "";
    if (!CAT_SLOT_NAMES.includes(slot) || !isEmptySprite(scene, p.ref)) continue;
    const part = GHOST_SLOT_PART[slot]!;
    const o = parts.parts[part] || BUILTIN_GHOST_PARTS.parts[part];
    const matrix = multiply(parent, p.matrix);
    const alpha = parentAlpha * (p.cxform ? p.cxform.mul[3] : 1);
    const b = o.bounds;
    out.push({ rig: rigId, slot, depth: p.depth, part, d: o.d, fillRule: o.fillRule || "nonzero", bounds: b, matrix, alpha, source: parts.source, label: slot, at: apply(matrix, (b.xmin + b.xmax) / 2, (b.ymin + b.ymax) / 2) });
  }
}

/** The ghosts of rig `rigId` on its own frame `frame` (rig-local px); [] unless it is a parts: "game" cat rig. */
export function ghostCatFor(scene: Scene, rigId: string, frame = 0, parts: GhostParts = BUILTIN_GHOST_PARTS): GhostSlot[] {
  const sp = scene.sprites[rigId];
  if (!isGhostRig(sp)) return [];
  const out: GhostSlot[] = [];
  slotGhosts(scene, rigId, bakeSprite(sp!), frame, IDENTITY, 1, parts, out);
  return out;
}

/**
 * The ghosts a preview of `targetId` ("stage", a sprite or a shape) shows on its frame `frame`: the target's own when it
 * is a parts: "game" rig, else every such rig it places, nested, on the preview's clock (a nested sprite runs on its
 * own clock — engine-behaviour.ts `nestedFrame`, exactly as the preview draws it).
 */
export function ghostCatsIn(scene: Scene, targetId: string, frame = 0, clock: number = frame, parts: GhostParts = BUILTIN_GHOST_PARTS): GhostSlot[] {
  const out: GhostSlot[] = [];
  const visit = (id: string, f: number, mat: Mat, alpha: number, left: number): void => {
    const sp = scene.sprites[id];
    if (isGhostRig(sp)) return slotGhosts(scene, id, bakeSprite(sp!), f, mat, alpha, parts, out);
    if (left <= 0) return;
    const baked = id === "stage" && !sp ? bakeStage(scene) : sp ? bakeSprite(sp) : null;
    if (!baked) return;
    const pf = Math.min(baked.frames - 1, Math.max(0, f | 0));
    for (const p of baked.placements[pf] || []) {
      const child = scene.sprites[p.ref];
      if (!child) continue;
      const cf = nestedFrame(clock, Math.max(1, child.frames | 0));
      visit(p.ref, cf, multiply(mat, p.matrix), alpha * (p.cxform ? p.cxform.mul[3] : 1), left - 1);
    }
  };
  visit(targetId, frame, IDENTITY, 1, MAX_NEST);
  return out;
}

/** Does `targetId` (or anything it places, on any frame) contain a parts: "game" cat rig? Drives the toggle's visibility. */
export function hasGhostRig(scene: Scene, targetId: string): boolean {
  const seen = new Set<string>();
  const has = (id: string): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const sp = scene.sprites[id];
    if (isGhostRig(sp)) return true;
    const refs = sp ? sp.layers.flatMap((l) => (l.keys || []).map((k) => k.ref)) : id === "stage" ? (scene.stage_instances || []).map((si) => si.ref) : [];
    return refs.some((r) => typeof r === "string" && !!scene.sprites[r] && has(r));
  };
  return has(targetId);
}

/** Union of the ghosts' outlines in target px (for the preview's fit), or null when there are none. */
export function ghostBounds(ghosts: GhostSlot[]): Bounds | null {
  let out: Bounds | null = null;
  for (const g of ghosts) {
    const b = g.bounds;
    const pts = [apply(g.matrix, b.xmin, b.ymin), apply(g.matrix, b.xmax, b.ymin), apply(g.matrix, b.xmin, b.ymax), apply(g.matrix, b.xmax, b.ymax)];
    for (const [x, y] of pts) out = unionBounds(out, { xmin: x, ymin: y, xmax: x, ymax: y });
  }
  return out;
}
