// Scanners for the three logs a harness run leaves behind:
//   <appdata>/<steamid>/logs/debug.log   the game's own log (overwritten per launch)
//   <gamedir>/mod_logs/mewframework.log  the framework (append mode -> window by offset)
//   <gamedir>/mod_logs/chainloader.log   Mewjector (truncated per launch)
// Pure scanners take text; collectLogs() does the reading. Nothing here ever
// looks under a saves/ directory.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Known failure markers in debug.log (see docs/engine-map.md, docs/automation-feasibility.md). */
export const DEBUG_MARKERS = [
  { marker: "NO_STATUS_NAMED", re: /NO[_ ]STATUS[_ ]NAMED/i },
  { marker: "NO_BRAIN_NAMED", re: /NO[_ ]BRAIN[_ ]NAMED/i },
  { marker: "NO_ABILITY_NAMED", re: /NO[_ ]ABILITY[_ ]NAMED/i },
  { marker: "NO_PASSIVE_NAMED", re: /NO[_ ]PASSIVE[_ ]NAMED/i },
  { marker: "No level named", re: /No level named/ },
  { marker: "No enemy named", re: /No enemy named/ },
  { marker: "GON_ERROR", re: /GON_ERROR:/ },
];

const PREFIX_RE = /^\[file: [^\]]*\]\s*/;

/**
 * @param {string} text
 * @returns {{ findings: Array<{ marker: string, line: number, text: string }>, saveSuffix: string|null, modPaths: string[] }}
 */
export function scanDebugLog(text) {
  /** @type {Array<{ marker: string, line: number, text: string }>} */
  const findings = [];
  /** @type {string|null} */
  let saveSuffix = null;
  /** @type {string[]} */
  const modPaths = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const msg = lines[i].replace(PREFIX_RE, "").trim();
    if (!msg) continue;
    const s = /^Save File Suffix:\s*(.*)$/.exec(msg);
    if (s) { saveSuffix = s[1].trim(); continue; }
    const m = /^Mod Path:\s*(.*)$/.exec(msg);
    if (m) { modPaths.push(m[1].trim()); continue; }
    for (const { marker, re } of DEBUG_MARKERS) {
      if (re.test(msg)) { findings.push({ marker, line: i + 1, text: msg }); break; }
    }
  }
  return { findings, saveSuffix, modPaths };
}

/**
 * @param {string|null} observed
 * @param {string} expected
 * @returns {{ ok: boolean, reason?: string }}
 */
export function checkSaveSuffix(observed, expected) {
  if (observed === null || observed === undefined) return { ok: false, reason: `"Save File Suffix:" line missing from debug.log (expected "${expected}")` };
  if (observed !== expected) return { ok: false, reason: `game reported save suffix "${observed}", expected "${expected}"` };
  return { ok: true };
}

/**
 * Parse mewframework.log text. When the text holds several sessions (append
 * mode, no window offset known) the LAST session is reported.
 * @param {string} text
 * @returns {{ active: boolean, symbols: number|null, hooks: string[], unknownBuild: boolean, sessions: number, build: string|null, version: string|null }}
 */
export function scanFrameworkLog(text) {
  const lines = String(text).split(/\r?\n/);
  /** @type {number[]} */
  const starts = [];
  lines.forEach((l, i) => { if (/^mewframework \S+ starting/.test(l)) starts.push(i); });
  const from = starts.length ? starts[starts.length - 1] : 0;
  const session = lines.slice(from);
  let active = false;
  /** @type {number|null} */
  let symbols = null;
  /** @type {string[]} */
  const hooks = [];
  let unknownBuild = false;
  /** @type {string|null} */
  let build = null;
  /** @type {string|null} */
  let version = null;
  for (const l of session) {
    let m;
    if ((m = /^mewframework (\S+) starting/.exec(l))) version = m[1];
    else if ((m = /^framework active: (\d+) symbols/.exec(l))) { active = true; symbols = Number(m[1]); }
    else if ((m = /^hook installed: (.+?) rva/.exec(l))) hooks.push(m[1]);
    else if (/^unknown build/.test(l)) unknownBuild = true;
    else if ((m = /^build (.+?) recognized/.exec(l))) build = m[1];
  }
  return { active, symbols, hooks, unknownBuild, sessions: starts.length, build, version };
}

/**
 * @param {string} text
 * @returns {{ modsLoaded: string[], crashLines: string[] }}
 */
export function scanChainloaderLog(text) {
  /** @type {string[]} */
  const modsLoaded = [];
  /** @type {string[]} */
  const crashLines = [];
  for (const l of String(text).split(/\r?\n/)) {
    const m = /Loading: (\S+\.dll)/i.exec(l);
    if (m) modsLoaded.push(m[1]);
    if (/fatal=1|Report written|Minidump written|crash report/i.test(l)) crashLines.push(l.trim());
  }
  return { modsLoaded, crashLines };
}

