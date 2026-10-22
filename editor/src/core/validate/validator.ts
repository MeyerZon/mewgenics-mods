// The mod validator. Runs four classes of checks over a mod's overlay files:
//   1. Reference integrity   - status/ability/passive/item/component/character
//      names resolve against base data or a native-registered name.
//   2. Localization completeness - referenced KEYWORD_*/ABILITY_* keys exist in
//      combined.csv with all 12 columns (error on missing key, warn on missing
//      translation). Keys the mod itself adds via combined.csv overlays count.
//   3. Overlay-target existence - .merge/.patch target existing paths; .append
//      adds non-colliding keys; positional CSV .merge is flagged fragile.
//   4. (Merge preview is provided separately by preview-merge.ts.)
//
// Findings are returned as a tagged Report (ok/warning/error with location).

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT, MODS_DIR, EXTRACTED_DATA, packPath } from "../repo.ts";
import { COMPONENT_CACHE_HINT } from "../components.ts";
import { parse, GonParseError } from "../gon/parser.ts";
import { preprocessFile, locateInclude, includeDir } from "../gon-includes.ts";
import { toValue } from "../gon/value.ts";
import { parseOverlayName } from "../overlay/overlay.ts";
import { parseCsv } from "../overlay/csv.ts";
import { parsePolicy } from "../overlay/policy.ts";
import { findIndex } from "../gon/value.ts";
import { resolutionSets } from "../names.ts";
import { loadLocalization, LOC_COLUMNS } from "../base-data.ts";
import { ReportBuilder } from "./result.ts";
import { identifyExe } from "../bindings/check.ts";
import { listManifests } from "../bindings/manifest.ts";
import { locateGameDir } from "../ingame/launch.ts";
import type { VObject, VNode } from "../gon/types.ts";
import type { Report, SourceLocation } from "./result.ts";
import type { OverlayMode, FileType } from "../overlay/overlay.ts";
import type { ResolutionSets } from "../names.ts";
import type { LocTable } from "../base-data.ts";
import { decodeLvl, lvlIds } from "../level/lvl.ts";

const LOC_FIELDS = new Set([
  "name", "desc", "description", "tooltip", "tooltip_stackless",
  "tooltip_stacks_pos", "tooltip_stacks_neg", "tooltip_stackless_pos",
  "tooltip_stackless_neg", "name_stacks_pos", "name_stacks_neg",
]);
const LOC_KEY_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/**
 * Map a pack-relative base file name to a data category.
 * @param baseName e.g. "data/abilities/fighter_abilities.gon"
 */
function categoryForPath(baseName: string): string | null {
  const p = baseName.replace(/\\/g, "/");
  if (p === "data/keyword_tooltips.gon") return "statuses";
  if (p === "data/difficulties.gon") return "difficulties";
  if (p.startsWith("data/abilities/")) return "abilities";
  if (p.startsWith("data/ability_templates/")) return "ability_templates";
  if (p.startsWith("data/passives/")) return "passives";
  if (p.startsWith("data/items/")) return "items";
  if (p.startsWith("data/characters/")) return "characters";
  if (p.startsWith("data/classes/")) return "classes";
  if (p.startsWith("data/text/")) return "text";
  return null;
}

export interface OverlayFile {
  /** path relative to the mod folder (posix) */
  relPath: string;
  /** file contents */
  text: string;
  /** base pack path (mode suffix stripped) */
  baseName: string;
  mode: OverlayMode;
  fileType: FileType;
  category: string | null;
}

/** Recursively collect overlay files under a mod folder. */
function listModFiles(modDir: string): Array<{ relPath: string; abs: string }> {
  const out: Array<{ relPath: string; abs: string }> = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (ent.isFile()) out.push({ relPath: relative(modDir, abs).replace(/\\/g, "/"), abs });
    }
  };
  if (existsSync(modDir)) walk(modDir);
  return out;
}

export interface TextOverride {
  relPath?: string;
  text?: string;
}

/**
 * Build the set of overlay files for a mod, applying an optional unsaved text
 * override for one file (and optionally including a not-yet-saved file).
 */
function collectOverlays(modDir: string, override?: TextOverride): OverlayFile[] {
  const files = listModFiles(modDir);
  const texts = new Map<string, string>();
  for (const f of files) {
    if (f.relPath === "description.json") continue;
    try {
      texts.set(f.relPath, readFileSync(f.abs, "utf8"));
    } catch {
      /* ignore unreadable */
    }
  }
  if (override && override.relPath !== undefined && override.text !== undefined) {
    texts.set(override.relPath, override.text);
  }
  const out: OverlayFile[] = [];
  for (const [relPath, text] of texts) {
    const fileName = relPath.split("/").pop() || relPath;
    const { baseName: baseLeaf, mode, fileType } = parseOverlayName(fileName);
    const baseName = relPath.slice(0, relPath.length - fileName.length) + baseLeaf;
    out.push({ relPath, text, baseName, mode, fileType, category: categoryForPath(baseName) });
  }
  return out;
}

