/* fw_unit_model.c — pure rules of the per-unit models (3D phase M2 item 4); see fw_unit_model.h. */
#include <string.h>
#include <stdio.h>
#include <math.h>
#include "fw_unit_model.h"

#define FW_UNIT_PI 3.14159265358979323846

static int rd_ptr(FwMemRead rd, void *u, const void *base, int off, const void **out) {
    *out = NULL;
    return rd(u, (const unsigned char *)base + off, (void *)out, sizeof *out) && *out != NULL;
}

int fw_unit_walk(FwMemRead rd, void *u, const void *turnControl, void **out, int cap) {
    const void *scene, *em, *x, *arr, *data;
    uint32_t n = 0;
    if (!turnControl) return 0;
    if (!rd || !out || cap <= 0) return -1;
    if (!rd_ptr(rd, u, turnControl, OFF_TC_SCENE, &scene) || !rd_ptr(rd, u, scene, OFF_SCENE_EM, &em) ||
        !rd_ptr(rd, u, em, OFF_EM_X, &x) || !rd_ptr(rd, u, x, OFF_X_CHARARRAY, &arr)) return -1;
    if (!rd(u, (const unsigned char *)arr + OFF_ARR_COUNT, &n, sizeof n) || n > FW_UNIT_WALK_MAX) return -1;
    if (n == 0) return 0;
    if (!rd_ptr(rd, u, arr, OFF_ARR_DATA, &data)) return -1;
    int k = (int)n < cap ? (int)n : cap;
    if (!rd(u, data, out, (size_t)k * sizeof(void *))) return -1;
    return k;
}

void fw_unit_seen_clear(FwUnitSeen *s) { memset(s, 0, sizeof *s); }

int fw_unit_seen_first(FwUnitSeen *s, const void *character, uint64_t generation) {
    if (!character) return 0;
    for (int i = 0; i < s->n; i++) {
        if (s->ch[i] != character) continue;
        if (s->gen[i] == generation) return 0;
        s->gen[i] = generation;                 /* the pool slot was reused: a new unit in the same place */
        return 1;
    }
    if (s->n >= FW_UNIT_SEEN_MAX) fw_unit_seen_clear(s);
    s->ch[s->n] = character;
    s->gen[s->n] = generation;
    s->n++;
    return 1;
}

void fw_unit_model_transform(double scale, double yawDeg, const double offset[3], float out[16]) {
    double s = scale > 0 ? scale : 1.0;
    double a = yawDeg * FW_UNIT_PI / 180.0, c = cos(a), sn = sin(a);
    memset(out, 0, 16 * sizeof(float));
    /* T x Ry x S, column-major: x' = c*x + sn*z, z' = -sn*x + c*z */
    out[0] = (float)(c * s);  out[2] = (float)(-sn * s);
    out[5] = (float)s;
    out[8] = (float)(sn * s); out[10] = (float)(c * s);
    out[15] = 1.0f;
    if (offset) { out[12] = (float)offset[0]; out[13] = (float)offset[1]; out[14] = (float)offset[2]; }
}

int fw_unit_facing(const float screen[16]) { return screen && screen[0] < 0.0f ? -1 : 1; }

int fw_unit_fmt_model(char *buf, size_t n, const char *entry, const void *character, const FwGonModel *m) {
    if (!buf || !n) return 0;
    int len = snprintf(buf, n, "unit model: %s %p -> %s", entry && entry[0] ? entry : "?", character, m ? m->file : "");
    if (m && m->isBlock && len >= 0 && (size_t)len < n) {
        len += snprintf(buf + len, n - (size_t)len, " (block scale=%g yaw=%g offset=(%g %g %g)", m->scale, m->yaw, m->offset[0], m->offset[1], m->offset[2]);
        if (m->texture[0] && (size_t)len < n) len += snprintf(buf + len, n - (size_t)len, " texture=%s", m->texture);
        if (m->invalid && (size_t)len < n) len += snprintf(buf + len, n - (size_t)len, " invalid=0x%x", (unsigned)m->invalid);
        if ((size_t)len < n) len += snprintf(buf + len, n - (size_t)len, ")");
    }
    size_t w = strlen(buf);
    return (int)w;
}

int fw_unit_fmt_at(char *buf, size_t n, const char *entry, int handle, const double xz[2], const float screen[16], int facing, uint64_t epochMs) {
    if (!buf || !n) return 0;
    char scr[64];
    if (screen) snprintf(scr, sizeof scr, "(%.3f %.3f)", (double)screen[12], (double)screen[13]);
    else snprintf(scr, sizeof scr, "(none)");
    snprintf(buf, n, "unit model at: %s handle=%d world=(%.3f %.3f) screen=%s facing=%s m0=%g ms=%llu", entry && entry[0] ? entry : "?", handle,
             xz ? xz[0] : 0.0, xz ? xz[1] : 0.0, scr, facing < 0 ? "-1" : "+1", screen ? (double)screen[0] : 0.0, (unsigned long long)epochMs);
    return (int)strlen(buf);
}

int fw_unit_moved(const double last[2], const double now[2]) {
    if (!last) return 1;
    return fabs(now[0] - last[0]) >= FW_UNIT_MOVE_EPS || fabs(now[1] - last[1]) >= FW_UNIT_MOVE_EPS;
}
