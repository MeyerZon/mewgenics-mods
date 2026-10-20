// PatchMerge field-policy suffixes.
//
// Mirrors the decompiled suffix parser at RVA 0x944cc0 (Gon_merge_a.c): it reads
// the END of a key and maps a recognized suffix to a policy code, requiring at
// least one character before the suffix. Checks run in this exact order:
//   .overwrite -> 3, .append -> 1, .merge -> 2, .add -> 4, .multiply -> 5, none -> 0
// We use string policy names instead of the numeric codes.

import type { VNode } from "../gon/types.ts";

export type Policy = "overwrite" | "append" | "merge" | "add" | "multiply" | "default";

const SUFFIXES: Array<[string, Policy]> = [
  [".overwrite", "overwrite"],
  [".append", "append"],
  [".merge", "merge"],
  [".add", "add"],
  [".multiply", "multiply"],
];

/** Split a key into its target name and field policy. */
export function parsePolicy(key: string): { name: string; policy: Policy } {
  for (const [suffix, policy] of SUFFIXES) {
    if (key.length > suffix.length && key.endsWith(suffix)) {
      return { name: key.slice(0, key.length - suffix.length), policy };
    }
  }
  return { name: key, policy: "default" };
}

/**
 * Recursively strip recognized policy suffixes from every object key in a value
 * subtree. The engine does this (RVA 0x944f50) when a patch introduces a brand
 * new field, since the suffix is only meaningful while merging.
 */
export function stripPolicySuffixes(v: VNode): VNode {
  if (v.t === "str") return v;
  if (v.t === "arr") {
    for (const it of v.items) stripPolicySuffixes(it);
    return v;
  }
  for (const e of v.entries) {
    e.key = parsePolicy(e.key).name;
    stripPolicySuffixes(e.value);
  }
  return v;
}
