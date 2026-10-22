// The generated sample assets of mods/fw-3d (3D phase M2/M3, docs/possible_3d_work.md): the crate's texture
// (textures/models/crate.png) and a tiny glTF binary (models/pillar.glb). Pure (no fs): editor/scripts/make-fw3d-assets.ts
// writes them, editor/test/fw3d-assets-tests.ts re-generates them and compares with the committed files, so this file
// is the source of both. Hand-made for this repo: no game data.
//
// The colours are chosen to be MEASURED in a T2 shot (editor/src/core/art/mesh-measure.ts):
//  - the crate texture is a 2 x 2 checker of a GREY (r = g = b: a palette index when the object has a palette row,
//    fw_mesh.shader's paletted_full rule) and an ORANGE (never grey: passes through the palette unchanged);
//  - the pillar's glTF baseColorFactor is a teal no arena tile has.
import { encodePng } from "./png.ts";

/** crate.png: 16 x 16 RGBA, four 8 x 8 cells, grey top-left and bottom-right */
export const CRATE_TEXTURE = { size: 16, cell: 8, grey: [96, 96, 96] as const, orange: [230, 120, 20] as const };

export function crateTexturePixels(): Uint8Array {
  const { size, cell, grey, orange } = CRATE_TEXTURE;
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? grey : orange;
      rgba.set([c[0], c[1], c[2], 255], (y * size + x) * 4);
    }
  }
  return rgba;
}

export function crateTexturePng(): Uint8Array {
  return encodePng(CRATE_TEXTURE.size, CRATE_TEXTURE.size, crateTexturePixels());
}

/** pillar.glb: a 0.5 x 1.2 x 0.5 box standing on its origin (glTF +Y up, metres = tiles), 24 vertices with NORMAL and
 * TEXCOORD_0, 36 uint16 indices (counter-clockwise from outside), one material with this baseColorFactor (linear) */
export const PILLAR = { half: 0.25, height: 1.2, baseColor: [0.1, 0.55, 0.75, 1] as const };

type V3 = [number, number, number];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function pillarGeometry(): { positions: number[]; normals: number[]; uvs: number[]; indices: number[] } {
  const { half, height } = PILLAR;
  // per face: outward normal n, in-plane axes u, v with u x v = n (so (0,1,2), (0,2,3) are counter-clockwise from outside)
  const faces: { n: V3; u: V3; v: V3 }[] = [
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
  ];
  const ext: V3 = [half, height / 2, half];
  const centre: V3 = [0, height / 2, 0];
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  for (const { n, u, v } of faces) {
    const c = cross(u, v);
    if (c[0] !== n[0] || c[1] !== n[1] || c[2] !== n[2]) throw new Error("pillar: u x v != n");
    const along = (a: V3) => Math.abs(a[0]) * ext[0] + Math.abs(a[1]) * ext[1] + Math.abs(a[2]) * ext[2];
    const fc: V3 = [centre[0] + n[0] * along(n), centre[1] + n[1] * along(n), centre[2] + n[2] * along(n)];
    const su = along(u), sv = along(v);
    const base = positions.length / 3;
    for (const [a, b, uv] of [[-1, -1, [0, 1]], [1, -1, [1, 1]], [1, 1, [1, 0]], [-1, 1, [0, 0]]] as [number, number, number[]][]) {
      positions.push(...[0, 1, 2].map((k) => +(fc[k]! + a * su * u[k]! + b * sv * v[k]!).toFixed(6)));
      normals.push(...n);
      uvs.push(...uv);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, normals, uvs, indices };
}

function pad4(n: number): number { return (n + 3) & ~3; }

export function pillarGlb(): Uint8Array {
  const g = pillarGeometry();
  const nv = g.positions.length / 3;
  const pos = new Float32Array(g.positions), nrm = new Float32Array(g.normals), uv = new Float32Array(g.uvs), idx = new Uint16Array(g.indices);
  const views = [pos, nrm, uv, idx];
  const offsets: number[] = [];
  let bin = 0;
  for (const v of views) { offsets.push(bin); bin = pad4(bin + v.byteLength); }
  const min = [0, 1, 2].map((k) => Math.min(...g.positions.filter((_, i) => i % 3 === k)));
  const max = [0, 1, 2].map((k) => Math.max(...g.positions.filter((_, i) => i % 3 === k)));
  const json = {
    asset: { version: "2.0", generator: "mewgenics-mods editor/src/core/art/fw3d-assets.ts" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "pillar", mesh: 0 }],
    meshes: [{ name: "pillar", primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0, mode: 4 }] }],
    materials: [{ name: "teal", pbrMetallicRoughness: { baseColorFactor: [...PILLAR.baseColor], metallicFactor: 0, roughnessFactor: 1 } }],
    buffers: [{ byteLength: bin }],
    bufferViews: [
      { buffer: 0, byteOffset: offsets[0], byteLength: pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: offsets[1], byteLength: nrm.byteLength, target: 34962 },
      { buffer: 0, byteOffset: offsets[2], byteLength: uv.byteLength, target: 34962 },
      { buffer: 0, byteOffset: offsets[3], byteLength: idx.byteLength, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: nv, type: "VEC3", min, max },
      { bufferView: 1, componentType: 5126, count: nv, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: nv, type: "VEC2" },
      { bufferView: 3, componentType: 5123, count: idx.length, type: "SCALAR" },
    ],
  };
  return packGlb(json, views.map((v) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength)), offsets, bin);
}

