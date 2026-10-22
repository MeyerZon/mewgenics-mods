/* The framework's random stream (see fw_rng.h). Pure C, host-tested by test/test_rng.c. */
#include "fw_rng.h"

void fw_rng_seed(FwRng *r, uint64_t seed) { r->state = seed; }

uint64_t fw_rng_next64(FwRng *r) {
    uint64_t z = (r->state += 0x9e3779b97f4a7c15ULL);
    z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ULL;
    z = (z ^ (z >> 27)) * 0x94d049bb133111ebULL;
    return z ^ (z >> 31);
}

/* Lemire's multiply-shift with rejection of the short low range: exactly uniform over [0, bound). */
uint32_t fw_rng_below(FwRng *r, uint32_t bound) {
    if (bound == 0) return 0;
    uint64_t m = (uint64_t)(uint32_t)(fw_rng_next64(r) >> 32) * bound;
    uint32_t low = (uint32_t)m;
    if (low < bound) {
        uint32_t threshold = (uint32_t)(0u - bound) % bound;
        while (low < threshold) {
            m = (uint64_t)(uint32_t)(fw_rng_next64(r) >> 32) * bound;
            low = (uint32_t)m;
        }
    }
    return (uint32_t)(m >> 32);
}