interface ModLocalNames {
  statuses: Set<string>;
  byCategory: Map<string, Set<string>>;
  locRows: Map<string, string[]>;
}

/** Gather mod-local names added across overlays (so same-mod references resolve). */
function modLocalNames(overlays: OverlayFile[]): ModLocalNames {
  const statuses = new Set<string>();
  const byCategory = new Map<string, Set<string>>();
  const locRows = new Map<string, string[]>();
  for (const o of overlays) {
    if (o.fileType === "gon") {
      let root: VNode;
      try {
        root = toValue(parse(o.text));
      } catch {
        continue;
      }
      if (root.t !== "obj") continue;
      // Only the `.patch` engine (0x946680) strips a key suffix; `.append` (0x945410) and `.merge` (0x945c30 under
      // the constant MERGE policy) register the key as written, so "NewCat.overwrite" is the name the game sees.
      const names = root.entries.map((e) => (o.mode === "patch" ? parsePolicy(e.key).name : e.key));
      if (o.category === "statuses") for (const n of names) statuses.add(n);
      if (o.category) {
        if (!byCategory.has(o.category)) byCategory.set(o.category, new Set());
        const set = byCategory.get(o.category);
        if (set) for (const n of names) set.add(n);
      }
    } else if (o.category === "text" && o.fileType === "csv") {
      for (const row of parseCsv(o.text)) {
        if (row[0]) locRows.set(row[0], row);
      }
    }
  }
  return { statuses, byCategory, locRows };
}

export interface NativeBuild {
  known: boolean;
  identity?: { timeDateStamp: string; sizeOfImage: string } | null;
  matched?: { steamBuildId: string; name?: string } | null;
}

/**
 * The installed exe's identity against bindings/*.json (header-only, memoized), or null when no
 * exe is installed. A mod that uses a native-registered name only works when this is a known build.
 */
export function installedNativeBuild(env: Record<string, string | undefined> = process.env): NativeBuild | null {
  try {
    const r = identifyExe(join(locateGameDir(env), "Mewgenics.exe"), listManifests().map((m) => m.manifest));
    return r ? { known: r.known, identity: r.identity, matched: r.matched } : null;
  } catch {
    return null;
  }
}

export interface ValidateOptions {
  /** injects the installed-exe identity (tests); undefined = look it up, null = no exe installed */
  nativeBuild?: NativeBuild | null;
  env?: Record<string, string | undefined>;
  /** the mod folder itself (tests/fixtures); default `mods/<modName>` */
  modDir?: string;
  /** the base-data root in the `.extracted/data` layout (tests/fixtures); default EXTRACTED_DATA */
  extractedData?: string;
  /** component class names (tests/fixtures); default the editor/data cache */
  components?: Iterable<string>;
  /** native-registered names (tests/fixtures); default editor/registered-names.json */
  registeredNames?: Iterable<string>;
}

/**
 * Validate one mod. Pass an override to validate unsaved text for one file.
 * `opts.nativeBuild` injects the installed-exe identity (tests); undefined means "look it up",
 * null means "no exe installed". The other options inject the inputs the validator resolves
 * against so a synthetic base and fixture mods can drive it without game data.
 */
export function validateMod(modName: string, override?: TextOverride, opts: ValidateOptions = {}): Report {
  const rb = new ReportBuilder();
  const modDir = opts.modDir ?? join(MODS_DIR, modName);
  if (!existsSync(modDir)) {
    rb.error("mod-missing", `mod folder not found: mods/${modName}`);
    return rb.build();
  }
  const overlays = collectOverlays(modDir, override);
  if (overlays.length === 0) {
    rb.warn("mod-empty", `mods/${modName} has no overlay files`);
  }

  const root = opts.extractedData ?? EXTRACTED_DATA;
  const sets = resolutionSets({
    root,
    components: opts.components ? new Set(opts.components) : undefined,
    registered: opts.registeredNames ? new Set(opts.registeredNames) : undefined,
  });
  const local = modLocalNames(overlays);
  const loc = loadLocalization(root);
  const nativeBuild = opts.nativeBuild !== undefined ? opts.nativeBuild : installedNativeBuild(opts.env);
  if (!sets.componentListKnown) {
    // Without a list every component would be "unknown": say once why they are not checked instead.
    rb.info("component-list-missing", `no component class names are known, so passives / ai brains / classes are not checked: ${COMPONENT_CACHE_HINT}`);
  }

  // Union of localization keys available: base + mod-added.
  const findLocRow = (key: string): string[] | undefined => local.locRows.get(key) || loc.rows.get(key);

  const fragments = includeFragments(overlays, root, modDir);
  let palettes: LvlPalettes | null = null;
  for (const o of overlays) {
    const fileLoc = { file: `mods/${modName}/${o.relPath}` };
    if (/\.lvl$/i.test(o.relPath)) {
      palettes ??= lvlPalettes(overlays, root);
      validateLvl(o, rb, palettes, modName, modDir, root);
    } else if (o.fileType === "gon") {
      validateGonOverlay(o, rb, sets, local, findLocRow, modName, nativeBuild, root, modDir, fragments);
      if (/^data\/maps\/[^/]+\.gon$/.test(o.baseName)) validateMapFile(o, rb, overlays, modName, root, modDir);
    } else if (o.fileType === "csv" || (o.category === "text" && o.fileType === "other")) {
      validateCsvOverlay(o, rb, loc, modName);
    } else if (o.mode === "replace") {
      rb.warn("whole-file-replace", `${o.relPath} replaces the whole base file; prefer .append/.merge/.patch`, fileLoc);
    }
  }
  return rb.build();
}

