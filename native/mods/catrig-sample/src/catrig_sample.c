/*
 * catrig_sample.dll — sample native mod for the cat rig redirect's DLL route (framework API v7).
 *
 * Registers the rig clip `RigSampleCatClip` (exported by mods/catrig-sample/swfs/rig.swf, built from
 * art/rig.scene.json) for the character entry `RigSampleCat` (mods/catrig-sample/data/characters), through
 * FW_RegisterCatRig, and reads it back with FW_CatRigFor. The export is deliberately not named `_CatRig_<Entry>`:
 * the framework's data seam cannot bind it, so a RigSampleCat drawn by the rig proves this DLL's registration.
 * Whenever RigSampleCat (or RigSampleCat_Champion / _Elite) spawns, the framework answers the game's "CatTest"
 * lookup with RigSampleCatClip; CatParts fills its empty slots with RigSampleParts.
 *
 * Load order: mewframework.dll first (chainloader.ini [LoadOrder]); registering in DllMain is fine — the registry
 * is read only when a character spawns, long after every SWF and DLL is loaded. Nothing here touches the game.
 * The pairs, checks and bind loop are pure (catrig_sample_rules.c, host-tested by test/test_catrig_sample.c).
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>

#include "mewjector.h"
#include "framework_api.h"
#include "catrig_sample_rules.h"

static MewjectorAPI g_mj;
static int g_mjOk = 0;
static FwApi g_fw;

static void log_line(void *user, const char *line) {
    (void)user;
    if (g_mjOk) g_mj.Log(CS_OWNER, "%s", line);
    OutputDebugStringA(line);
}

static void init(void) {
    g_mjOk = MJ_Require(CS_OWNER) && MJ_Resolve(&g_mj);
    if (!FW_Resolve(&g_fw)) { log_line(NULL, "mewframework.dll not loaded or older than API v7; mod inactive"); return; }
    if (!g_fw.IsActive()) { log_line(NULL, "framework inactive (vanilla launch or unknown build); mod inactive"); return; }
    CsBinder b = { g_fw.RegisterCatRig, g_fw.CatRigFor, log_line, NULL };
    int n = cs_bind_all(&b, CS_RIGS, CS_RIG_COUNT);
    char line[96];
    snprintf(line, sizeof line, "%d of %d cat rig(s) bound", n, CS_RIG_COUNT);
    log_line(NULL, line);
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved) {
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) { DisableThreadLibraryCalls(inst); init(); }
    return TRUE;
}
