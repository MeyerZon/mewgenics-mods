// The art source model ("scene"): schema, defaults, fill parsing, gray quantization,
// and validation. Pure (no node, no DOM) so the browser preview and the Node emitter
// share one interpretation. Every consumer uses the parsed facts from here rather than
// re-reading raw JSON.
//
// Rendering model this encodes (OBSERVED, see docs/art-pipeline.md §5):
//   art is drawn in 16 gray levels; `paletted_full.shader` maps gray level
//   N = floor(r*15 + .5) to column N of a `palette.png` row; non-gray pixels pass
//   through unchanged. So fills are either `gray:N` (remapped) or a colour (passthrough).

import { normalizePath } from "./geometry.ts";
import type { Mat } from "./geometry.ts";
import { gradientProblems } from "./gradient.ts";
import { fillRuleProblems } from "./shape.ts";
import { vanillaExportSource, exportShadowsMessage } from "./swf-rules.ts";
import { BLEND_MODES, GL_PREVIEW_BLENDS, filterProblems } from "./effects.ts";
import { rigFindings, catAnimFindings, CAT_CLIP_NAME } from "./cat-rig.ts";
import { textProblems, locKeyHtmlProblem } from "./text.ts";
import type { SceneText, LocKeySource } from "./text.ts";
import { VANILLA_EXPORTS } from "./vanilla-exports.ts";
import type { SceneImport } from "./vanilla-exports.ts";
import type { SceneFilter } from "./effects.ts";

/**
 * SymbolClass alone binds linkage names; a DoABC is not needed for that (docs/swf-emitter-fix-spec.md §3.2: the
 * no-DoABC gate variant binds and merges exactly like the stub one). "stub" stays available for experiments only.
 */
export const DEFAULT_ABC_MODE = "none";

export const GRAY_LEVELS = 16;
export const SCENE_VERSION = 1;

export type Fill =
  | { kind: "gray"; level: number }
  | { kind: "rgba"; r: number; g: number; b: number; a: number }
  | { kind: "bitmap"; id: string }
  | { kind: "gradient"; id: string }
  | { kind: "none" };

export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface ScenePath {
  /** SVG path data (absolute or relative, any commands) */
  d: string;
  /** "gray:N" | "#rrggbb" | "#rrggbbaa" | "bitmap:<id>" | "gradient:<id>" | "none" | null */
  fill?: string | null;
  fillRule?: "nonzero" | "evenodd";
  /** colour, "gray:N", "gradient:<id>" (DefineShape4) or null */
  stroke?: string | null;
  /** px */
  strokeWidth?: number;
  /** stroke ends (default round); anything but round makes the shape a DefineShape4 */
  strokeCap?: "round" | "butt" | "square";
  /** stroke corners (default round) */
  strokeJoin?: "round" | "bevel" | "miter";
  /** miter length / stroke width before a miter is bevelled (default 4) */
  miterLimit?: number;
  /** "none": the stroke keeps its width when the shape is scaled (LINESTYLE2 NoHScale + NoVScale) */
  strokeScale?: "normal" | "none";
  transform?: Mat;
}

/** How a halo shape was baked (glow.ts); the validator reports it and the UI can re-bake it. */
export interface BakedGlowMeta {
  kind: "glow" | "dropShadow";
  /** the source shape id */
  of: string;
  color: string;
  blur: number;
  strength: number;
  steps: number;
  dx?: number;
  dy?: number;
}

export interface SceneShape {
  paths: ScenePath[];
  source?: string;
  /** set on a halo shape bakeGlow / bakeDropShadow produced (glow.ts) */
  baked?: BakedGlowMeta;
}

export interface GradientStopDef {
  /** 0..1, ascending */
  offset: number;
  /** gray:N (palette-remapped like any gray) or #rrggbb[aa] */
  color: string;
}

/** A gradient a path fill references as "gradient:<id>" (geometry in the path's local px; see gradient.ts). */
export interface SceneGradient {
  kind: "linear" | "radial";
  stops: GradientStopDef[];
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  cx?: number;
  cy?: number;
  r?: number;
  fx?: number;
  fy?: number;
  spread?: "pad" | "reflect" | "repeat";
  /** applied after the geometry (SVG gradientTransform, objectBoundingBox) */
  transform?: Mat;
}

export interface SceneCxform {
  mul?: [number, number, number, number];
  add?: [number, number, number, number];
}

