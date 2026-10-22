/* mt_gon.c — a read-only walk of the game's GonObject tree through a guarded reader (pure, host-tested).
 *
 * Layout: the generated offsets.h (OFF_GON_* / GON_NODE_SIZE from bindings/<build>.json, witnessed in
 * GonObject_child_by_name 0x942b50 and the logging getters; docs/engine-map.md "GON at runtime"). The walk
 * reproduces child_by_name's linear scan (the first child whose std::string at +OFF_GON_NAME equals the segment)
 * and Index's `begin + i * GON_NODE_SIZE` without calling the game: no re-entrancy, and nothing reaches the game's
 * error sink (every typed getter logs `GON ERROR … does not exist` on a miss; this never does). */
#include "mt_pure.h"
#include "offsets.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>

#define MT_GON_MAX_CHILDREN 100000   /* a children vector longer than this is a misread pointer, not data */

static const char *const STAT_NAMES[MT_STAT_COUNT] = { "strength", "dexterity", "constitution", "intelligence", "speed", "charisma", "luck" };
const char *mt_stat_name(int k) { return k >= 0 && k < MT_STAT_COUNT ? STAT_NAMES[k] : "?"; }

const char *mt_gon_type_name(int type) {
    static char other[24];
    switch (type) {
        case 0: return "null"; case 1: return "string"; case 2: return "number";
        case 3: return "object"; case 4: return "array"; case 5: return "bool";
        default: snprintf(other, sizeof other, "type %d", type); return other;
    }
}

/* an MSVC std::string in game memory -> buf; 0 when unreadable or implausible (cap < 15, size > cap, size > 4096) */
static int read_str(MtMemRead rd, void *u, const void *addr, char *buf, size_t cap) {
    MtMsvcString s;
    if (!rd(u, addr, &s, sizeof s)) return 0;
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

/* the children range of a container node; 0 when unreadable or implausible (detail filled) */
static int children_of(MtMemRead rd, void *u, const unsigned char *node, const unsigned char **begin, const unsigned char **end, long *count, int segNo, char *detail, size_t cap) {
    if (!rd(u, node + OFF_GON_CHILDREN, begin, sizeof *begin) || !rd(u, node + OFF_GON_CHILDREN_END, end, sizeof *end)) {
        snprintf(detail, cap, "unreadable children vector at segment %d", segNo);
        return 0;
    }
    if (*end < *begin || (size_t)(*end - *begin) % GON_NODE_SIZE != 0 || (size_t)(*end - *begin) / GON_NODE_SIZE > MT_GON_MAX_CHILDREN) {
        snprintf(detail, cap, "unreadable: implausible children vector at segment %d (%p..%p)", segNo, (const void *)*begin, (const void *)*end);
        return 0;
    }
    *count = (long)((size_t)(*end - *begin) / GON_NODE_SIZE);
    return 1;
}

int mt_gon_get(MtMemRead rd, void *u, const void *node, const char *path, MtGonValue *out, char *detail, size_t cap) {
    char name[MT_GON_TEXT];
    memset(out, 0, sizeof *out);
    if (detail && cap) detail[0] = 0;
    if (!node) { snprintf(detail, cap, "unreadable: no node"); return -1; }
    const char *p = path ? path : "";
    const unsigned char *cur = (const unsigned char *)node;
    int segNo = 0;
    while (*p) {
        size_t n = 0;
        while (p[n] && p[n] != '.') n++;
        segNo++;
        int type = 0;
        if (!rd(u, cur + OFF_GON_TYPE, &type, sizeof type)) { snprintf(detail, cap, "unreadable node at segment %d (\"%.*s\")", segNo, (int)n, p); return -1; }
        if (type != 3 && type != 4) { snprintf(detail, cap, "\"%.*s\": the parent is a %s, not a container", (int)n, p, mt_gon_type_name(type)); return 0; }
        const unsigned char *begin = NULL, *end = NULL;
        long count = 0;
        if (!children_of(rd, u, cur, &begin, &end, &count, segNo, detail, cap)) return -1;
        const unsigned char *hit = NULL;
        if (seg_is_index(p, n)) {
            long idx = strtol(p, NULL, 10);   /* the segment is all digits, so strtol stops at the '.' or the NUL after it */
            if (idx >= count) { snprintf(detail, cap, "index %ld out of range (%ld children) at segment %d", idx, count, segNo); return 0; }
            hit = begin + idx * GON_NODE_SIZE;
        } else {
            for (long k = 0; k < count; k++) {
                const unsigned char *child = begin + k * GON_NODE_SIZE;
                if (!read_str(rd, u, child + OFF_GON_NAME, name, sizeof name)) { snprintf(detail, cap, "unreadable child name %ld of %ld at segment %d", k, count, segNo); return -1; }
                if (strlen(name) == n && !memcmp(name, p, n)) { hit = child; break; }
            }
            if (!hit) { snprintf(detail, cap, "no child named \"%.*s\" among %ld at segment %d", (int)n, p, count, segNo); return 0; }
        }
        cur = hit;
        p += n;
        if (*p == '.') p++;
    }
    int type = 0;
    if (!rd(u, cur + OFF_GON_TYPE, &type, sizeof type)) { snprintf(detail, cap, "unreadable node (type) after segment %d", segNo); return -1; }
    out->type = type;
    rd(u, cur + OFF_GON_INT, &out->i, sizeof out->i);
    rd(u, cur + OFF_GON_DOUBLE, &out->d, sizeof out->d);
    unsigned char b = 0;
    if (rd(u, cur + OFF_GON_BOOL, &b, 1)) out->b = b != 0;
    if (!read_str(rd, u, cur + OFF_GON_TEXT, out->text, sizeof out->text)) out->text[0] = 0;
    if (type == 3 || type == 4) {
        const unsigned char *begin = NULL, *end = NULL;
        char why[80];
        long count = 0;
        if (children_of(rd, u, cur, &begin, &end, &count, segNo, why, sizeof why)) out->childCount = count;
    }
    return 1;
}
