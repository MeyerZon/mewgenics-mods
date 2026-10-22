// Application API: the single surface the MCP server and the web server call.
// Neither adapter reimplements GON or validation; they route through here.

import * as baseData from "./base-data.ts";
import * as components from "./components.ts";
import { loadComponentSchema, describeComponent } from "./component-schema.ts";
import * as modio from "./mod-io.ts";
import { validateMod, installedNativeBuild } from "./validate/validator.ts";
import { previewMerge } from "./preview-merge.ts";
import { newFromTemplate as scaffold } from "./templates.ts";
import { loadRegisteredNames } from "./names.ts";
import * as artio from "./art/art-io.ts";
import { readPalette, knownRowHints } from "./art/palette.ts";
import { readGhostCatParts as readGhostParts } from "./art/ghost-cat-swf.ts";
import { validateScene, exampleScene, DEFAULT_ABC_MODE } from "./art/scene.ts";
import { newCatAnimation as catAnim } from "./art/cat-rig.ts";
import type { NewCatAnimationOptions } from "./art/cat-rig.ts";
import type { Scene, Finding as SceneFinding } from "./art/scene.ts";
import * as ingame from "./ingame/index.ts";
import * as vcHeadless from "./art/vectorcraft-headless.ts";
import * as pack from "./pack.ts";
import * as levelio from "./level/level-io.ts";
import * as levelart from "./level/level-art.ts";
import type { LvlFile } from "./level/lvl.ts";
import { embeddedBaseColorImage, conventionTexturePath } from "./art/glb-texture.ts";
import { decodePng } from "./art/png.ts";
import { modelPathProblem } from "./model3d.ts";
export { listVanillaSwfs, readVanillaSwf, vanillaSwfDir } from "./art/art-io.ts";
import { checkInstalledBuild } from "./bindings/check.ts";
import { portManifest, renderPortReport } from "./bindings/port.ts";
import { loadManifest, saveManifest, listManifests, BINDINGS_DIR } from "./bindings/manifest.ts";
import { parsePe, PeError } from "./bindings/pe.ts";
import { locateGameDir, NATIVE_DIST_DIR, FRAMEWORK_DLL_NAME, MEWTEST_DLL_NAME } from "./ingame/launch.ts";
import { readModManifest, compareBuild, MOD_NAME_RE, type BuildComparison } from "./mod-manifest.ts";
import { isInside, touchesSaves, SafetyError, MODS_DIR, DATA_CACHE_DIR, vanillaSwfDir as swfDir } from "./repo.ts";
import { sceneLocLookup } from "./art/scene-loc.ts";
import { loadAudioIndex, audioCategoryEntries, AUDIO_CATEGORIES } from "./audio/sound-sets.ts";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import type { TextOverride } from "./validate/validator.ts";
import type { PreviewMergeOptions } from "./preview-merge.ts";
import type { TemplateKind, TemplateOptions, TemplateResult } from "./templates.ts";
import type { BaseEntry } from "./base-data.ts";
import type { WhereUsedHit } from "./components.ts";

export type { TemplateKind, TemplateOptions, TemplateResult } from "./templates.ts";
export type { Report, Finding, SourceLocation, Severity } from "./validate/result.ts";
export type { PreviewMergeResult, GonPreview, TouchedEntry } from "./preview-merge.ts";
export type { ModFileInfo, ModFileWithText, ReadModResult, ReadModFileResult, WriteOverlayResult } from "./mod-io.ts";
export type { CategoryCount, BaseEntry } from "./base-data.ts";
export type { RegisteredName } from "./names.ts";

/** List base-data categories with entry counts. */
export function listBaseData(): { hasBaseData: boolean; categories: baseData.CategoryCount[] } {
  const categories = baseData.listCategories();
  // sounds / music / sound_files come from the cached audio index (npm run build:index), when present
  const ix = loadAudioIndex(DATA_CACHE_DIR);
  if (ix) for (const c of AUDIO_CATEGORIES) categories.push({ category: c, count: audioCategoryEntries(ix, c)?.length ?? 0 });
  return { hasBaseData: baseData.hasBaseData(), categories };
}

/** The most entries one page of listBaseEntries returns. */
export const BASE_PAGE_MAX = 5000;

/** One page of a category listing: `entries` from `offset`, out of `total` matches. */
export interface BaseEntriesPage {
  category: string;
  entries: string[];
  total: number;
  offset: number;
}

