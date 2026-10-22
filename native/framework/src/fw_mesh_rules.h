/* Pure mesh rules for phase M of the 3D plan (docs/possible_3d_work.md "Phase M"; design: the r3dF notes §1): the OBJ
 * subset parser, the OBJ -> game axes conversion, flat normals, the unit cube the M1 probe draws, the per-process model
 * registry and the mod-relative model path rule. No windows.h, no GL, no game: everything here is host-tested
 * (test/test_mesh_rules.c) and compiled into mewframework.dll unchanged. glTF is a later module.
 *
 * Conventions:
 * - FwMeshVertex is the VBO layout: attrib 0 = pos (offset 0), 1 = nrm (offset 12), 2 = uv (offset 24), stride 32.
 * - Indices are always uint32 triangles.
 * - Front faces: for a triangle (a, b, c), cross(b - a, c - a) is the outward normal. That holds in OBJ space
 *   (right-handed, Y up, counter-clockwise front faces: Blender's export) and, because fw_mesh_to_game_axes mirrors z
 *   AND reverses every triangle, it still holds in game space (x, height, z), which is left-handed.
 * - Ownership: a parsed / built mesh owns its two malloc'd arrays; fw_mesh_free releases them and zeroes the struct. */
#pragma once
#include <stdint.h>
#include <stddef.h>

#define FW_MESH_MAX_VERTS   (1u << 20)      /* refuse bigger: a misread count, not a prop */
#define FW_MESH_MAX_INDICES (3u << 20)

typedef struct FwMeshVertex { float pos[3]; float nrm[3]; float uv[2]; } FwMeshVertex;   /* 32 B */

typedef struct FwMesh {
    FwMeshVertex *verts; uint32_t nverts;
    uint32_t *indices;   uint32_t nindices;  /* a multiple of 3 */
    int has_normals;     /* 1: every face corner of the file named a vn. 0: the file gave none (or not on every corner)
                          * and the parser filled nrm with flat face normals (fw_mesh_flat_normals): nrm is ALWAYS valid */
    int has_uvs;         /* 1: some corner named a vt (corners without one get uv 0,0). 0: every uv is 0,0 */
    float bmin[3], bmax[3];
    /* appended for glTF (OBJ and the unit cube: 1,1,1,1 and ""): the material of the first baked primitive that has
     * one — glTF baseColorFactor (linear RGBA) and baseColorTexture's image: its uri (percent-decoded, relative to
     * the model file), "embedded:<bufferView>" for an image stored in a bufferView (.glb), "embedded:data-uri" for a
     * data: URI image. Materials of later primitives are ignored (one material per model). */
    float base_color[4];
    char texture[260];
    /* M3: the bytes of that image when it is EMBEDDED and a PNG (a .glb bufferView with mimeType image/png, or a
     * data:image/png;base64 URI): a malloc'd copy (fw_mesh_free releases it), NULL otherwise. Decoded by the DLL
     * (fw_mesh_embtex.c), never written anywhere. */
    uint8_t *image; size_t image_len;
} FwMesh;

/* ---- model codes (design §2.6, docs/data-mods.md "3D models: error codes"): ONE table, FW_MESH_CODES in
 * fw_mesh_rules.c, shared with the editor (editor/src/core/model-codes.ts; editor/test/model-codes-tests.ts parses the
 * table out of fw_mesh_rules.c and asserts both lists are identical, so keep its one-entry-per-line shape
 * `[FW_MC_X] = { "model-x", "error" },`). Severity: "error" = the model is refused (the unit draws its 2D clip),
 * "warning" = it loads but something is dropped or looks wrong, "info" = the engine fills something in. Not every code
 * is raised by the DLL: the path/registry codes and the texture / budget ones come from the editor or later phases. */
