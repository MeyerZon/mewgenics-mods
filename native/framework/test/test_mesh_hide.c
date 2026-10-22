/* Host-side tests for `hide_sprite` (3D phase M3, src/fw_mesh_hide.c): the decision, the per-frame set, and the filter
 * that wraps the M2 order filter, driven by the same fake Layer_Draw as test_mesh_order.c (draw mode 0: for every item,
 * load the impl at camera+OFF_CAM_LAYER_FILTER and draw the item only when its slot 2 returns true); plus the registry
 * field (fw_obj3d_set_hide). The in-game proof is T2: mods/_unitmodel/tests/unit-model-hide.mewtest. */
#define FW_NO_WINDOWS
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include "../../test/minitest.h"
#include "fw_functor.h"
#include "fw_mesh_order.h"
#include "fw_mesh_hide.h"
#include "fw_obj3d_rules.h"
#include "offsets.h"

typedef struct FakeItem { void *rnd; void *pos; double key; uint32_t flags; uint32_t pad; } FakeItem;

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

TEST(wanted_only_for_a_drawn_unit_model_with_hide_sprite_true) {
    static int R;
    CHECK_EQ(fw_mesh_hide_wanted(1, 0, &R, 1), 1);
    CHECK_EQ(fw_mesh_hide_wanted(0, 0, &R, 1), 0);    /* hide_sprite false */
    CHECK_EQ(fw_mesh_hide_wanted(-1, 0, &R, 1), 0);   /* not given / a bad value */
    CHECK_EQ(fw_mesh_hide_wanted(2, 0, &R, 1), 0);    /* only exactly 1 */
    CHECK_EQ(fw_mesh_hide_wanted(1, 1, &R, 1), 0);    /* a tile object has no sprite */
    CHECK_EQ(fw_mesh_hide_wanted(1, 0, NULL, 1), 0);  /* renderer unknown */
    CHECK_EQ(fw_mesh_hide_wanted(1, 0, &R, 0), 0);    /* the model failed to load / was not placed: the sprite is the fallback */
}

TEST(set_add_has_reset_dedupe_and_bound) {
    FwMeshHide h;
    memset(&h, 0x5a, sizeof h);
    fw_mesh_hide_reset(&h);
    CHECK_EQ(h.n, 0); CHECK_EQ(h.seen, 0); CHECK_EQ(h.skipped, 0);
    static int a, b;
    CHECK_EQ(fw_mesh_hide_has(&h, &a), 0);
    CHECK_EQ(fw_mesh_hide_add(&h, &a), 1);
    CHECK_EQ(fw_mesh_hide_add(&h, &a), 1);
    CHECK_EQ(h.n, 1);
    CHECK_EQ(fw_mesh_hide_has(&h, &a), 1);
    CHECK_EQ(fw_mesh_hide_has(&h, &b), 0);
    CHECK_EQ(fw_mesh_hide_has(&h, NULL), 0);
    CHECK_EQ(fw_mesh_hide_add(&h, NULL), 0);
    CHECK_EQ(fw_mesh_hide_add(NULL, &a), 0);
    CHECK_EQ(fw_mesh_hide_has(NULL, &a), 0);
    static char many[FW_MESH_HIDE_MAX + 1];
    fw_mesh_hide_reset(&h);
    for (int i = 0; i < FW_MESH_HIDE_MAX; i++) CHECK_EQ(fw_mesh_hide_add(&h, &many[i]), 1);
    CHECK_EQ(fw_mesh_hide_add(&h, &many[FW_MESH_HIDE_MAX]), 0);   /* full: that unit keeps its sprite */
    CHECK_EQ(h.n, FW_MESH_HIDE_MAX);
    fw_mesh_hide_reset(&h);
    CHECK_EQ(fw_mesh_hide_has(&h, &a), 0);
}

typedef struct SubmitLog { int events[64]; int n; } SubmitLog;   /* -1 a group, -(100 + draw) a mesh */
static void log_submit(void *ctx, const int *draws, int n) {
    SubmitLog *l = ctx;
    l->events[l->n++] = -1;
    for (int i = 0; i < n; i++) l->events[l->n++] = -(100 + draws[i]);
}

TEST(filter_skips_the_hidden_units_item_and_the_mesh_still_takes_its_place) {
    unsigned char cam[0x200];
    memset(cam, 0, sizeof cam);
    static int U0, RAT, U2;
    /* units layer, descending keys: U0 (10), the Rat (8) with a unit-attached mesh, U2 (3) */
    FakeItem items[3] = { { &U0, NULL, 10, 0, 0 }, { &RAT, NULL, 8, 0, 0 }, { &U2, NULL, 3, 0, 0 } };
    FwMeshOrder o;
    fw_mesh_order_reset(&o);
    fw_mesh_order_add(&o, fw_mesh_order_unit_key(2.5, 5.5), &RAT, 0);   /* the Rat's model: right after the Rat's item */
    SubmitLog log;
    memset(&log, 0, sizeof log);
    FwMeshOrderFilter st = { &o, CONST_UNITS_LAYER, log_submit, &log, NULL, 0 };
    FwMeshHide h;
    fw_mesh_hide_reset(&h);
    fw_mesh_hide_add(&h, &RAT);
    FwMeshHideFilter hf = { &h, CONST_UNITS_LAYER, fw_mesh_order_filter, &st, NULL };
    FwFilterImpl impl;
    fw_filter_make(&impl, fw_mesh_hide_filter, &hf);
    *(void **)(cam + OFF_CAM_LAYER_FILTER) = &impl;
    int drawn[8], nd = 0;
    fake_layer_draw(cam, items, 3, CONST_UNITS_LAYER, drawn, &nd);
    CHECK_EQ(nd, 2);                                  /* the Rat's sprite item is skipped */
    CHECK_EQ(drawn[0], 0); CHECK_EQ(drawn[1], 2);
    CHECK_EQ(h.seen, 3); CHECK_EQ(h.skipped, 1);
    CHECK_EQ(st.index, 3);                            /* the order filter still saw every item */
    CHECK_EQ(log.n, 2);                               /* the mesh went right before U2, i.e. where the Rat was */
    CHECK_EQ(log.events[0], -1); CHECK_EQ(log.events[1], -100);
    CHECK_EQ(o.e[0].item, 2);
    /* the same renderable on another layer (the mask layer, the shadow layer) is not touched */
    nd = 0;
    fake_layer_draw(cam, items, 3, CONST_UNITS_LAYER + 1, drawn, &nd);
    CHECK_EQ(nd, 3);
    CHECK_EQ(h.skipped, 1);
}

