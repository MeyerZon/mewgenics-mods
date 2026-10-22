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
