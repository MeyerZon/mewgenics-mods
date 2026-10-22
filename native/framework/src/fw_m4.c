/* fw_m4.c — the 4x4 maths of the mesh path (fw_m4.h). Pure, host-tested (test/test_mesh_draw.c). */
#include <math.h>
#include <string.h>
#include "fw_m4.h"

void fw_m4_identity(float o[16]) {
    memset(o, 0, 16 * sizeof(float));
    o[0] = o[5] = o[10] = o[15] = 1.0f;
}

void fw_m4_mul(const float a[16], const float b[16], float o[16]) {
    float r[16];
    for (int c = 0; c < 4; c++)
        for (int row = 0; row < 4; row++) {
            double s = 0;
            for (int k = 0; k < 4; k++) s += (double)a[k * 4 + row] * (double)b[c * 4 + k];
            r[c * 4 + row] = (float)s;
        }
    memcpy(o, r, sizeof r);
}

/* cofactor expansion in doubles (the same formula as fw_glow_mat4_inverse); inv[] = adjugate, det from row 0 */
static double adjugate(const float m[16], double inv[16]) {
    double a[16];
    for (int i = 0; i < 16; i++) a[i] = m[i];
    inv[0]  =  a[5]*a[10]*a[15] - a[5]*a[11]*a[14] - a[9]*a[6]*a[15] + a[9]*a[7]*a[14] + a[13]*a[6]*a[11] - a[13]*a[7]*a[10];
    inv[4]  = -a[4]*a[10]*a[15] + a[4]*a[11]*a[14] + a[8]*a[6]*a[15] - a[8]*a[7]*a[14] - a[12]*a[6]*a[11] + a[12]*a[7]*a[10];
    inv[8]  =  a[4]*a[9]*a[15]  - a[4]*a[11]*a[13] - a[8]*a[5]*a[15] + a[8]*a[7]*a[13] + a[12]*a[5]*a[11] - a[12]*a[7]*a[9];
    inv[12] = -a[4]*a[9]*a[14]  + a[4]*a[10]*a[13] + a[8]*a[5]*a[14] - a[8]*a[6]*a[13] - a[12]*a[5]*a[10] + a[12]*a[6]*a[9];
    inv[1]  = -a[1]*a[10]*a[15] + a[1]*a[11]*a[14] + a[9]*a[2]*a[15] - a[9]*a[3]*a[14] - a[13]*a[2]*a[11] + a[13]*a[3]*a[10];
    inv[5]  =  a[0]*a[10]*a[15] - a[0]*a[11]*a[14] - a[8]*a[2]*a[15] + a[8]*a[3]*a[14] + a[12]*a[2]*a[11] - a[12]*a[3]*a[10];
    inv[9]  = -a[0]*a[9]*a[15]  + a[0]*a[11]*a[13] + a[8]*a[1]*a[15] - a[8]*a[3]*a[13] - a[12]*a[1]*a[11] + a[12]*a[3]*a[9];
    inv[13] =  a[0]*a[9]*a[14]  - a[0]*a[10]*a[13] - a[8]*a[1]*a[14] + a[8]*a[2]*a[13] + a[12]*a[1]*a[10] - a[12]*a[2]*a[9];
    inv[2]  =  a[1]*a[6]*a[15]  - a[1]*a[7]*a[14]  - a[5]*a[2]*a[15] + a[5]*a[3]*a[14] + a[13]*a[2]*a[7]  - a[13]*a[3]*a[6];
    inv[6]  = -a[0]*a[6]*a[15]  + a[0]*a[7]*a[14]  + a[4]*a[2]*a[15] - a[4]*a[3]*a[14] - a[12]*a[2]*a[7]  + a[12]*a[3]*a[6];
    inv[10] =  a[0]*a[5]*a[15]  - a[0]*a[7]*a[13]  - a[4]*a[1]*a[15] + a[4]*a[3]*a[13] + a[12]*a[1]*a[7]  - a[12]*a[3]*a[5];
    inv[14] = -a[0]*a[5]*a[14]  + a[0]*a[6]*a[13]  + a[4]*a[1]*a[14] - a[4]*a[2]*a[13] - a[12]*a[1]*a[6]  + a[12]*a[2]*a[5];
    inv[3]  = -a[1]*a[6]*a[11]  + a[1]*a[7]*a[10]  + a[5]*a[2]*a[11] - a[5]*a[3]*a[10] - a[9]*a[2]*a[7]   + a[9]*a[3]*a[6];
    inv[7]  =  a[0]*a[6]*a[11]  - a[0]*a[7]*a[10]  - a[4]*a[2]*a[11] + a[4]*a[3]*a[10] + a[8]*a[2]*a[7]   - a[8]*a[3]*a[6];
    inv[11] = -a[0]*a[5]*a[11]  + a[0]*a[7]*a[9]   + a[4]*a[1]*a[11] - a[4]*a[3]*a[9]  - a[8]*a[1]*a[7]   + a[8]*a[3]*a[5];
    inv[15] =  a[0]*a[5]*a[10]  - a[0]*a[6]*a[9]   - a[4]*a[1]*a[10] + a[4]*a[2]*a[9]  + a[8]*a[1]*a[6]   - a[8]*a[2]*a[5];
    return a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
}

