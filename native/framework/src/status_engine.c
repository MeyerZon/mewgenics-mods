/*
 * status_engine.c — custom status effects on top of the game's own LuckUp-style statuses.
 *
 * Model of the engine (build 1.1.21239, see docs/engine-map.md):
 *  - Every status is a C++ object: glaiel::<Name> : Status : Passive : Component, 0xF0 bytes, with a 172-slot
 *    vtable. Slots used here: 0 GetTypeName(this, std::string* out) -> out, 1 GetTypeId(), 2 IsA(this, std::string*),
 *    3 GetTypeHierarchy() -> {int ids[16]; uint64 count}, 30 OnInit, 82 ApplyStatModifiers, 170 OnStacksChanged.
 *  - Object fields: +0x38 Character*, +0x5c int stacks, +0x75 removing flag, +0xc8 applier, +0xe9 flag from apply.
 *  - Character +0x18 = Entity*. Entity +0x24 = component count (u32), +0x28 = Component** array.
 *  - apply_status (0x483120) is a 793-way if-chain on the status name; unknown names fall through. We hook its
 *    entry and build registered custom names ourselves, destroying the by-value string as the callee must.
 *  - There is a FAMILY of name-keyed status-property lookups in ConstructionHelpers.cpp (category, flags, value,
 *    stack mode, icon, is-hit-effect, and several that write results through out-pointers). Each one hashes the
 *    name and reads its own map; an unknown name logs "NO STATUS NAMED" and returns a default. One of those
 *    defaults is later used as a divisor, which is what crashed the game. We hook every such lookup and, for a
 *    registered custom name, temporarily rewrite the std::string to the template name for the duration of the
 *    call, then restore it. The lookups therefore return the template's real values and nothing divides by zero.
 *
 * A custom status = the template's vtable copied with slots 0-3 replaced (new name, new type id from Mewjector,
 * IsA that also answers to the new name, a hierarchy with the template id swapped for ours). Objects are built
 * with the template's constructor and then re-pointed to the custom vtable, so all gameplay behavior (stat
 * contribution, display, expiry) is the template's, while identity is ours. Only "LuckUp" is supported as a
 * template in this build (its constructor and vtable are pinned); others need their ctor added to the
 * bindings manifest. Every build-specific number here comes from signatures.h / offsets.h (generated).
 *
 * This file is the game-facing glue only. The logic lives in host-tested pure modules: the definition rules and
 * the name alias rewrite (fw_status_rules.c), the vtable clone + thunk bodies (fw_vtable.c), the entity/component
 * walks and the apply/merge/set-stacks writes (fw_walk.c), and the hook plan (fw_resolve.c). What stays here:
 * the HeapAlloc of a clone, the per-definition C thunks (fixed game ABI), the calls into the game (template
 * constructor, vtable slots, Status_Remove, the std::string destructor) and the Mewjector hook installs.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string.h>
#include <stdio.h>
#include "framework_internal.h"
#include "fw_vtable.h"
#include "fw_walk.h"

#define MAX_DEFS FW_STATUS_MAX_DEFS
_Static_assert(FW_STATUS_MAX_DEFS == 8, "DEF_THUNKS / THUNK_ROW below have exactly 8 rows");

typedef struct CustomStatus {
    FwStatusDef def;
    char name[64];
    uintptr_t typeId;
    void **vt;                 /* our copy of the template vtable */
    void **templateVt;
    FwTypeHierarchy hier;
    FwVtableIdentity ident;    /* what the vtable thunks answer from (name, type id, template, &hier) */
} CustomStatus;

static CustomStatus g_defs[MAX_DEFS];
static void *g_vts[MAX_DEFS];      /* g_defs[i].vt, the walks' key */
static int g_defCount = 0;
static FwStatusTable g_table;      /* the registered names; index == slot in g_defs (fw_status_rules.c) */
static int g_lkHooked = 0;

const FwStatusTable *status_engine_table(void) { return &g_table; }

/* game functions */
typedef void *(*fn_ApplyByName)(MsvcString *name, void *ctx, int stacks, void *src, void *p5, void *p6, char p7, char p8);
typedef void *(*fn_LuckUp_ctor)(void *character, void *entity, int *stacks, void **src, void **applier);
typedef void (*fn_StatusRemove)(void *status);
typedef MsvcString *(*fn_GetTypeName)(void *self, MsvcString *out);
typedef uintptr_t (*fn_GetTypeId)(void *self);
typedef FwTypeHierarchy *(*fn_GetHier)(void *self);
typedef void (*fn_OnStacksChanged)(void *self);

