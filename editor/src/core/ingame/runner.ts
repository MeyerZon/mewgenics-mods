// Runs one .mewtest plan: preflight, lock, spawn the game (or the fake game),
// wait with a backstop, then assemble a report from the JSONL result, the
// three logs and the safety checks. One game instance at a time (lock file).
//
// Writes only under the runs dir (default editor/data/ingame-runs/, git-ignored).

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DATA_CACHE_DIR } from "../repo.ts";
import { locateGameDir, preflight, buildLaunch, LaunchError, type Preflight, type LaunchSpec, type Env } from "./launch.ts";
import { parseResults, type ResultSummary } from "./results.ts";
import { collectLogs, locateAppdataLogsDir, readWindow, checkLogExpects, type LogFindings, type LogExpect } from "./logs.ts";
import { isRunnerSide } from "./script.ts";
import { captureWindow, type CaptureFn } from "./shot.ts";
import {
  snapshotFile, compareSnapshots, realSavePath, realSavesDir, snapshotSaves, compareSaveSets, devSavePattern,
  resetCampaignSlot, CAMPAIGN_SLOT_FILE, type CampaignSlotReset,
  type SaveSnapshot,
} from "./savecheck.ts";
import type { Plan, Finding } from "./script.ts";

export const RUNS_DIR = join(DATA_CACHE_DIR, "ingame-runs");
export const BACKSTOP_GRACE_MS = 45000;
/** after the harness wrote its end record the verdict is on disk; a game that still lingers this long is killed
 *  (above the DLL's own 3 s clean-exit grace, so the DLL normally wins and this is the fallback) */
export const END_GRACE_MS = 5000;
export const LOCK_FILE = ".lock";
const TAIL_CHARS = 2000;

/** The runner's verdicts (docs/ingame-testing.md "Verdicts"). */
export type Verdict =
  | "pass" | "fail" | "timeout" | "crash" | "harness-error" | "backstop-timeout" | "launch-error"
  | "cannot-run" | "skipped" | "no-result" | "log-errors" | "safety-violation" | "unknown-build";

export interface SaveCheckResult {
  path: string;
  unchanged: boolean;
  matchesKnownBaseline: boolean;
  detail: string;
  before: SaveSnapshot;
  after: SaveSnapshot;
}

export interface SaveSetResult {
  dir: string;
  unchanged: boolean;
  changed: string[];
  detail: string;
  files: number;
  skipped: string[];
}

export interface SafetyReport {
  expectedSuffix: string;
  observedSuffix: string | null;
  saveSuffixOk: boolean;
  saveSuffixReason?: string;
  modPathsObserved: string[];
  saveCheck: SaveCheckResult | null;
  saveSet: SaveSetResult | null;
  /** `enter Campaign` only: the disposable slot was moved aside before the run; `after` says whether the game wrote a new one */
  campaignSlot: (CampaignSlotReset & { after: "present" | "absent" }) | null;
}

export interface IngameReport {
  ok: boolean;
  verdict: Verdict;
  reason: string;
  code: number | null;
  signal: string | null;
  /** the game lingered after writing its end record and was killed after END_GRACE_MS */
  killedAfterEnd: boolean;
  test: { mod: string; name: string; scriptPath: string | null; inline: boolean };
  plan: { mods: string[]; savesuffix: string; timeoutMs: number; hide: boolean; clean: boolean; directives: number; warnings: Finding[] };
  preflight: Preflight;
  launch: { command: string; args: string[]; cwd: string; gameDir: string; fake: boolean } | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  result: ResultSummary;
  logFindings: LogFindings | null;
  /** runner-side `expect log "<substr>"` results (evaluated against debug.log after the run) */
  logExpects: LogExpect[];
  safety: SafetyReport;
  artifacts: {
    runDir: string | null;
    script: string | null;
    resultFile: string | null;
    debugLog: string | null;
    frameworkLogWindow: string | null;
    chainloaderLog: string | null;
    report: string | null;
    /** one entry per `shot` directive: the PNG the runner captured while the DLL held the scene */
    shots: { label: string; line: number; path: string | null; hidden: boolean; note?: string }[];
  };
  stdoutTail: string;
  stderrTail: string;
}

export function runDirName(mod: string, name: string, nowMs: number): string {
  const d = new Date(nowMs);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40) || "x";
  return `${stamp}-${safe(mod)}-${safe(name)}`;
}

