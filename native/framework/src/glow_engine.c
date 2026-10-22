/*
 * glow_engine.c — per-unit glow (API v4): FW_SetUnitGlow / FW_ClearUnitGlow.
 *
 * The game has no per-Character glow field. What it has is a hover outline: `StatusMenu::update` pushes draw layer
 * CONST_MASK_LAYER (0x18) onto the hovered unit's renderer extra-layer vector, the unit's own `MaskedRendererIso_Submit`
 * then submits it once more into that layer, the mask camera (`TacticsTest+OFF_TT_MASK_CAMERA`, layer 0x18 only, draw
 * mode 3 = the sprite multiplied by white, so the mask carries the sprite's own luminance and its ALPHA is the
 * coverage) renders it to its RGBA texture, and the game's passes (a blur chain on the mask camera, the white
 * `composite_outlines` at pass index CONST_COMPOSITE_LAYER on the main camera, or the jump-flood route) shape a rim
 * out of it. Decoded in .analysis/notes-rim.md; what the in-game shots of 2026-10-22 corrected is recorded in
 * docs/engine-map.md "Per-unit glow".
 *
 * We ride that mask instead of building our own: every frame, after the game's own `TacticsTest::LateRender`
 * (vftable slot VT_TT_LATERENDER) has run, the engine (1) puts every registered unit into layer 0x18 with the game's
 * `vec_u32_AddUnique` — re-done every frame because `StatusMenu::update` strips 0x18 from the unit the hover just
 * left — (2) keeps mod-owned composites (mods/fw-glow/shaders/fw_unit_glow.shader: the band is computed from the
 * mask's alpha in the shader itself, no game pass needed) on the main camera at layer 0x1a with `framebuf` = the mask
 * camera's texture, re-finding their Pass* in the camera's per-layer vector each frame (passes die with the camera
 * when the fight scene ends): v2 (per-unit colours) groups the units by colour, one material per colour group
 * ("fw_unit_glow", "fw_unit_glow_1", … — a Material holds one `glow_color` when the passes run, so a colour needs its
 * own), and draws ONE full-screen pass when every unit shares a colour (exactly v1) or, with several colours, one pass
 * per unit with its group's material, scissored (pass rect B) to the unit's screen rect computed the way LateRender
 * computes the hovered unit's (clip bounds -> clip matrix -> Renderer_GetScreenMatrix -> inverse of the mask camera's
 * Position_GetViewMatrix x zoom -> the 1280x720 canvas; fw_glow_unit_rect) — the mask itself carries no unit identity,
 * so the scissor is what keeps one unit's colour off its neighbours; and (3) keeps the
 * game's white composite_outlines off while units are registered (its predicate is "the mask had content", so it
 * would wash every glowing unit's body white). Running after the original is what makes our writes win; the hook
 * therefore wraps the function rather than replacing it.
 *
 * Why MJ_InstallHook on the function and not a vtable slot swap: the framework installs every other hook through
 * Mewjector (chainable, priorities, one install path, undone on unload by Mewjector), the function is reached only
 * through the slot so a prologue hook sees exactly the slot's calls, and the slot is still verified: the install step
 * refuses the hook unless `TacticsTest_vftable[VT_TT_LATERENDER]` is the signature-resolved address (the vtable
 * binding is the second witness of the hook target).
 *
 * Limits (documented in engine-map): with several colours, units whose screen rects overlap share pixels of both
 * rims inside the overlap, and a unit whose rect cannot be computed (no clip of the two kinds LateRender takes) loses
 * its rim rather than painting it on everyone; combat scenes only (TacticsTest); the rim shader ships as data (mods/fw-glow must be on the mod path, else the material
 * has no shader and nothing is drawn); the game's white hover rim is off while any unit glows; registrations
 * are per fight scene (a new TacticsTest resets the registry) and a unit whose pool slot was reused is dropped
 * (generation check, the game's own idiom); main thread only (the harness and turn callbacks are).
 *
 * This file is game-facing glue: the decisions and the object writes are host-tested in fw_glow_rules.c. Every
 * number comes from the generated signatures.h / offsets.h.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string.h>
#include "framework_internal.h"
#include "fw_glow_rules.h"
#include "fw_vtable.h"   /* fw_msvc_init: the by-value std::string arguments the game destroys */

