// Fonts a mod carries itself: scene.fonts → DefineFont3 (+ a SymbolClass name = the font id), the only font tag the
// game decodes (DefineFont::decode 0xa2a4a0; DefineFont / DefineFont2 are FATAL). Written the way vanilla fonts.swf is:
// flags HasLayout | WideCodes (0x84; WideOffsets when the glyph table needs it), language 1, the name NUL-terminated,
// glyph shapes with FillStyle0 = 1, the code table ascending, ascent / descent / leading, the advance table, the bounds
// table and no kerning. A DefineEditText that names the font id as its class finds it through
// Swf_FindCharacterByClassName 0x9bb910 → the global export-name registry (docs/engine-map.md "Localization and text
// fields"). Pure (no node, no DOM): the preview lays texts out with layoutTextPaths.
//
// Glyph coordinates: an em of FONT_EM (1024) units, y down, the baseline at y = 0 (capitals reach into negative y),
// the pen starting at x = 0 — SVG path data. DefineFont3 stores them ×20 (the decoder's ×0.05).

import { normalizePath, subpathBounds } from "./geometry.ts";
import type { SubPath } from "./geometry.ts";
import { BitWriter, TAG, nbitsForSigned, writeRect, tag } from "./swf-bits.ts";
import type { Rect } from "./swf-bits.ts";
import { writeStraight, writeCurve } from "./shape.ts";
import type { ScenePath } from "./scene.ts";
import type { SceneText } from "./text.ts";

export const FONT_EM = 1024;

export interface SceneFontGlyph {
  /** SVG path data in em units (y down, baseline 0); "" for an empty glyph such as the space */
  d: string;
  /** pen advance in em units */
  advance: number;
}

export interface SceneFont {
  /** the DefineFont3 font name (default the font id) */
  name?: string;
  /** em units above / below the baseline */
  ascent: number;
  descent: number;
  /** extra line gap, em units (default 0) */
  leading?: number;
  /** one entry per character */
  glyphs: Record<string, SceneFontGlyph>;
}

export interface FontProblem {
  code: "font-empty" | "font-glyph" | "font-metrics";
  message: string;
  at?: string;
}

const isNum = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

export function fontProblems(f: SceneFont | null | undefined): FontProblem[] {
  if (!f || typeof f !== "object") return [{ code: "font-empty", message: "a font is an object { ascent, descent, glyphs }" }];
  const out: FontProblem[] = [];
  if (!isNum(f.ascent, 0, 4 * FONT_EM) || !isNum(f.descent, 0, 4 * FONT_EM)) out.push({ code: "font-metrics", message: `ascent and descent are em units (0..${4 * FONT_EM})`, at: "ascent" });
  if (f.leading !== undefined && !isNum(f.leading, -FONT_EM, 4 * FONT_EM)) out.push({ code: "font-metrics", message: "leading is em units", at: "leading" });
  if (f.name !== undefined && (typeof f.name !== "string" || !f.name || f.name.length > 200)) out.push({ code: "font-metrics", message: "name must be a short non-empty string", at: "name" });
  const glyphs = f.glyphs && typeof f.glyphs === "object" ? f.glyphs : {};
  const keys = Object.keys(glyphs);
  if (!keys.length) out.push({ code: "font-empty", message: "the font has no glyphs", at: "glyphs" });
  for (const k of keys) {
    const g = glyphs[k] as SceneFontGlyph | undefined;
    const at = `glyphs.${k}`;
    const cps = Array.from(k);
    if (cps.length !== 1 || k.codePointAt(0)! > 0xffff) { out.push({ code: "font-glyph", message: `glyph key ${JSON.stringify(k)} must be exactly one character (BMP; DefineFont3 codes are 16-bit)`, at }); continue; }
    if (!g || typeof g !== "object") { out.push({ code: "font-glyph", message: `glyph ${JSON.stringify(k)} must be { d, advance }`, at }); continue; }
    if (!isNum(g.advance, 0, 1600)) out.push({ code: "font-glyph", message: `glyph ${JSON.stringify(k)}: advance must be em units in 0..1600`, at: `${at}.advance` });
    if (typeof g.d !== "string") out.push({ code: "font-glyph", message: `glyph ${JSON.stringify(k)}: d must be SVG path data ("" for an empty glyph)`, at: `${at}.d` });
    else if (g.d.trim()) {
      try { normalizePath(g.d); } catch (e) { out.push({ code: "font-glyph", message: `glyph ${JSON.stringify(k)}: ${e instanceof Error ? e.message : String(e)}`, at: `${at}.d` }); }
    }
  }
  return out;
}

/** The distinct characters of `text` the font has no glyph for (line breaks ignored), in first-seen order. */
export function missingGlyphs(f: SceneFont, text: string): string[] {
  const have = f && f.glyphs ? f.glyphs : {};
  const out: string[] = [];
  for (const ch of Array.from(text || "")) if (ch !== "\n" && ch !== "\r" && !(ch in have) && !out.includes(ch)) out.push(ch);
  return out;
}

interface GlyphOut {
  code: number;
  shape: Uint8Array;
  advance: number;
  bounds: Rect;
  subs: SubPath[];
}

