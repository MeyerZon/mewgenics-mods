/* Host-side tests for the pure rules of the per-unit glow engine (src/fw_glow_rules.c): the registry of glowing
 * units (cap, update in place, clear, pruning by the pool generation at Character-8), the v1 shared colour, the
 * object accessors and the writes the per-frame plan makes — all over fake byte buffers shaped by the GENERATED
 * offsets.h macros only (Character+OFF_CH_RENDERER, renderer+OFF_RND_EXTRA_*, camera+OFF_CAM_PASSES,
 * pass+OFF_PASS_*). No windows.h, no game. The calls into the game (vec_u32_AddUnique, GetOrCreateMaterial,
 * SetUniform*, SetTexture, AddPostProcessPass) stay in glow_engine.c and are verified in-game (T2). */
#define FW_NO_WINDOWS
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include "../../test/minitest.h"
#include "fw_glow_rules.h"

/* fake sizes are test choices, not game facts; the asserts keep them above every offset the rules touch */
#define FAKE_CHAR_BYTES 0x60
#define FAKE_RND_BYTES  0x90
#define FAKE_CAM_BYTES  0xc0
#define FAKE_TT_BYTES   0xa0
#define FAKE_PASS_BYTES 0xa0
#define FAKE_LAYERS     0x30
_Static_assert(OFF_CH_RENDERER + 8 <= FAKE_CHAR_BYTES, "character fake too small");
_Static_assert(OFF_CH_GENERATION == -8, "the generation sits right before the Character (the pool header)");
_Static_assert(OFF_RND_EXTRA_DATA + 8 <= FAKE_RND_BYTES, "renderer fake too small");
_Static_assert(OFF_CAM_PASSES + 8 <= FAKE_CAM_BYTES && OFF_CAM_RTT_TEXTURE + 8 <= FAKE_CAM_BYTES, "camera fake too small");
_Static_assert(OFF_TT_BLUR_PASS + 8 <= FAKE_TT_BYTES, "TacticsTest fake too small");
_Static_assert(OFF_PASS_FLAGS + 2 <= FAKE_PASS_BYTES && OFF_PASS_RECT_B + 32 <= FAKE_PASS_BYTES, "pass fake too small");
_Static_assert(CONST_COMPOSITE_LAYER < FAKE_LAYERS && CONST_MASK_LAYER < FAKE_LAYERS, "layer table fake too small");

/* a Character with its pool generation at -8 (what OFF_CH_GENERATION reads) */
typedef struct FakeCharacter { uintptr_t generation; unsigned char body[FAKE_CHAR_BYTES]; } FakeCharacter;
static void *make_character(FakeCharacter *c, uintptr_t gen, void *renderer) {
    memset(c, 0, sizeof *c);
    c->generation = gen;
    *(void **)(c->body + OFF_CH_RENDERER) = renderer;
    return c->body;
}
/* a renderer whose extra-layer vector {cap, count, data} points at `data` */
static void make_renderer(unsigned char *r, uint32_t *data, uint32_t cap, uint32_t count) {
    memset(r, 0, FAKE_RND_BYTES);
    *(uint32_t *)(r + OFF_RND_EXTRA_LAYERS) = cap;
    *(uint32_t *)(r + OFF_RND_EXTRA_COUNT) = count;
    *(uint32_t **)(r + OFF_RND_EXTRA_DATA) = data;
}
/* a camera whose per-layer pass vectors live in `table` (FAKE_LAYERS x {begin, end, cap}) */
typedef struct FakeCamera { unsigned char bytes[FAKE_CAM_BYTES]; void **table[FAKE_LAYERS][3]; void *passes[FAKE_LAYERS][4]; } FakeCamera;
static void *make_camera(FakeCamera *c, void *texture) {
    memset(c, 0, sizeof *c);
    for (int i = 0; i < FAKE_LAYERS; i++) { c->table[i][0] = c->passes[i]; c->table[i][1] = c->passes[i]; c->table[i][2] = c->passes[i] + 4; }
    *(void **)(c->bytes + OFF_CAM_PASSES) = c->table;
    *(void **)(c->bytes + OFF_CAM_RTT_TEXTURE) = texture;
    return c->bytes;
}
static void camera_push_pass(FakeCamera *c, int layer, void *pass) {
    void **end = c->table[layer][1];
    *end = pass;
    c->table[layer][1] = end + 1;
}
/* a pass with `n` material entries */
typedef struct FakePass { unsigned char bytes[FAKE_PASS_BYTES]; struct { void *mat; int one; } mats[4]; } FakePass;
static void *make_pass(FakePass *p, void *mat0, uint32_t n) {
    memset(p, 0, sizeof *p);
    p->mats[0].mat = mat0;
    *(uint32_t *)(p->bytes + OFF_PASS_MAT_COUNT) = n;
    *(void **)(p->bytes + OFF_PASS_MATERIALS) = p->mats;
    return p->bytes;
}

