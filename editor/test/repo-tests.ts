// repo.ts: the path constants a fresh git worktree needs to redirect (T0; the env-dependent constants are
// evaluated at import, so those checks import repo.ts in a child node with the variable set).
//
// Every game-data / cache path resolves through repo.ts: EXTRACTED_ROOT (the parent of MEWGENICS_EXTRACTED_DATA,
// else <repo>/.extracted) + extractedPath(...) for the textures and the vanilla SWFs, DATA_CACHE_DIR for the
// caches. So setting MEWGENICS_EXTRACTED_DATA alone is enough for a worktree to see the main checkout's
// .extracted/ — the call sites below (palette, the Ruffle tab's vanilla list, build:index) are checked through it.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { packPath, EXTRACTED_DATA, EDITOR_DIR, REPO_ROOT } from "../src/core/repo.ts";
import { encodePng } from "../src/core/art/png.ts";
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

/** Import an editor module (path relative to editor/) in a child node with `env` applied and print
 * JSON.stringify(<expr>), where `m` is the module namespace. */
function evalIn(moduleRel: string, expr: string, env: Record<string, string>): { status: number | null; out: string; value?: unknown } {
  const url = pathToFileURL(join(EDITOR_DIR, ...moduleRel.split("/"))).href;
  const r = spawnSync(
    process.argv[0]!,
    ["--input-type=module", "-e", `import(${JSON.stringify(url)}).then((m) => console.log(JSON.stringify(${expr})))`],
    { env: { ...process.env, ...env }, encoding: "utf8", timeout: 60000 },
  );
  const out = ((r.stdout || "") + (r.stderr || "")).trim();
  let value: unknown;
  try { value = JSON.parse((r.stdout || "").trim().split("\n").pop() || ""); } catch { /* reported through out */ }
  return { status: r.status, out, value };
}

/** A temp dir laid out like a checkout's .extracted/ (an empty data/; the caller adds the rest). Returns its root. */
function fakeExtracted(): string {
  const root = mkdtempSync(join(tmpdir(), "mewged-extracted-"));
  mkdirSync(join(root, "data"));
  return root;
}