/**
 * List entries within a category. Without `page` every match comes back (offset 0). With `page`, the
 * slice [offset, offset + limit): a negative / non-numeric offset is 0, a limit outside 1..BASE_PAGE_MAX
 * (or non-numeric) is clamped into it.
 */
export function listBaseEntries(category: string, filter?: string, page?: { offset?: number; limit?: number }): BaseEntriesPage {
  let all: string[];
  if ((AUDIO_CATEGORIES as readonly string[]).includes(category)) {
    const ix = loadAudioIndex(DATA_CACHE_DIR);
    const list = ix ? audioCategoryEntries(ix, category) ?? [] : [];
    const f = filter?.toLowerCase();
    all = f ? list.filter((n) => n.toLowerCase().includes(f)) : list;
  } else all = baseData.listEntries(category, filter);
  if (!page) return { category, entries: all, total: all.length, offset: 0 };
  const offset = Number.isFinite(page.offset) ? Math.max(0, Math.floor(page.offset!)) : 0;
  const limit = Number.isFinite(page.limit) ? Math.min(BASE_PAGE_MAX, Math.max(1, Math.floor(page.limit!))) : BASE_PAGE_MAX;
  return { category, entries: all.slice(offset, offset + limit), total: all.length, offset };
}

export type ReadBaseEntryResult = ({ ok: true } & BaseEntry) | { ok: false; error: string };

/** Read one base entry as GON. */
export function readBaseEntry(category: string, name: string): ReadBaseEntryResult {
  const r = baseData.readEntry(category, name);
  if (!r) return { ok: false, error: `no base entry "${name}" in category "${category}"` };
  return { ok: true, ...r };
}

export interface ComponentSearchResult {
  query: string;
  count: number;
  names: string[];
  whereUsed?: Array<{ name: string; usedIn: WhereUsedHit[] }>;
  /** the GON keys each of the top 15 matches reads (editor/component-schema.json; base keys inherited) */
  schema?: ComponentKeyInfo[];
}

/** One component's resolved key schema (component-schema.ts describeComponent). */
export interface ComponentKeyInfo {
  name: string;
  chain: string[];
  status: string;
  open: boolean;
  children: string | null;
  scalar: string | null;
  required: string[];
  keys: Record<string, { type: string; default: number | boolean | string | null; required: boolean; from: string; confidence: string; unread?: boolean; evidence?: string; note?: string }>;
}

/** Search C++ component class names, optionally with where-used. */
export function searchComponents(query: string, opts: { whereUsed?: boolean; limit?: number } = {}): ComponentSearchResult {
  const names = components.searchComponentNames(query, opts.limit ?? 50);
  const cs = loadComponentSchema();
  // an exact match first, so searching a full class name always describes that class
  const top = [...names.filter((n) => n === query), ...names.filter((n) => n !== query)].slice(0, 15);
  const schema = cs ? (top.map((n) => describeComponent(cs, n)).filter((x) => x !== null) as unknown as ComponentKeyInfo[]) : [];
  if (!opts.whereUsed) return { query, count: names.length, names, schema };
  const detailed = names.slice(0, 15).map((name) => ({ name, usedIn: components.whereUsed(name, 20) }));
  return { query, count: names.length, names, whereUsed: detailed, schema };
}

export function listMods(): { mods: string[] } {
  return { mods: modio.listMods() };
}

export function readMod(modName: string, opts?: { includeText?: boolean }): modio.ReadModResult {
  return modio.readMod(modName, opts);
}

export function readModFile(modName: string, relPath: string): modio.ReadModFileResult {
  return modio.readModFile(modName, relPath);
}

export function writeOverlay(modName: string, relPath: string, content: string): modio.WriteOverlayResult {
  return modio.writeOverlay(modName, relPath, content);
}

/** `opts.modpaths`: the mods loaded together, in -modpaths order — adds the cross-mod append / SWF-name findings */
export function validate(modName: string, override?: TextOverride, opts: { modpaths?: string[] } = {}) {
  return validateMod(modName, override, opts.modpaths ? { modpaths: opts.modpaths } : {});
}

export function preview(modName: string, relPath: string, opts?: PreviewMergeOptions) {
  return previewMerge(modName, relPath, opts);
}

