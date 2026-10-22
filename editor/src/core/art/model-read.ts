// 3D model readers for a mod's models/<name>.obj|.gltf|.glb — the editor half of the importer design
// (docs/3d-importer-design.md). Pure: bytes in, a merged triangle mesh + findings out; no fs, no DOM, no Node Buffer,
// so the same code serves the validator, the MCP server and the browser preview.
//
// Shape of the pipeline (Godot's two-phase design, modules/gltf/gltf_document.cpp: _parse_gltf_state -> generate_scene;
// here parse -> one flattened TriMesh, because the engine draws one VBO per model):
//   readObj / readGltf  -> TriMesh in FILE axes (right-handed, +Y up, CCW front faces; uv origin top-left)
//   toGameAxes(mesh, s) -> the game's (x, height, z), left-handed: z mirrored and every triangle reversed
//   modelBudgetFindings / isoWireframeSvg on the game-axes mesh.
// Finding codes are `model-*` (docs/3d-importer-design.md "Error taxonomy"); the DLL logs the same code in its line.

import { readObj } from "./obj-read.ts";
import { readGltf } from "./gltf-read.ts";

/** A flattened triangle mesh. positions/normals: 3 floats per vertex, uvs: 2 (origin top-left, the glTF/image
 *  convention), indices: 3 per triangle. normals / uvs are null when the file had none for some vertex. */
export interface TriMesh { positions: Float32Array; normals: Float32Array | null; uvs: Float32Array | null; indices: Uint32Array }
export type ModelSeverity = "error" | "warning" | "info";
export interface ModelFinding { code: string; severity: ModelSeverity; message: string; line?: number }
/** A base-colour texture: an external uri (relative to the model file), or the embedded bytes of a .glb image. */
export interface ModelTexture { uri?: string; mimeType?: string; embedded?: Uint8Array; texCoord: number }
export interface ModelMaterial {
  name?: string;
  /** glTF baseColorFactor (LINEAR, spec 3.9.2) or OBJ "Kd"; default 1,1,1,1 */
  baseColor: [number, number, number, number];
  texture: ModelTexture | null;
  alphaMode: "OPAQUE" | "MASK" | "BLEND";
  alphaCutoff: number;
  doubleSided: boolean;
}
export interface ModelStats { vertices: number; triangles: number; meshes: number; primitives: number; nodes: number }
export interface ModelRead {
  format: "obj" | "gltf" | "glb" | "unknown";
  /** null when an error finding stopped the read */
  mesh: TriMesh | null;
  materials: ModelMaterial[];
  /** per merged primitive, in draw order: its index into `materials` (-1 = the default material) */
  primitiveMaterials: number[];
  findings: ModelFinding[];
  stats: ModelStats;
}

/** Caps shared with the DLL (docs/3d-importer-design.md "Limits"). The hard ones refuse the file; budgetTriangles warns. */
export const MODEL_LIMITS = {
  maxFileBytes: 16 << 20,          // a prop is ~0.1-1 MB; 16 MiB is a misdirected file, not a model
  maxVertices: 1 << 20,            // FW_MESH_MAX_VERTS (fw_mesh_rules.h): a misread count, not a prop
  maxIndices: 3 << 20,             // FW_MESH_MAX_INDICES
  maxNodes: 1024,
  maxNodeDepth: 64,
  maxPrimitives: 256,
  budgetTriangles: 5000,           // per model: ~4 px² per triangle on a ~100 px tile at the fight zoom
  maxTextureSide: 1024,
  belowFloor: -0.01,               // h below this = the model sinks into the floor (origin not at the feet)
  footprint: 0.5,                  // |x| or |z| beyond this (+ eps) = wider than its tile
};

export function emptyStats(): ModelStats { return { vertices: 0, triangles: 0, meshes: 0, primitives: 0, nodes: 0 }; }

/** The reader's internal stop: an error finding that ends the read (caught by the reader, never escapes). */
export class ModelStop extends Error {
  finding: ModelFinding;
  constructor(code: string, message: string, line?: number) {
    super(message);
    this.finding = line === undefined ? { code, severity: "error", message } : { code, severity: "error", message, line };
  }
}

