/* fw_mesh_order.h — sprite/mesh occlusion for the vanilla (orthographic) tactics scene, phase M2 of
 * docs/possible_3d_work.md: the mesh draws are interleaved into the units layer's painter order instead of being drawn
 * after the whole layer. Pure, host-tested (test/test_mesh_order.c); mesh_engine.c is the glue.
 *
 * The engine facts it relies on (OBSERVED, .analysis/decompiled/Layer_Draw_0x9896f0.c, Scene_SubmitDraw_0x989be0.c,
 * Layer_SetYSorted_0x989440.c; the bytes of 0x988dd0 / 0x988d30):
 *  - a layer's items are 0x20-byte {renderable*, Position*, double key (OFF_ITEM_KEY), u32 flags}; Scene_SubmitDraw
 *    fills the key from the layer's sorter std::function (the Position's interpolated x + z + depth offsets);
 *  - a sorted layer (OFF_LAYER_SORTED) with no comparator uses 0x988dd0 = `b.key < a.key`: DESCENDING, larger key =
 *    farther = drawn first; mode 0 draws the sorted items forward (mode 1 draws them in reverse);
 *  - before every item Layer_Draw calls the CAMERA's filter std::function (impl pointer at OFF_CAM_LAYER_FILTER) as
 *    `bool _Do_call(impl, Item* const& item, int const& layer)` and skips the item when it returns false.
 * So a mesh whose key is K is drawn by submitting its functor right before the first item whose key is <= K (meshes
 * win ties: equal keys are side by side on screen), and a mesh attached to a unit right after that unit's own item. */
#pragma once
#include <stddef.h>
#include "offsets.h"
#include "fw_functor.h"

#define FW_MESH_ORDER_MAX       64     /* meshes per frame (MESH_MAX_DRAWS in mesh_engine.c) */
#define FW_MESH_ORDER_EPS       1e-6   /* a unit-attached mesh's key sits this far below its unit's key */
#define FW_MESH_ORDER_LOG_ITEMS 32     /* items remembered for the log line */

enum { FW_MESH_ORDER_PENDING = 0, FW_MESH_ORDER_ARMED = 1, FW_MESH_ORDER_DONE = 2 };

typedef struct FwMeshOrderEntry {
    double key;           /* painter key (x + z of the object's origin; a unit-attached one: its unit's x + z - EPS) */
    const void *anchor;   /* unit-attached: the unit's renderable (the item it goes right after); NULL for a tile object */
    int draw;             /* the caller's draw index */
    int state;            /* FW_MESH_ORDER_PENDING / _ARMED (its anchor was just drawn) / _DONE */
    int item;             /* the item index it was submitted before; -1 = after the whole layer (or not yet) */
    double itemKey;       /* that item's key (0 when after the layer) */
} FwMeshOrderEntry;

typedef struct FwMeshOrder {
    int n;
    FwMeshOrderEntry e[FW_MESH_ORDER_MAX];
    int items;            /* items the filter saw this frame */
    int unsorted;         /* items whose key was larger than the previous item's (the plan assumes descending keys) */
    int groups;           /* insertion points used (one draw functor each) */
    double lastKey;
    double keys[FW_MESH_ORDER_LOG_ITEMS];
    int m2;               /* 1 = the M2 tie rule (a mesh whose key equals an item's goes AFTER it); 0 (default) = M3: before */
} FwMeshOrder;

void fw_mesh_order_reset(FwMeshOrder *o);
/* MEWFW_MESH_ORDER=m2 (the T2 control runs): meshes win ties again; call after fw_mesh_order_reset */
void fw_mesh_order_set_m2(FwMeshOrder *o, int on);
/* a mesh to place this frame; returns its entry index or -1 when full */
int fw_mesh_order_add(FwMeshOrder *o, double key, const void *anchor, int draw);
/* the key of an object standing at world (x, z) (a tile object: its origin; TacticsObject puts a tile's origin on the
 * tile centre col + 0.5, row + 0.5, so a tile's key is col + row + 1, the same as a unit standing on it) */
