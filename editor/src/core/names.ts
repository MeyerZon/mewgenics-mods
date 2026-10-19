// Name-resolution sets used by the validator's reference-integrity check.
// Composes base-data entry names, component class names, keyword/status names,
// and native-registered names (registered-names.json).

import { readFileSync, existsSync } from "node:fs";
import { REGISTERED_NAMES_PATH } from "./repo.ts";
import { buildIndex } from "./base-data.ts";
import { componentNameSet } from "./components.ts";

/**
 * @typedef {Object} RegisteredName
 * @property {string} name
 * @property {string} [kind]
 * @property {string} [mod]
 */

/** @type {RegisteredName[]|null} */
let registeredCache = null;

/**
 * Load the native-registered names. Accepts a bare array, {names:[...]}, or
 * entries that are plain strings or {name,kind,mod} objects.
 * @returns {RegisteredName[]}
 */
export function loadRegisteredNames() {
  if (registeredCache) return registeredCache;
  /** @type {RegisteredName[]} */
  let out = [];
  if (existsSync(REGISTERED_NAMES_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(REGISTERED_NAMES_PATH, "utf8"));
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.names) ? parsed.names : [];
      out = list
        .map((/** @type {any} */ e) => (typeof e === "string" ? { name: e } : e))
        .filter((/** @type {any} */ e) => e && typeof e.name === "string");
    } catch {
      out = [];
    }
  }
  registeredCache = out;
  return out;
}

/** @returns {Set<string>} */
export function registeredNameSet() {
  return new Set(loadRegisteredNames().map((e) => e.name));
}

/** Clear cached registered names (after editing the file). */
export function clearRegisteredCache() {
  registeredCache = null;
}

/** @param {string} category */
function entryNameSet(category) {
  const ci = buildIndex().get(category);
  return new Set(ci ? ci.names : []);
}

/**
 * The resolution sets the validator uses. Each is a Set of names.
 * @returns {{
 *   statuses: Set<string>, abilities: Set<string>, passives: Set<string>,
 *   items: Set<string>, characters: Set<string>, classes: Set<string>,
 *   templates: Set<string>, components: Set<string>, registered: Set<string>
 * }}
 */
export function resolutionSets() {
  const components = componentNameSet();
  const registered = registeredNameSet();
  // Every status is a glaiel component; keyword_tooltips lists display/status
  // names (incl. aliases). A status reference resolves if it is any of these or
  // native-registered.
  const keywords = entryNameSet("statuses");
  const statuses = new Set([...keywords, ...components, ...registered]);
  return {
    statuses,
    abilities: new Set([...entryNameSet("abilities"), ...registered]),
    passives: entryNameSet("passives"),
    items: entryNameSet("items"),
    characters: new Set([...entryNameSet("characters"), ...registered]),
    classes: entryNameSet("classes"),
    templates: entryNameSet("ability_templates"),
    components: new Set([...components, ...registered]),
    registered,
  };
}
