// Name-resolution sets used by the validator's reference-integrity check.
// Composes base-data entry names, component class names, keyword/status names,
// and native-registered names (registered-names.json).

import { readFileSync, existsSync } from "node:fs";
import { REGISTERED_NAMES_PATH } from "./repo.ts";
import { buildIndex } from "./base-data.ts";
import { componentNameSet } from "./components.ts";

export interface RegisteredName {
  name: string;
  kind?: string;
  mod?: string;
  /** a pattern entry (kind "glow"): names matching this regular expression are valid; `name` is only a label */
  pattern?: string;
  /** with `pattern`: a name starting with this prefix that does not match is reported as malformed */
  prefix?: string;
}

/**
 * kind "catrig" (framework API v7): a SWF export name the framework recognises by shape (`_CatRig_<CharacterEntry>`
 * replaces that entry's cat clip; fw_catrig_rules.h). It is no GON reference, so it is neither a literal name nor a
 * status pattern; the validator checks the entry (cat-rig-target-unknown) and the scene checks the rig (cat-rig-*).
 */
export const NON_NAME_KIND = "catrig";

/** The catrig entry's prefix (default _CatRig_). */
export function catRigPrefix(entries: RegisteredName[] = loadRegisteredNames()): string {
  const e = entries.find((x) => x.kind === NON_NAME_KIND && typeof x.prefix === "string" && x.prefix);
  return e ? e.prefix! : "_CatRig_";
}

/** A compiled pattern entry of registered-names.json. */
export interface RegisteredPattern {
  re: RegExp;
  prefix: string;
  label: string;
  kind?: string;
  mod?: string;
}

/**
 * The pattern entries of registered-names.json, compiled: a name the native layer recognises by its SHAPE rather than
 * by registration (glow v3: `FwGlow_<rrggbb[aa]>`, fw_glow_rules.h). An entry whose pattern does not compile is skipped.
 */
export function registeredPatterns(entries: RegisteredName[] = loadRegisteredNames()): RegisteredPattern[] {
  const out: RegisteredPattern[] = [];
  for (const e of entries) {
    if (typeof e.pattern !== "string" || e.kind === NON_NAME_KIND) continue;
    let re: RegExp;
    try {
      re = new RegExp(e.pattern);
    } catch {
      continue;
    }
    out.push({ re, prefix: typeof e.prefix === "string" ? e.prefix : "", label: e.name, kind: e.kind, mod: e.mod });
  }
  return out;
}

/** The pattern a name matches, or null. */
export function matchRegisteredPattern(patterns: RegisteredPattern[], name: string): RegisteredPattern | null {
  return patterns.find((p) => p.re.test(name)) ?? null;
}

/** The pattern whose (non-empty) prefix the name starts with although the name does not match it: a malformed name. */
export function malformedRegisteredPattern(patterns: RegisteredPattern[], name: string): RegisteredPattern | null {
  return patterns.find((p) => p.prefix !== "" && name.startsWith(p.prefix) && !p.re.test(name)) ?? null;
}

let registeredCache: RegisteredName[] | null = null;

/**
 * Load the native-registered names. Accepts a bare array, {names:[...]}, or
 * entries that are plain strings or {name,kind,mod} objects.
 */
export function loadRegisteredNames(): RegisteredName[] {
  if (registeredCache) return registeredCache;
  let out: RegisteredName[] = [];
  if (existsSync(REGISTERED_NAMES_PATH)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(REGISTERED_NAMES_PATH, "utf8"));
      const list: unknown[] = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { names?: unknown }).names)
          ? ((parsed as { names: unknown[] }).names)
          : [];
      out = list
        .map((e) => (typeof e === "string" ? { name: e } : e))
        .filter((e): e is RegisteredName => !!e && typeof (e as { name?: unknown }).name === "string");
    } catch {
      out = [];
    }
  }
  registeredCache = out;
  return out;
}

