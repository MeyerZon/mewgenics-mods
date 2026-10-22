/* fw_mesh_draw.c — red stub (the green commit implements it) */
#include "fw_mesh_draw.h"
int fw_mesh_probe_parse(const char *value, int *col, int *row) { (void)value; (void)col; (void)row; return -1; }
int fw_mesh_draw_after_layer(const void *tt, const void *cam, int layer) { (void)tt; (void)cam; (void)layer; return -1; }
const float *fw_mesh_stack_top(const void *const *stackData, const int *stackTop) { (void)stackData; (void)stackTop; return (const float *)1; }
int fw_mesh_fmt_probe(char *buf, size_t n, int frame, int col, int row, const float ndc[3], const double canvas[2]) { (void)frame; (void)col; (void)row; (void)ndc; (void)canvas; if (n) buf[0] = 0; return 0; }
