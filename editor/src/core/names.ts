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

export function registeredNameSet(): Set<string> {
  return new Set(loadRegisteredNames().map((e) => e.name));
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
  /** native-registered names; default editor/registered-names.json */
  registered?: Set<string>;
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
  };
}
