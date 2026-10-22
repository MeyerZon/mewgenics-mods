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
import { parsePattern, patternToString, scanAllExec } from "./scan.ts";
import type { Pattern } from "./scan.ts";
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

// ---- the 2026-10-21 locators (notes-bind): each returns the .pdata function begins an anchor leads to ----------------

const matchesAt = (buf: Buffer, off: number, pat: Pattern): boolean => {
  if (off < 0 || off + pat.length > buf.length) return false;
  for (let k = 0; k < pat.length; k++) if (pat.mask[k] && buf[off + k] !== pat.bytes[k]) return false;
  return true;
};
const fnBegins = (pe: Pe, sites: number[]): number[] => [...new Set(sites.map((at) => { const f = pe.pdata.find(at); return f ? f.begin : -1; }).filter((x) => x >= 0))];

/**
 * vtable-store rung: the .pdata functions containing a rip-relative lea of `vftableRva` whose bytes match `pattern`
 * at the lea (e.g. "48 8D 05 ?? ?? ?? ?? 48 89 03" = lea rax,[vftable]; mov [rbx],rax). A constructor is normally the
 * only such site, and the vftable comes from RTTI, so this rung needs no ported function.
 */
export function findVtableStoreFunctions(pe: Pe, buf: Buffer, vftableRva: number, pattern: string, sigCap?: number): number[] {
  const pat = parsePattern(pattern, sigCap);
  const sites = (leaIndex(pe, buf).get(vftableRva) || []).filter((at) => matchesAt(buf, pe.rvaToOff(at), pat));
  return fnBegins(pe, sites);
}

/**
 * imm32-witness rung: the .pdata functions containing an instruction matching `pattern` with `value` as the imm32 at
 * `imm32At`, followed within `maxForward` instructions by an E8 call to `calleeRva` (Status_ApplyLuckUp: `mov r8d,
 * LuckUp_typeid` four instructions before `call Entity_FindComponentsByTypeId`). The value is the constant's derived
 * value on this image, so the rung tracks a type id that changes between builds.
 */
export function findImm32WitnessFunctions(pe: Pe, buf: Buffer, pattern: string, imm32At: number, value: number, calleeRva: number, maxForward = 8, sigCap?: number): number[] {
  const pat = parsePattern(pattern, sigCap);
  if (imm32At < 0 || imm32At + 4 > pat.length) return [];
  const bytes = Uint8Array.from(pat.bytes), mask = Uint8Array.from(pat.mask);
  for (let k = 0; k < 4; k++) { bytes[imm32At + k] = (value >>> (8 * k)) & 0xff; mask[imm32At + k] = 1; }
  const out: number[] = [];
  for (const hit of scanAllExec(pe, buf, { bytes, mask, length: pat.length })) {
    const fn = pe.pdata.find(hit);
    if (!fn) continue;
    const d = decodeFunction(pe, buf, fn.begin);
    const i = d.instrs.findIndex((x) => x.at === hit);
    if (i < 0) continue;   // the hit is not an instruction boundary of its function
    for (let k = i + 1; k < d.instrs.length && k <= i + maxForward; k++) {
      const x = d.instrs[k];
      if (x.ins.kind === "call" && x.ins.reloc && x.ins.reloc.why === "E8 rel32" && x.ins.relTarget !== null && x.at + x.ins.length + x.ins.relTarget === calleeRva) { if (!out.includes(fn.begin)) out.push(fn.begin); break; }
    }
  }
  return out;
}

/**
 * caller-after-lea rung: inside the caller's .pdata body, every rip-relative lea of the unique whole string `literal`
 * and, per lea site, the E8 targets (that begin a .pdata function) within the next `maxForward` instructions, in order.
 * apply_status compares the name (`lea rdx,["LuckUp"]; call string==cstr; test al,al; jz`) and then calls the
 * per-status apply function: the caller picks the first target inside its size/call tolerance. The default window of
 * 24 instructions covers attach_passive, whose call sits 17 instructions after the lea on 25143593.
 */
