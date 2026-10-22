// glTF 2.0 subset reader (.gltf with data-URI / external buffers, .glb) — the editor half of the importer design
// (docs/3d-importer-design.md "glTF v1 subset"); the DLL's fw_mesh_gltf.c is to follow the same rules and codes.
//
// What it does: container + header checks -> buffers -> the default scene's node tree, each mesh instance's world
// matrix baked into its primitives (det < 0 reverses the triangles) -> ONE merged triangle list in file axes, plus the
// materials (base colour factor / texture) and a finding for everything it skips. Strict about the spec rules a
// minimal consumer depends on (alignment, strides, bounds, index ranges): each is an error finding, never a read past
// the end. Borrowed / rejected, with the source lines in the design doc:
// - two phases (Godot GLTFDocument: _parse_gltf_state fills a GLTFState, generate_scene builds nodes) — here phase 2
//   flattens into one mesh, like ImporterMesh::merge_importer_meshes with relative transforms;
// - GLB checks with Blender's words (io_scene_gltf2/io/imp/gltf2_io_gltf.py load_glb: version 2, file size, JSON
//   first) — Godot's _parse_glb reads version/length and ignores them;
// - extensionsRequired refused by name (Godot _parse_gltf_extensions; Blender checks()), BEFORE any buffer is read
//   (Godot checks them after _parse_buffers);
// - accessor decode = Godot GLTFAccessor::_decode_raw_numbers (stride, normalized ints per spec 3.11) but alignment
//   violations are errors here (Godot WARN_PRINTs "will try to load it anyway");
// - sparse accessors: decoded by Godot and Blender; refused in v1 unless only a skipped feature (morph targets) uses
//   them — Blender writes sparse accessors for shape keys by default ("Use Sparse Accessor if Better");
// - strips / fans converted to triangles (Blender mesh.py points_edges_tris); points / lines refused;
// - indices swapped by Godot for its clockwise front faces; here the file's CCW is kept and toGameAxes reverses.

import { ModelStop, MODEL_LIMITS } from "./model-read.ts";
import type { ModelRead, ModelFinding, ModelMaterial, ModelTexture, TriMesh, ModelStats } from "./model-read.ts";

export interface GltfReadOptions {
  /** reads a file next to the model (an external .bin or image uri, already percent-decoded); null = missing */
  resolve?: (uri: string) => Uint8Array | null;
}

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

const COMPONENT: Record<number, { size: number; name: string }> = {
  5120: { size: 1, name: "BYTE" }, 5121: { size: 1, name: "UNSIGNED_BYTE" }, 5122: { size: 2, name: "SHORT" },
  5123: { size: 2, name: "UNSIGNED_SHORT" }, 5125: { size: 4, name: "UNSIGNED_INT" }, 5126: { size: 4, name: "FLOAT" },
};
const TYPE_SIZE: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const MODE_NAME = ["POINTS", "LINES", "LINE_LOOP", "LINE_STRIP", "TRIANGLES", "TRIANGLE_STRIP", "TRIANGLE_FAN"];

// ---- base64 (strict; no Node Buffer so the browser can run this too) ------------------------------------------
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INV = (() => { const t = new Int16Array(256).fill(-1); for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i; return t; })();
export function decodeBase64(s: string): Uint8Array | null {
  const clean = s.replace(/[\r\n]/g, "");
  if (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
  const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((clean.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64_INV[clean.charCodeAt(i)]!, b = B64_INV[clean.charCodeAt(i + 1)]!;
    const c = clean[i + 2] === "=" ? 0 : B64_INV[clean.charCodeAt(i + 2)]!, d = clean[i + 3] === "=" ? 0 : B64_INV[clean.charCodeAt(i + 3)]!;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

// ---- small matrix helpers (column-major 4x4, glTF's layout) ---------------------------------------------------
type M4 = Float64Array;
const ident = (): M4 => { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
function mul(a: M4, b: M4): M4 {
  const r = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + rr]! * b[c * 4 + k]!;
    r[c * 4 + rr] = s;
  }
  return r;
}
function trs(t: number[], q: number[], s: number[]): M4 {
  let [x, y, z, w] = q as [number, number, number, number];
  const ql = Math.hypot(x, y, z, w) || 1; x /= ql; y /= ql; z /= ql; w /= ql;
  const m = new Float64Array(16);
  m[0] = (1 - 2 * (y * y + z * z)) * s[0]!; m[1] = 2 * (x * y + z * w) * s[0]!; m[2] = 2 * (x * z - y * w) * s[0]!;
  m[4] = 2 * (x * y - z * w) * s[1]!; m[5] = (1 - 2 * (x * x + z * z)) * s[1]!; m[6] = 2 * (y * z + x * w) * s[1]!;
  m[8] = 2 * (x * z + y * w) * s[2]!; m[9] = 2 * (y * z - x * w) * s[2]!; m[10] = (1 - 2 * (x * x + y * y)) * s[2]!;
  m[12] = t[0]!; m[13] = t[1]!; m[14] = t[2]!; m[15] = 1;
  return m;
}
const det3 = (m: M4): number =>
  m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!) - m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) + m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!);
