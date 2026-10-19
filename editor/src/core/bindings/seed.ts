// REA_GHIDRA_SEED_FILE generation. Windows Ghidra under REA is read-only (no set_address_name),
// but a seed file (`address<TAB>function|code|label[<TAB>name]`, applied before auto-analysis)
// gives the OLD exe our names, and gives the NEW exe the ported names plus one `function` seed
// per candidate of every ambiguous entry, so `compare_functions` (which pairs by name) can be
// run between the old function and each candidate. Pure; node built-ins only.

import { parseValue } from "./manifest.ts";

/** @typedef {{ address: number, kind: "function"|"code"|"label", name?: string }} SeedRow */

/**
 * @param {import("./manifest.ts").Manifest} m
 * @param {{ comment?: string }} [opts]
 * @returns {string}
 */
export function seedFromManifest(m, opts = {}) {
  const base = parseValue(m.build.imageBase);
  /** @type {SeedRow[]} */
  const rows = [];
  for (const e of m.entries) {
    const p = e.port;
    if (e.kind === "function") {
      if (p && p.status === "ambiguous" && Array.isArray(p.candidates)) {
        for (const c of p.candidates) rows.push({ address: base + parseInt(c.rva, 16), kind: "function", name: `${e.name}__cand_${c.rva}` });
        continue;
      }
      if (p && (p.status === "failed" || p.status === "needs-human")) continue; // no trustworthy address
      if (e.rva) rows.push({ address: base + parseInt(e.rva, 16), kind: "function", name: e.name });
    } else if (e.kind === "data" || e.kind === "vtable") {
      if (p && (p.status === "failed" || p.status === "ambiguous")) continue;
      if (e.rva) rows.push({ address: base + parseInt(e.rva, 16), kind: "label", name: e.name });
    }
  }
  rows.sort((a, b) => b.address - a.address);
  const header = [
    `# REA_GHIDRA_SEED_FILE for Mewgenics ${m.build.name} (steamBuildId ${m.build.steamBuildId}, exe sha256 ${m.build.exeSha256})`,
    `# generated from bindings/${m.build.steamBuildId}.json by tools/bindings/seed-file.ts; image base ${m.build.imageBase}`,
    `# ${rows.filter((r) => r.kind === "function").length} function seeds, ${rows.filter((r) => r.kind === "label").length} label seeds` + (opts.comment ? `; ${opts.comment}` : ""),
  ];
  return header.concat(rows.map((r) => `0x${r.address.toString(16)}\t${r.kind}${r.name ? `\t${r.name}` : ""}`)).join("\n") + "\n";
}

/**
 * @param {string} text
 * @returns {SeedRow[]}
 */
export function parseSeed(text) {
  /** @type {SeedRow[]} */
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.startsWith("#")) continue;
    const m = /^(0x[0-9a-fA-F]+)\t(function|code|label)(?:\t(\S.*))?$/.exec(line);
    if (!m) throw new Error(`seed file line ${i + 1}: expected "0xADDR<TAB>function|code|label[<TAB>name]", got ${JSON.stringify(line)}`);
    if (m[2] === "label" && !m[3]) throw new Error(`seed file line ${i + 1}: a label needs a name`);
    out.push({ address: parseInt(m[1], 16), kind: /** @type {SeedRow["kind"]} */ (m[2]), name: m[3] });
  }
  return out;
}
