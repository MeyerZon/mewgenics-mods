// The GON overlay engine: Append, DeepMerge, and PatchMerge.
//
// Semantics are taken from docs/data-mods.md ("Fidelity to the decompiled merges") and cross-checked against the
// decompiled functions in .analysis/decompiled/:
//   - Gon_PatchMerge_a_0x944cc0.c — the key-suffix -> policy parser (policy.ts).
//   - Gon_PatchMerge_b_0x944f50.c — the recursive suffix stripper (policy.ts).
//   - Gon_DeepMerge_0x946680.c    — the policy-driven merge the `.patch` engine below reproduces step by step.
//   The functions behind `.append` and `.merge` files (GON's Append and the suffix-blind DeepMerge) are NOT on
//   disk; `append` / `deepMerge` here follow docs/data-mods.md and the in-game observations of mods/_golden-merge.
//
// PatchMerge (0x946680), with `policy` = the suffix of the patch node's own key:
//   Numbers:  .add => base + patch,  .multiply => base * patch, else overwrite.
//   Strings:  .append/.add => base + patch (string concatenation), else overwrite. Bools overwrite.
//   Arrays:   .append/.add => concat;  default/.merge/.multiply => element-wise by index (extra patch items
//             appended);  .overwrite => replace whole (suffixes stripped). Array pushes never strip suffixes.
//   Objects:  .overwrite => replace (suffixes stripped);  otherwise per-child, each child using its own suffix
//             policy (recurse if the field exists, else append the new field with suffixes stripped); no-suffix
//             children under an append/add parent are appended, otherwise merged-if-present / appended-if-absent.
//             Duplicate keys match by occurrence: the nth patch child named X (suffixed children count under
//             their stripped name) merges into the nth base child named X. A child whose key is exactly a suffix
//             (`.add { … }`) applies its value to the parent itself under that policy.
//   Type mismatch (including bool/null vs other) => overwrite (suffixes stripped).
//
// Every operation works on deep clones and never mutates its inputs.

import { clone, findIndex, numberNode } from "../gon/value.ts";
import { parsePolicy, stripPolicySuffixes } from "./policy.ts";
import type { VNode, VObject, VScalar } from "../gon/types.ts";
import type { Policy } from "./policy.ts";

function isNumber(v: VNode): v is VScalar {
  return v.t === "str" && v.num !== null;
}

/** A GON string: a scalar that is neither a number nor a bare `true`/`false` (GON's bool type). */
function isGonString(v: VNode): v is VScalar {
  return v.t === "str" && v.num === null && !(!v.quoted && (v.raw === "true" || v.raw === "false"));
}

/** Index of the nth (0-based) entry with the given key, or -1. */
function findNthIndex(obj: VObject, key: string, nth: number): number {
  let seen = 0;
  for (let i = 0; i < obj.entries.length; i++) {
    if (obj.entries[i]!.key === key && seen++ === nth) return i;
  }
  return -1;
}

/** Append: concatenate the overlay's children onto a clone of the base. */
export function append(base: VNode, overlay: VNode): VNode {
  const b = clone(base);
  if (b.t === "obj" && overlay.t === "obj") {
    for (const e of overlay.entries) b.entries.push({ key: e.key, value: clone(e.value) });
    return b;
  }
  if (b.t === "arr" && overlay.t === "arr") {
    for (const it of overlay.items) b.items.push(clone(it));
    return b;
  }
  // Nothing sensible to append onto a mismatch; overlay wins.
  return clone(overlay);
}

/** DeepMerge into a clone of the base. */
export function deepMerge(base: VNode, overlay: VNode): VNode {
  return mergeValue(clone(base), overlay);
}

