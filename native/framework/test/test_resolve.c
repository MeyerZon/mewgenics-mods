/* Host-side tests for the framework's load-time policy (src/fw_resolve.c): symbol resolution over a fake image
 * (executable sections only, exactly one hit, the signature offset, drift against expectedRva), the `-savesuffix`
 * launch gate, the FW_GetSymbol / FW_GetData bounds and the hook plan (what is hooked, in which order, at which
 * priority, and how a failure is handled) driven against a fake installer. No windows.h, no game. */
#define FW_NO_WINDOWS
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include "../../test/minitest.h"
#include "fw_resolve.h"

/* ---- a fake image: .text (exec), .rdata (not exec), .text2 (exec) ---- */
static const uint8_t TEXT[]  = { 0x90, 0x48, 0x8B, 0xC4, 0x55, 0x90, 0x90, 0xDE, 0xAD, 0x90 };
static const uint8_t RDATA[] = { 0x48, 0x8B, 0xC4, 0x55, 0xDE, 0xAD, 0xBE, 0xEF };
static const uint8_t TEXT2[] = { 0x00, 0xDE, 0xAD, 0xBE, 0xEF, 0x00 };
static const FwImageSection SECTIONS[] = {
    { TEXT, sizeof TEXT, 1 }, { RDATA, sizeof RDATA, 0 }, { TEXT2, sizeof TEXT2, 1 } };
static const FwImage IMG = { 0x140000000u, SECTIONS, 3 };

TEST(scan_unique_skips_non_executable_sections) {
    int matches = 0;
    uintptr_t hit = fw_resolve_scan_unique(&IMG, "48 8B C4 55", &matches);
    CHECK(hit == (uintptr_t)(TEXT + 1));           /* .rdata holds the same bytes and is ignored */
    CHECK_EQ(matches, 1);
}

TEST(scan_unique_counts_hits_across_executable_sections) {
    int matches = 0;
    uintptr_t hit = fw_resolve_scan_unique(&IMG, "DE AD", &matches);
    CHECK(hit == (uintptr_t)(TEXT + 7));           /* the first hit is returned even when ambiguous */
    CHECK_EQ(matches, 2);
    matches = 0;
    CHECK(fw_resolve_scan_unique(&IMG, "DE AD BE EF", &matches) == (uintptr_t)(TEXT2 + 1));
    CHECK_EQ(matches, 1);
}

TEST(scan_unique_reports_no_match_and_bad_patterns_as_zero) {
    int matches = 5;
    CHECK_EQ(fw_resolve_scan_unique(&IMG, "CA FE", &matches), 0);
    CHECK_EQ(matches, 0);                           /* the counter is reset by the scan */
    matches = 5;
    CHECK_EQ(fw_resolve_scan_unique(&IMG, "ZZ", &matches), 0);
    CHECK_EQ(matches, 0);
    CHECK_EQ(fw_resolve_scan_unique(&IMG, "", &matches), 0);
}

TEST(resolve_symbol_applies_the_offset_and_checks_drift) {
    SymbolSig ok = { "A", "48 8B C4 55", -1, 0x0 };       /* expectedRva 0: no drift check */
    FwResolveResult r;
    CHECK_EQ(fw_resolve_symbol(&IMG, &ok, &r), FW_RESOLVE_OK);
    CHECK(r.addr == (uintptr_t)TEXT);                    /* hit at TEXT+1, offset -1 */
    CHECK_EQ(r.matches, 1);
    CHECK_EQ(r.rva, (uintptr_t)TEXT - 0x140000000u);
    SymbolSig drift = { "B", "48 8B C4 55", 0, 0x1234 };
    CHECK_EQ(fw_resolve_symbol(&IMG, &drift, &r), FW_RESOLVE_DRIFT);
    CHECK(r.addr == (uintptr_t)(TEXT + 1));              /* the scan result is still used */
    SymbolSig exact = { "C", "48 8B C4 55", 0, (uintptr_t)(TEXT + 1) - 0x140000000u };
    CHECK_EQ(fw_resolve_symbol(&IMG, &exact, &r), FW_RESOLVE_OK);
}

