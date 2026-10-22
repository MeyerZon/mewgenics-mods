// Shared types for the GON engine. This module exports nothing at runtime.

import type { GonScalarType } from "./typing.ts";

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
  /** Decoded value for string tokens (quotes/escapes resolved) — the text the game types and stores. */
  value?: string;
  /**
   * True if the string token was double-quoted. Round-tripping only: the game drops the quotes before typing, so
   * this never drives a type (see `ScalarNode.type`).
   */
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
  /** The game's type of this scalar (`scalarType(token.value)`): quoting plays no part. */
  type: GonScalarType;
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

/**
 * Any GON scalar (`t: "str"` is the discriminator for all four game types; `type` tells them apart).
 */
export interface VScalar {
  t: "str";
  /** Decoded scalar value (no surrounding quotes) — the text the game stores on the node. */
  raw: string;
  /** True if originally double-quoted. Preserved for the pretty-printer; never drives typing. */
  quoted: boolean;
  /** The game's double view (`numericValue(raw)`) when `type` is "number", else null. */
  num: number | null;
  /** The game's type of this scalar — quotes dropped, so `"5"` is a number and `"true"` a bool. */
  type: GonScalarType;
}

export type VNode = VObject | VArray | VScalar;
