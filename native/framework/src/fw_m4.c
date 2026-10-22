/* fw_m4.c — red stub (the green commit implements it) */
#include <string.h>
#include "fw_m4.h"
void fw_m4_identity(float o[16]) { memset(o, 0, 16 * sizeof(float)); }
void fw_m4_mul(const float a[16], const float b[16], float o[16]) { (void)a; (void)b; memset(o, 0, 16 * sizeof(float)); }
double fw_m4_det(const float m[16]) { (void)m; return 0; }
int fw_m4_inverse(const float m[16], float o[16]) { (void)m; (void)o; return 0; }
void fw_m4_apply(const float m[16], const float p[4], float out[4]) { (void)m; (void)p; memset(out, 0, 4 * sizeof(float)); }
void fw_m4_view_dir(float dir[3]) { dir[0] = dir[1] = dir[2] = 0; }
void fw_m4_iso_basis(const float iso[16], float out[16]) { (void)iso; memset(out, 0, 16 * sizeof(float)); }
void fw_m4_place(const float iso[16], double x, double h, double z, double s, float out[16]) { (void)iso; (void)x; (void)h; (void)z; (void)s; memset(out, 0, 16 * sizeof(float)); }
void fw_m4_tile_centre(int col, int row, double out[3]) { (void)col; (void)row; out[0] = out[1] = out[2] = 0; }
int fw_m4_project(const float mvp[16], const float local[3], float ndc[3]) { (void)mvp; (void)local; ndc[0] = ndc[1] = ndc[2] = 0; return 0; }
void fw_m4_ndc_to_pixel(const float ndc[3], double w, double h, double out[2]) { (void)ndc; (void)w; (void)h; out[0] = out[1] = 0; }
