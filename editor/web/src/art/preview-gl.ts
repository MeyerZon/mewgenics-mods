// In-suite "as in-game" animated preview renderer for the art pipeline.
//
// Hand-written raw WebGL1 (Canvas2D fallback), zero dependencies. Independent of React and
// of app state: `createPreview(canvas)` returns a plain object the panel drives. Nothing here
// touches the DOM at module top level, so the module is importable (and type-checked)
// outside a browser.
//
// Render model (docs/art-preview-plan.md §3, docs/art-pipeline.md §5):
//   * frames come from the SAME pure baking the SWF emitter uses (`timeline.ts`), so
//     the pixels on screen are computed from the matrices/cxforms the SWF will carry;
//   * shapes are filled with the stencil technique (no triangulation): one TRIANGLE_FAN
//     per sub-path writes winding counts with the ENGINE's rule — even-odd (INVERT), over
//     the sub-paths the emitter keeps (`fillSubpathMask`, shape.ts) — then the path's
//     bounding quad is drawn where stencil != 0 and clears the count as it covers;
//   * the fragment shader is a literal port of the engine's `paletted_full.shader`:
//     gray level N = floor(r*15+.5) selects column N of palette row `u_row`; pixels whose
//     channels differ pass through; the result is `* cxmul + cxadd` (OBSERVED GLSL);
//   * bitmaps are uploaded premultiplied and un-premultiplied in the shader exactly like
//     `swf_lib.shader` (`rgb /= max(a, .001)`).
//
// Engine behaviours this renderer follows, all OBSERVED (src/core/art/engine-behaviour.ts is the one place they live;
// 2026-10-20 in the game, npm run test:artprobe, and 2026-10-21 in the decompiled display path, docs/engine-map.md
// "SWF loader and display path"): a nested sprite advances on its own clock (`clock`: frames since playback started,
// not the parent's frame); bitmap fills (type 0x41) are sampled LINEAR and clamped; the fill rule is even-odd per
// fill style; the PlaceObject cxform applies AFTER the palette remap (paletted_full.shader); every gradient pads
// (no reflect/repeat in the rasterizer or the shader). Enemy clips are drawn mirrored by the game (the preview does
// not). Still INFERRED: a bitmap fill's pixel space is the path's local space (bitmap px (u,v) sits at local (u,v));
// the emitter's fill matrix convention must match.

import {
  normalizePath,
  flattenSubpath,
  boundsOf,
  subpathBounds,
  unionBounds,
  multiply,
  apply,
  invert,
  IDENTITY,
} from "../../../src/core/art/geometry.ts";
import { parseFill, fillToRgba, parseColor } from "../../../src/core/art/scene.ts";
import { bakeSprite, bakeStage, labelList } from "../../../src/core/art/timeline.ts";
import { nestedFrame, ENGINE_DRAWING } from "../../../src/core/art/engine-behaviour.ts";
import { strokePolys } from "../../../src/core/art/stroke.ts";
import { fillSubpathMask } from "../../../src/core/art/shape.ts";
import { C2D_COMPOSITE } from "../../../src/core/art/effects.ts";
import { textRgba } from "../../../src/core/art/text.ts";
import { bitmapFillType } from "../../../src/core/art/raster.ts";
import { layoutTextPaths } from "../../../src/core/art/font.ts";
import type { SceneText } from "../../../src/core/art/text.ts";
import type { StrokeStyle } from "../../../src/core/art/stroke.ts";
import { gradientUnitMatrix, gradientFocal, rasterizeStops, resolveStops, swfSpread } from "../../../src/core/art/gradient.ts";
import type { Scene, Fill, SceneShape } from "../../../src/core/art/scene.ts";
import type { Mat, SubPath } from "../../../src/core/art/geometry.ts";
import type { BakedSprite, Cxform, Placement } from "../../../src/core/art/timeline.ts";

export type { Scene, Fill, Mat, SubPath, BakedSprite, Cxform, Placement };