/**
 * The run dir for this launch: runDirName, or the first free "-2", "-3", … variant when a run of the same test
 * started in the same second (a reused dir would hand the new run the previous result.jsonl).
 */
export function uniqueRunDir(runsDir: string, mod: string, name: string, nowMs: number): string {
  const base = join(runsDir, runDirName(mod, name, nowMs));
  let dir = base;
  for (let n = 2; existsSync(dir); n++) dir = `${base}-${n}`;
  return dir;
}

function pidAlive(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch (e) {
    return (e as { code?: string })?.code === "EPERM";
  }
}

export type LockResult = { ok: true; release: () => void } | { ok: false; pid: number };

/** Pid-file lock so only one game runs at a time. A lock whose pid is dead is reclaimed. */
export function acquireLock(runsDir: string): LockResult {
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

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  backstop: boolean;
  killedAfterEnd?: boolean;
}

/** What decideVerdict reads from the collected logs (a LogFindings, or any object with these fields). */
export interface VerdictLogs {
  frameworkLog?: { present: boolean; unknownBuild: boolean; identity?: { timeDateStamp: string; sizeOfImage: string } | null; active: boolean; signatureFailures?: { name: string; matches: number }[]; build?: string | null } | null;
  crashReports?: string[];
  debugLog?: { findings: { marker: string; line: number; text: string }[] } | null;
}

export interface VerdictInput {
  preflight: Preflight;
  launchError?: string | null;
  exit: ExitInfo;
  result: ResultSummary;
  logs: VerdictLogs | null | undefined;
  /** runner-side expect log results; a miss is a fail (after log-errors, which names the root cause) */
  logExpects?: LogExpect[];
  safety: {
    saveSuffixOk: boolean;
    saveSuffixReason?: string;
    saveCheck: null | { unchanged: boolean; detail?: string };
    saveSet?: null | { unchanged: boolean; detail?: string };
  };
}

/** Pure verdict from the collected evidence. First match wins; see docs/ingame-testing.md. Dialogs the harness
 * dismissed (`popup` events) never decide the verdict but are appended to the reason, since they usually explain it. */
export function decideVerdict(input: VerdictInput): { verdict: Verdict; reason: string } {
  const v = decideVerdictBase(input);
  const popups = input.result && Array.isArray(input.result.popups) ? input.result.popups : [];
  if (!popups.length) return v;
  if (v.verdict === "pass") return { verdict: v.verdict, reason: `${v.reason}, ${popups.length} popup(s) dismissed` };
  return { verdict: v.verdict, reason: `${v.reason}; popup ${popups.map((p) => `${p.title}: ${p.text}`).join(" | ")}` };
}

function decideVerdictBase(input: VerdictInput): { verdict: Verdict; reason: string } {
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
  const enter = result.enter;
  if (code === 4 || result.scriptError || (result.end && result.end.code === 4)) {
    const fwInactive = fw && fw.present && !fw.active;
    const sigs = fw && Array.isArray(fw.signatureFailures) ? fw.signatureFailures : [];
    const detail = result.scriptError
      ? `script error at line ${result.scriptError.line}: ${result.scriptError.msg}`
      : result.end && result.end.reason === "enter_unavailable" && enter
        ? `enter ${enter.name} unavailable at line ${enter.line}: ${enter.detail} (enter_unavailable; rebuild mewframework/mewtest with the run-entry symbols)`
      : result.end && result.end.reason === "seed_unavailable" && result.seed
        ? `seed ${result.seed.seed} unavailable at line ${result.seed.line}: ${result.seed.detail} (seed_unavailable; rebuild mewframework/mewtest with the RNG symbols)`
      : fwInactive && sigs.length
        ? `mewframework inactive: signature ${sigs.map((s) => `${s.name} (${s.matches} matches)`).join(", ")} failed on build ${fw.build || "?"}; re-derive with tools/bindings/make-signature.ts`
        : fwInactive
          ? "mewframework inactive (see mod_logs/mewframework.log)"
          : (result.end && result.end.reason) || "harness error";
    return { verdict: "harness-error", reason: detail };
  }
  if (code === 2 || (result.end && result.end.reason === "timeout")) return { verdict: "timeout", reason: `script timeout (end reason ${result.end ? result.end.reason : "?"})` };
  if (result.end && result.end.reason === "enter_failed") {
    return { verdict: "fail", reason: enter ? `enter ${enter.name} failed at line ${enter.line}: ${enter.detail}` : "enter failed (no enter event)" };
  }
  if (result.end && result.end.reason === "seed_failed") {
    return { verdict: "fail", reason: result.seed ? `seed ${result.seed.seed} failed at line ${result.seed.line}: ${result.seed.detail}` : "seed failed (no seed event)" };
  }
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
    const f = logs.debugLog.findings[0]!;
    return { verdict: "log-errors", reason: `${logs.debugLog.findings.length} debug.log marker(s), first: ${f.marker} at line ${f.line}` };
  }
  const logExpects = input.logExpects || [];
  const missedLog = logExpects.find((e) => !e.ok);
  if (missedLog) return { verdict: "fail", reason: `expect log failed at line ${missedLog.line}: "${missedLog.substr}" ${missedLog.detail}` };
  if (code !== 0 && code !== null) return { verdict: "fail", reason: `exit code ${code}` };
  const extra = logExpects.length ? `, ${logExpects.length} log expectation(s)` : "";
  return { verdict: "pass", reason: `all ${result.expects.passed} expectation(s) passed${extra}` };
}