export interface SceneKey {
  /** 0-based */
  frame: number;
  /** shape or sprite id; null removes the layer's object */
  ref: string | null;
  x?: number;
  y?: number;
  sx?: number;
  sy?: number;
  /** degrees, clockwise on screen */
  rot?: number;
  skew?: number;
  /** raw override of x/y/sx/sy/rot/skew */
  matrix?: Mat;
  cxform?: SceneCxform | null;
  /** shorthand for cxform.mul[3] */
  alpha?: number;
  /** how to reach the next key (default hold) */
  tween?: "hold" | "linear";
  /** PlaceObject3 blend mode (held until the next key; not tweened) */
  blend?: string;
  /** PlaceObject3 filters (held until the next key; not tweened) */
  filters?: SceneFilter[];
}

export interface SceneLayer {
  /** becomes the PlaceObject2 instance name (e.g. "body") */
  name?: string;
  /** unique within the sprite, >= 1 */
  depth: number;
  /** this layer masks layers with depth <= clipDepth */
  clip?: boolean;
  clipDepth?: number;
  keys: SceneKey[];
}

export interface SceneSprite {
  frames: number;
  labels?: Record<string, number>;
  layers: SceneLayer[];
  /** "cat": a cat rig (layers named after the vanilla slots; cat-rig.ts checks it) */
  rig?: "cat";
  /** "game" (cat rigs): the slots are empty sprites the game fills with the cat's own parts (cat-rig.ts) */
  parts?: "game";
  /** "back" (cat rigs): the back-facing layout a `<anim>B` frame places (head_back behind, tail in front; cat-rig.ts CAT_BACK_SLOTS) */
  facing?: "back";
}

export interface SceneStage {
  width: number;
  height: number;
  background?: string;
}

export interface Scene {
  version: number;
  name: string;
  frameRate?: number;
  stage?: SceneStage;
  preview?: { palette?: number };
  curveResolution?: number;
  shapes: Record<string, SceneShape>;
  bitmaps?: Record<string, { file: string }>;
  gradients?: Record<string, SceneGradient>;
  /** DefineEditText characters in a game font (text.ts); keys place them like shapes */
  texts?: Record<string, SceneText>;
  /** symbols imported from game SWFs (ImportAssets2), placed by keys like sprites; no game bytes in the mod */
  imports?: Record<string, SceneImport>;
  sprites: Record<string, SceneSprite>;
  exports: Record<string, string>;
  stage_instances?: Array<SceneKey & { ref: string }>;
}

export interface Finding {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  path?: string;
}

export function newScene(name: string): Scene {
  const s: Scene = {
    version: SCENE_VERSION,
    name,
    frameRate: 60,
    stage: { width: 1280, height: 720, background: "#ffccff" },
    preview: { palette: 54 },
    shapes: {},
    bitmaps: {},
    sprites: {},
    exports: {},
    stage_instances: [],
  };
  return s;
}

/**
 * A small starter scene: a gray square that bobs, plus a passthrough-coloured eye,
 * exported under both a class-style and a ".png"-style linkage name.
 */
export function exampleScene(name = "starter"): Scene {
  const s = newScene(name);
  s.shapes.body = {
    paths: [
      { d: "M-40 -30 L40 -30 L40 30 L-40 30 Z", fill: "gray:8", fillRule: "nonzero" },
      { d: "M-40 -30 L40 -30 L40 -18 L-40 -18 Z", fill: "gray:12", fillRule: "nonzero" },
    ],
  };
  s.shapes.eye = {
    paths: [{ d: "M0 -8 C4.4 -8 8 -4.4 8 0 C8 4.4 4.4 8 0 8 C-4.4 8 -8 4.4 -8 0 C-8 -4.4 -4.4 -8 0 -8 Z", fill: "#ff2020" }],
  };
  s.sprites.Starter = {
    frames: 24,
    labels: { idle: 0, blink: 12 },
    layers: [
      {
        name: "body",
        depth: 1,
        keys: [
          { frame: 0, ref: "body", x: 0, y: 0, tween: "linear" },
          { frame: 12, ref: "body", x: 0, y: -6, tween: "linear" },
          { frame: 23, ref: "body", x: 0, y: 0 },
        ],
      },
      {
        name: "eye",
        depth: 2,
        keys: [
          { frame: 0, ref: "eye", x: 18, y: -6, tween: "linear" },
          { frame: 12, ref: "eye", x: 18, y: -12, sy: 0.2, tween: "linear" },
          { frame: 14, ref: "eye", x: 18, y: -11, sy: 1, tween: "linear" },
          { frame: 23, ref: "eye", x: 18, y: -6 },
        ],
      },
    ],
  };
  s.exports = { Starter: "Starter", "starter.png": "Starter" };
  s.stage_instances = [{ frame: 0, ref: "Starter", x: 640, y: 360 }];
  return s;
}

