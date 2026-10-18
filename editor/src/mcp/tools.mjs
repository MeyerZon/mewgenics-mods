// MCP tool definitions over the core API. Each tool has a JSON Schema and a
// handler; the handlers do narrow, hand-rolled argument validation and route to
// src/core. Writes are confined to mods/<name>/ by the core (repo.mjs), so the
// server cannot write under saves/ or touch Mewgenics.exe / resources.gpak.

import * as api from "../core/api.mjs";

export class ToolError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ToolError";
  }
}

/** @param {any} args @param {string} key @param {boolean} [required] @returns {string|undefined} */
function str(args, key, required = false) {
  const v = args == null ? undefined : args[key];
  if (v === undefined || v === null) {
    if (required) throw new ToolError(`missing required argument "${key}"`);
    return undefined;
  }
  if (typeof v !== "string") throw new ToolError(`argument "${key}" must be a string`);
  return v;
}
/** @param {any} args @param {string} key @returns {boolean|undefined} */
function bool(args, key) {
  const v = args == null ? undefined : args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new ToolError(`argument "${key}" must be a boolean`);
  return v;
}
/** @param {any} args @param {string} key @returns {number|undefined} */
function num(args, key) {
  const v = args == null ? undefined : args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ToolError(`argument "${key}" must be a number`);
  return v;
}
/** @param {any} args @param {string} key @returns {Record<string, any>} */
function obj(args, key) {
  const v = args == null ? undefined : args[key];
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new ToolError(`argument "${key}" must be an object`);
  return v;
}

/**
 * @typedef {Object} ToolDef
 * @property {string} name
 * @property {string} description
 * @property {Record<string, any>} inputSchema
 * @property {(args: any) => any} handler
 */

