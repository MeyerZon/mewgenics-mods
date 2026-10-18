/* minitest.h — the whole native host-side test framework (no deps, C11).
 *
 *   #include "minitest.h"
 *   TEST(name) { CHECK(cond); CHECK_EQ(a, b); CHECK_STR(s, "x"); }
 *   int main(void) { return MT_RUN_ALL(); }
 *
 * Tests register themselves in a static table at definition time via a constructor
 * attribute (GCC/clang). A failed CHECK reports file:line and the expression, marks
 * the test failed and continues; the process exit code is the number of failed tests
 * (capped at 1) so build scripts can gate on it. */
#pragma once
#include <stdio.h>
#include <string.h>

typedef void (*mt_fn)(void);
typedef struct mt_entry { const char *name; mt_fn fn; } mt_entry;

#ifndef MT_MAX_TESTS
#define MT_MAX_TESTS 512
#endif
static mt_entry mt_tests[MT_MAX_TESTS];
static int mt_count = 0;
static int mt_cur_failed = 0;

static inline void mt_register(const char *name, mt_fn fn) {
    if (mt_count < MT_MAX_TESTS) { mt_tests[mt_count].name = name; mt_tests[mt_count].fn = fn; mt_count++; }
}

#define TEST(name)                                                                          \
    static void mt_test_##name(void);                                                       \
    __attribute__((constructor)) static void mt_reg_##name(void) { mt_register(#name, mt_test_##name); } \
    static void mt_test_##name(void)

#define MT_FAIL(fmt, ...)                                                                   \
    do { mt_cur_failed = 1; printf("      %s:%d: " fmt "\n", __FILE__, __LINE__, __VA_ARGS__); } while (0)

#define CHECK(cond) do { if (!(cond)) MT_FAIL("CHECK failed: %s", #cond); } while (0)
#define CHECK_EQ(a, b) do { long long _a = (long long)(a), _b = (long long)(b); if (_a != _b) MT_FAIL("CHECK_EQ failed: %s = %lld, expected %s = %lld", #a, _a, #b, _b); } while (0)
#define CHECK_STR(a, b) do { const char *_a = (a), *_b = (b); if (!_a || !_b || strcmp(_a, _b) != 0) MT_FAIL("CHECK_STR failed: %s = \"%s\", expected \"%s\"", #a, _a ? _a : "(null)", _b ? _b : "(null)"); } while (0)
#define CHECK_MEM(a, b, n) do { if (memcmp((a), (b), (n)) != 0) MT_FAIL("CHECK_MEM failed: %s != %s (%d bytes)", #a, #b, (int)(n)); } while (0)

static inline int MT_RUN_ALL(void) {
    int failed = 0;
    setvbuf(stdout, NULL, _IONBF, 0); /* a crashing test must not take the earlier results with it */
    for (int i = 0; i < mt_count; i++) {
        mt_cur_failed = 0;
        printf("  ..  %s\r", mt_tests[i].name);
        mt_tests[i].fn();
        printf("%s  %s\n", mt_cur_failed ? "FAIL" : "  ok", mt_tests[i].name);
        failed += mt_cur_failed;
    }
    printf("\n%d passed, %d failed\n", mt_count - failed, failed);
    return failed ? 1 : 0;
}
