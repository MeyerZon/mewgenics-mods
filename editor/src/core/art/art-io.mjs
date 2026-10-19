// Mod-side IO for the art pipeline: scenes live at mods/<mod>/art/*.scene.json,
// built SWFs at mods/<mod>/swfs/<name>.swf and the manifest overlay at
// mods/<mod>/swfs/swflist.gon.append (the whole swfs/ dir is build output, git-ignored
// as mods/*/swfs/; art/*.scene.json is the source). Every path goes through
// resolveModWritePath, so nothing can land outside mods/<mod>/ or near saves/ or the
// protected game files.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { MODS_DIR, resolveModWritePath } from "../repo.mjs";
import { validateScene, newScene, exampleScene, DEFAULT_ABC_MODE } from "./scene.mjs";
import { importSvg } from "./svg-import.mjs";
import { decodePng } from "./png.mjs";
import { emitSwf, minimalGateSwf } from "./swf-emitter.mjs";
import { readSwf } from "./swf-reader.mjs";

/**
 * @typedef {import('./scene.mjs').Scene} Scene
 * @typedef {import('./scene.mjs').Finding} Finding
 */

export const ART_DIR = "art";
export const SWF_DIR = "swfs";
export const SCENE_SUFFIX = ".scene.json";

/** @param {string} modName */
function modDir(modName) {
  return join(MODS_DIR, modName);
}

/** @param {unknown} e */
function errText(e) {
  return String(e instanceof Error ? e.message : e);
}

/**
 * List a mod's art assets.
 * @param {string} modName
 */
export function listArtScenes(modName) {
  const dir = modDir(modName);
  if (!existsSync(dir)) return { ok: false, error: `mod not found: mods/${modName}`, scenes: [], swfs: [], svgs: [], pngs: [], swflistAppend: null };
  /** @type {Array<{relPath:string, name:string, bytes:number}>} */
  const scenes = [];
  /** @type {Array<{relPath:string, bytes:number, mtimeMs:number}>} */
  const swfs = [];
  /** @type {string[]} */
  const svgs = [];
  /** @type {string[]} */
  const pngs = [];
  let swflistAppend = null;
  /** @param {string} d */
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, ent.name);
      if (ent.isDirectory()) {
        if (ent.name.toLowerCase() !== "saves") walk(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      const rel = relative(dir, abs).replace(/\\/g, "/");
      const st = statSync(abs);
      if (rel.endsWith(SCENE_SUFFIX)) scenes.push({ relPath: rel, name: ent.name.slice(0, -SCENE_SUFFIX.length), bytes: st.size });
      else if (/\.swf$/i.test(rel)) swfs.push({ relPath: rel, bytes: st.size, mtimeMs: st.mtimeMs });
      else if (/\.svg$/i.test(rel)) svgs.push(rel);
      else if (/\.png$/i.test(rel)) pngs.push(rel);
      else if (rel === `${SWF_DIR}/swflist.gon.append`) swflistAppend = rel;
    }
  };
  walk(dir);
  scenes.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { ok: true, scenes, swfs, svgs, pngs, swflistAppend };
}

/**
 * Read + validate a scene file.
 * @param {string} modName @param {string} relPath
 * @returns {{ ok: boolean, relPath: string, scene?: Scene, findings: Finding[], error?: string, text?: string }}
 */
export function readArtScene(modName, relPath) {
  let abs;
  try {
    abs = resolveModWritePath(modName, relPath);
  } catch (e) {
    return { ok: false, relPath, findings: [], error: errText(e) };
  }
  if (!existsSync(abs)) return { ok: false, relPath, findings: [], error: `file not found: mods/${modName}/${relPath}` };
  const text = readFileSync(abs, "utf8");
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, relPath, findings: [{ severity: "error", code: "scene-json", message: `invalid JSON: ${errText(e)}` }], error: "invalid JSON", text };
  }
  const v = validateScene(json);
  return { ok: v.ok, relPath, scene: v.scene, findings: v.findings, text };
}

/**
 * Validate and write a scene (pretty JSON). Refuses to write an invalid scene unless
 * `force` is set (so a half-edited scene can still be saved from the UI).
 * @param {string} modName @param {string} relPath @param {unknown} sceneInput @param {{ force?: boolean }} [opts]
 */
