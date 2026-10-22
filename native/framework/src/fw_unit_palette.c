/* fw_unit_palette.c — the palette row of a unit's GON model (fw_unit_palette.h). Red stub: not implemented yet. */
#include "fw_unit_palette.h"

int fw_cat_palette_row(int base, int override_) { (void)base; (void)override_; return -2; }
int fw_unit_palette_read(FwMemRead rd, void *u, const void *character, FwUnitPalette *out) {
    (void)rd; (void)u; (void)character;
    out->status = -2; out->base = out->override_ = out->row = -2;
    return -2;
}
int fw_unit_model_palette(int usePalette, int current, const FwUnitPalette *p) { (void)usePalette; (void)current; (void)p; return -2; }
int fw_unit_fmt_palette(char *buf, size_t n, const char *entry, int handle, const FwUnitPalette *p) {
    (void)entry; (void)handle; (void)p;
    if (n) buf[0] = 0;
    return 0;
}