export interface EditorStatus {
  gameDir: string;
  exeFound: boolean;
  /** the installed exe is a build bindings/*.json knows */
  known: boolean;
  /** its Steam build id (null: no exe, or an unknown build) */
  gameBuild: string | null;
  timeDateStamp: string | null;
  knownBuilds: string[];
  extracted: boolean;
  extractedSwfs: boolean;
  frameworkDll: boolean;
  mewtestDll: boolean;
  /** Mewjector (version.dll) in the game folder */
  mewjector: boolean;
  saveSuffix: string;
  modsDir: string;
  /** with ?mod=: the build its mod.json was tested on, compared with the installed one */
  mod?: { name: string; gameBuild: string | null; compare: BuildComparison | null };
}

/**
 * What the status bar shows: the installed game's identity (PE headers only, memoized: the validator's
 * installedNativeBuild, never the full-exe hash of checkGameBuild), what is extracted / built, and the save suffix
 * modded play uses. Read-only: every check is an existsSync (plus the mod's mod.json when `mod` is given).
 */
export function editorStatus(opts: { mod?: string } = {}): EditorStatus {
  const gameDir = locateGameDir(process.env);
  const nb = installedNativeBuild(process.env);
  let knownBuilds: string[] = [];
  try {
    knownBuilds = listManifests().map((m) => m.manifest.build.steamBuildId);
  } catch {
    /* no bindings dir: none known */
  }
  const out: EditorStatus = {
    gameDir,
    exeFound: nb !== null,
    known: !!nb?.known,
    gameBuild: nb?.matched?.steamBuildId ?? null,
    timeDateStamp: nb?.identity?.timeDateStamp ?? null,
    knownBuilds,
    extracted: baseData.hasBaseData(),
    extractedSwfs: existsSync(swfDir()),
    frameworkDll: existsSync(join(NATIVE_DIST_DIR, FRAMEWORK_DLL_NAME)),
    mewtestDll: existsSync(join(NATIVE_DIST_DIR, MEWTEST_DLL_NAME)),
    mewjector: existsSync(join(gameDir, "version.dll")),
    saveSuffix: ingame.DEFAULT_SAVESUFFIX,
    modsDir: MODS_DIR,
  };
  const name = opts.mod || "";
  if (name && MOD_NAME_RE.test(name)) {
    const man = readModManifest(join(MODS_DIR, name), name);
    const gameBuild = man.present && man.ok ? man.manifest.gameBuild : null;
    out.mod = { name, gameBuild, compare: gameBuild ? compareBuild(gameBuild, nb) : null };
  }
  return out;
}

export function listRegisteredNativeNames() {
  return { registered: loadRegisteredNames() };
}

/**
 * Scaffold a new content entry. `options` arrives as untyped JSON from the MCP tool / HTTP body;
 * the template module reads the fields it knows.
 */
export function newFromTemplate(modName: string, kind: TemplateKind, name: string, options: Record<string, unknown> = {}): TemplateResult {
  return scaffold(modName, kind, name, options as TemplateOptions);
}

// ---- art pipeline (docs/art-preview-plan.md) --------------------------------
// Scenes (art/*.scene.json) → zero-dependency SWF emitter → mods/<mod>/swfs/*.swf.
// The web Preview panel renders from the same scene model via the pure modules in
// src/core/art/ (bundled into the browser UI by Vite); nothing here is re-implemented
// by an adapter.

export function listArtScenes(modName: string) {
  return artio.listArtScenes(modName);
}
export function readArtScene(modName: string, relPath: string) {
  return artio.readArtScene(modName, relPath);
}
export function writeArtScene(modName: string, relPath: string, scene: unknown, opts?: { force?: boolean }) {
  return artio.writeArtScene(modName, relPath, scene, opts);
}
export function newArtScene(modName: string, name: string, opts?: artio.NewSceneOptions) {
  return artio.newArtScene(modName, name, opts);
}
/**
 * Add a cat animation (a front rig `<name>Pose`, a back rig `<name>PoseBack` and the labeled `<name>F` / `<name>B`
 * frames — `<name>LF/RF/LB/RB` with `fourWay` — on the `_Append_CatTest` donor) to a scene object, without touching disk. The scene is validated first; `ok` is false on a refusal.
 */