/** a GLB 2.0 container: the JSON chunk (space-padded) and one BIN chunk holding views[i] at offsets[i] (bin bytes) */
function packGlb(json: unknown, views: Uint8Array[], offsets: number[], bin: number): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jlen = pad4(jsonBytes.length);
  const total = 12 + 8 + jlen + 8 + bin;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);   // "glTF"
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jlen, true);
  dv.setUint32(16, 0x4e4f534a, true);  // "JSON"
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jlen);
  const b0 = 20 + jlen;
  dv.setUint32(b0, bin, true);
  dv.setUint32(b0 + 4, 0x004e4942, true);   // "BIN\0"
  views.forEach((v, i) => out.set(v, b0 + 8 + offsets[i]!));
  return out;
}

/** totem.glb (M3, a model's OWN texture): the pillar's box with a baseColorTexture whose image is EMBEDDED in the
 * BIN chunk (bufferView + mimeType image/png) — no textures/models/totem.png exists, so the DLL must decode the .glb's
 * image itself. The texture is a 2 x 2 checker of a PURPLE and a LIME no arena tile has (measured in the T2 shot);
 * the base colour is white so the texel is drawn as is. */
export const TOTEM = { size: 16, cell: 8, purple: [150, 40, 210] as const, lime: [150, 225, 30] as const, baseColor: [1, 1, 1, 1] as const };

export function totemTexturePixels(): Uint8Array {
  const { size, cell, purple, lime } = TOTEM;
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? purple : lime;
      rgba.set([c[0], c[1], c[2], 255], (y * size + x) * 4);
    }
  }
  return rgba;
}

export function totemTexturePng(): Uint8Array {
  return encodePng(TOTEM.size, TOTEM.size, totemTexturePixels());
}

export function totemGlb(): Uint8Array {
  const g = pillarGeometry();
  const nv = g.positions.length / 3;
  const png = totemTexturePng();
  const pos = new Float32Array(g.positions), nrm = new Float32Array(g.normals), uv = new Float32Array(g.uvs), idx = new Uint16Array(g.indices);
  const views: Uint8Array[] = [pos, nrm, uv, idx].map((v) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  views.push(png);
  const offsets: number[] = [];
  let bin = 0;
  for (const v of views) { offsets.push(bin); bin = pad4(bin + v.byteLength); }
  const min = [0, 1, 2].map((k) => Math.min(...g.positions.filter((_, i) => i % 3 === k)));
  const max = [0, 1, 2].map((k) => Math.max(...g.positions.filter((_, i) => i % 3 === k)));
  const json = {
    asset: { version: "2.0", generator: "mewgenics-mods editor/src/core/art/fw3d-assets.ts" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "totem", mesh: 0 }],
    meshes: [{ name: "totem", primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0, mode: 4 }] }],
    materials: [{ name: "checker", pbrMetallicRoughness: { baseColorFactor: [...TOTEM.baseColor], baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 } }],
    textures: [{ source: 0 }],
    images: [{ name: "totem", bufferView: 4, mimeType: "image/png" }],
    buffers: [{ byteLength: bin }],
    bufferViews: [
      { buffer: 0, byteOffset: offsets[0], byteLength: views[0]!.byteLength, target: 34962 },
      { buffer: 0, byteOffset: offsets[1], byteLength: views[1]!.byteLength, target: 34962 },
      { buffer: 0, byteOffset: offsets[2], byteLength: views[2]!.byteLength, target: 34962 },
      { buffer: 0, byteOffset: offsets[3], byteLength: views[3]!.byteLength, target: 34963 },
      { buffer: 0, byteOffset: offsets[4], byteLength: views[4]!.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: nv, type: "VEC3", min, max },
      { bufferView: 1, componentType: 5126, count: nv, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: nv, type: "VEC2" },
      { bufferView: 3, componentType: 5123, count: idx.length, type: "SCALAR" },
    ],
  };
  return packGlb(json, views, offsets, bin);
}
