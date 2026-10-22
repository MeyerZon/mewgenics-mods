// OBJ subset reader — the editor twin of the DLL's fw_mesh_obj_parse (native/framework/src/fw_mesh_rules.c, branch
// feat/3d-meshes-m1): same statements, same limits, same error words ("face index 7 out of range (3 vertices) at line
// 4"), so the validator rejects exactly what the engine would (docs/3d-importer-design.md "OBJ").
//
// Design borrowed / rejected (docs/3d-importer-design.md cites the lines):
// - one pass over a whole in-memory buffer, line at a time, tokens as slices (Blender's OBJParser::parse_string_buffer
//   + IO_string_utils: mmap'd text, `parse_keyword`, no per-line allocation) — not Godot's split("/") per corner;
// - negative indices relative to the count so far (Blender parse_vertex_index; Godot `vtx += vertices.size() + 1`);
// - n-gons fan-triangulated (Godot's OBJ importer, face[0], face[i], face[i+1]); Blender keeps n-gons and repairs
//   invalid ones with a constrained Delaunay — too big for the DLL, so here a concave n-gon is a WARNING instead;
// - corners deduplicated on (v, vt, vn) (Godot SurfaceTool::index, Blender's per-corner loops);
// - strict where Blender is lenient: Blender warns and drops a face with a bad index (CLOG_WARN "Invalid vertex
//   index"), Godot fails the whole import (ERR_FAIL_INDEX_V); a silent hole in a prop is worse than a clear refusal,
//   so both the DLL and this reader refuse with the line;
// - vt v is flipped (v' = 1 - v, Godot: `uv.y = 1.0 - v[2].to_float()`): OBJ's texture origin is bottom-left, the
//   game's textures are uploaded top row first (stb_image, Texture2D_LoadFromFile 0xa0ad40) like glTF's top-left
//   origin, so every mesh carries image-convention uvs.
// - o / g / s / usemtl / mtllib are read as no-ops (v1 draws one material); a second usemtl warns.

import { ModelStop, MODEL_LIMITS, emptyStats, polygonIsConvex } from "./model-read.ts";
import type { ModelRead, ModelFinding } from "./model-read.ts";

const IGNORED = new Set(["o", "g", "s", "mg", "mtllib", "usemtl", "maplib", "usemap", "lod", "bevel", "c_interp", "d_interp", "shadow_obj", "trace_obj", "ctech", "stech"]);
const UNSUPPORTED = new Set(["l", "p", "curv", "curv2", "surf", "vp", "cstype", "deg", "bmat", "step", "parm", "trim", "hole", "scrv", "sp", "end", "con"]);
const WS = /[ \t\r\v\f]+/;
const FLOAT_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const INT_RE = /^[+-]?\d+$/;
const FLT_MAX = 3.4028234663852886e38;

const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

function parseFloatTok(t: string): number | null {
  if (!FLOAT_RE.test(t)) return null;
  const v = Number(t);
  if (!Number.isFinite(v) || Math.abs(v) > FLT_MAX) return null;
  return Math.fround(v);
}
function parseIntTok(t: string): number | null {
  if (!INT_RE.test(t)) return null;
  const v = Number(t);
  return Math.abs(v) > 0x7fffffff ? null : v;
}