/** Dispatch on the extension, as the GON `model` path names it. */
export function readModel(relPath: string, bytes: Uint8Array, resolve?: (uri: string) => Uint8Array | null): ModelRead {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(relPath)?.[1] ?? "").toLowerCase();
  if (bytes.length > MODEL_LIMITS.maxFileBytes) {
    return failed("unknown", "model-limit", `${relPath}: ${bytes.length} bytes is more than the ${MODEL_LIMITS.maxFileBytes}-byte limit`);
  }
  if (ext === "obj") return readObj(new TextDecoder("utf-8").decode(bytes));
  if (ext === "glb") {
    if (!(bytes.length >= 4 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46)) {
      return failed("glb", "model-glb-header", "This file is not a glTF/glb file (no 'glTF' magic)");
    }
    return readGltf(bytes, resolve ? { resolve } : {});
  }
  if (ext === "gltf") return readGltf(bytes, resolve ? { resolve } : {});
  return failed("unknown", "model-extension", `${relPath}: a model is .obj, .gltf or .glb, not '.${ext}'`);
}

export function failed(format: ModelRead["format"], code: string, message: string): ModelRead {
  return { format, mesh: null, materials: [], primitiveMaterials: [], findings: [{ code, severity: "error", message }], stats: emptyStats() };
}

/** File axes (right-handed, +Y up) -> game axes (x, height, z; left-handed): x_g = s·x, h = s·y, z_g = -s·z, normals
 *  mirrored the same way, every triangle reversed (a reflection flips winding). The same rule as the DLL's
 *  fw_mesh_to_game_axes (native/framework/src/fw_mesh_rules.h) and Godot's det < 0 swap in
 *  ImporterMesh::merge_importer_meshes. Returns a new mesh; scale <= 0 or NaN counts as 1. */
export function toGameAxes(m: TriMesh, scale = 1): TriMesh {
  const s = scale > 0 ? scale : 1;
  const p = new Float32Array(m.positions.length);
  for (let i = 0; i < p.length; i += 3) { p[i] = s * m.positions[i]!; p[i + 1] = s * m.positions[i + 1]!; p[i + 2] = -s * m.positions[i + 2]!; }
  let n: Float32Array | null = null;
  if (m.normals) {
    n = new Float32Array(m.normals.length);
    for (let i = 0; i < n.length; i += 3) { n[i] = m.normals[i]!; n[i + 1] = m.normals[i + 1]!; n[i + 2] = -m.normals[i + 2]!; }
  }
  const idx = new Uint32Array(m.indices.length);
  for (let i = 0; i + 2 < idx.length; i += 3) { idx[i] = m.indices[i]!; idx[i + 1] = m.indices[i + 2]!; idx[i + 2] = m.indices[i + 1]!; }
  return { positions: p, normals: n, uvs: m.uvs ? m.uvs.slice() : null, indices: idx };
}

export interface Bounds { min: [number, number, number]; max: [number, number, number] }
export function meshBounds(positions: Float32Array): Bounds {
  if (positions.length < 3) return { min: [0, 0, 0], max: [0, 0, 0] };
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) { const v = positions[i + k]!; if (v < min[k]!) min[k] = v; if (v > max[k]!) max[k] = v; }
  }
  return { min, max };
}

/** The vanilla iso projection of a game-axes point, in SVG units (y down): the ISO columns pinned by the T2 observer
 *  (editor/test/fixtures/ingame/observe3d-log.txt: x -> (0.894427, 0.447214), h -> (0, 1), z -> (-0.894427, 0.447214)
 *  in camera-2D, y up), so 1 = one world unit = one tile before the camera zoom. */
export function isoProject(x: number, h: number, z: number): [number, number] {
  const sx = 0.894427 * x - 0.894427 * z;
  const sy = 0.447214 * x + h + 0.447214 * z;
  return [sx, -sy];
}

/** A wireframe of a GAME-AXES mesh as the vanilla camera sees it: one <line> per unique edge over the outline of the
 *  tile the model stands on (x, z in [-0.5, 0.5]); the bounds and counts in the <title>. No DOM: a string. */
