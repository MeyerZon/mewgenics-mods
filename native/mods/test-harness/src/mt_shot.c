/* mt_shot.c — the raw shot file the glue writes and editor/src/core/ingame/shot.ts (decodeRawShot) reads; pure,
 * host-tested. Layout: "MTSHOT01", uint32 LE width, uint32 LE height, then height rows of width*3 RGB bytes, bottom
 * row first (glReadPixels order). */
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include "mt_pure.h"

static void put_le32(unsigned char *p, uint32_t v) {
    p[0] = (unsigned char)(v & 0xff);
    p[1] = (unsigned char)((v >> 8) & 0xff);
    p[2] = (unsigned char)((v >> 16) & 0xff);
    p[3] = (unsigned char)((v >> 24) & 0xff);
}

void mt_shot_raw_header(unsigned char out[MT_SHOT_RAW_HEADER], uint32_t w, uint32_t h) {
    memcpy(out, "MTSHOT01", 8);
    put_le32(out + 8, w);
    put_le32(out + 12, h);
}
