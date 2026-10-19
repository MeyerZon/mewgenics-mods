// Conversion between the faithful AST and the plain, order-preserving "value
// model" used by the overlay/merge engine and by merge-preview. The value model
// deliberately drops trivia: merge results are pretty-printed, not round-tripped.

/** @typedef {import('./types.ts').Node} Node */
/** @typedef {import('./types.ts').VNode} VNode */
/** @typedef {import('./types.ts').VObject} VObject */
/** @typedef {import('./types.ts').VArray} VArray */
/** @typedef {import('./types.ts').VScalar} VScalar */

// Full-match GON number (unquoted). Accepts leading-dot decimals like `.25`,
// negatives like `-999999`, and exponents; rejects expressions like `3+bonus`.
const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * @param {string} raw
 * @param {boolean} quoted
 * @returns {number|null}
 */
export function numericValue(raw, quoted) {
  if (quoted) return null;
  if (!NUMBER_RE.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Convert an AST node to the value model.
 * @param {Node} node
 * @returns {VNode}
 */
export function toValue(node) {
  if (node.kind === "scalar") {
    const raw = node.token.value ?? node.token.text;
    const quoted = node.token.quoted === true;
    return { t: "str", raw, quoted, num: numericValue(raw, quoted) };
  }
  if (node.kind === "array") {
    return { t: "arr", items: node.items.map(toValue) };
  }
  // object
  /** @type {VObject} */
  const obj = { t: "obj", entries: [] };
  for (const f of node.fields) {
    obj.entries.push({ key: f.key.value ?? f.key.text, value: toValue(f.value) });
  }
  return obj;
}

/**
 * Make a numeric scalar node.
 * @param {number} n
 * @returns {VScalar}
 */
export function numberNode(n) {
  const raw = Number.isInteger(n) ? String(n) : String(n);
  return { t: "str", raw, quoted: false, num: n };
}

/**
 * Deep clone a value node.
 * @param {VNode} v
 * @returns {VNode}
 */
export function clone(v) {
  if (v.t === "str") return { t: "str", raw: v.raw, quoted: v.quoted, num: v.num };
  if (v.t === "arr") return { t: "arr", items: v.items.map(clone) };
  return { t: "obj", entries: v.entries.map((e) => ({ key: e.key, value: clone(e.value) })) };
}

/**
 * First index of an entry with the given key, or -1.
 * @param {VObject} obj
 * @param {string} key
 * @returns {number}
 */
export function findIndex(obj, key) {
  for (let i = 0; i < obj.entries.length; i++) {
    if (obj.entries[i].key === key) return i;
  }
  return -1;
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeQuoted(s) {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

// A bare key/token is safe to print unquoted if it has no GON-significant chars.
const BARE_SAFE_RE = /^[^\s,{}[\]"#]+$/;

/**
 * @param {string} key
 * @returns {string}
 */
function renderKey(key) {
  if (key.length > 0 && BARE_SAFE_RE.test(key)) return key;
  return '"' + escapeQuoted(key) + '"';
}

/**
 * @param {VScalar} v
 * @returns {string}
 */
function renderScalar(v) {
  if (v.quoted) return '"' + escapeQuoted(v.raw) + '"';
  if (v.raw.length === 0) return '""';
  if (BARE_SAFE_RE.test(v.raw)) return v.raw;
  return '"' + escapeQuoted(v.raw) + '"';
}

/**
 * True if an array holds only scalars (render inline).
 * @param {VArray} arr
 */
function isScalarArray(arr) {
  return arr.items.every((it) => it.t === "str");
}

/**
 * Pretty-print a value node to readable GON. Not byte-faithful; for previews and
 * freshly generated overlays.
 * @param {VNode} v
 * @param {string} [indent]
 * @returns {string}
 */
export function pretty(v, indent = "") {
  if (v.t === "str") return renderScalar(v);
  if (v.t === "arr") {
    if (v.items.length === 0) return "[]";
    if (isScalarArray(v)) {
      return "[" + v.items.map((it) => pretty(it, indent)).join(" ") + "]";
    }
    const inner = indent + "\t";
    const lines = v.items.map((it) => inner + pretty(it, inner));
    return "[\n" + lines.join("\n") + "\n" + indent + "]";
  }
  // object
  if (v.entries.length === 0) return "{}";
  const inner = indent + "\t";
  const lines = v.entries.map((e) => inner + renderKey(e.key) + " " + pretty(e.value, inner));
  return "{\n" + lines.join("\n") + "\n" + indent + "}";
}

/**
 * Pretty-print a root object as a sequence of top-level `key value` pairs
 * (no surrounding braces), the way a GON file reads.
 * @param {VObject} root
 * @returns {string}
 */
export function prettyRoot(root) {
  if (root.entries.length === 0) return "";
  return root.entries.map((e) => renderKey(e.key) + " " + pretty(e.value, "")).join("\n\n") + "\n";
}
