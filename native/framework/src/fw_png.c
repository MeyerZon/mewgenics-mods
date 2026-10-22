/* fw_png.c — RED stub (the decoder lands in the green commit). */
#include <string.h>
#include "fw_png.h"
int fw_zlib_inflate(const uint8_t *src, size_t n, uint8_t *dst, size_t cap, size_t *outLen, char *why, size_t whycap) {
    (void)src; (void)n; (void)dst; (void)cap; if (outLen) *outLen = 0; if (why && whycap) why[0] = 0; return -1;
}
int fw_png_decode(const uint8_t *b, size_t len, int maxDim, FwPngImage *out, char *why, size_t whycap) {
    (void)b; (void)len; (void)maxDim; if (out) memset(out, 0, sizeof *out); if (why && whycap) why[0] = 0; return FW_PNGD_NOT_PNG;
}
void fw_png_free(FwPngImage *img) { if (img) memset(img, 0, sizeof *img); }
void fw_png_premultiply(uint8_t *rgba, size_t npixels) { (void)rgba; (void)npixels; }
