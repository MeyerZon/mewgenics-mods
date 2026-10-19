// Harvest: record, for every manifest entry, the evidence that lets the port step find the
// same thing in a rebuilt exe. Functions: the MSVC __FUNCSIG__ / __FILE__ strings they reference
// (rip-relative lea), their callees and rip-relative references by ordinal, size and counts
// (cfgLite) and a wildcarded prologue. Vtables: the RTTI chain (TypeDescriptor name -> complete
// object locator -> vftable). Constants: a vtable slot body. Globals: the ordinal of the
// rip-relative reference inside a witness function. harvestManifest also *verifies* every
// anchor against the current exe and reports mismatches without rewriting values.
// Pure over (pe, buf); node built-ins only.

import { sectionBytes } from "./pe.mjs";
import { parsePattern, patternToString } from "./scan.mjs";
import { decodeInstruction } from "./siggen.mjs";
import { hex, parseValue, entry } from "./manifest.mjs";

/** @typedef {{ text: string, role: "funcsig"|"file"|"literal", unique: boolean }} StringAnchor */
/** @typedef {{ ordinal: number, name: string, target: string }} CalleeAnchor  a call to a manifest entry; ordinal counts every call in the function */
/** @typedef {{ ordinal: number, opcode: string, target: string }} RipRef */
/**
 * @typedef {{
 *   strings: StringAnchor[], callees: CalleeAnchor[], ripRefs: RipRef[],
 *   cfgLite: { bytes: number, calls: number, ripRefs: number, resyncs: number }, prologue: string,
 * }} FunctionHarvest
 */

/** @param {import("./pe.mjs").Pe} pe */
const dataSections = (pe) => pe.sections.filter((s) => !s.exec && s.rawSize > 0);

/**
 * Read a NUL-terminated latin1 string at an RVA (null when unmapped or unterminated within max).
 * @param {import("./pe.mjs").Pe} pe @param {Buffer} buf @param {number} rva @param {number} [max]
 * @returns {string|null}
 */
export function cstringAt(pe, buf, rva, max = 2048) {
  const off = pe.rvaToOff(rva);
  if (off < 0) return null;
  let e = off;
  while (e < buf.length && e - off < max && buf[e] !== 0) e++;
  if (e >= buf.length || buf[e] !== 0) return null;
  return buf.toString("latin1", off, e);
}

/**
 * Find a NUL-terminated string (whole string: preceded by NUL or the section start) in the data
 * sections. Returns the first RVA and how many times it occurs (capped at 3).
 * @param {import("./pe.mjs").Pe} pe @param {Buffer} buf @param {string} text
 * @returns {{ rva: number|null, count: number }}
 */
export function findString(pe, buf, text) {
  const needle = Buffer.from(text + "\0", "latin1");
  /** @type {number|null} */
  let first = null;
  let count = 0;
  for (const s of dataSections(pe)) {
    const bytes = sectionBytes(buf, s);
    let i = 0;
    while ((i = bytes.indexOf(needle, i)) !== -1) {
      if (i === 0 || bytes[i - 1] === 0) {
        if (first === null) first = s.va + i;
        if (++count >= 3) return { rva: first, count };
      }
      i++;
    }
  }
  return { rva: first, count };
}

/** @type {WeakMap<Buffer, Map<number, number[]>>} */
const leaCache = new WeakMap();

/**
 * One pass over the executable sections collecting every rip-relative lea site by target RVA.
 * @param {import("./pe.mjs").Pe} pe @param {Buffer} buf
 * @returns {Map<number, number[]>} target rva -> lea instruction rvas
 */
export function leaIndex(pe, buf) {
  const cached = leaCache.get(buf);
  if (cached) return cached;
  /** @type {Map<number, number[]>} */
  const idx = new Map();
  for (const s of pe.execSections) {
    const b = sectionBytes(buf, s);
    const n = b.length;
    for (let i = 0; i + 7 <= n; i++) {
      const b0 = b[i];
      if ((b0 === 0x48 || b0 === 0x4c) && b[i + 1] === 0x8d && (b[i + 2] & 0xc7) === 0x05) {
        const disp = (b[i + 3] | (b[i + 4] << 8) | (b[i + 5] << 16) | (b[i + 6] << 24)) | 0;
        const target = s.va + i + 7 + disp;
        const list = idx.get(target);
        if (list) list.push(s.va + i);
        else idx.set(target, [s.va + i]);
      }
    }
  }
  leaCache.set(buf, idx);
  return idx;
}

/**
 * Every rip-relative lea that points at `rva`, with the .pdata function containing the site.
 * @param {import("./pe.mjs").Pe} pe @param {Buffer} buf @param {number} rva
 * @returns {{ at: number, fn: import("./pe.mjs").RuntimeFunction|null }[]}
 */