typedef enum FwMeshCodeId {
    /* errors */
    FW_MC_PATH_INVALID, FW_MC_FILE_MISSING, FW_MC_UNREGISTERED, FW_MC_NAME_UNKNOWN, FW_MC_REGISTRY_ENTRY, FW_MC_PARSE_ERROR, FW_MC_EXTENSION, FW_MC_GLB_HEADER,
    FW_MC_GLTF_VERSION, FW_MC_EXTENSION_REQUIRED, FW_MC_URI_UNSUPPORTED, FW_MC_BUFFER_MISSING, FW_MC_BUFFER_RANGE,
    FW_MC_ACCESSOR_INVALID, FW_MC_SPARSE_UNSUPPORTED, FW_MC_PRIMITIVE_MODE, FW_MC_ATTRIBUTE_MISSING,
    FW_MC_ATTRIBUTE_FORMAT, FW_MC_INDEX_RANGE, FW_MC_NODE_INVALID, FW_MC_NODE_CYCLE, FW_MC_EMPTY, FW_MC_LIMIT,
    /* warnings */
    FW_MC_MULTI_MATERIAL, FW_MC_NGON_CONCAVE, FW_MC_SKIN_IGNORED, FW_MC_ANIMATION_IGNORED, FW_MC_MORPH_IGNORED,
    FW_MC_TEXCOORD_SET, FW_MC_TEXTURE_TRANSFORM_IGNORED, FW_MC_ALPHA_BLEND, FW_MC_IMAGE_FORMAT, FW_MC_TEXTURE_NO_UVS,
    FW_MC_HEAVY, FW_MC_BELOW_FLOOR, FW_MC_FOOTPRINT, FW_MC_TEXTURE_MISSING, FW_MC_TEXTURE_FORMAT, FW_MC_TEXTURE_SIZE,
    FW_MC_IMAGE_EMBEDDED_INVALID, FW_MC_IMAGE_EMBEDDED_UNSUPPORTED,
    /* info */
    FW_MC_NO_NORMALS, FW_MC_TEXTURE_EMBEDDED, FW_MC_MTL_IGNORED, FW_MC_EXTENSION_IGNORED, FW_MC_ATTRIBUTE_IGNORED,
    FW_MC_COUNT
} FwMeshCodeId;
typedef struct FwMeshCode { const char *code; const char *severity; } FwMeshCode;
extern const FwMeshCode FW_MESH_CODES[FW_MC_COUNT];
const char *fw_mesh_code(FwMeshCodeId id);              /* the table's static string; NULL out of range */
const char *fw_mesh_code_severity(const char *code);    /* "error" | "warning" | "info"; NULL when not in the table */

/* A refusal: text (the loader's words), line (1-based OBJ line, 0 = not a line), code (a FW_MESH_CODES string; NULL
 * only before a parse). On SUCCESS the loaders leave code NULL and list what they dropped or filled in as warning /
 * info codes (each at most once, table order of discovery, at most FW_MESH_MAX_WARNINGS). */
#define FW_MESH_MAX_WARNINGS 8
typedef struct FwMeshError {
    char text[160]; int line;
    const char *code;
    const char *warnings[FW_MESH_MAX_WARNINGS]; int nwarnings;
} FwMeshError;
void fw_mesh_err_reset(FwMeshError *e);                 /* zeroes it (NULL is fine) */
void fw_mesh_warn(FwMeshError *e, FwMeshCodeId id);     /* adds the code once (NULL e / a full list: ignored) */
int fw_mesh_has_warning(const FwMeshError *e, FwMeshCodeId id);

