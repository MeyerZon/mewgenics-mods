/* MSVC release std::string / std::wstring layouts (32 bytes: SSO buffer or heap pointer,
 * size, capacity). Capacity 15 (7 for wchar) means SSO. For heap strings MSVC rounds the
 * capacity up to `len | 15` and asks the allocator for cap + 1 bytes; below 0x1000 that
 * is a plain allocation the game's _Tidy_deallocate frees with the matching deallocator. */
#include "mt_pure.h"
#include <string.h>

int mt_msvcstr_build(MtMsvcString *s, const char *text, size_t len, MtAllocFn alloc) {
    if (len > MT_MAX_CMD) return 0;
    if (len <= 15) {
        memcpy(s->u.buf, text, len);
        s->u.buf[len] = 0;
        s->size = len;
        s->cap = 15;
        return 1;
    }
    size_t cap = len | 15;
    char *p = alloc ? (char *)alloc(cap + 1) : 0;
    if (!p) return 0;
    memcpy(p, text, len);
    p[len] = 0;
    s->u.ptr = p;
    s->size = len;
    s->cap = cap;
    return 1;
}

const char *mt_msvcstr_data(const MtMsvcString *s) { return s->cap > 15 ? s->u.ptr : s->u.buf; }

size_t mt_msvcstr_copy(const MtMsvcString *s, char *out, size_t cap) {
    if (!out || cap == 0) return 0;
    size_t n = s->size < cap - 1 ? s->size : cap - 1;
    memcpy(out, mt_msvcstr_data(s), n);
    out[n] = 0;
    return n;
}

const uint16_t *mt_msvcwstr_data(const MtMsvcWString *s) { return s->cap > 7 ? s->u.ptr : s->u.buf; }

size_t mt_wstr_to_utf8(const uint16_t *w, size_t n, char *out, size_t cap) {
    size_t o = 0;
    if (cap == 0) return 0;
    for (size_t i = 0; i < n; i++) {
        uint32_t c = w[i];
        if (c >= 0xD800 && c <= 0xDBFF && i + 1 < n && w[i + 1] >= 0xDC00 && w[i + 1] <= 0xDFFF) {
            c = 0x10000 + ((c - 0xD800) << 10) + (w[i + 1] - 0xDC00);
            i++;
        }
        unsigned char enc[4];
        size_t len;
        if (c < 0x80) { enc[0] = (unsigned char)c; len = 1; }
        else if (c < 0x800) { enc[0] = (unsigned char)(0xC0 | (c >> 6)); enc[1] = (unsigned char)(0x80 | (c & 0x3F)); len = 2; }
        else if (c < 0x10000) { enc[0] = (unsigned char)(0xE0 | (c >> 12)); enc[1] = (unsigned char)(0x80 | ((c >> 6) & 0x3F)); enc[2] = (unsigned char)(0x80 | (c & 0x3F)); len = 3; }
        else { enc[0] = (unsigned char)(0xF0 | (c >> 18)); enc[1] = (unsigned char)(0x80 | ((c >> 12) & 0x3F)); enc[2] = (unsigned char)(0x80 | ((c >> 6) & 0x3F)); enc[3] = (unsigned char)(0x80 | (c & 0x3F)); len = 4; }
        if (o + len + 1 > cap) break;
        memcpy(out + o, enc, len);
        o += len;
    }
    out[o] = 0;
    return o;
}
