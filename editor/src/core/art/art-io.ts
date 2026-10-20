// Mod-side IO for the art pipeline: scenes live at mods/<mod>/art/*.scene.json,
// built SWFs at mods/<mod>/swfs/<name>.swf and the manifest overlay at
// mods/<mod>/swfs/swflist.gon.append (the whole swfs/ dir is build output, git-ignored
// as mods/*/swfs/; art/*.scene.json is the source). Every path goes through
// resolveModWritePath, so nothing can land outside mods/<mod>/ or near saves/ or the
// protected game files.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { MODS_DIR, REPO_ROOT, resolveModWritePath, isInside, touchesSaves } from "../repo.ts";
import { validateScene, newScene, exampleScene, DEFAULT_ABC_MODE } from "./scene.ts";
import type { Scene, SceneShape, SceneGradient, Finding } from "./scene.ts";
import { importSvg } from "./svg-import.ts";
import { adoptGradients } from "./gradient.ts";
import { shapeToSvg } from "./svg-export.ts";
import type { ImportOptions, ImportInfo } from "./svg-import.ts";
import { decodePng } from "./png.ts";
import type { RgbaImage } from "./png.ts";
import { emitSwf, minimalGateSwf } from "./swf-emitter.ts";
import type { EmitReport } from "./swf-emitter.ts";
import { readSwf } from "./swf-reader.ts";
import type { SwfHeader, Tag } from "./swf-reader.ts";

export const ART_DIR = "art";
export const SWF_DIR = "swfs";
export const SCENE_SUFFIX = ".scene.json";

function modDir(modName: string): string {
  return join(MODS_DIR, modName);
}

function errText(e: unknown): string {
  return String(e instanceof Error ? e.message : e);
}

export interface SceneListEntry {
  relPath: string;
  name: string;
  bytes: number;
}
export interface SwfListEntry {
  relPath: string;
  bytes: number;
  mtimeMs: number;
}
export interface ArtListing {
  ok: boolean;
  error?: string;
  scenes: SceneListEntry[];
  swfs: SwfListEntry[];
  svgs: string[];
  pngs: string[];
  swflistAppend: string | null;
}

