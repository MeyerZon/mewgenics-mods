/* Pure part of FW_Random / FW_SeedRandom (framework API v5): a splitmix64 stream and an unbiased bounded draw.
 * No windows.h, no game, no CRT rand: the framework owns ONE stream, seeded at load from the high-resolution clock
 * (varied run to run) and re-seeded by the harness `seed <N>` directive (identical run to run). Host-tested by
 * test/test_rng.c. Not thread-safe: call it on the game's main thread (turn callbacks, the harness). */
#pragma once
#include <stdint.h>

typedef struct FwRng { uint64_t state; } FwRng;

void     fw_rng_seed(FwRng *r, uint64_t seed);
uint64_t fw_rng_next64(FwRng *r);                 /* splitmix64 (Steele, Lea, Flood 2014) */
uint32_t fw_rng_below(FwRng *r, uint32_t bound);  /* uniform in [0, bound) (Lemire, unbiased); 0 when bound == 0 */