export function writeArtScene(modName, relPath, sceneInput, opts = {}) {
  if (!relPath.endsWith(SCENE_SUFFIX)) return { ok: false, error: `scene files must end with ${SCENE_SUFFIX}`, findings: [] };
  const v = validateScene(sceneInput);
  if (!v.ok && !opts.force) return { ok: false, error: "scene has errors (pass force to save anyway)", findings: v.findings };
  let abs;
  try {
    abs = resolveModWritePath(modName, relPath);
  } catch (e) {
    return { ok: false, error: errText(e), findings: v.findings };
  }
  mkdirSync(dirname(abs), { recursive: true });
  const text = JSON.stringify(opts.force ? sceneInput : v.scene, null, 2) + "\n";
  writeFileSync(abs, text);
  return { ok: true, path: `mods/${modName}/${relPath}`, bytes: Buffer.from(text).length, findings: v.findings, valid: v.ok };
}

/**
 * Create a new scene file from the starter example (or empty).
 * @param {string} modName @param {string} name @param {{ starter?: boolean }} [opts]
 */
export function newArtScene(modName, name, opts = {}) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name)) return { ok: false, error: `invalid scene name ${JSON.stringify(name)}`, findings: [] };
  const relPath = `${ART_DIR}/${name}${SCENE_SUFFIX}`;
  let abs;
  try {
    abs = resolveModWritePath(modName, relPath);
  } catch (e) {
    return { ok: false, error: errText(e), findings: [] };
  }
  if (existsSync(abs)) return { ok: false, error: `already exists: mods/${modName}/${relPath}`, findings: [] };
  const scene = opts.starter === false ? newScene(name) : exampleScene(name);
  const r = writeArtScene(modName, relPath, scene);
  return r.ok ? { ...r, relPath, scene } : r;
}

/**
 * Raw bytes of a file inside the mod (PNG/SVG assets for the preview and importer).
 * @param {string} modName @param {string} relPath
 * @returns {{ ok: true, bytes: Uint8Array, mime: string } | { ok: false, error: string }}
 */
export function readModBytes(modName, relPath) {
  let abs;
  try {
    abs = resolveModWritePath(modName, relPath);
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) return { ok: false, error: `file not found: mods/${modName}/${relPath}` };
  const lower = relPath.toLowerCase();
  const mime = lower.endsWith(".png") ? "image/png" : lower.endsWith(".svg") ? "image/svg+xml" : lower.endsWith(".swf") ? "application/x-shockwave-flash" : lower.endsWith(".json") ? "application/json" : "application/octet-stream";
  return { ok: true, bytes: new Uint8Array(readFileSync(abs)), mime };
}

/**
 * Write raw bytes (e.g. an uploaded SVG/PNG) into the mod's art folder.
 * @param {string} modName @param {string} relPath @param {Uint8Array} bytes
 */
