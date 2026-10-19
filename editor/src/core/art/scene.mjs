// The art source model ("scene"): schema, defaults, fill parsing, gray quantization,
// and validation. Pure (no node, no DOM) so the browser preview and the Node emitter
// share one interpretation. Every consumer uses the parsed facts from here rather than
// re-reading raw JSON.
//
// Rendering model this encodes (OBSERVED, see docs/art-pipeline.md §5):
//   art is drawn in 16 gray levels; `paletted_full.shader` maps gray level
//   N = floor(r*15 + .5) to column N of a `palette.png` row; non-gray pixels pass
//   through unchanged. So fills are either `gray:N` (remapped) or a colour (passthrough).

/**
 * SymbolClass alone binds linkage names; a DoABC is not needed for that (docs/swf-emitter-fix-spec.md §3.2: the
 * no-DoABC gate variant binds and merges exactly like the stub one). "stub" stays available for experiments only.
 */
export const DEFAULT_ABC_MODE = "none";

export const GRAY_LEVELS = 16;
export const SCENE_VERSION = 1;

/**
 * @typedef {{ kind: 'gray', level: number }
 *   | { kind: 'rgba', r: number, g: number, b: number, a: number }
 *   | { kind: 'bitmap', id: string }
 *   | { kind: 'none' }} Fill
 */

/**
 * @typedef {Object} ScenePath
 * @property {string} d                    SVG path data (absolute or relative, any commands)
 * @property {string|null} [fill]          "gray:N" | "#rrggbb" | "#rrggbbaa" | "bitmap:<id>" | "none" | null
 * @property {'nonzero'|'evenodd'} [fillRule]
 * @property {string|null} [stroke]        colour or "gray:N" or null
 * @property {number} [strokeWidth]        px
 * @property {import('./geometry.mjs').Mat} [transform]
 */

/**
 * @typedef {Object} SceneShape
 * @property {ScenePath[]} paths
 * @property {string} [source]
 */

/**
 * @typedef {Object} SceneCxform
 * @property {[number,number,number,number]} [mul]
 * @property {[number,number,number,number]} [add]
 */

/**
 * @typedef {Object} SceneKey
 * @property {number} frame                0-based
 * @property {string|null} ref             shape or sprite id; null removes the layer's object
 * @property {number} [x]
 * @property {number} [y]
 * @property {number} [sx]
 * @property {number} [sy]
 * @property {number} [rot]                degrees, clockwise on screen
 * @property {number} [skew]
 * @property {import('./geometry.mjs').Mat} [matrix]   raw override of x/y/sx/sy/rot/skew
 * @property {SceneCxform|null} [cxform]
 * @property {number} [alpha]              shorthand for cxform.mul[3]
 * @property {'hold'|'linear'} [tween]     how to reach the next key (default hold)
 */

/**
 * @typedef {Object} SceneLayer
 * @property {string} [name]              becomes the PlaceObject2 instance name (e.g. "body")
 * @property {number} depth               unique within the sprite, >= 1
 * @property {boolean} [clip]             this layer masks layers with depth <= clipDepth
 * @property {number} [clipDepth]
 * @property {SceneKey[]} keys
 */

/**
 * @typedef {Object} SceneSprite
 * @property {number} frames
 * @property {Record<string, number>} [labels]
 * @property {SceneLayer[]} layers
 */

/**
 * @typedef {Object} Scene
 * @property {number} version
 * @property {string} name
 * @property {number} [frameRate]
 * @property {{ width: number, height: number, background?: string }} [stage]
 * @property {{ palette?: number }} [preview]
 * @property {number} [curveResolution]
 * @property {Record<string, SceneShape>} shapes
 * @property {Record<string, { file: string }>} [bitmaps]
 * @property {Record<string, SceneSprite>} sprites
 * @property {Record<string, string>} exports
 * @property {Array<SceneKey & { ref: string }>} [stage_instances]
 */

/**
 * @typedef {{ severity: 'error'|'warning'|'info', code: string, message: string, path?: string }} Finding
 */