// ---- fills -------------------------------------------------------------------

/** @param level 0..15 → byte value the shader maps back to exactly `level` */
export function grayLevelToByte(level: number): number {
  return Math.max(0, Math.min(15, Math.round(level))) * 17;
}

/** Nearest 16-level gray for a byte (0..255). Mirrors the shader: floor(r*15+.5). */
export function byteToGrayLevel(byte: number): number {
  return Math.max(0, Math.min(15, Math.floor((byte / 255) * 15 + 0.5)));
}

export interface ParsedFill {
  fill: Fill;
  quantized?: boolean;
  error?: string;
}

/**
 * Parse a scene fill string. Gray colours (#rrggbb with r==g==b) are quantized to a
 * level (and the caller may warn when the quantization changed the byte).
 */
export function parseFill(str: string | null | undefined): ParsedFill {
  if (str === null || str === undefined || str === "none" || str === "") return { fill: { kind: "none" } };
  const s = String(str).trim();
  let m = /^gray:(\d{1,2})$/i.exec(s);
  if (m) {
    const level = Number(m[1]);
    if (level > 15) return { fill: { kind: "none" }, error: `gray level out of range: ${s}` };
    return { fill: { kind: "gray", level } };
  }
  m = /^bitmap:([A-Za-z0-9_.-]+)$/.exec(s);
  if (m) return { fill: { kind: "bitmap", id: m[1] } };
  m = /^gradient:([A-Za-z0-9_.-]+)$/.exec(s);
  if (m) return { fill: { kind: "gradient", id: m[1] } };
  const rgba = parseColor(s);
  if (!rgba) return { fill: { kind: "none" }, error: `unrecognized fill: ${s}` };
  if (rgba.r === rgba.g && rgba.g === rgba.b && rgba.a === 255) {
    const level = byteToGrayLevel(rgba.r);
    return { fill: { kind: "gray", level }, quantized: grayLevelToByte(level) !== rgba.r };
  }
  return { fill: { kind: "rgba", ...rgba } };
}

const NAMED: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00",
  gray: "#808080", grey: "#808080", none: "", transparent: "#00000000",
};

