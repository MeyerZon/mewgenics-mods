// The model codes (design §2.6; docs/data-mods.md "3D models: error codes"): ONE list shared by the DLL and the
// editor. The DLL's copy is FW_MESH_CODES in native/framework/src/fw_mesh_rules.c (what mewframework.log prints:
// "mesh: <path>: <code>: <text> — drawing the 2D clip"); test/model-codes-tests.ts parses that C table and asserts it
// equals this list entry for entry (code, severity, order), so the two cannot drift. Add a code in BOTH places.
// Severity: "error" = the model is refused and the unit keeps drawing its 2D movieclip; "warning" = it loads but
// something is dropped or will look wrong; "info" = the engine fills something in.
// Not every code is raised by both halves yet: model-unregistered is editor-only, the texture / budget codes belong
// to later phases, and the editor's reader is header-level until PR #128's full reader lands (model-check.ts).

export type ModelCodeSeverity = "error" | "warning" | "info";
export interface ModelCode { readonly code: string; readonly severity: ModelCodeSeverity; readonly meaning: string }

export const MODEL_CODES: readonly ModelCode[] = [
  { code: "model-path-invalid", severity: "error", meaning: "graphics.model is not a models/<name>.obj|.gltf|.glb path inside the mod (or not a string)" },
  { code: "model-file-missing", severity: "error", meaning: "the model file the path names is not in the mod folder (or is empty)" },
  { code: "model-unregistered", severity: "error", meaning: "an \"@Name\" model no native mod registers (editor/registered-names.json, kind model)" },
  { code: "model-parse-error", severity: "error", meaning: "OBJ syntax (a bad face, number or statement) or glTF JSON that does not parse" },
  { code: "model-extension", severity: "error", meaning: "the file is not .obj, .gltf or .glb" },
  { code: "model-glb-header", severity: "error", meaning: "the .glb container is broken: no glTF magic, version not 2, wrong length, first chunk not JSON, chunk not 4-byte aligned" },
  { code: "model-gltf-version", severity: "error", meaning: "no asset object, or asset.version is not 2.x" },
  { code: "model-extension-required", severity: "error", meaning: "the file requires a glTF extension the engine does not support (e.g. Draco, meshopt)" },
  { code: "model-uri-unsupported", severity: "error", meaning: "a buffer or image uri is absolute, http:, contains .. or is a non-base64 data: URI" },
  { code: "model-buffer-missing", severity: "error", meaning: "a buffer's data is not there: an external .bin, a missing GLB BIN chunk, a dangling buffer index" },
  { code: "model-buffer-range", severity: "error", meaning: "a buffer is shorter than its byteLength, or a bufferView / accessor reaches past its end" },
  { code: "model-accessor-invalid", severity: "error", meaning: "a bad accessor: componentType, type, stride, a dangling or malformed index" },
  { code: "model-sparse-unsupported", severity: "error", meaning: "an accessor the mesh uses is sparse (not supported in v1)" },
  { code: "model-primitive-mode", severity: "error", meaning: "points or lines (glTF mode != 4, OBJ l / p / curves): only triangles draw" },
  { code: "model-attribute-missing", severity: "error", meaning: "a primitive has no POSITION" },
  { code: "model-attribute-format", severity: "error", meaning: "POSITION / NORMAL not VEC3 float, TEXCOORD_0 not VEC2 float or normalized integer, or a non-finite position" },
  { code: "model-index-range", severity: "error", meaning: "an index past the vertex count, or an index count that is not a multiple of 3" },
  { code: "model-node-invalid", severity: "error", meaning: "a dangling or malformed node / mesh / scene / material / texture / image entry" },
  { code: "model-node-cycle", severity: "error", meaning: "a node reached twice (a cycle, or a child with two parents)" },
  { code: "model-empty", severity: "error", meaning: "nothing to draw: no faces (OBJ), no triangles in the default scene (glTF), an empty file" },
  { code: "model-limit", severity: "error", meaning: "a cap: too many vertices / indices, a node tree too deep, a full model registry, out of memory" },
  { code: "model-multi-material", severity: "warning", meaning: "more than one material in use: v1 draws every primitive with the first" },
  { code: "model-ngon-concave", severity: "warning", meaning: "an OBJ n-gon the fan triangulation will draw wrong (triangulate it on export)" },
  { code: "model-skin-ignored", severity: "warning", meaning: "the file has skins: v1 draws the bind pose" },
  { code: "model-animation-ignored", severity: "warning", meaning: "the file has animations: v1 draws the model still" },
  { code: "model-morph-ignored", severity: "warning", meaning: "a primitive has morph targets: v1 draws the base mesh" },
  { code: "model-texcoord-set", severity: "warning", meaning: "the base colour texture uses a texcoord set other than 0" },
  { code: "model-texture-transform-ignored", severity: "warning", meaning: "KHR_texture_transform is used but not applied" },
  { code: "model-alpha-blend", severity: "warning", meaning: "the material blends alpha: v1 draws it opaque" },
  { code: "model-image-format", severity: "warning", meaning: "the texture image is not a PNG the engine can load" },
  { code: "model-texture-no-uvs", severity: "warning", meaning: "the model names a texture but has no TEXCOORD_0 / vt: the texture cannot map" },
  { code: "model-heavy", severity: "warning", meaning: "over the per-model triangle / vertex budget" },
  { code: "model-below-floor", severity: "warning", meaning: "part of the model is below height 0: the origin is the ground point, so it sinks into the floor" },
  { code: "model-footprint", severity: "warning", meaning: "the model is much wider than a tile" },
  { code: "model-texture-missing", severity: "warning", meaning: "the texture file is absent: the base colour draws alone" },
  { code: "model-texture-format", severity: "warning", meaning: "the texture is grey-only (GL_LUMINANCE, not drawable in the core profile)" },
  { code: "model-texture-size", severity: "warning", meaning: "the texture is larger than 1024 px (no mipmaps: it shimmers)" },
  { code: "model-no-normals", severity: "info", meaning: "the file has no normals (on every corner): the engine computes flat ones" },
  { code: "model-texture-embedded", severity: "info", meaning: "the texture is embedded in the file (a GLB bufferView or a data: URI)" },
  { code: "model-mtl-ignored", severity: "info", meaning: "OBJ mtllib / usemtl: .mtl materials are not read (v1)" },
  { code: "model-extension-ignored", severity: "info", meaning: "the file uses (but does not require) glTF extensions; v1 ignores them" },
  { code: "model-attribute-ignored", severity: "info", meaning: "an attribute v1 does not use (TEXCOORD_1, COLOR_0, tangents, ...)" },
];

const BY_CODE = new Map(MODEL_CODES.map((c) => [c.code, c]));

/** The list entry for a code, or undefined when it is not a model code. */
export function modelCodeInfo(code: string): ModelCode | undefined {
  return BY_CODE.get(code);
}