export function newCatAnimation(scene: unknown, name: string, opts?: NewCatAnimationOptions): { ok: boolean; scene: Scene; findings: SceneFinding[]; rig?: string; backRig?: string; donor?: string } {
  const v = validateScene(scene);
  if (!v.ok) return { ok: false, scene: v.scene, findings: v.findings };
  const r = catAnim(v.scene, name, opts);
  return { ok: !r.findings.some((f) => f.severity === "error"), scene: r.scene, findings: r.findings, rig: r.rig, backRig: r.backRig, donor: r.donor };
}
/** Validate a scene object without touching disk (live editing); with `modName` its own loc keys count for text-loc-key-html too. */
export function validateArtScene(scene: unknown, modName?: string) {
  const v = validateScene(scene, { locKey: sceneLocLookup(modName ? join(MODS_DIR, modName) : null) });
  return { ok: v.ok, findings: v.findings, scene: v.scene };
}
export function importSvgShape(args: Parameters<typeof artio.importSvgShape>[0]) {
  return artio.importSvgShape(args);
}
export function importSvgIntoScene(args: Parameters<typeof artio.importSvgIntoScene>[0]) {
  return artio.importSvgIntoScene(args);
}
export function buildSwf(modName: string, relPath: string, opts?: Parameters<typeof artio.buildSwf>[2]) {
  return artio.buildSwf(modName, relPath, opts);
}
export function inspectSwf(modName: string, relPath: string) {
  return artio.inspectSwf(modName, relPath);
}
export function exportShapeSvg(modName: string, scenePath: string, shapeId: string) {
  return artio.exportShapeSvg(modName, scenePath, shapeId);
}
/** Bake a glow / drop shadow of a shape as <shapeId>_glow under it (glow.ts) and save the scene. */
/** A PNG as raster art: check it, copy it into the mod, add it to a scene as a bitmap fill / raster sprite / background (raster.ts). */
export function importBitmap(args: Parameters<typeof artio.importBitmap>[0]) {
  return artio.importBitmap(args);
}
export function bakeGlowIntoScene(args: Parameters<typeof artio.bakeGlowIntoScene>[0]) {
  return artio.bakeGlowIntoScene(args);
}
export function readArtAsset(modName: string, relPath: string) {
  return artio.readModBytes(modName, relPath);
}
export function writeArtAsset(modName: string, relPath: string, bytes: Uint8Array) {
  return artio.writeModBytes(modName, relPath, bytes);
}
export interface ExtractModelTextureResult {
  ok: boolean;
  error?: string;
  /** a model code (model-codes.ts) when ok is false */
  code?: string;
  /** mods/<mod>/textures/models/<stem>.png */
  path?: string;
  bytes?: number;
  width?: number;
  height?: number;
  /** where the image was in the model file: "bufferView N" or "data-uri" */
  source?: string;
  written?: boolean;
  /** findings about the PNG itself (the DLL's decoder limits) */
  findings: { code: string; message: string }[];
  note?: string;
}

/**
 * Write a glTF model's EMBEDDED base-colour PNG (a .glb bufferView or a data: URI) to the convention path
 * mods/<mod>/textures/models/<stem>.png, so it can be edited as a file (design: docs/3d-importer-design.md §3.3 item 3).
 * Refuses to overwrite unless `overwrite`; `dryRun` writes nothing. The write goes through the mod write guard
 * (art-io writeModBytes -> repo.ts resolveModWritePath: inside mods/<mod>/ only, never saves/, never game files).
 * Since M3 the DLL draws the embedded image itself and prefers it over the convention file: to draw the extracted
 * (edited) file, name it explicitly (graphics.model { texture "models/<stem>.png" }) or remove the image from the model.
 */
