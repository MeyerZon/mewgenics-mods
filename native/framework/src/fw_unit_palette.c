/* fw_unit_palette.c — the palette row of a unit's GON model (fw_unit_palette.h). Pure; host-tested by
 * test/test_unit_palette.c. */
#include <stdio.h>
#include <stdint.h>
#include "fw_unit_palette.h"

int fw_cat_palette_row(int base, int override_) {
    /* CatParts::init 0x73cc70: SetUniformInt(palette, base); if (override != -1 && override != -69) SetUniformInt(palette, override) */
    int row = (override_ >= 0 && override_ != CONST_CAT_MULTI_PALETTE) ? override_ : base;
    return row >= 0 ? row : -1;
}

int fw_unit_palette_read(FwMemRead rd, void *u, const void *character, FwUnitPalette *out) {
    out->status = FW_UNIT_PAL_UNREADABLE;
    out->base = out->override_ = out->row = -1;
    const void *parts = NULL;
    if (!character || !rd(u, (const char *)character + OFF_CH_CATPARTS, &parts, sizeof parts)) return out->status;
    if (!parts) return out->status = FW_UNIT_PAL_NOT_CAT;
    int32_t base, ovr;
    if (!rd(u, (const char *)parts + OFF_CATPARTS_PALETTE, &base, sizeof base) ||
        !rd(u, (const char *)parts + OFF_CATPARTS_PAL_OVERRIDE, &ovr, sizeof ovr)) return out->status;
    out->base = base;
    out->override_ = ovr;
    out->row = fw_cat_palette_row(base, ovr);
    return out->status = FW_UNIT_PAL_CAT;
}

int fw_unit_model_palette(int usePalette, int current, const FwUnitPalette *p) {
    if (usePalette != 1) return current;
    return p && p->status == FW_UNIT_PAL_CAT ? p->row : -1;
}

int fw_unit_fmt_palette(char *buf, size_t n, const char *entry, int handle, const FwUnitPalette *p) {
    if (!n) return 0;
    int k;
    if (p->status == FW_UNIT_PAL_CAT)
        k = snprintf(buf, n, "unit palette: %s handle=%d row=%d base=%d override=%d", entry, handle, p->row, p->base, p->override_);
    else
        k = snprintf(buf, n, "unit palette: %s handle=%d row=-1 (%s)", entry, handle,
                     p->status == FW_UNIT_PAL_NOT_CAT ? "no CatParts: not a cat, colours as authored" : "CatParts unreadable");
    return k < 0 ? 0 : k;
}
