#!/usr/bin/env node
// Generate the git-ignored editor/data/ caches:
//   - component-names.json : distilled unique glaiel::<Name> class names
//   - base-index.json      : category -> entry names (+ file) from .extracted/data
// Safe to run repeatedly; it only writes under editor/data/.

import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ensureDataCacheDir, ANALYSIS_DIR } from "../src/core/repo.ts";
import { distillFromTsv, COMPONENT_CACHE_HINT } from "../src/core/components.ts";
import { buildIndex, hasBaseData } from "../src/core/base-data.ts";

const dataDir = ensureDataCacheDir();

// Component names.
const tsv = join(ANALYSIS_DIR, "list_names.tsv");
if (existsSync(tsv)) {
  const names = distillFromTsv(tsv);
  writeFileSync(join(dataDir, "component-names.json"), JSON.stringify(names));
  console.log(`component-names.json: ${names.length} glaiel:: classes`);
} else if (existsSync(join(dataDir, "component-names.json"))) {
  console.log(`component-names.json: kept the existing cache (no ${tsv} to rebuild it from)`);
} else {
  console.log(`component-names.json: SKIPPED (no ${tsv}); ${COMPONENT_CACHE_HINT}`);
}

// Base-data index.
if (hasBaseData()) {
  const idx = buildIndex();
  const out: Record<string, { count: number; names: string[]; files: Record<string, string> }> = {};
  for (const [cat, ci] of idx.entries()) {
    out[cat] = { count: ci.names.length, names: ci.names, files: Object.fromEntries(ci.entryFile) };
  }
  writeFileSync(join(dataDir, "base-index.json"), JSON.stringify({ generatedAt: new Date().toISOString(), categories: out }, null, 1));
  const total = Object.values(out).reduce((a, c) => a + c.count, 0);
  console.log(`base-index.json: ${Object.keys(out).length} categories, ${total} entries`);
} else {
  console.log("base-index.json: SKIPPED (no .extracted/data)");
}

console.log(`done -> ${dataDir}`);
