/* Host-side tests for a unit model's facing (src/fw_unit_face.c, 3D phase M3 `face`): the direction read from
 * Character+OFF_CH_ORIENTATION (the GENERATED offsets.h) through a guarded fake reader; the yaw of every grid
 * direction (the four the game stores, the diagonals, (0,0)); the sprite-mirror fallback; the rotation matrix on
 * points (front vs back visibly different, the same convention as the GON block's yaw); the log line. No windows.h. */
#define FW_NO_WINDOWS
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <math.h>
#include "../../test/minitest.h"
#include "fw_unit_face.h"
#include "fw_unit_model.h"

static unsigned char body[0x400];
static int fake_read(void *u, const void *addr, void *out, size_t n) {
    (void)u;
    const unsigned char *p = (const unsigned char *)addr;
    if (!p || !n || p < body || p + n > body + sizeof body) return 0;
    memcpy(out, p, n);
    return 1;
}
static int near(double a, double b) { return fabs(a - b) < 1e-9; }
static int nearf(float a, float b) { return fabsf(a - b) < 1e-6f; }
/* apply a column-major 4x4 to (x, h, z, 1) */
static void apply(const float m[16], const double p[3], double out[3]) {
    for (int r = 0; r < 3; r++) out[r] = m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r];
}

TEST(orientation_offset_is_the_manifest_value) {
#ifdef OFF_CH_ORIENTATION
    CHECK_EQ(OFF_CH_ORIENTATION, 0x388);
#else
    CHECK(!"offsets.h carries OFF_CH_ORIENTATION (manifest entry Character_orientation)");
#endif
}

TEST(read_dir_from_the_character) {
#ifdef OFF_CH_ORIENTATION
    int dir[2] = { 9, 9 };
    const int32_t v[2] = { 1, 0 };
    memset(body, 0, sizeof body);
    memcpy(body + OFF_CH_ORIENTATION, v, sizeof v);
    CHECK_EQ(fw_face_read_dir(fake_read, NULL, body, dir), 1);
    CHECK_EQ(dir[0], 1); CHECK_EQ(dir[1], 0);
    const int32_t w[2] = { 0, -1 };
    memcpy(body + OFF_CH_ORIENTATION, w, sizeof w);
    CHECK_EQ(fw_face_read_dir(fake_read, NULL, body, dir), 1);
    CHECK_EQ(dir[0], 0); CHECK_EQ(dir[1], -1);
    memset(body + OFF_CH_ORIENTATION, 0, 8);                       /* never faced */
    dir[0] = dir[1] = 9;
    CHECK_EQ(fw_face_read_dir(fake_read, NULL, body, dir), 0);
    CHECK_EQ(dir[0], 0); CHECK_EQ(dir[1], 0);
    dir[0] = dir[1] = 9;
    CHECK_EQ(fw_face_read_dir(fake_read, NULL, body + sizeof body, dir), -1);   /* unreadable */
    CHECK_EQ(dir[0], 0); CHECK_EQ(dir[1], 0);
    CHECK_EQ(fw_face_read_dir(fake_read, NULL, NULL, dir), -1);
#else
    (void)fake_read;
    CHECK(!"offsets.h carries OFF_CH_ORIENTATION");
#endif
}

TEST(yaw_of_the_four_stored_directions_and_the_diagonals) {
    double y = -1;
    /* (0,-1) F unmirrored = the model's front to the lower right = yaw 0; then clockwise on screen */
    const int d[8][2] = { {0,-1}, {-1,-1}, {-1,0}, {-1,1}, {0,1}, {1,1}, {1,0}, {1,-1} };
    for (int i = 0; i < 8; i++) {
        CHECK_EQ(fw_face_yaw_deg(d[i], &y), 1);
        CHECK(near(y, 45.0 * i));
    }
    const int z[2] = { 0, 0 };
    y = 7;
    CHECK_EQ(fw_face_yaw_deg(z, &y), 0);
    CHECK(near(y, 0));
    CHECK_EQ(fw_face_yaw_deg(NULL, &y), 0);
    const int big[2] = { 0, -5 };                                  /* only the direction counts */
    CHECK_EQ(fw_face_yaw_deg(big, &y), 1);
    CHECK(near(y, 0));
}

