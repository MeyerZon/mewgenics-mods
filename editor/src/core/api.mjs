// Application API: the single surface the MCP server and the web server call.
// Neither adapter reimplements GON or validation; they route through here.

import * as baseData from "./base-data.mjs";
import * as components from "./components.mjs";
import * as modio from "./mod-io.mjs";
import { validateMod } from "./validate/validator.mjs";
import { previewMerge } from "./preview-merge.mjs";
import { newFromTemplate } from "./templates.mjs";
import { loadRegisteredNames } from "./names.mjs";
import * as artio from "./art/art-io.mjs";
import { readPalette, knownRowHints } from "./art/palette.mjs";
import { validateScene, exampleScene, DEFAULT_ABC_MODE } from "./art/scene.mjs";
import * as ingame from "./ingame/index.mjs";
import { checkInstalledBuild } from "./bindings/check.mjs";
import { portManifest, renderPortReport } from "./bindings/port.mjs";
import { loadManifest, saveManifest, listManifests, BINDINGS_DIR } from "./bindings/manifest.mjs";
import { parsePe, PeError } from "./bindings/pe.mjs";
import { locateGameDir } from "./ingame/launch.mjs";
import { isInside, touchesSaves, SafetyError } from "./repo.mjs";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

/** List base-data categories with entry counts. */
export function listBaseData() {
  return { hasBaseData: baseData.hasBaseData(), categories: baseData.listCategories() };
}

/**
 * List entries within a category.
 * @param {string} category
 * @param {string} [filter]
 */
export function listBaseEntries(category, filter) {
  return { category, entries: baseData.listEntries(category, filter) };
}

/**
 * Read one base entry as GON.
 * @param {string} category
 * @param {string} name
 */
export function readBaseEntry(category, name) {
  const r = baseData.readEntry(category, name);
  if (!r) return { ok: false, error: `no base entry "${name}" in category "${category}"` };
  return { ok: true, ...r };
}

/**
 * Search C++ component class names, optionally with where-used.
 * @param {string} query
 * @param {{ whereUsed?: boolean, limit?: number }} [opts]
 */
export function searchComponents(query, opts = {}) {
  const names = components.searchComponentNames(query, opts.limit ?? 50);
  if (!opts.whereUsed) return { query, count: names.length, names };
  const detailed = names.slice(0, 15).map((name) => ({ name, usedIn: components.whereUsed(name, 20) }));
  return { query, count: names.length, names, whereUsed: detailed };
}

export function listMods() {
  return { mods: modio.listMods() };
}

/**
 * @param {string} modName
 * @param {{ includeText?: boolean }} [opts]
 */
export function readMod(modName, opts) {
  return modio.readMod(modName, opts);
}

/**
 * @param {string} modName
 * @param {string} relPath
 */
export function readModFile(modName, relPath) {
  return modio.readModFile(modName, relPath);
}

/**
 * @param {string} modName
 * @param {string} relPath
 * @param {string} content
 */
export function writeOverlay(modName, relPath, content) {
  return modio.writeOverlay(modName, relPath, content);
}

/**
 * @param {string} modName
 * @param {{ relPath?: string, text?: string }} [override]
 */
export function validate(modName, override) {
  return validateMod(modName, override);
}

/**
 * @param {string} modName
 * @param {string} relPath
 * @param {{ overrideText?: string, includeFullGon?: boolean }} [opts]
 */
export function preview(modName, relPath, opts) {
  return previewMerge(modName, relPath, opts);
}

export function listRegisteredNativeNames() {
  return { registered: loadRegisteredNames() };
}

export { newFromTemplate };

// ---- art pipeline (docs/art-preview-plan.md) --------------------------------
// Scenes (art/*.scene.json) → zero-dependency SWF emitter → mods/<mod>/swfs/*.swf.
// The web Preview panel renders from the same scene model via the pure modules in
// src/core/art/ (served read-only to the browser); nothing here is re-implemented
// by an adapter.