/** @param b already a private clone; mutated in place */
function mergeValue(b: VNode, o: VNode): VNode {
  if (b.t === "obj" && o.t === "obj") {
    for (const oe of o.entries) {
      const i = findIndex(b, oe.key);
      if (i >= 0) b.entries[i]!.value = mergeValue(b.entries[i]!.value, oe.value);
      else b.entries.push({ key: oe.key, value: clone(oe.value) });
    }
    return b;
  }
  if (b.t === "arr" && o.t === "arr") {
    for (let k = 0; k < o.items.length; k++) {
      if (k < b.items.length) b.items[k] = mergeValue(b.items[k]!, o.items[k]!);
      else b.items.push(clone(o.items[k]!));
    }
    return b;
  }
  return clone(o); // scalar or type mismatch -> overwrite
}

/** PatchMerge into a clone of the base (root policy is the default). */
export function patchMerge(base: VNode, overlay: VNode): VNode {
  return patchValue(clone(base), overlay, "default");
}

/** The whole-node overwrite of 0x946680's LAB_140947159: copy the patch node, then strip suffixes under it. */
function overwriteWith(o: VNode): VNode {
  return stripPolicySuffixes(clone(o));
}

/**
 * Apply `overlay` into `b` (a private clone) under `policy` (the policy carried
 * by the overlay node's own key).
 */
export function patchValue(b: VNode, o: VNode, policy: Policy): VNode {
  // Numbers: add / multiply / overwrite.
  if (isNumber(b) && isNumber(o)) {
    const bn = b.num ?? 0;
    const on = o.num ?? 0;
    if (policy === "add") return numberNode(bn + on);
    if (policy === "multiply") return numberNode(bn * on);
    return clone(o);
  }

  // Strings: append / add concatenate, everything else overwrites.
  if (isGonString(b) && isGonString(o)) {
    if (policy === "append" || policy === "add") {
      return { t: "str", raw: b.raw + o.raw, quoted: b.quoted || o.quoted, num: null };
    }
    return clone(o);
  }

  // Any other scalar pair (bools, number vs string, ...) -> overwrite.
  if (b.t === "str" && o.t === "str") return clone(o);

  // Objects.
  if (b.t === "obj" && o.t === "obj") {
    if (policy === "overwrite") return overwriteWith(o);
    // Per-call occurrence counter: the nth patch child named X targets the nth base child named X.
    const seen = new Map<string, number>();
    const nth = (name: string): number => seen.get(name) ?? 0;
    const bump = (name: string): void => { seen.set(name, nth(name) + 1); };
    for (const oe of o.entries) {
      const { name, policy: childPolicy } = parsePolicy(oe.key);
      if (childPolicy !== "default") {
        if (name === "") {
          // A key that is exactly a suffix: merge its value into this node itself under that policy.
          const self = patchValue(b, oe.value, childPolicy);
          if (self.t !== "obj") return self; // this node is no longer an object; nothing more can land on it
          b = self;
          continue;
        }
        const i = findNthIndex(b, name, nth(name));
        if (i < 0) {
          b.entries.push({ key: name, value: stripPolicySuffixes(clone(oe.value)) });
        } else {
          b.entries[i]!.value = patchValue(b.entries[i]!.value, oe.value, childPolicy);
        }
        bump(name);
      } else if (policy === "append" || policy === "add") {
        b.entries.push({ key: oe.key, value: stripPolicySuffixes(clone(oe.value)) });
      } else {
        const i = findNthIndex(b, oe.key, nth(oe.key));
        if (i < 0) b.entries.push({ key: oe.key, value: stripPolicySuffixes(clone(oe.value)) });
        else b.entries[i]!.value = patchValue(b.entries[i]!.value, oe.value, "default");
        bump(oe.key);
      }
    }
    return b;
  }

  // Arrays.
  if (b.t === "arr" && o.t === "arr") {
    if (policy === "append" || policy === "add") {
      for (const it of o.items) b.items.push(clone(it));
      return b;
    }
    if (policy === "overwrite") return overwriteWith(o);
    // default / merge / multiply -> element-wise by index.
    for (let k = 0; k < o.items.length; k++) {
      if (k < b.items.length) b.items[k] = patchValue(b.items[k]!, o.items[k]!, "default");
      else b.items.push(clone(o.items[k]!));
    }
    return b;
  }

  // Type mismatch -> overwrite.
  return overwriteWith(o);
}
