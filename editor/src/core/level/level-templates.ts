// new_from_template kinds for maps/rooms (docs/data-mods.md "Maps, rooms and encounters"):
//   room            → a NEW level file mods/<mod>/levels/<folder>/<name>.lvl (binary, src/core/level/lvl.ts). The game
//                     reads any "levels/<path>.lvl" through the file manager (pack + every -modpaths dir), so the
//                     console's `load <folder>/<name>` plays it (OBSERVED 2026-10-22, mods/_roomprobe) and a map's
//                     level pools list mod files too (FileManager_ListDir 0x9a1900 walks the mod paths).
//   tileset-variant → a copy of a vanilla tileset object under a NEW name in data/tilesets.gon.append, selectable with
//                     the console's `tileset <name>` (OBSERVED 2026-10-22) or a map's `tileset <name>`.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { EXTRACTED_DATA, MODS_DIR, packPath } from "../repo.ts";
import { parse } from "../gon/parser.ts";
import { toValue, pretty, findIndex } from "../gon/value.ts";
import { parsePolicy } from "../overlay/policy.ts";
import { buildRoom, encodeLvl } from "./lvl.ts";
import type { LvlPick } from "./lvl.ts";
import type { VNode, VObject } from "../gon/types.ts";

export interface LevelTemplateOptions {
  folder?: string;
  width?: number | string;
  height?: number | string;
  objects?: unknown;
  tiles?: unknown;
  parent?: string;
  extractedData?: string;
  dryRun?: boolean;
}

export interface LevelPlanFile {
  relPath: string;
  content: string;
  /** binary files (a .lvl): the bytes; `content` is then a short human-readable summary */
  base64?: string;
}

export type LevelTemplatePlan = { ok: true; files: LevelPlanFile[]; hint: string } | { ok: false; error: string };

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

/** Read a GON file's top-level object (base copy and/or the mod's overlays), or null. */
function readRoot(abs: string): VObject | null {
  if (!existsSync(abs)) return null;
  try {
    const v = toValue(parse(readFileSync(abs, "utf8")));
    return v.t === "obj" ? v : null;
  } catch {
    return null;
  }
}

/** spawns.gon: `object <Name>` / `utility <Name>` → numeric id (the first id wins), from the base and this mod. */
export function spawnIdsByName(dataRoot: string, modName: string): Map<string, number> {
  const out = new Map<string, number>();
  const files = [packPath("data/spawns.gon", dataRoot), ...["", ".append", ".merge", ".patch"].map((s) => join(MODS_DIR, modName, "data", `spawns.gon${s}`))];
  for (const abs of files) {
    const root = readRoot(abs);
    if (!root) continue;
    for (const e of root.entries) {
      const id = parsePolicy(e.key).name;
      if (!/^\d+$/.test(id) || e.value.t !== "obj") continue;
      for (const f of e.value.entries) {
        if ((f.key === "object" || f.key === "utility") && f.value.t === "str" && !out.has(f.value.raw)) out.set(f.value.raw, Number(id));
      }
    }
  }
  return out;
}

function int(v: unknown, what: string): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n)) throw new Error(`${what} must be an integer, got ${JSON.stringify(v)}`);
  return n;
}

/** One placed pick: `{ x, y, id }`, `{ x, y, object: "Rat" }` or `{ x, y, random: [{ id|object, weight }] }`. */
function pickOf(o: Record<string, unknown>, names: Map<string, number>, what: string): LvlPick {
  const one = (r: Record<string, unknown>): number => {
    if (r.object !== undefined) {
      const id = names.get(String(r.object));
      if (id === undefined) throw new Error(`${what}: no data/spawns.gon entry has \`object ${String(r.object)}\` (base or this mod's spawns.gon overlay); add one with a data/spawns.gon.append entry or pass a numeric id`);
      return id;
    }
    return int(r.id, `${what}.id`);
  };
  if (Array.isArray(o.random)) return o.random.map((c, i) => ({ id: one(c as Record<string, unknown>), weight: int((c as Record<string, unknown>).weight ?? 1, `${what}.random[${i}].weight`) }));
  return one(o);
}

