/* Pure part of jokers_luck.dll: the reroll rule. The draw comes from the caller's random source (in the DLL:
 * the framework's FW_Random, which the harness `seed` directive pins), never from the CRT rand. Host-tested by
 * test/test_roll.c. */
#pragma once
#include <stdint.h>

#define JL_LUCK_MIN (-10)
#define JL_LUCK_MAX (10)

typedef uint32_t (*JlRandomBelow)(uint32_t bound);   /* uniform in [0, bound) */

/* A new luck modifier in [JL_LUCK_MIN, JL_LUCK_MAX] without 0 (0 stacks would remove the status); one draw. */
int jl_reroll(JlRandomBelow random_below);