export function writeModBytes(modName, relPath, bytes) {
  if (!/\.(svg|png)$/i.test(relPath)) return { ok: false, error: "only .svg and .png assets can be written here" };
  let abs;
  try {
    abs = resolveModWritePath(modName, relPath);
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
  return { ok: true, path: `mods/${modName}/${relPath}`, bytes: bytes.length };
}

/**
 * Import an SVG (text, or a file already inside the mod) into a scene shape. Does not
 * write; returns the shape so the UI/MCP can place it under `scene.shapes[id]`.
 * @param {{ svgText?: string, mod?: string, relPath?: string, options?: import('./svg-import.mjs').ImportOptions }} args
 */
export function importSvgShape(args) {
  let text = args.svgText;
  let source = args.relPath;
  if (text === undefined) {
    if (!args.mod || !args.relPath) return { ok: false, error: "pass svgText, or mod + relPath of an .svg inside the mod", findings: [] };
    const r = readModBytes(args.mod, args.relPath);
    if (!r.ok) return { ok: false, error: r.error, findings: [] };
    text = new TextDecoder().decode(r.bytes);
  }
  const res = importSvg(text, args.options || {});
  /** @type {import('./scene.mjs').SceneShape} */
  const shape = { paths: res.paths };
  if (source) shape.source = source;
  return { ok: res.ok, shape, findings: res.findings, info: res.info };
}

/**
 * Decode every bitmap the scene references (PNG files inside the mod).
 * @param {string} modName @param {Scene} scene
 * @returns {{ bitmaps: Map<string, {width:number, height:number, rgba:Uint8Array}>, findings: Finding[] }}
 */
export function loadSceneBitmaps(modName, scene) {
  const bitmaps = new Map();
  /** @type {Finding[]} */
  const findings = [];
  for (const [id, bm] of Object.entries(scene.bitmaps || {})) {
    const r = readModBytes(modName, bm.file);
    if (!r.ok) {
      findings.push({ severity: "error", code: "bitmap-read", message: `bitmap "${id}": ${r.error}`, path: `bitmaps.${id}.file` });
      continue;
    }
    try {
      bitmaps.set(id, decodePng(r.bytes));
    } catch (e) {
      findings.push({ severity: "error", code: "bitmap-decode", message: `bitmap "${id}": ${errText(e)}`, path: `bitmaps.${id}.file` });
    }
  }
  return { bitmaps, findings };
}

/**
 * Build a scene into mods/<mod>/swfs/<scene.name>.swf.
 * @param {string} modName @param {string} relPath scene file
 * @param {{ abc?: 'none'|'stub', overrideScene?: unknown, writeSwflist?: boolean, dryRun?: boolean }} [opts]
 */
export function buildSwf(modName, relPath, opts = {}) {
  const abcMode = opts.abc || DEFAULT_ABC_MODE;
  if (abcMode !== "none" && abcMode !== "stub") return { ok: false, error: `abc must be none|stub, got ${String(abcMode)}`, findings: [] };
  /** @type {Scene} */
  let scene;
  /** @type {Finding[]} */
  let findings;
  if (opts.overrideScene !== undefined) {
    const v = validateScene(opts.overrideScene);
    if (!v.ok) return { ok: false, error: "scene has errors", findings: v.findings };
    scene = v.scene;
    findings = v.findings;
  } else {
    const r = readArtScene(modName, relPath);
    if (!r.ok || !r.scene) return { ok: false, error: r.error || "scene has errors", findings: r.findings };
    scene = r.scene;
    findings = r.findings;
  }
  const bm = loadSceneBitmaps(modName, scene);
  findings = findings.concat(bm.findings);
  if (bm.findings.some((f) => f.severity === "error")) return { ok: false, error: "bitmap problems", findings };
  const out = emitSwf(scene, { abc: abcMode, bitmaps: bm.bitmaps });
  findings = findings.concat(out.findings);
  if (out.findings.some((f) => f.severity === "error")) return { ok: false, error: "emitter reported errors", findings, report: out.report };
  // self-check: our reader must parse what we wrote
  let verify;
  try {
    const parsed = readSwf(out.bytes);
    verify = { ok: true, tags: parsed.tags.length, frameCount: parsed.header.frameCount };
  } catch (e) {
    verify = { ok: false, error: errText(e) };
    findings.push({ severity: "error", code: "self-check", message: `emitted SWF failed to re-parse: ${errText(e)}` });
    return { ok: false, error: "self-check failed", findings, report: out.report };
  }
  const swfRel = `${SWF_DIR}/${scene.name}.swf`;
  if (opts.dryRun) return { ok: true, dryRun: true, swfPath: `mods/${modName}/${swfRel}`, bytes: out.bytes.length, report: out.report, findings, verify, abc: abcMode };
  let abs;
  try {
    abs = resolveModWritePath(modName, swfRel);
  } catch (e) {
    return { ok: false, error: errText(e), findings };
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, out.bytes);
  let swflist = null;
  if (opts.writeSwflist !== false) swflist = writeSwflistAppend(modName, [{ file: `${scene.name}.swf`, curveResolution: scene.curveResolution }]);
  return { ok: true, swfPath: `mods/${modName}/${swfRel}`, bytes: out.bytes.length, report: out.report, findings, verify, abc: abcMode, swflist };
}

/**
 * Write (or extend) mods/<mod>/swfs/swflist.gon.append so the engine loads the listed
 * SWFs. Idempotent: existing entries are kept, duplicates are not added. The format is
 * GON Append semantics onto `swfs/swflist.gon` (docs/data-mods.md): a `game [ ... ]` array
 * and optional `per_file_curve_resolution { <file> N }`.
 * @param {string} modName @param {Array<{file:string, curveResolution?: number}>} entries
 */
export function writeSwflistAppend(modName, entries) {
  const rel = `${SWF_DIR}/swflist.gon.append`;
  let abs;
  try {
    abs = resolveModWritePath(modName, rel);
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
  const existing = existsSync(abs) ? readFileSync(abs, "utf8") : "";
  const have = new Set();
  /** @type {Map<string, number>} */
  const res = new Map();
  const gameBlock = /game\s*\[([^\]]*)\]/.exec(existing);
  if (gameBlock) for (const tok of gameBlock[1].split(/\s+/)) if (tok && !tok.startsWith("//")) have.add(tok.replace(/^"|"$/g, ""));
  const resBlock = /per_file_curve_resolution\s*\{([^}]*)\}/.exec(existing);
  if (resBlock) {
    const re = /("?[^\s"{}]+"?)\s+(\d+)/g;
    let m;
    while ((m = re.exec(resBlock[1]))) res.set(m[1].replace(/^"|"$/g, ""), Number(m[2]));
  }
  for (const e of entries) {
    have.add(e.file);
    if (e.curveResolution) res.set(e.file, e.curveResolution);
  }
  const quote = (/** @type {string} */ f) => (/[\s/]/.test(f) ? `"${f}"` : f);
  let text = "// generated by the mod editor art pipeline — appends mod SWFs to swfs/swflist.gon\n";
  text += "game [\n" + [...have].map((f) => `    ${quote(f)}\n`).join("") + "]\n";
  if (res.size) text += "\nper_file_curve_resolution {\n" + [...res].map(([f, n]) => `    ${quote(f)} ${n}\n`).join("") + "}\n";
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return { ok: true, path: `mods/${modName}/${rel}`, files: [...have], text };
}