function sizeOf(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

export interface RunPlanArgs {
  plan: Plan;
  test: { mod: string; name: string; scriptPath: string | null };
  env?: Env;
  gameDir?: string;
  appdataLogsDir?: string | null;
  modsDir?: string;
  runsDir?: string;
  saveCheck?: boolean;
  realSavePath?: string | null;
  realSavesDir?: string | null;
  backstopGraceMs?: number;
  endGraceMs?: number;
  exists?: (p: string) => boolean;
  steamRunning?: () => boolean | null;
  /** screenshot taker for `shot` directives (tests inject one); default: the PowerShell window capture */
  capture?: CaptureFn;
  /** called right after the game process was spawned (sessions connect the pipe from here) */
  onLaunched?: (info: { pid: number | null; runDir: string; outPath: string }) => void;
}

interface SpawnOutcome extends ExitInfo {
  killedAfterEnd: boolean;
  stdout: string;
  stderr: string;
  err: string | null;
}

export async function runPlan(args: RunPlanArgs): Promise<IngameReport> {
  const env: Env = args.env || process.env;
  const plan = args.plan;
  const gameDir = args.gameDir || locateGameDir(env);
  const appdataLogsDir = args.appdataLogsDir !== undefined ? args.appdataLogsDir : locateAppdataLogsDir(env);
  const runsDir = args.runsDir || (env.MEWTEST_RESULTS_DIR ? String(env.MEWTEST_RESULTS_DIR) : RUNS_DIR);
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const expectedSuffix = plan.savesuffix;

  const report: IngameReport = {
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
    logExpects: [],
    safety: { expectedSuffix, observedSuffix: null, saveSuffixOk: true, modPathsObserved: [], saveCheck: null, saveSet: null, campaignSlot: null },
    artifacts: { runDir: null, script: null, resultFile: null, debugLog: null, frameworkLogWindow: null, chainloaderLog: null, report: null, shots: [] },
    stdoutTail: "",
    stderrTail: "",
  };
  const finish = (launchError: string | null, exit: ExitInfo = { code: null, signal: null, backstop: false }): IngameReport => {
    const v = decideVerdict({ preflight: report.preflight, launchError, exit, result: report.result, logs: report.logFindings, logExpects: report.logExpects, safety: report.safety });
    report.verdict = v.verdict;
    report.killedAfterEnd = !!exit.killedAfterEnd;
    const shots = report.artifacts.shots;
    const shotNote = shots.length
      ? `; ${shots.length} shot(s)${shots.some((s) => s.hidden) ? " taken with the window hidden (set hide: false to see the game)" : ""}${shots.some((s) => !s.path) ? `, ${shots.filter((s) => !s.path).length} not captured (${[...new Set(shots.filter((s) => !s.path).map((s) => s.note || "unknown"))].join(", ")})` : ""}`
      : "";
    report.reason = v.reason + (exit.killedAfterEnd ? "; the game lingered after its end record and was killed after the end grace" : "") + shotNote;
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
    let launch: LaunchSpec;
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
    // the disposable campaign slot starts fresh for every `enter Campaign` script; the previous one is kept in the run dir
    const slot = plan.usesCampaignSlot && savesDir ? resetCampaignSlot(savesDir, runDir) : null;

    // 5. spawn + wait (backstop kill)
    const launchedAtMs = Date.now();
    const exit = await new Promise<SpawnOutcome>((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let backstop = false;
      let killedAfterEnd = false;
      const child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      if (args.onLaunched) { try { args.onLaunched({ pid: child.pid ?? null, runDir, outPath }); } catch { /* the hook's problem */ } }
      const grace = args.backstopGraceMs !== undefined ? args.backstopGraceMs : BACKSTOP_GRACE_MS;
      const endGrace = args.endGraceMs !== undefined ? args.endGraceMs : END_GRACE_MS;
      // the harness flushes every record; once `end` is on disk the verdict exists and only the process lifetime is
      // open. Clean mode relies on this: the game may shut itself down (any exit code), or never exit -> kill it.
      let endTimer: ReturnType<typeof setTimeout> | null = null;
      const capture = args.capture || captureWindow;
      // `shot` events: capture as soon as one shows up in the result file (the DLL holds the scene ~700 ms)
      const takeShots = (res: ReturnType<typeof parseResults>) => {
        for (let i = report.artifacts.shots.length; i < res.shots.length; i++) {
          const s = res.shots[i]!;
          let cap: ReturnType<CaptureFn>;
          try { cap = capture(s.label, runDir, child.pid ?? null); } catch (e) { cap = { path: null, note: e instanceof Error ? e.message : String(e) }; }
          const c = typeof cap === "string" || cap === null ? { path: cap } : cap;
          report.artifacts.shots.push({ label: s.label, line: s.line, path: c.path, hidden: plan.hide, ...(c.note ? { note: c.note } : {}) });
        }
      };
      const poll = setInterval(() => {
        if (endTimer || settled) return;
        let seen = false;
        try {
          const res = existsSync(outPath) ? parseResults(readFileSync(outPath, "utf8")) : null;
          if (res) takeShots(res);
          seen = !!(res && res.end);
        } catch { seen = false; }
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
      child.stdout.on("data", (c: Buffer | string) => { stdout = (stdout + c.toString("utf8")).slice(-TAIL_CHARS); });
      child.stderr.on("data", (c: Buffer | string) => { stderr = (stderr + c.toString("utf8")).slice(-TAIL_CHARS); });
      const done = (code: number | null, signal: string | null, err: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        if (endTimer) clearTimeout(endTimer);
        resolve({ code, signal, backstop, killedAfterEnd, stdout, stderr, err });
      };
      child.on("error", (e: Error) => done(null, null, String(e && e.message ? e.message : e)));
      child.on("exit", (code: number | null, signal: string | null) => done(typeof code === "number" ? code : null, signal || null, null));
    });
    report.stdoutTail = exit.stdout;
    report.stderrTail = exit.stderr;

    // 6. evidence
    report.result = parseResults(existsSync(outPath) ? readFileSync(outPath, "utf8") : null);
    // shot events the poll did not get to (a game that ended within one poll tick): capture what is on screen now
    for (let i = report.artifacts.shots.length; i < report.result.shots.length; i++) {
      const s = report.result.shots[i]!;
      let cap: ReturnType<CaptureFn>;
      try { cap = (args.capture || captureWindow)(s.label, runDir, null); } catch (e) { cap = { path: null, note: e instanceof Error ? e.message : String(e) }; }
      const c = typeof cap === "string" || cap === null ? { path: cap } : cap;
      report.artifacts.shots.push({ label: s.label, line: s.line, path: c.path, hidden: plan.hide, ...(c.note ? { note: c.note } : {}) });
    }
    report.artifacts.resultFile = existsSync(outPath) ? outPath : null;
    const logs = collectLogs({ gameDir, appdataLogsDir, frameworkLogOffset, launchedAtMs, expectedSuffix });
    report.logFindings = logs;
    const runnerSide = plan.directives.filter(isRunnerSide);
    if (runnerSide.length) {
      const debugText = logs.debugLog.path && logs.debugLog.present ? readFileSync(logs.debugLog.path, "utf8") : null;
      report.logExpects = checkLogExpects(debugText, runnerSide);
    }
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
      campaignSlot: slot && savesDir ? { ...slot, after: existsSync(join(savesDir, CAMPAIGN_SLOT_FILE)) ? "present" : "absent" } : null,
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
