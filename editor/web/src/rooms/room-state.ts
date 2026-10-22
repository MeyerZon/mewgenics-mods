// Rooms mode (the Room editor): the store and the actions behind the explorer (the mod's levels/**.lvl + the tile and
// object palettes), the 10x10 grid painter and the inspector / findings panel. Every edit goes through the pure
// helpers of src/core/level/edit.ts (the same ones MCP write_level uses); the server encodes, guards the path
// (levels/** inside the mod only) and runs the lvl-* validator rules (/api/level, /api/level/validate).

import { createStore } from "../store.ts";
import { S, toast } from "../state.ts";
import { getJson, post, url } from "../api.ts";
import { registerDirty, guard } from "../dirty.ts";
import { paintTiles, placeObject, removeObjects, setObjectPick, objectsAt, firstId } from "../../../src/core/level/edit.ts";
import type { LvlFile, LvlPick } from "../../../src/core/level/lvl.ts";
import type { ArtResolution } from "../../../src/core/level/tile-art.ts";
import type { Report, TemplateResult } from "../types.ts";

export interface LevelInfo {
  relPath: string;
  bytes: number;
  ok: boolean;
  error?: string;
  objects?: number;
  painted?: number;
}
export interface PaletteEntry {
  id: number;
  name: string;
  kind: "empty" | "tile" | "object" | "utility" | "other";
  cls: string;
  classes: Array<{ name: string; weight: number }>;
  color: string | null;
  letter: string;
  category: number | null;
  source: "base" | "mod";
}
export interface LevelPalette {
  ok: true;
  hasBase: boolean;
  tiles: PaletteEntry[];
  objects: PaletteEntry[];
}
type ListLevelsResult = { ok: true; levels: LevelInfo[] } | { ok: false; error: string };
type ReadLevelResult = { ok: true; relPath: string; level: LvlFile; bytes: number } | { ok: false; error: string };
type WriteLevelResult = { ok: true; path: string; bytes: number; findings: Report["findings"] } | { ok: false; error: string };

export type RoomTool = "select" | "tile" | "object" | "erase";
export type RoomView = "flat" | "iso";

/** GET /api/level-art: which clip draws each palette id in the tileset (src/core/level/level-art.ts) */
export interface LevelArtInfo {
  ok: true;
  tileset: string;
  tilesetSource: string;
  tilesets: string[];
  hasSwfs: boolean;
  tiles: Record<string, ArtResolution>;
  objects: Record<string, ArtResolution>;
}
/** GET /api/level-tile-art?meta=1: the thumbnail's size and the clip's registration point in it */
export interface ArtMeta {
  width: number;
  height: number;
  originX: number;
  originY: number;
  scale: number;
}
export type ArtKind = "tile" | "object";

export interface RoomState {
  levels: LevelInfo[];
  path: string;
  level: LvlFile | null;
  /** JSON of the level as last read / saved (dirty = the current JSON differs) */
  loadedJson: string;
  palette: LevelPalette | null;
  tool: RoomTool;
  tileBrush: LvlPick;
  objectBrush: LvlPick;
  sel: { x: number; y: number } | null;
  report: Report | null;
  newOpen: boolean;
  tileFilter: string;
  objectFilter: string;
  view: RoomView;
  /** the tileset the art is shown in ("" until /api/level-art answers with the room's default) */
  tileset: string;
  art: LevelArtInfo | null;
  /** `${tileset}:${kind}:${id}` → the thumbnail's metadata (null: failed) */
  artMeta: Record<string, ArtMeta | null>;
}

export const R = createStore<RoomState>({
  levels: [],
  path: "",
  level: null,
  loadedJson: "",
  palette: null,
  tool: "tile",
  tileBrush: 1,
  objectBrush: 1,
  sel: null,
  report: null,
  newOpen: false,
  tileFilter: "",
  objectFilter: "",
  view: "flat",
  tileset: "",
  art: null,
  artMeta: {},
});

export function isDirty(s: RoomState): boolean {
  return !!s.level && JSON.stringify(s.level) !== s.loadedJson;
}

// unsaved work (dirty.ts): asked on demand only (it stringifies the level)
registerDirty("rooms", {
  dirty: () => isDirty(R.get()),
  label: () => `the room ${R.get().path}`,
  save: () => saveLevel(),
});

/** A room row clicked: asks first when the open room has unsaved edits. */
export async function pickLevel(relPath: string): Promise<void> {
  if (relPath !== R.get().path && !(await guard(["rooms"], "Opening another room"))) return;
  await openLevel(relPath);
}

