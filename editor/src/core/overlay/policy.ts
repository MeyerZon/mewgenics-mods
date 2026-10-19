// PatchMerge field-policy suffixes.
//
// Mirrors the decompiled suffix parser at RVA 0x944cc0 (Gon_merge_a.c): it reads
// the END of a key and maps a recognized suffix to a policy code, requiring at
// least one character before the suffix. Checks run in this exact order:
//   .overwrite -> 3, .append -> 1, .merge -> 2, .add -> 4, .multiply -> 5, none -> 0
// We use string policy names instead of the numeric codes.

/** @typedef {'overwrite'|'append'|'merge'|'add'|'multiply'|'default'} Policy */

/** @type {Array<[string, Policy]>} */
const SUFFIXES = [
  [".overwrite", "overwrite"],
  [".append", "append"],
  [".merge", "merge"],
  [".add", "add"],
  [".multiply", "multiply"],
];

/**
 * Split a key into its target name and field policy.
 * @param {string} key
 * @returns {{ name: string, policy: Policy }}
 */
export function parsePolicy(key) {
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
 * @param {import('../gon/types.ts').VNode} v
 * @returns {import('../gon/types.ts').VNode}
 */
export function stripPolicySuffixes(v) {
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
