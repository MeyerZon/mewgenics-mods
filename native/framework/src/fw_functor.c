/* fw_functor.c — an MSVC std::function<void()> built in C (fw_functor.h). Pure, host-tested (test/test_mesh_draw.c).
 * In the DLL these are plain C functions: x64 Windows has one calling convention, `this` arrives in RCX like any first
 * argument, and `bool dealloc` in DL (read as unsigned char). */
#include <string.h>
#include "fw_functor.h"

static int g_unexpectedDeallocs;
static const char g_typeTag[] = "fw_functor";   /* what _Target_type returns (never called on the submit/replay path) */

static void *fn_copy(void *self, void *where) {
    memcpy(where, self, sizeof(FwFunctorImpl));   /* vtable + captures; owns nothing */
    return where;
}
static void fn_docall(void *self) {
    const FwFunctorImpl *impl = (const FwFunctorImpl *)self;
    if (impl->fn) impl->fn(impl->user);
}
static const void *fn_target(void *self) { (void)self; return g_typeTag; }
static void fn_delete(void *self, unsigned char dealloc) {
    (void)self;
    /* always in place (our _Copy constructs into the engine's storage, our own object lives in the caller's), so the
     * engine passes dealloc = false; nothing to free in either case — count the surprise instead */
    if (dealloc) g_unexpectedDeallocs++;
}
static void *fn_get(void *self) { return (unsigned char *)self + 8; }

static const void *const g_vtbl[FW_FUNC_SLOTS] = {
    (const void *)fn_copy,     /* 0 _Copy */
    (const void *)fn_copy,     /* 1 _Move (trivially copyable: same as copy, like the game's lambdas) */
    (const void *)fn_docall,   /* 2 _Do_call */
    (const void *)fn_target,   /* 3 _Target_type */
    (const void *)fn_delete,   /* 4 _Delete_this */
    (const void *)fn_get,      /* 5 _Get */
};

const void *const *fw_functor_vtable(void) { return g_vtbl; }

void fw_functor_make(FwStdFunction *f, FwFunctorFn fn, void *user) {
    memset(f, 0, sizeof *f);
    f->u.impl.vtbl = g_vtbl;
    f->u.impl.fn = fn;
    f->u.impl.user = user;
    f->implPtr = &f->u.impl;
}

int fw_functor_unexpected_deallocs(void) { return g_unexpectedDeallocs; }

/* ---- M2: the per-item filter (fw_functor.h) */
static const char g_filterTag[] = "fw_filter";
static void *flt_copy(void *self, void *where) { memcpy(where, self, sizeof(FwFilterImpl)); return where; }
static unsigned char flt_docall(void *self, void **itemRef, int *layerRef) {
    const FwFilterImpl *impl = (const FwFilterImpl *)self;
    return (unsigned char)(impl->fn ? impl->fn(impl->user, itemRef, layerRef) != 0 : 1);
}
static const void *flt_target(void *self) { (void)self; return g_filterTag; }
static void flt_delete(void *self, unsigned char dealloc) { (void)self; if (dealloc) g_unexpectedDeallocs++; }

static const void *const g_filterVtbl[FW_FUNC_SLOTS] = {
    (const void *)flt_copy,     /* 0 _Copy */
    (const void *)flt_copy,     /* 1 _Move */
    (const void *)flt_docall,   /* 2 _Do_call(self, Item* const&, int const&) -> bool */
    (const void *)flt_target,   /* 3 _Target_type */
    (const void *)flt_delete,   /* 4 _Delete_this */
    (const void *)fn_get,       /* 5 _Get */
};

const void *const *fw_filter_vtable(void) { return g_filterVtbl; }

void fw_filter_make(FwFilterImpl *impl, FwFilterFn fn, void *user) {
    if (!impl) return;
    impl->vtbl = g_filterVtbl;
    impl->fn = fn;
    impl->user = user;
}

int fw_filter_call(void *impl, void **itemRef, int *layerRef) {
    if (!impl) return 1;
    const void *const *vt = *(const void *const *const *)impl;
    if (!vt || !vt[FW_FUNC_SLOT_DOCALL]) return 1;
    return ((FwFuncFilterCallFn)vt[FW_FUNC_SLOT_DOCALL])(impl, itemRef, layerRef) != 0;
}