export function findStringXrefs(pe, buf, rva) {
  return (leaIndex(pe, buf).get(rva) || []).map((at) => ({ at, fn: pe.pdata.find(at) }));
}

/**
 * Decode a whole .pdata function (or `fallbackBytes` when it is not in .pdata). Unknown opcodes
 * are skipped one byte at a time (counted in `resyncs`) so counting continues.
 * @param {import("./pe.mjs").Pe} pe @param {Buffer} buf @param {number} rva
 * @returns {{ begin: number, end: number, instrs: { at: number, ins: import("./siggen.mjs").Instruction }[], resyncs: number, bytes: Uint8Array }}
 */
export function decodeFunction(pe, buf, rva, fallbackBytes = 256) {
  const fn = pe.pdata.find(rva);
  const begin = fn && fn.begin === rva ? fn.begin : rva;
  const end = fn && fn.begin === rva ? fn.end : rva + fallbackBytes;
  const off = pe.rvaToOff(begin);
  const avail = off < 0 ? 0 : Math.min(end - begin, buf.length - off);
  const bytes = off < 0 ? new Uint8Array(0) : Uint8Array.from(buf.subarray(off, off + avail));
  /** @type {{ at: number, ins: import("./siggen.mjs").Instruction }[]} */
  const instrs = [];
  let resyncs = 0;
  let i = 0;
  while (i < bytes.length) {
    const ins = decodeInstruction(bytes, i);
    if (!ins) { resyncs++; i++; continue; }
    instrs.push({ at: begin + i, ins });
    i += ins.length;
  }
  return { begin, end, instrs, resyncs, bytes };
}

/**
 * @param {import("./pe.mjs").Pe} pe @param {Buffer} buf @param {number} rva
 * @param {{ names?: Map<number, string> }} [opts] rva -> entry name for callee naming
 * @returns {FunctionHarvest}
 */
export function harvestFunction(pe, buf, rva, opts = {}) {
  const names = opts.names || new Map();
  const d = decodeFunction(pe, buf, rva);
  /** @type {StringAnchor[]} */
  const strings = [];
  /** @type {CalleeAnchor[]} */
  const callees = []; // only calls to manifest entries (the ordinal counts every call), else the lists explode
  let calls = 0;
  /** @type {RipRef[]} */
  const ripRefs = [];
  for (const { at, ins } of d.instrs) {
    if (ins.relTarget === null) continue;
    const target = at + ins.length + ins.relTarget;
    if (ins.kind === "call" && ins.reloc && ins.reloc.why === "E8 rel32") {
      if (!pe.sectionOf(target)) continue;
      const name = names.get(target);
      if (name) callees.push({ ordinal: calls, name, target: hex(target) });
      calls++;
      continue;
    }
    if (!ins.reloc || ins.reloc.why !== "rip-relative disp32") continue;
    ripRefs.push({ ordinal: ripRefs.length, opcode: ins.kind, target: hex(target) });
    if (ins.kind !== "lea") continue;
    const sec = pe.sectionOf(target);
    if (!sec || sec.exec) continue;
    const s = cstringAt(pe, buf, target);
    if (!s) continue;
    const role = /__cdecl|__thiscall|__fastcall/.test(s) ? "funcsig" : /\.(cpp|hpp|c|h|inl)$/i.test(s) ? "file" : null;
    if (!role || strings.some((x) => x.text === s)) continue;
    strings.push({ text: s, role, unique: findString(pe, buf, s).count === 1 });
  }
  const head = d.bytes.subarray(0, Math.min(12, d.bytes.length));
  const mask = new Uint8Array(head.length).fill(1);
  let i = 0;
  while (i < head.length) {
    const ins = decodeInstruction(d.bytes, i);
    if (!ins) break;
    if (ins.reloc) for (let k = ins.reloc.at; k < ins.reloc.at + ins.reloc.len && k < head.length; k++) mask[k] = 0;
    i += ins.length;
  }
  return {
    strings, callees, ripRefs,
    cfgLite: { bytes: d.end - d.begin, calls, ripRefs: ripRefs.length, resyncs: d.resyncs },
    prologue: patternToString({ bytes: head, mask, length: head.length }),
  };
}

/** @param {import("./pe.mjs").Pe} pe @param {Buffer} buf @param {number} rva */
function u32At(pe, buf, rva) {
  const off = pe.rvaToOff(rva);
  return off < 0 || off + 4 > buf.length ? null : buf.readUInt32LE(off);
}
/** @param {import("./pe.mjs").Pe} pe @param {Buffer} buf @param {number} rva */
function u64At(pe, buf, rva) {
  const off = pe.rvaToOff(rva);
  return off < 0 || off + 8 > buf.length ? null : Number(buf.readBigUInt64LE(off));
}

