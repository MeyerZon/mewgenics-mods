// Parser for the harness's JSON-lines result file (pure).
// Event contract: docs/ingame-testing.md ("Result JSONL").

/** One JSONL record. Every event carries `ev`; the rest is the harness's own, kept as-is. */
export interface ResultEvent {
  ev: string;
  [k: string]: unknown;
}

/** The `end` record: `code` is the exit code the harness decided, `reason` names why. */
export interface EndEvent extends ResultEvent {
  ev: "end";
  code?: number;
  reason?: string;
}

/** The `crash` record written by the harness's exception handler. */
export interface CrashEvent extends ResultEvent {
  ev: "crash";
  code?: string;
  module?: string;
  rva?: string;
}

/** `script_error`: the harness rejected a directive. */
export interface ScriptErrorEvent extends ResultEvent {
  ev: "script_error";
  line?: number;
  msg?: string;
}

/** `enter`: the harness replayed (or refused) a dev-menu scene entry. */
export interface EnterEvent {
  line: number;
  name: string;
  ok: boolean;
  detail: string;
}

/** `shot`: the script asked for a screenshot here; the DLL held the scene for `hold_ms` while the runner captured. */
export interface ShotEvent {
  line: number;
  label: string;
  frame: number;
}

/** `popup`: a modal dialog the harness's watchdog dismissed (the game's own WARNING/ERROR boxes). */
export interface PopupEvent {
  title: string;
  text: string;
  frame: number;
}

export interface ExpectFailure {
  line: number;
  kind: string;
  arg: string;
  detail: string;
}

export interface ResultSummary {
  /** a result file existed */
  present: boolean;
  /** the last line was cut mid-record (process died while writing) */
  truncated: boolean;
  /** complete lines that were not JSON */
  parseErrors: number;
  events: ResultEvent[];
  start: ResultEvent | null;
  end: EndEvent | null;
  crash: CrashEvent | null;
  scriptError: ScriptErrorEvent | null;
  turns: number;
  consoleLines: string[];
  expects: { passed: number; failed: number; failures: ExpectFailure[] };
  /** the last units snapshot */
  units: ResultEvent | null;
  /** the enter event (one per script), null when the script had none */
  enter: EnterEvent | null;
  /** dialogs the watchdog dismissed, in order */
  popups: PopupEvent[];
  /** screenshot requests, in order */
  shots: ShotEvent[];
}

export function parseResults(text: string | null | undefined): ResultSummary {
  const r: ResultSummary = {
    present: typeof text === "string",
    truncated: false,
    parseErrors: 0,
    events: [],
    start: null,
    end: null,
    crash: null,
    scriptError: null,
    turns: 0,
    consoleLines: [],
    expects: { passed: 0, failed: 0, failures: [] },
    units: null,
    enter: null,
    popups: [],
    shots: [],
  };
  if (typeof text !== "string") return r;

  const lines = text.split("\n");
  const endsWithNewline = text.endsWith("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "");
    if (!line.trim()) continue;
    const isLast = i === lines.length - 1 || (i === lines.length - 2 && lines[lines.length - 1] === "");
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      if (isLast && !endsWithNewline) r.truncated = true;
      else r.parseErrors++;
      continue;
    }
    if (!ev || typeof ev !== "object") { r.parseErrors++; continue; }
    const e = ev as ResultEvent;
    r.events.push(e);
    switch (e.ev) {
      case "start": r.start = e; break;
      case "end": r.end = e as EndEvent; break;
      case "crash": r.crash = e as CrashEvent; break;
      case "script_error": if (!r.scriptError) r.scriptError = e as ScriptErrorEvent; break;
      case "turn": r.turns++; break;
      case "console": r.consoleLines.push(String(e.text ?? "")); break;
      case "units": r.units = e; break;
      case "enter": r.enter = { line: Number(e.line ?? 0), name: String(e.name ?? ""), ok: Boolean(e.ok), detail: String(e.detail ?? "") }; break;
      case "popup": r.popups.push({ title: String(e.title ?? ""), text: String(e.text ?? ""), frame: Number(e.frame ?? 0) }); break;
      case "shot": r.shots.push({ line: Number(e.line ?? 0), label: String(e.label ?? ""), frame: Number(e.frame ?? 0) }); break;
      case "expect":
        if (e.ok) r.expects.passed++;
        else {
          r.expects.failed++;
          r.expects.failures.push({ line: Number(e.line ?? 0), kind: String(e.kind ?? ""), arg: String(e.arg ?? ""), detail: String(e.detail ?? "") });
        }
        break;
      default: break; // unknown kinds are kept in events
    }
  }
  return r;
}
