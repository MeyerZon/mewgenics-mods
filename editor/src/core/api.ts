// Application API: the single surface the MCP server and the web server call.
// Neither adapter reimplements GON or validation; they route through here.

import * as baseData from "./base-data.ts";
import * as components from "./components.ts";
import { loadComponentSchema, describeComponent } from "./component-schema.ts";
import * as modio from "./mod-io.ts";
import { validateMod } from "./validate/validator.ts";
import { previewMerge } from "./preview-merge.ts";
import { newFromTemplate as scaffold } from "./templates.ts";
import { loadRegisteredNames } from "./names.ts";
import * as artio from "./art/art-io.ts";
import { readPalette, knownRowHints } from "./art/palette.ts";
import { validateScene, exampleScene, DEFAULT_ABC_MODE } from "./art/scene.ts";
import { newCatAnimation as catAnim } from "./art/cat-rig.ts";
import type { NewCatAnimationOptions } from "./art/cat-rig.ts";
import type { Scene, Finding as SceneFinding } from "./art/scene.ts";
import * as ingame from "./ingame/index.ts";
import * as vcHeadless from "./art/vectorcraft-headless.ts";
export { listVanillaSwfs, readVanillaSwf, vanillaSwfDir } from "./art/art-io.ts";
import { checkInstalledBuild } from "./bindings/check.ts";
import { portManifest, renderPortReport } from "./bindings/port.ts";
import { loadManifest, saveManifest, listManifests, BINDINGS_DIR } from "./bindings/manifest.ts";
import { parsePe, PeError } from "./bindings/pe.ts";
import { locateGameDir } from "./ingame/launch.ts";
import { isInside, touchesSaves, SafetyError } from "./repo.ts";
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
  return { hasBaseData: baseData.hasBaseData(), categories: baseData.listCategories() };
}

/** List entries within a category. */
export function listBaseEntries(category: string, filter?: string): { category: string; entries: string[] } {
  return { category, entries: baseData.listEntries(category, filter) };
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

export function validate(modName: string, override?: TextOverride) {
  return validateMod(modName, override);
}

export function preview(modName: string, relPath: string, opts?: PreviewMergeOptions) {
  return previewMerge(modName, relPath, opts);
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
 * Add a cat animation (a rig `<name>Pose` and the labeled `<name>F` / `<name>B` frames on the `_Append_CatTest`
 * donor) to a scene object, without touching disk. The scene is validated first; `ok` is false on a refusal.
 */
export function newCatAnimation(scene: unknown, name: string, opts?: NewCatAnimationOptions): { ok: boolean; scene: Scene; findings: SceneFinding[]; rig?: string; donor?: string } {
  const v = validateScene(scene);
  if (!v.ok) return { ok: false, scene: v.scene, findings: v.findings };
  const r = catAnim(v.scene, name, opts);
  return { ok: !r.findings.some((f) => f.severity === "error"), scene: r.scene, findings: r.findings, rig: r.rig, donor: r.donor };
}
/** Validate a scene object without touching disk (live editing). */
export function validateArtScene(scene: unknown) {
  const v = validateScene(scene);
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
export function bakeGlowIntoScene(args: Parameters<typeof artio.bakeGlowIntoScene>[0]) {
  return artio.bakeGlowIntoScene(args);
}
export function readArtAsset(modName: string, relPath: string) {
  return artio.readModBytes(modName, relPath);
}
export function writeArtAsset(modName: string, relPath: string, bytes: Uint8Array) {
  return artio.writeModBytes(modName, relPath, bytes);
}
export function readArtPalette(which?: Parameters<typeof readPalette>[0]) {
  const p = readPalette(which);
  return { ...p, hints: knownRowHints(), defaultAbc: DEFAULT_ABC_MODE };
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
