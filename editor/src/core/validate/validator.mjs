// The mod validator. Runs four classes of checks over a mod's overlay files:
//   1. Reference integrity   - status/ability/passive/item/component/character
//      names resolve against base data or a native-registered name.
//   2. Localization completeness - referenced KEYWORD_*/ABILITY_* keys exist in
//      combined.csv with all 12 columns (error on missing key, warn on missing
//      translation). Keys the mod itself adds via combined.csv overlays count.
//   3. Overlay-target existence - .merge/.patch target existing paths; .append
//      adds non-colliding keys; positional CSV .merge is flagged fragile.
//   4. (Merge preview is provided separately by preview-merge.mjs.)
//
// Findings are returned as a tagged Report (ok/warning/error with location).

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT, MODS_DIR } from "../repo.mjs";
import { parse, GonParseError } from "../gon/parser.mjs";
import { toValue } from "../gon/value.mjs";
import { parseOverlayName } from "../overlay/overlay.mjs";
import { parseCsv } from "../overlay/csv.mjs";
import { parsePolicy } from "../overlay/policy.mjs";
import { findIndex } from "../gon/value.mjs";
import { resolutionSets } from "../names.mjs";
import { loadLocalization, LOC_COLUMNS } from "../base-data.mjs";
import { ReportBuilder } from "./result.mjs";

/** @typedef {import('../gon/types.mjs').VObject} VObject */
/** @typedef {import('../gon/types.mjs').VNode} VNode */
/** @typedef {import('./result.mjs').Report} Report */

const LOC_FIELDS = new Set([
  "name", "desc", "description", "tooltip", "tooltip_stackless",
  "tooltip_stacks_pos", "tooltip_stacks_neg", "tooltip_stackless_pos",
  "tooltip_stackless_neg", "name_stacks_pos", "name_stacks_neg",
]);
const LOC_KEY_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/**
 * Map a pack-relative base file name to a data category.
 * @param {string} baseName  e.g. "data/abilities/fighter_abilities.gon"
 * @returns {string|null}
 */
function categoryForPath(baseName) {
  const p = baseName.replace(/\\/g, "/");
  if (p === "data/keyword_tooltips.gon") return "statuses";
  if (p === "data/difficulties.gon") return "difficulties";
  if (p.startsWith("data/abilities/")) return "abilities";
  if (p.startsWith("data/ability_templates/")) return "ability_templates";
  if (p.startsWith("data/passives/")) return "passives";
  if (p.startsWith("data/items/")) return "items";
  if (p.startsWith("data/characters/")) return "characters";
  if (p.startsWith("data/classes/")) return "classes";
  if (p.startsWith("data/text/")) return "text";
  return null;
}

/**
 * @typedef {Object} OverlayFile
 * @property {string} relPath   path relative to the mod folder (posix)
 * @property {string} text      file contents
 * @property {string} baseName  base pack path (mode suffix stripped)
 * @property {'append'|'merge'|'patch'|'replace'} mode
 * @property {'gon'|'csv'|'txt'|'other'} fileType
 * @property {string|null} category
 */

/**
 * Recursively collect overlay files under a mod folder.
 * @param {string} modDir
 * @returns {Array<{ relPath: string, abs: string }>}
 */
function listModFiles(modDir) {
  /** @type {Array<{ relPath: string, abs: string }>} */
  const out = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (ent.isFile()) out.push({ relPath: relative(modDir, abs).replace(/\\/g, "/"), abs });
    }
  };
  if (existsSync(modDir)) walk(modDir);
  return out;
}

/**
 * Build the set of overlay files for a mod, applying an optional unsaved text
 * override for one file (and optionally including a not-yet-saved file).
 * @param {string} modName
 * @param {{ relPath?: string, text?: string }} [override]
 * @returns {OverlayFile[]}
 */
function collectOverlays(modName, override) {
  const modDir = join(MODS_DIR, modName);
  const files = listModFiles(modDir);
  /** @type {Map<string, string>} */
  const texts = new Map();
  for (const f of files) {
    if (f.relPath === "description.json") continue;
    try {
      texts.set(f.relPath, readFileSync(f.abs, "utf8"));
    } catch {
      /* ignore unreadable */
    }
  }
  if (override && override.relPath !== undefined && override.text !== undefined) {
    texts.set(override.relPath, override.text);
  }
  /** @type {OverlayFile[]} */
  const out = [];
  for (const [relPath, text] of texts) {
    const fileName = relPath.split("/").pop() || relPath;
    const { baseName: baseLeaf, mode, fileType } = parseOverlayName(fileName);
    const baseName = relPath.slice(0, relPath.length - fileName.length) + baseLeaf;
    out.push({ relPath, text, baseName, mode, fileType, category: categoryForPath(baseName) });
  }
  return out;
}

