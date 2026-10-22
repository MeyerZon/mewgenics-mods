/*
 * obs3d_engine.c — the phase-0 3D observer (docs/possible_3d_work.md "Phase 0"). Log-only: it never writes game
 * memory and changes no behaviour. OFF unless the environment variable MEWFW_OBSERVE3D holds a positive number N
 * (fw_obs3d_budget); then the hooks on Camera_render (0x9787c0, the RTT cameras: RenderCore 0x989020's first list) and
 * Camera_RenderOneLayer (0x979210, every layer of the world and UI cameras: its second list; the T2 run of 2026-10-22
 * showed Camera_render never sees TacticsTest+0x68) are installed and, during a fight, the world camera's render #1, #1+60, #1+120, ... (N windows, fw_obs3d_should_log) are observed:
 *   - "obs3d globals ..."  ISO / ISO^-1, the render-state flags, the cull-disable counter, the depth bias, the matrix
 *                          stack top (once per observed frame, read right before the world camera renders);
 *   - "obs3d cam ..."      every camera that renders in that frame (world flag = TacticsTest+OFF_TT_MAIN_CAMERA):
 *                          RTT / HDR / zoom / flip / layer bitset and its view-projection from
 *                          Camera_GetViewProjection (0x9785e0, the matrix Camera_render post-multiplies the stack by);
 *   - "obs3d layers ..."   the world camera's enabled, non-empty layers (draw mode, item count);
 *   - "obs3d item ..."     the first item of the first non-empty enabled layer >= 0x19 (units) and of the first one
 *                          below it: raw world (x, z) and Renderer_GetScreenMatrix's 4x4 (m12/m13 = iso-projected
 *                          position, m14 = 0 in vanilla) — called only when the item's renderable is a MaskedRendererIso
 *                          (vftable check; units are, MaskedRendererIso_Submit submits `this`).
 * The TacticsTest comes from the glow engine's LateRender hook (obs3d_on_late_render), which runs every combat frame.
 * Cameras of the next frame render after LateRender; a camera observed before any LateRender of this fight is logged
 * with world=0. The line formats live in fw_obs3d_rules.c (host-tested) and are parsed by editor/src/core/ingame/obs3d.ts.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdlib.h>
#include <string.h>
#include "framework_internal.h"
#include "fw_obs3d_rules.h"

typedef void   (*fn_CameraRender)(void *cam);
typedef void   (*fn_CameraRenderOneLayer)(void *cam, int layer);
typedef float *(*fn_GetVP)(void *cam, float out[16]);
typedef float *(*fn_GetScreenMatrix)(void *renderer, float out[16]);

static fn_CameraRender g_orig;
static fn_CameraRenderOneLayer g_origOneLayer;
static int g_budget;           /* MEWFW_OBSERVE3D, read once at install */
static void *g_tt;             /* the fight's TacticsTest (from LateRender) */
static int g_worldFrame;       /* world-camera renders in this fight */
static int g_logging;          /* the current frame (since the last world render) is an observed one */
static int g_windows;          /* observed frames so far (all fights) */
static long g_calls;           /* Camera_render calls seen (the RTT cameras) */
static long g_layerCalls;      /* Camera_RenderOneLayer calls seen (world + UI cameras, once per layer) */
static int g_lateLogged;       /* "obs3d late" lines written this fight */

static void *data_ptr(int id) {
    uintptr_t a = fw_resolve_data_addr(1, g_build, g_base, id);
    return (void *)a;
}

void obs3d_on_late_render(void *tt) {
    if (g_budget <= 0 || (!g_orig && !g_origOneLayer)) return;
    if (tt != g_tt) { g_tt = tt; g_worldFrame = 0; g_logging = 0; g_lateLogged = 0; fw_log("obs3d fight tt=%p", tt); }
    /* the first late frames of a fight: is Camera_render reached, and for the world camera? */
    if (g_lateLogged < 3) {
        g_lateLogged++;
        void *world = tt ? *(void **)((unsigned char *)tt + OFF_TT_MAIN_CAMERA) : NULL;
        fw_log("obs3d late n=%d tt=%p world=%p camcalls=%ld layercalls=%ld worldframes=%d", g_lateLogged, tt, world, g_calls, g_layerCalls, g_worldFrame);
    }
}

