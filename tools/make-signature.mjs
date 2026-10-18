#!/usr/bin/env node
// Derive unique byte signatures for functions in Mewgenics.exe.
//   node tools/make-signature.mjs <exe> <name=rva> [<name=rva> ...]
// For each RVA, finds the shortest exact byte prefix (min 12, max FW_SIG_MAX_BYTES = 128 bytes,
// the DLL's parser cap) that occurs exactly once in the executable sections, and prints a
// bindings TSV line. Scanning uses editor/src/core/bindings/scan.mjs, i.e. exactly what the
// framework DLL does at load time (loader view of each executable section, exactly-once rule).
// Exact prefixes may break across builds when they contain rel32 operands; the manifest
// generator (tools/bindings/make-signature.mjs, later) wildcards those.
import { readFileSync } from "node:fs";
import { parsePe } from "../editor/src/core/bindings/pe.mjs";
import { scanExec, exactPattern, FW_SIG_MAX_BYTES } from "../editor/src/core/bindings/scan.mjs";

const [exePath, ...pairs] = process.argv.slice(2);
if (!exePath || pairs.length === 0) {
  console.error("usage: node tools/make-signature.mjs <exe> <name=rva(hex)> ...");
  process.exit(2);
}
const b = readFileSync(exePath);
const pe = parsePe(b);
const MIN = 12;
const MAX = FW_SIG_MAX_BYTES;
/** @param {Uint8Array} bytes */
const hex = (bytes) => Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join(" ").toUpperCase();

for (const p of pairs) {
  const [name, rvaStr] = p.split("=");
  const rva = parseInt(rvaStr, 16);
  const off = pe.rvaToOff(rva);
  if (off < 0) { console.log(`${name}\t0x${rva.toString(16)}\tUNMAPPED`); continue; }
  let sig = null;
  for (let len = MIN; len <= MAX; len += 2) {
    const needle = b.subarray(off, off + len);
    const r = scanExec(pe, b, exactPattern(needle));
    if (r.count === 1 && r.hits[0] === rva) { sig = needle; break; }
  }
  console.log(`${name}\t0x${rva.toString(16)}\t${sig ? sig.length : `NOT-UNIQUE@${MAX}`}\t${hex(sig || b.subarray(off, off + 64))}`);
}
