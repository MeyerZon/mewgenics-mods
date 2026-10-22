/* fw_png.c — zlib inflate + PNG decode (fw_png.h). Pure C11; every read is bounds-checked against the input and
 * every write against the output buffer. The inflate follows RFC 1951 the way zlib's reference "puff" does (canonical
 * Huffman tables as count + symbol arrays, decoded a bit at a time): slow-ish but small and easy to check — embedded
 * textures are a few KB and decoded once per model per process. Host-tested by test/test_png.c. */
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "fw_png.h"

static void say(char *why, size_t cap, const char *fmt, ...) {
    if (!why || !cap) return;
    va_list ap; va_start(ap, fmt);
    vsnprintf(why, cap, fmt, ap);
    va_end(ap);
}

/* ---------------------------------------------------------------- inflate (RFC 1951) */
typedef struct Inf {
    const uint8_t *in; size_t inLen, inPos;
    uint32_t bitBuf; int bitCnt;
    uint8_t *out; size_t outCap, outPos;
    const char *err;
} Inf;

#define MAXBITS 15
#define MAXLCODES 286
#define MAXDCODES 30
#define FIXLCODES 288
typedef struct Huff { short count[MAXBITS + 1]; short symbol[FIXLCODES]; } Huff;

/* need bits (<= 16) from the stream, LSB first; -1 on running out */
static int getbits(Inf *s, int need, uint32_t *v) {
    uint32_t val = s->bitBuf;
    while (s->bitCnt < need) {
        if (s->inPos >= s->inLen) { s->err = "the deflate stream is truncated"; return -1; }
        val |= (uint32_t)s->in[s->inPos++] << s->bitCnt;
        s->bitCnt += 8;
    }
    s->bitBuf = val >> need;
    s->bitCnt -= need;
    *v = val & ((1u << need) - 1u);
    return 0;
}

static int stored(Inf *s) {
    s->bitBuf = 0; s->bitCnt = 0;   /* to a byte boundary */
    if (s->inPos + 4 > s->inLen) { s->err = "a stored block header is truncated"; return -1; }
    unsigned len = s->in[s->inPos] | (s->in[s->inPos + 1] << 8);
    unsigned nlen = s->in[s->inPos + 2] | (s->in[s->inPos + 3] << 8);
    s->inPos += 4;
    if (len != (~nlen & 0xffffu)) { s->err = "a stored block's LEN / NLEN do not match"; return -1; }
    if (s->inPos + len > s->inLen) { s->err = "a stored block is truncated"; return -1; }
    if (s->outPos + len > s->outCap) { s->err = "more image data than the image needs"; return -1; }
    memcpy(s->out + s->outPos, s->in + s->inPos, len);
    s->inPos += len; s->outPos += len;
    return 0;
}

/* one symbol through h, canonical code read MSB-first a bit at a time; -1 on a bad code or truncation */
static int decode(Inf *s, const Huff *h) {
    int code = 0, first = 0, index = 0;
    for (int len = 1; len <= MAXBITS; len++) {
        uint32_t b;
        if (getbits(s, 1, &b) < 0) return -1;
        code |= (int)b;
        int count = h->count[len];
        if (code - count < first) return h->symbol[index + (code - first)];
        index += count;
        first += count;
        first <<= 1;
        code <<= 1;
    }
    s->err = "an invalid Huffman code";
    return -1;
}

/* builds h from n code lengths; 0 complete, > 0 incomplete, < 0 over-subscribed */
static int construct(Huff *h, const short *length, int n) {
    short offs[MAXBITS + 1];
    for (int len = 0; len <= MAXBITS; len++) h->count[len] = 0;
    for (int sym = 0; sym < n; sym++) h->count[length[sym]]++;
    if (h->count[0] == n) return 0;
    int left = 1;
    for (int len = 1; len <= MAXBITS; len++) {
        left <<= 1;
        left -= h->count[len];
        if (left < 0) return left;
    }
    offs[1] = 0;
    for (int len = 1; len < MAXBITS; len++) offs[len + 1] = (short)(offs[len] + h->count[len]);
    for (int sym = 0; sym < n; sym++) if (length[sym] != 0) h->symbol[offs[length[sym]]++] = (short)sym;
    return left;
}

