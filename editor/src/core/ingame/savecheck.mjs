// Read-only SHA-256 snapshot of the REAL save, taken before and after a
// harness run, so "the harness never touched the real save" is an automated
// assertion instead of a promise.
//
// This is the one place in the editor that reads paths under saves/. It was
// approved by the owner (2026-10-18) for this purpose only. It uses node:fs
// directly and deliberately does NOT go through repo.resolveReadPath, whose
// touchesSaves() guard stays as strict as ever for everything else. It never
// opens anything for writing. Since 2026-10-19 (leftovers PR 5) it also lists the
// saves dir and hashes every *.sav the suffixed launch is NOT allowed to write
// (snapshotSaves / compareSaveSets), because a dev launch was seen writing
// campaign02.sav while only steamcampaign01.sav was checked.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

/** SHA-256 of steamcampaign01.sav recorded on 2026-10-17 (docs/engine-map.md). Informational. */
export const KNOWN_REAL_SAVE_SHA256 = "09a68a36f6337e4eb493a7b2c119fdae494c02d0ef5438881e032faa03a7af08";
export const REAL_SAVE_FILE = "steamcampaign01.sav";

/** @typedef {{ path: string, present: boolean, sha256: string|null, bytes: number, mtimeMs: number }} SaveSnapshot */

/**
 * @param {string} path
 * @returns {SaveSnapshot}
 */
export function snapshotFile(path) {
  if (!existsSync(path)) return { path, present: false, sha256: null, bytes: 0, mtimeMs: 0 };
  const buf = readFileSync(path);
  const st = statSync(path);
  return { path, present: true, sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length, mtimeMs: st.mtimeMs };
}

/**
 * %APPDATA%\Glaiel Games\Mewgenics\<single steamid>\saves\steamcampaign01.sav, or null.
 * @param {Record<string, string|undefined>} env
 * @returns {string|null}
 */
export function realSavePath(env) {
  if (!env.APPDATA) return null;
  const base = join(env.APPDATA, "Glaiel Games", "Mewgenics");
  if (!existsSync(base)) return null;
  const ids = readdirSync(base, { withFileTypes: true })
    .filter((/** @type {any} */ d) => d.isDirectory() && /^\d+$/.test(d.name))
    .map((/** @type {any} */ d) => d.name);
  if (ids.length !== 1) return null;
  return join(base, ids[0], "saves", REAL_SAVE_FILE);
}

/**
 * %APPDATA%\Glaiel Games\Mewgenics\<single steamid>\saves, or null (two ids: never guess).
 * @param {Record<string, string|undefined>} env
 * @returns {string|null}
 */
export function realSavesDir(env) {
  const p = realSavePath(env);
  return p ? p.slice(0, p.length - REAL_SAVE_FILE.length - 1) : null;
}

/**
 * The save files a launch with `-savesuffix <suffix>` may legitimately write. Everything else under saves/ must
 * stay byte-identical across a harness run. Decoded from `MewSaveFile::open_or_create` (docs/engine-map.md
 * "Save safety"); OBSERVED 2026-10-18: a dev launch wrote `campaign02.sav`, never a `*dev*` file.
 * @param {string} suffix
 * @returns {RegExp}
 */
export function devSavePattern(suffix) {
  const s = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(campaign\\d+\\.sav|${s}\\d*\\.sav|${s}campaign\\d+\\.sav)$`, "i");
}

/** @typedef {{ dir: string, present: boolean, files: (SaveSnapshot & { name: string })[], skipped: string[] }} SaveSetSnapshot */

/**
 * Hash every *.sav in `dir` except the names `allow` matches (the suffixed launch's own files, listed in `skipped`).
 * Read-only; never follows into other directories.
 * @param {string} dir @param {{ allow: RegExp }} opts
 * @returns {SaveSetSnapshot}
 */
export function snapshotSaves(dir, opts) {
  if (!existsSync(dir)) return { dir, present: false, files: [], skipped: [] };
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((/** @type {any} */ d) => d.isFile() && /\.sav$/i.test(d.name))
    .map((/** @type {any} */ d) => d.name)
    .sort();
  /** @type {string[]} */
  const skipped = [];
  /** @type {(SaveSnapshot & { name: string })[]} */
  const files = [];
  for (const name of names) {
    if (opts.allow.test(name)) { skipped.push(name); continue; }
    files.push({ name, ...snapshotFile(join(dir, name)) });
  }
  return { dir, present: true, files, skipped };
}

/**
 * @param {SaveSetSnapshot} before @param {SaveSetSnapshot} after
 * @returns {{ unchanged: boolean, changed: string[], detail: string }}
 */
export function compareSaveSets(before, after) {
  /** @type {Map<string, SaveSnapshot>} */
  const b = new Map(before.files.map((f) => [f.name, f]));
  /** @type {Map<string, SaveSnapshot>} */
  const a = new Map(after.files.map((f) => [f.name, f]));
  /** @type {string[]} */
  const changed = [];
  /** @type {string[]} */
  const why = [];
  for (const [name, x] of b) {
    const y = a.get(name);
    if (!y) { changed.push(name); why.push(`${name} vanished`); continue; }
    if (x.sha256 !== y.sha256 || x.bytes !== y.bytes) { changed.push(name); why.push(`${name} CHANGED ${String(x.sha256).slice(0, 12)}… (${x.bytes} B) -> ${String(y.sha256).slice(0, 12)}… (${y.bytes} B)`); }
  }
  for (const name of a.keys()) if (!b.has(name)) { changed.push(name); why.push(`${name} appeared`); }
  changed.sort();
  const detail = changed.length
    ? why.join("; ")
    : `${after.files.length} real save file(s) unchanged${after.skipped.length ? ` (${after.skipped.join(", ")} belong to the suffixed launch)` : ""}`;
  return { unchanged: changed.length === 0, changed, detail };
}

/**
 * @param {SaveSnapshot} before @param {SaveSnapshot} after
 * @returns {{ unchanged: boolean, matchesKnownBaseline: boolean, detail: string }}
 */
export function compareSnapshots(before, after) {
  const unchanged = before.present === after.present && before.sha256 === after.sha256 && before.bytes === after.bytes;
  const matchesKnownBaseline = after.sha256 === KNOWN_REAL_SAVE_SHA256;
  const detail = !before.present && !after.present
    ? "real save not present before or after"
    : unchanged
      ? `unchanged (${after.bytes} bytes, sha256 ${String(after.sha256).slice(0, 12)}…)`
      : `CHANGED: before ${String(before.sha256).slice(0, 12)}… (${before.bytes} B) -> after ${String(after.sha256).slice(0, 12)}… (${after.bytes} B)`;
  return { unchanged, matchesKnownBaseline, detail };
}