typedef void  (*fn_LateRender)(void *tt);
typedef int   (*fn_AddUnique)(void *vec, const uint32_t *value);
typedef void *(*fn_GetOrCreateMaterial)(void *mgr, MsvcString *name, MsvcString *shaderFile);
typedef void  (*fn_SetUniformVec4)(void *mat, MsvcString *name, float x, float y, float z, float w);
typedef void  (*fn_SetUniformFloat)(void *mat, MsvcString *name, float v);
typedef void  (*fn_SetTexture)(void *mat, MsvcString *name, void *tex, int slot);
typedef void *(*fn_AddPass)(void *camera, void *material, int layer);
typedef float *(*fn_GetScreenMatrix)(void *renderer, float out[16]);
typedef float *(*fn_GetViewMatrix)(void *position, float out[16], double interp);

#define GLOW_SHADER   "fw_unit_glow.shader"   /* ours (mods/fw-glow/shaders/): the rim computed from the mask's alpha, no blur chain needed */
#define GLOW_RADIUS   12.0f                    /* band width in mask texels (the mask texture is window-sized at scale 1.0) */
#define GLOW_MARGIN   20.0                     /* canvas px (1280x720) added around a unit's rect: the band (GLOW_RADIUS mask texels, <= 1 canvas px each from 1280 wide up) plus slack */

static fn_LateRender g_orig;
static FwGlowRegistry g_reg;
static void *g_tt;              /* the TacticsTest of the last frame: another one = a new fight scene */
/* one material per colour slot (fw_glow_material_name: "fw_unit_glow", "fw_unit_glow_1", …), created on first need;
 * the ShaderManager keeps them for the process lifetime. A Material has one value per uniform when the passes run,
 * so a colour needs its own material. */
static void *g_mats[FW_GLOW_MAX_GROUPS];
static int g_nmats;
static void *g_matTexture[FW_GLOW_MAX_GROUPS];   /* the mask texture each material's framebuf is bound to (per fight) */
static float g_matColour[FW_GLOW_MAX_GROUPS][4];
static int g_matColourSet[FW_GLOW_MAX_GROUPS];
static int g_matFailed;         /* material creation failed once: say so once, never retry every frame */
static int g_rectFailLogged;    /* a unit's screen rect could not be computed: said once */
static int g_gameCompositeOff;  /* we disabled the game's composite_outlines pass; restore it when the last unit goes */

static int make_str(MsvcString *s, const char *text) {
    return fw_msvc_init(s, text, (FwStringAlloc)g_sym[FW_SYM_string_Allocate]);
}

/* materials for slots 0..k, in order */
static int ensure_material(int k) {
    while (g_nmats <= k) {
        if (g_matFailed) return 0;
        char nameBuf[32];
        const char *matName = fw_glow_material_name(g_nmats, nameBuf, sizeof nameBuf);
        uintptr_t slot = fw_resolve_data_addr(1, g_build, g_base, FW_DATA_ShaderManager);
        void *mgr = slot ? *(void **)slot : NULL;
        MsvcString name, file, uni;
        if (!matName || !mgr || !make_str(&name, matName) || !make_str(&file, GLOW_SHADER)) {
            fw_log("glow: no ShaderManager (%p) or no string memory; glow disabled", mgr);
            g_matFailed = 1;
            return 0;
        }
        void *mat = ((fn_GetOrCreateMaterial)g_sym[FW_SYM_ShaderManager_GetOrCreateMaterial])(mgr, &name, &file);   /* destroys both strings */
        if (!mat) { fw_log("glow: GetOrCreateMaterial(%s, %s) returned null; glow disabled", matName, GLOW_SHADER); g_matFailed = 1; return 0; }
        make_str(&uni, "glow_radius");
        ((fn_SetUniformFloat)g_sym[FW_SYM_Material_SetUniformFloat])(mat, &uni, GLOW_RADIUS);
        g_mats[g_nmats] = mat;
        g_matTexture[g_nmats] = NULL;
        g_matColourSet[g_nmats] = 0;
        fw_log("glow: material %s (%s) = %p, glow_radius %.0f", matName, GLOW_SHADER, mat, (double)GLOW_RADIUS);
        g_nmats++;
    }
    return 1;
}

static void bind_mask_texture(int k, void *tex) {
    MsvcString uni;
    if (!tex) return;
    make_str(&uni, "framebuf");
    ((fn_SetTexture)g_sym[FW_SYM_Material_SetTexture])(g_mats[k], &uni, tex, CONST_GLOW_FRAMEBUF_SLOT);
    g_matTexture[k] = tex;
}

static void set_colour(int k, const float c[4]) {
    MsvcString uni;
    make_str(&uni, "glow_color");
    ((fn_SetUniformVec4)g_sym[FW_SYM_Material_SetUniformVec4])(g_mats[k], &uni, c[0], c[1], c[2], c[3]);
    memcpy(g_matColour[k], c, sizeof g_matColour[k]);
    g_matColourSet[k] = 1;
    fw_log("glow: slot %d glow_color = %.2f %.2f %.2f %.2f", k, (double)c[0], (double)c[1], (double)c[2], (double)c[3]);
}

