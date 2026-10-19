/* mt_exit.c — the watchdog's exit/grace decision (pure; host-tested in test/test_mewtest.c "mt_exit").
 *
 * Why this exists: the decision used to live inline in the watchdog thread behind `if (!g_active) continue;`, and the
 * script-error path cleared g_active before requesting the exit, so the clean-exit grace could never fire there
 * (TODO.md: "-mewtest_clean 1 … the game then never exits"). Here the inputs are exactly the facts that matter and
 * nothing else; the glue copies its globals into an MtExitState every tick and acts on the answer. */
#include "mt_pure.h"

static int elapsed_over(uint32_t now, uint32_t since, uint32_t grace) {
    return (uint32_t)(now - since) > grace; /* unsigned difference: GetTickCount wraps every 49.7 days */
}

MtExitAction mt_exit_decide(const MtExitState *s, uint32_t nowMs, int *codeOut) {
    MtExitAction act = MT_X_NONE;
    int code = 0;
    if (!s->fired) {
        if (s->crashed && elapsed_over(nowMs, s->crashTick, MT_GRACE_CRASH_MS)) {
            act = MT_X_EXIT_CRASH; code = 3;
        } else if (s->cleanRequested && elapsed_over(nowMs, s->cleanTick, MT_GRACE_CLEAN_MS)) {
            act = MT_X_EXIT_CLEAN; code = s->exitCode < 0 ? 4 : s->exitCode;
        } else if (!s->runnerFinished && !s->cleanRequested && !s->crashed && elapsed_over(nowMs, s->startTick, s->timeoutMs)) {
            act = MT_X_TIMEOUT; code = 2;
        }
    }
    if (codeOut) *codeOut = code;
    return act;
}
