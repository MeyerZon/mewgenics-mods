/* Host-side tests for the M3 per-band mesh slices (src/fw_mesh_slice.c) and their place in the painter order
 * (src/fw_mesh_order.c): multi-tile meshes cut per sort band (item 6) and the mesh/unit tie on one tile (item 7).
 * The draw itself is verified in-game (T2: mods/dev-sandbox/tests/mesh-slices.mewtest). */
#define FW_NO_WINDOWS
#include <math.h>
#include <string.h>
#include "../../test/minitest.h"
#include "fw_mesh_slice.h"
#include "fw_mesh_order.h"

#define NEAR(a, b) (fabs((double)(a) - (double)(b)) < 1e-5)

static void ident(float m[16]) { memset(m, 0, 16 * sizeof *m); m[0] = m[5] = m[10] = m[15] = 1.0f; }

TEST(depth_range_of_a_box) {
    float w[16];
    ident(w);
    w[12] = 2.5f; w[14] = 6.5f;                                  /* the probe cube's tile (2,6) */
    const float lo[3] = { -0.4f, 0.0f, -0.4f }, hi[3] = { 0.4f, 0.8f, 0.4f };
    double r[2] = { 0, 0 };
    CHECK_EQ(fw_mesh_slice_depth(w, lo, hi, r), 1);
    CHECK(NEAR(r[0], 8.2) && NEAR(r[1], 9.8));
    /* the 2x1 slab anchored on (0,6): local x -0.45..1.45 */
    const float slo[3] = { -0.45f, 0.0f, -0.45f }, shi[3] = { 1.45f, 0.5f, 0.45f };
    w[12] = 0.5f; w[14] = 6.5f;
    CHECK_EQ(fw_mesh_slice_depth(w, slo, shi, r), 1);
    CHECK(NEAR(r[0], 6.1) && NEAR(r[1], 8.9));
    /* the facing mirror (x <-> z swap) keeps x + z: same range */
    float m[16];
    ident(m);
    m[0] = 0; m[2] = 1; m[8] = 1; m[10] = 0; m[12] = 0.5f; m[14] = 6.5f;
    CHECK_EQ(fw_mesh_slice_depth(m, slo, shi, r), 1);
    CHECK(NEAR(r[0], 6.1) && NEAR(r[1], 8.9));
    /* a scale and a lift: y does not move x + z */
    w[0] = w[10] = 2.0f; w[13] = 5.0f;
    CHECK_EQ(fw_mesh_slice_depth(w, lo, hi, r), 1);
    CHECK(NEAR(r[0], 7.0 - 1.6) && NEAR(r[1], 7.0 + 1.6));
    CHECK_EQ(fw_mesh_slice_depth(NULL, lo, hi, r), 0);
    CHECK_EQ(fw_mesh_slice_depth(w, lo, hi, NULL), 0);
}

TEST(plan_one_slice_per_band_keyed_by_its_middle) {
    FwMeshSlice s[FW_MESH_SLICE_MAX];
    /* the 0.8 cube centred on (2,6): its front half [8,9) and its back half [9,10) */
    CHECK_EQ(fw_mesh_slice_plan(8.2, 9.8, FW_MESH_SLICE_MAX, s), 2);
    CHECK(s[0].lo == 8 && s[0].hi == 9 && s[0].key == 8.5);
    CHECK(s[1].lo == 9 && s[1].hi == 10 && s[1].key == 9.5);
    CHECK(s[0].clip[0] == -FW_MESH_CLIP_OPEN && s[0].clip[1] == 9.0f);   /* the front slice is open towards the front */
    CHECK(s[1].clip[0] == 9.0f && s[1].clip[1] == FW_MESH_CLIP_OPEN);    /* the back slice towards the back */
    /* the 2x1 slab on (0,6)+(1,6): three bands */
    CHECK_EQ(fw_mesh_slice_plan(6.1, 8.9, FW_MESH_SLICE_MAX, s), 3);
    CHECK(s[0].key == 6.5 && s[1].key == 7.5 && s[2].key == 8.5);
    CHECK(s[1].clip[0] == 7.0f && s[1].clip[1] == 8.0f);
    /* a 3x3 centred on (3,3): depth 4.1 .. 9.9 -> six bands */
    CHECK_EQ(fw_mesh_slice_plan(4.1, 9.9, FW_MESH_SLICE_MAX, s), 6);
    CHECK(s[0].key == 4.5 && s[5].key == 9.5);
    /* a post on the back half of (2,6): one band, unclipped, keyed 9.5 (behind the feet of a unit there: under it) */
    CHECK_EQ(fw_mesh_slice_plan(9.1, 9.9, FW_MESH_SLICE_MAX, s), 1);
    CHECK(s[0].lo == 9 && s[0].hi == 10 && s[0].key == 9.5);
    CHECK(s[0].clip[0] == -FW_MESH_CLIP_OPEN && s[0].clip[1] == FW_MESH_CLIP_OPEN);
    /* edges exactly on a band edge (and float noise around it) add no empty band */
    CHECK_EQ(fw_mesh_slice_plan(7.0, 9.0, FW_MESH_SLICE_MAX, s), 2);
    CHECK(s[0].lo == 7 && s[1].hi == 9);
    CHECK_EQ(fw_mesh_slice_plan(7.0000001, 8.9999999, FW_MESH_SLICE_MAX, s), 2);
    CHECK_EQ(fw_mesh_slice_plan(9.0, 9.0, FW_MESH_SLICE_MAX, s), 1);    /* flat on an edge: the band behind it */
    CHECK(s[0].lo == 9 && s[0].key == 9.5);
}