static fn_ApplyByName g_orig_ApplyByName;
static fn_LuckUp_ctor g_LuckUp_ctor;
static fn_StatusRemove g_StatusRemove;
static FwStringDealloc g_TidyDeallocate;
static void **g_luckUpVt;
static void *g_defaultSource;

static CustomStatus *find_def_by_string(const MsvcString *s) {
    int i = fw_status_table_find(&g_table, msvc_str(s), s->size);
    return i >= 0 ? &g_defs[i] : NULL;
}

/* ----------------------------------------------------------------------- */
/* name aliasing: for the duration of one lookup, make a custom status name */
/* read as its template name, then restore the caller's string exactly —   */
/* fw_alias_in / fw_alias_out (fw_status_rules.c, host-tested for SSO,     */
/* heap-backed and shorter-than-template names).                           */
/* ----------------------------------------------------------------------- */

/* The lookups, by argument shape. The std::string name is the first pointer arg except shape C (an out-struct
 * is returned via the first arg, so the name is second). All other arguments pass through untouched. */
typedef uint64_t (*fnA)(MsvcString *);
typedef void     (*fnB)(MsvcString *, void *, void *, uint32_t, void *, void *);
typedef void    *(*fnC)(void *, MsvcString *, char);
typedef uint64_t (*fnD)(MsvcString *, void *, void *, uint8_t);
typedef uint64_t (*fnE)(MsvcString *, void *);

/* The per-build RVAs live in BuildInfo.lkRvas (signatures.h, generated from bindings/<build>.json);
 * FW_LK_COUNT and the A-E order are fixed by the manifest's FW_LK table. */
static void *g_lk_orig[FW_LK_COUNT];

#define LKA(i) static uint64_t lk##i(MsvcString *s){ FwAliasSave sv; fw_alias_in(s,&g_table,&sv); uint64_t r=((fnA)g_lk_orig[i])(s); fw_alias_out(s,&sv); return r; }
#define LKB(i) static void     lk##i(MsvcString *s,void*a,void*b,uint32_t c,void*d,void*e){ FwAliasSave sv; fw_alias_in(s,&g_table,&sv); ((fnB)g_lk_orig[i])(s,a,b,c,d,e); fw_alias_out(s,&sv); }
#define LKC(i) static void    *lk##i(void*o,MsvcString *s,char ch){ FwAliasSave sv; fw_alias_in(s,&g_table,&sv); void*r=((fnC)g_lk_orig[i])(o,s,ch); fw_alias_out(s,&sv); return r; }
#define LKD(i) static uint64_t lk##i(MsvcString *s,void*a,void*b,uint8_t c){ FwAliasSave sv; fw_alias_in(s,&g_table,&sv); uint64_t r=((fnD)g_lk_orig[i])(s,a,b,c); fw_alias_out(s,&sv); return r; }
#define LKE(i) static uint64_t lk##i(MsvcString *s,void*a){ FwAliasSave sv; fw_alias_in(s,&g_table,&sv); uint64_t r=((fnE)g_lk_orig[i])(s,a); fw_alias_out(s,&sv); return r; }
LKA(0) LKA(1) LKA(2) LKA(3) LKA(4) LKA(5)
LKB(6) LKB(7) LKB(8) LKB(9)
LKC(10)
LKD(11)
LKE(12)
static void *const g_lk_hook[FW_LK_COUNT] = { lk0, lk1, lk2, lk3, lk4, lk5, lk6, lk7, lk8, lk9, lk10, lk11, lk12 };

/* ----------------------------------------------------------------------- */
/* per-definition vtable overrides (slots 0-3). C has no closures, so one   */
/* set of thunks per definition index; the bodies are fw_vtable.c's.       */
/* ----------------------------------------------------------------------- */
#define DEF_THUNKS(I) \
    static MsvcString *vt##I##_GetTypeName(void *self, MsvcString *out) { (void)self; return fw_vtable_get_type_name(&g_defs[I].ident, out); } \
    static uintptr_t vt##I##_GetTypeId(void *self) { (void)self; return fw_vtable_get_type_id(&g_defs[I].ident); } \
    static int vt##I##_IsA(void *self, MsvcString *name) { return fw_vtable_is_a(&g_defs[I].ident, self, name, g_TidyDeallocate); } \
    static FwTypeHierarchy *vt##I##_GetHier(void *self) { (void)self; return (FwTypeHierarchy *)fw_vtable_get_hier(&g_defs[I].ident); }