TEST(resolve_symbol_refuses_zero_or_two_matches) {
    FwResolveResult r;
    SymbolSig none = { "N", "CA FE", 0, 0 };
    CHECK_EQ(fw_resolve_symbol(&IMG, &none, &r), FW_RESOLVE_NO_MATCH);
    CHECK_EQ(r.matches, 0); CHECK_EQ(r.addr, 0);
    SymbolSig two = { "T", "DE AD", 0, 0 };
    CHECK_EQ(fw_resolve_symbol(&IMG, &two, &r), FW_RESOLVE_AMBIGUOUS);
    CHECK_EQ(r.matches, 2); CHECK_EQ(r.addr, 0);
    SymbolSig bad = { "Z", "4", 0, 0 };
    CHECK_EQ(fw_resolve_symbol(&IMG, &bad, &r), FW_RESOLVE_BAD_PATTERN);
    CHECK_EQ(r.matches, 0); CHECK_EQ(r.addr, 0);
}

TEST(resolve_symbols_resolves_all_or_reports_each_failure) {
    SymbolSig syms[3] = { { "A", "48 8B C4 55", 0, 0 }, { "T", "DE AD", 0, 0 }, { "D", "DE AD BE EF", 0, 0x9999 } };
    uintptr_t addrs[3] = { 1, 1, 1 };
    FwResolveResult res[3];
    CHECK_EQ(fw_resolve_symbols(&IMG, syms, 3, addrs, res), 0);  /* one ambiguous symbol fails the lot */
    CHECK(addrs[0] == (uintptr_t)(TEXT + 1));
    CHECK_EQ(addrs[1], 1);                                       /* an unresolved slot is left alone */
    CHECK(addrs[2] == (uintptr_t)(TEXT2 + 1));                   /* drift still resolves (log only) */
    CHECK_EQ(res[0].code, FW_RESOLVE_OK); CHECK_EQ(res[1].code, FW_RESOLVE_AMBIGUOUS); CHECK_EQ(res[2].code, FW_RESOLVE_DRIFT);
    SymbolSig good[2] = { { "A", "48 8B C4 55", 0, 0 }, { "D", "DE AD BE EF", 0, 0 } };
    CHECK_EQ(fw_resolve_symbols(&IMG, good, 2, addrs, res), 1);
}

TEST(generated_signatures_resolve_against_nothing_on_a_fake_image_without_crashing) {
    /* every real pattern parses (test_build pins that); against the fake image they all miss */
    uintptr_t addrs[FW_SYMBOL_COUNT_]; FwResolveResult res[FW_SYMBOL_COUNT_];
    CHECK_EQ(fw_resolve_symbols(&IMG, FW_BUILDS[0].symbols, FW_SYMBOL_COUNT_, addrs, res), 0);
    for (size_t i = 0; i < FW_SYMBOL_COUNT_; i++) CHECK_EQ(res[i].code, FW_RESOLVE_NO_MATCH);
}

TEST(dev_launch_gate_needs_savesuffix_on_the_command_line) {
    CHECK_EQ(fw_resolve_is_dev_launch(L"\"C:\\Games\\Mewgenics.exe\" -savesuffix dev -debugconsole"), 1);
    CHECK_EQ(fw_resolve_is_dev_launch(L"\"C:\\Games\\Mewgenics.exe\""), 0);
    CHECK_EQ(fw_resolve_is_dev_launch(L"Mewgenics.exe -savesuffixdev"), 1);   /* a substring test, as the DLL does it */
    CHECK_EQ(fw_resolve_is_dev_launch(L"Mewgenics.exe -SaveSuffix dev"), 0);  /* case-sensitive */
    CHECK_EQ(fw_resolve_is_dev_launch(NULL), 0);
}

