/*
 * catrig_engine.c — cat rigs (API v7): FW_RegisterCatRig / FW_CatRigFor and the `_CatRig_<Entry>` data seam.
 *
 * Strategy S1 of the cat-parts plan (docs/engine-map.md "Cat rig redirect"; .analysis/notes-catA.md). A character
 * entry with `graphics { movieclip _CAT }` runs the game's whole cat path: Character::init(name, bool, bool) 0xf70f0
 * reads the entry and calls Character::init(movieclip, shadow) 0xf1150 synchronously, whose `_CAT` branch builds a
 * MaskedRendererIso with the literal "CatTest" (0x12c960 -> 0x78ceb0 -> Renderer::init 0x97a900 ->
 * Swf_GetCharacterByName 0x9bb890, a global registry over every loaded SWF) plus CatData and CatParts. CatParts fills
 * the slot-named instances of whatever clip the renderer plays, by name, on every prerender (notes-catB), so a
 * different clip with the same shape — labels <anim>F / <anim>B on the root, the pose as the child `ani`, EMPTY slot
 * sprites — gets the cat's own parts, palette and face.
 *
 * Three hooks (all installed at DLL load, through Mewjector like every other framework hook):
 *  1. ApplicationBase::process_animation_merges 0x9bc070, post-hook: after the game merged a loaded SWF's `_Append_`
 *     exports, scan the same SymbolClass list (fw_catrig_scan_file) for `_CatRig_<Entry>` exports and register each as
 *     {Entry -> that export}. The game itself ignores those exports (only `_Append_` is special to it), so an entry
 *     that does not exist simply never spawns: nothing to stall, the registration is just logged.
 *  2. Character::init(name, bool, bool) 0xf70f0: look the entry up in the registry (exact, then _Champion / _Elite
 *     stripped) and keep the rig in a thread-local for the duration of the call (saved and restored, so a nested init
 *     cannot leak its scope).
 *  3. Swf_GetCharacterByName 0x9bb890: inside a rigged entry's init, a request for exactly "CatTest" is answered with
 *     the rig clip's instance — the original called with the rig name (a std::string the callee destroys, like the
 *     one it replaces). Unknown rig clip (no loaded SWF exports it: the original returns NULL) -> the vanilla
 *     "CatTest" is looked up as if nothing happened, and that is logged once per entry; Renderer::init would be fatal
 *     on NULL, so the hook never returns NULL where the original would not. Every other name (the portraits
 *     `<entry>Portrait`, CatParts' part symbols, any non-rigged entry) passes straight through.
 *
 * The registry is written when a SWF loads (the loader thread or the main thread) and read when a character spawns,
 * so it is guarded by one SRW lock; entries never move or go away, so the thread-local pointer stays valid.
 * Decisions are host-tested in fw_catrig_rules.c; every number comes from the generated signatures.h / offsets.h.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string.h>
#include "framework_internal.h"
#include "fw_catrig_rules.h"
#include "fw_vtable.h"   /* fw_msvc_init, FwStringDealloc */

typedef void  (*fn_ProcessMerges)(void *app, void *file);
typedef void  (*fn_CharacterInit)(void *self, MsvcString *name, uint8_t a, uint8_t b);
typedef void *(*fn_GetCharacterByName)(void *unused, MsvcString *name);

static fn_ProcessMerges g_origMerges;
static fn_CharacterInit g_origInit;
static fn_GetCharacterByName g_origByName;

static FwCatRigRegistry g_reg;
static SRWLOCK g_lock = SRWLOCK_INIT;
static __thread const FwCatRig *t_rig;        /* the rig of the Character::init running on this thread, or NULL */
static volatile LONG g_redirects;
static int g_missLogged[FW_CATRIG_MAX];        /* "rig clip not found" said once per registry slot */

static void scan_report(const char *exportName, const char *character, FwCatRigResult r, void *file) {
    if (r == FW_CATRIG_OK) fw_log("catrig: registered %s for %s (from data, SWF file %p)", exportName, character, file);
    else if (r == FW_CATRIG_SAME) fw_log("catrig: %s for %s already registered", exportName, character);
    else fw_log("catrig: %s refused: %s", exportName, fw_catrig_result_text(r));
}

static void hook_ProcessAnimationMerges(void *app, void *file) {
    if (g_origMerges) g_origMerges(app, file);
    AcquireSRWLockExclusive(&g_lock);
    fw_catrig_scan_file(&g_reg, file, scan_report, file, 100000);
    ReleaseSRWLockExclusive(&g_lock);
}

