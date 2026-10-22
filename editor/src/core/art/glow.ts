// Baked glows and drop shadows. The game's SWF player refuses every PlaceObject3 filter list (OBSERVED 2026-10-21,
// `glaiel::swf::PlaceObject::decode3` 0xb78210 stops with "ERROR: FILTERS NOT SUPPORTED <swf>" on the flag bit
// alone; docs/engine-map.md "Glow and outline passes"), so a glow is baked into the art as an ordinary halo shape
// placed under the source. Pure: no node, no DOM; the scene is copied, never mutated.
//
// Algorithm. Every filled sub-path of the source is flattened to a polygon oriented with its fill on the right
// (assignFillSides decides which rings are outer boundaries and which are holes), then pushed away from the fill by
// a distance d along the vertex bisectors (miter clamped at 2·d). The halo is N concentric bands: band k covers the
// dilation by blur·k/N minus the dilation by blur·(k-1)/N (an annulus: the outer offset rings as they are, the inner
// ones reversed, nonzero fill), so the bands never overlap and the falloff does not depend on how the player blends
// overlapping fills inside one shape. Band k's alpha is colour.a · min(1, strength · (N-k+1)/N); the innermost band
// is a full disc (it also sits under the source, which hides it). A drop shadow is the same halo shifted by dx, dy
// in the shape's local px (it rotates and scales with the placement, unlike a screen-space filter).
//
// Limitations (documented, tested where it matters): the offset is a per-vertex miter, not a true Minkowski sum —
// features narrower than 2·blur over-inflate and concave corners sharper than the clamp notch slightly; a blur above
// half the shape's smallest feature can fold a ring onto itself (harmless under nonzero, but no longer a clean
// outline). Stroke-only paths and bitmap/gradient fills contribute their outline (fill kind is ignored; `none` is
// skipped). Inner glows are not bakeable (nothing to draw under the source).

import { normalizePath, flattenSubpath } from "./geometry.ts";
import { assignFillSides } from "./shape.ts";
import { parseFill, fillToRgba } from "./scene.ts";
import type { Scene, SceneShape, ScenePath, SceneKey, SceneLayer, SceneSprite, Finding, BakedGlowMeta } from "./scene.ts";

export interface BakeGlowOptions {
  /** gray:N or #rrggbb[aa] (any parseFill colour); the alpha is the halo's ceiling */
  color: string;
  /** how far the halo reaches, px in the shape's local space (0.5..255) */
  blur: number;
  /** alpha multiplier of the falloff (default 1; >1 saturates the inner bands like Flash's glow strength) */
  strength?: number;
  /** glow (centred) or dropShadow (offset by dx, dy) */
  kind?: "glow" | "dropShadow";
  /** dropShadow offset, local px (default 4, 4 for a drop shadow, 0 for a glow) */
  dx?: number;
  dy?: number;
  /** concentric bands (default 4, 1..8) */
  steps?: number;
  /** overwrite an existing <id>_glow shape (its layers are kept) */
  replace?: boolean;
  /** inner glows cannot be baked; true is refused */
  inner?: boolean;
}

export interface BakeGlowResult {
  ok: boolean;
  /** a deep copy of the input with the halo (the input on refusal) */
  scene: Scene;
  findings: Finding[];
  glowId?: string;
  /** the halo layers added, one per sprite layer that places the source */
  layersAdded: Array<{ sprite: string; depth: number }>;
}

export const MAX_STEPS = 8;
const MITER_CLAMP = 2;
const FLATTEN_TOLERANCE = 0.25;

