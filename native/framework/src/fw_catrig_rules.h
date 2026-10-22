/* Pure rules of the cat rig redirect (API v7; catrig_engine.c is the game-facing glue). No windows.h, no game:
 * host-tested in test/test_catrig_rules.c over fake buffers shaped by the GENERATED offsets.h.
 *
 *  - the registry {character entry -> rig clip}: FW_CATRIG_MAX rigs, entry names of 1..FW_CATRIG_NAME_MAX bytes (clips
 *    up to FW_CATRIG_CLIP_MAX, i.e. _CatRig_ + a full entry), one rig per
 *    character (the first registration wins; the same pair again is FW_CATRIG_SAME, not an error);
 *  - the lookup Character::init's hook makes with the entry name (a std::string: data + size, not NUL-terminated):
 *    exact first, then with the `_Champion` / `_Elite` suffix the game appends for champion / elite spawns stripped;
 *  - `_CatRig_<Entry>`: the SymbolClass export name a data mod declares a rig with (case-sensitive, like `_Append_`);
 *  - the vanilla cat clip test ("CatTest", exactly) the by-name lookup hook makes;
 *  - the scan of one SWF file's SymbolClass std::list (file + OFF_SWF_SYMBOL_LIST = the sentinel; node + 0 next,
 *    + OFF_SYMNODE_NAME the export name, the int character id OFF_SYMNODE_ID_FROM_NAME after the name; id 0 skipped),
 *    the same walk process_animation_merges 0x9bc070 makes for `_Append_`. */
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "fw_status_rules.h"   /* MsvcString */
#include "offsets.h"

#define FW_CATRIG_MAX 16
#define FW_CATRIG_NAME_MAX 63
#define FW_CATRIG_EXPORT_PREFIX "_CatRig_"
#define FW_CATRIG_CLIP_MAX (FW_CATRIG_NAME_MAX + 8)   /* a rig clip: room for _CatRig_ + a 63-byte entry */
#define FW_CATRIG_VANILLA_CLIP "CatTest"

typedef enum FwCatRigResult {
    FW_CATRIG_OK = 0,
    FW_CATRIG_SAME,                /* this character already has exactly this rig (idempotent) */
    FW_CATRIG_ERR_NULL,
    FW_CATRIG_ERR_EMPTY,
    FW_CATRIG_ERR_TOO_LONG,        /* a character over FW_CATRIG_NAME_MAX bytes, a clip over FW_CATRIG_CLIP_MAX */
    FW_CATRIG_ERR_DUPLICATE,       /* the character already has another rig */
    FW_CATRIG_ERR_FULL,
    FW_CATRIG_ERR_NOT_RIG_EXPORT,  /* parse: no _CatRig_ prefix (keep last: tests iterate up to it) */
} FwCatRigResult;
const char *fw_catrig_result_text(FwCatRigResult r);

typedef struct FwCatRig {
    char character[FW_CATRIG_NAME_MAX + 1];
    char clip[FW_CATRIG_CLIP_MAX + 1];
    int fromData;                  /* 1: a _CatRig_ export found by the SWF scan; 0: FW_RegisterCatRig */
} FwCatRig;
typedef struct FwCatRigRegistry { FwCatRig rigs[FW_CATRIG_MAX]; int count; } FwCatRigRegistry;

void fw_catrig_init(FwCatRigRegistry *r);
FwCatRigResult fw_catrig_add(FwCatRigRegistry *r, const char *character, const char *clip, int fromData);
/* the rig for an entry name of `len` bytes (exact, then _Champion / _Elite stripped); NULL if none. Entries never
 * move or go away, so the pointer stays valid for the process lifetime. */
const FwCatRig *fw_catrig_find(const FwCatRigRegistry *r, const char *entry, size_t len);
/* `_CatRig_<Entry>` (len bytes) -> out = <Entry> NUL-terminated (out holds FW_CATRIG_NAME_MAX + 1) */
FwCatRigResult fw_catrig_parse_export(const char *name, size_t len, char *out);
int fw_catrig_is_vanilla_clip(const MsvcString *name);

/* Walk one SWF file's SymbolClass list (at most maxNodes nodes) and register every `_CatRig_<Entry>` export with a
 * non-zero id as {Entry, the export name, fromData 1}. cb (may be NULL) is told about every `_CatRig_` export with
 * its result (OK, SAME or the refusal). Returns the number of new registrations. */
typedef void (*FwCatRigScanReport)(const char *exportName, const char *character, FwCatRigResult r, void *user);
int fw_catrig_scan_file(FwCatRigRegistry *r, const void *swfFile, FwCatRigScanReport cb, void *user, size_t maxNodes);
