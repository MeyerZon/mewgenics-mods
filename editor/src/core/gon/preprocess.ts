// The game's GON text pre-pass, ported from `Gon_Preprocess` 0xa50bd0 (RE session inc 2026-10-22,
// `.analysis/decompiled/Gon_Pre*_0x*.c`, docs/engine-map.md "GON parser"). Every GON text the game loads — a base
// file and every `.append` / `.merge` / `.patch` overlay — runs through it before `Gon_Tokenize` 0x93f090:
//
//   pass 1  Gon_Pre_StripComments 0xa4eb80   `//` to end of line (the newline is kept); `/* */` removed together with
//           the newlines inside it, no nesting, a `/` whose previous char is `*` closes (so `/*/` closes at once), an
//           unterminated `/*` drops the rest; never inside "…", where a `"` not preceded by `\` toggles the string.
//           `#` means nothing to this pass.
//   pass 2  Gon_Pre_ExpandIncludes 0xa4edf0  outside "…", at any `#` whose blank-delimited word is exactly `#include`:
//           read a name (blanks incl. newlines skipped first; `"` toggles a quoted part that is not copied, a closing
//           `"` ends the name, no escapes) and replace `#include <name>` by the pass-1+2 text of resolve(name), with
//           the SAME resolver (so nested names resolve against the top-level resource). Text after the name stays.
//   pass 3  Gon_Pre_CollectDefines 0xa4f4a0 (top-level text only, after includes are inlined): outside "…", a #-word
//           exactly `#define`, a name (Gon_Pre_ReadBraced 0xa4e880: delimiters skipped, read to a delimiter), blanks,
//           an optional `( p1, p2 … )` (the `(` may follow blanks; parameters are delimiter-separated tokens), then
//           the body up to the #-word `#end` — from right after `)` with parameters, else from the first non-blank.
//           The definition leaves the text; the map key is `#NAME`; a later definition wins.
//   pass 4  Gon_Pre_ExpandMacros 0xa501c0, repeated while a round changed something, at most 256 (0x100) rounds:
//           outside "…", a #-word (`#` to a blank) equal to a key is replaced by the body after reading one
//           delimiter-separated token per parameter; every body token equal to a parameter becomes its argument
//           (Gon_Pre_SubstituteArgs 0xa4e0b0; the body's last token is flushed unsubstituted when no delimiter
//           follows it). Delimiters: blanks and ( ) , : = [ ] { }. Text after the arguments stays (so
//           `#NAME (a, b)` leaves its `)`); `#NAME(a,b)` is no call (the #-word must equal the key exactly).
//
// The game has no include depth limit or cycle guard (a cycle recurses until the stack overflows) and a missing
// include is fatal (`Could not locate include file: <name>`). Here a miss contributes no text and is recorded; a
// cycle is cut and flagged. The editor's tokenizer keeps comments as trivia for byte-faithful editing; this module is
// what the semantic readers (validator, merge preview) parse.

/** Resolves an `#include` name (as written) to the included file's text, or null when it does not exist. */
export type IncludeResolver = (name: string) => string | null;

export interface IncludeUse {
  /** the name as written (quotes dropped) */
  name: string;
  found: boolean;
  /** 0 = written in the text given to preprocess(); 1 = inside a file it includes; … */
  depth: number;
  /** 1-based position of the `#` in the raw text of the file that holds the directive */
  line: number;
  col: number;
  /** names of the includes this one sits inside, outermost first ([] at depth 0) */
  chain: string[];
  /** the name is already being included further up (the game would recurse forever); not expanded */
  cycle?: boolean;
}

export interface PreprocessResult {
  /** the text the game's tokenizer would see (comments stripped, includes inlined) */
  text: string;
  includes: IncludeUse[];
  /** names of the `#define` macros collected from the top-level text (after includes), in definition order */
  defines: string[];
  /** how many pass-4 rounds changed the text (0 = no macro used) */
  macroPasses: number;
  /** all 256 rounds changed the text: a macro still expands (it names itself); the game parses what is left */
  macroRunaway?: boolean;
  /** 1-based position of a `/*` in the top-level text that is never closed (the game drops everything after it) */
  unclosedComment?: { line: number; col: number };
}

/** NUL, TAB, LF, CR, space — the blank set of the pre-pass word readers (mask 0x100002601). */
function isBlank(c: string | undefined): boolean {
  return c === undefined || c === "\0" || c === "\t" || c === "\n" || c === "\r" || c === " ";
}

/**
 * Pass 1 (Gon_Pre_StripComments 0xa4eb80).
 * @returns the stripped text, per kept character its offset in `src`, and the offset of the `/` of a `/*` that is
 * never closed (the pass then silently drops the rest of the text)
 */