export interface Bounds {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** 256 palette rows × 16 columns × [r, g, b] bytes — the rows of `textures/palette.png`. */
export type PaletteRows = Array<Array<[number, number, number]>>;

export interface PreviewTarget {
  id: string;
  kind: "sprite" | "shape" | "stage";
  frames: number;
}

export interface PreviewInfo {
  /** 'none' only after destroy() or when no context at all */
  backend: "webgl" | "canvas2d" | "none";
  /** frame count of the current target */
  frames: number;
  /** current frame (0-based) */
  frame: number;
  /** GL draw calls (or Canvas2D fill/stroke/drawImage calls) in the last render() */
  drawCalls: number;
  /** path fills (including strokes and mask shapes) in the last render() */
  fillsDrawn: number;
  /** how clipDepth masks are implemented on this backend */
  masks: "stencil" | "clip";
  /** masks beyond the supported nesting depth in the last render() (drawn unmasked) */
  maskOverflow: number;
  /** bitmap fills whose image has not been provided with setBitmap() */
  missingBitmaps: number;
  target: string | null;
  /** effective zoom (stage px → CSS px) */
  zoom: number;
  paletteRow: number;
  playing: boolean;
}

export interface Preview {
  /** an already-validated scene (validateScene().scene) */
  setScene(scene: Scene): void;
  /** a sprite id, a shape id, or "stage" (the main timeline) */
  setTarget(id: string): void;
  getTargets(): PreviewTarget[];
  getTarget(): string | null;
  /** null → identity ramp (gray passthrough) */
  setPalette(rows: PaletteRows | null): void;
  setPaletteRow(row: number): void;
  getPaletteRow(): number;
  setFrame(frame: number): void;
  getFrame(): number;
  getFrameCount(): number;
  getLabels(): Array<{ frame: number; label: string }>;
  play(): void;
  pause(): void;
  isPlaying(): boolean;
  setLoop(loop: boolean): void;
  getLoop(): boolean;
  step(delta: number): void;
  gotoLabel(name: string): boolean;
  /** bypass the palette remap (show the authored 16-level art) */
  setShowGray(show: boolean): void;
  getShowGray(): boolean;
  /** CSS colour, "checker", or null (transparent) */
  setBackground(bg: string | null): void;
  /** stage px → CSS px, or "fit" (re-fits on resize/target change) */
  setZoom(zoom: number | "fit"): void;
  getZoom(): number;
  /** stage coordinate shown at the canvas centre (locks zoom to its current numeric value) */
  setCenter(x: number, y: number): void;
  getCenter(): [number, number];
  /** re-read the canvas client size × devicePixelRatio */
  resize(): void;
  /** image for scene.bitmaps[id]; null removes it */
  setBitmap(id: string, image: TexImageSource | null): void;
  render(): void;
  destroy(): void;
  info(): PreviewInfo;
}

export interface PreviewOptions {
  /** human-readable backend/status messages */
  onStatus?: (status: string) => void;
  /** called whenever the current frame changes */
  onFrame?: (frame: number) => void;
  /** called when playback starts or stops (NOT on a visibility suspend, so the UI's play/pause stays truthful while off-screen) */
  onPlaying?: (playing: boolean) => void;
}

// ---- constants -------------------------------------------------------------------

const CHECKER_A = [0x1a / 255, 0x21 / 255, 0x2b / 255] as const;
const CHECKER_B = [0x14 / 255, 0x1a / 255, 0x22 / 255] as const;
const CHECKER_CELL_CSS = 8;
const MAX_MASK_LEVELS = 4; // stencil bits 0x80, 0x40, 0x20, 0x10; the rest hold winding counts
const MAX_NEST = 32;
const FLATTEN_TOL_CSS = 0.25;
const STAGE_KEY = "stage";

const VERT_SRC = `
attribute vec2 a_pos;
attribute vec2 a_uv;
uniform vec4 u_view;
varying vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_pos.x * u_view.x + u_view.z, a_pos.y * u_view.y + u_view.w, 0.0, 1.0);
}
`;

// Literal port of paletted_full.shader (+ swf_lib.shader's un-premultiply for bitmaps).
const FRAG_SRC = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D u_palette;
uniform sampler2D u_bitmap;
uniform vec4 u_color;
uniform vec4 u_cxmul;
uniform vec4 u_cxadd;
uniform float u_row;
uniform float u_showGray;
uniform float u_useBitmap;
uniform float u_focal;
uniform float u_spread;
uniform float u_bmMode;
uniform vec2 u_bmSize;
varying vec2 v_uv;
void main() {
  vec4 c = u_color;
  if (u_useBitmap > 1.5) {
    // gradient (2 linear, 3 radial): v_uv is the unit gradient space; t as gradientT() + applySpread() in gradient.ts
    float t;
    if (u_useBitmap < 2.5) {
      t = (v_uv.x + 1.0) * 0.5;
    } else {
      float dx = v_uv.x - u_focal;
      float b = 2.0 * u_focal * dx;
      float cc = dx * dx + v_uv.y * v_uv.y;
      float a1 = 1.0 - u_focal * u_focal;
      t = (b + sqrt(b * b + 4.0 * a1 * cc)) / (2.0 * a1);
    }
    if (u_spread < 0.5) t = clamp(t, 0.0, 1.0);
    else if (u_spread < 1.5) t = 1.0 - abs(mod(t, 2.0) - 1.0);
    else t = fract(t);
    vec4 gt = texture2D(u_bitmap, vec2((t * 255.0 + 0.5) / 256.0, 0.5));
    gt.rgb /= max(gt.a, .001);
    c = gt;
  } else if (u_useBitmap > 0.5) {
    // the fill type (raster.ts bitmapFillType, swf_lib.shader): 0x40 / 0x42 repeat = fract(uv); 0x42 / 0x43 pixel-snapped = the texel centre
    vec2 uv = v_uv;
    if (mod(u_bmMode, 2.0) < 0.5) uv = fract(uv);
    if (u_bmMode > 65.5) uv = (floor(uv * u_bmSize) + 0.5) / u_bmSize;
    vec4 t = texture2D(u_bitmap, uv);
    t.rgb /= max(t.a, .001);
    c = t;
  }
  vec4 pal = texture2D(u_palette, vec2((floor(c.r * 15.0 + 0.5) + 0.5) / 16.0, (u_row + 0.5) / 256.0));
  if (!(abs(c.r - c.g) < .001 && abs(c.r - c.b) < .001)) pal = c;
  if (u_showGray > 0.5) pal = c;
  gl_FragColor = vec4(pal.rgb, c.a) * u_cxmul + u_cxadd;
}
`;

const CHECKER_VERT_SRC = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;
const CHECKER_FRAG_SRC = `
precision mediump float;
uniform float u_cell;
uniform vec3 u_c0;
uniform vec3 u_c1;
void main() {
  vec2 c = floor(gl_FragCoord.xy / u_cell);
  float k = mod(c.x + c.y, 2.0);
  gl_FragColor = vec4(mix(u_c0, u_c1, k), 1.0);
}
`;

// ---- pure helpers -----------------------------------------------------------------

interface PreparedPath {
  /** normalized in shape-local space (path.transform applied) */
  subs: SubPath[];
  fill: Fill;
  fillRgba: Rgba | null;
  /** per sub-path: carries the fill in the SWF (shape.ts fillSubpathMask); the engine fills those even-odd */
  fillMask: boolean[];
  strokeRgba: Rgba | null;
  /** the stroke's parsed fill (a gradient stroke has strokeRgba null) */
  strokeFill: Fill | null;
  strokeWidth: number;
  strokeStyle: StrokeStyle;
  /** non-scaling stroke: the width is in stage px whatever the placement scale */
  strokeFixed: boolean;
  /** the path's own transform (bitmap pixel space → shape-local) */
  transform: Mat;
  bounds: Bounds | null;
}

interface PreparedShape {
  paths: PreparedPath[];
  bounds: Bounds | null;
}

/** Normalize a shape's paths once per scene (geometry.ts owns the interpretation). */
function prepareShape(shape: SceneShape): PreparedShape {
  const paths: PreparedPath[] = [];
  let bounds: Bounds | null = null;
  for (const p of shape.paths || []) {
    if (!p || typeof p.d !== "string") continue;
    const transform: Mat = p.transform && p.transform.length === 6 ? ([...p.transform] as Mat) : IDENTITY;
    let subs: SubPath[];
    try {
      subs = normalizePath(p.d, { matrix: transform });
    } catch {
      continue; // malformed path data: validation reports it; the preview skips it
    }
    const fill = parseFill(p.fill).fill;
    const strokeFill = p.stroke ? parseFill(p.stroke).fill : null;
    const strokeWidth = p.stroke && (p.strokeWidth ?? 0) > 0 ? (p.strokeWidth as number) : 0;
    const b = subpathBounds(subs);
    bounds = unionBounds(bounds, b);
    paths.push({
      subs,
      fill,
      fillRgba: fillToRgba(fill),
      fillMask: fill.kind === "none" ? subs.map(() => false) : fillSubpathMask(subs, p.fillRule),
      strokeRgba: strokeFill ? fillToRgba(strokeFill) : null,
      strokeFill,
      strokeWidth,
      strokeStyle: { cap: p.strokeCap || "round", join: p.strokeJoin || "round", miterLimit: p.miterLimit ?? 4 },
      strokeFixed: p.strokeScale === "none",
      transform,
      bounds: b,
    });
  }
  return { paths, bounds };
}

/** uniform scale estimate of a matrix (sqrt |det|) */
function matScale(m: Mat): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1e-6;
}

/**
 * Flatten a prepared path's sub-paths into stage-space polygons.
 * @param mat composed placement matrix @param tolLocal flatten tolerance in shape-local px
 * @returns flat polygons [x0,y0,x1,y1,...] (stage space)
 */
/** The engine's fill rule (OBSERVED: libtess2 TESS_WINDING_ODD baked into tessTesselate 0xa73bb0). */
const FILL_RULE: "nonzero" | "evenodd" = ENGINE_DRAWING.fillRule;

/** The flattened sub-paths that carry the fill (the engine fills exactly these, even-odd). */
function fillPolysOf(path: PreparedPath, polys: number[][]): number[][] {
  return polys.filter((_, i) => path.fillMask[i]);
}

function flattenPath(path: PreparedPath, mat: Mat, tolLocal: number): number[][] {
  const polys: number[][] = [];
  for (const sub of path.subs) {
    const flat = flattenSubpath(sub, tolLocal);
    const out: number[] = new Array(flat.length);
    for (let i = 0; i < flat.length; i += 2) {
      const x = flat[i]!;
      const y = flat[i + 1]!;
      out[i] = mat[0] * x + mat[2] * y + mat[4];
      out[i + 1] = mat[1] * x + mat[3] * y + mat[5];
    }
    polys.push(out);
  }
  return polys;
}

const TEXT_SCALE = 2;

/** Draw a scene text into a canvas at TEXT_SCALE (word-wrapped to its box, aligned like the HTML <p align>). */
function textCanvas(t: SceneText): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.ceil(t.width * TEXT_SCALE));
  cv.height = Math.max(1, Math.ceil(t.height * TEXT_SCALE));
  const c = cv.getContext("2d");
  if (!c) return null;
  const rgba = textRgba(t);
  c.scale(TEXT_SCALE, TEXT_SCALE);
  c.font = `${t.size}px "${t.font || "Peralta"}", Georgia, serif`;
  c.fillStyle = `rgba(${rgba.r},${rgba.g},${rgba.b},${rgba.a / 255})`;
  c.textBaseline = "top";
  const align = t.align || "center";
  c.textAlign = align === "center" ? "center" : align === "right" ? "right" : "left";
  const x = align === "center" ? t.width / 2 : align === "right" ? t.width : 0;
  const lines: string[] = [];
  for (const para of String(t.text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && c.measureText(next).width > t.width) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  const lh = t.size * 1.15;
  lines.forEach((ln, i) => c.fillText(ln, x, i * lh));
  return cv;
}

function polysBounds(polys: number[][]): Bounds | null {
  let b: Bounds | null = null;
  for (const p of polys) b = unionBounds(b, boundsOf(p));
  return b;
}

function transformBounds(b: Bounds, m: Mat): Bounds {
  const c = [apply(m, b.xmin, b.ymin), apply(m, b.xmax, b.ymin), apply(m, b.xmin, b.ymax), apply(m, b.xmax, b.ymax)] as const;
  return {
    xmin: Math.min(c[0][0], c[1][0], c[2][0], c[3][0]),
    ymin: Math.min(c[0][1], c[1][1], c[2][1], c[3][1]),
    xmax: Math.max(c[0][0], c[1][0], c[2][0], c[3][0]),
    ymax: Math.max(c[0][1], c[1][1], c[2][1], c[3][1]),
  };
}

/**
 * Compose colour transforms: child applied first, then parent.
 * mul = parent.mul * child.mul; add = parent.mul * child.add + parent.add.
 */
export function composeCxform(parent: Cxform | null, child: Cxform | null): Cxform | null {
  if (!child) return parent;
  if (!parent) return child;
  return {
    mul: parent.mul.map((v, i) => v * child.mul[i]!) as [number, number, number, number],
    add: parent.add.map((v, i) => parent.mul[i]! * child.add[i]! + v) as [number, number, number, number],
  };
}

/** Identity palette: column N → (17N, 17N, 17N) for every row. */
function identityPaletteBytes(): Uint8Array {
  const bytes = new Uint8Array(16 * 256 * 3);
  for (let row = 0; row < 256; row++) {
    for (let col = 0; col < 16; col++) {
      const o = (row * 16 + col) * 3;
      bytes[o] = bytes[o + 1] = bytes[o + 2] = col * 17;
    }
  }
  return bytes;
}

/** Pack palette rows into the 16×256 RGB texture bytes (missing entries keep the identity ramp). */
export function paletteBytes(rows: PaletteRows | null): Uint8Array {
  const bytes = identityPaletteBytes();
  if (!rows) return bytes;
  for (let row = 0; row < 256 && row < rows.length; row++) {
    const r = rows[row];
    if (!Array.isArray(r)) continue;
    for (let col = 0; col < 16 && col < r.length; col++) {
      const px = r[col];
      if (!Array.isArray(px) || px.length < 3) continue;
      const o = (row * 16 + col) * 3;
      bytes[o] = clampByte(px[0]);
      bytes[o + 1] = clampByte(px[1]);
      bytes[o + 2] = clampByte(px[2]);
    }
  }
  return bytes;
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(Number(v) || 0)));
}
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * CPU version of the fragment shader (Canvas2D fallback, swatches, tests).
 * @param c fill bytes @param pal 16×256×3 bytes
 * @returns r,g,b in 0..255 and a in 0..1
 */
export function remapColor(c: Rgba, cx: Cxform | null, pal: Uint8Array, row: number, showGray: boolean): [number, number, number, number] {
  let r = c.r / 255;
  let g = c.g / 255;
  let b = c.b / 255;
  const a = c.a / 255;
  const isGray = Math.abs(r - g) < 0.001 && Math.abs(r - b) < 0.001;
  if (isGray && !showGray) {
    const col = Math.max(0, Math.min(15, Math.floor(r * 15 + 0.5)));
    const o = (Math.max(0, Math.min(255, row | 0)) * 16 + col) * 3;
    r = pal[o]! / 255;
    g = pal[o + 1]! / 255;
    b = pal[o + 2]! / 255;
  }
  const mul: readonly number[] = cx ? cx.mul : [1, 1, 1, 1];
  const add: readonly number[] = cx ? cx.add : [0, 0, 0, 0];
  return [
    Math.round(clamp01(r * mul[0]! + add[0]!) * 255),
    Math.round(clamp01(g * mul[1]! + add[1]!) * 255),
    Math.round(clamp01(b * mul[2]! + add[2]!) * 255),
    clamp01(a * mul[3]! + add[3]!),
  ];
}

// ---- the preview ------------------------------------------------------------------

interface BitmapTexture {
  tex: WebGLTexture;
  width: number;
  height: number;
}

interface CoverSpec {
  color: Rgba;
  cx: Cxform | null;
  bitmap: (BitmapTexture & { inv: Mat; mode?: number }) | null;
  /** with bitmap = the stop strip (width = height = 1, inv → unit gradient space): 2 linear / 3 radial */
  grad?: { mode: 2 | 3; focal: number; spread: number };
}

interface GradientTexture {
  tex: WebGLTexture;
  /** unit gradient space → path-local px */
  unit: Mat;
  mode: 2 | 3;
  focal: number;
  spread: number;
}

/** Visitor-based depth walk shared by the GL, Canvas2D and bounds passes. */
interface Visitor {
  shape(shapeId: string, prep: PreparedShape, mat: Mat, cx: Cxform | null): void;
  /** start defining a mask; false = unsupported here (draw the mask shape normally) */
  beginMask(): boolean;
  /** mask shape(s) done; following shapes are masked */
  endMaskDef(): void;
  /** masked range done */
  endMask(): void;
}

/**
 * Create a preview renderer on `canvas`. Tries WebGL1 (stencil fill + palette shader);
 * falls back to Canvas2D with the same colour math done on the CPU.
 */
export function createPreview(canvas: HTMLCanvasElement, opts: PreviewOptions = {}): Preview {
  const onStatus = opts.onStatus || (() => {});
  const onFrame = opts.onFrame || (() => {});
  const onPlaying = opts.onPlaying || (() => {});

  // ---- state ----
  let scene: Scene | null = null;
  let targetId: string | null = null;
  let prepared = new Map<string, PreparedShape>();
  let bakedCache = new Map<string, BakedSprite>();
  let boundsCache = new Map<string, Bounds | null>();
  let palBytes: Uint8Array = identityPaletteBytes();
  let paletteRow = 0;
  let frame = 0;
  /** frames elapsed since playback started: nested sprites run on this clock (OBSERVED), not on their parent's frame */
  let clock = 0;
  /** the PlaceObject3 blend of the placement being drawn (nested placements inherit it unless they set their own) */
  let curBlend = "normal";
  let playing = false;
  let loop = true;
  // suspended = the rAF loop is paused because the canvas is off-screen or the tab
  // is hidden (Page Visibility + IntersectionObserver). `playing` (the user's intent)
  // is preserved across a suspend so playback resumes automatically when visible again.
  let suspended = false;
  let showGray = false;
  let background: string | null = "checker";
  let zoomMode: number | "fit" = "fit";
  let zoom = 1;
  let center: [number, number] = [0, 0];
  let destroyed = false;
  let rafId: number | null = null;
  let lastTime = 0;
  let acc = 0;
  let drawCalls = 0;
  let fillsDrawn = 0;
  let maskOverflow = 0;
  let missingBitmaps = 0;
  const bitmapSources = new Map<string, TexImageSource>();

  // ---- backend selection ----
  let gl: WebGLRenderingContext | null = null;
  let ctx2d: CanvasRenderingContext2D | null = null;
  try {
    const attrs: WebGLContextAttributes = { stencil: true, premultipliedAlpha: false, antialias: true, preserveDrawingBuffer: false, alpha: true };
    gl = (canvas.getContext("webgl", attrs) || canvas.getContext("experimental-webgl", attrs)) as WebGLRenderingContext | null;
  } catch {
    gl = null;
  }
  if (gl) {
    const bits = gl.getParameter(gl.STENCIL_BITS) as number;
    if (!(bits >= 8)) {
      // the stencil technique needs the stencil plane; fall back rather than draw garbage
      onStatus(`WebGL has ${bits} stencil bits (need 8); using Canvas2D fallback`);
      gl = null;
    }
  }
  if (!gl) {
    ctx2d = canvas.getContext("2d");
    if (ctx2d) onStatus("WebGL unavailable: Canvas2D fallback (palette remap on CPU, cxform exact for fills, alpha-only for bitmaps)");
    else onStatus("No WebGL and no Canvas2D context: nothing can be drawn");
  }

  // ---- GL resources ----
  let prog: WebGLProgram | null = null;
  let checkerProg: WebGLProgram | null = null;
  let vbo: WebGLBuffer | null = null;
  let palTex: WebGLTexture | null = null;
  const bitmapTex = new Map<string, BitmapTexture>();
  const gradTex = new Map<string, GradientTexture>();
  let U: Record<string, WebGLUniformLocation | null> = {};
  let UC: Record<string, WebGLUniformLocation | null> = {};
  let aPos = -1;
  let aUv = -1;
  let aPosC = -1;
  let scratch = new Float32Array(4096);

  function compile(g: WebGLRenderingContext, type: number, src: string): WebGLShader {
    const sh = g.createShader(type);
    if (!sh) throw new Error("createShader failed");
    g.shaderSource(sh, src);
    g.compileShader(sh);
    if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) {
      const log = g.getShaderInfoLog(sh) || "";
      g.deleteShader(sh);
      throw new Error(`shader compile failed: ${log}`);
    }
    return sh;
  }
  function link(g: WebGLRenderingContext, vs: string, fs: string): WebGLProgram {
    const p = g.createProgram();
    if (!p) throw new Error("createProgram failed");
    g.attachShader(p, compile(g, g.VERTEX_SHADER, vs));
    g.attachShader(p, compile(g, g.FRAGMENT_SHADER, fs));
    g.linkProgram(p);
    if (!g.getProgramParameter(p, g.LINK_STATUS)) throw new Error(`program link failed: ${g.getProgramInfoLog(p) || ""}`);
    return p;
  }

  function initGL(): void {
    const g = gl;
    if (!g) return;
    prog = link(g, VERT_SRC, FRAG_SRC);
    checkerProg = link(g, CHECKER_VERT_SRC, CHECKER_FRAG_SRC);
    U = {};
    for (const n of ["u_view", "u_palette", "u_bitmap", "u_color", "u_cxmul", "u_cxadd", "u_row", "u_showGray", "u_useBitmap", "u_focal", "u_spread", "u_bmMode", "u_bmSize"]) U[n] = g.getUniformLocation(prog, n);
    UC = {};
    for (const n of ["u_cell", "u_c0", "u_c1"]) UC[n] = g.getUniformLocation(checkerProg, n);
    aPos = g.getAttribLocation(prog, "a_pos");
    aUv = g.getAttribLocation(prog, "a_uv");
    aPosC = g.getAttribLocation(checkerProg, "a_pos");
    vbo = g.createBuffer();
    palTex = g.createTexture();
    uploadPalette();
    bitmapTex.clear();
    for (const [id, img] of bitmapSources) uploadBitmap(id, img);
    gradTex.clear();
    uploadGradients();
    g.disable(g.CULL_FACE);
    g.disable(g.DEPTH_TEST);
    g.enable(g.BLEND);
    // straight alpha into a straight-alpha (premultipliedAlpha:false) backbuffer
    g.blendFuncSeparate(g.SRC_ALPHA, g.ONE_MINUS_SRC_ALPHA, g.ONE, g.ONE_MINUS_SRC_ALPHA);
  }

  function uploadPalette(): void {
    const g = gl;
    if (!g || !palTex) return;
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, palTex);
    g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    g.pixelStorei(g.UNPACK_ALIGNMENT, 1);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGB, 16, 256, 0, g.RGB, g.UNSIGNED_BYTE, palBytes);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
  }

  function uploadBitmap(id: string, img: TexImageSource): void {
    const g = gl;
    if (!g) return;
    const old = bitmapTex.get(id);
    const tex = old ? old.tex : g.createTexture();
    if (!tex) return;
    const size = imageSize(img);
    g.activeTexture(g.TEXTURE1);
    g.bindTexture(g.TEXTURE_2D, tex);
    g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true); // engine atlas is premultiplied; the shader un-premultiplies
    g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, img);
    g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    // NPOT-safe (WebGL1): clamp + no mipmaps. LINEAR because the game filters bitmap fills (OBSERVED, engine-behaviour.ts):
    // the blend of a gray texel with a coloured neighbour then passes the remap `if` unremapped — in the game too.
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    bitmapTex.set(id, { tex, width: size[0], height: size[1] });
  }

  /**
   * scene.texts → a 2× offscreen canvas each (Canvas2D fillText with the game font's name first, a serif fallback when
   * it is not installed here), shown as a bitmap-filled box so the GL, Canvas2D and bounds paths all draw it unchanged.
   */
  function renderTexts(s: Scene): void {
    const all = s.texts || {};
    for (const [id, t] of Object.entries(all)) {
      if (!t || !(t.width > 0) || !(t.height > 0) || !(t.size > 0)) continue;
      // a text in one of the scene's own fonts is drawn from its glyph paths, as the game draws a DefineFont3 (font.ts)
      const sf = s.fonts && t.font ? s.fonts[t.font] : undefined;
      if (sf) {
        prepared.set(id, prepareShape({ paths: layoutTextPaths(sf, t) }));
        continue;
      }
      const cv = textCanvas(t);
      if (!cv) continue;
      const bid = `__text_${id}`;
      bitmapSources.set(bid, cv);
      if (gl) uploadBitmap(bid, cv);
      const shape: SceneShape = { paths: [{ d: `M0 0 L${cv.width} 0 L${cv.width} ${cv.height} L0 ${cv.height} Z`, fill: `bitmap:${bid}`, transform: [1 / TEXT_SCALE, 0, 0, 1 / TEXT_SCALE, -t.width / 2, -t.height / 2] }] };
      prepared.set(id, prepareShape(shape));
    }
  }

  /** One 256×1 premultiplied stop strip per scene gradient (rasterizeStops: the emitter's ratios and colours). */
  function uploadGradients(): void {
    const g = gl;
    if (!g) return;
    for (const t of gradTex.values()) g.deleteTexture(t.tex);
    gradTex.clear();
    const all = (scene && scene.gradients) || {};
    for (const id of Object.keys(all)) {
      const gd = all[id]!;
      if (!Array.isArray(gd.stops) || gd.stops.length < 2) continue;
      const strip = rasterizeStops(resolveStops(gd.stops), 256);
      for (let i = 0; i < strip.length; i += 4) {
        const a = strip[i + 3]! / 255;
        strip[i] = Math.round(strip[i]! * a);
        strip[i + 1] = Math.round(strip[i + 1]! * a);
        strip[i + 2] = Math.round(strip[i + 2]! * a);
      }
      const tex = g.createTexture();
      if (!tex) continue;
      g.activeTexture(g.TEXTURE1);
      g.bindTexture(g.TEXTURE_2D, tex);
      g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      g.pixelStorei(g.UNPACK_ALIGNMENT, 1);
      g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, 256, 1, 0, g.RGBA, g.UNSIGNED_BYTE, new Uint8Array(strip.buffer));
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
      // OBSERVED: the game pads every gradient (ENGINE_DRAWING.gradientSpread); the authored spread only reaches the SWF bits
      gradTex.set(id, { tex, unit: gradientUnitMatrix(gd), mode: gd.kind === "radial" ? 3 : 2, focal: gradientFocal(gd), spread: ENGINE_DRAWING.gradientSpread === "pad" ? 0 : swfSpread(gd.spread) });
    }
  }

  function imageSize(img: TexImageSource): [number, number] {
    const any = img as { naturalWidth?: number; videoWidth?: number; width?: number; naturalHeight?: number; videoHeight?: number; height?: number };
    const w = any.naturalWidth || any.videoWidth || any.width || 0;
    const h = any.naturalHeight || any.videoHeight || any.height || 0;
    return [Number(w) || 0, Number(h) || 0];
  }

  const onLost = (e: Event): void => {
    e.preventDefault();
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
    onStatus("WebGL context lost; waiting for restore");
  };
  const onRestored = (): void => {
    try {
      initGL();
      onStatus("WebGL context restored");
      if (playing) startLoop();
      else render();
    } catch (e) {
      onStatus(`WebGL restore failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  if (gl) {
    try {
      initGL();
      canvas.addEventListener("webglcontextlost", onLost, false);
      canvas.addEventListener("webglcontextrestored", onRestored, false);
      onStatus("WebGL1 renderer ready: stencil fill, paletted_full remap, stencil masks, straight-alpha blending");
    } catch (e) {
      onStatus(`WebGL init failed (${e instanceof Error ? e.message : String(e)}); using Canvas2D fallback`);
      gl = null;
      ctx2d = canvas.getContext("2d");
    }
  }