/** M^-1 of the upper 3x3 (ROW-major), for the normal matrix (M^-1)^T: n'[r] = sum_k inv[k*3 + r] * n[k]; null when singular */
function normalMatrix(m: M4): number[] | null {
  const a = m[0]!, b = m[4]!, c = m[8]!, d = m[1]!, e = m[5]!, f = m[9]!, g = m[2]!, h = m[6]!, i = m[10]!;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-20) return null;
  return [(e * i - f * h), -(b * i - c * h), (b * f - c * e), -(d * i - f * g), (a * i - c * g), -(a * f - c * d), (d * h - e * g), -(a * h - b * g), (a * e - b * d)].map((x) => x / det);
}

function numArray(v: unknown, n: number, what: string): number[] {
  if (!Array.isArray(v) || v.length !== n || !v.every((x) => typeof x === "number" && Number.isFinite(x))) {
    throw new ModelStop("model-node-invalid", `glTF: ${what} must be ${n} numbers`);
  }
  return v as number[];
}

export function readGltf(bytes: Uint8Array, opts: GltfReadOptions = {}): ModelRead {
  const findings: ModelFinding[] = [];
  const note = (code: string, severity: ModelFinding["severity"], message: string): void => {
    if (!findings.some((f) => f.code === code)) findings.push({ code, severity, message });
  };
  const isGlb = bytes.length >= 4 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46;
  const format: ModelRead["format"] = isGlb ? "glb" : "gltf";
  const stats: ModelStats = { vertices: 0, triangles: 0, meshes: 0, primitives: 0, nodes: 0 };
  try {
    // ---- phase 1: container, JSON, header, extensions ----------------------------------------------------------
    let jsonText: string;
    let glbBin: Uint8Array | null = null;
    if (isGlb) ({ jsonText, glbBin } = parseGlb(bytes));
    else {
      try { jsonText = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw new ModelStop("model-parse-error", "glTF: Error parsing .gltf JSON data: not UTF-8 text"); }
    }
    let doc: unknown;
    try { doc = JSON.parse(jsonText.charCodeAt(0) === 0xfeff ? jsonText.slice(1) : jsonText); }
    catch (e) { throw new ModelStop("model-parse-error", "glTF: Error parsing .gltf JSON data: " + String(e instanceof Error ? e.message : e)); }
    if (!isObj(doc)) throw new ModelStop("model-parse-error", "glTF: Error parsing .gltf JSON data: the top level is not an object");
    checkAsset(doc);
    const required = arr(doc.extensionsRequired).filter((x): x is string => typeof x === "string");
    if (required.length) throw new ModelStop("model-extension-required", `glTF: Can't import file, required extension '${required[0]}' is not supported (export without it)`);
    const used = arr(doc.extensionsUsed).filter((x): x is string => typeof x === "string");
    if (used.length) note("model-extension-ignored", "info", `optional extension(s) ignored: ${used.join(", ")}`);

    // ---- buffers -----------------------------------------------------------------------------------------------
    const buffers: Uint8Array[] = arr(doc.buffers).map((b, i) => loadBuffer(b, i, glbBin, opts));
    const views = arr(doc.bufferViews);
    const accessors = arr(doc.accessors);

    const viewBytes = (vi: number, who: string): { data: Uint8Array; stride: number | null } => {
      const v = views[vi];
      if (!isInt(vi) || !isObj(v)) throw new ModelStop("model-accessor-invalid", `glTF: ${who} names bufferView ${vi}, which does not exist`);
      const bi = v.buffer, off = v.byteOffset ?? 0, len = v.byteLength;
      if (!isInt(bi) || !buffers[bi]) throw new ModelStop("model-accessor-invalid", `glTF: bufferView ${vi} names buffer ${String(bi)}, which does not exist`);
      if (!isInt(off) || off < 0 || !isInt(len) || len < 1) throw new ModelStop("model-accessor-invalid", `glTF: bufferView ${vi} needs a byteLength >= 1 and a byteOffset >= 0`);
      const buf = buffers[bi]!;
      if (off + len > buf.length) throw new ModelStop("model-buffer-range", `glTF: bufferView ${vi} (bytes ${off}..${off + len}) runs past the end of buffer ${bi} (${buf.length} bytes)`);
      let stride: number | null = null;
      if (v.byteStride !== undefined) {
        const s = v.byteStride;
        if (!isInt(s) || s % 4 !== 0 || s < 4 || s > 252) {
          throw new ModelStop("model-accessor-invalid", `glTF import: The declared buffer view byte stride ${String(s)} was not a multiple of 4 as required by glTF (bufferView ${vi}; 4..252)`);
        }
        stride = s;
      }
      return { data: buf.subarray(off, off + len), stride };
    };

    /** decodes accessor `ai` as numbers (normalized ints mapped per spec 3.11); checks alignment, stride, bounds */
    const readAccessor = (ai: unknown, who: string, vertexAttribute: boolean): { values: Float64Array; count: number; ncomp: number; comp: number; type: string; normalized: boolean } => {
      const a = isInt(ai) ? accessors[ai] : undefined;
      if (!isObj(a)) throw new ModelStop("model-accessor-invalid", `glTF: ${who} names accessor ${String(ai)}, which does not exist`);
      if (a.sparse !== undefined) throw new ModelStop("model-sparse-unsupported", `glTF: accessor ${String(ai)} (${who}) is sparse: sparse accessors are not supported in v1 (Blender: untick Shape Keys, or 'Use Sparse Accessor if Better')`);
      const comp = a.componentType as number, type = a.type as string, count = a.count;
      const cinfo = COMPONENT[comp];
      if (!cinfo) throw new ModelStop("model-accessor-invalid", `glTF: accessor ${String(ai)} has componentType ${String(comp)} (allowed: 5120 5121 5122 5123 5125 5126)`);
      const ncomp = TYPE_SIZE[type];
      if (!ncomp) throw new ModelStop("model-accessor-invalid", `glTF: accessor ${String(ai)} has type ${String(type)}`);
      if (!isInt(count) || count < 1) throw new ModelStop("model-accessor-invalid", `glTF: accessor ${String(ai)} needs a count >= 1`);
      const normalized = a.normalized === true;
      // nothing is allocated from a file-supplied count before it is bounded: by the view's bytes below, or (no view)
      // by the index/vertex caps — a hostile count must be a finding, never an allocation (the C reader's rule too)
      if (a.bufferView === undefined) {
        if (count > MODEL_LIMITS.maxIndices) throw new ModelStop("model-limit", `glTF: accessor ${String(ai)} count ${count} is more than the ${MODEL_LIMITS.maxIndices} limit`);
        return { values: new Float64Array(count * ncomp), count, ncomp, comp, type, normalized }; // spec: all zeros
      }
      const off = a.byteOffset ?? 0;
      if (!isInt(off) || off < 0) throw new ModelStop("model-accessor-invalid", `glTF: accessor ${String(ai)} byteOffset ${String(off)}`);
      const vi = a.bufferView as number;
      const { data, stride } = viewBytes(vi, `accessor ${String(ai)}`);
      const viewOff = (views[vi] as J).byteOffset as number | undefined ?? 0;
      if (off % cinfo.size !== 0 || (off + viewOff) % cinfo.size !== 0) {
        throw new ModelStop("model-accessor-invalid", `glTF: accessor ${String(ai)}: its byteOffset ${off} (+ bufferView ${vi}'s ${viewOff}) MUST be a multiple of the size of the accessor's component type (${cinfo.size})`);
      }
      const elem = cinfo.size * ncomp;
      const st = stride ?? elem;
      if (st < elem) throw new ModelStop("model-accessor-invalid", `glTF: bufferView ${vi} byteStride ${st} is smaller than accessor ${String(ai)}'s element (${elem} bytes)`);
      if (vertexAttribute && (off % 4 !== 0 || st % 4 !== 0)) {
        throw new ModelStop("model-accessor-invalid", `glTF: accessor ${String(ai)} (${who}): each element of a vertex attribute MUST be aligned to 4-byte boundaries (byteOffset ${off}, stride ${st})`);
      }
      const need = off + st * (count - 1) + elem;
      if (need > data.length) {
        throw new ModelStop("model-buffer-range", `glTF import: The buffer view size was smaller than the minimum required size for the accessor (accessor ${String(ai)} needs ${need} bytes, bufferView ${vi} has ${data.length})`);
      }
      const values = new Float64Array(count * ncomp);
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (let i = 0; i < count; i++) {
        for (let k = 0; k < ncomp; k++) {
          const p = off + i * st + k * cinfo.size;
          let x: number;
          switch (comp) {
            case 5120: x = dv.getInt8(p); if (normalized) x = Math.max(x / 127, -1); break;
            case 5121: x = dv.getUint8(p); if (normalized) x = x / 255; break;
            case 5122: x = dv.getInt16(p, true); if (normalized) x = Math.max(x / 32767, -1); break;
            case 5123: x = dv.getUint16(p, true); if (normalized) x = x / 65535; break;
            case 5125: x = dv.getUint32(p, true); break;
            default: x = dv.getFloat32(p, true);
          }
          values[i * ncomp + k] = x;
        }
      }
      return { values, count, ncomp, comp, type, normalized };
    };

    // ---- phase 2: the scene graph -> mesh instances --------------------------------------------------------
    const nodes = arr(doc.nodes);
    const meshes = arr(doc.meshes);
    if (nodes.length > MODEL_LIMITS.maxNodes) throw new ModelStop("model-limit", `glTF: ${nodes.length} nodes is more than the ${MODEL_LIMITS.maxNodes}-node limit`);
    let roots: number[];
    const scenes = arr(doc.scenes);
    if (scenes.length) {
      const si = doc.scene ?? 0;
      const sc = isInt(si) ? scenes[si] : undefined;
      if (!isObj(sc)) throw new ModelStop("model-node-invalid", `glTF: scene ${String(si)} does not exist`);
      roots = arr(sc.nodes) as number[];
    } else {
      const child = new Set<number>();
      for (const n of nodes) if (isObj(n)) for (const c of arr(n.children)) if (isInt(c)) child.add(c);
      roots = nodes.map((_, i) => i).filter((i) => !child.has(i));
    }
    const instances: { mesh: number; world: M4; node: number }[] = [];
    const seen = new Set<number>();
    let skinned = false;
    const visit = (ni: unknown, parent: M4, depth: number, path: Set<number>): void => {
      if (!isInt(ni) || !isObj(nodes[ni])) throw new ModelStop("model-node-invalid", `glTF: node ${String(ni)} does not exist`);
      if (path.has(ni)) throw new ModelStop("model-node-cycle", `glTF: node ${ni} is its own ancestor (the node hierarchy MUST be a tree)`);
      if (seen.has(ni)) throw new ModelStop("model-node-cycle", `glTF: node ${ni} has more than one parent (the node hierarchy MUST be disjoint trees)`);
      if (depth > MODEL_LIMITS.maxNodeDepth) throw new ModelStop("model-limit", `glTF: the node tree is deeper than ${MODEL_LIMITS.maxNodeDepth}`);
      seen.add(ni);
      const n = nodes[ni] as J;
      let local: M4;
      if (n.matrix !== undefined) local = Float64Array.from(numArray(n.matrix, 16, `node ${ni} matrix`));
      else local = trs(n.translation === undefined ? [0, 0, 0] : numArray(n.translation, 3, `node ${ni} translation`),
        n.rotation === undefined ? [0, 0, 0, 1] : numArray(n.rotation, 4, `node ${ni} rotation`),
        n.scale === undefined ? [1, 1, 1] : numArray(n.scale, 3, `node ${ni} scale`));
      const world = mul(parent, local);
      if (n.skin !== undefined) skinned = true;
      if (n.mesh !== undefined) {
        if (!isInt(n.mesh) || !isObj(meshes[n.mesh])) throw new ModelStop("model-node-invalid", `glTF: node ${ni} names mesh ${String(n.mesh)}, which does not exist`);
        instances.push({ mesh: n.mesh, world, node: ni });
      }
      path.add(ni);
      for (const c of arr(n.children)) visit(c, world, depth + 1, path);
      path.delete(ni);
    };
    for (const r of roots) visit(r, ident(), 0, new Set());
    stats.nodes = seen.size;
    if (instances.length === 0) throw new ModelStop("model-empty", "glTF: no node of the default scene references a mesh (nothing to draw)");

    // ---- primitives -> one merged triangle list ----------------------------------------------------------------
    const P: number[] = [], N: number[] = [], T: number[] = [], I: number[] = [];
    let allNormals = true, anyUv = false, morph = false;
    const ignoredAttrs = new Set<string>();
    const primitiveMaterials: number[] = [];
    const meshesUsed = new Set<number>();
    for (const inst of instances) {
      meshesUsed.add(inst.mesh);
      const prims = arr((meshes[inst.mesh] as J).primitives);
      if (prims.length === 0) throw new ModelStop("model-accessor-invalid", `glTF: mesh ${inst.mesh} has no primitives`);
      const flip = det3(inst.world) < 0;
      const nm = normalMatrix(inst.world);
      prims.forEach((pr, pi) => {
        if (!isObj(pr)) throw new ModelStop("model-accessor-invalid", `glTF: mesh ${inst.mesh} primitive ${pi} is not an object`);
        stats.primitives++;
        if (stats.primitives > MODEL_LIMITS.maxPrimitives) throw new ModelStop("model-limit", `glTF: more than ${MODEL_LIMITS.maxPrimitives} primitives`);
        const mode = pr.mode ?? 4;
        if (mode !== 4 && mode !== 5 && mode !== 6) {
          throw new ModelStop("model-primitive-mode", `glTF: mesh ${inst.mesh} primitive ${pi} has mode ${String(mode)} (${MODE_NAME[mode as number] ?? "?"}): only triangles are drawn`);
        }
        const at = isObj(pr.attributes) ? pr.attributes : {};
        if (at.POSITION === undefined) throw new ModelStop("model-attribute-missing", `glTF: mesh ${inst.mesh} primitive ${pi} has no POSITION`);
        const pos = readAccessor(at.POSITION, `mesh ${inst.mesh} primitive ${pi} POSITION`, true);
        if (pos.type !== "VEC3" || pos.comp !== 5126) throw new ModelStop("model-attribute-format", `glTF: POSITION must be VEC3 FLOAT, got ${pos.type} ${COMPONENT[pos.comp]!.name} (KHR_mesh_quantization is not supported)`);
        const nv = pos.count;
        let nrm: Float64Array | null = null, uv: Float64Array | null = null;
        if (at.NORMAL !== undefined) {
          const n = readAccessor(at.NORMAL, `mesh ${inst.mesh} primitive ${pi} NORMAL`, true);
          if (n.type !== "VEC3" || n.comp !== 5126) throw new ModelStop("model-attribute-format", `glTF: NORMAL must be VEC3 FLOAT, got ${n.type} ${COMPONENT[n.comp]!.name}`);
          if (n.count !== nv) throw new ModelStop("model-accessor-invalid", `glTF: NORMAL has ${n.count} elements, POSITION ${nv}`);
          nrm = n.values;
        } else allNormals = false;
        if (at.TEXCOORD_0 !== undefined) {
          const t = readAccessor(at.TEXCOORD_0, `mesh ${inst.mesh} primitive ${pi} TEXCOORD_0`, true);
          const okFmt = t.type === "VEC2" && (t.comp === 5126 || ((t.comp === 5121 || t.comp === 5123) && t.normalized));
          if (!okFmt) throw new ModelStop("model-attribute-format", `glTF: TEXCOORD_0 must be VEC2 FLOAT or normalized UNSIGNED_BYTE/SHORT, got ${t.type} ${COMPONENT[t.comp]!.name}${t.normalized ? " normalized" : ""}`);
          if (t.count !== nv) throw new ModelStop("model-accessor-invalid", `glTF: TEXCOORD_0 has ${t.count} elements, POSITION ${nv}`);
          uv = t.values; anyUv = true;
        }
        for (const k of Object.keys(at)) {
          if (/^(JOINTS|WEIGHTS)_\d+$/.test(k)) skinned = true;
          else if (k !== "POSITION" && k !== "NORMAL" && k !== "TEXCOORD_0") ignoredAttrs.add(k);
        }
        if (pr.targets !== undefined && arr(pr.targets).length) morph = true;
        // indices
        let idx: number[];
        if (pr.indices !== undefined) {
          const ia = readAccessor(pr.indices, `mesh ${inst.mesh} primitive ${pi} indices`, false);
          if (ia.type !== "SCALAR" || ia.normalized || !(ia.comp === 5121 || ia.comp === 5123 || ia.comp === 5125)) {
            throw new ModelStop("model-accessor-invalid", `glTF: indices must be SCALAR UNSIGNED_BYTE/SHORT/INT (not normalized), got ${ia.type} ${COMPONENT[ia.comp]!.name}`);
          }
          const restart = ia.comp === 5121 ? 255 : ia.comp === 5123 ? 65535 : 4294967295;
          idx = Array.from(ia.values);
          for (const x of idx) {
            if (x === restart) throw new ModelStop("model-index-range", `glTF: mesh ${inst.mesh} primitive ${pi}: indices MUST NOT contain the maximum value ${restart} (primitive restart)`);
            if (x >= nv) throw new ModelStop("model-index-range", `glTF: mesh ${inst.mesh} primitive ${pi} index ${x} out of range (${nv} vertices)`);
          }
          if (mode === 4 && idx.length % 3 !== 0) {
            throw new ModelStop("model-index-range", `glTF import: Mesh ${inst.mesh} surface ${pi} is invalid. Indexed triangle meshes MUST have an index array with a size that is a multiple of 3, but got ${idx.length} indices.`);
          }
        } else {
          if (mode === 4 && nv % 3 !== 0) {
            throw new ModelStop("model-index-range", `glTF import: Mesh ${inst.mesh} surface ${pi} is invalid. Non-indexed triangle meshes MUST have a vertex array with a size that is a multiple of 3, but got ${nv} vertices.`);
          }
          idx = Array.from({ length: nv }, (_, i) => i);
        }
        const tris = toTriangles(mode as number, idx);
        // bake
        const base = P.length / 3;
        if (base + nv > MODEL_LIMITS.maxVertices) throw new ModelStop("model-limit", `glTF: more than ${MODEL_LIMITS.maxVertices} vertices (limit)`);
        if (I.length + tris.length > MODEL_LIMITS.maxIndices) throw new ModelStop("model-limit", `glTF: more than ${MODEL_LIMITS.maxIndices} indices (limit)`);
        const w = inst.world;
        for (let v = 0; v < nv; v++) {
          const x = pos.values[3 * v]!, y = pos.values[3 * v + 1]!, z = pos.values[3 * v + 2]!;
          P.push(w[0]! * x + w[4]! * y + w[8]! * z + w[12]!, w[1]! * x + w[5]! * y + w[9]! * z + w[13]!, w[2]! * x + w[6]! * y + w[10]! * z + w[14]!);
          if (nrm) {
            const a = nrm[3 * v]!, b = nrm[3 * v + 1]!, c = nrm[3 * v + 2]!;
            let nx = a, ny = b, nz = c;
            if (nm) { nx = nm[0]! * a + nm[3]! * b + nm[6]! * c; ny = nm[1]! * a + nm[4]! * b + nm[7]! * c; nz = nm[2]! * a + nm[5]! * b + nm[8]! * c; }
            const l = Math.hypot(nx, ny, nz);
            if (l > 1e-20) N.push(nx / l, ny / l, nz / l); else N.push(0, 1, 0);
          } else N.push(0, 0, 0);
          if (uv) T.push(uv[2 * v]!, uv[2 * v + 1]!); else T.push(0, 0);
        }
        for (let t = 0; t + 2 < tris.length; t += 3) {
          if (flip) I.push(base + tris[t]!, base + tris[t + 2]!, base + tris[t + 1]!);
          else I.push(base + tris[t]!, base + tris[t + 1]!, base + tris[t + 2]!);
        }
        primitiveMaterials.push(isInt(pr.material) ? pr.material : -1);
      });
    }
    stats.meshes = meshesUsed.size;
    stats.vertices = P.length / 3;
    stats.triangles = I.length / 3;
    if (I.length === 0) throw new ModelStop("model-empty", "glTF: the meshes have no triangles");

    // ---- materials -----------------------------------------------------------------------------------------
    const materials = arr(doc.materials).map((m, i) => readMaterial(m, i, doc as J, buffers, viewBytes, note));
    for (const mi of primitiveMaterials) if (mi >= materials.length) throw new ModelStop("model-accessor-invalid", `glTF: a primitive names material ${mi}, which does not exist`);
    const usedMats = new Set(primitiveMaterials);
    if (usedMats.size > 1) note("model-multi-material", "warning", `${usedMats.size} materials are in use: v1 draws the whole model with the first one's colour/texture — join them into one material (one texture atlas) in Blender`);
    for (const mi of usedMats) {
      const m = mi >= 0 ? materials[mi] : undefined;
      if (m?.texture && !anyUv) note("model-texture-no-uvs", "warning", "the material has a texture but the mesh has no TEXCOORD_0 (export with UVs on)");
    }

    // ---- what v1 skips ---------------------------------------------------------------------------------------
    if (!allNormals) note("model-no-normals", "info", "a primitive has no NORMAL: the engine gives every triangle its flat face normal (export with Normals on for smooth shading)");
    if (skinned || arr(doc.skins).length) note("model-skin-ignored", "warning", "skinning (JOINTS_0/WEIGHTS_0, skins) is ignored in v1: the mesh is drawn in its bind pose");
    if (arr(doc.animations).length) note("model-animation-ignored", "warning", `${arr(doc.animations).length} animation(s) ignored in v1 (a static prop)`);
    if (morph) note("model-morph-ignored", "warning", "morph targets (shape keys) are ignored in v1: the base shape is drawn (Blender: untick Shape Keys)");
    if (ignoredAttrs.size) note("model-attribute-ignored", "info", `attribute(s) not used by the v1 shader: ${[...ignoredAttrs].sort().join(", ")}`);

    const mesh: TriMesh = {
      positions: new Float32Array(P),
      normals: allNormals ? new Float32Array(N) : null,
      uvs: anyUv ? new Float32Array(T) : null,
      indices: new Uint32Array(I),
    };
    return { format, mesh, materials, primitiveMaterials, findings, stats };
  } catch (e) {
    if (e instanceof ModelStop) return { format, mesh: null, materials: [], primitiveMaterials: [], findings: [...findings.filter((f) => f.severity !== "error"), e.finding], stats };
    throw e;
  }
}

