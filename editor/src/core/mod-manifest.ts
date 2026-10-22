// The mod manifest: mods/<name>/mod.json — what a shipped mod says about itself (docs/data-mods.md "Shipping a mod").
// The game never reads it (a file at the mod root that no pack file is named like is ignored, like description.json);
// the editor's validator, `pack` and `install` do.
//
//   name          the mod folder name (must equal it)               "jokers-luck"
//   version       semver                                            "0.1.0"
//   author        who made it                                       "MeyerZon"
//   description   one paragraph                                     "…"
//   gameBuild     the Steam build id it was tested on (digits; bindings/<id>.json names the known ones)   "25143593"
//   native        optional: the mod's own DLL file names, shipped in the zip under native/   ["jokers_luck.dll"]
//   frameworkApi  required with `native`: the mewframework API version the DLLs need (FW_API_VERSION)   4
//   license       optional, e.g. "MIT", "CC-BY-4.0", "All rights reserved"
//   attribution   optional, suggested: the ATTRIBUTION.md line (an ask, never a condition)

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NativeBuild } from "./validate/validator.ts";

export const MOD_MANIFEST_FILE = "mod.json";
/** The one line ATTRIBUTION.md asks for; pinned against that file by a test. */
export const ATTRIBUTION_LINE = "Made with mewgenics-mods (https://github.com/MeyerZon/mewgenics-mods).";
/** A mod folder name the editor accepts (also the zip's top folder). */
export const MOD_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DLL_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.dll$/i;

export interface ModManifest {
  name: string;
  version: string;
  author: string;
  description: string;
  gameBuild: string;
  native?: string[];
  frameworkApi?: number;
  license?: string;
  attribution?: string;
}

export type ParseManifestResult = { ok: true; manifest: ModManifest } | { ok: false; errors: string[] };

