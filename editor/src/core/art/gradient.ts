// Gradient fills: the one place the gradient geometry is interpreted. The emitter (shape.ts) turns it into a SWF
// gradient fill style; the preview (web/src/art/preview-gl.ts) samples the same stops with the same t-function.
//
// Model (scene.gradients[id], referenced by a path fill "gradient:<id>"):
//   linear: x1,y1 → x2,y2 in the path's local px (before path.transform, like the path's d)
//   radial: centre cx,cy, radius r, optional focus fx,fy (SVG semantics)
//   transform: optional 6-number matrix applied after the geometry (SVG gradientTransform / objectBoundingBox)
//   stops: 2..8 { offset 0..1 ascending, color gray:N | #rrggbb[aa] }   (DefineShape3 allows 8)
//   spread: pad (default) | reflect | repeat
//
// SWF: a gradient is defined on the square -16384..16384 twips; linear runs along x across it, radial is the
// circle of radius 16384. The fill matrix maps that square into shape space. "unit space" below is that square
// divided by 16384 (x in -1..1).

import { IDENTITY, multiply } from "./geometry.ts";
import type { Mat } from "./geometry.ts";
import { parseFill, fillToRgba } from "./scene.ts";
import type { SceneGradient, GradientStopDef, Scene, SceneShape } from "./scene.ts";

export const GRADIENT_SQUARE = 16384;
export const MAX_STOPS_SHAPE3 = 8;

export interface Rgba8 {
  r: number;
  g: number;
  b: number;
  a: number;
}
export interface ResolvedStop {
  /** 0..255 */
  ratio: number;
  color: Rgba8;
}
export type Spread = "pad" | "reflect" | "repeat";

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Unit space (gradient x in -1..1) → path-local px, including the gradient's own transform. */
export function gradientUnitMatrix(g: SceneGradient): Mat {
  let u: Mat;
  if (g.kind === "radial") {
    const r = g.r ?? 0;
    const cx = g.cx ?? 0;
    const cy = g.cy ?? 0;
    let ang = 0;
    if (num(g.fx) && num(g.fy) && (g.fx !== cx || g.fy !== cy)) ang = Math.atan2(g.fy - cy, g.fx - cx);
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    u = [r * c, r * s, -r * s, r * c, cx, cy];
  } else {
    const x1 = g.x1 ?? 0;
    const y1 = g.y1 ?? 0;
    const x2 = g.x2 ?? 0;
    const y2 = g.y2 ?? 0;
    const hx = (x2 - x1) / 2;
    const hy = (y2 - y1) / 2;
    u = [hx, hy, -hy, hx, x1 + hx, y1 + hy];
  }
  const t = g.transform && g.transform.length === 6 ? (g.transform as Mat) : null;
  return t ? multiply(t, u) : u;
}

/** The SWF focal ratio (-1..1) of a radial gradient: the focus's distance from the centre over r (0 when none). */
export function gradientFocal(g: SceneGradient): number {
  if (g.kind !== "radial" || !num(g.fx) || !num(g.fy) || !num(g.r) || !(g.r > 0)) return 0;
  const d = Math.hypot(g.fx - (g.cx ?? 0), g.fy - (g.cy ?? 0)) / g.r;
  return Math.max(-0.99, Math.min(0.99, d));
}

/**
 * The SWF fill-style matrix: gradient square (twips) → shape twips, with the translate in px (writeMatrix
 * multiplies it by 20), after the path's own transform. Same convention as the bitmap fill matrix in shape.ts.
 */
export function gradientMatrix(g: SceneGradient, pathTransform: Mat = IDENTITY): Mat {
  const p = multiply(pathTransform, gradientUnitMatrix(g));
  const k = 20 / GRADIENT_SQUARE;
  return [p[0] * k, p[1] * k, p[2] * k, p[3] * k, p[4], p[5]];
}

/** SWF SpreadMode bits. */
export function swfSpread(s: string | undefined): 0 | 1 | 2 {
  return s === "reflect" ? 1 : s === "repeat" ? 2 : 0;
}

/** Stops as SWF ratios (0..255) and colours. Unreadable colours resolve to opaque black (validation reports them). */
export function resolveStops(stops: GradientStopDef[]): ResolvedStop[] {
  return (stops || []).map((s) => {
    const off = num(s.offset) ? Math.max(0, Math.min(1, s.offset)) : 0;
    const c = fillToRgba(parseFill(s.color).fill) || { r: 0, g: 0, b: 0, a: 255 };
    return { ratio: Math.round(off * 255), color: { r: c.r, g: c.g, b: c.b, a: c.a } };
  });
}

/** A width×1 RGBA strip (straight alpha) of the stops: texel i is ratio i·255/(width-1); padded beyond the ends. */
export function rasterizeStops(stops: ResolvedStop[], width = 256): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * 4);
  if (!stops.length) return out;
  for (let i = 0; i < width; i++) {
    const ratio = width === 1 ? 0 : (i * 255) / (width - 1);
    let c: Rgba8;
    if (ratio <= stops[0]!.ratio) c = stops[0]!.color;
    else if (ratio >= stops[stops.length - 1]!.ratio) c = stops[stops.length - 1]!.color;
    else {
      let k = 0;
      while (k < stops.length - 2 && ratio > stops[k + 1]!.ratio) k++;
      const a = stops[k]!;
      const b = stops[k + 1]!;
      const f = b.ratio === a.ratio ? 1 : (ratio - a.ratio) / (b.ratio - a.ratio);
      c = { r: a.color.r + (b.color.r - a.color.r) * f, g: a.color.g + (b.color.g - a.color.g) * f, b: a.color.b + (b.color.b - a.color.b) * f, a: a.color.a + (b.color.a - a.color.a) * f };
    }
    out[i * 4] = Math.round(c.r);
    out[i * 4 + 1] = Math.round(c.g);
    out[i * 4 + 2] = Math.round(c.b);
    out[i * 4 + 3] = Math.round(c.a);
  }
  return out;
}