export function findCallsAfterStringLea(pe: Pe, buf: Buffer, callerRva: number, literal: string, maxForward = 24): { leaAt: number; targets: number[] }[] {
  const s = findString(pe, buf, literal);
  if (s.rva === null || s.count !== 1) return [];
  const fn = pe.pdata.find(callerRva);
  if (!fn || fn.begin !== callerRva) return [];
  const d = decodeFunction(pe, buf, callerRva);
  const out: { leaAt: number; targets: number[] }[] = [];
  for (let i = 0; i < d.instrs.length; i++) {
    const x = d.instrs[i];
    if (!(x.ins.kind === "lea" && x.ins.reloc && x.ins.reloc.why === "rip-relative disp32" && x.ins.relTarget !== null && x.at + x.ins.length + x.ins.relTarget === s.rva)) continue;
    const targets: number[] = [];
    for (let k = i + 1; k < d.instrs.length && k <= i + maxForward; k++) {
      const y = d.instrs[k];
      if (y.ins.kind === "call" && y.ins.reloc && y.ins.reloc.why === "E8 rel32" && y.ins.relTarget !== null) {
        const t = y.at + y.ins.length + y.ins.relTarget;
        const tf = pe.pdata.find(t);
        if (tf && tf.begin === t) targets.push(t);
      }
    }
    out.push({ leaAt: x.at, targets });
  }
  return out;
}

/** The .pdata function `delta` entries after (+1) / before (-1) the function beginning at `rva`, by table index. */
export function pdataNeighbour(pe: Pe, rva: number, delta: number): number | null {
  let lo = 0, hi = pe.pdata.count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = pe.pdata.get(mid);
    if (rva < e.begin) hi = mid - 1;
    else if (rva >= e.end) lo = mid + 1;
    else {
      if (e.begin !== rva) return null;
      const j = mid + delta;
      return j >= 0 && j < pe.pdata.count ? pe.pdata.get(j).begin : null;
    }
  }
  return null;
}

const ripRefCache = new WeakMap<Buffer, Map<number, number[]>>();

/**
 * One pass over every .pdata function collecting each rip-relative reference (any opcode) by target RVA. Built lazily
 * and cached per image: the shared-data-ref rung is the only consumer and it runs only when the cheaper rungs failed.
 * @returns target rva -> function begins referencing it
 */
export function ripRefIndex(pe: Pe, buf: Buffer): Map<number, number[]> {
  const cached = ripRefCache.get(buf);
  if (cached) return cached;
  const idx = new Map<number, number[]>();
  for (let i = 0; i < pe.pdata.count; i++) {
    const f = pe.pdata.get(i);
    const d = decodeFunction(pe, buf, f.begin);
    for (const { at, ins } of d.instrs) {
      if (!ins.reloc || ins.reloc.why !== "rip-relative disp32" || ins.relTarget === null) continue;
      const t = at + ins.length + ins.relTarget;
      const list = idx.get(t);
      if (!list) idx.set(t, [f.begin]);
      else if (list[list.length - 1] !== f.begin) list.push(f.begin);
    }
  }
  ripRefCache.set(buf, idx);
  return idx;
}

