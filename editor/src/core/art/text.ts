// Text the way the base game does it (vanilla ability_icons.swf / ui.swf): a DefineEditText that names a font class the
// game's own swfs/fonts.swf exports — no glyphs in our file — written with vanilla's exact flags and HTML, plus an
// ImportAssets2("fonts.swf") with zero assets that declares the dependency. Pinned in
// test/fixtures/art/game-fonts.json against the installed game. Pure.

import { parseFill, fillToRgba } from "./scene.ts";
import { BitWriter, TAG, tag, writeRect, writeRgba } from "./swf-bits.ts";

/** The font classes swfs/fonts.swf exports (its SymbolClass names). */
export const GAME_FONTS: readonly string[] = ["Edmundm", "NPCFont_BabyJack", "NPCFont_Frank", "NPCFont_OrganGrinder", "NPCFont_Steven", "Peralta", "Swanky", "TikaFont"];

/** A text character (placed by keys like a shape; its box is centred on the placement point). */
export interface SceneText {
  text: string;
  /** a GAME_FONTS class (default Peralta, the ability-icon font) */
  font?: string;
  /** px */
  size: number;
  /** gray:N or #rrggbb (default #000000, like vanilla) */
  color?: string;
  align?: "left" | "center" | "right";
  /** the text box, px */
  width: number;
  height: number;
  /** false: no HTML flag and the raw string as the initial text (default true: vanilla's `<p><font>` wrapper); the
   * loc-key probe's plain variant (docs/engine-map.md "Localization and text fields") */
  html?: boolean;
}

/** vanilla's DefineEditText flags: HasText WordWrap Multiline ReadOnly HasTextColor | HasFontClass HasLayout HTML UseOutlines */
export const EDIT_TEXT_FLAGS = 0xeca3;
/** the same without the HTML bit (0x0002 of the second flag byte): the initial text is plain */
export const EDIT_TEXT_FLAGS_PLAIN = EDIT_TEXT_FLAGS & ~0x0002;
const ALIGN: Record<string, number> = { left: 0, right: 1, center: 2, justify: 3 };

export interface TextProblem {
  code: "text-font" | "text-empty" | "text-size" | "text-box" | "text-color" | "text-html";
  message: string;
  at?: string;
}

/** @param sceneFonts the ids of the scene's own fonts (scene.fonts), valid font classes besides GAME_FONTS */
export function textProblems(t: SceneText | null | undefined, sceneFonts: readonly string[] = []): TextProblem[] {
  const out: TextProblem[] = [];
  if (!t || typeof t !== "object") return [{ code: "text-empty", message: "a text is an object { text, font, size, width, height }" }];
  if (typeof t.text !== "string" || !t.text.trim()) out.push({ code: "text-empty", message: "text is empty", at: "text" });
  const font = t.font ?? "Peralta";
  if (!GAME_FONTS.includes(font) && !sceneFonts.includes(font)) out.push({ code: "text-font", message: `font "${font}" is neither a game font class (${GAME_FONTS.join(", ")}) nor one of this scene's fonts${sceneFonts.length ? ` (${sceneFonts.join(", ")})` : " (scene.fonts)"}`, at: "font" });
  if (!(typeof t.size === "number" && t.size > 0 && t.size <= 400)) out.push({ code: "text-size", message: "size must be a number of px in (0, 400]", at: "size" });
  if (!(typeof t.width === "number" && t.width > 0 && typeof t.height === "number" && t.height > 0)) out.push({ code: "text-box", message: "width and height must be positive px", at: "width" });
  if (t.color !== undefined) {
    const f = parseFill(t.color);
    if (f.error || (f.fill.kind !== "gray" && f.fill.kind !== "rgba")) out.push({ code: "text-color", message: "color must be gray:N or #rrggbb", at: "color" });
  }
  if (t.html !== undefined && typeof t.html !== "boolean") out.push({ code: "text-html", message: "html must be true or false", at: "html" });
  if (t.align !== undefined && !(t.align in ALIGN)) out.push({ code: "text-box", message: "align must be left, center or right", at: "align" });
  return out;
}

/** Where a localization key comes from, as the caller's lookup knows it (the base combined.csv or the mod's own csv overlays). */
export type LocKeySource = "base" | "mod";
/** The cheap key test when no table is at hand: vanilla keys are ALL_CAPS_WITH_UNDERSCORES. */
export const LOC_KEY_SHAPE = /^[A-Z][A-Z0-9_]{2,}$/;

