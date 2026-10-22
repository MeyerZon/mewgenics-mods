/* fw_unit_palette.h — the palette row of a unit's GON model (3D phase M3 "pal", docs/possible_3d_work.md): a model block
 * with `palette true` on a cat draws its grey pixels through the cat's own palette.png row, the row the game gives the
 * cat's 2D doll. Pure: no windows.h, no game calls; host-tested by test/test_unit_palette.c over fake memory laid out by
 * the GENERATED offsets.h, compiled into the DLL unchanged. obj3d_engine.c does the guarded reads and the logging.
 *
 * OBSERVED (docs/engine-map.md "Cat parts: ... palette"; manifest entries Character_catParts, CatParts_palette,
 * CatParts_paletteOverride, CatPartsMultiPalette, witnessed in Character::init(clip) 0xf1150 / CatParts_Refresh 0x73f7d0):
 *  - Character+OFF_CH_CATPARTS = the CatParts component, stored by Character::init for a `_CAT` clip; NULL for every
 *    other unit (Character::init tests it before giving the shadow the doll's material);
 *  - CatParts::init / CatParts_Refresh set the uniform `palette` of the doll's `paletted` material (CatParts+0x160) to
 *    the base row CatParts+OFF_CATPARTS_PALETTE, then to the override CatParts+OFF_CATPARTS_PAL_OVERRIDE unless that is
 *    -1 (unset) or CONST_CAT_MULTI_PALETTE (-69: one material per part, the class's palette list; the mesh then takes
 *    the base row — INFERRED the closest single row);
 *  - non-cat units (no CatParts) are never palette-remapped by the game: their `palette true` model stays as authored
 *    (row -1, the documented default "off"). */
#pragma once
#include <stddef.h>
#include "offsets.h"
#include "fw_gon.h"   /* FwMemRead */

/* the row the doll's paletted material shows: override unless -1 / CONST_CAT_MULTI_PALETTE, else base; a negative
 * result (no usable row) is -1 */
int fw_cat_palette_row(int base, int override_);

enum { FW_UNIT_PAL_UNREADABLE = -1, FW_UNIT_PAL_NOT_CAT = 0, FW_UNIT_PAL_CAT = 1 };
typedef struct FwUnitPalette {
    int status;      /* FW_UNIT_PAL_*: a cat (CatParts read), not a cat (Character+0x90 NULL), or unreadable memory */
    int base, override_;   /* the CatParts fields (cats only; else -1) */
    int row;         /* fw_cat_palette_row for a cat, else -1 */
} FwUnitPalette;
/* reads Character+OFF_CH_CATPARTS and the two rows through rd; returns out->status */
int fw_unit_palette_read(FwMemRead rd, void *u, const void *character, FwUnitPalette *out);

/* the palette row a GON model object draws with: usePalette 1 (GON `palette true`) = the unit's row (p NULL = -1);
 * otherwise `current` unchanged (the row an API call set, normally -1 = off) */
int fw_unit_model_palette(int usePalette, int current, const FwUnitPalette *p);

/* "unit palette: <entry> handle=<h> row=<r> base=<b> override=<o>" for a cat,
 * "unit palette: <entry> handle=<h> row=-1 (no CatParts: not a cat, colours as authored)" or
 * "unit palette: <entry> handle=<h> row=-1 (CatParts unreadable)". The length written; always NUL-terminated. */
int fw_unit_fmt_palette(char *buf, size_t n, const char *entry, int handle, const FwUnitPalette *p);