/** shared-data-ref rung: the .pdata functions other than `withRva` that rip-reference `target`. */
export function findSharedDataRefFunctions(pe: Pe, buf: Buffer, target: number, withRva: number): number[] {
  return (ripRefIndex(pe, buf).get(target) || []).filter((f) => f !== withRva);
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

/** How many consecutive qwords from `vftableRva` point into an executable section (the vtable's slot count); cap 4096. */
export function vtableExtent(pe: Pe, buf: Buffer, vftableRva: number): number {
  let n = 0;
  for (; n < 4096; n++) {
    const abs = u64At(pe, buf, vftableRva + 8 * n);
    if (abs === null) break;
    const s = pe.sectionOf(abs - pe.imageBase);
    if (!s || !s.exec) break;
  }
  return n;
}

/**
 * A vtable slot's body: its .pdata range when the slot begins one, else the bytes up to and including the first
 * `ret` (C3 / C2 iw), at most 256 — so a tiny leaf slot never "contains" the function laid out after it.
 */
export function slotBody(pe: Pe, buf: Buffer, rva: number): Uint8Array {
  const fn = pe.pdata.find(rva);
  const off = pe.rvaToOff(rva);
  if (off < 0) return new Uint8Array(0);
  if (fn && fn.begin === rva) return Uint8Array.from(buf.subarray(off, Math.min(buf.length, off + (fn.end - fn.begin))));
  const max = Uint8Array.from(buf.subarray(off, Math.min(buf.length, off + 256)));
  let i = 0;
  while (i < max.length) {
    if (max[i] === 0xc3) return max.subarray(0, i + 1);
    if (max[i] === 0xc2) return max.subarray(0, Math.min(max.length, i + 3));
    const ins = decodeInstruction(max, i);
    i += ins ? ins.length : 1;
  }
  return max;
}

/**
 * The index of the vtable slot whose body starts with `bodyPattern`, contains `contains`, and/or whose bounded body holds
 * a rip-relative reference into the unique string `stringRef` (a lea of it or mov loads of its bytes); candidates[nth] when exactly `expect` (default 1) slots qualify, else null — never a guess.
 */
export function findVtableSlot(pe: Pe, buf: Buffer, vftableRva: number, search: { bodyPattern?: string; contains?: string; stringRef?: string; nth?: number; expect?: number }): number | null {
  const n = vtableExtent(pe, buf, vftableRva);
  const pat = search.bodyPattern ? parsePattern(search.bodyPattern) : null;
  const inner = search.contains ? parsePattern(search.contains) : null;
  let strRva: number | null = null;
  if (search.stringRef) {
    const f = findString(pe, buf, search.stringRef);
    if (f.count !== 1 || f.rva === null) return null;
    strRva = f.rva;
  }
  const hits: number[] = [];
  for (let slot = 0; slot < n; slot++) {
    const target = vtableSlotTarget(pe, buf, vftableRva, slot);
    if (target === null) continue;
    const body = slotBody(pe, buf, target);
    if (pat) {
      if (body.length < pat.length) continue;
      let ok = true;
      for (let k = 0; k < pat.length; k++) if (pat.mask[k] && body[k] !== pat.bytes[k]) { ok = false; break; }
      if (!ok) continue;
    }
    if (inner) {
      let found = false;
      for (let i = 0; !found && i + inner.length <= body.length; i++) {
        let k = 0;
        for (; k < inner.length; k++) if (inner.mask[k] && body[i + k] !== inner.bytes[k]) break;
        if (k === inner.length) found = true;
      }
      if (!found) continue;
    }
    if (strRva !== null) {
      // any rip-relative reference into the string counts: a lea of it, or mov loads of its bytes (MSVC builds a
      // short std::string from mov eax,[rip+str] / movzx eax,word [rip+str+4] — LuckUp's GetTypeName does)
      const strLen = search.stringRef!.length;
      let refs = false, i = 0;
      while (!refs && i < body.length) {
        const ins = decodeInstruction(body, i);
        if (!ins) { i++; continue; }
        if (ins.reloc && ins.reloc.why === "rip-relative disp32" && ins.relTarget !== null) {
          const tgt = target + i + ins.length + ins.relTarget;
          if (tgt >= strRva && tgt < strRva + strLen) refs = true;
        }
        i += ins.length;
      }
      if (!refs) continue;
    }
    hits.push(slot);
  }
  if (hits.length !== (search.expect ?? 1)) return null;
  return hits[search.nth || 0] ?? null;
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

/** an rdata witness's float (its raw IEEE-754 bits) as the integer constant it encodes: "f32" the value itself,
 * "f32-recip" the rounded reciprocal (LateRender multiplies by 1/1280); null unless integral within 1e-3 */
export function rdataWitnessValue(bits: number, kind: string): number | null {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(bits >>> 0, 0);
  const f = b.readFloatLE(0);
  let v: number;
  if (kind === "f32") v = f;
  else if (kind === "f32-recip") { if (f === 0 || !Number.isFinite(f)) return null; v = 1 / f; }
  else return null;
  const r = Math.round(v);
  return Number.isFinite(v) && Math.abs(v - r) < 1e-3 ? r : null;
}

/**
 * Read an rdata witness: the `nth` match of `pattern` in the function's .pdata body, the rip-relative disp32 at
 * `ripAt` inside it (the operand ends the instruction: rip = match + ripAt + 4), the 32-bit float at that target
 * (+ 4 * lane) and its value per `rdata`. A constant the code only ever multiplies by (a reciprocal in .rdata) is pinned
 * this way.
 */
export function readRdataWitness(pe: Pe, buf: Buffer, fnRva: number, w: { pattern: string; nth?: number; ripAt: number; rdata: string; lane?: number }, sigCap?: number): { found: boolean; target: number | null; value: number | null; matches: number } {
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
  if (at < 0 || at + w.ripAt + 4 > d.bytes.length) return { found: false, target: null, value: null, matches };
  const o = at + w.ripAt;
  const disp = (d.bytes[o] | (d.bytes[o + 1] << 8) | (d.bytes[o + 2] << 16) | (d.bytes[o + 3] << 24)) | 0;
  const target = fnRva + o + 4 + disp + 4 * (w.lane || 0);
  const off = pe.rvaToOff(target);
  if (off < 0 || off + 4 > buf.length) return { found: false, target, value: null, matches };
  const value = rdataWitnessValue(buf.readUInt32LE(off), w.rdata);
  return { found: value !== null, target, value, matches };
}

export interface ConstantSources {
  slot: number | null;
  arg: number | null;
  /** derive.extent: the vtable's slot count */
  extent: number | null;
  /** derive.slotSearch: the index of the matching slot */
  search: number | null;
  /** a displacement witness (pattern + dispAt [+ scale]) without a callee, e.g. the slot index of a vtable call */
  disp: number | null;
  /** an rdata witness (pattern + ripAt + rdata): a float the code loads rip-relative */
  rdata: number | null;
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
  const r: ConstantSources = { slot: null, arg: null, extent: null, search: null, disp: null, rdata: null, notes: [] };
  if (a.derive && a.derive.vtable && (a.derive.extent || a.derive.slotSearch)) {
    const vt = entry(manifest, a.derive.vtable);
    const vtRva = usable(vt) && vt ? parseInt(vt.rva || "0", 16) : null;
    if (a.derive.extent) {
      r.extent = vtRva !== null ? vtableExtent(pe, buf, vtRva) || null : null;
      r.notes.push(r.extent === null ? `${a.derive.vtable}: no extent` : `${a.derive.vtable} has ${r.extent} code slots`);
    }
    if (a.derive.slotSearch) {
      const ss = a.derive.slotSearch;
      r.search = vtRva !== null ? findVtableSlot(pe, buf, vtRva, ss) : null;
      const what = [ss.bodyPattern ? `body ${ss.bodyPattern}` : "", ss.contains ? `contains ${ss.contains}` : "", ss.stringRef ? `ref "${ss.stringRef}"` : ""].filter(Boolean).join(" + ");
      r.notes.push(r.search === null ? `${a.derive.vtable}: no single answer for ${what} (expect ${ss.expect ?? 1})` : `${a.derive.vtable}: ${what} -> slot ${r.search}`);
    }
  } else if (a.derive && a.derive.vtable) {
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
  if (a.witness && !a.witness.callee && a.witness.pattern && Number.isInteger(a.witness.ripAt) && a.witness.rdata) {
    const w = a.witness;
    const f = entry(manifest, w.function);
    const rd = usable(f) && f ? readRdataWitness(pe, buf, parseInt(f.rva || "0", 16), { pattern: w.pattern!, nth: w.nth, ripAt: w.ripAt!, rdata: w.rdata!, lane: w.lane }, manifest.sigCap) : null;
    r.rdata = rd && rd.found ? rd.value : null;
    r.notes.push(r.rdata === null
      ? `rdata witness ${w.pattern} #${w.nth || 0} in ${w.function} ${rd ? (rd.matches ? `matched but the float at ${rd.target !== null ? hex(rd.target) : "?"} gave no ${w.rdata} value` : "not found") : "unusable (function did not port)"}`
      : `rdata witness in ${w.function}: ${w.rdata} of the float at ${hex(rd!.target!)} = ${r.rdata}`);
  }
  return r;
}

/** constants with any derivation or witness source (the harvest verifies them, the port re-derives them) */
export function constantHasSources(a: Anchors): boolean {
  return !!((a.derive && a.derive.vtable) || (a.witness && a.witness.callee) || (a.witness && !a.witness.callee && a.witness.pattern && Number.isInteger(a.witness.dispAt)) || (a.witness && !a.witness.callee && a.witness.pattern && Number.isInteger(a.witness.ripAt) && !!a.witness.rdata));
}

/** every value a constant's sources produced, in a fixed order (all must agree) */
export function constantValues(src: ConstantSources): number[] {
  return [src.slot, src.arg, src.extent, src.search, src.disp, src.rdata].filter((v): v is number => v !== null);
}

export type HarvestStatus = "harvested" | "verified" | "mismatch" | "unresolved" | "unanchored" | "skipped";

/** the value an imm32 witness must find: the constant's slot-body derivation on this image when it has one (and the vtable is usable), else the manifest value */
export function constantValueOnImage(manifest: Manifest, pe: Pe, buf: Buffer, c: Entry): { value: number | null; via: string } {
  const d = c.anchors.derive;
  if (d && d.vtable && d.slot !== undefined && d.bodyPattern && d.imm32At !== undefined) {
    const vt = entry(manifest, d.vtable);
    if (vt && (!vt.port || String(vt.port.status).startsWith("ported"))) {
      const v = deriveFromVtableSlot(pe, buf, parseInt(vt.rva || "0", 16), d.slot, d.bodyPattern, d.imm32At);
      return { value: v, via: v === null ? `slot ${d.slot} of ${d.vtable} does not match ${d.bodyPattern}` : `slot ${d.slot} of ${d.vtable}` };
    }
    return { value: null, via: `${d.vtable} did not port` };
  }
  return c.value ? { value: parseValue(c.value), via: "manifest value" } : { value: null, via: "no value" };
}

interface AnchorVerification {
  checks: string[];
  failed: boolean;
  /** an anchor field (caller ordinal) was rewritten to what the image shows */
  rewritten: boolean;
}

/**
 * Verify (and re-harvest the ordinals of) a function entry's locating anchors against this image: vtableStore,
 * imm32Witness, callers (after-lea + ordinal), after/before, sharedDataRef, dataRefs. Values are never rewritten.
 */
export function verifyFunctionAnchors(manifest: Manifest, pe: Pe, buf: Buffer, e: Entry, harvestOf: (e: Entry) => FunctionHarvest): AnchorVerification {
  const a = e.anchors;
  const rva = parseInt(e.rva || "0", 16);
  const r: AnchorVerification = { checks: [], failed: false, rewritten: false };
  const list = (fns: number[]) => (fns.length ? fns.map((f) => hex(f)).join("/") : "nothing");
  const check = (name: string, fns: number[]) => {
    const ok = fns.length === 1 && fns[0] === rva;
    r.checks.push(ok ? `${name} ok` : `${name} -> ${list(fns)} (manifest says ${e.rva})`);
    if (!ok) r.failed = true;
  };
  if (a.vtableStore && a.vtableStore.vtable) {
    const vt = entry(manifest, a.vtableStore.vtable);
    check("vtable-store", vt && vt.rva ? findVtableStoreFunctions(pe, buf, parseInt(vt.rva, 16), a.vtableStore.pattern, manifest.sigCap) : []);
  }
  if (a.imm32Witness && a.imm32Witness.equals) {
    const w = a.imm32Witness;
    const c = entry(manifest, w.equals);
    const callee = entry(manifest, w.callee);
    const val = c ? constantValueOnImage(manifest, pe, buf, c) : { value: null, via: "no such constant" };
    if (val.value === null || !callee || !callee.rva) { r.checks.push(`imm32-witness unusable (${val.value === null ? val.via : `callee ${w.callee} missing`})`); r.failed = true; }
    else check(`imm32-witness ${hex(val.value)}`, findImm32WitnessFunctions(pe, buf, w.pattern, w.imm32At, val.value, parseInt(callee.rva, 16), w.maxForward ?? 8, manifest.sigCap));
  }
  for (const c of Array.isArray(a.callers) ? a.callers : []) {
    const caller = entry(manifest, c.function);
    if (!caller || !caller.rva) { r.checks.push(`callers: ${c.function} missing`); r.failed = true; continue; }
    const crva = parseInt(caller.rva, 16);
    if (c.afterStringLea) {
      const sites = findCallsAfterStringLea(pe, buf, crva, c.afterStringLea, c.maxForward ?? 24);
      const hit = sites.some((s) => s.targets.includes(rva));
      r.checks.push(hit ? `caller-after-lea ok (${c.function})` : `caller-after-lea: no call to ${e.rva} after lea "${c.afterStringLea}" in ${c.function} (${sites.length} lea site(s))`);
      if (!hit) r.failed = true;
    }
    const ords = harvestOf(caller).callees.filter((x) => x.name === e.name).map((x) => x.ordinal);
    if (!ords.length) { r.checks.push(`caller-ordinal: ${c.function} has no call to ${e.name}`); r.failed = true; continue; }
    if (c.ordinal !== undefined && ords.includes(c.ordinal)) r.checks.push(`caller-ordinal ok (#${c.ordinal} of ${c.function})`);
    else if (ords.length === 1) { r.checks.push(`caller-ordinal ${c.ordinal === undefined ? "filled" : `#${c.ordinal} -> `}#${ords[0]} of ${c.function}`); if (c.ordinal !== undefined) r.rewritten = true; c.ordinal = ords[0]; }
    else { r.checks.push(`caller-ordinal: ${c.function} calls ${e.name} at #${ords.join("/#")}, manifest says #${c.ordinal}`); r.failed = true; }
  }
  if (a.after && a.after.function) {
    const n = entry(manifest, a.after.function);
    const t = n && n.rva ? pdataNeighbour(pe, parseInt(n.rva, 16), 1) : null;
    check(`pdata-successor of ${a.after.function}`, t === null ? [] : [t]);
  }
  if (a.before && a.before.function) {
    const n = entry(manifest, a.before.function);
    const t = n && n.rva ? pdataNeighbour(pe, parseInt(n.rva, 16), -1) : null;
    check(`pdata-predecessor of ${a.before.function}`, t === null ? [] : [t]);
  }
  if (a.sharedDataRef && a.sharedDataRef.with) {
    const w = entry(manifest, a.sharedDataRef.with);
    const ref = w ? harvestOf(w).ripRefs[a.sharedDataRef.ripRefOrdinal] : undefined;
    const mine = harvestOf(e).ripRefs.map((x) => x.target);
    const ok = !!ref && mine.includes(ref.target);
    r.checks.push(ok ? `shared-data-ref ok (${ref!.target} = rip ref #${a.sharedDataRef.ripRefOrdinal} of ${a.sharedDataRef.with})` : `shared-data-ref: ${ref ? `${e.name} does not reference ${ref.target}` : `${a.sharedDataRef.with} has no rip ref #${a.sharedDataRef.ripRefOrdinal}`}`);
    if (!ok) r.failed = true;
  }
  if (Array.isArray(a.dataRefs) && a.dataRefs.length) {
    const refs = harvestOf(e).ripRefs;
    const bad: string[] = [];
    for (const d of a.dataRefs) {
      const hit = refs.find((x) => parseInt(x.target, 16) === parseInt(d.rva, 16));
      if (!hit) { bad.push(d.rva); continue; }
      d.ripRefOrdinal = hit.ordinal;
    }
    r.checks.push(bad.length ? `dataRefs: ${bad.join("/")} not referenced by ${e.name}` : `dataRefs ok (${a.dataRefs.map((d) => `#${d.ripRefOrdinal}`).join(",")})`);
    if (bad.length) r.failed = true;
  }
  return r;
}
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
      const v = verifyFunctionAnchors(out, pe, buf, e, harvestOf);
      const status: HarvestStatus = v.failed ? "mismatch" : v.checks.length && !v.rewritten ? "verified" : "harvested";
      report.push({ name: e.name, kind: e.kind, status, detail: `${h.cfgLite.bytes} bytes, ${h.callees.length} calls, ${h.ripRefs.length} rip refs${sig ? ", unique funcsig" : h.strings.length ? ", strings but no unique funcsig" : ", no strings"}${v.checks.length ? `; anchors: ${v.checks.join(", ")}` : ""}` });
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
      const vals = constantValues(src);
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
