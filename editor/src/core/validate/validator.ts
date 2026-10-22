// The mod validator. Runs four classes of checks over a mod's overlay files:
//   1. Reference integrity   - status/ability/passive/item/component/character
//      names resolve against base data or a native-registered name.
//   2. Localization completeness - referenced KEYWORD_*/ABILITY_* keys exist in
//      combined.csv with all 12 columns (error on missing key, warn on missing
//      translation). Keys the mod itself adds via combined.csv overlays count.
//   3. Overlay-target existence - .merge/.patch target existing paths; .append
//      adds non-colliding keys; positional CSV .merge is flagged fragile.
//   4. (Merge preview is provided separately by preview-merge.ts.)
//   5. Component keys - a key under a component block that the component never
//      reads (unknown-key, warning) or a required key missing from a new block
//      (missing-required-key, error), per editor/component-schema.json.
//   6. Mod-shipped shaders (shaders/*.shader) - the game's .shader dialect (shader/dialect.ts): #version first,
//      the vert()/frag() entry points and COMPILING_* guards, #includes that resolve, uniforms native code sets.
//   7. The 3D data seam: a character's graphics.model is a mod file models/<...>.obj (model-path-invalid,
//      model-file-missing) or a native-registered "@Name" (model-unregistered); files under models/ are assets,
//      not overlays (model3d.ts, docs/data-mods.md "3D models in a mod (preview)"). A model file that exists is read
//      by model-check.ts and its loader codes (model-codes.ts = the DLL's FW_MESH_CODES) reported at the same key.
//
// Findings are returned as a tagged Report (ok/warning/error with location).

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT, MODS_DIR, EXTRACTED_DATA, DATA_CACHE_DIR, packPath, vanillaSwfDir } from "../repo.ts";
import { appendsOfSwf, appendsOfScene, crossModAppendFindings, vanillaAppendLabels, type ModAppends, type ModAppendFile } from "../art/append-conflicts.ts";
import type { Scene } from "../art/scene.ts";
import { COMPONENT_CACHE_HINT } from "../components.ts";
import { loadComponentSchema, resolveComponent, checkComponentBlock, forEachComponentBlock } from "../component-schema.ts";
import type { ComponentSchema } from "../component-schema.ts";
import { parse, GonParseError } from "../gon/parser.ts";
import { preprocessFile, locateInclude, includeDir } from "../gon-includes.ts";
import { toValue } from "../gon/value.ts";
import { parseOverlayName } from "../overlay/overlay.ts";
import { parseCsv } from "../overlay/csv.ts";
import { parsePolicy } from "../overlay/policy.ts";
import { findIndex } from "../gon/value.ts";
import { resolutionSets, matchRegisteredPattern, malformedRegisteredPattern, catRigPrefix } from "../names.ts";
import { MODEL_KEY, MODEL_PARENT, modelPathProblem, isRegisteredModelRef } from "../model3d.ts";
import { checkModelBytes } from "../model-check.ts";
import { modelCodeInfo } from "../model-codes.ts";
import { MODEL_REGISTRY_FILE, MODEL_REGISTRY_BASE_MOD, baseRegistryNames } from "../model-registry.ts";
import { loadLocalization, LOC_COLUMNS } from "../base-data.ts";
import { ReportBuilder, finding } from "./result.ts";
import { validateScene } from "../art/scene.ts";
import type { LocKeySource } from "../art/text.ts";
import { isParticleKey, PARTICLE_DEAD_KEYS, isNoneName, PARTICLE_REF_KEYS, ABILITY_CLIP_KEYS, NON_CLIP_PROJECTILE_VALUES } from "../particles.ts";
import { vanillaClipNames, modClipNames } from "../art/swf-exports.ts";
import { AUDIO_FILE_RE, makeAudioContext, validateAudioFiles, checkAudioField, MUSIC_INFO } from "./audio.ts";
import type { AudioContext, ModAudioFile } from "./audio.ts";
import { loadAudioIndex, isSoundSetPath } from "../audio/sound-sets.ts";
import type { AudioIndex } from "../audio/sound-sets.ts";
import { identifyExe } from "../bindings/check.ts";
import { listManifests } from "../bindings/manifest.ts";
import { locateGameDir } from "../ingame/launch.ts";
import { MOD_MANIFEST_FILE, readModManifest, compareBuild, describeMismatch } from "../mod-manifest.ts";
import { checkShaderSource, includesOf, EXPECTED_UNIFORMS } from "../shader/dialect.ts";
import type { VObject, VNode } from "../gon/types.ts";
import type { Report, SourceLocation } from "./result.ts";
import type { OverlayMode, FileType } from "../overlay/overlay.ts";
import type { ResolutionSets, RegisteredName } from "../names.ts";
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
  if (p === "data/particles.gon" || p === "data/particles2d.gon") return "particles";
  if (p === MODEL_REGISTRY_FILE) return "models";   // named models (M3 "@Name"); not a pack file: mods/fw-3d ships the base
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

