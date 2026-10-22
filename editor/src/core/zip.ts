// A minimal zip writer + reader, Node built-ins only (node:zlib for DEFLATE; the CRC-32, the local headers and the
// central directory are written by hand). Used by `pack` / `install` (src/core/pack.ts) and the VectorCraft vendoring
// script. Deliberately small: no zip64 (every size and offset < 4 GiB), no encryption, no data descriptors on write,
// only methods 0 (store) and 8 (deflate). Names are UTF-8 (general-purpose flag bit 11).

import { deflateRawSync, inflateRawSync } from "node:zlib";

const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_EOCD = 0x06054b50;
const FLAG_UTF8 = 0x0800;
/** version made by: 3 = UNIX (so the high 16 bits of the external attributes are a st_mode), spec 2.0 */
const MADE_BY = (3 << 8) | 20;
const NEEDED = 20;
const S_IFMT = 0o170000;
export const S_IFREG = 0o100000;
export const S_IFLNK = 0o120000;

// ---- CRC-32 (IEEE, the zip polynomial) ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- writer -----------------------------------------------------------------------------------------------------
export interface ZipInputFile {
  /** posix path inside the archive, no leading slash */
  name: string;
  data: Uint8Array;
  /** st_mode for the external attributes (default 0o100644, a regular file) */
  unixMode?: number;
}
export interface WriteZipOptions {
  /** auto (default): deflate when it is smaller, else store; store: never compress; deflate: always */
  method?: "auto" | "store" | "deflate";
  /** the timestamp of every entry (default 1980-01-01 00:00, the DOS epoch, so the same input gives the same bytes) */
  date?: Date;
}

