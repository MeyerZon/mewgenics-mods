// The editor-side 3D model readers (docs/3d-importer-design.md "Editor side"): editor/src/core/art/obj-read.ts,
// gltf-read.ts and model-read.ts (game axes, budgets, the iso wireframe preview). Every fixture is SYNTHETIC — built
// here from numbers with Node built-ins, shaped like the Khronos glTF-Sample-Assets models the design names (Triangle,
// TriangleWithoutIndices, Box, BoxInterleaved, SimpleMeshes, BoxTextured, SimpleSparseAccessor) — so no third-party
// file enters git. The OBJ error texts are the DLL's (native/framework/src/fw_mesh_rules.c on feat/3d-meshes-m1), so
// the editor and the engine reject a file with the same words.
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";
import { readObj } from "../src/core/art/obj-read.ts";
import { readGltf } from "../src/core/art/gltf-read.ts";
import { readModel, toGameAxes, isoProject, isoWireframeSvg, modelBudgetFindings, MODEL_LIMITS } from "../src/core/art/model-read.ts";
import type { ModelRead } from "../src/core/art/model-read.ts";

// ---- synthetic glTF builders --------------------------------------------------------------------------------------
const f32 = (a: number[]): Uint8Array => new Uint8Array(new Float32Array(a).buffer);
const u16 = (a: number[]): Uint8Array => new Uint8Array(new Uint16Array(a).buffer);
const u32 = (a: number[]): Uint8Array => new Uint8Array(new Uint32Array(a).buffer);
const u8 = (a: number[]): Uint8Array => new Uint8Array(a);

