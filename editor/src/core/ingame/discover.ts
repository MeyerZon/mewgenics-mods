// Discover committed in-game test scripts: mods/<mod>/tests/*.mewtest.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { MODS_DIR } from "../repo.ts";
import { parseScript } from "./script.ts";

export const TESTS_DIR = "tests";
export const SCRIPT_EXT = ".mewtest";

/**
 * @typedef {{ mod: string, name: string, relPath: string, absPath: string, plan: import("./script.ts").Plan }} IngameTestEntry
 */

/**
 * @param {string} [modName] restrict to one mod folder
 * @param {{ modsDir?: string }} [opts]
 * @returns {{ tests: IngameTestEntry[] }}
 */
export function listIngameTests(modName, opts = {}) {
  const modsDir = opts.modsDir || MODS_DIR;
  /** @type {IngameTestEntry[]} */
  const tests = [];
  if (!existsSync(modsDir)) return { tests };
  const mods = modName ? [modName] : readdirSync(modsDir).filter((m) => safeIsDir(join(modsDir, m))).sort();
  for (const mod of mods) {
    const dir = join(modsDir, mod, TESTS_DIR);
    if (!safeIsDir(dir)) continue;
    const files = readdirSync(dir).filter((f) => f.endsWith(SCRIPT_EXT)).sort();
    for (const f of files) {
      const absPath = join(dir, f);
      const name = basename(f, SCRIPT_EXT);
      const plan = parseScript(readFileSync(absPath, "utf8"), { owningMod: mod, name });
      tests.push({ mod, name, relPath: `${TESTS_DIR}/${f}`, absPath, plan });
    }
  }
  return { tests };
}

/** @param {string} p */
function safeIsDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
