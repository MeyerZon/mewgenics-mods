// Scanners for the three logs a harness run leaves behind:
//   <appdata>/<steamid>/logs/debug.log   the game's own log (overwritten per launch)
//   <gamedir>/mod_logs/mewframework.log  the framework (append mode -> window by offset)
//   <gamedir>/mod_logs/chainloader.log   Mewjector (truncated per launch)
// Pure scanners take text; collectLogs() does the reading. Nothing here ever
// looks under a saves/ directory.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Known failure markers in debug.log (see docs/engine-map.md, docs/automation-feasibility.md). */
export const DEBUG_MARKERS: { marker: string; re: RegExp }[] = [
  { marker: "NO_STATUS_NAMED", re: /NO[_ ]STATUS[_ ]NAMED/i },
  { marker: "NO_BRAIN_NAMED", re: /NO[_ ]BRAIN[_ ]NAMED/i },
  { marker: "NO_ABILITY_NAMED", re: /NO[_ ]ABILITY[_ ]NAMED/i },
  { marker: "NO_PASSIVE_NAMED", re: /NO[_ ]PASSIVE[_ ]NAMED/i },
  { marker: "No level named", re: /No level named/ },
  { marker: "No enemy named", re: /No enemy named/ },
  { marker: "GON_ERROR", re: /GON_ERROR:/ },
];

const PREFIX_RE = /^\[file: [^\]]*\]\s*/;

export interface DebugFinding {
  marker: string;
  line: number;
  text: string;
}

export interface DebugScan {
  findings: DebugFinding[];
  saveSuffix: string | null;
  modPaths: string[];
}

/** debug.log lines with the `[file: …; line: N;]` prefix stripped and trimmed (index = line number - 1). */
export function debugLogMessages(text: string): string[] {
  return String(text).split(/\r?\n/).map((l) => l.replace(PREFIX_RE, "").trim());
}

export interface LogExpect {
  line: number;
  substr: string;
  ok: boolean;
  detail: string;
}

/**
 * Runner-side `expect log "<substr>"`: each substring must occur in some debug.log message (prefix stripped).
 * Pure; `text` null means the log was not found.
 */
export function checkLogExpects(text: string | null, expects: { line: number; substr: string }[]): LogExpect[] {
  const msgs = text === null ? null : debugLogMessages(text);
  return expects.map(({ line, substr }) => {
    if (msgs === null) return { line, substr, ok: false, detail: "debug.log absent" };
    const i = msgs.findIndex((m) => m.includes(substr));
    return i >= 0 ? { line, substr, ok: true, detail: `matched debug.log line ${i + 1}` } : { line, substr, ok: false, detail: "not found in debug.log" };
  });
}

export function scanDebugLog(text: string): DebugScan {
  const findings: DebugFinding[] = [];
  let saveSuffix: string | null = null;
  const modPaths: string[] = [];
  const lines = debugLogMessages(text);
  for (let i = 0; i < lines.length; i++) {
    const msg = lines[i]!;
    if (!msg) continue;
    const s = /^Save File Suffix:\s*(.*)$/.exec(msg);
    if (s) { saveSuffix = s[1]!.trim(); continue; }
    const m = /^Mod Path:\s*(.*)$/.exec(msg);
    if (m) { modPaths.push(m[1]!.trim()); continue; }
    for (const { marker, re } of DEBUG_MARKERS) {
      if (re.test(msg)) { findings.push({ marker, line: i + 1, text: msg }); break; }
    }
  }
  return { findings, saveSuffix, modPaths };
}

export interface SaveSuffixCheck {
  ok: boolean;
  reason?: string;
}

export function checkSaveSuffix(observed: string | null | undefined, expected: string): SaveSuffixCheck {
  if (observed === null || observed === undefined) return { ok: false, reason: `"Save File Suffix:" line missing from debug.log (expected "${expected}")` };
  if (observed !== expected) return { ok: false, reason: `game reported save suffix "${observed}", expected "${expected}"` };
  return { ok: true };
}

export interface BuildIdentity {
  timeDateStamp: string;
  sizeOfImage: string;
}

export interface SignatureFailure {
  name: string;
  matches: number;
}

export interface FrameworkScan {
  active: boolean;
  symbols: number | null;
  hooks: string[];
  unknownBuild: boolean;
  /** the PE identity printed on an "unknown build:" line */
  identity: BuildIdentity | null;
  /** every "signature X: N matches (need exactly 1)" line (a known build whose bytes changed) */
  signatureFailures: SignatureFailure[];
  sessions: number;
  build: string | null;
  version: string | null;
}

/**
 * Parse mewframework.log text. When the text holds several sessions (append
 * mode, no window offset known) the LAST session is reported.
 */
