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
/** fields `expect unit` can read (the units event's per-unit fields); must agree with mt_script.c UNIT_FIELDS */
export const UNIT_FIELDS = ["name", "class", "faction", "move", "act", "turnkind"] as const;
export type UnitField = (typeof UNIT_FIELDS)[number];

export interface Finding {
  line: number;
  message: string;
}

export type WaitUnit = "frames" | "turns" | "rounds" | "ms";

/** One parsed directive line (docs/ingame-testing.md "Grammar"). */
export type Directive =
  | { line: number; kind: "cmd"; text: string }
  | { line: number; kind: "wait"; unit: WaitUnit; n: number }
  | { line: number; kind: "expect"; what: "console" | "noconsole"; substr: string; within?: number }
  | { line: number; kind: "expect"; what: "status"; status: string; unit: string }
  | { line: number; kind: "expect"; what: "units"; op: string; n: number }
  | { line: number; kind: "expect"; what: "round"; op: string; n: number }
  | { line: number; kind: "expect"; what: "stacks"; status: string; unit: string; op: string; n: number }
  | { line: number; kind: "expect"; what: "stacks"; status: string; unit: string; varied: true }
  /** one field of one unit in the units event: name|class compare as strings (== !=), the rest as integers */
  | { line: number; kind: "expect"; what: "unit"; unit: string; field: UnitField; op: string; value: string | number }
  /** runner-side: debug.log (after the `[file: …]` prefix) contains substr; evaluated after the run, never sent to the DLL */
  | { line: number; kind: "expect"; what: "log"; substr: string }
  | { line: number; kind: "dump" }
  | { line: number; kind: "log"; text: string }
  | { line: number; kind: "quit"; code: number | null }
  /** replay a dev-menu scene entry inside the game (mewtest.dll: MtHost.enter_scene); once per script */
  | { line: number; kind: "enter"; scene: string }
  /** the DLL emits a shot event and holds the scene ~700 ms; the runner captures the game window into the run dir */
  | { line: number; kind: "shot"; label: string }
  /** pin the game's RNG (TLS+0x178) once its startup is over; the value is kept as digits (full 64-bit range) */
  | { line: number; kind: "seed"; seed: string };

/** Scenes `enter` knows; must agree with mt_script.c (mt_scene_id). */
export const KNOWN_SCENES = ["TacticsTest", "Campaign"];
/** the scene whose entry opens the harness-owned disposable save slot (savecheck.ts CAMPAIGN_SLOT_FILE) */
export const CAMPAIGN_SCENE = "Campaign";

export interface Plan {
  ok: boolean;
  name: string;
  mods: string[];
  savesuffix: string;
  timeoutMs: number;
  hide: boolean;
  /** -mewtest_clean 1: after the end event the harness lets the game shut itself down (complete debug.log); default false */
  clean: boolean;
  directives: Directive[];
  /** true when an `enter Campaign` is present: the runner moves the disposable slot aside before launching */
  usesCampaignSlot: boolean;
  /** directive lines only (no header, no comments), "\n"-terminated */
  body: string;
  errors: Finding[];
  warnings: Finding[];
}