/** MapNode::str_to_type 0x225680: every other `type` is a fatal "No node type named: <x>" (MapNode.cpp). */
export const MAP_NODE_TYPES = [
  "none", "npc", "enter", "exit", "home", "battle", "hard", "miniboss", "boss", "event", "optional_event",
  "special_event", "shop", "treasure", "furniturebox", "foodbox", "bonus", "empty", "any",
];

/** Top-level keys of a base data file plus this mod's copies/overlays of it (any mode). */
function topKeys(pack: string, overlays: OverlayFile[], dataRoot: string): Set<string> {
  const out = new Set<string>();
  const texts: string[] = [];
  const abs = packPath(pack, dataRoot);
  if (existsSync(abs)) { try { texts.push(readFileSync(abs, "utf8")); } catch { /* unreadable */ } }
  for (const o of overlays) if (o.baseName === pack && o.fileType === "gon") texts.push(o.text);
  for (const t of texts) {
    try {
      const v = toValue(parse(t));
      if (v.t === "obj") for (const e of v.entries) out.add(parsePolicy(e.key).name);
    } catch { /* reported elsewhere */ }
  }
  return out;
}

/** Does any .lvl live directly in levels/<dir>/ (base extracted pack or this mod)? The game lists it non-recursively. */
function hasLevels(dir: string, modDir: string, dataRoot: string): boolean | null {
  const baseDir = packPath(`levels/${dir}`, dataRoot);
  const baseRoot = packPath("levels", dataRoot);
  const any = (d: string): boolean => existsSync(d) && readdirSync(d).some((n) => n.toLowerCase().endsWith(".lvl"));
  if (any(join(modDir, "levels", ...dir.split("/"))) || any(baseDir)) return true;
  return existsSync(baseRoot) ? false : null; // null: no extracted levels/ to check against
}

/**
 * A map file (data/maps/<x>.gon, new or an overlay): node types the game knows (fatal otherwise), next_map targets
 * that exist, a tileset name, a chapter_id from chapter_id_enum and level pools that are not empty. The map is the
 * text the game parses (comments stripped, `#include "standard_nodes.gon"` inlined).
 */
