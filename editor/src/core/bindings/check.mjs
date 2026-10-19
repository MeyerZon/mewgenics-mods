// Build check: is this exe a build the manifests know, and does every signature still hold?
// checkBuild is pure over bytes + manifests; checkInstalledBuild adds the file read. This is
// what the check_game_build MCP tool, tools/bindings/check-build.mjs and the validator's
// native-build warning use. It never writes and never launches anything.

import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parsePe, PeError } from "./pe.mjs";
import { parsePattern, scanExec } from "./scan.mjs";
import { listManifests, hex } from "./manifest.mjs";
import { locateGameDir } from "../ingame/launch.mjs";

/**
 * @typedef {"ok"|"moved"|"missing"|"ambiguous"} EntryStatus
 * @typedef {{ name: string, kind: string, status: EntryStatus, matches: number, hit: string|null, expected: string, offset: number, detail?: string }} CheckEntry
 * @typedef {{
 *   known: boolean,
 *   build: { timeDateStamp: string, sizeOfImage: string, imageBase: string, exeSize: number,
 *            matched: { steamBuildId: string, name: string, gameVersion: string }|null,
 *            scannedWith: string|null,
 *            knownBuilds: { steamBuildId: string, name: string, timeDateStamp: string, sizeOfImage: string }[] },
 *   entries: CheckEntry[],
 *   summary: { total: number, ok: number, moved: number, missing: number, ambiguous: number, unscanned: number },
 * }} BuildCheck
 */

/**
 * @param {Buffer} buf  the exe bytes
 * @param {import("./manifest.mjs").Manifest[]} manifests
 * @returns {BuildCheck}
 */
export function checkBuild(buf, manifests) {
  const pe = parsePe(buf);
  const ts = pe.timeDateStamp;
  const size = pe.sizeOfImage;
  const matched = manifests.find((m) => parseInt(m.build.timeDateStamp, 16) === ts && parseInt(m.build.sizeOfImage, 16) === size) || null;
  const newest = [...manifests].sort((a, b) => Number(b.build.steamBuildId) - Number(a.build.steamBuildId))[0] || null;
  // on an unknown build, scan with the newest manifest: "how much survived" is the first porting signal
  const scanWith = matched || newest;
  /** @type {CheckEntry[]} */
  const entries = [];
  const summary = { total: 0, ok: 0, moved: 0, missing: 0, ambiguous: 0, unscanned: 0 };
  if (scanWith) {
    for (const e of scanWith.entries) {
      summary.total++;
      if (e.kind !== "function" || !e.signature) { summary.unscanned++; continue; }
      const expected = parseInt(e.rva || "0", 16);
      /** @type {import("./scan.mjs").Pattern} */
      let pat;
      try {
        pat = parsePattern(e.signature.pattern, scanWith.sigCap);
      } catch (err) {
        entries.push({ name: e.name, kind: e.kind, status: "missing", matches: 0, hit: null, expected: hex(expected), offset: e.signature.offset, detail: `pattern does not parse: ${err instanceof Error ? err.message : String(err)}` });
        summary.missing++;
        continue;
      }
      const r = scanExec(pe, buf, pat);
      const hit = r.count >= 1 ? r.hits[0] + e.signature.offset : null;
      /** @type {EntryStatus} */
      const status = r.count === 0 ? "missing" : r.count > 1 ? "ambiguous" : hit === expected ? "ok" : "moved";
      entries.push({ name: e.name, kind: e.kind, status, matches: r.count, hit: hit === null ? null : hex(hit), expected: hex(expected), offset: e.signature.offset });
      summary[status]++;
    }
  }
  return {
    known: matched !== null,
    build: {
      timeDateStamp: hex(ts),
      sizeOfImage: hex(size),
      imageBase: hex(pe.imageBase),
      exeSize: buf.length,
      matched: matched ? { steamBuildId: matched.build.steamBuildId, name: matched.build.name, gameVersion: matched.build.gameVersion } : null,
      scannedWith: scanWith ? scanWith.build.steamBuildId : null,
      knownBuilds: manifests.map((m) => ({ steamBuildId: m.build.steamBuildId, name: m.build.name, timeDateStamp: m.build.timeDateStamp, sizeOfImage: m.build.sizeOfImage })),
    },
    entries,
    summary,
  };
}

