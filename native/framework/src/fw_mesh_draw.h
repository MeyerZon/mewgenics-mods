/* fw_mesh_draw.h — the pure decisions of the M1 mesh path (mesh_engine.c is the glue): the probe setting, which
 * Camera_RenderOneLayer call a mesh functor is submitted after, reading the matrix stack's top, and the log lines
 * the T2 measurement (editor/scripts/art-probe.ts --mesh) reads. Host-tested in test/test_mesh_draw.c. */
#pragma once
#include <stddef.h>
#include <stdint.h>

/* MEWFW_MESH_PROBE: "1" = a cube on the default tile, "<col>,<row>" = that tile; NULL / "" / "0" / garbage = off.
 * Returns 1 and fills col/row when on. */
#define FW_MESH_PROBE_DEFAULT_COL 3
#define FW_MESH_PROBE_DEFAULT_ROW 3
int fw_mesh_probe_parse(const char *value, int *col, int *row);

/* the probe cube's flat colour (magenta: neither the arena nor the UI uses it; glow-measure.ts's GLOW_PROBE_COLOUR) */
#define FW_MESH_PROBE_R 1.0f
#define FW_MESH_PROBE_G 0.0f
#define FW_MESH_PROBE_B 1.0f
#define FW_MESH_PROBE_SIZE 0.8   /* tile units: 0.8 x 0.8 footprint, 0.8 tall */

/* submit the mesh functor after this Camera_RenderOneLayer(cam, layer) call: the world camera
 * (TacticsTest + OFF_TT_MAIN_CAMERA) drawing the units layer (CONST_UNITS_LAYER) */
int fw_mesh_draw_after_layer(const void *tacticsTest, const void *cam, int layer);

/* the matrix stack's top (MatStack data pointer at FwData MatStackData, top index at FwData MatStackTop): a pointer to
 * 16 floats, NULL when the stack is not set up or the index is negative */
const float *fw_mesh_stack_top(const void *const *stackData, const int *stackTop);

/* "mesh probe f=<frame> tile=(<c>,<r>) ndc=(<x> <y> <z>) canvas=(<x> <y>)" — the projected tile centre at the cube's
 * mid height; canvas = the 1280x720 point (VP x model only), ndc = through the stack top too */
int fw_mesh_fmt_probe(char *buf, size_t n, int frame, int col, int row, const float ndc[3], const double canvas[2]);
