/* fw_gl_state.c — red stub (the green commit implements it) */
#include <string.h>
#include "fw_gl_state.h"
int fw_gl_fns_complete(const FwGlFns *gl) { (void)gl; return 0; }
void fw_gl_save(const FwGlFns *gl, FwGlState *st) { (void)gl; memset(st, 0, sizeof *st); }
void fw_gl_restore(const FwGlFns *gl, const FwGlState *st) { (void)gl; (void)st; }
int fw_gl_drain_errors(const FwGlFns *gl, uint32_t *first, int max) { (void)gl; (void)max; *first = 99; return -1; }