export function extractModelTexture(modName: string, modelPath: string, opts: { overwrite?: boolean; dryRun?: boolean } = {}): ExtractModelTextureResult {
  const problem = modelPathProblem(modelPath);
  if (problem) return { ok: false, code: "model-path-invalid", error: `${modelPath}: ${problem}`, findings: [] };
  if (modelPath.endsWith(".obj")) return { ok: false, code: "model-extension", error: "an OBJ model has no embedded image (only .glb / .gltf can embed one)", findings: [] };
  const read = artio.readModBytes(modName, modelPath);
  if (!read.ok) return { ok: false, code: "model-file-missing", error: read.error, findings: [] };
  const img = embeddedBaseColorImage(read.bytes);
  if (!img.ok) return { ok: false, code: img.code, error: img.error, findings: [] };
  const findings: { code: string; message: string }[] = [];
  let width: number | undefined, height: number | undefined;
  try {
    const d = decodePng(img.bytes);
    width = d.width; height = d.height;
    if (d.width > 2048 || d.height > 2048) findings.push({ code: "model-image-embedded-unsupported", message: `${d.width}x${d.height}: the DLL decodes up to 2048 px per side` });
    else if (d.width > 1024 || d.height > 1024) findings.push({ code: "model-texture-size", message: `${d.width}x${d.height}: larger than 1024 px (no mipmaps: it shimmers)` });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    findings.push({ code: /interlaced|bit depth|not supported/.test(m) ? "model-image-embedded-unsupported" : "model-image-embedded-invalid", message: m });
  }
  const rel = conventionTexturePath(modelPath);
  const path = `mods/${modName}/${rel}`;
  const exists = artio.readModBytes(modName, rel).ok;
  if (exists && !opts.overwrite) return { ok: false, error: `${path} already exists (pass overwrite: true to replace it)`, path, findings };
  const note = `the DLL draws ${modelPath}'s embedded image before the convention file; to draw ${path} instead, set graphics.model { texture "${rel.slice("textures/".length)}" } (an explicit texture wins) or remove the image from the model`;
  if (opts.dryRun) return { ok: true, path, bytes: img.bytes.length, width, height, source: img.source, written: false, findings, note };
  const w = artio.writeModBytes(modName, rel, img.bytes);
  if (!w.ok) return { ok: false, error: w.error, findings };
  return { ok: true, path: w.path, bytes: w.bytes, width, height, source: img.source, written: true, findings, note };
}

export function readArtPalette(which?: Parameters<typeof readPalette>[0]) {
  const p = readPalette(which);
  return { ...p, hints: knownRowHints(), defaultAbc: DEFAULT_ABC_MODE };
}
/** The ghost cat's part outlines for the preview: catparts.swf's silhouettes when extracted, else built-in (ghost-cat-swf.ts). */
export function readGhostCatParts() {
  return readGhostParts();
}
/** Write (or remove, for `control`) the SWF-gate files in mods/<mod>/swfs/ (docs/swf-emitter-fix-spec.md §8). */
export function prepareSwfGate(o: Parameters<typeof artio.prepareSwfGate>[0]) {
  return artio.prepareSwfGate(o);
}
export { SWF_GATE_MOD, SWF_GATE_VARIANTS } from "./art/art-io.ts";
/** Undo VectorCraft's artboard re-origin on an SVG it exported (svg-reorigin.ts; pure). */
export { reoriginSvg, parseViewBox } from "./art/svg-reorigin.ts";
/** MCP vectorcraft_exec: drive the vendored VectorCraft web build headlessly (Playwright Chromium) and apply the drawing to a shape. */
export function vectorcraftExec(args: Parameters<typeof vcHeadless.vectorcraftExec>[0]) {
  return vcHeadless.vectorcraftExec(args);
}
export function isVectorcraftVendored() {
  return vcHeadless.isVectorcraftVendored();
}
export { exampleScene as exampleArtScene };

// ---- in-game test harness (docs/ingame-testing.md) --------------------------

/** List committed in-game test scripts (mods/<mod>/tests/*.mewtest) with their parsed headers. */
export function listIngameTests(modName?: string) {
  return ingame.listIngameTests(modName);
}

export interface RunIngameTestArgs {
  mod: string;
  test?: string;
  script?: string;
  timeoutMs?: number;
  hide?: boolean;
  clean?: boolean;
  savesuffix?: string;
  saveCheck?: boolean;
  includeEvents?: boolean;
  /** tests only (defaults to process.env) */
  env?: Record<string, string | undefined>;
}

/**
 * Launch the game once with the mewtest harness and run one script. Blocks until the
 * game exits (or the timeout + backstop). Returns the report; `{ ok: false, error }` for
 * bad arguments. `env` is for tests only (defaults to process.env).
 */