static const short LBASE[29] = { 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258 };
static const short LEXT[29] = { 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0 };
static const short DBASE[30] = { 1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577 };
static const short DEXT[30] = { 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13 };

static int codes(Inf *s, const Huff *lencode, const Huff *distcode) {
    for (;;) {
        int sym = decode(s, lencode);
        if (sym < 0) return -1;
        if (sym < 256) {
            if (s->outPos >= s->outCap) { s->err = "more image data than the image needs"; return -1; }
            s->out[s->outPos++] = (uint8_t)sym;
        } else if (sym == 256) {
            return 0;
        } else {
            sym -= 257;
            if (sym >= 29) { s->err = "an invalid length symbol"; return -1; }
            uint32_t e;
            if (getbits(s, LEXT[sym], &e) < 0) return -1;
            size_t len = (size_t)LBASE[sym] + e;
            int ds = decode(s, distcode);
            if (ds < 0) return -1;
            if (ds >= 30) { s->err = "an invalid distance symbol"; return -1; }
            if (getbits(s, DEXT[ds], &e) < 0) return -1;
            size_t dist = (size_t)DBASE[ds] + e;
            if (dist > s->outPos) { s->err = "a back-reference before the start of the data"; return -1; }
            if (s->outPos + len > s->outCap) { s->err = "more image data than the image needs"; return -1; }
            for (size_t i = 0; i < len; i++, s->outPos++) s->out[s->outPos] = s->out[s->outPos - dist];
        }
    }
}

static int fixed(Inf *s) {
    static Huff lc, dc;
    static int built;
    if (!built) {
        short lengths[FIXLCODES];
        int sym = 0;
        for (; sym < 144; sym++) lengths[sym] = 8;
        for (; sym < 256; sym++) lengths[sym] = 9;
        for (; sym < 280; sym++) lengths[sym] = 7;
        for (; sym < FIXLCODES; sym++) lengths[sym] = 8;
        construct(&lc, lengths, FIXLCODES);
        for (sym = 0; sym < MAXDCODES; sym++) lengths[sym] = 5;
        construct(&dc, lengths, MAXDCODES);
        built = 1;
    }
    return codes(s, &lc, &dc);
}

static int dynamic(Inf *s) {
    static const short order[19] = { 16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15 };
    short lengths[MAXLCODES + MAXDCODES];
    Huff lc, dc;
    uint32_t v;
    if (getbits(s, 5, &v) < 0) return -1;
    int nlen = (int)v + 257;
    if (getbits(s, 5, &v) < 0) return -1;
    int ndist = (int)v + 1;
    if (getbits(s, 4, &v) < 0) return -1;
    int ncode = (int)v + 4;
    if (nlen > MAXLCODES || ndist > MAXDCODES) { s->err = "a dynamic block with too many codes"; return -1; }
    int idx;
    for (idx = 0; idx < ncode; idx++) { if (getbits(s, 3, &v) < 0) return -1; lengths[order[idx]] = (short)v; }
    for (; idx < 19; idx++) lengths[order[idx]] = 0;
    if (construct(&lc, lengths, 19) != 0) { s->err = "an incomplete code-length code"; return -1; }
    idx = 0;
    while (idx < nlen + ndist) {
        int sym = decode(s, &lc);
        if (sym < 0) return -1;
        if (sym < 16) { lengths[idx++] = (short)sym; continue; }
        short len = 0;
        int rep;
        if (sym == 16) {
            if (idx == 0) { s->err = "a repeat with no previous length"; return -1; }
            len = lengths[idx - 1];
            if (getbits(s, 2, &v) < 0) return -1;
            rep = 3 + (int)v;
        } else if (sym == 17) {
            if (getbits(s, 3, &v) < 0) return -1;
            rep = 3 + (int)v;
        } else {
            if (getbits(s, 7, &v) < 0) return -1;
            rep = 11 + (int)v;
        }
        if (idx + rep > nlen + ndist) { s->err = "too many code lengths"; return -1; }
        while (rep--) lengths[idx++] = len;
    }
    if (lengths[256] == 0) { s->err = "no end-of-block code"; return -1; }
    int err = construct(&lc, lengths, nlen);
    if (err < 0 || (err > 0 && nlen != lc.count[0] + lc.count[1])) { s->err = "an incomplete literal/length code"; return -1; }
    err = construct(&dc, lengths + nlen, ndist);
    if (err < 0 || (err > 0 && ndist != dc.count[0] + dc.count[1])) { s->err = "an incomplete distance code"; return -1; }
    return codes(s, &lc, &dc);
}