static int reject_first(void *user, void **itemRef, int *layerRef) { (void)layerRef; return *itemRef != user; }

TEST(filter_without_inner_chains_the_previous_impl_and_an_empty_set_hides_nothing) {
    unsigned char cam[0x200];
    memset(cam, 0, sizeof cam);
    static int A, B;
    FakeItem items[2] = { { &A, NULL, 5, 0, 0 }, { &B, NULL, 4, 0, 0 } };
    FwFilterImpl prev;
    fw_filter_make(&prev, reject_first, &items[0]);   /* a previous filter that rejects item 0 */
    FwMeshHide h;
    fw_mesh_hide_reset(&h);
    FwMeshHideFilter hf = { &h, CONST_UNITS_LAYER, NULL, NULL, &prev };
    FwFilterImpl impl;
    fw_filter_make(&impl, fw_mesh_hide_filter, &hf);
    *(void **)(cam + OFF_CAM_LAYER_FILTER) = &impl;
    int drawn[4], nd = 0;
    fake_layer_draw(cam, items, 2, CONST_UNITS_LAYER, drawn, &nd);
    CHECK_EQ(nd, 1); CHECK_EQ(drawn[0], 1);           /* the previous filter's verdict stands */
    CHECK_EQ(h.skipped, 0);
    fw_mesh_hide_add(&h, &B);
    nd = 0;
    fake_layer_draw(cam, items, 2, CONST_UNITS_LAYER, drawn, &nd);
    CHECK_EQ(nd, 0);
    CHECK_EQ(h.skipped, 1);                           /* item 0 was rejected by prev, not counted as ours */
    /* NULL safety: no set, no item */
    FwMeshHideFilter none = { NULL, CONST_UNITS_LAYER, NULL, NULL, NULL };
    void *ip = &items[1];
    int l = CONST_UNITS_LAYER;
    CHECK_EQ(fw_mesh_hide_filter(&none, &ip, &l), 1);
    CHECK_EQ(fw_mesh_hide_filter(&hf, NULL, &l), 1);
    CHECK_EQ(fw_mesh_hide_filter(NULL, &ip, &l), 1);
}

TEST(fmt_line) {
    FwMeshHide h;
    fw_mesh_hide_reset(&h);
    static int a;
    fw_mesh_hide_add(&h, &a);
    h.seen = 10; h.skipped = 1;
    char buf[128];
    CHECK_EQ(fw_mesh_hide_fmt(buf, sizeof buf, 61, &h), (int)strlen("mesh hide f=61 units=1 items=10 skipped=1"));
    CHECK_STR(buf, "mesh hide f=61 units=1 items=10 skipped=1");
    char tiny[8];
    fw_mesh_hide_fmt(tiny, sizeof tiny, 61, &h);
    CHECK_EQ((int)strlen(tiny), 7);
    CHECK_EQ(fw_mesh_hide_fmt(NULL, 0, 1, &h), 0);
}

TEST(registry_hide_flag_defaults_off_and_is_set_by_handle) {
    static Fw3dRegistry r;
    fw_obj3d_init(&r);
    static unsigned char ch[0x400];
    int h = fw_obj3d_add_character(&r, ch + 0x100, "models/box.obj", NULL);
    int t = fw_obj3d_add_tile(&r, 1, 2, "models/box.obj", NULL);
    CHECK(h > 0 && t > 0);
    CHECK_EQ(fw_obj3d_at(&r, 0)->hideSprite, 0);      /* API objects: drawn as before */
    CHECK_EQ(fw_obj3d_set_hide(&r, h, 1), 1);
    CHECK_EQ(fw_obj3d_at(&r, 0)->hideSprite, 1);
    CHECK_EQ(fw_obj3d_set_hide(&r, h, -1), 1);        /* not given */
    CHECK_EQ(fw_obj3d_at(&r, 0)->hideSprite, 0);
    CHECK_EQ(fw_obj3d_set_hide(&r, h, 2), 1);         /* only exactly 1 hides */
    CHECK_EQ(fw_obj3d_at(&r, 0)->hideSprite, 0);
    CHECK_EQ(fw_obj3d_set_hide(&r, h, 1), 1);
    CHECK_EQ(fw_obj3d_add_character(&r, ch + 0x100, "models/other.obj", NULL), h);   /* re-registered: kept */
    CHECK_EQ(fw_obj3d_at(&r, 0)->hideSprite, 1);
    CHECK_EQ(fw_obj3d_set_hide(&r, 9999, 1), 0);
    CHECK_EQ(fw_obj3d_at(&r, 1)->hideSprite, 0);
}

int main(void) { return MT_RUN_ALL(); }
