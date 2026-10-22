/*
 * jokers_luck.dll ??? sample native mod on top of mewframework.
 *
 * Adds the status effect "JokersLuck": at the start of each of the affected unit's turns, its luck
 * modifier is rerolled to a random non-zero value in [-10, +10]. The data layer (mods/jokers-luck) supplies the
 * display name, tooltip and a dev ability (JokersGambit) that applies it.
 *
 * Load order: mewframework.dll must be loaded first (pinned via chainloader.ini [LoadOrder]).
 * Everything game-specific is resolved through the framework; this file never hardcodes addresses.
 *
 * Randomness comes from the framework's FW_Random (API v5), never the CRT rand: msvcrt keeps rand's state per
 * thread (an srand in DllMain need not reach the game thread that rolls) and nothing could pin it. FW_Random is varied by
 * default and the harness `seed <N>` directive re-seeds it (mods/jokers-luck/tests/luck-seeded.mewtest).
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdarg.h>

#include "mewjector.h"
#include "framework_api.h"
#include "jl_roll.h"

#define MOD_OWNER "jokers_luck"
#define STATUS_NAME "JokersLuck"

static MewjectorAPI g_mj;
static int g_mjOk = 0;
static FwApi g_fw;

static void logf_(const char *fmt, ...) {
    char buf[512];
    va_list ap; va_start(ap, fmt); vsnprintf(buf, sizeof buf, fmt, ap); va_end(ap);
    if (g_mjOk) g_mj.Log(MOD_OWNER, "%s", buf);
    OutputDebugStringA(buf);
}

/* Called by the framework at the start of each turn for every unit carrying our status. */
static void on_turn_begin(void *character, void *status, void *user) {
    (void)user;
    int target = jl_reroll(g_fw.Random);   /* non-zero: 0 stacks would remove the status */
    int ok = g_fw.SetStatusStacks(status, target);
    logf_("turn begin for %p: Joker's Luck -> %+d luck (%s)", character, target, ok ? "applied" : "FAILED");
}

static int init(void) {
    g_mjOk = MJ_Require(MOD_OWNER) && MJ_Resolve(&g_mj);
    if (!FW_Resolve(&g_fw)) { logf_("mewframework.dll not loaded or too old; mod inactive"); return 0; }
    if (!g_fw.IsActive()) { logf_("framework inactive (vanilla launch or unknown build); mod inactive"); return 0; }

    FwStatusDef def = {0};
    def.name = STATUS_NAME;
    def.template_name = "LuckUp";     /* behaves as LuckUp (stacks = luck modifier), with its own identity */
    def.category = FW_STATUS_KEEP_TEMPLATE;
    def.on_turn_begin = on_turn_begin;
    if (!g_fw.RegisterStatus(&def)) { logf_("RegisterStatus(%s) failed", STATUS_NAME); return 0; }
    logf_("registered status %s (template %s)", STATUS_NAME, def.template_name);
    return 1;
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved) {
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) { DisableThreadLibraryCalls(inst); init(); }
    return TRUE;
}
