/* fw_mesh_order.c — the sprite/mesh painter-order plan (fw_mesh_order.h). Pure, host-tested (test/test_mesh_order.c).
 * red stubs */
#include <stdio.h>
#include <string.h>
#include "fw_mesh_order.h"

void fw_mesh_order_reset(FwMeshOrder *o) { (void)o; }
int fw_mesh_order_add(FwMeshOrder *o, double key, const void *anchor, int draw) { (void)o; (void)key; (void)anchor; (void)draw; return -1; }
double fw_mesh_order_tile_key(double x, double z) { (void)x; (void)z; return 0; }
double fw_mesh_order_unit_key(double x, double z) { (void)x; (void)z; return 0; }
int fw_mesh_order_before_item(FwMeshOrder *o, int index, double key, const void *renderable, int *out, int cap) { (void)o; (void)index; (void)key; (void)renderable; (void)out; (void)cap; return 0; }
int fw_mesh_order_rest(FwMeshOrder *o, int *out, int cap) { (void)o; (void)out; (void)cap; return 0; }
int fw_mesh_order_interleave(const void *layer) { (void)layer; return 0; }
double fw_mesh_order_item_key(const void *item) { (void)item; return 0; }
const void *fw_mesh_order_item_renderable(const void *item) { (void)item; return NULL; }
void *fw_mesh_order_cam_filter(const void *cam) { (void)cam; return NULL; }
void fw_mesh_order_set_cam_filter(void *cam, void *impl) { (void)cam; (void)impl; }
int fw_mesh_order_fmt(char *buf, size_t n, int frame, const FwMeshOrder *o) { (void)frame; (void)o; if (n) buf[0] = 0; return 0; }
int fw_mesh_order_fmt_keys(char *buf, size_t n, int frame, const FwMeshOrder *o) { (void)frame; (void)o; if (n) buf[0] = 0; return 0; }
int fw_mesh_order_fmt_item(char *buf, size_t n, int frame, int index, double key, const double xz[2]) { (void)frame; (void)index; (void)key; (void)xz; if (n) buf[0] = 0; return 0; }
int fw_mesh_order_filter(void *user, void **itemRef, int *layerRef) { (void)user; (void)itemRef; (void)layerRef; return 0; }
int fw_mesh_order_finish(FwMeshOrderFilter *f) { (void)f; return 0; }
int fw_mesh_order_hull(const float mvp[16], const float lo[3], const float hi[3], double box[4], double *area) { (void)mvp; (void)lo; (void)hi; (void)box; (void)area; return 0; }
int fw_mesh_order_fmt_occ(char *buf, size_t n, int frame, int col, int row, double key, const double box[4], double area) { (void)frame; (void)col; (void)row; (void)key; (void)box; (void)area; if (n) buf[0] = 0; return 0; }