  // ---- visibility gating (don't burn CPU/GPU on an off-screen or backgrounded canvas) ----
  // The playback loop is paused whenever the canvas scrolls out of view, the panel is
  // detached (e.g. switching to Data mode or another right-panel tab), or the tab is
  // hidden. `playing` is kept intact so it resumes on its own when the canvas is seen again.
  let io: IntersectionObserver | null = null;
  let visHandler: (() => void) | null = null;
  const docHidden = (): boolean => typeof document !== "undefined" && document.hidden;
  if (typeof document !== "undefined") {
    visHandler = () => (docHidden() ? suspend() : resume());
    document.addEventListener("visibilitychange", visHandler);
  }
  if (typeof IntersectionObserver !== "undefined") {
    io = new IntersectionObserver((entries) => {
      const visible = entries.some((e) => e.isIntersecting);
      if (visible && !docHidden()) resume();
      else suspend();
    });
    io.observe(canvas);
  }

  // ---- scene / target plumbing ----

  function bakedFor(id: string): BakedSprite | null {
    if (!scene) return null;
    let b = bakedCache.get(id);
    if (b) return b;
    if (id === STAGE_KEY) b = bakeStage(scene);
    else if (scene.sprites[id]) b = bakeSprite(scene.sprites[id]!);
    else if (scene.shapes[id]) b = { frames: 1, placements: [[{ depth: 1, ref: id, matrix: IDENTITY, cxform: null, clipDepth: null, name: null }]], labels: [[]] };
    else return null;
    bakedCache.set(id, b);
    return b;
  }

