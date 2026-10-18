#!/usr/bin/env node
// Derive unique byte signatures for functions in Mewgenics.exe.
//   node tools/make-signature.mjs <exe> <name=rva> [<name=rva> ...]
// For each RVA, finds the shortest exact byte prefix (min 12, max 64 bytes) that occurs exactly
// once in the executable sections, and prints a bindings line. Exact prefixes may break across
// builds when they contain rel32 operands; refine by hand with ?? wildcards where needed.
import { readFileSync } from "node:fs";
const [exePath, ...pairs] = process.argv.slice(2);
const b = readFileSync(exePath);
const pe = b.readUInt32LE(0x3c);
const nsec = b.readUInt16LE(pe + 6), optSize = b.readUInt16LE(pe + 20);
const secTab = pe + 24 + optSize;
const secs = [];
for (let i = 0; i < nsec; i++) {
  const o = secTab + i * 40;
  secs.push({ name: b.toString("latin1", o, o + 8).replace(/\0.*$/, ""), vsize: b.readUInt32LE(o + 8), va: b.readUInt32LE(o + 12), rawSize: b.readUInt32LE(o + 16), raw: b.readUInt32LE(o + 20), chars: b.readUInt32LE(o + 36) });
}
const exec = secs.filter((s) => s.chars & 0x20000000);
const rvaToOff = (rva) => { for (const s of secs) if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) return s.raw + (rva - s.va); return -1; };
function countOccurrences(needle, limit = 2) {
  let n = 0;
  for (const s of exec) {
    const hay = b.subarray(s.raw, s.raw + s.rawSize);
    let i = 0;
    while ((i = hay.indexOf(needle, i)) !== -1) { if (++n >= limit) return n; i++; }
  }
  return n;
}
for (const p of pairs) {
  const [name, rvaStr] = p.split("=");
  const rva = parseInt(rvaStr, 16);
  const off = rvaToOff(rva);
  if (off < 0) { console.log(`${name}\t0x${rva.toString(16)}\tUNMAPPED`); continue; }
  let sig = null;
  for (let len = 12; len <= 160; len += 2) {
    const needle = b.subarray(off, off + len);
    if (countOccurrences(needle) === 1) { sig = needle; break; }
  }
  const hex = (sig || b.subarray(off, off + 64)).toString("hex").match(/../g).join(" ").toUpperCase();
  console.log(`${name}\t0x${rva.toString(16)}\t${sig ? sig.length : "NOT-UNIQUE@160"}\t${hex}`);
}
