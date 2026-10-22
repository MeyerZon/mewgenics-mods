/* Pure rules of the per-unit glow engine; see fw_glow_rules.h. */
#include <string.h>
#include "fw_glow_rules.h"

/* ----------------------------------------------------------------------- */
/* registry                                                                 */
/* ----------------------------------------------------------------------- */
void fw_glow_reset(FwGlowRegistry *r) { memset(r, 0, sizeof *r); }

int fw_glow_find(const FwGlowRegistry *r, const void *character) {
    if (!character) return -1;
    for (int i = 0; i < r->count; i++) if (r->units[i].character == character) return i;
    return -1;
}

int fw_glow_set(FwGlowRegistry *r, void *character, const float rgba[4]) {
    if (!character || !rgba) return 0;
    int i = fw_glow_find(r, character);
    if (i < 0) {
        if (r->count >= FW_GLOW_MAX_UNITS) return 0;
        i = r->count++;
        r->units[i].character = character;
        r->units[i].generation = fw_glow_generation(character);
    }
    memcpy(r->units[i].rgba, rgba, sizeof r->units[i].rgba);
    r->units[i].fromStatus = 0;   /* a native call owns the entry (fw_glow_set_from_status marks it back) */
    return 1;
}

static void remove_at(FwGlowRegistry *r, int i) {
    for (int k = i + 1; k < r->count; k++) r->units[k - 1] = r->units[k];
    r->count--;
    memset(&r->units[r->count], 0, sizeof r->units[0]);
}

int fw_glow_clear(FwGlowRegistry *r, const void *character) {
    int i = fw_glow_find(r, character);
    if (i < 0) return 0;
    remove_at(r, i);
    return 1;
}

int fw_glow_prune(FwGlowRegistry *r) {
    int dropped = 0;
    for (int i = 0; i < r->count;) {
        if (fw_glow_generation(r->units[i].character) != r->units[i].generation) { remove_at(r, i); dropped++; }
        else i++;
    }
    return dropped;
}

void fw_glow_colour(const FwGlowRegistry *r, float out[4]) {
    if (r->count > 0) { memcpy(out, r->units[0].rgba, 4 * sizeof(float)); return; }
    out[0] = out[1] = out[2] = out[3] = 1.0f;
}

int fw_glow_colour_eq(const float a[4], const float b[4]) {
    return a[0] == b[0] && a[1] == b[1] && a[2] == b[2] && a[3] == b[3];
}

void fw_glow_frame(const FwGlowRegistry *r, FwGlowFrame *out) {
    memset(out, 0, sizeof *out);
    out->active = r->count > 0;
    fw_glow_colour(r, out->colour);
    fw_glow_groups(r, &out->groups);
    out->ndraws = fw_glow_plan(r, &out->groups, out->draws);
}

/* ----------------------------------------------------------------------- */
/* the renderer's extra-layer vector {+0 cap, +4 count, +8 data}            */
/* ----------------------------------------------------------------------- */
static uint32_t *layers_data(const void *renderer) { return *(uint32_t *const *)((const char *)renderer + OFF_RND_EXTRA_DATA); }
static uint32_t *layers_count(void *renderer) { return (uint32_t *)((char *)renderer + OFF_RND_EXTRA_COUNT); }

int fw_glow_layers_has(const void *renderer, uint32_t layer) {
    if (!renderer) return 0;
    uint32_t n = *(const uint32_t *)((const char *)renderer + OFF_RND_EXTRA_COUNT);
    const uint32_t *d = layers_data(renderer);
    if (!d) return 0;
    for (uint32_t i = 0; i < n; i++) if (d[i] == layer) return 1;
    return 0;
}

int fw_glow_layers_strip(void *renderer, uint32_t layer) {
    if (!renderer) return 0;
    uint32_t *count = layers_count(renderer), *d = layers_data(renderer);
    if (!d) return 0;
    int removed = 0;
    for (uint32_t i = 0; i < *count;) {
        if (d[i] == layer) { d[i] = d[*count - 1]; (*count)--; removed++; }   /* swap-remove, as StatusMenu::update does */
        else i++;
    }
    return removed;
}

