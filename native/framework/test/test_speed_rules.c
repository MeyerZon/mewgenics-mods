/* Host-side tests for the pure rules of the game-speed engine (src/fw_speed_rules.c): the clamp, the default (1.0 =
 * off, nothing written), multiplying what the game left in App+OFF_APP_TIMESCALE once per rendered frame, never
 * compounding the engine's own previous write, following the game's rewrites (combat_speed, hit pause, pause menu)
 * and restoring the game's base on disable. The FrameBegin hook that feeds it the live value is verified in-game (T2:
 * mods/dev-sandbox/tests/speed-*.mewtest). No windows.h, no game. */
#include <math.h>
#include <float.h>
#include "../../test/minitest.h"
#include "fw_speed_rules.h"

static int same(double a, double b) { return a == b; }
static int near(double a, double b) { return fabs(a - b) <= fabs(b) * 1e-12; }

TEST(clamp_defaults_bad_values_to_one_and_bounds_the_rest) {
    CHECK(same(fw_speed_clamp(1.0), 1.0));
    CHECK(same(fw_speed_clamp(4.0), 4.0));
    CHECK(same(fw_speed_clamp(0.5), 0.5));
    CHECK(same(fw_speed_clamp(0.0), 1.0));
    CHECK(same(fw_speed_clamp(-3.0), 1.0));
    CHECK(same(fw_speed_clamp(NAN), 1.0));
    CHECK(same(fw_speed_clamp(INFINITY), 1.0));
    CHECK(same(fw_speed_clamp(-INFINITY), 1.0));
    CHECK(same(fw_speed_clamp(1000.0), FW_SPEED_MAX));
    CHECK(same(fw_speed_clamp(0.001), FW_SPEED_MIN));
    CHECK(same(fw_speed_clamp(FW_SPEED_MAX), FW_SPEED_MAX));
    CHECK(same(fw_speed_clamp(FW_SPEED_MIN), FW_SPEED_MIN));
}

TEST(default_state_is_off_and_never_writes) {
    FwSpeedState s; fw_speed_init(&s);
    CHECK(same(s.factor, 1.0));
    CHECK_EQ(s.scaled, 0);
    double out = -1;
    CHECK_EQ(fw_speed_frame(&s, 1.0, &out), 0);
    CHECK_EQ(fw_speed_frame(&s, 2.0, &out), 0);   /* the game's combat_speed 2 passes through untouched */
    CHECK(same(out, -1));
    CHECK(same(fw_speed_set(&s, 1.0), 1.0));
    CHECK_EQ(fw_speed_frame(&s, 3.0, &out), 0);
}

TEST(set_stores_the_clamped_factor) {
    FwSpeedState s; fw_speed_init(&s);
    CHECK(same(fw_speed_set(&s, 8.0), 8.0));
    CHECK(same(s.factor, 8.0));
    CHECK(same(fw_speed_set(&s, 0.0), 1.0));
    CHECK(same(fw_speed_set(&s, 1e9), FW_SPEED_MAX));
}

TEST(scales_once_and_does_not_compound_its_own_write) {
    FwSpeedState s; fw_speed_init(&s); fw_speed_set(&s, 4.0);
    double out = 0;
    CHECK_EQ(fw_speed_frame(&s, 1.0, &out), 1);
    CHECK(near(out, 4.0));
    CHECK(out != 4.0);                             /* ulp-tagged: distinguishable from a game write of 4.0 */
    double w = out;
    /* nothing rewrote it (outside combat): the same value again, not 16 */
    CHECK_EQ(fw_speed_frame(&s, w, &out), 0);
    CHECK_EQ(fw_speed_frame(&s, w, &out), 0);
    CHECK(same(s.base, 1.0));
}