/** The toolbar's Close: asks first when the room has unsaved edits. */
export async function requestCloseLevel(): Promise<void> {
  if (!(await guard(["rooms"], "Closing the room"))) return;
  closeLevel();
}

export function setRoomTool(tool: RoomTool): void {
  R.set({ tool });
}
export function setRoomView(view: RoomView): void {
  R.set({ view });
}
export function setPaletteFilter(kind: "tile" | "object", value: string): void {
  R.set(kind === "tile" ? { tileFilter: value } : { objectFilter: value });
}
export function openNewRoom(): void {
  R.set({ newOpen: true });
}
export function closeNewRoom(): void {
  R.set({ newOpen: false });
}

/** Mod switched (or Rooms mode entered): the level list and the palette for that mod; closes the open level. */
export async function loadRoomsForMod(mod: string): Promise<void> {
  R.set({ levels: [], path: "", level: null, loadedJson: "", sel: null, report: null, palette: null, art: null, tileset: "" });
  if (!mod) return;
  await Promise.all([refreshLevels(mod), loadPalette(mod), loadArt(mod)]);
}

export async function refreshLevels(mod = S.get().mod): Promise<void> {
  const r = await getJson<ListLevelsResult>(url("/api/levels", { mod }));
  R.set({ levels: r.ok ? r.levels : [] });
}

export async function loadPalette(mod = S.get().mod): Promise<void> {
  const p = await getJson<LevelPalette>(url("/api/level-palette", { mod }));
  const spawn = p.objects.find((o) => o.kind === "utility" && o.cls === "PlayerSpawn");
  const firstTile = p.tiles.find((t) => t.id !== 0);
  R.set({ palette: p, objectBrush: spawn ? spawn.id : 1, tileBrush: firstTile ? firstTile.id : 1 });
}

export async function openLevel(relPath: string): Promise<void> {
  const mod = S.get().mod;
  const r = await getJson<ReadLevelResult>(url("/api/level", { mod, path: relPath }));
  if (!r.ok) {
    toast(`could not open ${relPath}: ${r.error}`);
    return;
  }
  R.set({ path: relPath, level: r.level, loadedJson: JSON.stringify(r.level), sel: null, report: null, tileset: "" });
  void runValidate();
  void loadArt(mod);
}

export function closeLevel(): void {
  R.set({ path: "", level: null, loadedJson: "", sel: null, report: null });
}

// ---- live findings (debounced) ----
let vTimer: ReturnType<typeof setTimeout> | undefined;
export function scheduleValidate(): void {
  if (vTimer) clearTimeout(vTimer);
  vTimer = setTimeout(() => void runValidate(), 250);
}
export async function runValidate(): Promise<void> {
  const { level, path } = R.get();
  const mod = S.get().mod;
  if (!level || !path || !mod) return;
  const rep = await post<"/api/level/validate", Report>("/api/level/validate", { mod, path, level });
  if (R.get().level === level) R.set({ report: rep });
}

function edit(next: LvlFile): void {
  if (next === R.get().level) return;
  R.set({ level: next });
  scheduleValidate();
}

// ---- painting ----
let stroke = false;
/** Apply the current tool at (x, y); `drag` is true for cells entered while the button is held. */
export function applyTool(x: number, y: number, drag: boolean): void {
  const s = R.get();
  if (!s.level) return;
  if (!drag) R.set({ sel: { x, y } });
  if (s.tool === "select") return;
  if (s.tool === "tile") edit(paintTiles(s.level, [{ x, y }], s.tileBrush));
  else if (s.tool === "object") { if (!drag) edit(placeObject(s.level, x, y, s.objectBrush)); }
  else if (objectsAt(s.level, x, y).length) edit(removeObjects(s.level, x, y));
  else edit(paintTiles(s.level, [{ x, y }], 0));
}
export function strokeStart(x: number, y: number): void {
  stroke = true;
  applyTool(x, y, false);
}
export function strokeEnter(x: number, y: number): void {
  if (stroke) applyTool(x, y, true);
}
export function strokeEnd(): void {
  stroke = false;
}

