// Shared types for the GON engine. This module exports nothing at runtime.

/** A source position (0-based offset, 1-based line/col). */
export interface Pos {
  offset: number;
  line: number;
  col: number;
}

export type TokenType = "lbrace" | "rbrace" | "lbracket" | "rbracket" | "string" | "eof";

/**
 * A lexical token. `leading` is the exact trivia (whitespace, commas, comments)
 * that preceded `text` in the source, so concatenating `leading + text` over all
 * tokens in order reproduces the file byte-for-byte.
 */
export interface Token {
  type: TokenType;
  /** Exact source text of the token ('' for eof). */
  text: string;
  /** Exact trivia text immediately before the token. */
  leading: string;
  /** Decoded value for string tokens (quotes/escapes resolved). */
  value?: string;
  /** True if the string token was double-quoted. */
  quoted?: boolean;
  /** Position of the start of `text`. */
  pos: Pos;
}

/**
 * A GON object node. For the synthetic file root, `open`/`close` are null and
 * `eof` carries the trailing-trivia token.
 */
export interface ObjectNode {
  kind: "object";
  fields: Field[];
  open: Token | null;
  close: Token | null;
  eof?: Token;
}

/** A single `key value` pair inside an object. */
export interface Field {
  key: Token;
  value: Node;
}

/** A GON array node. */
export interface ArrayNode {
  kind: "array";
  items: Node[];
  open: Token;
  close: Token;
}

/** A scalar (bare token or quoted string). */
export interface ScalarNode {
  kind: "scalar";
  token: Token;
}

export type Node = ObjectNode | ArrayNode | ScalarNode;

// ---- Value model (plain, order-preserving; used for merge + preview) --------

export interface VObject {
  t: "obj";
  entries: VEntry[];
}

export interface VEntry {
  /** Decoded key name (used for matching). */
  key: string;
  value: VNode;
}

export interface VArray {
  t: "arr";
  items: VNode[];
}

export interface VScalar {
  t: "str";
  /** Decoded scalar value (no surrounding quotes). */
  raw: string;
  /** True if originally double-quoted. */
  quoted: boolean;
  /** Numeric value if this is an unquoted GON number, else null. */
  num: number | null;
}

export type VNode = VObject | VArray | VScalar;
