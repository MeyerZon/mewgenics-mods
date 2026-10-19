// Base game data access: index the extracted .gon files, read individual
// entries, and load the localization table. Everything here is read-only against
// .extracted/ and is cached in memory for the life of the process.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "./gon/parser.ts";
import { serialize } from "./gon/parser.ts";
import { EXTRACTED_DATA, COMBINED_CSV, resolveReadPath } from "./repo.ts";
import { parseCsv } from "./overlay/csv.ts";

/** @typedef {import('./gon/types.ts').ObjectNode} ObjectNode */

/**
 * Category -> where its entries live. A `dir` scans every *.gon in that folder;
 * a `file` reads top-level keys from one file.
 * @type {Record<string, { dir?: string, file?: string }>}
 */
const CATEGORY_SOURCES = {
  abilities: { dir: "abilities" },
  ability_templates: { dir: "ability_templates" },
  passives: { dir: "passives" },
  items: { dir: "items" },
  characters: { dir: "characters" },
  events: { dir: "events" },
  mutations: { dir: "mutations" },
  classes: { file: join("classes", "classes.gon") },
  difficulties: { file: "difficulties.gon" },
  statuses: { file: "keyword_tooltips.gon" },
};

/**
 * @typedef {Object} CategoryIndex
 * @property {string[]} names        sorted entry names
 * @property {Map<string, string>} entryFile  name -> repo-relative file path
 */

/** @type {Map<string, CategoryIndex>|null} */
let indexCache = null;

/** @returns {boolean} whether extracted base data is present */
export function hasBaseData() {
  return existsSync(EXTRACTED_DATA);
}

/**
 * Recursively list *.gon files under a directory (absolute paths).
 * @param {string} dir
 * @returns {string[]}
 */
function listGon(dir) {
  /** @type {string[]} */
  const out = [];
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listGon(full));
    else if (ent.isFile() && ent.name.endsWith(".gon")) out.push(full);
  }
  return out;
}

/**
 * Top-level field keys (decoded) of a GON file.
 * @param {string} absFile
 * @returns {string[]}
 */
function topLevelKeys(absFile) {
  try {
    const root = parse(readFileSync(absFile, "utf8"));
    return root.fields.map((f) => f.key.value ?? f.key.text);
  } catch {
    return [];
  }
}

/**
 * Build (and cache) the base-data index.
 * @returns {Map<string, CategoryIndex>}
 */
export function buildIndex() {
  if (indexCache) return indexCache;
  /** @type {Map<string, CategoryIndex>} */
  const index = new Map();
  for (const [cat, src] of Object.entries(CATEGORY_SOURCES)) {
    /** @type {Map<string, string>} */
    const entryFile = new Map();
    /** @type {string[]} */
    let files = [];
    if (src.dir) files = listGon(join(EXTRACTED_DATA, src.dir));
    else if (src.file) {
      const f = join(EXTRACTED_DATA, src.file);
      if (existsSync(f)) files = [f];
    }
    for (const f of files) {
      for (const key of topLevelKeys(f)) {
        if (!entryFile.has(key)) entryFile.set(key, relative(EXTRACTED_DATA, f).replace(/\\/g, "/"));
      }
    }
    index.set(cat, { names: [...entryFile.keys()].sort(), entryFile });
  }
  indexCache = index;
  return index;
}

/** Clear the in-memory index (e.g. after regeneration). */
export function clearCache() {
  indexCache = null;
  locCache = null;
}

/**
 * List categories with entry counts.
 * @returns {Array<{ category: string, count: number }>}
 */
export function listCategories() {
  const idx = buildIndex();
  return [...idx.entries()].map(([category, ci]) => ({ category, count: ci.names.length }));
}

/**
 * List entry names in a category (optionally filtered by substring).
 * @param {string} category
 * @param {string} [filter]
 * @returns {string[]}
 */
export function listEntries(category, filter) {
  const ci = buildIndex().get(category);
  if (!ci) return [];
  if (!filter) return ci.names;
  const f = filter.toLowerCase();
  return ci.names.filter((n) => n.toLowerCase().includes(f));
}

/**
 * Read one base entry as GON text.
 * @param {string} category
 * @param {string} name
 * @returns {{ category: string, name: string, file: string, gon: string } | null}
 */
export function readEntry(category, name) {
  const ci = buildIndex().get(category);
  if (!ci) return null;
  const rel = ci.entryFile.get(name);
  if (!rel) return null;
  const abs = join(EXTRACTED_DATA, rel);
  const root = parse(readFileSync(abs, "utf8"));
  const field = root.fields.find((f) => (f.key.value ?? f.key.text) === name);
  if (!field) return null;
  const keyText = field.key.text;
  return { category, name, file: rel, gon: keyText + serialize(field.value) };
}

/**
 * Read an arbitrary base file's raw text (read-only, repo-relative under data/).
 * @param {string} repoRelPathUnderData  e.g. "abilities/fighter_abilities.gon"
 * @returns {string}
 */
export function readBaseFile(repoRelPathUnderData) {
  const abs = resolveReadPath(join(EXTRACTED_DATA, repoRelPathUnderData));
  return readFileSync(abs, "utf8");
}

// ---- Localization -----------------------------------------------------------

/**
 * @typedef {Object} LocTable
 * @property {string[]} header       column names (expected 12)
 * @property {Map<string, string[]>} rows  key -> full row (incl. key as col 0)
 * @property {number} columns        column count of the header
 */

/** @type {LocTable|null} */
let locCache = null;

/** The 12 expected localization columns. */
export const LOC_COLUMNS = ["KEY", "en", "notes", "sp", "fr", "de", "it", "pt-br", "ru", "ko", "ja", "zh-cn"];

/**
 * Load the base localization table (cached).
 * @returns {LocTable}
 */
export function loadLocalization() {
  if (locCache) return locCache;
  /** @type {LocTable} */
  let table = { header: LOC_COLUMNS.slice(), rows: new Map(), columns: LOC_COLUMNS.length };
  if (existsSync(COMBINED_CSV)) {
    const rows = parseCsv(readFileSync(COMBINED_CSV, "utf8"));
    const header = rows.length ? rows[0] : LOC_COLUMNS.slice();
    /** @type {Map<string, string[]>} */
    const map = new Map();
    for (let i = 1; i < rows.length; i++) {
      const key = rows[i][0];
      if (key !== undefined && key !== "" && !map.has(key)) map.set(key, rows[i]);
    }
    table = { header, rows: map, columns: header.length };
  }
  locCache = table;
  return table;
}
