/* Pure vtable work for a custom status (no windows.h, no game memory) so it can be unit-tested on the host
 * (test/test_vtable.c) and compiled into the DLL unchanged. status_engine.c keeps the game-facing parts: the
 * HeapAlloc of the clone, the per-slot C thunks (one row per definition, fixed game ABI) that forward here, and
 * the calls into the template's real slots.
 *
 * A custom status = the template's vtable copied into caller-supplied memory with slots 0-3 (GetTypeName,
 * GetTypeId, IsA, GetTypeHierarchy) replaced by per-definition thunks: new name, Mewjector-allocated type id, an
 * IsA that also answers to the new name, a hierarchy with the template id swapped for ours. Every slot number
 * comes from the generated offsets.h. */
#pragma once
#include <stdint.h>
#include <stddef.h>
#include "offsets.h"
#include "fw_status_rules.h"   /* MsvcString, FW_STATUS_NAME_MAX, fw_hier_rewrite */

#define FW_HIER_WORDS 16   /* GetTypeHierarchy() -> {int ids[16]; uint64 count} (docs/engine-map.md "Status effects") */
typedef struct FwTypeHierarchy { int ids[FW_HIER_WORDS]; uint64_t count; } FwTypeHierarchy;

#define FW_VTABLE_PATCHED_SLOTS 4   /* slots VT_GETTYPENAME .. VT_GETTYPEHIERARCHY */

/* One custom status as its vtable thunks see it. */
typedef struct FwVtableIdentity {
    const char *name;              /* the registered name (<= FW_STATUS_NAME_MAX bytes) */
    uintptr_t typeId;
    void *const *templateVt;       /* the template's vtable: IsA delegates to its VT_ISA slot */
    const FwTypeHierarchy *hier;   /* the rewritten hierarchy GetTypeHierarchy returns */
} FwVtableIdentity;

/* Copy `slots` pointers of templateVt into dst, then overwrite slots 0..3 with thunks[0..3].
 * Returns the number of slots written, 0 on a NULL argument or fewer than FW_VTABLE_PATCHED_SLOTS slots. */
size_t fw_vtable_clone(void **dst, void *const *templateVt, size_t slots, void *const thunks[FW_VTABLE_PATCHED_SLOTS]);

/* dst = templateHier with every fromId in ids[0..count) replaced by toId; returns the number swapped. */
int fw_vtable_make_hier(FwTypeHierarchy *dst, const FwTypeHierarchy *templateHier, uintptr_t fromId, int toId);

/* Thunk bodies (the game ABI wrappers in status_engine.c call these). */
typedef void (*FwStringDealloc)(MsvcString *);          /* std::string::_Tidy_deallocate */
typedef int (*FwIsAFn)(void *self, MsvcString *name);    /* the template's slot VT_ISA */
MsvcString *fw_vtable_get_type_name(const FwVtableIdentity *id, MsvcString *out);   /* constructs `out` as an SSO string */
uintptr_t   fw_vtable_get_type_id(const FwVtableIdentity *id);
/* 1 and destroys `name` (by-value std::string, callee destroys) when it is our name; otherwise the template's answer */
int         fw_vtable_is_a(const FwVtableIdentity *id, void *self, MsvcString *name, FwStringDealloc dealloc);
const FwTypeHierarchy *fw_vtable_get_hier(const FwVtableIdentity *id);

/* MSVC std::string helpers: construct an SSO string (text truncated to FW_STATUS_NAME_MAX), exact compare. */
void fw_msvc_init_sso(MsvcString *s, const char *text);
int  fw_msvc_eq(const MsvcString *s, const char *lit);