/* ----------------------------------------------------------------------- */
/* passes                                                                   */
/* ----------------------------------------------------------------------- */
void *fw_glow_find_pass(const void *camera, int layer, const void *material) {
    if (!camera || !material || layer < 0) return NULL;
    const char *table = *(const char *const *)((const char *)camera + OFF_CAM_PASSES);
    if (!table) return NULL;
    const char *vec = table + (size_t)layer * 0x18;   /* {begin, end, cap} of Pass* per layer index */
    void *const *begin = *(void *const *const *)vec, *const *end = *(void *const *const *)(vec + 8);
    for (void *const *p = begin; p && p < end; p++) {
        const char *pass = (const char *)*p;
        if (!pass || *(const uint32_t *)(pass + OFF_PASS_MAT_COUNT) == 0) continue;
        const void *const *mats = *(const void *const *const *)(pass + OFF_PASS_MATERIALS);
        if (mats && mats[0] == material) return (void *)pass;
    }
    return NULL;
}

void fw_glow_pass_force(void *pass, int enabled, int fullScreen) {
    if (!pass) return;
    *((char *)pass + OFF_PASS_ENABLED) = (char)(enabled ? 1 : 0);
    if (fullScreen) {
        double *a = (double *)((char *)pass + OFF_PASS_RECT_A), *b = (double *)((char *)pass + OFF_PASS_RECT_B);
        a[0] = 0; a[1] = 1; a[2] = 0; a[3] = 1;
        b[0] = 0; b[1] = 1; b[2] = 0; b[3] = 1;
    }
}

void fw_glow_pass_adopt(void *pass) {
    if (!pass) return;
    *(uint16_t *)((char *)pass + OFF_PASS_FLAGS) = 0;
    *((char *)pass + OFF_PASS_ENABLED) = 1;
}


/* ----------------------------------------------------------------------- */
/* v2: colour groups and the draw plan                                      */
/* ----------------------------------------------------------------------- */
void fw_glow_groups(const FwGlowRegistry *r, FwGlowGroups *out) {
    out->count = 0;
    for (int i = 0; i < r->count; i++) {
        int k = 0;
        while (k < out->count && !fw_glow_colour_eq(out->g[k].colour, r->units[i].rgba)) k++;
        if (k == out->count) {   /* a new colour: never more groups than units, so the cap holds */
            memcpy(out->g[k].colour, r->units[i].rgba, sizeof out->g[k].colour);
            out->g[k].count = 0;
            out->count++;
        }
        out->g[k].units[out->g[k].count++] = i;
    }
}

int fw_glow_group_of(const FwGlowGroups *g, int unit) {
    for (int k = 0; k < g->count; k++)
        for (int j = 0; j < g->g[k].count; j++) if (g->g[k].units[j] == unit) return k;
    return -1;
}

int fw_glow_plan(const FwGlowRegistry *r, const FwGlowGroups *g, FwGlowDraw out[FW_GLOW_MAX_UNITS]) {
    if (r->count == 0 || g->count == 0) return 0;
    if (g->count == 1) { out[0].group = 0; out[0].unit = -1; return 1; }
    int n = 0;
    for (int i = 0; i < r->count && n < FW_GLOW_MAX_UNITS; i++) { out[n].group = fw_glow_group_of(g, i); out[n].unit = i; n++; }
    return n;
}

const char *fw_glow_material_name(int slot, char *buf, size_t cap) {
    static const char base[] = "fw_unit_glow";
    char digits[12];
    int nd = 0;
    if (slot < 0 || !buf) return NULL;
    for (int v = slot; v > 0; v /= 10) digits[nd++] = (char)('0' + v % 10);
    size_t need = sizeof base - 1 + (slot > 0 ? 1 + (size_t)nd : 0) + 1;
    if (need > cap) return NULL;
    char *p = buf;
    memcpy(p, base, sizeof base - 1);
    p += sizeof base - 1;
    if (slot > 0) { *p++ = '_'; while (nd > 0) *p++ = digits[--nd]; }
    *p = 0;
    return buf;
}

