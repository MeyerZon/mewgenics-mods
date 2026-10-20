// PlaceObject3 effects on a key: blend modes and filters (blur / glow / dropShadow). Pure: the scene validator, the
// timeline, the emitter and the reader share these tables and the FILTERLIST byte layout (SWF 10 spec, PlaceObject3).

import { parseFill, fillToRgba } from "./scene.ts";
import type { BitWriter } from "./swf-bits.ts";

/** SWF BlendMode codes (0 and 1 are both normal) */
export const BLEND_MODES: Record<string, number> = {
  normal: 1, layer: 2, multiply: 3, screen: 4, lighten: 5, darken: 6, difference: 7, add: 8, subtract: 9, invert: 10,
  alpha: 11, erase: 12, overlay: 13, hardlight: 14,
};
export type BlendName = keyof typeof BLEND_MODES;
/** the blends the WebGL preview draws (blendFunc); the Canvas2D fallback also has lighten/darken/difference/overlay/hardlight */
export const GL_PREVIEW_BLENDS = new Set(["normal", "add", "multiply", "screen"]);
export const C2D_COMPOSITE: Record<string, GlobalCompositeOperationLike> = {
  normal: "source-over", add: "lighter", multiply: "multiply", screen: "screen", lighten: "lighten", darken: "darken",
  difference: "difference", overlay: "overlay", hardlight: "hard-light",
};
type GlobalCompositeOperationLike = "source-over" | "lighter" | "multiply" | "screen" | "lighten" | "darken" | "difference" | "overlay" | "hard-light";

export interface BlurFilter {
  type: "blur";
  blurX: number;
  blurY: number;
  /** passes 1..15 (default 1) */
  quality?: number;
}
export interface GlowFilter {
  type: "glow";
  color: string;
  blurX: number;
  blurY: number;
  /** 0..255 (default 1) */
  strength?: number;
  inner?: boolean;
  knockout?: boolean;
  quality?: number;
}
export interface DropShadowFilter {
  type: "dropShadow";
  color: string;
  /** degrees */
  angle?: number;
  /** px */
  distance?: number;
  blurX: number;
  blurY: number;
  strength?: number;
  inner?: boolean;
  knockout?: boolean;
  quality?: number;
}
export type SceneFilter = BlurFilter | GlowFilter | DropShadowFilter;

export interface Rgba8 {
  r: number;
  g: number;
  b: number;
  a: number;
}
/** a decoded filter (angles in radians, colours as RGBA) */
export type ParsedFilter =
  | { type: "blur"; blurX: number; blurY: number; passes: number }
  | { type: "glow"; color: Rgba8; blurX: number; blurY: number; strength: number; inner: boolean; knockout: boolean; passes: number }
  | { type: "dropShadow"; color: Rgba8; blurX: number; blurY: number; angle: number; distance: number; strength: number; inner: boolean; knockout: boolean; passes: number }
  | { type: "other"; id: number };

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** True when a key/placement needs PlaceObject3. */
export function hasEffects(blend: string | null | undefined, filters: SceneFilter[] | null | undefined): boolean {
  return (!!blend && blend !== "normal") || (!!filters && filters.length > 0);
}

function colour(s: string | undefined): Rgba8 | null {
  const f = parseFill(s);
  if (f.error) return null;
  const c = fillToRgba(f.fill);
  return c ? { r: c.r, g: c.g, b: c.b, a: c.a } : null;
}

/** Problems with one filter (empty when it can be written). */
export function filterProblems(f: unknown): string[] {
  const out: string[] = [];
  if (!f || typeof f !== "object") return ["a filter is an object"];
  const x = f as Record<string, unknown>;
  if (x.type !== "blur" && x.type !== "glow" && x.type !== "dropShadow") return [`unknown filter type ${JSON.stringify(x.type)} (blur, glow, dropShadow)`];
  for (const k of ["blurX", "blurY"]) if (!num(x[k]) || (x[k] as number) < 0 || (x[k] as number) > 255) out.push(`${k} must be a number in 0..255`);
  if (x.quality !== undefined && !(Number.isInteger(x.quality) && (x.quality as number) >= 1 && (x.quality as number) <= 15)) out.push("quality must be an integer 1..15");
  if (x.type !== "blur") {
    if (!colour(x.color as string)) out.push("color must be gray:N or #rrggbb[aa]");
    if (x.strength !== undefined && !(num(x.strength) && x.strength >= 0 && x.strength <= 255)) out.push("strength must be a number in 0..255");
  }
  if (x.type === "dropShadow") {
    if (x.angle !== undefined && !num(x.angle)) out.push("angle must be a number (degrees)");
    if (x.distance !== undefined && !num(x.distance)) out.push("distance must be a number (px)");
  }
  return out;
}

