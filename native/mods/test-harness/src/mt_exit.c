/* mt_exit.c — the watchdog's exit/grace decision (pure; host-tested). Red stub: decides nothing yet. */
#include "mt_pure.h"

MtExitAction mt_exit_decide(const MtExitState *s, uint32_t nowMs, int *codeOut) {
    (void)s; (void)nowMs;
    if (codeOut) *codeOut = 0;
    return MT_X_NONE;
}