/** @param {string} name */
export function newScene(name) {
  /** @type {Scene} */
  const s = {
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
 * @param {string} [name]
 * @returns {Scene}
 */
export function exampleScene(name = "starter") {
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

/** @param {number} level 0..15 → byte value the shader maps back to exactly `level` */
export function grayLevelToByte(level) {
  return Math.max(0, Math.min(15, Math.round(level))) * 17;
}

/**
 * Nearest 16-level gray for a byte (0..255). Mirrors the shader: floor(r*15+.5).
 * @param {number} byte
 */
export function byteToGrayLevel(byte) {
  return Math.max(0, Math.min(15, Math.floor((byte / 255) * 15 + 0.5)));
}

/**
 * Parse a scene fill string. Gray colours (#rrggbb with r==g==b) are quantized to a
 * level (and the caller may warn when the quantization changed the byte).
 * @param {string|null|undefined} str
 * @returns {{ fill: Fill, quantized?: boolean, error?: string }}
 */
export function parseFill(str) {
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
  const rgba = parseColor(s);
  if (!rgba) return { fill: { kind: "none" }, error: `unrecognized fill: ${s}` };
  if (rgba.r === rgba.g && rgba.g === rgba.b && rgba.a === 255) {
    const level = byteToGrayLevel(rgba.r);
    return { fill: { kind: "gray", level }, quantized: grayLevelToByte(level) !== rgba.r };
  }
  return { fill: { kind: "rgba", ...rgba } };
}

const NAMED = /** @type {Record<string, string>} */ ({
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00",
  gray: "#808080", grey: "#808080", none: "", transparent: "#00000000",
});

/**
 * #rgb, #rrggbb, #rrggbbaa, rgb(), rgba(), a few names.
 * @param {string} s
 * @returns {{ r: number, g: number, b: number, a: number } | null}
 */
export function parseColor(s) {
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
/** @param {number} v */
function clampByte(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/**
 * The RGBA bytes the emitter writes / the preview feeds the shader for a fill.
 * @param {Fill} fill
 * @returns {{ r: number, g: number, b: number, a: number } | null}
 */
export function fillToRgba(fill) {
  if (fill.kind === "gray") {
    const v = grayLevelToByte(fill.level);
    return { r: v, g: v, b: v, a: 255 };
  }
  if (fill.kind === "rgba") return { r: fill.r, g: fill.g, b: fill.b, a: fill.a };
  return null;
}

// ---- validation ---------------------------------------------------------------

/**
 * Validate (and lightly normalize, in place, on a deep copy) a scene. Never throws on
 * bad user data; returns findings. `ok` is false only on errors.
 * @param {unknown} input
 * @returns {{ ok: boolean, scene: Scene, findings: Finding[] }}
 */
export function validateScene(input) {
  /** @type {Finding[]} */
  const findings = [];
  /** @param {string} code @param {string} message @param {string[]} [at] */
  const err = (code, message, at) => findings.push({ severity: "error", code, message, path: at && at[0] });
  /** @param {string} code @param {string} message @param {string[]} [at] */
  const warn = (code, message, at) => findings.push({ severity: "warning", code, message, path: at && at[0] });

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    err("scene-not-object", "scene must be a JSON object");
    return { ok: false, scene: newScene("invalid"), findings };
  }
  /** @type {Scene} */
  const scene = JSON.parse(JSON.stringify(input));
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

  const ids = new Set();
  for (const id of Object.keys(scene.shapes)) {
    if (ids.has(id)) err("dup-id", `id "${id}" used by more than one shape/sprite/bitmap`, [`shapes.${id}`]);
    ids.add(id);
    const sh = scene.shapes[id];
    if (!sh || !Array.isArray(sh.paths)) {
      err("shape-paths", `shape "${id}" needs a paths[] array`, [`shapes.${id}`]);
      continue;
    }
    if (!sh.paths.length) warn("shape-empty", `shape "${id}" has no paths`, [`shapes.${id}`]);
    sh.paths.forEach((p, i) => {
      const at = `shapes.${id}.paths[${i}]`;
      if (!p || typeof p.d !== "string" || !p.d.trim()) {
        err("path-d", `path has no d`, [at]);
        return;
      }
      const f = parseFill(p.fill);
      if (f.error) err("fill", f.error, [at + ".fill"]);
      else if (f.quantized) warn("fill-quantized", `gray fill ${p.fill} snapped to gray:${/** @type {any} */ (f.fill).level}`, [at + ".fill"]);
      else if (f.fill.kind === "rgba") warn("passthrough-fill", `fill ${p.fill} is not gray: the engine will NOT palette-remap it`, [at + ".fill"]);
      else if (f.fill.kind === "bitmap" && !(scene.bitmaps || {})[f.fill.id]) err("bitmap-missing", `fill references unknown bitmap "${f.fill.id}"`, [at + ".fill"]);
      if (p.fillRule && p.fillRule !== "nonzero" && p.fillRule !== "evenodd") err("fill-rule", `fillRule must be nonzero|evenodd`, [at + ".fillRule"]);
      if (p.stroke) {
        const sf = parseFill(p.stroke);
        if (sf.error) err("stroke", sf.error, [at + ".stroke"]);
        if (!((p.strokeWidth ?? 0) > 0)) warn("stroke-width", "stroke set but strokeWidth is 0; stroke dropped", [at + ".strokeWidth"]);
      }
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
  for (const id of Object.keys(scene.sprites)) {
    const sp = scene.sprites[id];
    const at = `sprites.${id}`;
    if (!sp || !Array.isArray(sp.layers)) {
      err("sprite-layers", `sprite "${id}" needs layers[]`, [at]);
      continue;
    }
    if (!(Number.isInteger(sp.frames) && sp.frames >= 1)) {
      err("sprite-frames", `sprite "${id}" frames must be an integer >= 1`, [at + ".frames"]);
      sp.frames = Math.max(1, sp.frames | 0);
    }
    sp.labels = sp.labels || {};
    for (const [label, fr] of Object.entries(sp.labels)) {
      if (!/^[A-Za-z_][A-Za-z0-9_ -]*$/.test(label)) warn("label-name", `label "${label}" has unusual characters`, [at + ".labels"]);
      if (!(Number.isInteger(fr) && fr >= 0 && fr < sp.frames)) err("label-frame", `label "${label}" frame ${fr} outside 0..${sp.frames - 1}`, [at + ".labels." + label]);
    }
    const depths = new Set();
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
          if (typeof k.ref !== "string" || !(scene.shapes[k.ref] || scene.sprites[k.ref])) err("ref-missing", `ref "${String(k.ref)}" is not a shape or sprite`, [kat + ".ref"]);
          else if (k.ref === id) err("ref-self", `sprite "${id}" cannot contain itself`, [kat + ".ref"]);
        }
        if (k.tween && k.tween !== "hold" && k.tween !== "linear") err("key-tween", "tween must be hold|linear", [kat + ".tween"]);
        if (k.matrix && (!Array.isArray(k.matrix) || k.matrix.length !== 6)) err("key-matrix", "matrix must be a 6-number array", [kat + ".matrix"]);
        if (k.cxform) {
          for (const f of /** @type {const} */ (["mul", "add"])) {
            const v = k.cxform[f];
            if (v !== undefined && (!Array.isArray(v) || v.length !== 4)) err("key-cxform", `cxform.${f} must have 4 numbers`, [kat + ".cxform"]);
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
  }
  scene.stage_instances.forEach((si, i) => {
    if (!si || typeof si.ref !== "string" || !(scene.shapes[si.ref] || scene.sprites[si.ref])) err("stage-ref", `stage_instances[${i}].ref is not a shape or sprite`, [`stage_instances[${i}]`]);
  });
  if (scene.curveResolution !== undefined && !(Number.isInteger(scene.curveResolution) && scene.curveResolution >= 1)) warn("curve-resolution", "curveResolution must be a positive integer; ignored", ["curveResolution"]);

  return { ok: !findings.some((f) => f.severity === "error"), scene, findings };
}

/**
 * @param {Scene} scene @param {string} id @param {Set<string>} stack
 */
function hasCycle(scene, id, stack) {
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
 * @param {Scene} scene
 * @returns {string[]}
 */
export function buildOrder(scene) {
  const out = Object.keys(scene.bitmaps || {}).sort();
  out.push(...Object.keys(scene.shapes).sort());
  const seen = new Set(out);
  const visit = (/** @type {string} */ id) => {
    if (seen.has(id)) return;
    seen.add(id);
    const sp = scene.sprites[id];
    for (const layer of sp.layers || []) for (const k of layer.keys || []) if (k.ref && scene.sprites[k.ref]) visit(k.ref);
    out.push(id);
  };
  for (const id of Object.keys(scene.sprites).sort()) visit(id);
  return out;
}

/**
 * Which gray levels a shape uses (for the UI ramps) and whether it has passthrough fills.
 * @param {SceneShape} shape
 */
export function shapeGrayUsage(shape) {
  const levels = new Set();
  let passthrough = 0;
  let bitmaps = 0;
  for (const p of shape.paths || []) {
    const f = parseFill(p.fill).fill;
    if (f.kind === "gray") levels.add(f.level);
    else if (f.kind === "rgba") passthrough++;
    else if (f.kind === "bitmap") bitmaps++;
  }
  return { levels: [...levels].sort((a, b) => a - b), passthrough, bitmaps };
}
