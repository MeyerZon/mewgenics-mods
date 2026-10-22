// MCP tool definitions over the core API. Each tool has a zod input schema (TOOL_INPUT) that
// is both the published JSON Schema (tools/list) and the argument gate (callTool validates
// before a handler runs, so handlers only ever see typed, parsed arguments). Writes are
// confined to mods/<name>/ by the core (repo.ts), so the server cannot write under saves/ or
// touch Mewgenics.exe / resources.gpak.

import { z } from "zod";
import * as api from "../core/api.ts";
import { resolveReadPath } from "../core/repo.ts";

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

const str = (description?: string) => (description ? z.string().describe(description) : z.string());
const bool = (description: string) => z.boolean().describe(description);
const num = (description: string) => z.number().describe(description);
const anyObject = z.record(z.string(), z.unknown());

/** Tool name → zod input schema. The JSON Schema on the wire is generated from these (toMcpSchema). */
export const TOOL_INPUT = {
  list_base_data: z.object({
    category: str("optional category to list entries for").optional(),
    filter: str("optional case-insensitive substring filter").optional(),
  }),
  read_base_entry: z.object({
    category: str("e.g. abilities, passives, items, characters, statuses"),
    name: str("the entry's GON key, e.g. Spin"),
  }),
  search_components: z.object({
    query: str("substring to match against component class names"),
    whereUsed: bool("also return where the top matches are referenced").optional(),
    limit: num("max names to return (default 50)").optional(),
  }),
  read_mod: z.object({
    mod: str("mod folder name under mods/").optional(),
    includeText: bool("include overlay file contents").optional(),
  }),
  write_overlay: z.object({
    mod: str(),
    path: str("path relative to the mod folder"),
    content: str(),
  }),
  validate_mod: z.object({
    mod: str(),
    path: str("optional overlay path to override with unsaved text").optional(),
    text: str("optional unsaved content for `path`").optional(),
  }),
  preview_merge: z.object({
    mod: str(),
    path: str("overlay path relative to the mod folder"),
    text: str("optional unsaved overlay content").optional(),
    includeFullGon: bool("include the full effective GON text").optional(),
  }),
  list_registered_native_names: z.object({}),
  new_from_template: z.object({
    mod: str(),
    kind: z.enum(["ability", "passive", "item", "status-data"]),
    name: str("the new entry's GON key, e.g. MyCoolSpin"),
    options: anyObject.describe("scaffold options (displayName, desc, parent, mana, statusEffect, dryRun, ...)").optional(),
  }),
  list_ingame_tests: z.object({
    mod: str("optional mod folder to restrict to").optional(),
  }),
  list_art_scenes: z.object({
    mod: str("mod folder; lists art/*.scene.json, built swfs/*.swf and art assets"),
  }),
  read_art_scene: z.object({
    mod: str(),
    path: str("scene file inside the mod, e.g. art/my_rat.scene.json"),
  }),
  write_art_scene: z.object({
    mod: str(),
    path: str("scene file inside the mod (art/<name>.scene.json)"),
    scene: anyObject.describe("the whole scene (docs/art-preview-plan.md §2: version, name, shapes, bitmaps, sprites, exports, stage_instances)"),
    force: bool("write even when the scene has validation errors (they are returned)").optional(),
    dryRun: bool("validate only, write nothing").optional(),
  }),
  new_art_scene: z.object({
    mod: str(),
    name: str("scene name, becomes art/<name>.scene.json"),
    starter: bool("start from the example scene (default true)").optional(),
  }),
  import_svg: z.object({
    svgText: str("SVG markup (or pass mod + path of an .svg inside the mod)").optional(),
    mod: str("mod folder (for path, and for into)").optional(),
    path: str("an .svg inside the mod").optional(),
    options: anyObject.describe("importer options: applyViewBox, quantizeGray, grayTolerance, dropStrokes").optional(),
    into: z.object({
      scene: str("scene file inside the mod to add the shape to"),
      shapeId: str("the new shape's id"),
      replace: bool("overwrite a shape with that id").optional(),
    }).describe("save the imported shape into a scene (needs mod); without it nothing is written").optional(),
  }),
  export_svg: z.object({
    mod: str(),
    path: str("scene file inside the mod"),
    shapeId: str("the shape to export"),
  }),
  bake_glow: z.object({
    mod: str(),
    path: str("scene file inside the mod"),
    shapeId: str("the shape to put a halo under"),
    color: str("halo colour: #rrggbb[aa] or gray:N (its alpha is the ceiling)"),
    blur: num("halo reach in the shape's local px (0.5..255)"),
    strength: num("alpha multiplier of the falloff (default 1; >1 saturates the inner bands)").optional(),
    kind: z.enum(["glow", "dropShadow"]).describe("glow (centred, default) or dropShadow (offset by dx, dy)").optional(),
    dx: num("dropShadow offset x, local px (default 4)").optional(),
    dy: num("dropShadow offset y, local px (default 4)").optional(),
    steps: num("concentric bands 1..8 (default 4)").optional(),
    replace: bool("re-bake over an existing <shapeId>_glow").optional(),
  }),
  build_swf: z.object({
    mod: str(),
    path: str("scene file inside the mod"),
    abc: z.enum(["none", "stub"]).describe("DoABC: none (default; SymbolClass binds the name) or stub").optional(),
    dryRun: bool("emit + self-check, write nothing").optional(),
    writeSwflist: bool("also write swfs/swflist.gon.append (default true)").optional(),
  }),
  inspect_swf: z.object({
    mod: str(),
    path: str("a built SWF inside the mod, e.g. swfs/my_rat.swf"),
  }),
  run_ingame_test: z.object({
    mod: str("mod folder; its tests/ dir is searched and it is the default -modpaths entry"),
    test: str("script name without .mewtest, e.g. smoke").optional(),
    script: str("inline .mewtest text (alternative to `test`)").optional(),
    timeoutMs: num("override the script's timeout").optional(),
    hide: bool("hide the game window (default true)").optional(),
    clean: bool("clean exit: after the end event let the game shut itself down for a complete debug.log (default false: exit immediately); the harness exits after 3 s and the runner kills after 5 s if it lingers").optional(),
    savesuffix: str("override the save suffix (default dev); never empty").optional(),
    includeEvents: bool("include the raw JSONL events in the report").optional(),
  }),
  check_game_build: z.object({
    exe: str("optional path to a Mewgenics.exe to check instead of the installed one (read-only)").optional(),
  }),
  start_ingame_session: z.object({
    mod: str("mod folder; its tests/ dir is searched and it is the default -modpaths entry"),
    test: str("script name without .mewtest (made interactive: the DLL idles at its end)").optional(),
    script: str("inline .mewtest text (alternative to `test`); e.g. \"wait frames 120\\nenter TacticsTest\\nwait turns 1\\n\"").optional(),
    timeoutMs: num("the session's wall-clock budget (default the script's timeout, 120 s); the game is killed after it").optional(),
    hide: bool("hide the game window (default true)").optional(),
    savesuffix: str("override the save suffix (default dev); never empty").optional(),
    connectTimeoutMs: num("how long to wait for the DLL's pipe after the launch (default 30000)").optional(),
    waitIdle: bool("return only once the script has run to its end and the DLL idles (default true); false returns right after the pipe connects, and requests are then served inside the script's waits").optional(),
  }),
  ingame_exec: z.object({
    sessionId: str("from start_ingame_session"),
    cmd: str("a console line to run (op exec), e.g. \"spawn Rat\"").optional(),
    op: z.enum(["exec", "dump", "quit"]).describe("exec (default when cmd is given) | dump (the units event) | quit (ends the session and returns the report)").optional(),
    frames: num("frames to keep collecting console output after the command (default 3, max 600; ~180 frames/s hidden)").optional(),
  }),
  stop_ingame_session: z.object({
    sessionId: str("from start_ingame_session"),
    includeEvents: bool("include the raw JSONL events in the report").optional(),
  }),
  port_bindings: z.object({
    build: str("the NEW Steam build id (digits), e.g. 25200000; names bindings/<build>.json"),
    exe: str("path to the new Mewgenics.exe (default: the installed game)").optional(),
    from: str("the manifest to port from (default: the newest bindings/<build>.json)").optional(),
    version: str("the new game version string, e.g. 1.1.21300").optional(),
    resolve: z.record(z.string(), z.string()).describe("name -> 0xRVA answers for ambiguous/failed entries").optional(),
    dryRun: bool("default true; false writes bindings/<build>.json + the report").optional(),
  }),
};