export async function runIngameTest(args: RunIngameTestArgs) {
  const { mod, test, script } = args || {};
  if (!mod || typeof mod !== "string") return { ok: false as const, error: "mod is required" };
  if ((test && script) || (!test && !script)) return { ok: false as const, error: "pass exactly one of `test` (a name under mods/<mod>/tests/) or `script` (inline .mewtest text)" };
  let plan: ReturnType<typeof ingame.parseScript>;
  let scriptPath: string | null = null;
  let name = "inline";
  if (test) {
    const entry = ingame.listIngameTests(mod).tests.find((t) => t.name === test);
    if (!entry) return { ok: false as const, error: `no test "${test}" under mods/${mod}/tests/ (${ingame.listIngameTests(mod).tests.map((t) => t.name).join(", ") || "none"})` };
    plan = entry.plan;
    scriptPath = entry.absPath;
    name = entry.name;
  } else {
    plan = ingame.parseScript(String(script), { owningMod: mod, name });
  }
  if (args.timeoutMs !== undefined) plan = { ...plan, timeoutMs: args.timeoutMs };
  if (args.hide !== undefined) plan = { ...plan, hide: args.hide };
  if (args.clean !== undefined) plan = { ...plan, clean: args.clean };
  if (args.savesuffix !== undefined) plan = { ...plan, savesuffix: args.savesuffix };
  const report = await ingame.runPlan({ plan, test: { mod, name, scriptPath }, env: args.env, saveCheck: args.saveCheck });
  if (!args.includeEvents) report.result = { ...report.result, events: [] };
  return report;
}

// ---- interactive in-game sessions (named pipe; docs/ingame-testing.md "Interactive mode") ----
const sessions = new Map<string, ingame.IngameSession>();
let sessionSeq = 0;

export interface StartIngameSessionArgs extends RunIngameTestArgs {
  /** how long to wait for the DLL's pipe (default 30 s) */
  connectTimeoutMs?: number;
  /** wait until the script has run to its end before returning (default true), so requests do not land inside its waits */
  waitIdle?: boolean;
}

/** Launch the game on an `interactive: true` script (or make the given script interactive) and connect the pipe. */
export async function startIngameSession(args: StartIngameSessionArgs) {
  const { mod, test, script } = args || {};
  if (!mod || typeof mod !== "string") return { ok: false as const, error: "mod is required" };
  if ((test && script) || (!test && !script)) return { ok: false as const, error: "pass exactly one of `test` (a name under mods/<mod>/tests/) or `script` (inline .mewtest text)" };
  let plan: ReturnType<typeof ingame.parseScript>;
  let scriptPath: string | null = null;
  let name = "inline";
  if (test) {
    const entry = ingame.listIngameTests(mod).tests.find((t) => t.name === test);
    if (!entry) return { ok: false as const, error: `no test "${test}" under mods/${mod}/tests/` };
    plan = entry.plan;
    scriptPath = entry.absPath;
    name = entry.name;
  } else {
    plan = ingame.parseScript(String(script), { owningMod: mod, name });
  }
  if (!plan.ok) return { ok: false as const, error: `script errors: ${plan.errors.map((e) => `line ${e.line}: ${e.message}`).join("; ")}` };
  plan = { ...plan, interactive: true };
  if (args.timeoutMs !== undefined) plan = { ...plan, timeoutMs: args.timeoutMs };
  if (args.hide !== undefined) plan = { ...plan, hide: args.hide };
  if (args.savesuffix !== undefined) plan = { ...plan, savesuffix: args.savesuffix };
  try {
    const session = await ingame.startSession({ plan, test: { mod, name, scriptPath }, env: args.env, saveCheck: args.saveCheck, connectTimeoutMs: args.connectTimeoutMs });
    const sessionId = `s${++sessionSeq}-${session.pid}`;
    sessions.set(sessionId, session);
    if (args.waitIdle !== false) {
      try { await session.waitForIdle(plan.timeoutMs); } catch (e) {
        const report = await session.stop();
        sessions.delete(sessionId);
        return { ok: false as const, error: e instanceof Error ? e.message : String(e), report };
      }
    }
    return { ok: true as const, sessionId, pid: session.pid, runDir: session.runDir, pipe: session.pipe, idle: session.idle };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface IngameExecArgs {
  sessionId: string;
  /** console line (op exec) */
  cmd?: string;
  /** exec (default when cmd is given) | dump | quit */
  op?: "exec" | "dump" | "quit";
  /** frames to keep collecting console output after the command (DLL default 3, max 600) */
  frames?: number;
}

export async function ingameExec(args: IngameExecArgs) {
  const s = sessions.get(String(args.sessionId));
  if (!s) return { ok: false as const, error: `unknown session "${args.sessionId}" (start one with start_ingame_session; sessions end when the game exits)` };
  const op = args.op || (args.cmd !== undefined ? "exec" : "dump");
  try {
    if (op === "exec") {
      if (typeof args.cmd !== "string" || !args.cmd.trim()) return { ok: false as const, error: "cmd is required for op exec" };
      return { ok: true as const, reply: await s.exec(args.cmd, args.frames) };
    }
    if (op === "dump") return { ok: true as const, reply: await s.dump() };
    const report = await s.stop();
    sessions.delete(String(args.sessionId));
    return { ok: true as const, report };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e), ended: s.ended };
  }
}

