// The 3D data seam (preview, API v6): the GON key `graphics.model` on a data/characters entry. T0 on the synthetic
// validator base (test/fixtures/validator/: base/characters/inanimate_objects.gon + one mod per finding code), plus
// the sample mod mods/fw-3d against the same base (T0) and against the real .extracted base (T1, skipped without it).
// The path rule is the one the native side applies (fw_obj3d_model_path_ok in native/framework/src/fw_obj3d_rules.c,
// host-tested with the same cases by native/framework/test/test_obj3d_rules.c).

import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateMod } from "../src/core/validate/validator.ts";
import type { ValidateOptions } from "../src/core/validate/validator.ts";
import type { Finding, Report } from "../src/core/validate/result.ts";
import { modelPathProblem, isRegisteredModelRef } from "../src/core/model3d.ts";
import { splitRegisteredNames, resolutionSets } from "../src/core/names.ts";
import { MODS_DIR, EXTRACTED_DATA } from "../src/core/repo.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures", "validator");
const BASE = join(FIX, "base");
const MODS = join(FIX, "mods");
const COMPONENTS = ["PlayerBrain", "Uncontrollable", "Metal"];

export function runModel3dTests(test: TestFn, assert: AssertFn, eq: EqFn): void {
  const v = (code: string, opts: ValidateOptions = {}): Report =>
    validateMod(code, undefined, {
      modDir: join(MODS, code),
      extractedData: BASE,
      components: COMPONENTS,
      registeredNames: ["JokersLuck"],
      registeredModels: ["Crate3D"],
      nativeBuild: null,
      ...opts,
    });
  const codes = (r: Report): string => r.findings.map((f) => `${f.code}@${f.location?.path ?? f.location?.file ?? ""}`).join(",") || "(none)";
  const only = (r: Report, code: string): Finding[] => r.findings.filter((f) => f.code === code);

  test("model3d: the path rule — models/<...>.obj only; .., absolute, drive, backslash, empty segment, other extension refused", () => {
    for (const ok of ["models/crate.obj", "models/props/tire.obj", "models/a b.obj", "models/crate.glb", "models/props/tire.gltf"]) eq(modelPathProblem(ok), null, ok);   // one rule with the DLL (fw_mesh_model_kind): .gltf / .glb load too
    const bad: Array<[string, RegExp]> = [
      ["crate.obj", /models\//],
      ["models/crate.fbx", /\.obj/],
      ["models/crate.GLB", /\.obj/],
      ["models/crate.OBJ.txt", /\.obj/],
      ["models/.obj", /name/],
      ["models/../crate.obj", /\.\./],
      ["models//crate.obj", /empty/],
      ["models\\crate.obj", /backslash/],
      ["/models/crate.obj", /absolute/],
      ["C:/models/crate.obj", /absolute/],
      ["", /empty/],
    ];
    for (const [p, why] of bad) {
      const problem = modelPathProblem(p);
      assert(problem !== null && why.test(problem), `${JSON.stringify(p)} -> ${problem}`);
    }
  });
  test("model3d: '@Name' is a registered-model reference, anything else is a path", () => {
    eq(isRegisteredModelRef("@Crate3D"), true);
    eq(isRegisteredModelRef("models/crate.obj"), false);
    eq(isRegisteredModelRef("@"), false);
  });
  test("model3d: registered-names.json kind 'model' goes to the model set only; other kinds (and no kind) stay general names", () => {
    const s = splitRegisteredNames([{ name: "JokersLuck", kind: "status" }, { name: "Crate3D", kind: "model", mod: "x" }, { name: "Plain" }]);
    eq([...s.names].sort().join(","), "JokersLuck,Plain");
    eq([...s.models].join(","), "Crate3D");
    const sets = resolutionSets({ root: BASE, components: new Set(COMPONENTS), registered: new Set(["JokersLuck"]), models: new Set(["Crate3D"]) });
    assert(sets.models.has("Crate3D") && !sets.statuses.has("Crate3D") && !sets.characters.has("Crate3D"), "a model name is not a status / character");
  });
  test("model3d: model-clean — a mod-relative models/*.obj (quoted and bare, nested dir) and a registered @Crate3D validate with zero findings; files under models/ are assets, not whole-file replacements", () => {
    const r = v("model-clean");
    assert(r.ok && r.findings.length === 0, `expected no findings, got ${codes(r)}`);
  });
  test("model3d: model-file-missing is an error at Crate.graphics.model naming the path under the mod", () => {
    const r = v("model-file-missing");
    const hits = only(r, "model-file-missing");
    eq(hits.length, 1, codes(r));
    eq(hits[0]!.severity, "error");
    eq(hits[0]!.location?.path, "Crate.graphics.model");
    assert(/mods\/model-file-missing\/models\/nothere\.obj/.test(hits[0]!.message), hits[0]!.message);
    assert(!r.ok, "an error");
    eq(only(r, "merge-target-missing").length, 0, "graphics.model is meant to be added by a .merge: no merge-target-missing");
  });
  test("model3d: model-path-invalid is an error per bad value (.., .fbx, a number) and no file check follows", () => {
    const r = v("model-path-invalid");
    const hits = only(r, "model-path-invalid");
    eq(hits.map((f) => f.location?.path).sort().join(","), "Crate.graphics.model,Rock.graphics.model,Tire.graphics.model", codes(r));
    for (const h of hits) eq(h.severity, "error");
    eq(only(r, "model-file-missing").length, 0, "an invalid path is not also missing");
  });
  test("model3d: model-unregistered is an error for an @name no native mod registers (kind model)", () => {
    const r = v("model-unregistered");
    const hits = only(r, "model-unregistered");
    eq(hits.length, 1, codes(r));
    eq(hits[0]!.severity, "error");
    assert(/NotRegistered/.test(hits[0]!.message), hits[0]!.message);
    eq(only(v("model-clean", { registeredModels: [] }), "model-unregistered").length, 1, "@Crate3D without the registration");
  });
  test("model3d: a `model` key outside a character's graphics block is not a model reference", () => {
    const r = validateMod("model-clean", { relPath: "data/characters/inanimate_objects.gon.merge", text: "Crate {\n\tproperties {\n\t\tmodel \"../nope\"\n\t}\n}\n" }, {
      modDir: join(MODS, "model-clean"), extractedData: BASE, components: COMPONENTS, registeredNames: [], registeredModels: [], nativeBuild: null,
    });
    eq(only(r, "model-path-invalid").length + only(r, "model-file-missing").length, 0, codes(r));
  });
  test("model3d: mods/fw-3d validates with zero findings on the synthetic base (Crate gains graphics.model, models/crate.obj present)", () => {
    const r = validateMod("fw-3d", undefined, { extractedData: BASE, components: COMPONENTS, registeredNames: [], registeredModels: [], nativeBuild: null });
    assert(r.ok && r.findings.length === 0, `expected no findings, got ${codes(r)}`);
  });
  if (existsSync(join(EXTRACTED_DATA, "characters", "inanimate_objects.gon"))) {
    test("model3d: mods/fw-3d validates with zero findings against the real base data (T1)", () => {
      const r = validateMod("fw-3d", undefined, { nativeBuild: null });
      assert(r.ok && r.findings.length === 0, `expected no findings, got ${codes(r)}`);
    });
  } else console.log("  (skipped: data/characters/inanimate_objects.gon not extracted; mods/fw-3d is checked against the synthetic base only)");
  test("model3d: the fw-3d sample ships models/crate.obj and a description", () => {
    assert(existsSync(join(MODS_DIR, "fw-3d", "models", "crate.obj")), "models/crate.obj");
    assert(existsSync(join(MODS_DIR, "fw-3d", "description.json")), "description.json");
  });
}
