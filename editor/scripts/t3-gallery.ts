// npm run t3 — the T3 looks gallery: read the curated list editor/t3-looks.json, find each item's shots under the
// editor data dir (MEWGENICS_EDITOR_DATA, default editor/data/; a `*` segment = the newest run dir holding the file),
// copy them as-is into <data>/t3-gallery/shots/ (so the page survives run-dir cleanup) and write
// <data>/t3-gallery/index.html (src/core/t3-gallery.ts renders it). Opens nothing, runs no game. Both paths are
// git-ignored (editor/data/). Exit 1 when t3-looks.json has errors.
//   node scripts/t3-gallery.ts

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_CACHE_DIR } from "../src/core/repo.ts";
import { parseLooks, resolveShot, copiedName, renderGallery, summarize, type ResolvedItem, type ShotFs } from "../src/core/t3-gallery.ts";

const EDITOR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_URL = "https://github.com/MeyerZon/mewgenics-mods";

const { items, errors } = parseLooks(readFileSync(join(EDITOR, "t3-looks.json"), "utf8"));
if (errors.length) { for (const e of errors) console.error(`t3-looks.json: ${e}`); process.exit(1); }

const abs = (rel: string) => join(DATA_CACHE_DIR, ...rel.split("/"));
const fs: ShotFs = {
  exists: (rel) => { try { return statSync(abs(rel)).isFile(); } catch { return false; } },
  list: (rel) => { try { return readdirSync(abs(rel)); } catch { return []; } },
};

const outDir = join(DATA_CACHE_DIR, "t3-gallery");
const shotsDir = join(outDir, "shots");
mkdirSync(shotsDir, { recursive: true });

let copied = 0, kept = 0;
const seen = new Set<string>();
const resolved: ResolvedItem[] = items.map((it) => {
  const found: ResolvedItem["found"] = [];
  const missing: string[] = [];
  for (const pattern of it.shots) {
    const rel = resolveShot(pattern, fs);
    if (!rel) { missing.push(pattern); continue; }
    const file = copiedName(rel);
    const dst = join(shotsDir, file);
    const src = abs(rel);
    if (!seen.has(file)) {
      seen.add(file);
      const a = existsSync(dst) ? statSync(dst) : null, b = statSync(src);
      if (a && a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 2000) kept++;
      else { copyFileSync(src, dst); copied++; }
    }
    found.push({ pattern, file });
  }
  return { ...it, found, missing };
});

const index = join(outDir, "index.html");
writeFileSync(index, renderGallery(resolved, { generatedAt: new Date().toISOString(), repoUrl: REPO_URL }));
const s = summarize(resolved);
console.log(`T3 gallery: ${index}`);
console.log(`  ${s.total} items: ${s.withShots} with shots, ${s.needsRerun} need a re-run, ${s.handsOn} hands-on (shots: ${copied} copied, ${kept} already there)`);
for (const it of resolved) {
  if (it.missing.length) console.log(`  needs re-run  ${it.id}: ${it.regenerate}  (missing ${it.missing.join(", ")})`);
}
