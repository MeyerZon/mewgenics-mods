// Named models (3D phase M3 "@Name"; SCRATCH importer-design §3.2: the model value's `file` is a models/ path "or @Name").
// A mod declares models once in data/models.gon (mods/fw-3d ships the empty base; a mod adds entries with
// data/models.gon.append / .merge / .patch, merged by the game's own loader in mod-path order) and a unit refers to one
// with graphics { model "@Name" } or model { file "@Name" ... } (the unit's keys override the entry's). The DLL resolves
// the reference at spawn (native/framework/src/fw_model_names.c); the validator here checks the same rules:
//   - model-name-unknown (error): an "@Name" that neither this mod's registry, the base registry (mods/fw-3d) nor a
//     native registration (editor/registered-names.json kind model) declares;
//   - model-registry-entry (error): a registry entry that is not a model (no string file, an "@" chain, not a models/
//     path, not a string or block); the entry's other keys follow the graphics.model block rules (model-scale, ...)
//     and its file the path / file / reader rules.

import { join, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateMod } from "../src/core/validate/validator.ts";
import type { ValidateOptions } from "../src/core/validate/validator.ts";
import type { Finding, Report } from "../src/core/validate/result.ts";
import { modelCodeInfo } from "../src/core/model-codes.ts";
import { MODEL_REGISTRY_FILE, MODEL_REGISTRY_BASE_MOD, registryEntryNames, baseRegistryNames } from "../src/core/model-registry.ts";
import { MODS_DIR } from "../src/core/repo.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures", "validator");
const BASE = join(FIX, "base");
const MODS = join(FIX, "mods");
const COMPONENTS = ["PlayerBrain", "Uncontrollable", "Metal"];

export function runModelNamesTests(test: TestFn, assert: AssertFn, eq: EqFn): void {
  const v = (mod: string, opts: ValidateOptions = {}): Report =>
    validateMod(mod, undefined, {
      modDir: join(MODS, mod), extractedData: BASE, components: COMPONENTS, registeredNames: [], registeredModels: [], namedModels: ["FwBase"], nativeBuild: null, ...opts,
    });
  const codes = (r: Report): string => r.findings.map((f) => `${f.code}@${f.location?.path ?? f.location?.file ?? ""}`).join(",") || "(none)";
  const only = (r: Report, code: string): Finding[] => r.findings.filter((f) => f.code === code);
  const at = (r: Report, code: string): string => only(r, code).map((f) => `${f.severity}@${f.location?.path ?? f.location?.file}`).sort().join(",");

  test("model-names: the two codes are in the shared list (DLL FW_MESH_CODES = model-codes.ts) as errors", () => {
    eq(modelCodeInfo("model-name-unknown")?.severity, "error");
    eq(modelCodeInfo("model-registry-entry")?.severity, "error");
  });
  test("model-names: the registry file and its base mod; the entry names of a registry text (a .patch strips key suffixes, like the game)", () => {
    eq(MODEL_REGISTRY_FILE, "data/models.gon");
    eq(MODEL_REGISTRY_BASE_MOD, "fw-3d");
    eq(registryEntryNames("A { file \"models/a.obj\" }\nB \"models/b.glb\"\n// c\n", "append").join(","), "A,B");
    eq(registryEntryNames("A.overwrite { file \"models/a.obj\" }", "patch").join(","), "A");
    eq(registryEntryNames("A.overwrite { file \"models/a.obj\" }", "merge").join(","), "A.overwrite");
    eq(registryEntryNames("{ unclosed", "append").join(","), "");
  });
  test("model-names: mods/fw-3d ships the base registry (data/models.gon) and the base names are read from it", () => {
    assert(existsSync(join(MODS_DIR, MODEL_REGISTRY_BASE_MOD, "data", "models.gon")), "mods/fw-3d/data/models.gon");
    const names = baseRegistryNames();
    const text = readFileSync(join(MODS_DIR, MODEL_REGISTRY_BASE_MOD, "data", "models.gon"), "utf8");
    eq([...names].sort().join(","), registryEntryNames(text, "replace").sort().join(","));
  });
  test("model-names: model-names-clean — references in both forms to this mod's entries and to a base name validate with zero findings; a .append registry has no pack base and that is fine", () => {
    const r = v("model-names-clean");
    assert(r.ok && r.findings.length === 0, `expected no findings, got ${codes(r)}`);
  });
  test("model-names: an @Name nothing declares is model-name-unknown (error) at <Entry>.graphics.model, naming the places it looked", () => {
    const r = v("model-names-bad");
    eq(at(r, "model-name-unknown"), "error@Crate.graphics.model", codes(r));
    assert(/@Nope/.test(only(r, "model-name-unknown")[0]!.message) && /data\/models\.gon/.test(only(r, "model-name-unknown")[0]!.message), only(r, "model-name-unknown")[0]!.message);
    eq(only(v("model-names-clean", { namedModels: [] }), "model-name-unknown").length, 1, "@FwBase without the base registry");
    eq(only(v("model-names-clean", { namedModels: [], registeredModels: ["FwBase"] }), "model-name-unknown").length, 0, "a native registration also declares it");
  });
  test("model-names: malformed registry entries — model-registry-entry per refused entry, the block rules and the file rules on the rest", () => {
    const r = v("model-names-bad");
    eq(at(r, "model-registry-entry"), "error@BadPath.file,error@Chain.file,error@NoFile,error@Num", codes(r));
    eq(at(r, "model-file-missing"), "error@Missing.file", codes(r));
    eq(at(r, "model-scale"), "error@BadScale.scale", codes(r));
    eq(only(r, "model-path-invalid").length, 0, `the registry's own code, not model-path-invalid: ${codes(r)}`);
    eq(only(r, "base-missing").length + only(r, "whole-file-replace").length + only(r, "unknown-status").length, 0, codes(r));
    eq(r.findings.length, 7, codes(r));   // the four entries, Missing, BadScale, @Nope — the reference to the refused Chain is not reported twice
  });
  test("model-names: a plain data/models.gon outside mods/fw-3d replaces the base registry (whole-file-replace warning); in fw-3d it is the base (no warning)", () => {
    const r = validateMod("model-names-clean", { relPath: "data/models.gon", text: "Other \"models/box.obj\"\n" }, {
      modDir: join(MODS, "model-names-clean"), extractedData: BASE, components: COMPONENTS, registeredNames: [], registeredModels: [], namedModels: ["FwBase"], nativeBuild: null,
    });
    eq(at(r, "whole-file-replace"), "warning@mods/model-names-clean/data/models.gon", codes(r));
    const fw = validateMod("fw-3d", undefined, { extractedData: BASE, components: COMPONENTS, registeredNames: [], registeredModels: [], nativeBuild: null });
    eq(only(fw, "whole-file-replace").length, 0, codes(fw));
  });
}