export async function stopIngameSession(args: { sessionId: string; includeEvents?: boolean }) {
  const s = sessions.get(String(args.sessionId));
  if (!s) return { ok: false as const, error: `unknown session "${args.sessionId}"` };
  const report = await s.stop();
  sessions.delete(String(args.sessionId));
  if (!args.includeEvents) report.result = { ...report.result, events: [] };
  return { ok: true as const, report };
}

// ---- native bindings (bindings/<build>.json, docs/binding-port.md) ------------

export interface CheckGameBuildArgs {
  exe?: string;
  env?: Record<string, string | undefined>;
  manifests?: NonNullable<Parameters<typeof checkInstalledBuild>[0]>["manifests"];
}

/**
 * Is the installed Mewgenics.exe (or `exe`) a build the bindings manifests know, and does every
 * signature still match exactly once at its RVA? Read-only; never launches the game. Returns
 * `{ ok: false, skipped: true, reason }` when the exe or the manifests are absent.
 * `env` / `manifests` are for tests (default: process.env and bindings/*.json).
 */
export function checkGameBuild(args: CheckGameBuildArgs = {}) {
  return checkInstalledBuild({ exePath: args.exe, env: args.env, manifests: args.manifests });
}

export interface PortBindingsArgs {
  build: string;
  from?: string;
  exe?: string;
  version?: string;
  resolve?: Record<string, string>;
  dryRun?: boolean;
  out?: string;
  env?: Record<string, string | undefined>;
}

export type PortBindingsResult =
  | { ok: false; skipped: boolean; reason: string }
  | {
      ok: true;
      dryRun: boolean;
      from: string;
      exe: string;
      build: string;
      summary: ReturnType<typeof portManifest>["summary"];
      rows: ReturnType<typeof portManifest>["rows"];
      needsAgent: ReturnType<typeof portManifest>["needsAgent"];
      report: string;
      written?: { manifest: string; report: string };
    };

/**
 * Port the bindings manifest of a known build to a new exe (docs/binding-port.md). Walks the
 * resolution ladder for every entry and returns the rows, the summary, the entries that need an
 * agent or a human, and the markdown report. `dryRun` (default true) writes nothing; otherwise
 * bindings/<build>.json and bindings/<build>.port-report.md are written (never anywhere else:
 * SafetyError). `from` defaults to the newest manifest, `exe` to the installed game.
 */
export function portBindings(args: PortBindingsArgs): PortBindingsResult {
  const build = String(args.build ?? "");
  if (!/^\d+$/.test(build)) return { ok: false, skipped: false, reason: `build must be the new Steam build id (digits only), got ${JSON.stringify(args.build)}` };
  const exePath = resolvePath(args.exe || join(locateGameDir(args.env || process.env), "Mewgenics.exe"));
  if (touchesSaves(exePath)) throw new SafetyError(`refusing to read a saves path: ${exePath}`);
  if (!existsSync(exePath)) return { ok: false, skipped: true, reason: `exe not found: ${exePath}` };
  let fromPath = args.from;
  if (!fromPath) {
    const all = listManifests();
    if (!all.length) return { ok: false, skipped: true, reason: "no bindings/<build>.json manifests to port from" };
    fromPath = all[all.length - 1]!.path;
  }
  const old = loadManifest(fromPath);
  const buf = readFileSync(exePath);
  let pe: ReturnType<typeof parsePe>;
  try {
    pe = parsePe(buf);
  } catch (e) {
    if (e instanceof PeError) return { ok: false, skipped: false, reason: `not a PE32+ image: ${e.message}` };
    throw e;
  }
  const dryRun = args.dryRun !== false;
  const result = portManifest(old, pe, buf, { steamBuildId: build, gameVersion: args.version, resolve: args.resolve || {} });
  const report = renderPortReport(result, { generatedAt: new Date().toISOString() });
  const out: PortBindingsResult = { ok: true, dryRun, from: fromPath, exe: exePath, build, summary: result.summary, rows: result.rows, needsAgent: result.needsAgent, report };
  if (!dryRun) {
    const outPath = resolvePath(args.out || join(BINDINGS_DIR, `${build}.json`));
    if (!isInside(BINDINGS_DIR, outPath)) throw new SafetyError(`refusing to write a manifest outside bindings/: ${outPath}`);
    saveManifest(outPath, result.manifest);
    const reportPath = outPath.replace(/\.json$/i, ".port-report.md");
    writeFileSync(reportPath, report);
    out.written = { manifest: outPath, report: reportPath };
  }
  return out;
}