function validateMapFile(o: OverlayFile, rb: ReportBuilder, overlays: OverlayFile[], modName: string, dataRoot: string, modDir: string): void {
  const file = `mods/${modName}/${o.relPath}`;
  let root: VNode;
  try {
    root = toValue(parse(preprocessFile(o.text, { resource: o.baseName, dataRoot, modDir }).text));
  } catch {
    return; // gon-parse-error is reported by validateGonOverlay
  }
  if (root.t !== "obj") return;
  const child = (v: VNode, k: string): VNode | undefined => (v.t === "obj" ? v.entries.find((e) => parsePolicy(e.key).name === k)?.value : undefined);
  const str = (v: VNode | undefined): string | undefined => (v && v.t === "str" ? v.raw : undefined);

  const nodes = child(root, "nodes");
  if (nodes && nodes.t === "obj") {
    const mapFiles = new Set<string>();
    const baseMaps = packPath("data/maps", dataRoot);
    if (existsSync(baseMaps)) for (const n of readdirSync(baseMaps)) mapFiles.add(n.toLowerCase());
    for (const x of overlays) if (/^data\/maps\/[^/]+\.gon$/.test(x.baseName)) mapFiles.add(x.baseName.slice("data/maps/".length).toLowerCase());
    for (const e of nodes.entries) {
      const name = parsePolicy(e.key).name;
      const type = str(child(e.value, "type"));
      if (type !== undefined && !MAP_NODE_TYPES.includes(type)) {
        rb.error("map-node-type-unknown", `node "${name}" has type "${type}": the game knows only ${MAP_NODE_TYPES.join(", ")} (MapNode::str_to_type 0x225680) and stops with a fatal "No node type named: ${type}"`, { file, path: `nodes.${name}.type` });
      }
      const next = str(child(e.value, "next_map"));
      if (next !== undefined && existsSync(baseMaps) && !mapFiles.has(next.toLowerCase())) {
        rb.error("map-next-map-missing", `node "${name}" leads to next_map ${next}, but there is no data/maps/${next} in the base data or this mod (the run loads "data/maps/" + next_map)`, { file, path: `nodes.${name}.next_map` });
      }
    }
  }
  const tileset = str(child(root, "tileset"));
  if (tileset !== undefined && existsSync(packPath("data/tilesets.gon", dataRoot)) && !topKeys("data/tilesets.gon", overlays, dataRoot).has(tileset)) {
    rb.warn("map-tileset-unknown", `tileset "${tileset}" is not a tileset in data/tilesets.gon (base or this mod's tilesets.gon overlay); add it with new_from_template kind tileset-variant`, { file, path: "tileset" });
  }
  const chapter = str(child(root, "chapter_id"));
  if (chapter !== undefined && existsSync(packPath("data/chapter_id_enum.gon", dataRoot))) {
    const ids = new Set<string>();
    for (const text of [readFileSync(packPath("data/chapter_id_enum.gon", dataRoot), "utf8"), ...overlays.filter((x) => x.baseName === "data/chapter_id_enum.gon").map((x) => x.text)]) {
      try {
        const arr = child(toValue(parse(text)), "chapter_id_enum");
        if (arr && arr.t === "arr") for (const it of arr.items) if (it.t === "str") ids.add(it.raw);
      } catch { /* reported elsewhere */ }
    }
    if (!ids.has(chapter)) {
      rb.warn("map-chapter-id-unknown", `chapter_id "${chapter}" is not in data/chapter_id_enum.gon; the list mirrors a C++ enum (MewDirector.h, the file says) that the game indexes by position, so reuse a vanilla chapter_id for a new map`, { file, path: "chapter_id" });
    }
  }
  const levels = child(root, "levels");
  const folder = str(levels ? child(levels, "folder") : undefined);
  if (levels && levels.t === "obj" && folder !== undefined) {
    for (const e of levels.entries) {
      // easy / hard are flat folders of rooms; rare may be empty in vanilla (dimensionx) and boss / miniboss / special are
      // per-boss subfolders chosen through `bosses` / `minibosses`
      if ((e.key !== "easy" && e.key !== "hard") || e.value.t !== "arr") continue;
      for (const it of e.value.items) {
        if (it.t !== "str") continue;
        const has = hasLevels(`${folder}/${it.raw}`, modDir, dataRoot);
        if (has === false) {
          rb.warn("map-level-pool-empty", `levels.${e.key} names levels/${folder}/${it.raw}/, which holds no .lvl in the base data or this mod: that pool is empty (the game lists the folder, mod files included — FileManager_ListDir 0x9a1900)`, { file, path: `levels.${e.key}` });
        }
      }
    }
  }
}

/** The numeric ids of the two palettes every level names (data/spawns.gon objects, data/tiles.gon tiles). */
interface LvlPalettes {
  spawns: Set<number>;
  tiles: Set<number>;
  /** spawn ids whose entry is `utility PlayerSpawn` (vanilla: 1) */
  playerSpawns: Set<number>;
}

/** Top-level numeric ids of a palette file: the base copy plus every overlay this mod ships on it (any mode). */
function lvlPalettes(overlays: OverlayFile[], dataRoot: string): LvlPalettes {
  const read = (pack: string, onEntry: (id: number, v: VNode) => void): void => {
    const texts: string[] = [];
    const abs = packPath(pack, dataRoot);
    if (existsSync(abs)) { try { texts.push(readFileSync(abs, "utf8")); } catch { /* unreadable */ } }
    for (const o of overlays) if (o.baseName === pack && o.fileType === "gon") texts.push(o.text);
    for (const t of texts) {
      let root: VNode;
      try { root = toValue(parse(t)); } catch { continue; }
      if (root.t !== "obj") continue;
      for (const e of root.entries) {
        const name = parsePolicy(e.key).name;
        if (/^\d+$/.test(name)) onEntry(Number(name), e.value);
      }
    }
  };
  const spawns = new Set<number>();
  const tiles = new Set<number>();
  const playerSpawns = new Set<number>();
  read("data/spawns.gon", (id, v) => {
    spawns.add(id);
    if (v.t === "obj" && v.entries.some((e) => e.key === "utility" && e.value.t === "str" && e.value.raw === "PlayerSpawn")) playerSpawns.add(id);
  });
  read("data/tiles.gon", (id) => tiles.add(id));
  return { spawns, tiles, playerSpawns };
}

/**
 * A level file the mod ships (`levels/<path>.lvl`, read by the game as `"levels/" + name + ".lvl"` through the file
 * manager, so a new file is loadable by name — OBSERVED in-game 2026-10-22, mods/_roomprobe). Decodes it
 * (src/core/level/lvl.ts) and checks every object id against data/spawns.gon and every tile id against
 * data/tiles.gon (base + this mod's overlays on them); id 0 is the reserved empty entry.
 */
