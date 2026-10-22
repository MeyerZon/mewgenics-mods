// The game's `.shader` dialect, as glaiel::Shader::compile (0xa55470, build 25143593) turns one source file into a
// GL program, plus the static checks the validator runs over a mod's `shaders/*.shader` (docs/data-mods.md
// "Mod-shipped shaders"). Pure: no fs, no game.
//
// OBSERVED (.analysis/decompiled/Shader_compile_0xa55470.c, notes-r3dD G7):
//   - one source string per file; `#include`s are already expanded by the loader (ShaderManager_LoadShader 0x9bb220)
//     and the engine adds no `#version`, so the file's own `#version` must come first.
//   - the source is copied twice. Vertex copy: the FIRST occurrence of the 7 bytes " vert()" becomes " main()" (a
//     single find + std::string::replace, not a loop); fragment copy: the first " frag()" becomes " main()".
//   - in both copies `COMPILING_VERTEX_PROGRAM` / `COMPILING_FRAGMENT_PROGRAM` are replaced everywhere (a loop) by
//     "1"/"0" (vertex) and "0"/"1" (fragment); `MATRICES_AS_ATTRIBS` everywhere by "1" when GL_ARB_base_instance is
//     present (0xa49d20) else "0" (String_ReplaceAll 0xa55250).
//   - before linking, glBindAttribLocation(program, loc, name) for position 0, color 1, texcoord 2, mvp 3,
//     color_xform 7, depth_bias 9 — by NAME, on every program. A vertex `in` with another name gets whatever
//     location the linker picks.
// INFERRED (not witnessed): where the loader looks for an `#include`d file (base pack only, or the -modpaths too);
// that a mod shader's compile/link failure only logs (via 0x951bc0, Shader.cpp) and leaves a broken material.

import type { Finding, SourceLocation } from "../validate/result.ts";
import { finding } from "../validate/result.ts";

/** The engine's glBindAttribLocation calls in 0xa55470 (OBSERVED), by name; mat4 mvp spans 3..6, mat2x4 color_xform 7..8. */
export const ENGINE_ATTRIBUTE_LOCATIONS = { position: 0, color: 1, texcoord: 2, mvp: 3, color_xform: 7, depth_bias: 9 } as const;

export interface GlslDecl {
  name: string;
  /** GLSL type as written, e.g. "vec4", "sampler2D" */
  type: string;
}

/**
 * The uniforms mewframework's mesh renderer sets with glUniform* on material "fw_mesh" (fw_mesh.shader): the
 * contract between mods/fw-3d/shaders/fw_mesh.shader and the native side. Matrices are column-major (transpose
 * GL_FALSE); `palette` < 0 = no palette remap; `fw_flat` != 0 = output fw_base_color unlit; `fw_tex` (unit 0) is
 * sampled with the mesh's uvs when `fw_has_tex` != 0, `palettemap` is on unit 1; `fw_clip` = [lo, hi) of world x + z this draw keeps (M3 per-band slices: a
 * fragment outside is discarded; ±1e30 = open).
 */
export const FW_MESH_UNIFORMS: readonly GlslDecl[] = [
  { name: "fw_mvp", type: "mat4" },
  { name: "fw_model", type: "mat4" },
  { name: "fw_light_dir", type: "vec3" },
  { name: "fw_ambient", type: "float" },
  { name: "fw_bands", type: "float" },
  { name: "fw_base_color", type: "vec4" },
  { name: "palettemap", type: "sampler2D" },
  { name: "palette", type: "int" },
  { name: "fw_flat", type: "int" },
  { name: "fw_cx_mul", type: "vec4" },
  { name: "fw_cx_add", type: "vec4" },
  { name: "fw_tex", type: "sampler2D" },
  { name: "fw_has_tex", type: "int" },
  { name: "fw_clip", type: "vec2" },
];

/** The mesh VBO layout (stride 32): the names are the engine's, so its by-name binds give exactly these locations. */
export const FW_MESH_ATTRIBUTES: readonly (GlslDecl & { location: number; carries: string })[] = [
  { location: 0, name: "position", type: "vec3", carries: "model-space position" },
  { location: 1, name: "color", type: "vec3", carries: "model-space normal" },
  { location: 2, name: "texcoord", type: "vec2", carries: "uv" },
];

/** Uniforms a shader file must declare because native code sets them by name, keyed by the file name. */
export const EXPECTED_UNIFORMS: Readonly<Record<string, readonly GlslDecl[]>> = { "fw_mesh.shader": FW_MESH_UNIFORMS };

