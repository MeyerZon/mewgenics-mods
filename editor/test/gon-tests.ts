// GON typing fidelity (T0): the editor's tokenizer / parser / value model must type a scalar the way the game
// does (Gon_Tokenize 0x93f090 -> Gon_ParseTokens 0x93fcf0, docs/data-mods.md "GON typing fidelity") while the
// serializer still emits the original bytes. Each test names the game rule it pins; the ones marked DIVERGED were
// red on 2026-10-22 and are what fix/gon-parser-fidelity changed.
//
// Game rules (OBSERVED in the decompiles):
//   tokenizer  `,` `:` `=` are whitespace; `{ } [ ]` are single tokens; `#` comments to end of line; `"` opens a
//              quoted token, `\` escapes the next char (only `\n` becomes a newline; `\t` is just `t`), the quotes
//              are dropped and NO "was quoted" flag survives.
//   parser     a scalar is a number iff strtol(tok, &end, 0) or strtod(tok, &end) consumes it entirely (so `"5"`,
//              `0x10`, `1e3`, `-3`, `.25`, `""` are numbers); exactly `true` / `false` -> bool; `null` -> null;
//              everything else (`yes`, `True`, `5%`) -> string. `{` -> object, `[` -> array. Every scalar keeps
//              its source text.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, serialize } from "../src/core/gon/parser.ts";
import { toValue, pretty, prettyRoot } from "../src/core/gon/value.ts";
import { scalarType, numericValue } from "../src/core/gon/typing.ts";
import { append, deepMerge, patchMerge } from "../src/core/overlay/merge.ts";
import type { VNode, VScalar, VArray, VObject } from "../src/core/gon/types.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OVERLAY_FIXTURES = join(HERE, "fixtures", "overlay");

function root(src: string): VObject {
  const v = toValue(parse(src));
  if (v.t !== "obj") throw new Error("root is not an object");
  return v;
}
function field(src: string, key: string): VNode {
  const r = root(src);
  const e = r.entries.find((x) => x.key === key);
  if (!e) throw new Error(`no field ${key} in ${JSON.stringify(src)}; keys: ${r.entries.map((x) => x.key).join(",")}`);
  return e.value;
}
function scalar(v: VNode): VScalar {
  if (v.t !== "str") throw new Error(`expected a scalar, got ${v.t}`);
  return v;
}
function arr(v: VNode): VArray {
  if (v.t !== "arr") throw new Error(`expected an array, got ${v.t}`);
  return v;
}
/** The one scalar in `k <src>` */
function sc(src: string): VScalar {
  return scalar(field(`k ${src}`, "k"));
}