/** The id of the halo shape baked for `shapeId`. */
export function glowIdFor(shapeId: string): string {
  return `${shapeId}_glow`;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const fmt = (v: number): string => {
  const r = Math.round(v * 100) / 100;
  return (Object.is(r, -0) ? 0 : r).toString();
};
const hex2 = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");

/** Drop repeated points and the closing duplicate; null when fewer than 3 distinct points remain. */
function cleanRing(flat: number[]): number[] | null {
  const pts: number[] = [];
  for (let i = 0; i < flat.length; i += 2) {
    const x = flat[i]!, y = flat[i + 1]!;
    if (pts.length && Math.abs(pts[pts.length - 2]! - x) < 1e-9 && Math.abs(pts[pts.length - 1]! - y) < 1e-9) continue;
    pts.push(x, y);
  }
  while (pts.length >= 4 && Math.abs(pts[0]! - pts[pts.length - 2]!) < 1e-9 && Math.abs(pts[1]! - pts[pts.length - 1]!) < 1e-9) pts.length -= 2;
  return pts.length >= 6 ? pts : null;
}

function reversed(ring: number[]): number[] {
  const n = ring.length / 2;
  const out: number[] = new Array(ring.length);
  for (let i = 0; i < n; i++) {
    out[2 * i] = ring[2 * (n - 1 - i)]!;
    out[2 * i + 1] = ring[2 * (n - 1 - i) + 1]!;
  }
  return out;
}

/**
 * Push a closed ring (fill on the RIGHT of travel) away from its fill by `d`: each vertex moves along the bisector
 * of its two edges' left normals, by d / cos(half-angle) clamped to MITER_CLAMP·d. d = 0 returns the ring itself.
 */
export function offsetRing(ring: number[], d: number): number[] {
  if (d === 0) return ring.slice();
  const n = ring.length / 2;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const px = ring[2 * ((i + n - 1) % n)]!, py = ring[2 * ((i + n - 1) % n) + 1]!;
    const x = ring[2 * i]!, y = ring[2 * i + 1]!;
    const nx = ring[2 * ((i + 1) % n)]!, ny = ring[2 * ((i + 1) % n) + 1]!;
    let u1x = x - px, u1y = y - py;
    let u2x = nx - x, u2y = ny - y;
    const l1 = Math.hypot(u1x, u1y) || 1, l2 = Math.hypot(u2x, u2y) || 1;
    u1x /= l1; u1y /= l1; u2x /= l2; u2y /= l2;
    // left normal of travel (away from a fill on the right) in y-down space
    const n1x = u1y, n1y = -u1x, n2x = u2y, n2y = -u2x;
    const mx = n1x + n2x, my = n1y + n2y;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-9) {
      // a 180° turn: bevel with the two edge offsets
      out.push(x + n1x * d, y + n1y * d, x + n2x * d, y + n2y * d);
      continue;
    }
    const cosHalf = (n1x * mx + n1y * my) / ml;
    const len = Math.min(d / Math.max(cosHalf, 1e-6), MITER_CLAMP * d);
    out.push(x + (mx / ml) * len, y + (my / ml) * len);
  }
  return out;
}

/** The source's rings (flattened, fill on the right). Empty when nothing is filled. */
export function sourceRings(shape: SceneShape): number[][] {
  const rings: number[][] = [];
  for (const p of shape.paths || []) {
    const f = parseFill(p.fill);
    if (f.error || f.fill.kind === "none") continue;
    let subs;
    try { subs = normalizePath(p.d, { matrix: p.transform }); } catch { continue; }
    const sides = assignFillSides(subs, p.fillRule === "evenodd");
    subs.forEach((sub, i) => {
      if (sides[i] === "none") return;
      const flat = cleanRing(flattenSubpath(sub, FLATTEN_TOLERANCE));
      if (!flat) return;
      rings.push(sides[i] === "left" ? reversed(flat) : flat);
    });
  }
  return rings;
}

function ringToD(ring: number[], dx: number, dy: number): string {
  const parts: string[] = [];
  for (let i = 0; i < ring.length; i += 2) parts.push(`${i === 0 ? "M" : "L"}${fmt(ring[i]! + dx)} ${fmt(ring[i + 1]! + dy)}`);
  parts.push("Z");
  return parts.join(" ");
}

