/* fw_mesh_rules.c — RED stub: the API of fw_mesh_rules.h with nothing implemented (every call fails). */
#include <string.h>
#include "fw_mesh_rules.h"

int fw_mesh_obj_parse(const char *text, size_t len, FwMesh *out, FwMeshError *err) {
    (void)text; (void)len;
    if (out) memset(out, 0, sizeof *out);
    if (err) { strcpy(err->text, "not implemented"); err->line = 0; }
    return 0;
}
void fw_mesh_to_game_axes(FwMesh *m, float scale) { (void)m; (void)scale; }
int fw_mesh_flat_normals(FwMesh *m) { (void)m; return 0; }
void fw_mesh_bounds(FwMesh *m) { (void)m; }
void fw_mesh_free(FwMesh *m) { if (m) memset(m, 0, sizeof *m); }
int fw_mesh_unit_cube(FwMesh *out) { if (out) memset(out, 0, sizeof *out); return 0; }
int fw_mesh_reg_add(FwMeshRegistry *reg, const char *name, FwMesh *taken) { (void)reg; (void)name; (void)taken; return -1; }
int fw_mesh_reg_find(const FwMeshRegistry *reg, const char *name) { (void)reg; (void)name; return -1; }
const FwMesh *fw_mesh_reg_get(const FwMeshRegistry *reg, int i) { (void)reg; (void)i; return NULL; }
const char *fw_mesh_reg_name(const FwMeshRegistry *reg, int i) { (void)reg; (void)i; return NULL; }
void fw_mesh_reg_clear(FwMeshRegistry *reg) { if (reg) reg->count = 0; }
int fw_mesh_model_path(const char *ref, char *out, size_t cap) { (void)ref; if (out && cap) out[0] = 0; return 0; }
int fw_mesh_name_from_path(const char *path, char *out, size_t cap) { (void)path; if (out && cap) out[0] = 0; return 0; }
