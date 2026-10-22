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
//   passes 3/4 (top-level only) `#define NAME(args) … #end` macros, `#NAME` expansion — NOT modelled here; reported
//           in `defines` so callers can say so.
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
  /** names of `#define` macros in the top-level text (the game expands them; the editor does not) */
  defines: string[];
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

/** Names of `#define` directives outside strings (the detection half of Gon_Pre_CollectDefines 0xa4f4a0). */
function findDefines(text: string): string[] {
  const names: string[] = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '"' && !(i > 0 && text[i - 1] === "\\")) inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "#" && hashWord(text, i) === "#define") {
      const { word, end } = readWord(text, i + "#define".length);
      names.push(word.replace(/\(.*$/, ""));
      i = end - 1;
    }
  }
  return names;
}

/**
 * The game's pre-pass (passes 1 and 2; macros are only detected) over one top-level GON text.
 * @param resolve include-name -> text; default: no file resolves
 */
export function preprocess(src: string, resolve: IncludeResolver = () => null): PreprocessResult {
  const includes: IncludeUse[] = [];
  const stripped = stripComments(src);
  const text = expandIncludes(src, stripped, resolve, 0, [], includes);
  const result: PreprocessResult = { text, includes, defines: findDefines(text) };
  if (stripped.unclosedBlockAt !== undefined) result.unclosedComment = lineCol(src, stripped.unclosedBlockAt);
  return result;
}