/**
 * Inspect a built (or any) SWF inside a mod with the verification reader: header, tag
 * histogram, SymbolClass names, frame labels, DoABC presence.
 * @param {string} modName @param {string} relPath
 */
export function inspectSwf(modName, relPath) {
  const r = readModBytes(modName, relPath);
  if (!r.ok) return { ok: false, error: r.error };
  try {
    const parsed = readSwf(r.bytes);
    /** @type {Record<string, number>} */
    const histogram = {};
    /** @type {string[]} */
    const labels = [];
    /** @type {Array<{id:number, name:string}>} */
    const exports = [];
    let doAbc = 0;
    const walk = (/** @type {any[]} */ tags) => {
      for (const t of tags) {
        histogram[t.name] = (histogram[t.name] || 0) + 1;
        if (t.name === "FrameLabel" && t.label !== undefined) labels.push(t.label);
        if (t.name === "SymbolClass" && Array.isArray(t.entries)) for (const e of t.entries) exports.push({ id: e.id, name: e.name });
        if (t.name === "DoABC") doAbc++;
        if (Array.isArray(t.tags)) walk(t.tags);
      }
    };
    walk(parsed.tags);
    return { ok: true, header: parsed.header, histogram, labels, exports, doAbc, bytes: r.bytes.length };
  } catch (e) {
    return { ok: false, error: `not a readable SWF: ${errText(e)}` };
  }
}

// ---- the SWF gate (docs/swf-emitter-fix-spec.md §8, docs/art-preview-plan.md §7) ----
//
// One generated donor SWF + a one-entry swflist.gon.append in a dedicated mod, run through the
// in-game harness (mods/swf-gate/tests/boot.mewtest): the game either boots to the main menu
// (`pass`) or faults in the post-load merge (`crash`). Variants isolate the cause:

/** The mod the gate lives in; `*.swf` and the generated `.append` are git-ignored there. */
export const SWF_GATE_MOD = "swf-gate";
export const SWF_GATE_FILE = "gate.swf";
/** The frame label = the ability whose icon the donor appends (a jokers-luck ability with no vanilla icon). */
export const SWF_GATE_LABEL = "JokersGambit";

