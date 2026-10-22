// The Room editor's tileset art on disk: which clip draws each tile / spawn id of a mod's palette in a tileset
// (tile-art.ts resolves, from data the server reads here), and the PNG thumbnails of those clips' frame 1
// (art/swf-raster.ts over art/swf-library.ts), served by GET /api/level-art and GET /api/level-tile-art.
//
// Read-only on the game files: the SWFs are read from the extracted copy (.extracted/swfs, git-ignored) and the mod's
// own mods/<mod>/swfs/*.swf; thumbnails and the SWF export index are cached under editor/data/level-art/ (git-ignored)
// and never committed. Without .extracted/ every id is a named reason and the UI keeps the tint swatches.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { EXTRACTED_DATA, MODS_DIR, DATA_CACHE_DIR, vanillaSwfDir } from "../repo.ts";
import { parse } from "../gon/parser.ts";
import { toValue } from "../gon/value.ts";
import { parsePolicy } from "../overlay/policy.ts";
import type { VNode } from "../gon/types.ts";
import { levelPalette } from "./level-io.ts";
import type { PaletteEntry } from "./level-io.ts";
import { resolveTileArt, resolveObjectArt, defaultTilesetFor } from "./tile-art.ts";
import type { ArtContext, ArtResolution, MapTileset } from "./tile-art.ts";
import { vanillaSwfFiles, modSwfFiles, swfExportIndex, openSwfSource, fileStamp } from "../art/swf-library.ts";
import type { SwfFileRef } from "../art/swf-library.ts";
import { rasterizeCharacter } from "../art/swf-raster.ts";
import { encodePng } from "../art/png.ts";

/** Bump when the rasteriser's output changes, so cached thumbnails are redrawn. */
export const LEVEL_ART_RASTER_VERSION = 1;
/** output px per clip px: a tile diamond (140 clip px wide) becomes 70 px */
export const LEVEL_ART_SCALE = 0.5;

export interface LevelArtOptions {
  /** base data root (default EXTRACTED_DATA) */
  extractedData?: string;
  /** vanilla SWF directory (default .extracted/swfs) */
  swfDir?: string;
  /** cache root (default editor/data); thumbnails go to <cacheDir>/level-art/ */
  cacheDir?: string;
}

export interface LevelArtQuery {
  tileset?: string;
  /** the room (levels/<folder>/…): picks the default tileset from the map that uses the folder */
  path?: string;
}

export interface LevelArtInfo {
  ok: true;
  tileset: string;
  /** where the tileset came from: "query", "map <name>", "default_tileset", "fallback alley" */
  tilesetSource: string;
  tilesets: string[];
  hasSwfs: boolean;
  tiles: Record<string, ArtResolution>;
  objects: Record<string, ArtResolution>;
}

function plain(v: VNode): unknown {
  if (v.t === "str") return v.type === "number" && v.num !== null ? v.num : v.raw;
  if (v.t === "arr") return v.items.map(plain);
  const o: Record<string, unknown> = {};
  for (const e of v.entries) o[parsePolicy(e.key).name] = plain(e.value);
  return o;
}

