/* Pure rules of the 3D-object registry; see fw_obj3d_rules.h. */
#include <string.h>
#include "fw_obj3d_rules.h"
#include "fw_mesh_rules.h"

/* ----------------------------------------------------------------------- */
/* registry                                                                 */
/* ----------------------------------------------------------------------- */
void fw_obj3d_init(Fw3dRegistry *r) { memset(r, 0, sizeof *r); r->nextHandle = 1; }

void fw_obj3d_clear(Fw3dRegistry *r) {
    int next = r->nextHandle > 0 ? r->nextHandle : 1;
    memset(r, 0, sizeof *r);
    r->nextHandle = next;
}

int fw_obj3d_model_ok(const char *model) {
    if (!model || !model[0]) return 0;
    size_t n = 0;
    for (const char *p = model; *p; p++, n++) {
        unsigned char c = (unsigned char)*p;
        if (c < 0x20 || c > 0x7e || c == '\\') return 0;
        if (n + 1 >= FW_OBJ3D_MODEL_MAX) return 0;
    }
    return 1;
}

/* the one model path rule (fw_mesh_rules.c model_check; editor/src/core/model3d.ts mirrors it) */
int fw_obj3d_model_path_ok(const char *path) {
    return fw_obj3d_model_ok(path) && fw_mesh_model_kind(path) != 0;
}

void fw_obj3d_identity(float out[16]) {
    memset(out, 0, 16 * sizeof(float));
    out[0] = out[5] = out[10] = out[15] = 1.0f;
}

static void set_common(Fw3dObject *o, const char *model, const float transform[16]) {
    memset(o->model, 0, sizeof o->model);
    memcpy(o->model, model, strlen(model));   /* fw_obj3d_model_ok bounded it below FW_OBJ3D_MODEL_MAX */
    if (transform) memcpy(o->transform, transform, sizeof o->transform);
    else fw_obj3d_identity(o->transform);
}

static Fw3dObject *new_object(Fw3dRegistry *r) {
    if (r->count >= FW_OBJ3D_MAX) return NULL;
    if (r->nextHandle <= 0) r->nextHandle = 1;   /* a zeroed registry, or the (theoretical) wrap */
    Fw3dObject *o = &r->objs[r->count++];
    memset(o, 0, sizeof *o);
    o->handle = r->nextHandle++;
    o->palette = -1;   /* M2: no palette remap until fw_obj3d_set_material */
    for (int k = 0; k < 4; k++) o->tint[k] = 1.0f;   /* the default look: draw as before */
    o->usePalette = -1;
    o->doubleSided = -1;
    o->facing = 1;
    return o;
}

int fw_obj3d_find_character(const Fw3dRegistry *r, const void *character) {
    if (!character) return -1;
    for (int i = 0; i < r->count; i++) if (!r->objs[i].byTile && r->objs[i].character == character) return i;
    return -1;
}

int fw_obj3d_find_handle(const Fw3dRegistry *r, int handle) {
    if (handle <= 0) return -1;
    for (int i = 0; i < r->count; i++) if (r->objs[i].handle == handle) return i;
    return -1;
}

int fw_obj3d_add_character(Fw3dRegistry *r, void *character, const char *model, const float transform[16]) {
    if (!character || !fw_obj3d_model_ok(model)) return 0;
    int i = fw_obj3d_find_character(r, character);
    Fw3dObject *o;
    if (i >= 0) o = &r->objs[i];
    else {
        o = new_object(r);
        if (!o) return 0;
        o->character = character;
    }
    o->generation = fw_obj3d_generation(character);
    set_common(o, model, transform);
    return o->handle;
}

int fw_obj3d_add_tile(Fw3dRegistry *r, int col, int row, const char *model, const float transform[16]) {
    if (col < 0 || row < 0 || col >= FW_OBJ3D_TILE_MAX || row >= FW_OBJ3D_TILE_MAX || !fw_obj3d_model_ok(model)) return 0;
    Fw3dObject *o = new_object(r);
    if (!o) return 0;
    o->byTile = 1;
    o->tileCol = col;
    o->tileRow = row;
    set_common(o, model, transform);
    return o->handle;
}

static void remove_at(Fw3dRegistry *r, int i) {
    for (int k = i + 1; k < r->count; k++) r->objs[k - 1] = r->objs[k];
    r->count--;
    memset(&r->objs[r->count], 0, sizeof r->objs[0]);
}

int fw_obj3d_remove_character(Fw3dRegistry *r, const void *character) {
    int i = fw_obj3d_find_character(r, character);
    if (i < 0) return 0;
    remove_at(r, i);
    return 1;
}

int fw_obj3d_remove_handle(Fw3dRegistry *r, int handle) {
    int i = fw_obj3d_find_handle(r, handle);
    if (i < 0) return 0;
    remove_at(r, i);
    return 1;
}

