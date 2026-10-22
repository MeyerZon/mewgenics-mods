/* Pure rules of the 3D-object registry; see fw_obj3d_rules.h. RED STUB: every function refuses. */
#include <string.h>
#include "fw_obj3d_rules.h"
void fw_obj3d_init(Fw3dRegistry *r) { memset(r, 0, sizeof *r); }
void fw_obj3d_clear(Fw3dRegistry *r) { (void)r; }
int  fw_obj3d_add_character(Fw3dRegistry *r, void *c, const char *m, const float t[16]) { (void)r; (void)c; (void)m; (void)t; return 0; }
int  fw_obj3d_add_tile(Fw3dRegistry *r, int col, int row, const char *m, const float t[16]) { (void)r; (void)col; (void)row; (void)m; (void)t; return 0; }
int  fw_obj3d_find_character(const Fw3dRegistry *r, const void *c) { (void)r; (void)c; return -1; }
int  fw_obj3d_find_handle(const Fw3dRegistry *r, int h) { (void)r; (void)h; return -1; }
int  fw_obj3d_remove_character(Fw3dRegistry *r, const void *c) { (void)r; (void)c; return 0; }
int  fw_obj3d_remove_handle(Fw3dRegistry *r, int h) { (void)r; (void)h; return 0; }
int  fw_obj3d_prune(Fw3dRegistry *r) { (void)r; return 0; }
int  fw_obj3d_count(const Fw3dRegistry *r) { (void)r; return 0; }
const Fw3dObject *fw_obj3d_at(const Fw3dRegistry *r, int i) { (void)r; (void)i; return NULL; }
int  fw_obj3d_model_ok(const char *m) { (void)m; return 0; }
int  fw_obj3d_model_path_ok(const char *p) { (void)p; return 0; }
void fw_obj3d_identity(float out[16]) { memset(out, 0, 16 * sizeof(float)); }
void fw_obj3d_mat4_mul(const float a[16], const float b[16], float out[16]) { (void)a; (void)b; memset(out, 0, 16 * sizeof(float)); }
void fw_obj3d_tile_centre(int col, int row, float out[3]) { (void)col; (void)row; out[0] = out[1] = out[2] = 0; }
void fw_obj3d_model_matrix(const Fw3dObject *o, const double xz[2], float out[16]) { (void)o; (void)xz; memset(out, 0, 16 * sizeof(float)); }
