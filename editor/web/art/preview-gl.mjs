// In-suite "as in-game" animated preview renderer for the art pipeline.
//
// Hand-written raw WebGL1 (Canvas2D fallback), zero dependencies, browser ESM, no
// build step. Independent of VanJS and of app state: `createPreview(canvas)` returns a
// plain object the panel drives. Nothing here touches the DOM at module top level, so
// the module is importable (and type-checked) outside a browser.
//
// Render model (docs/art-preview-plan.md §3, docs/art-pipeline.md §5):
//   * frames come from the SAME pure baking the SWF emitter uses (`timeline.mjs`), so
//     the pixels on screen are computed from the matrices/cxforms the SWF will carry;
//   * shapes are filled with the stencil technique (no triangulation): one TRIANGLE_FAN
//     per sub-path writes winding counts (nonzero: INCR_WRAP/DECR_WRAP by facing;
//     evenodd: INVERT), then the path's bounding quad is drawn where stencil != 0 and
//     clears the count as it covers;
//   * the fragment shader is a literal port of the engine's `paletted_full.shader`:
//     gray level N = floor(r*15+.5) selects column N of palette row `u_row`; pixels whose
//     channels differ pass through; the result is `* cxmul + cxadd` (OBSERVED GLSL);
//   * bitmaps are uploaded premultiplied and un-premultiplied in the shader exactly like
//     `swf_lib.shader` (`rgb /= max(a, .001)`).
//
// INFERRED engine behaviours this renderer relies on (not verified in-engine):
//   * nested sprite frame = parent frame mod child.frames (Flash default looping);
//   * PlaceObject2 cxform applies AFTER the palette remap (as the shader's
//     `* color_xform[0] + color_xform[1]` suggests);
//   * bitmap fills are sampled NEAREST and clamped at their edges, like a Flash
//     "clipped bitmap" fill (the engine's atlas sampling mode is not observed);
//   * a bitmap fill's pixel space is the path's local space (bitmap px (u,v) sits at
//     local (u,v)); the emitter's fill matrix convention must match.

import {
  normalizePath,
  flattenSubpath,
  boundsOf,
  subpathBounds,
  unionBounds,
  multiply,
  apply,
  invert,
  signedArea,
  IDENTITY,
} from "../../src/core/art/geometry.mjs";
import { parseFill, fillToRgba, parseColor } from "../../src/core/art/scene.mjs";
import { bakeSprite, bakeStage, labelList } from "../../src/core/art/timeline.mjs";

/** @typedef {import('../../src/core/art/scene.mjs').Scene} Scene */
/** @typedef {import('../../src/core/art/scene.mjs').Fill} Fill */
/** @typedef {import('../../src/core/art/geometry.mjs').Mat} Mat */
/** @typedef {import('../../src/core/art/geometry.mjs').SubPath} SubPath */
/** @typedef {import('../../src/core/art/timeline.mjs').BakedSprite} BakedSprite */
/** @typedef {import('../../src/core/art/timeline.mjs').Cxform} Cxform */
/** @typedef {import('../../src/core/art/timeline.mjs').Placement} Placement */

/** @typedef {{ xmin: number, ymin: number, xmax: number, ymax: number }} Bounds */
/** @typedef {{ r: number, g: number, b: number, a: number }} Rgba */

/**
 * 256 palette rows × 16 columns × [r, g, b] bytes — the rows of `textures/palette.png`.
 * @typedef {Array<Array<[number, number, number]>>} PaletteRows
 */

/** @typedef {{ id: string, kind: 'sprite' | 'shape' | 'stage', frames: number }} PreviewTarget */

/**
 * @typedef {Object} PreviewInfo
 * @property {'webgl' | 'canvas2d' | 'none'} backend   'none' only after destroy() or when no context at all
 * @property {number} frames                            frame count of the current target
 * @property {number} frame                             current frame (0-based)
 * @property {number} drawCalls                         GL draw calls (or Canvas2D fill/stroke/drawImage calls) in the last render()
 * @property {number} fillsDrawn                        path fills (including strokes and mask shapes) in the last render()
 * @property {'stencil' | 'clip'} masks                 how clipDepth masks are implemented on this backend
 * @property {number} maskOverflow                      masks beyond the supported nesting depth in the last render() (drawn unmasked)
 * @property {number} missingBitmaps                    bitmap fills whose image has not been provided with setBitmap()
 * @property {string | null} target
 * @property {number} zoom                              effective zoom (stage px → CSS px)
 * @property {number} paletteRow
 * @property {boolean} playing
 */

