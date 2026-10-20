// File-level overlay dispatch: turn an overlay file name + base file into the
// effective merged result, choosing the engine from the mode suffix.

import { parse } from "../gon/parser.ts";
import { toValue, prettyRoot } from "../gon/value.ts";
import { append, deepMerge, patchMerge } from "./merge.ts";
import { parseCsv, serializeCsv, csvAppend, csvPositionalMerge } from "./csv.ts";
import type { VObject } from "../gon/types.ts";

export type OverlayMode = "append" | "merge" | "patch" | "replace";
export type FileType = "gon" | "csv" | "txt" | "other";

const MODE_SUFFIX = /\.(append|merge|patch)$/;

export interface OverlayName {
  baseName: string;
  mode: OverlayMode;
  fileType: FileType;
}

/**
 * Split an overlay file name into its base file name, mode, and file type.
 * @param fileName base name only, e.g. "fighter_abilities.gon.append"
 */
export function parseOverlayName(fileName: string): OverlayName {
  const m = MODE_SUFFIX.exec(fileName);
  let mode: OverlayMode = "replace";
  let baseName = fileName;
  if (m) {
    mode = m[1] as OverlayMode;
    baseName = fileName.slice(0, fileName.length - m[0].length);
  }
  let fileType: FileType = "other";
  if (baseName.endsWith(".gon")) fileType = "gon";
  else if (baseName.endsWith(".csv")) fileType = "csv";
  else if (baseName.endsWith(".txt")) fileType = "txt";
  return { baseName, mode, fileType };
}

function parseRoot(text?: string): VObject {
  const root = parse(text ?? "");
  const v = toValue(root);
  if (v.t !== "obj") return { t: "obj", entries: [] };
  return v;
}

export interface GonOverlayResult {
  base: VObject;
  overlay: VObject;
  effective: VObject;
  text: string;
}

/**
 * Apply a GON overlay to a base file and return the effective merged object.
 * @param baseText base file contents, or null if the base is absent
 */
export function applyGonOverlay(baseText: string | null, overlayText: string, mode: OverlayMode): GonOverlayResult {
  const base = parseRoot(baseText ?? "");
  const overlay = parseRoot(overlayText);
  let effective: VObject;
  if (mode === "replace" || baseText === null) {
    effective = overlay;
  } else if (mode === "append") {
    effective = append(base, overlay) as VObject;
  } else if (mode === "merge") {
    effective = deepMerge(base, overlay) as VObject;
  } else {
    effective = patchMerge(base, overlay) as VObject;
  }
  return { base, overlay, effective, text: prettyRoot(effective) };
}

export interface CsvOverlayResult {
  base: string[][];
  overlay: string[][];
  effective: string[][];
  text: string;
}

/** Apply a CSV overlay to a base file. */
export function applyCsvOverlay(baseText: string | null, overlayText: string, mode: OverlayMode): CsvOverlayResult {
  const base = baseText === null ? [] : parseCsv(baseText);
  const overlay = parseCsv(overlayText);
  let effective: string[][];
  if (mode === "replace" || baseText === null) effective = overlay.map((r) => r.slice());
  else if (mode === "append") effective = csvAppend(base, overlay);
  else effective = csvPositionalMerge(base, overlay); // merge/patch -> positional
  return { base, overlay, effective, text: serializeCsv(effective) };
}
