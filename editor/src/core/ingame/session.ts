// An interactive in-game session: the game is launched through runPlan with an `interactive: true` plan (the DLL
// gets -mewtest_pipe 1 and idles at the end of the script instead of ending), the pipe is connected, and commands
// are sent while the run is alive. `stop()` sends quit and returns the ordinary report, so verdicts, log checks and
// the save-set safety check are exactly those of a scripted run; every exchange is also in result.jsonl.

import { existsSync, readFileSync } from "node:fs";
import { runPlan, type RunPlanArgs, type IngameReport } from "./runner.ts";
import { connectPipe, pipePath, type PipeClient, type PipeReply } from "./pipe.ts";

export interface IngameSession {
  readonly pid: number;
  readonly runDir: string;
  readonly pipe: string;
  /** true once the game exited (the report is final); exec/dump then reject */
  readonly ended: boolean;
  /** true once the DLL emitted `idle` (the script ran to its end; requests are no longer served inside the script's waits) */
  readonly idle: boolean;
  /** resolve when the script has run to its end (the idle event is in the result file) or the game ended; rejects on the timeout */
  waitForIdle(timeoutMs?: number): Promise<void>;
  /** run a console line; the reply is the DLL's exec event (ok + the console lines collected for `frames` frames) */
  exec(cmd: string, frames?: number): Promise<PipeReply>;
  /** the units event (available, round, count, list) */
  dump(): Promise<PipeReply>;
  /** send quit (if still alive), wait for the game to exit, return the report */
  stop(): Promise<IngameReport>;
}

export interface StartSessionArgs extends RunPlanArgs {
  /** how long to wait for the DLL's pipe after the launch (default 30 s) */
  connectTimeoutMs?: number;
}

export async function startSession(args: StartSessionArgs): Promise<IngameSession> {
  if (!args.plan.interactive) throw new Error("startSession needs a plan with `interactive: true` (the DLL idles at the end of the script and serves the pipe)");
  let launched: { pid: number | null; runDir: string; outPath: string } | null = null;
  let resolveLaunched: (v: { pid: number | null; runDir: string; outPath: string }) => void = () => {};
  const launchedP = new Promise<{ pid: number | null; runDir: string; outPath: string }>((r) => { resolveLaunched = r; });
  let report: IngameReport | null = null;
  const reportP = runPlan({ ...args, onLaunched: (info) => { launched = info; resolveLaunched(info); } }).then((r) => { report = r; return r; });
  const info = await Promise.race([
    launchedP,
    reportP.then((r) => { throw new Error(`session did not start: ${r.verdict}: ${r.reason}`); }),
  ]);
  void launched;
  if (info.pid === null) { await reportP.catch(() => undefined); throw new Error("session did not start: the game process has no pid"); }
  const path = pipePath(info.pid);
  let client: PipeClient;
  try {
    client = await Promise.race([
      connectPipe(path, { timeoutMs: args.connectTimeoutMs ?? 30000 }),
      reportP.then((r) => { throw new Error(`session ended before the pipe connected: ${r.verdict}: ${r.reason}`); }),
    ]);
  } catch (e) {
    await reportP.catch(() => undefined);
    throw e;
  }
  void reportP.then(() => client.close());
  const ended = () => report !== null;
  let idle = false;
  const seenIdle = () => {
    if (idle) return true;
    try {
      if (existsSync(info.outPath) && /{"ev":"idle"/.test(readFileSync(info.outPath, "utf8"))) idle = true;
    } catch { /* mid-write; next poll */ }
    return idle;
  };
  const guard = () => {
    if (report) throw new Error(`session ended: ${report.verdict}: ${report.reason}`);
    if (client.closed) throw new Error("session ended: pipe closed");
  };
  return {
    pid: info.pid,
    runDir: info.runDir,
    pipe: path,
    get ended() { return ended(); },
    get idle() { return seenIdle(); },
    async waitForIdle(timeoutMs = 120000) {
      const t0 = Date.now();
      while (!seenIdle()) {
        if (report) throw new Error(`session ended before idle: ${report.verdict}: ${report.reason}`);
        if (Date.now() - t0 > timeoutMs) throw new Error(`the script did not reach its end (idle) within ${timeoutMs} ms`);
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    async exec(cmd: string, frames?: number) {
      guard();
      return client.request({ op: "exec", text: cmd, frames });
    },
    async dump() {
      guard();
      return client.request({ op: "dump" });
    },
    async stop() {
      if (!report && !client.closed) {
        try { await client.request({ op: "quit" }, 15000); } catch { /* EOF or a closed pipe: the report says what happened */ }
      }
      return reportP;
    },
  };
}