function validateLvl(o: OverlayFile, rb: ReportBuilder, pal: LvlPalettes, modName: string, modDir: string, dataRoot: string): void {
  const file = `mods/${modName}/${o.relPath}`;
  if (!o.relPath.startsWith("levels/")) {
    rb.warn("lvl-outside-levels", `${o.relPath} is a level file outside levels/: the game reads levels only as "levels/<name>.lvl", so it never sees this one`, { file });
  }
  if (existsSync(packPath(o.relPath, dataRoot))) {
    rb.warn("whole-file-replace", `${o.relPath} replaces the vanilla level of the same path (whole file); give a new room its own name`, { file });
  }
  let bytes: Uint8Array;
  try { bytes = readFileSync(join(modDir, o.relPath)); } catch (e) { rb.error("lvl-bad-format", `cannot read ${o.relPath}: ${String(e)}`, { file }); return; }
  let lvl;
  try { lvl = decodeLvl(bytes); } catch (e) {
    rb.error("lvl-bad-format", `${o.relPath} is not a level file the game can read: ${e instanceof Error ? e.message : String(e)}`, { file });
    return;
  }
  if (lvl.objectPalette !== "spawns.gon" || (lvl.tilePalette !== "" && lvl.tilePalette !== "tiles.gon")) {
    rb.warn("lvl-palette-unusual", `${o.relPath} names palettes "${lvl.objectPalette}" / "${lvl.tilePalette}"; every vanilla level names "spawns.gon" / "tiles.gon"`, { file });
  }
  const ids = lvlIds(lvl);
  const badObjects = ids.objects.filter((id) => id !== 0 && !pal.spawns.has(id));
  if (badObjects.length) {
    rb.error("lvl-unknown-spawn-id", `${o.relPath} places object id(s) ${badObjects.join(", ")}, not defined in data/spawns.gon (base or this mod's spawns.gon overlay): add them with a data/spawns.gon.append entry \`<id> { object <Character> }\``, { file });
  }
  const badTiles = ids.tiles.filter((id) => id !== 0 && !pal.tiles.has(id));
  if (badTiles.length) {
    rb.error("lvl-unknown-tile-id", `${o.relPath} uses tile id(s) ${badTiles.join(", ")}, not defined in data/tiles.gon (base or this mod's tiles.gon overlay)`, { file });
  }
  if (!ids.objects.some((id) => pal.playerSpawns.has(id))) {
    rb.warn("lvl-no-player-spawn", `${o.relPath} has no player spawn (an object whose spawns.gon entry is \`utility PlayerSpawn\`, vanilla id 1): the party has nowhere to stand`, { file });
  }
}

/**
 * Pack paths of the files this mod ships that its own GON files `#include` (found as the mod's copy). Such a file
 * that is not in the base data is an include fragment, read only through the include, not a whole-file replacement.
 */
function includeFragments(overlays: OverlayFile[], dataRoot: string, modDir: string): Set<string> {
  const out = new Set<string>();
  for (const o of overlays) {
    if (o.fileType !== "gon") continue;
    const ctx = { resource: o.baseName, dataRoot, modDir };
    for (const inc of preprocessFile(o.text, ctx).includes) {
      if (!inc.found || inc.cycle) continue;
      const t = locateInclude(ctx, inc.name);
      if (t.source === "mod") out.add(t.packPath);
    }
  }
  return out;
}