double fw_mesh_order_tile_key(double x, double z);
/* the fallback key of a mesh attached to the unit at (x, z): just below the unit's own key */
double fw_mesh_order_unit_key(double x, double z);

/* item `index` (key, renderable) is about to be drawn: writes the draw indices to submit right before it (farther
 * first; ties keep the add order) into out[cap], marks them done and arms the meshes anchored to this renderable (they
 * go before the NEXT item). Returns the count. */
int fw_mesh_order_before_item(FwMeshOrder *o, int index, double key, const void *renderable, int *out, int cap);
/* after the layer: every mesh not submitted yet (farther first) */
int fw_mesh_order_rest(FwMeshOrder *o, int *out, int cap);

/* the filter body (mesh_engine.c installs it as the world camera's per-item filter around Camera_RenderOneLayer of the
 * units layer): for an item of `layer`, submit the meshes that go before it (one submit call = one draw functor), then
 * return what the previous filter says (fw_filter_call: none = draw). Items of other layers only chain. */
typedef void (*FwMeshOrderSubmitFn)(void *ctx, const int *draws, int n);
typedef struct FwMeshOrderFilter {
    FwMeshOrder *order;
    int layer;                    /* CONST_UNITS_LAYER */
    FwMeshOrderSubmitFn submit;
    void *ctx;
    void *prev;                   /* the camera's filter impl before ours (chained), usually NULL */
    int index;                    /* items of `layer` seen so far */
} FwMeshOrderFilter;
int fw_mesh_order_filter(void *user, void **itemRef, int *layerRef);   /* an FwFilterFn; user = FwMeshOrderFilter* */
/* after the layer: submit the rest (one functor); returns the number of meshes submitted */
int fw_mesh_order_finish(FwMeshOrderFilter *f);

/* 1 iff the layer can be interleaved: sorted (OFF_LAYER_SORTED) and drawn forward (OFF_LAYER_MODE 0) */
int fw_mesh_order_interleave(const void *layer);
/* an item's key / renderable (item = the 0x20-byte layer item) */
double fw_mesh_order_item_key(const void *item);
const void *fw_mesh_order_item_renderable(const void *item);
/* the camera's filter std::function impl pointer (NULL = none) */
void *fw_mesh_order_cam_filter(const void *cam);
void fw_mesh_order_set_cam_filter(void *cam, void *impl);

/* log lines (return the length written; always NUL-terminated):
 * "mesh order f=<frame> items=<n> meshes=<m> groups=<g> unsorted=<u> | d<draw> key=<k> before item <i> key=<k> | d<draw> key=<k> after the layer ..." */
int fw_mesh_order_fmt(char *buf, size_t n, int frame, const FwMeshOrder *o);
/* "mesh order keys f=<frame> <k0> <k1> ..." (the first FW_MESH_ORDER_LOG_ITEMS item keys in draw order) */
int fw_mesh_order_fmt_keys(char *buf, size_t n, int frame, const FwMeshOrder *o);
/* the screen silhouette of a box lo..hi (local units) through mvp (column-major, fw_m4 convention): the NDC bbox
 * {x0, y0, x1, y1} and the area of the convex hull of its 8 projected corners (NDC units^2; the T2 measurement turns it
 * into the pixel count an unoccluded flat-coloured box covers). 0 when a corner has w ~ 0. */
int fw_mesh_order_hull(const float mvp[16], const float lo[3], const float hi[3], double box[4], double *area);
/* "mesh occ f=<frame> tile=(<c>,<r>) key=<k> hull=(<x0> <y0> <x1> <y1>) area=<a>" (the probe cube) */
int fw_mesh_order_fmt_occ(char *buf, size_t n, int frame, int col, int row, double key, const double box[4], double area);
/* "mesh order item f=<frame> i=<index> key=<k> at=(<x> <z>)" (a unit item's world position) */
int fw_mesh_order_fmt_item(char *buf, size_t n, int frame, int index, double key, const double xz[2]);