export function stripComments(src: string): { text: string; map: number[]; unclosedBlockAt?: number } {
  let out = "";
  const map: number[] = [];
  const n = src.length;
  let inString = false;
  let inComment = false;
  let block = false;
  let blockStart = -1;
  const keep = (i: number): void => {
    out += src[i];
    map.push(i);
  };
  for (let i = 0; i < n; i++) {
    const c = src[i];
    if (inString) {
      if (c === '"' && !(i > 0 && src[i - 1] === "\\")) inString = false;
      keep(i);
    } else if (inComment) {
      if (block) {
        if (c === "/" && i > 0 && src[i - 1] === "*") inComment = false; // the closing `/` is dropped too
      } else if (c === "\n") {
        inComment = false;
        keep(i);
      }
    } else {
      if (c === '"') inString = true;
      if (c === "/" && i < n - 1 && src[i + 1] === "*") {
        inComment = true;
        block = true;
        blockStart = i;
      }
      if (c === "/" && i < n - 1 && src[i + 1] === "/") {
        inComment = true;
        block = false;
        continue;
      }
      if (!inComment) keep(i);
    }
  }
  return inComment && block ? { text: out, map, unclosedBlockAt: blockStart } : { text: out, map };
}

/** Gon_Pre_ReadWord 0xa4e650: skip blanks, then read a word; `"` toggles a quoted part (not copied), a closing `"`
 * ends the word just after it. @returns the word and the cursor after it */
function readWord(text: string, at: number): { word: string; end: number } {
  let i = at;
  while (i < text.length && isBlank(text[i])) i++;
  let word = "";
  let quoted = false;
  while (i < text.length) {
    const c = text[i]!;
    if (!quoted && isBlank(c)) break;
    if (c === '"') {
      if (quoted) return { word, end: i + 1 };
      quoted = true;
    } else {
      word += c;
    }
    i++;
  }
  return { word, end: i };
}

/** The blank-delimited word starting at `at` (the pre-pass `#`-word: quotes are ordinary characters here). */
function hashWord(text: string, at: number): string {
  let j = at;
  while (j < text.length && !isBlank(text[j])) j++;
  return text.slice(at, j);
}

/** 1-based line/col of offset `off` in `src`. */
function lineCol(src: string, off: number): { line: number; col: number } {
  let line = 1;
  let last = -1;
  for (let i = 0; i < off && i < src.length; i++) {
    if (src[i] === "\n") {
      line++;
      last = i;
    }
  }
  return { line, col: off - last };
}

/** Pass 2 (Gon_Pre_ExpandIncludes 0xa4edf0) over the pass-1 output of `raw`. */
function expandIncludes(
  raw: string,
  stripped: { text: string; map: number[] },
  resolve: IncludeResolver,
  depth: number,
  chain: string[],
  includes: IncludeUse[],
): string {
  const text = stripped.text;
  const n = text.length;
  let out = "";
  let inString = false;
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    if (inString) {
      if (c === '"' && !(i > 0 && text[i - 1] === "\\")) inString = false;
      out += c;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c !== "#" || hashWord(text, i) !== "#include") {
      out += c;
      i++;
      continue;
    }
    const { word: name, end } = readWord(text, i + "#include".length);
    const pos = lineCol(raw, stripped.map[i] ?? raw.length);
    const use: IncludeUse = { name, found: false, depth, line: pos.line, col: pos.col, chain: [...chain] };
    includes.push(use);
    i = end;
    if (chain.includes(name)) {
      use.cycle = true;
      use.found = true;
      continue;
    }
    const incRaw = resolve(name);
    if (incRaw === null) continue;
    use.found = true;
    out += expandIncludes(incRaw, stripComments(incRaw), resolve, depth + 1, [...chain, name], includes);
  }
  return out;
}

/** Blanks plus ( ) , : = [ ] { } — the delimiter set of ReadBraced 0xa4e880, the parameter/argument readers and
 * SubstituteArgs 0xa4e0b0 (masks 0x100002601 + 0x28000000240013 over c-0x28 + `{` `}`; 0x2400130100002601 +
 * 0x500000005 over c-0x5b). */
function isDelim(c: string | undefined): boolean {
  return isBlank(c) || c === "(" || c === ")" || c === "," || c === ":" || c === "=" || c === "[" || c === "]" || c === "{" || c === "}";
}

