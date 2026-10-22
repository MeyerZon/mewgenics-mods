/* Host-side tests for the unit palette row (src/fw_unit_palette.c, 3D phase M3 "pal"): the row rule CatParts::init /
 * CatParts_Refresh apply to the doll's paletted material (override unless -1 / -69, else base), the Character ->
 * CatParts -> rows read over fake memory laid out by the GENERATED offsets.h through a guarded fake reader, the GON
 * `palette true` selection and the log line. No windows.h, no game. */
#define FW_NO_WINDOWS
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdio.h>
#include "../../test/minitest.h"
#include "fw_unit_palette.h"

static unsigned char character[0x400], catParts[0x800];
static int in(const void *a, size_t n, const void *buf, size_t size) {
    const unsigned char *p = (const unsigned char *)a, *b = (const unsigned char *)buf;
    return p >= b && p + n <= b + size;
}
static int fake_read(void *u, const void *addr, void *out, size_t n) {
    (void)u;
    if (!addr || !n) return 0;
    if (in(addr, n, character, sizeof character) || in(addr, n, catParts, sizeof catParts)) { memcpy(out, addr, n); return 1; }
    return 0;
}
static void fake_cat(const void *parts, int base, int override_) {
    memset(character, 0, sizeof character); memset(catParts, 0, sizeof catParts);
    memcpy(character + OFF_CH_CATPARTS, &parts, sizeof parts);
    memcpy(catParts + OFF_CATPARTS_PALETTE, &base, sizeof base);
    memcpy(catParts + OFF_CATPARTS_PAL_OVERRIDE, &override_, sizeof override_);
}

TEST(the_generated_offsets_are_the_witnessed_ones) {
    CHECK_EQ(OFF_CH_CATPARTS, 0x90);
    CHECK_EQ(OFF_CATPARTS_PALETTE, 0x1b4);
    CHECK_EQ(OFF_CATPARTS_PAL_OVERRIDE, 0x1b8);
    CHECK_EQ(CONST_CAT_MULTI_PALETTE, -69);
}

TEST(row_rule_is_the_dolls_material_rule) {
    CHECK_EQ(fw_cat_palette_row(9, -1), 9);                         /* no override: the base row */
    CHECK_EQ(fw_cat_palette_row(9, 137), 137);                      /* OverridePalette / prop / Jester cycle */
    CHECK_EQ(fw_cat_palette_row(9, 0), 0);                          /* row 0 is a real override */
    CHECK_EQ(fw_cat_palette_row(16, CONST_CAT_MULTI_PALETTE), 16);  /* multi-palette: the base row */
    CHECK_EQ(fw_cat_palette_row(-1, -1), -1);                       /* nothing usable */
    CHECK_EQ(fw_cat_palette_row(-5, -1), -1);
    CHECK_EQ(fw_cat_palette_row(-1, CONST_CAT_MULTI_PALETTE), -1);
    CHECK_EQ(fw_cat_palette_row(4, -7), 4);                         /* any other negative override is no row: base */
}

TEST(read_walks_character_to_catparts_rows) {
    FwUnitPalette p;
    fake_cat(catParts, 9, -1);
    CHECK_EQ(fw_unit_palette_read(fake_read, NULL, character, &p), FW_UNIT_PAL_CAT);
    CHECK_EQ(p.status, FW_UNIT_PAL_CAT); CHECK_EQ(p.base, 9); CHECK_EQ(p.override_, -1); CHECK_EQ(p.row, 9);
    fake_cat(catParts, 16, 144);
    CHECK_EQ(fw_unit_palette_read(fake_read, NULL, character, &p), FW_UNIT_PAL_CAT);
    CHECK_EQ(p.row, 144);
}

TEST(read_null_catparts_is_not_a_cat_and_bad_memory_is_unreadable) {
    FwUnitPalette p;
    fake_cat(NULL, 9, 3);
    CHECK_EQ(fw_unit_palette_read(fake_read, NULL, character, &p), FW_UNIT_PAL_NOT_CAT);
    CHECK_EQ(p.row, -1); CHECK_EQ(p.base, -1); CHECK_EQ(p.override_, -1);
    fake_cat((const void *)0x40, 9, 3);                             /* a CatParts* the reader refuses */
    CHECK_EQ(fw_unit_palette_read(fake_read, NULL, character, &p), FW_UNIT_PAL_UNREADABLE);
    CHECK_EQ(p.row, -1);
    CHECK_EQ(fw_unit_palette_read(fake_read, NULL, (const void *)0x40, &p), FW_UNIT_PAL_UNREADABLE);
    CHECK_EQ(fw_unit_palette_read(fake_read, NULL, NULL, &p), FW_UNIT_PAL_UNREADABLE);
    CHECK_EQ(p.row, -1);
}

TEST(gon_palette_true_takes_the_unit_row_else_keeps_the_current) {
    FwUnitPalette cat = { FW_UNIT_PAL_CAT, 9, -1, 9 }, rat = { FW_UNIT_PAL_NOT_CAT, -1, -1, -1 };
    CHECK_EQ(fw_unit_model_palette(1, -1, &cat), 9);
    CHECK_EQ(fw_unit_model_palette(1, 40, &cat), 9);       /* palette true follows the cat even over an API row */
    CHECK_EQ(fw_unit_model_palette(1, -1, &rat), -1);      /* not a cat: colours as authored */
    CHECK_EQ(fw_unit_model_palette(1, -1, NULL), -1);
    CHECK_EQ(fw_unit_model_palette(0, -1, &cat), -1);      /* palette false: never the cat's row */
    CHECK_EQ(fw_unit_model_palette(-1, -1, &cat), -1);     /* not given: as before (off) */
    CHECK_EQ(fw_unit_model_palette(0, 40, &cat), 40);      /* an API-set row stays */
}

TEST(log_line_names_the_row_and_where_it_came_from) {
    char buf[256];
    FwUnitPalette cat = { FW_UNIT_PAL_CAT, 9, -1, 9 }, rat = { FW_UNIT_PAL_NOT_CAT, -1, -1, -1 }, bad = { FW_UNIT_PAL_UNREADABLE, -1, -1, -1 };
    fw_unit_fmt_palette(buf, sizeof buf, "TomTom", 3, &cat);
    CHECK_STR(buf, "unit palette: TomTom handle=3 row=9 base=9 override=-1");
    fw_unit_fmt_palette(buf, sizeof buf, "Rat", 1, &rat);
    CHECK_STR(buf, "unit palette: Rat handle=1 row=-1 (no CatParts: not a cat, colours as authored)");
    fw_unit_fmt_palette(buf, sizeof buf, "X", 2, &bad);
    CHECK_STR(buf, "unit palette: X handle=2 row=-1 (CatParts unreadable)");
    char small[12];
    int k = fw_unit_fmt_palette(small, sizeof small, "TomTom", 3, &cat);
    CHECK(k > 0 && strlen(small) == sizeof small - 1);
}

int main(void) { return MT_RUN_ALL(); }
