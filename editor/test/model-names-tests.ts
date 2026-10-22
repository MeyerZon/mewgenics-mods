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
import { MODEL_REGISTRY_FILE, MODEL_REGISTRY_BASE_MOD, registryEntryNames, baseRegistryNames, parseModelNamesLog } from "../src/core/model-registry.ts";
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

  // ---- the DLL's log lines and the T2 pins (2026-10-22, build 25143593, mods/_modelnames/tests/model-names.mewtest) ----
  test("model-names: parseModelNamesLog reads the load line, the resolution lines and the coded error lines (any log prefix)", () => {
    const p = parseModelNamesLog([
      "[19:06:28.829] [mewframework] model names: data/models.gon: 2 entries: FwCrate, NameBox (GonResource 000001d0d5428270)",
      "unit model: Rat: @NameBox -> data/models.gon entry NameBox",
      "unit model: Rat 000001daf9397708 -> models/name-box.gltf (block scale=1.25 yaw=45 offset=(0 0 0))",
      "mesh: @NoSuchModel: model-name-unknown: no data/models.gon entry named NoSuchModel (unit Pooter; 2 named models) — drawing the 2D clip",
      "mesh: @Chain: model-registry-entry: data/models.gon entry Chain names another @Name (@Box); an entry must name a models/<...>.obj|.gltf|.glb file (unit Rat) — drawing the 2D clip",
      "mesh: models/x.obj: model-file-missing: not found — drawing the 2D clip",
    ].join("\n"));
    eq(JSON.stringify(p.registry), JSON.stringify({ entries: ["FwCrate", "NameBox"], absent: false, unreadable: false }));
    eq(JSON.stringify(p.resolved), JSON.stringify([{ unit: "Rat", ref: "@NameBox", entry: "NameBox" }]));
    eq(p.errors.map((e) => `${e.ref}:${e.code}:${e.unit}`).join(","), "@NoSuchModel:model-name-unknown:Pooter,@Chain:model-registry-entry:Rat");
    eq(JSON.stringify(parseModelNamesLog("model names: data/models.gon: 1 entry: FwCrate (GonResource 0)").registry?.entries), JSON.stringify(["FwCrate"]));
    eq(parseModelNamesLog("model names: data/models.gon: absent (no mod on the mod path ships it; mods/fw-3d has the base) (GonResource 0000000000000000)").registry?.absent, true);
    eq(parseModelNamesLog("model names: data/models.gon: unreadable (GonResource 1)").registry?.unreadable, true);
    eq(parseModelNamesLog("nothing here").registry, null);
  });
  const fx = (n: string): string | null => { try { return readFileSync(join(HERE, "fixtures", "ingame", n), "utf8"); } catch { return null; } };
  test("model-names-log.txt (T2, 2026-10-22, mods fw-3d, _modelnames, dev-sandbox): data/models.gon read through Gon_LoadFile = fw-3d's base + _modelnames's .append; the Rat's @NameBox resolves with its own scale over the entry's; two Pooters give ONE model-name-unknown line and no registration", () => {
    const text = fx("model-names-log.txt");
    assert(text !== null, "fixtures/ingame/model-names-log.txt is pinned");
    const p = parseModelNamesLog(text!);
    eq(JSON.stringify(p.registry), JSON.stringify({ entries: ["FwCrate", "NameBox"], absent: false, unreadable: false }));
    eq(JSON.stringify(p.resolved), JSON.stringify([{ unit: "Rat", ref: "@NameBox", entry: "NameBox" }]));
    assert(/unit model: Rat \S+ -> models\/name-box\.gltf \(block scale=1\.25 yaw=45 offset=\(0 0 0\)\)/.test(text!), "the unit's scale 1.25 over NameBox's 0.8, NameBox's yaw 45 kept");
    eq(p.errors.map((e) => `${e.ref}:${e.code}:${e.unit}`).join(","), "@NoSuchModel:model-name-unknown:Pooter");
    eq((text!.match(/model-name-unknown/g) ?? []).length, 1, "exactly one coded line for two Pooters");
    eq((text!.match(/Spawned Pooter/g) ?? []).length, 2, "both Pooters were spawned");
    assert(/Register3DObject\(\S+, models\/name-box\.gltf\): ok/.test(text!) && !/Register3DObject\([^)]*@/.test(text!), "only the resolved path is registered");
    assert(/mesh object f=\d+ handle=1 model=models\/name-box\.gltf unit /.test(text!), "the box is drawn on the Rat");
  });
  test("model-names-order-log.txt (T2, 2026-10-22, mods _modelnames, fw-3d, dev-sandbox): an overlay on a mod path listed BEFORE the one holding the base file is dropped by the loader — only fw-3d's FwCrate, both references unknown", () => {
    const text = fx("model-names-order-log.txt");
    assert(text !== null, "fixtures/ingame/model-names-order-log.txt is pinned");
    const p = parseModelNamesLog(text!);
    eq(JSON.stringify(p.registry?.entries), JSON.stringify(["FwCrate"]));
    eq(p.errors.map((e) => `${e.ref}:${e.code}:${e.unit}`).join(","), "@NameBox:model-name-unknown:Rat,@NoSuchModel:model-name-unknown:Pooter");
    const paths = [...text!.matchAll(/Mod Path: .*[\\/]mods[\\/](\S+)/g)].map((m) => m[1]);
    eq(paths.join(","), "_modelnames,fw-3d,dev-sandbox");
  });
  test("model-names-summary.json (T2, 2026-10-22): run pass, the real save unchanged, the magenta NameBox drawn at the Rat's anchor in both shots; its pixel count is the M2 unit box's x 1.25^2 (the unit's scale override reached the draw)", () => {
    const text = fx("model-names-summary.json");
    assert(text !== null, "fixtures/ingame/model-names-summary.json is pinned");
    const s = JSON.parse(text!) as { run: { verdict: string; save: string }; measures: Array<{ shot: string; magentaInBox: number; magentaWholeShot: number }> };
    eq(s.run.verdict, "pass");
    assert(/1 real save file\(s\) unchanged/.test(s.run.save), s.run.save);
    eq(s.measures.length, 2);
    const m2 = JSON.parse(fx("unit-model-summary.json") ?? "null") as { pairs: Array<{ a: string; b: string; patchA: { count: number } }> } | null;
    const base = m2?.pairs.find((q) => q.a === "unit-a" && q.b === "unit-m")?.patchA.count ?? 13935;   // the M2 unit box (scale 1) on the same Rat tile
    for (const m of s.measures) {
      assert(m.magentaInBox >= 15000, `${m.shot}: ${m.magentaInBox} magenta px at the Rat's anchor`);
      eq(m.magentaInBox, m.magentaWholeShot, `${m.shot}: every magenta pixel of the shot is at the Rat`);
      const ratio = m.magentaInBox / base;
      assert(Math.abs(ratio - 1.5625) < 0.08, `${m.shot}: ${m.magentaInBox}/${base} = ${ratio.toFixed(3)} (expected 1.25^2 = 1.5625)`);
    }
  });
}