/** "5000" -> 5000, "90s" -> 90000, "2m" -> 120000; null when invalid or <= 0. */
export function parseTimeout(v: string): number | null {
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
 */
function parseQuoted(s: string, i: number): { value: string; end: number } | null {
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

/** Parse one directive line (already trimmed, non-empty, not a comment). */
export function parseDirective(line: string, lineNo: number): Directive | { error: string } {
  const word = (/^(\S+)/.exec(line) || ["", ""])[1]!;
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
      const unit = m[1]!;
      if (unit !== "frames" && unit !== "turns" && unit !== "rounds" && unit !== "ms") return { error: `bad wait unit "${unit}" (frames|turns|rounds|ms)` };
      if (!/^\d+$/.test(m[2]!) || Number(m[2]) < 1) return { error: "wait count must be an integer >= 1" };
      return { line: lineNo, kind: "wait", unit, n: Number(m[2]) };
    }
    case "expect": {
      const what = (/^(\S+)/.exec(rest) || ["", ""])[1]!;
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
        let unit = m[2]!.trim();
        if (unit.startsWith('"')) {
          const q = parseQuoted(unit, 0);
          if (!q || q.end !== unit.length) return { error: "expect status: bad quoted unit name" };
          unit = q.value;
        } else if (/\s/.test(unit)) {
          return { error: "expect status: quote a unit name that contains spaces" };
        }
        return { line: lineNo, kind: "expect", what: "status", status: m[1]!, unit };
      }
      if (what === "units" || what === "round") {
        const m = /^(\S+)\s+(\d+)$/.exec(arg);
        if (!m) return { error: `expect ${what} needs: <op> <N>` };
        if (!UNITS_OPS.includes(m[1]!)) return { error: `expect ${what}: bad operator "${m[1]}" (${UNITS_OPS.join(" ")})` };
        return { line: lineNo, kind: "expect", what, op: m[1]!, n: Number(m[2]) };
      }
      if (what === "stacks") {
        const m = /^(\S+)\s+on\s+(.+)$/.exec(arg);
        if (!m) return { error: "expect stacks needs: <Status> on <unit> (<op> <N> | varied)" };
        let rest2 = m[2]!.trim();
        let unit: string;
        if (rest2.startsWith('"')) {
          const q = parseQuoted(rest2, 0);
          if (!q) return { error: "expect stacks: bad quoted unit name" };
          unit = q.value;
          rest2 = rest2.slice(q.end).trim();
        } else {
          const sp = rest2.search(/\s/);
          if (sp < 0) return { error: "expect stacks needs: <Status> on <unit> (<op> <N> | varied)" };
          unit = rest2.slice(0, sp);
          rest2 = rest2.slice(sp).trim();
        }
        if (rest2 === "varied") return { line: lineNo, kind: "expect", what: "stacks", status: m[1]!, unit, varied: true };
        if (rest2.startsWith("varied")) return { error: "expect stacks: unexpected text after varied" };
        const op = /^(\S+)\s+(\d+)$/.exec(rest2);
        if (!op) return { error: "expect stacks needs: <Status> on <unit> (<op> <N> | varied)" };
        if (!UNITS_OPS.includes(op[1]!)) return { error: `expect stacks: bad operator "${op[1]}" (${UNITS_OPS.join(" ")}) or varied` };
        return { line: lineNo, kind: "expect", what: "stacks", status: m[1]!, unit, op: op[1]!, n: Number(op[2]) };
      }
      if (what === "unit") {
        let rest2 = arg;
        let unit: string;
        if (rest2.startsWith('"')) {
          const q = parseQuoted(rest2, 0);
          if (!q) return { error: "expect unit: bad quoted unit name" };
          unit = q.value;
          rest2 = rest2.slice(q.end).trim();
        } else {
          const sp = rest2.search(/\s/);
          if (sp < 0) return { error: "expect unit needs: <unit> <field> <op> <value>" };
          unit = rest2.slice(0, sp);
          rest2 = rest2.slice(sp).trim();
        }
        const m2 = /^(\S+)\s+(\S+)\s+([\s\S]+)$/.exec(rest2);
        if (!m2) return { error: "expect unit needs: <unit> <field> <op> <value>" };
        const field = m2[1]!, op = m2[2]!, val = m2[3]!.trim();
        if (!(UNIT_FIELDS as readonly string[]).includes(field)) return { error: `expect unit: unknown field "${field}" (${UNIT_FIELDS.join("|")})` };
        if (!UNITS_OPS.includes(op)) return { error: `expect unit: bad operator "${op}" (${UNITS_OPS.join(" ")})` };
        if (field === "name" || field === "class") {
          if (op !== "==" && op !== "!=") return { error: "expect unit: name/class take == or != and a quoted value" };
          const q = parseQuoted(val, 0);
          if (!q || val.slice(q.end).trim()) return { error: "expect unit: name/class take == or != and a quoted value" };
          return { line: lineNo, kind: "expect", what: "unit", unit, field: field as UnitField, op, value: q.value };
        }
        if (!/^\d+$/.test(val)) return { error: "expect unit: faction/move/act/turnkind take one integer" };
        return { line: lineNo, kind: "expect", what: "unit", unit, field: field as UnitField, op, value: Number(val) };
      }
      if (what === "log") {
        const q = parseQuoted(arg, 0);
        if (!q) return { error: arg ? "expect log: unterminated or missing quoted string" : "expect log needs a quoted substring" };
        const tail = arg.slice(q.end).trim();
        if (tail) return { error: `expect log: unexpected trailing text "${tail}" (no within: debug.log is read once, after the run)` };
        return { line: lineNo, kind: "expect", what: "log", substr: q.value };
      }
      return { error: what ? `unknown expect kind "${what}"` : "expect needs a kind (console|noconsole|status|units|round|stacks|unit|log)" };
    }
    case "dump":
      if (rest) return { error: "dump takes no arguments" };
      return { line: lineNo, kind: "dump" };
    case "log": {
      const q = parseQuoted(rest, 0);
      if (!q || rest.slice(q.end).trim()) return { error: "log needs one quoted string" };
      return { line: lineNo, kind: "log", text: q.value };
    }
    case "shot": {
      const q = parseQuoted(rest, 0);
      if (!q || rest.slice(q.end).trim()) return { error: "shot needs one quoted label" };
      return { line: lineNo, kind: "shot", label: q.value };
    }
    case "seed": {
      if (!/^\d{1,20}$/.test(rest) || BigInt(rest) > 18446744073709551615n) return { error: "seed needs one unsigned integer (0..18446744073709551615)" };
      return { line: lineNo, kind: "seed", seed: BigInt(rest).toString() };
    }
    case "enter": {
      if (!rest) return { error: `enter needs a scene name (${KNOWN_SCENES.join("|")})` };
      if (/\s/.test(rest)) return { error: "enter takes exactly one scene name" };
      if (!KNOWN_SCENES.includes(rest)) return { error: `unknown scene "${rest}" (${KNOWN_SCENES.join("|")})` };
      return { line: lineNo, kind: "enter", scene: rest };
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

/** Directives the Node runner evaluates itself (the DLL gets a comment placeholder instead). */
export function isRunnerSide(d: Directive): d is Extract<Directive, { what: "log" }> {
  return d.kind === "expect" && d.what === "log";
}

export interface ParseScriptOptions {
  owningMod?: string;
  name?: string;
}

export function parseScript(text: string, opts: ParseScriptOptions = {}): Plan {
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  const directives: Directive[] = [];
  const bodyLines: string[] = [];
  let mods: string[] | null = null;
  let savesuffix = DEFAULT_SAVESUFFIX;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let hide = true;
  let clean = false;
  let inHeader = true;

  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i]!.trim();
    if (!raw) { inHeader = false; continue; }
    if (raw.startsWith("#")) { inHeader = false; continue; }
    const hm = /^([A-Za-z_]+):(?:\s+(.*))?$/.exec(raw);
    if (hm) {
      if (!inHeader) { errors.push({ line: lineNo, message: `header line "${hm[1]}:" after the first directive` }); continue; }
      const key = hm[1]!.toLowerCase();
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
    // runner-side directives go into the DLL body as a comment, so the body's line numbers stay those of the
    // script and the harness (which tolerates # lines) never sees a directive it does not know
    bodyLines.push(isRunnerSide(d) ? `# runner: ${raw}` : raw);
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
    usesCampaignSlot: directives.some((d) => d.kind === "enter" && d.scene === CAMPAIGN_SCENE),
    body: bodyLines.length ? bodyLines.join("\n") + "\n" : "",
    errors,
    warnings,
  };
}