TEST(plan_merges_bands_beyond_the_cap_and_refuses_bad_input) {
    FwMeshSlice s[FW_MESH_SLICE_MAX + 4];
    CHECK_EQ(fw_mesh_slice_plan(0.5, 20.5, FW_MESH_SLICE_MAX, s), 7);   /* 21 bands, width 3 */
    CHECK(s[0].lo == 0 && s[0].hi == 3 && s[0].key == 1.5);
    CHECK(s[6].lo == 18 && s[6].hi == 21 && s[6].key == 19.5);
    CHECK(s[6].clip[1] == FW_MESH_CLIP_OPEN && s[0].clip[0] == -FW_MESH_CLIP_OPEN);
    CHECK_EQ(fw_mesh_slice_plan(0.5, 20.5, 100, s), 7);                 /* max is capped at FW_MESH_SLICE_MAX */
    CHECK_EQ(fw_mesh_slice_plan(0.5, 2.5, 1, s), 1);                    /* max 1: one slice, unclipped */
    CHECK(s[0].clip[0] == -FW_MESH_CLIP_OPEN && s[0].clip[1] == FW_MESH_CLIP_OPEN && s[0].key == 1.5);
    CHECK_EQ(fw_mesh_slice_plan(3.0, 2.0, FW_MESH_SLICE_MAX, s), 0);    /* back before front */
    CHECK_EQ(fw_mesh_slice_plan(NAN, 2.0, FW_MESH_SLICE_MAX, s), 0);
    CHECK_EQ(fw_mesh_slice_plan(0.0, 1e12, FW_MESH_SLICE_MAX, s), 0);   /* absurd: refused, not looped */
    CHECK_EQ(fw_mesh_slice_plan(1.0, 2.0, 0, s), 0);
    CHECK_EQ(fw_mesh_slice_plan(1.0, 2.0, 4, NULL), 0);
}

/* an iso-like projection: ndc x = x - z, ndc y = (x + z) / 2 + y (column-major) */
static void iso(float m[16]) { ident(m); m[8] = -1.0f; m[1] = 0.5f; m[9] = 0.5f; }