/** The halo's paths: outermost band first, innermost (strongest) last. */
export function haloPaths(rings: number[][], o: { blur: number; steps: number; rgb: string; alpha: number; strength: number; dx: number; dy: number }): ScenePath[] {
  const out: ScenePath[] = [];
  for (let k = o.steps; k >= 1; k--) {
    const dOut = (o.blur * k) / o.steps;
    const dIn = (o.blur * (k - 1)) / o.steps;
    const ds: string[] = rings.map((r) => ringToD(offsetRing(r, dOut), o.dx, o.dy));
    if (k > 1) for (const r of rings) ds.push(ringToD(reversed(offsetRing(r, dIn)), o.dx, o.dy));
    const a = Math.min(1, (o.strength * (o.steps - k + 1)) / o.steps) * o.alpha;
    out.push({ d: ds.join(" "), fill: `${o.rgb}${hex2(a * 255)}` });
  }
  return out;
}

const refuse = (scene: Scene, findings: Finding[]): BakeGlowResult => ({ ok: false, scene, findings, layersAdded: [] });

/**
 * Bake a glow (or drop shadow) of `shapeId` as the shape `<shapeId>_glow` and place it immediately under the
 * source on every sprite layer that places it (keys mirrored; other refs on that layer become `ref: null`). The
 * source shape is never touched. Refusals come back as error findings (glow-shape, glow-color, glow-blur,
 * glow-strength, glow-steps, glow-offset, glow-inner, glow-exists, glow-empty).
 */
