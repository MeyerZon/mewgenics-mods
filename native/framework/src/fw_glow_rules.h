/* Pure rules of the per-unit glow engine (no windows.h, no game calls) so they can be unit-tested on the host over
 * fake byte buffers (test/test_glow_rules.c) and compiled into the DLL unchanged. glow_engine.c keeps the game-facing
 * parts: the LateRender hook, the calls into the game (vec_u32_AddUnique, GetOrCreateMaterial, SetUniform*,
 * SetTexture, AddPostProcessPass) and the logging; it sequences them around the decisions and writes made here.
 *
 * The mechanism (docs/engine-map.md "Per-unit glow", .analysis/notes-rim.md): a unit is drawn into the combat outline
 * MASK by its own renderer when the renderer's extra-layer vector (+OFF_RND_EXTRA_LAYERS) lists layer
 * CONST_MASK_LAYER; the mask camera (TacticsTest+OFF_TT_MASK_CAMERA) renders that layer (the sprite multiplied by
 * white: rgb = its luminance, alpha = its coverage) into its texture (+OFF_CAM_RTT_TEXTURE), and composite passes on
 * the main camera (+OFF_TT_MAIN_CAMERA, layer CONST_COMPOSITE_LAYER) read it. The engine owns such composites
 * (materials fw_unit_glow[_<k>] / mods/fw-glow/shaders/fw_unit_glow.shader, which computes the band from the mask's
 * alpha by itself; v2: one material per colour group, one pass per draw of fw_glow_plan, scissored to a unit's screen
 * rect when colours differ), re-finds its passes in the camera's per-layer vector every frame (they die with the
 * camera) and keeps
 * the game's own white composite (TacticsTest+OFF_TT_COMPOSITE_PASS) off while units glow. The game's blur chain
 * (+OFF_TT_BLUR_PASS) is only read for tests. Every field is reached through the generated offsets.h macros. */
#pragma once
#include <stdint.h>
#include <stddef.h>
#include "offsets.h"

#define FW_GLOW_MAX_UNITS 16

/* ---- the registry: which units glow, and the pool generation each was registered with ---- */
/* fromStatus: the entry was made by a FwGlow_<hex> status (the data seam, below), not by a native FW_SetUnitGlow call:
 * fw_glow_sweep re-checks it every frame against the unit's statuses and drops it with the status */
typedef struct FwGlowEntry { void *character; uintptr_t generation; float rgba[4]; int fromStatus; } FwGlowEntry;
typedef struct FwGlowRegistry { FwGlowEntry units[FW_GLOW_MAX_UNITS]; int count; } FwGlowRegistry;

void fw_glow_reset(FwGlowRegistry *r);
int  fw_glow_find(const FwGlowRegistry *r, const void *character);               /* index, -1 if absent */
/* add (capturing the generation at Character+OFF_CH_GENERATION) or update the colour in place; 0 when character or
 * rgba is NULL or the registry is full */
int  fw_glow_set(FwGlowRegistry *r, void *character, const float rgba[4]);
int  fw_glow_clear(FwGlowRegistry *r, const void *character);                    /* 1 removed (order kept), 0 absent */
/* a new fight scene: drop the native registrations (they belong to the old scene), keep the status-sourced ones (a
 * FwGlow_ status can be applied before the new scene's first frame; prune + sweep re-validate them every frame) */
void fw_glow_reset_scene(FwGlowRegistry *r);
/* drop every entry whose Character's pool generation no longer matches the one captured (the slot was reused or
 * freed: the game validates its remembered unit the same way); returns the number dropped */
int  fw_glow_prune(FwGlowRegistry *r);
/* the first registered unit's rgba (white when empty): v1's shared colour, v2's colour group 0 */
void fw_glow_colour(const FwGlowRegistry *r, float out[4]);
int  fw_glow_colour_eq(const float a[4], const float b[4]);

/* ---- the data seam: a status named FwGlow_<rrggbb> or FwGlow_<rrggbbaa> asks for a glow (no mod DLL) ----
 * A data mod grants the status through any vanilla mechanism (StatusOnSpawnIn / StatusOnBattleStart on a character,
 * an ability's effects, a Temporary). status_engine.c recognises the name in its apply_status hook (the name-keyed
 * lookups alias it to the template like a registered name), builds a LuckUp-template object with the glow vtable and
 * registers the unit here with fromStatus = 1; every frame fw_glow_sweep asks the status engine whether the unit
 * still carries a live glow status and clears the rim when it does not. 6 or 8 hex digits, either case; alpha 0xff
 * when omitted; 13 or 15 bytes, so the name always fits the std::string SSO buffer the alias rewrite needs. */
