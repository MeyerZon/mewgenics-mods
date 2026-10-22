/* Host-side tests for the pure parts of the phase-0 3D observer (src/fw_obs3d_rules.c): the MEWFW_OBSERVE3D budget
 * parse, the camera / render-queue / layer / item / Position accessors over fake byte buffers shaped by the GENERATED
 * offsets.h macros only, the world-camera predicate (TacticsTest+OFF_TT_MAIN_CAMERA) and the log line formats that
 * editor/src/core/ingame/obs3d.ts parses. The hook and the game calls stay in obs3d_engine.c (verified in-game, T2). */
#define FW_NO_WINDOWS
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdlib.h>
#include "../../test/minitest.h"
#include "fw_obs3d_rules.h"

#define FAKE_CAM_BYTES 0x180
#define FAKE_RQ_BYTES  0x60
#define FAKE_POS_BYTES 0xc0
#define FAKE_TT_BYTES  0xa0
#define FAKE_LAYERS    0x30
_Static_assert(OFF_CAM_LAYER_BITS + 8 <= FAKE_CAM_BYTES && OFF_CAM_ZOOM_Y + 4 <= FAKE_CAM_BYTES && OFF_CAM_QUEUE + 8 <= FAKE_CAM_BYTES, "camera fake too small");
_Static_assert(OFF_RQ_LAYERS_END + 8 <= FAKE_RQ_BYTES, "queue fake too small");
_Static_assert(OFF_POS_Z + 8 <= FAKE_POS_BYTES, "position fake too small");
_Static_assert(OFF_LAYER_MODE + 4 <= CONST_LAYER_STRIDE && OFF_LAYER_ITEMS + 8 <= CONST_LAYER_STRIDE, "a layer's fields sit inside its stride");
#define ITEM_BYTES (1 << CONST_LAYER_ITEM_SHIFT)
_Static_assert(ITEM_BYTES >= 8, "an item starts with its renderable");
#define FAKE_RND_BYTES 0x60
_Static_assert(OFF_RND_POSITION + 8 <= FAKE_RND_BYTES, "renderer fake too small");

typedef struct World {
    unsigned char cam[FAKE_CAM_BYTES];
    unsigned char rq[FAKE_RQ_BYTES];
    unsigned char layers[FAKE_LAYERS * CONST_LAYER_STRIDE];
    unsigned char items[4 * ITEM_BYTES];
    unsigned char pos[FAKE_POS_BYTES];
    uint32_t bits[2];
    uintptr_t renderable[FAKE_RND_BYTES / sizeof(uintptr_t)];
} World;

static void make_world(World *w) {
    memset(w, 0, sizeof *w);
    *(void **)(w->cam + OFF_CAM_QUEUE) = w->rq;
    *(uint32_t **)(w->cam + OFF_CAM_LAYER_BITS) = w->bits;
    *(double *)(w->cam + OFF_CAM_ZOOM) = 60.0;
    *(int32_t *)(w->cam + OFF_CAM_ZOOM_Y) = -1;
    *(unsigned char **)(w->rq + OFF_RQ_LAYERS) = w->layers;
    *(unsigned char **)(w->rq + OFF_RQ_LAYERS_END) = w->layers + sizeof w->layers;
    /* layer 0x19 (units): mode 0, one item {renderable, Position} */
    unsigned char *l19 = w->layers + 0x19 * CONST_LAYER_STRIDE;
    *(uint32_t *)(l19 + OFF_LAYER_COUNT) = 1;
    *(unsigned char **)(l19 + OFF_LAYER_ITEMS) = w->items;
    *(void **)(w->items + 0) = w->renderable;
    w->renderable[0] = 0x140ed81e8u;   /* a test vftable value */
    *(void **)((unsigned char *)w->renderable + OFF_RND_POSITION) = w->pos;
    /* layer 5: mode 1 (depth-tested), 3 items, no renderables */
    unsigned char *l5 = w->layers + 5 * CONST_LAYER_STRIDE;
    *(uint32_t *)(l5 + OFF_LAYER_COUNT) = 3;
    *(int32_t *)(l5 + OFF_LAYER_MODE) = 1;
    *(double *)(w->pos + OFF_POS_X) = 3.5;
    *(double *)(w->pos + OFF_POS_Z) = 7.5;
    w->bits[0] = (1u << 5) | (1u << 0x19);
}

TEST(budget_is_off_unless_a_plain_positive_decimal_and_capped) {
    CHECK_EQ(fw_obs3d_budget(NULL), 0);
    CHECK_EQ(fw_obs3d_budget(""), 0);
    CHECK_EQ(fw_obs3d_budget("0"), 0);
    CHECK_EQ(fw_obs3d_budget("-5"), 0);
    CHECK_EQ(fw_obs3d_budget("yes"), 0);
    CHECK_EQ(fw_obs3d_budget("12x"), 0);
    CHECK_EQ(fw_obs3d_budget("3"), 3);
    CHECK_EQ(fw_obs3d_budget("120"), 120);
    CHECK_EQ(fw_obs3d_budget("1000000000000"), FW_OBS3D_MAX_BUDGET);
}

