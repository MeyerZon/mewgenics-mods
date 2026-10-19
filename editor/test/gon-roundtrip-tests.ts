// GON round-trip over the extracted base data (T1): every base .gon must serialize back byte-exact.
// Skips (never fails) when the extracted dir has no .gon files, so T0 is runnable without game data
// (TDD target 9). `opts.extractedDir` / `opts.log` exist for the runner's own test of that skip.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse, serialize } from "../src/core/gon/parser.ts";
import { EXTRACTED_DATA } from "../src/core/repo.ts";

/** @param {string} dir @param {string[]} acc */
function listGon(dir, acc) {
  if (!existsSync(dir)) return acc;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) listGon(full, acc);
    else if (ent.isFile() && ent.name.endsWith(".gon")) acc.push(full);
  }
  return acc;
}

/**
 * @param {(name: string, fn: () => void) => void} test
 * @param {(cond: boolean, msg: string) => void} assert
 * @param {(a: unknown, b: unknown, msg?: string) => void} eq
 * @param {{ extractedDir?: string, log?: (line: string) => void }} [opts]
 * @returns {{ skipped: boolean, checked: number }}
 */
export function runGonRoundTripTests(test, assert, eq, opts = {}) {
  const dir = opts.extractedDir || EXTRACTED_DATA;
  const log = opts.log || console.log;
  log("\n# GON round-trip (parse -> serialize is byte-exact)");
  const all = listGon(dir, []);
  if (all.length === 0) {
    log(`  (skipped: no .gon files under ${dir}; run python -I tools/gpak.py extract .extracted --prefix data/)`);
    return { skipped: true, checked: 0 };
  }
  let checked = 0;
  let exact = 0;
  /** @type {string[]} */
  const failures = [];
  for (const f of all) {
    const src = readFileSync(f, "utf8");
    const out = serialize(parse(src));
    checked++;
    if (out === src) exact++;
    else if (failures.length < 5) failures.push(f.slice(dir.length + 1));
  }
  test(`round-trips all ${checked} base .gon files byte-exact`, () =>
    assert(exact === checked, `${checked - exact} differed, e.g. ${failures.join(", ")}`));
  void eq;
  return { skipped: false, checked };
}
