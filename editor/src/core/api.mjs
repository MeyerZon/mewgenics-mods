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