/** List a mod's art assets. */
export function listArtScenes(modName: string): ArtListing {
  const dir = modDir(modName);
  if (!existsSync(dir)) return { ok: false, error: `mod not found: mods/${modName}`, scenes: [], swfs: [], svgs: [], pngs: [], swflistAppend: null };
  const scenes: SceneListEntry[] = [];
  const swfs: SwfListEntry[] = [];
  const svgs: string[] = [];
  const pngs: string[] = [];
  let swflistAppend: string | null = null;
  const walk = (d: string) => {
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

export interface SceneReadResult {
  ok: boolean;
  relPath: string;
  scene?: Scene;
  findings: Finding[];
  error?: string;
  text?: string;
}

/** Read + validate a scene file. */
export function readArtScene(modName: string, relPath: string): SceneReadResult {
  let abs: string;
  try {
    abs = resolveModWritePath(modName, relPath);
  } catch (e) {
    return { ok: false, relPath, findings: [], error: errText(e) };
  }
  if (!existsSync(abs)) return { ok: false, relPath, findings: [], error: `file not found: mods/${modName}/${relPath}` };
  const text = readFileSync(abs, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, relPath, findings: [{ severity: "error", code: "scene-json", message: `invalid JSON: ${errText(e)}` }], error: "invalid JSON", text };
  }
  const v = validateScene(json);
  return { ok: v.ok, relPath, scene: v.scene, findings: v.findings, text };
}

export interface SceneWriteResult {
  ok: boolean;
  error?: string;
  findings: Finding[];
  path?: string;
  bytes?: number;
  valid?: boolean;
}

/**
 * Validate and write a scene (pretty JSON). Refuses to write an invalid scene unless
 * `force` is set (so a half-edited scene can still be saved from the UI).
 */
export function writeArtScene(modName: string, relPath: string, sceneInput: unknown, opts: { force?: boolean } = {}): SceneWriteResult {
  if (!relPath.endsWith(SCENE_SUFFIX)) return { ok: false, error: `scene files must end with ${SCENE_SUFFIX}`, findings: [] };
  const v = validateScene(sceneInput);
  if (!v.ok && !opts.force) return { ok: false, error: "scene has errors (pass force to save anyway)", findings: v.findings };
  let abs: string;
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

export interface NewSceneResult extends SceneWriteResult {
  relPath?: string;
  scene?: Scene;
}

/** Create a new scene file from the starter example (or empty). */
export function newArtScene(modName: string, name: string, opts: { starter?: boolean } = {}): NewSceneResult {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name)) return { ok: false, error: `invalid scene name ${JSON.stringify(name)}`, findings: [] };
  const relPath = `${ART_DIR}/${name}${SCENE_SUFFIX}`;
  let abs: string;
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

export type ModBytesResult = { ok: true; bytes: Uint8Array; mime: string } | { ok: false; error: string };

/** Raw bytes of a file inside the mod (PNG/SVG assets for the preview and importer). */
export function readModBytes(modName: string, relPath: string): ModBytesResult {
  let abs: string;
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

export type WriteBytesResult = { ok: true; path: string; bytes: number } | { ok: false; error: string };

/** Write raw bytes (e.g. an uploaded SVG/PNG) into the mod's art folder. */
export function writeModBytes(modName: string, relPath: string, bytes: Uint8Array): WriteBytesResult {
  if (!/\.(svg|png)$/i.test(relPath)) return { ok: false, error: "only .svg and .png assets can be written here" };
  let abs: string;
  try {
    abs = resolveModWritePath(modName, relPath);
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
  return { ok: true, path: `mods/${modName}/${relPath}`, bytes: bytes.length };
}

export interface ImportSvgArgs {
  svgText?: string;
  mod?: string;
  relPath?: string;
  options?: ImportOptions;
}
export interface ImportSvgResult {
  ok: boolean;
  error?: string;
  shape?: SceneShape;
  /** gradients the shape's fills reference; add them to scene.gradients (adoptGradients in gradient.ts) */
  gradients?: Record<string, SceneGradient>;
  findings: Finding[];
  info?: ImportInfo;
}

/**
 * Import an SVG (text, or a file already inside the mod) into a scene shape. Does not
 * write; returns the shape so the UI/MCP can place it under `scene.shapes[id]`.
 */
export function importSvgShape(args: ImportSvgArgs): ImportSvgResult {
  let text = args.svgText;
  const source = args.relPath;
  if (text === undefined) {
    if (!args.mod || !args.relPath) return { ok: false, error: "pass svgText, or mod + relPath of an .svg inside the mod", findings: [] };
    const r = readModBytes(args.mod, args.relPath);
    if (!r.ok) return { ok: false, error: r.error, findings: [] };
    text = new TextDecoder().decode(r.bytes);
  }
  const res = importSvg(text, args.options || {});
  const shape: SceneShape = { paths: res.paths };
  if (source) shape.source = source;
  return { ok: res.ok, shape, gradients: res.gradients, findings: res.findings, info: res.info };
}

export interface ImportSvgIntoSceneArgs {
  mod: string;
  /** the scene file inside the mod, e.g. art/my_rat.scene.json */
  scenePath: string;
  /** the shape id to add (or replace) */
  shapeId: string;
  svgText?: string;
  /** an .svg inside the mod instead of svgText */
  svgPath?: string;
  options?: ImportOptions;
  /** replace a shape with the same id (default false: refuse) */
  replace?: boolean;
}
/** Import an SVG and save it as a shape of a scene in one step (the agent-facing convenience behind MCP import_svg). */
export function importSvgIntoScene(args: ImportSvgIntoSceneArgs): { ok: boolean; error?: string; paths?: number; findings: Finding[] } {
  const rd = readArtScene(args.mod, args.scenePath);
  if (!rd.ok || !rd.scene) return { ok: false, error: rd.error || "scene does not validate (fix it or write it with force first)", findings: rd.findings || [] };
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(args.shapeId)) return { ok: false, error: `bad shape id ${JSON.stringify(args.shapeId)}`, findings: [] };
  if (rd.scene.shapes[args.shapeId] && !args.replace) return { ok: false, error: `shape "${args.shapeId}" exists (pass replace: true to overwrite it)`, findings: [] };
  const imp = importSvgShape({ svgText: args.svgText, mod: args.svgText === undefined ? args.mod : undefined, relPath: args.svgPath, options: args.options });
  if (!imp.ok || !imp.shape) return { ok: false, error: imp.error || "import failed", findings: imp.findings || [] };
  const next: Scene = { ...rd.scene, shapes: { ...rd.scene.shapes }, gradients: { ...(rd.scene.gradients || {}) } };
  delete next.shapes[args.shapeId];
  next.shapes[args.shapeId] = adoptGradients(next, imp.shape, imp.gradients);
  const w = writeArtScene(args.mod, args.scenePath, next);
  if (!w.ok) return { ok: false, error: w.error || "write failed", findings: [...(imp.findings || []), ...((w as { findings?: Finding[] }).findings || [])] };
  return { ok: true, paths: imp.shape.paths.length, findings: imp.findings || [] };
}

/**
 * Export one shape of a scene as art/<shapeId>.svg inside the mod, for an external vector editor (VectorCraft,
 * Inkscape, …). Import it back with importSvgIntoScene({ …, replace: true, options: { applyViewBox: false } }).
 */
export function exportShapeSvg(modName: string, scenePath: string, shapeId: string): { ok: boolean; error?: string; relPath?: string; svg?: string; findings: Finding[] } {
  const rd = readArtScene(modName, scenePath);
  if (!rd.ok || !rd.scene) return { ok: false, error: rd.error || "scene does not validate", findings: rd.findings || [] };
  const shape = rd.scene.shapes[shapeId];
  if (!shape) return { ok: false, error: `no shape "${shapeId}" in ${scenePath}`, findings: [] };
  const out = shapeToSvg(shape, rd.scene.gradients || {});
  const relPath = `art/${shapeId.replace(/[^A-Za-z0-9_.-]/g, "_")}.svg`;
  const w = writeModBytes(modName, relPath, new TextEncoder().encode(out.svg));
  if (!w.ok) return { ok: false, error: w.error, findings: out.findings };
  return { ok: true, relPath, svg: out.svg, findings: out.findings };
}

/** Decode every bitmap the scene references (PNG files inside the mod). */
export function loadSceneBitmaps(modName: string, scene: Scene): { bitmaps: Map<string, RgbaImage>; findings: Finding[] } {
  const bitmaps = new Map<string, RgbaImage>();
  const findings: Finding[] = [];
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

export type AbcMode = "none" | "stub";

export interface BuildSwfOptions {
  abc?: AbcMode;
  overrideScene?: unknown;
  writeSwflist?: boolean;
  dryRun?: boolean;
}

export interface SwfVerify {
  ok: boolean;
  tags?: number;
  frameCount?: number;
  error?: string;
}

export interface BuildSwfResult {
  ok: boolean;
  error?: string;
  findings: Finding[];
  report?: EmitReport;
  dryRun?: boolean;
  swfPath?: string;
  bytes?: number;
  verify?: SwfVerify;
  abc?: AbcMode;
  swflist?: SwflistResult | null;
}

/**
 * Build a scene into mods/<mod>/swfs/<scene.name>.swf.
 * @param relPath scene file
 */
export function buildSwf(modName: string, relPath: string, opts: BuildSwfOptions = {}): BuildSwfResult {
  const abcMode = opts.abc || DEFAULT_ABC_MODE;
  if (abcMode !== "none" && abcMode !== "stub") return { ok: false, error: `abc must be none|stub, got ${String(abcMode)}`, findings: [] };
  let scene: Scene;
  let findings: Finding[];
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
  let verify: SwfVerify;
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
  let abs: string;
  try {
    abs = resolveModWritePath(modName, swfRel);
  } catch (e) {
    return { ok: false, error: errText(e), findings };
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, out.bytes);
  let swflist: SwflistResult | null = null;
  if (opts.writeSwflist !== false) swflist = writeSwflistAppend(modName, [{ file: `${scene.name}.swf`, curveResolution: scene.curveResolution }]);
  return { ok: true, swfPath: `mods/${modName}/${swfRel}`, bytes: out.bytes.length, report: out.report, findings, verify, abc: abcMode, swflist };
}

export interface SwflistEntry {
  file: string;
  curveResolution?: number;
}
export type SwflistResult = { ok: true; path: string; files: string[]; text: string } | { ok: false; error: string };

/**
 * Write (or extend) mods/<mod>/swfs/swflist.gon.append so the engine loads the listed
 * SWFs. Idempotent: existing entries are kept, duplicates are not added. The format is
 * GON Append semantics onto `swfs/swflist.gon` (docs/data-mods.md): a `game [ ... ]` array
 * and optional `per_file_curve_resolution { <file> N }`.
 */
export function writeSwflistAppend(modName: string, entries: SwflistEntry[]): SwflistResult {
  const rel = `${SWF_DIR}/swflist.gon.append`;
  let abs: string;
  try {
    abs = resolveModWritePath(modName, rel);
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
  const existing = existsSync(abs) ? readFileSync(abs, "utf8") : "";
  const have = new Set<string>();
  const res = new Map<string, number>();
  const gameBlock = /game\s*\[([^\]]*)\]/.exec(existing);
  if (gameBlock) for (const tok of gameBlock[1].split(/\s+/)) if (tok && !tok.startsWith("//")) have.add(tok.replace(/^"|"$/g, ""));
  const resBlock = /per_file_curve_resolution\s*\{([^}]*)\}/.exec(existing);
  if (resBlock) {
    const re = /("?[^\s"{}]+"?)\s+(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(resBlock[1]))) res.set(m[1].replace(/^"|"$/g, ""), Number(m[2]));
  }
  for (const e of entries) {
    have.add(e.file);
    if (e.curveResolution) res.set(e.file, e.curveResolution);
  }
  const quote = (f: string) => (/[\s/]/.test(f) ? `"${f}"` : f);
  let text = "// generated by the mod editor art pipeline — appends mod SWFs to swfs/swflist.gon\n";
  text += "game [\n" + [...have].map((f) => `    ${quote(f)}\n`).join("") + "]\n";
  if (res.size) text += "\nper_file_curve_resolution {\n" + [...res].map(([f, n]) => `    ${quote(f)} ${n}\n`).join("") + "}\n";
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return { ok: true, path: `mods/${modName}/${rel}`, files: [...have], text };
}

export interface InspectSwfResult {
  ok: boolean;
  error?: string;
  header?: SwfHeader;
  histogram?: Record<string, number>;
  labels?: string[];
  exports?: Array<{ id: number; name: string }>;
  doAbc?: number;
  bytes?: number;
}

/**
 * Inspect a built (or any) SWF inside a mod with the verification reader: header, tag
 * histogram, SymbolClass names, frame labels, DoABC presence.
 */
export function inspectSwf(modName: string, relPath: string): InspectSwfResult {
  const r = readModBytes(modName, relPath);
  if (!r.ok) return { ok: false, error: r.error };
  try {
    const parsed = readSwf(r.bytes);
    const histogram: Record<string, number> = {};
    const labels: string[] = [];
    const exports: Array<{ id: number; name: string }> = [];
    let doAbc = 0;
    const walk = (tags: Tag[]) => {
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
// ---- vanilla SWFs (read-only reference copies in the git-ignored .extracted/swfs/) ----------------------------
/** where extracted vanilla SWFs live; MEWGENICS_VANILLA_SWF_DIR overrides (tests) */
export function vanillaSwfDir(): string {
  return process.env.MEWGENICS_VANILLA_SWF_DIR ? process.env.MEWGENICS_VANILLA_SWF_DIR : join(REPO_ROOT, ".extracted", "swfs");
}
const VANILLA_HINT = (name: string) => `python -I tools/gpak.py extract .extracted --prefix swfs/${name || ""}`;

export interface VanillaSwfListing {
  ok: true;
  dir: string;
  files: { name: string; present: boolean; bytes?: number }[];
  hint: string;
}
/** The vanilla SWF names the game loads (swflist.gon: the loader line and the game [...] block), with presence. */
export function listVanillaSwfs(): VanillaSwfListing {
  const dir = vanillaSwfDir();
  const listPath = join(dir, "swflist.gon");
  const names: string[] = [];
  if (existsSync(listPath)) {
    const text = readFileSync(listPath, "utf8").replace(/\/\/[^\n]*/g, "");
    const loader = /^\s*loader\s+("?)([^\s"]+)\1/m.exec(text);
    if (loader) names.push(loader[2]!);
    const game = /game\s*\[([^\]]*)\]/.exec(text);
    if (game) for (const tok of game[1]!.split(/\s+/)) { const n = tok.replace(/^"|"$/g, ""); if (n && !names.includes(n)) names.push(n); }
  }
  const files = names.map((name) => {
    const abs = join(dir, name);
    if (!existsSync(abs)) return { name, present: false };
    return { name, present: true, bytes: statSync(abs).size };
  });
  return { ok: true, dir, files, hint: `extract the vanilla SWFs with: ${VANILLA_HINT("")}` };
}

export type VanillaSwfRead = { ok: true; name: string; bytes: Uint8Array } | { ok: false; error: string; hint?: string };
/** Bytes of one extracted vanilla SWF, by its swflist name (e.g. "ability_icons.swf", "cutscenes/game_intro.swf"). */
export function readVanillaSwf(name: string): VanillaSwfRead {
  const n = String(name || "");
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_./-]*\.swf$/.test(n) || n.split("/").some((seg) => seg === ".." || seg === "") || n.includes(":")) return { ok: false, error: `not a vanilla SWF name: ${JSON.stringify(n)}` };
  const dir = vanillaSwfDir();
  const abs = join(dir, n);
  if (!isInside(dir, abs) || touchesSaves(abs)) return { ok: false, error: `refusing ${JSON.stringify(n)}` };
  if (!existsSync(abs)) return { ok: false, error: `${n} is not extracted`, hint: VANILLA_HINT(n) };
  return { ok: true, name: n, bytes: new Uint8Array(readFileSync(abs)) };
}

export const SWF_GATE_MOD = "swf-gate";
export const SWF_GATE_FILE = "gate.swf";
/** The frame label = the ability whose icon the donor appends (a jokers-luck ability with no vanilla icon). */
export const SWF_GATE_LABEL = "JokersGambit";

export type GateLayout = "flat" | "nested" | "legacy";

export interface GateVariantSpec {
  linkage: string;
  layout: GateLayout;
  /** the square's fill (default gray:8) */
  fill?: "gray" | "gradient";
  /** "shape4": a LINESTYLE2 stroke on the square (DefineShape4) */
  stroke?: "shape4";
  /** PlaceObject3: "blend" (blend add) or "filters" (a glow) */
  effects?: "blend" | "filters";
  /** a Peralta DefineEditText on the icon (ImportAssets2 fonts.swf) */
  text?: boolean;
  /** an imported catparts.swf export placed on the icon (the cat-parts import experiment) */
  importPart?: string;
  expect: string;
  note: string;
}

/**
 * `expect` is the harness verdict the variant must produce (OBSERVED 2026-10-19; runs recorded in the PR for
 * fix/swf-append-frame): every real-target donor boots to the main menu; an unknown target logs
 * "Append movieclip: … could not locate original movieclip to append to" (Application.cpp:1363) and the boot then
 * never reaches the console (verdict `harness-error`, reason `console_unavailable`, no crash report) — which
 * doubles as the proof that process_animation_merges ran over our SymbolClass.
 */
export const SWF_GATE_VARIANTS: Record<string, GateVariantSpec> = {
  flat: { linkage: "_Append_AbilityIcon", layout: "flat", expect: "pass", note: "the fix: bare shape at depth 3, exactly like AbilityIcon's own labeled frames" },
  nested: { linkage: "_Append_AbilityIcon", layout: "nested", expect: "pass", note: "spec §8.1 alternative: the shape wrapped in a nested movieclip at depth 3" },
  gradient: { linkage: "_Append_AbilityIcon", layout: "flat", fill: "gradient", expect: "pass", note: "the flat icon with a gray:2 → gray:14 linear gradient fill (DefineShape3 fill type 0x10): the game loads a gradient" },
  shape4: { linkage: "_Append_AbilityIcon", layout: "flat", stroke: "shape4", expect: "pass", note: "the flat icon with a butt-cap, miter-join, non-scaling stroke: a DefineShape4 with a LINESTYLE2 (EdgeBounds + flags) — the game loads it" },
  blend: { linkage: "_Append_AbilityIcon", layout: "flat", effects: "blend", expect: "pass", note: "the flat icon placed with blend add: a PlaceObject3 with a blend mode and no filters" },
  filters: { linkage: "_Append_AbilityIcon", layout: "flat", effects: "filters", expect: "crash", note: "negative control: a PlaceObject3 filter list (a glow) — OBSERVED 2026-10-20 the engine stops with 'ERROR: FILTERS NOT SUPPORTED swfs/gate.swf'" },
  text: { linkage: "_Append_AbilityIcon", layout: "flat", text: true, expect: "pass", note: "the flat icon plus a Peralta DefineEditText and ImportAssets2(fonts.swf, 0 assets), exactly how vanilla icons carry text" },
  import: { linkage: "_Append_AbilityIcon", layout: "flat", importPart: "CatTail", expect: "pass", note: "the cat-parts import experiment: the flat icon plus an instance of catparts.swf's CatTail through ImportAssets2(catparts.swf, [{ id, CatTail }]) — does the game resolve a symbol imported from another loaded SWF?" },
  legacy: { linkage: "_Append_AbilityIcon", layout: "legacy", expect: "pass", note: "the pre-fix donor (shape at depth 1); it boots too, so the 2026-10-18 crash is not a boot-time merge fault" },
  probe: { linkage: "GateProbe", layout: "flat", expect: "pass", note: "load-only control: the same bytes under a non-_Append_ linkage, so nothing is merged" },
  missing: { linkage: "_Append_NoSuchClipXYZ", layout: "flat", expect: "harness-error", note: "merge witness: an unknown append target is logged and then stalls the boot before the console appears" },
};

export type GateVariant = "flat" | "nested" | "gradient" | "shape4" | "blend" | "filters" | "text" | "import" | "legacy" | "probe" | "missing" | "control";

export interface PrepareGateResult {
  ok: boolean;
  error?: string;
  variant?: GateVariant;
  mod?: string;
  written?: string[];
  removed?: string[];
  linkage?: string;
  label?: string;
  layout?: GateLayout;
  expect?: string;
  note?: string;
  next?: string;
}

/**
 * Write (or, for `control`, remove) the gate files in `mods/<mod>/swfs/`: `gate.swf` and a
 * `swflist.gon.append` listing only it. Nothing is launched here; `npm run test:swfgate -- <variant>`
 * does both. Only `mods/<mod>/` is ever written.
 */
export function prepareSwfGate(o: { mod?: string; variant: GateVariant }): PrepareGateResult {
  const modName = (o && o.mod) || SWF_GATE_MOD;
  const variant = o && o.variant;
  const isControl = variant === "control";
  const spec = !isControl && variant && Object.prototype.hasOwnProperty.call(SWF_GATE_VARIANTS, variant) ? SWF_GATE_VARIANTS[variant] : null;
  if (!isControl && !spec) return { ok: false, error: `unknown gate variant ${JSON.stringify(variant)}; use one of ${[...Object.keys(SWF_GATE_VARIANTS), "control"].join(", ")}` };
  const rels = [`${SWF_DIR}/${SWF_GATE_FILE}`, `${SWF_DIR}/swflist.gon.append`];
  const abs: string[] = [];
  for (const rel of rels) {
    try {
      abs.push(resolveModWritePath(modName, rel));
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  }
  const next = `cd editor && npm run test:swfgate -- ${variant}`;
  if (isControl) {
    const removed: string[] = [];
    rels.forEach((rel, i) => {
      if (existsSync(abs[i])) {
        rmSync(abs[i]);
        removed.push(`mods/${modName}/${rel}`);
      }
    });
    return { ok: true, variant, mod: modName, written: [], removed, expect: "pass", note: "no gate files: a vanilla boot with the mod path present", next };
  }
  if (!spec) return { ok: false, error: "unreachable" };
  const bytes = minimalGateSwf({ withAbc: false, linkage: spec.linkage, label: SWF_GATE_LABEL, layout: spec.layout, fill: spec.fill, stroke: spec.stroke, effects: spec.effects, text: spec.text, importPart: spec.importPart });
  const list = `// SWF gate variant "${variant}" (docs/swf-emitter-fix-spec.md §8): generated by prepareSwfGate — regenerate, do not edit\ngame [\n    ${SWF_GATE_FILE}\n]\n`;
  const payload = [bytes, new TextEncoder().encode(list)];
  const written: string[] = [];
  rels.forEach((rel, i) => {
    mkdirSync(dirname(abs[i]), { recursive: true });
    writeFileSync(abs[i], payload[i]);
    written.push(`mods/${modName}/${rel}`);
  });
  return { ok: true, variant, mod: modName, written, removed: [], linkage: spec.linkage, label: SWF_GATE_LABEL, layout: spec.layout, expect: spec.expect, note: spec.note, next };
}