static const float RED[4] = { 1, 0, 0, 1 }, BLUE[4] = { 0, 0, 1, 0.5f };

TEST(registry_set_find_update_in_place_clear_compacts_and_caps_at_16) {
    FwGlowRegistry r; fw_glow_reset(&r);
    FakeCharacter c[FW_GLOW_MAX_UNITS + 1]; void *ch[FW_GLOW_MAX_UNITS + 1];
    for (int i = 0; i <= FW_GLOW_MAX_UNITS; i++) ch[i] = make_character(&c[i], 100 + (uintptr_t)i, NULL);
    CHECK_EQ(fw_glow_find(&r, ch[0]), -1);
    for (int i = 0; i < FW_GLOW_MAX_UNITS; i++) CHECK_EQ(fw_glow_set(&r, ch[i], RED), 1);
    CHECK_EQ(r.count, FW_GLOW_MAX_UNITS);
    CHECK_EQ(fw_glow_set(&r, ch[FW_GLOW_MAX_UNITS], RED), 0);       /* full: refused, nothing changes */
    CHECK_EQ(r.count, FW_GLOW_MAX_UNITS);
    CHECK_EQ(fw_glow_set(&r, ch[3], BLUE), 1);                        /* an existing unit: colour updated in place */
    CHECK_EQ(r.count, FW_GLOW_MAX_UNITS);
    CHECK_EQ(fw_glow_find(&r, ch[3]), 3);
    CHECK(r.units[3].rgba[2] == 1.0f && r.units[3].rgba[3] == 0.5f);
    CHECK(r.units[3].generation == 103);                               /* the pool generation is captured at set time */
    CHECK_EQ(fw_glow_clear(&r, ch[1]), 1);
    CHECK_EQ(fw_glow_clear(&r, ch[1]), 0);                             /* already gone */
    CHECK_EQ(r.count, FW_GLOW_MAX_UNITS - 1);
    CHECK_EQ(fw_glow_find(&r, ch[2]), 1);                              /* order kept (compaction, not swap-remove) */
    CHECK_EQ(fw_glow_find(&r, ch[3]), 2);
    CHECK_EQ(fw_glow_set(&r, ch[FW_GLOW_MAX_UNITS], RED), 1);          /* room again */
    fw_glow_reset(&r);
    CHECK_EQ(r.count, 0);
}

TEST(registry_refuses_null_and_bad_colours) {
    FwGlowRegistry r; fw_glow_reset(&r);
    FakeCharacter c; void *ch = make_character(&c, 1, NULL);
    CHECK_EQ(fw_glow_set(&r, NULL, RED), 0);
    CHECK_EQ(fw_glow_set(&r, ch, NULL), 0);
    CHECK_EQ(fw_glow_clear(&r, NULL), 0);
    CHECK_EQ(r.count, 0);
}

TEST(prune_drops_units_whose_pool_generation_moved) {
    FwGlowRegistry r; fw_glow_reset(&r);
    FakeCharacter c[3]; void *ch[3];
    for (int i = 0; i < 3; i++) { ch[i] = make_character(&c[i], 10 + (uintptr_t)i, NULL); fw_glow_set(&r, ch[i], RED); }
    CHECK_EQ(fw_glow_prune(&r), 0);
    c[1].generation = 99;                                              /* the slot was reused by another unit */
    CHECK_EQ(fw_glow_prune(&r), 1);
    CHECK_EQ(r.count, 2);
    CHECK_EQ(fw_glow_find(&r, ch[1]), -1);
    CHECK_EQ(fw_glow_find(&r, ch[2]), 1);
}

