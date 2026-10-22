/* fw_speed_rules.c — the pure decisions of the game-speed engine; see fw_speed_rules.h. */
#include <math.h>
#include "fw_speed_rules.h"

double fw_speed_clamp(double factor) {
    if (!isfinite(factor) || factor <= 0.0) return 1.0;
    if (factor < FW_SPEED_MIN) return FW_SPEED_MIN;
    if (factor > FW_SPEED_MAX) return FW_SPEED_MAX;
    return factor;
}

void fw_speed_init(FwSpeedState *s) {
    s->factor = 1.0;
    s->scaled = 0;
    s->base = 1.0;
    s->written = 0.0;
}

double fw_speed_set(FwSpeedState *s, double factor) {
    s->factor = fw_speed_clamp(factor);
    return s->factor;
}

int fw_speed_frame(FwSpeedState *s, double current, double *out) {
    if (!isfinite(current) || current <= 0.0) { s->scaled = 0; return 0; }
    /* our own previous write still in place -> the game's value under it is the base we kept */
    int ours = s->scaled && current == s->written;
    double base = ours ? s->base : current;
    if (s->factor == 1.0) {
        if (!s->scaled) return 0;
        s->scaled = 0;
        if (!ours) return 0;   /* the game rewrote it meanwhile: its value stands */
        *out = base;
        return 1;
    }
    double target = nextafter(base * s->factor, INFINITY);   /* ulp-tagged: never equal to a plain game write */
    s->base = base;
    s->written = target;
    s->scaled = 1;
    if (ours && current == target) return 0;
    *out = target;
    return 1;
}