#define FW_GLOW_STATUS_PREFIX     "FwGlow_"
#define FW_GLOW_STATUS_PREFIX_LEN 7
/* 1 and rgba (each byte / 255) when bytes[0..len) is exactly the prefix + 6 or 8 hex digits; 0 otherwise (rgba untouched) */
int  fw_glow_parse_status_name(const char *bytes, size_t len, float rgba[4]);
/* 1 when bytes[0..len) starts with the prefix: a name in the glow namespace (FW_RegisterStatus refuses it) */
int  fw_glow_status_prefixed(const char *bytes, size_t len);
/* set from a status: like fw_glow_set, and marks the entry fromStatus (a later native fw_glow_set takes it over) */
int  fw_glow_set_from_status(FwGlowRegistry *r, void *character, const float rgba[4]);
/* probe(character, rgba, user): 1 = the unit carries a live glow status (rgba = its colour), 0 = none */
typedef int (*FwGlowStatusProbe)(void *character, float rgba[4], void *user);
/* every fromStatus entry: probe it; 0 -> removed (its character appended to cleared[0..max)), 1 -> colour updated in
 * place. Native entries are not probed. Returns the number removed. Call after fw_glow_prune (the probe walks the unit) */
int  fw_glow_sweep(FwGlowRegistry *r, FwGlowStatusProbe probe, void *user, void **cleared, int max);

/* the glow status objects and their names: one vtable serves every colour, so GetTypeName / IsA answer per object
 * from this table (a ring: the oldest entry is reused when full; a stale entry is harmless because only objects
 * carrying the glow vtable are ever looked up, and put() replaces the entry of a reused address) */
#define FW_GLOW_STATUS_OBJS 32
typedef struct FwGlowStatusObj { void *obj; char name[FW_GLOW_STATUS_PREFIX_LEN + 8 + 1]; float rgba[4]; } FwGlowStatusObj;
typedef struct FwGlowStatusObjs { FwGlowStatusObj e[FW_GLOW_STATUS_OBJS]; int next; } FwGlowStatusObjs;
/* record (or re-colour) obj under a valid glow name; 0 when obj is NULL or the name does not parse */
int  fw_glow_status_put(FwGlowStatusObjs *t, void *obj, const char *name, size_t len);
const FwGlowStatusObj *fw_glow_status_get(const FwGlowStatusObjs *t, const void *obj);   /* NULL if unknown */
/* the name a glow object answers with when the table lost it (opaque white, still a valid glow name) */
#define FW_GLOW_STATUS_FALLBACK "FwGlow_ffffffff"

/* ---- v2: per-unit colours ----
 * A Material holds ONE value per uniform at draw time (the composite passes run later, in the main camera's render),
 * so each distinct colour needs its own material: colour group k draws with material slot k (fw_glow_material_name).
 * The mask holds every glowing unit at once and carries no identity, so with two or more colours each unit gets its
 * own composite pass scissored (pass rect B) to the unit's screen rect, computed as TacticsTest::LateRender computes
 * the hovered unit's (fw_glow_unit_rect); with one colour the v1 path stays: one full-screen pass. */
#define FW_GLOW_MAX_GROUPS FW_GLOW_MAX_UNITS
typedef struct FwGlowGroup { float colour[4]; int count; int units[FW_GLOW_MAX_UNITS]; } FwGlowGroup;   /* units = registry indices */
typedef struct FwGlowGroups { int count; FwGlowGroup g[FW_GLOW_MAX_GROUPS]; } FwGlowGroups;
/* the distinct colours (exact rgba equality) in order of first appearance in the registry; stable for a stable registry */
void fw_glow_groups(const FwGlowRegistry *r, FwGlowGroups *out);
int  fw_glow_group_of(const FwGlowGroups *g, int unit);                         /* group index of a registry index, -1 if none */
/* one draw = one composite pass: material slot `group`, scissored to registry unit `unit` (-1 = full screen) */
typedef struct FwGlowDraw { int group; int unit; } FwGlowDraw;
/* 0 draws when empty; ONE full-screen draw of group 0 when every unit shares a colour (v1); else one draw per unit in
 * registry order. Returns the count (<= FW_GLOW_MAX_UNITS). */
int  fw_glow_plan(const FwGlowRegistry *r, const FwGlowGroups *g, FwGlowDraw out[FW_GLOW_MAX_UNITS]);
/* the material of colour slot k: "fw_unit_glow" for 0 (the v1 name), "fw_unit_glow_<k>" after; NULL if it does not fit */
const char *fw_glow_material_name(int slot, char *buf, size_t cap);

/* the per-frame decision over the registry: groups + draws (colour = group 0's, white when empty) */
typedef struct FwGlowFrame { int active; float colour[4]; FwGlowGroups groups; int ndraws; FwGlowDraw draws[FW_GLOW_MAX_UNITS]; } FwGlowFrame;
void fw_glow_frame(const FwGlowRegistry *r, FwGlowFrame *out);

/* ---- v2: a unit's screen rect, LateRender's hovered-unit math (0x88e24e..0x88e4a0, OBSERVED in the disassembly) ----
 * bounds = clip vtable slot VT_CLIP_BOUNDS -> {x0, x1, y0, y1}; fw_glow_clip_bounds (a replica of the leaf 0x9d46d0)
 * by the clip matrix at clip+OFF_CLIP_MATRIX; fw_glow_matrix_bounds by Renderer_GetScreenMatrix(renderer);
 * fw_glow_view_rect by C = inverse(Position_GetViewMatrix(maskCamera+OFF_CAM_POSITION, interp)) (fw_glow_mat4_inverse
 * replaces the leaf 0xa07c70) times the zoom matrix {zoom, 0 / 0, zoom*zoomY / 0,0,1,0 / 640,360,0,1}, divided by the
 * 1280x720 canvas, y flipped. Normalized like the pass rects (0..1, x0 < x1, y0 < y1). */