TEST(colour_is_the_first_registered_units_rgba_white_when_empty_and_the_frame_plan_says_so) {
    FwGlowRegistry r; fw_glow_reset(&r);
    float c[4]; FwGlowFrame f;
    fw_glow_colour(&r, c);
    CHECK(c[0] == 1 && c[1] == 1 && c[2] == 1 && c[3] == 1);
    fw_glow_frame(&r, &f);
    CHECK_EQ(f.active, 0);
    FakeCharacter a, b; void *ca = make_character(&a, 1, NULL), *cb = make_character(&b, 2, NULL);
    fw_glow_set(&r, ca, BLUE); fw_glow_set(&r, cb, RED);
    fw_glow_colour(&r, c);
    CHECK(c[0] == 0 && c[2] == 1 && c[3] == 0.5f);                      /* v1: one shared colour = the first unit's */
    fw_glow_frame(&r, &f);
    CHECK_EQ(f.active, 1);
    CHECK(f.colour[2] == 1.0f);
    fw_glow_clear(&r, ca);
    fw_glow_colour(&r, c);
    CHECK(c[0] == 1 && c[2] == 0);                                      /* the next one takes over */
    CHECK_EQ(fw_glow_colour_eq(RED, c), 1);
    CHECK_EQ(fw_glow_colour_eq(RED, BLUE), 0);
}

TEST(accessors_read_through_the_generated_offsets) {
    unsigned char rnd[FAKE_RND_BYTES]; uint32_t layers[4] = { 1, 2, 3, 4 };
    make_renderer(rnd, layers, 4, 4);
    FakeCharacter c; void *ch = make_character(&c, 77, rnd);
    CHECK(fw_glow_renderer(ch) == rnd);
    CHECK(fw_glow_generation(ch) == 77);
    CHECK(fw_glow_extra_layers(rnd) == rnd + OFF_RND_EXTRA_LAYERS);
    unsigned char tt[FAKE_TT_BYTES]; memset(tt, 0, sizeof tt);
    FakeCamera mask, main; int tex = 0, pass = 0, composite = 0;
    void *maskCam = make_camera(&mask, &tex), *mainCam = make_camera(&main, NULL);
    *(void **)(tt + OFF_TT_MASK_CAMERA) = maskCam;
    *(void **)(tt + OFF_TT_MAIN_CAMERA) = mainCam;
    *(void **)(tt + OFF_TT_BLUR_PASS) = &pass;
    *(void **)(tt + OFF_TT_COMPOSITE_PASS) = &composite;
    CHECK(fw_glow_mask_camera(tt) == maskCam);
    CHECK(fw_glow_main_camera(tt) == mainCam);
    CHECK(fw_glow_blur_pass(tt) == &pass);
    CHECK(fw_glow_composite_pass(tt) == &composite);
    CHECK(fw_glow_camera_texture(maskCam) == &tex);
    CHECK(fw_glow_camera_texture(mainCam) == NULL);
}

TEST(layers_has_and_strip_over_the_renderers_extra_layer_vector) {
    unsigned char rnd[FAKE_RND_BYTES]; uint32_t data[8] = { 5, CONST_MASK_LAYER, 7, CONST_MASK_LAYER, 9 };
    make_renderer(rnd, data, 8, 5);
    CHECK_EQ(fw_glow_layers_has(rnd, CONST_MASK_LAYER), 1);
    CHECK_EQ(fw_glow_layers_has(rnd, 6), 0);
    CHECK_EQ(fw_glow_layers_strip(rnd, CONST_MASK_LAYER), 2);          /* every copy goes (StatusMenu's loop) */
    CHECK_EQ(*(uint32_t *)(rnd + OFF_RND_EXTRA_COUNT), 3);
    CHECK_EQ(fw_glow_layers_has(rnd, CONST_MASK_LAYER), 0);
    CHECK_EQ(fw_glow_layers_has(rnd, 5), 1); CHECK_EQ(fw_glow_layers_has(rnd, 7), 1); CHECK_EQ(fw_glow_layers_has(rnd, 9), 1);
    CHECK_EQ(fw_glow_layers_strip(rnd, CONST_MASK_LAYER), 0);
    make_renderer(rnd, NULL, 0, 0);                                     /* an empty vector (data NULL) is safe */
    CHECK_EQ(fw_glow_layers_has(rnd, CONST_MASK_LAYER), 0);
    CHECK_EQ(fw_glow_layers_strip(rnd, CONST_MASK_LAYER), 0);
    CHECK_EQ(fw_glow_layers_has(NULL, CONST_MASK_LAYER), 0);
    CHECK_EQ(fw_glow_layers_strip(NULL, CONST_MASK_LAYER), 0);
}