/* the unit's screen rect exactly as LateRender computes the hovered unit's (fw_glow_unit_rect: 1 ok, -1 off screen, 0 failed) */
static int unit_rect(void *tt, void *character, FwGlowRect *out) {
    void *rnd = fw_glow_renderer(character);
    void *clip = fw_glow_unit_clip(rnd);
    void *maskCam = fw_glow_mask_camera(tt);
    void *pos = maskCam ? fw_glow_camera_position(maskCam) : NULL;
    if (!clip || !pos) return 0;
    float raw[4], screen[16], view[16];
    fw_glow_clip_raw_bounds(clip, raw);
    ((fn_GetScreenMatrix)g_sym[FW_SYM_Renderer_GetScreenMatrix])(rnd, screen);
    ((fn_GetViewMatrix)g_sym[FW_SYM_Position_GetViewMatrix])(pos, view, fw_glow_camera_interp(maskCam));
    return fw_glow_unit_rect(raw, fw_glow_clip_matrix(clip), screen, view, fw_glow_camera_zoom(maskCam), fw_glow_camera_zoom_y(maskCam), GLOW_MARGIN, out);
}

static void disable_our_passes(void *mainCam) {
    void *passes[FW_GLOW_MAX_UNITS];
    int n = fw_glow_collect_passes(mainCam, CONST_COMPOSITE_LAYER, g_mats, g_nmats, passes, FW_GLOW_MAX_UNITS);
    for (int i = 0; i < n; i++) fw_glow_pass_force(passes[i], 0, 0);
}

/* the per-frame plan, after the game's LateRender */
static void glow_frame(void *tt) {
    if (tt != g_tt) {
        if (g_tt) { fw_log("glow: new fight scene (TacticsTest %p -> %p): %d registration(s) dropped", g_tt, tt, g_reg.count); fw_glow_reset(&g_reg); }
        g_tt = tt;
        for (int k = 0; k < FW_GLOW_MAX_GROUPS; k++) g_matTexture[k] = NULL;   /* a new scene has new cameras: re-bind framebuf */
    }
    int dropped = fw_glow_prune(&g_reg);
    if (dropped) fw_log("glow: %d unit(s) dropped (pool generation moved)", dropped);
    static FwGlowFrame f;   /* ~1.4 KB: kept off the game thread's stack */
    fw_glow_frame(&g_reg, &f);
    void *mainCam = fw_glow_main_camera(tt), *maskCam = fw_glow_mask_camera(tt);
    if (!mainCam || !maskCam) return;
    if (!f.active) {
        if (g_nmats) disable_our_passes(mainCam);
        if (g_gameCompositeOff) { fw_glow_pass_force(fw_glow_composite_pass(tt), 1, 0); g_gameCompositeOff = 0; }
        return;
    }
    /* 0. the game's white composite_outlines would wash every masked unit's body white ((1 - luminance) of the
     *    mask, which is the sprite multiplied by white, not a flat silhouette): off while we have units, as LateRender
     *    itself does on hovered frames in jump-flood mode; back on when the last unit is cleared */
    fw_glow_pass_force(fw_glow_composite_pass(tt), 0, 0);
    g_gameCompositeOff = 1;
    /* 1. every registered unit submits itself into the mask layer (StatusMenu strips it from the unit the hover left) */
    uint32_t layer = CONST_MASK_LAYER;
    for (int i = 0; i < g_reg.count; i++) {
        void *rnd = fw_glow_renderer(g_reg.units[i].character);
        if (rnd && !fw_glow_layers_has(rnd, layer)) ((fn_AddUnique)g_sym[FW_SYM_vec_u32_AddUnique])(fw_glow_extra_layers(rnd), &layer);
    }
    /* 2. one material per colour group, reading the mask camera's texture, with the group's colour */
    if (!ensure_material(f.groups.count - 1)) return;
    void *tex = fw_glow_camera_texture(maskCam);
    for (int k = 0; k < f.groups.count; k++) {
        if (tex != g_matTexture[k]) bind_mask_texture(k, tex);
        if (!g_matColourSet[k] || !fw_glow_colour_eq(g_matColour[k], f.groups.g[k].colour)) set_colour(k, f.groups.g[k].colour);
    }
    /* 3. one composite pass per draw on the main camera (re-found every frame: passes die with the camera): one colour
     *    = one full-screen pass (v1), several = one pass per unit scissored to its screen rect */
    void *passes[FW_GLOW_MAX_UNITS];
    int n = fw_glow_collect_passes(mainCam, CONST_COMPOSITE_LAYER, g_mats, g_nmats, passes, FW_GLOW_MAX_UNITS);
    while (n < f.ndraws) {
        void *pass = ((fn_AddPass)g_sym[FW_SYM_Camera_AddPostProcessPass])(mainCam, g_mats[f.draws[n].group], CONST_COMPOSITE_LAYER);
        if (!pass) { fw_log("glow: AddPostProcessPass failed"); break; }
        fw_glow_pass_adopt(pass);
        fw_log("glow: pass %p added on camera %p at layer 0x%x (%d of ours), framebuf = mask texture %p (slot %d)", pass, mainCam, CONST_COMPOSITE_LAYER, n + 1, tex, CONST_GLOW_FRAMEBUF_SLOT);
        passes[n++] = pass;
    }
    for (int i = 0; i < n; i++) {
        if (i >= f.ndraws) { fw_glow_pass_force(passes[i], 0, 0); continue; }
        const FwGlowDraw *d = &f.draws[i];
        fw_glow_pass_set_material(passes[i], g_mats[d->group]);
        if (d->unit < 0) { fw_glow_pass_set_rect(passes[i], NULL); fw_glow_pass_force(passes[i], 1, 0); continue; }
        FwGlowRect r;
        int rc = unit_rect(tt, g_reg.units[d->unit].character, &r);
        if (rc == 0 && !g_rectFailLogged) { fw_log("glow: no screen rect for unit %p (no clip of kind %d/%d, or a singular view); its rim is skipped", g_reg.units[d->unit].character, CONST_CLIP_KIND_A, CONST_CLIP_KIND_B); g_rectFailLogged = 1; }
        if (rc == 1) fw_glow_pass_set_rect(passes[i], &r);
        fw_glow_pass_force(passes[i], rc == 1, 0);   /* off screen or no rect: this pass draws nothing (never another unit's rim in this colour) */
    }
}