TEST(visible_area_of_a_slice) {
    float p[16], w[16];
    iso(p); ident(w);
    const float lo[3] = { 0, 0, 0 }, hi[3] = { 1, 1, 1 };
    double box[4] = { 0 }, a = 0;
    /* the whole cube: the top + the two front faces (x = 0, z = 0), 1 each */
    CHECK_EQ(fw_mesh_slice_visible(p, w, lo, hi, -FW_MESH_CLIP_OPEN, FW_MESH_CLIP_OPEN, box, &a), 1);
    CHECK(NEAR(a, 3.0));
    CHECK(NEAR(box[0], -1) && NEAR(box[1], 0) && NEAR(box[2], 1) && NEAR(box[3], 2));
    /* the front band [0,1): both front faces' halves... all of x=0 with z<1 and z=0 with x<1, and half the top */
    CHECK_EQ(fw_mesh_slice_visible(p, w, lo, hi, 0, 1, box, &a), 1);
    CHECK(NEAR(a, 2.5));
    CHECK_EQ(fw_mesh_slice_visible(p, w, lo, hi, 1, 2, box, &a), 1);    /* the back band: the top's far half */
    CHECK(NEAR(a, 0.5));
    CHECK(NEAR(box[1], 1.5) && NEAR(box[3], 2));
    CHECK_EQ(fw_mesh_slice_visible(p, w, lo, hi, 5, 6, box, &a), 0);    /* nothing in it */
    CHECK(a == 0);
    w[12] = 2; w[14] = 3;                                               /* moved: the bands move with x + z */
    CHECK_EQ(fw_mesh_slice_visible(p, w, lo, hi, 5, 6, box, &a), 1);
    CHECK(NEAR(a, 2.5));
    float z[16] = { 0 };
    CHECK_EQ(fw_mesh_slice_visible(z, w, lo, hi, 5, 6, box, &a), 0);    /* w = 0 */
    CHECK_EQ(fw_mesh_slice_visible(NULL, w, lo, hi, 5, 6, box, &a), 0);
}

TEST(tints_and_probe_tile_suffix) {
    float c[4];
    fw_mesh_slice_tint(0, c); CHECK(c[0] == 0 && c[1] == 0 && c[2] == 1 && c[3] == 1);
    fw_mesh_slice_tint(1, c); CHECK(c[0] == 0 && c[1] == 1 && c[2] == 1);
    fw_mesh_slice_tint(2, c); CHECK(c[0] == 1 && c[1] == 0 && c[2] == 1);
    fw_mesh_slice_tint(3, c); CHECK(c[0] == 0 && c[1] == 0 && c[2] == 1);
    fw_mesh_slice_tint(-1, c); CHECK(c[3] == 1);
    CHECK_STR(fw_mesh_slice_tint_name(0), "blue");
    CHECK_STR(fw_mesh_slice_tint_name(4), "cyan");
    CHECK_STR(fw_mesh_slice_tint_name(5), "magenta");
    char path[64];
    int col = -9, row = -9;
    CHECK_EQ(fw_mesh_slice_probe_at("models/slab2x1.obj@0,6", path, sizeof path, &col, &row), 1);
    CHECK_STR(path, "models/slab2x1.obj"); CHECK_EQ(col, 0); CHECK_EQ(row, 6);
    CHECK_EQ(fw_mesh_slice_probe_at("models/crate.obj", path, sizeof path, &col, &row), 0);
    CHECK_STR(path, "models/crate.obj");
    CHECK_EQ(fw_mesh_slice_probe_at("models/a.obj@x", path, sizeof path, &col, &row), -1);
    CHECK_EQ(fw_mesh_slice_probe_at("models/a.obj@1,", path, sizeof path, &col, &row), -1);
    CHECK_EQ(fw_mesh_slice_probe_at("models/a.obj@-1,2", path, sizeof path, &col, &row), -1);
    CHECK_EQ(fw_mesh_slice_probe_at("models/a.obj@1,2x", path, sizeof path, &col, &row), -1);
    CHECK_EQ(fw_mesh_slice_probe_at("@1,2", path, sizeof path, &col, &row), -1);
    CHECK_EQ(fw_mesh_slice_probe_at("models/a.obj@1,2", path, 8, &col, &row), -1);   /* does not fit */
    CHECK_EQ(fw_mesh_slice_probe_at(NULL, path, sizeof path, &col, &row), -1);
}

TEST(log_line) {
    FwMeshSlice s[2];
    CHECK_EQ(fw_mesh_slice_plan(8.2, 9.8, 2, s), 2);
    const double b[4] = { -0.5, -0.25, 0.125, 0.5 };
    char buf[256];
    fw_mesh_slice_fmt(buf, sizeof buf, 61, 3, 1, 2, &s[1], b, 0.03125, "cyan");
    CHECK_STR(buf, "mesh slice f=61 obj=3 band=1/2 depth=[9.000 10.000) key=9.500 vis=(-0.5000 -0.2500 0.1250 0.5000) area=0.031250 tint=cyan");
    char small[12];
    int n = fw_mesh_slice_fmt(small, sizeof small, 61, 3, 1, 2, &s[1], b, 0.03125, NULL);
    CHECK(n == (int)strlen(small) && strlen(small) == sizeof small - 1);
    fw_mesh_slice_fmt(buf, sizeof buf, 1, 0, 0, 1, &s[0], NULL, 0, NULL);
    CHECK_STR(buf, "mesh slice f=1 obj=0 band=0/1 depth=[8.000 9.000) key=8.500 vis=(0.0000 0.0000 0.0000 0.0000) area=0.000000 tint=-");
}