TEST(find_pass_scans_the_cameras_layer_vector_for_the_pass_whose_first_material_is_ours) {
    FakeCamera cam; void *c = make_camera(&cam, NULL);
    int ours = 0, theirs = 0;
    FakePass p0, p1, p2;
    void *game = make_pass(&p0, &theirs, 1), *mine = make_pass(&p1, &ours, 1), *empty = make_pass(&p2, &ours, 0);
    CHECK(fw_glow_find_pass(c, CONST_COMPOSITE_LAYER, &ours) == NULL);  /* nothing on the layer yet */
    camera_push_pass(&cam, CONST_COMPOSITE_LAYER, game);
    camera_push_pass(&cam, CONST_COMPOSITE_LAYER, empty);               /* zero materials: never a match, never read */
    CHECK(fw_glow_find_pass(c, CONST_COMPOSITE_LAYER, &ours) == NULL);
    camera_push_pass(&cam, CONST_COMPOSITE_LAYER, mine);
    CHECK(fw_glow_find_pass(c, CONST_COMPOSITE_LAYER, &ours) == mine);
    CHECK(fw_glow_find_pass(c, CONST_COMPOSITE_LAYER, &theirs) == game);
    CHECK(fw_glow_find_pass(c, CONST_MASK_LAYER, &ours) == NULL);       /* another layer's vector */
    CHECK(fw_glow_find_pass(NULL, CONST_COMPOSITE_LAYER, &ours) == NULL);
    CHECK(fw_glow_find_pass(c, CONST_COMPOSITE_LAYER, NULL) == NULL);
}

TEST(pass_force_writes_the_enable_byte_and_full_screen_rects_adopt_zeroes_the_flags) {
    FakePass p; int mat = 0; void *pass = make_pass(&p, &mat, 1);
    double *a = (double *)(p.bytes + OFF_PASS_RECT_A), *b = (double *)(p.bytes + OFF_PASS_RECT_B);
    a[0] = 0.3; a[1] = 0.4; a[2] = 0.5; a[3] = 0.6; b[0] = 0.3; b[1] = 0.4; b[2] = 0.5; b[3] = 0.6;   /* a hovered unit's rect */
    *(uint16_t *)(p.bytes + OFF_PASS_FLAGS) = 1;
    fw_glow_pass_force(pass, 1, 1);
    CHECK_EQ(p.bytes[OFF_PASS_ENABLED], 1);
    CHECK(a[0] == 0 && a[1] == 1 && a[2] == 0 && a[3] == 1);
    CHECK(b[0] == 0 && b[1] == 1 && b[2] == 0 && b[3] == 1);
    CHECK_EQ(*(uint16_t *)(p.bytes + OFF_PASS_FLAGS), 1);               /* force leaves the flags alone */
    a[0] = 0.3;
    fw_glow_pass_force(pass, 0, 0);
    CHECK_EQ(p.bytes[OFF_PASS_ENABLED], 0);
    CHECK(a[0] == 0.3);                                                 /* rects untouched without fullScreen */
    fw_glow_pass_adopt(pass);
    CHECK_EQ(*(uint16_t *)(p.bytes + OFF_PASS_FLAGS), 0);
    CHECK_EQ(p.bytes[OFF_PASS_ENABLED], 1);                             /* adopt = ours, enabled */
    fw_glow_pass_force(NULL, 1, 1);                                     /* NULL is a no-op */
    fw_glow_pass_adopt(NULL);
}

/* ===================================================================================================== */
/* v2: per-unit colours: colour groups, the draw plan, the unit's screen rect (LateRender's hovered-unit  */
/* math, 0x88e24e..0x88e4a0) and the per-draw pass writes                                                */
/* ===================================================================================================== */
static const float GREEN[4] = { 0, 1, 0, 1 }, CYAN[4] = { 0, 1, 1, 1 };

