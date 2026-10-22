/* fw_mesh_slice.h — 3D phase M3 items 6 + 7 (docs/possible_3d_work.md): a mesh is placed in the units layer's painter
 * order by its own footprint, not by one point. Pure, host-tested (test/test_mesh_slice.c); mesh_engine.c is the glue.
 *
 * The units layer is drawn far-to-near by the item key = x + z of the unit's feet (fw_mesh_order.h; a unit on tile
 * (c, r) has the key c + r + 1, an integer). A mesh spans the depth range [front, back] = min/max of world x + z over
 * its bounds. It is cut into SLICES along that depth, one per sort band [n, n + 1) (n integer, the bands between the
 * keys of two neighbouring tile diagonals), and every slice is drawn at its own place in the painter order with a clip
 * on world x + z (fw_mesh.shader: fw_clip = [lo, hi), the first slice open towards the front, the last towards the
 * back). A slice's key is the middle of its band (n + 0.5): it goes in before every unit standing at or in front of the
 * band's front edge n (those units are drawn over it) and after every unit behind it (it is drawn over them). So:
 *  - item 6, a multi-tile mesh: each row of tiles is drawn at its own depth, giving correct occlusion against cats
 *    standing in front of one part and behind another;
 *  - item 7, a mesh and a unit on the same tile: only the part of the mesh in front of the unit's feet is drawn over
 *    the unit, the part behind them goes under it (a mesh behind the feet does not cover a unit standing in front of
 *    it). Exact ties (a key equal to an item's key: merged bands) go to the unit: the mesh is drawn first (stable, not
 *    dependent on the add order) — fw_mesh_order_before_item's tie rule.
 * A mesh attached to a unit is not sliced: it still goes right after its own unit (fw_mesh_order.h).
 * More than FW_MESH_SLICE_MAX bands: neighbouring bands are merged (the band width grows), keeping the count bounded. */
#pragma once
#include <stddef.h>

#define FW_MESH_SLICE_MAX  8          /* slices per mesh (a 3x3 footprint needs 6) */
#define FW_MESH_CLIP_OPEN  1.0e30f    /* an open clip end */
#define FW_MESH_SLICE_EPS  1e-6       /* a depth this close to a band edge counts as on it */

typedef struct FwMeshSlice {
    double lo, hi;        /* the band [lo, hi) in world x + z */
    double key;           /* its painter key: (lo + hi) / 2 */
    float clip[2];        /* the shader's fw_clip: [lo, hi), with FW_MESH_CLIP_OPEN at the open ends */
} FwMeshSlice;

/* the depth range of a box lo..hi (local units) under the world matrix (column-major): range = {min, max} of world
 * x + z over its 8 corners. 0 when an argument is missing. */
int fw_mesh_slice_depth(const float world[16], const float lo[3], const float hi[3], double range[2]);
/* the slices of a mesh spanning depth [front, back] (front <= back): writes up to max (<= FW_MESH_SLICE_MAX) slices,
 * farthest LAST (index 0 = the front band), returns the count (>= 1; 0 for a bad argument). */
int fw_mesh_slice_plan(double front, double back, int max, FwMeshSlice *out);
/* the screen footprint of the slice dlo <= x + z < dhi of the box lo..hi under world / mvp: the summed NDC area of the
 * parts of its front-facing faces (oriented like the top face) inside the slice — the pixels a flat-coloured slice
 * shows when nothing covers it — and their NDC bbox {x0, y0, x1, y1}. 0 when nothing is inside or a w is ~0. */
int fw_mesh_slice_visible(const float mvp[16], const float world[16], const float lo[3], const float hi[3], double dlo, double dhi, double box[4], double *area);

/* the measurement tint of band i (MEWFW_MESH_PROBE_TINT): blue, cyan, magenta, repeating (no two neighbours alike) */
void fw_mesh_slice_tint(int band, float rgba[4]);
const char *fw_mesh_slice_tint_name(int band);

/* MEWFW_MESH_PROBE_MODEL's optional "@<col>,<row>" suffix ("models/slab.obj@0,6"): copies the path without it into
 * path[cap]. Returns 1 with col/row set when the suffix is there, 0 when it is not, -1 when it is malformed (or the
 * path does not fit). */
int fw_mesh_slice_probe_at(const char *spec, char *path, size_t cap, int *col, int *row);

/* "mesh slice f=<frame> obj=<obj> band=<i>/<n> depth=[<lo> <hi>) key=<k> vis=(<x0> <y0> <x1> <y1>) area=<a> tint=<name>"
 * (the band, not the clip: the first/last slice's clip is open beyond it); returns the length (always NUL-terminated) */
int fw_mesh_slice_fmt(char *buf, size_t n, int frame, int obj, int band, int nbands, const FwMeshSlice *s, const double box[4], double area, const char *tint);