TEST(should_log_one_frame_per_window_until_the_budget_is_spent) {
    CHECK_EQ(fw_obs3d_should_log(0, 3), 0);
    CHECK_EQ(fw_obs3d_should_log(1, 3), 1);
    CHECK_EQ(fw_obs3d_should_log(2, 3), 0);
    CHECK_EQ(fw_obs3d_should_log(1 + FW_OBS3D_EVERY, 3), 1);
    CHECK_EQ(fw_obs3d_should_log(1 + 2 * FW_OBS3D_EVERY, 3), 1);
    CHECK_EQ(fw_obs3d_should_log(1 + 3 * FW_OBS3D_EVERY, 3), 0);
    CHECK_EQ(fw_obs3d_should_log(1, 0), 0);
}

TEST(camera_fields_read_through_the_generated_offsets) {
    World w; make_world(&w);
    w.cam[OFF_CAM_RTT] = 1; w.cam[OFF_CAM_HDR] = 0;
    CHECK_EQ(fw_obs3d_cam_rtt(w.cam), 1);
    CHECK_EQ(fw_obs3d_cam_hdr(w.cam), 0);
    CHECK(fw_obs3d_cam_zoom(w.cam) == 60.0);
    CHECK_EQ(fw_obs3d_cam_flip(w.cam), -1);
    CHECK(fw_obs3d_cam_queue(w.cam) == w.rq);
    CHECK_EQ(fw_obs3d_cam_rtt(NULL), 0);
    CHECK(fw_obs3d_cam_zoom(NULL) == 0.0);
}

TEST(layer_bitset_and_mask) {
    World w; make_world(&w);
    CHECK_EQ(fw_obs3d_cam_layer_on(w.cam, 5), 1);
    CHECK_EQ(fw_obs3d_cam_layer_on(w.cam, 0x19), 1);
    CHECK_EQ(fw_obs3d_cam_layer_on(w.cam, 0x18), 0);
    CHECK_EQ(fw_obs3d_cam_layer_on(w.cam, -1), 0);
    w.bits[1] = 1u << (0x2a - 32);
    CHECK_EQ(fw_obs3d_cam_layer_on(w.cam, 0x2a), 1);
    CHECK(fw_obs3d_cam_layer_mask(w.cam) == (((uint64_t)1 << 0x2a) | ((uint64_t)1 << 0x19) | ((uint64_t)1 << 5)));
    *(uint32_t **)(w.cam + OFF_CAM_LAYER_BITS) = NULL;
    CHECK_EQ(fw_obs3d_cam_layer_on(w.cam, 5), 0);
    CHECK(fw_obs3d_cam_layer_mask(w.cam) == 0);
}

TEST(world_camera_is_tacticstest_main_camera) {
    World w; make_world(&w);
    unsigned char tt[FAKE_TT_BYTES]; memset(tt, 0, sizeof tt);
    unsigned char other[FAKE_CAM_BYTES];
    *(void **)(tt + OFF_TT_MAIN_CAMERA) = w.cam;
    CHECK_EQ(fw_obs3d_is_world_camera(tt, w.cam), 1);
    CHECK_EQ(fw_obs3d_is_world_camera(tt, other), 0);
    CHECK_EQ(fw_obs3d_is_world_camera(NULL, w.cam), 0);
    CHECK_EQ(fw_obs3d_is_world_camera(tt, NULL), 0);
}

TEST(render_queue_layers_items_and_position) {
    World w; make_world(&w);
    CHECK_EQ(fw_obs3d_layer_count(w.rq), FAKE_LAYERS);
    CHECK_EQ(fw_obs3d_layer_count(NULL), 0);
    CHECK(fw_obs3d_layer(w.rq, FAKE_LAYERS) == NULL);
    CHECK(fw_obs3d_layer(w.rq, -1) == NULL);
    const void *l19 = fw_obs3d_layer(w.rq, 0x19), *l5 = fw_obs3d_layer(w.rq, 5);
    CHECK_EQ(fw_obs3d_layer_items(l19), 1);
    CHECK_EQ(fw_obs3d_layer_mode(l5), 1);
    CHECK(fw_obs3d_item_renderable(l19, 0) == w.renderable);
    CHECK(fw_obs3d_renderer_position(w.renderable) == w.pos);
    CHECK(fw_obs3d_renderer_position(NULL) == NULL);
    CHECK_EQ(fw_obs3d_is_masked_renderer_iso(w.renderable, 0x140ed81e8u), 1);
    CHECK_EQ(fw_obs3d_is_masked_renderer_iso(w.renderable, 0x140ed81f0u), 0);
    CHECK_EQ(fw_obs3d_is_masked_renderer_iso(w.renderable, 0), 0);
    CHECK_EQ(fw_obs3d_is_masked_renderer_iso(NULL, 0x140ed81e8u), 0);
    CHECK(fw_obs3d_item_renderable(l19, 1) == NULL);
    CHECK(fw_obs3d_item_renderable(l5, 0) == NULL);   /* items pointer null */
    double xz[2];
    fw_obs3d_position_xz(w.pos, xz);
    CHECK(xz[0] == 3.5 && xz[1] == 7.5);
    fw_obs3d_position_xz(NULL, xz);
    CHECK(xz[0] == 0.0 && xz[1] == 0.0);
    CHECK_EQ(fw_obs3d_first_item_layer(w.cam, 0), 0x19);
    CHECK_EQ(fw_obs3d_first_item_layer(w.cam, 0x1a), -1);
}

