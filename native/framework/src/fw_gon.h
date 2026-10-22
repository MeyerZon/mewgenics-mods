/* A read-only walk of the game's live GonObject tree (pure, host-tested by test/test_gon.c), promoted from the
 * harness's mt_gon.c (native/mods/test-harness/src/mt_gon.c, which stays as it is) for the framework's own use: the
 * 3D data seam reads `graphics.model` from a unit's entry at Character+OFF_CH_GON_ENTRY (0x240, OBSERVED by the
 * harness's `expect gon`; docs/engine-map.md "GON at runtime").
 *
 * Layout: the generated offsets.h (OFF_GON_* / GON_NODE_SIZE). The walk reproduces GonObject_child_by_name's linear
 * scan (the first child whose std::string name equals the segment) and Index's `begin + i * GON_NODE_SIZE` without
 * calling the game: no re-entrancy, and nothing reaches the game's GON ERROR sink. Every read goes through a reader
 * the caller supplies (the DLL passes a VirtualQuery-guarded one; fw_gon_direct_read is a plain copy for trusted
 * pointers and the host tests); implausible strings and children vectors are "unreadable", never followed. */
#pragma once
#include <stddef.h>
#include "offsets.h"

typedef int (*FwMemRead)(void *u, const void *addr, void *out, size_t n);   /* guarded copy: 1 ok, 0 unreadable */
int fw_gon_direct_read(void *u, const void *addr, void *out, size_t n);      /* memcpy; 0 only for NULL / n == 0 */

#define FW_GON_TEXT 256
#define FW_GON_TYPE_STRING 1
/* the string value at `path` ("graphics.model"; all-digit segments index the children vector; "" = the node itself)
 * under `node` into out (truncated to cap - 1). 1 found and a string (type 1), 0 missing or not a string, -1
 * unreadable (NULL node, a bad pointer, an implausible vector or std::string). out is "" unless 1 is returned. */
int fw_gon_get_string(FwMemRead rd, void *u, const void *node, const char *path, char *out, size_t cap);
/* `graphics.model` of a data/characters entry (the 3D data seam): fw_gon_get_string(rd, u, entry, "graphics.model", ...) */
int fw_gon_model(FwMemRead rd, void *u, const void *gonEntry, char *out, size_t cap);
/* the same through fw_gon_direct_read into a static buffer (main thread only; the next call overwrites it): the
 * `graphics.model` string, NULL when absent / not a string / unreadable. For a pointer the caller trusts. */
const char *fw_gon_entry_model(const void *gonEntry);

/* ---- the GON `model` value: the string form or the block form (SCRATCH importer-design §3.2; docs/data-mods.md
 * "3D models in a mod") ----
 *     graphics { model "models/crate.obj" }                                  the string form: file only, defaults
 *     graphics { model { file "models/x.glb"  scale 1  yaw 0  offset [0 0 0]  texture "models/x.png"
 *                        tint [1 1 1 1]  palette true  double_sided false } }  the block form
 * A value of the wrong type keeps its default and sets its FW_GON_MODEL_BAD_* bit in `invalid` (the editor's
 * model-scale / model-yaw / model-offset / ... rules name the same cases; the DLL logs them once per unit). */
#define FW_GON_TYPE_NUMBER 2
#define FW_GON_TYPE_OBJECT 3
#define FW_GON_TYPE_ARRAY  4
#define FW_GON_TYPE_BOOL   5
enum {
    FW_GON_MODEL_BAD_SCALE   = 1 << 0,   /* not a number, or <= 0 */
    FW_GON_MODEL_BAD_YAW     = 1 << 1,   /* not a number */
    FW_GON_MODEL_BAD_OFFSET  = 1 << 2,   /* not an array of exactly 3 numbers */
    FW_GON_MODEL_BAD_TEXTURE = 1 << 3,   /* not a string */
    FW_GON_MODEL_BAD_TINT    = 1 << 4,   /* not an array of 3 or 4 numbers */
    FW_GON_MODEL_BAD_PALETTE = 1 << 5,   /* not a bool */
    FW_GON_MODEL_BAD_DOUBLE_SIDED = 1 << 6,   /* not a bool */
    FW_GON_MODEL_BAD_FILE    = 1 << 7    /* a block without a string `file` (the whole model is then absent: 0) */
};
typedef struct FwGonModel {
    int isBlock;                 /* 0 = the string form, 1 = the block form */
    char file[FW_GON_TEXT];      /* the model path ("models/x.obj") or "@Name"; the only required field */
    double scale;                /* uniform, > 0; default 1 (1 model unit = 1 tile) */
    double yaw;                  /* degrees about the height axis; default 0 (front toward the lower right) */
    double offset[3];            /* (x, height, z) in tiles, applied after scale and yaw; default 0 0 0 */
    /* the look fields: parsed here, DRAWN by the texture/tint/palette side of the mesh engine (agent `tex`) */
    char texture[FW_GON_TEXT];   /* "" = none given (the convention textures/models/<name>.png is the draw side's) */
    float tint[4];               /* multiplies the base colour; default 1 1 1 1 (3 numbers = alpha 1) */
    int palette;                 /* -1 not given, 0 false, 1 true */
    int doubleSided;             /* -1 not given, 0 false, 1 true */
    int invalid;                 /* FW_GON_MODEL_BAD_* bits of the keys whose value was refused (default kept) */
} FwGonModel;
/* the defaults above, file "" (isBlock 0) */
void fw_gon_model_defaults(FwGonModel *m);
/* `graphics.model` of a data/characters entry, either form, into out (defaults first). 1 found (a string, or a block
 * with a string `file`), 0 none (no key, a scalar that is not a string, a block without `file`: BAD_FILE set),
 * -1 unreadable (out keeps the defaults). Same reader, offsets and plausibility guards as fw_gon_get_string. */
int fw_gon_model_block(FwMemRead rd, void *u, const void *gonEntry, FwGonModel *out);
/* the number at `path` (a type-2 node's double view, OFF_GON_DOUBLE): 1 ok, 0 missing / not a number, -1 unreadable */
int fw_gon_get_number(FwMemRead rd, void *u, const void *node, const char *path, double *out);
/* the node's own key (OFF_GON_NAME), e.g. "Crate" for an entry: 1 ok, -1 unreadable; out "" unless 1 */
int fw_gon_node_name(FwMemRead rd, void *u, const void *node, char *out, size_t cap);