/** The registered-name kind of a 3D model a native mod registers with the mesh engine (GON `model "@Name"`). */
export const MODEL_KIND = "model";

/**
 * Split registered names by kind: `model` entries only resolve a GON `model "@Name"` reference; every other entry
 * (any other kind, or none) is a general name valid as a status / ability / character / component, as before.
 */
export function splitRegisteredNames(list: RegisteredName[]): { names: Set<string>; models: Set<string> } {
  const names = new Set<string>();
  const models = new Set<string>();
  for (const e of list) (e.kind === MODEL_KIND ? models : names).add(e.name);
  return { names, models };
}

/** The general native-registered names (every kind but `model`). */
export function registeredNameSet(): Set<string> {
  return splitRegisteredNames(loadRegisteredNames().filter((e) => typeof e.pattern !== "string" && e.kind !== NON_NAME_KIND)).names;
}

/** The native-registered 3D model names (kind `model`). */
export function registeredModelSet(): Set<string> {
  return splitRegisteredNames(loadRegisteredNames()).models;
}

/** Clear cached registered names (after editing the file). */
export function clearRegisteredCache(): void {
  registeredCache = null;
}

function entryNameSet(category: string, root?: string): Set<string> {
  const ci = buildIndex(root).get(category);
  return new Set(ci ? ci.names : []);
}

export interface ResolutionSources {
  /** the extracted `data/` tree to index; default EXTRACTED_DATA */
  root?: string;
  /** component class names; default the editor/data cache */
  components?: Set<string>;
  /** native-registered names; default editor/registered-names.json (every kind but `model`) */
  registered?: Set<string>;
  /** native-registered name patterns (entries with `pattern`); default those of editor/registered-names.json */
  registeredPatterns?: RegisteredName[];
  /** native-registered 3D model names; default editor/registered-names.json entries of kind `model` */
  models?: Set<string>;
}

export interface ResolutionSets {
  statuses: Set<string>;
  abilities: Set<string>;
  passives: Set<string>;
  items: Set<string>;
  characters: Set<string>;
  classes: Set<string>;
  templates: Set<string>;
  /** particle system names: data/particles.gon + data/particles2d.gon */
  particles: Set<string>;
  components: Set<string>;
  /** false when no component class list was available at all (the editor/data cache is missing or empty) */
  componentListKnown: boolean;
  registered: Set<string>;
  /** names the native layer recognises by shape (a status named FwGlow_<rrggbb[aa]>): valid statuses, never listed */
  registeredPatterns: RegisteredPattern[];
  /** native-registered 3D models: what a GON `model "@Name"` resolves against */
  models: Set<string>;
}

/** The resolution sets the validator uses. Each is a Set of names. Sources default to the real ones. */
export function resolutionSets(src: ResolutionSources = {}): ResolutionSets {
  const root = src.root;
  const components = src.components ?? componentNameSet();
  const registered = src.registered ?? registeredNameSet();
  // Every status is a glaiel component; keyword_tooltips lists display/status
  // names (incl. aliases). A status reference resolves if it is any of these or
  // native-registered.
  const keywords = entryNameSet("statuses", root);
  const statuses = new Set([...keywords, ...components, ...registered]);
  return {
    statuses,
    abilities: new Set([...entryNameSet("abilities", root), ...registered]),
    passives: entryNameSet("passives", root),
    items: entryNameSet("items", root),
    characters: new Set([...entryNameSet("characters", root), ...registered]),
    classes: entryNameSet("classes", root),
    templates: entryNameSet("ability_templates", root),
    particles: new Set([...entryNameSet("particles", root), ...entryNameSet("particles2d", root)]),
    components: new Set([...components, ...registered]),
    componentListKnown: components.size > 0,
    registered,
    registeredPatterns: registeredPatterns(src.registeredPatterns ?? loadRegisteredNames()),
    models: src.models ?? registeredModelSet(),
  };
}
