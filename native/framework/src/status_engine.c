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
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string.h>
#include <stdio.h>
#include "framework_internal.h"

#define MAX_DEFS 8
#define HIER_WORDS 16

typedef struct TypeHierarchy { int ids[HIER_WORDS]; uint64_t count; } TypeHierarchy;

typedef struct CustomStatus {
    FwStatusDef def;
    char name[64];
    uintptr_t typeId;
    void **vt;                 /* our copy of the template vtable */
    void **templateVt;
    TypeHierarchy hier;
} CustomStatus;

static CustomStatus g_defs[MAX_DEFS];
static int g_defCount = 0;

/* game functions */
typedef void *(*fn_ApplyByName)(MsvcString *name, void *ctx, int stacks, void *src, void *p5, void *p6, char p7, char p8);
typedef void *(*fn_LuckUp_ctor)(void *character, void *entity, int *stacks, void **src, void **applier);
typedef void (*fn_StatusRemove)(void *status);
typedef void (*fn_TidyDeallocate)(MsvcString *s);
typedef MsvcString *(*fn_GetTypeName)(void *self, MsvcString *out);
typedef uintptr_t (*fn_GetTypeId)(void *self);
typedef int (*fn_IsA)(void *self, MsvcString *name);
typedef TypeHierarchy *(*fn_GetHier)(void *self);
typedef void (*fn_OnStacksChanged)(void *self);

static fn_ApplyByName g_orig_ApplyByName;
static fn_LuckUp_ctor g_LuckUp_ctor;
static fn_StatusRemove g_StatusRemove;
static fn_TidyDeallocate g_TidyDeallocate;
static void **g_luckUpVt;
static void *g_defaultSource;

/* ----------------------------------------------------------------------- */
/* helpers                                                                  */
/* ----------------------------------------------------------------------- */
static void msvc_set_sso(MsvcString *s, const char *text) {
    size_t n = strlen(text);
    if (n > 15) n = 15;
    if (s->cap > 15) g_TidyDeallocate(s);
    memcpy(s->u.buf, text, n); s->u.buf[n] = 0; s->size = n; s->cap = 15;
}
static int msvc_eq(const MsvcString *s, const char *lit) {
    size_t n = strlen(lit);
    return s->size == n && memcmp(msvc_str(s), lit, n) == 0;
}
static CustomStatus *find_def_by_string(const MsvcString *s) {
    for (int i = 0; i < g_defCount; i++) if (msvc_eq(s, g_defs[i].name)) return &g_defs[i];
    return NULL;
}
static CustomStatus *find_def_by_vt(void **vt) {
    for (int i = 0; i < g_defCount; i++) if (g_defs[i].vt == vt) return &g_defs[i];
    return NULL;
}
static inline void *char_entity(void *character) { return *(void **)((char *)character + OFF_CH_ENTITY); }
static inline uint32_t entity_count(void *entity) { return *(uint32_t *)((char *)entity + OFF_ENT_COMPCOUNT); }
static inline void **entity_components(void *entity) { return *(void ***)((char *)entity + OFF_ENT_COMPS); }
static inline int *status_stacks(void *st) { return (int *)((char *)st + OFF_STATUS_STACKS); }
static inline void *status_character(void *st) { return *(void **)((char *)st + OFF_STATUS_CHARACTER); }
static inline char status_removing(void *st) { return *((char *)st + OFF_STATUS_REMOVING); }

static void *find_status_on(void *character, const CustomStatus *d) {
    void *ent = char_entity(character);
    if (!ent) return NULL;
    uint32_t n = entity_count(ent); void **comps = entity_components(ent);
    for (uint32_t i = 0; i < n; i++) {
        void *c = comps[i];
        if (c && *(void ***)c == d->vt && !status_removing(c) && *((char *)c + OFF_STATUS_TEMPORARY) == 0) return c;
    }
    return NULL;
}