/**
 * @typedef {{ known: boolean, identity: { timeDateStamp: string, sizeOfImage: string }, matched: { steamBuildId: string, name: string }|null, exePath: string }} ExeIdentity
 */

/** @type {Map<string, ExeIdentity>} */
const identityCache = new Map();

/**
 * Identity only, from the PE headers (first 64 KB), memoized per path + mtime + manifest set.
 * This is the validator's fast path: it never reads the whole exe and never scans.
 * @param {string} path
 * @param {import("./manifest.mjs").Manifest[]} manifests
 * @returns {ExeIdentity|null} null when the file is absent or not a PE image
 */
export function identifyExe(path, manifests) {
  if (!existsSync(path)) return null;
  const st = statSync(path);
  const key = `${path}|${st.mtimeMs}|${st.size}|${manifests.map((m) => m.build.steamBuildId).join(",")}`;
  const hit = identityCache.get(key);
  if (hit) return hit;
  const head = Buffer.alloc(Math.min(65536, st.size));
  const fd = openSync(path, "r");
  try {
    readSync(fd, head, 0, head.length, 0);
  } finally {
    closeSync(fd);
  }
  /** @type {import("./pe.mjs").Pe} */
  let pe;
  try {
    pe = parsePe(head);
  } catch (e) {
    if (e instanceof PeError) return null;
    throw e;
  }
  const matched = manifests.find((m) => parseInt(m.build.timeDateStamp, 16) === pe.timeDateStamp && parseInt(m.build.sizeOfImage, 16) === pe.sizeOfImage) || null;
  const r = {
    known: matched !== null,
    identity: { timeDateStamp: hex(pe.timeDateStamp), sizeOfImage: hex(pe.sizeOfImage) },
    matched: matched ? { steamBuildId: matched.build.steamBuildId, name: matched.build.name } : null,
    exePath: path,
  };
  identityCache.set(key, r);
  return r;
}

/**
 * @typedef {({ ok: true, exePath: string, sha256: string } & BuildCheck) | { ok: false, skipped: boolean, reason: string, exePath: string }} InstalledCheck
 */

/**
 * Check the installed game (or an explicit exe). Read-only. Returns ok:false + skipped when the
 * exe or the manifests are absent, so callers can log "(skipped: …)" instead of failing.
 * @param {{ env?: Record<string, string|undefined>, gameDir?: string, exePath?: string, manifests?: import("./manifest.mjs").Manifest[] }} [opts]
 * @returns {InstalledCheck}
 */
export function checkInstalledBuild(opts = {}) {
  const env = opts.env || process.env;
  const path = opts.exePath || join(opts.gameDir || locateGameDir(env), "Mewgenics.exe");
  if (!existsSync(path)) return { ok: false, skipped: true, reason: `Mewgenics.exe not found: ${path} (set MEWGENICS_DIR or pass exe)`, exePath: path };
  const manifests = opts.manifests || listManifests().map((x) => x.manifest);
  if (manifests.length === 0) return { ok: false, skipped: true, reason: "no bindings/<build>.json manifests found", exePath: path };
  const buf = readFileSync(path);
  try {
    const r = checkBuild(buf, manifests);
    return { ok: true, exePath: path, sha256: createHash("sha256").update(buf).digest("hex"), ...r };
  } catch (e) {
    if (e instanceof PeError) return { ok: false, skipped: false, reason: `not a PE32+ image: ${e.message}`, exePath: path };
    throw e;
  }
}
