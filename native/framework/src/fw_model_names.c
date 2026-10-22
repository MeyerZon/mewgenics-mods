/* fw_model_names.c — the named-model registry (3D phase M3 "@Name"); see fw_model_names.h. RED STUB. */
#include <string.h>
#include <stdio.h>
#include "fw_model_names.h"

void fw_model_names_clear(FwModelNames *r) { (void)r; }
int fw_model_names_load(FwMemRead rd, void *u, const void *root, FwModelNames *r) { (void)rd; (void)u; (void)root; (void)r; return -9; }
const FwModelName *fw_model_names_find(const FwModelNames *r, const char *name) { (void)r; (void)name; return NULL; }
int fw_model_names_resolve(const FwModelNames *r, const FwGonModel *unit, FwGonModel *out, const FwModelName **hit) { (void)r; (void)unit; (void)out; (void)hit; return -9; }
int fw_model_names_fmt_error(char *buf, size_t n, const char *ref, int rc, const char *unitEntry, const FwModelNames *r, const FwModelName *hit) { (void)ref; (void)rc; (void)unitEntry; (void)r; (void)hit; if (n) buf[0] = 0; return 0; }
int fw_model_names_fmt_loaded(char *buf, size_t n, const FwModelNames *r, int absent) { (void)r; (void)absent; if (n) buf[0] = 0; return 0; }
int fw_model_names_log_first(FwModelNamesLogged *g, const char *ref) { (void)g; (void)ref; return -9; }