/* ----------------------------------------------------------------------- */
/* name aliasing: for the duration of one lookup, make a custom status name */
/* read as its template name, then restore the caller's string exactly.    */
/* Custom names and template names are both SSO (<=15 chars), so the rewrite */
/* never reallocates. We still save and restore the raw bytes in case the   */
/* caller's std::string happened to be heap-backed from reuse.              */
/* ----------------------------------------------------------------------- */
typedef struct AliasSave { int did; size_t size; char *dst; char bytes[32]; } AliasSave;

static void alias_in(MsvcString *name, AliasSave *s) {
    CustomStatus *d = find_def_by_string(name);
    if (!d) { s->did = 0; return; }
    s->did = 1;
    s->dst = (name->cap > 15) ? name->u.ptr : name->u.buf;
    s->size = name->size;
    size_t keep = s->size < 31 ? s->size : 31;
    memcpy(s->bytes, s->dst, keep); s->bytes[keep] = 0;
    size_t n = strlen(d->def.template_name);   /* "LuckUp" (6) <= our name length */
    memcpy(s->dst, d->def.template_name, n + 1);
    name->size = n;
}
static void alias_out(MsvcString *name, AliasSave *s) {
    if (!s->did) return;
    size_t keep = s->size < 31 ? s->size : 31;
    memcpy(s->dst, s->bytes, keep); s->dst[keep] = 0;
    name->size = s->size;
}

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

#define LKA(i) static uint64_t lk##i(MsvcString *s){ AliasSave sv; alias_in(s,&sv); uint64_t r=((fnA)g_lk_orig[i])(s); alias_out(s,&sv); return r; }
#define LKB(i) static void     lk##i(MsvcString *s,void*a,void*b,uint32_t c,void*d,void*e){ AliasSave sv; alias_in(s,&sv); ((fnB)g_lk_orig[i])(s,a,b,c,d,e); alias_out(s,&sv); }
#define LKC(i) static void    *lk##i(void*o,MsvcString *s,char ch){ AliasSave sv; alias_in(s,&sv); void*r=((fnC)g_lk_orig[i])(o,s,ch); alias_out(s,&sv); return r; }
#define LKD(i) static uint64_t lk##i(MsvcString *s,void*a,void*b,uint8_t c){ AliasSave sv; alias_in(s,&sv); uint64_t r=((fnD)g_lk_orig[i])(s,a,b,c); alias_out(s,&sv); return r; }
#define LKE(i) static uint64_t lk##i(MsvcString *s,void*a){ AliasSave sv; alias_in(s,&sv); uint64_t r=((fnE)g_lk_orig[i])(s,a); alias_out(s,&sv); return r; }
LKA(0) LKA(1) LKA(2) LKA(3) LKA(4) LKA(5)
LKB(6) LKB(7) LKB(8) LKB(9)
LKC(10)
LKD(11)
LKE(12)
static void *const g_lk_hook[FW_LK_COUNT] = { lk0, lk1, lk2, lk3, lk4, lk5, lk6, lk7, lk8, lk9, lk10, lk11, lk12 };

/* ----------------------------------------------------------------------- */
/* per-definition vtable overrides (slots 0-3). C has no closures, so one   */
/* set of thunks per definition index.                                     */
/* ----------------------------------------------------------------------- */
#define DEF_THUNKS(I) \
    static MsvcString *vt##I##_GetTypeName(void *self, MsvcString *out) { (void)self; out->size = 0; out->cap = 15; msvc_set_sso(out, g_defs[I].name); return out; } \
    static uintptr_t vt##I##_GetTypeId(void *self) { (void)self; return g_defs[I].typeId; } \
    static int vt##I##_IsA(void *self, MsvcString *name) { \
        if (msvc_eq(name, g_defs[I].name)) { g_TidyDeallocate(name); return 1; } \
        return ((fn_IsA)g_defs[I].templateVt[VT_ISA])(self, name); } \
    static TypeHierarchy *vt##I##_GetHier(void *self) { (void)self; return &g_defs[I].hier; }
