// Runs one .mewtest plan: preflight, lock, spawn the game (or the fake game),
// wait with a backstop, then assemble a report from the JSONL result, the
// three logs and the safety checks. One game instance at a time (lock file).
//
// Writes only under the runs dir (default editor/data/ingame-runs/, git-ignored).

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DATA_CACHE_DIR } from "../repo.ts";
import { locateGameDir, preflight, buildLaunch, LaunchError } from "./launch.ts";
import { parseResults } from "./results.ts";
import { collectLogs, locateAppdataLogsDir, readWindow } from "./logs.ts";
import { snapshotFile, compareSnapshots, realSavePath, realSavesDir, snapshotSaves, compareSaveSets, devSavePattern } from "./savecheck.ts";

export const RUNS_DIR = join(DATA_CACHE_DIR, "ingame-runs");
export const BACKSTOP_GRACE_MS = 45000;
/** after the harness wrote its end record the verdict is on disk; a game that still lingers this long is killed
 *  (above the DLL's own 3 s clean-exit grace, so the DLL normally wins and this is the fallback) */
export const END_GRACE_MS = 5000;
export const LOCK_FILE = ".lock";
const TAIL_CHARS = 2000;

/**
 * @typedef {'pass'|'fail'|'timeout'|'crash'|'harness-error'|'backstop-timeout'|'launch-error'
 *   |'cannot-run'|'skipped'|'no-result'|'log-errors'|'safety-violation'|'unknown-build'} Verdict
 */
/**
 * @typedef {Object} IngameReport
 * @property {boolean} ok
 * @property {Verdict} verdict
 * @property {string} reason
 * @property {number|null} code
 * @property {string|null} signal
 * @property {boolean} killedAfterEnd  the game lingered after writing its end record and was killed after END_GRACE_MS
 * @property {{ mod: string, name: string, scriptPath: string|null, inline: boolean }} test
 * @property {{ mods: string[], savesuffix: string, timeoutMs: number, hide: boolean, clean: boolean, directives: number, warnings: any[] }} plan
 * @property {import("./launch.ts").Preflight} preflight
 * @property {{ command: string, args: string[], cwd: string, gameDir: string, fake: boolean } | null} launch
 * @property {string} startedAt
 * @property {string} endedAt
 * @property {number} durationMs
 * @property {import("./results.ts").ResultSummary} result
 * @property {import("./logs.ts").LogFindings | null} logFindings
 * @property {{ expectedSuffix: string, observedSuffix: string|null, saveSuffixOk: boolean, saveSuffixReason?: string, modPathsObserved: string[], saveCheck: null | { path: string, unchanged: boolean, matchesKnownBaseline: boolean, detail: string, before: any, after: any }, saveSet: null | { dir: string, unchanged: boolean, changed: string[], detail: string, files: number, skipped: string[] } }} safety
 * @property {{ runDir: string|null, script: string|null, resultFile: string|null, debugLog: string|null, frameworkLogWindow: string|null, chainloaderLog: string|null, report: string|null }} artifacts
 * @property {string} stdoutTail
 * @property {string} stderrTail
 */

/**
 * @param {string} mod @param {string} name @param {number} nowMs
 */
export function runDirName(mod, name, nowMs) {
  const d = new Date(nowMs);
  const p = (/** @type {number} */ n) => String(n).padStart(2, "0");
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  const safe = (/** @type {string} */ s) => s.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40) || "x";
  return `${stamp}-${safe(mod)}-${safe(name)}`;
}

/**
 * The run dir for this launch: runDirName, or the first free "-2", "-3", … variant when a run of the same test
 * started in the same second (a reused dir would hand the new run the previous result.jsonl).
 * @param {string} runsDir @param {string} mod @param {string} name @param {number} nowMs
 */
export function uniqueRunDir(runsDir, mod, name, nowMs) {
  const base = join(runsDir, runDirName(mod, name, nowMs));
  let dir = base;
  for (let n = 2; existsSync(dir); n++) dir = `${base}-${n}`;
  return dir;
}

