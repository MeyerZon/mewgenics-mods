// PatchMerge field-policy suffixes.
//
// Mirrors the decompiled suffix parser at RVA 0x944cc0 (Gon_PatchMerge_a_0x944cc0.c): it reads the END of a key
// and maps the first recognized suffix to a policy code. A key whose length EQUALS the suffix length qualifies
// (`9 < len` for ".overwrite" is len >= 10), so a key that is exactly ".add" carries the add policy with an empty
// name. Checks run in this exact order:
//   .overwrite -> 3, .append -> 1, .merge -> 2, .add -> 4, .multiply -> 5, none -> 0
// We use string policy names instead of the numeric codes.
//
// The NAME is what the stripper at RVA 0x944f50 (Gon_PatchMerge_b_0x944f50.c; inlined again in 0x946680 before
// the lookup) leaves: it removes each of the five suffixes once, in the same order, so stacked suffixes
// ("x.add.overwrite") strip down to "x" while "x.overwrite.add" keeps "x.overwrite" (the .overwrite check already
// ran when .add was removed).

import type { VNode } from "../gon/types.ts";

export type Policy = "overwrite" | "append" | "merge" | "add" | "multiply" | "default";

const SUFFIXES: Array<[string, Policy]> = [
  [".overwrite", "overwrite"],
  [".append", "append"],
  [".merge", "merge"],
  [".add", "add"],
  [".multiply", "multiply"],
];

/** The policy a key's suffix selects (first match in 0x944cc0's order), or "default". */
export function policyOf(key: string): Policy {
  for (const [suffix, policy] of SUFFIXES) {
    if (key.length >= suffix.length && key.endsWith(suffix)) return policy;
  }
  return "default";
}

/** A key with every recognized suffix removed the way 0x944f50 does it: each of the five once, in order. */
export function stripName(key: string): string {
  let name = key;
  for (const [suffix] of SUFFIXES) {
    if (name.length >= suffix.length && name.endsWith(suffix)) name = name.slice(0, name.length - suffix.length);
  }
  return name;
}

/** Split a key into its target name and field policy. */
export function parsePolicy(key: string): { name: string; policy: Policy } {
  return { name: stripName(key), policy: policyOf(key) };
}

/**
 * Recursively strip recognized policy suffixes from every object key in a value
 * subtree. The engine does this (RVA 0x944f50) on a patch node it copies in whole: a
 * brand-new field, an `.overwrite`, or a type-mismatch overwrite. Array items are
 * recursed into (their inner object keys are stripped) but the array branches of the
 * merge itself never call it (see merge.ts).
 */
export function stripPolicySuffixes(v: VNode): VNode {
  if (v.t === "str") return v;
  if (v.t === "arr") {
    for (const it of v.items) stripPolicySuffixes(it);
    return v;
  }
  for (const e of v.entries) {
    e.key = stripName(e.key);
    stripPolicySuffixes(e.value);
  }
  return v;
}
