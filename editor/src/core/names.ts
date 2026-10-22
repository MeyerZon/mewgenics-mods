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
    if (typeof e.pattern !== "string") continue;
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

export function registeredNameSet(): Set<string> {
  return new Set(loadRegisteredNames().filter((e) => typeof e.pattern !== "string").map((e) => e.name));
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
  /** native-registered name patterns (entries with `pattern`); default those of editor/registered-names.json */
  registeredPatterns?: RegisteredName[];
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
  /** names the native layer recognises by shape (a status named FwGlow_<rrggbb[aa]>): valid statuses, never listed */
  registeredPatterns: RegisteredPattern[];
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
    registeredPatterns: registeredPatterns(src.registeredPatterns ?? loadRegisteredNames()),
  };
}
