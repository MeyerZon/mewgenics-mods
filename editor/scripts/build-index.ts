#!/usr/bin/env node
// Generate the git-ignored editor/data/ caches:
//   - component-names.json : distilled unique glaiel::<Name> class names
//   - base-index.json      : category -> entry names (+ file) from .extracted/data
//   - audio-index.json     : every pack audio/ path + the sound sets' groups and music_info tracks, read from the
//                            resources.gpak index and its audio/*.gon entries (opened read-only; nothing extracted)
// Safe to run repeatedly; it only writes under editor/data/.

import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ensureDataCacheDir, ANALYSIS_DIR } from "../src/core/repo.ts";
import { distillFromTsv, COMPONENT_CACHE_HINT } from "../src/core/components.ts";
import { buildIndex, hasBaseData } from "../src/core/base-data.ts";
import { openGpak } from "../src/core/gpak-index.ts";
import { buildAudioIndex, audioIndexToJson, AUDIO_INDEX_FILE } from "../src/core/audio/sound-sets.ts";
import { locateGameDir } from "../src/core/ingame/launch.ts";

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

// Audio index (sounds and music), from the installed pack.
const gpakPath = join(locateGameDir(process.env), "resources.gpak");
if (existsSync(gpakPath)) {
  const g = openGpak(gpakPath);
  try {
    const byPath = new Map(g.entries.map((e) => [e.path, e]));
    const ix = buildAudioIndex(g.entries.map((e) => e.path), (p) => new TextDecoder().decode(g.read(byPath.get(p)!)));
    writeFileSync(join(dataDir, AUDIO_INDEX_FILE), JSON.stringify({ generatedAt: new Date().toISOString(), ...audioIndexToJson(ix) }));
    const groups = [...ix.sets.values()].reduce((a, s) => a + s.events.size, 0);
    console.log(`${AUDIO_INDEX_FILE}: ${ix.files.size} audio files, ${ix.sets.size} sound sets, ${groups} groups, ${ix.music.size} music tracks`);
  } finally {
    g.close();
  }
} else {
  console.log(`${AUDIO_INDEX_FILE}: SKIPPED (no ${gpakPath}; set MEWGENICS_DIR to the game folder)`);
}

console.log(`done -> ${dataDir}`);