  /** Frames a target animates over (the stage holds its single frame while its children loop). */
  function frameCountOf(id: string): number {
    if (!scene) return 1;
    if (id === STAGE_KEY) {
      let n = 1;
      for (const si of scene.stage_instances || []) {
        const sp = si && scene.sprites[si.ref];
        if (sp) n = Math.max(n, sp.frames | 0);
      }
      return n;
    }
    const sprite = scene.sprites[id];
    if (sprite) return Math.max(1, sprite.frames | 0);
    return 1;
  }

  function placementsAt(baked: BakedSprite, f: number): Placement[] {
    return baked.placements[Math.min(baked.frames - 1, Math.max(0, f))] || [];
  }

  /** @param f frame within this timeline */
  function walk(placements: Placement[], f: number, mat: Mat, cx: Cxform | null, depthLeft: number, v: Visitor, clk: number = f): void {
    let i = 0;
    while (i < placements.length) {
      const p = placements[i]!;
      // a placement with clipDepth masks the placements with depth in (depth, clipDepth]
      if (p.clipDepth !== null && p.clipDepth > p.depth && v.beginMask()) {
        drawPlacement(p, f, mat, cx, depthLeft, v, clk);
        v.endMaskDef();
        i++;
        while (i < placements.length && placements[i]!.depth <= p.clipDepth) {
          drawPlacement(placements[i]!, f, mat, cx, depthLeft, v, clk);
          i++;
        }
        v.endMask();
        continue;
      }
      drawPlacement(p, f, mat, cx, depthLeft, v, clk);
      i++;
    }
  }

