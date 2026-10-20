// Harvest: record, for every manifest entry, the evidence that lets the port step find the
// same thing in a rebuilt exe. Functions: the MSVC __FUNCSIG__ / __FILE__ strings they reference
// (rip-relative lea), their callees and rip-relative references by ordinal, size and counts
// (cfgLite) and a wildcarded prologue. Vtables: the RTTI chain (TypeDescriptor name -> complete
// object locator -> vftable). Constants: a vtable slot body. Globals: the ordinal of the
// rip-relative reference inside a witness function. harvestManifest also *verifies* every
// anchor against the current exe and reports mismatches without rewriting values.
// Pure over (pe, buf); node built-ins only.

import { sectionBytes } from "./pe.ts";
import type { Pe, PeSection, RuntimeFunction } from "./pe.ts";
import { parsePattern, patternToString } from "./scan.ts";
import { decodeInstruction } from "./siggen.ts";
import type { Instruction } from "./siggen.ts";
import { hex, parseValue, entry } from "./manifest.ts";
import type { Manifest, Entry, StringAnchor, CalleeAnchor, CfgLite, Anchors } from "./manifest.ts";

export type { StringAnchor, CalleeAnchor } from "./manifest.ts";

export interface RipRef {
  ordinal: number;
  opcode: string;
  target: string;
}
export interface FunctionHarvest {
  strings: StringAnchor[];
  callees: CalleeAnchor[];
  ripRefs: RipRef[];
  cfgLite: CfgLite;
  prologue: string;
}

const dataSections = (pe: Pe): PeSection[] => pe.sections.filter((s) => !s.exec && s.rawSize > 0);

