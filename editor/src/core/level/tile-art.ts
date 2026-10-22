// Tileset art for the Room editor: which SWF clip draws a tile id or a spawn id in a given tileset. Pure (no Node
// imports); level-art.ts feeds it the parsed data and the SWF export index, and rasterises what it resolves.
//
// Tiles. A tiles.gon entry names a C++ tile class (`tile WaterTile`, or a weighted list `tile { GrassTile 80 … }`). The
// clip is the class name when tiles.swf exports it (WaterTile, FireTile, IceTile, MetalTile, GrassTile, … — read-only
// listing of tiles.swf's SymbolClass, 2026-10-22). A few classes have no clip of their own name; TILE_CLIP_ALIASES maps
// them to the clip the exe's string table names next to them (`ToxTile`, `TallGrassBack`/`Front`, …) — INFERRED from
// the exported names + the exe's string literals, not from the decompiled tile init. A tileset's `water_alt_tile`
// (meatworld / theend: BloodTile) replaces the water clips — INFERRED from the key's name. data/tilesets.gon has no
// other per-tile-class slot; a tile's art does not otherwise change with the tileset.
//
// Objects. A spawns.gon `object <Name>` is a character (data/characters/*.gon, `variant_of` chains inherit), drawn with
// its `graphics.movieclip` (default `_CAT`: the cat rig, not one clip). For every non-cat character the game first
// looks the clip name up as a key of the CURRENT tileset (ResolveClipName 0x7bdbb0, OBSERVED 2026-10-22): that is how
// `static_1x1_a` becomes the alley's Rubble, and how a mod's `alley { Rat ArtProbe }` redirect works. Enemy clips are
// drawn mirrored (OBSERVED, docs/engine-map.md "How the game draws a mod's character art"); here every faction other
// than allies / none mirrors. `utility` entries (PlayerSpawn) are editor markers with no art.

export const ART_REASONS = [
  "empty",
  "not-in-palette",
  "blank-tile",
  "no-tile-class",
  "utility",
  "no-character",
  "cat-rig",
  "no-clip",
  "no-swfs",
] as const;
export type ArtReason = (typeof ART_REASONS)[number];

export interface ArtResolved {
  ok: true;
  id: number;
  kind: "tile" | "object";
  clip: string;
  /** the SWF that exports `clip` (a vanilla file name, or `mod:<file>`) */
  swf: string;
  /** how the name was reached, for the tooltip */
  steps: string[];
  mirrored: boolean;
  /** graphics.scale (objects), 1 for tiles */
  scale: number;
  tileClass?: string;
  character?: string;
}
export interface ArtUnresolved {
  ok: false;
  id: number;
  kind: "tile" | "object";
  reason: ArtReason;
  /** one sentence: why the swatch is shown */
  detail: string;
  clip?: string;
  tileClass?: string;
  character?: string;
}
export type ArtResolution = ArtResolved | ArtUnresolved;

export interface ArtClass {
  name: string;
  weight: number;
}
export interface ArtEntry {
  id: number;
  kind?: string;
  classes: ArtClass[];
}

export interface ArtContext {
  tileset: string;
  /** data/tilesets.gon (+ the mod's overlays): tileset name → its flat object */
  tilesets: Record<string, Record<string, unknown>>;
  /** export (SymbolClass) name → SWF; null when no SWF directory exists (.extracted/ absent) */
  exports: Map<string, string> | null;
  /** data/characters/*.gon top-level entries by name */
  characters: Map<string, Record<string, unknown>>;
}

/** Tile classes whose clip has another name in tiles.swf (INFERRED: exported names + the exe's string literals). */
export const TILE_CLIP_ALIASES: Readonly<Record<string, string>> = {
  ToxicTile: "ToxTile",
  TallGrassTile: "TallGrassBack",
  TallFlowerTile: "TallFlowerBack",
  TallBrambleTile: "TallBrambleTileBack",
  WaterTile_Current: "WaterTile",
  FloatingGlassTile: "FloatingGlassTileBottom",
};
/** Tile classes that draw nothing of their own (the bare ground). */
export const ARTLESS_TILE_CLASSES: readonly string[] = ["BlankTile"];
const WATER_CLASSES = new Set(["WaterTile", "WaterTile_Current"]);
const NON_MIRRORED_FACTIONS = new Set(["allies", "none"]);

/** The heaviest class of a weighted list (the first on a tie); null for none. */
export function mainTileClass(classes: ArtClass[]): string | null {
  let best: ArtClass | null = null;
  for (const c of classes) if (!best || c.weight > best.weight) best = c;
  return best ? best.name : null;
}

/** ResolveClipName: a string under the clip name in the current tileset replaces it. */
export function resolveClipName(name: string, tileset: string, tilesets: ArtContext["tilesets"]): { clip: string; remapped: boolean } {
  const v = tilesets[tileset]?.[name];
  return typeof v === "string" && v ? { clip: v, remapped: true } : { clip: name, remapped: false };
}

function fail(id: number, kind: "tile" | "object", reason: ArtReason, detail: string, extra: Partial<ArtUnresolved> = {}): ArtUnresolved {
  return { ok: false, id, kind, reason, detail, ...extra };
}

const noSwfs = (id: number, kind: "tile" | "object", extra: Partial<ArtUnresolved> = {}): ArtUnresolved =>
  fail(id, kind, "no-swfs", "no SWF directory (extract the game files: tools/gpak.py extract), so the tint swatch is shown", extra);

