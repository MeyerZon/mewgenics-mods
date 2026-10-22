/* fw_mesh_slice.c — per-band slices of a mesh in the units layer's painter order (fw_mesh_slice.h). Pure, host-tested
 * (test/test_mesh_slice.c). */
#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "fw_mesh_slice.h"

#define BAND_LIMIT 4096   /* bands before merging: anything wider is not a model on a board */

static void corner(const float lo[3], const float hi[3], int i, float p[3]) {
    p[0] = (i & 1) ? hi[0] : lo[0];
    p[1] = (i & 2) ? hi[1] : lo[1];
    p[2] = (i & 4) ? hi[2] : lo[2];
}

/* world x + z of a local point (column-major world) */
static double depth_of(const float w[16], const float p[3]) {
    return (double)(w[0] + w[2]) * p[0] + (double)(w[4] + w[6]) * p[1] + (double)(w[8] + w[10]) * p[2] + (double)w[12] + (double)w[14];
}

int fw_mesh_slice_depth(const float world[16], const float lo[3], const float hi[3], double range[2]) {
    if (!world || !lo || !hi || !range) return 0;
    for (int i = 0; i < 8; i++) {
        float p[3];
        corner(lo, hi, i, p);
        double d = depth_of(world, p);
        if (i == 0 || d < range[0]) range[0] = d;
        if (i == 0 || d > range[1]) range[1] = d;
    }
    return 1;
}

int fw_mesh_slice_plan(double front, double back, int max, FwMeshSlice *out) {
    if (!out || max <= 0 || !(front <= back) || !isfinite(front) || !isfinite(back)) return 0;
    if (max > FW_MESH_SLICE_MAX) max = FW_MESH_SLICE_MAX;
    double f0 = floor(front + FW_MESH_SLICE_EPS), b1 = ceil(back - FW_MESH_SLICE_EPS) - 1.0;
    if (b1 < f0) b1 = f0;
    double count = b1 - f0 + 1.0;
    if (count > BAND_LIMIT) return 0;
    int nb = (int)count, w = (nb + max - 1) / max, n = (nb + w - 1) / w;
    for (int i = 0; i < n; i++) {
        FwMeshSlice *s = &out[i];
        s->lo = f0 + (double)i * w;
        s->hi = s->lo + w;
        if (s->hi > b1 + 1.0) s->hi = b1 + 1.0;
        s->key = (s->lo + s->hi) * 0.5;
        s->clip[0] = i == 0 ? -FW_MESH_CLIP_OPEN : (float)s->lo;
        s->clip[1] = i == n - 1 ? FW_MESH_CLIP_OPEN : (float)s->hi;
    }
    return n;
}

/* ---- visible area ---- */
typedef struct V3 { double p[3]; double d; } V3;

/* keep the part of the polygon where sign * (d - edge) >= 0 (Sutherland-Hodgman on a linear function) */
static int clip_poly(const V3 *in, int n, double edge, double sign, V3 *out) {
    int m = 0;
    for (int i = 0; i < n; i++) {
        const V3 *a = &in[i], *b = &in[(i + 1) % n];
        double fa = sign * (a->d - edge), fb = sign * (b->d - edge);
        if (fa >= 0) out[m++] = *a;
        if ((fa >= 0) != (fb >= 0)) {
            double t = fa / (fa - fb);
            V3 *c = &out[m++];
            for (int k = 0; k < 3; k++) c->p[k] = a->p[k] + t * (b->p[k] - a->p[k]);
            c->d = a->d + t * (b->d - a->d);
        }
    }
    return m;
}

