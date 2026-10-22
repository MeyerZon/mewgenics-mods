// Linkage names (SymbolClass / ExportAssets) of SWF files, read from the top-level tag headers only — no shape or
// sprite is parsed, so the 44 vanilla SWFs (1.5 GB) are listed in well under a second. Clips resolve by name through
// one global registry of every loaded SWF (App_FindMovieClipByName 0x9bb6f0, last-loaded first), so these names are
// what a particles.gon `movieclip` or an ability's graphics `particle` can point at.

import { openSync, readSync, closeSync, fstatSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { vanillaSwfDir } from "../repo.ts";

const TAG_SYMBOL_CLASS = 76, TAG_EXPORT_ASSETS = 56, TAG_END = 0;

function namesFromBody(b: Uint8Array): string[] {
  const out: string[] = [];
  if (b.length < 2) return out;
  const n = b[0]! | (b[1]! << 8);
  let q = 2;
  for (let i = 0; i < n && q < b.length; i++) {
    q += 2;
    let e = q;
    while (e < b.length && b[e] !== 0) e++;
    out.push(Buffer.from(b.subarray(q, e)).toString("latin1"));
    q = e + 1;
  }
  return out;
}

/** Export names of an in-memory SWF (FWS, or CWS inflated here). */
export function swfExportNamesFromBytes(bytes: Uint8Array): string[] {
  let b = bytes;
  if (b.length < 9) return [];
  if (b[0] === 0x43) { const body = inflateSync(b.subarray(8)); const n = new Uint8Array(8 + body.length); n.set(b.subarray(0, 8)); n.set(body, 8); n[0] = 0x46; b = n; }
  if (b[0] !== 0x46) return [];
  const nbits = b[8]! >> 3;
  let p = 8 + Math.ceil((5 + nbits * 4) / 8) + 4;
  const out: string[] = [];
  while (p + 2 <= b.length) {
    const h = b[p]! | (b[p + 1]! << 8);
    const code = h >> 6;
    let len = h & 63;
    p += 2;
    if (len === 63) { len = (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16)) + b[p + 3]! * 0x1000000; p += 4; }
    if (code === TAG_SYMBOL_CLASS || code === TAG_EXPORT_ASSETS) out.push(...namesFromBody(b.subarray(p, p + len)));
    if (code === TAG_END) break;
    p += len;
  }
  return out;
}

/** Export names of one SWF file on disk, reading only tag headers (and the export tags' bodies). */
export function swfExportNames(path: string): string[] {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(32, size));
    readSync(fd, head, 0, head.length, 0);
    if (head[0] === 0x43) return swfExportNamesFromBytes(new Uint8Array(readFileSync(path)));
    if (head[0] !== 0x46 || head.length < 9) return [];
    const nbits = head[8]! >> 3;
    let p = 8 + Math.ceil((5 + nbits * 4) / 8) + 4;
    const out: string[] = [];
    const hb = Buffer.alloc(6);
    while (p + 2 <= size) {
      readSync(fd, hb, 0, 6, p);
      const h = hb.readUInt16LE(0);
      const code = h >> 6;
      let len = h & 63;
      p += 2;
      if (len === 63) { len = hb.readUInt32LE(2); p += 4; }
      if (code === TAG_SYMBOL_CLASS || code === TAG_EXPORT_ASSETS) {
        const body = Buffer.alloc(len);
        readSync(fd, body, 0, len, p);
        out.push(...namesFromBody(new Uint8Array(body)));
      }
      if (code === TAG_END) break;
      p += len;
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

const cache = new Map<string, Set<string>>();

/** Every export name of the extracted vanilla SWFs (memoized per directory); empty when none are extracted. */
export function vanillaClipNames(dir: string = vanillaSwfDir()): Set<string> {
  const hit = cache.get(dir);
  if (hit) return hit;
  const out = new Set<string>();
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.toLowerCase().endsWith(".swf")) continue;
      try { for (const n of swfExportNames(join(dir, f))) out.add(n); } catch { /* unreadable: skip */ }
    }
  }
  cache.set(dir, out);
  return out;
}

/** Export names a mod provides: its art scenes' `exports` and any built SWF under its swfs/. */
export function modClipNames(modDir: string): Set<string> {
  const out = new Set<string>();
  const art = join(modDir, "art");
  if (existsSync(art)) {
    for (const f of readdirSync(art)) {
      if (!f.endsWith(".scene.json")) continue;
      try { const s = JSON.parse(readFileSync(join(art, f), "utf8")) as { exports?: Record<string, unknown> }; for (const k of Object.keys(s.exports || {})) out.add(k); } catch { /* bad scene: the scene validator reports it */ }
    }
  }
  const swfs = join(modDir, "swfs");
  if (existsSync(swfs)) for (const f of readdirSync(swfs)) if (f.toLowerCase().endsWith(".swf")) { try { for (const n of swfExportNames(join(swfs, f))) out.add(n); } catch { /* skip */ } }
  return out;
}
