// The game's .shader dialect (glaiel::Shader::compile 0xa55470) and the validator's mod-shader rule.
// T0: the dialect functions on literal sources, the validator on the fixture mods under
// test/fixtures/validator/mods/shader-* with the synthetic base shaders in test/fixtures/validator/shaders/.
// The shipped mod shaders (mods/fw-glow, mods/fw-3d) are checked too; only their #include of a base shader needs
// .extracted/shaders (T1): without it that sub-check is reported as one info and logged as "(skipped: …)".
// One T1 fidelity check: every vanilla shader that has entry points passes checkShaderSource.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  shaderStages,
  checkShaderSource,
  declaredUniforms,
  vertexAttributes,
  activeSource,
  includesOf,
  FW_MESH_UNIFORMS,
  FW_MESH_ATTRIBUTES,
  ENGINE_ATTRIBUTE_LOCATIONS,
} from "../src/core/shader/dialect.ts";
import { validateMod } from "../src/core/validate/validator.ts";
import { MODS_DIR, extractedPath } from "../src/core/repo.ts";
import type { ValidateOptions } from "../src/core/validate/validator.ts";
import type { Finding, Report } from "../src/core/validate/result.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures", "validator");
const BASE = join(FIX, "base");
const MODS = join(FIX, "mods");
const BASE_SHADERS = extractedPath("shaders");
const BASE_SHADERS_READY = existsSync(join(BASE_SHADERS, "std_in.shader"));

const SIMPLE = [
  "#version 150",
  "uniform float k;",
  "#if COMPILING_VERTEX_PROGRAM",
  "    in vec3 position;",
  "    void vert(){ gl_Position = vec4(position * k, 1.0); }",
  "#elif COMPILING_FRAGMENT_PROGRAM",
  "    out vec4 frag_color;",
  "    void frag(){ frag_color = vec4(k); }",
  "#endif",
  "",
].join("\n");

