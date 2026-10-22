/* Host-side tests for the per-unit model rules (src/fw_unit_model.c, 3D phase M2 item 4): the fight's units walk over
 * fake TurnControl / Scene / EntityManager / RefArray memory laid out by the GENERATED offsets.h only, through a
 * guarded fake reader (unmapped pointers refused); the seen set (one look per Character and pool generation); the block
 * transform T(offset) x Ry(yaw) x S(scale) checked on points; the facing sign from a screen matrix; the log line.
 * No windows.h, no game. */
#define FW_NO_WINDOWS
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdio.h>
#include <math.h>
#include "../../test/minitest.h"
#include "fw_unit_model.h"

/* ---- fake memory: a few buffers the reader accepts ---- */
static unsigned char tc[0x200], scene[0x100], em[0x100], xobj[OFF_X_CHARARRAY + 0x10], arr[0x40];
static void *chars[8];
static unsigned char charBodies[8][16];
static int in(const void *a, size_t n, const void *buf, size_t size) {
    const unsigned char *p = (const unsigned char *)a, *b = (const unsigned char *)buf;
    return p >= b && p + n <= b + size;
}
static int fake_read(void *u, const void *addr, void *out, size_t n) {
    (void)u;
    if (!addr || !n) return 0;
    if (in(addr, n, tc, sizeof tc) || in(addr, n, scene, sizeof scene) || in(addr, n, em, sizeof em) ||
        in(addr, n, xobj, sizeof xobj) || in(addr, n, arr, sizeof arr) || in(addr, n, chars, sizeof chars)) {
        memcpy(out, addr, n);
        return 1;
    }
    return 0;
}
static void put_ptr(unsigned char *base, int off, const void *p) { memcpy(base + off, &p, sizeof p); }
static void fake_fight(uint32_t count) {
    memset(tc, 0, sizeof tc); memset(scene, 0, sizeof scene); memset(em, 0, sizeof em); memset(xobj, 0, sizeof xobj); memset(arr, 0, sizeof arr);
    for (int i = 0; i < 8; i++) chars[i] = charBodies[i];
    put_ptr(tc, OFF_TC_SCENE, scene);
    put_ptr(scene, OFF_SCENE_EM, em);
    put_ptr(em, OFF_EM_X, xobj);
    put_ptr(xobj, OFF_X_CHARARRAY, arr);
    memcpy(arr + OFF_ARR_COUNT, &count, sizeof count);
    put_ptr(arr, OFF_ARR_DATA, chars);
}

TEST(walk_reads_the_character_array_through_the_harness_chain) {
    fake_fight(5);
    void *out[8] = { 0 };
    CHECK_EQ(fw_unit_walk(fake_read, NULL, tc, out, 8), 5);
    for (int i = 0; i < 5; i++) CHECK(out[i] == charBodies[i]);
    CHECK(out[5] == NULL);
    CHECK_EQ(fw_unit_walk(fake_read, NULL, tc, out, 3), 3);       /* capped by cap */
    fake_fight(0);
    CHECK_EQ(fw_unit_walk(fake_read, NULL, tc, out, 8), 0);
}

TEST(walk_refuses_null_unmapped_and_implausible_links) {
    void *out[8];
    CHECK_EQ(fw_unit_walk(fake_read, NULL, NULL, out, 8), 0);
    fake_fight(3);
    CHECK_EQ(fw_unit_walk(fake_read, NULL, (const void *)0x40, out, 8), -1);
    put_ptr(scene, OFF_SCENE_EM, (const void *)0x1000);             /* an unmapped EntityManager */
    CHECK_EQ(fw_unit_walk(fake_read, NULL, tc, out, 8), -1);
    fake_fight(3);
    put_ptr(em, OFF_EM_X, NULL);                                      /* a NULL link mid-chain */
    CHECK_EQ(fw_unit_walk(fake_read, NULL, tc, out, 8), -1);
    fake_fight(FW_UNIT_WALK_MAX + 1);                                 /* a count no fight has */
    CHECK_EQ(fw_unit_walk(fake_read, NULL, tc, out, 8), -1);
    fake_fight(3);
    put_ptr(arr, OFF_ARR_DATA, (const void *)0x2000);                 /* the data pointer unmapped */
    CHECK_EQ(fw_unit_walk(fake_read, NULL, tc, out, 8), -1);
}

TEST(seen_set_looks_once_per_character_and_generation) {
    FwUnitSeen s;
    fw_unit_seen_clear(&s);
    int a, b;
    CHECK_EQ(fw_unit_seen_first(&s, &a, 1), 1);
    CHECK_EQ(fw_unit_seen_first(&s, &a, 1), 0);
    CHECK_EQ(fw_unit_seen_first(&s, &b, 1), 1);
    CHECK_EQ(fw_unit_seen_first(&s, &a, 2), 1);                      /* the pool slot was reused: a new unit */
    CHECK_EQ(fw_unit_seen_first(&s, &a, 2), 0);
    CHECK_EQ(s.n, 2);
    CHECK_EQ(fw_unit_seen_first(&s, NULL, 0), 0);                    /* NULL is never a unit */
    fw_unit_seen_clear(&s);
    CHECK_EQ(fw_unit_seen_first(&s, &a, 2), 1);
}