export function bakeGlow(input: Scene, shapeId: string, options: BakeGlowOptions): BakeGlowResult {
  const findings: Finding[] = [];
  const err = (code: string, message: string) => findings.push({ severity: "error", code, message, path: `shapes.${shapeId}` });
  const o = options || ({} as BakeGlowOptions);
  const source = input && input.shapes ? input.shapes[shapeId] : undefined;
  if (!source || !Array.isArray(source.paths)) err("glow-shape", `no shape "${shapeId}" to bake a glow of`);
  const kind = o.kind === "dropShadow" ? "dropShadow" : o.kind === undefined || o.kind === "glow" ? "glow" : null;
  if (!kind) err("glow-kind", `kind must be glow or dropShadow (got ${JSON.stringify(o.kind)})`);
  const pf = parseFill(o.color);
  const rgba = pf.error ? null : fillToRgba(pf.fill);
  if (!rgba) err("glow-color", `color must be gray:N or #rrggbb[aa] (got ${JSON.stringify(o.color)})`);
  if (!num(o.blur) || o.blur < 0.5 || o.blur > 255) err("glow-blur", `blur must be a number in 0.5..255 px (got ${JSON.stringify(o.blur)})`);
  const strength = o.strength === undefined ? 1 : o.strength;
  if (!num(strength) || strength < 0) err("glow-strength", `strength must be a number >= 0 (got ${JSON.stringify(o.strength)})`);
  const steps = o.steps === undefined ? 4 : o.steps;
  if (!(Number.isInteger(steps) && steps >= 1 && steps <= MAX_STEPS)) err("glow-steps", `steps must be an integer 1..${MAX_STEPS} (got ${JSON.stringify(o.steps)})`);
  const dx = o.dx === undefined ? (kind === "dropShadow" ? 4 : 0) : o.dx;
  const dy = o.dy === undefined ? (kind === "dropShadow" ? 4 : 0) : o.dy;
  if (!num(dx) || !num(dy)) err("glow-offset", "dx and dy must be numbers (local px)");
  if (o.inner) err("glow-inner", "inner glows cannot be baked: a halo under the source would be hidden by it");
  const glowId = glowIdFor(shapeId);
  const taken = !!(input.shapes && input.shapes[glowId]) || !!(input.sprites && input.sprites[glowId]) || !!(input.bitmaps && input.bitmaps[glowId]) || !!(input.gradients && input.gradients[glowId]) || !!(input.texts && input.texts[glowId]);
  if (taken && !(o.replace && input.shapes[glowId])) err("glow-exists", `"${glowId}" already exists (pass replace: true to re-bake it)`);
  if (findings.length) return refuse(input, findings);

  const rings = sourceRings(source!);
  if (!rings.length) {
    err("glow-empty", `shape "${shapeId}" has no filled outline to bake a glow of`);
    return refuse(input, findings);
  }
  const rgb = `#${hex2(rgba!.r)}${hex2(rgba!.g)}${hex2(rgba!.b)}`;
  const paths = haloPaths(rings, { blur: o.blur, steps, rgb, alpha: rgba!.a / 255, strength, dx, dy });
  const baked: BakedGlowMeta = { kind: kind!, of: shapeId, color: o.color, blur: o.blur, strength, steps };
  if (kind === "dropShadow") { baked.dx = dx; baked.dy = dy; }

  const scene: Scene = JSON.parse(JSON.stringify(input)) as Scene;
  const halo: SceneShape = { paths, baked };
  // keep the shape order: the halo right after its source
  const shapes: Record<string, SceneShape> = {};
  for (const [id, sh] of Object.entries(scene.shapes)) {
    if (id === glowId) continue;
    shapes[id] = sh;
    if (id === shapeId) shapes[glowId] = halo;
  }
  scene.shapes = shapes;

  const layersAdded: Array<{ sprite: string; depth: number }> = [];
  let placed = false;
  for (const [spriteId, sp] of Object.entries(scene.sprites || {})) {
    if (!sp || !Array.isArray(sp.layers)) continue;
    const places = (l: SceneLayer, id: string) => (l.keys || []).some((k) => k.ref === id);
    const targets = sp.layers.filter((l) => places(l, shapeId));
    if (!targets.length) continue;
    placed = true;
    if (sp.layers.some((l) => places(l, glowId))) continue; // re-bake: the halo layer is already there
    for (const layer of targets.slice().sort((a, b) => b.depth - a.depth)) layersAdded.push({ sprite: spriteId, depth: insertHaloLayer(sp, layer, shapeId, glowId) });
  }
  layersAdded.sort((a, b) => (a.sprite < b.sprite ? -1 : a.sprite > b.sprite ? 1 : a.depth - b.depth));
  if (!placed) findings.push({ severity: "info", code: "glow-unplaced", message: `no sprite places "${shapeId}": place "${glowId}" on a layer under it yourself`, path: `shapes.${glowId}` });
  return { ok: true, scene, findings, glowId, layersAdded };
}

/** Insert a layer placing `glowId` right under `layer` (depths at or above it shift up when the slot is taken). */
function insertHaloLayer(sp: SceneSprite, layer: SceneLayer, shapeId: string, glowId: string): number {
  const D = layer.depth;
  let depth: number;
  if (D - 1 >= 1 && !sp.layers.some((l) => l.depth === D - 1)) depth = D - 1;
  else {
    for (const l of sp.layers) {
      if (l.depth >= D) l.depth += 1;
      if (l.clip && (l.clipDepth ?? 0) >= D) l.clipDepth = (l.clipDepth ?? 0) + 1;
    }
    depth = D;
  }
  const keys: SceneKey[] = (layer.keys || []).map((k) => {
    if (k.ref !== shapeId) return { frame: k.frame, ref: null };
    const { filters: _drop, ...rest } = k;
    void _drop;
    return { ...rest, ref: glowId };
  });
  sp.layers.push({ depth, keys });
  return depth;
}

/** A drop shadow: bakeGlow with kind dropShadow (dx, dy default 4, 4; use a dark, translucent colour). */
export function bakeDropShadow(scene: Scene, shapeId: string, options: Omit<BakeGlowOptions, "kind">): BakeGlowResult {
  return bakeGlow(scene, shapeId, { ...options, kind: "dropShadow" });
}
