/*
 * mewframework.dll — native framework for Mewgenics mods, loaded by Mewjector.
 *
 * Design rules (see docs/engine-map.md and the project plan):
 *  - Activates ONLY when the game was launched with -savesuffix on its command line.
 *    A plain Steam launch therefore stays vanilla even with version.dll present.
 *  - Refuses to run on an unknown game build: the main module's PE TimeDateStamp and
 *    SizeOfImage must match an entry in the embedded build table, and every byte
 *    signature must resolve to exactly one address. Any failure -> log and stay inert.
 *  - Installs hooks through Mewjector's MJ_InstallHook so other mods can chain.
 *  - Never writes to the game folder or to save files.
 *
 * This file is the Windows/game-facing glue; the decisions are host-tested pure modules: the build gate
 * (fw_build.c), the signature scanner (fw_sig.c), symbol resolution over the image's executable sections,
 * the -savesuffix gate, the FW_GetSymbol / FW_GetData bounds and the hook plan — order, priorities, failure
 * policy (fw_resolve.c). What stays here: reading the PE header, the Mewjector calls, the hook functions
 * themselves (fixed game ABI) and logging.
 *
 * Build: native/framework/build.bat (w64devkit GCC, no MSVC needed).
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdarg.h>
#include <string.h>
#include <stdint.h>

#include "framework_internal.h"
#include "fw_sig.h"
#include "fw_build.h"
#include "fw_resolve.h"
#include "fw_rng.h"

MewjectorAPI g_mj;
int g_mjAvailable = 0;
static int g_active = 0;
uintptr_t g_base = 0;
const BuildInfo *g_build = NULL;
static FILE *g_log = NULL;
uintptr_t g_sym[FW_SYMBOL_COUNT_];

/* ----------------------------------------------------------------------- */
/* logging                                                                  */
/* ----------------------------------------------------------------------- */
void fw_log(const char *fmt, ...) {
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    if (g_mjAvailable && g_mj.Log) g_mj.Log(FW_OWNER, "%s", buf);
    if (g_log) { fprintf(g_log, "%s\n", buf); fflush(g_log); }
    OutputDebugStringA(buf);
}

/* ----------------------------------------------------------------------- */
/* build identity                                                           */
/* ----------------------------------------------------------------------- */
static const BuildInfo *identify_build(uintptr_t base) {
    const IMAGE_DOS_HEADER *dos = (const IMAGE_DOS_HEADER *)base;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return NULL;
    const IMAGE_NT_HEADERS64 *nt = (const IMAGE_NT_HEADERS64 *)(base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) return NULL;
    uint32_t ts = nt->FileHeader.TimeDateStamp;
    uint32_t size = nt->OptionalHeader.SizeOfImage;
    int idx = fw_identify_build(ts, size, FW_BUILDS, FW_BUILD_COUNT);
    if (idx >= 0) return &FW_BUILDS[idx];
    fw_log("unknown build: TimeDateStamp=0x%08x SizeOfImage=0x%08x; framework disabled", ts, size);
    return NULL;
}

/* ----------------------------------------------------------------------- */
/* signature scanning: the PE section walk feeds fw_resolve_symbols, which  */
/* scans executable sections only and demands exactly one hit per symbol.  */
/* ----------------------------------------------------------------------- */
#define PE_MAX_SECTIONS 96   /* the PE/COFF limit on NumberOfSections */

static int resolve_symbols(void) {
    const IMAGE_DOS_HEADER *dos = (const IMAGE_DOS_HEADER *)g_base;
    const IMAGE_NT_HEADERS64 *nt = (const IMAGE_NT_HEADERS64 *)(g_base + dos->e_lfanew);
    const IMAGE_SECTION_HEADER *sec = IMAGE_FIRST_SECTION(nt);
    FwImageSection sections[PE_MAX_SECTIONS];
    unsigned n = nt->FileHeader.NumberOfSections;
    if (n > PE_MAX_SECTIONS) n = PE_MAX_SECTIONS;
    for (unsigned s = 0; s < n; s++) {
        sections[s].bytes = (const uint8_t *)(g_base + sec[s].VirtualAddress);
        sections[s].len = sec[s].Misc.VirtualSize;
        sections[s].executable = (sec[s].Characteristics & IMAGE_SCN_MEM_EXECUTE) != 0;
    }
    FwImage img = { g_base, sections, n };
    FwResolveResult res[FW_SYMBOL_COUNT_];
    int ok = fw_resolve_symbols(&img, g_build->symbols, FW_SYMBOL_COUNT, g_sym, res);
    for (size_t i = 0; i < FW_SYMBOL_COUNT; i++) {
        const SymbolSig *s = &g_build->symbols[i];
        if (res[i].code == FW_RESOLVE_DRIFT)
            fw_log("signature %s resolved to RVA 0x%llx (expected 0x%llx for known build); using scan result",
                  s->name, (unsigned long long)res[i].rva, (unsigned long long)s->expectedRva);
        else if (res[i].code == FW_RESOLVE_RAW_RVA)
            fw_log("symbol %s: no signature on this build; using RVA 0x%llx", s->name, (unsigned long long)res[i].rva);
        else if (res[i].code == FW_RESOLVE_NO_RVA)
            fw_log("symbol %s: no signature and no RVA; framework disabled", s->name);
        else if (res[i].code != FW_RESOLVE_OK)
            fw_log("signature %s: %d matches (need exactly 1); framework disabled", s->name, res[i].matches);
    }
    return ok;
}