function dosDateTime(d: Date | undefined): { time: number; date: number } {
  if (!d) return { time: 0, date: (0 << 9) | (1 << 5) | 1 };
  const y = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Build a zip archive from `files` (in the given order). Throws on an empty or duplicate name or a 4 GiB overflow. */
export function writeZip(files: ZipInputFile[], opts: WriteZipOptions = {}): Uint8Array {
  const method = opts.method ?? "auto";
  const { time, date } = dosDateTime(opts.date);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (const f of files) {
    // names are written as given (the reader side, safeZipPath, is the guard; tests forge hostile names with this)
    if (!f.name) throw new Error("zip entry name must not be empty");
    if (seen.has(f.name)) throw new Error(`duplicate zip entry: ${f.name}`);
    seen.add(f.name);
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data);
    let body: Uint8Array = f.data;
    let m = 0;
    if (method !== "store" && f.data.length > 0) {
      const deflated = deflateRawSync(f.data, { level: 9 });
      if (method === "deflate" || deflated.length < f.data.length) { body = deflated; m = 8; }
    }
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(SIG_LOCAL, 0);
    lh.writeUInt16LE(NEEDED, 4);
    lh.writeUInt16LE(FLAG_UTF8, 6);
    lh.writeUInt16LE(m, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(SIG_CENTRAL, 0);
    ch.writeUInt16LE(MADE_BY, 4);
    ch.writeUInt16LE(NEEDED, 6);
    ch.writeUInt16LE(FLAG_UTF8, 8);
    ch.writeUInt16LE(m, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    // extra 30, comment 32, disk 34, internal attrs 36 stay 0
    ch.writeUInt32LE((((f.unixMode ?? (S_IFREG | 0o644)) & 0xffff) << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, Buffer.from(body.buffer, body.byteOffset, body.byteLength));
    centrals.push(ch, name);
    offset += 30 + name.length + body.length;
    if (offset > 0xffffffff) throw new Error("zip too large (no zip64 support)");
  }
  const cd = Buffer.concat(centrals);
  if (files.length > 0xfffe) throw new Error("too many zip entries (no zip64 support)");
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}

// ---- reader (central directory; stored + deflate; CRC checked; no zip64, no encryption) ---------------------------
export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  size: number;
  /** high 16 bits: the unix st_mode when the archive was made on UNIX (0 from many Windows tools) */
  externalAttrs: number;
  localHeaderOffset: number;
  /** where the entry's bytes start (after the local header's name + extra field) */
  dataOffset: number;
  isDir: boolean;
}

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

/** The entries of a zip from its central directory (the authoritative sizes; data-descriptor entries need no special case). */
export function listZip(buf: Uint8Array): ZipEntry[] {
  const dv = view(buf);
  const n = buf.length;
  let eocd = -1;
  for (let i = n - 22; i >= Math.max(0, n - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)");
  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error("zip64 archives are not supported");
  if (cdOffset + cdSize > eocd) throw new Error("zip central directory lies outside the file");
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > n || dv.getUint32(p, true) !== SIG_CENTRAL) throw new Error(`bad central directory entry #${i} at ${p}`);
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const externalAttrs = dv.getUint32(p + 38, true);
    const localHeaderOffset = dv.getUint32(p + 42, true);
    const name = new TextDecoder("utf8").decode(buf.subarray(p + 46, p + 46 + nameLen));
    if (flags & 0x1) throw new Error(`zip entry "${name}" is encrypted`);
    if (localHeaderOffset + 30 > n || dv.getUint32(localHeaderOffset, true) !== SIG_LOCAL) throw new Error(`zip entry "${name}": bad local header at ${localHeaderOffset}`);
    const dataOffset = localHeaderOffset + 30 + dv.getUint16(localHeaderOffset + 26, true) + dv.getUint16(localHeaderOffset + 28, true);
    if (dataOffset + compressedSize > n) throw new Error(`zip entry "${name}": data runs past the end of the file`);
    entries.push({ name, method, flags, crc32: crc, compressedSize, size, externalAttrs, localHeaderOffset, dataOffset, isDir: name.endsWith("/") });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** True when the entry's unix mode says symlink (only meaningful for archives made on UNIX). */
export function isSymlinkEntry(e: ZipEntry): boolean {
  return ((e.externalAttrs >>> 16) & S_IFMT) === S_IFLNK;
}

/**
 * An entry's bytes (inflated when deflated), verified against the directory's size and CRC-32. Inflation is capped
 * at the declared size, so a stream that would expand further (a zip bomb) throws instead of filling memory.
 */
export function readZipEntry(buf: Uint8Array, e: ZipEntry): Uint8Array {
  const raw = buf.subarray(e.dataOffset, e.dataOffset + e.compressedSize);
  let out: Uint8Array;
  if (e.method === 0) out = raw;
  else if (e.method === 8) {
    try {
      // maxOutputLength must be >= 1; one byte over the declared size is enough to detect a longer stream
      out = new Uint8Array(inflateRawSync(raw, { maxOutputLength: Math.max(1, e.size + 1) }));
    } catch (err) {
      throw new Error(`zip entry "${e.name}": inflate failed or exceeds the declared ${e.size} bytes (${err instanceof Error ? err.message : String(err)})`);
    }
  } else throw new Error(`zip entry "${e.name}": unsupported compression method ${e.method}`);
  if (out.length !== e.size) throw new Error(`zip entry "${e.name}": inflated to ${out.length} bytes, directory says ${e.size}`);
  const c = crc32(out);
  if (c !== e.crc32) throw new Error(`zip entry "${e.name}": CRC-32 mismatch (${c.toString(16)} vs ${e.crc32.toString(16)})`);
  return out;
}

/**
 * The destination-relative path for a zip entry, or null when it must not be written: outside `strip` (a top
 * folder to remove), a directory, absolute, a drive letter, a backslash, a NUL, or any "." / ".." / empty segment.
 */
export function safeZipPath(name: string, strip = ""): string | null {
  if (name.includes("\\") || name.includes("\0") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) return null;
  if (strip && !name.startsWith(strip)) return null;
  const rel = name.slice(strip.length);
  if (!rel || rel.endsWith("/")) return null;
  const segs = rel.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) return null;
  return segs.join("/");
}