const fixed = (w: BitWriter, v: number) => w.u32(Math.round(v * 65536) >>> 0);
const fixed8 = (w: BitWriter, v: number) => w.u16(Math.round(v * 256) & 0xffff);

/** FILTERLIST: count, then per filter its id and fields. */
export function writeFilterList(w: BitWriter, filters: SceneFilter[]): void {
  w.u8(filters.length);
  for (const f of filters) {
    const passes = f.quality ?? 1;
    if (f.type === "blur") {
      w.u8(1);
      fixed(w, f.blurX);
      fixed(w, f.blurY);
      w.writeUB(5, passes);
      w.writeUB(3, 0);
      continue;
    }
    const c = colour(f.color) || { r: 0, g: 0, b: 0, a: 255 };
    if (f.type === "glow") {
      w.u8(2);
      w.u8(c.r); w.u8(c.g); w.u8(c.b); w.u8(c.a);
      fixed(w, f.blurX);
      fixed(w, f.blurY);
      fixed8(w, f.strength ?? 1);
    } else {
      w.u8(0);
      w.u8(c.r); w.u8(c.g); w.u8(c.b); w.u8(c.a);
      fixed(w, f.blurX);
      fixed(w, f.blurY);
      fixed(w, ((f.angle ?? 45) * Math.PI) / 180);
      fixed(w, f.distance ?? 4);
      fixed8(w, f.strength ?? 1);
    }
    // InnerShadow/InnerGlow, Knockout, CompositeSource (always 1), Passes(5)
    w.writeUB(1, f.inner ? 1 : 0);
    w.writeUB(1, f.knockout ? 1 : 0);
    w.writeUB(1, 1);
    w.writeUB(5, passes);
  }
}

/** The reader side (r is the swf-reader BitReader; typed loosely to keep this module free of the reader). */
export function readFilterList(r: { u8(): number; u16(): number; u32(): number; readUB(n: number): number; align(): void }): ParsedFilter[] {
  const n = r.u8();
  const out: ParsedFilter[] = [];
  const fx = () => (r.u32() | 0) / 65536;
  const fx8 = () => ((r.u16() << 16) >> 16) / 256;
  const rgba = (): Rgba8 => ({ r: r.u8(), g: r.u8(), b: r.u8(), a: r.u8() });
  for (let i = 0; i < n; i++) {
    const id = r.u8();
    if (id === 1) {
      const blurX = fx(), blurY = fx();
      const passes = r.readUB(5);
      r.readUB(3);
      out.push({ type: "blur", blurX, blurY, passes });
    } else if (id === 2) {
      const color = rgba(), blurX = fx(), blurY = fx(), strength = fx8();
      const inner = !!r.readUB(1), knockout = !!r.readUB(1);
      r.readUB(1);
      out.push({ type: "glow", color, blurX, blurY, strength, inner, knockout, passes: r.readUB(5) });
    } else if (id === 0) {
      const color = rgba(), blurX = fx(), blurY = fx(), angle = fx(), distance = fx(), strength = fx8();
      const inner = !!r.readUB(1), knockout = !!r.readUB(1);
      r.readUB(1);
      out.push({ type: "dropShadow", color, blurX, blurY, angle, distance, strength, inner, knockout, passes: r.readUB(5) });
    } else {
      out.push({ type: "other", id });
      break; // other filter layouts are not decoded; the rest of the list cannot be located
    }
    r.align();
  }
  return out;
}
