/* Host-side tests for the M2 sprite/mesh painter order (src/fw_mesh_order.c) and the camera's per-item filter
 * std::function built in C (src/fw_functor.c, fw_filter_*), driven by a fake Layer_Draw that does what 0x9896f0 does in
 * draw mode 0: for every (already sorted, descending-key) item, load the impl pointer at camera+OFF_CAM_LAYER_FILTER and,
 * when set, call its slot 2 with (impl, &itemPointer, &layer), drawing the item only when it returns true.
 * The draw itself is verified in-game (T2: mods/dev-sandbox/tests/mesh-occlusion.mewtest). */
#define FW_NO_WINDOWS
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdlib.h>
#include <math.h>
#include "../../test/minitest.h"
#include "fw_functor.h"
#include "fw_mesh_order.h"
#include "offsets.h"

/* the 0x20-byte layer item {renderable*, Position*, double key, u32 flags} */
typedef struct FakeItem { void *rnd; void *pos; double key; uint32_t flags; uint32_t pad; } FakeItem;

TEST(item_layout_matches_the_manifest) {
    CHECK_EQ(sizeof(FakeItem), 1 << CONST_LAYER_ITEM_SHIFT);
    CHECK_EQ(offsetof(FakeItem, key), OFF_ITEM_KEY);
    FakeItem it = { (void *)0x1234, NULL, 8.25, 0, 0 };
    CHECK(fw_mesh_order_item_renderable(&it) == (void *)0x1234);
    CHECK(fw_mesh_order_item_key(&it) == 8.25);
    CHECK(fw_mesh_order_item_renderable(NULL) == NULL);
}

TEST(keys_tile_and_unit) {
    /* a tile object on (2,6): origin (2.5, 6.5) -> 9 = col + row + 1, the key of a unit standing there */
    CHECK(fabs(fw_mesh_order_tile_key(2.5, 6.5) - 9.0) < 1e-12);
    CHECK(fabs(fw_mesh_order_tile_key(2.5, 4.5) - 7.0) < 1e-12);
    double u = fw_mesh_order_unit_key(2.5, 5.5);
    CHECK(u < 8.0 && u > 8.0 - 1e-4);
}

static int plan_all(FwMeshOrder *o, const double *keys, void *const *rnds, int nitems, int got[][8], int *gotn) {
    int out[FW_MESH_ORDER_MAX];
    for (int i = 0; i < nitems; i++) {
        int n = fw_mesh_order_before_item(o, i, keys[i], rnds ? rnds[i] : NULL, out, FW_MESH_ORDER_MAX);
        gotn[i] = n;
        for (int k = 0; k < n && k < 8; k++) got[i][k] = out[k];
    }
    return fw_mesh_order_rest(o, out, FW_MESH_ORDER_MAX);
}

TEST(plan_puts_each_mesh_before_the_first_item_not_farther) {
    FwMeshOrder o;
    fw_mesh_order_reset(&o);
    /* items in draw order (descending keys): a wall at 10, a cat on (2,6) at 9, a crate at 8.5, the cat R on (2,5) at 8,
     * a cat at 7, a far-front tile half at 3 */
    static int R;
    const double keys[] = { 10, 9, 8.5, 8, 7, 3 };
    void *const rnds[] = { NULL, NULL, NULL, &R, NULL, NULL };
    CHECK_EQ(fw_mesh_order_add(&o, fw_mesh_order_tile_key(2.5, 6.5), NULL, 0), 0);   /* key 9: behind R */
    CHECK_EQ(fw_mesh_order_add(&o, fw_mesh_order_tile_key(2.5, 4.5), NULL, 1), 1);   /* key 7 */
    CHECK_EQ(fw_mesh_order_add(&o, fw_mesh_order_unit_key(2.5, 5.5), &R, 2), 2);     /* on R */
    int got[6][8] = { { 0 } }, gotn[6] = { 0 };
    int rest = plan_all(&o, keys, rnds, 6, got, gotn);
    CHECK_EQ(gotn[0], 0);
    CHECK_EQ(gotn[1], 0);                         /* a tie (9 vs 9) goes after the item: the mesh wins ties */
    CHECK_EQ(gotn[2], 1); CHECK_EQ(got[2][0], 0); /* before the crate at 8.5 */
    CHECK_EQ(gotn[3], 0);                         /* R itself: the attached mesh is armed, not drawn yet */
    CHECK_EQ(gotn[4], 1); CHECK_EQ(got[4][0], 2); /* right after R; key-7 tile mesh ties the cat at 7 -> after it */
    CHECK_EQ(gotn[5], 1); CHECK_EQ(got[5][0], 1);
    CHECK_EQ(rest, 0);
    CHECK_EQ(o.items, 6);
    CHECK_EQ(o.unsorted, 0);
    CHECK_EQ(o.groups, 3);
    CHECK_EQ(o.e[0].item, 2); CHECK(o.e[0].itemKey == 8.5);
    CHECK_EQ(o.e[2].item, 4);
    CHECK_EQ(o.e[0].state, FW_MESH_ORDER_DONE);
}