static const float VP[16] = { 60, 0, 0, 0, 0, -60, 0, 0, 0, 0, 1, 0, 640, 360, 0, 1 };

TEST(camera_line_format) {
    World w; make_world(&w);
    char buf[512];
    int n = fw_obs3d_fmt_camera(buf, sizeof buf, 7, w.cam, 1, VP);
    CHECK_EQ(n, (int)strlen(buf));
    CHECK(strncmp(buf, "obs3d cam f=7 cam=", 18) == 0);
    CHECK(strstr(buf, " world=1 rtt=0 hdr=0 zoom=60 flip=-1 layers=0x2000020 vp=[60 0 0 0 0 -60 0 0 0 0 1 0 640 360 0 1]") != NULL);
}

TEST(layers_line_lists_enabled_nonempty_layers_with_mode_and_count) {
    World w; make_world(&w);
    char buf[256];
    fw_obs3d_fmt_layers(buf, sizeof buf, 2, w.cam);
    CHECK_STR(buf, "obs3d layers f=2 0x5:m1:n3 0x19:m0:n1");
    w.bits[0] = 1u << 0x19;
    fw_obs3d_fmt_layers(buf, sizeof buf, 2, w.cam);
    CHECK_STR(buf, "obs3d layers f=2 0x19:m0:n1");
}

TEST(item_and_globals_lines) {
    char buf[1024];
    double xz[2] = { 3.5, 7.5 };
    int r = 0;
    fw_obs3d_fmt_item(buf, sizeof buf, 1, 0x19, &r, xz, VP);
    CHECK(strncmp(buf, "obs3d item f=1 layer=0x19 rnd=", 30) == 0);
    CHECK(strstr(buf, " pos=(3.5 7.5) screen=[60 0 0 0 0 -60 0 0 0 0 1 0 640 360 0 1]") != NULL);
    float iso[16] = { 0.894427f, 0.447214f, 0, 0, 0, 1, 0, 0, -0.894427f, 0.447214f, 1, 0, 0, 0, 0, 1 };
    fw_obs3d_fmt_globals(buf, sizeof buf, iso, NULL, 0x9, 0, 2.0f, 1);
    CHECK(strncmp(buf, "obs3d globals iso=[0.894427 0.447214 0 0 0 1 0 0 -0.894427 0.447214 1 0 0 0 0 1] isoinv=[0 0", 92) == 0);
    CHECK(strstr(buf, "] flags=0x9 cull=0 depthbias=2 stacktop=1") != NULL);
}

TEST(app_line_reads_the_clear_bytes_the_antialias_setting_and_the_main_rt_samples) {
    static unsigned char app[0x1000];
    _Static_assert(OFF_APP_ANTIALIAS + 4 <= sizeof app && OFF_APP_MAIN_RT + OFF_RT_SAMPLES + 4 <= sizeof app, "app fake too small");
    memset(app, 0, sizeof app);
    app[OFF_APP_CLEAR_COLOR] = 1; app[OFF_APP_CLEAR_DEPTH] = 1; app[OFF_APP_CLEAR_STENCIL] = 0;
    *(int32_t *)(app + OFF_APP_ANTIALIAS) = 4;
    *(int32_t *)(app + OFF_APP_MAIN_RT + OFF_RT_SAMPLES) = 4;
    char buf[128];
    fw_obs3d_fmt_app(buf, sizeof buf, app);
    CHECK_STR(buf, "obs3d app clear=110 antialias=4 samples=4");
    fw_obs3d_fmt_app(buf, sizeof buf, NULL);
    CHECK_STR(buf, "obs3d app none");
}

TEST(formats_truncate_to_a_terminated_prefix) {
    World w; make_world(&w);
    char small[24];
    memset(small, 'x', sizeof small);
    int n = fw_obs3d_fmt_camera(small, sizeof small, 7, w.cam, 1, VP);
    CHECK_EQ(n, (int)sizeof small - 1);
    CHECK_EQ(small[sizeof small - 1], 0);
    CHECK(strncmp(small, "obs3d cam f=7 cam=", 18) == 0);
    char m[8];
    CHECK_EQ(fw_obs3d_fmt_mat(m, sizeof m, VP), 7);
    CHECK_STR(m, "[60 0 0");
    CHECK_EQ(fw_obs3d_fmt_mat(m, 0, VP), 0);
}

int main(void) { return MT_RUN_ALL(); }
