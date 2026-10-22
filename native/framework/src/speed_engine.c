/*
 * speed_engine.c — game speed (API v6, FW_SetTimeScale): the game-facing half of fw_speed_rules.c.
 *
 * ApplicationBase::FrameBegin runs once per rendered frame, inside Step, after that frame's fixed updates (which is
 * where HitPause_Update rewrites the time scale in combat) and before the main loop's next `accumulator +=
 * delta * App+OFF_APP_TIMESCALE`. Multiplying the value there makes the next frame run factor x as many identical
 * fixed updates (same dt each), i.e. the simulation runs factor x faster in wall-clock time while every update, the
 * RNG sequence and the turn logic stay what they are at 1x. docs/engine-map.md "Frame timing and game speed".
 *
 * The decisions (clamp, default off, no compounding of our own write, restore on disable) are fw_speed_rules.c
 * (host-tested); this file only reads/writes the double through the generated OFF_APP_TIMESCALE.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include "framework_internal.h"
#include "fw_speed_rules.h"

typedef void (*fn_FrameBegin)(void *app);
static fn_FrameBegin g_origFrameBegin = NULL;
static FwSpeedState g_speed = { 1.0, 0, 1.0, 0.0 };

static double *timescale_ptr(void *app) { return app ? (double *)((char *)app + OFF_APP_TIMESCALE) : NULL; }

static void hook_FrameBegin(void *app) {
    if (g_origFrameBegin) g_origFrameBegin(app);
    double *ts = timescale_ptr(app);
    if (!ts) return;
    double out = 0.0;
    if (fw_speed_frame(&g_speed, *ts, &out)) *ts = out;
}

int speed_engine_hook_step(const FwHookSpec *spec) {
    uintptr_t rva = g_sym[spec->index] - g_base;
    void *tramp = NULL;
    if (!g_mj.InstallHook(rva, 0, (void *)hook_FrameBegin, &tramp, spec->priority, FW_OWNER)) {
        fw_log("MJ_InstallHook failed for %s (rva 0x%llx)", spec->label, (unsigned long long)rva);
        return 0;
    }
    g_origFrameBegin = (fn_FrameBegin)tramp;
    fw_log("hook installed: %s rva 0x%llx, chain depth %d", spec->label, (unsigned long long)rva, g_mj.QueryHook(rva));
    return 1;
}

/* Call on the game's main thread (a hook, a turn callback, the harness): the per-frame hook reads g_speed there. */
double speed_engine_set(double factor) {
    double applied = fw_speed_set(&g_speed, factor);
    fw_log("SetTimeScale(%g): factor %g%s", factor, applied, applied == 1.0 ? " (off: the game's own scale is restored next frame)" : "");
    return applied;
}

double speed_engine_get(void) { return g_speed.factor; }
