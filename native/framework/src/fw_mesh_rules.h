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
} FwMesh;

typedef struct FwMeshError { char text[160]; int line; } FwMeshError;   /* line = 1-based OBJ line, 0 = not a line */

/* Parses an OBJ text of `len` bytes (NOT NUL-terminated: the bytes of a BinaryResource). Returns 1 and fills *out
 * (in OBJ space; call fw_mesh_to_game_axes next), or 0 with *out zeroed and err->text / err->line set (err may be NULL).
 * Subset: `v x y z [w ...]` (extras ignored), `vt u [v [w]]`, `vn x y z`, `f` with corners i, i/j, i//k, i/j/k and
 * negative (relative) indices; n-gons fan-triangulated (0,i,i+1: convex faces only); corners deduplicated on the
 * (v, vt, vn) triple. Ignored: blank lines, `#` comments, `o`, `g`, `s`, `mtllib`, `usemtl` (materials: later), CR
 * before LF, a UTF-8 BOM. Errors: index 0, an index out of range, a face with < 3 corners, a non-number, a trailing `\`
 * continuation, `l` / `p` / `curv` / `curv2` / `surf` and every other statement, no faces at all, the limits above. */
int fw_mesh_obj_parse(const char *text, size_t len, FwMesh *out, FwMeshError *err);

/* OBJ (right-handed, Y up) -> game (x, height, z; left-handed): x_g = s*x, h = s*y, z_g = -s*z; normals mirrored the
 * same way (and renormalised), every triangle's index order reversed (a reflection flips winding), bounds recomputed.
 * scale <= 0 (or NaN) is treated as 1. 1 game world unit = 1 tile; Blender's 1 m = 1 tile at scale 1. */
void fw_mesh_to_game_axes(FwMesh *m, float scale);

/* Gives every triangle its own three vertices with the face normal normalize(cross(b - a, c - a)) (degenerate
 * triangles get 0,1,0); uvs are kept, has_normals is left as is. nverts becomes nindices. 0 on allocation failure
 * (the mesh is then unchanged), else 1. */
int fw_mesh_flat_normals(FwMesh *m);
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
/* Accepts exactly `models/<name>.obj`: forward slashes, no subdirectory, <name> 1..63 chars of [A-Za-z0-9_-], the
 * extension lowercase `.obj` (the only format tonight). Then copies ref into out (cap must fit it + NUL) and returns 1;
 * else 0 with out = "" (when cap > 0). So `..`, absolute paths, drive letters, backslashes and spaces are all refused. */
int fw_mesh_model_path(const char *ref, char *out, size_t cap);
/* `models/crate.obj` -> `crate` (the registry name). Same acceptance rule as fw_mesh_model_path; 1 ok, else 0 / "". */
int fw_mesh_name_from_path(const char *path, char *out, size_t cap);