function parseGlb(b: Uint8Array): { jsonText: string; glbBin: Uint8Array | null } {
  if (b.length < 20) throw new ModelStop("model-glb-header", "Bad GLB: file size doesn't match");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const version = dv.getUint32(4, true), total = dv.getUint32(8, true);
  if (version !== 2) throw new ModelStop("model-glb-header", `GLB version must be 2; got ${version}`);
  if (total !== b.length) throw new ModelStop("model-glb-header", "Bad GLB: file size doesn't match");
  let off = 12;
  let jsonText: string | null = null, bin: Uint8Array | null = null, chunk = 0;
  while (off < total) {
    if (off + 8 > total) throw new ModelStop("model-glb-header", "Bad GLB: truncated chunk header");
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    if (len % 4 !== 0) throw new ModelStop("model-glb-header", `Bad GLB: chunk ${chunk} length ${len} is not a multiple of 4 (chunks MUST be 4-byte aligned)`);
    if (off + 8 + len > total) throw new ModelStop("model-glb-header", `Bad GLB: chunk ${chunk} runs past the end of the file`);
    const data = b.subarray(off + 8, off + 8 + len);
    if (chunk === 0) {
      if (type !== 0x4e4f534a) throw new ModelStop("model-glb-header", "Bad GLB: first chunk not JSON");
      try { jsonText = new TextDecoder("utf-8", { fatal: true }).decode(data); }
      catch { throw new ModelStop("model-parse-error", "glTF Binary: Error parsing .glb file's JSON data: not UTF-8"); }
    } else if (chunk === 1 && type === 0x004e4942) bin = data; // later / unknown chunks: ignored (spec 4.4.3.1)
    off += 8 + len; chunk++;
  }
  if (jsonText === null) throw new ModelStop("model-glb-header", "Bad GLB: no JSON chunk");
  return { jsonText, glbBin: bin };
}

