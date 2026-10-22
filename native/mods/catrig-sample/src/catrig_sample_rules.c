/* Pure part of catrig_sample.dll — see catrig_sample_rules.h. */
#include <stdio.h>
#include <string.h>
#include "catrig_sample_rules.h"

const FwCatRigDef CS_RIGS[] = {
    { "RigSampleCat", "RigSampleCatClip" },   /* mods/catrig-sample: data/characters + art/rig.scene.json's export */
};
const int CS_RIG_COUNT = (int)(sizeof CS_RIGS / sizeof CS_RIGS[0]);

CsDefCheck cs_check_def(const FwCatRigDef *def) {
    if (!def || !def->character || !def->rig_clip) return CS_DEF_NULL;
    size_t nc = strlen(def->character), nk = strlen(def->rig_clip);
    if (!nc || !nk) return CS_DEF_EMPTY;
    if (nc > CS_ENTRY_MAX || nk > CS_CLIP_MAX) return CS_DEF_TOO_LONG;
    if (strncmp(def->rig_clip, CS_DATA_PREFIX, sizeof CS_DATA_PREFIX - 1) == 0) return CS_DEF_DATA_EXPORT;
    return CS_DEF_OK;
}

const char *cs_check_text(CsDefCheck c) {
    switch (c) {
    case CS_DEF_OK: return "ok";
    case CS_DEF_NULL: return "null definition, character or clip";
    case CS_DEF_EMPTY: return "empty character or clip name";
    case CS_DEF_TOO_LONG: return "the character is longer than 63 bytes or the clip than 71";
    case CS_DEF_DATA_EXPORT: return "a _CatRig_ export is bound from data by the framework; a DLL pair names any other export";
    }
    return "unknown check";
}

static void say(const CsBinder *b, const char *fmt, const char *x, const char *y, const char *z) {
    if (!b->log) return;
    char line[256];
    snprintf(line, sizeof line, fmt, x, y, z);
    b->log(b->user, line);
}

int cs_bind_all(const CsBinder *b, const FwCatRigDef *defs, int n) {
    if (!b || !b->reg || !b->rigFor || !defs) return 0;
    int bound = 0;
    for (int i = 0; i < n; i++) {
        const FwCatRigDef *d = &defs[i];
        CsDefCheck c = cs_check_def(d);
        if (c != CS_DEF_OK) {
            say(b, "skipped %s for %s: %s", d->rig_clip ? d->rig_clip : "(null)", d->character ? d->character : "(null)", cs_check_text(c));
            continue;
        }
        if (!b->reg(d)) { say(b, "FW_RegisterCatRig refused %s for %s%s", d->rig_clip, d->character, ""); continue; }
        const char *got = b->rigFor(d->character);
        if (!got || strcmp(got, d->rig_clip) != 0) {
            say(b, "FW_CatRigFor(%s) = %s after registering %s", d->character, got ? got : "(null)", d->rig_clip);
            continue;
        }
        say(b, "bound %s -> %s (FW_CatRigFor agrees)%s", d->character, d->rig_clip, "");
        bound++;
    }
    return bound;
}
