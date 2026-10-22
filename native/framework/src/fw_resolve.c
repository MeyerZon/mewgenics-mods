/* Pure load-time policy; see fw_resolve.h. */
#include <string.h>
#include "fw_resolve.h"

/* ----------------------------------------------------------------------- */
/* symbol resolution                                                        */
/* ----------------------------------------------------------------------- */
uintptr_t fw_resolve_scan_unique(const FwImage *img, const char *pattern, int *matches) {
    uint8_t bytes[FW_SIG_MAX_BYTES], mask[FW_SIG_MAX_BYTES];
    *matches = 0;
    int n = fw_parse_pattern(pattern, bytes, mask, sizeof bytes);
    if (n <= 0) return 0;
    uintptr_t found = 0;
    for (size_t s = 0; s < img->count; s++) {
        const FwImageSection *sec = &img->sections[s];
        if (!sec->executable) continue;
        const uint8_t *hit = fw_scan_buffer(sec->bytes, sec->len, bytes, mask, (size_t)n, matches);
        if (hit && !found) found = (uintptr_t)hit;
        if (*matches > 1) return found;
    }
    return found;
}

FwResolveCode fw_resolve_symbol(const FwImage *img, const SymbolSig *sig, FwResolveResult *out) {
    uint8_t bytes[FW_SIG_MAX_BYTES], mask[FW_SIG_MAX_BYTES];
    memset(out, 0, sizeof *out);
    if (!sig->pattern) {
        if (!sig->expectedRva) return out->code = FW_RESOLVE_NO_RVA;
        out->rva = sig->expectedRva;
        out->addr = img->base + sig->expectedRva;
        return out->code = FW_RESOLVE_RAW_RVA;
    }
    if (fw_parse_pattern(sig->pattern, bytes, mask, sizeof bytes) <= 0) return out->code = FW_RESOLVE_BAD_PATTERN;
    uintptr_t hit = fw_resolve_scan_unique(img, sig->pattern, &out->matches);
    if (out->matches == 0) return out->code = FW_RESOLVE_NO_MATCH;
    if (out->matches > 1) return out->code = FW_RESOLVE_AMBIGUOUS;
    out->addr = hit + sig->offset;
    out->rva = out->addr - img->base;
    return out->code = (sig->expectedRva && out->rva != sig->expectedRva) ? FW_RESOLVE_DRIFT : FW_RESOLVE_OK;
}

int fw_resolve_symbols(const FwImage *img, const SymbolSig *syms, size_t n, uintptr_t *addrs, FwResolveResult *results) {
    int ok = 1;
    for (size_t i = 0; i < n; i++) {
        FwResolveCode c = fw_resolve_symbol(img, &syms[i], &results[i]);
        if (c == FW_RESOLVE_OK || c == FW_RESOLVE_DRIFT || c == FW_RESOLVE_RAW_RVA) addrs[i] = results[i].addr;
        else ok = 0;
    }
    return ok;
}

/* ----------------------------------------------------------------------- */
/* activation gate and API bounds                                           */
/* ----------------------------------------------------------------------- */
int fw_resolve_is_dev_launch(const wchar_t *commandLine) {
    return commandLine && wcsstr(commandLine, L"-savesuffix") != NULL;
}

uintptr_t fw_resolve_symbol_addr(int active, const uintptr_t *syms, size_t count, int symbol) {
    if (!active || symbol < 0 || (size_t)symbol >= count) return 0;
    return syms[symbol];
}

uintptr_t fw_resolve_data_addr(int active, const BuildInfo *build, uintptr_t base, int dataId) {
    if (!active || !build || dataId < 0 || dataId >= (int)FW_DATA_COUNT_) return 0;
    uint32_t rva = build->rva_data[dataId];
    return rva ? base + rva : 0;
}

/* ----------------------------------------------------------------------- */
/* hook plan: the order the DLL installs its hooks in, with Mewjector       */
/* priorities (lower runs first) and the failure policy of each step.       */
/* ----------------------------------------------------------------------- */
_Static_assert(FW_LK_COUNT == 13, "FW_HOOK_PLAN lists one FW_HOOK_LOOKUP row per status-name lookup");
#define LK_ROW(i) { FW_HOOK_LOOKUP, i, 20, "status lookup", FW_HOOK_CONTINUE }
const FwHookSpec FW_HOOK_PLAN[] = {
    { FW_HOOK_SYMBOL, FW_SYM_Character_BeginTurn, 20, "Character::BeginTurn", FW_HOOK_ABORT },
    { FW_HOOK_STATUS_PREPARE, 0, 0, "LuckUp vtable sanity check", FW_HOOK_ABORT },
    { FW_HOOK_SYMBOL, FW_SYM_Status_ApplyByName, 20, "apply_status", FW_HOOK_CONTINUE },
    LK_ROW(0), LK_ROW(1), LK_ROW(2), LK_ROW(3), LK_ROW(4), LK_ROW(5), LK_ROW(6),
    LK_ROW(7), LK_ROW(8), LK_ROW(9), LK_ROW(10), LK_ROW(11), LK_ROW(12),
    { FW_HOOK_STATUS_BARRIER, 0, 0, "status hooks", FW_HOOK_ABORT },
    { FW_HOOK_SYMBOL, FW_SYM_TurnControl_NextTurn, 100, "TurnControl::NextTurn", FW_HOOK_ABORT },
    { FW_HOOK_SYMBOL, FW_SYM_TacticsTest_LateRender, 100, "TacticsTest::LateRender (unit glow)", FW_HOOK_ABORT },
    { FW_HOOK_SYMBOL, FW_SYM_ApplicationBase_FrameBegin, 100, "ApplicationBase::FrameBegin (game speed)", FW_HOOK_ABORT },
};
const size_t FW_HOOK_PLAN_COUNT = sizeof FW_HOOK_PLAN / sizeof FW_HOOK_PLAN[0];

int fw_hook_run(const FwHookSpec *plan, size_t count, FwHookInstall install, void *user) {
    int failures = 0;
    for (size_t i = 0; i < count; i++) {
        const FwHookSpec *s = &plan[i];
        int ok = install(s, (int)i, failures, user);
        if (!ok) failures++;
        if (s->step == FW_HOOK_STATUS_BARRIER) { if (failures) return 0; continue; }
        if (!ok && s->onFail == FW_HOOK_ABORT) return 0;
    }
    return failures == 0;
}
