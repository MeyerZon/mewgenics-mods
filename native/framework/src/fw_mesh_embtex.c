/* fw_mesh_embtex.c — RED stub (the implementation lands in the green commit). */
#include <string.h>
#include "fw_mesh_embtex.h"
int fw_tex_source(const char *explicitName, int hasEmbedded) { (void)explicitName; (void)hasEmbedded; return FW_TEXSRC_NONE; }
const char *fw_tex_source_name(int src) { (void)src; return "none"; }
int fw_embtex_decode(FwEmbTex *t, const char *modelPath, const uint8_t *png, size_t len) { (void)t; (void)modelPath; (void)png; (void)len; return FW_EMB_REFUSED; }
uint32_t fw_embtex_upload(FwEmbTex *t, const FwTexUploadGl *gl) { (void)t; (void)gl; return 0; }
void fw_embtex_free(FwEmbTex *t) { if (t) memset(t, 0, sizeof *t); }
int fw_embtex_fmt_load(char *buf, size_t n, const char *model, const FwEmbTex *t) { (void)model; (void)t; if (n) buf[0] = 0; return 0; }
