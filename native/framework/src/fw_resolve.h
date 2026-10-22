/* Pure load-time policy of mewframework (no windows.h, no game) so it can be unit-tested on the host
 * (test/test_resolve.c) and compiled into the DLL unchanged: symbol resolution over an image description
 * (executable sections only; exactly one hit; the signature's offset; drift against the authoring RVA), the
 * `-savesuffix` launch gate, the FW_GetSymbol / FW_GetData bounds, and the hook plan — which hooks are installed,
 * in which order, at which Mewjector priority and what a failure does. framework.c reads the PE header into an
 * FwImage, logs each result and installs the hooks the plan names; status_engine.c owns the status-side steps. */
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <wchar.h>
#include "signatures.h"
#include "fw_sig.h"

/* ---- symbol resolution ---- */
typedef struct FwImageSection { const uint8_t *bytes; size_t len; int executable; } FwImageSection;
typedef struct FwImage { uintptr_t base; const FwImageSection *sections; size_t count; } FwImage;

typedef enum FwResolveCode {
    FW_RESOLVE_OK = 0,
    FW_RESOLVE_DRIFT,         /* resolved, but not at expectedRva (the scan result is used; log only) */
    FW_RESOLVE_NO_MATCH,
    FW_RESOLVE_AMBIGUOUS,     /* two or more hits */
    FW_RESOLVE_BAD_PATTERN,   /* does not parse (reported as 0 matches, like a miss) */
    FW_RESOLVE_RAW_RVA,       /* no signature on this build (manifest `signature: null`): the identity gate already proved
                                 the image, so expectedRva is taken as-is, like FW_LK (resolved; no scan) */
    FW_RESOLVE_NO_RVA         /* no signature and no expectedRva: nothing to take (fails) */
} FwResolveCode;
typedef struct FwResolveResult { FwResolveCode code; int matches; uintptr_t addr; uintptr_t rva; } FwResolveResult;

/* Scan the executable sections for an IDA-style pattern: the FIRST hit (0 if none) and the hit count in *matches
 * (reset to 0 first; counting stops at 2). A pattern that does not parse is 0 hits. */
uintptr_t fw_resolve_scan_unique(const FwImage *img, const char *pattern, int *matches);
/* One symbol: out->addr = hit + sig->offset (0 unless OK/DRIFT/RAW_RVA), out->rva = addr - img->base.
 * A NULL pattern never scans: it is RAW_RVA (addr = base + expectedRva) or NO_RVA. */
FwResolveCode fw_resolve_symbol(const FwImage *img, const SymbolSig *sig, FwResolveResult *out);
/* All n symbols: addrs[i] is written for OK/DRIFT and left alone otherwise; results[i] may be NULL-free output.
 * Returns 1 iff every symbol resolved (DRIFT and RAW_RVA count as resolved). */
int fw_resolve_symbols(const FwImage *img, const SymbolSig *syms, size_t n, uintptr_t *addrs, FwResolveResult *results);

/* ---- activation gate and API bounds ---- */
int fw_resolve_is_dev_launch(const wchar_t *commandLine);   /* 1 iff "-savesuffix" occurs (case-sensitive substring) */
uintptr_t fw_resolve_symbol_addr(int active, const uintptr_t *syms, size_t count, int symbol);
uintptr_t fw_resolve_data_addr(int active, const BuildInfo *build, uintptr_t base, int dataId);

/* ---- hook plan ---- */
typedef enum FwHookStep {
    FW_HOOK_SYMBOL,           /* hook the FwSymbol `index` */
    FW_HOOK_LOOKUP,           /* hook status-name lookup `index` (FW_LK order) */
    FW_HOOK_STATUS_PREPARE,   /* status_engine: bind the template, sanity-check its vtable */
    FW_HOOK_STATUS_BARRIER    /* status_engine: report; the run stops here if anything before failed */
} FwHookStep;
typedef enum FwHookOnFail { FW_HOOK_ABORT, FW_HOOK_CONTINUE } FwHookOnFail;
typedef struct FwHookSpec { FwHookStep step; int index; int priority; const char *label; FwHookOnFail onFail; } FwHookSpec;

extern const FwHookSpec FW_HOOK_PLAN[];
extern const size_t FW_HOOK_PLAN_COUNT;

/* install(spec, ordinal, failuresSoFar, user) -> 1 on success. The run calls every step in plan order; a failed
 * ABORT step ends it at once, a failed CONTINUE step is remembered, a BARRIER step ends it when anything failed
 * before it. Returns 1 iff every step succeeded. */
typedef int (*FwHookInstall)(const FwHookSpec *spec, int ordinal, int failuresSoFar, void *user);
int fw_hook_run(const FwHookSpec *plan, size_t count, FwHookInstall install, void *user);
