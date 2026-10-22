/* Host-side tests for Joker's Luck's reroll (src/jl_roll.c) driven by the framework's random stream
 * (framework/src/fw_rng.c, what FW_Random serves): two runs with the same seed give the same reroll sequence (what
 * mods/jokers-luck/tests/luck-seeded.mewtest relies on), a different seed gives another, and every reroll is a
 * non-zero value in [-10, +10]. */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "../../../test/minitest.h"
#include "fw_rng.h"
#include "jl_roll.h"

static FwRng g_rng;
static int g_draws;
static uint32_t below(uint32_t bound) { g_draws++; return fw_rng_below(&g_rng, bound); }

static void run(uint64_t seed, int *out, int n) {
    fw_rng_seed(&g_rng, seed);
    for (int i = 0; i < n; i++) out[i] = jl_reroll(below);
}

TEST(two_runs_with_the_same_seed_give_the_same_rerolls) {
    int a[12], b[12];
    run(42, a, 12);
    srand(777); (void)rand();          /* the CRT state is irrelevant */
    run(42, b, 12);
    CHECK_MEM(a, b, sizeof a);
}

TEST(a_different_seed_gives_a_different_reroll_sequence) {
    int a[12], b[12];
    run(42, a, 12); run(43, b, 12);
    CHECK(memcmp(a, b, sizeof a) != 0);
}

TEST(every_reroll_is_nonzero_in_range_and_all_twenty_values_occur) {
    int seen[21]; memset(seen, 0, sizeof seen);
    fw_rng_seed(&g_rng, 1);
    for (int i = 0; i < 4000; i++) {
        int v = jl_reroll(below);
        CHECK(v >= JL_LUCK_MIN && v <= JL_LUCK_MAX && v != 0);
        if (v >= JL_LUCK_MIN && v <= JL_LUCK_MAX) seen[v - JL_LUCK_MIN]++;
    }
    for (int v = JL_LUCK_MIN; v <= JL_LUCK_MAX; v++) if (v) CHECK(seen[v - JL_LUCK_MIN] > 100);
}

TEST(one_reroll_is_one_draw) {
    fw_rng_seed(&g_rng, 5); g_draws = 0;
    for (int i = 0; i < 50; i++) (void)jl_reroll(below);
    CHECK_EQ(g_draws, 50);
}

int main(void) { return MT_RUN_ALL(); }
