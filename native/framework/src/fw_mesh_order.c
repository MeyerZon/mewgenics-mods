/* fw_mesh_order.c — the sprite/mesh painter-order plan (fw_mesh_order.h). Pure, host-tested (test/test_mesh_order.c).
 * Reads game memory only through the generated offsets.h macros, so the fake layer/item/camera of the tests stand in. */
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "fw_mesh_order.h"

#define AT(p, off, T) (*(T *)((const unsigned char *)(p) + (off)))

void fw_mesh_order_reset(FwMeshOrder *o) {
    if (o) memset(o, 0, sizeof *o);
}

void fw_mesh_order_set_m2(FwMeshOrder *o, int on) {
    if (o) o->m2 = on ? 1 : 0;
}

int fw_mesh_order_add(FwMeshOrder *o, double key, const void *anchor, int draw) {
    if (!o || o->n >= FW_MESH_ORDER_MAX) return -1;
    FwMeshOrderEntry *e = &o->e[o->n];
    memset(e, 0, sizeof *e);
    e->key = key;
    e->anchor = anchor;
    e->draw = draw;
    e->state = FW_MESH_ORDER_PENDING;
    e->item = -1;
    return o->n++;
}

double fw_mesh_order_tile_key(double x, double z) { return x + z; }
double fw_mesh_order_unit_key(double x, double z) { return x + z - FW_MESH_ORDER_EPS; }

/* the entries flagged in `take` -> out, farther first (descending key; ties keep the add order), marked done */
static int emit(FwMeshOrder *o, const unsigned char *take, int item, double itemKey, int *out, int cap) {
    int n = 0;
    unsigned char used[FW_MESH_ORDER_MAX];
    memset(used, 0, sizeof used);
    while (n < cap) {
        int best = -1;
        for (int i = 0; i < o->n; i++)
            if (take[i] && !used[i] && (best < 0 || o->e[i].key > o->e[best].key)) best = i;
        if (best < 0) break;
        used[best] = 1;
        o->e[best].state = FW_MESH_ORDER_DONE;
        o->e[best].item = item;
        o->e[best].itemKey = itemKey;
        out[n++] = o->e[best].draw;
    }
    if (n) o->groups++;
    return n;
}

int fw_mesh_order_before_item(FwMeshOrder *o, int index, double key, const void *renderable, int *out, int cap) {
    if (!o) return 0;
    if (o->items > 0 && key > o->lastKey + 1e-9) o->unsorted++;
    if (o->items < FW_MESH_ORDER_LOG_ITEMS) o->keys[o->items] = key;
    o->items++;
    o->lastKey = key;
    unsigned char take[FW_MESH_ORDER_MAX];
    memset(take, 0, sizeof take);
    for (int i = 0; i < o->n; i++) {
        const FwMeshOrderEntry *e = &o->e[i];
        if (e->state == FW_MESH_ORDER_DONE) continue;
        if (e->state == FW_MESH_ORDER_ARMED || e->key > key) take[i] = 1;
    }
    int n = out && cap > 0 ? emit(o, take, index, key, out, cap) : 0;
    /* arm what is attached to this item: it goes right after it, i.e. before the next item */
    if (renderable)
        for (int i = 0; i < o->n; i++)
            if (o->e[i].state == FW_MESH_ORDER_PENDING && o->e[i].anchor == renderable) o->e[i].state = FW_MESH_ORDER_ARMED;
    return n;
}

int fw_mesh_order_rest(FwMeshOrder *o, int *out, int cap) {
    if (!o || !out || cap <= 0) return 0;
    unsigned char take[FW_MESH_ORDER_MAX];
    for (int i = 0; i < o->n; i++) take[i] = o->e[i].state != FW_MESH_ORDER_DONE;
    return emit(o, take, -1, 0.0, out, cap);
}

int fw_mesh_order_filter(void *user, void **itemRef, int *layerRef) {
    FwMeshOrderFilter *f = (FwMeshOrderFilter *)user;
    if (f && f->order && layerRef && *layerRef == f->layer && itemRef && *itemRef) {
        int out[FW_MESH_ORDER_MAX];
        int n = fw_mesh_order_before_item(f->order, f->index++, fw_mesh_order_item_key(*itemRef), fw_mesh_order_item_renderable(*itemRef), out, FW_MESH_ORDER_MAX);
        if (n && f->submit) f->submit(f->ctx, out, n);
    }
    return fw_filter_call(f ? f->prev : NULL, itemRef, layerRef);
}

int fw_mesh_order_finish(FwMeshOrderFilter *f) {
    if (!f || !f->order) return 0;
    int out[FW_MESH_ORDER_MAX];
    int n = fw_mesh_order_rest(f->order, out, FW_MESH_ORDER_MAX);
    if (n && f->submit) f->submit(f->ctx, out, n);
    return n;
}

int fw_mesh_order_interleave(const void *layer) {
    return layer && AT(layer, OFF_LAYER_SORTED, uint8_t) != 0 && AT(layer, OFF_LAYER_MODE, int32_t) == 0;
}

double fw_mesh_order_item_key(const void *item) { return item ? AT(item, OFF_ITEM_KEY, double) : 0.0; }
/* the renderable is the item's first field (Layer_Draw: `mov rax,[item]; call [rax+0xa0]`) */
const void *fw_mesh_order_item_renderable(const void *item) { return item ? *(void *const *)item : NULL; }

void *fw_mesh_order_cam_filter(const void *cam) { return cam ? AT(cam, OFF_CAM_LAYER_FILTER, void *) : NULL; }
void fw_mesh_order_set_cam_filter(void *cam, void *impl) { if (cam) AT(cam, OFF_CAM_LAYER_FILTER, void *) = impl; }