/**
 * MSVC x64 RTTI: TypeDescriptor { vftable*, spare, name[] } (in .data) -> a CompleteObjectLocator
 * { signature 1, offset, cdOffset, pTypeDescriptor, pClassDescriptor, pSelf } (image-relative u32s)
 * -> the vftable whose slot -1 holds the locator's absolute address.
 * @param {import("./pe.mjs").Pe} pe @param {Buffer} buf @param {string} typeDescriptorName e.g. ".?AVLuckUp@glaiel@@"
 * @returns {{ typeDescriptor: number, col: number, vftable: number }|null}
 */
export function findRtti(pe, buf, typeDescriptorName) {
  const name = findString(pe, buf, typeDescriptorName);
  if (name.rva === null || name.count !== 1) return null;
  const td = name.rva - 16;
  /** @type {number[]} */
  const cols = [];
  for (const s of dataSections(pe)) {
    const b = sectionBytes(buf, s);
    for (let i = 12; i + 12 <= b.length; i += 4) {
      if (b.readUInt32LE(i) !== td) continue;
      const col = s.va + i - 12;
      if (b.readUInt32LE(i - 12) !== 1) continue;           // signature: x64 image-relative
      if (b.readUInt32LE(i + 8) !== col) continue;          // pSelf
      cols.push(col);
    }
  }
  if (cols.length === 0) return null;
  cols.sort((a, b) => (u32At(pe, buf, a + 4) || 0) - (u32At(pe, buf, b + 4) || 0)); // offset 0 (primary) first
  const colAbs = BigInt(pe.imageBase + cols[0]);
  for (const s of dataSections(pe)) {
    const b = sectionBytes(buf, s);
    for (let i = 0; i + 8 <= b.length; i += 8) {
      if (b.readBigUInt64LE(i) === colAbs) return { typeDescriptor: td, col: cols[0], vftable: s.va + i + 8 };
    }
  }
  return null;
}

/**
 * @param {import("./pe.mjs").Pe} pe @param {Buffer} buf @param {number} vftableRva @param {number} slot
 * @returns {number|null} the slot's target RVA
 */
export function vtableSlotTarget(pe, buf, vftableRva, slot) {
  const abs = u64At(pe, buf, vftableRva + 8 * slot);
  if (abs === null) return null;
  const rva = abs - pe.imageBase;
  return pe.sectionOf(rva) ? rva : null;
}

/**
 * Read an imm32 out of a vtable slot's body when the body matches `bodyPattern` (e.g. "B8 ?? ?? ?? ?? C3").
 * @param {import("./pe.mjs").Pe} pe @param {Buffer} buf @param {number} vftableRva @param {number} slot @param {string} bodyPattern @param {number} imm32At
 * @returns {number|null}
 */
export function deriveFromVtableSlot(pe, buf, vftableRva, slot, bodyPattern, imm32At) {
  const target = vtableSlotTarget(pe, buf, vftableRva, slot);
  if (target === null) return null;
  const off = pe.rvaToOff(target);
  const pat = parsePattern(bodyPattern);
  if (off < 0 || off + pat.length > buf.length) return null;
  for (let k = 0; k < pat.length; k++) if (pat.mask[k] && buf[off + k] !== pat.bytes[k]) return null;
  return off + imm32At + 4 <= buf.length ? buf.readUInt32LE(off + imm32At) : null;
}

/**
 * @typedef {{ name: string, kind: string, status: "harvested"|"verified"|"mismatch"|"unresolved"|"unanchored"|"skipped", detail: string }} HarvestRow
 */

/**
 * Fill and verify every entry's anchors against this exe. Values are never rewritten: a
 * mismatch is reported for the port step / a human. Returns a new manifest object.
 * @param {import("./pe.mjs").Pe} pe @param {Buffer} buf @param {import("./manifest.mjs").Manifest} manifest
 * @returns {{ manifest: import("./manifest.mjs").Manifest, report: HarvestRow[], changed: boolean }}
 */