/* ----------------------------------------------------------------------- */
/* v2: a unit's screen rect (TacticsTest::LateRender 0x88e24e..0x88e4a0)    */
/* ----------------------------------------------------------------------- */
static float fmin2(float a, float b) { return a < b ? a : b; }
static float fmax2(float a, float b) { return a > b ? a : b; }

void fw_glow_clip_bounds(float b[4], const float m[6]) {   /* the leaf 0x9d46d0, operand for operand */
    const float x0 = b[0], x1 = b[1], y0 = b[2], y1 = b[3];
    b[0] = fmin2(m[0] * x1, m[0] * x0) + m[4] + fmin2(m[3] * y1, m[3] * y0);
    b[1] = fmax2(m[0] * x1, m[0] * x0) + m[4] + fmax2(m[3] * y1, m[3] * y0);
    b[2] = fmin2(m[2] * x1, m[2] * x0) + m[5] + fmin2(m[1] * y1, m[1] * y0);
    b[3] = fmax2(m[2] * x1, m[2] * x0) + m[5] + fmax2(m[1] * y1, m[1] * y0);
}

void fw_glow_matrix_bounds(float b[4], const float M[16]) {   /* LateRender 0x88e2b1..0x88e376 */
    const float x0 = b[0], x1 = b[1], y0 = b[2], y1 = b[3];
    b[0] = fmin2(M[0] * x0, M[0] * x1) + M[12] + fmin2(M[4] * y0, M[4] * y1);
    b[1] = fmax2(M[0] * x0, M[0] * x1) + M[12] + fmax2(M[4] * y0, M[4] * y1);
    b[2] = fmin2(M[1] * x0, M[1] * x1) + M[13] + fmin2(M[5] * y0, M[5] * y1);
    b[3] = fmax2(M[1] * x0, M[1] * x1) + M[13] + fmax2(M[5] * y0, M[5] * y1);
}

int fw_glow_mat4_inverse(const float m[16], float out[16]) {   /* stands in for the leaf 0xa07c70 (cofactors / det) */
    double a[16], inv[16];
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
    const double det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
    if (!(det > 1e-12 || det < -1e-12)) return 0;   /* singular, or NaN */
    for (int i = 0; i < 16; i++) out[i] = (float)(inv[i] / det);
    return 1;
}

void fw_glow_view_rect(const float b[4], const float C[16], double zoom, int zoomY, FwGlowRect *out) {
    /* P = C x K, K = {zoom,0,0,0 / 0,zoom*zoomY,0,0 / 0,0,1,0 / 640,360,0,1}; LateRender uses lanes 0 (x) and 1 (y) of
     * rows 0, 1 and 3 only (0x88e3ed..0x88e4a0) */
    const float z = (float)zoom, zy = (float)((double)zoomY * zoom);
    const float cx = (float)(FW_GLOW_CANVAS_W / 2), cy = (float)(FW_GLOW_CANVAS_H / 2);
    const float p0x = C[0] * z + C[3] * cx, p0y = C[1] * zy + C[3] * cy;
    const float p1x = C[4] * z + C[7] * cx, p1y = C[5] * zy + C[7] * cy;
    const float p3x = C[12] * z + C[15] * cx, p3y = C[13] * zy + C[15] * cy;
    const float sx = (float)(1.0 / FW_GLOW_CANVAS_W), sy = (float)(1.0 / FW_GLOW_CANVAS_H);
    out->x0 = (fmin2(p0x * b[0], p0x * b[1]) + p3x + fmin2(p1x * b[2], p1x * b[3])) * sx;
    out->x1 = (fmax2(p0x * b[0], p0x * b[1]) + p3x + fmax2(p1x * b[2], p1x * b[3])) * sx;
    out->y0 = 1.0f - (fmax2(p0y * b[0], p0y * b[1]) + p3y + fmax2(p1y * b[2], p1y * b[3])) * sy;
    out->y1 = 1.0f - (fmin2(p0y * b[0], p0y * b[1]) + p3y + fmin2(p1y * b[2], p1y * b[3])) * sy;
}

