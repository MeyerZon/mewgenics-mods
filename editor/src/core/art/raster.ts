// Raster art in a scene: a PNG as a bitmap-filled shape, as a whole raster sprite (a character clip: a "photo" enemy)
// or as a background plate (a tileset's combat_background). Pure (no node, no DOM): the web UI and the API share it.
//
// The engine facts it encodes (docs/engine-map.md "SWF loader and display path"; docs/art-pipeline.md "Raster art"):
//  - fill types (FillStyle_read 0xb6ebc0): 0x40 repeat / 0x41 clipped, both smoothed (swf_lib.shader: textureLod LINEAR
//    with mips, bias −0.5), 0x42 / 0x43 their pixel-snapped twins (clamp_to_nearest, mip 0); clipped clamps the uv to
//    the edge texels, repeat is mod(uv, 1);
//  - the atlas page is texture_atlas_size (default 4096) and fit_texture 0xa24540 is FATAL for a bitmap whose width or
//    height is >= the page (bitmap-too-large);
//  - vanilla draws its own combat backgrounds this way (backgrounds.swf AlleyBGTest: a 2000×1500 bitmap scaled 0.7667
//    over a rect from (0,0), one plate per frame) and enemies' raster parts with 0x41 (test/fixtures/art/vanilla-raster.json).

import type { Scene, SceneBitmap, SceneShape, SceneSprite, Finding } from "./scene.ts";
import { bitmapFitsAtlas, bitmapTooLargeMessage } from "./engine-behaviour.ts";

/** The fill type the emitter writes for a scene bitmap (0x41 unless repeat / smooth:false say otherwise). */
export function bitmapFillType(bm: SceneBitmap | undefined): number {
  const repeat = !!(bm && bm.repeat === true);
  const snapped = !!(bm && bm.smooth === false);
  return (repeat ? 0x40 : 0x41) + (snapped ? 2 : 0);
}

export type RasterMode = "fill" | "sprite" | "background";
export type RasterOrigin = "top-left" | "center" | "bottom-center";
export const RASTER_MODES: readonly RasterMode[] = ["fill", "sprite", "background"];
export const RASTER_ORIGINS: readonly RasterOrigin[] = ["top-left", "center", "bottom-center"];

export interface AddBitmapOptions {
  /** the shape id; the bitmap is <id>Bmp, the sprite <id>Clip */
  id: string;
  /** the PNG, relative to the mod (e.g. art/Photo.png) */
  file: string;
  /** the PNG's size in texels */
  width: number;
  height: number;
  /** "sprite" (default): a 1-frame clip exported for graphics.movieclip; "background": the same, origin top-left (a combat_background plate); "fill": only the bitmap + a shape to place yourself */
  mode?: RasterMode;
  /** clip px per texel (default 1). The game magnifies bitmaps LINEAR; above 1 they soften (bitmap-upscaled) */
  scale?: number;
  /** where clip (0,0) sits on the image (default: sprite bottom-center = the feet, background / fill top-left) */
  origin?: RasterOrigin;
  repeat?: boolean;
  smooth?: boolean;
  /** fill mode: the shape's size in clip px (default the image's size × scale); with repeat the bitmap tiles over it */
  area?: { width: number; height: number };
  /** sprite / background: the linkage name (default the id) */
  exportName?: string;
  /** overwrite existing ids */
  replace?: boolean;
}

export interface AddBitmapResult {
  ok: boolean;
  scene: Scene;
  bitmapId: string;
  shapeId: string;
  spriteId?: string;
  exportName?: string;
  findings: Finding[];
}

const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Findings about a bitmap of this size drawn at this scale (no scene needed). */
export function rasterFindings(what: string, width: number, height: number, scale = 1): Finding[] {
  const out: Finding[] = [];
  if (!bitmapFitsAtlas(width, height)) out.push({ severity: "error", code: "bitmap-too-large", message: bitmapTooLargeMessage(what, width, height) });
  if (scale > 1) out.push({ severity: "info", code: "bitmap-upscaled", message: `${what} is drawn at ${scale} clip px per texel: the game magnifies bitmaps with LINEAR filtering (swf_lib.shader), so it looks soft in-game; author it at ${Math.ceil(width * scale)}×${Math.ceil(height * scale)} or more and use scale <= 1 (vanilla's combat plates are 2000×1500 at 0.7667)` });
  return out;
}