static void log_item(int frame, void *cam, int from, int below) {
    const void *q = fw_obs3d_cam_queue(cam);
    int layer = -1;
    if (below) {
        for (int i = 0; i < from && i < fw_obs3d_layer_count(q); i++)
            if (fw_obs3d_cam_layer_on(cam, i) && fw_obs3d_item_renderable(fw_obs3d_layer(q, i), 0)) { layer = i; break; }
    } else layer = fw_obs3d_first_item_layer(cam, from);
    if (layer < 0) return;
    const void *l = fw_obs3d_layer(q, layer);
    void *rnd = fw_obs3d_item_renderable(l, 0);
    int isRenderer = fw_obs3d_is_masked_renderer_iso(rnd, g_base + g_build->rva_MaskedRendererIso_vftable);
    void *pos = isRenderer ? fw_obs3d_renderer_position(rnd) : NULL;
    double xz[2];
    fw_obs3d_position_xz(pos, xz);
    float screen[16] = { 0 };
    isRenderer = isRenderer && pos;
    if (isRenderer) ((fn_GetScreenMatrix)g_sym[FW_SYM_Renderer_GetScreenMatrix])(rnd, screen);
    char buf[1024];
    fw_obs3d_fmt_item(buf, sizeof buf, frame, layer, rnd, xz, isRenderer ? screen : NULL);
    fw_log("%s%s", buf, isRenderer ? "" : " (not a MaskedRendererIso: no position, no screen matrix)");
}

static void observe(void *cam) {
    int world = fw_obs3d_is_world_camera(g_tt, cam);
    if (world) {
        g_worldFrame++;
        g_logging = fw_obs3d_should_log(g_worldFrame, g_budget);
        if (g_logging) g_windows++;
    }
    if (!g_logging) return;
    char buf[1024];
    if (world) {
        const float *iso = data_ptr(FW_DATA_Iso), *isoinv = data_ptr(FW_DATA_IsoInverse);
        const uint8_t *flags = data_ptr(FW_DATA_RenderStateFlags);
        const int *cull = data_ptr(FW_DATA_CullDisableCounter), *top = data_ptr(FW_DATA_MatStackTop);
        const float *bias = data_ptr(FW_DATA_DepthBias);
        fw_obs3d_fmt_globals(buf, sizeof buf, iso, isoinv, flags ? *flags : 0, cull ? *cull : -1, bias ? *bias : 0.0f, top ? *top : -1);
        fw_log("%s f=%d", buf, g_worldFrame);
        void **app = data_ptr(FW_DATA_App);
        fw_obs3d_fmt_app(buf, sizeof buf, app ? *app : NULL);
        fw_log("%s f=%d", buf, g_worldFrame);
    }
    float vp[16];
    ((fn_GetVP)g_sym[FW_SYM_Camera_GetViewProjection])(cam, vp);
    fw_obs3d_fmt_camera(buf, sizeof buf, g_worldFrame, cam, world, vp);
    fw_log("%s", buf);
    if (!world) return;
    fw_obs3d_fmt_layers(buf, sizeof buf, g_worldFrame, cam);
    fw_log("%s", buf);
    log_item(g_worldFrame, cam, 0x19, 0);
    log_item(g_worldFrame, cam, 0x19, 1);
}

static void hook_Camera_render(void *cam) {
    g_calls++;
    if (cam && g_windows <= g_budget) observe(cam);
    g_orig(cam);
}

/* RenderCore's second list: every layer index x every camera (the world camera TacticsTest+0x68 and the UI camera);
 * a camera's layer-0 call opens its frame */
static void hook_Camera_RenderOneLayer(void *cam, int layer) {
    g_layerCalls++;
    if (g_budget > 0 && cam && layer == 0 && g_windows <= g_budget) observe(cam);
    g_origOneLayer(cam, layer);
    mesh_engine_after_layer(cam, layer);   /* phase M: the mesh draw functor goes in after the world camera's units layer */
}

/* the FW_SYM_Camera_render / FW_SYM_Camera_RenderOneLayer steps of FW_HOOK_PLAN: a no-op success when the observer is off
 * (Camera_render) / when neither the observer nor the mesh engine needs it (Camera_RenderOneLayer: the mesh engine's
 * record-time insertion point, mesh_engine.c) */
int obs3d_engine_hook_step(const FwHookSpec *spec) {
    g_budget = fw_obs3d_budget(getenv("MEWFW_OBSERVE3D"));
    int one = spec->index == FW_SYM_Camera_RenderOneLayer;
    if (g_budget <= 0 && !(one && mesh_engine_wants_layer_hook())) return 1;
    void *tramp = NULL;
    uintptr_t rva = g_sym[spec->index] - g_base;
    if (!g_mj.InstallHook(rva, 0, one ? (void *)hook_Camera_RenderOneLayer : (void *)hook_Camera_render, &tramp, spec->priority, FW_OWNER)) {
        fw_log("MJ_InstallHook failed for %s (rva 0x%llx)", spec->label, (unsigned long long)rva);
        return 0;
    }
    if (one) g_origOneLayer = (fn_CameraRenderOneLayer)tramp; else g_orig = (fn_CameraRender)tramp;
    fw_log("hook installed: %s rva 0x%llx (observe3d: %d window(s) of %d world frames; meshes: %s)", spec->label, (unsigned long long)rva, g_budget, FW_OBS3D_EVERY, one && mesh_engine_wants_layer_hook() ? "on" : "off");
    return 1;
}