static double clamp01(double v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

int fw_glow_unit_rect(const float rawBounds[4], const float clipM[6], const float screenM[16], const float viewM[16],
                      double zoom, int zoomY, double margin, FwGlowRect *out) {
    float b[4] = { rawBounds[0], rawBounds[1], rawBounds[2], rawBounds[3] }, C[16];
    fw_glow_clip_bounds(b, clipM);
    fw_glow_matrix_bounds(b, screenM);
    if (!fw_glow_mat4_inverse(viewM, C)) return 0;
    FwGlowRect r;
    fw_glow_view_rect(b, C, zoom, zoomY, &r);
    if (r.x0 != r.x0 || r.x1 != r.x1 || r.y0 != r.y0 || r.y1 != r.y1) return 0;   /* NaN */
    r.x0 = clamp01(r.x0 - margin / FW_GLOW_CANVAS_W); r.x1 = clamp01(r.x1 + margin / FW_GLOW_CANVAS_W);
    r.y0 = clamp01(r.y0 - margin / FW_GLOW_CANVAS_H); r.y1 = clamp01(r.y1 + margin / FW_GLOW_CANVAS_H);
    *out = r;
    return (r.x0 < r.x1 && r.y0 < r.y1) ? 1 : -1;
}

typedef int (*fn_clip_kind)(void *self);
typedef float *(*fn_clip_bounds)(void *self, float *out);

void *fw_glow_unit_clip(const void *renderer) {
    if (!renderer) return NULL;
    void *clip = *(void *const *)((const char *)renderer + OFF_RND_CLIP);
    if (!clip) return NULL;
    void *const *vt = *(void *const *const *)clip;
    if (!vt || !vt[0]) return NULL;
    const int kind = ((fn_clip_kind)vt[0])(clip);
    return (kind == CONST_CLIP_KIND_A || kind == CONST_CLIP_KIND_B) ? clip : NULL;
}

void fw_glow_clip_raw_bounds(void *clip, float out[4]) {
    void *const *vt = *(void *const *const *)clip;
    ((fn_clip_bounds)vt[VT_CLIP_BOUNDS])(clip, out);
}

const float *fw_glow_clip_matrix(const void *clip) { return (const float *)((const char *)clip + OFF_CLIP_MATRIX); }

/* ----------------------------------------------------------------------- */
/* v2: our passes                                                           */
/* ----------------------------------------------------------------------- */
void *fw_glow_pass_first_material(const void *pass) {
    if (!pass || *(const uint32_t *)((const char *)pass + OFF_PASS_MAT_COUNT) == 0) return NULL;
    void *const *mats = *(void *const *const *)((const char *)pass + OFF_PASS_MATERIALS);
    return mats ? mats[0] : NULL;
}

int fw_glow_collect_passes(const void *camera, int layer, void *const *mats, int nmats, void **out, int max) {
    if (!camera || layer < 0 || !mats || nmats <= 0) return 0;
    const char *table = *(const char *const *)((const char *)camera + OFF_CAM_PASSES);
    if (!table) return 0;
    const char *vec = table + (size_t)layer * 0x18;   /* {begin, end, cap} of Pass* per layer index */
    void *const *begin = *(void *const *const *)vec, *const *end = *(void *const *const *)(vec + 8);
    int n = 0;
    for (void *const *p = begin; p && p < end && n < max; p++) {
        void *m = fw_glow_pass_first_material(*p);
        if (!m) continue;
        for (int k = 0; k < nmats; k++) if (mats[k] == m) { out[n++] = *p; break; }
    }
    return n;
}

void fw_glow_pass_set_material(void *pass, void *material) {
    if (!pass || *(const uint32_t *)((const char *)pass + OFF_PASS_MAT_COUNT) == 0) return;
    void **mats = *(void ***)((char *)pass + OFF_PASS_MATERIALS);
    if (mats) mats[0] = material;   /* {Material*, int} entries: the pointer is the first field */
}

void fw_glow_pass_set_rect(void *pass, const FwGlowRect *r) {
    if (!pass) return;
    double *b = (double *)((char *)pass + OFF_PASS_RECT_B);
    if (r) { b[0] = r->x0; b[1] = r->x1; b[2] = r->y0; b[3] = r->y1; }
    else { b[0] = 0; b[1] = 1; b[2] = 0; b[3] = 1; }
}

/* ----------------------------------------------------------------------- */
/* the data seam: FwGlow_<rrggbb[aa]> status names                          */
/* ----------------------------------------------------------------------- */
static int hex_digit(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

int fw_glow_status_prefixed(const char *bytes, size_t len) {
    return bytes && len >= FW_GLOW_STATUS_PREFIX_LEN && memcmp(bytes, FW_GLOW_STATUS_PREFIX, FW_GLOW_STATUS_PREFIX_LEN) == 0;
}

int fw_glow_parse_status_name(const char *bytes, size_t len, float rgba[4]) {
    if (!rgba || !fw_glow_status_prefixed(bytes, len)) return 0;
    size_t digits = len - FW_GLOW_STATUS_PREFIX_LEN;
    if (digits != 6 && digits != 8) return 0;
    int v[4] = { 0, 0, 0, 255 };
    for (size_t k = 0; k < digits; k += 2) {
        int hi = hex_digit(bytes[FW_GLOW_STATUS_PREFIX_LEN + k]), lo = hex_digit(bytes[FW_GLOW_STATUS_PREFIX_LEN + k + 1]);
        if (hi < 0 || lo < 0) return 0;
        v[k / 2] = hi * 16 + lo;
    }
    for (int k = 0; k < 4; k++) rgba[k] = (float)v[k] / 255.0f;
    return 1;
}

int fw_glow_set_from_status(FwGlowRegistry *r, void *character, const float rgba[4]) {
    if (!fw_glow_set(r, character, rgba)) return 0;
    r->units[fw_glow_find(r, character)].fromStatus = 1;
    return 1;
}

void fw_glow_reset_scene(FwGlowRegistry *r) {
    for (int i = 0; i < r->count;) {
        if (!r->units[i].fromStatus) remove_at(r, i);
        else i++;
    }
}

int fw_glow_sweep(FwGlowRegistry *r, FwGlowStatusProbe probe, void *user, void **cleared, int max) {
    if (!probe) return 0;
    int removed = 0;
    for (int i = 0; i < r->count;) {
        FwGlowEntry *e = &r->units[i];
        float c[4];
        if (!e->fromStatus) { i++; continue; }
        if (probe(e->character, c, user)) { memcpy(e->rgba, c, sizeof e->rgba); i++; continue; }
        if (cleared && removed < max) cleared[removed] = e->character;
        remove_at(r, i);
        removed++;
    }
    return removed;
}

int fw_glow_status_put(FwGlowStatusObjs *t, void *obj, const char *name, size_t len) {
    float c[4];
    if (!t || !obj || !fw_glow_parse_status_name(name, len, c)) return 0;
    FwGlowStatusObj *e = NULL;
    for (int i = 0; i < FW_GLOW_STATUS_OBJS; i++) if (t->e[i].obj == obj) { e = &t->e[i]; break; }
    if (!e) { e = &t->e[t->next]; t->next = (t->next + 1) % FW_GLOW_STATUS_OBJS; }
    memset(e, 0, sizeof *e);
    e->obj = obj;
    memcpy(e->name, name, len);                      /* len <= 15 < sizeof e->name: the parse guaranteed it */
    memcpy(e->rgba, c, sizeof e->rgba);
    return 1;
}

const FwGlowStatusObj *fw_glow_status_get(const FwGlowStatusObjs *t, const void *obj) {
    if (!t || !obj) return NULL;
    for (int i = 0; i < FW_GLOW_STATUS_OBJS; i++) if (t->e[i].obj == obj) return &t->e[i];
    return NULL;
}
