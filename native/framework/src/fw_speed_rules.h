/* Pure rules of the game-speed engine (no windows.h, no game calls), host-tested by test/test_speed_rules.c and
 * compiled into the DLL unchanged. speed_engine.c keeps the game-facing part: the ApplicationBase::FrameBegin hook
 * that reads and writes the app's time scale through the generated OFF_APP_TIMESCALE.
 *
 * The mechanism (docs/engine-map.md "Frame timing and game speed", .analysis/notes-speed.md): the main loop adds
 * `frame delta * App+OFF_APP_TIMESCALE` (a double) to its fixed-step accumulator and runs one fixed update (same dt)
 * per step, so the time scale only changes HOW MANY identical updates run per rendered frame. The game itself
 * rewrites the scale: HitPause_Update sets it to combat_speed (x the hit-pause factor) on every update in combat,
 * the pause menu sets 1.0. The engine therefore multiplies whatever the game left there, once per rendered frame
 * (FrameBegin runs after that frame's updates and before the next accumulation), and must not multiply its own
 * previous write again when the game did not touch the value (outside combat nothing rewrites it). It tells the two
 * apart by writing an ulp-tagged value: base * factor nudged up by one ulp, which no game write (1.0, 2.0, 0.25 * 3
 * …) equals; an error of 2^-52 relative. */
#pragma once

#define FW_SPEED_MIN 0.0625   /* 1/16: slower than this is not a test aid */
#define FW_SPEED_MAX 64.0     /* far above what the CPU sustains (the measured ceiling is in engine-map) */

/* NaN, +-inf, 0 and negatives -> 1.0 (the default, "off"); otherwise clamped into [FW_SPEED_MIN, FW_SPEED_MAX] */
double fw_speed_clamp(double factor);

typedef struct FwSpeedState {
    double factor;    /* the requested multiplier, clamped; 1.0 = off */
    int scaled;       /* 1 while the app holds a value this engine wrote */
    double base;      /* the game's own value under that write */
    double written;   /* the exact (ulp-tagged) value written */
} FwSpeedState;

void fw_speed_init(FwSpeedState *s);                    /* factor 1, nothing written */
double fw_speed_set(FwSpeedState *s, double factor);    /* stores and returns the clamped factor */

/* One rendered frame. `current` is the app's time scale now. Returns 1 and the value to store in *out when the app
 * must be written, 0 when it must be left alone. Factor 1 after a write restores the game's base once (only if the
 * game has not rewritten it meanwhile), then stops writing. A current value that is not finite or not > 0 is the
 * game's business (paused / garbage): never scaled, and it ends a pending write. */
int fw_speed_frame(FwSpeedState *s, double current, double *out);
