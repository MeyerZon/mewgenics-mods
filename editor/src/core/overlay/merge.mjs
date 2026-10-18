// The GON overlay engine: Append, DeepMerge, and PatchMerge.
//
// Semantics are taken from docs/data-mods.md and cross-checked against the
// decompiled merge functions:
//   - Append    (X.gon.append): add the overlay's children at the end.
//   - DeepMerge (X.gon.merge):  matching fields merge recursively, new fields
//                               append, mismatched types overwrite.
//   - PatchMerge(X.gon.patch):  like merge, but each field's key suffix picks a
//                               policy (overwrite/append/merge/add/multiply),
//                               per the decompiled PatchMerge at RVA 0x946680.
//
// Numbers:  .add => base + patch,  .multiply => base * patch, else overwrite.
// Arrays:   .append/.add => concat;  merge/default/multiply => element-wise by
//           index (extra patch items appended);  .overwrite => replace whole.
// Objects:  .overwrite => replace;  otherwise per-child, each child using its own
//           suffix policy (recurse if the field exists, else append the new field
//           with suffixes stripped); no-suffix children under an append/add parent
//           are appended, otherwise merged-if-present / appended-if-absent.
// Type mismatch (including bool/null vs other) => overwrite.
//
// Every operation works on deep clones and never mutates its inputs.

import { clone, findIndex, numberNode } from "../gon/value.mjs";
import { parsePolicy, stripPolicySuffixes } from "./policy.mjs";

/** @typedef {import('../gon/types.mjs').VNode} VNode */
/** @typedef {import('../gon/types.mjs').VObject} VObject */
/** @typedef {import('../gon/types.mjs').VArray} VArray */
/** @typedef {import('../gon/types.mjs').VScalar} VScalar */
/** @typedef {import('./policy.mjs').Policy} Policy */

/**
 * @param {VNode} v
 * @returns {v is VScalar}
 */
function isNumber(v) {
  return v.t === "str" && v.num !== null;
}

/**
 * Append: concatenate the overlay's children onto a clone of the base.
 * @param {VNode} base
 * @param {VNode} overlay
 * @returns {VNode}
 */
export function append(base, overlay) {
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

/**
 * DeepMerge into a clone of the base.
 * @param {VNode} base
 * @param {VNode} overlay
 * @returns {VNode}
 */
export function deepMerge(base, overlay) {
  return mergeValue(clone(base), overlay);
}

/**
 * @param {VNode} b  (already a private clone; mutated in place)
 * @param {VNode} o
 * @returns {VNode}
 */
function mergeValue(b, o) {
  if (b.t === "obj" && o.t === "obj") {
    for (const oe of o.entries) {
      const i = findIndex(b, oe.key);
      if (i >= 0) b.entries[i].value = mergeValue(b.entries[i].value, oe.value);
      else b.entries.push({ key: oe.key, value: clone(oe.value) });
    }
    return b;
  }
  if (b.t === "arr" && o.t === "arr") {
    for (let k = 0; k < o.items.length; k++) {
      if (k < b.items.length) b.items[k] = mergeValue(b.items[k], o.items[k]);
      else b.items.push(clone(o.items[k]));
    }
    return b;
  }
  return clone(o); // scalar or type mismatch -> overwrite
}

/**
 * PatchMerge into a clone of the base (root policy is the default).
 * @param {VNode} base
 * @param {VNode} overlay
 * @returns {VNode}
 */
export function patchMerge(base, overlay) {
  return patchValue(clone(base), overlay, "default");
}

/**
 * Apply `overlay` into `b` (a private clone) under `policy` (the policy carried
 * by the overlay node's own key).
 * @param {VNode} b
 * @param {VNode} o
 * @param {Policy} policy
 * @returns {VNode}
 */
export function patchValue(b, o, policy) {
  // Numbers: add / multiply / overwrite.
  if (isNumber(b) && isNumber(o)) {
    const bn = /** @type {VScalar} */ (b).num ?? 0;
    const on = /** @type {VScalar} */ (o).num ?? 0;
    if (policy === "add") return numberNode(bn + on);
    if (policy === "multiply") return numberNode(bn * on);
    return clone(o);
  }

  // Both scalar (string/bool, not both numeric) -> overwrite.
  if (b.t === "str" && o.t === "str") return clone(o);

  // Objects.
  if (b.t === "obj" && o.t === "obj") {
    if (policy === "overwrite") return clone(o);
    for (const oe of o.entries) {
      const { name, policy: childPolicy } = parsePolicy(oe.key);
      if (childPolicy !== "default") {
        const i = findIndex(b, name);
        if (i < 0) {
          b.entries.push({ key: name, value: stripPolicySuffixes(clone(oe.value)) });
        } else {
          b.entries[i].value = patchValue(b.entries[i].value, oe.value, childPolicy);
        }
      } else if (policy === "append" || policy === "add") {
        b.entries.push({ key: oe.key, value: stripPolicySuffixes(clone(oe.value)) });
      } else {
        const i = findIndex(b, oe.key);
        if (i < 0) b.entries.push({ key: oe.key, value: stripPolicySuffixes(clone(oe.value)) });
        else b.entries[i].value = patchValue(b.entries[i].value, oe.value, "default");
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
    if (policy === "overwrite") return clone(o);
    // default / merge / multiply -> element-wise by index.
    for (let k = 0; k < o.items.length; k++) {
      if (k < b.items.length) b.items[k] = patchValue(b.items[k], o.items[k], "default");
      else b.items.push(clone(o.items[k]));
    }
    return b;
  }

  // Type mismatch -> overwrite.
  return clone(o);
}