int fw_zlib_inflate(const uint8_t *src, size_t n, uint8_t *dst, size_t cap, size_t *outLen, char *why, size_t whycap) {
    if (outLen) *outLen = 0;
    if (why && whycap) why[0] = 0;
    if (!src || n < 6) { say(why, whycap, "the zlib stream is shorter than its header + checksum"); return -1; }
    unsigned cmf = src[0], flg = src[1];
    if ((cmf & 15) != 8 || (cmf >> 4) > 7) { say(why, whycap, "zlib method %u / window %u is not deflate <= 32K", cmf & 15, cmf >> 4); return -1; }
    if (((cmf << 8) | flg) % 31) { say(why, whycap, "the zlib header check (FCHECK) fails"); return -1; }
    if (flg & 0x20) { say(why, whycap, "a zlib preset dictionary is not allowed in PNG"); return -1; }
    Inf s;
    memset(&s, 0, sizeof s);
    s.in = src + 2; s.inLen = n - 2; s.out = dst; s.outCap = dst ? cap : 0;
    int last;
    do {
        uint32_t v;
        if (getbits(&s, 1, &v) < 0) goto fail;
        last = (int)v;
        if (getbits(&s, 2, &v) < 0) goto fail;
        int rc = v == 0 ? stored(&s) : v == 1 ? fixed(&s) : v == 2 ? dynamic(&s) : (s.err = "a deflate block of type 3", -1);
        if (rc < 0) goto fail;
    } while (!last);
    /* Adler-32, big-endian, on the next byte boundary */
    if (s.inPos + 4 > s.inLen) { say(why, whycap, "the zlib Adler-32 is missing (truncated)"); return -1; }
    uint32_t want = ((uint32_t)s.in[s.inPos] << 24) | ((uint32_t)s.in[s.inPos + 1] << 16) | ((uint32_t)s.in[s.inPos + 2] << 8) | s.in[s.inPos + 3];
    uint32_t a = 1, b = 0;
    for (size_t i = 0; i < s.outPos; i++) { a = (a + s.out[i]) % 65521u; b = (b + a) % 65521u; }
    if (((b << 16) | a) != want) { say(why, whycap, "the zlib Adler-32 does not match the data"); return -1; }
    if (outLen) *outLen = s.outPos;
    return 0;
fail:
    say(why, whycap, "bad deflate data: %s", s.err ? s.err : "?");
    return -1;
}

/* ---------------------------------------------------------------- PNG */
static uint32_t be32(const uint8_t *p) { return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3]; }

