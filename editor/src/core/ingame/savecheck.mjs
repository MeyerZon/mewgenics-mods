// Read-only SHA-256 snapshot of the REAL save, taken before and after a
// harness run, so "the harness never touched the real save" is an automated
// assertion instead of a promise.
//
// This is the one place in the editor that reads a path under saves/. It was
// approved by the owner (2026-10-18) for this purpose only. It uses node:fs
// directly and deliberately does NOT go through repo.resolveReadPath, whose
// touchesSaves() guard stays as strict as ever for everything else. It never
// opens the file for writing and never lists or touches other save files.

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
