// Overlay engine fidelity against the decompiled merge functions (T0).
//
// Each directory under fixtures/overlay/<case>/ is one pair: `base.gon`, exactly one `overlay.gon.<mode>`
// (append | merge | patch) and `expected.gon` — what the game's merge (Gon_DeepMerge_0x946680.c, i.e. the
// policy-driven merge; Gon_PatchMerge_a_0x944cc0.c the suffix parser; Gon_PatchMerge_b_0x944f50.c the
// recursive suffix stripper) produces. The comparison is structural: both sides are parsed and pretty-printed,
// so whitespace and comments never matter. See docs/data-mods.md "Fidelity to the decompiled merges".
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../src/core/gon/parser.ts";
import { toValue, prettyRoot } from "../src/core/gon/value.ts";
import { applyGonOverlay, parseOverlayName } from "../src/core/overlay/overlay.ts";
import { append } from "../src/core/overlay/merge.ts";
import { parsePolicy, stripPolicySuffixes } from "../src/core/overlay/policy.ts";
import { touchedEntries } from "../src/core/preview-merge.ts";
import type { VNode, VObject } from "../src/core/gon/types.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const OVERLAY_FIXTURES = join(HERE, "fixtures", "overlay");

function normalize(text: string): string {
  const v = toValue(parse(text));
  return prettyRoot(v.t === "obj" ? v : ({ t: "obj", entries: [] } as VObject));
}

export function runOverlayTests(test: TestFn, assert: AssertFn, eq: EqFn): void {
  console.log("\n# Overlay fidelity fixtures (fixtures/overlay/<case>: base.gon + overlay.gon.<mode> -> expected.gon)");
  const cases = existsSync(OVERLAY_FIXTURES)
    ? readdirSync(OVERLAY_FIXTURES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    : [];
  assert(cases.length > 0, `no fixture directories under ${OVERLAY_FIXTURES}`);
  for (const name of cases) {
    test(`overlay fixture ${name}`, () => {
      const dir = join(OVERLAY_FIXTURES, name);
      const overlays = readdirSync(dir).filter((f) => /^overlay\.gon\.(append|merge|patch)$/.test(f));
      eq(overlays.length, 1, `${name}: exactly one overlay.gon.<mode> file`);
      const overlayFile = overlays[0]!;
      const { mode } = parseOverlayName(overlayFile);
      const base = readFileSync(join(dir, "base.gon"), "utf8");
      const overlay = readFileSync(join(dir, overlayFile), "utf8");
      const expected = readFileSync(join(dir, "expected.gon"), "utf8");
      const { text } = applyGonOverlay(base, overlay, mode);
      eq(normalize(text), normalize(expected), `${name} (${mode})`);
    });
  }

  test("parsePolicy: a key that is exactly a suffix carries that policy (0x944cc0 accepts len == suffix len) with an empty name", () => {
    eq(parsePolicy(".add").policy, "add");
    eq(parsePolicy(".add").name, "");
    eq(parsePolicy(".overwrite").policy, "overwrite");
    eq(parsePolicy(".overwrite").name, "");
  });
  test("parsePolicy: stacked suffixes — the policy is the first match in 0x944cc0's order, the name is stripped in 0x944f50's order", () => {
    // ".overwrite" is checked first, so it is the policy; the stripper then removes ".overwrite", then ".add".
    eq(parsePolicy("x.add.overwrite").policy, "overwrite");
    eq(parsePolicy("x.add.overwrite").name, "x");
    // ".add" is the last suffix, so the policy is add; the stripper removes ".add" and stops (".overwrite" was checked earlier).
    eq(parsePolicy("x.overwrite.add").policy, "add");
    eq(parsePolicy("x.overwrite.add").name, "x.overwrite");
  });
  test("stripPolicySuffixes strips stacked suffixes the way 0x944f50 does (all five, in order, once each)", () => {
    const v = toValue(parse("a.add.overwrite 1 b.multiply.merge 2"));
    stripPolicySuffixes(v);
    if (v.t !== "obj") throw new Error("object expected");
    eq(v.entries.map((e) => e.key).join(","), "a,b");
  });

  // Gon_Append 0x945410 below the object/array branches: string+string is std::string::append (FUN_140051920); every
  // other pair (number+number, object+array, ...) logs "GON ERROR: Append incompatible types" and leaves `this` alone.
  const scalarOf = (text: string): VNode => {
    const v = toValue(parse(text));
    if (v.t !== "obj" || v.entries.length !== 1) throw new Error("one entry expected");
    return v.entries[0]!.value;
  };
  test("append: string + string concatenates (0x945410 string branch = FUN_140051920 append)", () => {
    const r = append(scalarOf('s "ab"'), scalarOf('s "cd"'));
    eq(r.t, "str");
    if (r.t !== "str") throw new Error("scalar expected");
    eq(r.raw, "abcd");
  });
  test("append: number + number is 'Append incompatible types' — the base is left unchanged", () => {
    const r = append(scalarOf("n 1"), scalarOf("n 2"));
    eq(r.t, "str");
    if (r.t !== "str") throw new Error("scalar expected");
    eq(r.num, 1);
  });
  test("append: object + array is 'Append incompatible types' — the base is left unchanged", () => {
    const r = append(scalarOf("o { a 1 }"), scalarOf("o [1 2]"));
    eq(r.t, "obj");
    if (r.t !== "obj") throw new Error("object expected");
    eq(r.entries.length, 1);
    eq(r.entries[0]!.key, "a");
  });

  // After `.append` keeps a duplicate name, the game's name index (FUN_14012a310 in 0x945410 and 0x945c30) points at
  // the LAST child of that name; a by-name lookup therefore sees the appended one. The preview's touched-entries view
  // must resolve the same way (and say the name now occurs twice), while the effective text still lists both.
  test("preview_merge touched entries: an appended duplicate resolves by name to the last occurrence, with its count", () => {
    const { base, overlay, effective, text } = applyGonOverlay("Spin { damage 10 }", "Spin { damage 5 }", "append");
    eq(effective.entries.length, 2, "the AST keeps both Spin entries");
    eq(normalize(text), normalize("Spin { damage 10 }\nSpin { damage 5 }"), "the effective text lists both");
    const t = touchedEntries(base, overlay, effective, "append");
    eq(t.length, 1);
    eq(t[0]!.key, "Spin");
    eq(t[0]!.status, "changed");
    eq(t[0]!.occurrences, 2);
    assert(/damage 5/.test(t[0]!.effective ?? ""), `effective resolves to the appended Spin, got ${t[0]!.effective}`);
    assert(/damage 10/.test(t[0]!.base ?? ""), `base is the base's Spin, got ${t[0]!.base}`);
  });
}