export function runShaderTests(test: TestFn, assert: AssertFn, eq: EqFn): void {
  const codes = (fs: Finding[]): string => fs.map((f) => f.code).join(",") || "(none)";

  // ---- dialect: shaderStages reproduces 0xa55470's text edits ----
  test("shader dialect: vertex stage renames ' vert()' to ' main()' and sets COMPILING_VERTEX_PROGRAM 1 / FRAGMENT 0", () => {
    const { vertex } = shaderStages(SIMPLE);
    assert(vertex.includes("void main(){ gl_Position"), vertex);
    assert(vertex.includes("#if 1\n") && vertex.includes("#elif 0\n"), vertex);
    assert(vertex.includes("void frag()"), "the fragment entry stays as written in the vertex copy (preprocessed out)");
    assert(!/COMPILING_/.test(vertex), "no flag name left");
  });
  test("shader dialect: fragment stage renames ' frag()' to ' main()' and sets VERTEX 0 / FRAGMENT 1", () => {
    const { fragment } = shaderStages(SIMPLE);
    assert(fragment.includes("void main(){ frag_color"), fragment);
    assert(fragment.includes("#if 0\n") && fragment.includes("#elif 1\n"), fragment);
    assert(fragment.includes("void vert()"), "the vertex entry stays as written in the fragment copy");
  });
  test("shader dialect: the entry rename is a single first-occurrence replace (OBSERVED 0xa55470), the flags are replace-all", () => {
    const src = "#version 150\n// a vert() call\nvoid vert(){}\nvoid vert(){}\n#if COMPILING_VERTEX_PROGRAM\n#endif\n#if COMPILING_VERTEX_PROGRAM\n#endif\n";
    const { vertex } = shaderStages(src);
    eq(vertex.split(" main()").length - 1, 1, "one rename");
    assert(vertex.includes("// a main() call"), `the first occurrence (here in a comment) is the one renamed: ${vertex}`);
    eq(vertex.split("#if 1").length - 1, 2, "both flags replaced");
  });
  test("shader dialect: identifiers that merely contain vert/frag are untouched (convert(), vertical(), ' vert ()')", () => {
    const src = "float convert(){return 1.;}\nfloat vertical(){return 2.;}\nvoid vert (){}\n";
    const { vertex } = shaderStages(src);
    eq(vertex, src, "nothing matches the 7-byte needle ' vert()'");
  });
  test("shader dialect: MATRICES_AS_ATTRIBS becomes 1 (GL_ARB_base_instance, the default) or 0", () => {
    const src = "#if MATRICES_AS_ATTRIBS\nin mat4 mvp;\n#endif\n";
    assert(shaderStages(src).vertex.startsWith("#if 1\n"), "default 1");
    assert(shaderStages(src, { matricesAsAttribs: false }).fragment.startsWith("#if 0\n"), "0 when the extension is absent");
  });
  test("shader dialect: activeSource drops the inactive #if/#elif/#else branches of a stage", () => {
    const v = activeSource(shaderStages(SIMPLE).vertex);
    assert(v.includes("in vec3 position;") && !v.includes("frag_color"), v);
    const f = activeSource(shaderStages(SIMPLE).fragment);
    assert(f.includes("frag_color") && !f.includes("in vec3 position"), f);
  });
  test("shader dialect: declaredUniforms reads both stages, comma lists, and ignores comments", () => {
    const src = "#version 150\n// uniform float ghost;\nuniform vec4 a, b;\n/* uniform int ghost2; */\n#if COMPILING_FRAGMENT_PROGRAM\nuniform int c;\n#endif\n";
    eq(declaredUniforms(src).map((u) => `${u.type} ${u.name}`).join(";"), "vec4 a;vec4 b;int c");
  });
  test("shader dialect: vertexAttributes lists the active vertex stage's global ins", () => {
    eq(vertexAttributes(SIMPLE).map((a) => `${a.type} ${a.name}`).join(";"), "vec3 position");
  });
  test("shader dialect: ENGINE_ATTRIBUTE_LOCATIONS = the glBindAttribLocation calls of 0xa55470 (by name, before link)", () => {
    eq(JSON.stringify(ENGINE_ATTRIBUTE_LOCATIONS), JSON.stringify({ position: 0, color: 1, texcoord: 2, mvp: 3, color_xform: 7, depth_bias: 9 }));
  });

  // ---- checkShaderSource ----
  test("checkShaderSource: a well-formed self-contained shader has no findings", () => {
    eq(codes(checkShaderSource(SIMPLE)), "(none)");
  });
  test("checkShaderSource: shader-entry-missing names the absent ' frag()' with its stage", () => {
    const fs = checkShaderSource(SIMPLE.replace("void frag()", "void fragment()"));
    eq(codes(fs), "shader-entry-missing");
    assert(/frag\(\)/.test(fs[0]!.message) && /fragment/.test(fs[0]!.message), fs[0]!.message);
    eq(fs[0]!.severity, "error");
  });
  test("checkShaderSource: shader-entry-shadowed when the first ' vert()' is not the definition (a comment steals the one rename)", () => {
    const fs = checkShaderSource(SIMPLE.replace("uniform float k;", "uniform float k; // calls vert() first"));
    eq(codes(fs), "shader-entry-shadowed");
    eq(fs[0]!.location?.line, 2);
  });
  test("checkShaderSource: shader-guard-missing when a stage has no #if/#elif COMPILING_* guard", () => {
    const fs = checkShaderSource(SIMPLE.replace("#elif COMPILING_FRAGMENT_PROGRAM", "#else"));
    eq(codes(fs), "shader-guard-missing");
    assert(/COMPILING_FRAGMENT_PROGRAM/.test(fs[0]!.message), fs[0]!.message);
  });
  test("checkShaderSource: shader-version-first when #version is not the first non-comment line (the engine adds none)", () => {
    eq(codes(checkShaderSource("// header comment\n" + SIMPLE)), "(none)", "comments before #version are allowed");
    const fs = checkShaderSource("uniform float x;\n" + SIMPLE);
    eq(codes(fs), "shader-version-first");
    eq(fs[0]!.location?.line, 1);
  });
  test("checkShaderSource: a library (included by another shader) needs no #version, entry points or guards", () => {
    eq(codes(checkShaderSource("vec4 f(vec4 c){ return c; }\n", { library: true })), "(none)");
  });
  test("checkShaderSource: shader-include-missing / unknown include via resolveInclude", () => {
    const src = SIMPLE.replace("uniform float k;", '#include "a.shader"\n#include "b.shader"\nuniform float k;');
    const fs = checkShaderSource(src, { resolveInclude: (n) => (n === "a.shader" ? true : n === "b.shader" ? false : null) });
    eq(codes(fs), "shader-include-missing");
    assert(/b\.shader/.test(fs[0]!.message), fs[0]!.message);
    eq(fs[0]!.location?.line, 3);
    eq(codes(checkShaderSource(src, { resolveInclude: () => null })), "shader-include-unchecked", "null = cannot tell (no base shaders)");
  });
  test("checkShaderSource: requiredUniforms flags an absent uniform and a wrong type", () => {
    const fs = checkShaderSource(SIMPLE, { requiredUniforms: [{ name: "k", type: "int" }, { name: "q", type: "vec4" }] });
    eq(codes(fs), "shader-uniform-type,shader-uniform-missing");
  });
  test("checkShaderSource: shader-attribute-unbound warns for a vertex in the engine does not bind by name", () => {
    const fs = checkShaderSource(SIMPLE.replace("in vec3 position;", "in vec3 position;\n    in vec3 a_normal;"));
    eq(codes(fs), "shader-attribute-unbound");
    eq(fs[0]!.severity, "warning");
  });

  // ---- the lead's contract ----
  test("FW_MESH_UNIFORMS is the list the native side sets with glUniform* (names + GLSL types)", () => {
    eq(FW_MESH_UNIFORMS.map((u) => `${u.type} ${u.name}`).join(";"),
      "mat4 fw_mvp;mat4 fw_model;vec3 fw_light_dir;float fw_ambient;float fw_bands;vec4 fw_base_color;sampler2D palettemap;int palette;int fw_flat;vec4 fw_cx_mul;vec4 fw_cx_add;sampler2D fw_tex;int fw_has_tex");
    eq(FW_MESH_ATTRIBUTES.map((a) => `${a.location} ${a.type} ${a.name}`).join(";"), "0 vec3 position;1 vec3 color;2 vec2 texcoord");
    for (const a of FW_MESH_ATTRIBUTES) eq(ENGINE_ATTRIBUTE_LOCATIONS[a.name as keyof typeof ENGINE_ATTRIBUTE_LOCATIONS], a.location, `${a.name} is bound by the engine to ${a.location}`);
  });

  // ---- the validator rule ----
  const v = (mod: string, opts: ValidateOptions = {}): Report =>
    validateMod(mod, undefined, { modDir: join(MODS, mod), extractedData: BASE, baseShaderDir: join(FIX, "shaders"), components: [], registeredNames: [], nativeBuild: null, ...opts });
  const one = (mod: string, code: string, severity: "error" | "warning"): Finding => {
    const r = v(mod);
    const hits = r.findings.filter((f) => f.code !== "component-list-missing");
    eq(codes(hits), code, mod);
    eq(hits[0]!.severity, severity, `${code} severity`);
    eq(hits[0]!.location?.file?.startsWith(`mods/${mod}/shaders/`), true, `located in the shader: ${JSON.stringify(hits[0]!.location)}`);
    return hits[0]!;
  };
  test("validator shaders: shader-clean (a base include + a library of its own) has zero findings and no whole-file-replace", () => {
    const r = v("shader-clean");
    eq(codes(r.findings.filter((f) => f.code !== "component-list-missing")), "(none)");
  });
  test("validator shaders: one fixture mod per code", () => {
    one("shader-entry-missing", "shader-entry-missing", "error");
    eq(one("shader-entry-shadowed", "shader-entry-shadowed", "error").location?.line, 2);
    one("shader-guard-missing", "shader-guard-missing", "error");
    eq(one("shader-version-first", "shader-version-first", "error").location?.line, 1);
    eq(one("shader-include-missing", "shader-include-missing", "error").location?.line, 3);
    one("shader-attribute-unbound", "shader-attribute-unbound", "warning");
    one("shader-base-replace", "whole-file-replace", "warning");
  });
  test("validator shaders: a mod's fw_mesh.shader must declare FW_MESH_UNIFORMS with their types", () => {
    const r = v("shader-uniform-missing");
    const hits = r.findings.filter((f) => f.code.startsWith("shader-uniform"));
    eq(hits.map((f) => `${f.code}:${/"(\w+)"/.exec(f.message)?.[1]}`).sort().join(","), "shader-uniform-missing:fw_bands,shader-uniform-type:palette");
    assert(!r.ok, "errors");
  });
  test("validator shaders: an include the mod does not ship, with no base shaders dir, is one info (not an error)", () => {
    const r = v("shader-clean", { baseShaderDir: join(FIX, "no-such-dir") });
    eq(codes(r.findings.filter((f) => f.code !== "component-list-missing")), "shader-include-unchecked");
    eq(r.findings.find((f) => f.code === "shader-include-unchecked")!.severity, "info");
    assert(r.ok, "an info keeps the mod valid");
  });

  // ---- the shipped shaders ----
  const real = (mod: string): Report => validateMod(mod, undefined, { modDir: join(MODS_DIR, mod), nativeBuild: null });
  // A shipped mod validates against base data (its variant_of parents, statuses, shader includes and .merge targets),
  // so without .extracted (CI) the whole check is skipped rather than trimmed — the repo's T1 convention.
  if (BASE_SHADERS_READY) {
    for (const mod of ["fw-glow", "fw-3d"]) {
      test(`mods/${mod} validates clean (shaders + base data)`, () => {
        const r = real(mod);
        const rest = r.findings.filter((f) => f.code !== "component-list-missing");
        eq(codes(rest), "(none)", JSON.stringify(rest));
      });
    }
  } else {
    console.log("  (skipped: mods/fw-glow and mods/fw-3d validate clean — .extracted absent; their names, statuses and shader includes resolve only against base data)");
  }
  const meshPath = join(MODS_DIR, "fw-3d", "shaders", "fw_mesh.shader");
  const mesh = existsSync(meshPath) ? readFileSync(meshPath, "utf8") : "";
  test("mods/fw-3d/shaders/fw_mesh.shader: both stages have one void main() and the right 1/0 flags", () => {
    assert(mesh !== "", `missing ${meshPath}`);
    const { vertex, fragment } = shaderStages(mesh);
    eq(vertex.split("void main()").length - 1, 1, "vertex main");
    eq(fragment.split("void main()").length - 1, 1, "fragment main");
    assert(/#if 1\b/.test(vertex) && /#elif 0\b/.test(vertex), "vertex flags");
    assert(/#if 0\b/.test(fragment) && /#elif 1\b/.test(fragment), "fragment flags");
    assert(activeSource(vertex).includes("void main()") && activeSource(fragment).includes("void main()"), "main is in the active branch of each stage");
    eq(mesh.split(/\r?\n/)[0], "#version 150", "#version 150 on line 1, like the game's");
  });
  test("mods/fw-3d/shaders/fw_mesh.shader: its uniforms are exactly FW_MESH_UNIFORMS, its attributes FW_MESH_ATTRIBUTES", () => {
    assert(mesh !== "", `missing ${meshPath}`);
    const want = FW_MESH_UNIFORMS.map((u) => `${u.type} ${u.name}`).sort().join(";");
    eq(declaredUniforms(mesh).map((u) => `${u.type} ${u.name}`).sort().join(";"), want);
    eq(vertexAttributes(mesh).map((a) => `${a.type} ${a.name}`).join(";"), FW_MESH_ATTRIBUTES.map((a) => `${a.type} ${a.name}`).join(";"));
    eq(includesOf(mesh).length, 0, "self-contained (no include: std_in's vec2 position would clash)");
  });

  // ---- T1 fidelity: the vanilla shaders follow the dialect the checker describes ----
  if (BASE_SHADERS_READY) {
    test("T1: every vanilla shader with entry points passes checkShaderSource (no error)", () => {
      const names = readdirSync(BASE_SHADERS).filter((n) => n.endsWith(".shader"));
      let checked = 0;
      const bad: string[] = [];
      for (const n of names) {
        const src = readFileSync(join(BASE_SHADERS, n), "utf8");
        if (!src.includes(" vert()")) continue; // std_in / swf_lib are libraries; cursor_latched is a #version 430 compute-style file
        checked++;
        const fs = checkShaderSource(src, { resolveInclude: (i) => existsSync(join(BASE_SHADERS, i)) }).filter((f) => f.severity === "error");
        if (fs.length) bad.push(`${n}: ${codes(fs)}`);
      }
      assert(checked >= 40, `checked ${checked}`);
      eq(bad.join(" | "), "", "no vanilla shader trips an error");
    });
  } else console.log("  (skipped: .extracted/shaders absent; vanilla-shader fidelity check)");
}
