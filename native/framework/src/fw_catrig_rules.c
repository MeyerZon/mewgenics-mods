/* Pure rules of the cat rig redirect — see fw_catrig_rules.h. */
#include <string.h>
#include <stdio.h>
#include "fw_catrig_rules.h"

static const char *const SUFFIXES[] = { "_Champion", "_Elite" };

const char *fw_catrig_result_text(FwCatRigResult r) {
    switch (r) {
    case FW_CATRIG_OK: return "registered";
    case FW_CATRIG_SAME: return "already registered with the same clip";
    case FW_CATRIG_ERR_NULL: return "null definition, character or clip";
    case FW_CATRIG_ERR_EMPTY: return "empty character or clip name";
    case FW_CATRIG_ERR_TOO_LONG: return "the character name is longer than 63 bytes (or the clip than 71)";
    case FW_CATRIG_ERR_DUPLICATE: return "that character already has another rig (first registration wins)";
    case FW_CATRIG_ERR_FULL: return "the cat rig registry is full (16)";
    case FW_CATRIG_ERR_NOT_RIG_EXPORT: return "not a _CatRig_<Entry> export";
    }
    return "unknown result";
}

void fw_catrig_init(FwCatRigRegistry *r) { memset(r, 0, sizeof *r); }

static const FwCatRig *find_exact(const FwCatRigRegistry *r, const char *s, size_t n) {
    for (int i = 0; i < r->count; i++)
        if (strlen(r->rigs[i].character) == n && memcmp(r->rigs[i].character, s, n) == 0) return &r->rigs[i];
    return NULL;
}

FwCatRigResult fw_catrig_add(FwCatRigRegistry *r, const char *character, const char *clip, int fromData) {
    if (!r || !character || !clip) return FW_CATRIG_ERR_NULL;
    size_t nc = strlen(character), nk = strlen(clip);
    if (!nc || !nk) return FW_CATRIG_ERR_EMPTY;
    if (nc > FW_CATRIG_NAME_MAX || nk > FW_CATRIG_CLIP_MAX) return FW_CATRIG_ERR_TOO_LONG;
    const FwCatRig *have = find_exact(r, character, nc);
    if (have) return strcmp(have->clip, clip) == 0 ? FW_CATRIG_SAME : FW_CATRIG_ERR_DUPLICATE;
    if (r->count >= FW_CATRIG_MAX) return FW_CATRIG_ERR_FULL;
    FwCatRig *g = &r->rigs[r->count];
    memcpy(g->character, character, nc + 1);
    memcpy(g->clip, clip, nk + 1);
    g->fromData = fromData ? 1 : 0;
    r->count++;
    return FW_CATRIG_OK;
}

const FwCatRig *fw_catrig_find(const FwCatRigRegistry *r, const char *entry, size_t len) {
    if (!r || !entry || !len || !r->count) return NULL;
    const FwCatRig *g = find_exact(r, entry, len);
    if (g) return g;
    for (size_t i = 0; i < sizeof SUFFIXES / sizeof SUFFIXES[0]; i++) {
        size_t sl = strlen(SUFFIXES[i]);
        if (len > sl && memcmp(entry + len - sl, SUFFIXES[i], sl) == 0) return find_exact(r, entry, len - sl);
    }
    return NULL;
}

FwCatRigResult fw_catrig_parse_export(const char *name, size_t len, char *out) {
    static const size_t PL = sizeof FW_CATRIG_EXPORT_PREFIX - 1;
    if (!name || !out) return FW_CATRIG_ERR_NULL;
    out[0] = 0;
    if (len < PL || memcmp(name, FW_CATRIG_EXPORT_PREFIX, PL) != 0) return FW_CATRIG_ERR_NOT_RIG_EXPORT;
    size_t n = len - PL;
    if (!n) return FW_CATRIG_ERR_EMPTY;
    if (n > FW_CATRIG_NAME_MAX) return FW_CATRIG_ERR_TOO_LONG;
    memcpy(out, name + PL, n);
    out[n] = 0;
    return FW_CATRIG_OK;
}

int fw_catrig_is_vanilla_clip(const MsvcString *name) {
    static const size_t VL = sizeof FW_CATRIG_VANILLA_CLIP - 1;
    return name && name->size == VL && memcmp(msvc_str(name), FW_CATRIG_VANILLA_CLIP, VL) == 0;
}

int fw_catrig_scan_file(FwCatRigRegistry *r, const void *swfFile, FwCatRigScanReport cb, void *user, size_t maxNodes) {
    if (!r || !swfFile) return 0;
    const unsigned char *head = *(const unsigned char *const *)((const unsigned char *)swfFile + OFF_SWF_SYMBOL_LIST);
    if (!head) return 0;
    int added = 0;
    const unsigned char *node = *(const unsigned char *const *)head;
    for (size_t k = 0; node && node != head && k < maxNodes; k++, node = *(const unsigned char *const *)node) {
        const MsvcString *name = (const MsvcString *)(node + OFF_SYMNODE_NAME);
        int id = *(const int *)(node + OFF_SYMNODE_NAME + OFF_SYMNODE_ID_FROM_NAME);
        if (id == 0) continue;
        const char *s = msvc_str(name);
        char entry[FW_CATRIG_NAME_MAX + 1];
        FwCatRigResult pr = fw_catrig_parse_export(s, name->size, entry);
        if (pr == FW_CATRIG_ERR_NOT_RIG_EXPORT) continue;
        char exportName[96];
        size_t en = name->size < sizeof exportName - 1 ? name->size : sizeof exportName - 1;
        memcpy(exportName, s, en); exportName[en] = 0;
        FwCatRigResult res = pr;
        if (pr == FW_CATRIG_OK) {
            res = fw_catrig_add(r, entry, exportName, 1);   /* the clip is the export name itself (<= FW_CATRIG_CLIP_MAX) */
        }
        if (res == FW_CATRIG_OK) added++;
        if (cb) cb(exportName, entry, res, user);
    }
    return added;
}
