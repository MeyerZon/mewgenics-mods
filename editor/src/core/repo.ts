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
// The two git-ignored inputs a checkout accumulates can be redirected, so a secondary git worktree (which has
// neither) reads the main checkout's copies (docs/tdd-procedure.md "Running the editor from a git worktree"):
//   MEWGENICS_EXTRACTED_DATA  the extracted `data/` tree; default <repo>/.extracted/data. The test runner also
//                             points it at an empty dir for the T0-without-game-data nested run.
//   MEWGENICS_EDITOR_DATA     the editor's cache dir (component-names.json, base-index.json, ingame-runs/);
//                             default <repo>/editor/data. Refused under any `saves/` path (the editor writes here).
export const EXTRACTED_DATA = process.env.MEWGENICS_EXTRACTED_DATA
  ? resolve(process.env.MEWGENICS_EXTRACTED_DATA)
  : join(REPO_ROOT, ".extracted", "data");
export const MODS_DIR = join(REPO_ROOT, "mods");
export const DATA_CACHE_DIR = process.env.MEWGENICS_EDITOR_DATA
  ? resolve(process.env.MEWGENICS_EDITOR_DATA)
  : join(EDITOR_DIR, "data");
export const REGISTERED_NAMES_PATH = join(EDITOR_DIR, "registered-names.json");
export const ANALYSIS_DIR = join(REPO_ROOT, ".analysis");
export const COMBINED_CSV = join(EXTRACTED_DATA, "text", "combined.csv");

/**
 * Where a pack-relative base file (`data/characters/enemies.gon`, `swfs/catparts.swf`) lives on disk. `root` is
 * the extracted `data/` tree, so `data/<x>` maps straight under it; any other pack directory is a sibling of it
 * (with the default root `.extracted/data` that is `.extracted/<packRel>`).
 */
export function packPath(packRel: string, root: string = EXTRACTED_DATA): string {
  const p = packRel.replace(/\\/g, "/");
  return p.startsWith("data/") ? join(root, p.slice("data/".length)) : join(root, "..", p);
}

/** True if `child` is the same as or located inside `parent`. */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** True if any path segment is a `saves` directory (case-insensitive); both separators count, so a Windows-shaped
 * path is caught on a Linux host too. */
export function touchesSaves(p: string): boolean {
  return resolve(p)
    .split(/[\\/]/)
    .some((seg) => seg.toLowerCase() === "saves");
}

export class SafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafetyError";
  }
}

// The cache dir is the one place outside mods/ the editor writes; an override must never point near a save.
if (touchesSaves(DATA_CACHE_DIR)) {
  throw new SafetyError(`MEWGENICS_EDITOR_DATA points under a saves/ directory (${DATA_CACHE_DIR}); the editor writes its caches there and never near a save`);
}

/**
 * Validate and resolve a path for reading base/extracted data. Must live under
 * .extracted/ (or the repo generally) and must not touch a saves directory.
 * @param p absolute or repo-relative
 * @returns resolved absolute path
 */
export function resolveReadPath(p: string): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(REPO_ROOT, p);
  if (touchesSaves(abs)) throw new SafetyError(`refusing to read a saves path: ${abs}`);
  return abs;
}

/**
 * Validate and resolve a write path under mods/<name>/. Rejects writes outside
 * mods/, any saves path, and the protected game files.
 * @param relPath path relative to the mod folder, e.g. "data/abilities/x.gon.append"
 * @returns resolved absolute path
 */
export function resolveModWritePath(modName: string, relPath: string): string {
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
export function ensureDataCacheDir(): string {
  if (!existsSync(DATA_CACHE_DIR)) mkdirSync(DATA_CACHE_DIR, { recursive: true });
  return DATA_CACHE_DIR;
}