/** @param {string} modName */
export function listArtScenes(modName) {
  return artio.listArtScenes(modName);
}
/** @param {string} modName @param {string} relPath */
export function readArtScene(modName, relPath) {
  return artio.readArtScene(modName, relPath);
}
/** @param {string} modName @param {string} relPath @param {unknown} scene @param {{ force?: boolean }} [opts] */
export function writeArtScene(modName, relPath, scene, opts) {
  return artio.writeArtScene(modName, relPath, scene, opts);
}
/** @param {string} modName @param {string} name @param {{ starter?: boolean }} [opts] */
export function newArtScene(modName, name, opts) {
  return artio.newArtScene(modName, name, opts);
}
/** Validate a scene object without touching disk (live editing). @param {unknown} scene */
export function validateArtScene(scene) {
  const v = validateScene(scene);
  return { ok: v.ok, findings: v.findings, scene: v.scene };
}
/** @param {{ svgText?: string, mod?: string, relPath?: string, options?: import('./art/svg-import.mjs').ImportOptions }} args */
export function importSvgShape(args) {
  return artio.importSvgShape(args);
}
/** @param {string} modName @param {string} relPath @param {{ abc?: 'none'|'stub', overrideScene?: unknown, writeSwflist?: boolean, dryRun?: boolean }} [opts] */
export function buildSwf(modName, relPath, opts) {
  return artio.buildSwf(modName, relPath, opts);
}
/** @param {string} modName @param {string} relPath */
export function inspectSwf(modName, relPath) {
  return artio.inspectSwf(modName, relPath);
}
/** @param {string} modName @param {string} relPath */
export function readArtAsset(modName, relPath) {
  return artio.readModBytes(modName, relPath);
}
/** @param {string} modName @param {string} relPath @param {Uint8Array} bytes */
export function writeArtAsset(modName, relPath, bytes) {
  return artio.writeModBytes(modName, relPath, bytes);
}
/** @param {'palette'|'fx_palette'} [which] */
export function readArtPalette(which) {
  const p = readPalette(which);
  return { ...p, hints: knownRowHints(), defaultAbc: DEFAULT_ABC_MODE };
}
/** @param {string} [modName] */
export function prepareAbcGateTest(modName) {
  return artio.prepareAbcGateTest(modName);
}
export { exampleScene as exampleArtScene };

// ---- in-game test harness (docs/ingame-testing.md) --------------------------

/**
 * List committed in-game test scripts (mods/<mod>/tests/*.mewtest) with their parsed headers.
 * @param {string} [modName]
 */
export function listIngameTests(modName) {
  return ingame.listIngameTests(modName);
}

/**
 * Launch the game once with the mewtest harness and run one script. Blocks until the
 * game exits (or the timeout + backstop). Returns the report; `{ ok: false, error }` for
 * bad arguments. `env` is for tests only (defaults to process.env).
 * @param {{ mod: string, test?: string, script?: string, timeoutMs?: number, hide?: boolean,
 *   savesuffix?: string, saveCheck?: boolean, includeEvents?: boolean,
 *   env?: Record<string, string|undefined> }} args
 */
export async function runIngameTest(args) {
  const { mod, test, script } = args || {};
  if (!mod || typeof mod !== "string") return { ok: false, error: "mod is required" };
  if ((test && script) || (!test && !script)) return { ok: false, error: "pass exactly one of `test` (a name under mods/<mod>/tests/) or `script` (inline .mewtest text)" };
  /** @type {import("./ingame/script.mjs").Plan} */
  let plan;
  /** @type {string|null} */
  let scriptPath = null;
  let name = "inline";
  if (test) {
    const entry = ingame.listIngameTests(mod).tests.find((t) => t.name === test);
    if (!entry) return { ok: false, error: `no test "${test}" under mods/${mod}/tests/ (${ingame.listIngameTests(mod).tests.map((t) => t.name).join(", ") || "none"})` };
    plan = entry.plan;
    scriptPath = entry.absPath;
    name = entry.name;
  } else {
    plan = ingame.parseScript(String(script), { owningMod: mod, name });
  }
  if (args.timeoutMs !== undefined) plan = { ...plan, timeoutMs: args.timeoutMs };
  if (args.hide !== undefined) plan = { ...plan, hide: args.hide };
  if (args.savesuffix !== undefined) plan = { ...plan, savesuffix: args.savesuffix };
  const report = await ingame.runPlan({ plan, test: { mod, name, scriptPath }, env: args.env, saveCheck: args.saveCheck });
  if (!args.includeEvents) report.result = { ...report.result, events: [] };
  return report;
}

