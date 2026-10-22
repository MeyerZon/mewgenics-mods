// Merge preview: compute base vs. overlay vs. effective for one overlay file.
// Focused by default (only the entries/rows the overlay touches) to keep results
// small, with an option to include the whole effective GON text.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { EXTRACTED_DATA, MODS_DIR, resolveReadPath, packPath } from "./repo.ts";
import { parseOverlayName, applyGonOverlay, applyCsvOverlay } from "./overlay/overlay.ts";
import { parsePolicy } from "./overlay/policy.ts";
import { pretty, findLastIndex } from "./gon/value.ts";
import type { VObject, VNode } from "./gon/types.ts";
import type { OverlayMode } from "./overlay/overlay.ts";

/**
 * By-name lookup the way the game resolves a name: the LAST entry with that key. The name index
 * (FUN_14012a310 in Gon_Append 0x945410 / Gon_DeepMerge_plain 0x945c30) is repointed at every pushed child, so
 * after an `.append` that duplicates a name the appended one is what `enemies["Rat"]` finds.
 */
function get(obj: VObject, key: string): VNode | null {
  const i = findLastIndex(obj, key);
  return i >= 0 ? obj.entries[i]!.value : null;
}

function countKey(obj: VObject, key: string): number {
  let n = 0;
  for (const e of obj.entries) if (e.key === key) n++;
  return n;
}

function sameText(a: VNode | null, b: VNode | null): boolean {
  const pa = a ? pretty(a) : null;
  const pb = b ? pretty(b) : null;
  return pa === pb;
}

export interface PreviewMergeOptions {
  overrideText?: string;
  includeFullGon?: boolean;
  /** the base-data root in the `.extracted/data` layout (tests/fixtures); default EXTRACTED_DATA */
  extractedData?: string;
  /** the mod folder (tests/fixtures); default mods/<modName> */
  modDir?: string;
}

export interface CsvAppendPreview {
  ok: true;
  kind: "csv";
  mode: OverlayMode;
  baseFile: string;
  baseExists: boolean;
  addedRows: string[][];
  baseRowCount: number;
  effectiveRowCount: number;
  note: string;
}

export interface CsvChangedRow {
  rowIndex: number;
  before: string[] | undefined;
  after: string[] | undefined;
}

export interface CsvMergePreview {
  ok: true;
  kind: "csv";
  mode: OverlayMode;
  baseFile: string;
  baseExists: boolean;
  note: string;
  changedRows: CsvChangedRow[];
}

export type TouchedStatus = "added" | "changed" | "unchanged";

export interface TouchedEntry {
  key: string;
  status: TouchedStatus;
  base: string | null;
  effective: string | null;
  /** present when the key occurs more than once in the effective file (an `.append` of an existing name): the game keeps every copy, and `effective` is the last one — the one a by-name lookup sees */
  occurrences?: number;
}

/**
 * The top-level entries an overlay touches, as base vs. effective, resolved by name the way the game does
 * (last occurrence). Pure; `previewMerge` wraps it with the file reads.
 */
export function touchedEntries(base: VObject, overlay: VObject, effective: VObject, mode: OverlayMode): TouchedEntry[] {
  const touched: string[] = [];
  for (const e of overlay.entries) {
    const name = mode === "patch" ? parsePolicy(e.key).name : e.key;
    if (!touched.includes(name)) touched.push(name);
  }
  return touched.map((key) => {
    const baseVal = get(base, key);
    const effVal = get(effective, key);
    let status: TouchedStatus = "changed";
    if (baseVal === null) status = "added";
    else if (sameText(baseVal, effVal)) status = "unchanged";
    const n = countKey(effective, key);
    return {
      key,
      status,
      base: baseVal ? pretty(baseVal) : null,
      effective: effVal ? pretty(effVal) : null,
      ...(n > 1 ? { occurrences: n } : {}),
    };
  });
}

export interface GonPreview {
  ok: true;
  kind: "gon";
  mode: OverlayMode;
  baseFile: string;
  baseExists: boolean;
  touched: TouchedEntry[];
  baseEntryCount: number;
  effectiveEntryCount: number;
  effectiveText?: string;
}

export type PreviewMergeResult = CsvAppendPreview | CsvMergePreview | GonPreview | { ok: false; error: string };

/** @param relPath overlay path relative to the mod folder */
export function previewMerge(modName: string, relPath: string, opts: PreviewMergeOptions = {}): PreviewMergeResult {
  const overlayAbs = join(MODS_DIR, modName, relPath);
  let overlayText = opts.overrideText;
  if (overlayText === undefined) {
    if (!existsSync(overlayAbs)) {
      return { ok: false, error: `overlay file not found: mods/${modName}/${relPath}` };
    }
    overlayText = readFileSync(overlayAbs, "utf8");
  }

  const fileName = relPath.split("/").pop() || relPath;
  const { baseName: baseLeaf, mode, fileType } = parseOverlayName(fileName);
  const baseRel = relPath.slice(0, relPath.length - fileName.length) + baseLeaf;
  const baseAbs = resolveReadPath(packPath(baseRel, opts.extractedData ?? EXTRACTED_DATA));
  const baseText = existsSync(baseAbs) ? readFileSync(baseAbs, "utf8") : null;

  if (fileType === "csv") {
    const { base, overlay, effective } = applyCsvOverlay(baseText, overlayText, mode);
    if (mode === "append") {
      return {
        ok: true,
        kind: "csv",
        mode,
        baseFile: baseRel,
        baseExists: baseText !== null,
        addedRows: overlay.map((r) => r.slice()),
        baseRowCount: base.length,
        effectiveRowCount: effective.length,
        note: "append adds these rows at the end",
      };
    }
    // positional merge/patch: report rows that changed
    const changed: CsvChangedRow[] = [];
    for (let i = 0; i < overlay.length && i < base.length; i++) {
      changed.push({ rowIndex: i, before: base[i], after: effective[i] });
    }
    return {
      ok: true,
      kind: "csv",
      mode,
      baseFile: baseRel,
      baseExists: baseText !== null,
      note: "positional merge: rows matched by index (fragile)",
      changedRows: changed,
    };
  }

  // GON
  const { base, overlay, effective, text } = applyGonOverlay(baseText, overlayText, mode);

  return {
    ok: true,
    kind: "gon",
    mode,
    baseFile: baseRel,
    baseExists: baseText !== null,
    touched: touchedEntries(base, overlay, effective, mode),
    baseEntryCount: base.entries.length,
    effectiveEntryCount: effective.entries.length,
    ...(opts.includeFullGon ? { effectiveText: text } : {}),
  };
}
