// GON tokenizer.
//
// Produces a flat token list where every byte of the source is accounted for:
// each token carries the exact `leading` trivia (whitespace, commas, and
// comments) that preceded it. Concatenating `leading + text` across all tokens
// (including the final `eof` token, whose `leading` holds any trailing trivia)
// reproduces the input byte-for-byte. This is what makes round-tripping faithful.
//
// GON facts honored here (observed in the extracted base data + gon.h behavior):
//  - Objects `{ }`, arrays `[ ]`.
//  - Bare tokens run until whitespace / comma / structural char / quote / comment.
//    Examples: `3+bonus_melee_ability_damage`, `.25`, `character_to_tile`, `pt-br`.
//  - Quoted strings `"..."` with backslash escapes.
//  - Commas are optional separators (treated as whitespace) — seen in
//    `[idle, FighterIdle]`.
//  - Comments: `// line`, `# line`, and `/* block */`.

/** @typedef {import('./types.ts').Token} Token */

const SPACE = new Set([" ", "\t", "\r", "\n", ","]);
/** @type {Record<string, 'lbrace'|'rbrace'|'lbracket'|'rbracket'>} */
const STRUCT = { "{": "lbrace", "}": "rbrace", "[": "lbracket", "]": "rbracket" };

/**
 * Decode a quoted GON string's inner escapes.
 * @param {string} inner raw characters between the quotes
 * @returns {string}
 */
function decodeEscapes(inner) {
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "\\" && i + 1 < inner.length) {
      const n = inner[i + 1];
      i++;
      if (n === "n") out += "\n";
      else if (n === "t") out += "\t";
      else if (n === "r") out += "\r";
      else if (n === '"') out += '"';
      else if (n === "\\") out += "\\";
      else if (n === "/") out += "/";
      else out += n; // unknown escape: keep the escaped char literally
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * Tokenize GON source.
 * @param {string} src
 * @returns {Token[]}
 */
export function tokenize(src) {
  /** @type {Token[]} */
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const n = src.length;

  /** advance one char, maintaining line/col */
  function adv() {
    const c = src[i];
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
  function scanTrivia() {
    const start = i;
    for (;;) {
      if (i >= n) break;
      const c = src[i];
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
        while (i < n && !(src[i] === "*" && src[i + 1] === "/")) adv();
        if (i < n) {
          adv();
          adv();
        }
        continue;
      }
      break;
    }
    return src.slice(start, i);
  }

  /** true if `c` ends a bare token @param {string} c */
  function isBareTerminator(c) {
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
    const c = src[i];
    const st = STRUCT[c];
    if (st) {
      adv();
      tokens.push({
        type: /** @type {Token['type']} */ (st),
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
        const ch = src[i];
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
      const ch = src[i];
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
