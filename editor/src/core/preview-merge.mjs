// Merge preview: compute base vs. overlay vs. effective for one overlay file.
// Focused by default (only the entries/rows the overlay touches) to keep results
// small, with an option to include the whole effective GON text.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, MODS_DIR, resolveReadPath } from "./repo.mjs";
import { parseOverlayName, applyGonOverlay, applyCsvOverlay } from "./overlay/overlay.mjs";
import { parsePolicy } from "./overlay/policy.mjs";
import { pretty, findIndex } from "./gon/value.mjs";

/** @typedef {import('./gon/types.mjs').VObject} VObject */
/** @typedef {import('./gon/types.mjs').VNode} VNode */

/**
 * @param {VObject} obj
 * @param {string} key
 * @returns {VNode|null}
 */
function get(obj, key) {
  const i = findIndex(obj, key);
  return i >= 0 ? obj.entries[i].value : null;
}

/** @param {VNode|null} a @param {VNode|null} b */
function sameText(a, b) {
  const pa = a ? pretty(a) : null;
  const pb = b ? pretty(b) : null;
  return pa === pb;
}

/**
 * @param {string} modName
 * @param {string} relPath          overlay path relative to the mod folder
 * @param {{ overrideText?: string, includeFullGon?: boolean }} [opts]
 */
export function previewMerge(modName, relPath, opts = {}) {
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
  const baseAbs = resolveReadPath(join(REPO_ROOT, ".extracted", baseRel));
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
    const changed = [];
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
  /** @type {string[]} */
  const touched = [];
  for (const e of overlay.entries) {
    const name = mode === "patch" ? parsePolicy(e.key).name : e.key;
    if (!touched.includes(name)) touched.push(name);
  }

  const entries = touched.map((key) => {
    const baseVal = get(base, key);
    const effVal = get(effective, key);
    /** @type {'added'|'changed'|'unchanged'} */
    let status = "changed";
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