DEF_THUNKS(0) DEF_THUNKS(1) DEF_THUNKS(2) DEF_THUNKS(3) DEF_THUNKS(4) DEF_THUNKS(5) DEF_THUNKS(6) DEF_THUNKS(7)
#define THUNK_ROW(I) { (void *)vt##I##_GetTypeName, (void *)vt##I##_GetTypeId, (void *)vt##I##_IsA, (void *)vt##I##_GetHier }
static void *const g_thunks[MAX_DEFS][4] = { THUNK_ROW(0), THUNK_ROW(1), THUNK_ROW(2), THUNK_ROW(3), THUNK_ROW(4), THUNK_ROW(5), THUNK_ROW(6), THUNK_ROW(7) };

/* ----------------------------------------------------------------------- */
/* construction hook: apply_status(name, ...)                               */
/* ----------------------------------------------------------------------- */
static void *hook_ApplyByName(MsvcString *name, void *ctx, int stacks, void *src, void *p5, void *p6, char p7, char p8) {
    CustomStatus *d = find_def_by_string(name);
    if (!d) return g_orig_ApplyByName(name, ctx, stacks, src, p5, p6, p7, p8);

    void *character = *(void **)((char *)ctx + OFF_APPLYCTX_CHARACTER);
    void *entity = *(void **)((char *)ctx + OFF_APPLYCTX_ENTITY);
    void *source = src ? src : g_defaultSource;
    void *applier = p5 ? p5 : (p6 ? *(void **)((char *)p6 + OFF_APPLYP6_APPLIER) : NULL);
    void *result = NULL;

    void *existing = find_status_on(character, d);
    if (existing && p7 == 0) {
        *status_stacks(existing) += stacks;
        *(void **)((char *)existing + OFF_STATUS_APPLIER) = applier;
        *(void **)((char *)existing + OFF_STATUS_APPLIER_OWNER) = applier ? *(void **)((char *)applier + OFF_APPLIER_OWNER) : NULL;
        if (stacks != 0) ((fn_OnStacksChanged)d->vt[VT_ONSTACKSCHANGED])(existing);
        if (*status_stacks(existing) == 0) g_StatusRemove(existing);
        result = existing;
        fw_log("%s: +%d stacks on existing (now %d)", d->name, stacks, *status_stacks(existing));
    } else {
        int st = stacks;
        void *obj = g_LuckUp_ctor(character, entity, &st, &source, &applier);
        if (obj) {
            *(void ***)obj = d->vt;          /* identity swap: template behavior, our name/type */
            *((char *)obj + OFF_STATUS_TEMPORARY) = p7;
            result = obj;
            fw_log("%s: created on %p with %d stacks (obj %p)", d->name, character, stacks, obj);
        } else {
            fw_log("%s: template constructor returned null (target dead or invalid)", d->name);
        }
    }
    g_TidyDeallocate(name); /* by-value std::string: callee destroys */
    return result;
}

/* ----------------------------------------------------------------------- */
/* install                                                                  */
/* ----------------------------------------------------------------------- */
static int hook_rva(uint32_t rva, void *fn, void **tramp, int prio, const char *label) {
    if (!g_mj.InstallHook(rva, 0, fn, tramp, prio, FW_OWNER)) { fw_log("hook %s failed (rva 0x%x)", label, rva); return 0; }
    return 1;
}

int status_engine_install_hooks(void) {
    g_LuckUp_ctor = (fn_LuckUp_ctor)g_sym[FW_SYM_LuckUp_ctor];
    g_StatusRemove = (fn_StatusRemove)g_sym[FW_SYM_Status_Remove];
    g_TidyDeallocate = (fn_TidyDeallocate)g_sym[FW_SYM_string_TidyDeallocate];
    g_luckUpVt = (void **)(g_base + g_build->rva_LuckUp_vftable);
    g_defaultSource = (void *)(g_base + g_build->rva_DefaultStatusSource);

    MsvcString nm = {{{0}}, 0, 15};
    ((fn_GetTypeName)g_luckUpVt[VT_GETTYPENAME])(NULL, &nm);
    uintptr_t id = ((fn_GetTypeId)g_luckUpVt[VT_GETTYPEID])(NULL);
    if (!msvc_eq(&nm, "LuckUp") || id != g_build->luckUpTypeId) {
        fw_log("LuckUp vtable sanity check failed (name '%s', id 0x%llx); custom statuses disabled", msvc_str(&nm), (unsigned long long)id);
        return 0;
    }

    int ok = 1;
    ok &= hook_rva(g_sym[FW_SYM_Status_ApplyByName] - g_base, (void *)hook_ApplyByName, (void **)&g_orig_ApplyByName, 20, "apply_status");
    int lk = 0;
    for (int i = 0; i < FW_LK_COUNT; i++)
        if (hook_rva(g_build->lkRvas[i], g_lk_hook[i], &g_lk_orig[i], 20, "status lookup")) lk++;
    fw_log("status hooks: apply_status + %d/%d name lookups aliased", lk, FW_LK_COUNT);
    return ok && lk == FW_LK_COUNT;
}

