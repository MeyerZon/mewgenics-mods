/* Pure parts of the phase-0 3D observer; see fw_obs3d_rules.h. No windows.h, no game calls. */
#include "fw_obs3d_rules.h"
#include <stdio.h>
#include <string.h>
#include <stdarg.h>

#define AT(p, off, T) (*(T const *)((const unsigned char *)(p) + (off)))

int fw_obs3d_budget(const char *value) {
    if (!value || !*value) return 0;
    long n = 0;
    for (const char *c = value; *c; c++) {
        if (*c < '0' || *c > '9') return 0;
        n = n * 10 + (*c - '0');
        if (n > FW_OBS3D_MAX_BUDGET) n = FW_OBS3D_MAX_BUDGET;
    }
    return (int)n;
}

int fw_obs3d_should_log(int worldFrame, int budget) {
    if (worldFrame < 1 || budget <= 0) return 0;
    return (worldFrame - 1) % FW_OBS3D_EVERY == 0 && (worldFrame - 1) / FW_OBS3D_EVERY < budget;
}

int fw_obs3d_cam_rtt(const void *cam) { return cam ? AT(cam, OFF_CAM_RTT, uint8_t) != 0 : 0; }
int fw_obs3d_cam_hdr(const void *cam) { return cam ? AT(cam, OFF_CAM_HDR, uint8_t) != 0 : 0; }
double fw_obs3d_cam_zoom(const void *cam) { return cam ? AT(cam, OFF_CAM_ZOOM, double) : 0.0; }
int fw_obs3d_cam_flip(const void *cam) { return cam ? AT(cam, OFF_CAM_ZOOM_Y, int32_t) : 0; }
void *fw_obs3d_cam_queue(const void *cam) { return cam ? AT(cam, OFF_CAM_QUEUE, void *) : NULL; }

int fw_obs3d_cam_layer_on(const void *cam, int layer) {
    if (!cam || layer < 0) return 0;
    const uint32_t *bits = AT(cam, OFF_CAM_LAYER_BITS, const uint32_t *);
    if (!bits) return 0;
    return (bits[layer >> 5] >> (layer & 31)) & 1u;
}

uint64_t fw_obs3d_cam_layer_mask(const void *cam) {
    if (!cam) return 0;
    const uint32_t *bits = AT(cam, OFF_CAM_LAYER_BITS, const uint32_t *);
    if (!bits) return 0;
    return (uint64_t)bits[0] | ((uint64_t)bits[1] << 32);
}

int fw_obs3d_is_world_camera(const void *tacticsTest, const void *cam) {
    return tacticsTest && cam && AT(tacticsTest, OFF_TT_MAIN_CAMERA, const void *) == cam;
}

int fw_obs3d_layer_count(const void *queue) {
    if (!queue) return 0;
    const unsigned char *b = AT(queue, OFF_RQ_LAYERS, const unsigned char *), *e = AT(queue, OFF_RQ_LAYERS_END, const unsigned char *);
    if (!b || e < b) return 0;
    return (int)((size_t)(e - b) / CONST_LAYER_STRIDE);
}

const void *fw_obs3d_layer(const void *queue, int i) {
    if (i < 0 || i >= fw_obs3d_layer_count(queue)) return NULL;
    return AT(queue, OFF_RQ_LAYERS, const unsigned char *) + (size_t)i * CONST_LAYER_STRIDE;
}

int fw_obs3d_layer_items(const void *layer) { return layer ? (int)AT(layer, OFF_LAYER_COUNT, uint32_t) : 0; }
int fw_obs3d_layer_mode(const void *layer) { return layer ? AT(layer, OFF_LAYER_MODE, int32_t) : 0; }

static const unsigned char *item_at(const void *layer, int k) {
    if (!layer || k < 0 || k >= fw_obs3d_layer_items(layer)) return NULL;
    const unsigned char *data = AT(layer, OFF_LAYER_ITEMS, const unsigned char *);
    return data ? data + ((size_t)k << CONST_LAYER_ITEM_SHIFT) : NULL;
}
void *fw_obs3d_item_renderable(const void *layer, int k) { const unsigned char *it = item_at(layer, k); return it ? AT(it, 0, void *) : NULL; }
void *fw_obs3d_renderer_position(const void *renderer) { return renderer ? AT(renderer, OFF_RND_POSITION, void *) : NULL; }
int fw_obs3d_is_masked_renderer_iso(const void *obj, uintptr_t vftable) { return obj && vftable && AT(obj, 0, uintptr_t) == vftable; }

void fw_obs3d_position_xz(const void *position, double out[2]) {
    if (!position) { out[0] = out[1] = 0.0; return; }
    out[0] = AT(position, OFF_POS_X, double);
    out[1] = AT(position, OFF_POS_Z, double);
}

/* append with truncation; *len tracks the would-be length capped at n-1 */
static void put(char *buf, size_t n, size_t *len, const char *fmt, ...) {
    if (*len >= n) return;
    va_list ap;
    va_start(ap, fmt);
    int w = vsnprintf(buf + *len, n - *len, fmt, ap);
    va_end(ap);
    if (w < 0) return;
    *len += (size_t)w;
    if (*len >= n) *len = n - 1;
}