function glyphShape(d: string): { bytes: Uint8Array; bounds: Rect; subs: SubPath[] } {
  const w = new BitWriter(64);
  w.writeUB(4, 1); // NumFillBits
  w.writeUB(4, 0); // NumLineBits
  const subs = d.trim() ? normalizePath(d) : [];
  const T = (v: number) => Math.round(v * 20);
  for (const sub of subs) {
    const sx = T(sub.start[0]), sy = T(sub.start[1]);
    // StyleChangeRecord: TypeFlag 0, NewStyles 0, LineStyle 0, FillStyle1 0, FillStyle0 1, MoveTo 1 (vanilla's glyphs)
    w.writeUB(6, 0b000011);
    const mb = nbitsForSigned([sx, sy]);
    w.writeUB(5, mb);
    w.writeSB(mb, sx);
    w.writeSB(mb, sy);
    w.writeUB(1, 1);
    let px = sx, py = sy;
    const edges = sub.edges.map((e) => (e.t === "L" ? { t: "L" as const, x: T(e.x), y: T(e.y) } : { t: "Q" as const, cx: T(e.cx), cy: T(e.cy), x: T(e.x), y: T(e.y) }));
    const last = edges[edges.length - 1];
    if (last && (last.x !== sx || last.y !== sy)) edges.push({ t: "L", x: sx, y: sy });
    for (const e of edges) {
      if (e.t === "L") writeStraight(w, e.x - px, e.y - py);
      else writeCurve(w, px, py, e.cx, e.cy, e.x, e.y);
      px = e.x;
      py = e.y;
    }
  }
  w.writeUB(6, 0); // EndShapeRecord
  const b = subpathBounds(subs);
  const bounds = b ? { xmin: T(b.xmin), ymin: T(b.ymin), xmax: T(b.xmax), ymax: T(b.ymax) } : { xmin: 0, ymin: 0, xmax: 0, ymax: 0 };
  return { bytes: w.finish(), bounds, subs };
}

/** DefineFont3 (framed tag) for a scene font. */
export function encodeDefineFont3(id: number, f: SceneFont, fontName: string): Uint8Array {
  const glyphs: GlyphOut[] = Object.entries(f.glyphs)
    .map(([ch, g]) => ({ code: ch.codePointAt(0)!, ...(() => { const s = glyphShape(g.d); return { shape: s.bytes, bounds: s.bounds, subs: s.subs }; })(), advance: Math.round(g.advance * 20) }))
    .sort((a, b) => a.code - b.code);
  const n = glyphs.length;
  const shapesLen = glyphs.reduce((s, g) => s + g.shape.length, 0);
  const wideOffsets = 2 * (n + 1) + shapesLen > 0xffff;
  const offSize = wideOffsets ? 4 : 2;
  const w = new BitWriter(64 + shapesLen + n * 16);
  w.u16(id);
  w.u8(0x80 | 0x04 | (wideOffsets ? 0x08 : 0)); // HasLayout | WideCodes (| WideOffsets)
  w.u8(1); // LanguageCode: Latin
  const name = new TextEncoder().encode(`${fontName}\u0000`);
  w.u8(Math.min(255, name.length));
  w.bytes(name.subarray(0, 255));
  w.u16(n);
  let off = offSize * (n + 1);
  const writeOff = (v: number) => (wideOffsets ? w.u32(v) : w.u16(v));
  for (const g of glyphs) { writeOff(off); off += g.shape.length; }
  writeOff(off); // CodeTableOffset
  for (const g of glyphs) w.bytes(g.shape);
  for (const g of glyphs) w.u16(g.code);
  w.u16(Math.round(f.ascent * 20));
  w.u16(Math.round(f.descent * 20));
  w.s16(Math.round((f.leading ?? 0) * 20));
  for (const g of glyphs) w.s16(g.advance);
  for (const g of glyphs) writeRect(w, g.bounds);
  w.u16(0); // KerningCount
  return tag(TAG.DefineFont3, w.finish(), true);
}

/**
 * The text laid out as glyph paths in px, in the text box's frame (the box centred on the origin, like the
 * DefineEditText bounds the emitter writes): a 2 px margin (DynamicTextBox ±2), lines split at "\n", align per line,
 * no wrapping. For the preview and the probe's expectations; the game's own layout may differ by a pixel or two.
 */
export function layoutTextPaths(f: SceneFont, t: SceneText): ScenePath[] {
  const s = t.size / FONT_EM;
  const left = -t.width / 2 + 2, right = t.width / 2 - 2, top = -t.height / 2 + 2;
  const lineH = (f.ascent + f.descent + (f.leading ?? 0)) * s;
  const out: ScenePath[] = [];
  const fill = t.color || "#000000";
  (t.text || "").split("\n").forEach((line, li) => {
    const chars = Array.from(line);
    const width = chars.reduce((sum, ch) => sum + ((f.glyphs[ch] && f.glyphs[ch]!.advance) || 0) * s, 0);
    let x = t.align === "right" ? right - width : t.align === "left" ? left : -width / 2;
    const baseline = top + f.ascent * s + li * lineH;
    for (const ch of chars) {
      const g = f.glyphs[ch];
      if (!g) continue;
      if (g.d.trim()) out.push({ d: g.d, fill, transform: [s, 0, 0, s, round(x), round(baseline)] });
      x += g.advance * s;
    }
  });
  return out;
}

function round(v: number): number {
  return Math.round(v * 10000) / 10000;
}