function readGon(abs: string): Record<string, unknown> {
  if (!existsSync(abs)) return {};
  try {
    const v = plain(toValue(parse(readFileSync(abs, "utf8"))));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** base file (or the mod's whole-file copy), then the mod's .append / .merge / .patch: shallow per top-level key */
function gonWithOverlays(baseAbs: string, modAbs: string | null): Record<string, unknown> {
  const out = { ...(modAbs && existsSync(modAbs) ? readGon(modAbs) : readGon(baseAbs)) };
  if (modAbs) {
    for (const suf of [".append", ".merge", ".patch"]) {
      for (const [k, v] of Object.entries(readGon(modAbs + suf))) {
        const prev = out[k];
        out[k] = isObj(prev) && isObj(v) ? { ...prev, ...v } : v;
      }
    }
  }
  return out;
}

function gonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => /\.gon(\.(append|merge|patch))?$/.test(n)).map((n) => join(dir, n));
}

function stampKey(paths: string[]): string {
  return paths.map((p) => { try { const s = statSync(p); return `${p}:${s.size}:${s.mtimeMs}`; } catch { return `${p}:-`; } }).join("|");
}

interface LevelArtData {
  tilesets: Record<string, Record<string, unknown>>;
  defaultTileset: string | null;
  maps: MapTileset[];
  characters: Map<string, Record<string, unknown>>;
}
const dataMemo = new Map<string, { key: string; data: LevelArtData }>();

function modDataDir(mod: string): string | null {
  return mod && !/[\\/]/.test(mod) && mod !== "." && mod !== ".." ? join(MODS_DIR, mod, "data") : null;
}

function loadData(mod: string, root: string): LevelArtData {
  const md = modDataDir(mod);
  const charFiles = [...gonFiles(join(root, "characters")), ...(md ? gonFiles(join(md, "characters")) : [])];
  const mapFiles = [...gonFiles(join(root, "maps")), ...(md ? gonFiles(join(md, "maps")) : [])];
  const tsFiles = [join(root, "tilesets.gon"), ...(md ? ["", ".append", ".merge", ".patch"].map((s) => join(md, "tilesets.gon" + s)) : [])];
  const key = stampKey([...charFiles, ...mapFiles, ...tsFiles]);
  const memoKey = `${root}|${mod}`;
  const hit = dataMemo.get(memoKey);
  if (hit && hit.key === key) return hit.data;

  const ts = gonWithOverlays(join(root, "tilesets.gon"), md ? join(md, "tilesets.gon") : null);
  const tilesets: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(ts)) if (isObj(v)) tilesets[k] = v;
  const defaultTileset = typeof ts.default_tileset === "string" ? ts.default_tileset : null;

  const maps: MapTileset[] = [];
  for (const f of mapFiles.filter((p) => p.endsWith(".gon"))) {
    const g = readGon(f);
    const levels = isObj(g.levels) ? g.levels : {};
    if (typeof g.tileset === "string" && typeof levels.folder === "string") maps.push({ name: f.replace(/^.*[\\/]/, "").replace(/\.gon$/, ""), folder: levels.folder, tileset: g.tileset });
  }

  const characters = new Map<string, Record<string, unknown>>();
  // base files first, the mod's after (its whole files / appends add or replace names; merges merge per section)
  for (const f of charFiles) {
    const merge = /\.(merge|patch)$/.test(f);
    for (const [name, v] of Object.entries(readGon(f))) {
      if (!isObj(v)) continue;
      const prev = characters.get(name);
      if (merge && prev) {
        const next: Record<string, unknown> = { ...prev };
        for (const [k, sv] of Object.entries(v)) next[k] = isObj(prev[k]) && isObj(sv) ? { ...(prev[k] as Record<string, unknown>), ...sv } : sv;
        characters.set(name, next);
      } else characters.set(name, v);
    }
  }
  const data = { tilesets, defaultTileset, maps, characters };
  dataMemo.set(memoKey, { key, data });
  return data;
}

function swfFiles(mod: string, swfDir: string): SwfFileRef[] {
  const modSwfs = mod && modDataDir(mod) ? modSwfFiles(join(MODS_DIR, mod, "swfs")) : [];
  return [...modSwfs, ...vanillaSwfFiles(swfDir)];
}

function cacheRoot(opts: LevelArtOptions): string {
  return join(opts.cacheDir ?? DATA_CACHE_DIR, "level-art");
}

function context(mod: string, q: LevelArtQuery, opts: LevelArtOptions) {
  const root = opts.extractedData ?? EXTRACTED_DATA;
  const swfDir = opts.swfDir ?? vanillaSwfDir();
  const data = loadData(mod, root);
  const files = swfFiles(mod, swfDir);
  const index = files.length ? swfExportIndex(files, join(cacheRoot(opts), "swf-exports.json")) : null;
  const def = defaultTilesetFor(q.path ?? "", data.maps, data.defaultTileset);
  const tileset = q.tileset && q.tileset.trim() ? q.tileset.trim() : def.tileset;
  const ctx: ArtContext = { tileset, tilesets: data.tilesets, exports: index && index.exports.size ? index.exports : null, characters: data.characters };
  const palette = levelPalette(mod, { extractedData: root });
  return { ctx, index, palette, tilesetSource: q.tileset && q.tileset.trim() ? "query" : def.source, data };
}

/** "#rrggbb" or "rgb(r, g, b)" (edit.ts swatchColor) → [r, g, b] */
export function cssRgb(c: string | null | undefined): [number, number, number] | null {
  if (!c) return null;
  let m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);
  if (m) return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
  m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(c);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * The vanilla shader-filled tiles (WaterTile, LavaTile, IceTile, CreepTile, OilTile, …) draw their surface in pure
 * magenta #ff00ff, which the game's tile shaders replace (read-only look at tiles.swf, 2026-10-22; the shader side is
 * INFERRED). A thumbnail repaints those pixels with the tile's dev-editor tint so the grid does not read as magenta.
 */
export function repaintShaderKey(rgba: Uint8Array, tint: [number, number, number]): number {
  let n = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3]! > 0 && rgba[i]! >= 247 && rgba[i + 1]! <= 8 && rgba[i + 2]! >= 247) {
      rgba[i] = tint[0];
      rgba[i + 1] = tint[1];
      rgba[i + 2] = tint[2];
      n++;
    }
  }
  return n;
}