/** Skip delimiters, then read a token up to the next delimiter (ReadBraced / the inline argument readers). */
function readToken(text: string, at: number): { token: string; end: number } {
  let i = at;
  while (i < text.length && isDelim(text[i])) i++;
  let token = "";
  while (i < text.length && !isDelim(text[i])) token += text[i++];
  return { token, end: i };
}

interface Macro {
  params: string[];
  body: string;
}

/** Pass 3 (Gon_Pre_CollectDefines 0xa4f4a0): remove every definition; @returns the remaining text and the macros */
function collectDefines(text: string): { text: string; macros: Map<string, Macro>; names: string[] } {
  const macros = new Map<string, Macro>();
  const names: string[] = [];
  const n = text.length;
  let out = "";
  let inString = false;
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    if (inString) {
      if (c === '"' && !(i > 0 && text[i - 1] === "\\")) inString = false;
      out += c;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c !== "#" || hashWord(text, i) !== "#define") {
      out += c;
      i++;
      continue;
    }
    i = readWord(text, i).end; // consumes `#define`
    const name = readToken(text, i);
    i = name.end;
    while (i < n && isBlank(text[i])) i++;
    const params: string[] = [];
    if (text[i] === "(") {
      i++;
      // The game's loop: `)` ends the list; else blanks, delimiters (a `)` there too), a token, blanks, an optional
      // `,` + blanks. An unterminated list reads past the end of the text in the game (undefined); here it stops.
      while (i < n && text[i] !== ")") {
        const p = readToken(text, i);
        params.push(p.token);
        i = p.end;
        while (i < n && isBlank(text[i])) i++;
        if (text[i] === ",") {
          i++;
          while (i < n && isBlank(text[i])) i++;
        }
      }
      if (i < n) i++; // the `)`
    }
    let body = "";
    while (i < n) {
      if (text[i] === "#" && hashWord(text, i) === "#end") {
        i = readWord(text, i).end;
        break;
      }
      body += text[i++];
    }
    macros.set(`#${name.token}`, { params, body });
    names.push(name.token);
  }
  return { text: out, macros, names };
}

/** Gon_Pre_SubstituteArgs 0xa4e0b0: each delimiter-terminated body token equal to a parameter -> its argument. */
function substituteArgs(m: Macro, args: string[]): string {
  let out = "";
  let cur = "";
  for (const c of m.body) {
    if (!isDelim(c)) {
      cur += c;
      continue;
    }
    const k = m.params.indexOf(cur);
    if (k >= 0) cur = args[k] ?? "";
    out += cur + c;
    cur = "";
  }
  return out + cur; // the trailing token is flushed as written
}

/** One pass-4 round (Gon_Pre_ExpandMacros 0xa501c0). @returns the new text and whether any macro was expanded */
function expandMacrosOnce(text: string, macros: Map<string, Macro>): { text: string; changed: boolean } {
  const n = text.length;
  let out = "";
  let inString = false;
  let changed = false;
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    if (inString) {
      if (c === '"' && !(i > 0 && text[i - 1] === "\\")) inString = false;
      out += c;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    const m = c === "#" ? macros.get(hashWord(text, i)) : undefined;
    if (!m) {
      out += c;
      i++;
      continue;
    }
    i = readWord(text, i).end;
    const args: string[] = [];
    for (let k = 0; k < m.params.length; k++) {
      const a = readToken(text, i);
      args.push(a.token);
      i = a.end;
    }
    out += substituteArgs(m, args);
    changed = true;
  }
  return { text: out, changed };
}

/** The game's cap on pass-4 rounds (Gon_Preprocess's 4th argument: 0x100 from every GonResource caller). */
export const MACRO_PASSES = 256;

/**
 * The game's pre-pass (all four passes: `full` = 1, as GonResource::decode / combined_decode call it) over one
 * top-level GON text.
 * @param resolve include-name -> text; default: no file resolves
 */
export function preprocess(src: string, resolve: IncludeResolver = () => null): PreprocessResult {
  const includes: IncludeUse[] = [];
  const stripped = stripComments(src);
  const text = expandIncludes(src, stripped, resolve, 0, [], includes);
  const defs = collectDefines(text);
  let out = defs.text;
  let macroPasses = 0;
  if (defs.macros.size > 0) {
    while (macroPasses < MACRO_PASSES) {
      const r = expandMacrosOnce(out, defs.macros);
      if (!r.changed) break;
      out = r.text;
      macroPasses++;
    }
  }
  const result: PreprocessResult = { text: out, includes, defines: defs.names, macroPasses };
  if (macroPasses === MACRO_PASSES) result.macroRunaway = true;
  if (stripped.unclosedBlockAt !== undefined) result.unclosedComment = lineCol(src, stripped.unclosedBlockAt);
  return result;
}
