// PE32+ reader for the bindings library: build identity, the section table,
// RVA <-> file-offset mapping and the .pdata (RUNTIME_FUNCTION) table that
// gives every function's begin/end without a disassembler. Pure: works on a
// Buffer, never writes, node built-ins only. Shared by the signature scanner
// (scan.ts), the generator (siggen.ts), harvest/port and tools/bindings/*.

/**
 * @typedef {{ name: string, va: number, vsize: number, raw: number, rawSize: number, chars: number, exec: boolean }} PeSection
 * @typedef {{ begin: number, end: number, unwind: number }} RuntimeFunction
 * @typedef {{ rva: number, size: number }} DataDirectory
 * @typedef {{
 *   machine: number,
 *   timeDateStamp: number,
 *   sizeOfImage: number,
 *   sizeOfHeaders: number,
 *   imageBase: number,
 *   sectionAlignment: number,
 *   fileAlignment: number,
 *   sections: PeSection[],
 *   execSections: PeSection[],
 *   dataDirectories: DataDirectory[],
 *   rvaToOff: (rva: number) => number,
 *   offToRva: (off: number) => number,
 *   sectionOf: (rva: number) => PeSection|null,
 *   pdata: { count: number, get: (i: number) => RuntimeFunction, find: (rva: number) => RuntimeFunction|null },
 * }} Pe
 */

export const IMAGE_SCN_MEM_EXECUTE = 0x20000000;
export const IMAGE_DIRECTORY_ENTRY_EXCEPTION = 3;
export const RUNTIME_FUNCTION_SIZE = 12;

export class PeError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "PeError";
  }
}

/**
 * Parse a PE32+ image from its on-disk bytes.
 * @param {Buffer} buf
 * @returns {Pe}
 */
export function parsePe(buf) {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) throw new PeError("not a PE file (no MZ header)");
  const pe = buf.readUInt32LE(0x3c);
  if (pe + 24 > buf.length || buf.readUInt32LE(pe) !== 0x00004550) throw new PeError("not a PE file (no PE signature)");
  const machine = buf.readUInt16LE(pe + 4);
  const nsec = buf.readUInt16LE(pe + 6);
  const timeDateStamp = buf.readUInt32LE(pe + 8);
  const optSize = buf.readUInt16LE(pe + 20);
  const opt = pe + 24;
  const magic = buf.readUInt16LE(opt);
  if (magic !== 0x20b) throw new PeError(`unsupported optional header magic 0x${magic.toString(16)} (need PE32+)`);
  const imageBase = Number(buf.readBigUInt64LE(opt + 24));
  const sectionAlignment = buf.readUInt32LE(opt + 32);
  const fileAlignment = buf.readUInt32LE(opt + 36);
  const sizeOfImage = buf.readUInt32LE(opt + 56);
  const sizeOfHeaders = buf.readUInt32LE(opt + 60);
  const numDirs = buf.readUInt32LE(opt + 108);
  /** @type {DataDirectory[]} */
  const dataDirectories = [];
  for (let i = 0; i < numDirs; i++) {
    const o = opt + 112 + i * 8;
    if (o + 8 > buf.length) break;
    dataDirectories.push({ rva: buf.readUInt32LE(o), size: buf.readUInt32LE(o + 4) });
  }

  /** @type {PeSection[]} */
  const sections = [];
  const secTab = opt + optSize;
  for (let i = 0; i < nsec; i++) {
    const o = secTab + i * 40;
    if (o + 40 > buf.length) throw new PeError("section table truncated");
    const chars = buf.readUInt32LE(o + 36);
    sections.push({
      name: buf.toString("latin1", o, o + 8).replace(/\0.*$/, ""),
      vsize: buf.readUInt32LE(o + 8),
      va: buf.readUInt32LE(o + 12),
      rawSize: buf.readUInt32LE(o + 16),
      raw: buf.readUInt32LE(o + 20),
      chars,
      exec: (chars & IMAGE_SCN_MEM_EXECUTE) !== 0,
    });
  }
  const execSections = sections.filter((s) => s.exec);

  /** @param {number} rva */
  const sectionOf = (rva) => {
    for (const s of sections) if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) return s;
    return null;
  };
  /** @param {number} rva */
  const rvaToOff = (rva) => {
    const s = sectionOf(rva);
    if (!s) return -1;
    const d = rva - s.va;
    return d < s.rawSize ? s.raw + d : -1; // beyond the raw data there is no file byte (zero fill in memory)
  };
  /** @param {number} off */
  const offToRva = (off) => {
    for (const s of sections) if (s.rawSize > 0 && off >= s.raw && off < s.raw + s.rawSize) return s.va + (off - s.raw);
    return -1;
  };

  // .pdata: the exception directory is an array of RUNTIME_FUNCTION { BeginAddress, EndAddress, UnwindInfo }
  // sorted by BeginAddress (PE spec), so a binary search finds the entry containing an RVA.
  const exc = dataDirectories[IMAGE_DIRECTORY_ENTRY_EXCEPTION];
  const excOff = exc && exc.size >= RUNTIME_FUNCTION_SIZE ? rvaToOff(exc.rva) : -1;
  const count = excOff >= 0 ? Math.min(Math.floor(exc.size / RUNTIME_FUNCTION_SIZE), Math.floor((buf.length - excOff) / RUNTIME_FUNCTION_SIZE)) : 0;
  /** @param {number} i @returns {RuntimeFunction} */
  const get = (i) => {
    if (i < 0 || i >= count) throw new PeError(`pdata index ${i} out of range (count ${count})`);
    const o = excOff + i * RUNTIME_FUNCTION_SIZE;
    return { begin: buf.readUInt32LE(o), end: buf.readUInt32LE(o + 4), unwind: buf.readUInt32LE(o + 8) };
  };
  /** @param {number} rva @returns {RuntimeFunction|null} */
  const find = (rva) => {
    let lo = 0;
    let hi = count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const e = get(mid);
      if (rva < e.begin) hi = mid - 1;
      else if (rva >= e.end) lo = mid + 1;
      else return e;
    }
    return null;
  };

  return {
    machine, timeDateStamp, sizeOfImage, sizeOfHeaders, imageBase, sectionAlignment, fileAlignment,
    sections, execSections, dataDirectories, rvaToOff, offToRva, sectionOf,
    pdata: { count, get, find },
  };
}

/**
 * The bytes of a section as the loader sees them: raw data, zero-padded to VirtualSize when
 * VirtualSize is larger. The DLL scans Misc.VirtualSize in memory while the old TSV tool scanned
 * the raw size on disk; this is the single definition both sides now use.
 * @param {Buffer} buf
 * @param {PeSection} s
 * @returns {Buffer}
 */
export function sectionBytes(buf, s) {
  const raw = buf.subarray(s.raw, Math.min(buf.length, s.raw + s.rawSize));
  if (s.vsize <= raw.length) return raw.subarray(0, s.vsize);
  const out = Buffer.alloc(s.vsize);
  raw.copy(out, 0);
  return out;
}