function checkAsset(doc: J): void {
  const asset = doc.asset;
  if (!isObj(asset)) throw new ModelStop("model-gltf-version", "Bad glTF: no asset in json");
  const v = asset.version;
  if (typeof v !== "string") throw new ModelStop("model-gltf-version", "Bad glTF: no version");
  const m = /^(\d+)\.(\d+)$/.exec(v);
  if (!m || m[1] !== "2") throw new ModelStop("model-gltf-version", `glTF version must be 2.x; got ${v}`);
  const mv = asset.minVersion;
  if (mv !== undefined) {
    const mm = typeof mv === "string" ? /^(\d+)\.(\d+)$/.exec(mv) : null;
    if (!mm || mm[1] !== "2" || mm[2] !== "0") throw new ModelStop("model-gltf-version", `glTF minVersion ${String(mv)} is newer than the 2.0 this reader supports`);
  }
}

function uriKind(uri: string): "data" | "file" | "unsupported" {
  if (uri.startsWith("data:")) return "data";
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri) || uri.startsWith("/") || uri.startsWith("\\")) return "unsupported";
  return "file";
}
function decodeUri(uri: string): string {
  try { return decodeURIComponent(uri); } catch { return uri; }
}

function loadBuffer(b: unknown, i: number, glbBin: Uint8Array | null, opts: GltfReadOptions): Uint8Array {
  if (!isObj(b)) throw new ModelStop("model-accessor-invalid", `glTF: buffer ${i} is not an object`);
  const declared = b.byteLength;
  if (!isInt(declared) || declared < 1) throw new ModelStop("model-accessor-invalid", `glTF: buffer ${i} needs a byteLength >= 1`);
  let data: Uint8Array | null;
  if (typeof b.uri === "string") {
    const uri = b.uri;
    const kind = uriKind(uri);
    if (kind === "data") {
      const m = /^data:application\/(octet-stream|gltf-buffer);base64,(.*)$/s.exec(uri);
      if (!m) throw new ModelStop("model-uri-unsupported", `glTF: Got buffer with an unknown URI data type: ${uri.slice(0, 48)}`);
      data = decodeBase64(m[2]!);
      if (!data) throw new ModelStop("model-parse-error", `glTF: buffer ${i}: the base64 data URI does not decode`);
    } else if (kind === "unsupported") {
      throw new ModelStop("model-uri-unsupported", `glTF: buffer ${i} uri '${uri}' is not a relative file name (no absolute paths, no http)`);
    } else {
      data = opts.resolve ? opts.resolve(decodeUri(uri)) : null;
      if (!data) throw new ModelStop("model-buffer-missing", `glTF: Binary file not found: ${uri}`);
    }
  } else if (i === 0 && glbBin) data = glbBin;
  else throw new ModelStop("model-buffer-missing", `glTF: Buffer ${i} has no data and cannot be loaded.`);
  if (data.length < declared) throw new ModelStop("model-buffer-range", `glTF: buffer ${i} declares byteLength ${declared} but has ${data.length} bytes`);
  return data.subarray(0, declared);
}