TEST(v2_groups_are_the_distinct_colours_in_first_registration_order_each_listing_its_units) {
    FwGlowRegistry r; fw_glow_reset(&r);
    FwGlowGroups g;
    fw_glow_groups(&r, &g);
    CHECK_EQ(g.count, 0);
    FakeCharacter c[5]; void *ch[5];
    for (int i = 0; i < 5; i++) ch[i] = make_character(&c[i], 1 + (uintptr_t)i, NULL);
    fw_glow_set(&r, ch[0], RED); fw_glow_set(&r, ch[1], BLUE); fw_glow_set(&r, ch[2], RED); fw_glow_set(&r, ch[3], GREEN); fw_glow_set(&r, ch[4], BLUE);
    fw_glow_groups(&r, &g);
    CHECK_EQ(g.count, 3);                                                 /* RED, BLUE, GREEN: order of first appearance */
    CHECK_EQ(fw_glow_colour_eq(g.g[0].colour, RED), 1); CHECK_EQ(fw_glow_colour_eq(g.g[1].colour, BLUE), 1); CHECK_EQ(fw_glow_colour_eq(g.g[2].colour, GREEN), 1);
    CHECK_EQ(g.g[0].count, 2); CHECK_EQ(g.g[0].units[0], 0); CHECK_EQ(g.g[0].units[1], 2);
    CHECK_EQ(g.g[1].count, 2); CHECK_EQ(g.g[1].units[0], 1); CHECK_EQ(g.g[1].units[1], 4);
    CHECK_EQ(g.g[2].count, 1); CHECK_EQ(g.g[2].units[0], 3);
    CHECK_EQ(fw_glow_group_of(&g, 4), 1); CHECK_EQ(fw_glow_group_of(&g, 3), 2); CHECK_EQ(fw_glow_group_of(&g, 9), -1);
    fw_glow_set(&r, ch[0], GREEN);                                        /* recolour in place: the unit changes group, the order follows */
    fw_glow_groups(&r, &g);
    CHECK_EQ(g.count, 3);
    CHECK_EQ(fw_glow_colour_eq(g.g[0].colour, GREEN), 1); CHECK_EQ(g.g[0].count, 2); CHECK_EQ(g.g[0].units[1], 3);
    CHECK_EQ(fw_glow_colour_eq(g.g[1].colour, BLUE), 1);
    CHECK_EQ(fw_glow_colour_eq(g.g[2].colour, RED), 1); CHECK_EQ(g.g[2].units[0], 2);
    fw_glow_clear(&r, ch[2]);                                             /* the last RED unit goes: so does its group */
    fw_glow_groups(&r, &g);
    CHECK_EQ(g.count, 2);
    CHECK_EQ(g.g[1].units[1], 3);                                         /* indices follow the compacted registry (ch[4] is now 3) */
}

TEST(v2_groups_keep_the_cap_sixteen_distinct_colours_are_sixteen_groups) {
    FwGlowRegistry r; fw_glow_reset(&r);
    FakeCharacter c[FW_GLOW_MAX_UNITS];
    for (int i = 0; i < FW_GLOW_MAX_UNITS; i++) {
        float col[4] = { (float)i / 16.0f, 0, 1, 1 };
        CHECK_EQ(fw_glow_set(&r, make_character(&c[i], 5, NULL), col), 1);
    }
    FwGlowGroups g; fw_glow_groups(&r, &g);
    CHECK_EQ(g.count, FW_GLOW_MAX_UNITS);
    CHECK_EQ(FW_GLOW_MAX_GROUPS, FW_GLOW_MAX_UNITS);
    for (int i = 0; i < FW_GLOW_MAX_UNITS; i++) { CHECK_EQ(g.g[i].count, 1); CHECK_EQ(g.g[i].units[0], i); }
}

TEST(v2_plan_one_colour_is_one_full_screen_draw_v1_path_several_colours_one_scissored_draw_per_unit) {
    FwGlowRegistry r; fw_glow_reset(&r);
    FwGlowGroups g; FwGlowDraw d[FW_GLOW_MAX_UNITS];
    fw_glow_groups(&r, &g);
    CHECK_EQ(fw_glow_plan(&r, &g, d), 0);
    FakeCharacter c[3]; void *ch[3];
    for (int i = 0; i < 3; i++) ch[i] = make_character(&c[i], 1, NULL);
    fw_glow_set(&r, ch[0], RED); fw_glow_set(&r, ch[1], RED); fw_glow_set(&r, ch[2], RED);
    fw_glow_groups(&r, &g);
    CHECK_EQ(fw_glow_plan(&r, &g, d), 1);                                 /* every unit one colour: the mask needs no split */
    CHECK_EQ(d[0].group, 0); CHECK_EQ(d[0].unit, -1);
    fw_glow_set(&r, ch[1], CYAN);
    fw_glow_groups(&r, &g);
    CHECK_EQ(fw_glow_plan(&r, &g, d), 3);                                 /* two colours: one draw per unit, registry order */
    CHECK_EQ(d[0].unit, 0); CHECK_EQ(d[0].group, 0);
    CHECK_EQ(d[1].unit, 1); CHECK_EQ(d[1].group, 1);
    CHECK_EQ(d[2].unit, 2); CHECK_EQ(d[2].group, 0);
    FwGlowFrame f; fw_glow_frame(&r, &f);                                 /* the frame carries groups + plan */
    CHECK_EQ(f.active, 1); CHECK_EQ(f.groups.count, 2); CHECK_EQ(f.ndraws, 3); CHECK_EQ(f.draws[1].group, 1);
    CHECK_EQ(fw_glow_colour_eq(f.colour, RED), 1);
}