static void put_mat(char *buf, size_t n, size_t *len, const float m[16]) {
    put(buf, n, len, "[");
    for (int i = 0; i < 16; i++) put(buf, n, len, i ? " %.6g" : "%.6g", m ? (double)m[i] : 0.0);
    put(buf, n, len, "]");
}

static int finish(char *buf, size_t n, size_t len) {
    if (!n) return 0;
    if (len >= n) len = n - 1;
    buf[len] = 0;
    return (int)len;
}

int fw_obs3d_fmt_mat(char *buf, size_t n, const float m[16]) {
    size_t len = 0;
    if (!n) return 0;
    buf[0] = 0;
    put_mat(buf, n, &len, m);
    return finish(buf, n, len);
}

int fw_obs3d_fmt_camera(char *buf, size_t n, int frame, const void *cam, int world, const float vp[16]) {
    size_t len = 0;
    if (!n) return 0;
    buf[0] = 0;
    put(buf, n, &len, "obs3d cam f=%d cam=%p world=%d rtt=%d hdr=%d zoom=%.6g flip=%d layers=0x%llx vp=", frame, cam, world ? 1 : 0,
        fw_obs3d_cam_rtt(cam), fw_obs3d_cam_hdr(cam), fw_obs3d_cam_zoom(cam), fw_obs3d_cam_flip(cam),
        (unsigned long long)fw_obs3d_cam_layer_mask(cam));
    put_mat(buf, n, &len, vp);
    return finish(buf, n, len);
}

int fw_obs3d_fmt_layers(char *buf, size_t n, int frame, const void *cam) {
    size_t len = 0;
    if (!n) return 0;
    buf[0] = 0;
    put(buf, n, &len, "obs3d layers f=%d", frame);
    const void *q = fw_obs3d_cam_queue(cam);
    int count = fw_obs3d_layer_count(q);
    for (int i = 0; i < count; i++) {
        const void *l = fw_obs3d_layer(q, i);
        if (!fw_obs3d_cam_layer_on(cam, i) || fw_obs3d_layer_items(l) == 0) continue;
        put(buf, n, &len, " 0x%x:m%d:n%d", i, fw_obs3d_layer_mode(l), fw_obs3d_layer_items(l));
    }
    return finish(buf, n, len);
}

int fw_obs3d_fmt_item(char *buf, size_t n, int frame, int layer, const void *renderable, const double xz[2], const float screen[16]) {
    size_t len = 0;
    if (!n) return 0;
    buf[0] = 0;
    put(buf, n, &len, "obs3d item f=%d layer=0x%x rnd=%p pos=(%.6g %.6g) screen=", frame, layer, renderable,
        xz ? xz[0] : 0.0, xz ? xz[1] : 0.0);
    put_mat(buf, n, &len, screen);
    return finish(buf, n, len);
}

int fw_obs3d_fmt_globals(char *buf, size_t n, const float *iso, const float *isoinv, uint32_t flags, int cull, float depthBias, int stackTop) {
    size_t len = 0;
    if (!n) return 0;
    buf[0] = 0;
    put(buf, n, &len, "obs3d globals iso=");
    put_mat(buf, n, &len, iso);
    put(buf, n, &len, " isoinv=");
    put_mat(buf, n, &len, isoinv);
    put(buf, n, &len, " flags=0x%x cull=%d depthbias=%.6g stacktop=%d", (unsigned)flags, cull, (double)depthBias, stackTop);
    return finish(buf, n, len);
}

int fw_obs3d_fmt_app(char *buf, size_t n, const void *app) {
    size_t len = 0;
    if (!n) return 0;
    buf[0] = 0;
    if (!app) { put(buf, n, &len, "obs3d app none"); return finish(buf, n, len); }
    const unsigned char *rt = (const unsigned char *)app + OFF_APP_MAIN_RT;
    put(buf, n, &len, "obs3d app clear=%d%d%d antialias=%d samples=%d", AT(app, OFF_APP_CLEAR_COLOR, uint8_t) != 0,
        AT(app, OFF_APP_CLEAR_DEPTH, uint8_t) != 0, AT(app, OFF_APP_CLEAR_STENCIL, uint8_t) != 0, AT(app, OFF_APP_ANTIALIAS, int32_t),
        AT(rt, OFF_RT_SAMPLES, int32_t));
    return finish(buf, n, len);
}

int fw_obs3d_first_item_layer(const void *cam, int from) {
    const void *q = fw_obs3d_cam_queue(cam);
    int count = fw_obs3d_layer_count(q);
    for (int i = from < 0 ? 0 : from; i < count; i++) {
        const void *l = fw_obs3d_layer(q, i);
        if (fw_obs3d_cam_layer_on(cam, i) && fw_obs3d_item_renderable(l, 0)) return i;
    }
    return -1;
}
