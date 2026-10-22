// repo.ts: the path constants a fresh git worktree needs to redirect (T0; the env-dependent constants are
// evaluated at import, so those checks import repo.ts in a child node with the variable set).

import { mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { packPath, EXTRACTED_DATA, EDITOR_DIR } from "../src/core/repo.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const REPO_TS = pathToFileURL(join(EDITOR_DIR, "src", "core", "repo.ts")).href;

/** Import repo.ts in a child node with `env` applied and print one of its exports. */
function printConst(name: string, env: Record<string, string>): { status: number | null; out: string } {
  const r = spawnSync(
    process.argv[0]!,
    ["--input-type=module", "-e", `import(${JSON.stringify(REPO_TS)}).then((m) => console.log(m[${JSON.stringify(name)}]))`],
    { env: { ...process.env, ...env }, encoding: "utf8", timeout: 60000 },
  );
  return { status: r.status, out: ((r.stdout || "") + (r.stderr || "")).trim() };
}

export function runRepoTests(test: TestFn, assert: AssertFn, eq: EqFn): void {
  test("packPath: data/<x> maps under the extracted data root; another pack dir (swfs/…) is its sibling", () => {
    eq(packPath("data/characters/enemies.gon", join("r", "data")), join("r", "data", "characters", "enemies.gon"));
    eq(packPath("data\\text\\combined.csv", join("r", "data")), join("r", "data", "text", "combined.csv"), "backslashes accepted");
    eq(packPath("swfs/catparts.swf", join("r", "data")), join("r", "swfs", "catparts.swf"));
    eq(packPath("data/difficulties.gon"), join(EXTRACTED_DATA, "difficulties.gon"), "default root is EXTRACTED_DATA");
  });
  test("DATA_CACHE_DIR: editor/data by default; MEWGENICS_EDITOR_DATA redirects it (a worktree points at a checkout's cache)", () => {
    const def = printConst("DATA_CACHE_DIR", { MEWGENICS_EDITOR_DATA: "" });
    eq(def.out, join(EDITOR_DIR, "data"), `default: ${def.out}`);
    const tmp = mkdtempSync(join(tmpdir(), "mewged-editor-data-"));
    const r = printConst("DATA_CACHE_DIR", { MEWGENICS_EDITOR_DATA: tmp });
    eq(r.status, 0, r.out);
    eq(r.out, resolve(tmp), "the override is honoured");
  });
  test("DATA_CACHE_DIR: an override under a saves/ directory is refused at load (the editor never writes near a save)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mewged-editor-data-"));
    const r = printConst("DATA_CACHE_DIR", { MEWGENICS_EDITOR_DATA: join(tmp, "saves", "cache") });
    assert(r.status !== 0, `expected a load failure, got exit ${r.status}: ${r.out}`);
    assert(/saves/.test(r.out) && /MEWGENICS_EDITOR_DATA/.test(r.out), `names the path and the variable: ${r.out}`);
  });
}