int fw_obj3d_prune(Fw3dRegistry *r) {
    int dropped = 0;
    for (int i = 0; i < r->count;) {
        const Fw3dObject *o = &r->objs[i];
        if (!o->byTile && fw_obj3d_generation(o->character) != o->generation) { remove_at(r, i); dropped++; }
        else i++;
    }
    return dropped;
}

int fw_obj3d_count(const Fw3dRegistry *r) { return r->count; }

const Fw3dObject *fw_obj3d_at(const Fw3dRegistry *r, int i) { return i >= 0 && i < r->count ? &r->objs[i] : NULL; }

/* ----------------------------------------------------------------------- */
/* matrices (column-major: element (row, col) at [col*4 + row])             */
/* ----------------------------------------------------------------------- */
void fw_obj3d_mat4_mul(const float a[16], const float b[16], float out[16]) {
    for (int c = 0; c < 4; c++)
        for (int rr = 0; rr < 4; rr++) {
            float s = 0.0f;
            for (int k = 0; k < 4; k++) s += a[k * 4 + rr] * b[c * 4 + k];
            out[c * 4 + rr] = s;
        }
}

void fw_obj3d_tile_centre(int col, int row, float out[3]) {
    out[0] = (float)col + 0.5f;
    out[1] = 0.0f;
    out[2] = (float)row + 0.5f;
}

void fw_obj3d_model_matrix(const Fw3dObject *o, const double unitXZ[2], float out[16]) {
    float anchor[3] = { 0.0f, 0.0f, 0.0f };
    if (o->byTile) fw_obj3d_tile_centre(o->tileCol, o->tileRow, anchor);
    else if (unitXZ) { anchor[0] = (float)unitXZ[0]; anchor[2] = (float)unitXZ[1]; }
    float t[16];
    fw_obj3d_identity(t);
    t[12] = anchor[0]; t[13] = anchor[1]; t[14] = anchor[2];
    if (o->facing < 0) {
        /* the sprite's mirror across the screen vertical is, in the iso basis, the x <-> z swap (about the anchor) */
        float m[16];
        fw_obj3d_identity(m);
        m[0] = 0.0f; m[2] = 1.0f; m[8] = 1.0f; m[10] = 0.0f;
        float tm[16];
        fw_obj3d_mat4_mul(t, m, tm);
        fw_obj3d_mat4_mul(tm, o->transform, out);
        return;
    }
    fw_obj3d_mat4_mul(t, o->transform, out);
}

int fw_obj3d_set_material(Fw3dRegistry *r, int handle, const char *texture, int palette) {
    int i = fw_obj3d_find_handle(r, handle);
    if (i < 0) return 0;
    if (texture && texture[0] && !fw_obj3d_model_ok(texture)) return 0;
    Fw3dObject *o = &r->objs[i];
    if (texture && texture[0]) { size_t n = strlen(texture); memcpy(o->texture, texture, n + 1); }
    else o->texture[0] = 0;
    o->palette = palette < 0 ? -1 : palette;
    return 1;
}
/* ---- look + facing (3D phase M2 item 4) ---- */
int fw_obj3d_set_look(Fw3dRegistry *r, int handle, const char *texture, const float tint[4], int usePalette, int doubleSided) {
    int i = fw_obj3d_find_handle(r, handle);
    if (i < 0 || (texture && texture[0] && !fw_obj3d_model_ok(texture))) return 0;
    Fw3dObject *o = &r->objs[i];
    memset(o->texture, 0, sizeof o->texture);
    if (texture) memcpy(o->texture, texture, strlen(texture));   /* fw_obj3d_model_ok bounded it */
    for (int k = 0; k < 4; k++) o->tint[k] = tint ? tint[k] : 1.0f;
    o->usePalette = usePalette < 0 ? -1 : usePalette ? 1 : 0;
    o->doubleSided = doubleSided < 0 ? -1 : doubleSided ? 1 : 0;
    return 1;
}

int fw_obj3d_set_facing(Fw3dRegistry *r, int handle, int facing) {
    int i = fw_obj3d_find_handle(r, handle);
    if (i < 0) return 0;
    r->objs[i].facing = facing < 0 ? -1 : 1;
    return 1;
}

int fw_obj3d_set_face_yaw(Fw3dRegistry *r, int handle, double yawDeg) { (void)r; (void)handle; (void)yawDeg; return 0; }   /* RED STUB */

int fw_obj3d_mark_gon(Fw3dRegistry *r, int handle) {
    int i = fw_obj3d_find_handle(r, handle);
    if (i < 0) return 0;
    r->objs[i].fromGon = 1;
    return 1;
}

/* M3 (fw_mesh_hide.h): only exactly 1 hides the sprite */
int fw_obj3d_set_hide(Fw3dRegistry *r, int handle, int hideSprite) {
    int i = fw_obj3d_find_handle(r, handle);
    if (i < 0) return 0;
    r->objs[i].hideSprite = hideSprite == 1;
    return 1;
}
