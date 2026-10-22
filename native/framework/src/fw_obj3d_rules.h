/* Pure rules of the 3D-object registry (API v6: FW_Register3DObject / FW_Place3DObjectOnTile / FW_Unregister3DObject;
 * docs/possible_3d_work.md phase M, docs/data-mods.md "3D models in a mod (preview)"). No windows.h, no game calls:
 * host-tested over fake Characters by test/test_obj3d_rules.c and compiled into the DLL unchanged. obj3d_engine.c
 * owns the one static registry, logs, and hands the objects to the mesh engine (which resolves `model` names and draws).
 *
 * An object is either
 *   - attached to a Character: it follows the unit (the mesh engine reads the unit's world (x, z) each frame and
 *     passes it to fw_obj3d_model_matrix); registered with the pool generation at Character+OFF_CH_GENERATION, the
 *     glow registry's idiom, so a unit whose pool slot was reused or freed is dropped by fw_obj3d_prune; at most one
 *     object per Character (registering again replaces its model and transform and keeps its handle); or
 *   - placed on a tile (col, row): anchored at the tile centre, world (col + 0.5, 0, row + 0.5) — units stand at tile
 *     centres with height 0 (OBSERVED, editor/test/fixtures/ingame/observe3d-log.txt); any number per tile.
 * World space is the game's (x, height, z) basis that FW_DATA_Iso projects. Matrices are column-major float[16]
 * (OpenGL order: element (row r, col c) at [c*4 + r], translation in [12..14]). Every object has a handle > 0 that is
 * never reused within the process (fw_obj3d_clear keeps the counter), so a stale handle cannot hit a newer object. */
#pragma once
#include <stdint.h>
#include <stddef.h>
#include "offsets.h"

#define FW_OBJ3D_MAX        64
#define FW_OBJ3D_MODEL_MAX  64    /* bytes of `model` incl. the NUL: a registered model name or a mod path "models/x.obj" */
#define FW_OBJ3D_TILE_MAX   4096  /* col/row bound: a larger index is a caller bug, not a map */

typedef struct Fw3dObject {
    int handle;                         /* > 0 */
    void *character;                    /* NULL for a tile object */
    uint64_t generation;                /* Character+OFF_CH_GENERATION at registration (uint64, as the pool header holds it) */
    char model[FW_OBJ3D_MODEL_MAX];     /* registered model name / mod path; resolved by the mesh engine, only stored here */
    float transform[16];                /* the object's own model matrix in world units, column-major; identity when NULL was passed */
    int tileCol, tileRow;               /* byTile only */
    int byTile;
} Fw3dObject;

typedef struct Fw3dRegistry { Fw3dObject objs[FW_OBJ3D_MAX]; int count; int nextHandle; } Fw3dRegistry;

void fw_obj3d_init(Fw3dRegistry *r);                                     /* empty, handles start at 1 */
void fw_obj3d_clear(Fw3dRegistry *r);                                    /* a new fight: drop every object, keep the handle counter */
/* attach to a Character (capturing its pool generation) or replace the model + transform of its object in place;
 * returns the handle, 0 when character is NULL, the model is invalid (fw_obj3d_model_ok) or the registry is full */
int  fw_obj3d_add_character(Fw3dRegistry *r, void *character, const char *model, const float transform[16]);
/* a new object on tile (col, row); the handle, 0 when the model is invalid, col/row is outside 0..FW_OBJ3D_TILE_MAX-1
 * or the registry is full */
int  fw_obj3d_add_tile(Fw3dRegistry *r, int col, int row, const char *model, const float transform[16]);
int  fw_obj3d_find_character(const Fw3dRegistry *r, const void *character);   /* index, -1 if absent */
int  fw_obj3d_find_handle(const Fw3dRegistry *r, int handle);                   /* index, -1 if absent */
int  fw_obj3d_remove_character(Fw3dRegistry *r, const void *character);        /* 1 removed (order kept), 0 absent */
int  fw_obj3d_remove_handle(Fw3dRegistry *r, int handle);                       /* 1 removed (order kept), 0 absent */
/* drop every Character object whose pool generation moved (tile objects stay); returns the number dropped */
int  fw_obj3d_prune(Fw3dRegistry *r);
int  fw_obj3d_count(const Fw3dRegistry *r);
const Fw3dObject *fw_obj3d_at(const Fw3dRegistry *r, int i);                     /* NULL out of range */

/* a model string the registry accepts: non-empty, shorter than FW_OBJ3D_MODEL_MAX, printable ASCII, no backslash */
int  fw_obj3d_model_ok(const char *model);
/* the mod-path form the GON key `model` must have (the editor's model-path-invalid rule, same cases): "models/<...>.obj",
 * no "..", no backslash, not absolute (no leading '/', no drive colon), no empty segment */
int  fw_obj3d_model_path_ok(const char *path);

void fw_obj3d_identity(float out[16]);
void fw_obj3d_mat4_mul(const float a[16], const float b[16], float out[16]);   /* out = a x b (column-major); out may alias neither */
/* the tile centre in world (x, height, z): (col + 0.5, 0, row + 0.5) */
void fw_obj3d_tile_centre(int col, int row, float out[3]);
/* the object's model matrix in world space: translation to its anchor x its own transform. The anchor is the tile
 * centre for a tile object, (unitXZ[0], 0, unitXZ[1]) for a Character object (the unit's world position, read by the
 * caller this frame); a Character object with unitXZ NULL is anchored at the origin. */
void fw_obj3d_model_matrix(const Fw3dObject *o, const double unitXZ[2], float out[16]);

static inline uint64_t fw_obj3d_generation(const void *character) { return *(const uint64_t *)((const char *)character + OFF_CH_GENERATION); }
