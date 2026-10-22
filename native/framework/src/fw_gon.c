/* fw_gon.c — the framework's read-only walk of the game's GonObject tree; see fw_gon.h. The walk is the harness's
 * mt_gon_get (native/mods/test-harness/src/mt_gon.c) narrowed to string values: same offsets, same plausibility
 * guards, same child_by_name / Index semantics. Plus the GON `model` value in both forms (fw_gon_model_block). */
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

/* a container's children vector: 1 ok (begin, count), -1 implausible / unreadable */
static int children(FwMemRead rd, void *u, const unsigned char *node, const unsigned char **beginOut, long *countOut) {
    const unsigned char *begin = NULL, *end = NULL;
    if (!rd(u, node + OFF_GON_CHILDREN, &begin, sizeof begin) || !rd(u, node + OFF_GON_CHILDREN_END, &end, sizeof end)) return -1;
    if (end < begin || (size_t)(end - begin) % GON_NODE_SIZE != 0 || (size_t)(end - begin) / GON_NODE_SIZE > FW_GON_MAX_CHILDREN) return -1;
    *beginOut = begin;
    *countOut = (long)((size_t)(end - begin) / GON_NODE_SIZE);
    return 1;
}

/* walk `path` from node: 1 found (*hitOut = the node), 0 missing (a scalar parent, no such child, index out of
 * range), -1 unreadable */
