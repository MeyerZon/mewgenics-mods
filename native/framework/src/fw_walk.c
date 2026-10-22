/* Pure entity/component walks and object edits; see fw_walk.h. */
#include "fw_walk.h"

void *fw_walk_find_status(void *character, const void *vt) {
    if (!character) return NULL;
    void *ent = fw_walk_char_entity(character);
    if (!ent) return NULL;
    uint32_t n = fw_walk_entity_count(ent); void **comps = fw_walk_entity_components(ent);
    for (uint32_t i = 0; i < n; i++) {
        void *c = comps[i];
        if (c && fw_walk_status_vt(c) == vt && !fw_walk_status_removing(c) && fw_walk_status_temporary(c) == 0) return c;
    }
    return NULL;
}

int fw_walk_vt_index(void *const *vts, int count, const void *vt) {
    if (!vt) return -1;
    for (int i = 0; i < count; i++) if (vts[i] == vt) return i;
    return -1;
}

int fw_walk_each_custom(void *character, void *const *vts, int count, FwWalkVisit cb, void *user) {
    if (!character || count <= 0) return 0;
    void *ent = fw_walk_char_entity(character);
    if (!ent) return 0;
    uint32_t n = fw_walk_entity_count(ent); void **comps = fw_walk_entity_components(ent);
    int visits = 0;
    for (uint32_t i = 0; i < n; i++) {
        void *c = comps[i];
        if (!c) continue;
        int d = fw_walk_vt_index(vts, count, fw_walk_status_vt(c));
        if (d >= 0 && !fw_walk_status_removing(c)) { cb(d, c, user); visits++; }
    }
    return visits;
}

void fw_walk_apply_resolve(const void *ctx, void *src, void *p5, const void *p6, void *defaultSource, FwApplyResolved *out) {
    out->character = *(void *const *)((const char *)ctx + OFF_APPLYCTX_CHARACTER);
    out->entity = *(void *const *)((const char *)ctx + OFF_APPLYCTX_ENTITY);
    out->source = src ? src : defaultSource;
    out->applier = p5 ? p5 : (p6 ? *(void *const *)((const char *)p6 + OFF_APPLYP6_APPLIER) : NULL);
}

int fw_walk_merge_stacks(void *existing, int delta, void *applier) {
    *fw_walk_status_stacks(existing) += delta;
    *(void **)((char *)existing + OFF_STATUS_APPLIER) = applier;
    *(void **)((char *)existing + OFF_STATUS_APPLIER_OWNER) = applier ? *(void **)((char *)applier + OFF_APPLIER_OWNER) : NULL;
    return *fw_walk_status_stacks(existing);
}

void fw_walk_adopt(void *obj, void **vt, char temporary) {
    *(void ***)obj = vt;
    *((char *)obj + OFF_STATUS_TEMPORARY) = temporary;
}

void fw_walk_write_stacks(void *status, int value) { *fw_walk_status_stacks(status) = value; }

int fw_walk_touch_passives(void *status) {
    void *ch = fw_walk_status_character(status);
    if (!ch) return 0;
    *((char *)ch + OFF_CH_TOUCHED_PASSIVES) = 1;
    return 1;
}