/**
 * Gather mod-local names added across overlays (so same-mod references resolve).
 * @param {OverlayFile[]} overlays
 */
function modLocalNames(overlays) {
  /** @type {Set<string>} */
  const statuses = new Set();
  /** @type {Map<string, Set<string>>} */
  const byCategory = new Map();
  /** @type {Map<string, string[]>} */
  const locRows = new Map();
  for (const o of overlays) {
    if (o.fileType === "gon") {
      let root;
      try {
        root = toValue(parse(o.text));
      } catch {
        continue;
      }
      if (root.t !== "obj") continue;
      const names = root.entries.map((e) => parsePolicy(e.key).name);
      if (o.category === "statuses") for (const n of names) statuses.add(n);
      if (o.category) {
        if (!byCategory.has(o.category)) byCategory.set(o.category, new Set());
        const set = byCategory.get(o.category);
        if (set) for (const n of names) set.add(n);
      }
    } else if (o.category === "text" && o.fileType === "csv") {
      for (const row of parseCsv(o.text)) {
        if (row[0]) locRows.set(row[0], row);
      }
    }
  }
  return { statuses, byCategory, locRows };
}

/**
 * Validate one mod. Pass an override to validate unsaved text for one file.
 * @param {string} modName
 * @param {{ relPath?: string, text?: string }} [override]
 * @returns {Report}
 */
export function validateMod(modName, override) {
  const rb = new ReportBuilder();
  const modDir = join(MODS_DIR, modName);
  if (!existsSync(modDir)) {
    rb.error("mod-missing", `mod folder not found: mods/${modName}`);
    return rb.build();
  }
  const overlays = collectOverlays(modName, override);
  if (overlays.length === 0) {
    rb.warn("mod-empty", `mods/${modName} has no overlay files`);
  }

  const sets = resolutionSets();
  const local = modLocalNames(overlays);
  const loc = loadLocalization();

  // Union of localization keys available: base + mod-added.
  /** @type {(key: string) => string[] | undefined} */
  const findLocRow = (key) => local.locRows.get(key) || loc.rows.get(key);

  for (const o of overlays) {
    const fileLoc = { file: `mods/${modName}/${o.relPath}` };
    if (o.fileType === "gon") {
      validateGonOverlay(o, rb, sets, local, findLocRow, modName);
    } else if (o.fileType === "csv" || (o.category === "text" && o.fileType === "other")) {
      validateCsvOverlay(o, rb, loc, modName);
    } else if (o.mode === "replace") {
      rb.warn("whole-file-replace", `${o.relPath} replaces the whole base file; prefer .append/.merge/.patch`, fileLoc);
    }
  }
  return rb.build();
}

/**
 * @param {OverlayFile} o
 * @param {ReportBuilder} rb
 * @param {ReturnType<typeof resolutionSets>} sets
 * @param {ReturnType<typeof modLocalNames>} local
 * @param {(key: string) => string[] | undefined} findLocRow
 * @param {string} modName
 */