static uint32_t crc_table[256];
static int crc_built;
static uint32_t crc32_of(const uint8_t *p, size_t n) {
    if (!crc_built) {
        for (uint32_t i = 0; i < 256; i++) {
            uint32_t c = i;
            for (int k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320u ^ (c >> 1) : c >> 1;
            crc_table[i] = c;
        }
        crc_built = 1;
    }
    uint32_t c = 0xffffffffu;
    for (size_t i = 0; i < n; i++) c = crc_table[(c ^ p[i]) & 0xff] ^ (c >> 8);
    return c ^ 0xffffffffu;
}

static int paeth(int a, int b, int c) {
    int p = a + b - c, pa = abs(p - a), pb = abs(p - b), pc = abs(p - c);
    return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
}

void fw_png_free(FwPngImage *img) {
    if (!img) return;
    free(img->rgba);
    memset(img, 0, sizeof *img);
}

int fw_png_decode(const uint8_t *b, size_t len, int maxDim, FwPngImage *out, char *why, size_t whycap) {
    static const uint8_t sig[8] = { 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n' };
    if (why && whycap) why[0] = 0;
    if (!out) return FW_PNGD_NOMEM;
    memset(out, 0, sizeof *out);
    if (maxDim <= 0 || maxDim > 16384) maxDim = 16384;
    if (!b || len < 8 + 25 || memcmp(b, sig, 8) != 0 || be32(b + 8) != 13 || memcmp(b + 12, "IHDR", 4) != 0) {
        say(why, whycap, "not a PNG (no signature, or IHDR is not the first chunk)");
        return FW_PNGD_NOT_PNG;
    }
    uint32_t w = 0, h = 0;
    int depth = 0, ctype = 0, interlace = 0;
    const uint8_t *plte = NULL, *trns = NULL;
    uint32_t plteLen = 0, trnsLen = 0;
    size_t zcap = 0, zlen = 0;
    uint8_t *z = NULL;
    int sawIend = 0, rc = FW_PNGD_CORRUPT;
    size_t p = 8;
    while (p < len) {
        if (p + 12 > len) { say(why, whycap, "truncated at byte %zu (a chunk header)", p); goto out; }
        uint32_t cl = be32(b + p);
        const uint8_t *type = b + p + 4, *data = b + p + 8;
        if (cl > 0x7fffffffu || (size_t)cl > len - p - 12) { say(why, whycap, "the %.4s chunk at byte %zu is truncated", (const char *)type, p); goto out; }
        if (crc32_of(type, (size_t)cl + 4) != be32(data + cl)) { say(why, whycap, "the %.4s chunk's CRC does not match", (const char *)type); goto out; }
        if (!memcmp(type, "IHDR", 4)) {
            if (p != 8 || cl != 13) { say(why, whycap, "a second or malformed IHDR"); goto out; }
            w = be32(data); h = be32(data + 4); depth = data[8]; ctype = data[9]; interlace = data[12];
            if (data[10] != 0 || data[11] != 0) { rc = FW_PNGD_UNSUPPORTED; say(why, whycap, "compression / filter method %u / %u (only 0)", data[10], data[11]); goto out; }
            if (depth != 8) { rc = FW_PNGD_UNSUPPORTED; say(why, whycap, "bit depth %d (only 8-bit images are decoded; re-export as 8-bit)", depth); goto out; }
            if (ctype != 0 && ctype != 2 && ctype != 3 && ctype != 4 && ctype != 6) { rc = FW_PNGD_UNSUPPORTED; say(why, whycap, "colour type %d", ctype); goto out; }
            if (interlace != 0) { rc = FW_PNGD_UNSUPPORTED; say(why, whycap, "interlaced (Adam7) images are not decoded; re-export without interlacing"); goto out; }
            if (w == 0 || h == 0 || w > (uint32_t)maxDim || h > (uint32_t)maxDim) { rc = FW_PNGD_SIZE; say(why, whycap, "size %ux%u (1..%d per side)", w, h, maxDim); goto out; }
        } else if (!memcmp(type, "PLTE", 4)) {
            if (cl == 0 || cl % 3 || cl > 768) { say(why, whycap, "a PLTE of %u bytes", cl); goto out; }
            plte = data; plteLen = cl;
        } else if (!memcmp(type, "tRNS", 4)) {
            trns = data; trnsLen = cl;
        } else if (!memcmp(type, "IDAT", 4)) {
            if (zlen + cl > zcap) {
                size_t nc = zcap ? zcap : 4096;
                while (nc < zlen + cl) nc *= 2;
                uint8_t *nz = (uint8_t *)realloc(z, nc);
                if (!nz) { rc = FW_PNGD_NOMEM; say(why, whycap, "out of memory"); goto out; }
                z = nz; zcap = nc;
            }
            if (cl) memcpy(z + zlen, data, cl);
            zlen += cl;
        } else if (!memcmp(type, "IEND", 4)) {
            sawIend = 1;
            break;
        } else if (!(type[0] & 0x20)) {   /* an unknown CRITICAL chunk (upper-case first letter): stb_image refuses it too */
            rc = FW_PNGD_UNSUPPORTED; say(why, whycap, "an unknown critical chunk %.4s", (const char *)type); goto out;
        }
        p += 12 + (size_t)cl;
    }
    if (!sawIend) { say(why, whycap, "no IEND (truncated)"); goto out; }
    if (!zlen) { say(why, whycap, "no IDAT"); goto out; }
    if (ctype == 3 && !plte) { say(why, whycap, "a palette image without PLTE"); goto out; }
    {
        int ch = ctype == 0 ? 1 : ctype == 2 ? 3 : ctype == 3 ? 1 : ctype == 4 ? 2 : 4;
        size_t stride = (size_t)w * (size_t)ch, rawLen = (stride + 1) * (size_t)h;
        uint8_t *raw = (uint8_t *)malloc(rawLen);
        out->rgba = (uint8_t *)malloc((size_t)w * h * 4);
        uint8_t *prev = (uint8_t *)calloc(stride, 1), *cur = (uint8_t *)malloc(stride);
        if (!raw || !out->rgba || !prev || !cur) { free(raw); free(prev); free(cur); rc = FW_PNGD_NOMEM; say(why, whycap, "out of memory"); goto out; }
        size_t got = 0;
        char zwhy[128];
        if (fw_zlib_inflate(z, zlen, raw, rawLen, &got, zwhy, sizeof zwhy) < 0) { free(raw); free(prev); free(cur); say(why, whycap, "%s", zwhy); goto out; }
        if (got != rawLen) { free(raw); free(prev); free(cur); say(why, whycap, "the image data is %zu bytes, %zu expected", got, rawLen); goto out; }
        for (uint32_t y = 0; y < h; y++) {
            const uint8_t *src = raw + (size_t)y * (stride + 1);
            int f = src[0];
            src++;
            for (size_t i = 0; i < stride; i++) {
                int a = i >= (size_t)ch ? cur[i - ch] : 0, up = prev[i], c = i >= (size_t)ch ? prev[i - ch] : 0, pred;
                switch (f) {
                case 0: pred = 0; break;
                case 1: pred = a; break;
                case 2: pred = up; break;
                case 3: pred = (a + up) >> 1; break;
                case 4: pred = paeth(a, up, c); break;
                default: free(raw); free(prev); free(cur); say(why, whycap, "scanline %u has filter type %d", y, f); goto out;
                }
                cur[i] = (uint8_t)(src[i] + pred);
            }
            uint8_t *o = out->rgba + (size_t)y * w * 4;
            for (uint32_t x = 0; x < w; x++, o += 4) {
                const uint8_t *s = cur + (size_t)x * ch;
                switch (ctype) {
                case 0: o[0] = o[1] = o[2] = s[0]; o[3] = (trns && trnsLen >= 2 && trns[0] == 0 && trns[1] == s[0]) ? 0 : 255; break;
                case 2: o[0] = s[0]; o[1] = s[1]; o[2] = s[2];
                        o[3] = (trns && trnsLen >= 6 && !trns[0] && trns[1] == s[0] && !trns[2] && trns[3] == s[1] && !trns[4] && trns[5] == s[2]) ? 0 : 255; break;
                case 3:
                    if ((uint32_t)s[0] * 3 + 2 >= plteLen) { say(why, whycap, "palette index %u outside PLTE (%u entries)", s[0], plteLen / 3); free(raw); free(prev); free(cur); goto out; }
                    o[0] = plte[s[0] * 3]; o[1] = plte[s[0] * 3 + 1]; o[2] = plte[s[0] * 3 + 2];
                    o[3] = (trns && s[0] < trnsLen) ? trns[s[0]] : 255; break;
                case 4: o[0] = o[1] = o[2] = s[0]; o[3] = s[1]; break;
                default: o[0] = s[0]; o[1] = s[1]; o[2] = s[2]; o[3] = s[3]; break;
                }
            }
            uint8_t *t = prev; prev = cur; cur = t;
        }
        free(raw); free(prev); free(cur);
        out->w = (int)w; out->h = (int)h;
        rc = FW_PNGD_OK;
    }
out:
    free(z);
    if (rc != FW_PNGD_OK) fw_png_free(out);
    return rc;
}

void fw_png_premultiply(uint8_t *rgba, size_t npixels) {
    if (!rgba) return;
    for (size_t i = 0; i < npixels; i++) {
        uint8_t *p = rgba + i * 4;
        double a = (double)p[3] * 0.00392156862745098;
        p[0] = (uint8_t)(int)((double)p[0] * a);
        p[1] = (uint8_t)(int)((double)p[1] * a);
        p[2] = (uint8_t)(int)((double)p[2] * a);
    }
}