/* Parses an OBJ text of `len` bytes (NOT NUL-terminated: the bytes of a BinaryResource). Returns 1 and fills *out
 * (in OBJ space; call fw_mesh_to_game_axes next), or 0 with *out zeroed and err->text / err->line set (err may be NULL).
 * Subset: `v x y z [w ...]` (extras ignored), `vt u [v [w]]`, `vn x y z`, `f` with corners i, i/j, i//k, i/j/k and
 * negative (relative) indices; n-gons fan-triangulated (0,i,i+1: convex faces only); corners deduplicated on the
 * (v, vt, vn) triple. Ignored: blank lines, `#` comments (also after a statement), `o`, `g`, `s`, `mg`, `mtllib`,
 * `usemtl` (materials: later), the display attributes `maplib usemap lod bevel c_interp d_interp shadow_obj trace_obj
 * ctech stech`, CR before LF, a UTF-8 BOM. Errors (text ends "at line N", err->line = N): index 0, an index out of range
 * ("face index 7 out of range (3 vertices) at line 4"; "face texcoord index ..." / "face normal index ..."), a face with
 * < 3 corners, a non-number, a trailing `\` continuation, "unsupported OBJ statement 'l'" (also p, curv, curv2, surf,
 * vp and the other free-form geometry statements), "unknown OBJ statement '...'", the limits above ("... (limit)");
 * "no faces" (line 0). */
int fw_mesh_obj_parse(const char *text, size_t len, FwMesh *out, FwMeshError *err);

/* Reads a side file named by a model (a glTF buffer's uri, percent-decoded, relative to the model file; never absolute,
 * never containing "..", "\" or ":"): returns malloc'd bytes (the parser free()s them, so same CRT) and *len, or NULL
 * when absent. */
typedef void *(*FwMeshReadFn)(void *user, const char *relPath, size_t *len);

/* Parses a glTF 2.0 model: `.glb` (detected by the magic "glTF": header version 2, JSON chunk, optional BIN chunk,
 * 4-byte aligned chunk lengths) or `.gltf` JSON text. Buffers: the .glb BIN chunk (buffer 0 without uri), base64
 * `data:` URIs, or a relative file through `read` (may be NULL when nothing external is needed). Returns 1 and fills
 * *out in glTF model space (right-handed, +Y up, metres: call fw_mesh_to_game_axes next, exactly as for OBJ), or 0 with
 * *out zeroed and err->text set (err->line = 0).
 * - Scene: the `scene` (default 0) of `scenes`, its node trees walked depth-first; every node with a `mesh` bakes all
 *   of that mesh's primitives with the node's world transform (`matrix`, column-major, or T*R*S from `translation` /
 *   `rotation` (x,y,z,w quaternion) / `scale`); normals by the inverse-transpose (renormalised); a node whose matrix
 *   has a negative determinant reverses its triangles. A node reached twice (cycle / shared child) is an error. No
 *   `scenes` at all: every mesh baked once with the identity. Cameras, lights, skins (bind pose is used) and
 *   animations are ignored. A node tree deeper than FW_GLTF_MAX_NODE_DEPTH is an error ("too deep").
 * - Primitive: mode absent or 4 (TRIANGLES), else an error naming the mode; POSITION required (VEC3 float), NORMAL
 *   (VEC3 float; absent -> flat normals for that primitive, and has_normals = 0), TEXCOORD_0 (VEC2 float, or normalized
 *   unsigned byte / short; non-normalized integers are an error); other attributes ignored; `targets` (morphs) are an
 *   error. Indices: SCALAR unsigned byte / short / int, each < the POSITION count, count % 3 == 0; absent -> 0..n-1.
 * - Accessors: `sparse` is an error, a missing bufferView is an error; byteStride honoured; every element must lie
 *   inside its bufferView and every bufferView inside its buffer's byteLength (an error, never a read past the end).
 * - `asset.version` must start with "2."; a non-empty `extensionsRequired` is an error naming the first entry
 *   (KHR_draco_mesh_compression, EXT_meshopt_compression, KHR_texture_transform, ...); `extensionsUsed` is ignored.
 * - Limits: FW_MESH_MAX_VERTS / FW_MESH_MAX_INDICES over the whole baked model. */
#define FW_GLTF_MAX_NODE_DEPTH 256
int fw_mesh_gltf_parse(const uint8_t *bytes, size_t len, FwMeshReadFn read, void *user, FwMesh *out, FwMeshError *err);