/* ----------------------------------------------------------------------- */
/* hooks                                                                    */
/* ----------------------------------------------------------------------- */
/* glaiel::TurnControl::NextTurn(TurnControl* this). MSVC x64 passes `this` in RCX,
 * which is the first argument under the Windows x64 ABI that GCC also uses here. */
typedef void (*fn_TurnControl_NextTurn)(void *turnControl);
static fn_TurnControl_NextTurn g_next_TurnControl_NextTurn = NULL;
static volatile long g_turnCounter = 0;

static void hook_TurnControl_NextTurn(void *turnControl) {
    long n = InterlockedIncrement(&g_turnCounter);
    if (n <= 20 || (n % 50) == 0) fw_log("TurnControl::NextTurn #%ld (tc=%p)", n, turnControl);
    if (g_next_TurnControl_NextTurn) g_next_TurnControl_NextTurn(turnControl);
}

typedef void (*fn_Character_BeginTurn)(void *character, int kind);
static fn_Character_BeginTurn g_next_Character_BeginTurn = NULL;
/* Dispatch custom-status turn callbacks before the game's own turn-start work. */
static void hook_Character_BeginTurn(void *character, int kind) {
    status_engine_on_begin_turn(character);
    if (g_next_Character_BeginTurn) g_next_Character_BeginTurn(character, kind);
}

/* One step of FW_HOOK_PLAN: this file's two observer hooks, the glow engine's render hook; everything else is the status engine's. */
static int install_step(const FwHookSpec *spec, int ordinal, int failuresSoFar, void *user) {
    (void)ordinal; (void)failuresSoFar; (void)user;
    if (spec->step == FW_HOOK_SYMBOL && spec->index == FW_SYM_TacticsTest_LateRender) return glow_engine_hook_step(spec);
    if (spec->step == FW_HOOK_SYMBOL && spec->index == FW_SYM_Character_BeginTurn) {
        uintptr_t rva = g_sym[spec->index] - g_base;
        void *tramp = NULL;
        if (!g_mj.InstallHook(rva, 0, (void *)hook_Character_BeginTurn, &tramp, spec->priority, FW_OWNER)) {
            fw_log("MJ_InstallHook failed for %s (rva 0x%llx)", spec->label, (unsigned long long)rva);
            return 0;
        }
        g_next_Character_BeginTurn = (fn_Character_BeginTurn)tramp;
        fw_log("hook installed: %s rva 0x%llx", spec->label, (unsigned long long)rva);
        return 1;
    }
    if (spec->step == FW_HOOK_SYMBOL && spec->index == FW_SYM_TurnControl_NextTurn) {
        uintptr_t rva = g_sym[spec->index] - g_base;
        void *tramp = NULL;
        if (!g_mj.InstallHook(rva, 0, (void *)hook_TurnControl_NextTurn, &tramp, spec->priority, FW_OWNER)) {
            fw_log("MJ_InstallHook failed for %s (rva 0x%llx)", spec->label, (unsigned long long)rva);
            return 0;
        }
        g_next_TurnControl_NextTurn = (fn_TurnControl_NextTurn)tramp;
        fw_log("hook installed: %s rva 0x%llx, chain depth %d", spec->label, (unsigned long long)rva, g_mj.QueryHook(rva));
        return 1;
    }
    return status_engine_hook_step(spec);
}

static int install_hooks(void) {
    return fw_hook_run(FW_HOOK_PLAN, FW_HOOK_PLAN_COUNT, install_step, NULL);
}

/* ----------------------------------------------------------------------- */
/* exported API                                                             */
/* ----------------------------------------------------------------------- */
FW_EXPORT int FW_GetVersion(void) { return FW_API_VERSION; }
FW_EXPORT int FW_IsActive(void) { return g_active; }
FW_EXPORT uintptr_t FW_GetSymbol(int symbol) {
    return fw_resolve_symbol_addr(g_active, g_sym, FW_SYMBOL_COUNT, symbol);
}
FW_EXPORT const char *FW_GetBuildName(void) { return g_build ? g_build->name : "unknown"; }