/** Parse and check a mod.json text. `folder` (the mod folder / zip top folder) must equal `name` when given. */
export function parseModManifest(text: string, folder?: string): ParseManifestResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`mod.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: ["mod.json must be a JSON object"] };
  const o = raw as Record<string, unknown>;
  const errors: string[] = [];
  const str = (k: string, required: boolean, nonEmpty: boolean): string | undefined => {
    const v = o[k];
    if (v === undefined) { if (required) errors.push(`${k} is required`); return undefined; }
    if (typeof v !== "string") { errors.push(`${k} must be a string`); return undefined; }
    if (nonEmpty && !v.trim()) { errors.push(`${k} must not be empty`); return undefined; }
    return v;
  };
  const name = str("name", true, true);
  if (name !== undefined && !MOD_NAME_RE.test(name)) errors.push(`name ${JSON.stringify(name)} must be a folder name: letters, digits, _ . - (max 64)`);
  if (name !== undefined && folder !== undefined && name !== folder) errors.push(`name ${JSON.stringify(name)} must equal the mod folder name ${JSON.stringify(folder)}`);
  const version = str("version", true, true);
  if (version !== undefined && !SEMVER_RE.test(version)) errors.push(`version ${JSON.stringify(version)} must be semver, e.g. 1.0.0`);
  const author = str("author", true, true);
  const description = str("description", true, false);
  const gameBuild = str("gameBuild", true, true);
  if (gameBuild !== undefined && !/^\d+$/.test(gameBuild)) errors.push(`gameBuild ${JSON.stringify(gameBuild)} must be the Steam build id (digits, as in bindings/<id>.json), not the version string`);
  const license = str("license", false, false);
  const attribution = str("attribution", false, false);
  let native: string[] | undefined;
  if (o.native !== undefined) {
    if (!Array.isArray(o.native) || o.native.some((d) => typeof d !== "string" || !DLL_RE.test(d))) errors.push("native must be a list of bare .dll file names, e.g. [\"my_mod.dll\"]");
    else native = o.native as string[];
  }
  let frameworkApi: number | undefined;
  if (o.frameworkApi !== undefined) {
    if (!Number.isInteger(o.frameworkApi) || (o.frameworkApi as number) < 1) errors.push("frameworkApi must be a positive integer (mewframework's FW_API_VERSION)");
    else frameworkApi = o.frameworkApi as number;
  }
  if (native && native.length > 0 && frameworkApi === undefined && o.frameworkApi === undefined) errors.push("frameworkApi is required when native lists DLLs (the mewframework API version they need)");
  if (errors.length) return { ok: false, errors };
  const manifest: ModManifest = { name: name!, version: version!, author: author!, description: description!, gameBuild: gameBuild! };
  if (native) manifest.native = native;
  if (frameworkApi !== undefined) manifest.frameworkApi = frameworkApi;
  if (license !== undefined) manifest.license = license;
  if (attribution !== undefined) manifest.attribution = attribution;
  return { ok: true, manifest };
}

export type ReadManifestResult = { present: false } | ({ present: true } & ParseManifestResult);

/** Read <modDir>/mod.json; `present: false` when there is none. */
export function readModManifest(modDir: string, folder: string): ReadManifestResult {
  const p = join(modDir, MOD_MANIFEST_FILE);
  if (!existsSync(p)) return { present: false };
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch (e) {
    return { present: true, ok: false, errors: [`could not read mod.json: ${e instanceof Error ? e.message : String(e)}`] };
  }
  return { present: true, ...parseModManifest(text, folder) };
}

export interface DraftOptions {
  modDir: string;
  modName: string;
  gameBuild: string;
  native?: string[];
  frameworkApi?: number;
}

/** A valid mod.json for a mod that has none, seeded from its description.json (title/author/version/description). */
export function draftModManifest(o: DraftOptions): ModManifest {
  let desc: Record<string, unknown> = {};
  try {
    const p = join(o.modDir, "description.json");
    if (existsSync(p)) {
      const v = JSON.parse(readFileSync(p, "utf8")) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) desc = v as Record<string, unknown>;
    }
  } catch {
    /* an unreadable description.json just means no seed */
  }
  const s = (k: string) => (typeof desc[k] === "string" ? (desc[k] as string) : "");
  const m: ModManifest = {
    name: o.modName,
    version: SEMVER_RE.test(s("version")) ? s("version") : "0.1.0",
    author: s("author").trim() || "unknown",
    description: s("description"),
    gameBuild: o.gameBuild,
  };
  if (o.native && o.native.length) {
    m.native = o.native;
    m.frameworkApi = o.frameworkApi ?? 1;
  }
  m.license = "";
  m.attribution = ATTRIBUTION_LINE;
  return m;
}

export interface BuildComparison {
  /** match: the installed exe is the build the mod was tested on; mismatch: another (or an unknown) build; unknown: no exe found */
  status: "match" | "mismatch" | "unknown";
  modBuild: string;
  /** the installed build's Steam id when a bindings manifest knows it, else null */
  installedBuild: string | null;
  /** whether the installed exe is a build bindings/*.json knows; null without an exe */
  installedKnown: boolean | null;
  installedTimeDateStamp?: string;
}

/** Compare the mod's tested build with the installed exe's identity (validator `installedNativeBuild`, or injected). */
export function compareBuild(modBuild: string, installed: NativeBuild | null): BuildComparison {
  if (!installed) return { status: "unknown", modBuild, installedBuild: null, installedKnown: null };
  const id = installed.known && installed.matched ? installed.matched.steamBuildId : null;
  const out: BuildComparison = { status: id === modBuild ? "match" : "mismatch", modBuild, installedBuild: id, installedKnown: installed.known };
  if (installed.identity?.timeDateStamp) out.installedTimeDateStamp = installed.identity.timeDateStamp;
  return out;
}

/** One sentence describing a mismatch, for findings and prompts. */
export function describeMismatch(c: BuildComparison): string {
  return c.installedBuild
    ? `the mod was tested on Steam build ${c.modBuild}, the installed game is build ${c.installedBuild}`
    : `the mod was tested on Steam build ${c.modBuild}, the installed game is a build no bindings/<id>.json knows${c.installedTimeDateStamp ? ` (PE TimeDateStamp ${c.installedTimeDateStamp})` : ""} — probably a newer game update`;
}