/** Read a NUL-terminated latin1 string at an RVA (null when unmapped or unterminated within max). */
export function cstringAt(pe: Pe, buf: Buffer, rva: number, max = 2048): string | null {
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
 */
export function findString(pe: Pe, buf: Buffer, text: string): { rva: number | null; count: number } {
  const needle = Buffer.from(text + "\0", "latin1");
  let first: number | null = null;
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

const leaCache = new WeakMap<Buffer, Map<number, number[]>>();

/**
 * One pass over the executable sections collecting every rip-relative lea site by target RVA.
 * @returns target rva -> lea instruction rvas
 */
export function leaIndex(pe: Pe, buf: Buffer): Map<number, number[]> {
  const cached = leaCache.get(buf);
  if (cached) return cached;
  const idx = new Map<number, number[]>();
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

/** Every rip-relative lea that points at `rva`, with the .pdata function containing the site. */
export function findStringXrefs(pe: Pe, buf: Buffer, rva: number): { at: number; fn: RuntimeFunction | null }[] {
  return (leaIndex(pe, buf).get(rva) || []).map((at) => ({ at, fn: pe.pdata.find(at) }));
}

export interface DecodedFunction {
  begin: number;
  end: number;
  instrs: { at: number; ins: Instruction }[];
  resyncs: number;
  bytes: Uint8Array;
}

/**
 * Decode a whole .pdata function (or `fallbackBytes` when it is not in .pdata). Unknown opcodes
 * are skipped one byte at a time (counted in `resyncs`) so counting continues.
 */
export function decodeFunction(pe: Pe, buf: Buffer, rva: number, fallbackBytes = 256): DecodedFunction {
  const fn = pe.pdata.find(rva);
  const begin = fn && fn.begin === rva ? fn.begin : rva;
  const end = fn && fn.begin === rva ? fn.end : rva + fallbackBytes;
  const off = pe.rvaToOff(begin);
  const avail = off < 0 ? 0 : Math.min(end - begin, buf.length - off);
  const bytes = off < 0 ? new Uint8Array(0) : Uint8Array.from(buf.subarray(off, off + avail));
  const instrs: { at: number; ins: Instruction }[] = [];
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

/** @param opts.names rva -> entry name for callee naming */
export function harvestFunction(pe: Pe, buf: Buffer, rva: number, opts: { names?: Map<number, string> } = {}): FunctionHarvest {
  const names = opts.names || new Map<number, string>();
  const d = decodeFunction(pe, buf, rva);
  const strings: StringAnchor[] = [];
  const callees: CalleeAnchor[] = []; // only calls to manifest entries (the ordinal counts every call), else the lists explode
  let calls = 0;
  const ripRefs: RipRef[] = [];
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
    const role: StringAnchor["role"] | null = /__cdecl|__thiscall|__fastcall/.test(s) ? "funcsig" : /\.(cpp|hpp|c|h|inl)$/i.test(s) ? "file" : null;
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

function u32At(pe: Pe, buf: Buffer, rva: number): number | null {
  const off = pe.rvaToOff(rva);
  return off < 0 || off + 4 > buf.length ? null : buf.readUInt32LE(off);
}
function u64At(pe: Pe, buf: Buffer, rva: number): number | null {
  const off = pe.rvaToOff(rva);
  return off < 0 || off + 8 > buf.length ? null : Number(buf.readBigUInt64LE(off));
}

/**
 * MSVC x64 RTTI: TypeDescriptor { vftable*, spare, name[] } (in .data) -> a CompleteObjectLocator
 * { signature 1, offset, cdOffset, pTypeDescriptor, pClassDescriptor, pSelf } (image-relative u32s)
 * -> the vftable whose slot -1 holds the locator's absolute address.
 * @param typeDescriptorName e.g. ".?AVLuckUp@glaiel@@"
 */
export function findRtti(pe: Pe, buf: Buffer, typeDescriptorName: string): { typeDescriptor: number; col: number; vftable: number } | null {
  const name = findString(pe, buf, typeDescriptorName);
  if (name.rva === null || name.count !== 1) return null;
  const td = name.rva - 16;
  const cols: number[] = [];
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

/** @returns the slot's target RVA */
export function vtableSlotTarget(pe: Pe, buf: Buffer, vftableRva: number, slot: number): number | null {
  const abs = u64At(pe, buf, vftableRva + 8 * slot);
  if (abs === null) return null;
  const rva = abs - pe.imageBase;
  return pe.sectionOf(rva) ? rva : null;
}

/** Read an imm32 out of a vtable slot's body when the body matches `bodyPattern` (e.g. "B8 ?? ?? ?? ?? C3"). */
export function deriveFromVtableSlot(pe: Pe, buf: Buffer, vftableRva: number, slot: number, bodyPattern: string, imm32At: number): number | null {
  const target = vtableSlotTarget(pe, buf, vftableRva, slot);
  if (target === null) return null;
  const off = pe.rvaToOff(target);
  const pat = parsePattern(bodyPattern);
  if (off < 0 || off + pat.length > buf.length) return null;
  for (let k = 0; k < pat.length; k++) if (pat.mask[k] && buf[off + k] !== pat.bytes[k]) return null;
  return off + imm32At + 4 <= buf.length ? buf.readUInt32LE(off + imm32At) : null;
}

/**
 * Read an imm32 from the instruction matching `pattern` within `maxBack` instructions before the first E8 call to
 * `calleeRva` inside the function at `fnRva` (e.g. "41 B8 ?? ?? ?? ??" = mov r8d, imm32: the type id passed to
 * Entity_FindComponentsByTypeId). A second, independent source for a constant that otherwise rests on one vtable slot body.
 */
export function deriveFromCallArg(pe: Pe, buf: Buffer, fnRva: number, calleeRva: number, pattern: string, imm32At: number, maxBack = 8): number | null {
  const d = decodeFunction(pe, buf, fnRva);
  const pat = parsePattern(pattern);
  for (let i = 0; i < d.instrs.length; i++) {
    const x = d.instrs[i];
    if (!(x.ins.kind === "call" && x.ins.reloc && x.ins.reloc.why === "E8 rel32" && x.ins.relTarget !== null)) continue;
    if (x.at + x.ins.length + x.ins.relTarget !== calleeRva) continue;
    for (let k = i - 1; k >= 0 && k >= i - maxBack; k--) {
      const y = d.instrs[k];
      const off = pe.rvaToOff(y.at);
      if (off < 0 || y.ins.length < pat.length || off + pat.length > buf.length) continue;
      let ok = true;
      for (let j = 0; j < pat.length; j++) if (pat.mask[j] && buf[off + j] !== pat.bytes[j]) { ok = false; break; }
      if (!ok) continue;
      return off + imm32At + 4 <= buf.length ? buf.readUInt32LE(off + imm32At) : null;
    }
    return null; // only the first call to the callee counts
  }
  return null;
}

/**
 * Read a displacement (or any immediate) out of the `nth` match of a byte pattern inside a function's .pdata body:
 * what a struct-offset witness is. `dispSize` 1 (default) reads a signed byte, anything else a signed 32-bit value;
 * `scale` divides it (a `call [rax+8*slot]` witnesses the slot index). Byte-scanning on purpose: the decoder's
 * instruction boundaries are not needed and a mis-sized instruction cannot shift the match.
 */
export interface OffsetWitnessRead {
  found: boolean;
  /** byte index of the match inside the function body, or null */
  at: number | null;
  /** the raw signed displacement, or null */
  raw: number | null;
  /** raw / scale, or null (also when the quotient is not integral) */
  value: number | null;
  /** how many times the pattern matched in the body */
  matches: number;
}
export function readOffsetWitness(pe: Pe, buf: Buffer, fnRva: number, w: { pattern: string; nth?: number; dispAt?: number; dispSize?: number; scale?: number }, sigCap?: number): OffsetWitnessRead {
  const d = decodeFunction(pe, buf, fnRva);
  const pat = parsePattern(w.pattern, sigCap);
  const want = w.nth || 0;
  let matches = 0, at = -1;
  for (let i = 0; i + pat.length <= d.bytes.length; i++) {
    let k = 0;
    for (; k < pat.length; k++) if (pat.mask[k] && d.bytes[i + k] !== pat.bytes[k]) break;
    if (k !== pat.length) continue;
    if (matches === want) at = i;
    matches++;
  }
  if (at < 0) return { found: false, at: null, raw: null, value: null, matches };
  const size = w.dispSize || 1;
  const off = at + (w.dispAt || 0);
  if (off + (size === 1 ? 1 : 4) > d.bytes.length) return { found: false, at, raw: null, value: null, matches };
  let raw: number;
  if (size === 1) { raw = d.bytes[off]; if (raw > 127) raw -= 256; }
  else raw = (d.bytes[off] | (d.bytes[off + 1] << 8) | (d.bytes[off + 2] << 16) | (d.bytes[off + 3] << 24)) | 0;
  const scale = w.scale || 1;
  if (raw % scale !== 0) return { found: false, at, raw, value: null, matches };
  return { found: true, at, raw, value: raw / scale, matches };
}

export interface ConstantSources {
  slot: number | null;
  arg: number | null;
  /** a displacement witness (pattern + dispAt [+ scale]) without a callee, e.g. the slot index of a vtable call */
  disp: number | null;
  notes: string[];
}

/**
 * Every independent source of a constant's value on this image: the vtable slot body (anchors.derive) and the
 * call-arg witness (anchors.witness with a callee). Entries that carry a port block must have ported for their
 * value to be trusted. Shared by harvest (verify) and port (re-derive); the caller decides what agreement means.
 * The anchor fields are passed through as the manifest holds them (a missing field fails inside the helper, as before).
 */
export function constantSources(manifest: Manifest, pe: Pe, buf: Buffer, e: Entry): ConstantSources {
  const a = e.anchors;
  const usable = (x: Entry | null | undefined): boolean => !!x && (!x.port || String(x.port.status).startsWith("ported"));
  const r: ConstantSources = { slot: null, arg: null, disp: null, notes: [] };
  if (a.derive && a.derive.vtable) {
    const vt = entry(manifest, a.derive.vtable);
    r.slot = usable(vt) && vt ? deriveFromVtableSlot(pe, buf, parseInt(vt.rva || "0", 16), a.derive.slot!, a.derive.bodyPattern!, a.derive.imm32At!) : null;
    r.notes.push(r.slot === null ? (usable(vt) ? `slot ${a.derive.slot} of ${a.derive.vtable} does not match ${a.derive.bodyPattern}` : `${a.derive.vtable} did not port`) : `slot body gives ${hex(r.slot)}`);
  }
  if (a.witness && a.witness.callee) {
    const w = a.witness;
    const f = entry(manifest, w.function);
    const c = entry(manifest, a.witness.callee);
    r.arg = usable(f) && usable(c) && f && c ? deriveFromCallArg(pe, buf, parseInt(f.rva || "0", 16), parseInt(c.rva || "0", 16), w.pattern!, w.imm32At!, w.maxBack ?? 8) : null;
    r.notes.push(r.arg === null ? `call-arg witness ${w.pattern} before the call to ${w.callee} in ${w.function} not found` : `call-arg witness in ${w.function} gives ${hex(r.arg)}`);
  }
  if (a.witness && !a.witness.callee && a.witness.pattern && Number.isInteger(a.witness.dispAt)) {
    const w = a.witness;
    const f = entry(manifest, w.function);
    const rd = usable(f) && f ? readOffsetWitness(pe, buf, parseInt(f.rva || "0", 16), { pattern: w.pattern!, nth: w.nth, dispAt: w.dispAt, dispSize: w.dispSize, scale: w.scale }, manifest.sigCap) : null;
    r.disp = rd && rd.found ? rd.value : null;
    r.notes.push(r.disp === null
      ? `displacement witness ${w.pattern} #${w.nth || 0} in ${w.function} ${rd ? (rd.matches ? "matched but gave no value" : "not found") : "unusable (function did not port)"}`
      : `displacement witness in ${w.function} gives ${hex(rd!.raw!)}${w.scale && w.scale !== 1 ? ` / ${w.scale} = ${r.disp}` : ""}`);
  }
  return r;
}

/** constants with any derivation or witness source (the harvest verifies them, the port re-derives them) */
export function constantHasSources(a: Anchors): boolean {
  return !!((a.derive && a.derive.vtable) || (a.witness && a.witness.callee) || (a.witness && !a.witness.callee && a.witness.pattern && Number.isInteger(a.witness.dispAt)));
}

export type HarvestStatus = "harvested" | "verified" | "mismatch" | "unresolved" | "unanchored" | "skipped";
export interface HarvestRow {
  name: string;
  kind: string;
  status: HarvestStatus;
  detail: string;
}

/**
 * Fill and verify every entry's anchors against this exe. Values are never rewritten: a
 * mismatch is reported for the port step / a human. Returns a new manifest object.
 */
export function harvestManifest(pe: Pe, buf: Buffer, manifest: Manifest): { manifest: Manifest; report: HarvestRow[]; changed: boolean } {
  const out: Manifest = JSON.parse(JSON.stringify(manifest));
  const names = new Map<number, string>();
  for (const e of out.entries) if (e.kind === "function" && e.rva) names.set(parseInt(e.rva, 16), e.name);
  const report: HarvestRow[] = [];
  const fnCache = new Map<string, FunctionHarvest>();
  const harvestOf = (e: Entry): FunctionHarvest => {
    let h = fnCache.get(e.name);
    if (!h) { h = harvestFunction(pe, buf, parseInt(e.rva || "0", 16), { names }); fnCache.set(e.name, h); }
    return h;
  };

  for (const e of out.entries) {
    const a = e.anchors;
    if (e.kind === "function") {
      const h = harvestOf(e);
      // hand-written literal anchors (e.g. a config key the function reads) are kept and re-checked
      const manual: StringAnchor[] = (Array.isArray(a.strings) ? a.strings : []).filter((s) => s && s.role === "literal").map((s) => ({ text: s.text, role: "literal" as const, unique: findString(pe, buf, s.text).count === 1 }));
      a.strings = [...manual, ...h.strings];
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
    if (e.kind === "offset" && a.witness && typeof a.witness.function === "string" && a.witness.pattern) {
      const w = entry(out, a.witness.function);
      if (!w || w.kind !== "function") { report.push({ name: e.name, kind: e.kind, status: "unresolved", detail: `witness ${a.witness.function} is not a function entry` }); continue; }
      const rd = readOffsetWitness(pe, buf, parseInt(w.rva || "0", 16), { pattern: a.witness.pattern, nth: a.witness.nth, dispAt: a.witness.dispAt, dispSize: a.witness.dispSize, scale: a.witness.scale }, out.sigCap);
      if (!rd.found) { report.push({ name: e.name, kind: e.kind, status: "unresolved", detail: `${w.name}: ${a.witness.pattern} #${a.witness.nth || 0} ${rd.matches ? "matched but gave no value" : "not found"} (${rd.matches} match(es))` }); continue; }
      const want = parseValue(e.value || "0");
      report.push({ name: e.name, kind: e.kind, status: rd.value === want ? "verified" : "mismatch", detail: `${w.name}: ${a.witness.pattern} #${a.witness.nth || 0} reads ${hex(rd.value!)} (${rd.matches} match(es)); manifest says ${e.value}` });
      continue;
    }
    if (e.kind === "constant" && constantHasSources(a)) {
      const src = constantSources(out, pe, buf, e);
      const vals = [src.slot, src.arg, src.disp].filter((v): v is number => v !== null);
      if (!vals.length) { report.push({ name: e.name, kind: e.kind, status: "unresolved", detail: src.notes.join("; ") }); continue; }
      const want = parseValue(e.value || "0");
      const same = vals.every((v) => v === want);
      report.push({ name: e.name, kind: e.kind, status: same ? "verified" : "mismatch", detail: `${src.notes.join("; ")}; manifest says ${e.value}` });
      continue;
    }
    if (e.kind === "data" && a.derive && a.derive.table) {
      const t = entry(out, a.derive.table);
      const v = t ? parseInt(t.rva || "0", 16) + 8 * a.derive.index! : null;
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
