/* Tracks how many console output lines have been seen, and where the current `cmd`
 * window starts. The game's console vector only grows unless the user clears it. */
#include "mt_pure.h"

int mt_console_poll(MtConsoleTrack *t, int count, int *firstNew, int *numNew) {
    if (count < 0) count = 0;
    if (count < t->seen) { t->seen = 0; t->windowStart = 0; } /* cleared */
    *firstNew = t->seen;
    *numNew = count - t->seen;
    t->seen = count;
    return *numNew;
}

void mt_console_mark_window(MtConsoleTrack *t) { t->windowStart = t->seen; }
