/* fw_mesh_hide.c — `hide_sprite` (3D phase M3): the decision, the per-frame set and the wrapping per-item filter
 * (fw_mesh_hide.h). Pure, host-tested (test/test_mesh_hide.c); reads game memory only through fw_mesh_order's item
 * accessor (the generated offsets), so the tests' fake items stand in. */
#include <stdio.h>
#include <string.h>
#include "fw_mesh_hide.h"
#include "fw_mesh_order.h"

void fw_mesh_hide_reset(FwMeshHide *h) {
    if (h) memset(h, 0, sizeof *h);
}

int fw_mesh_hide_wanted(int hideSprite, int byTile, const void *renderable, int modelDrawn) {
    return hideSprite == 1 && !byTile && renderable != NULL && modelDrawn;
}

int fw_mesh_hide_has(const FwMeshHide *h, const void *renderable) {
    if (!h || !renderable) return 0;
    for (int i = 0; i < h->n; i++) if (h->rnd[i] == renderable) return 1;
    return 0;
}

int fw_mesh_hide_add(FwMeshHide *h, const void *renderable) {
    if (!h || !renderable) return 0;
    if (fw_mesh_hide_has(h, renderable)) return 1;
    if (h->n >= FW_MESH_HIDE_MAX) return 0;
    h->rnd[h->n++] = renderable;
    return 1;
}

int fw_mesh_hide_filter(void *user, void **itemRef, int *layerRef) {
    FwMeshHideFilter *f = (FwMeshHideFilter *)user;
    if (!itemRef || !layerRef) return 1;   /* Layer_Draw always passes both; nothing to decide on otherwise */
    if (!f) return 1;
    int draw = f->inner ? f->inner(f->innerUser, itemRef, layerRef) : fw_filter_call(f->prev, itemRef, layerRef);
    if (!f->set || *layerRef != f->layer || !*itemRef) return draw;
    f->set->seen++;
    if (draw && fw_mesh_hide_has(f->set, fw_mesh_order_item_renderable(*itemRef))) {
        f->set->skipped++;
        return 0;
    }
    return draw;
}

int fw_mesh_hide_fmt(char *buf, size_t n, int frame, const FwMeshHide *h) {
    if (!buf || !n) return 0;
    snprintf(buf, n, "mesh hide f=%d units=%d items=%d skipped=%d", frame, h ? h->n : 0, h ? h->seen : 0, h ? h->skipped : 0);
    return (int)strlen(buf);
}