TEST(follows_the_games_rewrites_combat_speed_and_hit_pause) {
    FwSpeedState s; fw_speed_init(&s); fw_speed_set(&s, 2.0);
    double out = 0;
    CHECK_EQ(fw_speed_frame(&s, 1.0, &out), 1); CHECK(near(out, 2.0));
    /* HitPause_Update wrote combat_speed 2 during the updates: a fresh base, 2 x 2 */
    CHECK_EQ(fw_speed_frame(&s, 2.0, &out), 1); CHECK(near(out, 4.0));
    /* and keeps writing 2 every update: 4 again (never mistaken for our own write of ~2) */
    CHECK_EQ(fw_speed_frame(&s, 2.0, &out), 1); CHECK(near(out, 4.0));
    /* a hit pause: combat_speed x 0.1 */
    CHECK_EQ(fw_speed_frame(&s, 0.2, &out), 1); CHECK(near(out, 0.4));
    /* the pause menu: 1.0 */
    CHECK_EQ(fw_speed_frame(&s, 1.0, &out), 1); CHECK(near(out, 2.0));
}

TEST(changing_the_factor_rescales_the_same_base) {
    FwSpeedState s; fw_speed_init(&s); fw_speed_set(&s, 2.0);
    double out = 0;
    CHECK_EQ(fw_speed_frame(&s, 1.5, &out), 1); CHECK(near(out, 3.0));
    fw_speed_set(&s, 8.0);
    CHECK_EQ(fw_speed_frame(&s, out, &out), 1); CHECK(near(out, 12.0));   /* base 1.5 x 8, not 3 x 8 */
}

TEST(disable_restores_the_games_base_once_then_stops) {
    FwSpeedState s; fw_speed_init(&s); fw_speed_set(&s, 4.0);
    double out = 0;
    CHECK_EQ(fw_speed_frame(&s, 2.0, &out), 1);
    double w = out;
    fw_speed_set(&s, 1.0);
    CHECK_EQ(fw_speed_frame(&s, w, &out), 1);
    CHECK(same(out, 2.0));                          /* exactly the game's value back */
    CHECK_EQ(s.scaled, 0);
    CHECK_EQ(fw_speed_frame(&s, 2.0, &out), 0);
    CHECK_EQ(fw_speed_frame(&s, 1.0, &out), 0);
}

TEST(disable_after_the_game_rewrote_leaves_the_game_value) {
    FwSpeedState s; fw_speed_init(&s); fw_speed_set(&s, 4.0);
    double out = 0;
    CHECK_EQ(fw_speed_frame(&s, 1.0, &out), 1);
    fw_speed_set(&s, 1.0);
    CHECK_EQ(fw_speed_frame(&s, 3.0, &out), 0);    /* the game already wrote its own 3.0: nothing to restore */
    CHECK_EQ(s.scaled, 0);
}

TEST(non_positive_or_non_finite_current_is_left_alone) {
    FwSpeedState s; fw_speed_init(&s); fw_speed_set(&s, 4.0);
    double out = 123;
    CHECK_EQ(fw_speed_frame(&s, 0.0, &out), 0);
    CHECK_EQ(fw_speed_frame(&s, -1.0, &out), 0);
    CHECK_EQ(fw_speed_frame(&s, NAN, &out), 0);
    CHECK(same(out, 123));
    CHECK_EQ(fw_speed_frame(&s, 1.0, &out), 1); CHECK(near(out, 4.0));
}

TEST(the_written_value_stays_finite_at_the_clamp) {
    FwSpeedState s; fw_speed_init(&s); fw_speed_set(&s, FW_SPEED_MAX);
    double out = 0;
    CHECK_EQ(fw_speed_frame(&s, 4.0, &out), 1);
    CHECK(near(out, 4.0 * FW_SPEED_MAX) && isfinite(out));
    fw_speed_set(&s, FW_SPEED_MIN);
    CHECK_EQ(fw_speed_frame(&s, out, &out), 1);
    CHECK(near(out, 4.0 * FW_SPEED_MIN) && out > 0);
}

int main(void) { return MT_RUN_ALL(); }