export type ToolName = keyof typeof TOOL_INPUT;
/** The parsed arguments a tool's handler receives. */
export type ToolArgs<N extends ToolName> = z.output<(typeof TOOL_INPUT)[N]>;

export type JsonSchema = Record<string, unknown>;

export interface ToolDef {
  name: ToolName;
  description: string;
  inputSchema: JsonSchema;
  /** Receives the zod-parsed arguments (callTool validates first). May return a promise. */
  handler: (args: unknown) => unknown;
}

/** The JSON Schema MCP publishes for a tool: zod's draft-2020-12 output without the `$schema` key. */
export function toMcpSchema(schema: z.ZodType): JsonSchema {
  const { $schema: _omit, ...rest } = z.toJSONSchema(schema);
  void _omit;
  return rest;
}

function def<N extends ToolName>(name: N, description: string, handler: (args: ToolArgs<N>) => unknown): ToolDef {
  return { name, description, inputSchema: toMcpSchema(TOOL_INPUT[name]), handler: (args) => handler(args as ToolArgs<N>) };
}

export const TOOLS: ToolDef[] = [
  def(
    "list_base_data",
    "List base game data. With no arguments, returns the data categories (abilities, passives, items, characters, classes, difficulties, statuses, ...) with entry counts. With `category`, lists the entry names in that category (optionally filtered by substring).",
    (a) => (a.category ? api.listBaseEntries(a.category, a.filter) : api.listBaseData()),
  ),
  def(
    "read_base_entry",
    "Read one base game entry as GON text, e.g. the ability `Spin` or the status tooltip `Adrenaline`.",
    (a) => api.readBaseEntry(a.category, a.name),
  ),
  def(
    "search_components",
    "Search the ~2,007 glaiel::<Name> C++ behavior component class names by substring. With `whereUsed: true`, also returns which base .gon files reference the top matches.",
    (a) => api.searchComponents(a.query, { whereUsed: a.whereUsed, limit: a.limit }),
  ),
  def(
    "read_mod",
    "Read a mod's description and overlay file list. With no `mod`, lists mod folders. With `includeText: true`, includes each overlay file's contents.",
    (a) => (a.mod ? api.readMod(a.mod, { includeText: a.includeText }) : api.listMods()),
  ),
  def(
    "write_overlay",
    "Create or overwrite an overlay file under mods/<name>/. The path is relative to the mod folder and mirrors the pack layout, e.g. data/abilities/my_abilities.gon.append. Writes can only land under the mod folder; saves/ and game files are refused.",
    (a) => api.writeOverlay(a.mod, a.path, a.content),
  ),
  def(
    "validate_mod",
    "Validate a mod's overlays: reference integrity (statuses/abilities/components resolve against base data or registered names), localization completeness (keys exist in combined.csv with all 12 columns), and overlay-target existence (.merge/.patch target existing paths, .append adds non-colliding keys, positional CSV .merge flagged fragile). Returns ok/warning/error findings with source locations. Pass `path`+`text` to validate unsaved content for one file.",
    (a) => {
      const override = a.path !== undefined && a.text !== undefined ? { relPath: a.path, text: a.text } : undefined;
      return api.validate(a.mod, override);
    },
  ),
  def(
    "preview_merge",
    "Compute the effective merged result (base + overlay) for one overlay file. For GON, returns the touched entries as base vs. effective (add `includeFullGon: true` for the whole merged file). For CSV, returns the added or changed rows. Pass `text` to preview unsaved content.",
    (a) => api.preview(a.mod, a.path, { overrideText: a.text, includeFullGon: a.includeFullGon }),
  ),
  def(
    "list_registered_native_names",
    "List status/ability/component names registered by the native layer (from registered-names.json). The validator treats these as valid references so a data mod paired with a native mod validates. Seeded with JokersLuck.",
    () => api.listRegisteredNativeNames(),
  ),
  def(
    "new_from_template",
    "Scaffold a new content entry (kind: ability | passive | item | status-data) plus matching localization rows, writing them as .append overlays under mods/<name>/. Pass `options.dryRun: true` to return the content without writing. `options` may include displayName, desc, parent, mana, class, component, statusEffect, gonFile, fillTranslations.",
    (a) => api.newFromTemplate(a.mod, a.kind, a.name, a.options ?? {}),
  ),
  def(
    "list_ingame_tests",
    "List in-game test scripts (mods/<mod>/tests/*.mewtest) with their parsed header (mods, savesuffix, timeout, hide, clean) and any parse errors. Running them needs Steam, Mewjector, native/dist/mewframework.dll + mewtest.dll; see docs/ingame-testing.md.",
    (a) => api.listIngameTests(a.mod),
  ),
  def(
    "run_ingame_test",
    "Launch Mewgenics once with -savesuffix (never the real save), the test's mod paths and the mewtest harness DLL, run one .mewtest script and return the report: verdict (pass | fail | timeout | crash | harness-error | backstop-timeout | launch-error | cannot-run | skipped | no-result | log-errors | safety-violation), expectation failures, console lines, debug.log / framework / chainloader findings and artifact paths, incl. artifacts.shots: one PNG per `shot \"<label>\"` directive, captured from the game window while the harness holds the scene (needs hide: false; open the PNGs to judge the look). Pass `test` (a name under mods/<mod>/tests/) or an inline `script`. Blocks until the game exits (default 120 s timeout + 45 s backstop). Returns verdict skipped/cannot-run with the reason when the game, Steam or the harness DLL is absent.",
    (a) => {
      if ((a.test && a.script) || (!a.test && !a.script)) throw new ToolError("pass exactly one of `test` or `script`");
      return api.runIngameTest({
        mod: a.mod,
        test: a.test,
        script: a.script,
        timeoutMs: a.timeoutMs,
        hide: a.hide,
        clean: a.clean,
        savesuffix: a.savesuffix,
        includeEvents: a.includeEvents,
      });
    },
  ),
  def(
    "start_ingame_session",
    "Launch Mewgenics on an interactive .mewtest (the harness runs the script, then idles and serves a named pipe instead of exiting) and connect to it. Returns { sessionId, pid, runDir, pipe }. Then ingame_exec sends console lines (after `enter TacticsTest` the run commands exist: spawn, bind, status, win, ...), op dump reads the units, and stop_ingame_session (or op quit) ends the game and returns the ordinary report (verdict, log findings, save-set check). One game at a time; the session dies at the script's timeout. Never the real save (-savesuffix); docs/ingame-testing.md \"Interactive mode\".",
    async (a) => {
      if ((a.test && a.script) || (!a.test && !a.script)) throw new ToolError("pass exactly one of `test` or `script`");
      const r = await api.startIngameSession({ mod: a.mod, test: a.test, script: a.script, timeoutMs: a.timeoutMs, hide: a.hide, savesuffix: a.savesuffix, connectTimeoutMs: a.connectTimeoutMs, waitIdle: a.waitIdle });
      if (!r.ok) throw new ToolError(r.error);
      return r;
    },
  ),
  def(
    "ingame_exec",
    "Send one request to a running in-game session: a console line (cmd; the reply is the DLL's exec event with the console lines it produced within `frames` frames), op dump (the units event: names, classes, factions, statuses, stacks) or op quit (ends the game; returns the report). Rejects with \"unknown session\" after the game exited.",
    async (a) => {
      const r = await api.ingameExec({ sessionId: a.sessionId, cmd: a.cmd, op: a.op, frames: a.frames });
      if (!r.ok) throw new ToolError(r.error);
      return r;
    },
  ),
  def(
    "stop_ingame_session",
    "End an in-game session (sends quit, waits for the game to exit) and return the run's report, exactly as run_ingame_test would (every exec exchange is also in result.jsonl / report.result.execs).",
    async (a) => {
      const r = await api.stopIngameSession({ sessionId: a.sessionId, includeEvents: a.includeEvents });
      if (!r.ok) throw new ToolError(r.error);
      return r;
    },
  ),
  def(
    "list_art_scenes",
    "List a mod's art: scenes (art/*.scene.json, with validity), built SWFs (swfs/*.swf) and assets (SVG/PNG). Art is authored as a scene (shapes from SVG paths with gray:N palette fills, bitmaps, sprites with keyed layers and labels, exports = SymbolClass names) and built into a SWF the game loads through swfs/swflist.gon.append.",
    (a) => api.listArtScenes(a.mod),
  ),
  def(
    "read_art_scene",
    "Read and validate one scene file; returns { ok, scene, findings }.",
    (a) => api.readArtScene(a.mod, a.path),
  ),
  def(
    "write_art_scene",
    "Write a whole scene file inside the mod (validated first; refused with findings when invalid unless force). dryRun validates only. Writes are confined to mods/<mod>/.",
    (a) => (a.dryRun ? api.validateArtScene(a.scene) : api.writeArtScene(a.mod, a.path, a.scene, { force: a.force })),
  ),
  def(
    "new_art_scene",
    "Create art/<name>.scene.json (the example scene by default: two gray shapes, a 24-frame sprite with idle/blink labels, exports).",
    (a) => api.newArtScene(a.mod, a.name, { starter: a.starter }),
  ),
  def(
    "import_svg",
    "Convert SVG markup (or an .svg inside the mod) into a scene shape: paths with fills quantised to gray:N where possible; gradients, filters, text, use and masks are reported as findings. With into { scene, shapeId } the shape is saved into that scene; otherwise nothing is written and the shape is returned.",
    (a) => {
      if (a.into) {
        if (!a.mod) throw new ToolError("into needs mod");
        return api.importSvgIntoScene({ mod: a.mod, scenePath: a.into.scene, shapeId: a.into.shapeId, svgText: a.svgText, svgPath: a.path, options: a.options, replace: a.into.replace });
      }
      if (!a.svgText && !(a.mod && a.path)) throw new ToolError("pass svgText, or mod + path");
      return api.importSvgShape({ svgText: a.svgText, mod: a.mod, relPath: a.path, options: a.options });
    },
  ),
  def(
    "export_svg",
    "Export one shape of a scene as mods/<mod>/art/<shapeId>.svg for an external vector editor (VectorCraft, Inkscape, …: static drawing only — animation stays in the scene's sprites). Re-import the edited file with import_svg { mod, path: 'art/<shapeId>.svg', options: { applyViewBox: false }, into: { scene, shapeId, replace: true } } to keep its coordinates.",
    (a) => api.exportShapeSvg(a.mod, a.path, a.shapeId),
  ),
  def(
    "bake_glow",
    "Bake a glow or drop shadow into a scene the way the game allows: the SWF player stops on any PlaceObject3 filter (\"ERROR: FILTERS NOT SUPPORTED\"), so this adds an ordinary halo shape <shapeId>_glow — concentric bands of the source outline pushed out by blur with falling alpha — and places it immediately under the source on every sprite layer that places it. The source shape is never changed. For engine-side light/tint instead, use the passives CharacterLightSource { glow [r g b a] size N } (a ground disc) or AdvancedTint [mul][add] (docs/data-mods.md).",
    (a) => api.bakeGlowIntoScene({ mod: a.mod, scenePath: a.path, shapeId: a.shapeId, color: a.color, blur: a.blur, strength: a.strength, kind: a.kind, dx: a.dx, dy: a.dy, steps: a.steps, replace: a.replace }),
  ),
  def(
    "build_swf",
    "Build a scene into mods/<mod>/swfs/<scene.name>.swf (DefineShape3 / DefineBitsLossless2 / DefineSprite / SymbolClass), re-read it with the verification reader, and add it to swfs/swflist.gon.append. dryRun emits and checks without writing. To see it in the game: an ability icon via _Append_AbilityIcon (npm run test:swfgate) or a character's graphics.movieclip (see mods/_artprobe and npm run test:artprobe).",
    (a) => api.buildSwf(a.mod, a.path, { abc: a.abc, dryRun: a.dryRun, writeSwflist: a.writeSwflist }),
  ),
  def(
    "inspect_swf",
    "Read a built SWF inside the mod with the verification reader: header, tag histogram, frame labels, exports, DoABC count.",
    (a) => api.inspectSwf(a.mod, a.path),
  ),
  def(
    "check_game_build",
    "Is the installed Mewgenics.exe a game build the native bindings know (bindings/<steamBuildId>.json), and does every byte signature still match exactly once at its RVA? Read-only, never launches the game. Returns { ok, known, build: { timeDateStamp, sizeOfImage, matched, scannedWith, knownBuilds }, entries: [{ name, status: ok|moved|missing|ambiguous, expected, hit }], summary }. known:false means a game update broke the native layer (mewframework disables itself; data mods still load) and the bindings must be ported (docs/binding-port.md). Returns ok:false with skipped:true when the exe or the manifests are absent.",
    (a) => api.checkGameBuild({ exe: a.exe ? resolveReadPath(a.exe) : undefined }),
  ),
  def(
    "port_bindings",
    "Port the native bindings manifest of a known game build to a new Mewgenics.exe (docs/binding-port.md). Walks the resolution ladder per entry (signature rescan -> unique __FUNCSIG__ string xref -> caller ordinal -> .pdata neighbour; witnesses / RTTI / vtable slots / table indices for data) and returns { ok, dryRun, summary, rows: [{ name, kind, oldValue, newValue, status, method, detail, candidates? }], needsAgent: [...ambiguous/failed rows], report (markdown) }. Statuses: ported-exact | ported-rescan | ported-anchor | ported-witness | ported-derived | proposed (value NOT applied) | ambiguous | failed | needs-human. dryRun (default true) writes nothing; dryRun:false writes bindings/<build>.json and bindings/<build>.port-report.md and nothing else. Resolve ambiguous/failed entries by passing resolve: { name: \"0xRVA\" } after examining the candidates (REA compare_functions with tools/bindings/seed-file.ts, or .analysis/decompiled). Afterwards: npm run bindings:gen, rebuild the DLLs, npm test, run_ingame_test.",
    (a) => {
      const resolve = a.resolve ?? {};
      for (const [k, v] of Object.entries(resolve)) if (!/^0x[0-9a-fA-F]+$/.test(v)) throw new ToolError(`resolve.${k} must be a 0x hex RVA string`);
      return api.portBindings({
        build: a.build,
        exe: a.exe ? resolveReadPath(a.exe) : undefined,
        from: a.from ? resolveReadPath(a.from) : undefined,
        version: a.version,
        resolve,
        dryRun: a.dryRun,
      });
    },
  ),
];

const toolsByName = new Map<string, ToolDef>(TOOLS.map((t) => [t.name, t]));

export function findTool(name: string): ToolDef | undefined {
  return toolsByName.get(name);
}

/**
 * Validate `args` against the tool's zod schema (synchronously; a bad call throws ToolError before any handler
 * runs) and dispatch. Returns whatever the handler returns, possibly a promise.
 */
export function callTool(name: string, args: unknown): unknown {
  const tool = toolsByName.get(name);
  if (!tool) throw new ToolError(`unknown tool: ${name}`);
  const schema = TOOL_INPUT[tool.name];
  const r = schema.safeParse(args ?? {});
  if (!r.success) {
    const detail = r.error.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new ToolError(`invalid arguments for ${name}: ${detail}`);
  }
  return tool.handler(r.data);
}
