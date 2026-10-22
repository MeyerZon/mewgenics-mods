/* Shared between framework.c and status_engine.c; not part of the public API. */
#pragma once
#include <stdint.h>
#include "mewjector.h"
#include "framework_api.h"
#include "signatures.h"
#include "offsets.h"
#include "fw_status_rules.h"   /* MsvcString, the status table rules (pure, host-tested) */
#include "fw_resolve.h"        /* FwHookSpec: the hook plan both files install steps of (pure, host-tested) */

extern MewjectorAPI g_mj;
extern int g_mjAvailable;
extern uintptr_t g_base;
extern const BuildInfo *g_build;
extern uintptr_t g_sym[FW_SYMBOL_COUNT_];

void fw_log(const char *fmt, ...);

/* status_engine.c */
int status_engine_hook_step(const FwHookSpec *spec);   /* the status-side steps of FW_HOOK_PLAN (framework.c drives the run) */
int status_engine_register(const FwStatusDef *def);
const FwStatusTable *status_engine_table(void);   /* the registered names, for fw_status_validate() */
int status_engine_set_stacks(void *status, int value);
int status_engine_has_status(void *character, const char *statusName);
void status_engine_on_begin_turn(void *character);
/* the data glow seam: 1 and the colour when `character` carries a live FwGlow_<hex> status (an FwGlowStatusProbe) */
int status_engine_glow_probe(void *character, float rgba[4], void *user);

/* glow_engine.c (API v4) */
int glow_engine_hook_step(const FwHookSpec *spec);   /* the FW_SYM_TacticsTest_LateRender step of FW_HOOK_PLAN */
int glow_engine_set(void *character, const float rgba[4]);
int glow_engine_clear(void *character);
int glow_engine_set_from_status(void *character, const float rgba[4]);   /* a FwGlow_ status was applied (status_engine.c) */

/* speed_engine.c (API v6) */
int speed_engine_hook_step(const FwHookSpec *spec);   /* the FW_SYM_ApplicationBase_FrameBegin step of FW_HOOK_PLAN */
double speed_engine_set(double factor);                /* returns the clamped factor kept */
double speed_engine_get(void);
/* catrig_engine.c (API v7) */
int catrig_engine_is_step(const FwHookSpec *spec);     /* the three cat rig steps of FW_HOOK_PLAN */
int catrig_engine_hook_step(const FwHookSpec *spec);
int catrig_engine_register(const FwCatRigDef *def);
const char *catrig_engine_for(const char *character);

/* obs3d_engine.c (phase-0 3D observer, log-only, MEWFW_OBSERVE3D) */
int obs3d_engine_hook_step(const FwHookSpec *spec);   /* the FW_SYM_Camera_render step: a no-op success when off */
void obs3d_on_late_render(void *tacticsTest);        /* called by the glow engine's LateRender hook every combat frame */
