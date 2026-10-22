/* fw_png.h — a small, bounds-checked zlib inflate + PNG decoder for the images embedded in a .glb (3D phase M3: a
 * model's own texture, design SCRATCH/mesh/importer-design.md §2.7 "v2"). Pure C11, no windows.h, no GL, no game:
 * host-tested by test/test_png.c against PNGs made by the editor's encoder (editor/src/core/art/png.ts) and Node's zlib
 * (stored / fixed / dynamic Huffman blocks, every scanline filter, every 8-bit colour type, several IDATs) and against
 * broken ones; compiled into mewframework.dll unchanged.
 *
 * Why our own decoder (not the game's): the game has no "Texture2D from bytes in memory" path. App_GetTexture 0x9bb490
 * only takes a NAME and Texture2D_LoadFromFile 0xa0ad40 reads "textures/" + name through
 * ResourceManager_GetBinaryResource (it dereferences a missing file). Its statically linked stb_image memory loader
 * (0xa7c960, called with a hand-filled stbi__context on the stack) is reachable only by rebuilding that private struct
 * and would need two new manifest entries (the loader + the CRT free for its pixels); a 400-line decoder we test on the
 * host is cheaper to keep correct across game updates than an internal-struct contract with a static library.
 *
 * Scope (refused with a reason, never read past the input): 8-bit depth only; colour types 0 grey, 2 RGB, 3 palette
 * (+ tRNS), 4 grey+alpha, 6 RGBA; no interlace (Adam7); compression / filter method 0; every chunk's CRC checked; the
 * zlib header, every deflate block and the Adler-32 checked; an unknown CRITICAL chunk refused (as stb_image does);
 * ancillary chunks skipped. Output: straight (not premultiplied) RGBA8, top row first (glTF's uv origin is the image's
 * top-left, and glTexImage2D's first row is t = 0, so uvs map unchanged). */
#pragma once
#include <stddef.h>
#include <stdint.h>

enum {
    FW_PNGD_OK = 0,
    FW_PNGD_NOT_PNG = 1,       /* no PNG signature / IHDR first */
    FW_PNGD_CORRUPT = 2,       /* truncated, a CRC / Adler-32 mismatch, a bad deflate stream, a bad filter, too little data */
    FW_PNGD_UNSUPPORTED = 3,   /* valid PNG the decoder does not do: bit depth != 8, interlaced, an unknown critical chunk */
    FW_PNGD_SIZE = 4,          /* zero-sized or a side over the maxDim cap */
    FW_PNGD_NOMEM = 5
};

/* zlib (RFC 1950) stream -> exactly the bytes it inflates to, into dst[0..cap). 0 ok (*outLen = bytes written), -1 an
 * error (why = text): a bad header (method 8, window <= 32K, FCHECK, no preset dictionary), a bad block, a code or
 * distance past the data, more output than cap, a truncated stream, an Adler-32 mismatch. */
int fw_zlib_inflate(const uint8_t *src, size_t n, uint8_t *dst, size_t cap, size_t *outLen, char *why, size_t whycap);

typedef struct FwPngImage { int w, h; uint8_t *rgba; } FwPngImage;   /* rgba: malloc'd w*h*4, straight alpha */

/* Decodes a PNG into *out (zeroed first; fw_png_free releases it). maxDim caps each side (<= 0: no cap beyond 16384).
 * Returns FW_PNGD_OK or a code with why set. */
int fw_png_decode(const uint8_t *bytes, size_t len, int maxDim, FwPngImage *out, char *why, size_t whycap);
void fw_png_free(FwPngImage *img);

/* The game's premultiply (Texture2D_LoadFromFile 0xa0ad40 on a 4-channel image, OBSERVED): every colour channel
 * c = (uint8)(int)(c * (a * 0.00392156862745098)) in double precision; alpha unchanged. So an embedded texture samples
 * exactly like one App_GetTexture loaded (fw_mesh.shader treats texels as premultiplied). */
void fw_png_premultiply(uint8_t *rgba, size_t npixels);
