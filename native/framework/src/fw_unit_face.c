/* fw_unit_face.c — a unit model's facing (3D phase M3 `face`); see fw_unit_face.h. */
#include <string.h>
#include <stdio.h>
#include <math.h>
#include "fw_unit_face.h"

#define FW_FACE_PI 3.14159265358979323846

int fw_face_read_dir(FwMemRead rd, void *u, const void *character, int dir[2]) {
    int32_t v[2] = { 0, 0 };
    if (dir) dir[0] = dir[1] = 0;
    if (!rd || !character || !dir) return -1;
    if (!rd(u, (const unsigned char *)character + OFF_CH_ORIENTATION, v, sizeof v)) return -1;
    if (v[0] == 0 && v[1] == 0) return 0;
    dir[0] = v[0]; dir[1] = v[1];
    return 1;
}

int fw_face_yaw_deg(const int dir[2], double *yawDeg) {
    if (yawDeg) *yawDeg = 0.0;
    if (!dir || (dir[0] == 0 && dir[1] == 0)) return 0;
    double y = atan2(-(double)dir[0], -(double)dir[1]) * 180.0 / FW_FACE_PI;
    if (y < 0) y += 360.0;
    if (y >= 360.0 || y == 0.0) y = 0.0;   /* also turns -0 into 0 */
    if (yawDeg) *yawDeg = y;
    return 1;
}

double fw_face_yaw(int dirOk, const int dir[2], int flip, int *src) {
    double y;
    if (dirOk == 1 && fw_face_yaw_deg(dir, &y)) {
        if (src) *src = FW_FACE_SRC_DIR;
        return y;
    }
    if (src) *src = FW_FACE_SRC_FLIP;
    return flip < 0 ? 90.0 : 0.0;
}

/* cos / sin with the multiples of 90 exact */
static void cos_sin(double deg, double *c, double *s) {
    double q = fmod(deg, 360.0);
    if (q < 0) q += 360.0;
    if (q == 0.0)        { *c = 1;  *s = 0; return; }
    if (q == 90.0)       { *c = 0;  *s = 1; return; }
    if (q == 180.0)      { *c = -1; *s = 0; return; }
    if (q == 270.0)      { *c = 0;  *s = -1; return; }
    double a = q * FW_FACE_PI / 180.0;
    *c = cos(a); *s = sin(a);
}

void fw_face_rotation(double yawDeg, float out[16]) {
    double c, s;
    cos_sin(yawDeg, &c, &s);
    memset(out, 0, 16 * sizeof(float));
    /* column-major Ry: x' = c*x + s*z, z' = -s*x + c*z (fw_unit_model_transform's rotation) */
    out[0] = (float)c;  out[2] = (float)-s;
    out[5] = 1.0f;
    out[8] = (float)s;  out[10] = (float)c;
    out[15] = 1.0f;
    for (int k = 0; k < 16; k++) if (out[k] == 0.0f) out[k] = 0.0f;   /* no -0 */
}

int fw_face_fmt(char *buf, size_t n, const char *entry, int handle, const int dir[2], double yawDeg, int src, uint64_t epochMs) {
    if (!buf || !n) return 0;
    snprintf(buf, n, "unit model face: %s handle=%d dir=(%d %d) yaw=%g src=%s ms=%llu", entry && entry[0] ? entry : "?", handle,
             dir ? dir[0] : 0, dir ? dir[1] : 0, yawDeg, src == FW_FACE_SRC_DIR ? "dir" : "flip", (unsigned long long)epochMs);
    return (int)strlen(buf);
}