/** Plan a new room: mods/<mod>/levels/<folder>/<name>.lvl. */
export function planRoom(modName: string, name: string, o: LevelTemplateOptions): LevelTemplatePlan {
  const folder = o.folder ?? "custom";
  if (!SEGMENT.test(name)) return { ok: false, error: `invalid room name ${JSON.stringify(name)}: letters, digits, "_" and "-" only (it becomes levels/<folder>/<name>.lvl)` };
  const segs = folder.split("/");
  if (!segs.every((s) => SEGMENT.test(s))) return { ok: false, error: `invalid folder ${JSON.stringify(folder)}: "/"-separated names of letters, digits, "_" and "-"` };
  const dataRoot = o.extractedData ?? EXTRACTED_DATA;
  const names = spawnIdsByName(dataRoot, modName);
  try {
    const width = o.width === undefined ? 10 : int(o.width, "width");
    const height = o.height === undefined ? 10 : int(o.height, "height");
    let objects: Array<{ x: number; y: number; id: LvlPick }>;
    if (o.objects === undefined) {
      const spawn = names.get("PlayerSpawn") ?? 1;
      const rat = names.get("Rat") ?? 11;
      objects = [
        { x: 1, y: 0, id: spawn }, { x: 3, y: 0, id: spawn }, { x: 5, y: 0, id: spawn }, { x: 7, y: 0, id: spawn },
        { x: 3, y: height - 2, id: rat }, { x: 6, y: height - 2, id: rat },
      ];
    } else {
      if (!Array.isArray(o.objects)) return { ok: false, error: "options.objects must be an array of { x, y, id | object | random }" };
      objects = o.objects.map((r, i) => {
        const rec = r as Record<string, unknown>;
        return { x: int(rec.x, `objects[${i}].x`), y: int(rec.y, `objects[${i}].y`), id: pickOf(rec, names, `objects[${i}]`) };
      });
    }
    const tilesIn = o.tiles === undefined ? [] : o.tiles;
    if (!Array.isArray(tilesIn)) return { ok: false, error: "options.tiles must be an array of { x, y, id | random }" };
    const tiles = tilesIn.map((r, i) => {
      const rec = r as Record<string, unknown>;
      const id: LvlPick = Array.isArray(rec.random)
        ? rec.random.map((c, j) => ({ id: int((c as Record<string, unknown>).id, `tiles[${i}].random[${j}].id`), weight: int((c as Record<string, unknown>).weight ?? 1, `tiles[${i}].random[${j}].weight`) }))
        : int(rec.id, `tiles[${i}].id`);
      return { x: int(rec.x, `tiles[${i}].x`), y: int(rec.y, `tiles[${i}].y`), id };
    });
    const lvl = buildRoom({ width, height, objects, tiles });
    const bytes = encodeLvl(lvl);
    const rel = `levels/${folder}/${name}.lvl`;
    const summary = `level ${rel}: ${width}x${height}, ${objects.length} object(s), ${tiles.length} painted tile(s), ${bytes.length} bytes`;
    return {
      ok: true,
      files: [{ relPath: rel, content: summary, base64: Buffer.from(bytes).toString("base64") }],
      hint: `play it in a test fight: \`enter TacticsTest\`, then the console command \`load ${folder}/${name}\` (mewtest: \`cmd load ${folder}/${name}\`). A map's run picks it once the folder is one of its level pools (levels { folder <map> easy [<subfolder> …] } lists levels/<map>/<subfolder>/*.lvl, mod files included).`,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Plan a tileset variant: `<name> { …copy of <parent>… }` appended to mods/<mod>/data/tilesets.gon.append. */
export function planTilesetVariant(modName: string, name: string, o: LevelTemplateOptions): LevelTemplatePlan {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { ok: false, error: `invalid tileset name ${JSON.stringify(name)} (letters, digits, underscore; not starting with a digit)` };
  const parent = o.parent ?? "alley";
  const dataRoot = o.extractedData ?? EXTRACTED_DATA;
  const base = readRoot(packPath("data/tilesets.gon", dataRoot));
  if (!base) return { ok: false, error: `data/tilesets.gon not found under ${dataRoot} (extract the base data first)` };
  if (findIndex(base, name) >= 0) return { ok: false, error: `tileset "${name}" already exists in the base tilesets.gon: pick a new name (to change a vanilla tileset use a data/tilesets.gon.merge)` };
  const pi = findIndex(base, parent);
  const pv: VNode | undefined = pi >= 0 ? base.entries[pi]!.value : undefined;
  if (!pv || pv.t !== "obj") return { ok: false, error: `no tileset "${parent}" in the base tilesets.gon to copy (vanilla: ${base.entries.filter((e) => e.value.t === "obj").map((e) => e.key).join(", ")})` };
  const rel = "data/tilesets.gon.append";
  const abs = join(MODS_DIR, modName, rel);
  const prevRoot = readRoot(abs);
  if (prevRoot && findIndex(prevRoot, name) >= 0) return { ok: false, error: `tileset "${name}" already exists in mods/${modName}/${rel}` };
  const entry = `// tileset ${name}: a copy of vanilla "${parent}" — change the slots (combat_background, static_*, debris, global_objects, …)\n${name} ${pretty(pv, "")}\n`;
  const prev = existsSync(abs) ? readFileSync(abs, "utf8").replace(/\s*$/, "") + "\n\n" : "// tilesets added by the mewgenics mod editor (.append overlay)\n";
  return {
    ok: true,
    files: [{ relPath: rel, content: prev + entry }],
    hint: `select it in a test fight with the console command \`tileset ${name}\` then \`load <level>\` (mewtest: \`cmd tileset ${name}\`), or point a map at it with \`tileset ${name}\` in data/maps/<map>.gon.merge`,
  };
}
