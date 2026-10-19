// .mewtest script parser (pure; no fs).
//
// A script is a header of `key: value` lines followed by one directive per
// line. The Node side owns the header (which mods to load, the save suffix,
// the timeout, the window mode); the native harness (mewtest.dll) only ever
// sees the directive body. Grammar and semantics: docs/ingame-testing.md.

export const DEFAULT_SAVESUFFIX = "dev";
export const DEFAULT_TIMEOUT_MS = 120000;
export const HEADER_KEYS = ["mods", "savesuffix", "timeout", "hide", "clean"];
export const SAVESUFFIX_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const MAX_CMD_BYTES = 4078; // the game's std::string small/large allocation boundary
export const UNITS_OPS = ["==", "!=", ">=", "<=", ">", "<"];

/** @typedef {{ line: number, message: string }} Finding */
/**
 * @typedef {{ line: number, kind: "cmd", text: string }
 *   | { line: number, kind: "wait", unit: "frames" | "turns" | "ms", n: number }
 *   | { line: number, kind: "expect", what: "console" | "noconsole", substr: string, within?: number }
 *   | { line: number, kind: "expect", what: "status", status: string, unit: string }
 *   | { line: number, kind: "expect", what: "units", op: string, n: number }
 *   | { line: number, kind: "dump" }
 *   | { line: number, kind: "log", text: string }
 *   | { line: number, kind: "quit", code: number | null }} Directive
 */
/**
 * @typedef {Object} Plan
 * @property {boolean} ok
 * @property {string} name
 * @property {string[]} mods
 * @property {string} savesuffix
 * @property {number} timeoutMs
 * @property {boolean} hide
 * @property {boolean} clean  -mewtest_clean 1: after the end event the harness lets the game shut itself down (complete debug.log); default false
 * @property {Directive[]} directives
 * @property {string} body  directive lines only (no header, no comments), "\n"-terminated
 * @property {Finding[]} errors
 * @property {Finding[]} warnings
 */

/**
 * "5000" -> 5000, "90s" -> 90000, "2m" -> 120000; null when invalid or <= 0.
 * @param {string} v
 * @returns {number|null}
 */
export function parseTimeout(v) {
  const m = /^\s*(\d+)\s*(ms|s|m)?\s*$/i.exec(String(v));
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] || "ms").toLowerCase();
  return unit === "s" ? n * 1000 : unit === "m" ? n * 60000 : n;
}

/**
 * Parse a double-quoted string literal starting at s[i] === '"'.
 * Escapes: \" and \\ only.
 * @param {string} s @param {number} i
 * @returns {{ value: string, end: number } | null}
 */
function parseQuoted(s, i) {
  if (s[i] !== '"') return null;
  let out = "";
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === "\\" && j + 1 < s.length && (s[j + 1] === '"' || s[j + 1] === "\\")) {
      out += s[j + 1];
      j++;
    } else if (c === '"') {
      return { value: out, end: j + 1 };
    } else {
      out += c;
    }
  }
  return null;
}

/**
 * Parse one directive line (already trimmed, non-empty, not a comment).
 * @param {string} line @param {number} lineNo
 * @returns {Directive | { error: string }}
 */
export function parseDirective(line, lineNo) {
  const word = (/^(\S+)/.exec(line) || ["", ""])[1];
  const rest = line.slice(word.length).trim();
  switch (word) {
    case "cmd": {
      if (!rest) return { error: "cmd needs a console command" };
      if (Buffer.from(rest, "utf8").length > MAX_CMD_BYTES) return { error: `cmd longer than ${MAX_CMD_BYTES} bytes` };
      return { line: lineNo, kind: "cmd", text: rest };
    }
    case "wait": {
      const m = /^(\S+)\s+(\S+)$/.exec(rest);
      if (!m) return { error: "wait needs a unit (frames|turns|ms) and a count" };
      const unit = m[1];
      if (unit !== "frames" && unit !== "turns" && unit !== "ms") return { error: `bad wait unit "${unit}" (frames|turns|ms)` };
      if (!/^\d+$/.test(m[2]) || Number(m[2]) < 1) return { error: "wait count must be an integer >= 1" };
      return { line: lineNo, kind: "wait", unit, n: Number(m[2]) };
    }
    case "expect": {
      const what = (/^(\S+)/.exec(rest) || ["", ""])[1];
      const arg = rest.slice(what.length).trim();
      if (what === "console" || what === "noconsole") {
        const q = parseQuoted(arg, 0);
        if (!q) return { error: arg ? `expect ${what}: unterminated or missing quoted string` : `expect ${what} needs a quoted substring` };
        const tail = arg.slice(q.end).trim();
        if (!tail) return { line: lineNo, kind: "expect", what, substr: q.value };
        const w = /^within\s+(\d+)$/.exec(tail);
        if (!w || Number(w[1]) < 1) return { error: `expect ${what}: unexpected trailing text "${tail}"` };
        return { line: lineNo, kind: "expect", what, substr: q.value, within: Number(w[1]) };
      }
      if (what === "status") {
        const m = /^(\S+)\s+on\s+(.+)$/.exec(arg);
        if (!m) return { error: "expect status needs: <StatusName> on <unit>" };
        let unit = m[2].trim();
        if (unit.startsWith('"')) {
          const q = parseQuoted(unit, 0);
          if (!q || q.end !== unit.length) return { error: "expect status: bad quoted unit name" };
          unit = q.value;
        } else if (/\s/.test(unit)) {
          return { error: "expect status: quote a unit name that contains spaces" };
        }
        return { line: lineNo, kind: "expect", what: "status", status: m[1], unit };
      }
      if (what === "units") {
        const m = /^(\S+)\s+(\d+)$/.exec(arg);
        if (!m) return { error: "expect units needs: <op> <N>" };
        if (!UNITS_OPS.includes(m[1])) return { error: `expect units: bad operator "${m[1]}" (${UNITS_OPS.join(" ")})` };
        return { line: lineNo, kind: "expect", what: "units", op: m[1], n: Number(m[2]) };
      }
      return { error: what ? `unknown expect kind "${what}"` : "expect needs a kind (console|noconsole|status|units)" };
    }
    case "dump":
      if (rest) return { error: "dump takes no arguments" };
      return { line: lineNo, kind: "dump" };
    case "log": {
      const q = parseQuoted(rest, 0);
      if (!q || rest.slice(q.end).trim()) return { error: "log needs one quoted string" };
      return { line: lineNo, kind: "log", text: q.value };
    }
    case "quit": {
      if (!rest) return { line: lineNo, kind: "quit", code: null };
      if (!/^\d+$/.test(rest) || Number(rest) > 255) return { error: "quit code must be an integer 0..255" };
      return { line: lineNo, kind: "quit", code: Number(rest) };
    }
    default:
      return { error: `unknown directive "${word}"` };
  }
}

