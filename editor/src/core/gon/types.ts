// Shared JSDoc typedefs for the GON engine. This module exports nothing at
// runtime; it exists so other modules can reference `import('./types.ts').X`.

/**
 * A source position (0-based offset, 1-based line/col).
 * @typedef {{ offset: number, line: number, col: number }} Pos
 */

/**
 * A lexical token. `leading` is the exact trivia (whitespace, commas, comments)
 * that preceded `text` in the source, so concatenating `leading + text` over all
 * tokens in order reproduces the file byte-for-byte.
 * @typedef {Object} Token
 * @property {'lbrace'|'rbrace'|'lbracket'|'rbracket'|'string'|'eof'} type
 * @property {string} text      Exact source text of the token ('' for eof).
 * @property {string} leading   Exact trivia text immediately before the token.
 * @property {string} [value]   Decoded value for string tokens (quotes/escapes resolved).
 * @property {boolean} [quoted] True if the string token was double-quoted.
 * @property {Pos} pos          Position of the start of `text`.
 */

/**
 * A GON object node. For the synthetic file root, `open`/`close` are null and
 * `eof` carries the trailing-trivia token.
 * @typedef {Object} ObjectNode
 * @property {'object'} kind
 * @property {Field[]} fields
 * @property {Token|null} open
 * @property {Token|null} close
 * @property {Token} [eof]
 */

/**
 * A single `key value` pair inside an object.
 * @typedef {Object} Field
 * @property {Token} key
 * @property {Node} value
 */

/**
 * A GON array node.
 * @typedef {Object} ArrayNode
 * @property {'array'} kind
 * @property {Node[]} items
 * @property {Token} open
 * @property {Token} close
 */

/**
 * A scalar (bare token or quoted string).
 * @typedef {Object} ScalarNode
 * @property {'scalar'} kind
 * @property {Token} token
 */

/**
 * @typedef {ObjectNode | ArrayNode | ScalarNode} Node
 */

// ---- Value model (plain, order-preserving; used for merge + preview) --------

/**
 * @typedef {Object} VObject
 * @property {'obj'} t
 * @property {VEntry[]} entries
 */

/**
 * @typedef {Object} VEntry
 * @property {string} key    Decoded key name (used for matching).
 * @property {VNode} value
 */

/**
 * @typedef {Object} VArray
 * @property {'arr'} t
 * @property {VNode[]} items
 */

/**
 * @typedef {Object} VScalar
 * @property {'str'} t
 * @property {string} raw       Decoded scalar value (no surrounding quotes).
 * @property {boolean} quoted   True if originally double-quoted.
 * @property {number|null} num  Numeric value if this is an unquoted GON number, else null.
 */

/**
 * @typedef {VObject | VArray | VScalar} VNode
 */

export {};