function validateGonOverlay(o, rb, sets, local, findLocRow, modName) {
  const file = `mods/${modName}/${o.relPath}`;
  let root;
  try {
    root = parse(o.text);
  } catch (e) {
    if (e instanceof GonParseError) {
      rb.error("gon-parse-error", e.message, { file, line: e.pos?.line, col: e.pos?.col });
    } else {
      rb.error("gon-parse-error", String(e), { file });
    }
    return;
  }
  if (o.mode === "replace") {
    rb.warn("whole-file-replace", `${o.relPath} replaces the whole base file; prefer .append/.merge/.patch`, { file });
  }
  const overlay = toValue(root);
  if (overlay.t !== "obj") return;

  // ---- Reference integrity (context-aware walk) ----------------------------
  const statusSet = new Set([...sets.statuses, ...local.statuses]);
  const parentSet =
    o.category === "characters"
      ? new Set([...sets.characters, ...(local.byCategory.get("characters") ?? [])])
      : new Set([...sets.abilities, ...(local.byCategory.get("abilities") ?? [])]);

  /**
   * @param {VNode} node
   * @param {string[]} path
   */
  const walk = (node, path) => {
    if (node.t === "obj") {
      for (const e of node.entries) handleField(e.key, e.value, path);
    } else if (node.t === "arr") {
      node.items.forEach((it, i) => walk(it, [...path, `[${i}]`]));
    }
  };

  /**
   * @param {string} key
   * @param {VNode} value
   * @param {string[]} path
   */
  const handleField = (key, value, path) => {
    const here = [...path, key];
    const at = { file, path: here.join(".") };
    if (key === "effects" || key === "temporary_effects") {
      if (value.t === "obj") for (const se of value.entries) checkStatus(se.key, { file, path: [...here, se.key].join(".") });
      return;
    }
    if (key === "passives") {
      if (value.t === "obj") {
        for (const pe of value.entries) {
          if (!sets.components.has(pe.key)) {
            rb.warn("unknown-component", `unknown component class "${pe.key}" in passives`, { file, path: [...here, pe.key].join(".") });
          }
          if (/Status/.test(pe.key) && pe.value.t === "obj") {
            for (const ss of pe.value.entries) checkStatus(ss.key, { file, path: [...here, pe.key, ss.key].join(".") });
          } else if (pe.value.t === "obj" || pe.value.t === "arr") {
            walk(pe.value, [...here, pe.key]);
          }
        }
      }
      return;
    }
    if (key === "variant_of") {
      if (value.t === "str" && !parentSet.has(value.raw)) {
        rb.error("unknown-parent", `variant_of references "${value.raw}", which is not a known ${o.category === "characters" ? "character" : "ability"} (base or this mod)`, at);
      }
      return;
    }
    if (key === "template") {
      if (value.t === "str" && sets.templates.size > 0 && !sets.templates.has(value.raw)) {
        rb.warn("unknown-template", `template "${value.raw}" is not a known ability template`, at);
      }
      return;
    }
    if (key === "status") {
      if (value.t === "str" && LOC_KEY_RE.test(value.raw) === false && /^[A-Za-z_]/.test(value.raw)) {
        checkStatus(value.raw, at);
      }
      return;
    }
    if (key === "brain") {
      if (value.t === "str" && !sets.components.has(value.raw)) {
        rb.warn("unknown-component", `ai brain "${value.raw}" is not a known component class`, at);
      }
      return;
    }
    if (key === "class") {
      if (value.t === "str") {
        const inMeta = path[path.length - 1] === "meta";
        if (inMeta) {
          if (sets.classes.size > 0 && !sets.classes.has(value.raw)) {
            rb.warn("unknown-class", `class "${value.raw}" is not a known cat class`, at);
          }
        } else if (!sets.components.has(value.raw)) {
          rb.warn("unknown-component", `class "${value.raw}" is not a known component`, at);
        }
      }
      return;
    }
    // localization-bearing fields: a value that looks like an ALL_CAPS key.
    if (LOC_FIELDS.has(key) && value.t === "str" && LOC_KEY_RE.test(value.raw)) {
      checkLoc(value.raw, { file, path: here.join(".") });
    }
    // recurse into structure
    if (value.t === "obj" || value.t === "arr") walk(value, here);
  };

  /**
   * @param {string} name
   * @param {import('./result.mjs').SourceLocation} at
   */
  const checkStatus = (name, at) => {
    if (!statusSet.has(name)) {
      rb.error("unknown-status", `status "${name}" is not defined in base data, not native-registered, and not added by this mod`, at);
    }
  };

  /**
   * @param {string} key
   * @param {import('./result.mjs').SourceLocation} at
   */
  const checkLoc = (key, at) => {
    const row = findLocRow(key);
    if (!row) {
      rb.error("missing-loc-key", `localization key "${key}" not found in combined.csv (base or this mod's .csv overlay)`, at);
      return;
    }
    if (row.length < LOC_COLUMNS.length) {
      rb.warn("incomplete-loc-row", `localization row "${key}" has ${row.length} columns (expected ${LOC_COLUMNS.length})`, at);
      return;
    }
    // Translation columns are indices 3..11 (sp..zh-cn); en is 1, notes is 2.
    const missing = [];
    for (let i = 3; i < LOC_COLUMNS.length; i++) {
      if (!row[i] || row[i].trim() === "") missing.push(LOC_COLUMNS[i]);
    }
    if (missing.length > 0) {
      rb.warn("missing-translation", `localization key "${key}" is missing translations: ${missing.join(", ")}`, at);
    }
  };

  for (const e of overlay.entries) handleField(e.key, e.value, []);

  // ---- Overlay-target existence --------------------------------------------
  const baseAbs = join(REPO_ROOT, ".extracted", o.baseName);
  const baseExists = existsSync(baseAbs);
  if ((o.mode === "merge" || o.mode === "patch") && !baseExists) {
    rb.warn("base-missing", `${o.relPath} is a ${o.mode} overlay but base file ${o.baseName} was not found under .extracted/ (cannot verify targets)`, { file });
  }
  if (baseExists && (o.mode === "merge" || o.mode === "patch" || o.mode === "append")) {
    let baseRoot;
    try {
      baseRoot = toValue(parse(readFileSync(baseAbs, "utf8")));
    } catch {
      baseRoot = null;
    }
    if (baseRoot && baseRoot.t === "obj") {
      if (o.mode === "append") {
        for (const e of overlay.entries) {
          if (findIndex(baseRoot, e.key) >= 0) {
            rb.warn("append-collision", `.append adds "${e.key}" but the base file already has it; .append duplicates rather than changing it (use .merge/.patch to change)`, { file, path: e.key });
          }
        }
      } else if (o.mode === "merge") {
        checkMergeTargets(overlay, baseRoot, [], rb, file);
      } else {
        checkPatchTargets(overlay, baseRoot, [], rb, file);
      }
    }
  }
}