/** @param {number} pid */
function pidAlive(pid) {
  try {
    return process.kill(pid, 0);
  } catch (e) {
    return /** @type {any} */ (e)?.code === "EPERM";
  }
}

/**
 * Pid-file lock so only one game runs at a time. A lock whose pid is dead is reclaimed.
 * @param {string} runsDir
 * @returns {{ ok: true, release: () => void } | { ok: false, pid: number }}
 */
export function acquireLock(runsDir) {
  mkdirSync(runsDir, { recursive: true });
  const lockPath = join(runsDir, LOCK_FILE);
  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(lockPath, "utf8").trim());
    if (Number.isFinite(pid) && pid > 0 && pidAlive(pid)) return { ok: false, pid };
    rmSync(lockPath, { force: true });
  }
  writeFileSync(lockPath, String(process.pid));
  return { ok: true, release: () => rmSync(lockPath, { force: true }) };
}

/**
 * Pure verdict from the collected evidence. First match wins; see docs/ingame-testing.md.
 * @param {{ preflight: import("./launch.ts").Preflight, launchError?: string|null, exit: { code: number|null, signal: string|null, backstop: boolean }, result: import("./results.ts").ResultSummary, logs: any, safety: { saveSuffixOk: boolean, saveSuffixReason?: string, saveCheck: null | { unchanged: boolean, detail?: string }, saveSet?: null | { unchanged: boolean, detail?: string } } }} input
 * @returns {{ verdict: Verdict, reason: string }}
 */
export function decideVerdict(input) {
  const { preflight: pre, exit, result, logs, safety } = input;
  if (pre.skipped) return { verdict: "skipped", reason: pre.reasons.join("; ") || "skipped" };
  if (!pre.ok) return { verdict: "cannot-run", reason: pre.reasons.join("; ") };
  if (input.launchError) return { verdict: "launch-error", reason: input.launchError };
  const fw = logs && logs.frameworkLog ? logs.frameworkLog : null;
  if (fw && fw.present && fw.unknownBuild) {
    // the game updated: mewframework fails closed and mewtest goes inert (an older harness sits at the
    // menu until the backstop; the current one exits 4). Decided before the backstop so the cause is named.
    const id = fw.identity ? ` (TimeDateStamp ${fw.identity.timeDateStamp}, SizeOfImage ${fw.identity.sizeOfImage})` : "";
    return { verdict: "unknown-build", reason: `mewframework does not know this game build${id}; port the bindings (docs/binding-port.md); data mods still load` };
  }
  if (exit.backstop) return { verdict: "backstop-timeout", reason: "the game did not exit by the script timeout plus the backstop grace; killed" };
  if (!safety.saveSuffixOk) return { verdict: "safety-violation", reason: safety.saveSuffixReason || "save suffix mismatch" };
  if (safety.saveCheck && !safety.saveCheck.unchanged) return { verdict: "safety-violation", reason: `real save changed: ${safety.saveCheck.detail || ""}` };
  if (safety.saveSet && !safety.saveSet.unchanged) return { verdict: "safety-violation", reason: `a real save file changed: ${safety.saveSet.detail || ""}` };
  const code = exit.code;
  const crashReports = logs && Array.isArray(logs.crashReports) ? logs.crashReports : [];
  if (result.crash) return { verdict: "crash", reason: `crash ${result.crash.code || ""} at ${result.crash.module || "?"}+${result.crash.rva || "?"}` };
  if (code === 3 || (result.end && result.end.code === 3)) return { verdict: "crash", reason: code === 3 ? "harness exit code 3 (crash)" : `end code 3 (${result.end && result.end.reason})` };
  if (crashReports.length) return { verdict: "crash", reason: `crash report(s) written: ${crashReports.join(", ")}` };
  if (code !== null && code !== 0 && code > 255) return { verdict: "crash", reason: `abnormal exit code ${code} (0x${(code >>> 0).toString(16)})` };
  if (code !== null && code < 0) return { verdict: "crash", reason: `abnormal exit code ${code} (0x${(code >>> 0).toString(16)})` };
  if (code === 4 || result.scriptError || (result.end && result.end.code === 4)) {
    const fwInactive = fw && fw.present && !fw.active;
    const sigs = fw && Array.isArray(fw.signatureFailures) ? fw.signatureFailures : [];
    const detail = result.scriptError
      ? `script error at line ${result.scriptError.line}: ${result.scriptError.msg}`
      : fwInactive && sigs.length
        ? `mewframework inactive: signature ${sigs.map((/** @type {{ name: string, matches: number }} */ s) => `${s.name} (${s.matches} matches)`).join(", ")} failed on build ${fw.build || "?"}; re-derive with tools/bindings/make-signature.ts`
        : fwInactive
          ? "mewframework inactive (see mod_logs/mewframework.log)"
          : (result.end && result.end.reason) || "harness error";
    return { verdict: "harness-error", reason: detail };
  }
  if (code === 2 || (result.end && result.end.reason === "timeout")) return { verdict: "timeout", reason: `script timeout (end reason ${result.end ? result.end.reason : "?"})` };
  if (code === 1 || result.expects.failed > 0 || (result.end && result.end.code === 1)) {
    const f = result.expects.failures[0];
    return { verdict: "fail", reason: f ? `expect ${f.kind} failed at line ${f.line}: ${f.detail}` : "harness exit code 1" };
  }
  // clean mode: the process exit code is the game's own (or null after the end-grace kill); the end record is authoritative
  if (result.end && typeof result.end.code === "number" && result.end.code !== 0 && (code === null || code === 0)) {
    return { verdict: "fail", reason: `end code ${result.end.code} (${result.end.reason || "?"}); process exit code ${code === null ? "unavailable" : code}` };
  }
  if (!result.present) return { verdict: "no-result", reason: "no result file was written" };
  if (!result.end) return { verdict: "no-result", reason: result.truncated ? "result file truncated (no end event)" : "result file has no end event" };
  if (logs && logs.debugLog && logs.debugLog.findings.length) {
    const f = logs.debugLog.findings[0];
    return { verdict: "log-errors", reason: `${logs.debugLog.findings.length} debug.log marker(s), first: ${f.marker} at line ${f.line}` };
  }
  if (code !== 0 && code !== null) return { verdict: "fail", reason: `exit code ${code}` };
  return { verdict: "pass", reason: `all ${result.expects.passed} expectation(s) passed` };
}