TEST(plan_rest_and_front_and_grouping) {
    FwMeshOrder o;
    fw_mesh_order_reset(&o);
    const double keys[] = { 6, 5 };
    fw_mesh_order_add(&o, 2.0, NULL, 10);    /* nearer than every item: after the layer */
    fw_mesh_order_add(&o, 20.0, NULL, 11);   /* farther than every item: before item 0 */
    fw_mesh_order_add(&o, 21.0, NULL, 12);   /* same insertion point, farther: first in the group */
    fw_mesh_order_add(&o, 1.0, NULL, 13);
    int got[2][8] = { { 0 } }, gotn[2] = { 0 }, out[FW_MESH_ORDER_MAX];
    for (int i = 0; i < 2; i++) { gotn[i] = fw_mesh_order_before_item(&o, i, keys[i], NULL, out, FW_MESH_ORDER_MAX); for (int k = 0; k < gotn[i]; k++) got[i][k] = out[k]; }
    CHECK_EQ(gotn[0], 2); CHECK_EQ(got[0][0], 12); CHECK_EQ(got[0][1], 11);
    CHECK_EQ(gotn[1], 0);
    int n = fw_mesh_order_rest(&o, out, FW_MESH_ORDER_MAX);
    CHECK_EQ(n, 2); CHECK_EQ(out[0], 10); CHECK_EQ(out[1], 13);
    CHECK_EQ(o.e[0].item, -1);
    CHECK_EQ(o.groups, 2);
    CHECK_EQ(fw_mesh_order_rest(&o, out, FW_MESH_ORDER_MAX), 0);   /* nothing twice */
}

TEST(plan_unanchored_unit_falls_back_to_its_key_and_counts_unsorted) {
    FwMeshOrder o;
    fw_mesh_order_reset(&o);
    static int R, other;
    fw_mesh_order_add(&o, 8.0 - FW_MESH_ORDER_EPS, &R, 0);   /* R never shows up in the layer */
    int out[FW_MESH_ORDER_MAX];
    CHECK_EQ(fw_mesh_order_before_item(&o, 0, 9, &other, out, FW_MESH_ORDER_MAX), 0);
    CHECK_EQ(fw_mesh_order_before_item(&o, 1, 7.5, &other, out, FW_MESH_ORDER_MAX), 1);
    CHECK_EQ(fw_mesh_order_before_item(&o, 2, 7.9, &other, out, FW_MESH_ORDER_MAX), 0);   /* ascending: counted */
    CHECK_EQ(o.unsorted, 1);
}

TEST(plan_capacity) {
    FwMeshOrder o;
    fw_mesh_order_reset(&o);
    for (int i = 0; i < FW_MESH_ORDER_MAX; i++) CHECK_EQ(fw_mesh_order_add(&o, i, NULL, i), i);
    CHECK_EQ(fw_mesh_order_add(&o, 1, NULL, 99), -1);
    int out[4];
    CHECK_EQ(fw_mesh_order_before_item(&o, 0, -1, NULL, out, 4), 4);   /* bounded by cap; the rest stay pending */
    int big[FW_MESH_ORDER_MAX];
    CHECK_EQ(fw_mesh_order_rest(&o, big, FW_MESH_ORDER_MAX), FW_MESH_ORDER_MAX - 4);
}

TEST(interleave_only_a_sorted_forward_layer) {
    unsigned char layer[CONST_LAYER_STRIDE];
    memset(layer, 0, sizeof layer);
    layer[OFF_LAYER_SORTED] = 1;
    CHECK_EQ(fw_mesh_order_interleave(layer), 1);
    *(int32_t *)(layer + OFF_LAYER_MODE) = 1;           /* reverse order: no */
    CHECK_EQ(fw_mesh_order_interleave(layer), 0);
    *(int32_t *)(layer + OFF_LAYER_MODE) = 0;
    layer[OFF_LAYER_SORTED] = 0;                          /* unsorted: no */
    CHECK_EQ(fw_mesh_order_interleave(layer), 0);
    CHECK_EQ(fw_mesh_order_interleave(NULL), 0);
}

TEST(camera_filter_slot) {
    unsigned char cam[0x200];
    memset(cam, 0, sizeof cam);
    CHECK(fw_mesh_order_cam_filter(cam) == NULL);
    int x;
    fw_mesh_order_set_cam_filter(cam, &x);
    CHECK(*(void **)(cam + OFF_CAM_LAYER_FILTER) == (void *)&x);
    CHECK(fw_mesh_order_cam_filter(cam) == (void *)&x);
    CHECK(fw_mesh_order_cam_filter(NULL) == NULL);
}