/** @param nativeBuild installed-exe identity; null = no exe */
function validateGonOverlay(
  o: OverlayFile,
  rb: ReportBuilder,
  sets: ResolutionSets,
  local: ModLocalNames,
  findLocRow: (key: string) => string[] | undefined,
  modName: string,
  nativeBuild: NativeBuild | null,
  dataRoot: string,
  modDir: string,
  fragments: Set<string> = new Set(),
): void {
  const file = `mods/${modName}/${o.relPath}`;
  const hasComponentList = sets.componentListKnown; // else component-list-missing was reported once
  let root;
  try {
    parse(o.text); // the raw text first: parse errors carry positions in the file as written
    root = semanticParse(o, rb, file, dataRoot, modDir);
  } catch (e) {
    if (e instanceof GonParseError) {
      rb.error("gon-parse-error", e.message, { file, line: e.pos?.line, col: e.pos?.col });
    } else {
      rb.error("gon-parse-error", String(e), { file });
    }
    return;
  }
  const fragment = o.mode === "replace" && fragments.has(o.baseName) && !existsSync(packPath(o.baseName, dataRoot));
  // a NEW data/maps/<x>.gon replaces nothing: the map DB lists data/maps (SpawnDatabase_LoadGonDir 0x7c0cb0 →
  // FileManager_ListDir 0x9a1900, which walks every -modpaths dir too) and a run loads "data/maps/" + next_map
  const newMap = o.mode === "replace" && /^data\/maps\/[^/]+\.gon$/.test(o.baseName) && !existsSync(packPath(o.baseName, dataRoot));
  if (o.mode === "replace" && !fragment && !newMap) {
    rb.warn("whole-file-replace", `${o.relPath} replaces the whole base file; prefer .append/.merge/.patch`, { file });
  }
  if (!root) return;
  const overlay = toValue(root);
  if (overlay.t !== "obj") return;

  // ---- Reference integrity (context-aware walk) ----------------------------
  const statusSet = new Set([...sets.statuses, ...local.statuses]);
  const parentSet =
    o.category === "characters"
      ? new Set([...sets.characters, ...(local.byCategory.get("characters") ?? [])])
      : new Set([...sets.abilities, ...(local.byCategory.get("abilities") ?? [])]);

  const walk = (node: VNode, path: string[]): void => {
    if (node.t === "obj") {
      for (const e of node.entries) handleField(e.key, e.value, path);
    } else if (node.t === "arr") {
      node.items.forEach((it, i) => walk(it, [...path, `[${i}]`]));
    }
  };

  const handleField = (key: string, value: VNode, path: string[]): void => {
    const here = [...path, key];
    const at: SourceLocation = { file, path: here.join(".") };
    if (key === "effects" || key === "temporary_effects") {
      if (value.t === "obj") for (const se of value.entries) checkStatus(se.key, { file, path: [...here, se.key].join(".") });
      return;
    }
    if (key === "passives") {
      if (value.t === "obj") {
        for (const pe of value.entries) {
          if (hasComponentList && !sets.components.has(pe.key)) {
            rb.warn("unknown-component", `unknown component class "${pe.key}" in passives`, { file, path: [...here, pe.key].join(".") });
          }
          if (/Status/.test(pe.key) && pe.value.t === "obj") {
            for (const ss of pe.value.entries) checkStatus(ss.key, { file, path: [...here, pe.key, ss.key].join(".") });
          } else if (pe.value.t === "obj" || pe.value.t === "arr") {
            walk(pe.value, [...here, pe.key]);
          }
        }
      }
      return;
    }
    if (key === "variant_of") {
      if (value.t === "str" && !parentSet.has(value.raw)) {
        rb.error("unknown-parent", `variant_of references "${value.raw}", which is not a known ${o.category === "characters" ? "character" : "ability"} (base or this mod)`, at);
      }
      return;
    }
    if (key === "template") {
      if (value.t === "str" && sets.templates.size > 0 && !sets.templates.has(value.raw)) {
        rb.warn("unknown-template", `template "${value.raw}" is not a known ability template`, at);
      }
      return;
    }
    if (key === "status") {
      if (value.t === "str" && LOC_KEY_RE.test(value.raw) === false && /^[A-Za-z_]/.test(value.raw)) {
        checkStatus(value.raw, at);
      }
      return;
    }
    if (key === "brain") {
      if (value.t === "str" && hasComponentList && !sets.components.has(value.raw)) {
        rb.warn("unknown-component", `ai brain "${value.raw}" is not a known component class`, at);
      }
      return;
    }
    if (key === "class") {
      if (value.t === "str") {
        const inMeta = path[path.length - 1] === "meta";
        if (inMeta) {
          if (sets.classes.size > 0 && !sets.classes.has(value.raw)) {
            rb.warn("unknown-class", `class "${value.raw}" is not a known cat class`, at);
          }
        } else if (hasComponentList && !sets.components.has(value.raw)) {
          rb.warn("unknown-component", `class "${value.raw}" is not a known component`, at);
        } else checkNative(value.raw, at);
      }
      return;
    }
    // localization-bearing fields: a value that looks like an ALL_CAPS key.
    if (LOC_FIELDS.has(key) && value.t === "str" && LOC_KEY_RE.test(value.raw)) {
      checkLoc(value.raw, { file, path: here.join(".") });
    }
    // recurse into structure
    if (value.t === "obj" || value.t === "arr") walk(value, here);
  };

  /** names provided only by native mod code (editor/registered-names.json), warned once per file */
  const nativeWarned = new Set<string>();
  const checkNative = (name: string, at: SourceLocation): void => {
    if (!sets.registered.has(name) || !nativeBuild || nativeBuild.known || nativeWarned.has(name)) return;
    nativeWarned.add(name);
    const id = nativeBuild.identity ? ` (TimeDateStamp ${nativeBuild.identity.timeDateStamp}, SizeOfImage ${nativeBuild.identity.sizeOfImage})` : "";
    rb.warn("native-build-unknown", `"${name}" is provided by native mod code (mewframework), but the installed Mewgenics.exe is not a build the bindings know${id}: the framework will stay inactive and the game will report NO_*_NAMED. Port the bindings first (docs/binding-port.md, check_game_build / port_bindings).`, at);
  };
  const checkStatus = (name: string, at: SourceLocation): void => {
    if (!statusSet.has(name)) {
      rb.error("unknown-status", `status "${name}" is not defined in base data, not native-registered, and not added by this mod`, at);
      return;
    }
    checkNative(name, at);
  };

  const checkLoc = (key: string, at: SourceLocation): void => {
    const row = findLocRow(key);
    if (!row) {
      rb.error("missing-loc-key", `localization key "${key}" not found in combined.csv (base or this mod's .csv overlay)`, at);
      return;
    }
    if (row.length < LOC_COLUMNS.length) {
      rb.warn("incomplete-loc-row", `localization row "${key}" has ${row.length} columns (expected ${LOC_COLUMNS.length})`, at);
      return;
    }
    // Translation columns are indices 3..11 (sp..zh-cn); en is 1, notes is 2.
    const missing: string[] = [];
    for (let i = 3; i < LOC_COLUMNS.length; i++) {
      const cell = row[i];
      if (!cell || cell.trim() === "") missing.push(LOC_COLUMNS[i]!);
    }
    if (missing.length > 0) {
      rb.warn("missing-translation", `localization key "${key}" is missing translations: ${missing.join(", ")}`, at);
    }
  };

  for (const e of overlay.entries) handleField(e.key, e.value, []);

  // ---- Literal suffixes outside .patch ------------------------------------------
  // Only the `.patch` engine (0x946680) reads key suffixes. A `.merge` file runs Gon_DeepMerge_plain 0x945c30 under
  // the constant MERGE policy (Gon_DefaultMergeMode 0x9451c0 returns 2) and `.append` runs Gon_Append 0x945410: in
  // both, `faction.overwrite` is a child literally named "faction.overwrite", at any depth. Almost always a mistake.
  if (o.mode === "merge" || o.mode === "append") {
    const walkSuffixes = (node: VNode, path: string[]): void => {
      if (node.t === "obj") {
        for (const e of node.entries) {
          const here = [...path, e.key];
          if (parsePolicy(e.key).policy !== "default") {
            rb.warn("merge-suffix-literal", `.${o.mode} files do not interpret key suffixes: "${here.join(".")}" is a literal child name, not a .${parsePolicy(e.key).policy} policy — use a .patch file for per-field policies, or drop the suffix`, { file, path: here.join(".") });
          }
          walkSuffixes(e.value, here);
        }
      } else if (node.t === "arr") {
        node.items.forEach((it, i) => walkSuffixes(it, [...path, `[${i}]`]));
      }
    };
    walkSuffixes(overlay, []);
  }

  // ---- Overlay-target existence --------------------------------------------
  const baseAbs = packPath(o.baseName, dataRoot);
  const baseExists = existsSync(baseAbs);
  if ((o.mode === "merge" || o.mode === "patch") && !baseExists) {
    rb.warn("base-missing", `${o.relPath} is a ${o.mode} overlay but base file ${o.baseName} was not found in the extracted base data (cannot verify targets)`, { file });
  }
  if (baseExists && (o.mode === "merge" || o.mode === "patch" || o.mode === "append")) {
    let baseRoot: VNode | null;
    try {
      baseRoot = toValue(parse(preprocessFile(readFileSync(baseAbs, "utf8"), { resource: o.baseName, dataRoot, modDir }).text));
    } catch {
      baseRoot = null;
    }
    if (baseRoot && baseRoot.t === "obj") {
      if (o.mode === "append") {
        for (const e of overlay.entries) {
          if (findIndex(baseRoot, e.key) >= 0) {
            rb.warn("append-collision", `.append adds "${e.key}" but the base file already has it; .append duplicates rather than changing it (use .merge/.patch to change)`, { file, path: e.key });
          }
        }
      } else if (o.mode === "merge") {
        checkMergeTargets(overlay, baseRoot, [], rb, file);
      } else {
        checkPatchTargets(overlay, baseRoot, [], rb, file);
      }
    }
  }
}

