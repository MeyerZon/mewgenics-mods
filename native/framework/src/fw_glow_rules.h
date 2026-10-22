/* Pure rules of the per-unit glow engine (no windows.h, no game calls) so they can be unit-tested on the host over
 * fake byte buffers (test/test_glow_rules.c) and compiled into the DLL unchanged. glow_engine.c keeps the game-facing
 * parts: the LateRender hook, the calls into the game (vec_u32_AddUnique, GetOrCreateMaterial, SetUniform*,
 * SetTexture, AddPostProcessPass) and the logging; it sequences them around the decisions and writes made here.
 *
 * The mechanism (docs/engine-map.md "Per-unit glow", .analysis/notes-rim.md): a unit is drawn into the combat outline
 * MASK by its own renderer when the renderer's extra-layer vector (+OFF_RND_EXTRA_LAYERS) lists layer
 * CONST_MASK_LAYER; the mask camera (TacticsTest+OFF_TT_MASK_CAMERA) renders that layer flat white into its texture
 * (+OFF_CAM_RTT_TEXTURE), the game's blur chain (TacticsTest+OFF_TT_BLUR_PASS) spreads it, and a composite pass on the
 * main camera (+OFF_TT_MAIN_CAMERA, layer CONST_COMPOSITE_LAYER) paints a colour wherever the blurred mask is set and
 * the unblurred mask is not. The engine owns one such composite (material fw_unit_glow / composite_glow.shader) and
 * re-finds its pass in the camera's per-layer vector every frame (passes die with the camera). Every field is reached
 * through the generated offsets.h macros. */
#pragma once
#include <stdint.h>
#include <stddef.h>
#include "offsets.h"

#define FW_GLOW_MAX_UNITS 16

/* ---- the registry: which units glow, and the pool generation each was registered with ---- */
typedef struct FwGlowEntry { void *character; uintptr_t generation; float rgba[4]; } FwGlowEntry;
typedef struct FwGlowRegistry { FwGlowEntry units[FW_GLOW_MAX_UNITS]; int count; } FwGlowRegistry;

void fw_glow_reset(FwGlowRegistry *r);
int  fw_glow_find(const FwGlowRegistry *r, const void *character);               /* index, -1 if absent */
/* add (capturing the generation at Character+OFF_CH_GENERATION) or update the colour in place; 0 when character or
 * rgba is NULL or the registry is full */
int  fw_glow_set(FwGlowRegistry *r, void *character, const float rgba[4]);
int  fw_glow_clear(FwGlowRegistry *r, const void *character);                    /* 1 removed (order kept), 0 absent */
/* drop every entry whose Character's pool generation no longer matches the one captured (the slot was reused or
 * freed: the game validates its remembered unit the same way); returns the number dropped */
int  fw_glow_prune(FwGlowRegistry *r);
/* v1 has ONE composite, hence one shared colour: the first registered unit's rgba (white when empty) */
void fw_glow_colour(const FwGlowRegistry *r, float out[4]);
int  fw_glow_colour_eq(const float a[4], const float b[4]);

/* the per-frame decision over the registry */
typedef struct FwGlowFrame { int active; float colour[4]; } FwGlowFrame;
void fw_glow_frame(const FwGlowRegistry *r, FwGlowFrame *out);

/* ---- accessors (generated offsets) ---- */
static inline void     *fw_glow_renderer(const void *character) { return *(void *const *)((const char *)character + OFF_CH_RENDERER); }
static inline uintptr_t fw_glow_generation(const void *character) { return *(const uintptr_t *)((const char *)character + OFF_CH_GENERATION); }
/* the vec_u32 {cap, count, data} vec_u32_AddUnique takes */
static inline void     *fw_glow_extra_layers(void *renderer) { return (char *)renderer + OFF_RND_EXTRA_LAYERS; }
static inline void     *fw_glow_mask_camera(const void *tt) { return *(void *const *)((const char *)tt + OFF_TT_MASK_CAMERA); }
static inline void     *fw_glow_main_camera(const void *tt) { return *(void *const *)((const char *)tt + OFF_TT_MAIN_CAMERA); }
static inline void     *fw_glow_blur_pass(const void *tt) { return *(void *const *)((const char *)tt + OFF_TT_BLUR_PASS); }
static inline void     *fw_glow_camera_texture(const void *camera) { return *(void *const *)((const char *)camera + OFF_CAM_RTT_TEXTURE); }

/* ---- the renderer's extra-layer vector ---- */
int fw_glow_layers_has(const void *renderer, uint32_t layer);        /* 0 for NULL / empty */
int fw_glow_layers_strip(void *renderer, uint32_t layer);            /* swap-remove every entry == layer (StatusMenu's loop); returns removed */

/* ---- passes ---- */
/* the Pass* in (camera+OFF_CAM_PASSES)[layer] whose first material entry is `material`; NULL when none / NULL args */
void *fw_glow_find_pass(const void *camera, int layer, const void *material);
/* +OFF_PASS_ENABLED = enabled; with fullScreen both rects become {0,1,0,1} (the game narrows them to the hovered unit) */
void  fw_glow_pass_force(void *pass, int enabled, int fullScreen);
/* a pass the engine just added: enabled, flags zeroed like the game's own composites */
void  fw_glow_pass_adopt(void *pass);
