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
import { parsePolicy, stripPolicySuffixes } from "../src/core/overlay/policy.ts";
import type { VObject } from "../src/core/gon/types.ts";
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
}