/**
 * @param {string} text
 * @param {{ owningMod?: string, name?: string }} [opts]
 * @returns {Plan}
 */
export function parseScript(text, opts = {}) {
  /** @type {Finding[]} */
  const errors = [];
  /** @type {Finding[]} */
  const warnings = [];
  /** @type {Directive[]} */
  const directives = [];
  /** @type {string[]} */
  const bodyLines = [];
  /** @type {string[] | null} */
  let mods = null;
  let savesuffix = DEFAULT_SAVESUFFIX;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let hide = true;
  let clean = false;
  let inHeader = true;

  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i].trim();
    if (!raw) { inHeader = false; continue; }
    if (raw.startsWith("#")) { inHeader = false; continue; }
    const hm = /^([A-Za-z_]+):(?:\s+(.*))?$/.exec(raw);
    if (hm) {
      if (!inHeader) { errors.push({ line: lineNo, message: `header line "${hm[1]}:" after the first directive` }); continue; }
      const key = hm[1].toLowerCase();
      const val = (hm[2] || "").trim();
      if (key === "mods") {
        mods = val.split(/[\s,]+/).filter(Boolean);
        if (mods.length === 0) errors.push({ line: lineNo, message: "mods: needs at least one mod name" });
      } else if (key === "savesuffix") {
        if (!SAVESUFFIX_RE.test(val)) errors.push({ line: lineNo, message: `savesuffix must match ${SAVESUFFIX_RE}` });
        else savesuffix = val;
      } else if (key === "timeout") {
        const t = parseTimeout(val);
        if (t === null) errors.push({ line: lineNo, message: `bad timeout "${val}" (e.g. 5000, 90s, 2m)` });
        else timeoutMs = t;
      } else if (key === "hide") {
        if (val === "true" || val === "1") hide = true;
        else if (val === "false" || val === "0") hide = false;
        else errors.push({ line: lineNo, message: `hide must be true or false` });
      } else if (key === "clean") {
        if (val === "true" || val === "1") clean = true;
        else if (val === "false" || val === "0") clean = false;
        else errors.push({ line: lineNo, message: `clean must be true or false` });
      } else {
        errors.push({ line: lineNo, message: `unknown header key "${hm[1]}" (${HEADER_KEYS.join(", ")})` });
      }
      continue;
    }
    inHeader = false;
    const d = parseDirective(raw, lineNo);
    if ("error" in d) { errors.push({ line: lineNo, message: d.error }); continue; }
    directives.push(d);
    bodyLines.push(raw);
  }

  if (mods === null) mods = opts.owningMod ? [opts.owningMod] : [];
  if (mods.length === 0) errors.push({ line: 0, message: "no mods: add a `mods:` header or pass the owning mod" });
  if (!directives.some((d) => d.kind === "quit")) {
    warnings.push({ line: 0, message: "no quit directive; the harness quits at end of script (code 0 if all expects passed, else 1)" });
  }

  return {
    ok: errors.length === 0,
    name: opts.name || "inline",
    mods,
    savesuffix,
    timeoutMs,
    hide,
    clean,
    directives,
    body: bodyLines.length ? bodyLines.join("\n") + "\n" : "",
    errors,
    warnings,
  };
}
