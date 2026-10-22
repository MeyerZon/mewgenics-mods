/* fw_gon.c — the framework's read-only walk of the game's GonObject tree; see fw_gon.h. The walk is the harness's
 * mt_gon_get (native/mods/test-harness/src/mt_gon.c) narrowed to string values: same offsets, same plausibility
 * guards, same child_by_name / Index semantics. */
#include <string.h>
#include <stdlib.h>
#include "fw_gon.h"

#define FW_GON_MAX_CHILDREN 100000   /* a children vector longer than this is a misread pointer, not data */

/* an MSVC std::string: 16-byte SSO buffer or heap pointer, then size and capacity */
typedef struct FwGonMsvcString { union { char buf[16]; char *ptr; } u; size_t size, cap; } FwGonMsvcString;

int fw_gon_direct_read(void *u, const void *addr, void *out, size_t n) {
    (void)u;
    if (!addr || !out || n == 0) return 0;
    memcpy(out, addr, n);
    return 1;
}

/* an std::string in game memory -> buf (truncated); 0 when unreadable or implausible (cap < 15, size > cap, size > 4096) */
static int read_str(FwMemRead rd, void *u, const void *addr, char *buf, size_t cap) {
    FwGonMsvcString s;
    if (!cap || !rd(u, addr, &s, sizeof s)) return 0;
    if (s.cap < 15 || s.size > s.cap || s.size > 4096) return 0;
    size_t n = s.size < cap - 1 ? s.size : cap - 1;
    if (s.cap > 15) { if (n && !rd(u, s.u.ptr, buf, n)) return 0; }
    else memcpy(buf, s.u.buf, n);
    buf[n] = 0;
    return 1;
}

static int seg_is_index(const char *s, size_t n) {
    if (!n || n > 9) return 0;
    for (size_t i = 0; i < n; i++) if (s[i] < '0' || s[i] > '9') return 0;
    return 1;
}

int fw_gon_get_string(FwMemRead rd, void *u, const void *node, const char *path, char *out, size_t cap) {
    char name[FW_GON_TEXT];
    if (!out || !cap) return -1;
    out[0] = 0;
    if (!node || !rd) return -1;
    const char *p = path ? path : "";
    const unsigned char *cur = (const unsigned char *)node;
    while (*p) {
        size_t n = 0;
        while (p[n] && p[n] != '.') n++;
        int type = 0;
        if (!rd(u, cur + OFF_GON_TYPE, &type, sizeof type)) return -1;
        if (type != 3 && type != 4) return 0;                       /* the parent is a scalar: no such child */
        const unsigned char *begin = NULL, *end = NULL;
        if (!rd(u, cur + OFF_GON_CHILDREN, &begin, sizeof begin) || !rd(u, cur + OFF_GON_CHILDREN_END, &end, sizeof end)) return -1;
        if (end < begin || (size_t)(end - begin) % GON_NODE_SIZE != 0 || (size_t)(end - begin) / GON_NODE_SIZE > FW_GON_MAX_CHILDREN) return -1;
        long count = (long)((size_t)(end - begin) / GON_NODE_SIZE);
        const unsigned char *hit = NULL;
        if (seg_is_index(p, n)) {
            long idx = strtol(p, NULL, 10);
            if (idx >= count) return 0;
            hit = begin + idx * GON_NODE_SIZE;
        } else {
            for (long k = 0; k < count; k++) {
                const unsigned char *child = begin + k * GON_NODE_SIZE;
                if (!read_str(rd, u, child + OFF_GON_NAME, name, sizeof name)) return -1;
                if (strlen(name) == n && !memcmp(name, p, n)) { hit = child; break; }
            }
            if (!hit) return 0;
        }
        cur = hit;
        p += n;
        if (*p == '.') p++;
    }
    int type = 0;
    if (!rd(u, cur + OFF_GON_TYPE, &type, sizeof type)) return -1;
    if (type != FW_GON_TYPE_STRING) return 0;
    if (!read_str(rd, u, cur + OFF_GON_TEXT, out, cap)) { out[0] = 0; return -1; }
    return 1;
}

int fw_gon_model(FwMemRead rd, void *u, const void *gonEntry, char *out, size_t cap) {
    return fw_gon_get_string(rd, u, gonEntry, "graphics.model", out, cap);
}

const char *fw_gon_entry_model(const void *gonEntry) {
    static char buf[FW_GON_TEXT];
    return fw_gon_model(fw_gon_direct_read, NULL, gonEntry, buf, sizeof buf) == 1 ? buf : NULL;
}
