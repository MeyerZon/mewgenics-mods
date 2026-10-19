#!/usr/bin/env node
// Harvest (and verify) the anchors in a bindings manifest against its exe.
//   node tools/bindings/harvest.mjs <exe> --manifest bindings/<build>.json [--write] [--all]
// Prints one row per entry (mismatch / unresolved always; the rest with --all) and a summary;
// --write saves the harvested manifest (values are never rewritten, only anchors). Exit 1 on any
// mismatch, 0 otherwise. Run it on the CURRENT build before a game update takes the old exe away.
import { readFileSync } from "node:fs";
import { parsePe } from "../../editor/src/core/bindings/pe.mjs";
import { loadManifest, saveManifest } from "../../editor/src/core/bindings/manifest.mjs";
import { harvestManifest } from "../../editor/src/core/bindings/harvest.mjs";

const argv = process.argv.slice(2);
const exePath = argv[0];
const mi = argv.indexOf("--manifest");
if (!exePath || mi < 0 || !argv[mi + 1]) {
  console.error("usage: node tools/bindings/harvest.mjs <exe> --manifest bindings/<build>.json [--write] [--all]");
  process.exit(2);
}
const path = argv[mi + 1];
const write = argv.includes("--write");
const all = argv.includes("--all");
const buf = readFileSync(exePath);
const pe = parsePe(buf);
const m = loadManifest(path);
if (parseInt(m.build.timeDateStamp, 16) !== pe.timeDateStamp || parseInt(m.build.sizeOfImage, 16) !== pe.sizeOfImage) {
  console.error(`exe identity (${pe.timeDateStamp.toString(16)}/${pe.sizeOfImage.toString(16)}) does not match manifest ${m.build.steamBuildId}`);
  process.exit(1);
}
const { manifest, report, changed } = harvestManifest(pe, buf, m);
/** @type {Record<string, number>} */
const counts = {};
for (const r of report) {
  counts[r.status] = (counts[r.status] || 0) + 1;
  if (all || r.status === "mismatch" || r.status === "unresolved") console.log(`  ${r.status.padEnd(10)} ${r.name.padEnd(34)} ${r.detail}`);
}
console.log(`\n${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}; manifest ${changed ? "changed" : "unchanged"}`);
if (write && changed) {
  saveManifest(path, manifest);
  console.log(`wrote ${path}`);
} else if (changed) console.log("(dry run; add --write to save)");
process.exit(counts.mismatch ? 1 : 0);
