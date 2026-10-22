/* fw_mesh_slice.c — per-band slices of a mesh in the painter order (fw_mesh_slice.h). RED STUB. */
#include <string.h>
#include "fw_mesh_slice.h"

int fw_mesh_slice_depth(const float world[16], const float lo[3], const float hi[3], double range[2]) { (void)world; (void)lo; (void)hi; (void)range; return 0; }
int fw_mesh_slice_plan(double front, double back, int max, FwMeshSlice *out) { (void)front; (void)back; (void)max; (void)out; return 0; }
int fw_mesh_slice_visible(const float mvp[16], const float world[16], const float lo[3], const float hi[3], double dlo, double dhi, double box[4], double *area) { (void)mvp; (void)world; (void)lo; (void)hi; (void)dlo; (void)dhi; (void)box; (void)area; return 0; }
void fw_mesh_slice_tint(int band, float rgba[4]) { (void)band; memset(rgba, 0, 4 * sizeof *rgba); }
const char *fw_mesh_slice_tint_name(int band) { (void)band; return ""; }
int fw_mesh_slice_probe_at(const char *spec, char *path, size_t cap, int *col, int *row) { (void)spec; (void)path; (void)cap; (void)col; (void)row; return -1; }
int fw_mesh_slice_fmt(char *buf, size_t n, int frame, int obj, int band, int nbands, const FwMeshSlice *s, const double box[4], double area, const char *tint) { (void)frame; (void)obj; (void)band; (void)nbands; (void)s; (void)box; (void)area; (void)tint; if (buf && n) buf[0] = 0; return 0; }