  function drawPlacement(p: Placement, f: number, mat: Mat, cx: Cxform | null, depthLeft: number, v: Visitor, clk: number = f): void {
    const prevBlend = curBlend;
    if (p.blend && p.blend !== "normal") curBlend = p.blend;
    try {
      drawPlacementInner(p, f, mat, cx, depthLeft, v, clk);
    } finally {
      curBlend = prevBlend;
    }
  }

  function drawPlacementInner(p: Placement, f: number, mat: Mat, cx: Cxform | null, depthLeft: number, v: Visitor, clk: number): void {
    if (!scene) return;
    const m = multiply(mat, p.matrix);
    const c = composeCxform(cx, p.cxform);
    const prep = prepared.get(p.ref);
    if (prep) {
      v.shape(p.ref, prep, m, c);
      return;
    }
    if (scene.sprites[p.ref] && depthLeft > 0) {
      const b = bakedFor(p.ref);
      if (!b) return;
      // OBSERVED (engine-behaviour.ts): a nested sprite runs on its own clock, so a one-frame holder does not freeze it
      const cf = nestedFrame(clk, b.frames);
      walk(placementsAt(b, cf), cf, m, c, depthLeft - 1, v, clk);
    }
  }

  function walkTarget(id: string, f: number, v: Visitor, clk: number = f): void {
    const b = bakedFor(id);
    if (!b) return;
    walk(placementsAt(b, f), f, IDENTITY, null, MAX_NEST, v, clk);
  }

  /** Union bounds of a target across all of its frames (stage: the stage rect). */
  function targetBounds(id: string): Bounds | null {
    if (!scene) return null;
    if (boundsCache.has(id)) return boundsCache.get(id) || null;
    let out: Bounds | null = null;
    if (id === STAGE_KEY && scene.stage) {
      out = { xmin: 0, ymin: 0, xmax: scene.stage.width, ymax: scene.stage.height };
    } else {
      const n = frameCountOf(id);
      const v: Visitor = {
        shape: (_id, prep, mat) => {
          if (prep.bounds) out = unionBounds(out, transformBounds(prep.bounds, mat));
        },
        beginMask: () => false,
        endMaskDef: () => {},
        endMask: () => {},
      };
      for (let f = 0; f < n; f++) walkTarget(id, f, v);
    }
    boundsCache.set(id, out);
    return out;
  }

  // ---- view ----

  function cssSize(): [number, number] {
    const w = canvas.clientWidth || canvas.width || 1;
    const h = canvas.clientHeight || canvas.height || 1;
    return [w, h];
  }

  function updateFit(): void {
    if (zoomMode !== "fit") return;
    const [w, h] = cssSize();
    const b = targetId ? targetBounds(targetId) : null;
    if (!b || !(b.xmax > b.xmin) || !(b.ymax > b.ymin)) {
      zoom = 1;
      center = b ? [b.xmin, b.ymin] : [0, 0];
      return;
    }
    const pad = 0.9;
    zoom = Math.max(1e-3, Math.min((w * pad) / (b.xmax - b.xmin), (h * pad) / (b.ymax - b.ymin)));
    center = [(b.xmin + b.xmax) / 2, (b.ymin + b.ymax) / 2];
  }

  function resize(): number {
    const dpr = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
    const [w, h] = cssSize();
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    return dpr;
  }

  // ---- WebGL drawing ----

  const maskStack: { bits: number }[] = [];
  let definingMask = 0; // the stencil bit being defined, 0 when not defining a mask

  function activeMaskBits(): number {
    let bits = 0;
    for (const m of maskStack) bits |= m.bits;
    return bits;
  }
  function windingMask(): number {
    return 0xff >> maskStack.length;
  }

  /** @param n floats */
  function ensureScratch(n: number): void {
    if (scratch.length < n) {
      let len = scratch.length;
      while (len < n) len *= 2;
      scratch = new Float32Array(len);
    }
  }

  /**
   * Stencil fill of stage-space polygons, then the cover quad.
   * @param cover null while defining a mask
   */
  function glFill(polys: number[][], rule: "nonzero" | "evenodd", cover: CoverSpec | null): void {
    const g = gl;
    if (!g || !prog) return;
    const b = polysBounds(polys);
    if (!b) return;
    // pass 1: winding counts into the low stencil bits, colour off
    let total = 0;
    for (const p of polys) total += p.length / 2;
    ensureScratch(total * 4 + 16);
    let o = 0;
    const ranges: Array<[number, number]> = [];
    for (const p of polys) {
      const n = p.length / 2;
      if (n < 3) continue;
      ranges.push([o / 4, n]);
      for (let i = 0; i < p.length; i += 2) {
        scratch[o++] = p[i]!;
        scratch[o++] = p[i + 1]!;
        scratch[o++] = 0;
        scratch[o++] = 0;
      }
    }
    if (!ranges.length) return;
    fillsDrawn++;
    const outer = activeMaskBits() & ~definingMask;
    const wm = windingMask();
    g.colorMask(false, false, false, false);
    g.stencilMask(wm);
    if (outer) g.stencilFunc(g.EQUAL, outer, outer); // only inside the enclosing mask(s)
    else g.stencilFunc(g.ALWAYS, 0, 0xff);
    if (rule === "evenodd") {
      g.stencilOp(g.KEEP, g.KEEP, g.INVERT);
    } else {
      g.stencilOpSeparate(g.FRONT, g.KEEP, g.KEEP, g.INCR_WRAP);
      g.stencilOpSeparate(g.BACK, g.KEEP, g.KEEP, g.DECR_WRAP);
    }
    g.bufferData(g.ARRAY_BUFFER, scratch.subarray(0, o), g.DYNAMIC_DRAW);
    for (const [first, count] of ranges) {
      g.drawArrays(g.TRIANGLE_FAN, first, count);
      drawCalls++;
    }
    // pass 2: cover quad where winding != 0; clear (or promote to the mask bit) as we cover
    const padPx = 1 / Math.max(zoom, 1e-6);
    const x0 = b.xmin - padPx;
    const y0 = b.ymin - padPx;
    const x1 = b.xmax + padPx;
    const y1 = b.ymax + padPx;
    const corners = [x0, y0, x1, y0, x0, y1, x1, y1];
    o = 0;
    for (let i = 0; i < 8; i += 2) {
      scratch[o++] = corners[i]!;
      scratch[o++] = corners[i + 1]!;
      if (cover && cover.bitmap) {
        // stage → bitmap px through inverse(placement ∘ pathTransform); affine, so linear across the quad
        const uv = apply(cover.bitmap.inv, corners[i]!, corners[i + 1]!);
        scratch[o++] = uv[0] / Math.max(1, cover.bitmap.width);
        scratch[o++] = uv[1] / Math.max(1, cover.bitmap.height);
      } else {
        scratch[o++] = 0;
        scratch[o++] = 0;
      }
    }
    g.bufferData(g.ARRAY_BUFFER, scratch.subarray(0, o), g.DYNAMIC_DRAW);
    if (definingMask) {
      g.stencilFunc(g.NOTEQUAL, definingMask, wm);
      g.stencilMask(definingMask | wm);
      g.stencilOp(g.KEEP, g.KEEP, g.REPLACE); // set the mask bit, zero the winding bits
    } else {
      g.colorMask(true, true, true, true);
      g.stencilFunc(g.NOTEQUAL, 0, wm);
      g.stencilMask(wm);
      g.stencilOp(g.KEEP, g.KEEP, g.ZERO);
      if (cover) {
        const c = cover.color;
        g.uniform4f(U.u_color!, c.r / 255, c.g / 255, c.b / 255, c.a / 255);
        const mul: readonly number[] = cover.cx ? cover.cx.mul : [1, 1, 1, 1];
        const add: readonly number[] = cover.cx ? cover.cx.add : [0, 0, 0, 0];
        g.uniform4f(U.u_cxmul!, mul[0]!, mul[1]!, mul[2]!, mul[3]!);
        g.uniform4f(U.u_cxadd!, add[0]!, add[1]!, add[2]!, add[3]!);
        if (cover.bitmap) {
          g.activeTexture(g.TEXTURE1);
          g.bindTexture(g.TEXTURE_2D, cover.bitmap.tex);
          g.uniform1f(U.u_useBitmap!, cover.grad ? cover.grad.mode : 1);
          g.uniform1f(U.u_bmMode!, cover.bitmap.mode ?? 0x41);
          g.uniform2f(U.u_bmSize!, Math.max(1, cover.bitmap.width), Math.max(1, cover.bitmap.height));
          if (cover.grad) {
            g.uniform1f(U.u_focal!, cover.grad.focal);
            g.uniform1f(U.u_spread!, cover.grad.spread);
          }
        } else {
          g.uniform1f(U.u_useBitmap!, 0);
        }
      }
    }
    if (cover && !definingMask) blendModeFunc(g, curBlend);
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
    if (cover && !definingMask && curBlend !== "normal") blendModeFunc(g, "normal");
    drawCalls++;
    g.stencilMask(0xff);
  }

