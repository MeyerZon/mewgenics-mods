/* Pure parts of the phase-0 3D observer (docs/possible_3d_work.md "Phase 0"): log-only, no behaviour change, OFF by
 * default. obs3d_engine.c hooks Camera_render (0x9787c0) when the environment variable MEWFW_OBSERVE3D holds a
 * positive frame budget, and for that many world-camera frames logs what the 3D plan relies on: every camera's RTT /
 * HDR / zoom / flip / layer bitset and its view-projection (Camera_GetViewProjection 0x9785e0), the world camera's
 * non-empty layers (mode, item count), one item's raw world (x, z) and Renderer_GetScreenMatrix 4x4, and the
 * process-wide render globals (ISO / ISO^-1, render-state flags, cull counter, depth bias).
 *
 * Everything here reads fake-able memory through the GENERATED offsets.h macros only, so it is host-tested
 * (test/test_obs3d_rules.c); the game calls (the VP, the screen matrix) and the hook stay in obs3d_engine.c. The log
 * line formats are a contract: editor/src/core/ingame/obs3d.ts parses them and the T2 run's lines are pinned as
 * editor/test/fixtures/ingame/observe3d-log.txt. */
#pragma once
#include <stdint.h>
#include <stddef.h>
#include "offsets.h"

#define FW_OBS3D_MAX_BUDGET 600   /* world-camera frames; a typo like 1e9 must not log for an hour */

/* MEWFW_OBSERVE3D value -> frame budget: NULL, "", "0", negative or not a plain decimal = 0 (off); else min(n, MAX) */
int fw_obs3d_budget(const char *value);
/* the world camera's render #worldFrame (1-based, per fight) is logged when it is the first of a window of
 * FW_OBS3D_EVERY frames and fewer than `budget` windows have passed: frames 1, 1+EVERY, 1+2*EVERY, ... */
#define FW_OBS3D_EVERY 60
int fw_obs3d_should_log(int worldFrame, int budget);

/* ---- camera ---- */
int fw_obs3d_cam_rtt(const void *cam);
int fw_obs3d_cam_hdr(const void *cam);
double fw_obs3d_cam_zoom(const void *cam);
int fw_obs3d_cam_flip(const void *cam);
/* layer i enabled in the camera's bitset (uint32 words at *(cam+OFF_CAM_LAYER_BITS)); 0 for i < 0 or a null bitset */
int fw_obs3d_cam_layer_on(const void *cam, int layer);
/* bits 0..63 of the bitset as one integer (combat has 0x30 layers) */
uint64_t fw_obs3d_cam_layer_mask(const void *cam);
void *fw_obs3d_cam_queue(const void *cam);
/* the world camera of a fight: TacticsTest+OFF_TT_MAIN_CAMERA (non-RTT; docs/possible_3d_work.md K8) */
int fw_obs3d_is_world_camera(const void *tacticsTest, const void *cam);

/* ---- render queue / layers ---- */
int fw_obs3d_layer_count(const void *queue);                  /* (end - begin) / CONST_LAYER_STRIDE, 0 for null */
const void *fw_obs3d_layer(const void *queue, int i);         /* NULL when out of range */
int fw_obs3d_layer_items(const void *layer);                  /* item count */
int fw_obs3d_layer_mode(const void *layer);                   /* draw mode (1 = depth-tested, 2/3 = flat black/white) */
void *fw_obs3d_item_renderable(const void *layer, int k);     /* item k's renderable (a Renderer for sprites), NULL if out of range */
void *fw_obs3d_renderer_position(const void *renderer);       /* a Renderer's Position* (+OFF_RND_POSITION) */
/* 1 iff the object's vftable is the MaskedRendererIso one (units: safe to call Renderer_GetScreenMatrix on) */
int fw_obs3d_is_masked_renderer_iso(const void *obj, uintptr_t vftable);
void fw_obs3d_position_xz(const void *position, double out[2]);   /* raw (not interpolated) world x, z (the height is in the screen matrix) */

/* ---- log lines (each returns the length written, buffer always NUL-terminated; truncation keeps a valid prefix) ---- */
int fw_obs3d_fmt_mat(char *buf, size_t n, const float m[16]);   /* "[m0 m1 ... m15]" with %.6g */
/* "obs3d cam f=<frame> cam=<ptr> world=<0|1> rtt=<0|1> hdr=<0|1> zoom=<g> flip=<d> layers=0x<hex> vp=[...]" */
int fw_obs3d_fmt_camera(char *buf, size_t n, int frame, const void *cam, int world, const float vp[16]);
/* "obs3d layers f=<frame> 0x19:m0:n5 ..." for the camera's enabled, non-empty layers */
int fw_obs3d_fmt_layers(char *buf, size_t n, int frame, const void *cam);
/* "obs3d item f=<frame> layer=0x<l> rnd=<ptr> pos=(x z) screen=[...]" */
int fw_obs3d_fmt_item(char *buf, size_t n, int frame, int layer, const void *renderable, const double xz[2], const float screen[16]);
/* "obs3d globals iso=[...] isoinv=[...] flags=0x<x> cull=<d> depthbias=<g> stacktop=<d>" (iso/isoinv may be NULL) */
int fw_obs3d_fmt_globals(char *buf, size_t n, const float *iso, const float *isoinv, uint32_t flags, int cull, float depthBias, int stackTop);

/* "obs3d app clear=<c><d><s> antialias=<n> samples=<n>": FrameBegin's per-frame clear of the main RT
 * (App+OFF_APP_CLEAR_COLOR/DEPTH/STENCIL bytes -> GL_COLOR/DEPTH/STENCIL_BUFFER_BIT), the antialias setting and the main RT's
 * clamped sample count (App+OFF_APP_MAIN_RT, rt+OFF_RT_SAMPLES): the depth buffer the world camera's layers share */
int fw_obs3d_fmt_app(char *buf, size_t n, const void *app);

/* the first enabled non-empty layer >= from whose first item has a renderable, -1 if none */
int fw_obs3d_first_item_layer(const void *cam, int from);
