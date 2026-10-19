// Parser for the harness's JSON-lines result file (pure).
// Event contract: docs/ingame-testing.md ("Result JSONL").

/**
 * @typedef {Object} ResultSummary
 * @property {boolean} present        a result file existed
 * @property {boolean} truncated      the last line was cut mid-record (process died while writing)
 * @property {number} parseErrors     complete lines that were not JSON
 * @property {any[]} events
 * @property {any|null} start
 * @property {any|null} end
 * @property {any|null} crash
 * @property {any|null} scriptError
 * @property {number} turns
 * @property {string[]} consoleLines
 * @property {{ passed: number, failed: number, failures: Array<{ line: number, kind: string, arg: string, detail: string }> }} expects
 * @property {any|null} units         the last units snapshot
 */

/**
 * @param {string|null|undefined} text
 * @returns {ResultSummary}
 */
export function parseResults(text) {
  /** @type {ResultSummary} */
  const r = {
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
  };
  if (typeof text !== "string") return r;

  const lines = text.split("\n");
  const endsWithNewline = text.endsWith("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (!line.trim()) continue;
    const isLast = i === lines.length - 1 || (i === lines.length - 2 && lines[lines.length - 1] === "");
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      if (isLast && !endsWithNewline) r.truncated = true;
      else r.parseErrors++;
      continue;
    }
    if (!ev || typeof ev !== "object") { r.parseErrors++; continue; }
    r.events.push(ev);
    switch (ev.ev) {
      case "start": r.start = ev; break;
      case "end": r.end = ev; break;
      case "crash": r.crash = ev; break;
      case "script_error": if (!r.scriptError) r.scriptError = ev; break;
      case "turn": r.turns++; break;
      case "console": r.consoleLines.push(String(ev.text ?? "")); break;
      case "units": r.units = ev; break;
      case "expect":
        if (ev.ok) r.expects.passed++;
        else {
          r.expects.failed++;
          r.expects.failures.push({ line: Number(ev.line ?? 0), kind: String(ev.kind ?? ""), arg: String(ev.arg ?? ""), detail: String(ev.detail ?? "") });
        }
        break;
      default: break; // unknown kinds are kept in events
    }
  }
  return r;
}