/* --- API v3: per-build data addresses (globals, DYNAPI slots) --- */
FW_EXPORT uintptr_t FW_GetData(int dataId) {
    return fw_resolve_data_addr(g_active, g_build, g_base, dataId);
}

/* --- custom statuses (API v2) --- */
static FwStatusDef g_statusDefs[FW_STATUS_MAX_DEFS];   /* one cap, shared with status_engine.c (fw_status_rules.h) */
static int g_statusDefCount = 0;

FW_EXPORT int FW_RegisterStatus(const FwStatusDef *def) {
    if (!g_active) return 0;
    /* validate BEFORE claiming the name with Mewjector, so a refused definition never owns a name */
    FwStatusRule why = fw_status_validate(def, status_engine_table());
    if (why != FW_STATUS_OK) { fw_log("RegisterStatus(%s): %s", def && def->name ? def->name : "?", fw_status_rule_text(why)); return 0; }
    if (g_mj.RegisterName && !g_mj.RegisterName("status", def->name, FW_OWNER)) {
        fw_log("RegisterStatus: name %s already owned by %s", def->name, g_mj.LookupName("status", def->name));
        return 0;
    }
    g_statusDefs[g_statusDefCount++] = *def;
    return status_engine_register(&g_statusDefs[g_statusDefCount - 1]);
}

FW_EXPORT int FW_SetStatusStacks(void *status, int value) {
    return status_engine_set_stacks(status, value);
}

FW_EXPORT int FW_CharacterHasStatus(void *character, const char *statusName) {
    return status_engine_has_status(character, statusName);
}

/* --- API v4: per-unit glow (glow_engine.c) --- */
FW_EXPORT int FW_SetUnitGlow(void *character, float r, float g, float b, float a) {
    if (!g_active) return 0;
    float rgba[4] = { r, g, b, a };
    return glow_engine_set(character, rgba);
}

FW_EXPORT int FW_ClearUnitGlow(void *character) {
    if (!g_active) return 0;
    return glow_engine_clear(character);
}

/* --- API v5: the mods' random stream (fw_rng.c); never the CRT rand --- */
static FwRng g_rng;

FW_EXPORT uint32_t FW_Random(uint32_t bound) { return fw_rng_below(&g_rng, bound); }
FW_EXPORT void FW_SeedRandom(uint64_t seed) {
    fw_rng_seed(&g_rng, seed);
    fw_log("FW_Random seeded with %llu", (unsigned long long)seed);
}

/* ----------------------------------------------------------------------- */
/* init                                                                     */
/* ----------------------------------------------------------------------- */
static void init(void) {
    {   /* varied by default; the harness `seed <N>` re-seeds with N (FW_SeedRandom) */
        LARGE_INTEGER qpc; QueryPerformanceCounter(&qpc);
        fw_rng_seed(&g_rng, (uint64_t)qpc.QuadPart ^ ((uint64_t)GetCurrentProcessId() << 32) ^ (uint64_t)GetCurrentThreadId());
    }
    g_log = fopen("mod_logs\\mewframework.log", "a");
    g_mjAvailable = MJ_Require(FW_OWNER) && MJ_Resolve(&g_mj);
    fw_log("mewframework %d.%d.%d starting; mewjector=%s", FW_VERSION_MAJOR, FW_VERSION_MINOR, FW_VERSION_PATCH,
          g_mjAvailable ? "yes" : "no");

    if (!fw_resolve_is_dev_launch(GetCommandLineW())) {
        fw_log("vanilla launch (no -savesuffix on command line); framework inactive");
        return;
    }
    g_base = (uintptr_t)GetModuleHandleW(NULL);
    g_build = identify_build(g_base);
    if (!g_build) return;
    fw_log("build %s recognized (base 0x%llx)", g_build->name, (unsigned long long)g_base);
    if (!resolve_symbols()) return;
    if (!g_mjAvailable) { fw_log("Mewjector API unavailable; hooks need it; framework inactive"); return; }
    if (!install_hooks()) return;

    g_active = 1;
    fw_log("framework active: %zu symbols resolved, %d data addresses, mewjector api v%d", FW_SYMBOL_COUNT, (int)FW_DATA_COUNT_, g_mj.GetVersion());
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved) {
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(inst);
        init();
    } else if (reason == DLL_PROCESS_DETACH) {
        if (g_log) fclose(g_log);
    }
    return TRUE;
}