TEST(symbol_and_data_bounds_return_zero_when_inactive_or_out_of_range) {
    uintptr_t sym[3] = { 0x10, 0x20, 0x30 };
    CHECK_EQ(fw_resolve_symbol_addr(1, sym, 3, 1), 0x20);
    CHECK_EQ(fw_resolve_symbol_addr(0, sym, 3, 1), 0);
    CHECK_EQ(fw_resolve_symbol_addr(1, sym, 3, -1), 0);
    CHECK_EQ(fw_resolve_symbol_addr(1, sym, 3, 3), 0);
    const BuildInfo *b = &FW_BUILDS[0];
    CHECK_EQ(fw_resolve_data_addr(1, b, 0x140000000u, FW_DATA_App), 0x140000000u + b->rva_data[FW_DATA_App]);
    CHECK_EQ(fw_resolve_data_addr(0, b, 0x140000000u, FW_DATA_App), 0);
    CHECK_EQ(fw_resolve_data_addr(1, NULL, 0x140000000u, FW_DATA_App), 0);
    CHECK_EQ(fw_resolve_data_addr(1, b, 0x140000000u, -1), 0);
    CHECK_EQ(fw_resolve_data_addr(1, b, 0x140000000u, FW_DATA_COUNT_), 0);
    BuildInfo zero = *b; uint32_t rvas[FW_DATA_COUNT_] = { 0 }; memcpy(zero.rva_data, rvas, sizeof rvas);
    CHECK_EQ(fw_resolve_data_addr(1, &zero, 0x140000000u, FW_DATA_App), 0);   /* an unset RVA is not base+0 */
}

/* ---- the hook plan ---- */
TEST(hook_plan_pins_order_priorities_and_failure_policy) {
    CHECK_EQ(FW_HOOK_PLAN_COUNT, (size_t)(1 + 1 + 1 + FW_LK_COUNT + 1 + 1 + 1));
    const FwHookSpec *p = FW_HOOK_PLAN;
    size_t i = 0;
    CHECK_EQ(p[i].step, FW_HOOK_SYMBOL); CHECK_EQ(p[i].index, FW_SYM_Character_BeginTurn); CHECK_EQ(p[i].priority, 20); CHECK_EQ(p[i].onFail, FW_HOOK_ABORT); i++;
    CHECK_EQ(p[i].step, FW_HOOK_STATUS_PREPARE); CHECK_EQ(p[i].onFail, FW_HOOK_ABORT); i++;
    CHECK_EQ(p[i].step, FW_HOOK_SYMBOL); CHECK_EQ(p[i].index, FW_SYM_Status_ApplyByName); CHECK_EQ(p[i].priority, 20); CHECK_EQ(p[i].onFail, FW_HOOK_CONTINUE); i++;
    for (int lk = 0; lk < FW_LK_COUNT; lk++, i++) {
        CHECK_EQ(p[i].step, FW_HOOK_LOOKUP); CHECK_EQ(p[i].index, lk); CHECK_EQ(p[i].priority, 20); CHECK_EQ(p[i].onFail, FW_HOOK_CONTINUE);
    }
    CHECK_EQ(p[i].step, FW_HOOK_STATUS_BARRIER); i++;
    CHECK_EQ(p[i].step, FW_HOOK_SYMBOL); CHECK_EQ(p[i].index, FW_SYM_TurnControl_NextTurn); CHECK_EQ(p[i].priority, 100); CHECK_EQ(p[i].onFail, FW_HOOK_ABORT); i++;
    /* the glow engine's render hook comes last: an observer like NextTurn, after the status hooks are in */
    CHECK_EQ(p[i].step, FW_HOOK_SYMBOL); CHECK_EQ(p[i].index, FW_SYM_TacticsTest_LateRender); CHECK_EQ(p[i].priority, 100); CHECK_EQ(p[i].onFail, FW_HOOK_ABORT); i++;
    CHECK_EQ(i, FW_HOOK_PLAN_COUNT);
    for (size_t k = 0; k < FW_HOOK_PLAN_COUNT; k++) CHECK(p[k].label != NULL);
}

