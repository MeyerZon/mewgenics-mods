/* catrig_sample_rules.h — the pure part of catrig_sample.dll (no windows.h, no game; host-tested by
 * test/test_catrig_sample.c).
 *
 * The sample binds a whole cat rig to one character entry through the DLL route of framework API v7
 * (FW_RegisterCatRig / FW_CatRigFor), the route PR #109 left unverified in game: mods/catrig-sample/ ships the
 * character entry RigSampleCat (a TomTom variant, `movieclip _CAT`, its own custom_cat_data) and an art scene whose
 * rig clip is exported as `RigSampleCatClip` — deliberately NOT `_CatRig_<Entry>`, so the framework's data seam (the
 * SymbolClass scan) cannot bind it and only this DLL can.
 *
 * The rules: which pairs the sample registers (CS_RIGS), the checks a pair must pass before it is handed to the
 * framework (the framework's own limits: entry 1..63 bytes, clip 1..71, plus "not a _CatRig_ export", which would
 * make the DLL redundant), and the binding loop (register, then read back through FW_CatRigFor and compare). */
#pragma once
#include "framework_api.h"

#define CS_OWNER "catrig_sample"
#define CS_ENTRY_MAX 63      /* FW_CATRIG_NAME_MAX */
#define CS_CLIP_MAX 71       /* FW_CATRIG_CLIP_MAX */
#define CS_DATA_PREFIX "_CatRig_"

/* the sample's pairs (catrig_sample_rules.c): RigSampleCat -> RigSampleCatClip */
extern const FwCatRigDef CS_RIGS[];
extern const int CS_RIG_COUNT;

typedef enum CsDefCheck {
    CS_DEF_OK = 0,
    CS_DEF_NULL,          /* null definition, character or clip */
    CS_DEF_EMPTY,         /* empty character or clip */
    CS_DEF_TOO_LONG,      /* character > 63 bytes or clip > 71 */
    CS_DEF_DATA_EXPORT    /* the clip is a _CatRig_ export: the framework binds that from data already */
} CsDefCheck;

CsDefCheck cs_check_def(const FwCatRigDef *def);
const char *cs_check_text(CsDefCheck c);

/* What the binding loop needs from the framework (FwApi's RegisterCatRig / CatRigFor) and a logger. */
typedef struct CsBinder {
    int (*reg)(const FwCatRigDef *def);
    const char *(*rigFor)(const char *character);
    void (*log)(void *user, const char *line);
    void *user;
} CsBinder;

/* Check, register and read back every pair; one log line per pair:
 *   "bound <character> -> <clip> (FW_CatRigFor agrees)"
 *   "skipped <clip> for <character>: <cs_check_text>"
 *   "FW_RegisterCatRig refused <clip> for <character>"
 *   "FW_CatRigFor(<character>) = <what> after registering <clip>"   (the read-back disagrees)
 * Returns the number of pairs bound and read back. A NULL binder, reg or rigFor -> 0, nothing called. */
int cs_bind_all(const CsBinder *b, const FwCatRigDef *defs, int n);
