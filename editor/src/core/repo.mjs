// Repository paths and the hard safety guards.
//
// Safety invariants enforced here (see AGENTS.md and the build brief):
//   - The editor only READS base data under .extracted/ and the repo's mods/.
//   - The editor only WRITES under mods/<name>/ and the git-ignored editor/data/.
//   - It NEVER reads or writes anything under any `saves/` directory.
//   - It never touches Mewgenics.exe or resources.gpak.

import { fileURLToPath } from "node:url";
import { dirname, resolve, join, relative, isAbsolute, sep } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url)); // <repo>/editor/src/core
export const REPO_ROOT = resolve(here, "..", "..", "..");
export const EDITOR_DIR = join(REPO_ROOT, "editor");
export const EXTRACTED_DATA = join(REPO_ROOT, ".extracted", "data");
export const MODS_DIR = join(REPO_ROOT, "mods");
export const DATA_CACHE_DIR = join(EDITOR_DIR, "data");
export const REGISTERED_NAMES_PATH = join(EDITOR_DIR, "registered-names.json");
export const ANALYSIS_DIR = join(REPO_ROOT, ".analysis");
export const COMBINED_CSV = join(EXTRACTED_DATA, "text", "combined.csv");

/**
 * True if `child` is the same as or located inside `parent`.
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
export function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * True if any path segment is a `saves` directory (case-insensitive).
 * @param {string} p
 */
export function touchesSaves(p) {
  return resolve(p)
    .split(sep)
    .some((seg) => seg.toLowerCase() === "saves");
}

export class SafetyError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "SafetyError";
  }
}

/**
 * Validate and resolve a path for reading base/extracted data. Must live under
 * .extracted/ (or the repo generally) and must not touch a saves directory.
 * @param {string} p absolute or repo-relative
 * @returns {string} resolved absolute path
 */
export function resolveReadPath(p) {
  const abs = isAbsolute(p) ? resolve(p) : resolve(REPO_ROOT, p);
  if (touchesSaves(abs)) throw new SafetyError(`refusing to read a saves path: ${abs}`);
  return abs;
}

/**
 * Validate and resolve a write path under mods/<name>/. Rejects writes outside
 * mods/, any saves path, and the protected game files.
 * @param {string} modName
 * @param {string} relPath  path relative to the mod folder, e.g. "data/abilities/x.gon.append"
 * @returns {string} resolved absolute path
 */
export function resolveModWritePath(modName, relPath) {
  if (!modName || /[\\/]/.test(modName) || modName === "." || modName === "..") {
    throw new SafetyError(`invalid mod name: ${JSON.stringify(modName)}`);
  }
  const abs = resolve(MODS_DIR, modName, relPath);
  if (!isInside(join(MODS_DIR, modName), abs)) {
    throw new SafetyError(`refusing to write outside mods/${modName}: ${abs}`);
  }
  if (touchesSaves(abs)) throw new SafetyError(`refusing to write a saves path: ${abs}`);
  const lower = abs.toLowerCase();
  if (lower.endsWith("mewgenics.exe") || lower.endsWith("resources.gpak")) {
    throw new SafetyError(`refusing to write a protected game file: ${abs}`);
  }
  return abs;
}

/** Ensure the git-ignored editor/data/ cache directory exists. */
export function ensureDataCacheDir() {
  if (!existsSync(DATA_CACHE_DIR)) mkdirSync(DATA_CACHE_DIR, { recursive: true });
  return DATA_CACHE_DIR;
}