function replaceFirst(s: string, find: string, repl: string): string {
  const i = s.indexOf(find);
  return i < 0 ? s : s.slice(0, i) + repl + s.slice(i + find.length);
}

/** The vertex and fragment sources 0xa55470 hands to glShaderSource for an (include-expanded) `.shader` source. */
export function shaderStages(src: string, opts: { matricesAsAttribs?: boolean } = {}): { vertex: string; fragment: string } {
  const m = opts.matricesAsAttribs === false ? "0" : "1";
  const flags = (s: string, v: string, f: string): string =>
    s.split("COMPILING_VERTEX_PROGRAM").join(v).split("COMPILING_FRAGMENT_PROGRAM").join(f).split("MATRICES_AS_ATTRIBS").join(m);
  return {
    vertex: flags(replaceFirst(src, " vert()", " main()"), "1", "0"),
    fragment: flags(replaceFirst(src, " frag()", " main()"), "0", "1"),
  };
}

/** Blank out // and /* *\/ comments, keeping every newline (so offsets map to the same lines). */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (c) => c.replace(/[^\r\n]/g, " "));
}

/** `#if` condition after the dialect's replacements: literal numbers are decided, anything else is unknown (null). */
function condition(expr: string): boolean | null {
  const e = expr.trim();
  if (/^\d+$/.test(e)) return Number(e) !== 0;
  const neg = /^!\s*(\d+)$/.exec(e);
  if (neg) return Number(neg[1]) === 0;
  return null;
}

/**
 * The lines of one stage that survive its preprocessor, with directives and inactive lines blanked (line numbers
 * kept). Only literal conditions are decided (what `shaderStages` leaves); an unknown condition keeps both branches.
 */
export function activeSource(stageSrc: string): string {
  const lines = stageSrc.split(/\r?\n/);
  const stack: Array<{ parent: boolean; taken: boolean; active: boolean }> = [];
  const live = (): boolean => (stack.length ? stack[stack.length - 1]!.active : true);
  const out: string[] = [];
  for (const line of stripComments(lines.join("\n")).split("\n")) {
    const d = /^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b(.*)$/.exec(line);
    if (!d) {
      out.push(live() ? line : "");
      continue;
    }
    const [, kw, rest] = d;
    if (kw === "if" || kw === "ifdef" || kw === "ifndef") {
      const parent = live();
      const c = kw === "if" ? condition(rest!) : null;
      stack.push({ parent, taken: c === true, active: parent && c !== false });
    } else if (kw === "elif") {
      const top = stack[stack.length - 1];
      if (top) {
        if (top.taken) top.active = false;
        else {
          const c = condition(rest!);
          top.active = top.parent && c !== false;
          top.taken = c === true;
        }
      }
    } else if (kw === "else") {
      const top = stack[stack.length - 1];
      if (top) top.active = top.parent && !top.taken;
    } else stack.pop();
    out.push("");
  }
  return out.join("\n");
}