/**
 * @typedef {Object} Preview
 * @property {(scene: Scene) => void} setScene                an already-validated scene (validateScene().scene)
 * @property {(id: string) => void} setTarget                a sprite id, a shape id, or "stage" (the main timeline)
 * @property {() => PreviewTarget[]} getTargets
 * @property {() => string | null} getTarget
 * @property {(rows: PaletteRows | null) => void} setPalette null → identity ramp (gray passthrough)
 * @property {(row: number) => void} setPaletteRow
 * @property {() => number} getPaletteRow
 * @property {(frame: number) => void} setFrame
 * @property {() => number} getFrame
 * @property {() => number} getFrameCount
 * @property {() => Array<{ frame: number, label: string }>} getLabels
 * @property {() => void} play
 * @property {() => void} pause
 * @property {() => boolean} isPlaying
 * @property {(loop: boolean) => void} setLoop
 * @property {() => boolean} getLoop
 * @property {(delta: number) => void} step
 * @property {(name: string) => boolean} gotoLabel
 * @property {(show: boolean) => void} setShowGray         bypass the palette remap (show the authored 16-level art)
 * @property {() => boolean} getShowGray
 * @property {(bg: string | null) => void} setBackground   CSS colour, "checker", or null (transparent)
 * @property {(zoom: number | 'fit') => void} setZoom       stage px → CSS px, or "fit" (re-fits on resize/target change)
 * @property {() => number} getZoom
 * @property {(x: number, y: number) => void} setCenter    stage coordinate shown at the canvas centre (locks zoom to its current numeric value)
 * @property {() => [number, number]} getCenter
 * @property {() => void} resize                           re-read the canvas client size × devicePixelRatio
 * @property {(id: string, image: TexImageSource | null) => void} setBitmap   image for scene.bitmaps[id]; null removes it
 * @property {() => void} render
 * @property {() => void} destroy
 * @property {() => PreviewInfo} info
 */

/**
 * @typedef {Object} PreviewOptions
 * @property {(status: string) => void} [onStatus]   human-readable backend/status messages
 * @property {(frame: number) => void} [onFrame]     called whenever the current frame changes
 * @property {(playing: boolean) => void} [onPlaying] called when playback starts or stops (NOT on a visibility suspend, so the UI's play/pause stays truthful while off-screen)
 */

// ---- constants -------------------------------------------------------------------

