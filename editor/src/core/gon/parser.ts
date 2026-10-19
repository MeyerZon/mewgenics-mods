// GON parser + faithful serializer.
//
// The parser arranges the flat token stream into an AST while referencing each
// token exactly once. The serializer walks the AST in source order, emitting
// `token.leading + token.text` for every token, so an UNMODIFIED tree serializes
// back to the exact original bytes (round-trip = no-op). Edited subtrees carry
// freshly synthesized trivia; untouched tokens keep theirs.
//
// Per GON's loader, the whole file is treated as the contents of a single root
// object (its top-level `name value` pairs). We model that as an ObjectNode with
// `open`/`close` = null and the trailing `eof` token attached for trailing trivia.

import { tokenize } from "./tokenizer.ts";

/** @typedef {import('./types.ts').Token} Token */
/** @typedef {import('./types.ts').Node} Node */
/** @typedef {import('./types.ts').ObjectNode} ObjectNode */
/** @typedef {import('./types.ts').ArrayNode} ArrayNode */
/** @typedef {import('./types.ts').ScalarNode} ScalarNode */
/** @typedef {import('./types.ts').Field} Field */

export class GonParseError extends Error {
  /**
   * @param {string} message
   * @param {import('./types.ts').Pos} [pos]
   */
  constructor(message, pos) {
    super(pos ? `${message} (line ${pos.line}, col ${pos.col})` : message);
    this.name = "GonParseError";
    this.pos = pos;
  }
}

/**
 * Parse GON source into a root ObjectNode.
 * @param {string} src
 * @returns {ObjectNode}
 */
export function parse(src) {
  const tokens = tokenize(src);
  let p = 0;

  const peek = () => tokens[p];
  const next = () => tokens[p++];

  /**
   * Parse a value node. The current token is the first token of the value.
   * @returns {Node}
   */
  function parseValue() {
    const t = peek();
    if (t.type === "lbrace") return parseObject(next());
    if (t.type === "lbracket") return parseArray(next());
    if (t.type === "string") {
      next();
      return { kind: "scalar", token: t };
    }
    throw new GonParseError(
      `unexpected ${t.type === "eof" ? "end of file" : "'" + t.text + "'"} where a value was expected`,
      t.pos,
    );
  }

  /**
   * @param {Token} open  the already-consumed '{'
   * @returns {ObjectNode}
   */
  function parseObject(open) {
    /** @type {Field[]} */
    const fields = [];
    for (;;) {
      const t = peek();
      if (t.type === "rbrace") {
        return { kind: "object", fields, open, close: next() };
      }
      if (t.type === "eof") {
        throw new GonParseError("unterminated object: missing '}'", open.pos);
      }
      if (t.type !== "string") {
        throw new GonParseError(`expected a field name, got '${t.text}'`, t.pos);
      }
      const key = next();
      fields.push({ key, value: parseValue() });
    }
  }

  /**
   * @param {Token} open  the already-consumed '['
   * @returns {ArrayNode}
   */
  function parseArray(open) {
    /** @type {Node[]} */
    const items = [];
    for (;;) {
      const t = peek();
      if (t.type === "rbracket") {
        return { kind: "array", items, open, close: next() };
      }
      if (t.type === "eof") {
        throw new GonParseError("unterminated array: missing ']'", open.pos);
      }
      items.push(parseValue());
    }
  }

  // Root: read top-level fields until EOF (synthetic wrapping object).
  /** @type {Field[]} */
  const fields = [];
  for (;;) {
    const t = peek();
    if (t.type === "eof") {
      return { kind: "object", fields, open: null, close: null, eof: next() };
    }
    if (t.type !== "string") {
      throw new GonParseError(
        `expected a top-level field name, got '${t.text}'`,
        t.pos,
      );
    }
    const key = next();
    fields.push({ key, value: parseValue() });
  }
}

/**
 * Serialize an AST back to source. For an unmodified tree this is byte-exact.
 * @param {Node} node  usually the root ObjectNode
 * @returns {string}
 */
export function serialize(node) {
  /** @type {string[]} */
  const out = [];
  /** @param {Token} tok */
  const emit = (tok) => {
    out.push(tok.leading);
    out.push(tok.text);
  };
  /** @param {Node} nd */
  function walk(nd) {
    if (nd.kind === "scalar") {
      emit(nd.token);
      return;
    }
    if (nd.kind === "array") {
      emit(nd.open);
      for (const item of nd.items) walk(item);
      emit(nd.close);
      return;
    }
    // object
    if (nd.open) emit(nd.open);
    for (const f of nd.fields) {
      emit(f.key);
      walk(f.value);
    }
    if (nd.close) emit(nd.close);
    if (nd.eof) emit(nd.eof);
  }
  walk(node);
  return out.join("");
}