/* ---- the filter std::function against a fake Layer_Draw ---- */
static void fake_layer_draw(unsigned char *cam, FakeItem *items, int n, int layer, int *drawn, int *ndrawn) {
    for (int i = 0; i < n; i++) {
        void *impl = *(void **)(cam + OFF_CAM_LAYER_FILTER);
        void *ip = &items[i];
        int l = layer;
        int ok = 1;
        if (impl) ok = ((FwFuncFilterCallFn)(*(const void *const *const *)impl)[FW_FUNC_SLOT_DOCALL])(impl, &ip, &l) != 0;
        if (ok) drawn[(*ndrawn)++] = i;
    }
}

static int g_seenLayer; static void *g_seenItem;
static int accept_all(void *user, void **itemRef, int *layerRef) { (void)user; g_seenItem = *itemRef; g_seenLayer = *layerRef; return 1; }
static int reject_odd_flags(void *user, void **itemRef, int *layerRef) { (void)user; (void)layerRef; return !(((FakeItem *)*itemRef)->flags & 1); }

TEST(filter_impl_layout_and_call) {
    FwFilterImpl f;
    int token;
    fw_filter_make(&f, accept_all, &token);
    const void *const *vt = fw_filter_vtable();
    CHECK(vt != NULL);
    if (!vt) return;
    for (int i = 0; i < FW_FUNC_SLOTS; i++) CHECK(vt[i] != NULL);
    CHECK(f.vtbl == vt);
    CHECK(f.fn == accept_all);
    CHECK(f.user == &token);
    unsigned char cam[0x200];
    memset(cam, 0, sizeof cam);
    FakeItem items[3] = { { NULL, NULL, 3, 0, 0 }, { NULL, NULL, 2, 0, 0 }, { NULL, NULL, 1, 0, 0 } };
    fw_mesh_order_set_cam_filter(cam, &f);
    int drawn[8], nd = 0;
    fake_layer_draw(cam, items, 3, CONST_UNITS_LAYER, drawn, &nd);
    CHECK_EQ(nd, 3);
    CHECK(g_seenItem == (void *)&items[2]);
    CHECK_EQ(g_seenLayer, CONST_UNITS_LAYER);
    CHECK_EQ(fw_filter_call(NULL, NULL, NULL), 1);   /* no impl: draw */
}

typedef struct SubmitLog { int events[64]; int n; } SubmitLog;   /* >= 0 an item drawn, -(100 + draw) a mesh submitted, -1 a group boundary */
static SubmitLog *g_log;
static void log_submit(void *ctx, const int *draws, int n) {
    SubmitLog *l = ctx;
    l->events[l->n++] = -1;
    for (int i = 0; i < n; i++) l->events[l->n++] = -(100 + draws[i]);
}

TEST(filter_interleaves_submits_and_chains_the_previous_filter) {
    unsigned char cam[0x200];
    memset(cam, 0, sizeof cam);
    static int R;
    FakeItem items[4] = { { NULL, NULL, 10, 0, 0 }, { &R, NULL, 8, 1, 0 }, { NULL, NULL, 7, 0, 0 }, { NULL, NULL, 3, 0, 0 } };
    FwMeshOrder o;
    fw_mesh_order_reset(&o);
    fw_mesh_order_add(&o, 9, NULL, 0);          /* behind R: before item 1 */
    fw_mesh_order_add(&o, 8 - FW_MESH_ORDER_EPS, &R, 1);   /* attached to R: before item 2 */
    fw_mesh_order_add(&o, 1, NULL, 2);          /* in front of everything: after the layer */
    SubmitLog log = { { 0 }, 0 };
    g_log = &log;
    FwFilterImpl prev;
    fw_filter_make(&prev, reject_odd_flags, NULL);   /* a filter the camera already had */
    FwMeshOrderFilter st = { &o, CONST_UNITS_LAYER, log_submit, &log, &prev, 0 };
    FwFilterImpl ours;
    fw_filter_make(&ours, fw_mesh_order_filter, &st);
    fw_mesh_order_set_cam_filter(cam, &ours);
    int drawn[8], nd = 0;
    fake_layer_draw(cam, items, 4, CONST_UNITS_LAYER, drawn, &nd);
    CHECK_EQ(nd, 3);                              /* the chained filter still rejected item 1 (odd flags) */
    CHECK_EQ(drawn[0], 0); CHECK_EQ(drawn[1], 2); CHECK_EQ(drawn[2], 3);
    CHECK_EQ(st.index, 4);
    CHECK_EQ(log.n, 4);
    CHECK_EQ(log.events[0], -1); CHECK_EQ(log.events[1], -100);
    CHECK_EQ(log.events[2], -1); CHECK_EQ(log.events[3], -101);
    CHECK_EQ(o.e[0].item, 1); CHECK_EQ(o.e[1].item, 2);
    CHECK_EQ(fw_mesh_order_finish(&st), 1);
    CHECK_EQ(log.events[5], -102);
    CHECK_EQ(fw_mesh_order_finish(&st), 0);
    /* another layer's items only chain (no plan step) */
    FwMeshOrder o2;
    fw_mesh_order_reset(&o2);
    fw_mesh_order_add(&o2, 100, NULL, 0);
    FwMeshOrderFilter st2 = { &o2, CONST_UNITS_LAYER, log_submit, &log, NULL, 0 };
    fw_filter_make(&ours, fw_mesh_order_filter, &st2);
    nd = 0;
    fake_layer_draw(cam, items, 4, CONST_UNITS_LAYER - 1, drawn, &nd);
    CHECK_EQ(nd, 4);
    CHECK_EQ(st2.index, 0);
    CHECK_EQ(o2.e[0].state, FW_MESH_ORDER_PENDING);
}

