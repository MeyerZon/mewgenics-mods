// Where a GON `#include` resolves — the file-loading half of the game's pre-pass (RE session inc 2026-10-22,
// docs/engine-map.md "GON parser"):
//
// - `GonResource::decode` 0x9a6100 / `combined_decode` 0x9a64a0 capture the directory of the resource being loaded
//   (its pack path up to and including the last `/`, e.g. `data/maps/` for `data/maps/alley.gon`) and the include
//   lambda (0x9a7610 / 0x9a7490) asks for `dir + name` — plain concatenation — as a `TextResource`
//   (`ResourceManager_GetTextResource` 0x7c10e0). A miss is the fatal `Could not locate include file: <name>`.
// - That lookup goes through the same file manager as every data file: a mod's own copy at the mirrored path wins
//   over the pack, and when the file exists, its `.append` / `.merge` / `.patch` overlays are picked up by the
//   INCLUDED name — but `TextResource::combined_decode` 0x9a5a20 just concatenates their raw text after the base text
//   (the mode is ignored): an overlay on an included file is pasted, never merged.
// - Overlay files are resolved against the BASE resource's directory (the lambda captures `this->path`), which in a
//   mod folder mirroring the pack is the same relative directory.
//
// - The joined path is NOT normalised anywhere: the pack index is looked up by that exact string and a loose
//   (`-modpaths`) file as `<modpath> + string` through std::filesystem (FileManager_FileExists 0x9a14c0; the open,
//   FileManager_GetFile 0x99ff50, walks the same mod paths first). A name with a `.` / `..` / empty segment, a
//   leading `/`, a drive letter or a backslash therefore never matches a pack file (fatal) and is handed to the OS for
//   loose files (where `..` can leave the mod folder). Such a name is `unsafe` here and never read.
//
// Safety: only `<dataRoot>/…` (`.extracted/data` by default) and `<modDir>/data/…` are ever read; a name that
// normalises outside `data/` is refused (`outside`), never read.

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { EXTRACTED_DATA, packPath, isInside } from "./repo.ts";
import { preprocess } from "./gon/preprocess.ts";
import type { PreprocessResult } from "./gon/preprocess.ts";

export interface IncludeContext {
  /** pack path of the resource being loaded, e.g. `data/maps/alley.gon` (for an overlay: its base file) */
  resource: string;
  /** the extracted `data/` tree; default EXTRACTED_DATA */
  dataRoot?: string;
  /** the mod folder (mirrors the pack: `<modDir>/data/…`) whose files and overlays take part, if any */
  modDir?: string;
}

export interface IncludeTarget {
  /** `dir(resource) + name`, normalised (posix) */
  packPath: string;
  /** the name escapes `data/`: refused, nothing read */
  outside: boolean;
  /** the name is not a literal relative pack path (`.`/`..`/empty segment, leading `/`, drive letter, backslash): the game
   * never finds it in the pack and passes it to the OS for loose files; refused, nothing read */
  unsafe?: boolean;
  /** where the file was found: the mod's own copy, the base data, or nowhere */
  source: "mod" | "base" | null;
  /** the mod's overlays on the included name (pack paths), concatenated after the file's text */
  overlays: string[];
  /** the TextResource text the game would inline (before the pre-pass), or null when the include is missing */
  text: string | null;
}

/** The directory the game resolves includes against: the resource path up to and including its last `/`. */
export function includeDir(resource: string): string {
  const p = resource.replace(/\\/g, "/");
  const k = p.lastIndexOf("/");
  return k < 0 ? "" : p.slice(0, k + 1);
}

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

/** True when `name` is not a literal relative pack path (see the header): the game would not normalise it. */
export function isUnsafeIncludeName(name: string): boolean {
  if (name.includes("\\") || /^[A-Za-z]:/.test(name)) return true;
  return name.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
}

/** Resolve one `#include` name the way the game does (see the header). */
export function locateInclude(ctx: IncludeContext, name: string): IncludeTarget {
  const joined = (includeDir(ctx.resource) + name).replace(/\\/g, "/");
  const norm = posix.normalize(joined);
  const none = (outside: boolean): IncludeTarget => ({ packPath: norm, outside, source: null, overlays: [], text: null });
  if (!norm.startsWith("data/") || posix.isAbsolute(norm)) return { ...none(true), ...(isUnsafeIncludeName(name) ? { unsafe: true } : {}) };
  if (isUnsafeIncludeName(name)) return { ...none(false), unsafe: true };
  const dataRoot = ctx.dataRoot ?? EXTRACTED_DATA;
  const baseAbs = packPath(norm, dataRoot);
  if (!isInside(dataRoot, baseAbs)) return none(true);
  const modAbs = ctx.modDir ? join(ctx.modDir, ...norm.split("/")) : null;
  if (modAbs && !isInside(ctx.modDir!, modAbs)) return none(true);

  let source: IncludeTarget["source"] = null;
  let text: string | null = null;
  if (modAbs && isFile(modAbs)) {
    source = "mod";
    text = readFileSync(modAbs, "utf8");
  } else if (isFile(baseAbs)) {
    source = "base";
    text = readFileSync(baseAbs, "utf8");
  }
  const overlays: string[] = [];
  if (text !== null && modAbs) {
    // TextResource::combined_decode: base text, then each overlay's raw text, mode ignored (suffix order as
    // FileManager_ResolveWithOverlays 0x9a09f0 probes them: .append, .merge, .patch).
    for (const suffix of [".append", ".merge", ".patch"]) {
      if (isFile(modAbs + suffix)) {
        overlays.push(norm + suffix);
        text += readFileSync(modAbs + suffix, "utf8");
      }
    }
  }
  return { packPath: norm, outside: false, source, overlays, text };
}

/** Run the game's pre-pass over a GON text loaded as `ctx.resource` (includes resolved by locateInclude). */
export function preprocessFile(text: string, ctx: IncludeContext): PreprocessResult {
  return preprocess(text, (name) => locateInclude(ctx, name).text);
}