export function isoWireframeSvg(m: TriMesh, opts: { px?: number; stroke?: string; tile?: string } = {}): string {
  const px = opts.px ?? 100;
  const edges = new Set<string>();
  const list: [number, number][] = [];
  for (let i = 0; i + 2 < m.indices.length; i += 3) {
    const t = [m.indices[i]!, m.indices[i + 1]!, m.indices[i + 2]!];
    for (let k = 0; k < 3; k++) {
      const a = t[k]!, b = t[(k + 1) % 3]!;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (!edges.has(key)) { edges.add(key); list.push([a, b]); }
    }
  }
  const pt = (v: number): [number, number] => isoProject(m.positions[3 * v]!, m.positions[3 * v + 1]!, m.positions[3 * v + 2]!);
  const tile = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([x, z]) => isoProject(x!, 0, z!));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = ([x, y]: [number, number]): void => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
  tile.forEach(grow);
  for (let v = 0; 3 * v + 2 < m.positions.length; v++) grow(pt(v));
  const pad = 0.1;
  const f = (n: number): string => (Math.round(n * px * 100) / 100).toString();
  const b = meshBounds(m.positions);
  const r3 = (n: number): string => (Math.round(n * 1000) / 1000).toString();
  const title = `${m.indices.length / 3} triangles, ${list.length} edges; bounds x ${r3(b.min[0])}..${r3(b.max[0])}, h ${r3(b.min[1])}..${r3(b.max[1])}, z ${r3(b.min[2])}..${r3(b.max[2])} (tiles)`;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(minX - pad)} ${f(minY - pad)} ${f(maxX - minX + 2 * pad)} ${f(maxY - minY + 2 * pad)}">`);
  out.push(`<title>${title}</title>`);
  out.push(`<polygon points="${tile.map(([x, y]) => `${f(x)},${f(y)}`).join(" ")}" fill="none" stroke="${opts.tile ?? "#888"}" stroke-dasharray="4 3"/>`);
  out.push(`<g stroke="${opts.stroke ?? "currentColor"}" stroke-width="1" fill="none">`);
  for (const [a, c] of list) {
    const [x1, y1] = pt(a), [x2, y2] = pt(c);
    out.push(`<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}"/>`);
  }
  out.push("</g></svg>");
  return out.join("");
}

/** Warnings about a GAME-AXES mesh that loads fine but will look wrong or cost too much (docs/3d-importer-design.md
 *  "Limits"): model-heavy, model-below-floor (origin not at the feet), model-footprint (wider than one tile). */
export function modelBudgetFindings(m: TriMesh): ModelFinding[] {
  const out: ModelFinding[] = [];
  const tris = Math.floor(m.indices.length / 3);
  if (tris > MODEL_LIMITS.budgetTriangles) {
    out.push({ code: "model-heavy", severity: "warning", message: `${tris} triangles is over the ${MODEL_LIMITS.budgetTriangles}-triangle budget for one prop (decimate in Blender: Modifiers > Decimate)` });
  }
  const b = meshBounds(m.positions);
  if (b.min[1] < MODEL_LIMITS.belowFloor) {
    out.push({ code: "model-below-floor", severity: "warning", message: `the model reaches ${round3(b.min[1])} below the floor: put its origin at its feet (Blender: Object > Set Origin, then move the mesh up)` });
  }
  const eps = 0.01;
  const wide = Math.max(-b.min[0], b.max[0], -b.min[2], b.max[2]);
  if (wide > MODEL_LIMITS.footprint + eps) {
    out.push({ code: "model-footprint", severity: "warning", message: `the model reaches ${round3(wide)} tiles from its origin: wider than the one tile it stands on (1 Blender metre = 1 tile)` });
  }
  return out;
}

function round3(n: number): number { return Math.round(n * 1000) / 1000; }

/** Signed-area test used by both readers: is the polygon (projected on its dominant plane) convex? */
export function polygonIsConvex(pts: number[][]): boolean {
  if (pts.length <= 3) return true;
  // Newell normal -> dominant axis
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
    nx += (a[1]! - b[1]!) * (a[2]! + b[2]!); ny += (a[2]! - b[2]!) * (a[0]! + b[0]!); nz += (a[0]! - b[0]!) * (a[1]! + b[1]!);
  }
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  const [u, v, sign] = az >= ax && az >= ay ? [0, 1, Math.sign(nz)] : ax >= ay ? [1, 2, Math.sign(nx)] : [2, 0, Math.sign(ny)];
  if (sign === 0) return false;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!, b = pts[(i + 1) % pts.length]!, c = pts[(i + 2) % pts.length]!;
    const cross = (b[u]! - a[u]!) * (c[v]! - b[v]!) - (b[v]! - a[v]!) * (c[u]! - b[u]!);
    if (cross * sign < -1e-12) return false;
  }
  return true;
}