TEST(yaw_falls_back_to_the_sprite_mirror) {
    const int back[2] = { 1, 0 };
    int src = 0;
    CHECK(near(fw_face_yaw(1, back, -1, &src), 270));             /* the direction wins over the mirror */
    CHECK_EQ(src, FW_FACE_SRC_DIR);
    CHECK(near(fw_face_yaw(0, back, -1, &src), 90));              /* unreadable: mirrored sprite = dir (-1,0) */
    CHECK_EQ(src, FW_FACE_SRC_FLIP);
    CHECK(near(fw_face_yaw(-1, NULL, 1, &src), 0));
    CHECK_EQ(src, FW_FACE_SRC_FLIP);
    CHECK(near(fw_face_yaw(1, NULL, 1, NULL), 0));                 /* dirOk without a dir: fallback, no crash */
}

TEST(rotation_turns_the_model_front_to_the_facing_direction) {
    /* the model's front after the loaders' z mirror: world -z */
    const double front[3] = { 0, 0, -1 };
    const int d[4][2] = { {0,-1}, {-1,0}, {0,1}, {1,0} };
    for (int i = 0; i < 4; i++) {
        double yaw, p[3];
        float m[16];
        fw_face_yaw_deg(d[i], &yaw);
        fw_face_rotation(yaw, m);
        apply(m, front, p);
        CHECK(near(p[0], d[i][0])); CHECK(near(p[1], 0)); CHECK(near(p[2], d[i][1]));
    }
    /* exact multiples of 90: entries are 0 / +-1 exactly */
    float m[16];
    fw_face_rotation(270, m);
    const float want[16] = { 0,0,1,0, 0,1,0,0, -1,0,0,0, 0,0,0,1 };
    for (int k = 0; k < 16; k++) CHECK(m[k] == want[k]);
    /* front vs back: a nose at +0.5 in front of the model lands on opposite sides of the anchor */
    const double nose[3] = { 0, 0, -0.5 };
    double a[3], b[3];
    fw_face_rotation(0, m);   apply(m, nose, a);
    fw_face_rotation(270, m); apply(m, nose, b);
    CHECK(near(a[2], -0.5) && near(a[0], 0));
    CHECK(near(b[0], 0.5) && near(b[2], 0));
}

TEST(rotation_matches_the_gon_block_yaw) {
    /* fw_unit_model_transform(1, yaw, NULL) is the GON block's Ry: one convention for both */
    for (int deg = 0; deg < 360; deg += 45) {
        float a[16], b[16];
        fw_face_rotation(deg, a);
        fw_unit_model_transform(1.0, deg, NULL, b);
        for (int k = 0; k < 16; k++) CHECK(nearf(a[k], b[k]));
    }
}

TEST(face_log_line) {
    char buf[160];
    const int d[2] = { 1, 0 };
    fw_face_fmt(buf, sizeof buf, "Rat", 3, d, 270, FW_FACE_SRC_DIR, 1792000000123ull);
    CHECK_STR(buf, "unit model face: Rat handle=3 dir=(1 0) yaw=270 src=dir ms=1792000000123");
    fw_face_fmt(buf, sizeof buf, NULL, 4, NULL, 90, FW_FACE_SRC_FLIP, 5);
    CHECK_STR(buf, "unit model face: ? handle=4 dir=(0 0) yaw=90 src=flip ms=5");
    char tiny[8];
    fw_face_fmt(tiny, sizeof tiny, "Rat", 3, d, 270, FW_FACE_SRC_DIR, 1);
    CHECK_EQ((int)strlen(tiny), 7);
}

int main(void) { return MT_RUN_ALL(); }
