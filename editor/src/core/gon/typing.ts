// GON scalar typing — the game's rule, reproduced (Gon_ParseTokens 0x93fcf0, tail; docs/data-mods.md "GON typing
// fidelity"). The tokenizer (Gon_Tokenize 0x93f090) drops the quotes of a quoted token and keeps no "was quoted"
// flag, so a scalar's type is decided purely by its text:
//
//   type = string (1);  int = strtol(text, &end, 0);  if (*end == 0) type = number (2);
//                       dbl = strtod(text, &end);     if (*end == 0) type = number (2);
//   text == "null"  -> null (0);   text == "true" -> bool true (5);   text == "false" -> bool false (5)
//
// Both numeric views are always stored on the node (`1.5` -> int 1 via strtol, double 1.5 via strtod); the merges
// (.add / .multiply in Gon_DeepMerge 0x946680) and Number() read the double, Int() reads the strtol view. The editor
// models the double view (`numericValue`) — it is the one the overlay engine needs. Consequences the game lives
// with and the editor reproduces: `"5"` is a number, `""` is the number 0 (strtol consumes nothing and `*end` is the
// NUL), `0x10` is 16, `017` is 17 (double view; Int() would say 15), `inf` / `nan` are numbers (UCRT strtod, C99),
// `5%` / `yes` / `True` are strings.
//
// strtol / strtod are emulated here for full-consumption only, per the UCRT: leading whitespace is skipped
// (" \t\n\v\f\r"), an optional sign, then base-0 integer (0x hex / leading-0 octal / decimal) or a C99 double
// (decimal with optional exponent, 0x hex float with optional p-exponent, inf / infinity / nan / nan(...),
// case-insensitive). A conversion that finds no digits leaves `end` at the start of the text.

export type GonScalarType = "string" | "number" | "bool" | "null";

const WS = new Set([" ", "\t", "\n", "\v", "\f", "\r"]);
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";
const isOct = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "7";
const isHex = (c: string | undefined): boolean => c !== undefined && /^[0-9a-fA-F]$/.test(c);

/** Index past leading whitespace and an optional sign; `neg` says whether the sign was '-'. */
function prefix(s: string): { i: number; neg: boolean } {
  let i = 0;
  while (i < s.length && WS.has(s[i]!)) i++;
  let neg = false;
  if (s[i] === "+" || s[i] === "-") {
    neg = s[i] === "-";
    i++;
  }
  return { i, neg };
}

/** strtol(s, &end, 0): `end` is the index the C call would leave, `value` the integer (unbounded). */
export function strtol(s: string): { end: number; value: number } {
  const { i: start, neg } = prefix(s);
  let i = start;
  let value = 0;
  let digits = 0;
  if (s[i] === "0" && (s[i + 1] === "x" || s[i + 1] === "X") && isHex(s[i + 2])) {
    i += 2;
    while (isHex(s[i])) {
      value = value * 16 + parseInt(s[i]!, 16);
      i++;
      digits++;
    }
  } else if (s[i] === "0") {
    while (isOct(s[i])) {
      value = value * 8 + (s.charCodeAt(i) - 48);
      i++;
      digits++;
    }
  } else {
    while (isDigit(s[i])) {
      value = value * 10 + (s.charCodeAt(i) - 48);
      i++;
      digits++;
    }
  }
  if (digits === 0) return { end: 0, value: 0 };
  return { end: i, value: neg ? -value : value };
}

/** strtod(s, &end) per the UCRT (C99): `end` as the C call would leave it, `value` the double. */
export function strtod(s: string): { end: number; value: number } {
  const { i: start, neg } = prefix(s);
  const sign = neg ? -1 : 1;
  const rest = s.slice(start);
  const lower = rest.toLowerCase();
  // inf / infinity
  if (lower.startsWith("infinity")) return { end: start + 8, value: sign * Infinity };
  if (lower.startsWith("inf")) return { end: start + 3, value: sign * Infinity };
  // nan / nan(n-char-sequence)
  if (lower.startsWith("nan")) {
    let i = start + 3;
    if (s[i] === "(") {
      let j = i + 1;
      while (j < s.length && /^[0-9A-Za-z_]$/.test(s[j]!)) j++;
      if (s[j] === ")") i = j + 1;
    }
    return { end: i, value: NaN };
  }
  // hex float: 0x hexdigits [. hexdigits] [p [+-] digits]
  if (rest[0] === "0" && (rest[1] === "x" || rest[1] === "X") && (isHex(rest[2]) || (rest[2] === "." && isHex(rest[3])))) {
    let i = start + 2;
    let mant = 0;
    let scale = 0;
    let digits = 0;
    while (isHex(s[i])) {
      mant = mant * 16 + parseInt(s[i]!, 16);
      i++;
      digits++;
    }
    if (s[i] === ".") {
      i++;
      while (isHex(s[i])) {
        mant = mant * 16 + parseInt(s[i]!, 16);
        scale -= 4;
        i++;
        digits++;
      }
    }
    if (digits === 0) return { end: 0, value: 0 };
    let exp = 0;
    if (s[i] === "p" || s[i] === "P") {
      let j = i + 1;
      let eneg = false;
      if (s[j] === "+" || s[j] === "-") {
        eneg = s[j] === "-";
        j++;
      }
      if (isDigit(s[j])) {
        let e = 0;
        while (isDigit(s[j])) {
          e = e * 10 + (s.charCodeAt(j) - 48);
          j++;
        }
        exp = eneg ? -e : e;
        i = j;
      }
    }
    return { end: i, value: sign * mant * Math.pow(2, scale + exp) };
  }
  // decimal: digits [. digits] | . digits, then optional e [+-] digits
  let i = start;
  let digits = 0;
  while (isDigit(s[i])) {
    i++;
    digits++;
  }
  if (s[i] === ".") {
    i++;
    while (isDigit(s[i])) {
      i++;
      digits++;
    }
  }
  if (digits === 0) return { end: 0, value: 0 };
  if (s[i] === "e" || s[i] === "E") {
    let j = i + 1;
    if (s[j] === "+" || s[j] === "-") j++;
    if (isDigit(s[j])) {
      while (isDigit(s[j])) j++;
      i = j;
    }
  }
  return { end: i, value: Number(s.slice(start, i)) * sign };
}

/**
 * The game's double view of a scalar, or null when neither strtol nor strtod consumes the whole text (then it is
 * not a number). strtod's value wins when both consume (`017` -> 17), strtol's when only it does.
 */
export function numericValue(text: string): number | null {
  const d = strtod(text);
  if (d.end === text.length) return d.value;
  const l = strtol(text);
  if (l.end === text.length) return l.value;
  return null;
}

/** The game's type of a scalar token's (unquoted) text. */
export function scalarType(text: string): GonScalarType {
  let type: GonScalarType = numericValue(text) === null ? "string" : "number";
  if (text === "null") type = "null";
  if (text === "true" || text === "false") type = "bool";
  return type;
}
