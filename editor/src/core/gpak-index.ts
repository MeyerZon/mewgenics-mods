// Read-only access to the `resources.gpak` INDEX (paths + sizes) and to single entries by offset, for the
// audio index (editor/data/audio-index.json). Same format as tools/gpak.py:
//   u32 count; count x { u16 path_len; char path[path_len]; u32 size }; bodies concatenated in index order.
// The file is opened with flag "r" only and never written; nothing here extracts assets to disk.

import { openSync, readSync, closeSync, fstatSync } from "node:fs";

export interface GpakEntry {
  path: string;
  offset: number;
  size: number;
}

/** Parse the index from the first bytes of a gpak (the whole header must be in `head`). */
export function parseGpakIndex(head: Uint8Array, fileSize?: number): GpakEntry[] {
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (head.length < 4) throw new Error("gpak: truncated index (no count)");
  const count = dv.getUint32(0, true);
  let pos = 4;
  const raw: Array<{ path: string; size: number }> = [];
  const dec = new TextDecoder("utf-8");
  for (let i = 0; i < count; i++) {
    if (pos + 2 > head.length) throw new Error(`gpak: truncated index at entry ${i}`);
    const plen = dv.getUint16(pos, true);
    pos += 2;
    if (pos + plen + 4 > head.length) throw new Error(`gpak: truncated index at entry ${i}`);
    const path = dec.decode(head.subarray(pos, pos + plen));
    pos += plen;
    const size = dv.getUint32(pos, true);
    pos += 4;
    raw.push({ path, size });
  }
  let off = pos;
  const out: GpakEntry[] = raw.map((r) => {
    const e = { path: r.path, offset: off, size: r.size };
    off += r.size;
    return e;
  });
  if (fileSize !== undefined && off !== fileSize) throw new Error(`gpak: index + bodies = ${off} bytes, file is ${fileSize}`);
  return out;
}

/** A read-only handle on a gpak: its index and a reader for one entry's bytes. Call close() when done. */
export function openGpak(path: string): { entries: GpakEntry[]; read(e: GpakEntry, maxBytes?: number): Uint8Array; close(): void } {
  const fd = openSync(path, "r");
  try {
    const st = fstatSync(fd);
    let len = 1 << 20;
    let entries: GpakEntry[] | null = null;
    while (entries === null) {
      const head = new Uint8Array(Math.min(len, st.size));
      readSync(fd, head, 0, head.length, 0);
      try {
        entries = parseGpakIndex(head, st.size);
      } catch (e) {
        if (len >= st.size || !/truncated/.test(String(e))) throw e;
        len *= 4;
      }
    }
    const list = entries;
    return {
      entries: list,
      read(e: GpakEntry, maxBytes?: number): Uint8Array {
        const n = Math.min(e.size, maxBytes ?? e.size);
        const b = new Uint8Array(n);
        readSync(fd, b, 0, n, e.offset);
        return b;
      },
      close(): void { closeSync(fd); },
    };
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}