typedef struct FakeInstaller { int failAt; int calls; int barrierSeenFailures; FwHookStep steps[32]; int ordinals[32]; } FakeInstaller;
static int fake_install(const FwHookSpec *spec, int ordinal, int failuresSoFar, void *user) {
    FakeInstaller *fi = (FakeInstaller *)user;
    fi->steps[fi->calls] = spec->step; fi->ordinals[fi->calls] = ordinal; fi->calls++;
    if (spec->step == FW_HOOK_STATUS_BARRIER) fi->barrierSeenFailures = failuresSoFar;
    return ordinal != fi->failAt;
}

TEST(hook_run_installs_the_whole_plan_in_order) {
    FakeInstaller fi; memset(&fi, 0, sizeof fi); fi.failAt = -1;
    CHECK_EQ(fw_hook_run(FW_HOOK_PLAN, FW_HOOK_PLAN_COUNT, fake_install, &fi), 1);
    CHECK_EQ(fi.calls, (int)FW_HOOK_PLAN_COUNT);
    for (int k = 0; k < fi.calls; k++) CHECK_EQ(fi.ordinals[k], k);
    CHECK_EQ(fi.steps[fi.calls - 1], FW_HOOK_SYMBOL);
    CHECK_EQ(fi.barrierSeenFailures, 0);
}

TEST(hook_run_aborts_at_once_on_an_abort_step) {
    FakeInstaller fi; memset(&fi, 0, sizeof fi); fi.failAt = 0;      /* Character::BeginTurn fails */
    CHECK_EQ(fw_hook_run(FW_HOOK_PLAN, FW_HOOK_PLAN_COUNT, fake_install, &fi), 0);
    CHECK_EQ(fi.calls, 1);
    memset(&fi, 0, sizeof fi); fi.failAt = 1;                         /* the vtable sanity check fails */
    CHECK_EQ(fw_hook_run(FW_HOOK_PLAN, FW_HOOK_PLAN_COUNT, fake_install, &fi), 0);
    CHECK_EQ(fi.calls, 2);
}

TEST(hook_run_continues_through_a_failed_lookup_but_stops_at_the_barrier) {
    FakeInstaller fi; memset(&fi, 0, sizeof fi); fi.failAt = 3 + 5;  /* lookup [5] fails */
    CHECK_EQ(fw_hook_run(FW_HOOK_PLAN, FW_HOOK_PLAN_COUNT, fake_install, &fi), 0);
    CHECK_EQ(fi.calls, 3 + FW_LK_COUNT + 1);                         /* every lookup tried, the barrier called, NextTurn not */
    CHECK_EQ(fi.steps[fi.calls - 1], FW_HOOK_STATUS_BARRIER);
    CHECK_EQ(fi.barrierSeenFailures, 1);
    memset(&fi, 0, sizeof fi); fi.failAt = 2;                         /* apply_status itself fails: same shape */
    CHECK_EQ(fw_hook_run(FW_HOOK_PLAN, FW_HOOK_PLAN_COUNT, fake_install, &fi), 0);
    CHECK_EQ(fi.calls, 3 + FW_LK_COUNT + 1);
}

TEST(hook_run_fails_when_the_last_hook_fails) {
    FakeInstaller fi; memset(&fi, 0, sizeof fi); fi.failAt = (int)FW_HOOK_PLAN_COUNT - 1;
    CHECK_EQ(fw_hook_run(FW_HOOK_PLAN, FW_HOOK_PLAN_COUNT, fake_install, &fi), 0);
    CHECK_EQ(fi.calls, (int)FW_HOOK_PLAN_COUNT);
}

int main(void) { return MT_RUN_ALL(); }
