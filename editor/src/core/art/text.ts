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
}

/** vanilla's DefineEditText flags: HasText WordWrap Multiline ReadOnly HasTextColor | HasFontClass HasLayout HTML UseOutlines */
export const EDIT_TEXT_FLAGS = 0xeca3;
const ALIGN: Record<string, number> = { left: 0, right: 1, center: 2, justify: 3 };

export interface TextProblem {
  code: "text-font" | "text-empty" | "text-size" | "text-box" | "text-color";
  message: string;
  at?: string;
}

export function textProblems(t: SceneText | null | undefined): TextProblem[] {
  const out: TextProblem[] = [];
  if (!t || typeof t !== "object") return [{ code: "text-empty", message: "a text is an object { text, font, size, width, height }" }];
  if (typeof t.text !== "string" || !t.text.trim()) out.push({ code: "text-empty", message: "text is empty", at: "text" });
  const font = t.font ?? "Peralta";
  if (!GAME_FONTS.includes(font)) out.push({ code: "text-font", message: `font "${font}" is not a game font class (${GAME_FONTS.join(", ")})`, at: "font" });
  if (!(typeof t.size === "number" && t.size > 0 && t.size <= 400)) out.push({ code: "text-size", message: "size must be a number of px in (0, 400]", at: "size" });
  if (!(typeof t.width === "number" && t.width > 0 && typeof t.height === "number" && t.height > 0)) out.push({ code: "text-box", message: "width and height must be positive px", at: "width" });
  if (t.color !== undefined) {
    const f = parseFill(t.color);
    if (f.error || (f.fill.kind !== "gray" && f.fill.kind !== "rgba")) out.push({ code: "text-color", message: "color must be gray:N or #rrggbb", at: "color" });
  }
  if (t.align !== undefined && !(t.align in ALIGN)) out.push({ code: "text-box", message: "align must be left, center or right", at: "align" });
  return out;
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
  w.u8(EDIT_TEXT_FLAGS >> 8); // flag bytes in file order: ec, a3
  w.u8(EDIT_TEXT_FLAGS & 0xff);
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
  w.string(textHtml(t));
  return tag(TAG.DefineEditText, w.finish());
}

/** ImportAssets2("fonts.swf", 0 assets): vanilla's declaration that the file uses the game's fonts. */
export function encodeImportGameFonts(): Uint8Array {
  const w = new BitWriter(16);
  w.string("fonts.swf");
  w.u8(1); // reserved, 1 as in vanilla
  w.u8(0); // reserved
  w.u16(0); // count
  return tag(TAG.ImportAssets2, w.finish());
}
