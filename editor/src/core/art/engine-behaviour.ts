// How the game draws a mod's SWF art — the single place these facts live. OBSERVED in the game (npm run
// test:artprobe, 2026-10-20; the summary is pinned in editor/test/fixtures/ingame/artprobe-summary.json and a test keeps
// these constants in agreement with it) and in the decompiled display path (RE session disp, 2026-10-21; function RVAs
// in docs/engine-map.md "SWF loader and display path"). The preview renderer (web/src/art/preview-gl.ts), the scene
// validator and the SWF rules (swf-rules.ts) read these instead of guessing. Pure (no node, no DOM).

export const ENGINE_DRAWING = {
  /** a nested sprite advances on its own clock (under a one-frame parent it still animates), like Flash's free-running child timelines; OBSERVED in-game and in MovieClip::update 0x9a8720 (per-instance accumulator) */
  nestedSprites: "own-clock" as "own-clock" | "parent-frame",
  /** bitmap fills are filtered (blended inside magnified texels), not point-sampled — true of the fill type the emitter writes (0x41); see bitmapFillType */
  bitmapSampling: "linear" as "linear" | "nearest",
  /** outside the bitmap the edge texels streak (a Flash "clipped" fill), they do not repeat — fill type 0x41; 0x40 would repeat (swf_lib.shader `mod(uv,1)`) */
  bitmapEdge: "clamp" as "clamp" | "repeat",
  /** enemy clips are drawn mirrored horizontally (they face left): a negative x-scale on an ancestor's matrix (0x9b16c0 → the matrix stack in DisplayObject::Render 0x9b0a50); the preview shows the clip as authored */
  enemyClipsMirrored: true,
  /**
   * a character's root clip timeline is driven by the game (AnimStateMachine::PlayAnimation 0x9abda0 → gotoAndPlay /
   * gotoAndStop by label; an unknown label is a no-op), unlike nested sprites; free-running animation belongs in a
   * nested sprite, game states in frame labels
   */
  rootTimeline: "game-driven" as "game-driven" | "plays" | "held",
  /**
   * OBSERVED (Tess_tessTesselate 0xa73bb0 at +0xb9: windingRule = TESS_WINDING_ODD, baked in; Tesselator::tesselate
   * 0xa2f900 feeds each fill style's contours): every fill style is filled EVEN-ODD over its own contour set; the
   * DefineShape4 UsesFillWindingRule flag is never read. The emitter chooses which sub-paths carry the fill
   * (shape.ts assignFillSides) so nested sub-paths come out as authored; where even-odd and nonzero differ anyway
   * (partial overlaps, self-overlaps) the validator warns `fill-rule-ignored` and the preview draws even-odd.
   */
  fillRule: "evenodd" as "evenodd" | "nonzero",
  /** OBSERVED (shaders/paletted_full.shader: `out = remap(compute_color_full(v)); frag = out * color_xform[0] + color_xform[1]`; the cxform is concatenated Flash-style in 0x9b0a50): the PlaceObject cxform applies AFTER the palette remap */
  cxformOrder: "after-remap" as "after-remap" | "before-remap",
  /** OBSERVED (GradientAtlas::RasterizeRow 0xa27de0 + default_gradient.shader / swf_lib.shader): stops are rasterized over t in [0,1] and sampled with no reflect/repeat arithmetic — every gradient pads, whatever the SWF spread bits say */
  gradientSpread: "pad" as "pad" | "honoured",
  /** the fill type the emitter writes (FillStyle_read 0xb6ebc0 keeps 0x40 repeat / 0x41 clipped, each smoothed, and 0x42 / 0x43 their pixel-snapped twins apart): 0x41 = clipped + smoothed, i.e. LINEAR (with mips) and clamped — what the probe saw */
  bitmapFillType: 0x41,
  observed: "2026-10-20, build 25143593, npm run test:artprobe; 2026-10-21, RE session disp (docs/engine-map.md 'SWF loader and display path')",
} as const;

/**
 * The bitmap atlas page size: the game setting `texture_atlas_size` (default 0x1000, read in LoadNeededTextures
 * 0xa241a0). `fit_texture` 0xa24540 is FATAL ("Bitmap Fill could not fit into atlas") for a bitmap whose width or
 * height is >= the page, so a mod bitmap must be strictly smaller in both dimensions.
 */
export const TEXTURE_ATLAS_SIZE = 4096;
export const TEXTURE_ATLAS_SETTING = "texture_atlas_size";

/** True when a width×height bitmap fits the default atlas page (fit_texture 0xa24540: both dimensions < page). */
export function bitmapFitsAtlas(width: number, height: number): boolean {
  return width < TEXTURE_ATLAS_SIZE && height < TEXTURE_ATLAS_SIZE;
}

/** The `bitmap-too-large` message for a bitmap that does not fit (one wording for the scene and the SWF checks). */
export function bitmapTooLargeMessage(what: string, width: number, height: number): string {
  return `${what} is ${width}x${height}: the game stops with "Bitmap Fill could not fit into atlas" (fit_texture 0xa24540) for a bitmap whose width or height is >= ${TEXTURE_ATLAS_SETTING} (default ${TEXTURE_ATLAS_SIZE}); keep both below ${TEXTURE_ATLAS_SIZE}`;
}

/** The frame a nested sprite with `frames` frames shows at `clock` (the frames elapsed since the root started). */
export function nestedFrame(clock: number, frames: number): number {
  if (frames <= 0) return 0;
  return ((Math.floor(clock) % frames) + frames) % frames;
}
