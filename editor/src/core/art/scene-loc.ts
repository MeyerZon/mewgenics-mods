// The localization-key lookup the scene validator's text-loc-key-html rule uses (text.ts locKeyHtmlProblem): a key
// is one in the base combined.csv (the git-ignored .extracted/ copy; that half is empty when it is absent) or one the
// mod adds through its own data/text/*.csv overlays. Node side; scene.ts stays pure and takes the lookup as a callback.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXTRACTED_DATA } from "../repo.ts";
import { loadLocalization } from "../base-data.ts";
import { parseCsv } from "../overlay/csv.ts";
import type { LocKeySource } from "./text.ts";

/** The first-column keys of a mod's data/text/*.csv overlays (append / merge / patch / replace alike). */
export function modLocKeys(modDir: string): Set<string> {
  const out = new Set<string>();
  const dir = join(modDir, "data", "text");
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (!/\.csv(\.|$)/.test(name)) continue;
    try {
      for (const row of parseCsv(readFileSync(join(dir, name), "utf8"))) if (row[0]) out.add(row[0]);
    } catch {
      /* unreadable: no keys */
    }
  }
  return out;
}

/** A locKey callback for validateScene: the mod's own keys first, then the base table. */
export function sceneLocLookup(modDir: string | null, root: string = EXTRACTED_DATA): (key: string) => LocKeySource | null {
  const mod = modDir ? modLocKeys(modDir) : new Set<string>();
  const base = loadLocalization(root).rows;
  return (key) => (mod.has(key) ? "mod" : base.has(key) ? "base" : null);
}
