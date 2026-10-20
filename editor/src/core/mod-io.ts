// Reading and writing mod folders. All writes go through resolveModWritePath so
// they can only land under mods/<name>/ and never touch saves/ or game files.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { MODS_DIR, resolveModWritePath } from "./repo.ts";
import { parseOverlayName } from "./overlay/overlay.ts";
import type { OverlayMode, FileType } from "./overlay/overlay.ts";

/** List mod folder names under mods/. */
export function listMods(): string[] {
  if (!existsSync(MODS_DIR)) return [];
  return readdirSync(MODS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export interface ModFileInfo {
  relPath: string;
  bytes: number;
  baseName: string;
  mode: OverlayMode;
  fileType: FileType;
}

/** Recursively list files under a mod, with overlay metadata. */
export function listModFiles(modName: string): ModFileInfo[] {
  const modDir = join(MODS_DIR, modName);
  const out: ModFileInfo[] = [];
  if (!existsSync(modDir)) return out;
  const walk = (dir: string): void => {
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

export interface ModFileWithText extends ModFileInfo {
  text?: string;
}

export type ReadModResult =
  | { ok: true; name: string; description: unknown; files: ModFileWithText[] }
  | { ok: false; error: string };

/** Read a mod: its description.json (if any) and the list of overlay files. */
export function readMod(modName: string, opts: { includeText?: boolean } = {}): ReadModResult {
  const modDir = join(MODS_DIR, modName);
  if (!existsSync(modDir)) return { ok: false, error: `mod not found: mods/${modName}` };
  let description: unknown = null;
  const descPath = join(modDir, "description.json");
  if (existsSync(descPath)) {
    try {
      description = JSON.parse(readFileSync(descPath, "utf8"));
    } catch (e) {
      description = { _error: `could not parse description.json: ${String(e)}` };
    }
  }
  const files: ModFileWithText[] = listModFiles(modName).map((f) => {
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

export type ReadModFileResult = { ok: true; text: string } | { ok: false; error: string };

/** Read one overlay file's text. */
export function readModFile(modName: string, relPath: string): ReadModFileResult {
  const abs = resolveModWritePath(modName, relPath); // also validates confinement
  if (!existsSync(abs)) return { ok: false, error: `file not found: mods/${modName}/${relPath}` };
  return { ok: true, text: readFileSync(abs, "utf8") };
}

export type WriteOverlayResult = { ok: true; path: string; bytes: number } | { ok: false; error: string };

/** Write (create or overwrite) an overlay file under mods/<name>/. */
export function writeOverlay(modName: string, relPath: string, content: string): WriteOverlayResult {
  let abs: string;
  try {
    abs = resolveModWritePath(modName, relPath);
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) };
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return { ok: true, path: `mods/${modName}/${relPath}`, bytes: Buffer.from(content).length };
}