/**
 * The GON the game actually parses for an overlay: the text after its pre-pass (Gon_Preprocess 0xa50bd0: comments
 * stripped, `#include` inlined against the base resource's directory with this mod's files taking part). Reports
 * includes that resolve nowhere (`include-missing`: the game shows an error box "Could not locate include file" and
 * exits), names that are not literal pack paths (`include-path-unsafe`: `..`, `./`, a leading `/`, a drive letter or a
 * backslash; the game never normalises them), a `/*` that is never closed (`comment-unclosed`: the game drops the
 * rest of the file) and a macro still expanding after the game's 256 rounds (`gon-macro-runaway`). `#define`
 * macros are expanded exactly as the game does (Gon_Pre_CollectDefines 0xa4f4a0 / Gon_Pre_ExpandMacros 0xa501c0).
 * @returns the parsed root, or null after a `gon-parse-error` the pre-pass introduced
 */
function semanticParse(o: OverlayFile, rb: ReportBuilder, file: string, dataRoot: string, modDir: string) {
  const ctx = { resource: o.baseName, dataRoot, modDir };
  const pre = preprocessFile(o.text, ctx);
  for (const inc of pre.includes) {
    if (inc.found) continue;
    const t = locateInclude(ctx, inc.name);
    const via = inc.chain.length ? ` (inside ${inc.chain.map((c) => `"${c}"`).join(" > ")})` : "";
    const why = t.outside
      ? `resolves to ${t.packPath}, outside data/: the editor does not read it and the game would not find it in the pack`
      : `resolves to ${t.packPath}, which exists neither in this mod nor in the base data: when the game loads this file it shows an error message box "Could not locate include file: ${inc.name}" and exits`;
    const at = inc.depth === 0 ? { file, line: inc.line, col: inc.col } : { file };
    if (t.unsafe) {
      rb.error("include-path-unsafe", `#include "${inc.name}"${via} is not a literal pack path: the game joins it to ${includeDir(o.baseName)} without normalising "..", "./", a leading "/", a drive letter or a backslash, so it never matches a file in the pack (the game then shows "Could not locate include file" and exits) and a loose mod file is looked up by the OS, which may leave the mod folder. Write the path relative to ${includeDir(o.baseName)} with plain "/"-separated names (the editor does not read it)`, at);
      continue;
    }
    rb.error("include-missing", `#include "${inc.name}"${via} ${why}`, at);
  }
  if (pre.unclosedComment) {
    rb.warn("comment-unclosed", `a /* block comment is never closed: the game silently drops everything after it to the end of the file (add the missing */)`, { file, line: pre.unclosedComment.line, col: pre.unclosedComment.col });
  }
  if (pre.macroRunaway) {
    rb.warn("gon-macro-runaway", `${o.relPath}: a #define macro (${pre.defines.join(", ")}) still expands after the game's 256 expansion rounds (it uses itself): the game stops there and parses what is left, with the remaining #NAME read as a # comment`, { file });
  }
  try {
    return parse(pre.text);
  } catch (e) {
    rb.error("gon-parse-error", `after the game's comment/#include pre-pass: ${e instanceof Error ? e.message : String(e)}`, { file });
    return null;
  }
}