/** #rgb, #rrggbb, #rrggbbaa, rgb(), rgba(), a few names. */
export function parseColor(s: string): RgbaColor | null {
  let str = s.trim().toLowerCase();
  if (NAMED[str] !== undefined) str = NAMED[str];
  if (!str) return null;
  let m = /^#([0-9a-f]{3,4})$/.exec(str);
  if (m) {
    const h = m[1];
    const r = parseInt(h[0] + h[0], 16);
    const g = parseInt(h[1] + h[1], 16);
    const b = parseInt(h[2] + h[2], 16);
    const a = h.length === 4 ? parseInt(h[3] + h[3], 16) : 255;
    return { r, g, b, a };
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(str);
  if (m) {
    const v = parseInt(m[1], 16);
    return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255, a: m[2] ? parseInt(m[2], 16) : 255 };
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(str);
  if (m) {
    return { r: clampByte(Number(m[1])), g: clampByte(Number(m[2])), b: clampByte(Number(m[3])), a: m[4] !== undefined ? clampByte(Number(m[4]) * 255) : 255 };
  }
  return null;
}
function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/** The RGBA bytes the emitter writes / the preview feeds the shader for a fill. */
export function fillToRgba(fill: Fill): RgbaColor | null {
  if (fill.kind === "gray") {
    const v = grayLevelToByte(fill.level);
    return { r: v, g: v, b: v, a: 255 };
  }
  if (fill.kind === "rgba") return { r: fill.r, g: fill.g, b: fill.b, a: fill.a };
  return null;
}

// ---- validation ---------------------------------------------------------------

export interface SceneValidation {
  ok: boolean;
  scene: Scene;
  findings: Finding[];
}

export interface SceneValidateOptions {
  /** is this string a localization key, and whose (text-loc-key-html)? Without it only the key shape is tested. */
  locKey?: (key: string) => LocKeySource | null | undefined;
}

/**
 * Validate (and lightly normalize, in place, on a deep copy) a scene. Never throws on
 * bad user data; returns findings. `ok` is false only on errors.
 */
export function validateScene(input: unknown, opts: SceneValidateOptions = {}): SceneValidation {
  const findings: Finding[] = [];
  const err = (code: string, message: string, at?: string[]) => findings.push({ severity: "error", code, message, path: at && at[0] });
  const warn = (code: string, message: string, at?: string[]) => findings.push({ severity: "warning", code, message, path: at && at[0] });

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    err("scene-not-object", "scene must be a JSON object");
    return { ok: false, scene: newScene("invalid"), findings };
  }
  // user JSON: the fields are checked one by one below, so this is the only `as` in the module
  const scene: Scene = JSON.parse(JSON.stringify(input)) as Scene;
  if (scene.version !== SCENE_VERSION) warn("scene-version", `scene.version is ${String(scene.version)}, expected ${SCENE_VERSION}`, ["version"]);
  if (typeof scene.name !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(scene.name)) {
    err("scene-name", "scene.name must be a file-safe identifier (letters, digits, _ . -)", ["name"]);
  }
  if (scene.frameRate === undefined) scene.frameRate = 60;
  if (typeof scene.frameRate !== "number" || !(scene.frameRate > 0 && scene.frameRate <= 120)) err("frame-rate", "frameRate must be 1..120", ["frameRate"]);
  else if (scene.frameRate !== 60) warn("frame-rate-vanilla", "vanilla files are 60 fps; other rates are untested in-engine", ["frameRate"]);
  if (!scene.stage) scene.stage = { width: 1280, height: 720, background: "#ffccff" };
  if (!(scene.stage.width > 0) || !(scene.stage.height > 0)) err("stage-size", "stage.width/height must be positive", ["stage"]);
  if (scene.stage.background !== undefined && !parseColor(scene.stage.background)) warn("stage-background", `unrecognized stage.background ${String(scene.stage.background)}`, ["stage.background"]);
  if (!scene.preview) scene.preview = {};
  if (scene.preview.palette !== undefined && !(Number.isInteger(scene.preview.palette) && scene.preview.palette >= 0 && scene.preview.palette < 256)) {
    warn("preview-palette", "preview.palette must be a row index 0..255", ["preview.palette"]);
    scene.preview.palette = 0;
  }
  scene.shapes = scene.shapes || {};
  scene.sprites = scene.sprites || {};
  scene.bitmaps = scene.bitmaps || {};
  scene.exports = scene.exports || {};
  scene.stage_instances = scene.stage_instances || [];

  const ids = new Set<string>();
  for (const id of Object.keys(scene.shapes)) {
    if (ids.has(id)) err("dup-id", `id "${id}" used by more than one shape/sprite/bitmap`, [`shapes.${id}`]);
    ids.add(id);
    const sh = scene.shapes[id];
    if (!sh || !Array.isArray(sh.paths)) {
      err("shape-paths", `shape "${id}" needs a paths[] array`, [`shapes.${id}`]);
      continue;
    }
    if (!sh.paths.length) warn("shape-empty", `shape "${id}" has no paths`, [`shapes.${id}`]);
    if (sh.baked !== undefined) {
      const b = sh.baked;
      if (!b || typeof b.of !== "string" || (b.kind !== "glow" && b.kind !== "dropShadow")) err("glow-baked", `shape "${id}".baked must name kind (glow|dropShadow) and of (the source shape)`, [`shapes.${id}.baked`]);
      else if (!scene.shapes[b.of]) warn("glow-orphan", `shape "${id}" is a baked ${b.kind} of "${b.of}", which no longer exists (delete it or re-bake)`, [`shapes.${id}.baked`]);
      else findings.push({ severity: "info", code: "glow-baked", message: `shape "${id}" is a baked ${b.kind} of "${b.of}" (${b.color}, blur ${b.blur} px, ${b.steps} band${b.steps === 1 ? "" : "s"}${b.kind === "dropShadow" ? `, offset ${b.dx ?? 0}, ${b.dy ?? 0}` : ""}); re-bake it after editing "${b.of}"`, path: `shapes.${id}` });
    }
    sh.paths.forEach((p, i) => {
      const at = `shapes.${id}.paths[${i}]`;
      if (!p || typeof p.d !== "string" || !p.d.trim()) {
        err("path-d", `path has no d`, [at]);
        return;
      }
      const f = parseFill(p.fill);
      if (f.error) err("fill", f.error, [at + ".fill"]);
      else if (f.quantized) warn("fill-quantized", `gray fill ${p.fill} snapped to gray:${f.fill.kind === "gray" ? f.fill.level : ""}`, [at + ".fill"]);
      else if (f.fill.kind === "rgba") warn("passthrough-fill", `fill ${p.fill} is not gray: the engine will NOT palette-remap it`, [at + ".fill"]);
      else if (f.fill.kind === "bitmap" && !(scene.bitmaps || {})[f.fill.id]) err("bitmap-missing", `fill references unknown bitmap "${f.fill.id}"`, [at + ".fill"]);
      else if (f.fill.kind === "gradient" && !(scene.gradients || {})[f.fill.id]) err("gradient-missing", `fill references unknown gradient "${f.fill.id}"`, [at + ".fill"]);
      if (p.fillRule && p.fillRule !== "nonzero" && p.fillRule !== "evenodd") err("fill-rule", `fillRule must be nonzero|evenodd`, [at + ".fillRule"]);
      else if (f.fill.kind !== "none" && !f.error && p.fillRule !== "evenodd") {
        // OBSERVED 2026-10-21: the engine fills every fill style even-odd (libtess2 TESS_WINDING_ODD, 0xa73bb0); the emitter
        // resolves nesting, so only crossings / self-overlaps draw differently from the authored nonzero rule
        let problems: string[] = [];
        try { problems = fillRuleProblems(normalizePath(p.d, { matrix: p.transform }), p.fillRule); } catch { /* path-parse is the emitter's finding */ }
        if (problems.length) warn("fill-rule-ignored", `the engine fills each fill style even-odd (libtess2 TESS_WINDING_ODD), not nonzero: ${problems.join("; ")} in-game; set fillRule "evenodd" to preview it that way, or put the overlapping parts in separate paths`, [at + ".fillRule"]);
      }
      if (p.stroke) {
        const sf = parseFill(p.stroke);
        if (sf.error) err("stroke", sf.error, [at + ".stroke"]);
        else if (sf.fill.kind === "bitmap") err("stroke", "bitmap strokes are not supported (use a colour, gray:N or gradient:<id>)", [at + ".stroke"]);
        else if (sf.fill.kind === "gradient" && !(scene.gradients || {})[sf.fill.id]) err("gradient-missing", `stroke references unknown gradient "${sf.fill.id}"`, [at + ".stroke"]);
        if (!((p.strokeWidth ?? 0) > 0)) warn("stroke-width", "stroke set but strokeWidth is 0; stroke dropped", [at + ".strokeWidth"]);
      }
      if (p.strokeCap !== undefined && !["round", "butt", "square"].includes(p.strokeCap)) err("stroke-style", "strokeCap must be round, butt or square", [at + ".strokeCap"]);
      if (p.strokeJoin !== undefined && !["round", "bevel", "miter"].includes(p.strokeJoin)) err("stroke-style", "strokeJoin must be round, bevel or miter", [at + ".strokeJoin"]);
      if (p.miterLimit !== undefined && !(typeof p.miterLimit === "number" && p.miterLimit >= 1 && p.miterLimit < 256)) err("stroke-style", "miterLimit must be a number in 1..255", [at + ".miterLimit"]);
      if (p.strokeScale !== undefined && p.strokeScale !== "normal" && p.strokeScale !== "none") err("stroke-style", "strokeScale must be normal or none", [at + ".strokeScale"]);
      if (p.transform && (!Array.isArray(p.transform) || p.transform.length !== 6 || p.transform.some((n) => typeof n !== "number"))) err("path-transform", "transform must be a 6-number matrix", [at + ".transform"]);
    });
  }
  for (const id of Object.keys(scene.bitmaps)) {
    if (ids.has(id)) err("dup-id", `id "${id}" used by more than one shape/sprite/bitmap`, [`bitmaps.${id}`]);
    ids.add(id);
    const bm = scene.bitmaps[id];
    if (!bm || typeof bm.file !== "string" || !/\.png$/i.test(bm.file)) err("bitmap-file", `bitmap "${id}" needs a .png file path relative to the mod`, [`bitmaps.${id}`]);
    else if (bm.file.includes("..") || bm.file.startsWith("/") || /^[A-Za-z]:/.test(bm.file)) err("bitmap-path", `bitmap "${id}" path must stay inside the mod folder`, [`bitmaps.${id}.file`]);
  }
  for (const id of Object.keys(scene.sprites)) {
    if (ids.has(id)) err("dup-id", `id "${id}" used by more than one shape/sprite/bitmap`, [`sprites.${id}`]);
    ids.add(id);
  }
  for (const id of Object.keys(scene.gradients || {})) {
    if (ids.has(id)) err("dup-id", `id "${id}" used by more than one shape/sprite/bitmap/gradient`, [`gradients.${id}`]);
    ids.add(id);
    for (const p of gradientProblems((scene.gradients || {})[id])) err(p.code, `gradient "${id}": ${p.message}`, [`gradients.${id}` + (p.at ? `.${p.at}` : "")]);
    const spread = (scene.gradients || {})[id]?.spread;
    // OBSERVED 2026-10-21: GradientAtlas::RasterizeRow 0xa27de0 / default_gradient.shader have no reflect/repeat arithmetic
    if (spread === "reflect" || spread === "repeat") warn("gradient-spread-ignored", `gradient "${id}": spread "${spread}" is written to the SWF but the game pads every gradient (the last stop's colour continues past the end); the preview pads too`, [`gradients.${id}.spread`]);
  }
  for (const id of Object.keys(scene.imports || {})) {
    if (ids.has(id)) err("dup-id", `id "${id}" used by more than one shape/sprite/bitmap/gradient/text/import`, [`imports.${id}`]);
    ids.add(id);
    const im = (scene.imports || {})[id];
    if (!im || typeof im.from !== "string" || !/^[A-Za-z0-9_.-]+\.swf$/.test(im.from)) err("import-from", `import "${id}": from must be a game SWF file name (e.g. catparts.swf)`, [`imports.${id}.from`]);
    else if (typeof im.name !== "string" || !im.name) err("import-unknown", `import "${id}": name is required`, [`imports.${id}.name`]);
    else if (VANILLA_EXPORTS[im.from] && !VANILLA_EXPORTS[im.from]!.includes(im.name)) err("import-unknown", `import "${id}": ${im.from} does not export "${im.name}"`, [`imports.${id}.name`]);
    else if (!VANILLA_EXPORTS[im.from]) findings.push({ severity: "warning", code: "import-unpinned", message: `import "${id}": ${im.from}'s exports are not pinned; "${im.name}" is not checked`, path: `imports.${id}` });
    // OBSERVED 2026-10-20 (the cat-parts import experiment): a SWF with ImportAssets2 entries loads, but spawning a character
    // whose clip places an imported symbol crashes the game (0xc0000005 at Mewgenics.exe+0xa4a1a9)
    err("import-unsupported", `import "${id}": the game crashes when a clip places a symbol imported from another SWF (OBSERVED 2026-10-20)`, [`imports.${id}`]);
  }
  for (const id of Object.keys(scene.texts || {})) {
    if (ids.has(id)) err("dup-id", `id "${id}" used by more than one shape/sprite/bitmap/gradient/text`, [`texts.${id}`]);
    ids.add(id);
    const t = (scene.texts || {})[id];
    const problems = textProblems(t);
    for (const p of problems) err(p.code, `text "${id}": ${p.message}`, [`texts.${id}` + (p.at ? `.${p.at}` : "")]);
    const lk = !problems.length && t ? locKeyHtmlProblem(t, opts.locKey) : null;
    if (lk) findings.push({ severity: lk.severity, code: "text-loc-key-html", message: `text "${id}": ${lk.message}`, path: `texts.${id}` });
  }
  for (const id of Object.keys(scene.sprites)) {
    const sp = scene.sprites[id];
    const at = `sprites.${id}`;
    if (!sp || !Array.isArray(sp.layers)) {
      err("sprite-layers", `sprite "${id}" needs layers[]`, [at]);
      continue;
    }
    if (sp.rig === "cat") findings.push(...rigFindings(sp, at, scene));
    else if (sp.rig !== undefined) err("sprite-rig", `rig must be "cat"`, [at + ".rig"]);
    if (sp.parts !== undefined && sp.parts !== "game") err("sprite-parts", `parts must be "game"`, [at + ".parts"]);
    else if (sp.parts === "game" && sp.rig !== "cat") err("sprite-parts", `parts: "game" needs rig: "cat"`, [at + ".parts"]);
    if (sp.facing !== undefined && sp.facing !== "back") err("sprite-facing", `facing must be "back" (or absent for a front rig)`, [at + ".facing"]);
    else if (sp.facing === "back" && sp.rig !== "cat") err("sprite-facing", `facing: "back" needs rig: "cat"`, [at + ".facing"]);
    if (!(Number.isInteger(sp.frames) && sp.frames >= 1)) {
      err("sprite-frames", `sprite "${id}" frames must be an integer >= 1`, [at + ".frames"]);
      sp.frames = Math.max(1, sp.frames | 0);
    }
    sp.labels = sp.labels || {};
    for (const [label, fr] of Object.entries(sp.labels)) {
      if (!/^[A-Za-z_][A-Za-z0-9_ -]*$/.test(label)) warn("label-name", `label "${label}" has unusual characters`, [at + ".labels"]);
      if (!(Number.isInteger(fr) && fr >= 0 && fr < sp.frames)) err("label-frame", `label "${label}" frame ${fr} outside 0..${sp.frames - 1}`, [at + ".labels." + label]);
    }
    const depths = new Set<number>();
    sp.layers.forEach((layer, li) => {
      const lat = `${at}.layers[${li}]`;
      if (!(Number.isInteger(layer.depth) && layer.depth >= 1 && layer.depth <= 65535)) err("layer-depth", "layer.depth must be an integer 1..65535", [lat + ".depth"]);
      if (depths.has(layer.depth)) err("layer-depth-dup", `depth ${layer.depth} used twice in sprite "${id}"`, [lat + ".depth"]);
      depths.add(layer.depth);
      if (layer.name !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(layer.name)) warn("layer-name", `instance name "${layer.name}" is not an identifier`, [lat + ".name"]);
      if (layer.clip && !((layer.clipDepth ?? 0) > layer.depth)) err("clip-depth", "clip layers need clipDepth > depth", [lat + ".clipDepth"]);
      if (!Array.isArray(layer.keys) || !layer.keys.length) {
        err("layer-keys", "layer needs at least one key", [lat + ".keys"]);
        return;
      }
      let last = -1;
      layer.keys.forEach((k, ki) => {
        const kat = `${lat}.keys[${ki}]`;
        if (!(Number.isInteger(k.frame) && k.frame >= 0 && k.frame < sp.frames)) err("key-frame", `key frame ${k.frame} outside 0..${sp.frames - 1}`, [kat + ".frame"]);
        if (k.frame <= last) err("key-order", "keys must be sorted by strictly increasing frame", [kat + ".frame"]);
        last = k.frame;
        if (k.ref !== null && k.ref !== undefined) {
          if (typeof k.ref !== "string" || !(scene.shapes[k.ref] || scene.sprites[k.ref] || (scene.texts || {})[k.ref] || (scene.imports || {})[k.ref])) err("ref-missing", `ref "${String(k.ref)}" is not a shape, sprite, text or import`, [kat + ".ref"]);
          else if (k.ref === id) err("ref-self", `sprite "${id}" cannot contain itself`, [kat + ".ref"]);
        }
        if (k.tween && k.tween !== "hold" && k.tween !== "linear") err("key-tween", "tween must be hold|linear", [kat + ".tween"]);
        if (k.matrix && (!Array.isArray(k.matrix) || k.matrix.length !== 6)) err("key-matrix", "matrix must be a 6-number array", [kat + ".matrix"]);
        if (k.cxform) {
          for (const f of ["mul", "add"] as const) {
            const v = k.cxform[f];
            if (v !== undefined && (!Array.isArray(v) || v.length !== 4)) err("key-cxform", `cxform.${f} must have 4 numbers`, [kat + ".cxform"]);
          }
        }
        if (k.blend !== undefined) {
          if (typeof k.blend !== "string" || !Object.prototype.hasOwnProperty.call(BLEND_MODES, k.blend)) err("blend", `blend must be one of ${Object.keys(BLEND_MODES).join(", ")}`, [kat + ".blend"]);
          else if (!GL_PREVIEW_BLENDS.has(k.blend)) findings.push({ severity: "info", code: "blend-not-previewed", message: `blend "${k.blend}" is written to the SWF; the WebGL preview draws it as normal`, path: kat + ".blend" });
        }
        if (k.filters !== undefined) {
          if (!Array.isArray(k.filters)) err("filter", "filters must be an array", [kat + ".filters"]);
          else {
            k.filters.forEach((fl, fi) => { for (const msg of filterProblems(fl)) err("filter", `filters[${fi}]: ${msg}`, [`${kat}.filters[${fi}]`]); });
            // OBSERVED 2026-10-20 (gate "filters"): the game stops with "ERROR: FILTERS NOT SUPPORTED <swf>" on any filter list
            // (PlaceObject::decode3 0xb78210 stops on the HasFilterList flag bit alone; docs/engine-map.md "Glow and outline passes")
            if (k.filters.length) err("filter-unsupported", "the game does not support filters: it stops with \"ERROR: FILTERS NOT SUPPORTED\" when a SWF carries one. Bake the glow or shadow into the art instead (bakeGlow / MCP bake_glow / the shape row's Bake glow… button: a halo shape placed under the source), or use the engine's own knobs — CharacterLightSource { glow [r g b a] size N } for a ground light, AdvancedTint [mul…][add…] for a brightness lift (docs/data-mods.md \"Lighting and tint knobs\")", [kat + ".filters"]);
          }
        }
      });
    });
  }
  // sprite containment cycles
  for (const id of Object.keys(scene.sprites)) {
    if (hasCycle(scene, id, new Set())) err("sprite-cycle", `sprite "${id}" contains itself through nesting`, [`sprites.${id}`]);
  }
  const exportsN = Object.keys(scene.exports).length;
  if (!exportsN) warn("no-exports", "no exports: the SWF will have an empty SymbolClass, nothing is addressable from GON", ["exports"]);
  for (const [linkage, ref] of Object.entries(scene.exports)) {
    if (!linkage) err("export-name", "empty linkage name", ["exports"]);
    if (typeof ref !== "string" || !(scene.shapes[ref] || scene.sprites[ref])) err("export-ref", `export "${linkage}" points at unknown id "${String(ref)}"`, [`exports.${linkage}`]);
    // OBSERVED 2026-10-21 (0x9bb6f0): clips resolve by name through a global registry of every loaded SWF, last-loaded first
    if (linkage === CAT_CLIP_NAME) err("cat-clip-override", `export "${CAT_CLIP_NAME}" would replace the game's cat clip for every cat (clips resolve through a global last-loaded-first registry); append frames with "_Append_${CAT_CLIP_NAME}" instead`, [`exports.${linkage}`]);
    const vanillaFile = linkage ? vanillaExportSource(linkage) : null;
    if (vanillaFile) findings.push({ severity: "info", code: "export-shadows-vanilla", message: `export ${exportShadowsMessage(linkage, vanillaFile)}`, path: `exports.${linkage}` });
  }
  // a cat animation donor (exports._Append_CatTest): facing pairs, a rig per labeled frame, depth 1 (cat-rig.ts)
  findings.push(...catAnimFindings(scene));
  scene.stage_instances.forEach((si, i) => {
    if (!si || typeof si.ref !== "string" || !(scene.shapes[si.ref] || scene.sprites[si.ref] || (scene.texts || {})[si.ref] || (scene.imports || {})[si.ref])) err("stage-ref", `stage_instances[${i}].ref is not a shape or sprite`, [`stage_instances[${i}]`]);
  });
  if (scene.curveResolution !== undefined && !(Number.isInteger(scene.curveResolution) && scene.curveResolution >= 1)) warn("curve-resolution", "curveResolution must be a positive integer; ignored", ["curveResolution"]);

  return { ok: !findings.some((f) => f.severity === "error"), scene, findings };
}