/**
 * text-loc-key-html: the game substitutes a key only in a plain initial text (the text-box ctor 0x98d910 looks the
 * whole string up; OBSERVED 2026-10-22, mods/_artprobe/tests/render-loctext.mewtest), so a text that is exactly a
 * key and still carries vanilla's HTML wrapper is drawn as the key. A key the lookup confirms (base table or the mod's
 * csv overlays) is a warning; a string that only has the key shape is an info (it may be a plain word like PROBE).
 */
export function locKeyHtmlProblem(t: SceneText, locKey?: (key: string) => LocKeySource | null | undefined): { severity: "warning" | "info"; message: string } | null {
  if (!t || typeof t.text !== "string" || t.html === false) return null;
  const key = t.text;
  const why: string[] = [];
  const src = locKey ? locKey(key) : null;
  if (src === "base") why.push("in the base combined.csv");
  if (src === "mod") why.push("added by this mod's combined.csv.append");
  const shaped = LOC_KEY_SHAPE.test(key);
  if (!why.length) {
    if (!shaped) return null;
    return { severity: "info", message: `"${key}" looks like a loc key but no such key exists in the base table or this mod's csv files; if it is meant to be localized, add the key and set html: false` };
  }
  if (shaped) why.push("matches the key shape ^[A-Z][A-Z0-9_]{2,}$");
  return { severity: "warning", message: `"${key}" is a localization key (${why.join("; ")}) but the text is emitted as HTML (vanilla's <p><font> wrapper): the game substitutes a key only in a plain text, so it would draw "${key}" as written. Set "html": false on this text (Art mode: tick "plain (localized)" on its row)` };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function textRgba(t: SceneText): { r: number; g: number; b: number; a: number } {
  const c = t.color ? fillToRgba(parseFill(t.color).fill) : null;
  return c ? { r: c.r, g: c.g, b: c.b, a: c.a } : { r: 0, g: 0, b: 0, a: 255 };
}

/** The HTML initial text, in vanilla's exact shape. */
export function textHtml(t: SceneText): string {
  const c = textRgba(t);
  const hex = "#" + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("");
  return `<p align="${t.align || "center"}"><font size="${Math.round(t.size)}" color="${hex}" letterSpacing="0.00" kerning="1">${esc(t.text)}</font></p>`;
}

/** DefineEditText (framed tag). The bounds are the text box centred on the origin. */
export function encodeDefineEditText(id: number, t: SceneText): Uint8Array {
  const w = new BitWriter(96 + t.text.length * 2);
  w.u16(id);
  const hw = Math.round((t.width * 20) / 2), hh = Math.round((t.height * 20) / 2);
  writeRect(w, { xmin: -hw, xmax: hw, ymin: -hh, ymax: hh });
  const flags = t.html === false ? EDIT_TEXT_FLAGS_PLAIN : EDIT_TEXT_FLAGS;
  w.u8(flags >> 8); // flag bytes in file order: ec, a3 (a1 plain)
  w.u8(flags & 0xff);
  w.string(t.font || "Peralta");
  w.u16(Math.round(t.size * 20));
  writeRgba(w, textRgba(t));
  // layout: align, left margin, right margin, indent, leading
  w.u8(ALIGN[t.align || "center"] ?? 2);
  w.u16(0);
  w.u16(0);
  w.u16(0);
  w.s16(0);
  w.string(""); // VariableName
  w.string(t.html === false ? t.text : textHtml(t));
  return tag(TAG.DefineEditText, w.finish());
}

/** ImportAssets2(url, entries): reserved bytes 1, 0 as in vanilla, then { character id, linkage name } per entry. */
export function encodeImportAssets2(url: string, entries: Array<{ id: number; name: string }>): Uint8Array {
  const w = new BitWriter(32 + entries.length * 24);
  w.string(url);
  w.u8(1);
  w.u8(0);
  w.u16(entries.length);
  for (const e of entries) {
    w.u16(e.id);
    w.string(e.name);
  }
  return tag(TAG.ImportAssets2, w.finish());
}

/** ImportAssets2("fonts.swf", 0 assets): vanilla's declaration that the file uses the game's fonts. */
export function encodeImportGameFonts(): Uint8Array {
  return encodeImportAssets2("fonts.swf", []);
}