/**
 * Mod folders that hold files the game never loads: `tests/` (the harness's .mewtest scripts) and `art/` (the
 * editor's scene sources; their built SWFs go under `swfs/`). The pack has no such root (its roots are audio, data,
 * levels, shaders, swfs, textures and two loose files), so these are never overlays; neither is a dotfile
 * (`.gitignore`) anywhere in the mod.
 */
const NON_PACK_ROOTS = new Set(["tests", "art"]);
export function isPackPath(relPath: string): boolean {
  const segs = relPath.split("/");
  return !NON_PACK_ROOTS.has(segs[0]!) && !segs.some((s) => s.startsWith("."));
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
    // art/*.scene.json is not a pack file but is validated as a scene (validateSceneFile); everything else off-pack is skipped
    if (f.relPath === "description.json" || f.relPath === MOD_MANIFEST_FILE || (!isPackPath(f.relPath) && !f.relPath.endsWith(SCENE_SUFFIX))) continue;
    if (AUDIO_FILE_RE.test(f.relPath)) continue; // binary audio: checked by validateAudioFiles, never an overlay
    if (f.relPath.startsWith("models/")) continue; // 3D model assets (graphics.model), not overlays of a pack file
    if (f.relPath.startsWith("textures/models/") && f.relPath.endsWith(".png")) continue; // 3D model textures (App_GetTexture "models/<stem>.png"), new files
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
  /** the component key schema (tests/fixtures); undefined = the tracked editor/component-schema.json, null = none */
  componentSchema?: ComponentSchema | null;
  /** vanilla SWF clip (export) names (tests/fixtures); default every extracted vanilla SWF (src/core/art/swf-exports.ts); empty = unknown */
  clips?: Iterable<string>;
  /** the pack's audio index (tests/fixtures); undefined = the editor/data cache, null = none */
  audioIndex?: AudioIndex | null;
  /**
   * The mods loaded together, in -modpaths order (this mod is added last when absent): adds the cross-mod findings
   * of art/append-conflicts.ts — swf-file-conflict, cat-append-conflict, cat-append-shadows-vanilla, … — from each
   * mod's built swfs/*.swf, or its art/*.scene.json when nothing is built.
   */
  modpaths?: string[];
  /** the vanilla SWF folder for the cross-mod checks (tests); default vanillaSwfDir() */
  vanillaSwfs?: string;
  /** native-registered name PATTERNS (tests/fixtures; entries with `pattern`); default the pattern entries of editor/registered-names.json */
  registeredPatterns?: RegisteredName[];
  /** the base shaders dir an #include resolves against (tests/fixtures); default the pack's shaders/ next to extractedData */
  baseShaderDir?: string;
  /** native-registered 3D model names (tests/fixtures); default editor/registered-names.json entries of kind "model" */
  registeredModels?: Iterable<string>;
  /** named models (data/models.gon, M3 "@Name") declared outside this mod (tests/fixtures); default the base registry, mods/fw-3d/data/models.gon */
  namedModels?: Iterable<string>;
}

/** A mod's SWFs as the game would load them: the built swfs/*.swf, else the scenes the editor would build. */
export function modAppendFiles(modDir: string): ModAppendFile[] {
  const swfs = join(modDir, "swfs");
  const built = existsSync(swfs) ? readdirSync(swfs).filter((f) => f.toLowerCase().endsWith(".swf")) : [];
  if (built.length) {
    return built.map((file) => {
      try {
        return { file, appends: appendsOfSwf(new Uint8Array(readFileSync(join(swfs, file)))) };
      } catch {
        return { file, appends: [] };
      }
    });
  }
  const art = join(modDir, "art");
  if (!existsSync(art)) return [];
  const out: ModAppendFile[] = [];
  for (const f of readdirSync(art).filter((n) => n.endsWith(".scene.json"))) {
    try {
      const sc = JSON.parse(readFileSync(join(art, f), "utf8")) as Scene;
      if (sc && typeof sc.name === "string") out.push({ file: `${sc.name}.swf`, appends: appendsOfScene(sc) });
    } catch {
      /* a broken scene is the art validator's to report */
    }
  }
  return out;
}

