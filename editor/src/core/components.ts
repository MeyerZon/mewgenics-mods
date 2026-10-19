// C++ component class names (glaiel::<Name>). The distilled list is cached at
// editor/data/component-names.json by scripts/build-index.ts. If that cache is
// missing we fall back to distilling it on demand from .analysis/list_names.tsv.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_CACHE_DIR, ANALYSIS_DIR, EXTRACTED_DATA } from "./repo.ts";

const CACHE_FILE = join(DATA_CACHE_DIR, "component-names.json");
const NAMES_TSV = join(ANALYSIS_DIR, "list_names.tsv");

/** @type {string[]|null} */
let namesCache = null;
/** @type {Set<string>|null} */
let nameSet = null;

/**
 * Distill unique glaiel::<Name> class names from list_names.tsv.
 * @param {string} tsvPath
 * @returns {string[]}
 */
export function distillFromTsv(tsvPath) {
  const text = readFileSync(tsvPath, "utf8");
  /** @type {Set<string>} */
  const set = new Set();
  const re = /glaiel::([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(text)) !== null) set.add(m[1]);
  return [...set].sort();
}

/**
 * Load the component-name list (cached; built on demand if needed).
 * @returns {string[]}
 */
export function loadComponentNames() {
  if (namesCache) return namesCache;
  if (existsSync(CACHE_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
      if (Array.isArray(parsed)) namesCache = parsed;
      else if (parsed && Array.isArray(parsed.names)) namesCache = parsed.names;
    } catch {
      namesCache = null;
    }
  }
  if (!namesCache && existsSync(NAMES_TSV)) {
    namesCache = distillFromTsv(NAMES_TSV);
  }
  if (!namesCache) namesCache = [];
  return namesCache;
}

/** @returns {Set<string>} */
export function componentNameSet() {
  if (!nameSet) nameSet = new Set(loadComponentNames());
  return nameSet;
}

/** @param {string} name */
export function isComponentName(name) {
  return componentNameSet().has(name);
}

/**
 * Search component names by substring.
 * @param {string} query
 * @param {number} [limit]
 * @returns {string[]}
 */
export function searchComponentNames(query, limit = 50) {
  const q = query.toLowerCase();
  const out = [];
  for (const n of loadComponentNames()) {
    if (n.toLowerCase().includes(q)) {
      out.push(n);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * Where-used: find base .gon files that mention a bare token `name`. Scans the
 * extracted data tree with a word-boundary regex. Returns repo-relative paths
 * (under .extracted/data) with a small count of matching lines.
 * @param {string} name
 * @param {number} [limit]
 * @returns {Array<{ file: string, hits: number, sample: string[] }>}
 */
export function whereUsed(name, limit = 40) {
  /** @type {Array<{ file: string, hits: number, sample: string[] }>} */
  const results = [];
  if (!existsSync(EXTRACTED_DATA)) return results;
  const re = new RegExp("(^|[\\s,{}\\[\\]])" + escapeRe(name) + "([\\s,{}\\[\\]]|$)");
  /** @param {string} dir */
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (results.length >= limit) return;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && (ent.name.endsWith(".gon") || ent.name.endsWith(".csv"))) {
        let text;
        try {
          text = readFileSync(full, "utf8");
        } catch {
          continue;
        }
        if (text.length > 4_000_000) continue; // skip the giant combined.csv for speed
        const lines = text.split(/\r?\n/);
        const sample = [];
        let hits = 0;
        for (const line of lines) {
          if (re.test(line)) {
            hits++;
            if (sample.length < 3) sample.push(line.trim().slice(0, 160));
          }
        }
        if (hits > 0) {
          results.push({
            file: full.slice(EXTRACTED_DATA.length + 1).replace(/\\/g, "/"),
            hits,
            sample,
          });
        }
      }
    }
  };
  walk(EXTRACTED_DATA);
  return results;
}

/** @param {string} s */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
