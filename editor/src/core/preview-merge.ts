// Merge preview: compute base vs. overlay vs. effective for one overlay file.
// Focused by default (only the entries/rows the overlay touches) to keep results
// small, with an option to include the whole effective GON text.

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { EXTRACTED_DATA, MODS_DIR, resolveReadPath } from "./repo.ts";
import { parseOverlayName, applyGonOverlay, applyCsvOverlay } from "./overlay/overlay.ts";
import { parsePolicy } from "./overlay/policy.ts";
import { pretty, findIndex } from "./gon/value.ts";
import type { VObject, VNode } from "./gon/types.ts";
import type { OverlayMode } from "./overlay/overlay.ts";

function get(obj: VObject, key: string): VNode | null {
  const i = findIndex(obj, key);
  return i >= 0 ? obj.entries[i]!.value : null;
}

function sameText(a: VNode | null, b: VNode | null): boolean {
  const pa = a ? pretty(a) : null;
  const pb = b ? pretty(b) : null;
  return pa === pb;
}

export interface PreviewMergeOptions {
  overrideText?: string;
  includeFullGon?: boolean;
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
  // the pack copy next to EXTRACTED_DATA (<…>/.extracted/<data/…>); honours MEWGENICS_EXTRACTED_DATA like every other reader
  const baseAbs = resolveReadPath(resolve(EXTRACTED_DATA, "..", baseRel));
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

  // Touched top-level keys.
  const touched: string[] = [];
  for (const e of overlay.entries) {
    const name = mode === "patch" ? parsePolicy(e.key).name : e.key;
    if (!touched.includes(name)) touched.push(name);
  }

  const entries: TouchedEntry[] = touched.map((key) => {
    const baseVal = get(base, key);
    const effVal = get(effective, key);
    let status: TouchedStatus = "changed";
    if (baseVal === null) status = "added";
    else if (sameText(baseVal, effVal)) status = "unchanged";
    return {
      key,
      status,
      base: baseVal ? pretty(baseVal) : null,
      effective: effVal ? pretty(effVal) : null,
    };
  });

  return {
    ok: true,
    kind: "gon",
    mode,
    baseFile: baseRel,
    baseExists: baseText !== null,
    touched: entries,
    baseEntryCount: base.entries.length,
    effectiveEntryCount: effective.entries.length,
    ...(opts.includeFullGon ? { effectiveText: text } : {}),
  };
}
