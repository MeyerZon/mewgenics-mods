/* fw_functor.c — red stub (the green commit implements it) */
#include <string.h>
#include "fw_functor.h"
static const void *const g_vt[FW_FUNC_SLOTS] = { 0 };
const void *const *fw_functor_vtable(void) { return g_vt; }
void fw_functor_make(FwStdFunction *f, FwFunctorFn fn, void *user) { (void)fn; (void)user; memset(f, 0, sizeof *f); }
int fw_functor_unexpected_deallocs(void) { return 0; }
