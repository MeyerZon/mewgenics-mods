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
/* command line gate                                                        */
/* ----------------------------------------------------------------------- */
static int command_line_has(const wchar_t *flag) {
    const wchar_t *cl = GetCommandLineW();
    return cl && wcsstr(cl, flag) != NULL;
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
    for (size_t i = 0; i < FW_BUILD_COUNT; i++) {
        if (FW_BUILDS[i].timeDateStamp == ts && FW_BUILDS[i].sizeOfImage == size) return &FW_BUILDS[i];
    }
    fw_log("unknown build: TimeDateStamp=0x%08x SizeOfImage=0x%08x; framework disabled", ts, size);
    return NULL;
}

/* ----------------------------------------------------------------------- */
/* signature scanning (IDA-style "48 8B ?? ?? 89" patterns, exec sections)  */
/* The parser and matcher live in fw_sig.c (host-tested); this adds the PE  */
/* section walk.                                                            */
/* ----------------------------------------------------------------------- */
static uintptr_t scan_unique(uintptr_t base, const char *pattern, int *matches) {
    uint8_t bytes[FW_SIG_MAX_BYTES], mask[FW_SIG_MAX_BYTES];
    int n = fw_parse_pattern(pattern, bytes, mask, sizeof bytes);
    *matches = 0;
    if (n <= 0) return 0;
    const IMAGE_DOS_HEADER *dos = (const IMAGE_DOS_HEADER *)base;
    const IMAGE_NT_HEADERS64 *nt = (const IMAGE_NT_HEADERS64 *)(base + dos->e_lfanew);
    const IMAGE_SECTION_HEADER *sec = IMAGE_FIRST_SECTION(nt);
    uintptr_t found = 0;
    for (unsigned s = 0; s < nt->FileHeader.NumberOfSections; s++) {
        if (!(sec[s].Characteristics & IMAGE_SCN_MEM_EXECUTE)) continue;
        const uint8_t *p = (const uint8_t *)(base + sec[s].VirtualAddress);
        const uint8_t *hit = fw_scan_buffer(p, sec[s].Misc.VirtualSize, bytes, mask, (size_t)n, matches);
        if (hit && !found) found = (uintptr_t)hit;
        if (*matches > 1) return found;
    }
    return found;
}


static int resolve_symbols(void) {
    int ok = 1;
    for (size_t i = 0; i < FW_SYMBOL_COUNT; i++) {
        const SymbolSig *s = &FW_SYMBOLS[i];
        int matches = 0;
        uintptr_t hit = scan_unique(g_base, s->pattern, &matches);
        if (matches != 1) {
            fw_log("signature %s: %d matches (need exactly 1); framework disabled", s->name, matches);
            ok = 0;
            continue;
        }
        uintptr_t addr = hit + s->offset;
        if (s->expectedRva && (addr - g_base) != s->expectedRva)
            fw_log("signature %s resolved to RVA 0x%llx (expected 0x%llx for known build); using scan result",
                  s->name, (unsigned long long)(addr - g_base), (unsigned long long)s->expectedRva);
        g_sym[i] = addr;
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

static int install_hooks(void) {
    {
        uintptr_t rva = g_sym[FW_SYM_Character_BeginTurn] - g_base;
        void *tramp = NULL;
        if (!g_mj.InstallHook(rva, 0, (void *)hook_Character_BeginTurn, &tramp, 20, FW_OWNER)) {
            fw_log("MJ_InstallHook failed for Character::BeginTurn (rva 0x%llx)", (unsigned long long)rva);
            return 0;
        }
        g_next_Character_BeginTurn = (fn_Character_BeginTurn)tramp;
        fw_log("hook installed: Character::BeginTurn rva 0x%llx", (unsigned long long)rva);
    }
    if (!status_engine_install_hooks()) return 0;
    uintptr_t rva = g_sym[FW_SYM_TurnControl_NextTurn] - g_base;
    void *tramp = NULL;
    if (!g_mj.InstallHook(rva, 0, (void *)hook_TurnControl_NextTurn, &tramp, 100, FW_OWNER)) {
        fw_log("MJ_InstallHook failed for TurnControl::NextTurn (rva 0x%llx)", (unsigned long long)rva);
        return 0;
    }
    g_next_TurnControl_NextTurn = (fn_TurnControl_NextTurn)tramp;
    fw_log("hook installed: TurnControl::NextTurn rva 0x%llx, chain depth %d",
          (unsigned long long)rva, g_mj.QueryHook(rva));
    return 1;
}

/* ----------------------------------------------------------------------- */
/* exported API                                                             */
/* ----------------------------------------------------------------------- */
FW_EXPORT int FW_GetVersion(void) { return FW_API_VERSION; }
FW_EXPORT int FW_IsActive(void) { return g_active; }
FW_EXPORT uintptr_t FW_GetSymbol(int symbol) {
    if (!g_active || symbol < 0 || symbol >= (int)FW_SYMBOL_COUNT) return 0;
    return g_sym[symbol];
}
FW_EXPORT const char *FW_GetBuildName(void) { return g_build ? g_build->name : "unknown"; }

/* --- API v3: per-build data addresses (globals, DYNAPI slots) --- */
FW_EXPORT uintptr_t FW_GetData(int dataId) {
    if (!g_active || !g_build || dataId < 0 || dataId >= (int)FW_DATA_COUNT_) return 0;
    uint32_t rva = g_build->rva_data[dataId];
    return rva ? g_base + rva : 0;
}

/* --- custom statuses (API v2) --- */
#define FW_MAX_STATUS_DEFS 16
static FwStatusDef g_statusDefs[FW_MAX_STATUS_DEFS];
static int g_statusDefCount = 0;

FW_EXPORT int FW_RegisterStatus(const FwStatusDef *def) {
    if (!g_active || !def || !def->name || !def->template_name) return 0;
    if (g_statusDefCount >= FW_MAX_STATUS_DEFS) { fw_log("RegisterStatus: table full"); return 0; }
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

/* ----------------------------------------------------------------------- */
/* init                                                                     */
/* ----------------------------------------------------------------------- */
static void init(void) {
    g_log = fopen("mod_logs\\mewframework.log", "a");
    g_mjAvailable = MJ_Require(FW_OWNER) && MJ_Resolve(&g_mj);
    fw_log("mewframework %d.%d.%d starting; mewjector=%s", FW_VERSION_MAJOR, FW_VERSION_MINOR, FW_VERSION_PATCH,
          g_mjAvailable ? "yes" : "no");

    if (!command_line_has(L"-savesuffix")) {
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