DEF_THUNKS(0) DEF_THUNKS(1) DEF_THUNKS(2) DEF_THUNKS(3) DEF_THUNKS(4) DEF_THUNKS(5) DEF_THUNKS(6) DEF_THUNKS(7)
#define THUNK_ROW(I) { (void *)vt##I##_GetTypeName, (void *)vt##I##_GetTypeId, (void *)vt##I##_IsA, (void *)vt##I##_GetHier }
static void *const g_thunks[MAX_DEFS][FW_VTABLE_PATCHED_SLOTS] = { THUNK_ROW(0), THUNK_ROW(1), THUNK_ROW(2), THUNK_ROW(3), THUNK_ROW(4), THUNK_ROW(5), THUNK_ROW(6), THUNK_ROW(7) };

/* ----------------------------------------------------------------------- */
/* construction hook: apply_status(name, ...)                               */
/* ----------------------------------------------------------------------- */
static void *hook_ApplyByName(MsvcString *name, void *ctx, int stacks, void *src, void *p5, void *p6, char p7, char p8) {
    CustomStatus *d = find_def_by_string(name);
    if (!d) return g_orig_ApplyByName(name, ctx, stacks, src, p5, p6, p7, p8);

    FwApplyResolved a;
    fw_walk_apply_resolve(ctx, src, p5, p6, g_defaultSource, &a);
    void *result = NULL;

    void *existing = fw_walk_find_status(a.character, d->vt);
    if (fw_walk_apply_merges(existing, p7)) {
        fw_walk_merge_stacks(existing, stacks, a.applier);
        if (stacks != 0) ((fn_OnStacksChanged)d->vt[VT_ONSTACKSCHANGED])(existing);
        if (*fw_walk_status_stacks(existing) == 0) g_StatusRemove(existing);
        result = existing;
        fw_log("%s: +%d stacks on existing (now %d)", d->name, stacks, *fw_walk_status_stacks(existing));
    } else {
        int st = stacks;
        void *source = a.source, *applier = a.applier;
        void *obj = g_LuckUp_ctor(a.character, a.entity, &st, &source, &applier);
        if (obj) {
            fw_walk_adopt(obj, d->vt, p7);   /* identity swap: template behavior, our name/type */
            result = obj;
            fw_log("%s: created on %p with %d stacks (obj %p)", d->name, a.character, stacks, obj);
        } else {
            fw_log("%s: template constructor returned null (target dead or invalid)", d->name);
        }
    }
    g_TidyDeallocate(name); /* by-value std::string: callee destroys */
    return result;
}

/* ----------------------------------------------------------------------- */
/* install: the status-side steps of FW_HOOK_PLAN (fw_resolve.c)            */
/* ----------------------------------------------------------------------- */
static int hook_rva(uint32_t rva, void *fn, void **tramp, int prio, const char *label) {
    if (!g_mj.InstallHook(rva, 0, fn, tramp, prio, FW_OWNER)) { fw_log("hook %s failed (rva 0x%x)", label, rva); return 0; }
    return 1;
}

static int prepare(void) {
    g_LuckUp_ctor = (fn_LuckUp_ctor)g_sym[FW_SYM_LuckUp_ctor];
    g_StatusRemove = (fn_StatusRemove)g_sym[FW_SYM_Status_Remove];
    g_TidyDeallocate = (FwStringDealloc)g_sym[FW_SYM_string_TidyDeallocate];
    g_luckUpVt = (void **)(g_base + g_build->rva_LuckUp_vftable);
    g_defaultSource = (void *)(g_base + g_build->rva_DefaultStatusSource);

    MsvcString nm = {{{0}}, 0, 15};
    ((fn_GetTypeName)g_luckUpVt[VT_GETTYPENAME])(NULL, &nm);
    uintptr_t id = ((fn_GetTypeId)g_luckUpVt[VT_GETTYPEID])(NULL);
    if (!fw_msvc_eq(&nm, FW_STATUS_TEMPLATE) || id != g_build->luckUpTypeId) {
        fw_log("LuckUp vtable sanity check failed (name '%s', id 0x%llx); custom statuses disabled", msvc_str(&nm), (unsigned long long)id);
        return 0;
    }
    return 1;
}

