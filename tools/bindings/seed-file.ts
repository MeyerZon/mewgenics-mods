#!/usr/bin/env node
// Write a REA_GHIDRA_SEED_FILE from a bindings manifest (docs/binding-port.md, step "ambiguous entries").
//   node tools/bindings/seed-file.ts --manifest bindings/<build>.json [--out .analysis/seeds-<build>.tsv]
// With the OLD manifest the old exe gets our names; with a PORTED manifest (bindings/<new>.json
// written by port.ts --apply) the new exe gets the ported names plus Name__cand_<rva> seeds for
// every ambiguous entry, so REA compare_functions can pair old vs candidate by name.
// Prints to stdout without --out. Never writes under saves/.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadManifest } from "../../editor/src/core/bindings/manifest.ts";
import { seedFromManifest } from "../../editor/src/core/bindings/seed.ts";
import { touchesSaves, SafetyError } from "../../editor/src/core/repo.ts";

const argv = process.argv.slice(2);
/** @param {string} flag */
const opt = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const manifestPath = opt("--manifest");
if (!manifestPath) {
  console.error("usage: node tools/bindings/seed-file.ts --manifest bindings/<build>.json [--out path]");
  process.exit(2);
}
const text = seedFromManifest(loadManifest(manifestPath));
const out = opt("--out");
if (out) {
  const abs = resolve(out);
  if (touchesSaves(abs)) throw new SafetyError(`refusing to write under a saves directory: ${abs}`);
  writeFileSync(abs, text);
  console.log(`wrote ${abs} (${text.split("\n").filter((l) => l && !l.startsWith("#")).length} seeds); use: REA_GHIDRA_SEED_FILE=${abs}`);
} else process.stdout.write(text);