static int resolve(FwMemRead rd, void *u, const void *node, const char *path, const unsigned char **hitOut) {
    char name[FW_GON_TEXT];
    if (!node || !rd) return -1;
    const char *p = path ? path : "";
    const unsigned char *cur = (const unsigned char *)node;
    while (*p) {
        size_t n = 0;
        while (p[n] && p[n] != '.') n++;
        int type = 0;
        if (!rd(u, cur + OFF_GON_TYPE, &type, sizeof type)) return -1;
        if (type != FW_GON_TYPE_OBJECT && type != FW_GON_TYPE_ARRAY) return 0;   /* the parent is a scalar: no such child */
        const unsigned char *begin = NULL;
        long count = 0;
        if (children(rd, u, cur, &begin, &count) < 0) return -1;
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
    *hitOut = cur;
    return 1;
}

/* the node at path and its type: 1 found, 0 missing, -1 unreadable */
static int typed(FwMemRead rd, void *u, const void *node, const char *path, const unsigned char **hit, int *type) {
    int r = resolve(rd, u, node, path, hit);
    if (r != 1) return r;
    if (!rd(u, *hit + OFF_GON_TYPE, type, sizeof *type)) return -1;
    return 1;
}

int fw_gon_get_string(FwMemRead rd, void *u, const void *node, const char *path, char *out, size_t cap) {
    if (!out || !cap) return -1;
    out[0] = 0;
    const unsigned char *cur = NULL;
    int type = 0, r = typed(rd, u, node, path, &cur, &type);
    if (r != 1) return r;
    if (type != FW_GON_TYPE_STRING) return 0;
    if (!read_str(rd, u, cur + OFF_GON_TEXT, out, cap)) { out[0] = 0; return -1; }
    return 1;
}

int fw_gon_get_number(FwMemRead rd, void *u, const void *node, const char *path, double *out) {
    const unsigned char *cur = NULL;
    int type = 0, r;
    if (out) *out = 0;
    if (!out) return -1;
    r = typed(rd, u, node, path, &cur, &type);
    if (r != 1) return r;
    if (type != FW_GON_TYPE_NUMBER) return 0;
    return rd(u, cur + OFF_GON_DOUBLE, out, sizeof *out) ? 1 : -1;
}

int fw_gon_node_name(FwMemRead rd, void *u, const void *node, char *out, size_t cap) {
    if (!out || !cap) return -1;
    out[0] = 0;
    if (!rd || !node || !read_str(rd, u, (const unsigned char *)node + OFF_GON_NAME, out, cap)) { out[0] = 0; return -1; }
    return 1;
}

int fw_gon_model(FwMemRead rd, void *u, const void *gonEntry, char *out, size_t cap) {
    return fw_gon_get_string(rd, u, gonEntry, "graphics.model", out, cap);
}

const char *fw_gon_entry_model(const void *gonEntry) {
    static char buf[FW_GON_TEXT];
    return fw_gon_model(fw_gon_direct_read, NULL, gonEntry, buf, sizeof buf) == 1 ? buf : NULL;
}

/* ---- the GON model value, both forms ---- */
void fw_gon_model_defaults(FwGonModel *m) {
    memset(m, 0, sizeof *m);
    m->scale = 1.0;
    for (int k = 0; k < 4; k++) m->tint[k] = 1.0f;
    m->palette = -1;
    m->doubleSided = -1;
    m->hideSprite = -1;
}

/* an array of numbers at key under block into v (n in [minN, maxN]): 1 ok (*got = n), 0 missing, 2 wrong shape, -1 unreadable */
static int read_numbers(FwMemRead rd, void *u, const unsigned char *block, const char *key, double *v, int minN, int maxN, int *got) {
    const unsigned char *arr = NULL, *begin = NULL;
    int type = 0;
    long count = 0;
    int r = typed(rd, u, block, key, &arr, &type);
    if (r != 1) return r;
    if (type != FW_GON_TYPE_ARRAY) return 2;
    if (children(rd, u, arr, &begin, &count) < 0) return -1;
    if (count < minN || count > maxN) return 2;
    for (long i = 0; i < count; i++) {
        const unsigned char *it = begin + i * GON_NODE_SIZE;
        int t = 0;
        if (!rd(u, it + OFF_GON_TYPE, &t, sizeof t)) return -1;
        if (t != FW_GON_TYPE_NUMBER) return 2;
        if (!rd(u, it + OFF_GON_DOUBLE, &v[i], sizeof v[i])) return -1;
    }
    *got = (int)count;
    return 1;
}

/* a bool key: 1 ok (*b = 0/1), 0 missing, 2 not a bool, -1 unreadable */
static int read_bool(FwMemRead rd, void *u, const unsigned char *block, const char *key, int *b) {
    const unsigned char *n = NULL;
    int type = 0;
    unsigned char byte = 0;
    int r = typed(rd, u, block, key, &n, &type);
    if (r != 1) return r;
    if (type != FW_GON_TYPE_BOOL) return 2;
    if (!rd(u, n + OFF_GON_BOOL, &byte, 1)) return -1;
    *b = byte ? 1 : 0;
    return 1;
}

int fw_gon_model_block(FwMemRead rd, void *u, const void *gonEntry, FwGonModel *out) {
    if (!out) return -1;
    fw_gon_model_defaults(out);
    const unsigned char *node = NULL;
    int type = 0, r = typed(rd, u, gonEntry, "graphics.model", &node, &type);
    if (r != 1) return r;
    if (type == FW_GON_TYPE_STRING) {
        if (!read_str(rd, u, node + OFF_GON_TEXT, out->file, sizeof out->file)) { out->file[0] = 0; return -1; }
        return 1;
    }
    if (type != FW_GON_TYPE_OBJECT) return 0;
    out->isBlock = 1;
    FwGonModel m = *out;
    double d = 0;
    int n = 0;
    double v[4];
    /* file (required) */
    r = fw_gon_get_string(rd, u, node, "file", m.file, sizeof m.file);
    if (r < 0) return -1;
    if (r == 0) { out->invalid |= FW_GON_MODEL_BAD_FILE; return 0; }
    /* scale: a number > 0 */
    const unsigned char *k = NULL;
    r = typed(rd, u, node, "scale", &k, &type);
    if (r < 0) return -1;
    if (r == 1) {
        if (type == FW_GON_TYPE_NUMBER && fw_gon_get_number(rd, u, k, "", &d) == 1 && d > 0) m.scale = d;
        else m.invalid |= FW_GON_MODEL_BAD_SCALE;
    }
    /* yaw: a number */
    r = typed(rd, u, node, "yaw", &k, &type);
    if (r < 0) return -1;
    if (r == 1) {
        if (type == FW_GON_TYPE_NUMBER && fw_gon_get_number(rd, u, k, "", &d) == 1) m.yaw = d;
        else m.invalid |= FW_GON_MODEL_BAD_YAW;
    }
    /* offset: exactly 3 numbers */
    r = read_numbers(rd, u, node, "offset", v, 3, 3, &n);
    if (r < 0) return -1;
    if (r == 1) for (int i = 0; i < 3; i++) m.offset[i] = v[i];
    else if (r == 2) m.invalid |= FW_GON_MODEL_BAD_OFFSET;
    /* texture: a string */
    r = typed(rd, u, node, "texture", &k, &type);
    if (r < 0) return -1;
    if (r == 1) {
        if (type != FW_GON_TYPE_STRING) m.invalid |= FW_GON_MODEL_BAD_TEXTURE;
        else if (!read_str(rd, u, k + OFF_GON_TEXT, m.texture, sizeof m.texture)) return -1;
    }
    /* tint: 3 or 4 numbers */
    r = read_numbers(rd, u, node, "tint", v, 3, 4, &n);
    if (r < 0) return -1;
    if (r == 1) { for (int i = 0; i < n; i++) m.tint[i] = (float)v[i]; if (n == 3) m.tint[3] = 1.0f; }
    else if (r == 2) m.invalid |= FW_GON_MODEL_BAD_TINT;
    /* palette, double_sided: bools */
    int b = 0;
    r = read_bool(rd, u, node, "palette", &b);
    if (r < 0) return -1;
    if (r == 1) m.palette = b; else if (r == 2) m.invalid |= FW_GON_MODEL_BAD_PALETTE;
    r = read_bool(rd, u, node, "double_sided", &b);
    if (r < 0) return -1;
    if (r == 1) m.doubleSided = b; else if (r == 2) m.invalid |= FW_GON_MODEL_BAD_DOUBLE_SIDED;
    /* hide_sprite (M3, fw_mesh_hide.h): a bool; a bad value keeps -1, so the sprite stays */
    r = read_bool(rd, u, node, "hide_sprite", &b);
    if (r < 0) return -1;
    if (r == 1) m.hideSprite = b; else if (r == 2) m.invalid |= FW_GON_MODEL_BAD_HIDE_SPRITE;
    *out = m;
    return 1;
}

int fw_gon_model_node(FwMemRead rd, void *u, const void *node, FwGonModel *out) { (void)rd; (void)u; (void)node; if (out) fw_gon_model_defaults(out); return -9; }   /* RED STUB */
int fw_gon_children(FwMemRead rd, void *u, const void *node, const void **begin, long *count) { (void)rd; (void)u; (void)node; (void)begin; if (count) *count = -1; return -9; }   /* RED STUB */
