/* Shared between framework.c and status_engine.c; not part of the public API. */
#pragma once
#include <stdint.h>
#include "mewjector.h"
#include "framework_api.h"
#include "signatures.h"
#include "offsets.h"
#include "fw_status_rules.h"   /* MsvcString, the status table rules (pure, host-tested) */
#include "fw_resolve.h"        /* FwHookSpec: the hook plan both files install steps of (pure, host-tested) */
#include "fw_obj3d_rules.h"    /* Fw3dObject: the 3D-object registry (pure, host-tested) */

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

/* mesh_engine.c (phase M: meshes in the vanilla scene; docs/possible_3d_work.md) */
int mesh_engine_wants_layer_hook(void);               /* reads MEWFW_MESH_PROBE once; 1 when the Camera_RenderOneLayer hook must be installed */
void mesh_engine_after_layer(void *cam, int layer);   /* record time, after the original Camera_RenderOneLayer */
void mesh_engine_on_late_render(void *tacticsTest);   /* every combat frame, from the glow engine's LateRender hook */
/* obj3d_engine.c (API v8: 3D objects; records only — the mesh engine resolves models and draws) */
int obj3d_engine_register(void *character, const char *model, const float transform[16]);   /* handle > 0, 0 refused */
int obj3d_engine_place(int col, int row, const char *model, const float transform[16]);     /* handle > 0, 0 refused */
int obj3d_engine_unregister(void *character, int handle);   /* by character when non-NULL, else by handle; 1 removed */
/* for the mesh engine, every combat frame: on_fight first (a new TacticsTest clears the registry, freed units are
 * pruned), then iterate count/get; fw_obj3d_model_matrix(o, unitXZ, out) gives the world matrix */
int obj3d_engine_count(void);
const Fw3dObject *obj3d_engine_get(int i);                  /* NULL out of range; valid until the next register/remove/on_fight */
void obj3d_engine_on_fight(void *tacticsTest);
/* the unit's GON graphics.model (its live entry at Character+OFF_CH_GON_ENTRY, guarded reads): 1 found, 0 none, -1 unreadable */
int obj3d_engine_unit_model(const void *character, char *out, size_t cap);