// ---- shipping a mod (docs/data-mods.md "Shipping a mod") ---------------------

/** Pack mods/<name>/ into editor/data/dist/<name>-<version>.zip (builds SWFs, validates; refuses on errors unless force). */
export function packMod(modName: string, opts: { force?: boolean; init?: boolean } = {}) {
  return pack.packMod(modName, { force: opts.force, init: opts.init });
}
/** Install a mod zip (a path or the bytes) into mods/<name>/. A build mismatch is returned as verdict build-mismatch unless accepted. */
export function installMod(zip: string | Uint8Array, opts: { acceptBuildMismatch?: boolean } = {}) {
  return pack.installMod(zip, { acceptBuildMismatch: opts.acceptBuildMismatch });
}
/** A packed zip from editor/data/dist/ by its file name (for the web UI's download), or null. */
export function readPackedZip(fileName: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.+-]*\.zip$/.test(fileName)) return null;
  const p = join(pack.DIST_DIR, fileName);
  return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
}
export { MOD_MANIFEST_FILE } from "./mod-manifest.ts";
export type { ModManifest } from "./mod-manifest.ts";
export type { PackResult, InstallResult } from "./pack.ts";
// ---- rooms: level files levels/**/*.lvl (the Room editor, MCP read_level / write_level) ----
// docs/data-mods.md "Maps, rooms and encounters"; the codec is src/core/level/lvl.ts, the edit helpers
// src/core/level/edit.ts (shared with the browser), the disk side src/core/level/level-io.ts.

export type { LvlFile, LvlPick, LvlChoice, LvlObject } from "./level/lvl.ts";
export type { LevelInfo, ListLevelsResult, ReadLevelResult, WriteLevelResult, LevelPalette, PaletteEntry, LevelEdit } from "./level/level-io.ts";

/** The mod's levels/**.lvl files with a decode summary. */
export function listLevels(modName: string) {
  return levelio.listLevels(modName);
}
/** Decode one of the mod's levels: { ok, relPath, level, base64, bytes }. */
export function readLevel(modName: string, relPath: string) {
  return levelio.readLevel(modName, relPath);
}
/** Encode and write a level (levels/**.lvl inside the mod only); returns the lvl-* findings. */
export function writeLevel(modName: string, relPath: string, level: LvlFile, opts?: levelio.LevelIoOptions) {
  return levelio.writeLevel(modName, relPath, level, opts);
}
/** write_level's other sources: base64 bytes and/or edit ops applied to the level (or the file on disk / an empty room). */
export function writeLevelFrom(modName: string, relPath: string, src: levelio.WriteLevelSource) {
  return levelio.writeLevelFrom(modName, relPath, src);
}
/** The lvl-* validator rules for unsaved level content (the Room editor's live findings). */
export function validateLevel(modName: string, relPath: string, level: LvlFile, opts?: levelio.LevelIoOptions) {
  return levelio.validateLevel(modName, relPath, level, opts);
}
/** The tile (tiles.gon) and object (spawns.gon) palettes for the mod: base + its overlays, with swatch colours. */
export function levelPalette(modName: string, opts?: levelio.LevelIoOptions) {
  return levelio.levelPalette(modName, opts);
}

// ---- the Room editor's tileset art (src/core/level/tile-art.ts resolves, level-art.ts renders + caches) ----
export type { ArtResolution, ArtReason } from "./level/tile-art.ts";
export type { LevelArtInfo, LevelArtImage, LevelArtMeta } from "./level/level-art.ts";

/** Which clip draws each tile / spawn id of the mod's palette in a tileset (default: the room's map, else default_tileset). */
export function levelArtInfo(modName: string, q: levelart.LevelArtQuery = {}, opts?: levelart.LevelArtOptions) {
  return levelart.levelArtInfo(modName, q, opts);
}
/** The PNG thumbnail (frame 1) of one tile or spawn id's clip, cached under editor/data/level-art/. */
export function levelArtImage(modName: string, q: levelart.LevelArtQuery & { tile?: number; object?: number }, opts?: levelart.LevelArtOptions) {
  return levelart.levelArtImage(modName, q, opts);
}