double fw_m4_det(const float m[16]) {
    double inv[16];
    return adjugate(m, inv);
}

int fw_m4_inverse(const float m[16], float o[16]) {
    double inv[16];
    const double det = adjugate(m, inv);
    if (!(det > 1e-12 || det < -1e-12)) return 0;   /* singular, or NaN */
    for (int i = 0; i < 16; i++) o[i] = (float)(inv[i] / det);
    return 1;
}

void fw_m4_apply(const float m[16], const float p[4], float out[4]) {
    float r[4];
    for (int row = 0; row < 4; row++)
        r[row] = (float)((double)m[row] * p[0] + (double)m[4 + row] * p[1] + (double)m[8 + row] * p[2] + (double)m[12 + row] * p[3]);
    memcpy(out, r, sizeof r);
}

void fw_m4_view_dir(float dir[3]) {
    /* yaw 45 deg (both ground axes equally), pitch 30 deg down: (cos30/sqrt2, -sin30, cos30/sqrt2) */
    const double c = cos(30.0 * 3.14159265358979323846 / 180.0) / sqrt(2.0);
    dir[0] = (float)c; dir[1] = -0.5f; dir[2] = (float)c;
}

void fw_m4_iso_basis(const float iso[16], float out[16]) {
    float d[3];
    fw_m4_view_dir(d);
    memset(out, 0, 16 * sizeof(float));
    out[0] = iso[0]; out[1] = iso[1]; out[2] = FW_M4_DEPTH_SCALE * d[0];
    out[4] = iso[4]; out[5] = iso[5]; out[6] = FW_M4_DEPTH_SCALE * d[1];
    out[8] = iso[8]; out[9] = iso[9]; out[10] = FW_M4_DEPTH_SCALE * d[2];
    out[15] = 1.0f;
}

void fw_m4_place(const float iso[16], double x, double h, double z, double scale, float out[16]) {
    float B[16], TS[16];
    fw_m4_iso_basis(iso, B);
    fw_m4_identity(TS);
    TS[0] = TS[5] = TS[10] = (float)scale;
    TS[12] = (float)x; TS[13] = (float)h; TS[14] = (float)z;
    fw_m4_mul(B, TS, out);
}

void fw_m4_tile_centre(int col, int row, double out[3]) {
    out[0] = col + 0.5; out[1] = 0.0; out[2] = row + 0.5;
}

int fw_m4_project(const float mvp[16], const float local[3], float ndc[3]) {
    const float p[4] = { local[0], local[1], local[2], 1.0f };
    float q[4];
    fw_m4_apply(mvp, p, q);
    if (!(q[3] > 1e-9f || q[3] < -1e-9f)) return 0;
    ndc[0] = q[0] / q[3]; ndc[1] = q[1] / q[3]; ndc[2] = q[2] / q[3];
    return 1;
}

void fw_m4_ndc_to_pixel(const float ndc[3], double w, double h, double out[2]) {
    out[0] = (ndc[0] + 1.0) * 0.5 * w;
    out[1] = (1.0 - ndc[1]) * 0.5 * h;
}
