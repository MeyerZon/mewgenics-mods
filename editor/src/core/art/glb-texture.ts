// A glTF model's EMBEDDED base-colour image (3D phase M3): the same pick as the DLL (native/framework/src/fw_mesh_gltf.c
// `material` + `embed_view` / `embed_data_uri`): the material of the first primitive that has one, in the default
// scene's depth-first node order (every mesh in order when there are no scenes); its pbrMetallicRoughness
// baseColorTexture -> textures[index].source -> images[source], stored in a bufferView (a .glb's BIN chunk) with
// mimeType image/png, or in a data:image/png;base64 URI. Pure (no fs, no Node Buffer): the core's extractModelTexture
// (api.ts, MCP extract_model_texture) writes the bytes to the convention path mods/<mod>/textures/models/<stem>.png.
// Problems carry the model codes of model-codes.ts (the DLL's FW_MESH_CODES).

export type EmbeddedImageResult =
  | { ok: true; bytes: Uint8Array; source: string; material: number; image: number }
  | { ok: false; code: string; error: string };

const GLB_MAGIC = 0x46546c67, CHUNK_JSON = 0x4e4f534a, CHUNK_BIN = 0x004e4942;
type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => v !== null && typeof v === "object" && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

function b64(s: string): Uint8Array | null {
  const t = s.replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(t) || t.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((t.length * 3) / 4));
  let acc = 0, bits = 0, w = 0;
  for (const c of t) {
    const v = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(c);
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[w++] = (acc >> bits) & 255; }
  }
  return out.subarray(0, w);
}

/** the first material index in the DLL's bake order, or null */
function firstMaterial(doc: J): number | null {
  const meshes = arr(doc["meshes"]), nodes = arr(doc["nodes"]);
  const fromMesh = (mi: number | null): number | null => {
    const m = mi === null ? undefined : meshes[mi];
    if (!isObj(m)) return null;
    for (const p of arr(m["primitives"])) if (isObj(p) && int(p["material"]) !== null) return int(p["material"]);
    return null;
  };
  const scenes = arr(doc["scenes"]);
  if (scenes.length) {
    const sc = scenes[int(doc["scene"]) ?? 0];
    const seen = new Set<number>();
    const walk = (ni: number | null, depth: number): number | null => {
      if (ni === null || seen.has(ni) || depth > 256) return null;
      seen.add(ni);
      const n = nodes[ni];
      if (!isObj(n)) return null;
      const m = "mesh" in n ? fromMesh(int(n["mesh"])) : null;
      if (m !== null) return m;
      for (const c of arr(n["children"])) { const r = walk(int(c), depth + 1); if (r !== null) return r; }
      return null;
    };
    for (const r of arr(isObj(sc) ? sc["nodes"] : [])) { const m = walk(int(r), 0); if (m !== null) return m; }
    return null;
  }
  for (let i = 0; i < meshes.length; i++) { const m = fromMesh(i); if (m !== null) return m; }
  return null;
}

