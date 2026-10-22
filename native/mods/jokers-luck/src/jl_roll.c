/* Joker's Luck's reroll rule (see jl_roll.h). Pure C, host-tested by test/test_roll.c. */
#include "jl_roll.h"

int jl_reroll(JlRandomBelow random_below) {
    /* 20 outcomes: 0..9 -> -10..-1, 10..19 -> +1..+10 (0 is skipped without a second draw) */
    int v = (int)random_below((uint32_t)(JL_LUCK_MAX - JL_LUCK_MIN)) + JL_LUCK_MIN;
    return v >= 0 ? v + 1 : v;
}
