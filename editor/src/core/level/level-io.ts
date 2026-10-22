// Level files on disk for the Room editor (web UI "Rooms" mode) and the MCP tools read_level / write_level.
// Reads and writes only `mods/<mod>/levels/**.lvl` (edit.ts isLevelPath + repo.ts resolveModWritePath: never outside
// the mod, never a saves/ path); encodes with lvl.ts, so an unedited level is written back byte for byte; the lvl-*
// validator rules run on every write and on unsaved content (validateLevelBytes).
//
// The palette is data/tiles.gon + data/spawns.gon (base, or the mod's whole-file copy) with the mod's .append /
// .merge / .patch on top; each entry's `editor { name … image_tint … category … }` block (the dev level editor's
// metadata) gives the label and a swatch colour. Tileset art is not resolved here: the swatch is the dev editor's
// tint, and a cell's look in a fight depends on the map's tileset.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { EXTRACTED_DATA, MODS_DIR, packPath, resolveModWritePath } from "../repo.ts";
import { parse } from "../gon/parser.ts";
import { toValue } from "../gon/value.ts";
import { parsePolicy } from "../overlay/policy.ts";
import { writeModBinary } from "../mod-io.ts";
import { validateLevelBytes } from "../validate/validator.ts";
import { decodeLvl, encodeLvl, buildRoom } from "./lvl.ts";
import { spawnIdsByName } from "./level-templates.ts";
import { isLevelPath, structuralErrors, paintTiles, placeObject, removeObjects, swatchColor, paletteLetter, categoryColor } from "./edit.ts";
import type { LvlFile, LvlPick } from "./lvl.ts";
import type { Finding, Report } from "../validate/result.ts";
import type { VNode } from "../gon/types.ts";

export interface LevelIoOptions {
  /** the base-data root (tests); default EXTRACTED_DATA */
  extractedData?: string;
  /** encode + validate, write nothing */
  dryRun?: boolean;
}

const PATH_RULE = 'a level path must be levels/<folder>/<name>.lvl inside the mod (letters, digits, "_" and "-"; the game reads "levels/" + name + ".lvl")';

export interface LevelInfo {
  relPath: string;
  bytes: number;
  ok: boolean;
  error?: string;
  objects?: number;
  /** cells whose tile is not 0 */
  painted?: number;
}

export type ListLevelsResult = { ok: true; mod: string; levels: LevelInfo[] } | { ok: false; error: string };