/* ---- the probe hull ---- */
static int proj(const float m[16], double x, double y, double z, double out[2]) {
    double w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (w < 1e-9 && w > -1e-9) return 0;
    out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    return 1;
}
static double cross(const double *o, const double *a, const double *b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }

int fw_mesh_order_hull(const float mvp[16], const float lo[3], const float hi[3], double box[4], double *area) {
    if (!mvp || !lo || !hi) return 0;
    double p[8][2];
    for (int i = 0; i < 8; i++)
        if (!proj(mvp, (i & 1) ? hi[0] : lo[0], (i & 2) ? hi[1] : lo[1], (i & 4) ? hi[2] : lo[2], p[i])) return 0;
    /* sort by x then y (8 points: insertion sort) */
    for (int i = 1; i < 8; i++)
        for (int j = i; j > 0 && (p[j][0] < p[j - 1][0] || (p[j][0] == p[j - 1][0] && p[j][1] < p[j - 1][1])); j--) {
            double t0 = p[j][0], t1 = p[j][1];
            p[j][0] = p[j - 1][0]; p[j][1] = p[j - 1][1];
            p[j - 1][0] = t0; p[j - 1][1] = t1;
        }
    /* Andrew's monotone chain */
    double h[16][2];
    int k = 0;
    for (int i = 0; i < 8; i++) {
        while (k >= 2 && cross(h[k - 2], h[k - 1], p[i]) <= 0) k--;
        h[k][0] = p[i][0]; h[k][1] = p[i][1]; k++;
    }
    for (int i = 6, t = k + 1; i >= 0; i--) {
        while (k >= t && cross(h[k - 2], h[k - 1], p[i]) <= 0) k--;
        h[k][0] = p[i][0]; h[k][1] = p[i][1]; k++;
    }
    double a = 0;
    for (int i = 0; i + 1 < k; i++) a += h[i][0] * h[i + 1][1] - h[i + 1][0] * h[i][1];
    if (area) *area = (a < 0 ? -a : a) * 0.5;
    if (box) {
        box[0] = box[2] = p[0][0];
        box[1] = box[3] = p[0][1];
        for (int i = 1; i < 8; i++) {
            if (p[i][0] < box[0]) box[0] = p[i][0];
            if (p[i][0] > box[2]) box[2] = p[i][0];
            if (p[i][1] < box[1]) box[1] = p[i][1];
            if (p[i][1] > box[3]) box[3] = p[i][1];
        }
    }
    return 1;
}

/* ---- log lines ---- */
static void put(char *buf, size_t n, size_t *len, const char *fmt, ...) {
    if (*len + 1 >= n) return;
    va_list ap;
    va_start(ap, fmt);
    int w = vsnprintf(buf + *len, n - *len, fmt, ap);
    va_end(ap);
    if (w < 0) return;
    *len += (size_t)w;
    if (*len >= n) *len = n - 1;
}

int fw_mesh_order_fmt(char *buf, size_t n, int frame, const FwMeshOrder *o) {
    if (!buf || !n) return 0;
    size_t len = 0;
    buf[0] = 0;
    if (!o) return 0;
    put(buf, n, &len, "mesh order f=%d items=%d meshes=%d groups=%d unsorted=%d", frame, o->items, o->n, o->groups, o->unsorted);
    for (int i = 0; i < o->n; i++) {
        const FwMeshOrderEntry *e = &o->e[i];
        if (e->state == FW_MESH_ORDER_DONE && e->item >= 0) put(buf, n, &len, " | d%d key=%.3f before item %d key=%.3f", e->draw, e->key, e->item, e->itemKey);
        else if (e->state == FW_MESH_ORDER_DONE) put(buf, n, &len, " | d%d key=%.3f after the layer", e->draw, e->key);
        else put(buf, n, &len, " | d%d key=%.3f not drawn", e->draw, e->key);
    }
    return (int)len;
}

int fw_mesh_order_fmt_keys(char *buf, size_t n, int frame, const FwMeshOrder *o) {
    if (!buf || !n) return 0;
    size_t len = 0;
    buf[0] = 0;
    put(buf, n, &len, "mesh order keys f=%d", frame);
    int k = o ? (o->items < FW_MESH_ORDER_LOG_ITEMS ? o->items : FW_MESH_ORDER_LOG_ITEMS) : 0;
    for (int i = 0; i < k; i++) put(buf, n, &len, " %.3f", o->keys[i]);
    return (int)len;
}

int fw_mesh_order_fmt_item(char *buf, size_t n, int frame, int index, double key, const double xz[2]) {
    if (!buf || !n) return 0;
    size_t len = 0;
    buf[0] = 0;
    put(buf, n, &len, "mesh order item f=%d i=%d key=%.3f at=(%.2f %.2f)", frame, index, key, xz ? xz[0] : 0.0, xz ? xz[1] : 0.0);
    return (int)len;
}

int fw_mesh_order_fmt_occ(char *buf, size_t n, int frame, int col, int row, double key, const double box[4], double area) {
    if (!buf || !n) return 0;
    size_t len = 0;
    buf[0] = 0;
    static const double zero[4] = { 0, 0, 0, 0 };
    if (!box) box = zero;
    put(buf, n, &len, "mesh occ f=%d tile=(%d,%d) key=%.3f hull=(%.4f %.4f %.4f %.4f) area=%.6f", frame, col, row, key, box[0], box[1], box[2], box[3], area);
    return (int)len;
}