/** TRIANGLES as is; STRIP and FAN converted (Blender io_scene_gltf2 blender/imp/mesh.py points_edges_tris) */
function toTriangles(mode: number, idx: number[]): number[] {
  if (mode === 4) return idx;
  const out: number[] = [];
  if (mode === 5) {
    for (let i = 0; i + 2 < idx.length; i++) {
      if (i % 2 === 0) out.push(idx[i]!, idx[i + 1]!, idx[i + 2]!);
      else out.push(idx[i]!, idx[i + 2]!, idx[i + 1]!);
    }
  } else {
    for (let i = 1; i + 1 < idx.length; i++) out.push(idx[0]!, idx[i]!, idx[i + 1]!);
  }
  return out;
}

function readMaterial(
  m: unknown, i: number, doc: J, buffers: Uint8Array[],
  viewBytes: (vi: number, who: string) => { data: Uint8Array; stride: number | null },
  note: (code: string, severity: ModelFinding["severity"], message: string) => void,
): ModelMaterial {
  const mat: ModelMaterial = { baseColor: [1, 1, 1, 1], texture: null, alphaMode: "OPAQUE", alphaCutoff: 0.5, doubleSided: false };
  if (!isObj(m)) return mat;
  if (typeof m.name === "string") mat.name = m.name;
  const pbr = isObj(m.pbrMetallicRoughness) ? m.pbrMetallicRoughness : {};
  const f = pbr.baseColorFactor;
  if (Array.isArray(f) && f.length === 4 && f.every((x) => typeof x === "number")) mat.baseColor = f as [number, number, number, number];
  if (m.alphaMode === "MASK" || m.alphaMode === "BLEND") mat.alphaMode = m.alphaMode;
  if (typeof m.alphaCutoff === "number") mat.alphaCutoff = m.alphaCutoff;
  if (m.doubleSided === true) mat.doubleSided = true;
  if (mat.alphaMode === "BLEND") note("model-alpha-blend", "warning", `material ${i}: alphaMode BLEND is drawn as a cut-out (MASK at ${mat.alphaCutoff}): meshes are not sorted for translucency in v1`);
  const bt = pbr.baseColorTexture;
  if (isObj(bt)) {
    const tex: ModelTexture = { texCoord: isInt(bt.texCoord) ? bt.texCoord : 0 };
    if (tex.texCoord !== 0) note("model-texcoord-set", "warning", `material ${i}: baseColorTexture uses TEXCOORD_${tex.texCoord}; v1 reads TEXCOORD_0 only`);
    if (isObj(bt.extensions) && bt.extensions.KHR_texture_transform !== undefined) note("model-texture-transform-ignored", "warning", `material ${i}: KHR_texture_transform (offset/scale/rotation of the UVs) is ignored — apply it to the UVs in Blender (remove the Mapping node)`);
    const t = isInt(bt.index) ? arr(doc.textures)[bt.index] : undefined;
    if (!isObj(t)) throw new ModelStop("model-accessor-invalid", `glTF: material ${i} names texture ${String(bt.index)}, which does not exist`);
    if (t.source === undefined) {
      note("model-image-format", "warning", `material ${i}: the texture has no PNG/JPEG source (WebP / KTX2 extensions are not readable by the game)`);
    } else {
      const img = isInt(t.source) ? arr(doc.images)[t.source] : undefined;
      if (!isObj(img)) throw new ModelStop("model-accessor-invalid", `glTF: texture ${String(bt.index)} names image ${String(t.source)}, which does not exist`);
      if (typeof img.mimeType === "string") tex.mimeType = img.mimeType;
      if (typeof img.uri === "string") {
        const k = uriKind(img.uri);
        if (k === "unsupported") throw new ModelStop("model-uri-unsupported", `glTF: image uri '${img.uri}' is not a relative file name`);
        if (k === "data") {
          const mm = /^data:([^;,]+);base64,(.*)$/s.exec(img.uri);
          const bytes = mm ? decodeBase64(mm[2]!) : null;
          if (!bytes) throw new ModelStop("model-parse-error", `glTF: image ${String(t.source)}: the data URI does not decode`);
          tex.embedded = bytes; tex.mimeType = tex.mimeType ?? mm![1]!;
        } else {
          tex.uri = decodeUri(img.uri);
          const guess = /\.jpe?g$/i.test(tex.uri) ? "image/jpeg" : /\.png$/i.test(tex.uri) ? "image/png" : null;
          if (!tex.mimeType && guess) tex.mimeType = guess;
        }
      } else if (img.bufferView !== undefined) {
        if (!tex.mimeType) throw new ModelStop("model-accessor-invalid", `glTF: Image index '${String(t.source)}' specifies 'bufferView' but no 'mimeType', which is invalid.`);
        tex.embedded = viewBytes(img.bufferView as number, `image ${String(t.source)}`).data.slice();
      } else throw new ModelStop("model-accessor-invalid", `glTF: image ${String(t.source)} has neither a uri nor a bufferView`);
      if (tex.embedded) note("model-texture-embedded", "info", "the texture is embedded in the model: the editor extracts it to textures/models/<name>.png, which the engine loads (v1 reads textures by file)");
      if (tex.mimeType && tex.mimeType !== "image/png" && tex.mimeType !== "image/jpeg") note("model-image-format", "warning", `material ${i}: texture type ${tex.mimeType}: the game's loader reads PNG (and JPEG) only`);
    }
    mat.texture = tex;
  }
  void buffers;
  return mat;
}