/* ----------------------------------------------------------------------- */
/* registration and runtime API                                            */
/* ----------------------------------------------------------------------- */
int status_engine_register(const FwStatusDef *def) {
    if (!g_orig_ApplyByName) { fw_log("RegisterStatus: engine hooks not installed"); return 0; }
    if (g_defCount >= MAX_DEFS) { fw_log("RegisterStatus: table full (%d)", MAX_DEFS); return 0; }
    if (strcmp(def->template_name, "LuckUp") != 0) { fw_log("RegisterStatus(%s): only template LuckUp is supported on this build", def->name); return 0; }
    if (strlen(def->name) > 15) { fw_log("RegisterStatus(%s): name must be at most 15 characters (SSO)", def->name); return 0; }

    CustomStatus *d = &g_defs[g_defCount];
    memset(d, 0, sizeof *d);
    d->def = *def;
    strncpy(d->name, def->name, sizeof d->name - 1);
    d->templateVt = g_luckUpVt;
    d->typeId = g_mj.AllocTypeIdPair(FW_OWNER);
    d->vt = (void **)HeapAlloc(GetProcessHeap(), 0, VT_SLOTS * sizeof(void *));
    if (!d->vt) return 0;
    memcpy(d->vt, g_luckUpVt, VT_SLOTS * sizeof(void *));
    for (int s = 0; s < 4; s++) d->vt[s] = g_thunks[g_defCount][s];

    TypeHierarchy *th = ((fn_GetHier)g_luckUpVt[VT_GETTYPEHIERARCHY])(NULL);
    d->hier = *th;
    for (uint64_t i = 0; i < d->hier.count && i < HIER_WORDS; i++)
        if ((uintptr_t)d->hier.ids[i] == g_build->luckUpTypeId) d->hier.ids[i] = (int)d->typeId;

    g_defCount++;
    fw_log("RegisterStatus: %s registered (template %s, type id 0x%llx, vtable %p)", d->name, def->template_name, (unsigned long long)d->typeId, (void *)d->vt);
    return 1;
}

int status_engine_set_stacks(void *status, int value) {
    if (!status) return 0;
    void **vt = *(void ***)status;
    CustomStatus *d = find_def_by_vt(vt);
    if (!d) return 0;
    *status_stacks(status) = value;
    ((fn_OnStacksChanged)vt[VT_ONSTACKSCHANGED])(status);
    void *ch = status_character(status);
    if (ch) *((char *)ch + OFF_CH_TOUCHED_PASSIVES) = 1;   /* ask the engine to recompute stats */
    if (value == 0) g_StatusRemove(status);
    return 1;
}

int status_engine_has_status(void *character, const char *statusName) {
    for (int i = 0; i < g_defCount; i++)
        if (strcmp(g_defs[i].name, statusName) == 0) return find_status_on(character, &g_defs[i]) != NULL;
    return 0;
}

void status_engine_on_begin_turn(void *character) {
    if (!character || g_defCount == 0) return;
    void *ent = char_entity(character);
    if (!ent) return;
    uint32_t n = entity_count(ent); void **comps = entity_components(ent);
    for (uint32_t i = 0; i < n; i++) {
        void *c = comps[i];
        if (!c) continue;
        CustomStatus *d = find_def_by_vt(*(void ***)c);
        if (d && d->def.on_turn_begin && !status_removing(c)) d->def.on_turn_begin(character, c, d->def.user);
    }
}
