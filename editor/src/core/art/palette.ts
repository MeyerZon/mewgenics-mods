// Reads the engine's shared palette table (`textures/palette.png`, 16×256) from the
// git-ignored extracted copy (repo.ts extractedPath("textures", …), so MEWGENICS_EXTRACTED_DATA
// redirects it in a worktree) and exposes it as rows for the preview. Never bundles
// or copies the game asset anywhere else. Falls back to an identity gray ramp when the
// file is not extracted, with a hint on how to extract it (read-only gpak access).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractedPath, resolveReadPath } from "../repo.ts";
import { decodePng } from "./png.ts";

export const PALETTE_REL = join(".extracted", "textures", "palette.png");
export const FX_PALETTE_REL = join(".extracted", "textures", "fx_palette.png");
export const EXTRACT_HINT = "python -I tools/gpak.py extract .extracted --prefix textures/palette.png";

/** 16 RGB entries */
export type PaletteRow = Array<[number, number, number]>;

export type PaletteKind = "palette" | "fx_palette";

export interface PaletteResult {
  ok: boolean;
  which: PaletteKind;
  /** 256 (or 128) rows of 16 RGB triplets; identity ramp when !ok */
  rows: PaletteRow[];
  width: number;
  height: number;
  /** file path or "identity" */
  source: string;
  error?: string;
  hint?: string;
}

/** The ramp the shader would produce with no table: gray level N → (17N,17N,17N). */
export function identityRows(height = 256): PaletteRow[] {
  const rows: PaletteRow[] = [];
  for (let r = 0; r < height; r++) {
    const row: PaletteRow = [];
    for (let c = 0; c < 16; c++) row.push([c * 17, c * 17, c * 17]);
    rows.push(row);
  }
  return rows;
}

const cache = new Map<string, PaletteResult>();

export function readPalette(which: PaletteKind = "palette", opts: { noCache?: boolean } = {}): PaletteResult {
  const key = which;
  if (!opts.noCache && cache.has(key)) return cache.get(key) as PaletteResult;
  const rel = which === "fx_palette" ? FX_PALETTE_REL : PALETTE_REL;
  const abs = resolveReadPath(extractedPath("textures", which + ".png"));
  const height = which === "fx_palette" ? 128 : 256;
  let result: PaletteResult;
  if (!existsSync(abs)) {
    result = { ok: false, which, rows: identityRows(height), width: 16, height, source: "identity", error: `${rel.replace(/\\/g, "/")} not extracted`, hint: EXTRACT_HINT.replace("palette.png", which + ".png") };
  } else {
    try {
      const img = decodePng(new Uint8Array(readFileSync(abs)));
      if (img.width !== 16) throw new Error(`expected a 16-wide palette map, got ${img.width}×${img.height}`);
      const rows: PaletteRow[] = [];
      for (let y = 0; y < img.height; y++) {
        const row: PaletteRow = [];
        for (let x = 0; x < 16; x++) {
          const i = (y * img.width + x) * 4;
          row.push([img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]]);
        }
        rows.push(row);
      }
      result = { ok: true, which, rows, width: img.width, height: img.height, source: rel.replace(/\\/g, "/") };
    } catch (e) {
      result = { ok: false, which, rows: identityRows(height), width: 16, height, source: "identity", error: `could not decode ${rel}: ${String(e instanceof Error ? e.message : e)}` };
    }
  }
  cache.set(key, result);
  return result;
}

/**
 * CPU-side remap of one gray level through a row — the exact shader rule
 * (`texelFetch(palettemap, ivec2(r*15+.5, row))`), for Canvas2D fallbacks and UI swatches.
 * @param level 0..15
 */
export function remapGray(rows: PaletteRow[], row: number, level: number): [number, number, number] {
  const r = rows[Math.max(0, Math.min(rows.length - 1, row | 0))];
  const c = Math.max(0, Math.min(15, level | 0));
  return r ? r[c] : [c * 17, c * 17, c * 17];
}

/**
 * Known palette-row uses from base data (OBSERVED in docs/art-pipeline.md §5), for the
 * picker's hints. Rows 0–48 are random cats (`num_palettes 49`).
 */
export function knownRowHints(): Record<number, string> {
  const h: Record<number, string> = {};
  for (let i = 0; i < 49; i++) h[i] = "random cat";
  h[11] = "hud_palette";
  h[54] = "Fighter";
  h[137] = "TomTom_Champion";
  return h;
}
