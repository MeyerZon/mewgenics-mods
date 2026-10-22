/* fw_mesh_hide.c — RED stub (fw_mesh_hide.h); the green commit fills it in. */
#include <string.h>
#include "fw_mesh_hide.h"

void fw_mesh_hide_reset(FwMeshHide *h) { (void)h; }
int fw_mesh_hide_wanted(int hideSprite, int byTile, const void *renderable, int modelDrawn) { (void)hideSprite; (void)byTile; (void)renderable; (void)modelDrawn; return 0; }
int fw_mesh_hide_add(FwMeshHide *h, const void *renderable) { (void)h; (void)renderable; return 0; }
int fw_mesh_hide_has(const FwMeshHide *h, const void *renderable) { (void)h; (void)renderable; return 0; }
int fw_mesh_hide_filter(void *user, void **itemRef, int *layerRef) { (void)user; (void)itemRef; (void)layerRef; return 1; }
int fw_mesh_hide_fmt(char *buf, size_t n, int frame, const FwMeshHide *h) { (void)frame; (void)h; if (buf && n) buf[0] = 0; return 0; }