/**
 * Warn about merge fields whose target does not exist in the base (merge would
 * silently add them, which usually indicates a value-change mistake).
 * @param {VObject} overlay
 * @param {VObject} base
 * @param {string[]} path
 * @param {ReportBuilder} rb
 * @param {string} file
 */
function checkMergeTargets(overlay, base, path, rb, file) {
  for (const e of overlay.entries) {
    const i = findIndex(base, e.key);
    const here = [...path, e.key];
    if (i < 0) {
      rb.warn("merge-target-missing", `.merge target "${here.join(".")}" does not exist in the base file; it will be ADDED, not changed`, { file, path: here.join(".") });
    } else if (e.value.t === "obj" && base.entries[i].value.t === "obj") {
      checkMergeTargets(e.value, /** @type {VObject} */ (base.entries[i].value), here, rb, file);
    }
  }
}

/**
 * Warn about patch policies whose target does not exist.
 * @param {VObject} overlay
 * @param {VObject} base
 * @param {string[]} path
 * @param {ReportBuilder} rb
 * @param {string} file
 */
function checkPatchTargets(overlay, base, path, rb, file) {
  for (const e of overlay.entries) {
    const { name, policy } = parsePolicy(e.key);
    const here = [...path, name];
    const i = findIndex(base, name);
    if (i < 0) {
      if (policy === "add" || policy === "multiply" || policy === "merge") {
        rb.warn("patch-target-missing", `.${policy} target "${here.join(".")}" does not exist in the base file; the policy has nothing to act on`, { file, path: here.join(".") });
      }
      continue;
    }
    if ((policy === "default" || policy === "merge") && e.value.t === "obj" && base.entries[i].value.t === "obj") {
      checkPatchTargets(e.value, /** @type {VObject} */ (base.entries[i].value), here, rb, file);
    }
    if ((policy === "add" || policy === "multiply") && (e.value.t !== "str" || e.value.num === null)) {
      rb.warn("patch-nonnumeric", `.${policy} on "${here.join(".")}" but the value is not a number`, { file, path: here.join(".") });
    }
  }
}

/**
 * @param {OverlayFile} o
 * @param {ReportBuilder} rb
 * @param {ReturnType<typeof loadLocalization>} loc
 * @param {string} modName
 */
function validateCsvOverlay(o, rb, loc, modName) {
  const file = `mods/${modName}/${o.relPath}`;
  const rows = parseCsv(o.text);
  if (o.mode === "merge" || o.mode === "patch") {
    rb.warn("csv-positional-merge-fragile", `${o.relPath} is a positional CSV ${o.mode}; it matches by ROW INDEX and breaks when the base game adds rows. Prefer .append with new keys.`, { file });
  }
  if (o.mode === "replace") {
    rb.warn("whole-file-replace", `${o.relPath} replaces the whole localization file; prefer .append`, { file });
  }
  const expected = loc.columns || LOC_COLUMNS.length;
  rows.forEach((row, idx) => {
    if (row.length === 1 && row[0] === "") return; // blank line
    if (o.mode === "append" && row.length !== expected) {
      rb.warn("csv-column-count", `row ${idx + 1} (key "${row[0]}") has ${row.length} columns; expected ${expected}`, { file, line: idx + 1 });
    }
  });
}

/** @param {string} p */
export function repoRelative(p) {
  return relative(REPO_ROOT, p).replace(/\\/g, "/");
}
