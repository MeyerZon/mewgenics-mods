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
  return splitRegisteredNames(loadRegisteredNames()).names;
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
  components: Set<string>;
  /** false when no component class list was available at all (the editor/data cache is missing or empty) */
  componentListKnown: boolean;
  registered: Set<string>;
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
    components: new Set([...components, ...registered]),
    componentListKnown: components.size > 0,
    registered,
    models: src.models ?? registeredModelSet(),
  };
}