/* OBJ (right-handed, Y up) -> game (x, height, z; left-handed): x_g = s*x, h = s*y, z_g = -s*z; normals mirrored the
 * same way (and renormalised), every triangle's index order reversed (a reflection flips winding), bounds recomputed.
 * scale <= 0 (or NaN) is treated as 1. 1 game world unit = 1 tile; Blender's 1 m = 1 tile at scale 1. */
void fw_mesh_to_game_axes(FwMesh *m, float scale);

/* Gives every triangle its own three vertices with the face normal normalize(cross(b - a, c - a)) (degenerate
 * triangles get 0,1,0); uvs are kept, has_normals is left as is. nverts becomes nindices. 0 on allocation failure
 * (the mesh is then unchanged), else 1. */
int fw_mesh_flat_normals(FwMesh *m);
void fw_mesh_default_material(FwMesh *m);    /* base_color = 1,1,1,1, texture = "" */
void fw_mesh_bounds(FwMesh *m);               /* recomputes bmin/bmax from verts (all 0 for an empty mesh) */
void fw_mesh_free(FwMesh *m);                 /* frees and zeroes; NULL and an already-freed mesh are fine */

/* A unit cube ALREADY IN GAME AXES (do not call fw_mesh_to_game_axes on it): x, z in [-0.5, 0.5], height in [0, 1]
 * (feet-registered: the origin is the tile's ground point), 24 vertices (4 per face, unit outward face normals,
 * uv 0..1 per face), 36 indices, front faces outward per the convention above. 1 ok, 0 on allocation failure. */
int fw_mesh_unit_cube(FwMesh *out);

/* ---- registry: the models a process has loaded, by name ---- */
#define FW_MESH_MAX_MODELS 32
#define FW_MESH_NAME_MAX   63                 /* chars, without the NUL */
typedef struct FwMeshRegistry {
    int count;
    char names[FW_MESH_MAX_MODELS][FW_MESH_NAME_MAX + 1];
    FwMesh meshes[FW_MESH_MAX_MODELS];
} FwMeshRegistry;                             /* zero-initialise (or fw_mesh_reg_clear) before use */

/* Adds `taken` under `name` (case-sensitive) and takes ownership: on success *taken is moved into the registry and
 * zeroed, and the index is returned. Refused (-1, *taken untouched, still the caller's): NULL arguments, an empty or
 * > FW_MESH_NAME_MAX name, a duplicate name, a full registry, a mesh with no vertices or no triangles. */
int fw_mesh_reg_add(FwMeshRegistry *reg, const char *name, FwMesh *taken);
int fw_mesh_reg_find(const FwMeshRegistry *reg, const char *name);           /* index, -1 if absent */
const FwMesh *fw_mesh_reg_get(const FwMeshRegistry *reg, int i);             /* NULL when out of range */
const char *fw_mesh_reg_name(const FwMeshRegistry *reg, int i);              /* NULL when out of range */
void fw_mesh_reg_clear(FwMeshRegistry *reg);                                 /* frees every mesh, count = 0 */

/* ---- model paths (mod-relative, as a GON `model` key names them) ---- */
/* Accepts exactly `models/<name>.<ext>` with ext one of lowercase `obj`, `gltf`, `glb`: forward slashes, no
 * subdirectory, <name> 1..63 chars of [A-Za-z0-9_-]. Then copies ref into out (cap must fit it + NUL) and returns 1;
 * else 0 with out = "" (when cap > 0). So `..`, absolute paths, drive letters, backslashes and spaces are all refused. */
int fw_mesh_model_path(const char *ref, char *out, size_t cap);
/* `models/crate.obj` -> `crate` (the registry name). Same acceptance rule as fw_mesh_model_path; 1 ok, else 0 / "". */
int fw_mesh_name_from_path(const char *path, char *out, size_t cap);
/* which parser a valid model path needs: OBJ -> fw_mesh_obj_parse, GLTF / GLB -> fw_mesh_gltf_parse; 0 = not valid */
#define FW_MESH_KIND_OBJ  1
#define FW_MESH_KIND_GLTF 2
#define FW_MESH_KIND_GLB  3
int fw_mesh_model_kind(const char *path);
