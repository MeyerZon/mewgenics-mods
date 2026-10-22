/* The framework's GON walker; see fw_gon.h. RED STUB: nothing is ever found. */
#include <string.h>
#include "fw_gon.h"
int fw_gon_direct_read(void *u, const void *addr, void *out, size_t n) { (void)u; (void)addr; (void)out; (void)n; return 0; }
int fw_gon_get_string(FwMemRead rd, void *u, const void *node, const char *path, char *out, size_t cap) { (void)rd; (void)u; (void)node; (void)path; if (cap) out[0] = 0; return 0; }
int fw_gon_model(FwMemRead rd, void *u, const void *e, char *out, size_t cap) { return fw_gon_get_string(rd, u, e, "graphics.model", out, cap); }
const char *fw_gon_entry_model(const void *e) { (void)e; return NULL; }
