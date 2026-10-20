#!/usr/bin/env node
// Regenerate native/framework/src/signatures.h and offsets.h from every bindings/<build>.json.
//   node tools/bindings/gen-headers.ts            write the headers (reports which changed)
//   node tools/bindings/gen-headers.ts --check    exit 1 if a committed header is stale
// Also reachable as `npm run bindings:gen` / `npm run bindings:check` from editor/.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../../editor/src/core/repo.ts";
import { listManifests } from "../../editor/src/core/bindings/manifest.ts";
import { generateHeaders } from "../../editor/src/core/bindings/gen-headers.ts";

const check = process.argv.includes("--check");
const manifests = listManifests();
if (manifests.length === 0) {
  console.error("no bindings/<build>.json manifests found");
  process.exit(2);
}
console.log(`manifests: ${manifests.map((m) => m.manifest.build.steamBuildId).join(", ")}`);
const out = generateHeaders(manifests.map((m) => m.manifest));
let stale = 0;
for (const [rel, text] of Object.entries(out)) {
  const p = join(REPO_ROOT, rel);
  const cur = existsSync(p) ? readFileSync(p, "utf8").replace(/\r\n/g, "\n") : null;
  const same = cur === text;
  if (same) console.log(`  up to date  ${rel}`);
  else if (check) { console.log(`  STALE       ${rel}`); stale++; }
  else { writeFileSync(p, text); console.log(`  wrote       ${rel}`); }
}
if (check && stale) {
  console.error(`${stale} header(s) stale: run npm run bindings:gen in editor/`);
  process.exit(1);
}