/** Add a PNG to a scene (a copy of it: the input is not changed). */
export function addBitmapToScene(input: Scene, o: AddBitmapOptions): AddBitmapResult {
  const scene: Scene = JSON.parse(JSON.stringify(input)) as Scene;
  const findings: Finding[] = [];
  const mode: RasterMode = o.mode ?? "sprite";
  const bitmapId = `${o.id}Bmp`;
  const spriteId = `${o.id}Clip`;
  const fail = (code: string, message: string): AddBitmapResult => ({ ok: false, scene: input, bitmapId, shapeId: o.id, findings: [...findings, { severity: "error", code, message }] });
  if (typeof o.id !== "string" || !ID_RE.test(o.id)) return fail("raster-id", `id "${String(o.id)}" must be letters, digits and _ (it names the shape, <id>Bmp and <id>Clip)`);
  if (!RASTER_MODES.includes(mode)) return fail("raster-mode", `mode must be one of ${RASTER_MODES.join(", ")}`);
  const origin: RasterOrigin = o.origin ?? (mode === "sprite" ? "bottom-center" : "top-left");
  if (!RASTER_ORIGINS.includes(origin)) return fail("raster-origin", `origin must be one of ${RASTER_ORIGINS.join(", ")}`);
  if (typeof o.file !== "string" || !/\.png$/i.test(o.file)) return fail("bitmap-file", `file must be a .png path inside the mod`);
  if (!(Number.isInteger(o.width) && o.width > 0 && Number.isInteger(o.height) && o.height > 0)) return fail("raster-size", "width and height are the PNG's size in texels (positive integers)");
  const scale = o.scale ?? 1;
  if (!(typeof scale === "number" && scale > 0 && scale < 100)) return fail("raster-scale", "scale (clip px per texel) must be a number in (0, 100)");
  findings.push(...rasterFindings(`bitmap "${bitmapId}" (${o.file})`, o.width, o.height, scale).map((f) => ({ ...f, path: `bitmaps.${bitmapId}` })));
  if (findings.some((f) => f.severity === "error")) return { ok: false, scene: input, bitmapId, shapeId: o.id, findings };

  const exportName = mode === "fill" ? undefined : o.exportName ?? o.id;
  if (exportName !== undefined && !ID_RE.test(exportName)) return fail("raster-export", `exportName "${exportName}" must be letters, digits and _`);
  const taken = (id: string) => !!(scene.shapes[id] || (scene.sprites || {})[id] || (scene.bitmaps || {})[id] || (scene.gradients || {})[id] || (scene.texts || {})[id] || (scene.imports || {})[id] || (scene.fonts || {})[id]);
  const mine = [bitmapId, o.id, ...(mode === "fill" ? [] : [spriteId])];
  if (!o.replace) {
    for (const id of mine) if (taken(id)) return fail("id-taken", `id "${id}" is already used in the scene (pass replace to overwrite it)`);
    if (exportName !== undefined && scene.exports[exportName] !== undefined) return fail("id-taken", `export "${exportName}" already exists (pass replace to overwrite it)`);
  }

  const bm: SceneBitmap = { file: o.file };
  if (o.repeat) bm.repeat = true;
  if (o.smooth === false) bm.smooth = false;
  scene.bitmaps = { ...(scene.bitmaps || {}), [bitmapId]: bm };

  // geometry in texel units, mapped to clip px by the path transform (the bitmap fill matrix follows it: shape.ts)
  const area = mode === "fill" && o.area ? o.area : null;
  const tw = area ? round(area.width / scale) : o.width;
  const th = area ? round(area.height / scale) : o.height;
  const wpx = tw * scale, hpx = th * scale;
  const ox = origin === "top-left" ? 0 : -wpx / 2;
  const oy = origin === "top-left" ? 0 : origin === "center" ? -hpx / 2 : -hpx;
  const shape: SceneShape = { paths: [{ d: `M0 0 L${tw} 0 L${tw} ${th} L0 ${th} Z`, fill: `bitmap:${bitmapId}`, transform: [scale, 0, 0, scale, round(ox), round(oy)] }], source: o.file };
  scene.shapes = { ...scene.shapes, [o.id]: shape };
  if (mode === "fill") return { ok: true, scene, bitmapId, shapeId: o.id, findings };

  const sprite: SceneSprite = { frames: 1, layers: [{ name: o.id, depth: 1, keys: [{ frame: 0, ref: o.id, x: 0, y: 0 }] }] };
  scene.sprites = { ...scene.sprites, [spriteId]: sprite };
  scene.exports = { ...scene.exports, [exportName!]: spriteId };
  return { ok: true, scene, bitmapId, shapeId: o.id, spriteId, exportName, findings };
}

function round(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * What the editor's PNG decoder (png.ts) refuses, read from the header alone (pure): not a PNG, a bit depth other
 * than 8, interlacing, an unknown colour type → `bitmap-unsupported-format`. An empty list means the header is fine.
 */
export function pngProblems(bytes: Uint8Array): Finding[] {
  const bad = (message: string): Finding[] => [{ severity: "error", code: "bitmap-unsupported-format", message }];
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!bytes || bytes.length < 33 || SIG.some((v, i) => bytes[i] !== v)) return bad("not a PNG file (bad signature); export the image as PNG");
  const type = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
  if (type !== "IHDR") return bad("PNG without IHDR first");
  const depth = bytes[24]!, colour = bytes[25]!, interlace = bytes[28]!;
  if (depth !== 8) return bad(`PNG bit depth ${depth} is not supported (only 8-bit); re-export as 8-bit RGBA`);
  if (![0, 2, 3, 4, 6].includes(colour)) return bad(`PNG colour type ${colour} is not supported`);
  if (interlace !== 0) return bad("interlaced (Adam7) PNGs are not supported; re-export without interlacing");
  return [];
}

/** The PNG's size from its IHDR (pure); null when it is not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (pngProblems(bytes).some((f) => f.message.startsWith("not a PNG") || f.message.startsWith("PNG without"))) return null;
  const be = (p: number) => ((bytes[p]! << 24) | (bytes[p + 1]! << 16) | (bytes[p + 2]! << 8) | bytes[p + 3]!) >>> 0;
  return { width: be(16), height: be(20) };
}