/**
 * The gradient parameter t at unit-space point (u, v) — the preview shader computes exactly this (GLSL copy in
 * preview-gl.ts). Linear: (u+1)/2. Radial with focus (focal, 0): the ratio of the distance from the focus to the
 * distance from the focus to the circle along the same ray (Flash's focal gradient; |uv| when focal is 0).
 */
export function gradientT(kind: "linear" | "radial", focal: number, u: number, v: number): number {
  if (kind === "linear") return (u + 1) / 2;
  const dx = u - focal;
  const b = 2 * focal * dx;
  const c = dx * dx + v * v;
  const a1 = 1 - focal * focal;
  return (b + Math.sqrt(b * b + 4 * a1 * c)) / (2 * a1);
}

/** Map t onto 0..1 with the spread mode. */
export function applySpread(t: number, spread: string | undefined): number {
  if (spread === "repeat") return t - Math.floor(t);
  if (spread === "reflect") {
    const m = ((t % 2) + 2) % 2;
    return 1 - Math.abs(m - 1);
  }
  return Math.max(0, Math.min(1, t));
}

/**
 * Add imported gradients to a scene and return the shape with its fills pointing at them. An id already in the scene
 * with an identical definition is reused; one taken by a different definition (or by a shape/sprite/bitmap) is
 * renamed id_2, id_3, ….
 */
export function adoptGradients(scene: Scene, shape: SceneShape, gradients: Record<string, SceneGradient> | undefined): SceneShape {
  if (!gradients || !Object.keys(gradients).length) return shape;
  const all = (scene.gradients = scene.gradients || {});
  const taken = (id: string) => !!(scene.shapes[id] || (scene.sprites || {})[id] || (scene.bitmaps || {})[id]);
  const rename = new Map<string, string>();
  for (const [id, g] of Object.entries(gradients)) {
    let target = id;
    let n = 2;
    while (taken(target) || (all[target] && JSON.stringify(all[target]) !== JSON.stringify(g))) target = `${id}_${n++}`;
    all[target] = g;
    rename.set(id, target);
  }
  return {
    ...shape,
    paths: shape.paths.map((p) => {
      const m = typeof p.fill === "string" ? /^gradient:(.+)$/.exec(p.fill) : null;
      return m && rename.has(m[1]!) ? { ...p, fill: `gradient:${rename.get(m[1]!)}` } : p;
    }),
  };
}

export interface GradientProblem {
  code: "gradient-stops" | "gradient-geometry" | "gradient-kind";
  message: string;
  /** sub-path under gradients.<id>, e.g. "stops[1].color" */
  at?: string;
}

/** Everything wrong with one gradient definition (empty when it can be emitted). */
export function gradientProblems(g: SceneGradient | null | undefined): GradientProblem[] {
  const out: GradientProblem[] = [];
  if (!g || (g.kind !== "linear" && g.kind !== "radial")) return [{ code: "gradient-kind", message: "kind must be linear or radial", at: "kind" }];
  const stops = Array.isArray(g.stops) ? g.stops : [];
  if (stops.length < 2 || stops.length > MAX_STOPS_SHAPE3) out.push({ code: "gradient-stops", message: `a gradient needs 2..${MAX_STOPS_SHAPE3} stops (has ${stops.length})`, at: "stops" });
  let prev = -1;
  stops.forEach((s, i) => {
    if (!s || !num(s.offset) || s.offset < 0 || s.offset > 1) out.push({ code: "gradient-stops", message: `stop ${i}: offset must be a number in 0..1`, at: `stops[${i}].offset` });
    else if (s.offset < prev) out.push({ code: "gradient-stops", message: `stop ${i}: offsets must not decrease (${s.offset} after ${prev})`, at: `stops[${i}].offset` });
    else prev = s.offset;
    const f = parseFill(s ? s.color : undefined);
    if (f.error || (f.fill.kind !== "gray" && f.fill.kind !== "rgba")) out.push({ code: "gradient-stops", message: `stop ${i}: color must be gray:N or #rrggbb[aa] (got ${JSON.stringify(s ? s.color : s)})`, at: `stops[${i}].color` });
  });
  if (g.kind === "linear") {
    if (![g.x1, g.y1, g.x2, g.y2].every(num)) out.push({ code: "gradient-geometry", message: "a linear gradient needs numeric x1, y1, x2, y2" });
    else if (g.x1 === g.x2 && g.y1 === g.y2) out.push({ code: "gradient-geometry", message: "a linear gradient's endpoints must differ" });
  } else {
    if (![g.cx, g.cy, g.r].every(num) || !((g.r as number) > 0)) out.push({ code: "gradient-geometry", message: "a radial gradient needs numeric cx, cy and r > 0" });
    if ((g.fx !== undefined || g.fy !== undefined) && !(num(g.fx) && num(g.fy))) out.push({ code: "gradient-geometry", message: "fx and fy go together" });
  }
  if (g.spread !== undefined && g.spread !== "pad" && g.spread !== "reflect" && g.spread !== "repeat") out.push({ code: "gradient-geometry", message: "spread must be pad, reflect or repeat", at: "spread" });
  if (g.transform !== undefined && (!Array.isArray(g.transform) || g.transform.length !== 6 || !g.transform.every(num))) out.push({ code: "gradient-geometry", message: "transform must be a 6-number matrix", at: "transform" });
  return out;
}