TEST(v2_material_names_slot_zero_keeps_the_v1_name) {
    char b[32];
    CHECK_STR(fw_glow_material_name(0, b, sizeof b), "fw_unit_glow");
    CHECK_STR(fw_glow_material_name(1, b, sizeof b), "fw_unit_glow_1");
    CHECK_STR(fw_glow_material_name(15, b, sizeof b), "fw_unit_glow_15");
    char tiny[4];
    CHECK(fw_glow_material_name(3, tiny, sizeof tiny) == NULL);           /* never truncated into another slot's name */
}

static int feq(double a, double b) { double d = a - b; return d < 1e-4 && d > -1e-4; }

TEST(v2_clip_bounds_is_the_9d46d0_replica_x_from_m0_m3_m4_y_from_m2_m1_m5) {
    /* bounds {x0, x1, y0, y1}; matrix {m0..m5}: x' = m0*x + m3*y + m4, y' = m2*x + m1*y + m5, as an axis-aligned box */
    float b[4] = { -1, 4, -2, 6 };
    const float m[6] = { 2, 3, 0.5f, -1, 10, 20 };
    fw_glow_clip_bounds(b, m);
    CHECK(feq(b[0], 2) && feq(b[1], 20) && feq(b[2], 13.5) && feq(b[3], 40));
}

TEST(v2_matrix_bounds_is_LateRenders_screen_matrix_stage_m0_m4_m12_for_x_m1_m5_m13_for_y) {
    float b[4] = { -1, 4, -2, 6 };
    float M[16] = { 0 };
    M[0] = 2; M[4] = -1; M[12] = 10;                                      /* x' = 2x - y + 10 */
    M[1] = 0.5f; M[5] = 3; M[13] = 20;                                    /* y' = 0.5x + 3y + 20 */
    M[2] = 99; M[3] = 99; M[8] = 99; M[14] = 99;                          /* never read */
    fw_glow_matrix_bounds(b, M);
    CHECK(feq(b[0], 2) && feq(b[1], 20) && feq(b[2], 13.5) && feq(b[3], 40));
}

TEST(v2_mat4_inverse_identity_known_affine_rotation_and_singular) {
    const float I[16] = { 1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1 };
    float out[16];
    CHECK_EQ(fw_glow_mat4_inverse(I, out), 1);
    for (int i = 0; i < 16; i++) CHECK(feq(out[i], I[i]));
    /* scale (2, 4, 1) then translate (3, 5, 0), the translation in elements 12/13 as the game's matrices carry it */
    const float A[16] = { 2,0,0,0, 0,4,0,0, 0,0,1,0, 3,5,0,1 };
    CHECK_EQ(fw_glow_mat4_inverse(A, out), 1);
    CHECK(feq(out[0], 0.5) && feq(out[5], 0.25) && feq(out[10], 1) && feq(out[15], 1));
    CHECK(feq(out[12], -1.5) && feq(out[13], -1.25) && feq(out[1], 0) && feq(out[4], 0));
    const float R[16] = { 0,1,0,0, -1,0,0,0, 0,0,1,0, 7,-2,0,1 };        /* a rotation + translation: inverse x R == I */
    CHECK_EQ(fw_glow_mat4_inverse(R, out), 1);
    for (int i = 0; i < 4; i++) for (int j = 0; j < 4; j++) {
        double s = 0; for (int k = 0; k < 4; k++) s += (double)out[i * 4 + k] * R[k * 4 + j];
        CHECK(feq(s, i == j ? 1 : 0));
    }
    const float S[16] = { 1,2,0,0, 2,4,0,0, 0,0,1,0, 0,0,0,1 };
    CHECK_EQ(fw_glow_mat4_inverse(S, out), 0);
}