/* the T2 fight (TacticsTest, seed 42; editor/test/fixtures/ingame/mesh-occlusion-log.txt): the units layer's item keys
 * in draw order; cats on (2,6) = 9, (2,5) = 8, (1,5) = 7, (1,4) = 6 (the .03 ones are obstacles) */
static const double FIGHT[] = { 18.03, 12.529, 11.03, 9.0, 8.0, 7.03, 7.0, 6.0, 5.03, 0.0 };
#define NFIGHT ((int)(sizeof FIGHT / sizeof FIGHT[0]))

static void place(FwMeshOrder *o, int where[]) {
    int out[FW_MESH_ORDER_MAX];
    for (int i = 0; i < 8; i++) where[i] = -2;
    for (int i = 0; i < NFIGHT; i++) {
        int n = fw_mesh_order_before_item(o, i, FIGHT[i], NULL, out, FW_MESH_ORDER_MAX);
        for (int k = 0; k < n; k++) where[out[k]] = i;
    }
    int n = fw_mesh_order_rest(o, out, FW_MESH_ORDER_MAX);
    for (int k = 0; k < n; k++) where[out[k]] = -1;
}

TEST(slab_2x1_on_the_fight_rows) {
    /* the 2x1 slab on (0,6)+(1,6), depth 6.1 .. 8.9: its back rows go under the cat on (1,5) (key 7), all of it over
     * the cat on (2,6) (key 9) */
    FwMeshSlice s[FW_MESH_SLICE_MAX];
    int n = fw_mesh_slice_plan(6.1, 8.9, FW_MESH_SLICE_MAX, s);
    CHECK_EQ(n, 3);
    FwMeshOrder o;
    fw_mesh_order_reset(&o);
    for (int i = 0; i < n; i++) fw_mesh_order_add(&o, s[i].key, NULL, i);
    int where[8];
    place(&o, where);
    CHECK_EQ(where[2], 4);   /* [8,9): before the cat on (2,5) at 8, after the cat on (2,6) at 9 */
    CHECK_EQ(where[1], 5);   /* [7,8): before the obstacle at 7.03 and so before the cat on (1,5) at 7 */
    CHECK_EQ(where[0], 7);   /* [6,7): after the cat on (1,5), before the cat on (1,4) at 6 */
    /* the M2 control: one draw keyed by the origin (0.5 + 6.5 = 7), meshes win ties: after the cat on (1,5) (over it) */
    fw_mesh_order_reset(&o);
    fw_mesh_order_set_m2(&o, 1);
    fw_mesh_order_add(&o, fw_mesh_order_tile_key(0.5, 6.5), NULL, 0);
    place(&o, where);
    CHECK_EQ(where[0], 7);
}

TEST(post_behind_the_feet_of_a_unit_on_its_tile) {
    /* item 7: a post on the back half of (2,6) (depth 9.1 .. 9.9) where a cat stands (key 9): drawn before the cat */
    FwMeshSlice s[FW_MESH_SLICE_MAX];
    CHECK_EQ(fw_mesh_slice_plan(9.1, 9.9, FW_MESH_SLICE_MAX, s), 1);
    FwMeshOrder o;
    fw_mesh_order_reset(&o);
    fw_mesh_order_add(&o, s[0].key, NULL, 0);
    int where[8];
    place(&o, where);
    CHECK_EQ(where[0], 3);   /* before item 3, the cat on (2,6): the cat covers it */
    /* M2: keyed by its origin (2.5 + 6.5 = 9), the tie went to the mesh: after the cat, over it */
    fw_mesh_order_reset(&o);
    fw_mesh_order_set_m2(&o, 1);
    fw_mesh_order_add(&o, fw_mesh_order_tile_key(2.5, 6.5), NULL, 0);
    place(&o, where);
    CHECK_EQ(where[0], 4);
}

int main(void) { return MT_RUN_ALL(); }
