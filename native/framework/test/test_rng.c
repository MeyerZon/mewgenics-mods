/* Host-side tests for the framework's random stream (src/fw_rng.c, behind FW_Random / FW_SeedRandom, API v5):
 * splitmix64's published first outputs, same seed -> same sequence, a re-seed restarts the stream, and the bounded
 * draw stays in range, is unbiased enough to hit every value, and never consults the CRT rand. */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "../../test/minitest.h"
#include "fw_rng.h"

TEST(splitmix64_matches_the_reference_outputs_for_seed_0) {
    FwRng r; fw_rng_seed(&r, 0);
    /* reference splitmix64 (seed 0): e220a8397b1dcdaf 6e789e6aa1b965f4 06c45d188009454f */
    CHECK(fw_rng_next64(&r) == 0xe220a8397b1dcdafULL);
    CHECK(fw_rng_next64(&r) == 0x6e789e6aa1b965f4ULL);
    CHECK(fw_rng_next64(&r) == 0x06c45d188009454fULL);
}

TEST(same_seed_gives_the_same_sequence_and_a_reseed_restarts_it) {
    FwRng a, b; fw_rng_seed(&a, 42); fw_rng_seed(&b, 42);
    uint32_t first[16];
    for (int i = 0; i < 16; i++) { first[i] = fw_rng_below(&a, 21); CHECK_EQ(fw_rng_below(&b, 21), first[i]); }
    fw_rng_seed(&a, 42);
    for (int i = 0; i < 16; i++) CHECK_EQ(fw_rng_below(&a, 21), first[i]);
}

TEST(different_seeds_give_different_sequences) {
    FwRng a, b; fw_rng_seed(&a, 42); fw_rng_seed(&b, 43);
    int same = 0;
    for (int i = 0; i < 16; i++) same += fw_rng_next64(&a) == fw_rng_next64(&b);
    CHECK_EQ(same, 0);
}

TEST(below_stays_in_range_and_hits_every_value) {
    FwRng r; fw_rng_seed(&r, 7);
    int seen[20]; memset(seen, 0, sizeof seen);
    for (int i = 0; i < 4000; i++) { uint32_t v = fw_rng_below(&r, 20); CHECK(v < 20); if (v < 20) seen[v]++; }
    for (int v = 0; v < 20; v++) CHECK(seen[v] > 100);   /* expected 200 each */
    CHECK_EQ(fw_rng_below(&r, 0), 0);
    CHECK_EQ(fw_rng_below(&r, 1), 0);
}

TEST(the_stream_ignores_the_crt_rand_state) {
    FwRng a, b; fw_rng_seed(&a, 99); fw_rng_seed(&b, 99);
    srand(1); uint64_t x = fw_rng_next64(&a);
    srand(12345); (void)rand(); uint64_t y = fw_rng_next64(&b);
    CHECK(x == y);
    CHECK(x != 0);
}

int main(void) { return MT_RUN_ALL(); }
