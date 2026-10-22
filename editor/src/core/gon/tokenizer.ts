// GON tokenizer.
//
// Produces a flat token list where every byte of the source is accounted for:
// each token carries the exact `leading` trivia (whitespace, commas, and
// comments) that preceded it. Concatenating `leading + text` across all tokens
// (including the final `eof` token, whose `leading` holds any trailing trivia)
// reproduces the input byte-for-byte. This is what makes round-tripping faithful.
//
// GON facts honored here (OBSERVED in Gon_Tokenize 0x93f090, docs/data-mods.md "GON typing fidelity"):
//  - Objects `{ }`, arrays `[ ]`: single-character tokens, no space needed around them (`a{b 1}`).
//  - `,` `:` `=` are whitespace, exactly like space / tab / CR / LF — `a=5`, `a:5`, `[1,2,3]`.
//  - Bare tokens run until whitespace / a structural char / `"` / `#`.
//    Examples: `3+bonus_melee_ability_damage`, `.25`, `character_to_tile`, `pt-br`.
//  - Quoted tokens `"..."`: `\` escapes the next character and only `\n` means a newline (`\t` is a plain `t`);
//    the quotes are dropped by the game and leave no flag — `quoted` here exists for round-tripping only.
//  - `#` starts a comment to end of line, even in the middle of a bare token.
//  - `//` and `/* */` are not in the game's tokenizer: the pre-pass `Gon_Preprocess` 0xa50bd0 strips them first
//    (OBSERVED, `Gon_Pre_StripComments` 0xa4eb80; ported in ./preprocess.ts). Here both stay as trivia so editing
//    round-trips; the rules match the pre-pass except where it interacts with `#` comments (it does not know them:
//    a `/*` or `"` inside a `#` comment still counts to it) — the semantic readers parse preprocess() output.
//  - `#include "x"` is a `#` comment to the tokenizer (trivia); the pre-pass inlines it before tokenizing
//    (./preprocess.ts, ../gon-includes.ts).

import type { Token, TokenType } from "./types.ts";

const SPACE = new Set([" ", "\t", "\r", "\n", ",", ":", "="]);
const STRUCT: Record<string, Exclude<TokenType, "string" | "eof">> = { "{": "lbrace", "}": "rbrace", "[": "lbracket", "]": "rbracket" };

/**
 * Decode a quoted GON string's inner escapes the way Gon_Tokenize does: `\n` is a newline, every other escaped
 * character is itself (`\"` -> `"`, `\\` -> `\`, `\t` -> `t`).
 * @param inner raw characters between the quotes
 */
function decodeEscapes(inner: string): string {
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c === "\\" && i + 1 < inner.length) {
      const n = inner[i + 1]!;
      i++;
      out += n === "n" ? "\n" : n;
    } else {
      out += c;
    }
  }
  return out;
}

/** Tokenize GON source. */
export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const n = src.length;

  /** advance one char, maintaining line/col */
  function adv(): string {
    const c = src[i]!;
    if (c === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
    i++;
    return c;
  }

  /** scan trivia (whitespace, commas, comments); return its text */
  function scanTrivia(): string {
    const start = i;
    for (;;) {
      if (i >= n) break;
      const c = src[i]!;
      if (SPACE.has(c)) {
        adv();
        continue;
      }
      if (c === "#") {
        while (i < n && src[i] !== "\n") adv();
        continue;
      }
      if (c === "/" && src[i + 1] === "/") {
        while (i < n && src[i] !== "\n") adv();
        continue;
      }
      if (c === "/" && src[i + 1] === "*") {
        adv();
        adv();
        // Gon_Pre_StripComments 0xa4eb80 closes at a `/` whose previous char is `*` — the opener's `*` counts, so
        // `/*/` closes at once; no nesting; unterminated runs to the end.
        while (i < n && !(src[i] === "/" && src[i - 1] === "*")) adv();
        if (i < n) adv();
        continue;
      }
      break;
    }
    return src.slice(start, i);
  }

  /** true if `c` ends a bare token */
  function isBareTerminator(c: string): boolean {
    if (SPACE.has(c)) return true;
    if (c === '"' || c === "#") return true;
    if (STRUCT[c]) return true;
    return false;
  }

  for (;;) {
    const leading = scanTrivia();
    const pos = { offset: i, line, col };
    if (i >= n) {
      tokens.push({ type: "eof", text: "", leading, pos });
      break;
    }
    const c = src[i]!;
    const st = STRUCT[c];
    if (st) {
      adv();
      tokens.push({
        type: st,
        text: c,
        leading,
        pos,
      });
      continue;
    }
    if (c === '"') {
      const start = i;
      adv(); // opening quote
      let inner = "";
      while (i < n) {
        const ch = src[i]!;
        if (ch === "\\" && i + 1 < n) {
          inner += src[i] + src[i + 1];
          adv();
          adv();
          continue;
        }
        if (ch === '"') break;
        inner += ch;
        adv();
      }
      if (i < n) adv(); // closing quote
      tokens.push({
        type: "string",
        text: src.slice(start, i),
        leading,
        value: decodeEscapes(inner),
        quoted: true,
        pos,
      });
      continue;
    }
    // bare token
    const start = i;
    while (i < n) {
      const ch = src[i]!;
      if (isBareTerminator(ch)) break;
      if (ch === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) break;
      adv();
    }
    const text = src.slice(start, i);
    tokens.push({
      type: "string",
      text,
      leading,
      value: text,
      quoted: false,
      pos,
    });
  }

  return tokens;
}
