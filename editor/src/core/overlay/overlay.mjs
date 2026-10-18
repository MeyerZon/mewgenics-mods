// File-level overlay dispatch: turn an overlay file name + base file into the
// effective merged result, choosing the engine from the mode suffix.

import { parse } from "../gon/parser.mjs";
import { toValue, prettyRoot } from "../gon/value.mjs";
import { append, deepMerge, patchMerge } from "./merge.mjs";
import { parseCsv, serializeCsv, csvAppend, csvPositionalMerge } from "./csv.mjs";

/** @typedef {import('../gon/types.mjs').VObject} VObject */
/** @typedef {'append'|'merge'|'patch'|'replace'} OverlayMode */
/** @typedef {'gon'|'csv'|'txt'|'other'} FileType */

const MODE_SUFFIX = /\.(append|merge|patch)$/;

/**
 * Split an overlay file name into its base file name, mode, and file type.
 * @param {string} fileName  base name only, e.g. "fighter_abilities.gon.append"
 * @returns {{ baseName: string, mode: OverlayMode, fileType: FileType }}
 */
export function parseOverlayName(fileName) {
  const m = MODE_SUFFIX.exec(fileName);
  /** @type {OverlayMode} */
  let mode = "replace";
  let baseName = fileName;
  if (m) {
    mode = /** @type {OverlayMode} */ (m[1]);
    baseName = fileName.slice(0, fileName.length - m[0].length);
  }
  /** @type {FileType} */
  let fileType = "other";
  if (baseName.endsWith(".gon")) fileType = "gon";
  else if (baseName.endsWith(".csv")) fileType = "csv";
  else if (baseName.endsWith(".txt")) fileType = "txt";
  return { baseName, mode, fileType };
}

/** @param {string} [text] */
function parseRoot(text) {
  const root = parse(text ?? "");
  const v = toValue(root);
  if (v.t !== "obj") return /** @type {VObject} */ ({ t: "obj", entries: [] });
  return v;
}

/**
 * Apply a GON overlay to a base file and return the effective merged object.
 * @param {string|null} baseText  base file contents, or null if the base is absent
 * @param {string} overlayText
 * @param {OverlayMode} mode
 * @returns {{ base: VObject, overlay: VObject, effective: VObject, text: string }}
 */
export function applyGonOverlay(baseText, overlayText, mode) {
  const base = parseRoot(baseText ?? "");
  const overlay = parseRoot(overlayText);
  /** @type {VObject} */
  let effective;
  if (mode === "replace" || baseText === null) {
    effective = overlay;
  } else if (mode === "append") {
    effective = /** @type {VObject} */ (append(base, overlay));
  } else if (mode === "merge") {
    effective = /** @type {VObject} */ (deepMerge(base, overlay));
  } else {
    effective = /** @type {VObject} */ (patchMerge(base, overlay));
  }
  return { base, overlay, effective, text: prettyRoot(effective) };
}

/**
 * Apply a CSV overlay to a base file.
 * @param {string|null} baseText
 * @param {string} overlayText
 * @param {OverlayMode} mode
 * @returns {{ base: string[][], overlay: string[][], effective: string[][], text: string }}
 */
export function applyCsvOverlay(baseText, overlayText, mode) {
  const base = baseText === null ? [] : parseCsv(baseText);
  const overlay = parseCsv(overlayText);
  let effective;
  if (mode === "replace" || baseText === null) effective = overlay.map((r) => r.slice());
  else if (mode === "append") effective = csvAppend(base, overlay);
  else effective = csvPositionalMerge(base, overlay); // merge/patch -> positional
  return { base, overlay, effective, text: serializeCsv(effective) };
}