/**
 * Read a file from a byte offset (for append-mode logs). null if missing.
 * @param {string} path @param {number} fromOffset
 * @returns {string|null}
 */
export function readWindow(path, fromOffset) {
  if (!existsSync(path)) return null;
  const buf = readFileSync(path);
  const off = Math.max(0, Math.min(fromOffset | 0, buf.length));
  return buf.toString("utf8", off);
}

/**
 * %APPDATA%\Glaiel Games\Mewgenics\<steamid>\logs when exactly one steamid dir exists.
 * Never descends into saves/.
 * @param {Record<string, string|undefined>} env
 * @returns {string|null}
 */
export function locateAppdataLogsDir(env) {
  if (!env.APPDATA) return null;
  const base = join(env.APPDATA, "Glaiel Games", "Mewgenics");
  if (!existsSync(base)) return null;
  const ids = readdirSync(base, { withFileTypes: true })
    .filter((/** @type {any} */ d) => d.isDirectory() && /^\d+$/.test(d.name))
    .map((/** @type {any} */ d) => d.name);
  if (ids.length !== 1) return null;
  const logs = join(base, ids[0], "logs");
  return existsSync(logs) ? logs : null;
}

/** @param {string} p */
function mtimeOf(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * @typedef {Object} LogFindings
 * @property {{ path: string|null, present: boolean, fresh: boolean, findings: Array<{marker:string,line:number,text:string}>, saveSuffix: string|null, modPaths: string[] }} debugLog
 * @property {{ path: string, present: boolean, windowOffset: number, active: boolean, symbols: number|null, hooks: string[], unknownBuild: boolean, build: string|null, version: string|null }} frameworkLog
 * @property {{ path: string, present: boolean, fresh: boolean, modsLoaded: string[], crashLines: string[] }} chainloaderLog
 * @property {string[]} crashReports  crash files newer than the launch
 * @property {{ ok: boolean, reason?: string }} saveSuffix
 */

/**
 * @param {{ gameDir: string, appdataLogsDir: string|null, frameworkLogOffset: number, launchedAtMs: number, expectedSuffix: string }} ctx
 * @returns {LogFindings}
 */
export function collectLogs(ctx) {
  const slack = 1000; // filesystem mtime granularity
  const since = ctx.launchedAtMs - slack;

  const debugPath = ctx.appdataLogsDir ? join(ctx.appdataLogsDir, "debug.log") : null;
  const debugText = debugPath && existsSync(debugPath) ? readFileSync(debugPath, "utf8") : null;
  const debugM = debugPath ? mtimeOf(debugPath) : null;
  const dbg = debugText !== null ? scanDebugLog(debugText) : { findings: [], saveSuffix: null, modPaths: [] };

  const fwPath = join(ctx.gameDir, "mod_logs", "mewframework.log");
  const fwText = readWindow(fwPath, ctx.frameworkLogOffset);
  const fw = fwText !== null ? scanFrameworkLog(fwText) : { active: false, symbols: null, hooks: [], unknownBuild: false, build: null, version: null, sessions: 0 };

  const clPath = join(ctx.gameDir, "mod_logs", "chainloader.log");
  const clText = existsSync(clPath) ? readFileSync(clPath, "utf8") : null;
  const clM = mtimeOf(clPath);
  const cl = clText !== null ? scanChainloaderLog(clText) : { modsLoaded: [], crashLines: [] };

  /** @type {string[]} */
  const crashReports = [];
  const crashDir = join(ctx.gameDir, "mod_logs", "crashes");
  if (existsSync(crashDir)) {
    for (const f of readdirSync(crashDir)) {
      const p = join(crashDir, f);
      const m = mtimeOf(p);
      if (m !== null && m >= since) crashReports.push(p);
    }
  }
  if (ctx.appdataLogsDir && existsSync(ctx.appdataLogsDir)) {
    for (const f of readdirSync(ctx.appdataLogsDir)) {
      if (!/^crash_.*\.txt$/i.test(f)) continue;
      const p = join(ctx.appdataLogsDir, f);
      const m = mtimeOf(p);
      if (m !== null && m >= since) crashReports.push(p);
    }
  }

  return {
    debugLog: { path: debugPath, present: debugText !== null, fresh: debugM !== null && debugM >= since, findings: dbg.findings, saveSuffix: dbg.saveSuffix, modPaths: dbg.modPaths },
    frameworkLog: { path: fwPath, present: fwText !== null, windowOffset: ctx.frameworkLogOffset, active: fw.active, symbols: fw.symbols, hooks: fw.hooks, unknownBuild: fw.unknownBuild, build: fw.build, version: fw.version },
    chainloaderLog: { path: clPath, present: clText !== null, fresh: clM !== null && clM >= since, modsLoaded: cl.modsLoaded, crashLines: cl.crashLines },
    crashReports,
    saveSuffix: checkSaveSuffix(dbg.saveSuffix, ctx.expectedSuffix),
  };
}