TEST(v2_view_rect_maps_the_world_box_through_the_inverse_view_and_zoom_into_the_1280x720_canvas_y_flipped) {
    const float I[16] = { 1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1 };
    FwGlowRect r;
    const float whole[4] = { -640, 640, -360, 360 };
    fw_glow_view_rect(whole, I, 1.0, 1, &r);                              /* x = (x + 640) / 1280, y = 1 - (y + 360) / 720 */
    CHECK(feq(r.x0, 0) && feq(r.x1, 1) && feq(r.y0, 0) && feq(r.y1, 1));
    const float box[4] = { 0, 64, 0, 36 };
    fw_glow_view_rect(box, I, 1.0, 1, &r);
    CHECK(feq(r.x0, 0.5) && feq(r.x1, 0.55) && feq(r.y0, 0.45) && feq(r.y1, 0.5));
    fw_glow_view_rect(box, I, 2.0, -1, &r);                               /* zoom 2; the int at Camera+0x170 scales y (here -1: flipped) */
    CHECK(feq(r.x0, 0.5) && feq(r.x1, 0.6) && feq(r.y0, 0.5) && feq(r.y1, 0.6));
    const float T[16] = { 1,0,0,0, 0,1,0,0, 0,0,1,0, 128,-72,0,1 };        /* an inverse view translating by (128, -72) */
    fw_glow_view_rect(box, T, 1.0, 1, &r);
    CHECK(feq(r.x0, 0.6) && feq(r.x1, 0.65) && feq(r.y0, 0.55) && feq(r.y1, 0.6));
}

TEST(v2_unit_rect_chains_the_stages_adds_the_margin_clamps_and_reports_singular_or_off_screen) {
    const float raw[4] = { 0, 64, 0, 36 };
    const float clipM[6] = { 1, 1, 0, 0, 0, 0 };                          /* identity in the replica's layout */
    const float screen[16] = { 1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1 };
    float view[16] = { 1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1 };
    FwGlowRect r;
    CHECK_EQ(fw_glow_unit_rect(raw, clipM, screen, view, 1.0, 1, 0.0, &r), 1);
    CHECK(feq(r.x0, 0.5) && feq(r.x1, 0.55) && feq(r.y0, 0.45) && feq(r.y1, 0.5));
    CHECK_EQ(fw_glow_unit_rect(raw, clipM, screen, view, 1.0, 1, 12.8, &r), 1);   /* margin in canvas px: 12.8/1280, 12.8/720 */
    CHECK(feq(r.x0, 0.49) && feq(r.x1, 0.56) && feq(r.y0, 0.45 - 12.8 / 720) && feq(r.y1, 0.5 + 12.8 / 720));
    view[12] = -600;                                                      /* the view is inverted first: the box lands at x 1240..1304 */
    CHECK_EQ(fw_glow_unit_rect(raw, clipM, screen, view, 1.0, 1, 0.0, &r), 1);
    CHECK(feq(r.x0, 1240.0 / 1280) && r.x1 == 1.0);                       /* clamped to the canvas */
    view[12] = -5000;
    CHECK_EQ(fw_glow_unit_rect(raw, clipM, screen, view, 1.0, 1, 0.0, &r), -1);   /* wholly off screen: nothing to draw */
    const float sing[16] = { 0 };
    CHECK_EQ(fw_glow_unit_rect(raw, clipM, screen, sing, 1.0, 1, 0.0, &r), 0);    /* singular view: no rect */
}

/* a fake clip with a vtable: slot 0 = the content kind, slot VT_CLIP_BOUNDS = bounds(out[4]) */
typedef struct FakeClip { void **vt; unsigned char body[0x80]; } FakeClip;
static int kind_a(void *self) { (void)self; return CONST_CLIP_KIND_A; }
static int kind_b(void *self) { (void)self; return CONST_CLIP_KIND_B; }
static int kind_other(void *self) { (void)self; return 7; }
static float *bounds_fn(void *self, float *out) { (void)self; out[0] = 1; out[1] = 2; out[2] = 3; out[3] = 4; return out; }
_Static_assert(OFF_CLIP_MATRIX + 24 <= sizeof(FakeClip), "clip fake too small");
_Static_assert(OFF_RND_CLIP + 8 <= FAKE_RND_BYTES, "renderer fake too small for the clip pointer");