static void hook_Character_init(void *self, MsvcString *name, uint8_t a, uint8_t b) {
    const FwCatRig *prev = t_rig, *rig = NULL;
    if (name && g_reg.count) {   /* count only grows; a racing registration is seen on the next spawn */
        AcquireSRWLockShared(&g_lock);
        rig = fw_catrig_find(&g_reg, msvc_str(name), name->size);
        ReleaseSRWLockShared(&g_lock);
    }
    t_rig = rig;
    g_origInit(self, name, a, b);   /* destroys `name` */
    t_rig = prev;
}

static void *hook_GetCharacterByName(void *unused, MsvcString *name) {
    const FwCatRig *rig = t_rig;
    if (rig && fw_catrig_is_vanilla_clip(name)) {
        MsvcString alt;
        if (fw_msvc_init(&alt, rig->clip, (FwStringAlloc)g_sym[FW_SYM_string_Allocate])) {
            void *inst = g_origByName(unused, &alt);   /* destroys alt */
            if (inst) {
                ((FwStringDealloc)g_sym[FW_SYM_string_TidyDeallocate])(name);   /* ours to destroy now: the callee would have */
                LONG n = InterlockedIncrement(&g_redirects);
                if (n <= 200) fw_log("catrig: %s: CatTest -> %s (instance %p)", rig->character, rig->clip, inst);
                return inst;
            }
            int slot = (int)(rig - g_reg.rigs);
            if (slot >= 0 && slot < FW_CATRIG_MAX && !g_missLogged[slot]) {
                g_missLogged[slot] = 1;
                fw_log("catrig: %s: rig clip %s not found in any loaded SWF; vanilla CatTest kept", rig->character, rig->clip);
            }
        } else fw_log("catrig: %s: no string memory for %s; vanilla CatTest kept", rig->character, rig->clip);
    }
    return g_origByName(unused, name);
}

/* ----------------------------------------------------------------------- */
/* install: the three cat rig steps of FW_HOOK_PLAN                         */
/* ----------------------------------------------------------------------- */
int catrig_engine_hook_step(const FwHookSpec *spec) {
    void *hook = NULL, **tramp = NULL;
    if (spec->index == FW_SYM_ApplicationBase_ProcessAnimationMerges) { hook = (void *)hook_ProcessAnimationMerges; tramp = (void **)&g_origMerges; }
    else if (spec->index == FW_SYM_Character_init) { hook = (void *)hook_Character_init; tramp = (void **)&g_origInit; }
    else if (spec->index == FW_SYM_Swf_GetCharacterByName) { hook = (void *)hook_GetCharacterByName; tramp = (void **)&g_origByName; }
    else return 0;
    uintptr_t rva = g_sym[spec->index] - g_base;
    if (!g_mj.InstallHook(rva, 0, hook, tramp, spec->priority, FW_OWNER)) {
        fw_log("MJ_InstallHook failed for %s (rva 0x%llx)", spec->label, (unsigned long long)rva);
        return 0;
    }
    fw_log("hook installed: %s rva 0x%llx", spec->label, (unsigned long long)rva);
    return 1;
}

int catrig_engine_is_step(const FwHookSpec *spec) {
    return spec->step == FW_HOOK_SYMBOL && (spec->index == FW_SYM_ApplicationBase_ProcessAnimationMerges ||
        spec->index == FW_SYM_Character_init || spec->index == FW_SYM_Swf_GetCharacterByName);
}

/* ----------------------------------------------------------------------- */
/* runtime API                                                              */
/* ----------------------------------------------------------------------- */
int catrig_engine_register(const FwCatRigDef *def) {
    AcquireSRWLockExclusive(&g_lock);
    FwCatRigResult r = def ? fw_catrig_add(&g_reg, def->character, def->rig_clip, 0) : FW_CATRIG_ERR_NULL;
    ReleaseSRWLockExclusive(&g_lock);
    const char *c = def && def->character ? def->character : "?", *k = def && def->rig_clip ? def->rig_clip : "?";
    if (r == FW_CATRIG_OK) fw_log("catrig: registered %s for %s (from a DLL)", k, c);
    else if (r == FW_CATRIG_SAME) fw_log("catrig: %s for %s already registered", k, c);
    else fw_log("catrig: %s refused: %s", k, fw_catrig_result_text(r));
    return r == FW_CATRIG_OK || r == FW_CATRIG_SAME;
}

const char *catrig_engine_for(const char *character) {
    if (!character) return NULL;
    AcquireSRWLockShared(&g_lock);
    const FwCatRig *g = fw_catrig_find(&g_reg, character, strlen(character));
    ReleaseSRWLockShared(&g_lock);
    return g ? g->clip : NULL;
}
