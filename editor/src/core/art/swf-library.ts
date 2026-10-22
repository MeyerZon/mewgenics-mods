// Read-only access to many SWFs by export name, for thumbnails (the Room editor's tileset art). The vanilla SWFs are
// large (backgrounds.swf ~170 MB), so a file is never fully parsed: a top-level tag-header walk records where each
// character is defined and what SymbolClass exports, and a character's tag is parsed (swf-reader.ts readTags) only
// when the rasteriser asks for it. Nothing is ever written next to the game files; the export index is cached in
// memory per (size, mtime) and, when a cache dir is given, as JSON there (editor/data/, git-ignored).

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { readTags } from "./swf-reader.ts";
import type { Tag } from "./swf-reader.ts";

/** Tag codes whose body starts with the u16 character id. */
const DEFINE_CODES = new Set([2, 22, 32, 83, 39, 20, 36, 6, 21, 35, 90, 11, 33, 37, 46, 84, 10, 48, 75, 7, 34, 14]);
const SYMBOL_CLASS = 76;
const EXPORT_ASSETS = 56;

export interface SwfScan {
  /** export name → character id */
  exports: Map<string, number>;
  /** character id → [tag start, tag end) in the file */
  ranges: Map<number, [number, number]>;
}

function cstring(b: Uint8Array, p: number): [string, number] {
  let e = p;
  while (e < b.length && b[e] !== 0) e++;
  return [Buffer.from(b.subarray(p, e)).toString("utf8"), e + 1];
}

/** Walk the top-level tags of an uncompressed (FWS) SWF: where each character is defined, and its exports. */
export function scanSwf(b: Uint8Array): SwfScan {
  const exports = new Map<string, number>();
  const ranges = new Map<number, [number, number]>();
  if (b.length < 21 || b[0] !== 0x46 || b[1] !== 0x57 || b[2] !== 0x53) throw new Error("not an uncompressed (FWS) SWF");
  const nbits = b[8]! >> 3;
  let p = 8 + Math.ceil((5 + 4 * nbits) / 8) + 4;
  while (p + 2 <= b.length) {
    const h = b[p]! | (b[p + 1]! << 8);
    const code = h >> 6;
    let len = h & 0x3f;
    let body = p + 2;
    if (len === 0x3f) {
      len = (b[body]! | (b[body + 1]! << 8) | (b[body + 2]! << 16)) + b[body + 3]! * 0x1000000;
      body += 4;
    }
    const end = body + len;
    if (end > b.length) break;
    if (DEFINE_CODES.has(code) && len >= 2) ranges.set(b[body]! | (b[body + 1]! << 8), [p, end]);
    else if ((code === SYMBOL_CLASS || code === EXPORT_ASSETS) && len >= 2) {
      const n = b[body]! | (b[body + 1]! << 8);
      let q = body + 2;
      for (let i = 0; i < n && q + 2 <= end; i++) {
        const id = b[q]! | (b[q + 1]! << 8);
        const [name, next] = cstring(b, q + 2);
        q = next;
        if (!exports.has(name)) exports.set(name, id);
      }
    }
    p = end;
    if (code === 0) break;
  }
  return { exports, ranges };
}

/** What the rasteriser reads: a character's parsed tag by id (+ the file's exports). */
export interface SwfSource {
  exports: Map<string, number>;
  get(id: number): Tag | undefined;
}

/** A lazily-parsed SWF over its bytes. */
export function swfSourceFromBytes(bytes: Uint8Array, scan: SwfScan = scanSwf(bytes)): SwfSource {
  const parsed = new Map<number, Tag | undefined>();
  return {
    exports: scan.exports,
    get(id: number): Tag | undefined {
      if (parsed.has(id)) return parsed.get(id);
      const r = scan.ranges.get(id);
      let t: Tag | undefined;
      if (r) {
        try { t = readTags(bytes, r[0], r[1])[0]; } catch { t = undefined; }
      }
      parsed.set(id, t);
      return t;
    },
  };
}

// ---- many files: the export index ----

export interface SwfFileRef {
  /** label shown to the user and used as the resolver's `swf` (a vanilla name, or mod:<file>) */
  label: string;
  abs: string;
}

interface FileStamp {
  size: number;
  mtimeMs: number;
}
const scanCache = new Map<string, { stamp: FileStamp; scan: SwfScan }>();
const bytesCache: Array<{ abs: string; stamp: FileStamp; bytes: Uint8Array; source: SwfSource }> = [];
const BYTES_KEEP = 3;

function stampOf(abs: string): FileStamp {
  const s = statSync(abs);
  return { size: s.size, mtimeMs: s.mtimeMs };
}
const sameStamp = (a: FileStamp, b: FileStamp) => a.size === b.size && a.mtimeMs === b.mtimeMs;