const CHECKER_A = [0x1a / 255, 0x21 / 255, 0x2b / 255];
const CHECKER_B = [0x14 / 255, 0x1a / 255, 0x22 / 255];
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
varying vec2 v_uv;
void main() {
  vec4 c = u_color;
  if (u_useBitmap > 0.5) {
    vec4 t = texture2D(u_bitmap, v_uv);
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

/**
 * @typedef {Object} PreparedPath
 * @property {SubPath[]} subs            normalized in shape-local space (path.transform applied)
 * @property {Fill} fill
 * @property {Rgba | null} fillRgba
 * @property {'nonzero' | 'evenodd'} fillRule
 * @property {Rgba | null} strokeRgba
 * @property {number} strokeWidth
 * @property {Mat} transform             the path's own transform (bitmap pixel space → shape-local)
 * @property {Bounds | null} bounds
 */

/** @typedef {{ paths: PreparedPath[], bounds: Bounds | null }} PreparedShape */

/**
 * Normalize a shape's paths once per scene (geometry.mjs owns the interpretation).
 * @param {import('../../src/core/art/scene.mjs').SceneShape} shape
 * @returns {PreparedShape}
 */
function prepareShape(shape) {
  /** @type {PreparedPath[]} */
  const paths = [];
  /** @type {Bounds | null} */
  let bounds = null;
  for (const p of shape.paths || []) {
    if (!p || typeof p.d !== "string") continue;
    /** @type {Mat} */
    const transform = p.transform && p.transform.length === 6 ? /** @type {Mat} */ ([...p.transform]) : IDENTITY;
    /** @type {SubPath[]} */
    let subs;
    try {
      subs = normalizePath(p.d, { matrix: transform });
    } catch {
      continue; // malformed path data: validation reports it; the preview skips it
    }
    const fill = parseFill(p.fill).fill;
    const strokeFill = p.stroke ? parseFill(p.stroke).fill : null;
    const strokeWidth = p.stroke && (p.strokeWidth ?? 0) > 0 ? /** @type {number} */ (p.strokeWidth) : 0;
    const b = subpathBounds(subs);
    bounds = unionBounds(bounds, b);
    paths.push({
      subs,
      fill,
      fillRgba: fillToRgba(fill),
      fillRule: p.fillRule === "evenodd" ? "evenodd" : "nonzero",
      strokeRgba: strokeFill ? fillToRgba(strokeFill) : null,
      strokeWidth,
      transform,
      bounds: b,
    });
  }
  return { paths, bounds };
}

/** @param {Mat} m uniform scale estimate of a matrix (sqrt |det|) */
function matScale(m) {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1e-6;
}

/**
 * Flatten a prepared path's sub-paths into stage-space polygons.
 * @param {PreparedPath} path @param {Mat} mat composed placement matrix @param {number} tolLocal flatten tolerance in shape-local px
 * @returns {number[][]} flat polygons [x0,y0,x1,y1,...] (stage space)
 */
function flattenPath(path, mat, tolLocal) {
  /** @type {number[][]} */
  const polys = [];
  for (const sub of path.subs) {
    const flat = flattenSubpath(sub, tolLocal);
    const out = new Array(flat.length);
    for (let i = 0; i < flat.length; i += 2) {
      const x = flat[i];
      const y = flat[i + 1];
      out[i] = mat[0] * x + mat[2] * y + mat[4];
      out[i + 1] = mat[1] * x + mat[3] * y + mat[5];
    }
    polys.push(out);
  }
  return polys;
}

/**
 * Stroke polygons (one quad per segment + a round join octagon per vertex), all with the
 * same orientation so one nonzero stencil pass covers their union exactly once.
 * @param {number[][]} polys stage-space polylines @param {boolean[]} closed @param {number} width stage px
 * @returns {number[][]}
 */
function strokePolys(polys, closed, width) {
  /** @type {number[][]} */
  const out = [];
  const h = width / 2;
  for (let k = 0; k < polys.length; k++) {
    const pts = polys[k];
    const n = pts.length / 2;
    if (n < 2) continue;
    const segs = closed[k] ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      const x0 = pts[2 * i];
      const y0 = pts[2 * i + 1];
      const x1 = pts[2 * j];
      const y1 = pts[2 * j + 1];
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      const nx = (-dy / len) * h;
      const ny = (dx / len) * h;
      out.push(orientNegative([x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny]));
    }
    // round joins (and round caps on open paths) as octagons
    for (let i = 0; i < n; i++) {
      const cx = pts[2 * i];
      const cy = pts[2 * i + 1];
      const oct = [];
      for (let s = 0; s < 8; s++) {
        const a = (s / 8) * Math.PI * 2;
        oct.push(cx + Math.cos(a) * h, cy + Math.sin(a) * h);
      }
      out.push(orientNegative(oct));
    }
  }
  return out;
}

/** @param {number[]} poly */
function orientNegative(poly) {
  if (signedArea(poly) > 0) {
    const n = poly.length / 2;
    const rev = new Array(poly.length);
    for (let i = 0; i < n; i++) {
      rev[2 * i] = poly[2 * (n - 1 - i)];
      rev[2 * i + 1] = poly[2 * (n - 1 - i) + 1];
    }
    return rev;
  }
  return poly;
}

/** @param {number[][]} polys @returns {Bounds | null} */
function polysBounds(polys) {
  /** @type {Bounds | null} */
  let b = null;
  for (const p of polys) b = unionBounds(b, boundsOf(p));
  return b;
}

/** @param {Bounds} b @param {Mat} m @returns {Bounds} */
function transformBounds(b, m) {
  const c = [apply(m, b.xmin, b.ymin), apply(m, b.xmax, b.ymin), apply(m, b.xmin, b.ymax), apply(m, b.xmax, b.ymax)];
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
 * @param {Cxform | null} parent @param {Cxform | null} child @returns {Cxform | null}
 */
export function composeCxform(parent, child) {
  if (!child) return parent;
  if (!parent) return child;
  return {
    mul: /** @type {[number, number, number, number]} */ (parent.mul.map((v, i) => v * child.mul[i])),
    add: /** @type {[number, number, number, number]} */ (parent.add.map((v, i) => parent.mul[i] * child.add[i] + v)),
  };
}

/** Identity palette: column N → (17N, 17N, 17N) for every row. @returns {Uint8Array} */
function identityPaletteBytes() {
  const bytes = new Uint8Array(16 * 256 * 3);
  for (let row = 0; row < 256; row++) {
    for (let col = 0; col < 16; col++) {
      const o = (row * 16 + col) * 3;
      bytes[o] = bytes[o + 1] = bytes[o + 2] = col * 17;
    }
  }
  return bytes;
}

/**
 * Pack palette rows into the 16×256 RGB texture bytes (missing entries keep the identity ramp).
 * @param {PaletteRows | null} rows @returns {Uint8Array}
 */
export function paletteBytes(rows) {
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

/** @param {number} v */
function clampByte(v) {
  return Math.max(0, Math.min(255, Math.round(Number(v) || 0)));
}
/** @param {number} v */
function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

/**
 * CPU version of the fragment shader (Canvas2D fallback, swatches, tests).
 * @param {Rgba} c fill bytes @param {Cxform | null} cx @param {Uint8Array} pal 16×256×3 bytes @param {number} row @param {boolean} showGray
 * @returns {[number, number, number, number]} r,g,b in 0..255 and a in 0..1
 */
export function remapColor(c, cx, pal, row, showGray) {
  let r = c.r / 255;
  let g = c.g / 255;
  let b = c.b / 255;
  const a = c.a / 255;
  const isGray = Math.abs(r - g) < 0.001 && Math.abs(r - b) < 0.001;
  if (isGray && !showGray) {
    const col = Math.max(0, Math.min(15, Math.floor(r * 15 + 0.5)));
    const o = (Math.max(0, Math.min(255, row | 0)) * 16 + col) * 3;
    r = pal[o] / 255;
    g = pal[o + 1] / 255;
    b = pal[o + 2] / 255;
  }
  const mul = cx ? cx.mul : [1, 1, 1, 1];
  const add = cx ? cx.add : [0, 0, 0, 0];
  return [
    Math.round(clamp01(r * mul[0] + add[0]) * 255),
    Math.round(clamp01(g * mul[1] + add[1]) * 255),
    Math.round(clamp01(b * mul[2] + add[2]) * 255),
    clamp01(a * mul[3] + add[3]),
  ];
}

// ---- the preview ------------------------------------------------------------------

/**
 * Create a preview renderer on `canvas`. Tries WebGL1 (stencil fill + palette shader);
 * falls back to Canvas2D with the same colour math done on the CPU.
 * @param {HTMLCanvasElement} canvas
 * @param {PreviewOptions} [opts]
 * @returns {Preview}
 */
export function createPreview(canvas, opts = {}) {
  const onStatus = opts.onStatus || (() => {});
  const onFrame = opts.onFrame || (() => {});
  const onPlaying = opts.onPlaying || (() => {});

  // ---- state ----
  /** @type {Scene | null} */
  let scene = null;
  /** @type {string | null} */
  let targetId = null;
  /** @type {Map<string, PreparedShape>} */
  let prepared = new Map();
  /** @type {Map<string, BakedSprite>} */
  let bakedCache = new Map();
  /** @type {Map<string, Bounds | null>} */
  let boundsCache = new Map();
  /** @type {Uint8Array} */
  let palBytes = identityPaletteBytes();
  let paletteRow = 0;
  let frame = 0;
  let playing = false;
  let loop = true;
  // suspended = the rAF loop is paused because the canvas is off-screen or the tab
  // is hidden (Page Visibility + IntersectionObserver). `playing` (the user's intent)
  // is preserved across a suspend so playback resumes automatically when visible again.
  let suspended = false;
  let showGray = false;
  /** @type {string | null} */
  let background = "checker";
  /** @type {number | 'fit'} */
  let zoomMode = "fit";
  let zoom = 1;
  let center = /** @type {[number, number]} */ ([0, 0]);
  let destroyed = false;
  /** @type {number | null} */
  let rafId = null;
  let lastTime = 0;
  let acc = 0;
  let drawCalls = 0;
  let fillsDrawn = 0;
  let maskOverflow = 0;
  let missingBitmaps = 0;
  /** @type {Map<string, TexImageSource>} */
  const bitmapSources = new Map();

  // ---- backend selection ----
  /** @type {WebGLRenderingContext | null} */
  let gl = null;
  /** @type {CanvasRenderingContext2D | null} */
  let ctx2d = null;
  try {
    const attrs = { stencil: true, premultipliedAlpha: false, antialias: true, preserveDrawingBuffer: false, alpha: true };
    gl = /** @type {WebGLRenderingContext | null} */ (canvas.getContext("webgl", attrs) || canvas.getContext("experimental-webgl", attrs));
  } catch {
    gl = null;
  }
  if (gl) {
    const bits = gl.getParameter(gl.STENCIL_BITS);
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
  /** @type {WebGLProgram | null} */
  let prog = null;
  /** @type {WebGLProgram | null} */
  let checkerProg = null;
  /** @type {WebGLBuffer | null} */
  let vbo = null;
  /** @type {WebGLTexture | null} */
  let palTex = null;
  /** @type {Map<string, { tex: WebGLTexture, width: number, height: number }>} */
  const bitmapTex = new Map();
  /** @type {Record<string, WebGLUniformLocation | null>} */
  let U = {};
  /** @type {Record<string, WebGLUniformLocation | null>} */
  let UC = {};
  let aPos = -1;
  let aUv = -1;
  let aPosC = -1;
  let scratch = new Float32Array(4096);

  /**
   * @param {WebGLRenderingContext} g @param {number} type @param {string} src
   */
  function compile(g, type, src) {
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
  /** @param {WebGLRenderingContext} g @param {string} vs @param {string} fs */
  function link(g, vs, fs) {
    const p = g.createProgram();
    if (!p) throw new Error("createProgram failed");
    g.attachShader(p, compile(g, g.VERTEX_SHADER, vs));
    g.attachShader(p, compile(g, g.FRAGMENT_SHADER, fs));
    g.linkProgram(p);
    if (!g.getProgramParameter(p, g.LINK_STATUS)) throw new Error(`program link failed: ${g.getProgramInfoLog(p) || ""}`);
    return p;
  }

  function initGL() {
    const g = gl;
    if (!g) return;
    prog = link(g, VERT_SRC, FRAG_SRC);
    checkerProg = link(g, CHECKER_VERT_SRC, CHECKER_FRAG_SRC);
    U = {};
    for (const n of ["u_view", "u_palette", "u_bitmap", "u_color", "u_cxmul", "u_cxadd", "u_row", "u_showGray", "u_useBitmap"]) U[n] = g.getUniformLocation(prog, n);
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
    g.disable(g.CULL_FACE);
    g.disable(g.DEPTH_TEST);
    g.enable(g.BLEND);
    // straight alpha into a straight-alpha (premultipliedAlpha:false) backbuffer
    g.blendFuncSeparate(g.SRC_ALPHA, g.ONE_MINUS_SRC_ALPHA, g.ONE, g.ONE_MINUS_SRC_ALPHA);
  }

  function uploadPalette() {
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

  /** @param {string} id @param {TexImageSource} img */
  function uploadBitmap(id, img) {
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
    // NPOT-safe (WebGL1): clamp + no mipmaps. NEAREST keeps authored texels exact: linear
    // filtering blends a gray texel with a coloured neighbour into a non-gray value that
    // the remap `if` then passes through (observed with ANGLE/SwiftShader).
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    bitmapTex.set(id, { tex, width: size[0], height: size[1] });
  }

  /** @param {TexImageSource} img @returns {[number, number]} */
  function imageSize(img) {
    const any = /** @type {any} */ (img);
    const w = any.naturalWidth || any.videoWidth || any.width || 0;
    const h = any.naturalHeight || any.videoHeight || any.height || 0;
    return [Number(w) || 0, Number(h) || 0];
  }

  /** @param {Event} e */
  const onLost = (e) => {
    e.preventDefault();
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
    onStatus("WebGL context lost; waiting for restore");
  };
  const onRestored = () => {
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
  /** @type {IntersectionObserver | null} */
  let io = null;
  /** @type {(() => void) | null} */
  let visHandler = null;
  const docHidden = () => typeof document !== "undefined" && document.hidden;
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

  /** @param {string} id @returns {BakedSprite | null} */
  function bakedFor(id) {
    if (!scene) return null;
    let b = bakedCache.get(id);
    if (b) return b;
    if (id === STAGE_KEY) b = bakeStage(scene);
    else if (scene.sprites[id]) b = bakeSprite(scene.sprites[id]);
    else if (scene.shapes[id]) b = { frames: 1, placements: [[{ depth: 1, ref: id, matrix: IDENTITY, cxform: null, clipDepth: null, name: null }]], labels: [[]] };
    else return null;
    bakedCache.set(id, b);
    return b;
  }

  /** Frames a target animates over (the stage holds its single frame while its children loop). */
  function frameCountOf(/** @type {string} */ id) {
    if (!scene) return 1;
    if (id === STAGE_KEY) {
      let n = 1;
      for (const si of scene.stage_instances || []) {
        const sp = si && scene.sprites[si.ref];
        if (sp) n = Math.max(n, sp.frames | 0);
      }
      return n;
    }
    if (scene.sprites[id]) return Math.max(1, scene.sprites[id].frames | 0);
    return 1;
  }

  /** @param {BakedSprite} baked @param {number} f */
  function placementsAt(baked, f) {
    return baked.placements[Math.min(baked.frames - 1, Math.max(0, f))] || [];
  }

  /**
   * Visitor-based depth walk shared by the GL, Canvas2D and bounds passes.
   * @typedef {Object} Visitor
   * @property {(shapeId: string, prep: PreparedShape, mat: Mat, cx: Cxform | null) => void} shape
   * @property {() => boolean} beginMask     start defining a mask; false = unsupported here (draw the mask shape normally)
   * @property {() => void} endMaskDef       mask shape(s) done; following shapes are masked
   * @property {() => void} endMask          masked range done
   */

  /**
   * @param {Placement[]} placements @param {number} f frame within this timeline @param {Mat} mat @param {Cxform | null} cx @param {number} depthLeft @param {Visitor} v
   */
  function walk(placements, f, mat, cx, depthLeft, v) {
    let i = 0;
    while (i < placements.length) {
      const p = placements[i];
      // a placement with clipDepth masks the placements with depth in (depth, clipDepth]
      if (p.clipDepth !== null && p.clipDepth > p.depth && v.beginMask()) {
        drawPlacement(p, f, mat, cx, depthLeft, v);
        v.endMaskDef();
        i++;
        while (i < placements.length && placements[i].depth <= p.clipDepth) {
          drawPlacement(placements[i], f, mat, cx, depthLeft, v);
          i++;
        }
        v.endMask();
        continue;
      }
      drawPlacement(p, f, mat, cx, depthLeft, v);
      i++;
    }
  }

  /**
   * @param {Placement} p @param {number} f @param {Mat} mat @param {Cxform | null} cx @param {number} depthLeft @param {Visitor} v
   */
  function drawPlacement(p, f, mat, cx, depthLeft, v) {
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
      // INFERRED (engine): a nested sprite shows frame (parent frame mod its own frame count),
      // i.e. Flash's default looping child timeline. Not verified against glaiel::swf.
      const cf = ((f % b.frames) + b.frames) % b.frames;
      walk(placementsAt(b, cf), cf, m, c, depthLeft - 1, v);
    }
  }

  /** @param {string} id @param {number} f @param {Visitor} v */
  function walkTarget(id, f, v) {
    const b = bakedFor(id);
    if (!b) return;
    walk(placementsAt(b, f), f, IDENTITY, null, MAX_NEST, v);
  }

  /** Union bounds of a target across all of its frames (stage: the stage rect). @param {string} id */
  function targetBounds(id) {
    if (!scene) return null;
    if (boundsCache.has(id)) return boundsCache.get(id) || null;
    /** @type {Bounds | null} */
    let out = null;
    if (id === STAGE_KEY && scene.stage) {
      out = { xmin: 0, ymin: 0, xmax: scene.stage.width, ymax: scene.stage.height };
    } else {
      const n = frameCountOf(id);
      /** @type {Visitor} */
      const v = {
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

  function cssSize() {
    const w = canvas.clientWidth || canvas.width || 1;
    const h = canvas.clientHeight || canvas.height || 1;
    return [w, h];
  }

  function updateFit() {
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

  function resize() {
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

  /** @type {{ bits: number }[]} */
  const maskStack = [];
  let definingMask = 0; // the stencil bit being defined, 0 when not defining a mask

  function activeMaskBits() {
    let bits = 0;
    for (const m of maskStack) bits |= m.bits;
    return bits;
  }
  function windingMask() {
    return 0xff >> maskStack.length;
  }

  /** @param {number} n floats */
  function ensureScratch(n) {
    if (scratch.length < n) {
      let len = scratch.length;
      while (len < n) len *= 2;
      scratch = new Float32Array(len);
    }
  }

  /**
   * Stencil fill of stage-space polygons, then the cover quad.
   * @param {number[][]} polys @param {'nonzero' | 'evenodd'} rule
   * @param {{ color: Rgba, cx: Cxform | null, bitmap: { tex: WebGLTexture, width: number, height: number, inv: Mat } | null } | null} cover  null while defining a mask
   */
  function glFill(polys, rule, cover) {
    const g = gl;
    if (!g || !prog) return;
    const b = polysBounds(polys);
    if (!b) return;
    // pass 1: winding counts into the low stencil bits, colour off
    let total = 0;
    for (const p of polys) total += p.length / 2;
    ensureScratch(total * 4 + 16);
    let o = 0;
    /** @type {Array<[number, number]>} */
    const ranges = [];
    for (const p of polys) {
      const n = p.length / 2;
      if (n < 3) continue;
      ranges.push([o / 4, n]);
      for (let i = 0; i < p.length; i += 2) {
        scratch[o++] = p[i];
        scratch[o++] = p[i + 1];
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
      scratch[o++] = corners[i];
      scratch[o++] = corners[i + 1];
      if (cover && cover.bitmap) {
        // stage → bitmap px through inverse(placement ∘ pathTransform); affine, so linear across the quad
        const uv = apply(cover.bitmap.inv, corners[i], corners[i + 1]);
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
        g.uniform4f(U.u_color, c.r / 255, c.g / 255, c.b / 255, c.a / 255);
        const mul = cover.cx ? cover.cx.mul : [1, 1, 1, 1];
        const add = cover.cx ? cover.cx.add : [0, 0, 0, 0];
        g.uniform4f(U.u_cxmul, mul[0], mul[1], mul[2], mul[3]);
        g.uniform4f(U.u_cxadd, add[0], add[1], add[2], add[3]);
        if (cover.bitmap) {
          g.activeTexture(g.TEXTURE1);
          g.bindTexture(g.TEXTURE_2D, cover.bitmap.tex);
          g.uniform1f(U.u_useBitmap, 1);
        } else {
          g.uniform1f(U.u_useBitmap, 0);
        }
      }
    }
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
    drawCalls++;
    g.stencilMask(0xff);
  }

  /** @returns {Visitor} */
  function glVisitor() {
    const g = /** @type {WebGLRenderingContext} */ (gl);
    return {
      shape: (_id, prep, mat, cx) => {
        const scale = matScale(mat);
        const tol = Math.max(1e-3, Math.min(1e3, FLATTEN_TOL_CSS / (zoom * scale)));
        for (const path of prep.paths) {
          const polys = flattenPath(path, mat, tol);
          if (!polys.length) continue;
          if (path.fill.kind !== "none") {
            if (definingMask) {
              glFill(polys, path.fillRule, null);
            } else if (path.fill.kind === "bitmap") {
              const bm = bitmapTex.get(path.fill.id);
              const inv = bm ? invert(multiply(mat, path.transform)) : null;
              if (bm && inv) {
                glFill(polys, path.fillRule, { color: { r: 255, g: 255, b: 255, a: 255 }, cx, bitmap: { tex: bm.tex, width: bm.width, height: bm.height, inv } });
              } else if (!bm) {
                missingBitmaps++;
                glFill(polys, path.fillRule, { color: { r: 255, g: 0, b: 255, a: 128 }, cx, bitmap: null });
              }
            } else if (path.fillRgba) {
              glFill(polys, path.fillRule, { color: path.fillRgba, cx, bitmap: null });
            }
          }
          if (path.strokeRgba && path.strokeWidth > 0) {
            const w = Math.max(path.strokeWidth * scale, 1 / Math.max(zoom, 1e-6));
            const sp = strokePolys(polys, path.subs.map((s) => s.closed), w);
            if (sp.length) glFill(sp, "nonzero", definingMask ? null : { color: path.strokeRgba, cx, bitmap: null });
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

  function renderGL() {
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
      g.uniform1f(UC.u_cell, CHECKER_CELL_CSS * dpr);
      g.uniform3f(UC.u_c0, CHECKER_A[0], CHECKER_A[1], CHECKER_A[2]);
      g.uniform3f(UC.u_c1, CHECKER_B[0], CHECKER_B[1], CHECKER_B[2]);
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
    g.uniform4f(U.u_view, sx, sy, -center[0] * sx, -center[1] * sy);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, palTex);
    g.uniform1i(U.u_palette, 0);
    g.uniform1i(U.u_bitmap, 1);
    g.uniform1f(U.u_row, paletteRow);
    g.uniform1f(U.u_showGray, showGray ? 1 : 0);
    g.uniform1f(U.u_useBitmap, 0);
    g.enable(g.STENCIL_TEST);
    maskStack.length = 0;
    definingMask = 0;
    walkTarget(targetId, frame, glVisitor());
    g.disable(g.STENCIL_TEST);
    g.colorMask(true, true, true, true);
  }

  // ---- Canvas2D drawing ----

  /** @type {Map<string, HTMLCanvasElement>} */
  const remapCache = new Map();
  /** @type {CanvasPattern | null} */
  let checkerPattern = null;
  let checkerPatternDpr = 0;

  /** @param {TexImageSource} src */
  function asCanvasImage(src) {
    return /** @type {CanvasImageSource} */ (/** @type {unknown} */ (src));
  }

  /**
   * Bitmap with the palette remap applied per pixel (cached per id/row/showGray).
   * @param {string} id @returns {CanvasImageSource | null}
   */
  function remappedBitmap(id) {
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
          const r = d[i];
          if (r === d[i + 1] && r === d[i + 2]) {
            const col = Math.floor((r / 255) * 15 + 0.5);
            const o = (paletteRow * 16 + col) * 3;
            d[i] = palBytes[o];
            d[i + 1] = palBytes[o + 1];
            d[i + 2] = palBytes[o + 2];
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

  /** @returns {Visitor} */
  function c2dVisitor() {
    const c = /** @type {CanvasRenderingContext2D} */ (ctx2d);
    /** @type {Path2D[]} */
    const maskPaths = [];
    let defining = false;
    /** @param {number[][]} polys @param {boolean[] | null} closed null = close every sub-path */
    const toPath = (polys, closed) => {
      const p = new Path2D();
      polys.forEach((poly, i) => {
        if (poly.length < 4) return;
        p.moveTo(poly[0], poly[1]);
        for (let k = 2; k < poly.length; k += 2) p.lineTo(poly[k], poly[k + 1]);
        if (!closed || closed[i]) p.closePath();
      });
      return p;
    };
    /** @param {[number, number, number, number]} rgba */
    const css = (rgba) => `rgba(${rgba[0]},${rgba[1]},${rgba[2]},${rgba[3].toFixed(4)})`;
    return {
      shape: (_id, prep, mat, cx) => {
        const scale = matScale(mat);
        const tol = Math.max(1e-3, Math.min(1e3, FLATTEN_TOL_CSS / (zoom * scale)));
        for (const path of prep.paths) {
          const polys = flattenPath(path, mat, tol);
          if (!polys.length) continue;
          const p2 = toPath(polys, null);
          if (path.fill.kind !== "none") {
            if (defining) {
              const mp = maskPaths[maskPaths.length - 1];
              if (mp) mp.addPath(p2);
            } else if (path.fill.kind === "bitmap") {
              const img = remappedBitmap(path.fill.id);
              if (img) {
                c.save();
                c.clip(p2, path.fillRule);
                const fm = multiply(mat, path.transform);
                c.transform(fm[0], fm[1], fm[2], fm[3], fm[4], fm[5]);
                // cxform approximated for bitmaps: alpha multiplier only
                c.globalAlpha = clamp01(cx ? cx.mul[3] : 1);
                c.imageSmoothingEnabled = false; // match the GL NEAREST sampling
                c.drawImage(img, 0, 0);
                c.restore();
                drawCalls++;
                fillsDrawn++;
              } else {
                missingBitmaps++;
                c.fillStyle = "rgba(255,0,255,0.5)";
                c.fill(p2, path.fillRule);
                drawCalls++;
                fillsDrawn++;
              }
            } else if (path.fillRgba) {
              c.fillStyle = css(remapColor(path.fillRgba, cx, palBytes, paletteRow, showGray));
              c.fill(p2, path.fillRule);
              drawCalls++;
              fillsDrawn++;
            }
          }
          if (path.strokeRgba && path.strokeWidth > 0 && !defining) {
            c.lineWidth = Math.max(path.strokeWidth * scale, 1 / Math.max(zoom, 1e-6));
            c.lineJoin = "round";
            c.lineCap = "round";
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

  function render2D() {
    const c = ctx2d;
    if (!c) return;
    const dpr = resize();
    const W = canvas.width;
    const H = canvas.height;
    c.setTransform(1, 0, 0, 1, 0, 0);
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
    walkTarget(targetId, frame, c2dVisitor());
    c.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ---- playback ----

  /** @param {boolean} v report a play-state change to the owner (deduped) */
  function setPlaying(v) {
    if (playing === v) return;
    playing = v;
    onPlaying(v);
  }
  // Pause the loop without clearing the user's play intent (off-screen / tab hidden).
  function suspend() {
    if (suspended) return;
    suspended = true;
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
  }
  function resume() {
    if (!suspended) return;
    suspended = false;
    if (destroyed) return;
    if (playing) startLoop();
    else render();
  }

  /** @param {number} t */
  function tick(t) {
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
          changed = true;
        } else {
          setPlaying(false); // stop on the last frame (tell the owner so its play/pause flips)
          acc = 0;
          break;
        }
      } else {
        frame++;
        changed = true;
      }
    }
    render();
    if (changed) onFrame(frame);
    if (playing) rafId = requestAnimationFrame(tick);
  }
  function startLoop() {
    if (rafId !== null || destroyed || suspended) return;
    lastTime = 0;
    acc = 0;
    rafId = requestAnimationFrame(tick);
  }

  // ---- API ----

  function getFrameCount() {
    return targetId ? frameCountOf(targetId) : 1;
  }

  /** @param {number} n */
  function setFrame(n) {
    const count = getFrameCount();
    const f = Math.max(0, Math.min(count - 1, Math.floor(Number(n) || 0)));
    if (f !== frame) {
      frame = f;
      onFrame(frame);
    }
    render();
  }

  function render() {
    if (destroyed) return;
    drawCalls = 0;
    fillsDrawn = 0;
    maskOverflow = 0;
    missingBitmaps = 0;
    updateFit();
    if (gl) renderGL();
    else if (ctx2d) render2D();
  }

  /** @type {Preview} */
  const preview = {
    setScene(s) {
      scene = s;
      prepared = new Map();
      bakedCache = new Map();
      boundsCache = new Map();
      remapCache.clear();
      for (const id of Object.keys(s.shapes || {})) prepared.set(id, prepareShape(s.shapes[id]));
      if (s.preview && Number.isInteger(s.preview.palette)) paletteRow = Math.max(0, Math.min(255, /** @type {number} */ (s.preview.palette)));
      const exists = targetId !== null && (targetId === STAGE_KEY || !!s.sprites[targetId] || !!s.shapes[targetId]);
      if (!exists) {
        const firstExport = Object.values(s.exports || {}).find((ref) => s.sprites[ref] || s.shapes[ref]);
        targetId = firstExport || Object.keys(s.sprites)[0] || Object.keys(s.shapes)[0] || STAGE_KEY;
      }
      if (frame >= getFrameCount()) {
        frame = 0;
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
      onFrame(0);
      render();
    },
    getTarget: () => targetId,
    getTargets() {
      if (!scene) return [];
      /** @type {PreviewTarget[]} */
      const out = [{ id: STAGE_KEY, kind: "stage", frames: frameCountOf(STAGE_KEY) }];
      for (const id of Object.keys(scene.sprites)) out.push({ id, kind: "sprite", frames: Math.max(1, scene.sprites[id].frames | 0) });
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
