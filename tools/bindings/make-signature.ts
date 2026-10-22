#!/usr/bin/env node
// Derive unique byte signatures with relocation bytes wildcarded (editor/src/core/bindings/siggen.ts).
//
//   node tools/bindings/make-signature.ts <exe> <name=rva(hex)> ...
//       print one TSV line per symbol: name, rva, length, offset, pattern (?? = wildcard)
//   node tools/bindings/make-signature.ts <exe> --manifest bindings/<build>.json [--write] [--only name,...]
//       regenerate the signature of every function entry that has one (or of --only names, which may
//       also add a signature to an entry that has none); report old -> new; --write saves the manifest.
//       An entry whose regeneration fails keeps its old signature and is listed (never silently dropped).
//
// Afterwards run `npm run bindings:gen` (editor/) so signatures.h follows the manifest.
import { readFileSync } from "node:fs";
import { parsePe } from "../../editor/src/core/bindings/pe.ts";
import { makeSignature } from "../../editor/src/core/bindings/siggen.ts";
import { loadManifest, saveManifest } from "../../editor/src/core/bindings/manifest.ts";

const argv = process.argv.slice(2);
const exePath = argv[0];
if (!exePath || argv.length < 2) {
  console.error("usage: node tools/bindings/make-signature.ts <exe> (<name=rva> ... | --manifest <path> [--write] [--only a,b])");
  process.exit(2);
}
const buf = readFileSync(exePath);
const pe = parsePe(buf);

const mi = argv.indexOf("--manifest");
if (mi >= 0) {
  const path = argv[mi + 1];
  const write = argv.includes("--write");
  const oi = argv.indexOf("--only");
  const only = oi >= 0 ? new Set(String(argv[oi + 1]).split(",")) : null;
  const m = loadManifest(path);
  if (parseInt(m.build.timeDateStamp, 16) !== pe.timeDateStamp || parseInt(m.build.sizeOfImage, 16) !== pe.sizeOfImage) {
    console.error(`exe identity (${pe.timeDateStamp.toString(16)}/${pe.sizeOfImage.toString(16)}) does not match manifest ${m.build.steamBuildId}; use the port tool for a different build`);
    process.exit(1);
  }
  let changed = 0, same = 0, failed = 0, wild = 0, skipped = 0;
  for (const e of m.entries) {
    if (e.kind !== "function") continue;
    if (!only && !e.signature) { skipped++; console.log(`  skipped (null)  ${e.name} (no signature on this build; name it with --only to try one)`); continue; }
    if (only && !only.has(e.name)) continue;
    const r = makeSignature(pe, buf, parseInt(e.rva || "0", 16), { minLen: 12, cap: m.sigCap });
    if (!r.ok) { failed++; console.log(`  FAILED      ${e.name}: ${r.reason}${e.signature ? " (kept old signature)" : ""}`); continue; }
    if (r.signature.wildcards.length) wild++;
    const old = e.signature ? `${e.signature.exactLen}B${e.signature.wildcards.length ? ` ${e.signature.wildcards.length}w` : ""}${e.signature.offset ? ` off ${e.signature.offset}` : ""}` : "none";
    const neu = `${r.signature.exactLen}B${r.signature.wildcards.length ? ` ${r.signature.wildcards.length}w` : ""}${r.signature.offset ? ` off ${r.signature.offset}` : ""}`;
    if (e.signature && e.signature.pattern === r.signature.pattern && e.signature.offset === r.signature.offset) { same++; console.log(`  unchanged   ${e.name} (${neu})`); continue; }
    changed++;
    console.log(`  ${e.signature ? "changed    " : "added      "} ${e.name}: ${old} -> ${neu}`);
    e.signature = r.signature;
  }
  console.log(`\n${changed} changed, ${same} unchanged, ${failed} failed, ${skipped} skipped (null); ${wild} with wildcards`);
  if (write) {
    saveManifest(path, m);
    console.log(`wrote ${path}; now run: cd editor && npm run bindings:gen`);
  } else if (changed) console.log("(dry run; add --write to save)");
  process.exit(failed ? 1 : 0);
}

for (const pair of argv.slice(1)) {
  const [name, rvaStr] = pair.split("=");
  const rva = parseInt(rvaStr, 16);
  if (!name || !Number.isFinite(rva)) { console.log(`${pair}\tBAD-ARG`); continue; }
  const r = makeSignature(pe, buf, rva, { minLen: 12 });
  if (!r.ok) console.log(`${name}\t0x${rva.toString(16)}\tFAILED\t${r.reason}`);
  else console.log(`${name}\t0x${rva.toString(16)}\t${r.signature.exactLen}\t${r.signature.offset}\t${r.signature.pattern}`);
}