const asEntry = (e: PaletteEntry | undefined) => (e ? { id: e.id, kind: e.kind, classes: e.classes } : undefined);

/** Every tile and object id of the mod's palette resolved in one tileset. */
export function levelArtInfo(mod: string, q: LevelArtQuery = {}, opts: LevelArtOptions = {}): LevelArtInfo {
  const { ctx, palette, tilesetSource, data } = context(mod, q, opts);
  const tiles: Record<string, ArtResolution> = {};
  const objects: Record<string, ArtResolution> = {};
  for (const t of palette.tiles) tiles[t.id] = resolveTileArt(asEntry(t), t.id, ctx);
  for (const o of palette.objects) objects[o.id] = resolveObjectArt(asEntry(o), o.id, ctx);
  return { ok: true, tileset: ctx.tileset, tilesetSource, tilesets: Object.keys(data.tilesets).sort(), hasSwfs: !!ctx.exports, tiles, objects };
}

export interface LevelArtMeta {
  width: number;
  height: number;
  /** the clip's registration point (a tile's centre, an object's feet) in PNG px */
  originX: number;
  originY: number;
  /** PNG px per clip px */
  scale: number;
  clip: string;
  swf: string;
  mirrored: boolean;
  notes: string[];
  cached: boolean;
}
export type LevelArtImage = { ok: true; png: Uint8Array; meta: LevelArtMeta; resolution: ArtResolution } | { ok: false; reason: string; detail: string };

/** The PNG thumbnail of one tile (`tile`) or spawn (`object`) id's clip in the tileset, rendered once and cached. */
export function levelArtImage(mod: string, q: LevelArtQuery & { tile?: number; object?: number }, opts: LevelArtOptions = {}): LevelArtImage {
  const { ctx, index, palette } = context(mod, q, opts);
  const isTile = q.tile !== undefined;
  const id = isTile ? q.tile! : q.object;
  if (id === undefined || !Number.isInteger(id)) return { ok: false, reason: "bad-request", detail: "give tile=<id> or object=<id>" };
  const entry = isTile ? palette.tiles.find((e) => e.id === id) : palette.objects.find((e) => e.id === id);
  const r = isTile ? resolveTileArt(asEntry(entry), id, ctx) : resolveObjectArt(asEntry(entry), id, ctx);
  if (!r.ok) return { ok: false, reason: r.reason, detail: r.detail };
  const file = index?.byLabel.get(r.swf);
  if (!file) return { ok: false, reason: "no-clip", detail: `${r.swf} is not readable` };
  const scale = LEVEL_ART_SCALE * r.scale;
  let stamp: { size: number; mtimeMs: number };
  try { stamp = fileStamp(file.abs); } catch (e) { return { ok: false, reason: "no-clip", detail: String(e) }; }
  const tint = isTile ? cssRgb(entry?.color) : null;
  const key = createHash("sha1").update(JSON.stringify([LEVEL_ART_RASTER_VERSION, file.abs, stamp.size, stamp.mtimeMs, r.clip, r.mirrored, scale, tint])).digest("hex").slice(0, 24);
  const dir = cacheRoot(opts);
  const pngPath = join(dir, `${key}.png`);
  const metaPath = join(dir, `${key}.json`);
  if (existsSync(pngPath) && existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as LevelArtMeta;
      return { ok: true, png: new Uint8Array(readFileSync(pngPath)), meta: { ...meta, cached: true }, resolution: r };
    } catch { /* re-render */ }
  }
  let src;
  try { src = openSwfSource(file.abs); } catch (e) { return { ok: false, reason: "no-clip", detail: `${r.swf}: ${e instanceof Error ? e.message : String(e)}` }; }
  const cid = src.exports.get(r.clip);
  if (cid === undefined) return { ok: false, reason: "no-clip", detail: `${r.swf} does not export ${r.clip}` };
  const img = rasterizeCharacter(src, cid, { scale, mirror: r.mirrored });
  if (tint && repaintShaderKey(img.rgba, tint)) img.notes.push(`#ff00ff shader-key pixels painted in the tint rgb(${tint.join(", ")})`);
  const png = encodePng(img.width, img.height, img.rgba);
  const meta: LevelArtMeta = { width: img.width, height: img.height, originX: img.originX, originY: img.originY, scale: img.scale, clip: r.clip, swf: r.swf, mirrored: r.mirrored, notes: img.notes, cached: false };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(pngPath, png);
    writeFileSync(metaPath, JSON.stringify(meta));
  } catch { /* the cache is an optimisation */ }
  return { ok: true, png, meta, resolution: r };
}
