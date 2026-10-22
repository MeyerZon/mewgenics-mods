/* mt_shot.c — the raw shot file format the glue writes and editor/src/core/ingame/shot.ts reads (pure, host-tested). */
#include <stdint.h>
#include <stddef.h>
#include "mt_pure.h"

void mt_shot_raw_header(unsigned char out[MT_SHOT_RAW_HEADER], uint32_t w, uint32_t h) {
    (void)out; (void)w; (void)h;   /* red: not written yet */
}