export function scanFrameworkLog(text: string): FrameworkScan {
  const lines = String(text).split(/\r?\n/);
  const starts: number[] = [];
  lines.forEach((l, i) => { if (/^mewframework \S+ starting/.test(l)) starts.push(i); });
  const from = starts.length ? starts[starts.length - 1]! : 0;
  const session = lines.slice(from);
  let active = false;
  let symbols: number | null = null;
  const hooks: string[] = [];
  let unknownBuild = false;
  let identity: BuildIdentity | null = null;
  const signatureFailures: SignatureFailure[] = [];
  let build: string | null = null;
  let version: string | null = null;
  for (const l of session) {
    let m: RegExpExecArray | null;
    if ((m = /^mewframework (\S+) starting/.exec(l))) version = m[1]!;
    else if ((m = /^framework active: (\d+) symbols/.exec(l))) { active = true; symbols = Number(m[1]); }
    else if ((m = /^hook installed: (.+?) rva/.exec(l))) hooks.push(m[1]!);
    else if ((m = /^unknown build: TimeDateStamp=(0x[0-9a-fA-F]+) SizeOfImage=(0x[0-9a-fA-F]+)/.exec(l))) { unknownBuild = true; identity = { timeDateStamp: m[1]!, sizeOfImage: m[2]! }; }
    else if (/^unknown build/.test(l)) unknownBuild = true;
    else if ((m = /^signature (\S+): (\d+) matches/.exec(l))) signatureFailures.push({ name: m[1]!, matches: Number(m[2]) });
    else if ((m = /^build (.+?) recognized/.exec(l))) build = m[1]!;
  }
  return { active, symbols, hooks, unknownBuild, identity, signatureFailures, sessions: starts.length, build, version };
}

export interface ChainloaderScan {
  modsLoaded: string[];
  crashLines: string[];
}

export function scanChainloaderLog(text: string): ChainloaderScan {
  const modsLoaded: string[] = [];
  const crashLines: string[] = [];
  for (const l of String(text).split(/\r?\n/)) {
    const m = /Loading: (\S+\.dll)/i.exec(l);
    if (m) modsLoaded.push(m[1]!);
    if (/fatal=1|Report written|Minidump written|crash report/i.test(l)) crashLines.push(l.trim());
  }
  return { modsLoaded, crashLines };
}

/** Read a file from a byte offset (for append-mode logs). null if missing. */
export function readWindow(path: string, fromOffset: number): string | null {
  if (!existsSync(path)) return null;
  const buf = readFileSync(path);
  const off = Math.max(0, Math.min(fromOffset | 0, buf.length));
  return buf.toString("utf8", off);
}

/**
 * %APPDATA%\Glaiel Games\Mewgenics\<steamid>\logs when exactly one steamid dir exists.
 * Never descends into saves/.
 */
export function locateAppdataLogsDir(env: Record<string, string | undefined>): string | null {
  if (!env.APPDATA) return null;
  const base = join(env.APPDATA, "Glaiel Games", "Mewgenics");
  if (!existsSync(base)) return null;
  const ids = readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
    .map((d) => d.name);
  if (ids.length !== 1) return null;
  const logs = join(base, ids[0]!, "logs");
  return existsSync(logs) ? logs : null;
}

function mtimeOf(p: string): number | null {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

export interface LogFindings {
  debugLog: { path: string | null; present: boolean; fresh: boolean; findings: DebugFinding[]; saveSuffix: string | null; modPaths: string[] };
  frameworkLog: {
    path: string;
    present: boolean;
    windowOffset: number;
    active: boolean;
    symbols: number | null;
    hooks: string[];
    unknownBuild: boolean;
    identity: BuildIdentity | null;
    signatureFailures: SignatureFailure[];
    build: string | null;
    version: string | null;
  };
  chainloaderLog: { path: string; present: boolean; fresh: boolean; modsLoaded: string[]; crashLines: string[] };
  /** crash files newer than the launch */
  crashReports: string[];
  saveSuffix: SaveSuffixCheck;
}

export interface CollectLogsContext {
  gameDir: string;
  appdataLogsDir: string | null;
  frameworkLogOffset: number;
  launchedAtMs: number;
  expectedSuffix: string;
}

export function collectLogs(ctx: CollectLogsContext): LogFindings {
  const slack = 1000; // filesystem mtime granularity
  const since = ctx.launchedAtMs - slack;

  const debugPath = ctx.appdataLogsDir ? join(ctx.appdataLogsDir, "debug.log") : null;
  const debugText = debugPath && existsSync(debugPath) ? readFileSync(debugPath, "utf8") : null;
  const debugM = debugPath ? mtimeOf(debugPath) : null;
  const dbg: DebugScan = debugText !== null ? scanDebugLog(debugText) : { findings: [], saveSuffix: null, modPaths: [] };

  const fwPath = join(ctx.gameDir, "mod_logs", "mewframework.log");
  const fwText = readWindow(fwPath, ctx.frameworkLogOffset);
  const fw: FrameworkScan = fwText !== null ? scanFrameworkLog(fwText) : { active: false, symbols: null, hooks: [], unknownBuild: false, identity: null, signatureFailures: [], build: null, version: null, sessions: 0 };

  const clPath = join(ctx.gameDir, "mod_logs", "chainloader.log");
  const clText = existsSync(clPath) ? readFileSync(clPath, "utf8") : null;
  const clM = mtimeOf(clPath);
  const cl: ChainloaderScan = clText !== null ? scanChainloaderLog(clText) : { modsLoaded: [], crashLines: [] };

  const crashReports: string[] = [];
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
    frameworkLog: { path: fwPath, present: fwText !== null, windowOffset: ctx.frameworkLogOffset, active: fw.active, symbols: fw.symbols, hooks: fw.hooks, unknownBuild: fw.unknownBuild, identity: fw.identity, signatureFailures: fw.signatureFailures, build: fw.build, version: fw.version },
    chainloaderLog: { path: clPath, present: clText !== null, fresh: clM !== null && clM >= since, modsLoaded: cl.modsLoaded, crashLines: cl.crashLines },
    crashReports,
    saveSuffix: checkSaveSuffix(dbg.saveSuffix, ctx.expectedSuffix),
  };
}
