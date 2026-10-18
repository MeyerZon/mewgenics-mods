// Reading and writing mod folders. All writes go through resolveModWritePath so
// they can only land under mods/<name>/ and never touch saves/ or game files.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { MODS_DIR, resolveModWritePath } from "./repo.mjs";
import { parseOverlayName } from "./overlay/overlay.mjs";

/**
 * List mod folder names under mods/.
 * @returns {string[]}
 */
export function listMods() {
  if (!existsSync(MODS_DIR)) return [];
  return readdirSync(MODS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * @typedef {Object} ModFileInfo
 * @property {string} relPath
 * @property {number} bytes
 * @property {string} baseName
 * @property {'append'|'merge'|'patch'|'replace'} mode
 * @property {'gon'|'csv'|'txt'|'other'} fileType
 */

/**
 * Recursively list files under a mod, with overlay metadata.
 * @param {string} modName
 * @returns {ModFileInfo[]}
 */
export function listModFiles(modName) {
  const modDir = join(MODS_DIR, modName);
  /** @type {ModFileInfo[]} */
  const out = [];
  if (!existsSync(modDir)) return out;
  /** @param {string} dir */
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (ent.isFile()) {
        const relPath = relative(modDir, abs).replace(/\\/g, "/");
        const fileName = relPath.split("/").pop() || relPath;
        const { baseName: leaf, mode, fileType } = parseOverlayName(fileName);
        const baseName = relPath.slice(0, relPath.length - fileName.length) + leaf;
        out.push({ relPath, bytes: statSync(abs).size, baseName, mode, fileType });
      }
    }
  };
  walk(modDir);
  return out;
}

/**
 * Read a mod: its description.json (if any) and the list of overlay files.
 * @param {string} modName
 * @param {{ includeText?: boolean }} [opts]
 */
export function readMod(modName, opts = {}) {
  const modDir = join(MODS_DIR, modName);
  if (!existsSync(modDir)) return { ok: false, error: `mod not found: mods/${modName}` };
  let description = null;
  const descPath = join(modDir, "description.json");
  if (existsSync(descPath)) {
    try {
      description = JSON.parse(readFileSync(descPath, "utf8"));
    } catch (e) {
      description = { _error: `could not parse description.json: ${String(e)}` };
    }
  }
  const files = listModFiles(modName).map((f) => {
    if (opts.includeText && f.relPath !== "description.json") {
      try {
        return { ...f, text: readFileSync(join(modDir, f.relPath), "utf8") };
      } catch {
        return f;
      }
    }
    return f;
  });
  return { ok: true, name: modName, description, files };
}

/**
 * Read one overlay file's text.
 * @param {string} modName
 * @param {string} relPath
 */
export function readModFile(modName, relPath) {
  const abs = resolveModWritePath(modName, relPath); // also validates confinement
  if (!existsSync(abs)) return { ok: false, error: `file not found: mods/${modName}/${relPath}` };
  return { ok: true, text: readFileSync(abs, "utf8") };
}

/**
 * Write (create or overwrite) an overlay file under mods/<name>/.
 * @param {string} modName
 * @param {string} relPath
 * @param {string} content
 * @returns {{ ok: true, path: string, bytes: number } | { ok: false, error: string }}
 */
export function writeOverlay(modName, relPath, content) {
  let abs;
  try {
    abs = resolveModWritePath(modName, relPath);
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) };
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return { ok: true, path: `mods/${modName}/${relPath}`, bytes: Buffer.from(content).length };
}
