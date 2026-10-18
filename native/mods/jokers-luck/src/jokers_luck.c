/*
 * jokers_luck.dll ??? sample native mod on top of mewframework.
 *
 * Adds the status effect "JokersLuck": at the start of each of the affected unit's turns, its luck
 * modifier is rerolled to a random value in [-10, +10]. The data layer (mods/jokers-luck) supplies the
 * display name, tooltip and a dev ability (JokersGambit) that applies it.
 *
 * Load order: mewframework.dll must be loaded first (pinned via chainloader.ini [LoadOrder]).
 * Everything game-specific is resolved through the framework; this file never hardcodes addresses.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdlib.h>

#include "mewjector.h"
#include "framework_api.h"

#define MOD_OWNER "jokers_luck"
#define STATUS_NAME "JokersLuck"
#define LUCK_MIN (-10)
#define LUCK_MAX (10)

static MewjectorAPI g_mj;
static int g_mjOk = 0;
static FwApi g_fw;

static void logf_(const char *fmt, ...) {
    char buf[512];
    va_list ap; va_start(ap, fmt); vsnprintf(buf, sizeof buf, fmt, ap); va_end(ap);
    if (g_mjOk) g_mj.Log(MOD_OWNER, "%s", buf);
    OutputDebugStringA(buf);
}

/* Uniform integer in [lo, hi] from the process RNG seeded once per load. */
static int roll(int lo, int hi) {
    return lo + (int)((unsigned)rand() % (unsigned)(hi - lo + 1));
}

/* Called by the framework at the start of each turn for every unit carrying our status. */
static void on_turn_begin(void *character, void *status, void *user) {
    (void)user;
    int target;
    do { target = roll(LUCK_MIN, LUCK_MAX); } while (target == 0); /* 0 stacks would remove the status */
    int ok = g_fw.SetStatusStacks(status, target);
    logf_("turn begin for %p: Joker's Luck -> %+d luck (%s)", character, target, ok ? "applied" : "FAILED");
}

static int init(void) {
    srand((unsigned)GetTickCount());
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