/** Every `levels/**.lvl` the mod ships, sorted, with a one-line decode summary. */
export function listLevels(modName: string): ListLevelsResult {
  let modDir: string;
  try { modDir = resolveModWritePath(modName, "."); } catch (e) { return { ok: false, error: String(e instanceof Error ? e.message : e) }; }
  if (!existsSync(modDir)) return { ok: false, error: `mod not found: mods/${modName}` };
  const levels: LevelInfo[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".lvl")) {
        const relPath = relative(modDir, abs).replace(/\\/g, "/");
        const b = readFileSync(abs);
        try {
          const l = decodeLvl(b);
          levels.push({ relPath, bytes: b.length, ok: true, objects: l.objects.length, painted: l.tiles.filter((t) => t !== 0).length });
        } catch (err) {
          levels.push({ relPath, bytes: b.length, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  };
  walk(join(modDir, "levels"));
  levels.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return { ok: true, mod: modName, levels };
}

export type ReadLevelResult = { ok: true; relPath: string; level: LvlFile; base64: string; bytes: number } | { ok: false; error: string };

/** Decode one level of the mod. */
export function readLevel(modName: string, relPath: string): ReadLevelResult {
  if (!isLevelPath(relPath)) return { ok: false, error: `${PATH_RULE}; got ${JSON.stringify(relPath)}` };
  let abs: string;
  try { abs = resolveModWritePath(modName, relPath); } catch (e) { return { ok: false, error: String(e instanceof Error ? e.message : e) }; }
  if (!existsSync(abs)) return { ok: false, error: `level not found: mods/${modName}/${relPath}` };
  const b = readFileSync(abs);
  try {
    return { ok: true, relPath, level: decodeLvl(b), base64: b.toString("base64"), bytes: b.length };
  } catch (e) {
    return { ok: false, error: `mods/${modName}/${relPath} is not a level file: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export type ValidateLevelResult = Report;

/** The lvl-* rules for a level that may not be saved yet (structural problems are lvl-bad-format errors). */
export function validateLevel(modName: string, relPath: string, level: LvlFile, opts: LevelIoOptions = {}): ValidateLevelResult {
  const file = `mods/${modName}/${relPath}`;
  const errs = structuralErrors(level);
  if (errs.length) {
    const findings: Finding[] = errs.map((m) => ({ severity: "error", code: "lvl-bad-format", message: `${relPath}: ${m}`, location: { file } }));
    return { ok: false, findings, counts: { errors: findings.length, warnings: 0, infos: 0 } };
  }
  return validateLevelBytes(modName, relPath, encodeLvl(level), { extractedData: opts.extractedData });
}

export type WriteLevelResult =
  | { ok: true; path: string; bytes: number; findings: Finding[]; dryRun?: true; base64?: string }
  | { ok: false; error: string; findings?: Finding[] };

/** Encode and write `mods/<mod>/<relPath>` (levels/**.lvl only); returns the lvl findings of what was written. */
export function writeLevel(modName: string, relPath: string, level: LvlFile, opts: LevelIoOptions = {}): WriteLevelResult {
  if (!isLevelPath(relPath)) return { ok: false, error: `${PATH_RULE}; got ${JSON.stringify(relPath)}` };
  try { resolveModWritePath(modName, relPath); } catch (e) { return { ok: false, error: String(e instanceof Error ? e.message : e) }; }
  const errs = structuralErrors(level);
  if (errs.length) return { ok: false, error: `not written: ${errs.join("; ")}` };
  const bytes = encodeLvl(level);
  const findings = validateLevelBytes(modName, relPath, bytes, { extractedData: opts.extractedData }).findings;
  if (opts.dryRun) return { ok: true, dryRun: true, path: `mods/${modName}/${relPath}`, bytes: bytes.length, base64: Buffer.from(bytes).toString("base64"), findings };
  const r = writeModBinary(modName, relPath, bytes);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, path: r.path, bytes: r.bytes, findings };
}

// ---- edit ops (MCP write_level): change a level without sending all 100 cells ----

export interface LevelEditChoice {
  id?: number;
  object?: string;
  weight?: number;
}
export interface LevelEdit {
  op: "tile" | "object" | "remove";
  x: number;
  y: number;
  id?: number;
  /** a spawns.gon `object` / `utility` name (base or this mod), e.g. Rat, PlayerSpawn */
  object?: string;
  random?: LevelEditChoice[];
}

export interface WriteLevelSource extends LevelIoOptions {
  /** the whole level (as read_level returns it) */
  level?: LvlFile;
  /** or the file bytes */
  base64?: string;
  /** applied in order to `level` / `base64` / the file on disk / an empty 10x10 room */
  edits?: LevelEdit[];
}

/** Resolve the starting level, apply the edit ops, then writeLevel. */
export function writeLevelFrom(modName: string, relPath: string, src: WriteLevelSource): WriteLevelResult {
  if (!isLevelPath(relPath)) return { ok: false, error: `${PATH_RULE}; got ${JSON.stringify(relPath)}` };
  let level: LvlFile;
  try {
    if (src.level) level = src.level;
    else if (src.base64 !== undefined) level = decodeLvl(Buffer.from(src.base64, "base64"));
    else {
      const cur = readLevel(modName, relPath);
      if (cur.ok) level = cur.level;
      else if (/not found/.test(cur.error)) level = buildRoom({ objects: [] });
      else return cur;
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (src.edits?.length) {
    const names = spawnIdsByName(src.extractedData ?? EXTRACTED_DATA, modName);
    const one = (c: { id?: number; object?: string }, what: string): number => {
      if (c.object !== undefined) {
        const id = names.get(c.object);
        if (id === undefined) throw new Error(`${what}: no data/spawns.gon entry has \`object ${c.object}\` or \`utility ${c.object}\` (base or this mod)`);
        return id;
      }
      if (c.id === undefined) throw new Error(`${what}: give id, object or random`);
      return c.id;
    };
    try {
      src.edits.forEach((e, i) => {
        const what = `edits[${i}] (${e.op} at ${e.x},${e.y})`;
        if (e.op === "remove") { level = removeObjects(level, e.x, e.y); return; }
        const pick: LvlPick = e.random ? e.random.map((c, j) => ({ id: one(c, `${what}.random[${j}]`), weight: c.weight ?? 1 })) : one(e, what);
        if (e.x < 0 || e.y < 0 || e.x >= level.width || e.y >= level.height) throw new Error(`${what}: outside the ${level.width}x${level.height} grid`);
        level = e.op === "tile" ? paintTiles(level, [{ x: e.x, y: e.y }], pick) : placeObject(level, e.x, e.y, pick);
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return writeLevel(modName, relPath, level, src);
}

// ---- palette ----

export interface PaletteEntry {
  id: number;
  /** the dev editor's label (editor.name), else the class name */
  name: string;
  kind: "empty" | "tile" | "object" | "utility" | "other";
  /** the tile / object / utility class (a weighted tile list joined as "A 80 · B 15") */
  cls: string;
  classes: Array<{ name: string; weight: number }>;
  /** CSS colour from editor.image_tint, or null */
  color: string | null;
  letter: string;
  /** editor.category (spawns.gon groups: 1 player spawns, 3 basic enemies, 105 pickups, …) */
  category: number | null;
  /** where the entry (or its last change) comes from */
  source: "base" | "mod";
}

export interface LevelPalette {
  ok: true;
  /** base tiles.gon / spawns.gon were found */
  hasBase: boolean;
  tiles: PaletteEntry[];
  objects: PaletteEntry[];
}

function plain(v: VNode): unknown {
  if (v.t === "str") return v.type === "number" && v.num !== null ? v.num : v.raw;
  if (v.t === "arr") return v.items.map(plain);
  const o: Record<string, unknown> = {};
  for (const e of v.entries) o[e.key] = plain(e.value);
  return o;
}

function readEntries(abs: string): Array<{ id: number; value: Record<string, unknown> }> {
  if (!existsSync(abs)) return [];
  let root: VNode;
  try { root = toValue(parse(readFileSync(abs, "utf8"))); } catch { return []; }
  if (root.t !== "obj") return [];
  const out: Array<{ id: number; value: Record<string, unknown> }> = [];
  for (const e of root.entries) {
    const name = parsePolicy(e.key).name;
    if (!/^\d+$/.test(name) || e.value.t !== "obj") continue;
    const value: Record<string, unknown> = {};
    for (const f of e.value.entries) value[parsePolicy(f.key).name] = plain(f.value);
    out.push({ id: Number(name), value });
  }
  return out;
}

function paletteOf(pack: string, modName: string, dataRoot: string, classKeys: string[], byCategory: boolean): { entries: PaletteEntry[]; hasBase: boolean } {
  const modDir = join(MODS_DIR, modName);
  const leaf = pack.slice("data/".length);
  const whole = join(modDir, "data", leaf);
  const baseAbs = packPath(pack, dataRoot);
  const merged = new Map<number, { value: Record<string, unknown>; source: "base" | "mod" }>();
  const first = existsSync(whole) ? { abs: whole, source: "mod" as const } : { abs: baseAbs, source: "base" as const };
  for (const e of readEntries(first.abs)) merged.set(e.id, { value: e.value, source: first.source });
  for (const suffix of [".append", ".merge", ".patch"]) {
    for (const e of readEntries(join(modDir, "data", leaf + suffix))) {
      const prev = merged.get(e.id);
      if (!prev) { merged.set(e.id, { value: e.value, source: "mod" }); continue; }
      const editor = { ...(prev.value.editor as Record<string, unknown> | undefined), ...(e.value.editor as Record<string, unknown> | undefined) };
      merged.set(e.id, { value: { ...prev.value, ...e.value, editor }, source: "mod" });
    }
  }
  const entries: PaletteEntry[] = [...merged.entries()].sort((a, b) => a[0] - b[0]).map(([id, { value, source }]) => {
    const editor = (value.editor && typeof value.editor === "object" ? value.editor : {}) as Record<string, unknown>;
    const key = classKeys.find((k) => value[k] !== undefined);
    const raw = key ? value[key] : undefined;
    let classes: Array<{ name: string; weight: number }> = [];
    if (typeof raw === "string") classes = [{ name: raw, weight: 1 }];
    else if (raw && typeof raw === "object" && !Array.isArray(raw)) classes = Object.entries(raw as Record<string, unknown>).map(([name, w]) => ({ name, weight: typeof w === "number" ? w : 1 }));
    const cls = classes.length === 1 && typeof raw === "string" ? classes[0]!.name : classes.map((c) => `${c.name} ${c.weight}`).join(" · ");
    const name = typeof editor.name === "string" && editor.name ? editor.name : cls || `#${id}`;
    const kind: PaletteEntry["kind"] = id === 0 ? "empty" : key === "utility" ? "utility" : key === "object" ? "object" : key === "tile" ? "tile" : "other";
    const category = typeof editor.category === "number" ? editor.category : null;
    const color = swatchColor(editor.image_tint) ?? (byCategory ? categoryColor(category) : null);
    return { id, name, kind, cls, classes, color, letter: id === 0 ? "" : paletteLetter(name), category, source };
  });
  return { entries, hasBase: existsSync(baseAbs) };
}

/** The tile and object palettes a level of this mod can use (base + the mod's overlays). */
export function levelPalette(modName: string, opts: LevelIoOptions = {}): LevelPalette {
  const dataRoot = opts.extractedData ?? EXTRACTED_DATA;
  const t = paletteOf("data/tiles.gon", modName, dataRoot, ["tile"], false);
  const o = paletteOf("data/spawns.gon", modName, dataRoot, ["utility", "object"], true);
  return { ok: true, hasBase: t.hasBase && o.hasBase, tiles: t.entries, objects: o.entries };
}