export function runGonTests(test: TestFn, assert: AssertFn, eq: EqFn): void {
  console.log("\n# GON typing fidelity (tokenizer / parser / value model vs the game's)");

  // ---- scalar typing -------------------------------------------------------
  test("gon typing: a bare integer is a number with its text kept (5 -> number 5, raw '5')", () => {
    const s = sc("5");
    eq(s.type, "number");
    eq(s.num, 5);
    eq(s.raw, "5");
    eq(s.quoted, false);
  });
  test("gon typing: a quoted numeric is a number too — the game drops the quotes before typing (DIVERGED)", () => {
    const s = sc('"5"');
    eq(s.type, "number", '"5" type');
    eq(s.num, 5, '"5" num');
    eq(s.raw, "5");
    eq(s.quoted, true, "the quoted flag survives for round-tripping");
    const neg = sc('"-2.5"');
    eq(neg.type, "number");
    eq(neg.num, -2.5);
  });
  test("gon typing: the AST scalar node carries the game's type as well (parse(...).type)", () => {
    const r = parse('a "5" b yes c true');
    const types = r.fields.map((f) => (f.value.kind === "scalar" ? f.value.type : f.value.kind));
    eq(types.join(","), "number,string,bool");
  });
  test("gon typing: hex 0x10 is a number (strtol base 0) = 16 (DIVERGED)", () => {
    const s = sc("0x10");
    eq(s.type, "number");
    eq(s.num, 16);
    eq(s.raw, "0x10", "source text kept");
    eq(sc("0X1f").num, 31);
  });
  test("gon typing: 1e3, -3, .25, 5., +7, 1.5 are numbers (strtod / strtol consume them entirely)", () => {
    eq(sc("1e3").type, "number");
    eq(sc("1e3").num, 1000);
    eq(sc("-3").num, -3);
    eq(sc(".25").num, 0.25);
    eq(sc("5.").num, 5);
    eq(sc("+7").num, 7);
    eq(sc("1.5").num, 1.5);
    eq(sc("1E-2").num, 0.01);
  });
  test("gon typing: a leading-zero integer is a number; its double view is decimal (017 -> 17, the merges use the double)", () => {
    const s = sc("017");
    eq(s.type, "number");
    eq(s.num, 17);
  });
  test("gon typing: exactly true / false are bools; True, TRUE, yes, no, 1 are not (DIVERGED: quoted \"true\" is a bool as well)", () => {
    eq(sc("true").type, "bool");
    eq(sc("false").type, "bool");
    eq(sc("true").num, null, "a bool has no numeric view");
    eq(sc("True").type, "string");
    eq(sc("TRUE").type, "string");
    eq(sc("yes").type, "string");
    eq(sc("no").type, "string");
    eq(sc("1").type, "number");
    eq(sc('"true"').type, "bool", 'quoted "true" is still the bool token');
  });
  test("gon typing: null is the null type (quoted or not); nulls, NULL are strings", () => {
    eq(sc("null").type, "null");
    eq(sc('"null"').type, "null");
    eq(sc("null").num, null);
    eq(sc("nulls").type, "string");
    eq(sc("NULL").type, "string");
  });
  test("gon typing: 5% is a string (Percent() reads it); so are 3+bonus, pt-br, 2-X, 1.2.3, 0x, +, -, a trailing-space quoted \"5 \"", () => {
    for (const t of ["5%", "3+bonus_melee_ability_damage", "pt-br", "2-X", "1.2.3", "0x", "+", "-", "e3", "1e", '"5 "']) {
      eq(sc(t).type, "string", `${t} type`);
      eq(sc(t).num, null, `${t} num`);
    }
  });
  test("gon typing: an empty quoted token \"\" is a number 0 in the game (strtol consumes nothing and stops at the NUL) — raw stays empty (DIVERGED)", () => {
    const s = sc('""');
    eq(s.type, "number");
    eq(s.num, 0);
    eq(s.raw, "");
    eq(s.quoted, true);
  });
  test("gon typing: a quoted token with leading whitespace is a number — strtol / strtod skip it (\" 5\" -> 5)", () => {
    eq(sc('" 5"').type, "number");
    eq(sc('" 5"').num, 5);
  });
  test("gon typing: inf / nan spellings are numbers under the UCRT strtod (C99); vanilla data has none", () => {
    eq(sc("inf").type, "number");
    eq(sc("inf").num, Infinity);
    eq(sc("-Infinity").num, -Infinity);
    eq(sc("nan").type, "number");
    assert(Number.isNaN(sc("nan").num), "nan num is NaN");
  });
  test("gon typing: scalarType / numericValue are the one rule (used by the AST and the value model)", () => {
    eq(scalarType("5"), "number");
    eq(scalarType("true"), "bool");
    eq(scalarType("null"), "null");
    eq(scalarType("yes"), "string");
    eq(numericValue("0x10"), 16);
    eq(numericValue("5%"), null);
    eq(numericValue(""), 0);
  });

  // ---- tokenizer: separators, comments, escapes, adjacency -------------------
  test("gon tokenizer: `,` `:` `=` are whitespace — a=5, a:5, a = 5 and [1,2,3] all parse like spaces (DIVERGED for : and =)", () => {
    eq(scalar(field("a=5", "a")).num, 5, "a=5");
    eq(scalar(field("a:5", "a")).num, 5, "a:5");
    eq(scalar(field("a = 5", "a")).num, 5, "a = 5");
    eq(scalar(field("a:=5,", "a")).num, 5, "a:=5,");
    eq(arr(field("a [1,2,3]", "a")).items.length, 3, "[1,2,3]");
    eq(arr(field("a [1:2=3]", "a")).items.length, 3, "[1:2=3]");
    const r = root("a=1,b:2\nc = 3");
    eq(r.entries.map((e) => e.key).join(","), "a,b,c");
  });
  test("gon tokenizer: separators and comments live in the trivia — serialize(parse(x)) is byte-exact for a=5 / a:5 / #", () => {
    for (const src of ["a=5\n", "a:5", "a = 5 , b = \"6\"\n", "a [1,2,3]\n", "x 1 # a comment\ny 2\n", "x 1 #no newline at end", "k \"\"\n", "k \"a\\nb\"\n"]) {
      eq(serialize(parse(src)), src, `round trip of ${JSON.stringify(src)}`);
    }
  });
  test("gon tokenizer: `#` starts a line comment anywhere, ending the pending token (a#b 1 -> a, then comment)", () => {
    const r = root("x 1 # trailing { not a brace\ny 2");
    eq(r.entries.map((e) => e.key).join(","), "x,y");
    eq(scalar(field("v 5#comment\nw 6", "v")).num, 5, "5#comment is 5 then a comment");
  });
  test("gon tokenizer: `\\` escapes inside quotes — only \\n becomes a newline; \\t is t, \\\" is \", \\\\ is \\ (DIVERGED for \\t / \\r)", () => {
    eq(sc('"x\\ny"').raw, "x\ny", "\\n");
    eq(sc('"x\\ty"').raw, "xty", "\\t is a literal t in the game");
    eq(sc('"x\\ry"').raw, "xry", "\\r is a literal r in the game");
    eq(sc('"q\\"q"').raw, 'q"q', '\\"');
    eq(sc('"b\\\\s"').raw, "b\\s", "\\\\");
    eq(sc('"a\\/b"').raw, "a/b", "\\/");
    eq(sc('"a\\zb"').raw, "azb", "unknown escape keeps the char");
  });
  test("gon tokenizer: raw tabs and newlines inside quotes are kept as-is", () => {
    eq(sc('"a\tb"').raw, "a\tb");
    eq(sc('"a\nb"').raw, "a\nb");
    eq(scalarType("a\tb"), "string");
  });
  test("gon tokenizer: `{` `}` `[` `]` are single tokens — a{b 1} and a[1] need no space; so does a quoted key", () => {
    const o = field("a{b 1}c[2]", "a");
    eq(o.t, "obj");
    if (o.t !== "obj") return;
    eq(scalar(o.entries[0]!.value).num, 1);
    eq(arr(field("a{b 1}c[2]", "c")).items.length, 1);
    eq(scalar(field('"a"5', "a")).num, 5, '"a"5: a quoted token flushes and the bare one follows');
    eq(scalar(field('a"5"b 6', "a")).raw, "5", 'a"5": the bare token flushes at the quote');
  });
  test("gon tokenizer: `//` and `/* */` are stripped before the game's tokenizer sees them (188 / 35 of 210 vanilla files use them; the tokenizer itself has no `//`) — kept as comments", () => {
    const r = root("a 1 // c { \nb 2 /* x [ */ c 3");
    eq(r.entries.map((e) => e.key).join(","), "a,b,c");
    eq(serialize(parse("a 1 // c\n")), "a 1 // c\n");
  });

  // ---- the value model's pretty-printer must emit what the game reads back ----
  test("gon pretty: a string holding = : , or whitespace is quoted so the game does not split it (DIVERGED for = and :)", () => {
    const q = (raw: string): string => pretty({ t: "str", raw, quoted: false, num: null, type: "string" });
    eq(q("a=b"), '"a=b"');
    eq(q("a:b"), '"a:b"');
    eq(q("a,b"), '"a,b"');
    eq(q("a b"), '"a b"');
    eq(q("plain"), "plain");
  });
  test("gon pretty: every scalar survives pretty -> parse with the game's escapes (tabs raw, newlines as \\n, quotes and backslashes escaped)", () => {
    for (const raw of ["a=b", "tab\there", "nl\nhere", 'q"q', "back\\slash", "cr\rhere", "", "5", "x#y", "p{q"]) {
      const out = prettyRoot({ t: "obj", entries: [{ key: "k", value: { t: "str", raw, quoted: false, num: null, type: "string" } }] });
      eq(sc(out.slice(2).trimEnd()).raw, raw, `pretty -> parse of ${JSON.stringify(raw)} via ${JSON.stringify(out)}`);
    }
  });
  test("gon pretty: a quoted number keeps its quotes and a bare one stays bare (byte-faithful preview)", () => {
    eq(pretty(sc('"5"')), '"5"');
    eq(pretty(sc("5")), "5");
  });

  // ---- overlay engine: numeric policies see the game's numbers -----------------
  test("gon overlay: patch .add / .multiply treat a quoted numeric as a number — x \"10\" + x.add 5 = 15 (DIVERGED)", () => {
    const r = patchMerge(root('x "10"'), root("x.add 5"));
    const x = scalar((r as VObject).entries[0]!.value);
    eq(x.num, 15);
    eq(x.type, "number");
    eq(x.raw, "15");
    const m = patchMerge(root("x 10"), root('x.multiply "3"'));
    eq(scalar((m as VObject).entries[0]!.value).num, 30);
  });
  test("gon overlay: deepMerge / append keep the game's type on a quoted numeric", () => {
    const r = deepMerge(root("x 1"), root('x "2"'));
    const x = scalar((r as VObject).entries[0]!.value);
    eq(x.type, "number");
    eq(x.num, 2);
    eq(x.quoted, true);
    const a = append(root("x 1"), root('y "2"'));
    eq(scalar((a as VObject).entries[1]!.value).type, "number");
  });
  test("gon overlay fixture: every test/fixtures/overlay/<name>/ (base.gon + overlay.gon.<mode> -> expected.gon) matches", () => {
    const names = readdirSync(OVERLAY_FIXTURES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    assert(names.length > 0, "at least one overlay fixture");
    for (const name of names) {
      const dir = join(OVERLAY_FIXTURES, name);
      const overlayFile = readdirSync(dir).find((f) => f.startsWith("overlay.gon."));
      if (!overlayFile) throw new Error(`${name}: no overlay.gon.<mode>`);
      const mode = overlayFile.slice("overlay.gon.".length);
      const base = root(readFileSync(join(dir, "base.gon"), "utf8"));
      const overlay = root(readFileSync(join(dir, overlayFile), "utf8"));
      const expected = root(readFileSync(join(dir, "expected.gon"), "utf8"));
      const fn = mode === "append" ? append : mode === "merge" ? deepMerge : mode === "patch" ? patchMerge : null;
      if (!fn) throw new Error(`${name}: unknown mode ${mode}`);
      const got = fn(base, overlay);
      eq(pretty(got), pretty(expected), `fixture ${name}`);
    }
  });
}
