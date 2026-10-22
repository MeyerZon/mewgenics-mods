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

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, serialize } from "../src/core/gon/parser.ts";
import { toValue, pretty, prettyRoot } from "../src/core/gon/value.ts";
import { scalarType, numericValue } from "../src/core/gon/typing.ts";
import { append, deepMerge, patchMerge } from "../src/core/overlay/merge.ts";
import { preprocess, stripComments } from "../src/core/gon/preprocess.ts";
import { locateInclude, preprocessFile } from "../src/core/gon-includes.ts";
import { EXTRACTED_DATA, MODS_DIR } from "../src/core/repo.ts";
import { parseScript } from "../src/core/ingame/script.ts";
import { validateMod } from "../src/core/validate/validator.ts";
import type { VNode, VScalar, VArray, VObject, VEntry } from "../src/core/gon/types.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OVERLAY_FIXTURES = join(HERE, "fixtures", "overlay");
const INCLUDE_FIXTURES = join(HERE, "fixtures", "gon-include");

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
  runGonPreprocessTests(test, assert, eq);
}

// ---- The game's text pre-pass (Gon_Preprocess 0xa50bd0, RE session inc 2026-10-22) ---------------------------------
// Every GON text the game loads (base files and every .append/.merge/.patch overlay) goes through
// Gon_Preprocess(text, resolve, 0x100, 1) before Gon_Tokenize:
//   pass 1 Gon_Pre_StripComments 0xa4eb80   `//` to end of line (the newline kept), `/* */` removed with its newlines,
//                                           no nesting, the first `*/` closes (`/*/` closes at once), unterminated
//                                           drops the rest; never inside "…" (a `"` not preceded by `\` toggles);
//                                           `#` means nothing to this pass.
//   pass 2 Gon_Pre_ExpandIncludes 0xa4edf0  outside "…", a #-word exactly `#include`, blanks (newlines too), a name
//                                           (quotes optional and dropped, a closing quote ends it) -> replaced by the
//                                           pre-passed text of resolve(name); text after the name stays; the
//                                           recursion reuses the SAME resolver (top-level resource directory).
//   passes 3/4 `#define … #end` macros (top level only) — not modelled by the editor, reported instead.
// The file layer (GonResource::decode 0x9a6100, include lambda 0x9a7610): path = <dir of the resource being loaded> +
// name, fetched as a TextResource (0x7c10e0): a mod's own copy wins, overlays on the included name are concatenated
// as text (TextResource::combined_decode 0x9a5a20 ignores the mode); missing -> fatal "Could not locate include file".