// ---- inspector edits ----
export function setCellTile(x: number, y: number, pick: LvlPick): void {
  const l = R.get().level;
  if (l) edit(paintTiles(l, [{ x, y }], pick));
}
export function setObject(index: number, pick: LvlPick): void {
  const l = R.get().level;
  if (l) edit(setObjectPick(l, index, pick));
}
export function removeObjectAt(index: number): void {
  const l = R.get().level;
  if (l) edit({ ...l, objects: l.objects.filter((_o, i) => i !== index) });
}
export function addObjectAt(x: number, y: number): void {
  const s = R.get();
  if (!s.level) return;
  // a second object on a cell (vanilla stacks a few): append, never replace
  edit({ ...s.level, objects: [...s.level.objects, { x, y, id: s.objectBrush }] });
}

export function chooseTileBrush(id: number): void {
  R.set({ tileBrush: id, tool: "tile" });
}
export function chooseObjectBrush(id: number): void {
  R.set({ objectBrush: id, tool: "object" });
}
export function brushLabel(p: LvlPick): string {
  return typeof p === "number" ? String(p) : `random(${p.map((c) => `${c.id}:${c.weight}`).join(", ")})`;
}
export { firstId };

/** Write the open room (the top-bar Save / Ctrl+S in Rooms mode). True when written. */
export async function saveLevel(): Promise<boolean> {
  const { level, path } = R.get();
  const mod = S.get().mod;
  if (!level || !path || !mod) return false;
  const r = await post<"/api/level", WriteLevelResult>("/api/level", { mod, path, level });
  if (!r.ok) {
    toast(`write refused: ${r.error}`, { kind: "error" });
    return false;
  }
  const findings = r.findings;
  let errors = 0, warnings = 0, infos = 0;
  for (const f of findings) { if (f.severity === "error") errors++; else if (f.severity === "warning") warnings++; else infos++; }
  R.set({ loadedJson: JSON.stringify(level), report: { ok: errors === 0, findings, counts: { errors, warnings, infos } } });
  toast(`saved ${r.path} (${r.bytes} bytes)`, { kind: "ok" });
  await refreshLevels(mod);
  return true;
}

/** New room: new_from_template kind room (4 player spawns + 2 Rats) → levels/<folder>/<name>.lvl, then open it. */
export async function newRoom(folder: string, name: string): Promise<string | null> {
  const mod = S.get().mod;
  if (!mod) return "open a mod first";
  if (!(await guard(["rooms"], "Creating a new room"))) return null;
  const res = await post<"/api/template", TemplateResult>("/api/template", { mod, kind: "room", name, options: { folder: folder || "custom" } });
  if (!res.ok) return res.error;
  R.set({ newOpen: false });
  await refreshLevels(mod);
  await openLevel(`levels/${folder || "custom"}/${name}.lvl`);
  toast(`created levels/${folder || "custom"}/${name}.lvl${res.hint ? " — " + res.hint : ""}`);
  return null;
}

// ---- tileset art (the grid's thumbnails; tint swatches stay the fallback) ----

/** Resolve the palette's art in R.tileset ("" = the room's default: its map's tileset, else default_tileset). */
let artSeq = 0;
export async function loadArt(mod = S.get().mod): Promise<void> {
  if (!mod) return;
  const { tileset, path } = R.get();
  const seq = ++artSeq;
  try {
    const a = await getJson<LevelArtInfo>(url("/api/level-art", { mod, tileset, path }));
    if (seq === artSeq && a && a.ok) R.set({ art: a, tileset: a.tileset });
  } catch {
    if (seq === artSeq) R.set({ art: null });
  }
}

export async function chooseTileset(tileset: string): Promise<void> {
  R.set({ tileset });
  await loadArt();
}

export function artUrl(kind: ArtKind, id: number, meta = false): string {
  return url("/api/level-tile-art", { mod: S.get().mod, tileset: R.get().tileset, [kind]: id, meta: meta ? 1 : undefined });
}

const metaPending = new Set<string>();
/** Fetch (once) the thumbnail metadata the iso view positions an image with. */
export function ensureArtMeta(kind: ArtKind, id: number): void {
  const key = `${R.get().tileset}:${kind}:${id}`;
  if (key in R.get().artMeta || metaPending.has(key)) return;
  metaPending.add(key);
  void (async () => {
    let m: ArtMeta | null = null;
    try {
      const r = await fetch(artUrl(kind, id, true));
      if (r.ok) m = (await r.json()) as ArtMeta;
    } catch { /* stays a swatch */ }
    metaPending.delete(key);
    R.set({ artMeta: { ...R.get().artMeta, [key]: m } });
  })();
}