/** The vanilla SWFs in swflist.gon `game` order (the rest of the directory after), as file refs. */
export function vanillaSwfFiles(swfDir: string): SwfFileRef[] {
  if (!existsSync(swfDir)) return [];
  const all = readdirSync(swfDir).filter((n) => n.toLowerCase().endsWith(".swf"));
  let order: string[] = [];
  const list = join(swfDir, "swflist.gon");
  if (existsSync(list)) order = [...readFileSync(list, "utf8").matchAll(/([A-Za-z0-9_./-]+\.swf)/g)].map((m) => basename(m[1]!));
  const ranked = [...new Set([...order.filter((n) => all.includes(n)), ...all.sort()])];
  return ranked.map((n) => ({ label: n, abs: join(swfDir, n) }));
}

/** A mod's own SWFs (mods/<mod>/swfs/*.swf), labelled mod:<file>. */
export function modSwfFiles(modSwfDir: string): SwfFileRef[] {
  if (!existsSync(modSwfDir)) return [];
  return readdirSync(modSwfDir).filter((n) => n.toLowerCase().endsWith(".swf")).sort().map((n) => ({ label: `mod:${n}`, abs: join(modSwfDir, n) }));
}

interface DiskIndex {
  version: 1;
  files: Record<string, { size: number; mtimeMs: number; exports: string[] }>;
}

/**
 * export name → file label over `files` (first file wins: pass the mod's files first). Unreadable files are skipped.
 * With `cacheFile`, the per-file export lists persist across server restarts (keyed by size + mtime).
 */
export function swfExportIndex(files: SwfFileRef[], cacheFile?: string): { exports: Map<string, string>; byLabel: Map<string, SwfFileRef> } {
  let disk: DiskIndex = { version: 1, files: {} };
  if (cacheFile && existsSync(cacheFile)) {
    try { disk = JSON.parse(readFileSync(cacheFile, "utf8")) as DiskIndex; } catch { /* rebuilt */ }
  }
  let dirty = false;
  const exports = new Map<string, string>();
  const byLabel = new Map<string, SwfFileRef>();
  for (const f of files) {
    let stamp: FileStamp;
    try { stamp = stampOf(f.abs); } catch { continue; }
    byLabel.set(f.label, f);
    let names: string[] | undefined;
    const d = disk.files[f.abs];
    if (d && d.size === stamp.size && d.mtimeMs === stamp.mtimeMs) names = d.exports;
    else {
      try {
        names = [...openScan(f.abs, stamp).exports.keys()];
        disk.files[f.abs] = { ...stamp, exports: names };
        dirty = true;
      } catch { continue; }
    }
    for (const n of names) if (!exports.has(n)) exports.set(n, f.label);
  }
  if (cacheFile && dirty) {
    try {
      mkdirSync(join(cacheFile, ".."), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(disk));
    } catch { /* the cache is an optimisation */ }
  }
  return { exports, byLabel };
}

function openScan(abs: string, stamp: FileStamp): SwfScan {
  const hit = scanCache.get(abs);
  if (hit && sameStamp(hit.stamp, stamp)) return hit.scan;
  const bytes = new Uint8Array(readFileSync(abs));
  const scan = scanSwf(bytes);
  scanCache.set(abs, { stamp, scan });
  remember(abs, stamp, bytes, scan);
  return scan;
}

function remember(abs: string, stamp: FileStamp, bytes: Uint8Array, scan: SwfScan): SwfSource {
  const i = bytesCache.findIndex((e) => e.abs === abs);
  if (i >= 0) bytesCache.splice(i, 1);
  const source = swfSourceFromBytes(bytes, scan);
  bytesCache.unshift({ abs, stamp, bytes, source });
  while (bytesCache.length > BYTES_KEEP) bytesCache.pop();
  return source;
}

/** A lazily-parsed source for one SWF on disk (the few most recent files stay in memory). */
export function openSwfSource(abs: string): SwfSource {
  const stamp = stampOf(abs);
  const hit = bytesCache.find((e) => e.abs === abs);
  if (hit && sameStamp(hit.stamp, stamp)) {
    bytesCache.splice(bytesCache.indexOf(hit), 1);
    bytesCache.unshift(hit);
    return hit.source;
  }
  const bytes = new Uint8Array(readFileSync(abs));
  const sc = scanCache.get(abs);
  const scan = sc && sameStamp(sc.stamp, stamp) ? sc.scan : scanSwf(bytes);
  scanCache.set(abs, { stamp, scan });
  return remember(abs, stamp, bytes, scan);
}

/** size + mtime of a file, for cache keys */
export function fileStamp(abs: string): FileStamp {
  return stampOf(abs);
}