/**
 * Warn about merge fields whose target does not exist in the base (merge would
 * silently add them, which usually indicates a value-change mistake).
 */
function checkMergeTargets(overlay: VObject, base: VObject, path: string[], rb: ReportBuilder, file: string): void {
  for (const e of overlay.entries) {
    const i = findIndex(base, e.key);
    const here = [...path, e.key];
    if (i < 0) {
      rb.warn("merge-target-missing", `.merge target "${here.join(".")}" does not exist in the base file; it will be ADDED, not changed`, { file, path: here.join(".") });
    } else {
      const bv = base.entries[i]!.value;
      if (e.value.t === "obj" && bv.t === "obj") checkMergeTargets(e.value, bv, here, rb, file);
    }
  }
}

/** Warn about patch policies whose target does not exist. */
function checkPatchTargets(overlay: VObject, base: VObject, path: string[], rb: ReportBuilder, file: string): void {
  for (const e of overlay.entries) {
    const { name, policy } = parsePolicy(e.key);
    const here = [...path, name];
    const i = findIndex(base, name);
    if (i < 0) {
      if (policy === "add" || policy === "multiply" || policy === "merge") {
        rb.warn("patch-target-missing", `.${policy} target "${here.join(".")}" does not exist in the base file; the policy has nothing to act on`, { file, path: here.join(".") });
      }
      continue;
    }
    const bv = base.entries[i]!.value;
    if ((policy === "default" || policy === "merge") && e.value.t === "obj" && bv.t === "obj") {
      checkPatchTargets(e.value, bv, here, rb, file);
    }
    if ((policy === "add" || policy === "multiply") && (e.value.t !== "str" || e.value.num === null)) {
      rb.warn("patch-nonnumeric", `.${policy} on "${here.join(".")}" but the value is not a number`, { file, path: here.join(".") });
    }
  }
}

function validateCsvOverlay(o: OverlayFile, rb: ReportBuilder, loc: LocTable, modName: string): void {
  const file = `mods/${modName}/${o.relPath}`;
  const rows = parseCsv(o.text);
  if (o.mode === "merge" || o.mode === "patch") {
    rb.warn("csv-positional-merge-fragile", `${o.relPath} is a positional CSV ${o.mode}; it matches by ROW INDEX and breaks when the base game adds rows. Prefer .append with new keys.`, { file });
  }
  if (o.mode === "replace") {
    rb.warn("whole-file-replace", `${o.relPath} replaces the whole localization file; prefer .append`, { file });
  }
  const expected = loc.columns || LOC_COLUMNS.length;
  rows.forEach((row, idx) => {
    if (row.length === 1 && row[0] === "") return; // blank line
    if (o.mode === "append" && row.length !== expected) {
      rb.warn("csv-column-count", `row ${idx + 1} (key "${row[0]}") has ${row.length} columns; expected ${expected}`, { file, line: idx + 1 });
    }
  });
}

export function repoRelative(p: string): string {
  return relative(REPO_ROOT, p).replace(/\\/g, "/");
}
