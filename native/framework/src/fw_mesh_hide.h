/* fw_mesh_hide.h — `hide_sprite` (3D phase M3): a unit whose GON `graphics { model { ... hide_sprite true } }` model is
 * drawn this frame has its 2D sprite left out of the fight's units layer, so the mesh replaces the sprite instead of
 * standing next to it. Pure, host-tested (test/test_mesh_hide.c); mesh_engine.c is the glue.
 *
 * Mechanism (OBSERVED facts, docs/engine-map.md "Sprites vs meshes: painter-order interleave"):
 *  - Layer_Draw 0x9896f0 calls the camera's per-item filter std::function (Camera+OFF_CAM_LAYER_FILTER) before every
 *    item of a layer and SKIPS the item when it returns false; M2 already puts our filter there for the one
 *    Camera_RenderOneLayer(world camera, CONST_UNITS_LAYER) call (fw_mesh_order_filter);
 *  - a unit has exactly one item in the units layer: its MaskedRendererIso (Character+0x40, the item's first field =
 *    the renderable; the M2 log: 10 items, 8 of them MaskedRendererIso at the 8 units' tile centres). Everything else a
 *    unit draws is elsewhere: the Shadow component's sprite is layer 0xa (shadows), the hover outline / per-unit glow
 *    mask is layer 0x18 drawn by the MASK camera (TacticsTest+0x58), the HUD (health bars, status icons, damage text)
 *    is not in the world camera's units layer.
 * So hiding = returning false for exactly that renderable's item, in that layer, on that camera, in that frame — the
 * engine's own state is never written (the sprite keeps animating, hit-testing and sorting; only its one draw is
 * skipped). The hide filter WRAPS the order filter: the order filter still sees the skipped item first (it arms the
 * unit-attached mesh there), so the mesh still lands where the sprite would have been in the painter order.
 *
 * The decision (fw_mesh_hide_wanted): hide only when hide_sprite is true (1; "not given" and a bad value are -1, a
 * plain false 0), the object is attached to a unit (a tile object has no sprite), its renderable is known, and its
 * model's draw was added THIS frame — a model that failed to load (a coded error, mesh_engine.c resolve_model) or that
 * could not be placed never hides the sprite: the 2D clip is the fallback. */
#pragma once
#include <stddef.h>
#include "fw_functor.h"

#define FW_MESH_HIDE_MAX 64   /* units hidden per frame (FW_OBJ3D_MAX objects at most) */

typedef struct FwMeshHide {
    int n;
    const void *rnd[FW_MESH_HIDE_MAX];   /* the renderables (MaskedRendererIso*) whose units-layer item is skipped */
    int seen;                            /* items of the layer the filter saw this frame */
    int skipped;                         /* items it skipped */
} FwMeshHide;

void fw_mesh_hide_reset(FwMeshHide *h);
/* 1 when the object's sprite is to be hidden this frame (see above): hideSprite == 1 && !byTile && renderable && modelDrawn */
int fw_mesh_hide_wanted(int hideSprite, int byTile, const void *renderable, int modelDrawn);
/* remember a renderable (duplicates kept once): 1 in the set, 0 NULL / full */
int fw_mesh_hide_add(FwMeshHide *h, const void *renderable);
int fw_mesh_hide_has(const FwMeshHide *h, const void *renderable);

/* the per-item filter body that wraps an inner one (usually fw_mesh_order_filter): the inner filter runs first (or, with
 * no inner, the camera's previous impl via fw_filter_call); then an item of `layer` whose renderable is in `set` returns
 * 0 (skipped, counted). Items of other layers are what the inner filter says. */
typedef struct FwMeshHideFilter {
    FwMeshHide *set;
    int layer;           /* CONST_UNITS_LAYER */
    FwFilterFn inner;    /* NULL = chain `prev` directly */
    void *innerUser;
    void *prev;          /* the camera's filter impl before ours, used only when inner is NULL */
} FwMeshHideFilter;
int fw_mesh_hide_filter(void *user, void **itemRef, int *layerRef);   /* an FwFilterFn; user = FwMeshHideFilter* */

/* "mesh hide f=<frame> units=<n> items=<seen> skipped=<skipped>" (the length written; always NUL-terminated) */
int fw_mesh_hide_fmt(char *buf, size_t n, int frame, const FwMeshHide *h);