export function resolveTileArt(entry: ArtEntry | undefined, id: number, ctx: ArtContext): ArtResolution {
  if (id === 0) return fail(id, "tile", "empty", "tile id 0 is the reserved empty entry");
  if (!entry) return fail(id, "tile", "not-in-palette", `tile id ${id} is not in tiles.gon (base or this mod)`);
  const cls = mainTileClass(entry.classes);
  if (!cls) return fail(id, "tile", "no-tile-class", `tiles.gon ${id} has no \`tile\` class`);
  if (ARTLESS_TILE_CLASSES.includes(cls)) return fail(id, "tile", "blank-tile", `${cls} is the bare ground: it draws no clip`, { tileClass: cls });
  const steps = [`tiles.gon ${id} → ${cls}${entry.classes.length > 1 ? " (heaviest of the weighted list)" : ""}`];
  let clip = cls;
  const alias = TILE_CLIP_ALIASES[cls];
  if (alias) {
    clip = alias;
    steps.push(`class alias ${cls} → ${alias}`);
  }
  const alt = ctx.tilesets[ctx.tileset]?.water_alt_tile;
  if (WATER_CLASSES.has(cls) && typeof alt === "string" && alt) {
    clip = alt;
    steps.push(`tileset ${ctx.tileset} water_alt_tile → ${alt}`);
  }
  if (!ctx.exports) return noSwfs(id, "tile", { clip, tileClass: cls });
  const swf = ctx.exports.get(clip);
  if (!swf) return fail(id, "tile", "no-clip", `no SWF exports a clip named ${clip} (tile class ${cls})`, { clip, tileClass: cls });
  steps.push(`${clip} in ${swf}`);
  return { ok: true, id, kind: "tile", clip, swf, steps, mirrored: false, scale: 1, tileClass: cls };
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** A character's effective graphics + faction, following `variant_of` (the child's keys win, section by section). */
export function characterGraphics(name: string, characters: ArtContext["characters"]): { found: boolean; movieclip: string; scale: number; faction: string | null; chain: string[] } {
  const chain: string[] = [];
  let graphics: Record<string, unknown> = {};
  let properties: Record<string, unknown> = {};
  let cur: string | undefined = name;
  while (cur && !chain.includes(cur)) {
    const c = characters.get(cur);
    if (!c) break;
    chain.push(cur);
    graphics = { ...obj(c.graphics), ...graphics };
    properties = { ...obj(c.properties), ...properties };
    cur = typeof c.variant_of === "string" ? c.variant_of : undefined;
  }
  const movieclip = typeof graphics.movieclip === "string" && graphics.movieclip ? graphics.movieclip : "_CAT";
  const scale = typeof graphics.scale === "number" && graphics.scale > 0 ? graphics.scale : 1;
  const faction = typeof properties.faction === "string" ? properties.faction : null;
  return { found: chain.length > 0, movieclip, scale, faction, chain };
}

export function resolveObjectArt(entry: ArtEntry | undefined, id: number, ctx: ArtContext): ArtResolution {
  if (id === 0) return fail(id, "object", "empty", "object id 0 is the reserved empty entry");
  if (!entry) return fail(id, "object", "not-in-palette", `spawn id ${id} is not in spawns.gon (base or this mod)`);
  const name = entry.classes[0]?.name ?? "";
  if (entry.kind === "utility") return fail(id, "object", "utility", `utility ${name} is an editor marker with no clip`, { character: name });
  if (!name) return fail(id, "object", "no-character", `spawns.gon ${id} names no object`);
  let g = characterGraphics(name, ctx.characters);
  const elite = !g.found && /_Elite$/.test(name) ? name.slice(0, -"_Elite".length) : null;
  if (elite) g = characterGraphics(elite, ctx.characters);
  if (!g.found) return fail(id, "object", "no-character", `no data/characters/*.gon entry named ${name}`, { character: name });
  if (g.movieclip === "_CAT") return fail(id, "object", "cat-rig", `${name} is drawn by the cat rig (movieclip _CAT), not one clip`, { character: name });
  const steps = [`spawns.gon ${id} → object ${name}${elite ? ` (an elite variant: drawn as ${elite})` : ""}`, `graphics.movieclip ${g.movieclip}${g.chain.length > 1 ? ` (via ${g.chain.slice(1).join(" → ")})` : ""}`];
  const r = resolveClipName(g.movieclip, ctx.tileset, ctx.tilesets);
  if (r.remapped) steps.push(`tileset ${ctx.tileset} ${g.movieclip} → ${r.clip}`);
  if (!ctx.exports) return noSwfs(id, "object", { clip: r.clip, character: name });
  const swf = ctx.exports.get(r.clip);
  if (!swf) return fail(id, "object", "no-clip", `no SWF exports a clip named ${r.clip} (${name})`, { clip: r.clip, character: name });
  steps.push(`${r.clip} in ${swf}`);
  const mirrored = g.faction !== null && !NON_MIRRORED_FACTIONS.has(g.faction);
  if (mirrored) steps.push(`faction ${g.faction}: drawn mirrored`);
  return { ok: true, id, kind: "object", clip: r.clip, swf, steps, mirrored, scale: g.scale, character: name };
}

export interface MapTileset {
  name: string;
  /** levels.folder */
  folder: string;
  tileset: string;
}

/** The tileset a room is shown in by default: the map whose `levels { folder }` holds it, else `default_tileset`. */
export function defaultTilesetFor(relPath: string, maps: MapTileset[], defaultTileset: string | null): { tileset: string; source: string } {
  const folder = /^levels\/([^/]+)\//.exec(relPath)?.[1];
  const m = folder ? maps.find((x) => x.folder === folder) : undefined;
  if (m) return { tileset: m.tileset, source: `map ${m.name}` };
  if (defaultTileset) return { tileset: defaultTileset, source: "default_tileset" };
  return { tileset: "alley", source: "fallback alley" };
}