function hasCycle(scene: Scene, id: string, stack: Set<string>): boolean {
  if (stack.has(id)) return true;
  const sp = scene.sprites[id];
  if (!sp || !Array.isArray(sp.layers)) return false;
  stack.add(id);
  for (const layer of sp.layers) {
    for (const k of layer.keys || []) {
      if (k.ref && scene.sprites[k.ref] && hasCycle(scene, k.ref, stack)) return true;
    }
  }
  stack.delete(id);
  return false;
}

/**
 * Deterministic build order: every id a sprite depends on comes before it.
 * Shapes and bitmaps first (sorted), then sprites in dependency order.
 */
export function buildOrder(scene: Scene): string[] {
  const out = Object.keys(scene.imports || {}).sort();
  out.push(...Object.keys(scene.bitmaps || {}).sort());
  out.push(...Object.keys(scene.shapes).sort());
  out.push(...Object.keys(scene.texts || {}).sort());
  const seen = new Set(out);
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const sp = scene.sprites[id];
    for (const layer of sp.layers || []) for (const k of layer.keys || []) if (k.ref && scene.sprites[k.ref]) visit(k.ref);
    out.push(id);
  };
  for (const id of Object.keys(scene.sprites).sort()) visit(id);
  return out;
}

export interface GrayUsage {
  levels: number[];
  passthrough: number;
  bitmaps: number;
  gradients: number;
}

/** Which gray levels a shape uses (for the UI ramps) and whether it has passthrough fills. */
export function shapeGrayUsage(shape: SceneShape): GrayUsage {
  const levels = new Set<number>();
  let passthrough = 0;
  let bitmaps = 0;
  let gradients = 0;
  for (const p of shape.paths || []) {
    const f = parseFill(p.fill).fill;
    if (f.kind === "gray") levels.add(f.level);
    else if (f.kind === "rgba") passthrough++;
    else if (f.kind === "bitmap") bitmaps++;
    else if (f.kind === "gradient") gradients++;
  }
  return { levels: [...levels].sort((a, b) => a - b), passthrough, bitmaps, gradients };
}
