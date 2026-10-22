/* fw_unit_model.c — pure rules of the per-unit models; see fw_unit_model.h. (red: stubs) */
#include <string.h>
#include "fw_unit_model.h"

int fw_unit_walk(FwMemRead rd, void *u, const void *turnControl, void **out, int cap) { (void)rd; (void)u; (void)turnControl; (void)out; (void)cap; return -2; }
void fw_unit_seen_clear(FwUnitSeen *s) { s->n = 0; }
int fw_unit_seen_first(FwUnitSeen *s, const void *character, uint64_t generation) { (void)s; (void)character; (void)generation; return 0; }
void fw_unit_model_transform(double scale, double yawDeg, const double offset[3], float out[16]) { (void)scale; (void)yawDeg; (void)offset; memset(out, 0, 16 * sizeof(float)); }
int fw_unit_facing(const float screen[16]) { (void)screen; return 0; }
int fw_unit_fmt_model(char *buf, size_t n, const char *entry, const void *character, const FwGonModel *m) { (void)entry; (void)character; (void)m; if (n) buf[0] = 0; return 0; }
int fw_unit_fmt_at(char *buf, size_t n, const char *entry, int handle, const double xz[2], const float screen[16], int facing, uint64_t epochMs) { (void)entry; (void)handle; (void)xz; (void)screen; (void)facing; (void)epochMs; if (n) buf[0] = 0; return 0; }
int fw_unit_moved(const double last[2], const double now[2]) { (void)last; (void)now; return -1; }