/** Only MEWGENICS_EXTRACTED_DATA set: the explicit SWF-dir override is cleared ("" counts as unset). */
const onlyExtracted = (root: string): Record<string, string> => ({ MEWGENICS_EXTRACTED_DATA: join(root, "data"), MEWGENICS_VANILLA_SWF_DIR: "" });

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

  test("EXTRACTED_ROOT / extractedPath: <repo>/.extracted by default; the parent of MEWGENICS_EXTRACTED_DATA when it is set", () => {
    const def = evalIn("src/core/repo.ts", `[m.EXTRACTED_ROOT, m.extractedPath("textures", "palette.png")]`, { MEWGENICS_EXTRACTED_DATA: "" });
    eq(JSON.stringify(def.value), JSON.stringify([join(REPO_ROOT, ".extracted"), join(REPO_ROOT, ".extracted", "textures", "palette.png")]), `default: ${def.out}`);
    const root = fakeExtracted();
    const r = evalIn("src/core/repo.ts", `[m.EXTRACTED_ROOT, m.extractedPath("swfs"), m.EXTRACTED_DATA]`, onlyExtracted(root));
    eq(JSON.stringify(r.value), JSON.stringify([resolve(root), join(resolve(root), "swfs"), join(resolve(root), "data")]), `override: ${r.out}`);
  });
  test("vanillaSwfDir: <extracted root>/swfs from MEWGENICS_EXTRACTED_DATA alone; MEWGENICS_VANILLA_SWF_DIR still overrides it", () => {
    const root = fakeExtracted();
    const r = evalIn("src/core/repo.ts", `m.vanillaSwfDir()`, onlyExtracted(root));
    eq(r.value, join(resolve(root), "swfs"), r.out);
    const other = mkdtempSync(join(tmpdir(), "mewged-swfs-"));
    const o = evalIn("src/core/repo.ts", `m.vanillaSwfDir()`, { ...onlyExtracted(root), MEWGENICS_VANILLA_SWF_DIR: other });
    eq(o.value, resolve(other), o.out);
  });
  test("the Ruffle tab's vanilla list (api.listVanillaSwfs) reads <extracted root>/swfs with only MEWGENICS_EXTRACTED_DATA set", () => {
    const root = fakeExtracted();
    mkdirSync(join(root, "swfs"));
    writeFileSync(join(root, "swfs", "swflist.gon"), "loader loader.swf\ngame [\n  minecarts.swf\n]\n");
    writeFileSync(join(root, "swfs", "minecarts.swf"), Buffer.from("FWS\u0011fake", "latin1"));
    const r = evalIn("src/core/api.ts", `(() => { const l = m.listVanillaSwfs(); return { dir: l.dir, files: l.files.map((f) => f.name + ":" + f.present) }; })()`, onlyExtracted(root));
    eq(JSON.stringify(r.value), JSON.stringify({ dir: join(resolve(root), "swfs"), files: ["loader.swf:false", "minecarts.swf:true"] }), r.out);
    const b = evalIn("src/core/api.ts", `m.readVanillaSwf("minecarts.swf").ok`, onlyExtracted(root));
    eq(b.value, true, b.out);
  });
  test("readPalette reads <extracted root>/textures/palette.png with only MEWGENICS_EXTRACTED_DATA set (not <repo>/.extracted)", () => {
    const root = fakeExtracted();
    mkdirSync(join(root, "textures"));
    const rgba = new Uint8Array(16 * 256 * 4);
    for (let i = 0; i < 16 * 256; i++) { rgba[i * 4] = 200; rgba[i * 4 + 1] = (i * 7) & 255; rgba[i * 4 + 2] = 10; rgba[i * 4 + 3] = 255; }
    writeFileSync(join(root, "textures", "palette.png"), encodePng(16, 256, rgba));
    const r = evalIn("src/core/art/palette.ts", `(() => { const p = m.readPalette("palette", { noCache: true }); return { ok: p.ok, height: p.height, px: p.rows[3][5] }; })()`, onlyExtracted(root));
    eq(JSON.stringify(r.value), JSON.stringify({ ok: true, height: 256, px: [200, (53 * 7) & 255, 10] }), r.out);
    const fx = evalIn("src/core/art/palette.ts", `(() => { const p = m.readPalette("fx_palette", { noCache: true }); return { ok: p.ok, error: p.error }; })()`, onlyExtracted(root));
    assert(JSON.stringify(fx.value).includes("\"ok\":false") && /fx_palette\.png not extracted/.test(fx.out), `absent fx_palette -> identity + not-extracted error: ${fx.out}`);
  });
  test("npm run build:index writes base-index.json to MEWGENICS_EDITOR_DATA, never into the checkout's editor/data", () => {
    const root = fakeExtracted();
    mkdirSync(join(root, "data", "abilities"));
    writeFileSync(join(root, "data", "abilities", "a.gon"), "Spin {\n  name x\n}\n");
    const cache = mkdtempSync(join(tmpdir(), "mewged-editor-data-"));
    const repoIndex = join(EDITOR_DIR, "data", "base-index.json");
    const before = existsSync(repoIndex) ? statSync(repoIndex).mtimeMs : -1;
    const r = spawnSync(process.argv[0]!, [join(EDITOR_DIR, "scripts", "build-index.ts")], {
      env: { ...process.env, ...onlyExtracted(root), MEWGENICS_EDITOR_DATA: cache }, encoding: "utf8", timeout: 120000,
    });
    const out = ((r.stdout || "") + (r.stderr || "")).trim();
    eq(r.status, 0, out);
    assert(existsSync(join(cache, "base-index.json")), `base-index.json written to the override: ${out}`);
    eq(existsSync(repoIndex) ? statSync(repoIndex).mtimeMs : -1, before, "the checkout's editor/data/base-index.json is untouched");
    assert(out.includes(resolve(cache)), `reports where it wrote: ${out}`);
  });
}
