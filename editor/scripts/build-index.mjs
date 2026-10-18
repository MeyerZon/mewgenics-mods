#!/usr/bin/env node
// Generate the git-ignored editor/data/ caches:
//   - component-names.json : distilled unique glaiel::<Name> class names
//   - base-index.json      : category -> entry names (+ file) from .extracted/data
// Safe to run repeatedly; it only writes under editor/data/.

import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ensureDataCacheDir, ANALYSIS_DIR } from "../src/core/repo.mjs";
import { distillFromTsv } from "../src/core/components.mjs";
import { buildIndex, hasBaseData } from "../src/core/base-data.mjs";

const dataDir = ensureDataCacheDir();

// Component names.
const tsv = join(ANALYSIS_DIR, "list_names.tsv");
if (existsSync(tsv)) {
  const names = distillFromTsv(tsv);
  writeFileSync(join(dataDir, "component-names.json"), JSON.stringify(names));
  console.log(`component-names.json: ${names.length} glaiel:: classes`);
} else {
  console.log(`component-names.json: SKIPPED (no ${tsv})`);
}

// Base-data index.
if (hasBaseData()) {
  const idx = buildIndex();
  /** @type {Record<string, { count: number, names: string[], files: Record<string,string> }>} */
  const out = {};
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