function declsOf(text: string, re: RegExp): GlslDecl[] {
  const out: GlslDecl[] = [];
  for (const m of text.matchAll(re)) {
    for (const part of m[2]!.split(",")) {
      const name = part.replace(/=.*$/s, "").replace(/\[.*$/s, "").trim();
      if (/^\w+$/.test(name)) out.push({ name, type: m[1]! });
    }
  }
  return out;
}

const UNIFORM_RE = /\buniform\s+(?:(?:lowp|mediump|highp)\s+)?(\w+)\s+([^;]+);/g;
const IN_RE = /^[ \t]*in\s+(?:(?:flat|smooth|noperspective|lowp|mediump|highp)\s+)*(\w+)\s+([^;(){}]+);/gm;

/** Uniforms declared in the active text of either stage, first declaration wins, vertex stage first. */
export function declaredUniforms(src: string): GlslDecl[] {
  const { vertex, fragment } = shaderStages(src);
  const seen = new Map<string, GlslDecl>();
  for (const stage of [vertex, fragment]) for (const u of declsOf(activeSource(stage), UNIFORM_RE)) if (!seen.has(u.name)) seen.set(u.name, u);
  return [...seen.values()];
}

/** The global `in` declarations of the active vertex stage: the vertex attributes. */
export function vertexAttributes(src: string): GlslDecl[] {
  return declsOf(activeSource(shaderStages(src).vertex), IN_RE);
}

/** The `#include "name"` directives outside comments, with the offset of each. */
export function includesOf(src: string): Array<{ name: string; index: number }> {
  return [...stripComments(src).matchAll(/^[ \t]*#[ \t]*include[ \t]+"([^"]+)"/gm)].map((m) => ({ name: m[1]!, index: m.index }));
}

export interface ShaderCheckOptions {
  /** the file is `#include`d by another shader: it needs no #version, entry points or stage guards of its own */
  library?: boolean;
  /** true = found, false = missing, null = cannot tell (no base shaders to look in); omitted = includes not checked */
  resolveInclude?: (name: string) => boolean | null;
  /** uniforms native code sets by name on this shader (EXPECTED_UNIFORMS[file]) */
  requiredUniforms?: readonly GlslDecl[];
  /** added to every finding's location */
  file?: string;
}

/** Static checks of one `.shader` source against the dialect; findings carry 1-based lines. */
export function checkShaderSource(src: string, opts: ShaderCheckOptions = {}): Finding[] {
  const out: Finding[] = [];
  const at = (index?: number): SourceLocation => {
    const loc: SourceLocation = {};
    if (opts.file) loc.file = opts.file;
    if (index !== undefined) loc.line = src.slice(0, index).split("\n").length;
    return loc;
  };
  const bare = stripComments(src);

  if (!opts.library) {
    const first = /\S/.exec(bare);
    if (!first || !/^#\s*version\b/.test(bare.slice(first.index))) {
      out.push(finding("error", "shader-version-first", "#version must be the first line (comments aside): the engine adds none and the included files' text goes where their #include is", at(first?.index)));
    }
    for (const [needle, stage] of [[" vert()", "vertex"], [" frag()", "fragment"]] as const) {
      const entry = needle.trim();
      const i = src.indexOf(needle);
      if (i < 0) {
        out.push(finding("error", "shader-entry-missing", `no "void ${entry}" entry point: the engine makes the ${stage} stage's main() by renaming the first " ${entry}" (with the space before it, exactly)`, at()));
      } else if (!(src.slice(Math.max(0, i - 4), i) === "void" && /^\s*\{/.test(src.slice(i + needle.length)))) {
        const def = new RegExp(`void ${entry.replace(/[()]/g, "\\$&")}\\s*\\{`).exec(src);
        out.push(finding("error", "shader-entry-shadowed", `the first " ${entry}" is not the "void ${entry} {" definition, but the engine renames only the first one to main() for the ${stage} stage${def ? ` (the definition at line ${at(def.index).line} keeps its name)` : ""}; reword it`, at(i)));
      }
      const flag = stage === "vertex" ? "COMPILING_VERTEX_PROGRAM" : "COMPILING_FRAGMENT_PROGRAM";
      if (!new RegExp(`^[ \\t]*#[ \\t]*(if|elif)[ \\t]+${flag}\\b`, "m").test(bare)) {
        out.push(finding("error", "shader-guard-missing", `no "#if ${flag}" / "#elif ${flag}" guard: both stages compile the same text, so the ${stage}-only code must sit under it (the game's shaders use #if COMPILING_VERTEX_PROGRAM ... #elif COMPILING_FRAGMENT_PROGRAM ... #endif)`, at()));
      }
    }
  }

  if (opts.resolveInclude) {
    const unknown: string[] = [];
    let firstUnknown: number | undefined;
    for (const inc of includesOf(src)) {
      const r = opts.resolveInclude(inc.name);
      if (r === false) out.push(finding("error", "shader-include-missing", `#include "${inc.name}" is neither in this mod's shaders/ nor a base shader`, at(inc.index)));
      else if (r === null) {
        unknown.push(inc.name);
        firstUnknown ??= inc.index;
      }
    }
    if (unknown.length) out.push(finding("info", "shader-include-unchecked", `not checked (no extracted base shaders, .extracted/shaders): #include ${unknown.map((n) => `"${n}"`).join(", ")}`, at(firstUnknown)));
  }

  if (opts.requiredUniforms) {
    const have = new Map(declaredUniforms(src).map((u) => [u.name, u.type]));
    for (const u of opts.requiredUniforms) {
      const t = have.get(u.name);
      if (t === undefined) out.push(finding("error", "shader-uniform-missing", `uniform "${u.name}" (${u.type}) is set by native code but not declared`, at()));
      else if (t !== u.type) out.push(finding("error", "shader-uniform-type", `uniform "${u.name}" is declared ${t}; native code sets it as ${u.type}`, at()));
    }
  }

  for (const a of vertexAttributes(src)) {
    if (!(a.name in ENGINE_ATTRIBUTE_LOCATIONS)) {
      out.push(finding("warning", "shader-attribute-unbound", `vertex input "${a.name}" is not one of the names the engine binds before linking (${Object.keys(ENGINE_ATTRIBUTE_LOCATIONS).join(", ")}): its location is the linker's choice`, at()));
    }
  }
  return out;
}