// ---- native bindings (bindings/<build>.json, docs/binding-port.md) ------------

/**
 * Is the installed Mewgenics.exe (or `exe`) a build the bindings manifests know, and does every
 * signature still match exactly once at its RVA? Read-only; never launches the game. Returns
 * `{ ok: false, skipped: true, reason }` when the exe or the manifests are absent.
 * `env` / `manifests` are for tests (default: process.env and bindings/*.json).
 * @param {{ exe?: string, env?: Record<string, string|undefined>, manifests?: import("./bindings/manifest.mjs").Manifest[] }} [args]
 */
export function checkGameBuild(args = {}) {
  return checkInstalledBuild({ exePath: args.exe, env: args.env, manifests: args.manifests });
}

/**
 * Port the bindings manifest of a known build to a new exe (docs/binding-port.md). Walks the
 * resolution ladder for every entry and returns the rows, the summary, the entries that need an
 * agent or a human, and the markdown report. `dryRun` (default true) writes nothing; otherwise
 * bindings/<build>.json and bindings/<build>.port-report.md are written (never anywhere else:
 * SafetyError). `from` defaults to the newest manifest, `exe` to the installed game.
 * @param {{ build: string, from?: string, exe?: string, version?: string, resolve?: Record<string, string>, dryRun?: boolean, out?: string, env?: Record<string, string|undefined> }} args
 */
export function portBindings(args) {
  const build = String(args.build ?? "");
  if (!/^\d+$/.test(build)) return { ok: false, skipped: false, reason: `build must be the new Steam build id (digits only), got ${JSON.stringify(args.build)}` };
  const exePath = resolvePath(args.exe || join(locateGameDir(args.env || process.env), "Mewgenics.exe"));
  if (touchesSaves(exePath)) throw new SafetyError(`refusing to read a saves path: ${exePath}`);
  if (!existsSync(exePath)) return { ok: false, skipped: true, reason: `exe not found: ${exePath}` };
  let fromPath = args.from;
  if (!fromPath) {
    const all = listManifests();
    if (!all.length) return { ok: false, skipped: true, reason: "no bindings/<build>.json manifests to port from" };
    fromPath = all[all.length - 1].path;
  }
  const old = loadManifest(fromPath);
  const buf = readFileSync(exePath);
  /** @type {import("./bindings/pe.mjs").Pe} */
  let pe;
  try {
    pe = parsePe(buf);
  } catch (e) {
    if (e instanceof PeError) return { ok: false, skipped: false, reason: `not a PE32+ image: ${e.message}` };
    throw e;
  }
  const dryRun = args.dryRun !== false;
  const result = portManifest(old, pe, buf, { steamBuildId: build, gameVersion: args.version, resolve: args.resolve || {} });
  const report = renderPortReport(result, { generatedAt: new Date().toISOString() });
  /** @type {{ ok: true, dryRun: boolean, from: string, exe: string, build: string, summary: Record<string, number>, rows: any[], needsAgent: any[], report: string, written?: { manifest: string, report: string } }} */
  const out = { ok: true, dryRun, from: fromPath, exe: exePath, build, summary: result.summary, rows: result.rows, needsAgent: result.needsAgent, report };
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