/** @type {ToolDef[]} */
export const TOOLS = [
  {
    name: "list_base_data",
    description:
      "List base game data. With no arguments, returns the data categories (abilities, passives, items, characters, classes, difficulties, statuses, ...) with entry counts. With `category`, lists the entry names in that category (optionally filtered by substring).",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "optional category to list entries for" },
        filter: { type: "string", description: "optional case-insensitive substring filter" },
      },
      additionalProperties: false,
    },
    handler: (args) => {
      const category = str(args, "category");
      if (category) return api.listBaseEntries(category, str(args, "filter"));
      return api.listBaseData();
    },
  },
  {
    name: "read_base_entry",
    description: "Read one base game entry as GON text, e.g. the ability `Spin` or the status tooltip `Adrenaline`.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "e.g. abilities, passives, items, characters, statuses" },
        name: { type: "string", description: "the entry's GON key, e.g. Spin" },
      },
      required: ["category", "name"],
      additionalProperties: false,
    },
    handler: (args) => api.readBaseEntry(str(args, "category", true) ?? "", str(args, "name", true) ?? ""),
  },
  {
    name: "search_components",
    description:
      "Search the ~2,007 glaiel::<Name> C++ behavior component class names by substring. With `whereUsed: true`, also returns which base .gon files reference the top matches.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "substring to match against component class names" },
        whereUsed: { type: "boolean", description: "also return where the top matches are referenced" },
        limit: { type: "number", description: "max names to return (default 50)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: (args) =>
      api.searchComponents(str(args, "query", true) ?? "", { whereUsed: bool(args, "whereUsed"), limit: num(args, "limit") }),
  },
  {
    name: "read_mod",
    description:
      "Read a mod's description and overlay file list. With no `mod`, lists mod folders. With `includeText: true`, includes each overlay file's contents.",
    inputSchema: {
      type: "object",
      properties: {
        mod: { type: "string", description: "mod folder name under mods/" },
        includeText: { type: "boolean", description: "include overlay file contents" },
      },
      additionalProperties: false,
    },
    handler: (args) => {
      const mod = str(args, "mod");
      if (!mod) return api.listMods();
      return api.readMod(mod, { includeText: bool(args, "includeText") });
    },
  },
  {
    name: "write_overlay",
    description:
      "Create or overwrite an overlay file under mods/<name>/. The path is relative to the mod folder and mirrors the pack layout, e.g. data/abilities/my_abilities.gon.append. Writes can only land under the mod folder; saves/ and game files are refused.",
    inputSchema: {
      type: "object",
      properties: {
        mod: { type: "string" },
        path: { type: "string", description: "path relative to the mod folder" },
        content: { type: "string" },
      },
      required: ["mod", "path", "content"],
      additionalProperties: false,
    },
    handler: (args) =>
      api.writeOverlay(str(args, "mod", true) ?? "", str(args, "path", true) ?? "", str(args, "content", true) ?? ""),
  },
  {
    name: "validate_mod",
    description:
      "Validate a mod's overlays: reference integrity (statuses/abilities/components resolve against base data or registered names), localization completeness (keys exist in combined.csv with all 12 columns), and overlay-target existence (.merge/.patch target existing paths, .append adds non-colliding keys, positional CSV .merge flagged fragile). Returns ok/warning/error findings with source locations. Pass `path`+`text` to validate unsaved content for one file.",
    inputSchema: {
      type: "object",
      properties: {
        mod: { type: "string" },
        path: { type: "string", description: "optional overlay path to override with unsaved text" },
        text: { type: "string", description: "optional unsaved content for `path`" },
      },
      required: ["mod"],
      additionalProperties: false,
    },
    handler: (args) => {
      const path = str(args, "path");
      const text = str(args, "text");
      const override = path !== undefined && text !== undefined ? { relPath: path, text } : undefined;
      return api.validate(str(args, "mod", true) ?? "", override);
    },
  },
  {
    name: "preview_merge",
    description:
      "Compute the effective merged result (base + overlay) for one overlay file. For GON, returns the touched entries as base vs. effective (add `includeFullGon: true` for the whole merged file). For CSV, returns the added or changed rows. Pass `text` to preview unsaved content.",
    inputSchema: {
      type: "object",
      properties: {
        mod: { type: "string" },
        path: { type: "string", description: "overlay path relative to the mod folder" },
        text: { type: "string", description: "optional unsaved overlay content" },
        includeFullGon: { type: "boolean", description: "include the full effective GON text" },
      },
      required: ["mod", "path"],
      additionalProperties: false,
    },
    handler: (args) =>
      api.preview(str(args, "mod", true) ?? "", str(args, "path", true) ?? "", {
        overrideText: str(args, "text"),
        includeFullGon: bool(args, "includeFullGon"),
      }),
  },
  {
    name: "list_registered_native_names",
    description:
      "List status/ability/component names registered by the native layer (from registered-names.json). The validator treats these as valid references so a data mod paired with a native mod validates. Seeded with JokersLuck.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => api.listRegisteredNativeNames(),
  },
  {
    name: "new_from_template",
    description:
      "Scaffold a new content entry (kind: ability | passive | item | status-data) plus matching localization rows, writing them as .append overlays under mods/<name>/. Pass `options.dryRun: true` to return the content without writing. `options` may include displayName, desc, parent, mana, class, component, statusEffect, gonFile, fillTranslations.",
    inputSchema: {
      type: "object",
      properties: {
        mod: { type: "string" },
        kind: { type: "string", enum: ["ability", "passive", "item", "status-data"] },
        name: { type: "string", description: "the new entry's GON key, e.g. MyCoolSpin" },
        options: { type: "object", description: "scaffold options (displayName, desc, parent, mana, statusEffect, dryRun, ...)" },
      },
      required: ["mod", "kind", "name"],
      additionalProperties: false,
    },
    handler: (args) =>
      api.newFromTemplate(
        str(args, "mod", true) ?? "",
        /** @type {any} */ (str(args, "kind", true) ?? ""),
        str(args, "name", true) ?? "",
        obj(args, "options"),
      ),
  },
  {
    name: "list_ingame_tests",
    description:
      "List in-game test scripts (mods/<mod>/tests/*.mewtest) with their parsed header (mods, savesuffix, timeout, hide) and any parse errors. Running them needs Steam, Mewjector, native/dist/mewframework.dll + mewtest.dll; see docs/ingame-testing.md.",
    inputSchema: {
      type: "object",
      properties: { mod: { type: "string", description: "optional mod folder to restrict to" } },
      additionalProperties: false,
    },
    handler: (args) => api.listIngameTests(str(args, "mod")),
  },
  {
    name: "run_ingame_test",
    description:
      "Launch Mewgenics once with -savesuffix (never the real save), the test's mod paths and the mewtest harness DLL, run one .mewtest script and return the report: verdict (pass | fail | timeout | crash | harness-error | backstop-timeout | launch-error | cannot-run | skipped | no-result | log-errors | safety-violation), expectation failures, console lines, debug.log / framework / chainloader findings and artifact paths. Pass `test` (a name under mods/<mod>/tests/) or an inline `script`. Blocks until the game exits (default 120 s timeout + 45 s backstop). Returns verdict skipped/cannot-run with the reason when the game, Steam or the harness DLL is absent.",
    inputSchema: {
      type: "object",
      properties: {
        mod: { type: "string", description: "mod folder; its tests/ dir is searched and it is the default -modpaths entry" },
        test: { type: "string", description: "script name without .mewtest, e.g. smoke" },
        script: { type: "string", description: "inline .mewtest text (alternative to `test`)" },
        timeoutMs: { type: "number", description: "override the script's timeout" },
        hide: { type: "boolean", description: "hide the game window (default true)" },
        savesuffix: { type: "string", description: "override the save suffix (default dev); never empty" },
        includeEvents: { type: "boolean", description: "include the raw JSONL events in the report" },
      },
      required: ["mod"],
      additionalProperties: false,
    },
    handler: (args) => {
      const test = str(args, "test");
      const script = str(args, "script");
      if ((test && script) || (!test && !script)) throw new ToolError("pass exactly one of `test` or `script`");
      return api.runIngameTest({
        mod: str(args, "mod", true) ?? "",
        test,
        script,
        timeoutMs: num(args, "timeoutMs"),
        hide: bool(args, "hide"),
        savesuffix: str(args, "savesuffix"),
        includeEvents: bool(args, "includeEvents"),
      });
    },
  },
];