export function readObj(text: string): ModelRead {
  const findings: ModelFinding[] = [];
  const pos: number[] = [], tex: number[] = [], nrm: number[] = [];
  const outPos: number[] = [], outUv: number[] = [], outNrm: number[] = [];
  const indices: number[] = [];
  const dedup = new Map<string, number>();
  let allNormals = true, anyUv = false, mtllib = false;
  const materials = new Set<string>();
  let concave = 0, firstConcaveLine = 0;
  let line = 0;
  const lim = (what: string, max: number): never => { throw new ModelStop("model-limit", `more than ${max} ${what} (limit) at line ${line}`, line); };
  const err = (msg: string): never => { throw new ModelStop("model-parse-error", msg, line); };

  const numbers = (toks: string[], kw: string, min: number, max: number): number[] => {
    const out: number[] = [];
    for (const t of toks) {
      const f = parseFloatTok(t);
      if (f === null) err(`not a number '${cut(t, 40)}' in '${kw}' at line ${line}`);
      if (out.length >= max) err(`too many numbers in '${kw}' (max ${max}) at line ${line}`);
      out.push(f!);
    }
    if (out.length < min) err(`'${kw}' needs ${min} numbers, got ${out.length} at line ${line}`);
    return out;
  };
  const resolve = (v: number, count: number, what: string, plural: string): number => {
    if (v === 0) err(`face ${what}index 0 is invalid (OBJ indices start at 1) at line ${line}`);
    const r = v > 0 ? v - 1 : count + v;
    if (r < 0 || r >= count) err(`face ${what}index ${v} out of range (${count} ${plural}) at line ${line}`);
    return r;
  };
  const corner = (tok: string): [number, number, number] => {
    const parts = tok.split("/");
    if (parts.length > 3) err(`bad face corner '${cut(tok, 40)}' at line ${line}`);
    const v: (number | null)[] = [null, null, null];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      if (p === "") {
        if (i === 1 && parts.length === 3) continue; // i//k
        err(`bad face corner '${cut(tok, 40)}' at line ${line}`);
      }
      const n = parseIntTok(p);
      if (n === null) err(`not an index '${cut(tok, 40)}' at line ${line}`);
      v[i] = n;
    }
    const pi = resolve(v[0]!, pos.length / 3, "", "vertices");
    const ti = v[1] === null ? -1 : resolve(v[1], tex.length / 2, "texcoord ", "texcoords");
    const ni = v[2] === null ? -1 : resolve(v[2], nrm.length / 3, "normal ", "normals");
    return [pi, ti, ni];
  };

  try {
    let src = text;
    if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
    const lines = src.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    for (const raw of lines) {
      line++;
      let l = raw;
      const hash = l.indexOf("#");
      if (hash >= 0) l = l.slice(0, hash);
      l = l.replace(/[ \t\r\v\f]+$/, "");
      if (l.endsWith("\\")) err(`line continuation '\\' is not supported at line ${line}`);
      const toks = l.split(WS).filter((t) => t !== "");
      if (toks.length === 0) continue;
      const kw = toks[0]!, rest = toks.slice(1);
      if (kw === "v") {
        if (pos.length / 3 >= MODEL_LIMITS.maxVertices) lim("vertices", MODEL_LIMITS.maxVertices);
        const f = numbers(rest, "v", 3, 7);
        pos.push(f[0]!, f[1]!, f[2]!);
      } else if (kw === "vt") {
        if (tex.length / 2 >= MODEL_LIMITS.maxVertices) lim("texcoords", MODEL_LIMITS.maxVertices);
        const f = numbers(rest, "vt", 1, 3);
        tex.push(f[0]!, f[1] ?? 0);
      } else if (kw === "vn") {
        if (nrm.length / 3 >= MODEL_LIMITS.maxVertices) lim("normals", MODEL_LIMITS.maxVertices);
        const f = numbers(rest, "vn", 3, 3);
        nrm.push(f[0]!, f[1]!, f[2]!);
      } else if (kw === "f") {
        const face: number[] = [];
        const facePts: number[][] = [];
        for (const t of rest) {
          const [pi, ti, ni] = corner(t);
          if (ti >= 0) anyUv = true;
          if (ni < 0) allNormals = false;
          const key = `${pi}/${ti}/${ni}`;
          let vi = dedup.get(key);
          if (vi === undefined) {
            vi = outPos.length / 3;
            if (vi >= MODEL_LIMITS.maxVertices) lim("mesh vertices", MODEL_LIMITS.maxVertices);
            dedup.set(key, vi);
            outPos.push(pos[3 * pi]!, pos[3 * pi + 1]!, pos[3 * pi + 2]!);
            if (ti >= 0) outUv.push(tex[2 * ti]!, 1 - tex[2 * ti + 1]!); else outUv.push(0, 0);
            if (ni >= 0) {
              const x = nrm[3 * ni]!, y = nrm[3 * ni + 1]!, z = nrm[3 * ni + 2]!;
              const len = Math.hypot(x, y, z);
              if (len > 1e-20) outNrm.push(x / len, y / len, z / len); else outNrm.push(0, 1, 0);
            } else outNrm.push(0, 0, 0);
          }
          face.push(vi);
          facePts.push([pos[3 * pi]!, pos[3 * pi + 1]!, pos[3 * pi + 2]!]);
        }
        if (face.length < 3) err(`a face needs at least 3 corners, got ${face.length} at line ${line}`);
        if (indices.length + 3 * (face.length - 2) > MODEL_LIMITS.maxIndices) lim("indices", MODEL_LIMITS.maxIndices);
        if (face.length > 3 && !polygonIsConvex(facePts)) { concave++; if (!firstConcaveLine) firstConcaveLine = line; }
        for (let i = 1; i + 1 < face.length; i++) indices.push(face[0]!, face[i]!, face[i + 1]!);
      } else if (IGNORED.has(kw)) {
        if (kw === "usemtl" && rest.length) materials.add(rest.join(" "));
        if (kw === "mtllib") mtllib = true;
      } else if (UNSUPPORTED.has(kw)) {
        err(`unsupported OBJ statement '${kw}' at line ${line}`);
      } else {
        err(`unknown OBJ statement '${cut(kw, 24)}' at line ${line}`);
      }
    }
    line = 0;
    if (indices.length === 0) throw new ModelStop("model-parse-error", "no faces");
  } catch (e) {
    if (e instanceof ModelStop) return { format: "obj", mesh: null, materials: [], primitiveMaterials: [], findings: [e.finding], stats: emptyStats() };
    throw e;
  }

  if (!allNormals) findings.push({ code: "model-no-normals", severity: "info", message: "not every face corner names a vn: the engine gives every triangle its flat face normal (export with Normals on for smooth shading)" });
  if (materials.size > 1) findings.push({ code: "model-multi-material", severity: "warning", message: `${materials.size} materials (${[...materials].slice(0, 4).join(", ")}): v1 draws the whole model with one colour/texture — join them into one material in Blender` });
  if (mtllib) findings.push({ code: "model-mtl-ignored", severity: "info", message: "mtllib is not read: an OBJ model's colour and texture come from the GON model settings" });
  if (concave) findings.push({ code: "model-ngon-concave", severity: "warning", message: `${concave} concave or degenerate n-gon(s), first at line ${firstConcaveLine}: the fan triangulation will draw them wrong — triangulate on export (Blender OBJ export: Geometry > Triangulated Mesh)`, line: firstConcaveLine });

  const nverts = outPos.length / 3;
  return {
    format: "obj",
    mesh: {
      positions: new Float32Array(outPos),
      normals: allNormals ? new Float32Array(outNrm) : null,
      uvs: anyUv ? new Float32Array(outUv) : null,
      indices: new Uint32Array(indices),
    },
    materials: [],
    primitiveMaterials: [],
    findings,
    stats: { vertices: nverts, triangles: indices.length / 3, meshes: 1, primitives: 1, nodes: 0 },
  };
}