/** The cross-mod append / SWF-name findings that involve `modName`, for the mods of `opts.modpaths`. */
function crossModFindings(modName: string, opts: ValidateOptions, rb: ReportBuilder): void {
  const order = [...(opts.modpaths || [])];
  if (!order.includes(modName)) order.push(modName);
  const mods: ModAppends[] = [];
  for (const m of order) {
    const dir = m === modName && opts.modDir ? opts.modDir : join(MODS_DIR, m);
    if (!existsSync(dir)) {
      rb.warn("modpath-missing", `modpaths names mods/${m}, which does not exist`);
      continue;
    }
    mods.push({ mod: m, files: modAppendFiles(dir) });
  }
  const vdir = opts.vanillaSwfs ?? vanillaSwfDir();
  const targets = new Set(mods.flatMap((m) => m.files.flatMap((f) => f.appends.map((a) => a.target))));
  const vanilla = existsSync(vdir)
    ? { files: readdirSync(vdir).filter((f) => f.toLowerCase().endsWith(".swf")), labels: Object.fromEntries([...targets].filter((t) => t === "CatTest").map((t) => [t, vanillaAppendLabels(t, vdir)])) }
    : undefined;
  for (const f of crossModAppendFindings(mods, vanilla)) {
    if (!f.mods.includes(modName)) continue;
    rb.add({ severity: f.severity, code: f.code, message: f.message, ...(f.path ? { location: { path: f.path } } : {}) });
  }
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
  const nativeBuild = opts.nativeBuild !== undefined ? opts.nativeBuild : installedNativeBuild(opts.env);
  checkManifest(modDir, modName, nativeBuild, rb);
  if (overlays.length === 0) {
    rb.warn("mod-empty", `mods/${modName} has no overlay files`);
  }

  const root = opts.extractedData ?? EXTRACTED_DATA;
  const sets = resolutionSets({
    root,
    components: opts.components ? new Set(opts.components) : undefined,
    registered: opts.registeredNames ? new Set(opts.registeredNames) : undefined,
    registeredPatterns: opts.registeredPatterns,
    models: opts.registeredModels ? new Set(opts.registeredModels) : undefined,
  });
  const local = modLocalNames(overlays);
  // "@Name" resolves against this mod's data/models.gon entries, the base registry (mods/fw-3d) and native registrations
  const namedModels = new Set([...(local.byCategory.get("models") ?? []), ...(opts.namedModels ? opts.namedModels : baseRegistryNames())]);
  const loc = loadLocalization(root);
  const componentSchema = opts.componentSchema !== undefined ? opts.componentSchema : loadComponentSchema();
  if (!sets.componentListKnown) {
    // Without a list every component would be "unknown": say once why they are not checked instead.
    rb.info("component-list-missing", `no component class names are known, so passives / ai brains / classes are not checked: ${COMPONENT_CACHE_HINT}`);
  }

  // Sounds and music: the mod's audio files, its sound-set / music_info overlays, and (below) data refs.
  const audioFiles: ModAudioFile[] = listModFiles(modDir).filter((f) => AUDIO_FILE_RE.test(f.relPath));
  const audioIndex = opts.audioIndex !== undefined ? opts.audioIndex : loadAudioIndex(DATA_CACHE_DIR);
  const audio = makeAudioContext(audioIndex, overlays, audioFiles);
  validateAudioFiles(modName, overlays, audioFiles, audio, rb);

  // Union of localization keys available: base + mod-added.
  const findLocRow = (key: string): string[] | undefined => local.locRows.get(key) || loc.rows.get(key);

  // shaders/*.shader: a file the game compiles by name (ShaderManager_GetOrCreateMaterial), not a data overlay
  const isShader = (o: OverlayFile): boolean => /^shaders\/[^/]+\.shader$/.test(o.relPath);
  const shaders = overlays.filter(isShader);
  const baseShaderDir = opts.baseShaderDir ?? packPath("shaders", root);
  const modShaderNames = new Set(shaders.map((o) => o.relPath.slice("shaders/".length)));
  const included = new Set<string>();
  for (const o of shaders) for (const inc of includesOf(o.text)) included.add(inc.name);
  const resolveInclude = (name: string): boolean | null =>
    modShaderNames.has(name) ? true : existsSync(baseShaderDir) ? existsSync(join(baseShaderDir, name)) : null;

  const fragments = includeFragments(overlays, root, modDir);
  let palettes: LvlPalettes | null = null;
  const clips: ClipNames = { vanilla: opts.clips ? new Set(opts.clips) : vanillaClipNames(), mod: modClipNames(modDir), listMissingReported: false };
  for (const o of overlays) {
    const fileLoc = { file: `mods/${modName}/${o.relPath}` };
    if (isShader(o)) {
      const name = o.relPath.slice("shaders/".length);
      for (const f of checkShaderSource(o.text, { file: fileLoc.file, library: included.has(name), resolveInclude, requiredUniforms: EXPECTED_UNIFORMS[name] })) rb.add(f);
      if (existsSync(join(baseShaderDir, name))) {
        rb.warn("whole-file-replace", `${o.relPath} replaces the game's own ${name} for every material that loads it`, fileLoc);
      }
    } else if (o.relPath.endsWith(SCENE_SUFFIX)) {
      // an art scene is a source the editor builds into a SWF, not a game file: run the scene validator on it
      validateSceneFile(o, rb, fileLoc.file, (k) => (local.locRows.has(k) ? "mod" : loc.rows.has(k) ? "base" : null));
    } else if (/\.lvl$/i.test(o.relPath)) {
      palettes ??= lvlPalettes(overlays, root);
      validateLvl(o, rb, palettes, modName, modDir, root);
    } else if (o.fileType === "gon") {
      validateGonOverlay(o, rb, sets, local, findLocRow, modName, nativeBuild, root, componentSchema, modDir, fragments, clips, audio, namedModels);
      if (/^data\/maps\/[^/]+\.gon$/.test(o.baseName)) validateMapFile(o, rb, overlays, modName, root, modDir);
    } else if (o.fileType === "csv" || (o.category === "text" && o.fileType === "other")) {
      validateCsvOverlay(o, rb, loc, modName);
    } else if (o.mode === "replace") {
      rb.warn("whole-file-replace", `${o.relPath} replaces the whole base file; prefer .append/.merge/.patch`, fileLoc);
    }
  }
  checkCatRigTargets(overlays, rb, modName, new Set([...sets.characters, ...(local.byCategory.get("characters") ?? [])]));
  if (opts.modpaths) crossModFindings(modName, opts, rb);
  return rb.build();
}