  /** GL approximation of a PlaceObject3 blend on straight-alpha output: add, multiply, screen; anything else as normal. */
  function blendModeFunc(g: WebGLRenderingContext, mode: string): void {
    if (mode === "add") g.blendFuncSeparate(g.SRC_ALPHA, g.ONE, g.ONE, g.ONE_MINUS_SRC_ALPHA);
    else if (mode === "multiply") g.blendFuncSeparate(g.DST_COLOR, g.ONE_MINUS_SRC_ALPHA, g.ONE, g.ONE_MINUS_SRC_ALPHA);
    else if (mode === "screen") g.blendFuncSeparate(g.ONE, g.ONE_MINUS_SRC_COLOR, g.ONE, g.ONE_MINUS_SRC_ALPHA);
    else g.blendFuncSeparate(g.SRC_ALPHA, g.ONE_MINUS_SRC_ALPHA, g.ONE, g.ONE_MINUS_SRC_ALPHA);
  }

  function glVisitor(): Visitor {
    const g = gl as WebGLRenderingContext;
    return {
      shape: (_id, prep, mat, cx) => {
        const scale = matScale(mat);
        const tol = Math.max(1e-3, Math.min(1e3, FLATTEN_TOL_CSS / (zoom * scale)));
        for (const path of prep.paths) {
          const polys = flattenPath(path, mat, tol);
          if (!polys.length) continue;
          const fillPolys = fillPolysOf(path, polys);
          if (path.fill.kind !== "none" && fillPolys.length) {
            if (definingMask) {
              glFill(fillPolys, FILL_RULE, null);
            } else if (path.fill.kind === "bitmap") {
              const bm = bitmapTex.get(path.fill.id);
              const inv = bm ? invert(multiply(mat, path.transform)) : null;
              if (bm && inv) {
                const mode = bitmapFillType(scene && scene.bitmaps ? scene.bitmaps[path.fill.id] : undefined);
                glFill(fillPolys, FILL_RULE, { color: { r: 255, g: 255, b: 255, a: 255 }, cx, bitmap: { tex: bm.tex, width: bm.width, height: bm.height, inv, mode } });
              } else if (!bm) {
                missingBitmaps++;
                glFill(fillPolys, FILL_RULE, { color: { r: 255, g: 0, b: 255, a: 128 }, cx, bitmap: null });
              }
            } else if (path.fill.kind === "gradient") {
              const gt = gradTex.get(path.fill.id);
              const inv = gt ? invert(multiply(multiply(mat, path.transform), gt.unit)) : null;
              if (gt && inv) {
                glFill(fillPolys, FILL_RULE, { color: { r: 255, g: 255, b: 255, a: 255 }, cx, bitmap: { tex: gt.tex, width: 1, height: 1, inv }, grad: { mode: gt.mode, focal: gt.focal, spread: gt.spread } });
              }
            } else if (path.fillRgba) {
              glFill(fillPolys, FILL_RULE, { color: path.fillRgba, cx, bitmap: null });
            }
          }
          const sg = path.strokeFill && path.strokeFill.kind === "gradient" ? gradTex.get(path.strokeFill.id) : undefined;
          if ((path.strokeRgba || sg) && path.strokeWidth > 0) {
            const w = Math.max(path.strokeWidth * (path.strokeFixed ? 1 : scale), 1 / Math.max(zoom, 1e-6));
            const sp = strokePolys(polys, path.subs.map((s) => s.closed), w, path.strokeStyle);
            const inv = sg ? invert(multiply(multiply(mat, path.transform), sg.unit)) : null;
            const cover: CoverSpec | null = definingMask ? null : sg && inv
              ? { color: { r: 255, g: 255, b: 255, a: 255 }, cx, bitmap: { tex: sg.tex, width: 1, height: 1, inv }, grad: { mode: sg.mode, focal: sg.focal, spread: sg.spread } }
              : path.strokeRgba ? { color: path.strokeRgba, cx, bitmap: null } : null;
            if (sp.length && (cover || definingMask)) glFill(sp, "nonzero", cover);
          }
        }
      },
      beginMask: () => {
        if (maskStack.length >= MAX_MASK_LEVELS) {
          maskOverflow++;
          return false;
        }
        const bits = 0x80 >> maskStack.length;
        maskStack.push({ bits });
        definingMask = bits;
        return true;
      },
      endMaskDef: () => {
        definingMask = 0;
      },
      endMask: () => {
        const m = maskStack.pop();
        if (!m) return;
        // drop this mask plane everywhere (gl.clear honours the stencil write mask)
        g.stencilMask(m.bits);
        g.clearStencil(0);
        g.clear(g.STENCIL_BUFFER_BIT);
        g.stencilMask(0xff);
      },
    };
  }

