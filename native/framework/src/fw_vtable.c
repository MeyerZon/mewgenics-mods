/* Pure vtable work for a custom status; see fw_vtable.h. */
#include <string.h>
#include "fw_vtable.h"

size_t fw_vtable_clone(void **dst, void *const *templateVt, size_t slots, void *const thunks[FW_VTABLE_PATCHED_SLOTS]) {
    if (!dst || !templateVt || !thunks || slots < FW_VTABLE_PATCHED_SLOTS) return 0;
    memcpy(dst, templateVt, slots * sizeof(void *));
    for (size_t s = 0; s < FW_VTABLE_PATCHED_SLOTS; s++) dst[s] = thunks[s];
    return slots;
}

int fw_vtable_make_hier(FwTypeHierarchy *dst, const FwTypeHierarchy *templateHier, uintptr_t fromId, int toId) {
    *dst = *templateHier;
    return fw_hier_rewrite(dst->ids, dst->count, FW_HIER_WORDS, fromId, toId);
}

void fw_msvc_init_sso(MsvcString *s, const char *text) {
    size_t n = strlen(text);
    if (n > FW_STATUS_NAME_MAX) n = FW_STATUS_NAME_MAX;
    memcpy(s->u.buf, text, n); s->u.buf[n] = 0; s->size = n; s->cap = FW_STATUS_NAME_MAX;
}

int fw_msvc_eq(const MsvcString *s, const char *lit) {
    size_t n = strlen(lit);
    return s->size == n && memcmp(msvc_str(s), lit, n) == 0;
}

int fw_msvc_init(MsvcString *s, const char *text, FwStringAlloc alloc) {
    size_t n = strlen(text);
    if (n <= 15) {
        memcpy(s->u.buf, text, n); s->u.buf[n] = 0; s->size = n; s->cap = 15;
        return 1;
    }
    size_t cap = n | 15;
    char *p = alloc ? (char *)alloc(cap + 1) : NULL;
    if (!p) return 0;
    memcpy(p, text, n); p[n] = 0;
    s->u.ptr = p; s->size = n; s->cap = cap;
    return 1;
}

MsvcString *fw_vtable_get_type_name(const FwVtableIdentity *id, MsvcString *out) {
    fw_msvc_init_sso(out, id->name);
    return out;
}

uintptr_t fw_vtable_get_type_id(const FwVtableIdentity *id) { return id->typeId; }

int fw_vtable_is_a(const FwVtableIdentity *id, void *self, MsvcString *name, FwStringDealloc dealloc) {
    if (fw_msvc_eq(name, id->name)) { dealloc(name); return 1; }
    return ((FwIsAFn)id->templateVt[VT_ISA])(self, name);
}

const FwTypeHierarchy *fw_vtable_get_hier(const FwVtableIdentity *id) { return id->hier; }

size_t fw_vtable_clone_glow(void **dst, void *const *templateVt, size_t slots, void *const thunks[FW_VTABLE_PATCHED_SLOTS], void *applyStatMods) {
    if (!applyStatMods || slots <= VT_APPLYSTATMODIFIERS) return 0;
    if (fw_vtable_clone(dst, templateVt, slots, thunks) != slots) return 0;
    dst[VT_APPLYSTATMODIFIERS] = applyStatMods;
    return slots;
}
