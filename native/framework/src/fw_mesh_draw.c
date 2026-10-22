/* fw_mesh_draw.c — the pure decisions of the M1 mesh path (fw_mesh_draw.h). Host-tested in test/test_mesh_draw.c. */
#include <stdio.h>
#include <string.h>
#include "fw_mesh_draw.h"
#include "offsets.h"

/* a plain non-negative decimal of at most 6 digits, the whole [s, e) range */
static int parse_uint(const char *s, const char *e, int *out) {
    if (s >= e || e - s > 6) return 0;
    int v = 0;
    for (const char *p = s; p < e; p++) {
        if (*p < '0' || *p > '9') return 0;
        v = v * 10 + (*p - '0');
    }
    *out = v;
    return 1;
}

int fw_mesh_probe_parse(const char *value, int *col, int *row) {
    if (!value || !*value) return 0;
    if (!strcmp(value, "1")) { *col = FW_MESH_PROBE_DEFAULT_COL; *row = FW_MESH_PROBE_DEFAULT_ROW; return 1; }
    const char *comma = strchr(value, ',');
    if (!comma) return 0;
    int c, r;
    if (!parse_uint(value, comma, &c) || !parse_uint(comma + 1, comma + 1 + strlen(comma + 1), &r)) return 0;
    *col = c; *row = r;
    return 1;
}

int fw_mesh_draw_after_layer(const void *tacticsTest, const void *cam, int layer) {
    if (!tacticsTest || !cam || layer != CONST_UNITS_LAYER) return 0;
    return *(void *const *)((const unsigned char *)tacticsTest + OFF_TT_MAIN_CAMERA) == cam;
}

const float *fw_mesh_stack_top(const void *const *stackData, const int *stackTop) {
    if (!stackData || !stackTop || !*stackData || *stackTop < 0) return NULL;
    return (const float *)*stackData + (size_t)*stackTop * 16;
}

int fw_mesh_fmt_probe(char *buf, size_t n, int frame, int col, int row, const float ndc[3], const double canvas[2]) {
    int k = snprintf(buf, n, "mesh probe f=%d tile=(%d,%d) ndc=(%.3g %.3g %.3g) canvas=(%.2f %.2f)", frame, col, row,
                     (double)ndc[0], (double)ndc[1], (double)ndc[2], canvas[0], canvas[1]);
    if (k < 0) { if (n) buf[0] = 0; return 0; }
    return (size_t)k < n ? k : (int)(n ? n - 1 : 0);
}

/* ---- red stubs (the green commit implements them) ---- */
int fw_shader_stage(const char *src, size_t len, int vertex, char *out, size_t cap) { (void)src; (void)len; (void)vertex; (void)out; (void)cap; return -1; }
int fw_mesh_load_bytes(const char *path, const uint8_t *bytes, size_t len, FwMesh *out, FwMeshError *err) { (void)path; (void)bytes; (void)len; (void)err; memset(out, 0, sizeof *out); return 0; }
void fw_mesh_object_mvp(const float top[16], const float vp[16], const float iso[16], const float world[16], float out[16]) { (void)top; (void)vp; (void)iso; (void)world; memset(out, 0, 16 * sizeof(float)); }