TEST(seen_set_starts_over_when_full) {
    static FwUnitSeen s;
    static char many[FW_UNIT_SEEN_MAX + 1];
    fw_unit_seen_clear(&s);
    for (int i = 0; i < FW_UNIT_SEEN_MAX; i++) CHECK_EQ(fw_unit_seen_first(&s, &many[i], 1), 1);
    CHECK_EQ(s.n, FW_UNIT_SEEN_MAX);
    CHECK_EQ(fw_unit_seen_first(&s, &many[FW_UNIT_SEEN_MAX], 1), 1);
    CHECK_EQ(s.n, 1);
    CHECK_EQ(fw_unit_seen_first(&s, &many[0], 1), 1);               /* looked at once more after the reset */
}

static void apply(const float m[16], const float p[3], float out[3]) {
    for (int r = 0; r < 3; r++) out[r] = m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r];
}
static int near3(const float a[3], float x, float y, float z) { return fabsf(a[0] - x) < 1e-5f && fabsf(a[1] - y) < 1e-5f && fabsf(a[2] - z) < 1e-5f; }

TEST(block_transform_is_offset_after_yaw_after_scale) {
    float m[16], q[3];
    const float front[3] = { 0, 0, -1 }, up[3] = { 0, 1, 0 }, o[3] = { 0, 0, 0 };
    fw_unit_model_transform(1.0, 0.0, NULL, m);                       /* identity */
    apply(m, front, q); CHECK(near3(q, 0, 0, -1));
    const double off[3] = { 1.0, 0.5, -1.0 };
    fw_unit_model_transform(2.0, 90.0, off, m);
    apply(m, front, q); CHECK(near3(q, -2.0f + 1.0f, 0.5f, -1.0f));   /* front (-z) -> -x at yaw 90: lower left on screen */
    apply(m, up, q); CHECK(near3(q, 1.0f, 2.5f, -1.0f));              /* height scales, yaw keeps it */
    apply(m, o, q); CHECK(near3(q, 1.0f, 0.5f, -1.0f));               /* the origin lands on the offset */
    fw_unit_model_transform(1.0, 45.0, NULL, m);
    apply(m, front, q); CHECK(near3(q, -0.70710678f, 0, -0.70710678f)); /* yaw 45: straight down on screen */
    fw_unit_model_transform(0.0, 0.0, NULL, m);                       /* scale <= 0 is taken as 1 */
    apply(m, front, q); CHECK(near3(q, 0, 0, -1));
    fw_unit_model_transform(-3.0, 0.0, NULL, m);
    apply(m, up, q); CHECK(near3(q, 0, 1, 0));
}

TEST(facing_is_the_sign_of_the_screen_matrix_x_scale) {
    float s[16] = { 0 };
    s[0] = 1.0f;  CHECK_EQ(fw_unit_facing(s), 1);
    s[0] = -1.0f; CHECK_EQ(fw_unit_facing(s), -1);
    s[0] = 0.0f;  CHECK_EQ(fw_unit_facing(s), 1);
    CHECK_EQ(fw_unit_facing(NULL), 1);
}

TEST(model_log_line_string_and_block_forms) {
    FwGonModel m;
    fw_gon_model_defaults(&m);
    snprintf(m.file, sizeof m.file, "%s", "models/crate.obj");
    char buf[256];
    void *ch = (void *)(uintptr_t)0x1234;
    int n = fw_unit_fmt_model(buf, sizeof buf, "Crate", ch, &m);
    char want[256];
    snprintf(want, sizeof want, "unit model: Crate %p -> models/crate.obj", ch);
    CHECK_STR(buf, want);
    CHECK_EQ(n, (int)strlen(want));
    m.isBlock = 1; m.scale = 1.5; m.yaw = 90; m.offset[1] = 0.25;
    snprintf(m.texture, sizeof m.texture, "%s", "models/crate.png");
    m.invalid = FW_GON_MODEL_BAD_TINT;
    fw_unit_fmt_model(buf, sizeof buf, "Rat", ch, &m);
    snprintf(want, sizeof want, "unit model: Rat %p -> models/crate.obj (block scale=1.5 yaw=90 offset=(0 0.25 0) texture=models/crate.png invalid=0x10)", ch);
    CHECK_STR(buf, want);
    char small[16];
    fw_unit_fmt_model(small, sizeof small, "Rat", ch, &m);
    CHECK_EQ((int)strlen(small), 15);                                 /* truncated, NUL-terminated */
}

TEST(position_log_line_and_move_threshold) {
    const double xz[2] = { 5.5, 3.25 };
    float s[16] = { 0 };
    s[0] = -1.0f; s[12] = 640.5f; s[13] = -321.25f;
    char buf[256];
    int n = fw_unit_fmt_at(buf, sizeof buf, "Rat", 7, xz, s, -1, 1792000000123ull);
    CHECK_STR(buf, "unit model at: Rat handle=7 world=(5.500 3.250) screen=(640.500 -321.250) facing=-1 m0=-1 ms=1792000000123");
    CHECK_EQ(n, (int)strlen(buf));
    fw_unit_fmt_at(buf, sizeof buf, "Rat", 7, xz, NULL, 1, 5);          /* no screen matrix */
    CHECK_STR(buf, "unit model at: Rat handle=7 world=(5.500 3.250) screen=(none) facing=+1 m0=0 ms=5");
    const double a[2] = { 1.0, 1.0 }, b[2] = { 1.005, 0.995 }, c[2] = { 1.0, 1.02 };
    CHECK_EQ(fw_unit_moved(NULL, a), 1);
    CHECK_EQ(fw_unit_moved(a, b), 0);
    CHECK_EQ(fw_unit_moved(a, c), 1);
}

int main(void) { return MT_RUN_ALL(); }
