// Named models (3D phase M3 "@Name"; SCRATCH importer-design §3.2: a model value's `file` is a models/ path "or @Name").
// A mod declares models once by name in data/models.gon and a unit refers to one with graphics { model "@Name" } or
// model { file "@Name" scale 2 } (the unit's keys override the entry's). mods/fw-3d ships the empty base file; a mod
// adds entries with data/models.gon.append (or .merge / .patch): the game's loader (Gon_LoadFile 0x611a0 ->
// FileManager_ResolveWithOverlays) merges every mod's overlay in mod-path order, and needs the base to exist, which is
// why fw-3d carries it. The DLL's side is native/framework/src/fw_model_names.c (same entry rules, same codes).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./gon/parser.ts";
import { toValue } from "./gon/value.ts";
import { parseOverlayName } from "./overlay/overlay.ts";
import type { OverlayMode } from "./overlay/overlay.ts";
import { parsePolicy } from "./overlay/policy.ts";
import { MODS_DIR } from "./repo.ts";

/** the registry's pack path (no such file in the gpak: fw-3d provides the base) */
export const MODEL_REGISTRY_FILE = "data/models.gon";
/** the mod that ships the base registry file */
export const MODEL_REGISTRY_BASE_MOD = "fw-3d";

/** The entry names a registry overlay text declares, as the game sees them (a .patch strips key suffixes, the other
 *  modes register the key as written); [] when the text does not parse. */
export function registryEntryNames(text: string, mode: OverlayMode): string[] {
  let root;
  try {
    root = toValue(parse(text));
  } catch {
    return [];
  }
  if (root.t !== "obj") return [];
  return root.entries.map((e) => (mode === "patch" ? parsePolicy(e.key).name : e.key));
}

/** Every name the base registry mod's data/models.gon (and its overlays) declares. */
export function baseRegistryNames(modsDir: string = MODS_DIR, baseMod: string = MODEL_REGISTRY_BASE_MOD): Set<string> {
  const out = new Set<string>();
  const dir = join(modsDir, baseMod, "data");
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const { baseName, mode } = parseOverlayName(f);
    if (`data/${baseName}` !== MODEL_REGISTRY_FILE) continue;
    try {
      for (const n of registryEntryNames(readFileSync(join(dir, f), "utf8"), mode)) out.add(n);
    } catch {
      /* unreadable: no names */
    }
  }
  return out;
}

// ---- the DLL's log lines (native/framework/src/fw_model_names.c, obj3d_engine.c), for the T2 pins ----
export interface ModelNamesLog {
  /** the load line: the entry names, or absent / unreadable; null when no load line */
  registry: { entries: string[]; absent: boolean; unreadable: boolean } | null;
  /** "unit model: <Unit>: @Ref -> data/models.gon entry <Entry>" */
  resolved: Array<{ unit: string; ref: string; entry: string }>;
  /** "mesh: @Ref: model-name-unknown|model-registry-entry: ... (unit <Unit>...) — drawing the 2D clip" */
  errors: Array<{ ref: string; code: string; unit: string | null; line: string }>;
}
const LOAD_RE = /model names: data\/models\.gon: (?:(\d+) entr(?:y|ies)(?:: ([^(]*?))?(?: \(\d+ dropped\))?|(absent)(?: \([^)]*\))?|(unreadable))(?: \(GonResource [0-9a-fA-Fx]+\))?\s*$/;
const RESOLVED_RE = /unit model: (\S+): (@\S+) -> data\/models\.gon entry (\S+)\s*$/;
const ERROR_RE = /mesh: (@\S*): (model-name-unknown|model-registry-entry): .*?(?:\(unit ([^;)]+)[;)].*)?\s— drawing the 2D clip\s*$/;

/** The named-model lines of a mewframework.log (any line prefix: the chainloader's timestamp, the window log's none). */
export function parseModelNamesLog(text: string): ModelNamesLog {
  const out: ModelNamesLog = { registry: null, resolved: [], errors: [] };
  for (const line of text.split(/\r?\n/)) {
    let m = LOAD_RE.exec(line);
    if (m) {
      const entries = m[1] !== undefined && m[2] ? m[2].split(",").map((s) => s.trim()).filter(Boolean) : [];
      out.registry = { entries, absent: m[3] !== undefined, unreadable: m[4] !== undefined };
      continue;
    }
    m = RESOLVED_RE.exec(line);
    if (m) { out.resolved.push({ unit: m[1]!, ref: m[2]!, entry: m[3]! }); continue; }
    m = ERROR_RE.exec(line);
    if (m) out.errors.push({ ref: m[1]!, code: m[2]!, unit: m[3] ?? null, line: line.slice(line.indexOf("mesh: @")) });
  }
  return out;
}