export function harvestManifest(pe, buf, manifest) {
  /** @type {import("./manifest.mjs").Manifest} */
  const out = JSON.parse(JSON.stringify(manifest));
  /** @type {Map<number, string>} */
  const names = new Map();
  for (const e of out.entries) if (e.kind === "function" && e.rva) names.set(parseInt(e.rva, 16), e.name);
  /** @type {HarvestRow[]} */
  const report = [];
  /** @type {Map<string, FunctionHarvest>} */
  const fnCache = new Map();
  /** @param {import("./manifest.mjs").Entry} e */
  const harvestOf = (e) => {
    let h = fnCache.get(e.name);
    if (!h) { h = harvestFunction(pe, buf, parseInt(e.rva || "0", 16), { names }); fnCache.set(e.name, h); }
    return h;
  };

  for (const e of out.entries) {
    const a = e.anchors;
    if (e.kind === "function") {
      const h = harvestOf(e);
      a.strings = h.strings;
      a.callees = h.callees;
      a.cfgLite = h.cfgLite;
      a.prologue = h.prologue;
      const sig = h.strings.find((s) => s.role === "funcsig" && s.unique);
      report.push({ name: e.name, kind: e.kind, status: "harvested", detail: `${h.cfgLite.bytes} bytes, ${h.callees.length} calls, ${h.ripRefs.length} rip refs${sig ? ", unique funcsig" : h.strings.length ? ", strings but no unique funcsig" : ", no strings"}` });
      continue;
    }
    if (a.witness && typeof a.witness.function === "string" && (e.kind === "data")) {
      const w = entry(out, a.witness.function);
      if (!w) { report.push({ name: e.name, kind: e.kind, status: "unresolved", detail: `witness ${a.witness.function} missing` }); continue; }
      const h = harvestOf(w);
      const target = parseInt(e.rva || "0", 16);
      const refs = h.ripRefs.filter((r) => parseInt(r.target, 16) === target);
      if (refs.length === 0) { a.witness.needsHarvest = true; report.push({ name: e.name, kind: e.kind, status: "unresolved", detail: `${w.name} has no rip-relative reference to ${hex(target)}` }); continue; }
      const prev = a.witness.ripRefOrdinal;
      a.witness.ripRefOrdinal = refs[0].ordinal;
      a.witness.kind = `rip-${refs[0].opcode}`;
      a.witness.needsHarvest = false;
      report.push({ name: e.name, kind: e.kind, status: Number.isInteger(prev) && prev === refs[0].ordinal ? "verified" : "harvested", detail: `rip ref #${refs[0].ordinal} (${refs[0].opcode}) in ${w.name}${refs.length > 1 ? ` (+${refs.length - 1} more)` : ""}` });
      continue;
    }
    if (e.kind === "vtable" && a.rtti && a.rtti.typeDescriptorName) {
      const r = findRtti(pe, buf, a.rtti.typeDescriptorName);
      if (!r) { report.push({ name: e.name, kind: e.kind, status: "unresolved", detail: `RTTI for ${a.rtti.typeDescriptorName} not found` }); continue; }
      const same = r.vftable === parseInt(e.rva || "0", 16);
      a.rtti.method = "typedesc-col-vftable";
      report.push({ name: e.name, kind: e.kind, status: same ? "verified" : "mismatch", detail: `rtti gives ${hex(r.vftable)} (col ${hex(r.col)}, typedesc ${hex(r.typeDescriptor)}); manifest says ${e.rva}` });
      continue;
    }
    if (e.kind === "constant" && a.derive && a.derive.vtable) {
      const vt = entry(out, a.derive.vtable);
      const v = vt ? deriveFromVtableSlot(pe, buf, parseInt(vt.rva || "0", 16), a.derive.slot, a.derive.bodyPattern, a.derive.imm32At) : null;
      if (v === null) { report.push({ name: e.name, kind: e.kind, status: "unresolved", detail: `slot ${a.derive.slot} of ${a.derive.vtable} does not match ${a.derive.bodyPattern}` }); continue; }
      const same = v === parseValue(e.value || "0");
      report.push({ name: e.name, kind: e.kind, status: same ? "verified" : "mismatch", detail: `slot body gives ${hex(v)}; manifest says ${e.value}` });
      continue;
    }
    if (e.kind === "data" && a.derive && a.derive.table) {
      const t = entry(out, a.derive.table);
      const v = t ? parseInt(t.rva || "0", 16) + 8 * a.derive.index : null;
      if (v === null) { report.push({ name: e.name, kind: e.kind, status: "unresolved", detail: `table ${a.derive.table} missing` }); continue; }
      const same = v === parseInt(e.rva || "0", 16);
      report.push({ name: e.name, kind: e.kind, status: same ? "verified" : "mismatch", detail: `${a.derive.table} + 8*${a.derive.index} = ${hex(v)}; manifest says ${e.rva}` });
      continue;
    }
    if (e.kind === "data" && Array.isArray(a.strings)) {
      for (const s of a.strings) s.unique = findString(pe, buf, s.text).count === 1;
      report.push({ name: e.name, kind: e.kind, status: "harvested", detail: `${a.strings.length} string anchor(s)` });
      continue;
    }
    report.push({ name: e.name, kind: e.kind, status: a.unanchored ? "unanchored" : "skipped", detail: a.unanchored ? "no anchor yet; the port step reports it instead of guessing" : "nothing to harvest" });
  }
  return { manifest: out, report, changed: JSON.stringify(out) !== JSON.stringify(manifest) };
}
