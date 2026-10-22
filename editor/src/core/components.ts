// C++ component class names (glaiel::<Name>). The distilled list is cached at
// editor/data/component-names.json by scripts/build-index.ts. If that cache is
// missing we fall back to distilling it on demand from .analysis/list_names.tsv.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_CACHE_DIR, ANALYSIS_DIR, EXTRACTED_DATA } from "./repo.ts";

export const COMPONENT_CACHE_FILE = join(DATA_CACHE_DIR, "component-names.json");
const CACHE_FILE = COMPONENT_CACHE_FILE;
const NAMES_TSV = join(ANALYSIS_DIR, "list_names.tsv");

/** What to do when no component names are known (a fresh clone or git worktree has no editor/data/ cache). */
export const COMPONENT_CACHE_HINT =
  `editor/data/component-names.json missing or empty (${COMPONENT_CACHE_FILE}) — run npm run build:index with ` +
  `.analysis/list_names.tsv present, or set MEWGENICS_EDITOR_DATA to a checkout's editor/data that has it`;

/** Whether a component-name list is available, and the hint when it is not. */
export function componentCacheStatus(): { ok: true; count: number } | { ok: false; hint: string } {
  const n = loadComponentNames().length;
  return n > 0 ? { ok: true, count: n } : { ok: false, hint: COMPONENT_CACHE_HINT };
}

let namesCache: string[] | null = null;
let nameSet: Set<string> | null = null;

/** Distill unique glaiel::<Name> class names from list_names.tsv. */
export function distillFromTsv(tsvPath: string): string[] {
  const text = readFileSync(tsvPath, "utf8");
  const set = new Set<string>();
  const re = /glaiel::([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) set.add(m[1]!);
  return [...set].sort();
}

/** Load the component-name list (cached; built on demand if needed). */
export function loadComponentNames(): string[] {
  if (namesCache) return namesCache;
  if (existsSync(CACHE_FILE)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
      if (Array.isArray(parsed)) namesCache = parsed as string[];
      else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { names?: unknown }).names)) {
        namesCache = (parsed as { names: string[] }).names;
      }
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

export function componentNameSet(): Set<string> {
  if (!nameSet) nameSet = new Set(loadComponentNames());
  return nameSet;
}

export function isComponentName(name: string): boolean {
  return componentNameSet().has(name);
}

/** Search component names by substring. */
export function searchComponentNames(query: string, limit = 50): string[] {
  const q = query.toLowerCase();
  const out: string[] = [];
  for (const n of loadComponentNames()) {
    if (n.toLowerCase().includes(q)) {
      out.push(n);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export interface WhereUsedHit {
  file: string;
  hits: number;
  sample: string[];
}

/**
 * Where-used: find base .gon files that mention a bare token `name`. Scans the
 * extracted data tree with a word-boundary regex. Returns repo-relative paths
 * (under .extracted/data) with a small count of matching lines.
 */
export function whereUsed(name: string, limit = 40): WhereUsedHit[] {
  const results: WhereUsedHit[] = [];
  if (!existsSync(EXTRACTED_DATA)) return results;
  const re = new RegExp("(^|[\\s,{}\\[\\]])" + escapeRe(name) + "([\\s,{}\\[\\]]|$)");
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (results.length >= limit) return;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && (ent.name.endsWith(".gon") || ent.name.endsWith(".csv"))) {
        let text: string;
        try {
          text = readFileSync(full, "utf8");
        } catch {
          continue;
        }
        if (text.length > 4_000_000) continue; // skip the giant combined.csv for speed
        const lines = text.split(/\r?\n/);
        const sample: string[] = [];
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

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