TEST(log_lines) {
    FwMeshOrder o;
    fw_mesh_order_reset(&o);
    fw_mesh_order_add(&o, 9, NULL, 0);
    fw_mesh_order_add(&o, 1, NULL, 1);
    int out[8];
    fw_mesh_order_before_item(&o, 0, 10, NULL, out, 8);
    fw_mesh_order_before_item(&o, 1, 8, NULL, out, 8);
    fw_mesh_order_rest(&o, out, 8);
    char buf[512];
    fw_mesh_order_fmt(buf, sizeof buf, 61, &o);
    CHECK_STR(buf, "mesh order f=61 items=2 meshes=2 groups=2 unsorted=0 | d0 key=9.000 before item 1 key=8.000 | d1 key=1.000 after the layer");
    fw_mesh_order_fmt_keys(buf, sizeof buf, 61, &o);
    CHECK_STR(buf, "mesh order keys f=61 10.000 8.000");
    const double xz[2] = { 2.5, 5.5 };
    fw_mesh_order_fmt_item(buf, sizeof buf, 61, 3, 8.0, xz);
    CHECK_STR(buf, "mesh order item f=61 i=3 key=8.000 at=(2.50 5.50)");
    char small[16];
    int n = fw_mesh_order_fmt(small, sizeof small, 1, &o);
    CHECK(n < (int)sizeof small && small[sizeof small - 1] == 0 && strlen(small) == sizeof small - 1);
}

TEST(hull_of_the_probe_cube) {
    float m[16] = { 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 };
    const float lo[3] = { -0.5f, 0.0f, -0.5f }, hi[3] = { 0.5f, 1.0f, 0.5f };
    double box[4] = { 0 }, area = 0;
    CHECK_EQ(fw_mesh_order_hull(m, lo, hi, box, &area), 1);
    CHECK(fabs(box[0] + 0.5) < 1e-9 && fabs(box[1]) < 1e-9 && fabs(box[2] - 0.5) < 1e-9 && fabs(box[3] - 1) < 1e-9);
    CHECK(fabs(area - 1) < 1e-9);                 /* the front face: z is dropped */
    m[8] = 1;                                     /* x_ndc = x + z: a hexagon-free parallelogram of width 2 */
    CHECK_EQ(fw_mesh_order_hull(m, lo, hi, box, &area), 1);
    CHECK(fabs(area - 2) < 1e-6);
    CHECK(fabs(box[0] + 1) < 1e-6 && fabs(box[2] - 1) < 1e-6);
    m[9] = 0.5f;                                  /* y_ndc = y + z/2: a hexagon (the iso view of a box) */
    CHECK_EQ(fw_mesh_order_hull(m, lo, hi, box, &area), 1);
    CHECK(fabs(area - 2.5) < 1e-6);               /* 2x1 parallelogram + the two sheared caps (2 x 0.25 each, half) */
    float z[16] = { 0 };
    CHECK_EQ(fw_mesh_order_hull(z, lo, hi, box, &area), 0);
    char buf[200];
    const double b[4] = { -0.5, -0.25, 0.125, 0.5 };
    fw_mesh_order_fmt_occ(buf, sizeof buf, 121, 2, 6, 9.0, b, 0.03125);
    CHECK_STR(buf, "mesh occ f=121 tile=(2,6) key=9.000 hull=(-0.5000 -0.2500 0.1250 0.5000) area=0.031250");
}

int main(void) { return MT_RUN_ALL(); }
