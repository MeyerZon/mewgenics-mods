// Byte-signature scanner with exactly the semantics of the framework DLL's
// native/framework/src/fw_sig.c, so a node test can predict what the DLL
// will do at load time: IDA-style patterns ("48 8B ?? C4"), first hit wins,
// the match counter stops at two (callers only care about "exactly one"),
// and executable sections are scanned as the loader sees them (VirtualSize,
// zero-padded). Pure; node built-ins only.

import { sectionBytes } from "./pe.ts";

/** Mirrors FW_SIG_MAX_BYTES in fw_sig.h; a longer pattern fails to parse in the DLL ("0 matches"). */
export const FW_SIG_MAX_BYTES = 128;

/**
 * @typedef {{ bytes: Uint8Array, mask: Uint8Array, length: number }} Pattern  mask 1 = byte must match
 * @typedef {{ matches: number }} ScanState  shared counter across buffers/sections
 */

export class PatternError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "PatternError";
  }
}

/**
 * Parse an IDA-style pattern. Tokens are two hex digits or a run of `?`; whitespace separates.
 * Throws PatternError on bad hex, junk after a token, or more than `cap` bytes (the DLL returns -1).
 * @param {string} sig
 * @param {number} [cap]
 * @returns {Pattern}
 */
export function parsePattern(sig, cap = FW_SIG_MAX_BYTES) {
  const bytes = new Uint8Array(cap);
  const mask = new Uint8Array(cap);
  let n = 0;
  let i = 0;
  const isSpace = (/** @type {string} */ c) => c === " " || c === "\t";
  while (i < sig.length) {
    while (i < sig.length && isSpace(sig[i])) i++;
    if (i >= sig.length) break;
    if (n >= cap) throw new PatternError(`pattern longer than ${cap} bytes`);
    if (sig[i] === "?") {
      bytes[n] = 0;
      mask[n] = 0;
      while (i < sig.length && sig[i] === "?") i++;
    } else {
      const hex = sig.slice(i, i + 2);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new PatternError(`bad hex at ${i}: ${JSON.stringify(sig.slice(i, i + 2))}`);
      bytes[n] = parseInt(hex, 16);
      mask[n] = 1;
      i += 2;
    }
    if (i < sig.length && !isSpace(sig[i])) throw new PatternError(`junk after token at ${i}: ${JSON.stringify(sig[i])}`);
    n++;
  }
  return { bytes: bytes.subarray(0, n), mask: mask.subarray(0, n), length: n };
}

/**
 * @param {Pattern} pat
 * @returns {string} "48 8B ?? C4"
 */
export function patternToString(pat) {
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < pat.length; i++) out.push(pat.mask[i] ? pat.bytes[i].toString(16).padStart(2, "0").toUpperCase() : "??");
  return out.join(" ");
}

/**
 * An all-fixed pattern over raw bytes.
 * @param {Uint8Array} bytes
 * @returns {Pattern}
 */
export function exactPattern(bytes) {
  return { bytes: Uint8Array.from(bytes), mask: new Uint8Array(bytes.length).fill(1), length: bytes.length };
}

/**
 * The DLL's fw_scan_buffer: returns the FIRST hit offset (or -1) and ADDS the hit count to
 * state.matches, returning as soon as the count reaches 2. A zero-length pattern never matches.
 * Uses Buffer.indexOf on the leading fixed run as a prefilter; semantics are unchanged.
 * @param {Buffer} hay
 * @param {Pattern} pat
 * @param {ScanState} state
 * @returns {number}
 */
export function scanBuffer(hay, pat, state) {
  const n = pat.length;
  if (n === 0 || hay.length < n) return -1;
  let lead = 0;
  while (lead < n && pat.mask[lead]) lead++;
  const needle = lead > 0 ? Buffer.from(pat.bytes.subarray(0, lead)) : null;
  let found = -1;
  let i = 0;
  const last = hay.length - n;
  while (i <= last) {
    if (needle) {
      const j = hay.indexOf(needle, i);
      if (j < 0 || j > last) break;
      i = j;
    }
    let k = lead;
    for (; k < n; k++) if (pat.mask[k] && hay[i + k] !== pat.bytes[k]) break;
    if (k === n) {
      if (found < 0) found = i;
      if (++state.matches > 1) return found;
    }
    i++;
  }
  return found;
}

/**
 * Scan one section as the loader sees it. Returns the RVAs of up to two hits.
 * @param {Buffer} buf
 * @param {import("./pe.ts").PeSection} section
 * @param {Pattern} pat
 * @param {ScanState} state
 * @returns {number[]}
 */
export function scanSection(buf, section, pat, state) {
  const bytes = sectionBytes(buf, section);
  /** @type {number[]} */
  const hits = [];
  const before = state.matches;
  const first = scanBuffer(bytes, pat, state);
  if (first < 0) return hits;
  hits.push(section.va + first);
  if (state.matches - before >= 2) {
    // locate the second hit for reporting (the DLL stops here; we only need its address)
    const st2 = { matches: 0 };
    const second = scanBuffer(bytes.subarray(first + 1), pat, st2);
    if (second >= 0) hits.push(section.va + first + 1 + second);
  }
  return hits;
}

/**
 * The DLL's scan_unique: every executable section, one shared counter, stop at two.
 * @param {import("./pe.ts").Pe} pe
 * @param {Buffer} buf
 * @param {Pattern} pat
 * @returns {{ hits: number[], count: number }}
 */
export function scanExec(pe, buf, pat) {
  return scanSections(buf, pe.execSections, pat);
}

/**
 * @param {Buffer} buf
 * @param {import("./pe.ts").PeSection[]} sections
 * @param {Pattern} pat
 * @returns {{ hits: number[], count: number }}
 */
export function scanSections(buf, sections, pat) {
  const state = { matches: 0 };
  /** @type {number[]} */
  const hits = [];
  for (const s of sections) {
    for (const h of scanSection(buf, s, pat, state)) if (hits.length < 2) hits.push(h);
    if (state.matches >= 2) break;
  }
  return { hits, count: state.matches };
}
