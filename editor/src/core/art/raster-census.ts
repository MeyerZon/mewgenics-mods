// What vanilla does with raster (read-only, T1): per installed SWF the bitmap count, the largest bitmap and the bitmap
// fill types its shapes use, the lossless formats and the JPEG count across all files, and how the alley combat
// background (backgrounds.swf AlleyBGTest, the plate TacticsTest shows) is built. Pinned in
// test/fixtures/art/vanilla-raster.json; docs/art-pipeline.md "Raster art" cites it. Node (reads files).

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readSwf, flattenTags } from "./swf-reader.ts";
import type { Tag } from "./swf-reader.ts";

export interface RasterCensus {
  files: Record<string, { bitmaps: number; maxWidth: number; maxHeight: number; fillTypes: string[] }>;
  formats: number[];
  jpeg: number;
  alleyBackground: { file: string; export: string; frames: number; bitmap: string; scale: number };
}

const JPEG = new Set([6, 21, 35, 90]);

export function vanillaRasterCensus(dir: string): RasterCensus {
  const files: RasterCensus["files"] = {};
  const formats = new Set<number>();
  let jpeg = 0;
  let alley: RasterCensus["alleyBackground"] = { file: "backgrounds.swf", export: "AlleyBGTest", frames: 0, bitmap: "", scale: 0 };
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".swf")).sort()) {
    const parsed = readSwf(new Uint8Array(readFileSync(join(dir, f))));
    const all = flattenTags(parsed.tags);
    jpeg += all.filter((t) => JPEG.has(t.code)).length;
    const bms = all.filter((t) => t.bitmap);
    if (!bms.length) continue;
    let maxWidth = 0, maxHeight = 0;
    for (const t of bms) { maxWidth = Math.max(maxWidth, t.bitmap!.width); maxHeight = Math.max(maxHeight, t.bitmap!.height); formats.add(t.bitmap!.format); }
    const types = new Set<string>();
    for (const t of all) if (t.shape) for (const fs of [...t.shape.fillStyles, ...t.shape.lineStyles.map((l) => l.fill).filter((x) => !!x)]) if (fs && fs.type >= 0x40) types.add(`0x${fs.type.toString(16)}`);
    files[f] = { bitmaps: bms.length, maxWidth, maxHeight, fillTypes: [...types].sort() };
    if (f === "backgrounds.swf") alley = alleyPlate(parsed.tags, all);
  }
  return { files, formats: [...formats].sort((a, b) => a - b), jpeg, alleyBackground: alley };
}

function alleyPlate(top: Tag[], all: Tag[]): RasterCensus["alleyBackground"] {
  const byId = new Map<number, Tag>();
  for (const t of all) { const id = t.shape ? t.shape.id : t.bitmap ? t.bitmap.id : t.id; if (id !== undefined && !byId.has(id)) byId.set(id, t); }
  const sc = top.filter((t) => t.code === 76).flatMap((t) => t.entries || []);
  const e = sc.find((x) => x.name === "AlleyBGTest");
  const sp = e ? byId.get(e.id) : undefined;
  const out = { file: "backgrounds.swf", export: "AlleyBGTest", frames: sp && sp.frameCount ? sp.frameCount : 0, bitmap: "", scale: 0 };
  const first = sp && sp.tags ? sp.tags.find((t) => t.place && t.place.characterId !== undefined) : undefined;
  const shape = first ? byId.get(first.place!.characterId!) : undefined;
  const fill = shape && shape.shape ? shape.shape.fillStyles.find((f) => f.type >= 0x40 && f.bitmapId !== undefined && byId.get(f.bitmapId!)?.bitmap) : undefined;
  if (fill) {
    const b = byId.get(fill.bitmapId!)!.bitmap!;
    out.bitmap = `${b.width}x${b.height}`;
    out.scale = Math.round(((fill.matrix ? fill.matrix[0] : 0) / 20) * 10000) / 10000;
  }
  return out;
}