/** A growing binary buffer; add() pads to 4 bytes first and returns the view's offset/length. */
class Bin {
  parts: Uint8Array[] = [];
  len = 0;
  add(b: Uint8Array): { byteOffset: number; byteLength: number } {
    const pad = (4 - (this.len % 4)) % 4;
    if (pad) { this.parts.push(new Uint8Array(pad)); this.len += pad; }
    const off = this.len;
    this.parts.push(b); this.len += b.length;
    return { byteOffset: off, byteLength: b.length };
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.len); let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

type Json = Record<string, unknown>;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dataUri = (b: Uint8Array): string => "data:application/octet-stream;base64," + Buffer.from(b).toString("base64");

/** a .gltf text with the BIN embedded as a data URI */
function gltfText(json: Json, bin: Uint8Array): Uint8Array {
  const j = { ...json, buffers: [{ uri: dataUri(bin), byteLength: bin.length }] };
  return enc(JSON.stringify(j));
}
/** a .glb: 12-byte header, JSON chunk (space-padded), BIN chunk (zero-padded) */
function glb(json: Json, bin: Uint8Array | null, opts: { version?: number; lengthDelta?: number; jsonPad?: number } = {}): Uint8Array {
  const j = bin ? { ...json, buffers: [{ byteLength: bin.length }] } : json;
  let jb = enc(JSON.stringify(j));
  const jpad = opts.jsonPad ?? (4 - (jb.length % 4)) % 4;
  const jsonChunk = new Uint8Array(jb.length + jpad).fill(0x20); jsonChunk.set(jb);
  jb = jsonChunk;
  const bpad = bin ? (4 - (bin.length % 4)) % 4 : 0;
  const total = 12 + 8 + jb.length + (bin ? 8 + bin.length + bpad : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, opts.version ?? 2, true); dv.setUint32(8, total + (opts.lengthDelta ?? 0), true);
  dv.setUint32(12, jb.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(jb, 20);
  if (bin) {
    const o = 20 + jb.length;
    dv.setUint32(o, bin.length + bpad, true); dv.setUint32(o + 4, 0x004e4942, true); out.set(bin, o + 8);
  }
  return out;
}

/** Triangle (glTF-Sample-Assets "Triangle" shape): u16 indices view 0, positions view 1, one node, one mesh. */
function triangleDoc(opts: { indices?: "u8" | "u16" | "u32" | "none"; extra?: Json } = {}): { json: Json; bin: Uint8Array } {
  const b = new Bin();
  const kind = opts.indices ?? "u16";
  const views: Json[] = [];
  const accessors: Json[] = [];
  const prim: Json = { attributes: { POSITION: 0 } };
  const pv = b.add(f32([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  views.push({ buffer: 0, ...pv, target: 34962 });
  accessors.push({ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] });
  if (kind !== "none") {
    const data = kind === "u8" ? u8([0, 1, 2]) : kind === "u16" ? u16([0, 1, 2]) : u32([0, 1, 2]);
    const iv = b.add(data);
    views.push({ buffer: 0, ...iv, target: 34963 });
    accessors.push({ bufferView: 1, componentType: kind === "u8" ? 5121 : kind === "u16" ? 5123 : 5125, count: 3, type: "SCALAR" });
    prim.indices = 1;
  }
  const json: Json = {
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [prim] }], bufferViews: views, accessors, ...(opts.extra ?? {}),
  };
  return { json, bin: b.bytes() };
}

/** A unit box (glTF "Box"-like): 24 verts with normals (and optional uvs), 36 u16 indices; interleaved or not. */
function boxDoc(opts: { interleaved?: boolean; uvs?: "f32" | "u16n" | "none"; nodes?: Json[]; sceneNodes?: number[]; materials?: Json[]; extra?: Json } = {}): { json: Json; bin: Uint8Array } {
  const P: number[] = [], N: number[] = [], T: number[] = [], I: number[] = [];
  const faces: [number[], number[], number[]][] = [ // normal, u axis, v axis
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [n, u, v] of faces) {
    const base = P.length / 3;
    for (const [a, c] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      P.push(0.5 * (n[0]! + a * u[0]! + c * v[0]!), 0.5 * (n[1]! + a * u[1]! + c * v[1]!), 0.5 * (n[2]! + a * u[2]! + c * v[2]!));
      N.push(n[0]!, n[1]!, n[2]!);
      T.push((a + 1) / 2, (1 - c) / 2);
    }
    I.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const b = new Bin();
  const views: Json[] = [];
  const accessors: Json[] = [];
  const attributes: Json = {};
  const uvKind = opts.uvs ?? "none";
  if (opts.interleaved) {
    const stride = 32;
    const nv = P.length / 3;
    const ab = new ArrayBuffer(nv * stride);
    const dv = new DataView(ab);
    for (let i = 0; i < nv; i++) {
      for (let k = 0; k < 3; k++) dv.setFloat32(i * stride + 4 * k, P[3 * i + k]!, true);
      for (let k = 0; k < 3; k++) dv.setFloat32(i * stride + 12 + 4 * k, N[3 * i + k]!, true);
      for (let k = 0; k < 2; k++) dv.setFloat32(i * stride + 24 + 4 * k, T[2 * i + k]!, true);
    }
    const v = b.add(new Uint8Array(ab));
    views.push({ buffer: 0, ...v, byteStride: stride, target: 34962 });
    accessors.push({ bufferView: 0, byteOffset: 0, componentType: 5126, count: nv, type: "VEC3", min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] });
    accessors.push({ bufferView: 0, byteOffset: 12, componentType: 5126, count: nv, type: "VEC3" });
    attributes.POSITION = 0; attributes.NORMAL = 1;
    if (uvKind === "f32") { accessors.push({ bufferView: 0, byteOffset: 24, componentType: 5126, count: nv, type: "VEC2" }); attributes.TEXCOORD_0 = 2; }
  } else {
    const pv = b.add(f32(P)); views.push({ buffer: 0, ...pv, target: 34962 });
    accessors.push({ bufferView: views.length - 1, componentType: 5126, count: P.length / 3, type: "VEC3", min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] });
    attributes.POSITION = accessors.length - 1;
    const nvw = b.add(f32(N)); views.push({ buffer: 0, ...nvw, target: 34962 });
    accessors.push({ bufferView: views.length - 1, componentType: 5126, count: N.length / 3, type: "VEC3" });
    attributes.NORMAL = accessors.length - 1;
    if (uvKind !== "none") {
      const tv = uvKind === "f32" ? b.add(f32(T)) : b.add(u16(T.map((x) => Math.round(x * 65535))));
      views.push({ buffer: 0, ...tv, target: 34962 });
      accessors.push({ bufferView: views.length - 1, componentType: uvKind === "f32" ? 5126 : 5123, normalized: uvKind === "u16n", count: T.length / 2, type: "VEC2" });
      attributes.TEXCOORD_0 = accessors.length - 1;
    }
  }
  const iv = b.add(u16(I)); views.push({ buffer: 0, ...iv, target: 34963 });
  accessors.push({ bufferView: views.length - 1, componentType: 5123, count: I.length, type: "SCALAR" });
  const prim: Json = { attributes, indices: accessors.length - 1 };
  if (opts.materials) prim.material = 0;
  const json: Json = {
    asset: { version: "2.0", generator: "synthetic" }, scene: 0,
    scenes: [{ nodes: opts.sceneNodes ?? [0] }], nodes: opts.nodes ?? [{ mesh: 0 }],
    meshes: [{ primitives: [prim] }], bufferViews: views, accessors,
    ...(opts.materials ? { materials: opts.materials } : {}), ...(opts.extra ?? {}),
  };
  return { json, bin: b.bytes() };
}

const codes = (r: ModelRead): string => r.findings.map((f) => f.code).join(",");
const errors = (r: ModelRead) => r.findings.filter((f) => f.severity === "error");
const near = (a: number, b: number, eps = 1e-5): boolean => Math.abs(a - b) <= eps;

export function runModelReadTests(test: TestFn, assert: AssertFn, eq: EqFn): void {
  console.log("\n# 3D model readers (OBJ / glTF 2.0 subset, game axes, iso wireframe preview)");

  // ---- OBJ ----------------------------------------------------------------------------------------------------
  test("obj: a v/vt/vn triangle reads 3 vertices, 1 triangle; vt v is flipped to the image convention (Godot: uv.y = 1 - v)", () => {
    const r = readObj("v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0.25\nvt 1 0.25\nvt 0 1\nvn 0 0 1\nf 1/1/1 2/2/1 3/3/1\n");
    eq(errors(r).length, 0, codes(r));
    const m = r.mesh!;
    eq(m.positions.length, 9); eq(m.indices.join(","), "0,1,2");
    assert(m.normals !== null && m.uvs !== null, "normals + uvs");
    assert(near(m.uvs![1]!, 0.75), `v 0.25 -> 0.75, got ${m.uvs![1]}`);
    eq(r.stats.triangles, 1); eq(r.format, "obj");
  });
  test("obj: n-gons are fan-triangulated (quad -> 2, pentagon -> 3), like the DLL and Godot's OBJ importer", () => {
    const q = readObj("v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n");
    eq(q.mesh!.indices.join(","), "0,1,2,0,2,3");
    const p = readObj("v 0 0 0\nv 1 0 0\nv 1.5 1 0\nv 0.5 1.5 0\nv -0.5 1 0\nf 1 2 3 4 5\n");
    eq(p.stats.triangles, 3);
  });
  test("obj: negative indices resolve against the count read so far (Blender's parse_vertex_index rule)", () => {
    const r = readObj("v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n");
    eq(errors(r).length, 0, codes(r)); eq(r.stats.triangles, 1);
    assert(near(r.mesh!.positions[3]!, 1), "second corner = v 2");
  });
  test("obj: corners are deduplicated on the (v, vt, vn) triple: a v-only cube is 8 vertices, 12 triangles", () => {
    const v = "v -1 -1 -1\nv 1 -1 -1\nv 1 1 -1\nv -1 1 -1\nv -1 -1 1\nv 1 -1 1\nv 1 1 1\nv -1 1 1\n";
    const f = "f 1 4 3 2\nf 5 6 7 8\nf 1 2 6 5\nf 2 3 7 6\nf 3 4 8 7\nf 4 1 5 8\n";
    const r = readObj(v + f);
    eq(r.stats.vertices, 8); eq(r.stats.triangles, 12);
    assert(r.findings.some((x) => x.code === "model-no-normals" && x.severity === "info"), "no vn -> info: flat normals are generated");
  });
  test("obj: errors carry the DLL's words and the line (index 0, out of range, unsupported, unknown, continuation, no faces)", () => {
    const cases: [string, string][] = [
      ["v 0 0 0\nf 0 1 1\n", "face index 0 is invalid (OBJ indices start at 1) at line 2"],
      ["v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 7\n", "face index 7 out of range (3 vertices) at line 4"],
      ["v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nf 1/2 2/1 3/1\n", "face texcoord index 2 out of range (1 texcoords) at line 5"],
      ["v 0 0 0\nv 1 0 0\nl 1 2\n", "unsupported OBJ statement 'l' at line 3"],
      ["v 0 0 0\nfoo bar\n", "unknown OBJ statement 'foo' at line 2"],
      ["v 0 0 \\\n0\n", "line continuation '\\' is not supported at line 1"],
      ["v 0 0 zero\n", "not a number 'zero' in 'v' at line 1"],
      ["v 0 0 0\nv 1 0 0\nf 1 2\n", "a face needs at least 3 corners, got 2 at line 3"],
      ["v 0 0 0\n# just a point\n", "no faces"],
    ];
    for (const [src, msg] of cases) {
      const r = readObj(src);
      eq(r.mesh, null, `no mesh for ${JSON.stringify(src)}`);
      const e = errors(r);
      eq(e.length, 1, `one error for ${JSON.stringify(src)}: ${codes(r)}`);
      eq(e[0]!.code, "model-parse-error");
      eq(e[0]!.message, msg);
    }
    eq(errors(readObj("v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nf 1/2 2/1 3/1\n"))[0]!.line, 5, "the line is kept");
  });
  test("obj: CRLF, a UTF-8 BOM, # comments (also after a statement) and the ignored statements read clean", () => {
    const r = readObj("﻿# header\r\nmtllib crate.mtl\r\no Crate\r\ng body\r\ns off\r\nusemtl wood\r\nv 0 0 0 # a\r\nv 1 0 0\r\nv 0 1 0\r\nf 1 2 3\r\n");
    eq(errors(r).length, 0, codes(r)); eq(r.stats.triangles, 1);
  });
  test("obj: a second distinct usemtl warns model-multi-material (v1 draws one material); a concave quad warns model-ngon-concave", () => {
    const m = readObj("v 0 0 0\nv 1 0 0\nv 0 1 0\nv 1 1 0\nusemtl a\nf 1 2 3\nusemtl b\nf 2 4 3\n");
    assert(m.findings.some((x) => x.code === "model-multi-material" && x.severity === "warning"), codes(m));
    const c = readObj("v 0 0 0\nv 2 0 0\nv 0.5 0.5 0\nv 0 2 0\nf 1 2 3 4\n");
    assert(c.findings.some((x) => x.code === "model-ngon-concave" && x.severity === "warning"), codes(c));
    eq(errors(c).length, 0, "concave is a warning, the fan is still built");
  });

  // ---- glTF: containers and headers ---------------------------------------------------------------------------
  test("gltf: the Triangle shape (u16 indices, base64 data URI) reads 3 vertices, 1 triangle; no normals -> info", () => {
    const { json, bin } = triangleDoc();
    const r = readGltf(gltfText(json, bin));
    eq(errors(r).length, 0, codes(r));
    eq(r.format, "gltf"); eq(r.stats.vertices, 3); eq(r.stats.triangles, 1);
    eq(r.mesh!.indices.join(","), "0,1,2");
    assert(r.findings.some((x) => x.code === "model-no-normals"), codes(r));
  });
  test("gltf: TriangleWithoutIndices -> indices 0..n-1; u8 / u16 / u32 index types give the same mesh", () => {
    const none = readGltf(gltfText(triangleDoc({ indices: "none" }).json, triangleDoc({ indices: "none" }).bin));
    eq(none.mesh!.indices.join(","), "0,1,2", codes(none));
    for (const k of ["u8", "u16", "u32"] as const) {
      const d = triangleDoc({ indices: k });
      const r = readGltf(glb(d.json, d.bin));
      eq(r.format, "glb"); eq(errors(r).length, 0, `${k}: ${codes(r)}`); eq(r.mesh!.indices.join(","), "0,1,2", k);
    }
  });
  test("glb: container checks (magic, version 2, length = file size, JSON first, 4-byte chunks) — Blender's load_glb wording", () => {
    const d = triangleDoc();
    const ok = glb(d.json, d.bin);
    const badMagic = ok.slice(); badMagic[0] = 0x00;
    const cases: [Uint8Array, string, string][] = [
      [glb(d.json, d.bin, { version: 1 }), "model-glb-header", "GLB version must be 2; got 1"],
      [glb(d.json, d.bin, { lengthDelta: 4 }), "model-glb-header", "Bad GLB: file size doesn't match"],
      [ok.slice(0, ok.length - 3), "model-glb-header", "Bad GLB: file size doesn't match"],
    ];
    for (const [bytes, code, msg] of cases) {
      const r = readGltf(bytes);
      eq(r.mesh, null); eq(errors(r)[0]?.code, code, codes(r)); eq(errors(r)[0]?.message, msg);
    }
    const bm = readGltf(badMagic);
    eq(errors(bm)[0]?.code, "model-parse-error", "no magic = parsed as JSON text, which fails");
    // a JSON chunk whose length is not a multiple of 4
    const mis = glb(d.json, d.bin, { jsonPad: ((4 - (enc(JSON.stringify({ ...d.json, buffers: [{ byteLength: d.bin.length }] })).length % 4)) % 4) + 1 });
    const rm = readGltf(mis);
    eq(errors(rm)[0]?.code, "model-glb-header", codes(rm));
    assert(/4-byte/.test(errors(rm)[0]!.message), errors(rm)[0]!.message);
  });
  test("gltf: asset.version major 2 only; minVersion above 2.0 refused; bad JSON reported with Godot's prefix", () => {
    const d = triangleDoc();
    const v1 = readGltf(gltfText({ ...d.json, asset: { version: "1.0" } }, d.bin));
    eq(errors(v1)[0]?.code, "model-gltf-version"); eq(errors(v1)[0]?.message, "glTF version must be 2.x; got 1.0");
    const mv = readGltf(gltfText({ ...d.json, asset: { version: "2.1", minVersion: "2.1" } }, d.bin));
    eq(errors(mv)[0]?.code, "model-gltf-version");
    const v21 = readGltf(gltfText({ ...d.json, asset: { version: "2.1" } }, d.bin));
    eq(errors(v21).length, 0, "2.1 without minVersion loads (spec: check the major version)");
    const bad = readGltf(enc("{ \"asset\": "));
    eq(errors(bad)[0]?.code, "model-parse-error");
    assert(errors(bad)[0]!.message.startsWith("glTF: Error parsing .gltf JSON data: "), errors(bad)[0]!.message);
  });
  test("gltf: extensionsRequired is refused by name (Godot's message); extensionsUsed alone is an info", () => {
    const d = triangleDoc({ extra: { extensionsUsed: ["KHR_draco_mesh_compression"], extensionsRequired: ["KHR_draco_mesh_compression"] } });
    const r = readGltf(gltfText(d.json, d.bin));
    eq(r.mesh, null); eq(errors(r)[0]?.code, "model-extension-required");
    eq(errors(r)[0]?.message, "glTF: Can't import file, required extension 'KHR_draco_mesh_compression' is not supported (export without it)");
    const u = triangleDoc({ extra: { extensionsUsed: ["KHR_materials_specular"] } });
    const ru = readGltf(gltfText(u.json, u.bin));
    eq(errors(ru).length, 0); assert(ru.findings.some((x) => x.code === "model-extension-ignored" && x.severity === "info"), codes(ru));
  });

  // ---- glTF: accessors / buffers ------------------------------------------------------------------------------
  test("gltf: BoxInterleaved (byteStride 32: position, normal, uv in one view) equals the separate-views box", () => {
    const a = readGltf(glb(boxDoc({ interleaved: true, uvs: "f32" }).json, boxDoc({ interleaved: true, uvs: "f32" }).bin));
    const b = readGltf(glb(boxDoc({ uvs: "f32" }).json, boxDoc({ uvs: "f32" }).bin));
    eq(errors(a).length, 0, codes(a)); eq(errors(b).length, 0, codes(b));
    eq(a.stats.vertices, 24); eq(a.stats.triangles, 12);
    eq(Array.from(a.mesh!.positions).join(","), Array.from(b.mesh!.positions).join(","));
    eq(Array.from(a.mesh!.normals!).join(","), Array.from(b.mesh!.normals!).join(","));
    eq(Array.from(a.mesh!.uvs!).join(","), Array.from(b.mesh!.uvs!).join(","));
  });
  test("gltf: normalized UNSIGNED_SHORT TEXCOORD_0 decodes as c / 65535 (spec 3.11, Godot's decode)", () => {
    const f = readGltf(glb(boxDoc({ uvs: "f32" }).json, boxDoc({ uvs: "f32" }).bin));
    const n = readGltf(glb(boxDoc({ uvs: "u16n" }).json, boxDoc({ uvs: "u16n" }).bin));
    eq(errors(n).length, 0, codes(n));
    for (let i = 0; i < f.mesh!.uvs!.length; i++) assert(near(f.mesh!.uvs![i]!, n.mesh!.uvs![i]!, 1e-4), `uv ${i}`);
  });
  test("gltf: an accessor past its bufferView's end is model-buffer-range (Godot: 'buffer view size was smaller ...')", () => {
    const d = triangleDoc();
    (d.json.accessors as Json[])[0]!.count = 4;
    const r = readGltf(gltfText(d.json, d.bin));
    eq(r.mesh, null); eq(errors(r)[0]?.code, "model-buffer-range", codes(r));
    const v = triangleDoc();
    (v.json.bufferViews as Json[])[0]!.byteLength = 400;
    eq(errors(readGltf(gltfText(v.json, v.bin)))[0]?.code, "model-buffer-range", "a view past its buffer");
  });
  test("gltf: misaligned accessor offsets and a byteStride that is not a multiple of 4 are model-accessor-invalid", () => {
    const d = triangleDoc();
    (d.json.accessors as Json[])[1]!.byteOffset = 1;
    (d.json.accessors as Json[])[1]!.count = 2;
    const r = readGltf(gltfText(d.json, d.bin));
    eq(errors(r)[0]?.code, "model-accessor-invalid", codes(r));
    assert(/multiple of the size of the accessor's component type/.test(errors(r)[0]!.message), errors(r)[0]!.message);
    const s = boxDoc({ interleaved: true });
    (s.json.bufferViews as Json[])[0]!.byteStride = 30;
    const rs = readGltf(glb(s.json, s.bin));
    eq(errors(rs)[0]?.code, "model-accessor-invalid", codes(rs));
    assert(/byte stride 30/.test(errors(rs)[0]!.message), errors(rs)[0]!.message);
  });
  test("gltf: a sparse POSITION is model-sparse-unsupported; sparse data only inside morph targets is skipped with the targets", () => {
    const d = triangleDoc();
    (d.json.accessors as Json[])[0]!.sparse = { count: 1, indices: { bufferView: 1, componentType: 5123 }, values: { bufferView: 0 } };
    const r = readGltf(gltfText(d.json, d.bin));
    eq(errors(r)[0]?.code, "model-sparse-unsupported", codes(r));
    const t = triangleDoc();
    (t.json.accessors as Json[]).push({ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", sparse: { count: 1, indices: { bufferView: 1, componentType: 5123 }, values: { bufferView: 0 } } });
    ((t.json.meshes as Json[])[0]!.primitives as Json[])[0]!.targets = [{ POSITION: 2 }];
    const rt = readGltf(gltfText(t.json, t.bin));
    eq(errors(rt).length, 0, codes(rt));
    assert(rt.findings.some((x) => x.code === "model-morph-ignored" && x.severity === "warning"), codes(rt));
  });
  test("gltf: index checks — out of range, count not a multiple of 3 (Godot's wording), non-triangle mode", () => {
    const d = triangleDoc({ indices: "u16" });
    const b = d.bin.slice(); new DataView(b.buffer).setUint16(36 + 4, 9, true); // indices view starts at 36: [0, 1, 9]
    const r = readGltf(gltfText(d.json, b));
    eq(errors(r)[0]?.code, "model-index-range", codes(r));
    const m = triangleDoc();
    (m.json.accessors as Json[])[1]!.count = 2;
    const rm = readGltf(gltfText(m.json, m.bin));
    eq(errors(rm)[0]?.code, "model-index-range");
    assert(/MUST have an index array with a size that is a multiple of 3, but got 2 indices/.test(errors(rm)[0]!.message), errors(rm)[0]!.message);
    const l = triangleDoc();
    ((l.json.meshes as Json[])[0]!.primitives as Json[])[0]!.mode = 1;
    eq(errors(readGltf(gltfText(l.json, l.bin)))[0]?.code, "model-primitive-mode");
  });
  test("gltf: a missing external .bin is model-buffer-missing; a resolver supplies it; http URIs are refused", () => {
    const d = triangleDoc();
    const json = { ...d.json, buffers: [{ uri: "tri.bin", byteLength: d.bin.length }] };
    const miss = readGltf(enc(JSON.stringify(json)));
    eq(errors(miss)[0]?.code, "model-buffer-missing"); eq(errors(miss)[0]?.message, "glTF: Binary file not found: tri.bin");
    const ok = readGltf(enc(JSON.stringify(json)), { resolve: (u) => (u === "tri.bin" ? d.bin : null) });
    eq(errors(ok).length, 0, codes(ok)); eq(ok.stats.triangles, 1);
    const web = readGltf(enc(JSON.stringify({ ...d.json, buffers: [{ uri: "https://example.com/tri.bin", byteLength: d.bin.length }] })));
    eq(errors(web)[0]?.code, "model-uri-unsupported");
  });

  // ---- glTF: scene graph --------------------------------------------------------------------------------------
  test("gltf: the Box shape's root matrix (a -90° turn about X) is baked into the vertices", () => {
    const m = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
    const d = boxDoc({ nodes: [{ children: [1], matrix: m }, { mesh: 0 }] });
    const r = readGltf(glb(d.json, d.bin));
    eq(errors(r).length, 0, codes(r));
    // the +Z face normal (0,0,1) rotated by the matrix: column-major, so n' = col2 * 1 = (0, 1, 0)
    const N = r.mesh!.normals!;
    let found = false;
    for (let i = 0; i < N.length; i += 3) if (near(N[i]!, 0) && near(N[i + 1]!, 1) && near(N[i + 2]!, 0)) found = true;
    const plain = readGltf(glb(boxDoc().json, boxDoc().bin));
    eq(Array.from(plain.mesh!.normals!).slice(48, 51).join(","), "0,0,1", "face 4 of the unrotated box faces +Z");
    assert(found && near(N[49]!, 1), `face 4 now faces +Y, got ${Array.from(N.slice(48, 51))}`);
  });
  test("gltf: SimpleMeshes (one mesh, two nodes, translation [1,0,0]) gives two copies merged into one triangle list", () => {
    const d = triangleDoc();
    const json = { ...d.json, scenes: [{ nodes: [0, 1] }], nodes: [{ mesh: 0 }, { mesh: 0, translation: [1, 0, 0] }] };
    const r = readGltf(gltfText(json, d.bin));
    eq(errors(r).length, 0, codes(r)); eq(r.stats.triangles, 2); eq(r.stats.vertices, 6);
    eq(r.mesh!.indices.join(","), "0,1,2,3,4,5"); eq(r.mesh!.positions[9], 1, "second copy shifted by x+1");
  });
  test("gltf: a node with a negative determinant (scale [-1,1,1]) reverses its triangles (Godot's merge_importer_meshes rule)", () => {
    const d = triangleDoc();
    const json = { ...d.json, nodes: [{ mesh: 0, scale: [-1, 1, 1] }] };
    const r = readGltf(gltfText(json, d.bin));
    eq(errors(r).length, 0, codes(r)); eq(r.mesh!.indices.join(","), "0,2,1");
    eq(r.mesh!.positions[3], -1, "x mirrored");
  });
  test("gltf: a node cycle and an empty scene are errors (model-node-cycle, model-empty)", () => {
    const d = triangleDoc();
    const cyc = readGltf(gltfText({ ...d.json, nodes: [{ children: [1] }, { children: [0], mesh: 0 }] }, d.bin));
    eq(errors(cyc)[0]?.code, "model-node-cycle", codes(cyc));
    const empty = readGltf(gltfText({ ...d.json, nodes: [{}] }, d.bin));
    eq(errors(empty)[0]?.code, "model-empty", codes(empty));
  });
  test("gltf: skins, animations, cameras are skipped with findings (the bind pose is drawn)", () => {
    const d = triangleDoc({ extra: { animations: [{ channels: [], samplers: [] }], skins: [{ joints: [0] }] } });
    const r = readGltf(gltfText({ ...d.json, nodes: [{ mesh: 0, skin: 0 }] }, d.bin));
    eq(errors(r).length, 0, codes(r));
    assert(r.findings.some((x) => x.code === "model-skin-ignored"), codes(r));
    assert(r.findings.some((x) => x.code === "model-animation-ignored"), codes(r));
  });

  // ---- glTF: materials and textures ---------------------------------------------------------------------------
  test("gltf: BoxTextured — baseColorFactor (linear) and an external PNG uri; two materials in use warn model-multi-material", () => {
    const mats = [{ name: "Wood", pbrMetallicRoughness: { baseColorFactor: [0.5, 0.25, 1, 1], baseColorTexture: { index: 0 } } }];
    const d = boxDoc({ uvs: "f32", materials: mats, extra: { textures: [{ source: 0 }], images: [{ uri: "crate.png" }] } });
    const r = readGltf(glb(d.json, d.bin));
    eq(errors(r).length, 0, codes(r));
    const m = r.materials[0]!;
    eq(m.name, "Wood"); eq(m.baseColor.join(","), "0.5,0.25,1,1"); eq(m.texture?.uri, "crate.png"); eq(m.texture?.texCoord, 0);
    eq(r.primitiveMaterials.join(","), "0");
    const two = boxDoc({ materials: [{}, {}] });
    const prims = (two.json.meshes as Json[])[0]!.primitives as Json[];
    prims.push({ ...prims[0]!, material: 1 });
    const r2 = readGltf(glb(two.json, two.bin));
    assert(r2.findings.some((x) => x.code === "model-multi-material" && x.severity === "warning"), codes(r2));
  });
  test("glb: an embedded image (bufferView + mimeType) is returned as bytes; KHR_texture_transform and texCoord 1 warn", () => {
    const png = u8([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const d = boxDoc({ uvs: "f32", materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 1, extensions: { KHR_texture_transform: { scale: [2, 2] } } } } }] });
    const b = new Bin(); b.add(d.bin); const pv = b.add(png);
    (d.json.bufferViews as Json[]).push({ buffer: 0, ...pv });
    d.json.images = [{ bufferView: (d.json.bufferViews as Json[]).length - 1, mimeType: "image/png" }];
    d.json.textures = [{ source: 0 }];
    d.json.extensionsUsed = ["KHR_texture_transform"];
    const r = readGltf(glb(d.json, b.bytes()));
    eq(errors(r).length, 0, codes(r));
    const t = r.materials[0]!.texture!;
    eq(t.mimeType, "image/png"); eq(t.embedded?.length, png.length); eq(t.embedded?.[1], 0x50);
    assert(r.findings.some((x) => x.code === "model-texture-transform-ignored"), codes(r));
    assert(r.findings.some((x) => x.code === "model-texcoord-set"), codes(r));
    assert(r.findings.some((x) => x.code === "model-texture-embedded" && x.severity === "info"), codes(r));
  });
  test("gltf: alphaMode BLEND warns (cut-out only), doubleSided is carried", () => {
    const d = boxDoc({ materials: [{ alphaMode: "BLEND", doubleSided: true }] });
    const r = readGltf(glb(d.json, d.bin));
    eq(r.materials[0]!.alphaMode, "BLEND"); eq(r.materials[0]!.doubleSided, true);
    assert(r.findings.some((x) => x.code === "model-alpha-blend"), codes(r));
  });

  // ---- game axes, budgets, preview, dispatch ------------------------------------------------------------------
  test("toGameAxes: x_g = s·x, h = s·y, z_g = -s·z, normals mirrored, every triangle reversed (fw_mesh_to_game_axes)", () => {
    const d = boxDoc();
    const src = readGltf(glb(d.json, d.bin)).mesh!;
    const before = Array.from(src.positions).join(",");
    const g = toGameAxes(src, 2);
    eq(g.positions[0], 2 * src.positions[0]!); eq(g.positions[1], 2 * src.positions[1]!); eq(g.positions[2], -2 * src.positions[2]!);
    assert(near(g.normals![50]!, -1), "the +Z face normal becomes -z in game axes");
    eq(`${g.indices[0]},${g.indices[1]},${g.indices[2]}`, `${src.indices[0]},${src.indices[2]},${src.indices[1]}`);
    eq(Array.from(src.positions).join(","), before, "the source is not mutated");
  });
  test("isoProject: the game's ISO columns (x -> (0.894, 0.447), h -> (0, 1), z -> (-0.894, 0.447)) with SVG y down", () => {
    const [ax, ay] = isoProject(1, 0, 0); assert(near(ax, 0.894427) && near(ay, -0.447214), `${ax},${ay}`);
    const [bx, by] = isoProject(0, 1, 0); assert(near(bx, 0) && near(by, -1), `${bx},${by}`);
    const [cx, cy] = isoProject(0, 0, 1); assert(near(cx, -0.894427) && near(cy, -0.447214), `${cx},${cy}`);
  });
  test("isoWireframeSvg: one <line> per unique edge, a tile diamond, and the bounds in the title", () => {
    const r = readObj("v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n");
    const svg = isoWireframeSvg(toGameAxes(r.mesh!, 1));
    eq((svg.match(/<line /g) || []).length, 5, "a quad as 2 triangles has 5 unique edges");
    assert(svg.includes("<polygon") && svg.startsWith("<svg"), "a tile outline polygon");
    assert(/<title>[^<]*5 edges[^<]*<\/title>/.test(svg), svg.slice(0, 300));
  });
  test("modelBudgetFindings: model-heavy above the triangle budget, model-below-floor under h < -0.01, model-footprint past one tile", () => {
    const big = { positions: new Float32Array([0, -0.5, 0, 3, 0, 0, 0, 1, 0]), normals: null, uvs: null, indices: new Uint32Array(3 * (MODEL_LIMITS.budgetTriangles + 1)) };
    const f = modelBudgetFindings(big);
    const c = f.map((x) => x.code).join(",");
    assert(c.includes("model-heavy") && c.includes("model-below-floor") && c.includes("model-footprint"), c);
    const small = toGameAxes(readObj("v -0.4 0 -0.4\nv 0.4 0 -0.4\nv 0 0.8 0.4\nf 1 2 3\n").mesh!, 1);
    eq(modelBudgetFindings(small).length, 0, modelBudgetFindings(small).map((x) => x.code).join(","));
  });
  test("readModel dispatches on the extension (.obj / .gltf / .glb, else model-extension); a .glb without the magic is an error", () => {
    const d = triangleDoc();
    eq(readModel("models/t.gltf", gltfText(d.json, d.bin)).stats.triangles, 1);
    eq(readModel("models/t.glb", glb(d.json, d.bin)).stats.triangles, 1);
    eq(readModel("models/t.obj", enc("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n")).stats.triangles, 1);
    eq(errors(readModel("models/t.fbx", u8([1, 2, 3])))[0]?.code, "model-extension");
    eq(errors(readModel("models/t.glb", gltfText(d.json, d.bin)))[0]?.code, "model-glb-header");
  });
}
