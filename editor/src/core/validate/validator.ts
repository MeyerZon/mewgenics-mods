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
import { toValue } from "../gon/value.ts";
import { parseOverlayName } from "../overlay/overlay.ts";
import { parseCsv } from "../overlay/csv.ts";
import { parsePolicy } from "../overlay/policy.ts";
import { findIndex } from "../gon/value.ts";
import { resolutionSets } from "../names.ts";
import { loadLocalization, LOC_COLUMNS } from "../base-data.ts";
import { ReportBuilder, finding } from "./result.ts";
import { validateScene } from "../art/scene.ts";
import type { LocKeySource } from "../art/text.ts";
import { identifyExe } from "../bindings/check.ts";
import { listManifests } from "../bindings/manifest.ts";
import { locateGameDir } from "../ingame/launch.ts";
import type { VObject, VNode } from "../gon/types.ts";
import type { Report, SourceLocation } from "./result.ts";
import type { OverlayMode, FileType } from "../overlay/overlay.ts";
import type { ResolutionSets } from "../names.ts";
import type { LocTable } from "../base-data.ts";

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

  for (const o of overlays) {
    const fileLoc = { file: `mods/${modName}/${o.relPath}` };
    if (o.relPath.endsWith(SCENE_SUFFIX)) {
      // an art scene is a source the editor builds into a SWF, not a game file: run the scene validator on it
      validateSceneFile(o, rb, fileLoc.file, (k) => (local.locRows.has(k) ? "mod" : loc.rows.has(k) ? "base" : null));
    } else if (o.fileType === "gon") {
      validateGonOverlay(o, rb, sets, local, findLocRow, modName, nativeBuild, root);
    } else if (o.fileType === "csv" || (o.category === "text" && o.fileType === "other")) {
      validateCsvOverlay(o, rb, loc, modName);
    } else if (o.mode === "replace") {
      rb.warn("whole-file-replace", `${o.relPath} replaces the whole base file; prefer .append/.merge/.patch`, fileLoc);
    }
  }
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
): void {
  const file = `mods/${modName}/${o.relPath}`;
  const hasComponentList = sets.componentListKnown; // else component-list-missing was reported once
  let root;
  try {
    root = parse(o.text);
  } catch (e) {
    if (e instanceof GonParseError) {
      rb.error("gon-parse-error", e.message, { file, line: e.pos?.line, col: e.pos?.col });
    } else {
      rb.error("gon-parse-error", String(e), { file });
    }
    return;
  }
  if (o.mode === "replace") {
    rb.warn("whole-file-replace", `${o.relPath} replaces the whole base file; prefer .append/.merge/.patch`, { file });
  }
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
      baseRoot = toValue(parse(readFileSync(baseAbs, "utf8")));
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
