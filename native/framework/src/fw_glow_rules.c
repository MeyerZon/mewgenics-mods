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
/* v2 (red: stubs, the host suite pins the behaviour)                       */
/* ----------------------------------------------------------------------- */
void fw_glow_groups(const FwGlowRegistry *r, FwGlowGroups *out) { (void)r; out->count = 0; }
int fw_glow_group_of(const FwGlowGroups *g, int unit) { (void)g; (void)unit; return -1; }
int fw_glow_plan(const FwGlowRegistry *r, const FwGlowGroups *g, FwGlowDraw out[FW_GLOW_MAX_UNITS]) { (void)r; (void)g; (void)out; return 0; }
const char *fw_glow_material_name(int slot, char *buf, size_t cap) { (void)slot; (void)buf; (void)cap; return NULL; }
void fw_glow_clip_bounds(float b[4], const float m[6]) { (void)b; (void)m; }
void fw_glow_matrix_bounds(float b[4], const float M[16]) { (void)b; (void)M; }
int fw_glow_mat4_inverse(const float m[16], float out[16]) { (void)m; (void)out; return 0; }
void fw_glow_view_rect(const float b[4], const float C[16], double zoom, int zoomY, FwGlowRect *out) { (void)b; (void)C; (void)zoom; (void)zoomY; memset(out, 0, sizeof *out); }
int fw_glow_unit_rect(const float rawBounds[4], const float clipM[6], const float screenM[16], const float viewM[16], double zoom, int zoomY, double margin, FwGlowRect *out) {
    (void)rawBounds; (void)clipM; (void)screenM; (void)viewM; (void)zoom; (void)zoomY; (void)margin; memset(out, 0, sizeof *out); return 0;
}
void *fw_glow_unit_clip(const void *renderer) { (void)renderer; return NULL; }
void fw_glow_clip_raw_bounds(void *clip, float out[4]) { (void)clip; (void)out; }
const float *fw_glow_clip_matrix(const void *clip) { (void)clip; return NULL; }
int fw_glow_collect_passes(const void *camera, int layer, void *const *mats, int nmats, void **out, int max) { (void)camera; (void)layer; (void)mats; (void)nmats; (void)out; (void)max; return 0; }
void *fw_glow_pass_first_material(const void *pass) { (void)pass; return NULL; }
void fw_glow_pass_set_material(void *pass, void *material) { (void)pass; (void)material; }
void fw_glow_pass_set_rect(void *pass, const FwGlowRect *r) { (void)pass; (void)r; }