/** @param {string} p */
function sizeOf(p) {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

/**
 * @param {{ plan: import("./script.ts").Plan, test: { mod: string, name: string, scriptPath: string|null },
 *   env?: Record<string, string|undefined>, gameDir?: string, appdataLogsDir?: string|null, modsDir?: string,
 *   runsDir?: string, saveCheck?: boolean, realSavePath?: string|null, realSavesDir?: string|null, backstopGraceMs?: number, endGraceMs?: number,
 *   exists?: (p: string) => boolean, steamRunning?: () => boolean|null }} args
 * @returns {Promise<IngameReport>}
 */
export async function runPlan(args) {
  const env = args.env || process.env;
  const plan = args.plan;
  const gameDir = args.gameDir || locateGameDir(env);
  const appdataLogsDir = args.appdataLogsDir !== undefined ? args.appdataLogsDir : locateAppdataLogsDir(env);
  const runsDir = args.runsDir || (env.MEWTEST_RESULTS_DIR ? String(env.MEWTEST_RESULTS_DIR) : RUNS_DIR);
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const expectedSuffix = plan.savesuffix;

  /** @type {IngameReport} */
  const report = {
    ok: false,
    verdict: "cannot-run",
    reason: "",
    code: null,
    signal: null,
    killedAfterEnd: false,
    test: { mod: args.test.mod, name: args.test.name, scriptPath: args.test.scriptPath, inline: !args.test.scriptPath },
    plan: { mods: plan.mods, savesuffix: plan.savesuffix, timeoutMs: plan.timeoutMs, hide: plan.hide, clean: plan.clean, directives: plan.directives.length, warnings: plan.warnings },
    preflight: { ok: false, skipped: false, reasons: [], checks: {} },
    launch: null,
    startedAt,
    endedAt: startedAt,
    durationMs: 0,
    result: parseResults(null),
    logFindings: null,
    safety: { expectedSuffix, observedSuffix: null, saveSuffixOk: true, modPathsObserved: [], saveCheck: null, saveSet: null },
    artifacts: { runDir: null, script: null, resultFile: null, debugLog: null, frameworkLogWindow: null, chainloaderLog: null, report: null },
    stdoutTail: "",
    stderrTail: "",
  };
  /** @param {string|null} launchError @param {{ code: number|null, signal: string|null, backstop: boolean, killedAfterEnd?: boolean }} [exit] */
  const finish = (launchError, exit = { code: null, signal: null, backstop: false }) => {
    const v = decideVerdict({ preflight: report.preflight, launchError, exit, result: report.result, logs: report.logFindings, safety: report.safety });
    report.verdict = v.verdict;
    report.killedAfterEnd = !!exit.killedAfterEnd;
    report.reason = v.reason + (exit.killedAfterEnd ? "; the game lingered after its end record and was killed after the end grace" : "");
    report.ok = v.verdict === "pass";
    report.code = exit.code;
    report.signal = exit.signal;
    const endMs = Date.now();
    report.endedAt = new Date(endMs).toISOString();
    report.durationMs = endMs - startedMs;
    if (report.artifacts.runDir) {
      const rp = join(report.artifacts.runDir, "report.json");
      writeFileSync(rp, JSON.stringify(report, null, 2));
      report.artifacts.report = rp;
    }
    return report;
  };

  // 1. plan + preflight
  if (!plan.ok) {
    report.preflight = { ok: true, skipped: false, reasons: [], checks: {} };
    return finish(`script errors: ${plan.errors.map((e) => `line ${e.line}: ${e.message}`).join("; ")}`);
  }
  report.preflight = preflight(plan, { gameDir, env, exists: args.exists, steamRunning: args.steamRunning, modsDir: args.modsDir, appdataLogsDir });
  if (!report.preflight.ok) return finish(null);

  // 2. lock + run dir
  const lock = acquireLock(runsDir);
  if (!lock.ok) {
    report.preflight = { ...report.preflight, ok: false, reasons: [`another in-game run is in progress (pid ${lock.pid}); lock ${join(runsDir, LOCK_FILE)}`] };
    return finish(null);
  }
  try {
    const runDir = uniqueRunDir(runsDir, args.test.mod, args.test.name, startedMs);
    mkdirSync(runDir, { recursive: true });
    const scriptPath = join(runDir, "script.mewtest");
    const outPath = join(runDir, "result.jsonl");
    writeFileSync(scriptPath, plan.body);
    report.artifacts.runDir = runDir;
    report.artifacts.script = scriptPath;

    // 3. launch spec
    let launch;
    try {
      launch = buildLaunch(plan, { gameDir, scriptPath, outPath, env, modsDir: args.modsDir });
    } catch (e) {
      return finish(e instanceof LaunchError ? e.message : String(e));
    }
    report.launch = { command: launch.command, args: launch.args, cwd: launch.cwd, gameDir, fake: launch.fake };

    // 4. pre-run snapshots
    const frameworkLogPath = join(gameDir, "mod_logs", "mewframework.log");
    const frameworkLogOffset = sizeOf(frameworkLogPath);
    const saveCheckEnabled = args.saveCheck !== false && env.MEWTEST_SAVECHECK !== "0";
    const savePath = args.realSavePath !== undefined ? args.realSavePath : realSavePath(env);
    const saveBefore = saveCheckEnabled && savePath ? snapshotFile(savePath) : null;
    const savesDir = args.realSavesDir !== undefined ? args.realSavesDir : realSavesDir(env);
    const allow = devSavePattern(expectedSuffix);
    const setBefore = saveCheckEnabled && savesDir ? snapshotSaves(savesDir, { allow }) : null;

    // 5. spawn + wait (backstop kill)
    const launchedAtMs = Date.now();
    const exit = await new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let backstop = false;
      let killedAfterEnd = false;
      const child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const grace = args.backstopGraceMs !== undefined ? args.backstopGraceMs : BACKSTOP_GRACE_MS;
      const endGrace = args.endGraceMs !== undefined ? args.endGraceMs : END_GRACE_MS;
      // the harness flushes every record; once `end` is on disk the verdict exists and only the process lifetime is
      // open. Clean mode relies on this: the game may shut itself down (any exit code), or never exit -> kill it.
      /** @type {ReturnType<typeof setTimeout>|null} */
      let endTimer = null;
      const poll = setInterval(() => {
        if (endTimer || settled) return;
        let seen = false;
        try { seen = existsSync(outPath) && !!parseResults(readFileSync(outPath, "utf8")).end; } catch { seen = false; }
        if (!seen) return;
        endTimer = setTimeout(() => {
          if (settled) return;
          killedAfterEnd = true;
          try { child.kill(); } catch { /* already gone */ }
        }, endGrace);
      }, 250);
      const timer = setTimeout(() => {
        backstop = true;
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }, plan.timeoutMs + grace);
      child.stdout.on("data", (/** @type {any} */ c) => { stdout = (stdout + c.toString("utf8")).slice(-TAIL_CHARS); });
      child.stderr.on("data", (/** @type {any} */ c) => { stderr = (stderr + c.toString("utf8")).slice(-TAIL_CHARS); });
      /** @param {number|null} code @param {string|null} signal @param {string|null} err */
      const done = (code, signal, err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        if (endTimer) clearTimeout(endTimer);
        resolve({ code, signal, backstop, killedAfterEnd, stdout, stderr, err });
      };
      child.on("error", (/** @type {any} */ e) => done(null, null, String(e && e.message ? e.message : e)));
      child.on("exit", (/** @type {any} */ code, /** @type {any} */ signal) => done(typeof code === "number" ? code : null, signal || null, null));
    });
    report.stdoutTail = exit.stdout;
    report.stderrTail = exit.stderr;

    // 6. evidence
    report.result = parseResults(existsSync(outPath) ? readFileSync(outPath, "utf8") : null);
    report.artifacts.resultFile = existsSync(outPath) ? outPath : null;
    const logs = collectLogs({ gameDir, appdataLogsDir, frameworkLogOffset, launchedAtMs, expectedSuffix });
    report.logFindings = logs;
    const saveAfter = saveBefore && savePath ? snapshotFile(savePath) : null;
    const setAfter = setBefore && savesDir ? snapshotSaves(savesDir, { allow }) : null;
    report.safety = {
      expectedSuffix,
      observedSuffix: logs.debugLog.saveSuffix,
      saveSuffixOk: logs.saveSuffix.ok,
      saveSuffixReason: logs.saveSuffix.reason,
      modPathsObserved: logs.debugLog.modPaths,
      saveCheck: saveBefore && saveAfter && savePath ? { path: savePath, ...compareSnapshots(saveBefore, saveAfter), before: saveBefore, after: saveAfter } : null,
      saveSet: setBefore && setAfter && savesDir ? { dir: savesDir, ...compareSaveSets(setBefore, setAfter), files: setAfter.files.length, skipped: setAfter.skipped } : null,
    };
    // copies for the record
    if (logs.debugLog.path && logs.debugLog.present) {
      const dst = join(runDir, "debug.log");
      copyFileSync(logs.debugLog.path, dst);
      report.artifacts.debugLog = dst;
    }
    const fwWindow = readWindow(frameworkLogPath, frameworkLogOffset);
    if (fwWindow !== null) {
      const dst = join(runDir, "mewframework.window.log");
      writeFileSync(dst, fwWindow);
      report.artifacts.frameworkLogWindow = dst;
    }
    if (logs.chainloaderLog.present) {
      const dst = join(runDir, "chainloader.log");
      copyFileSync(logs.chainloaderLog.path, dst);
      report.artifacts.chainloaderLog = dst;
    }
    return finish(exit.err ? `spawn failed: ${exit.err}` : null, { code: exit.code, signal: exit.signal, backstop: exit.backstop, killedAfterEnd: exit.killedAfterEnd });
  } finally {
    lock.release();
  }
}
