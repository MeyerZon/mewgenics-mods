// Base game data access: index the extracted .gon files, read individual
// entries, and load the localization table. Everything here is read-only against
// .extracted/ and is cached in memory for the life of the process.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "./gon/parser.ts";
import { serialize } from "./gon/parser.ts";
import { EXTRACTED_DATA, COMBINED_CSV, resolveReadPath } from "./repo.ts";
import { parseCsv } from "./overlay/csv.ts";

/**
 * Category -> where its entries live. A `dir` scans every *.gon in that folder;
 * a `file` reads top-level keys from one file.
 */
const CATEGORY_SOURCES: Record<string, { dir?: string; file?: string }> = {
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

export interface CategoryIndex {
  /** sorted entry names */
  names: string[];
  /** name -> repo-relative file path */
  entryFile: Map<string, string>;
}

let indexCache: Map<string, CategoryIndex> | null = null;

/** Whether extracted base data is present. */
export function hasBaseData(): boolean {
  return existsSync(EXTRACTED_DATA);
}

/** Recursively list *.gon files under a directory (absolute paths). */
function listGon(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listGon(full));
    else if (ent.isFile() && ent.name.endsWith(".gon")) out.push(full);
  }
  return out;
}

/** Top-level field keys (decoded) of a GON file. */
function topLevelKeys(absFile: string): string[] {
  try {
    const root = parse(readFileSync(absFile, "utf8"));
    return root.fields.map((f) => f.key.value ?? f.key.text);
  } catch {
    return [];
  }
}

/** Build (and cache) the base-data index. */
export function buildIndex(): Map<string, CategoryIndex> {
  if (indexCache) return indexCache;
  const index = new Map<string, CategoryIndex>();
  for (const [cat, src] of Object.entries(CATEGORY_SOURCES)) {
    const entryFile = new Map<string, string>();
    let files: string[] = [];
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
export function clearCache(): void {
  indexCache = null;
  locCache = null;
}

export interface CategoryCount {
  category: string;
  count: number;
}

/** List categories with entry counts. */
export function listCategories(): CategoryCount[] {
  const idx = buildIndex();
  return [...idx.entries()].map(([category, ci]) => ({ category, count: ci.names.length }));
}

/** List entry names in a category (optionally filtered by substring). */
export function listEntries(category: string, filter?: string): string[] {
  const ci = buildIndex().get(category);
  if (!ci) return [];
  if (!filter) return ci.names;
  const f = filter.toLowerCase();
  return ci.names.filter((n) => n.toLowerCase().includes(f));
}

export interface BaseEntry {
  category: string;
  name: string;
  file: string;
  gon: string;
}

/** Read one base entry as GON text. */
export function readEntry(category: string, name: string): BaseEntry | null {
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
 * @param repoRelPathUnderData e.g. "abilities/fighter_abilities.gon"
 */
export function readBaseFile(repoRelPathUnderData: string): string {
  const abs = resolveReadPath(join(EXTRACTED_DATA, repoRelPathUnderData));
  return readFileSync(abs, "utf8");
}

// ---- Localization -----------------------------------------------------------

export interface LocTable {
  /** column names (expected 12) */
  header: string[];
  /** key -> full row (incl. key as col 0) */
  rows: Map<string, string[]>;
  /** column count of the header */
  columns: number;
}

let locCache: LocTable | null = null;

/** The 12 expected localization columns. */
export const LOC_COLUMNS = ["KEY", "en", "notes", "sp", "fr", "de", "it", "pt-br", "ru", "ko", "ja", "zh-cn"];

/** Load the base localization table (cached). */
export function loadLocalization(): LocTable {
  if (locCache) return locCache;
  let table: LocTable = { header: LOC_COLUMNS.slice(), rows: new Map(), columns: LOC_COLUMNS.length };
  if (existsSync(COMBINED_CSV)) {
    const rows = parseCsv(readFileSync(COMBINED_CSV, "utf8"));
    const header = rows.length ? rows[0]! : LOC_COLUMNS.slice();
    const map = new Map<string, string[]>();
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]!;
      const key = row[0];
      if (key !== undefined && key !== "" && !map.has(key)) map.set(key, row);
    }
    table = { header, rows: map, columns: header.length };
  }
  locCache = table;
  return table;
}