  function renderGL(): void {
    const g = gl;
    if (!g || !prog || !checkerProg) return;
    const dpr = resize();
    const W = canvas.width;
    const H = canvas.height;
    g.viewport(0, 0, W, H);
    g.disable(g.STENCIL_TEST);
    g.disable(g.SCISSOR_TEST);
    g.colorMask(true, true, true, true);
    g.stencilMask(0xff);
    g.clearStencil(0);
    if (background === "checker") {
      g.clearColor(0, 0, 0, 0);
      g.clear(g.COLOR_BUFFER_BIT | g.STENCIL_BUFFER_BIT);
      g.useProgram(checkerProg);
      g.bindBuffer(g.ARRAY_BUFFER, vbo);
      scratch.set([-1, -1, 1, -1, -1, 1, 1, 1], 0);
      g.bufferData(g.ARRAY_BUFFER, scratch.subarray(0, 8), g.DYNAMIC_DRAW);
      g.enableVertexAttribArray(aPosC);
      g.vertexAttribPointer(aPosC, 2, g.FLOAT, false, 8, 0);
      g.uniform1f(UC.u_cell!, CHECKER_CELL_CSS * dpr);
      g.uniform3f(UC.u_c0!, CHECKER_A[0], CHECKER_A[1], CHECKER_A[2]);
      g.uniform3f(UC.u_c1!, CHECKER_B[0], CHECKER_B[1], CHECKER_B[2]);
      g.disable(g.BLEND);
      g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
      drawCalls++;
      g.enable(g.BLEND);
      g.disableVertexAttribArray(aPosC);
    } else {
      const c = background ? parseColor(background) : null;
      if (c) g.clearColor(c.r / 255, c.g / 255, c.b / 255, c.a / 255);
      else g.clearColor(0, 0, 0, 0);
      g.clear(g.COLOR_BUFFER_BIT | g.STENCIL_BUFFER_BIT);
    }
    if (!scene || !targetId) return;
    // view: stage px → clip space (y down on stage, up in clip)
    const sx = (2 * zoom * dpr) / W;
    const sy = (-2 * zoom * dpr) / H;
    g.useProgram(prog);
    g.bindBuffer(g.ARRAY_BUFFER, vbo);
    g.enableVertexAttribArray(aPos);
    g.vertexAttribPointer(aPos, 2, g.FLOAT, false, 16, 0);
    if (aUv >= 0) {
      g.enableVertexAttribArray(aUv);
      g.vertexAttribPointer(aUv, 2, g.FLOAT, false, 16, 8);
    }
    g.uniform4f(U.u_view!, sx, sy, -center[0] * sx, -center[1] * sy);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, palTex);
    g.uniform1i(U.u_palette!, 0);
    g.uniform1i(U.u_bitmap!, 1);
    g.uniform1f(U.u_row!, paletteRow);
    g.uniform1f(U.u_showGray!, showGray ? 1 : 0);
    g.uniform1f(U.u_useBitmap!, 0);
    g.enable(g.STENCIL_TEST);
    maskStack.length = 0;
    definingMask = 0;
    walkTarget(targetId, frame, glVisitor(), clock);
    g.disable(g.STENCIL_TEST);
    g.colorMask(true, true, true, true);
  }

  // ---- Canvas2D drawing ----

  const remapCache = new Map<string, HTMLCanvasElement>();
  let checkerPattern: CanvasPattern | null = null;
  let checkerPatternDpr = 0;

  function asCanvasImage(src: TexImageSource): CanvasImageSource {
    return src as unknown as CanvasImageSource;
  }

  /** Bitmap with the palette remap applied per pixel (cached per id/row/showGray). */
  function remappedBitmap(id: string): CanvasImageSource | null {
    const src = bitmapSources.get(id);
    if (!src) return null;
    const key = `${id}|${paletteRow}|${showGray ? 1 : 0}`;
    const hit = remapCache.get(key);
    if (hit) return hit;
    const [w, h] = imageSize(src);
    if (!w || !h) return asCanvasImage(src);
    try {
      const off = document.createElement("canvas");
      off.width = w;
      off.height = h;
      const c = off.getContext("2d");
      if (!c) return asCanvasImage(src);
      c.drawImage(asCanvasImage(src), 0, 0);
      const img = c.getImageData(0, 0, w, h);
      const d = img.data;
      if (!showGray) {
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i]!;
          if (r === d[i + 1] && r === d[i + 2]) {
            const col = Math.floor((r / 255) * 15 + 0.5);
            const o = (paletteRow * 16 + col) * 3;
            d[i] = palBytes[o]!;
            d[i + 1] = palBytes[o + 1]!;
            d[i + 2] = palBytes[o + 2]!;
          }
        }
      }
      c.putImageData(img, 0, 0);
      remapCache.set(key, off);
      return off;
    } catch {
      return asCanvasImage(src); // cross-origin or unreadable: draw unremapped
    }
  }

  function c2dVisitor(): Visitor {
    const c = ctx2d as CanvasRenderingContext2D;
    const maskPaths: Path2D[] = [];
    let defining = false;
    /** @param closed null = close every sub-path */
    const toPath = (polys: number[][], closed: boolean[] | null): Path2D => {
      const p = new Path2D();
      polys.forEach((poly, i) => {
        if (poly.length < 4) return;
        p.moveTo(poly[0]!, poly[1]!);
        for (let k = 2; k < poly.length; k += 2) p.lineTo(poly[k]!, poly[k + 1]!);
        if (!closed || closed[i]) p.closePath();
      });
      return p;
    };
    const css = (rgba: [number, number, number, number]): string => `rgba(${rgba[0]},${rgba[1]},${rgba[2]},${rgba[3].toFixed(4)})`;
    return {
      shape: (_id, prep, mat, cx) => {
        // PlaceObject3 blend of the enclosing placement (approximated per fill, not on a group layer)
        c.globalCompositeOperation = (C2D_COMPOSITE[curBlend] || "source-over") as GlobalCompositeOperation;
        const scale = matScale(mat);
        const tol = Math.max(1e-3, Math.min(1e3, FLATTEN_TOL_CSS / (zoom * scale)));
        for (const path of prep.paths) {
          const polys = flattenPath(path, mat, tol);
          if (!polys.length) continue;
          const fillPolys = fillPolysOf(path, polys);
          const p2 = toPath(fillPolys, null);
          if (path.fill.kind !== "none" && fillPolys.length) {
            if (defining) {
              const mp = maskPaths[maskPaths.length - 1];
              if (mp) mp.addPath(p2);
            } else if (path.fill.kind === "bitmap") {
              const img = remappedBitmap(path.fill.id);
              if (img) {
                c.save();
                c.clip(p2, FILL_RULE);
                const fm = multiply(mat, path.transform);
                c.transform(fm[0], fm[1], fm[2], fm[3], fm[4], fm[5]);
                // cxform approximated for bitmaps: alpha multiplier only
                c.globalAlpha = clamp01(cx ? cx.mul[3] : 1);
                // the game filters 0x40 / 0x41 fills and pixel-snaps 0x42 / 0x43 (bitmapFillType); repeat tiles them
                const ft = bitmapFillType(scene && scene.bitmaps ? scene.bitmaps[path.fill.id] : undefined);
                c.imageSmoothingEnabled = ft < 0x42;
                if (ft % 2 === 0) {
                  const pat = c.createPattern(img as CanvasImageSource, "repeat");
                  if (pat) { c.fillStyle = pat; c.fillRect(-1e4, -1e4, 2e4, 2e4); }
                } else c.drawImage(img, 0, 0);
                c.restore();
                drawCalls++;
                fillsDrawn++;
              } else {
                missingBitmaps++;
                c.fillStyle = "rgba(255,0,255,0.5)";
                c.fill(p2, FILL_RULE);
                drawCalls++;
                fillsDrawn++;
              }
            } else if (path.fill.kind === "gradient") {
              const gd = scene && scene.gradients ? scene.gradients[path.fill.id] : undefined;
              if (gd && Array.isArray(gd.stops) && gd.stops.length >= 2) {
                // Canvas2D fallback: stops remapped as colours (the GL path remaps per pixel); spread is pad only
                const fm = multiply(multiply(mat, path.transform), gradientUnitMatrix(gd));
                c.save();
                c.clip(p2, FILL_RULE);
                c.transform(fm[0], fm[1], fm[2], fm[3], fm[4], fm[5]);
                const grad =gd.kind === "radial" ? c.createRadialGradient(gradientFocal(gd), 0, 0, 0, 0, 1) : c.createLinearGradient(-1, 0, 1, 0);
                for (const s of resolveStops(gd.stops)) grad.addColorStop(s.ratio / 255, css(remapColor(s.color, cx, palBytes, paletteRow, showGray)));
                c.fillStyle = grad;
                c.fillRect(-1e4, -1e4, 2e4, 2e4);
                c.restore();
                drawCalls++;
                fillsDrawn++;
              }
            } else if (path.fillRgba) {
              c.fillStyle = css(remapColor(path.fillRgba, cx, palBytes, paletteRow, showGray));
              c.fill(p2, FILL_RULE);
              drawCalls++;
              fillsDrawn++;
            }
          }
          if (path.strokeRgba && path.strokeWidth > 0 && !defining) {
            c.lineWidth = Math.max(path.strokeWidth * (path.strokeFixed ? 1 : scale), 1 / Math.max(zoom, 1e-6));
            c.lineJoin = path.strokeStyle.join || "round";
            c.miterLimit = path.strokeStyle.miterLimit ?? 4;
            c.lineCap = path.strokeStyle.cap === "butt" ? "butt" : path.strokeStyle.cap || "round";
            c.strokeStyle = css(remapColor(path.strokeRgba, cx, palBytes, paletteRow, showGray));
            c.stroke(toPath(polys, path.subs.map((s) => s.closed)));
            drawCalls++;
            fillsDrawn++;
          }
        }
      },
      beginMask: () => {
        maskPaths.push(new Path2D());
        defining = true;
        return true;
      },
      endMaskDef: () => {
        defining = false;
        const mp = maskPaths[maskPaths.length - 1];
        c.save();
        if (mp) c.clip(mp, "nonzero");
      },
      endMask: () => {
        maskPaths.pop();
        c.restore();
      },
    };
  }

  function render2D(): void {
    const c = ctx2d;
    if (!c) return;
    const dpr = resize();
    const W = canvas.width;
    const H = canvas.height;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = "source-over";
    c.globalAlpha = 1;
    c.clearRect(0, 0, W, H);
    if (background === "checker") {
      if (!checkerPattern || checkerPatternDpr !== dpr) {
        const cell = Math.max(1, Math.round(CHECKER_CELL_CSS * dpr));
        const tile = document.createElement("canvas");
        tile.width = tile.height = cell * 2;
        const tc = tile.getContext("2d");
        if (tc) {
          tc.fillStyle = `rgb(${Math.round(CHECKER_A[0] * 255)},${Math.round(CHECKER_A[1] * 255)},${Math.round(CHECKER_A[2] * 255)})`;
          tc.fillRect(0, 0, cell * 2, cell * 2);
          tc.fillStyle = `rgb(${Math.round(CHECKER_B[0] * 255)},${Math.round(CHECKER_B[1] * 255)},${Math.round(CHECKER_B[2] * 255)})`;
          tc.fillRect(cell, 0, cell, cell);
          tc.fillRect(0, cell, cell, cell);
        }
        checkerPattern = c.createPattern(tile, "repeat");
        checkerPatternDpr = dpr;
      }
      if (checkerPattern) {
        c.fillStyle = checkerPattern;
        c.fillRect(0, 0, W, H);
        drawCalls++;
      }
    } else if (background) {
      const col = parseColor(background);
      if (col) {
        c.fillStyle = `rgba(${col.r},${col.g},${col.b},${(col.a / 255).toFixed(4)})`;
        c.fillRect(0, 0, W, H);
        drawCalls++;
      }
    }
    if (!scene || !targetId) return;
    const s = zoom * dpr;
    c.setTransform(s, 0, 0, s, W / 2 - center[0] * s, H / 2 - center[1] * s);
    walkTarget(targetId, frame, c2dVisitor(), clock);
    c.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ---- playback ----

  /** report a play-state change to the owner (deduped) */
  function setPlaying(v: boolean): void {
    if (playing === v) return;
    playing = v;
    onPlaying(v);
  }
  // Pause the loop without clearing the user's play intent (off-screen / tab hidden).
  function suspend(): void {
    if (suspended) return;
    suspended = true;
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
  }
  function resume(): void {
    if (!suspended) return;
    suspended = false;
    if (destroyed) return;
    if (playing) startLoop();
    else render();
  }

  function tick(t: number): void {
    rafId = null;
    if (destroyed || !playing || suspended) return;
    const fps = (scene && scene.frameRate) || 60;
    const dur = 1000 / fps;
    if (lastTime) acc += Math.min(t - lastTime, dur * 10);
    lastTime = t;
    let changed = false;
    const n = getFrameCount();
    while (acc >= dur) {
      acc -= dur;
      if (frame + 1 >= n) {
        if (loop) {
          frame = 0;
          clock++;
          changed = true;
        } else {
          setPlaying(false); // stop on the last frame (tell the owner so its play/pause flips)
          acc = 0;
          break;
        }
      } else {
        frame++;
        clock++;
        changed = true;
      }
    }
    render();
    if (changed) onFrame(frame);
    if (playing) rafId = requestAnimationFrame(tick);
  }
  function startLoop(): void {
    if (rafId !== null || destroyed || suspended) return;
    lastTime = 0;
    acc = 0;
    rafId = requestAnimationFrame(tick);
  }

  // ---- API ----

  function getFrameCount(): number {
    return targetId ? frameCountOf(targetId) : 1;
  }

  function setFrame(n: number): void {
    const count = getFrameCount();
    const f = Math.max(0, Math.min(count - 1, Math.floor(Number(n) || 0)));
    clock = f;   // a scrub or step shows the state at that frame, children as if they had run since frame 0
    if (f !== frame) {
      frame = f;
      onFrame(frame);
    }
    render();
  }

  function render(): void {
    if (destroyed) return;
    drawCalls = 0;
    fillsDrawn = 0;
    maskOverflow = 0;
    missingBitmaps = 0;
    updateFit();
    if (gl) renderGL();
    else if (ctx2d) render2D();
  }

  const preview: Preview = {
    setScene(s) {
      scene = s;
      prepared = new Map();
      bakedCache = new Map();
      boundsCache = new Map();
      remapCache.clear();
      for (const id of Object.keys(s.shapes || {})) prepared.set(id, prepareShape(s.shapes[id]!));
      renderTexts(s);
      uploadGradients();
      if (s.preview && Number.isInteger(s.preview.palette)) paletteRow = Math.max(0, Math.min(255, s.preview.palette as number));
      const exists = targetId !== null && (targetId === STAGE_KEY || !!s.sprites[targetId] || !!s.shapes[targetId]);
      if (!exists) {
        const firstExport = Object.values(s.exports || {}).find((ref) => s.sprites[ref] || s.shapes[ref]);
        targetId = firstExport || Object.keys(s.sprites)[0] || Object.keys(s.shapes)[0] || STAGE_KEY;
      }
      if (frame >= getFrameCount()) {
        frame = 0;
        clock = 0;
        onFrame(0);
      }
      render();
    },
    setTarget(id) {
      if (!scene) {
        targetId = id;
        return;
      }
      if (id !== STAGE_KEY && !scene.sprites[id] && !scene.shapes[id]) {
        onStatus(`unknown target "${id}"`);
        return;
      }
      targetId = id;
      frame = 0;
      clock = 0;
      onFrame(0);
      render();
    },
    getTarget: () => targetId,
    getTargets() {
      if (!scene) return [];
      const out: PreviewTarget[] = [{ id: STAGE_KEY, kind: "stage", frames: frameCountOf(STAGE_KEY) }];
      for (const id of Object.keys(scene.sprites)) out.push({ id, kind: "sprite", frames: Math.max(1, scene.sprites[id]!.frames | 0) });
      for (const id of Object.keys(scene.shapes)) out.push({ id, kind: "shape", frames: 1 });
      return out;
    },
    setPalette(rows) {
      palBytes = paletteBytes(rows);
      remapCache.clear();
      if (gl) uploadPalette();
      render();
    },
    setPaletteRow(n) {
      paletteRow = Math.max(0, Math.min(255, Math.floor(Number(n) || 0)));
      render();
    },
    getPaletteRow: () => paletteRow,
    setFrame,
    getFrame: () => frame,
    getFrameCount,
    getLabels() {
      if (!scene || !targetId) return [];
      const b = bakedFor(targetId);
      return b ? labelList(b) : [];
    },
    play() {
      if (destroyed || playing) return;
      if (!loop && frame >= getFrameCount() - 1) {
        frame = 0;
        clock = 0;
        onFrame(0);
      }
      setPlaying(true);
      startLoop();
    },
    pause() {
      setPlaying(false);
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
    },
    isPlaying: () => playing,
    setLoop(v) {
      loop = !!v;
    },
    getLoop: () => loop,
    step(delta) {
      const n = getFrameCount();
      const d = Math.trunc(Number(delta) || 0);
      setFrame((((frame + d) % n) + n) % n);
    },
    gotoLabel(name) {
      const hit = preview.getLabels().find((l) => l.label === name);
      if (!hit) return false;
      setFrame(hit.frame);
      return true;
    },
    setShowGray(v) {
      showGray = !!v;
      render();
    },
    getShowGray: () => showGray,
    setBackground(bg) {
      background = bg;
      render();
    },
    setZoom(z) {
      if (z === "fit") {
        zoomMode = "fit";
      } else {
        const n = Number(z);
        if (!(n > 0)) return;
        zoomMode = n;
        zoom = n;
      }
      render();
    },
    getZoom: () => zoom,
    setCenter(x, y) {
      if (zoomMode === "fit") {
        updateFit();
        zoomMode = zoom; // lock the current numeric zoom so the centre sticks
      }
      center = [Number(x) || 0, Number(y) || 0];
      render();
    },
    getCenter: () => [center[0], center[1]],
    resize() {
      resize();
      render();
    },
    setBitmap(id, image) {
      if (!image) {
        bitmapSources.delete(id);
        const t = bitmapTex.get(id);
        if (t && gl) gl.deleteTexture(t.tex);
        bitmapTex.delete(id);
      } else {
        bitmapSources.set(id, image);
        if (gl) uploadBitmap(id, image);
      }
      for (const k of [...remapCache.keys()]) if (k.startsWith(id + "|")) remapCache.delete(k);
      render();
    },
    render,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      setPlaying(false);
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
      if (io) {
        io.disconnect();
        io = null;
      }
      if (visHandler && typeof document !== "undefined") document.removeEventListener("visibilitychange", visHandler);
      visHandler = null;
      canvas.removeEventListener("webglcontextlost", onLost, false);
      canvas.removeEventListener("webglcontextrestored", onRestored, false);
      if (gl) {
        for (const t of bitmapTex.values()) gl.deleteTexture(t.tex);
        bitmapTex.clear();
        if (palTex) gl.deleteTexture(palTex);
        for (const t of gradTex.values()) gl.deleteTexture(t.tex);
        gradTex.clear();
        if (vbo) gl.deleteBuffer(vbo);
        if (prog) gl.deleteProgram(prog);
        if (checkerProg) gl.deleteProgram(checkerProg);
        const lose = gl.getExtension("WEBGL_lose_context");
        if (lose) lose.loseContext();
      }
      gl = null;
      ctx2d = null;
      prepared.clear();
      bakedCache.clear();
      remapCache.clear();
    },
    info() {
      return {
        backend: destroyed ? "none" : gl ? "webgl" : ctx2d ? "canvas2d" : "none",
        frames: getFrameCount(),
        frame,
        drawCalls,
        fillsDrawn,
        masks: gl ? "stencil" : "clip",
        maskOverflow,
        missingBitmaps,
        target: targetId,
        zoom,
        paletteRow,
        playing,
      };
    },
  };
  return preview;
}