/** The embedded base-colour PNG of a .glb (or a .gltf with a data: URI image). */
export function embeddedBaseColorImage(bytes: Uint8Array): EmbeddedImageResult {
  let jsonText: string, bin: Uint8Array | null = null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 4 && dv.getUint32(0, true) === GLB_MAGIC) {
    if (bytes.length < 20 || dv.getUint32(4, true) !== 2) return { ok: false, code: "model-glb-header", error: "not a GLB 2.0 container" };
    const total = Math.min(dv.getUint32(8, true), bytes.length), l0 = dv.getUint32(12, true);
    if (dv.getUint32(16, true) !== CHUNK_JSON || 20 + l0 > total) return { ok: false, code: "model-glb-header", error: "the first GLB chunk is not a JSON chunk inside the file" };
    jsonText = new TextDecoder().decode(bytes.subarray(20, 20 + l0));
    const at = 20 + l0;
    if (at + 8 <= total && dv.getUint32(at + 4, true) === CHUNK_BIN) {
      const l1 = dv.getUint32(at, true);
      if (at + 8 + l1 > total) return { ok: false, code: "model-glb-header", error: "the BIN chunk is past the end of the file" };
      bin = bytes.subarray(at + 8, at + 8 + l1);
    }
  } else jsonText = new TextDecoder().decode(bytes);
  let doc: unknown;
  try { doc = JSON.parse(jsonText); } catch (e) { return { ok: false, code: "model-parse-error", error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` }; }
  if (!isObj(doc)) return { ok: false, code: "model-parse-error", error: "the glTF JSON is not an object" };
  const mi = firstMaterial(doc);
  if (mi === null) return { ok: false, code: "model-texture-missing", error: "no primitive of the default scene has a material" };
  const mat = arr(doc["materials"])[mi];
  const pbr = isObj(mat) ? mat["pbrMetallicRoughness"] : undefined;
  const bct = isObj(pbr) ? pbr["baseColorTexture"] : undefined;
  if (!isObj(bct)) return { ok: false, code: "model-texture-missing", error: `material ${mi} has no baseColorTexture` };
  const ti = int(bct["index"]);
  const tex = ti === null ? undefined : arr(doc["textures"])[ti];
  const si = isObj(tex) ? int(tex["source"]) : null;
  const img = si === null ? undefined : arr(doc["images"])[si];
  if (!isObj(img) || si === null) return { ok: false, code: "model-node-invalid", error: `material ${mi}: texture ${ti} has no image` };
  const uri = img["uri"];
  if (typeof uri === "string") {
    if (!uri.startsWith("data:")) return { ok: false, code: "model-texture-missing", error: `image ${si} is not embedded: it is the file ${uri} (copy that PNG to textures/models/ yourself)` };
    const pre = "data:image/png;base64,";
    if (!uri.startsWith(pre)) return { ok: false, code: "model-image-format", error: `image ${si} is a ${uri.slice(5, uri.indexOf(",") >= 0 ? uri.indexOf(",") : 40)} data URI, not a base64 PNG` };
    const b = b64(uri.slice(pre.length));
    if (!b || !b.length) return { ok: false, code: "model-image-embedded-invalid", error: `image ${si}: bad base64 in its data URI` };
    return { ok: true, bytes: b, source: "data-uri", material: mi, image: si };
  }
  const bv = int(img["bufferView"]);
  if (bv === null) return { ok: false, code: "model-node-invalid", error: `image ${si} has neither uri nor bufferView` };
  if (img["mimeType"] !== "image/png") return { ok: false, code: "model-image-format", error: `image ${si} has mimeType ${JSON.stringify(img["mimeType"] ?? null)}, not image/png` };
  const view = arr(doc["bufferViews"])[bv];
  if (!isObj(view)) return { ok: false, code: "model-image-embedded-invalid", error: `image ${si}: bufferView ${bv} does not exist` };
  const off = int(view["byteOffset"] ?? 0), len = int(view["byteLength"]), buf = int(view["buffer"]);
  if (buf !== 0 || !bin) return { ok: false, code: "model-image-embedded-invalid", error: `image ${si}: bufferView ${bv} is not in the GLB BIN chunk` };
  if (off === null || len === null || off + len > bin.length || len === 0) return { ok: false, code: "model-image-embedded-invalid", error: `image ${si}: bufferView ${bv} is outside the BIN chunk` };
  return { ok: true, bytes: bin.slice(off, off + len), source: `bufferView ${bv}`, material: mi, image: si };
}

/** models/<...>/<stem>.<ext> -> textures/models/<stem>.png (the DLL's fw_tex_default_name, relative to the mod folder) */
export function conventionTexturePath(modelPath: string): string {
  const base = modelPath.split("/").pop() ?? modelPath;
  return `textures/models/${base.replace(/\.(obj|gltf|glb)$/, "")}.png`;
}
