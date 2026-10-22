/* RED stub: see fw_rng.h. */
#include "fw_rng.h"

void fw_rng_seed(FwRng *r, uint64_t seed) { (void)r; (void)seed; }
uint64_t fw_rng_next64(FwRng *r) { (void)r; return 0; }
uint32_t fw_rng_below(FwRng *r, uint32_t bound) { (void)r; (void)bound; return 0; }
