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
#define FAKE_RND_BYTES  0x80
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
    FakeCamera mask, main; int tex = 0, pass = 0;
    void *maskCam = make_camera(&mask, &tex), *mainCam = make_camera(&main, NULL);
    *(void **)(tt + OFF_TT_MASK_CAMERA) = maskCam;
    *(void **)(tt + OFF_TT_MAIN_CAMERA) = mainCam;
    *(void **)(tt + OFF_TT_BLUR_PASS) = &pass;
    CHECK(fw_glow_mask_camera(tt) == maskCam);
    CHECK(fw_glow_main_camera(tt) == mainCam);
    CHECK(fw_glow_blur_pass(tt) == &pass);
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

int main(void) { return MT_RUN_ALL(); }