const SCENE_SUFFIX = ".scene.json";

/** art/*.scene.json: the scene validator's findings (validateScene, the same core read_art_scene runs), located at the file. */
function validateSceneFile(o: OverlayFile, rb: ReportBuilder, file: string, locKey: (key: string) => LocKeySource | null): void {
  let json: unknown;
  try {
    json = JSON.parse(o.text);
  } catch (e) {
    rb.error("scene-json", `invalid JSON: ${e instanceof Error ? e.message : String(e)}`, { file });
    return;
  }
  for (const f of validateScene(json, { locKey }).findings) rb.add(finding(f.severity, f.code, f.message, f.path ? { file, path: f.path } : { file }));
}

/**
 * mods/<name>/mod.json (docs/data-mods.md "Shipping a mod"): manifest-missing (info: the mod still loads, it just
 * cannot be packed), manifest-invalid (error, every bad field named), manifest-build-mismatch (warning: the installed
 * exe is not the build the mod says it was tested on; nothing is said without an exe).
 */
function checkManifest(modDir: string, modName: string, nativeBuild: NativeBuild | null, rb: ReportBuilder): void {
  const file = `mods/${modName}/${MOD_MANIFEST_FILE}`;
  const m = readModManifest(modDir, modName);
  if (!m.present) {
    rb.info("manifest-missing", `no ${MOD_MANIFEST_FILE}: the mod loads, but packing it for others (npm run pack -- ${modName}, MCP pack_mod) needs one with name, version, author, description and gameBuild (--init / init: true drafts it)`, { file });
    return;
  }
  if (!m.ok) {
    rb.error("manifest-invalid", `${MOD_MANIFEST_FILE}: ${m.errors.join("; ")}`, { file });
    return;
  }
  const c = compareBuild(m.manifest.gameBuild, nativeBuild);
  if (c.status === "mismatch") {
    const native = m.manifest.native?.length ? " (its native DLLs only run on a build the framework knows)" : "";
    rb.warn("manifest-build-mismatch", `${describeMismatch(c)}; re-test the mod on this build and update gameBuild${native}`, { file, path: "gameBuild" });
  }
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
function validateLvl(o: Pick<OverlayFile, "relPath">, rb: ReportBuilder, pal: LvlPalettes, modName: string, modDir: string, dataRoot: string, unsaved?: Uint8Array): void {
  const file = `mods/${modName}/${o.relPath}`;
  if (!o.relPath.startsWith("levels/")) {
    rb.warn("lvl-outside-levels", `${o.relPath} is a level file outside levels/: the game reads levels only as "levels/<name>.lvl", so it never sees this one`, { file });
  }
  if (existsSync(packPath(o.relPath, dataRoot))) {
    rb.warn("whole-file-replace", `${o.relPath} replaces the vanilla level of the same path (whole file); give a new room its own name`, { file });
  }
  let bytes: Uint8Array;
  try { bytes = unsaved ?? readFileSync(join(modDir, o.relPath)); } catch (e) { rb.error("lvl-bad-format", `cannot read ${o.relPath}: ${String(e)}`, { file }); return; }
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
 * The lvl-* rules for one level whose bytes may not be on disk yet (the Room editor's live findings, the report of a
 * write): the palettes resolve against the base and the mod's spawns.gon / tiles.gon overlays as saved.
 */
export function validateLevelBytes(modName: string, relPath: string, bytes: Uint8Array, opts: ValidateOptions = {}): Report {
  const rb = new ReportBuilder();
  const modDir = opts.modDir ?? join(MODS_DIR, modName);
  const root = opts.extractedData ?? EXTRACTED_DATA;
  const overlays = existsSync(modDir) ? collectOverlays(modDir) : [];
  validateLvl({ relPath }, rb, lvlPalettes(overlays, root), modName, modDir, root, bytes);
  return rb.build();
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

interface ClipNames {
  vanilla: Set<string>;
  mod: Set<string>;
  listMissingReported: boolean;
}

/**
 * A swap rig (framework API v7): an art scene export `_CatRig_<Entry>` replaces the cat clip of the character entry
 * <Entry> (fw_catrig_rules.h), so <Entry> must be a character of the base game or of this mod. An unknown entry is not
 * a crash (the framework registers it and nothing ever spawns under that name) but the rig would silently never show.
 * The rig itself (slots, labels, entry-name length) is the scene validator's (cat-rig.ts catRigFindings).
 */
function checkCatRigTargets(overlays: OverlayFile[], rb: ReportBuilder, modName: string, characters: Set<string>): void {
  const prefix = catRigPrefix();
  for (const o of overlays) {
    if (!/^art\/[^/]+\.scene\.json$/.test(o.relPath)) continue;
    let exportsMap: unknown;
    try {
      exportsMap = (JSON.parse(o.text) as { exports?: unknown }).exports;
    } catch {
      continue; // the scene validator reports an unreadable scene
    }
    if (!exportsMap || typeof exportsMap !== "object") continue;
    for (const linkage of Object.keys(exportsMap)) {
      if (!linkage.startsWith(prefix)) continue;
      const entry = linkage.slice(prefix.length);
      if (!entry || characters.has(entry)) continue;
      rb.error("cat-rig-target-unknown", `${linkage} would replace the cat clip of the character "${entry}", which is not a known character (base data/characters or this mod's characters overlays); the rig would never be drawn`, { file: `mods/${modName}/${o.relPath}`, path: `exports.${linkage}` });
    }
  }
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
  componentSchema: ComponentSchema | null,
  modDir: string,
  fragments: Set<string>,
  clips: ClipNames,
  audio: AudioContext,
  namedModels: Set<string> = new Set(),
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
  // A sound set / music_info file is checked by validateAudioFiles; a NEW set file (no pack copy) is not a replace.
  const audioDef = isSoundSetPath(o.baseName) || o.baseName.toLowerCase() === MUSIC_INFO;
  const newAudioFile = audioDef && audio.exists(o.baseName) === false;
  if (o.mode === "replace" && o.category === "models") {
    // the base registry is fw-3d's; a plain copy anywhere else replaces it (and every entry merged before this mod)
    if (modName !== MODEL_REGISTRY_BASE_MOD) rb.warn("whole-file-replace", `${o.relPath} replaces the base registry mods/${MODEL_REGISTRY_BASE_MOD} ships (and every entry merged before this mod); declare models in ${MODEL_REGISTRY_FILE}.append`, { file });
  } else if (o.mode === "replace" && !fragment && !newMap && !newAudioFile) {
    rb.warn("whole-file-replace", `${o.relPath} replaces the whole base file; prefer .append/.merge/.patch`, { file });
  }
  if (!root) return;
  const overlay = toValue(root);
  if (overlay.t !== "obj") return;
  if (audioDef) return;

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
    checkAudioField(key, value, path, audio, rb, file);
    if (isModelField(o, key, path)) {
      checkModel(value, at);
      return;
    }
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
          if ((PARTICLE_REF_KEYS as readonly string[]).includes(pe.key)) {
            checkParticleRefs(pe.value, { file, path: [...here, pe.key].join(".") });
          } else if (/Status/.test(pe.key) && pe.value.t === "obj") {
            for (const ss of pe.value.entries) checkStatus(ss.key, { file, path: [...here, pe.key, ss.key].join(".") });
          } else if (pe.value.t === "obj" || pe.value.t === "arr") {
            walk(pe.value, [...here, pe.key]);
          }
        }
      }
      return;
    }
    // ---- particles (src/core/particles.ts; docs/data-mods.md "Particles and VFX") ----
    if (o.category === "particles" && path.length === 1) {
      if (!isParticleKey(key)) rb.warn("particle-unknown-key", (PARTICLE_DEAD_KEYS as readonly string[]).includes(key) ? `particle system key "${key}" is read by nothing (vanilla writes it once, but the exe has no such string); it has no effect` : `particle system key "${key}" is not one the game reads (ParticleSystemData decode 0x9c5970 and the loader); it is ignored — colour is not a key: it comes from the clip art`, at);
      if (key === "movieclip" && value.t === "str") { checkClip(value.raw, at); return; }
      if (key === "combo" || key === "chain") { checkParticleRefs(value, at); return; }
      if (key === "variant_of") { checkParticleRefs(value, at); return; }
      if (key === "scripts") return;
    }
    if (o.category !== "particles" && (key === "EliteParticle" || key === "ParticleBurst" || key === "global_particles" || (key === "particles" && /weather/.test(o.baseName)) || (key === "particle" && path[path.length - 1] === "FormChangeOnElementInfluence"))) {
      checkParticleRefs(value, at);
      return;
    }
    if (o.category === "abilities" && path[path.length - 1] === "graphics" && (ABILITY_CLIP_KEYS as readonly string[]).includes(key) && value.t === "str") {
      if (!(key === "projectile" && (NON_CLIP_PROJECTILE_VALUES as readonly string[]).includes(value.raw))) checkClip(value.raw, at);
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

  const particleSet = new Set([...sets.particles, ...(local.byCategory.get("particles") ?? [])]);
  /** a particle SYSTEM name (or an array of them): base particles.gon / particles2d.gon or this mod */
  const checkParticleRefs = (value: VNode, at: SourceLocation): void => {
    const one = (name: string, where: SourceLocation) => {
      if (isNoneName(name) || particleSet.has(name)) return;
      rb.error("particle-missing", `particle system "${name}" is not defined in data/particles.gon or particles2d.gon (base or this mod); the game finds no system by that name`, where);
    };
    if (value.t === "str") one(value.raw, at);
    else if (value.t === "arr") value.items.forEach((it, i) => { if (it.t === "str") one(it.raw, { file: at.file, path: `${at.path}.[${i}]` }); });
  };
  /** an SWF clip (export) name: a vanilla SWF or this mod (its art scenes / built swfs) */
  const checkClip = (name: string, at: SourceLocation): void => {
    if (isNoneName(name) || clips.mod.has(name) || clips.vanilla.has(name)) return;
    if (!clips.vanilla.size) {
      if (!clips.listMissingReported) { clips.listMissingReported = true; rb.info("clip-list-missing", `no vanilla SWF exports are known (extract the SWFs: python -I tools/gpak.py extract .extracted --prefix swfs/), so clip names are not checked`, at); }
      return;
    }
    rb.warn("clip-missing", `clip "${name}" is exported by no vanilla SWF and by none of this mod's art scenes; the game then draws nothing (a particle system draws its ParticleError clip and logs "No Movieclip Named") — unless another loaded mod exports it`, at);
  };

  /** names provided only by native mod code (editor/registered-names.json), warned once per file */
  const nativeWarned = new Set<string>();
  const checkNative = (name: string, at: SourceLocation): void => {
    if ((!sets.registered.has(name) && !matchRegisteredPattern(sets.registeredPatterns, name)) || !nativeBuild || nativeBuild.known || nativeWarned.has(name)) return;
    nativeWarned.add(name);
    const id = nativeBuild.identity ? ` (TimeDateStamp ${nativeBuild.identity.timeDateStamp}, SizeOfImage ${nativeBuild.identity.sizeOfImage})` : "";
    rb.warn("native-build-unknown", `"${name}" is provided by native mod code (mewframework), but the installed Mewgenics.exe is not a build the bindings know${id}: the framework will stay inactive and the game will report NO_*_NAMED. Port the bindings first (docs/binding-port.md, check_game_build / port_bindings).`, at);
  };
  const checkStatus = (name: string, at: SourceLocation): void => {
    // a name the native layer recognises by its shape (FwGlow_<rrggbb[aa]>: the data-level glow) is a valid status
    if (!statusSet.has(name) && matchRegisteredPattern(sets.registeredPatterns, name)) {
      checkNative(name, at);
      return;
    }
    const malformed = statusSet.has(name) ? null : malformedRegisteredPattern(sets.registeredPatterns, name);
    if (malformed && malformed.kind === "glow") {
      rb.error("invalid-glow-name", `status "${name}" starts with ${malformed.prefix} but is not a glow request: write ${malformed.prefix} + 6 or 8 hex digits (rrggbb or rrggbbaa, e.g. ${malformed.prefix}ff00ff); the framework recognises nothing else in that namespace (docs/data-mods.md "Asking for a unit glow from data")`, at);
      return;
    }
    if (!statusSet.has(name)) {
      rb.error("unknown-status", `status "${name}" is not defined in base data, not native-registered, and not added by this mod`, at);
      return;
    }
    checkNative(name, at);
  };

  /** graphics.model: "@Name" against the registered models, else a models/<...>.obj file in this mod; or the block form
   *  model { file scale yaw offset texture tint palette double_sided hide_sprite } (3D phase M2 item 4, hide_sprite M3; native fw_gon_model_block) */
  const checkModel = (value: VNode, at: SourceLocation): void => {
    if (value.t === "obj") {
      checkModelBlock(value, at);
      return;
    }
    if (value.t !== "str") {
      rb.error("model-path-invalid", `graphics.model must be a string ("models/<name>.obj" or "@RegisteredModel") or a model { file ... } block`, at);
      return;
    }
    checkModelFile(value.raw, at);
  };

  /** data/models.gon (M3 "@Name"): every entry is a model value (string or block) whose file is a models/ path — the
   *  DLL refuses the same entries (fw_model_names.c FW_MODEL_ENTRY_*) with the same code */
  const checkRegistry = (reg: VObject): void => {
    for (const { key, value } of reg.entries) {
      const name = o.mode === "patch" ? parsePolicy(key).name : key;
      const at: SourceLocation = { file, path: name };
      if (value.t === "obj") checkModelBlock(value, at, true);
      else if (value.t === "str" && value.type === "string") checkRegistryFile(value.raw, at);
      else rb.error("model-registry-entry", `${MODEL_REGISTRY_FILE} entry ${name} is neither a model path nor a model block: write ${name} "models/<name>.obj" or ${name} { file "models/<name>.obj" ... }`, at);
    }
  };
  const checkRegistryFile = (raw: string, at: SourceLocation): void => {
    if (isRegisteredModelRef(raw)) {
      rb.error("model-registry-entry", `${MODEL_REGISTRY_FILE} entry names another @Name (${raw}); an entry must name a models/<...>.obj|.gltf|.glb file`, at);
      return;
    }
    const why = modelPathProblem(raw);
    if (why) {
      rb.error("model-registry-entry", `${MODEL_REGISTRY_FILE} entry: "${raw}" ${why}`, at);
      return;
    }
    checkModelFile(raw, at);
  };

  const checkModelBlock = (block: VObject, at: SourceLocation, registry = false): void => {
    const here = (k: string): SourceLocation => ({ file: at.file, path: `${at.path}.${k}` });
    const num = (v: VNode): number | null => (v.t === "str" && v.type === "number" && v.num !== null ? v.num : null);
    const nums = (v: VNode): number[] | null => (v.t === "arr" && v.items.every((it) => num(it) !== null) ? v.items.map((it) => num(it)!) : null);
    const fileEntry = block.entries.find((e) => e.key === "file");
    if (registry && (!fileEntry || fileEntry.value.t !== "str" || fileEntry.value.type !== "string")) {
      rb.error("model-registry-entry", `${MODEL_REGISTRY_FILE} entry ${at.path} is a block without a string file; nothing is drawn for it`, fileEntry ? here("file") : at);
    } else if (registry) checkRegistryFile((fileEntry!.value as { raw: string }).raw, here("file"));
    else if (!fileEntry || fileEntry.value.t !== "str" || fileEntry.value.type !== "string") {
      rb.error("model-path-invalid", `a graphics.model block needs file "models/<name>.obj" (or "@RegisteredModel"); without it no model is drawn`, fileEntry ? here("file") : at);
    } else checkModelFile(fileEntry.value.raw, here("file"));
    for (const { key, value: v } of block.entries) {
      const loc = here(key);
      switch (key) {
        case "file":
          break;
        case "scale": {
          const n = num(v);
          if (n === null || !(n > 0)) rb.error("model-scale", `model scale must be a number > 0 (1 = one model unit per tile)`, loc);
          break;
        }
        case "yaw": {
          const n = num(v);
          if (n === null) rb.error("model-yaw", `model yaw must be a number of degrees about the height axis`, loc);
          else if (n % 45 !== 0) rb.warn("model-yaw", `model yaw ${n} is not a multiple of 45: the iso view's natural steps are 0, 45, 90, ... (the model will look skewed against the tiles)`, loc);
          break;
        }
        case "offset": {
          const a = nums(v);
          if (!a || a.length !== 3) rb.error("model-offset", `model offset must be 3 numbers [x height z] in tiles`, loc);
          break;
        }
        case "tint": {
          const a = nums(v);
          if (!a || (a.length !== 3 && a.length !== 4)) rb.error("model-tint", `model tint must be 3 or 4 numbers [r g b (a)], 0..1`, loc);
          break;
        }
        case "palette":
        case "double_sided":
        case "hide_sprite":
          if (v.t !== "str" || v.type !== "bool") rb.error("model-flag", `model ${key} must be true or false`, loc);
          break;
        case "texture": {
          if (v.t !== "str" || v.type !== "string") {
            rb.error("model-texture-missing", `model texture must be a string: a path under the mod's textures/ folder`, loc);
            break;
          }
          const t = v.raw;
          const bad = t === "" || t.includes("\\") || t.startsWith("/") || t.includes(":") || t.split("/").some((seg) => seg === ".." || seg === "");
          const abs = join(modDir, "textures", ...t.split("/"));
          if (bad) rb.warn("model-texture-missing", `model texture "${t}" is not a relative path under textures/`, loc);
          else if (!existsSync(abs) || !statSync(abs).isFile()) rb.warn("model-texture-missing", `model texture "${t}" not found: mods/${modName}/textures/${t} is not a file (the model draws with its base colour only)`, loc);
          break;
        }
        default:
          rb.warn("model-key-unknown", `"${key}" is not a key of the graphics.model block (file, scale, yaw, offset, texture, tint, palette, double_sided, hide_sprite); the framework ignores it`, loc);
      }
    }
  };

  const checkModelFile = (raw: string, at: SourceLocation): void => {
    if (isRegisteredModelRef(raw)) {
      if (!sets.models.has(raw.slice(1)) && !namedModels.has(raw.slice(1))) {
        rb.error("model-name-unknown", `model "${raw}" is not declared: no ${MODEL_REGISTRY_FILE} entry named ${raw.slice(1)} in this mod or mods/${MODEL_REGISTRY_BASE_MOD}, and no native mod registers it (editor/registered-names.json, kind "model")`, at);
      }
      return;
    }
    const why = modelPathProblem(raw);
    if (why) {
      rb.error("model-path-invalid", `model "${raw}": ${why}`, at);
      return;
    }
    const abs = join(modDir, ...raw.split("/"));
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      rb.error("model-file-missing", `model "${raw}" not found: mods/${modName}/${raw} is not a file (models are mod-only; the base game has none)`, at);
      return;
    }
    // what the DLL would say about the file (one code list with mewframework.log; header-level until PR #128)
    for (const issue of checkModelBytes(raw, readFileSync(abs))) {
      const sev = modelCodeInfo(issue.code)?.severity ?? "error";
      const msg = `model "${raw}": ${issue.message}`;
      if (sev === "error") rb.error(issue.code, msg, at);
      else if (sev === "warning") rb.warn(issue.code, msg, at);
      else rb.info(issue.code, msg, at);
    }
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

  if (o.category === "models") {
    checkRegistry(overlay);
    return;   // no pack base to check targets against: fw-3d's file is the base
  }
  for (const e of overlay.entries) handleField(e.key, e.value, []);

  // ---- Component keys (editor/component-schema.json; docs/data-mods.md "Component keys") ----------------
  // A key under a component block that the component never reads is silently ignored by the game (the #1 silent
  // mod bug): warn. A required key missing from a complete (.append / new-file) block: error. Partial overlays
  // (.merge / .patch) are not checked for required keys: the base block may supply them.
  if (componentSchema && hasComponentList) {
    const effect = new Set(componentSchema.effectNames ?? []);
    const isDyn = (n: string): boolean => sets.components.has(n) || statusSet.has(n) || effect.has(n);
    const tree = o.mode === "patch" ? stripSuffixes(overlay) : overlay;
    const complete = o.mode === "append" || o.mode === "replace";
    const isMap = (n: string): boolean => resolveComponent(componentSchema, n)?.children === "any";
    forEachComponentBlock(tree, (n) => sets.components.has(n), (name, value, path) => {
      if (value.t !== "obj") return;
      const r = resolveComponent(componentSchema, name);
      if (!r) return;
      const res = checkComponentBlock(r, value, { patch: false, requireComplete: complete, isDynamicChild: isDyn });
      const reads = Object.keys(r.keys).filter((k) => !r.keys[k]!.unread).sort();
      const readsText = reads.length ? `it reads: ${reads.join(", ")}` : "it reads no keys of its own (the scalar form sets its stacks)";
      const kids = r.children ? `; children: ${r.children} names` : "";
      for (const k of res.unknown) {
        rb.warn("unknown-key", `${name} never reads "${k}", so the game ignores it (${readsText}${kids})`, { file, path: [...path, k].join(".") });
      }
      for (const k of res.ignored) {
        const ks = r.keys[k];
        rb.info("ignored-key", `${name} never reads "${k}" — vanilla writes it too, but the game ignores it${ks?.note ? ` (${ks.note})` : ""}`, { file, path: [...path, k].join(".") });
      }
      for (const k of res.missing) {
        const ks = r.keys[k]!;
        rb.error("missing-required-key", `${name} requires "${k}" (${ks.type}, read by ${ks.from} with ${ks.accessor ?? "a logging getter"}, no default)`, { file, path: path.join(".") });
      }
    }, isMap);
  }

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
        checkMergeTargets(overlay, baseRoot, [], rb, file, o);
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
function checkMergeTargets(overlay: VObject, base: VObject, path: string[], rb: ReportBuilder, file: string, o: OverlayFile): void {
  for (const e of overlay.entries) {
    const i = findIndex(base, e.key);
    const here = [...path, e.key];
    if (i < 0) {
      if (isModelField(o, e.key, path)) continue; // graphics.model is a framework key: a .merge adds it on purpose
      rb.warn("merge-target-missing", `.merge target "${here.join(".")}" does not exist in the base file; it will be ADDED, not changed`, { file, path: here.join(".") });
    } else {
      const bv = base.entries[i]!.value;
      if (e.value.t === "obj" && bv.t === "obj") checkMergeTargets(e.value, bv, here, rb, file, o);
    }
  }
}

/** `<Entry>.graphics.model` of a data/characters overlay (key suffixes stripped in a .patch, as the game does). */
function isModelField(o: OverlayFile, key: string, path: string[]): boolean {
  if (o.category !== "characters" || path.length !== 2) return false;
  const bare = (k: string): string => (o.mode === "patch" ? parsePolicy(k).name : k);
  return bare(key) === MODEL_KEY && bare(path[1]!) === MODEL_PARENT;
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

/** A copy of a .patch tree with every key's policy suffix stripped (the names the game merges under). */
function stripSuffixes(v: VNode): VNode {
  if (v.t === "obj") return { t: "obj", entries: v.entries.map((e) => ({ key: parsePolicy(e.key).name, value: stripSuffixes(e.value) })) };
  if (v.t === "arr") return { t: "arr", items: v.items.map(stripSuffixes) };
  return v;
}