/**
 * `expect` is the harness verdict the variant must produce (OBSERVED 2026-10-19; runs recorded in the PR for
 * fix/swf-append-frame): every real-target donor boots to the main menu; an unknown target logs
 * "Append movieclip: … could not locate original movieclip to append to" (Application.cpp:1363) and the boot then
 * never reaches the console (verdict `harness-error`, reason `console_unavailable`, no crash report) — which
 * doubles as the proof that process_animation_merges ran over our SymbolClass.
 * @type {Record<string, { linkage: string, layout: "flat" | "nested" | "legacy", expect: string, note: string }>}
 */
export const SWF_GATE_VARIANTS = {
  flat: { linkage: "_Append_AbilityIcon", layout: "flat", expect: "pass", note: "the fix: bare shape at depth 3, exactly like AbilityIcon's own labeled frames" },
  nested: { linkage: "_Append_AbilityIcon", layout: "nested", expect: "pass", note: "spec §8.1 alternative: the shape wrapped in a nested movieclip at depth 3" },
  legacy: { linkage: "_Append_AbilityIcon", layout: "legacy", expect: "pass", note: "the pre-fix donor (shape at depth 1); it boots too, so the 2026-10-18 crash is not a boot-time merge fault" },
  probe: { linkage: "GateProbe", layout: "flat", expect: "pass", note: "load-only control: the same bytes under a non-_Append_ linkage, so nothing is merged" },
  missing: { linkage: "_Append_NoSuchClipXYZ", layout: "flat", expect: "harness-error", note: "merge witness: an unknown append target is logged and then stalls the boot before the console appears" },
};

/**
 * Write (or, for `control`, remove) the gate files in `mods/<mod>/swfs/`: `gate.swf` and a
 * `swflist.gon.append` listing only it. Nothing is launched here; `npm run test:swfgate -- <variant>`
 * does both. Only `mods/<mod>/` is ever written.
 * @param {{ mod?: string, variant: "flat" | "nested" | "legacy" | "probe" | "missing" | "control" }} o
 */
export function prepareSwfGate(o) {
  const modName = (o && o.mod) || SWF_GATE_MOD;
  const variant = o && o.variant;
  const isControl = variant === "control";
  const spec = !isControl && variant && Object.prototype.hasOwnProperty.call(SWF_GATE_VARIANTS, variant) ? SWF_GATE_VARIANTS[variant] : null;
  if (!isControl && !spec) return { ok: false, error: `unknown gate variant ${JSON.stringify(variant)}; use one of ${[...Object.keys(SWF_GATE_VARIANTS), "control"].join(", ")}` };
  const rels = [`${SWF_DIR}/${SWF_GATE_FILE}`, `${SWF_DIR}/swflist.gon.append`];
  /** @type {string[]} */
  const abs = [];
  for (const rel of rels) {
    try {
      abs.push(resolveModWritePath(modName, rel));
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  }
  const next = `cd editor && npm run test:swfgate -- ${variant}`;
  if (isControl) {
    /** @type {string[]} */
    const removed = [];
    rels.forEach((rel, i) => {
      if (existsSync(abs[i])) {
        rmSync(abs[i]);
        removed.push(`mods/${modName}/${rel}`);
      }
    });
    return { ok: true, variant, mod: modName, written: [], removed, expect: "pass", note: "no gate files: a vanilla boot with the mod path present", next };
  }
  if (!spec) return { ok: false, error: "unreachable" };
  const bytes = minimalGateSwf({ withAbc: false, linkage: spec.linkage, label: SWF_GATE_LABEL, layout: spec.layout });
  const list = `// SWF gate variant "${variant}" (docs/swf-emitter-fix-spec.md §8): generated by prepareSwfGate — regenerate, do not edit\ngame [\n    ${SWF_GATE_FILE}\n]\n`;
  const payload = [bytes, new TextEncoder().encode(list)];
  /** @type {string[]} */
  const written = [];
  rels.forEach((rel, i) => {
    mkdirSync(dirname(abs[i]), { recursive: true });
    writeFileSync(abs[i], payload[i]);
    written.push(`mods/${modName}/${rel}`);
  });
  return { ok: true, variant, mod: modName, written, removed: [], linkage: spec.linkage, label: SWF_GATE_LABEL, layout: spec.layout, expect: spec.expect, note: spec.note, next };
}