TEST(v2_unit_clip_takes_only_the_two_kinds_LateRender_takes_and_reads_bounds_and_matrix_through_it) {
    void *vt[VT_CLIP_BOUNDS + 1]; memset(vt, 0, sizeof vt);
    vt[0] = (void *)kind_a; vt[VT_CLIP_BOUNDS] = (void *)bounds_fn;
    FakeClip clip; memset(&clip, 0, sizeof clip); clip.vt = vt;
    const float *cm = (const float *)((const char *)&clip + OFF_CLIP_MATRIX);
    unsigned char rnd[FAKE_RND_BYTES]; memset(rnd, 0, sizeof rnd);
    CHECK(fw_glow_unit_clip(rnd) == NULL);                                /* no clip */
    CHECK(fw_glow_unit_clip(NULL) == NULL);
    *(void **)(rnd + OFF_RND_CLIP) = &clip;
    CHECK(fw_glow_unit_clip(rnd) == &clip);
    vt[0] = (void *)kind_b; CHECK(fw_glow_unit_clip(rnd) == &clip);
    vt[0] = (void *)kind_other; CHECK(fw_glow_unit_clip(rnd) == NULL);    /* LateRender would not take it either */
    float b[4] = { 0 };
    fw_glow_clip_raw_bounds(&clip, b);
    CHECK(b[0] == 1 && b[1] == 2 && b[2] == 3 && b[3] == 4);
    CHECK(fw_glow_clip_matrix(&clip) == cm);
}

TEST(v2_collect_passes_finds_every_pass_whose_first_material_is_one_of_ours_in_vector_order) {
    FakeCamera cam; void *c = make_camera(&cam, NULL);
    int m0 = 0, m1 = 0, theirs = 0;
    void *mats[2] = { &m0, &m1 };
    FakePass p[4];
    void *a = make_pass(&p[0], &m1, 1), *game = make_pass(&p[1], &theirs, 1), *b = make_pass(&p[2], &m0, 1), *empty = make_pass(&p[3], &m0, 0);
    void *out[4];
    CHECK_EQ(fw_glow_collect_passes(c, CONST_COMPOSITE_LAYER, mats, 2, out, 4), 0);
    camera_push_pass(&cam, CONST_COMPOSITE_LAYER, a);
    camera_push_pass(&cam, CONST_COMPOSITE_LAYER, game);
    camera_push_pass(&cam, CONST_COMPOSITE_LAYER, empty);
    camera_push_pass(&cam, CONST_COMPOSITE_LAYER, b);
    CHECK_EQ(fw_glow_collect_passes(c, CONST_COMPOSITE_LAYER, mats, 2, out, 4), 2);
    CHECK(out[0] == a && out[1] == b);
    CHECK_EQ(fw_glow_collect_passes(c, CONST_COMPOSITE_LAYER, mats, 1, out, 4), 1);   /* only the materials created so far */
    CHECK(out[0] == b);
    CHECK_EQ(fw_glow_collect_passes(c, CONST_COMPOSITE_LAYER, mats, 2, out, 1), 1);   /* capped */
    CHECK_EQ(fw_glow_collect_passes(NULL, CONST_COMPOSITE_LAYER, mats, 2, out, 4), 0);
}

TEST(v2_pass_writes_material_swap_and_scissor_rect_b_null_rect_is_full_screen) {
    FakePass p; int m0 = 0, m1 = 0; void *pass = make_pass(&p, &m0, 1);
    fw_glow_pass_set_material(pass, &m1);
    CHECK(p.mats[0].mat == &m1);
    CHECK(fw_glow_pass_first_material(pass) == &m1);
    double *a = (double *)(p.bytes + OFF_PASS_RECT_A), *b = (double *)(p.bytes + OFF_PASS_RECT_B);
    a[0] = 0; a[1] = 1; a[2] = 0; a[3] = 1;
    const FwGlowRect r = { 0.2, 0.3, 0.4, 0.5 };
    fw_glow_pass_set_rect(pass, &r);
    CHECK(b[0] == 0.2 && b[1] == 0.3 && b[2] == 0.4 && b[3] == 0.5);
    CHECK(a[0] == 0 && a[1] == 1 && a[2] == 0 && a[3] == 1);              /* rect A stays full screen, as the game's composites keep it */
    fw_glow_pass_set_rect(pass, NULL);
    CHECK(b[0] == 0 && b[1] == 1 && b[2] == 0 && b[3] == 1);
    fw_glow_pass_set_material(NULL, &m1);                                 /* NULL-safe */
    fw_glow_pass_set_rect(NULL, &r);
    CHECK(fw_glow_pass_first_material(NULL) == NULL);
}

int main(void) { return MT_RUN_ALL(); }