static int project(const float m[16], const double p[3], double out[2]) {
    double w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    if (w < 1e-9 && w > -1e-9) return 0;
    out[0] = (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w;
    out[1] = (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w;
    return 1;
}

/* the box's faces, counter-clockwise seen from outside, as corner indices (bit 0 = x hi, bit 1 = y hi, bit 2 = z hi) */
static const int FACES[6][4] = {
    { 2, 6, 7, 3 },   /* +y (the top: the orientation reference) */
    { 0, 1, 5, 4 },   /* -y */
    { 1, 3, 7, 5 },   /* +x */
    { 0, 4, 6, 2 },   /* -x */
    { 4, 5, 7, 6 },   /* +z */
    { 0, 2, 3, 1 },   /* -z */
};

/* signed NDC area of a face polygon; 0 when a vertex cannot be projected (*ok = 0) */
static double poly_area(const float mvp[16], const V3 *v, int n, double box[4], int *first, int *ok) {
    double a = 0, q[16][2];
    for (int i = 0; i < n; i++)
        if (!project(mvp, v[i].p, q[i])) { *ok = 0; return 0; }
    for (int i = 0; i < n; i++) {
        int j = (i + 1) % n;
        a += q[i][0] * q[j][1] - q[j][0] * q[i][1];
        if (box) {
            if (*first) { box[0] = box[2] = q[i][0]; box[1] = box[3] = q[i][1]; *first = 0; }
            if (q[i][0] < box[0]) box[0] = q[i][0];
            if (q[i][0] > box[2]) box[2] = q[i][0];
            if (q[i][1] < box[1]) box[1] = q[i][1];
            if (q[i][1] > box[3]) box[3] = q[i][1];
        }
    }
    return a * 0.5;
}

int fw_mesh_slice_visible(const float mvp[16], const float world[16], const float lo[3], const float hi[3], double dlo, double dhi, double box[4], double *area) {
    if (area) *area = 0;
    if (!mvp || !world || !lo || !hi) return 0;
    V3 c[8];
    for (int i = 0; i < 8; i++) {
        float p[3];
        corner(lo, hi, i, p);
        for (int k = 0; k < 3; k++) c[i].p[k] = p[k];
        c[i].d = depth_of(world, p);
    }
    int ok = 1, dummy = 0;
    /* the orientation of a visible face = the top's (the board camera looks down: the top is always seen; a view
     * that sees the top edge-on has no defined answer and returns 0) */
    V3 top[4];
    for (int k = 0; k < 4; k++) top[k] = c[FACES[0][k]];
    double ref = poly_area(mvp, top, 4, NULL, &dummy, &ok);
    if (!ok || fabs(ref) < 1e-12) return 0;
    double sum = 0, b[4] = { 0, 0, 0, 0 };
    int first = 1;
    for (int f = 0; f < 6; f++) {
        V3 v[4], t[12], u[12];
        for (int k = 0; k < 4; k++) v[k] = c[FACES[f][k]];
        int dumb = 1;
        double whole = poly_area(mvp, v, 4, NULL, &dumb, &ok);
        if (!ok) return 0;
        if (whole * ref <= 0) continue;                  /* back-facing or edge-on */
        int n = clip_poly(v, 4, dlo, 1.0, t);           /* d >= dlo */
        n = n ? clip_poly(t, n, dhi, -1.0, u) : 0;      /* d <= dhi (the half-open edge has no area) */
        if (n < 3) continue;
        double fb[4];
        int ffirst = 1;
        double a = poly_area(mvp, u, n, fb, &ffirst, &ok);
        if (!ok) return 0;
        if (fabs(a) < 1e-12) continue;                  /* a sliver on the band edge: no pixels, not in the bbox */
        if (first) { memcpy(b, fb, sizeof b); first = 0; }
        else {
            if (fb[0] < b[0]) b[0] = fb[0];
            if (fb[1] < b[1]) b[1] = fb[1];
            if (fb[2] > b[2]) b[2] = fb[2];
            if (fb[3] > b[3]) b[3] = fb[3];
        }
        sum += fabs(a);
    }
    if (first || sum <= 0) return 0;
    if (box) memcpy(box, b, sizeof b);
    if (area) *area = sum;
    return 1;
}

/* ---- tints, probe tile, log line ---- */
static const char *const TINT_NAMES[3] = { "blue", "cyan", "magenta" };
static const float TINTS[3][3] = { { 0, 0, 1 }, { 0, 1, 1 }, { 1, 0, 1 } };

static int tint_index(int band) { int i = band % 3; return i < 0 ? i + 3 : i; }

void fw_mesh_slice_tint(int band, float rgba[4]) {
    if (!rgba) return;
    const float *t = TINTS[tint_index(band)];
    rgba[0] = t[0]; rgba[1] = t[1]; rgba[2] = t[2]; rgba[3] = 1.0f;
}

const char *fw_mesh_slice_tint_name(int band) { return TINT_NAMES[tint_index(band)]; }

static int parse_uint(const char *s, const char *end, int *out) {
    if (s >= end) return 0;
    long v = 0;
    for (const char *p = s; p < end; p++) {
        if (*p < '0' || *p > '9') return 0;
        v = v * 10 + (*p - '0');
        if (v > 4095) return 0;
    }
    *out = (int)v;
    return 1;
}

int fw_mesh_slice_probe_at(const char *spec, char *path, size_t cap, int *col, int *row) {
    if (!spec || !path || !cap) return -1;
    const char *at = strrchr(spec, '@');
    size_t plen = at ? (size_t)(at - spec) : strlen(spec);
    if (plen == 0 || plen + 1 > cap) return -1;
    if (at) {
        const char *comma = strchr(at + 1, ',');
        int c = 0, r = 0;
        if (!comma || !parse_uint(at + 1, comma, &c) || !parse_uint(comma + 1, comma + 1 + strlen(comma + 1), &r)) return -1;
        if (col) *col = c;
        if (row) *row = r;
    }
    memcpy(path, spec, plen);
    path[plen] = 0;
    return at ? 1 : 0;
}

int fw_mesh_slice_fmt(char *buf, size_t n, int frame, int obj, int band, int nbands, const FwMeshSlice *s, const double box[4], double area, const char *tint) {
    if (!buf || !n) return 0;
    static const double zero[4] = { 0, 0, 0, 0 };
    if (!box) box = zero;
    int w = snprintf(buf, n, "mesh slice f=%d obj=%d band=%d/%d depth=[%.3f %.3f) key=%.3f vis=(%.4f %.4f %.4f %.4f) area=%.6f tint=%s",
                     frame, obj, band, nbands, s ? s->lo : 0.0, s ? s->hi : 0.0, s ? s->key : 0.0, box[0], box[1], box[2], box[3], area,
                     tint && tint[0] ? tint : "-");
    if (w < 0) { buf[0] = 0; return 0; }
    return (size_t)w >= n ? (int)(n - 1) : w;
}