int status_engine_hook_step(const FwHookSpec *spec) {
    switch (spec->step) {
    case FW_HOOK_STATUS_PREPARE:
        return prepare();
    case FW_HOOK_SYMBOL:   /* the plan routes only Status_ApplyByName here */
        return hook_rva(g_sym[spec->index] - g_base, (void *)hook_ApplyByName, (void **)&g_orig_ApplyByName, spec->priority, spec->label);
    case FW_HOOK_LOOKUP:
        if (!hook_rva(g_build->lkRvas[spec->index], g_lk_hook[spec->index], &g_lk_orig[spec->index], spec->priority, spec->label)) return 0;
        g_lkHooked++;
        return 1;
    case FW_HOOK_STATUS_BARRIER:
        fw_log("status hooks: apply_status + %d/%d name lookups aliased", g_lkHooked, FW_LK_COUNT);
        return 1;
    }
    return 0;
}

/* ----------------------------------------------------------------------- */
/* registration and runtime API                                            */
/* ----------------------------------------------------------------------- */
int status_engine_register(const FwStatusDef *def) {
    if (!g_orig_ApplyByName) { fw_log("RegisterStatus: engine hooks not installed"); return 0; }
    FwStatusRule why;
    int slot = fw_status_table_add(&g_table, def, &why);   /* the rules: cap, name length, template, uniqueness */
    if (slot < 0) { fw_log("RegisterStatus(%s): %s", def && def->name ? def->name : "?", fw_status_rule_text(why)); return 0; }

    CustomStatus *d = &g_defs[slot];
    memset(d, 0, sizeof *d);
    d->def = *def;
    strncpy(d->name, def->name, sizeof d->name - 1);
    d->templateVt = g_luckUpVt;
    d->typeId = g_mj.AllocTypeIdPair(FW_OWNER);
    d->vt = (void **)HeapAlloc(GetProcessHeap(), 0, VT_SLOTS * sizeof(void *));
    if (!d->vt) { g_table.count = slot; return 0; }
    fw_vtable_clone(d->vt, g_luckUpVt, VT_SLOTS, g_thunks[slot]);

    FwTypeHierarchy *th = ((fn_GetHier)g_luckUpVt[VT_GETTYPEHIERARCHY])(NULL);
    fw_vtable_make_hier(&d->hier, th, g_build->luckUpTypeId, (int)d->typeId);
    d->ident.name = d->name; d->ident.typeId = d->typeId; d->ident.templateVt = d->templateVt; d->ident.hier = &d->hier;
    g_vts[slot] = d->vt;

    g_defCount = g_table.count;
    fw_log("RegisterStatus: %s registered (template %s, type id 0x%llx, vtable %p)", d->name, def->template_name, (unsigned long long)d->typeId, (void *)d->vt);
    return 1;
}

int status_engine_set_stacks(void *status, int value) {
    if (!status) return 0;
    void **vt = (void **)fw_walk_status_vt(status);
    if (fw_walk_vt_index(g_vts, g_defCount, vt) < 0) return 0;
    fw_walk_write_stacks(status, value);
    ((fn_OnStacksChanged)vt[VT_ONSTACKSCHANGED])(status);
    fw_walk_touch_passives(status);   /* ask the engine to recompute stats */
    if (value == 0) g_StatusRemove(status);
    return 1;
}

int status_engine_has_status(void *character, const char *statusName) {
    for (int i = 0; i < g_defCount; i++)
        if (strcmp(g_defs[i].name, statusName) == 0) return fw_walk_find_status(character, g_defs[i].vt) != NULL;
    return 0;
}

static void begin_turn_visit(int defIndex, void *component, void *character) {
    CustomStatus *d = &g_defs[defIndex];
    if (d->def.on_turn_begin) d->def.on_turn_begin(character, component, d->def.user);
}

void status_engine_on_begin_turn(void *character) {
    fw_walk_each_custom(character, g_vts, g_defCount, begin_turn_visit, character);
}