static void hook_TacticsTest_LateRender(void *tt) {
    if (g_orig) g_orig(tt);
    glow_frame(tt);
}

/* ----------------------------------------------------------------------- */
/* install: the glow step of FW_HOOK_PLAN                                   */
/* ----------------------------------------------------------------------- */
int glow_engine_hook_step(const FwHookSpec *spec) {
    void **vt = (void **)(g_base + g_build->rva_TacticsTest_vftable);
    uintptr_t target = g_sym[spec->index];
    if ((uintptr_t)vt[VT_TT_LATERENDER] != target) {
        fw_log("glow: TacticsTest vftable slot %d is %p, the resolved LateRender is 0x%llx; glow hook not installed",
               VT_TT_LATERENDER, vt[VT_TT_LATERENDER], (unsigned long long)target);
        return 0;
    }
    void *tramp = NULL;
    uintptr_t rva = target - g_base;
    if (!g_mj.InstallHook(rva, 0, (void *)hook_TacticsTest_LateRender, &tramp, spec->priority, FW_OWNER)) {
        fw_log("MJ_InstallHook failed for %s (rva 0x%llx)", spec->label, (unsigned long long)rva);
        return 0;
    }
    g_orig = (fn_LateRender)tramp;
    fw_log("hook installed: %s rva 0x%llx (TacticsTest vftable slot %d verified)", spec->label, (unsigned long long)rva, VT_TT_LATERENDER);
    return 1;
}

/* ----------------------------------------------------------------------- */
/* runtime API                                                              */
/* ----------------------------------------------------------------------- */
int glow_engine_set(void *character, const float rgba[4]) {
    if (!g_orig) { fw_log("SetUnitGlow: the glow hook is not installed"); return 0; }
    int ok = fw_glow_set(&g_reg, character, rgba);
    fw_log("SetUnitGlow(%p, %.2f %.2f %.2f %.2f): %s (%d registered)", character,
           rgba ? (double)rgba[0] : 0.0, rgba ? (double)rgba[1] : 0.0, rgba ? (double)rgba[2] : 0.0, rgba ? (double)rgba[3] : 0.0,
           ok ? "ok" : "refused (null, or registry full)", g_reg.count);
    return ok;
}

int glow_engine_clear(void *character) {
    int i = fw_glow_find(&g_reg, character);
    if (i < 0) return 0;
    /* take the unit out of the mask now rather than next frame; the pool generation guards the freed-slot case.
     * If the game's hover put the unit there too, its white rim goes until the hover changes (StatusMenu re-adds
     * the layer only on a hover change). */
    if (fw_glow_generation(character) == g_reg.units[i].generation) fw_glow_layers_strip(fw_glow_renderer(character), CONST_MASK_LAYER);
    fw_glow_clear(&g_reg, character);
    fw_log("ClearUnitGlow(%p): cleared (%d registered)", character, g_reg.count);
    return 1;
}
