/* fw_unit_face.c — a unit model's facing (3D phase M3 `face`); see fw_unit_face.h. RED STUB: not implemented yet. */
#include <string.h>
#include "fw_unit_face.h"

int fw_face_read_dir(FwMemRead rd, void *u, const void *character, int dir[2]) { (void)rd; (void)u; (void)character; if (dir) dir[0] = dir[1] = 0; return -1; }
int fw_face_yaw_deg(const int dir[2], double *yawDeg) { (void)dir; if (yawDeg) *yawDeg = 0; return 0; }
double fw_face_yaw(int dirOk, const int dir[2], int flip, int *src) { (void)dirOk; (void)dir; (void)flip; if (src) *src = 0; return 0; }
void fw_face_rotation(double yawDeg, float out[16]) { (void)yawDeg; memset(out, 0, 16 * sizeof(float)); }
int fw_face_fmt(char *buf, size_t n, const char *entry, int handle, const int dir[2], double yawDeg, int src, uint64_t epochMs) {
    (void)entry; (void)handle; (void)dir; (void)yawDeg; (void)src; (void)epochMs;
    if (buf && n) buf[0] = 0;
    return 0;
}