export function runGonPreprocessTests(test: TestFn, assert: AssertFn, eq: EqFn): void {
  console.log("\n# GON pre-pass (comments, #include) vs the game's Gon_Preprocess 0xa50bd0");
  const pp = (src: string, files: Record<string, string> = {}) => preprocess(src, (n) => (n in files ? files[n]! : null));

  test("gon pre-pass: `//` runs to end of line and the newline is kept", () => {
    eq(stripComments("a 1 // c\nb 2").text, "a 1 \nb 2");
  });
  test("gon pre-pass: `/* */` is removed together with the newlines inside it", () => {
    eq(stripComments("a /* x\ny */ 1").text, "a  1");
  });
  test("gon pre-pass: block comments do not nest — the first `*/` closes", () => {
    eq(stripComments("/* a /* b */ c */").text, " c */");
  });
  test("gon pre-pass: `/*/` closes at once (the `*` of the opener counts as the `*` before `/`)", () => {
    eq(stripComments("x /*/ 5\ny 6").text, "x  5\ny 6");
  });
  test("gon pre-pass: an unterminated `/*` silently drops the rest of the text", () => {
    eq(stripComments("a 1 /* b 2").text, "a 1 ");
  });
  test("gon pre-pass: an unterminated `/*` is reported with the offset of its `/` (and preprocess gives line:col)", () => {
    eq(stripComments("a 1 /* b 2").unclosedBlockAt, 4);
    eq(stripComments("a /* b */ 1").unclosedBlockAt, undefined);
    const r = preprocess("x 1\n  /* open\ny 2");
    eq(r.unclosedComment ? `${r.unclosedComment.line}:${r.unclosedComment.col}` : "none", "2:3");
  });
  test("gon pre-pass: a lone trailing `/` is kept", () => {
    eq(stripComments("a /").text, "a /");
  });
  test("gon pre-pass: comment markers inside \"…\" are text; an escaped quote does not end the string", () => {
    eq(stripComments('s "http://x /*y*/"').text, 's "http://x /*y*/"');
    eq(stripComments('s "a\\"//b" // c').text, 's "a\\"//b" ');
  });
  test("gon pre-pass: `#` is not a comment to the pre-pass — a quote inside a # comment opens a string", () => {
    const src = '# say "hi\n// kept\n"\nx 1';
    eq(stripComments(src).text, src);
  });
  test("gon pre-pass: the source map points each kept character at its source offset", () => {
    const r = stripComments("a/*xx*/b");
    eq(r.text, "ab");
    eq(r.map.join(","), "0,7");
  });
  test("gon pre-pass: `#include \"name\"` is replaced by the pre-passed included text (its comments stripped)", () => {
    const r = pp('nodes {\n  #include "std.gon"\n  x 1\n}', { "std.gon": "a 1 // c\nb 2" });
    eq(r.text, "nodes {\n  a 1 \nb 2\n  x 1\n}");
    eq(r.includes.length, 1);
    eq(r.includes[0]!.name, "std.gon");
    assert(r.includes[0]!.found, "found");
    eq(`${r.includes[0]!.line}:${r.includes[0]!.col}`, "2:3");
  });
  test("gon pre-pass: the name may be bare and may sit on the next line (blanks include newlines)", () => {
    eq(pp("#include\nstd.gon\n", { "std.gon": "a 1" }).text, "a 1\n");
  });
  test("gon pre-pass: a closing quote ends the name; text after it on the line stays", () => {
    eq(pp('#include "std.gon"z 3', { "std.gon": "a 1 " }).text, "a 1 z 3");
  });
  test("gon pre-pass: `#includes`, `#include\"x\"` and `#include` inside a string are not directives", () => {
    const calls: string[] = [];
    const r = preprocess('#includes x\n#include"y"\ns "#include z"', (n) => (calls.push(n), "!"));
    eq(r.text, '#includes x\n#include"y"\ns "#include z"');
    eq(calls.length, 0, "resolver never called");
  });
  test("gon pre-pass: `#include` inside a comment is inert (comments go first)", () => {
    const calls: string[] = [];
    const r = preprocess('// #include "a.gon"\n/* #include "b.gon" */x 1', (n) => (calls.push(n), "!"));
    eq(r.text, "\nx 1");
    eq(calls.length, 0);
  });
  test("gon pre-pass: nested includes go back to the SAME resolver with the name as written", () => {
    const calls: string[] = [];
    const files: Record<string, string> = { "a.gon": '#include "b.gon"\nfrom_a 1', "b.gon": "from_b 2 /* c */" };
    const r = preprocess('#include "a.gon"', (n) => (calls.push(n), files[n] ?? null));
    eq(calls.join(","), "a.gon,b.gon");
    eq(r.text, "from_b 2 \nfrom_a 1");
    eq(r.includes.map((i) => `${i.name}@${i.depth}`).join(","), "a.gon@0,b.gon@1");
  });
  test("gon pre-pass: a missing include is recorded (the game stops with a fatal error) and contributes no text", () => {
    const r = pp('x 1\n  #include "nope.gon"\ny 2');
    eq(r.text, "x 1\n  \ny 2");
    eq(r.includes.length, 1);
    assert(!r.includes[0]!.found, "not found");
    eq(`${r.includes[0]!.line}:${r.includes[0]!.col}`, "2:3");
  });
  test("gon pre-pass: an include cycle terminates in the editor and is flagged (the game would recurse forever)", () => {
    const r = pp('#include "a.gon"', { "a.gon": '#include "a.gon"' });
    assert(r.includes.some((i) => i.cycle === true), JSON.stringify(r.includes.slice(0, 3)));
  });
  // ---- passes 3/4: `#define … #end` macros (Gon_Pre_CollectDefines 0xa4f4a0, Gon_Pre_ExpandMacros 0xa501c0,
  // Gon_Pre_SubstituteArgs 0xa4e0b0). Vanilla uses no #define (0 of 210 files), so every case here is SYNTHETIC,
  // hand-derived from the decompiles; the in-game check is mods/_incprobe/tests/include-probe.mewtest (IncProbeMacro).
  test("gon macros: `#define NAME … #end` is removed and `#NAME` becomes the body (no parameters: body starts after the blanks)", () => {
    const r = pp("#define NODE\n shop1 { type shop }\n#end\nx { #NODE }");
    eq(r.defines.join(","), "NODE");
    eq(r.text, "\nx { shop1 { type shop }\n }");
  });
  test("gon macros: `#define NAME(a, b)` — the body starts right after `)`, `#NAME x y` substitutes whole tokens", () => {
    const r = pp("#define NODE(name, kind) name { type kind } #end\nnodes { #NODE shop1 shop #NODE camp1, camp }");
    const nodes = field(r.text, "nodes");
    if (nodes.t !== "obj") throw new Error("nodes");
    eq(nodes.entries.map((e) => `${e.key}=${e.value.t}`).join(","), "shop1=obj,camp1=obj");
    eq(r.text, "\nnodes {  shop1 { type shop }   camp1 { type camp }  }");
  });
  test("gon macros: arguments are tokens split by blanks and ( ) , : = [ ] { } — `#NAME (a, b)` works but leaves its `)`", () => {
    eq(pp("#define P(a, b) a=b #end\nv #P (x, 5)").text, "\nv  x=5 )");
    eq(pp("#define P(a, b) a=b #end\nv #P x:5").text, "\nv  x=5 ");
  });
  test("gon macros: `#NAME(a,b)` is not a call — the #-word must equal `#NAME` exactly (then the tokenizer sees a # comment)", () => {
    eq(pp("#define P(a, b) a=b #end\nv 1 #P(x,5)").text, "\nv 1 #P(x,5)");
  });
  test("gon macros: substitution is per token (blank/separator-delimited): `x_y`, `\"x\"` and `#x` are left alone", () => {
    eq(pp('#define T(x) x x_y "x" #x [x] #end\nv #T 5').text, '\nv  5 x_y "x" #x [5] ');
  });
  test("gon macros: the body's last token is substituted only when a delimiter follows it (SubstituteArgs flushes it raw)", () => {
    eq(pp("#define T(x) x#end\nv #T 5").text, "\nv  x");
  });
  test("gon macros: a space before `(` still opens a parameter list (`#define X (1)` is a 1-parameter macro)", () => {
    eq(pp("#define X (1) one #end\nv #X 9").text, "\nv  one ");
  });
  test("gon macros: expansion repeats over the whole text until a pass changes nothing (a macro may use another)", () => {
    const r = pp("#define A #B #end\n#define B 7 #end\nv #A");
    eq((field(r.text, "v") as VScalar).raw, "7");
    eq(r.macroPasses, 2, "two expanding passes");
    assert(!r.macroRunaway, "not runaway");
  });
  test("gon macros: at most 256 expanding passes (a self-referencing macro stops there)", () => {
    const r = pp("#define A #A #end\nv #A");
    eq(r.macroPasses, 256);
    assert(r.macroRunaway === true, "runaway flagged");
  });
  test("gon macros: definitions are collected before expansion (use before define works); the last definition wins", () => {
    eq((field(pp("v #A\n#define A 3 #end").text, "v") as VScalar).raw, "3");
    eq((field(pp("#define A 1 #end\n#define A 2 #end\nv #A").text, "v") as VScalar).raw, "2");
  });
  test("gon macros: nothing happens inside \"…\" (neither #define nor #NAME), and an unknown #NAME stays as text", () => {
    eq(pp('#define A 1 #end\ns "#A" t #A u #NOPE').text, '\ns "#A" t 1  u #NOPE');
    eq(pp('s "#define A 1 #end"').defines.length, 0);
  });
  test("gon macros: a #define in an included file is visible to the includer (includes are inlined first)", () => {
    eq((field(pp('#include "m.gon"\nv #A', { "m.gon": "#define A 4 #end" }).text, "v") as VScalar).raw, "4");
  });
  test("gon macros: `#end` ends the body even mid-word (the #-word test runs at every `#`)", () => {
    eq(pp("#define A 1#end\nv #A").text, "\nv 1");
  });
  test("gon tokenizer: `/*/` closes the block comment like the pre-pass (x 5, y 6)", () => {
    const r = root("x /*/ 5\ny 6");
    eq(r.entries.map((e) => `${e.key}=${(e.value as VScalar).raw}`).join(","), "x=5,y=6");
  });

  // ---- the file layer: where a name resolves -----------------------------------------------------------------------
  const BASE = join(INCLUDE_FIXTURES, "base");
  const MOD = join(INCLUDE_FIXTURES, "mods", "m");
  test("gon include path: <dir of the resource being loaded> + name (data/maps/town.gon + std_nodes.gon)", () => {
    const t = locateInclude({ resource: "data/maps/town.gon", dataRoot: BASE }, "std_nodes.gon");
    eq(t.packPath, "data/maps/std_nodes.gon");
    eq(t.source, "base");
    assert(!t.outside, "inside");
  });
  test("gon include path: never reads outside data/ (a `..` escape is refused, not read)", () => {
    const t = locateInclude({ resource: "data/maps/town.gon", dataRoot: BASE }, "../../../package.json");
    assert(t.outside, "outside");
    eq(t.source, null);
    eq(t.text, null);
  });
  // The game joins `dir + name` with no normalisation; the pack index is looked up by that exact string and a loose
  // (-modpaths) file by `<modpath> + string` through std::filesystem (FileManager_FileExists 0x9a14c0), so a `..`,
  // `.`, `\`, leading-`/` or drive-letter name never matches a pack file (fatal) and reaches the OS for loose files.
  for (const name of ["../maps/std_nodes.gon", "./std_nodes.gon", "sub/../std_nodes.gon", "/std_nodes.gon", "C:/x.gon", "sub\\deeper.gon"]) {
    test(`gon include path: \`${name}\` is not a literal pack path — flagged unsafe, never read`, () => {
      const t = locateInclude({ resource: "data/maps/town.gon", dataRoot: BASE, modDir: MOD }, name);
      assert(t.unsafe === true, `unsafe: ${JSON.stringify(t)}`);
      eq(t.source, null);
      eq(t.text, null);
    });
  }
  test("gon include path: a plain relative name (`sub/deeper.gon`) is literal and resolves", () => {
    const t = locateInclude({ resource: "data/maps/town.gon", dataRoot: BASE }, "sub/deeper.gon");
    assert(!t.unsafe, "literal");
    eq(t.packPath, "data/maps/sub/deeper.gon");
    eq(t.source, "base");
  });
  test("gon include file: base town.gon inlines std_nodes.gon and, nested, deeper.gon", () => {
    const r = preprocessFile(readFileSync(join(BASE, "maps", "town.gon"), "utf8"), { resource: "data/maps/town.gon", dataRoot: BASE });
    const nodes = field(r.text, "nodes");
    if (nodes.t !== "obj") throw new Error("nodes is an object");
    eq(nodes.entries.map((e) => e.key).join(","), "shop0,camp0,exit0");
    assert(r.includes.every((i) => i.found), JSON.stringify(r.includes));
  });
  test("gon include file: a nested include resolves against the TOP-LEVEL resource's directory", () => {
    const r = preprocessFile(readFileSync(join(BASE, "maps", "sub", "inner.gon"), "utf8"), { resource: "data/maps/inner_host.gon", dataRoot: BASE });
    const inner = field(r.text, "inner");
    if (inner.t !== "obj") throw new Error("inner is an object");
    eq(inner.entries.map((e) => e.key).join(","), "camp0", "maps/deeper.gon, not maps/sub/deeper.gon");
  });
  test("gon include file: a mod-shipped file at the mirrored path is found (mod before base)", () => {
    const t = locateInclude({ resource: "data/maps/town.gon", dataRoot: BASE, modDir: MOD }, "extra_nodes.gon");
    eq(t.source, "mod");
    assert((t.text ?? "").includes("modnode0"), String(t.text));
  });
  test("gon include file: a mod's overlay on the INCLUDED name is concatenated as text (TextResource, mode ignored)", () => {
    const t = locateInclude({ resource: "data/maps/town.gon", dataRoot: BASE, modDir: MOD }, "std_nodes.gon");
    eq(t.source, "base");
    eq(t.overlays.join(","), "data/maps/std_nodes.gon.append");
    const text = t.text ?? "";
    assert(text.indexOf("shop0") >= 0 && text.indexOf("appended0") > text.indexOf("shop0"), text);
  });
  test("gon include T1: every vanilla maps/*.gon with an #include parses after the pre-pass and gains the shared nodes", () => {
    const maps = join(EXTRACTED_DATA, "maps");
    if (!existsSync(join(maps, "standard_nodes.gon"))) {
      console.log("  (skipped: no .extracted/data/maps/standard_nodes.gon)");
      return;
    }
    const std = root(preprocessFile(readFileSync(join(maps, "standard_nodes.gon"), "utf8"), { resource: "data/maps/standard_nodes.gon" }).text);
    let n = 0;
    for (const f of readdirSync(maps).filter((x) => x.endsWith(".gon"))) {
      const src = readFileSync(join(maps, f), "utf8");
      if (!src.includes("#include")) continue;
      n++;
      const r = preprocessFile(src, { resource: `data/maps/${f}` });
      assert(r.includes.length > 0 && r.includes.every((i) => i.found), `${f}: ${JSON.stringify(r.includes)}`);
      const nodes = field(r.text, "nodes");
      if (nodes.t !== "obj") throw new Error(`${f}: nodes`);
      for (const e of std.entries) assert(nodes.entries.some((x) => x.key === e.key), `${f}: ${e.key} inlined`);
    }
    assert(n >= 19, `expected the 19 including maps, saw ${n}`);
  });

  // ---- mods/_incprobe: the in-game probe for "a mod #includes a file it ships" (+ one #define macro) ----------------
  const PROBE = join(MODS_DIR, "_incprobe");
  const NO_BASE = join(PROBE, "no-base-data");
  const probeEntry = (rel: string, resource: string, name: string): VObject => {
    const r = preprocessFile(readFileSync(join(PROBE, ...rel.split("/")), "utf8"), { resource, modDir: PROBE, dataRoot: NO_BASE });
    const e = field(r.text, name);
    if (e.t !== "obj") throw new Error(`${name} is an object`);
    return e;
  };
  const at = (o: VObject, path: string): string => {
    let n: VNode = o;
    for (const k of path.split(".")) {
      if (n.t !== "obj") return "(not an object)";
      const e: VEntry | undefined = n.entries.find((x) => x.key === k);
      if (!e) return "(missing)";
      n = e.value;
    }
    return n.t === "str" ? n.raw : `(${n.t})`;
  };
  test("_incprobe: incprobe_props.gon (shipped by the mod) resolves from data/characters/enemies.gon.append as the mod's own file", () => {
    const t = locateInclude({ resource: "data/characters/enemies.gon", modDir: PROBE, dataRoot: NO_BASE }, "incprobe_props.gon");
    eq(t.packPath, "data/characters/incprobe_props.gon");
    eq(t.source, "mod");
  });
  test("_incprobe: after the pre-pass IncProbe is a Rat variant with properties.health 77 (from the include)", () => {
    const e = probeEntry("data/characters/enemies.gon.append", "data/characters/enemies.gon", "IncProbe");
    eq(at(e, "variant_of"), "Rat");
    eq(at(e, "properties.health"), "77");
  });
  test("_incprobe: after the pre-pass IncProbeMacro (small_enemies.gon.append, a 2-argument #define) has health 55, movement 2", () => {
    const e = probeEntry("data/characters/small_enemies.gon.append", "data/characters/small_enemies.gon", "IncProbeMacro");
    eq(at(e, "variant_of"), "Rat");
    eq(at(e, "properties.health"), "55");
    eq(at(e, "properties.movement"), "2");
  });
  test("T1 _incprobe: validates with zero errors, and incprobe_props.gon is an include fragment (no whole-file-replace)", () => {
    if (!existsSync(join(EXTRACTED_DATA, "characters", "enemies.gon"))) {
      console.log("  (skipped: no .extracted/data/characters/enemies.gon)");
      return;
    }
    const r = validateMod("_incprobe");
    assert(r.ok, JSON.stringify(r.findings.filter((f) => f.severity === "error")));
    const frag = r.findings.filter((f) => f.location?.file === "mods/_incprobe/data/characters/incprobe_props.gon");
    eq(frag.map((f) => f.code).join(","), "", "no finding on the fragment");
  });
  test("_incprobe: include-probe.mewtest seeds 42, enters TacticsTest, spawns IncProbe + IncProbeMacro and checks the merged GON", () => {
    const plan = parseScript(readFileSync(join(PROBE, "tests", "include-probe.mewtest"), "utf8"), { owningMod: "_incprobe", name: "include-probe" });
    assert(plan.ok, JSON.stringify(plan.errors));
    eq(plan.mods.join(","), "_incprobe,_autoplay");
    for (const re of [/seed 42/, /enter TacticsTest/, /cmd spawn IncProbe\n/, /cmd spawn IncProbeMacro/, /expect gon 8 properties\.health == 77/, /expect gon 9 properties\.health == 55/]) {
      assert(re.test(plan.body), `${re}: ${plan.body}`);
    }
  });
}
