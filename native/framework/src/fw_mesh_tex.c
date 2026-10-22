/* fw_mesh_tex.c — the pure texture / palette rules of the mesh path (fw_mesh_tex.h). RED stub. */
#include <string.h>
#include "fw_mesh_tex.h"

int fw_tex_name_ok(const char *name) { (void)name; return 0; }
int fw_tex_default_name(const char *modelPath, char *out, size_t cap) { (void)modelPath; if (out && cap) out[0] = 0; return 0; }
int fw_tex_choose(const char *explicitName, const char *modelPath, int materialNamedImage, FwTexChoice *out) { (void)explicitName; (void)modelPath; (void)materialNamedImage; memset(out, 0, sizeof *out); return 0; }
int fw_png_check(const uint8_t *bytes, size_t len, int *w, int *h, char *why, size_t cap) { (void)bytes; (void)len; (void)w; (void)h; (void)why; (void)cap; return -1; }
int fw_palette_row(int requested, int paletteHeight) { (void)requested; (void)paletteHeight; return -2; }
FwTexEntry *fw_tex_cache_get(FwTexCache *c, const char *name, int create) { (void)c; (void)name; (void)create; return NULL; }
uint32_t fw_tex_gl_name(const void *texture2d) { (void)texture2d; return 0xffffffffu; }
void fw_mesh_material_plan(uint32_t texName, uint32_t paletteName, int paletteRow, FwMeshMaterialPlan *out) { (void)texName; (void)paletteName; (void)paletteRow; memset(out, 0xff, sizeof *out); }
int fw_mesh_fmt_object(char *buf, size_t n, int frame, int handle, const char *model, int byTile, const float world[3], const float ndc[3], const char *tex, int palette) {
    (void)frame; (void)handle; (void)model; (void)byTile; (void)world; (void)ndc; (void)tex; (void)palette; if (n) buf[0] = 0; return -1; }
