// The validator's model reader — HEADER-LEVEL only: it reports the codes of model-codes.ts (the DLL's FW_MESH_CODES)
// that can be decided from a file's container and top-level JSON, with the DLL's own rules and similar words:
//   - the extension (.obj / .gltf / .glb), as fw_mesh_load_bytes;
//   - OBJ: at least one `f` statement (model-empty, the DLL's "no faces"); mtllib / usemtl -> model-mtl-ignored;
//   - GLB: the "glTF" magic, header version 2, the header length within the file, the first chunk JSON, 4-byte
//     aligned chunk lengths (fw_mesh_gltf.c `run`);
//   - glTF JSON (the .gltf text or the GLB JSON chunk): it parses to an object, asset.version is 2.x,
//     extensionsRequired is empty (the first entry named), and the top-level things v1 skips (extensionsUsed, skins,
//     animations).
// Accessors, buffers, primitives and the node tree are NOT read here: those codes come from the DLL's log until PR #128
// (docs/3d-importer-design) merges its full readers (editor/src/core/art/model-read.ts / obj-read.ts / gltf-read.ts),
// which then plug in behind checkModelBytes with the same code list.

export interface ModelIssue { readonly code: string; readonly message: string }

const GLB_MAGIC = 0x46546c67;   // "glTF" little-endian
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** The issues (errors first, in the order the DLL meets them; then warnings / info) of a model file's bytes. */
export function checkModelBytes(path: string, bytes: Uint8Array): ModelIssue[] {
  if (path.endsWith(".obj")) return checkObj(bytes);
  if (path.endsWith(".glb")) return checkGlb(bytes);
  if (path.endsWith(".gltf")) return checkGltfJson(new TextDecoder().decode(bytes));
  return [{ code: "model-extension", message: `not a .obj, .gltf or .glb file: ${path}` }];
}

function checkObj(bytes: Uint8Array): ModelIssue[] {
  const text = new TextDecoder().decode(bytes);
  let faces = false, mtl = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    const kw = line.split(/\s+/, 1)[0];
    if (kw === "f") faces = true;
    else if (kw === "mtllib" || kw === "usemtl") mtl = true;
  }
  if (!faces) return [{ code: "model-empty", message: "no faces" }];
  return mtl ? [{ code: "model-mtl-ignored", message: "mtllib / usemtl: .mtl materials are not read (v1 draws the base colour)" }] : [];
}

function checkGlb(b: Uint8Array): ModelIssue[] {
  const bad = (message: string): ModelIssue[] => [{ code: "model-glb-header", message }];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 4 || dv.getUint32(0, true) !== GLB_MAGIC) return bad("not a GLB file (no glTF magic in its first 4 bytes)");
  if (b.length < 20) return bad("glb is shorter than its header");
  const version = dv.getUint32(4, true), total = dv.getUint32(8, true);
  if (version !== 2) return bad(`glb version ${version} is not 2`);
  if (total > b.length) return bad(`glb header length ${total} is past the ${b.length} bytes given`);
  const l0 = dv.getUint32(12, true), t0 = dv.getUint32(16, true);
  if (t0 !== CHUNK_JSON) return bad("glb first chunk is not JSON");
  if (20 + l0 > total) return bad(`glb JSON chunk (${l0} bytes) is past the end`);
  if (l0 % 4) return bad(`glb JSON chunk length ${l0} is not 4-byte aligned`);
  const at = 20 + l0;
  if (at + 8 <= total) {
    const l1 = dv.getUint32(at, true), t1 = dv.getUint32(at + 4, true);
    if (at + 8 + l1 > total) return bad(`glb chunk 1 (${l1} bytes) is past the end`);
    if (t1 === CHUNK_BIN && l1 % 4) return bad(`glb BIN chunk length ${l1} is not 4-byte aligned`);
  }
  return checkGltfJson(new TextDecoder().decode(b.subarray(20, at)));
}

function checkGltfJson(text: string): ModelIssue[] {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch (e) {
    return [{ code: "model-parse-error", message: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` }];
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return [{ code: "model-parse-error", message: "the glTF JSON is not an object" }];
  const o = doc as Record<string, unknown>;
  const asset = o["asset"];
  if (asset === null || typeof asset !== "object" || Array.isArray(asset)) return [{ code: "model-gltf-version", message: "no asset object (not a glTF file)" }];
  const version = (asset as Record<string, unknown>)["version"];
  if (typeof version !== "string" || !version.startsWith("2.")) return [{ code: "model-gltf-version", message: `asset.version must be 2.x (got ${JSON.stringify(version ?? null)})` }];
  const nonEmpty = (k: string): unknown[] | null => (Array.isArray(o[k]) && (o[k] as unknown[]).length > 0 ? (o[k] as unknown[]) : null);
  const req = nonEmpty("extensionsRequired");
  if (req) return [{ code: "model-extension-required", message: `glTF extension required but not supported: ${String(req[0])} (export without it)` }];
  const out: ModelIssue[] = [];
  const used = nonEmpty("extensionsUsed");
  if (used) out.push({ code: "model-extension-ignored", message: `extensions used but ignored by v1: ${used.map(String).join(", ")}` });
  if (nonEmpty("skins")) out.push({ code: "model-skin-ignored", message: "skins are ignored: the bind pose draws" });
  if (nonEmpty("animations")) out.push({ code: "model-animation-ignored", message: "animations are ignored: the model draws still" });
  return out;
}