/* the game's virtual canvas, from the generated offsets.h (manifest constants GlowCanvasWidth/Height, read back from the
 * .rdata floats 1/1280 (0x14113f47c) and 1/720 (0x14113f488) LateRender multiplies by); the centre (640, 360) is half */
#define FW_GLOW_CANVAS_W ((double)CONST_GLOW_CANVAS_W)
#define FW_GLOW_CANVAS_H ((double)CONST_GLOW_CANVAS_H)
typedef struct FwGlowRect { double x0, x1, y0, y1; } FwGlowRect;
void fw_glow_clip_bounds(float b[4], const float m[6]);
void fw_glow_matrix_bounds(float b[4], const float M[16]);
int  fw_glow_mat4_inverse(const float m[16], float out[16]);                   /* 0 when singular */
void fw_glow_view_rect(const float b[4], const float C[16], double zoom, int zoomY, FwGlowRect *out);
/* the chain + `margin` canvas px on every side, clamped to 0..1: 1 ok, -1 wholly off screen, 0 singular view / NaN */
int  fw_glow_unit_rect(const float rawBounds[4], const float clipM[6], const float screenM[16], const float viewM[16],
                       double zoom, int zoomY, double margin, FwGlowRect *out);
/* the renderer's clip (+OFF_RND_CLIP) when its vtable slot 0 reports CONST_CLIP_KIND_A or _B (LateRender's check), else NULL */
void *fw_glow_unit_clip(const void *renderer);
void  fw_glow_clip_raw_bounds(void *clip, float out[4]);                        /* vtable slot VT_CLIP_BOUNDS */
const float *fw_glow_clip_matrix(const void *clip);                             /* clip+OFF_CLIP_MATRIX, 6 floats */
static inline void  *fw_glow_camera_position(const void *camera) { return *(void *const *)((const char *)camera + OFF_CAM_POSITION); }
/* the scene manager's frame interpolation factor (Component+OFF_COMPONENT_SCENEMANAGER -> +OFF_SCENEMANAGER_INTERP); 1.0 without one */
static inline double fw_glow_camera_interp(const void *camera) {
    const char *sm = *(const char *const *)((const char *)camera + OFF_COMPONENT_SCENEMANAGER);
    return sm ? *(const double *)(sm + OFF_SCENEMANAGER_INTERP) : 1.0;
}
static inline double fw_glow_camera_zoom(const void *camera) { return *(const double *)((const char *)camera + OFF_CAM_ZOOM); }
static inline int    fw_glow_camera_zoom_y(const void *camera) { return *(const int *)((const char *)camera + OFF_CAM_ZOOM_Y); }

/* ---- accessors (generated offsets) ---- */
static inline void     *fw_glow_renderer(const void *character) { return *(void *const *)((const char *)character + OFF_CH_RENDERER); }
static inline uintptr_t fw_glow_generation(const void *character) { return *(const uintptr_t *)((const char *)character + OFF_CH_GENERATION); }
/* the vec_u32 {cap, count, data} vec_u32_AddUnique takes */
static inline void     *fw_glow_extra_layers(void *renderer) { return (char *)renderer + OFF_RND_EXTRA_LAYERS; }
static inline void     *fw_glow_mask_camera(const void *tt) { return *(void *const *)((const char *)tt + OFF_TT_MASK_CAMERA); }
static inline void     *fw_glow_main_camera(const void *tt) { return *(void *const *)((const char *)tt + OFF_TT_MAIN_CAMERA); }
static inline void     *fw_glow_blur_pass(const void *tt) { return *(void *const *)((const char *)tt + OFF_TT_BLUR_PASS); }
/* the game's white composite_outlines pass on the main camera: it paints (1 - luminance) white over every unit in the
 * mask while its predicate holds, so the engine disables it while units are registered */
static inline void     *fw_glow_composite_pass(const void *tt) { return *(void *const *)((const char *)tt + OFF_TT_COMPOSITE_PASS); }
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
/* v2: every pass in (camera+OFF_CAM_PASSES)[layer] whose first material is one of mats[0..nmats), in vector order (<= max) */
int   fw_glow_collect_passes(const void *camera, int layer, void *const *mats, int nmats, void **out, int max);
void *fw_glow_pass_first_material(const void *pass);
void  fw_glow_pass_set_material(void *pass, void *material);                    /* the first {Material*, int} entry */
/* the scissor (rect B) to r; NULL = full screen {0,1,0,1}. Rect A is left alone, as the game's composites leave it */
void  fw_glow_pass_set_rect(void *pass, const FwGlowRect *r);
