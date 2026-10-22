/* Host-side tests for the pure entity/component walks and object edits of the status engine (src/fw_walk.c):
 * Character -> Entity -> components, finding a custom status by vtable, visiting every custom status of a
 * character, the apply_status argument resolution and merge writes, and the FW_SetStatusStacks writes. The
 * fakes are byte buffers shaped like the real objects through the GENERATED offsets.h macros only
 * (Character+OFF_CH_ENTITY = Entity*, Entity+OFF_ENT_COMPCOUNT / +OFF_ENT_COMPS = {count, Component**},
 * Status+0 = vtable, +OFF_STATUS_* fields); no windows.h, no game. */
#define FW_NO_WINDOWS
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include "../../test/minitest.h"
#include "fw_walk.h"

/* buffers big enough for every offset the walks touch; sizes are test choices, not game facts */
#define FAKE_CHARACTER_BYTES 0x1000
#define FAKE_ENTITY_BYTES    0x40
#define FAKE_STATUS_BYTES    0x100
#define FAKE_CTX_BYTES       0x40
#define FAKE_P6_BYTES        0x20
_Static_assert(OFF_CH_ENTITY + 8 <= FAKE_CHARACTER_BYTES && OFF_CH_TOUCHED_PASSIVES + 1 <= FAKE_CHARACTER_BYTES, "character fake too small");
_Static_assert(OFF_ENT_COMPCOUNT + 4 <= FAKE_ENTITY_BYTES && OFF_ENT_COMPS + 8 <= FAKE_ENTITY_BYTES, "entity fake too small");
_Static_assert(OFF_STATUS_TEMPORARY + 1 <= FAKE_STATUS_BYTES && OFF_STATUS_APPLIER_OWNER + 8 <= FAKE_STATUS_BYTES, "status fake too small");
_Static_assert(OFF_APPLYCTX_CHARACTER + 8 <= FAKE_CTX_BYTES && OFF_APPLYCTX_ENTITY + 8 <= FAKE_CTX_BYTES, "ctx fake too small");
_Static_assert(OFF_APPLYP6_APPLIER + 8 <= FAKE_P6_BYTES, "p6 fake too small");

typedef struct Fakes {
    unsigned char character[FAKE_CHARACTER_BYTES];
    unsigned char entity[FAKE_ENTITY_BYTES];
    unsigned char status[4][FAKE_STATUS_BYTES];
    void *comps[8];
} Fakes;

static void *VT_A = (void *)0xA000, *VT_B = (void *)0xB000, *VT_GAME = (void *)0xC000;

static void make_status(unsigned char *st, void *vt, int stacks, char removing, char temporary, void *character) {
    memset(st, 0, FAKE_STATUS_BYTES);
    *(void **)st = vt;
    *(int *)(st + OFF_STATUS_STACKS) = stacks;
    st[OFF_STATUS_REMOVING] = removing;
    st[OFF_STATUS_TEMPORARY] = temporary;
    *(void **)(st + OFF_STATUS_CHARACTER) = character;
}

/* a character with an entity holding `n` components */
static void make_character(Fakes *f, uint32_t n) {
    memset(f->character, 0, sizeof f->character);
    memset(f->entity, 0, sizeof f->entity);
    *(void **)(f->character + OFF_CH_ENTITY) = f->entity;
    *(uint32_t *)(f->entity + OFF_ENT_COMPCOUNT) = n;
    *(void **)(f->entity + OFF_ENT_COMPS) = f->comps;
}

TEST(accessors_read_through_the_generated_offsets) {
    Fakes f; make_character(&f, 3);
    CHECK(fw_walk_char_entity(f.character) == f.entity);
    CHECK_EQ(fw_walk_entity_count(f.entity), 3);
    CHECK(fw_walk_entity_components(f.entity) == f.comps);
    make_status(f.status[0], VT_A, 5, 1, 2, f.character);
    CHECK(fw_walk_status_vt(f.status[0]) == VT_A);
    CHECK_EQ(*fw_walk_status_stacks(f.status[0]), 5);
    CHECK_EQ(fw_walk_status_removing(f.status[0]), 1);
    CHECK_EQ(fw_walk_status_temporary(f.status[0]), 2);
    CHECK(fw_walk_status_character(f.status[0]) == f.character);
}

TEST(find_status_returns_the_first_live_component_with_the_vtable) {
    Fakes f; make_character(&f, 4);
    make_status(f.status[0], VT_GAME, 1, 0, 0, f.character);   /* a vanilla status */
    make_status(f.status[1], VT_A, 1, 1, 0, f.character);      /* ours, but being removed */
    make_status(f.status[2], VT_A, 1, 0, 1, f.character);      /* ours, but temporary */
    make_status(f.status[3], VT_A, 1, 0, 0, f.character);      /* the one */
    f.comps[0] = f.status[0]; f.comps[1] = f.status[1]; f.comps[2] = f.status[2]; f.comps[3] = f.status[3];
    CHECK(fw_walk_find_status(f.character, VT_A) == f.status[3]);
    CHECK(fw_walk_find_status(f.character, VT_B) == NULL);
}

TEST(find_status_skips_null_components_and_tolerates_a_missing_entity) {
    Fakes f; make_character(&f, 2);
    make_status(f.status[0], VT_A, 1, 0, 0, f.character);
    f.comps[0] = NULL; f.comps[1] = f.status[0];
    CHECK(fw_walk_find_status(f.character, VT_A) == f.status[0]);
    *(uint32_t *)(f.entity + OFF_ENT_COMPCOUNT) = 1;                 /* the count bounds the walk */
    CHECK(fw_walk_find_status(f.character, VT_A) == NULL);
    *(void **)(f.character + OFF_CH_ENTITY) = NULL;
    CHECK(fw_walk_find_status(f.character, VT_A) == NULL);
    CHECK(fw_walk_find_status(NULL, VT_A) == NULL);
}

TEST(find_live_takes_temporary_statuses_too_but_never_a_removing_one) {
    Fakes f; make_character(&f, 3);
    make_status(f.status[0], VT_A, 1, 1, 0, f.character);      /* ours, being removed: never */
    make_status(f.status[1], VT_A, 1, 0, 1, f.character);      /* ours, temporary (a Temporary glow): yes */
    make_status(f.status[2], VT_A, 1, 0, 0, f.character);
    f.comps[0] = f.status[0]; f.comps[1] = f.status[1]; f.comps[2] = f.status[2];
    CHECK(fw_walk_find_live(f.character, VT_A) == f.status[1]);
    CHECK(fw_walk_find_status(f.character, VT_A) == f.status[2]);  /* the merge target stays non-temporary */
    f.status[1][OFF_STATUS_REMOVING] = 1; f.status[2][OFF_STATUS_REMOVING] = 1;
    CHECK(fw_walk_find_live(f.character, VT_A) == NULL);
    CHECK(fw_walk_find_live(f.character, VT_B) == NULL);
    *(void **)(f.character + OFF_CH_ENTITY) = NULL;
    CHECK(fw_walk_find_live(f.character, VT_A) == NULL);
    CHECK(fw_walk_find_live(NULL, VT_A) == NULL);
}

TEST(entity_find_status_walks_the_apply_entity_directly_not_ctx_plus_0x20s_entity) {
    /* OBSERVED 2026-10-22 (data-glow T2, StatusOnSpawnIn): apply_status's ctx is the Character itself (ctx+0x18 =
     * the entity holding the statuses, the new object's +0x38 = ctx) and ctx+0x20 is another object whose entity
     * holds no components — so a merge lookup must walk the entity apply_status names, not ctx+0x20's */
    Fakes f; make_character(&f, 2);
    make_status(f.status[0], VT_A, 1, 1, 0, f.character);      /* removing: never */
    make_status(f.status[1], VT_A, 1, 0, 0, f.character);
    f.comps[0] = f.status[0]; f.comps[1] = f.status[1];
    CHECK(fw_walk_entity_find_status(f.entity, VT_A) == f.status[1]);
    f.status[1][OFF_STATUS_TEMPORARY] = 1;                          /* the merge target is never a temporary */
    CHECK(fw_walk_entity_find_status(f.entity, VT_A) == NULL);
    CHECK(fw_walk_entity_find_status(f.entity, VT_B) == NULL);
    CHECK(fw_walk_entity_find_status(NULL, VT_A) == NULL);
    f.status[1][OFF_STATUS_TEMPORARY] = 0;
    CHECK(fw_walk_find_status(f.character, VT_A) == fw_walk_entity_find_status(f.entity, VT_A));   /* the character form is a wrapper */
}

TEST(apply_existing_finds_the_units_status_under_both_ctx_shapes_never_through_ctx_plus_0x20) {
    /* OBSERVED 2026-10-22 (mods/jokers-luck/tests/merge-contexts.mewtest, red run 20261022-115757): apply_status's
     * ctx is a Component in every shape — the passive component under StatusOnBattleStart, the Character itself under
     * StatusOnSpawnIn — whose +0x18 is the unit's entity and whose +0x20 is the Scene (the framework logged "created on
     * <p>" with p = the `enter` event's scene= for all 6 applies). A second JokersLuck therefore never found the first
     * through ctx+0x20 and each unit carried two objects (1 and 2) instead of one with 3 stacks. */
    Fakes f; make_character(&f, 2);
    make_status(f.status[0], VT_GAME, 1, 0, 0, f.character);
    make_status(f.status[1], VT_A, 1, 0, 0, f.character);
    f.comps[0] = f.status[0]; f.comps[1] = f.status[1];
    unsigned char sceneEntity[FAKE_ENTITY_BYTES]; memset(sceneEntity, 0, sizeof sceneEntity);   /* holds no components */
    unsigned char scene[FAKE_CHARACTER_BYTES]; memset(scene, 0, sizeof scene);
    *(void **)(scene + OFF_CH_ENTITY) = sceneEntity;
    FwApplyResolved a;
    /* shape 1, StatusOnSpawnIn: ctx = the Character (its +0x18 = entity), ctx+0x20 = the scene */
    *(void **)(f.character + OFF_APPLYCTX_CHARACTER) = scene;
    fw_walk_apply_resolve(f.character, NULL, NULL, NULL, NULL, &a);
    CHECK(fw_walk_apply_existing(&a, VT_A) == f.status[1]);
    /* shape 2, StatusOnBattleStart: ctx = the passive component (its +0x18 = the unit's entity), ctx+0x20 = the scene */
    unsigned char passive[FAKE_CTX_BYTES]; memset(passive, 0, sizeof passive);
    *(void **)(passive + OFF_APPLYCTX_ENTITY) = f.entity;
    *(void **)(passive + OFF_APPLYCTX_CHARACTER) = scene;
    fw_walk_apply_resolve(passive, NULL, NULL, NULL, NULL, &a);
    CHECK(fw_walk_apply_existing(&a, VT_A) == f.status[1]);
    CHECK(fw_walk_apply_existing(&a, VT_B) == NULL);
    f.status[1][OFF_STATUS_TEMPORARY] = 1;                          /* a temporary is never the merge target */
    CHECK(fw_walk_apply_existing(&a, VT_A) == NULL);
    *(void **)(passive + OFF_APPLYCTX_ENTITY) = NULL;               /* no entity: nothing to merge into */
    fw_walk_apply_resolve(passive, NULL, NULL, NULL, NULL, &a);
    CHECK(fw_walk_apply_existing(&a, VT_A) == NULL);
}

TEST(vt_index_finds_a_registered_vtable) {
    void *vts[3] = { VT_A, VT_B, NULL };
    CHECK_EQ(fw_walk_vt_index(vts, 2, VT_A), 0);
    CHECK_EQ(fw_walk_vt_index(vts, 2, VT_B), 1);
    CHECK_EQ(fw_walk_vt_index(vts, 2, VT_GAME), -1);
    CHECK_EQ(fw_walk_vt_index(vts, 0, VT_A), -1);
    CHECK_EQ(fw_walk_vt_index(vts, 3, NULL), -1);                   /* a null vtable never matches */
}

typedef struct Visit { int index; void *component; } Visit;
static Visit g_visits[8]; static int g_visitCount;
static void record_visit(int defIndex, void *component, void *user) {
    CHECK(user == (void *)0x55);
    g_visits[g_visitCount].index = defIndex; g_visits[g_visitCount].component = component; g_visitCount++;
}

TEST(each_custom_visits_live_custom_statuses_in_component_order) {
    Fakes f; make_character(&f, 5);
    void *vts[2] = { VT_A, VT_B };
    make_status(f.status[0], VT_B, 1, 0, 0, f.character);
    make_status(f.status[1], VT_GAME, 1, 0, 0, f.character);
    make_status(f.status[2], VT_A, 1, 1, 0, f.character);        /* removing: skipped */
    make_status(f.status[3], VT_A, 1, 0, 1, f.character);        /* temporary: still visited (turn callbacks see it) */
    f.comps[0] = f.status[0]; f.comps[1] = f.status[1]; f.comps[2] = NULL; f.comps[3] = f.status[2]; f.comps[4] = f.status[3];
    g_visitCount = 0;
    CHECK_EQ(fw_walk_each_custom(f.character, vts, 2, record_visit, (void *)0x55), 2);
    CHECK_EQ(g_visitCount, 2);
    CHECK_EQ(g_visits[0].index, 1); CHECK(g_visits[0].component == f.status[0]);
    CHECK_EQ(g_visits[1].index, 0); CHECK(g_visits[1].component == f.status[3]);
}

TEST(each_custom_is_a_noop_without_character_entity_or_definitions) {
    Fakes f; make_character(&f, 1);
    void *vts[1] = { VT_A };
    make_status(f.status[0], VT_A, 1, 0, 0, f.character);
    f.comps[0] = f.status[0];
    g_visitCount = 0;
    CHECK_EQ(fw_walk_each_custom(NULL, vts, 1, record_visit, (void *)0x55), 0);
    CHECK_EQ(fw_walk_each_custom(f.character, vts, 0, record_visit, (void *)0x55), 0);
    *(void **)(f.character + OFF_CH_ENTITY) = NULL;
    CHECK_EQ(fw_walk_each_custom(f.character, vts, 1, record_visit, (void *)0x55), 0);
    CHECK_EQ(g_visitCount, 0);
}

TEST(apply_resolve_reads_ctx_and_picks_source_and_applier) {
    unsigned char ctx[FAKE_CTX_BYTES]; memset(ctx, 0, sizeof ctx);
    unsigned char p6[FAKE_P6_BYTES]; memset(p6, 0, sizeof p6);
    *(void **)(ctx + OFF_APPLYCTX_CHARACTER) = (void *)0xC1;
    *(void **)(ctx + OFF_APPLYCTX_ENTITY) = (void *)0xE1;
    *(void **)(p6 + OFF_APPLYP6_APPLIER) = (void *)0xA6;
    FwApplyResolved r;
    fw_walk_apply_resolve(ctx, (void *)0x51, (void *)0x55, p6, (void *)0xD0, &r);
    CHECK(r.character == (void *)0xC1);
    CHECK(r.entity == (void *)0xE1);
    CHECK(r.source == (void *)0x51);                                  /* an explicit source wins */
    CHECK(r.applier == (void *)0x55);                                 /* p5 wins over p6's applier */
    fw_walk_apply_resolve(ctx, NULL, NULL, p6, (void *)0xD0, &r);
    CHECK(r.source == (void *)0xD0);                                  /* default source when src is null */
    CHECK(r.applier == (void *)0xA6);                                 /* then p6->applier */
    fw_walk_apply_resolve(ctx, NULL, NULL, NULL, (void *)0xD0, &r);
    CHECK(r.applier == NULL);                                         /* then nothing */
}

TEST(apply_merges_only_into_an_existing_non_temporary_apply) {
    CHECK_EQ(fw_walk_apply_merges((void *)0x1, 0), 1);
    CHECK_EQ(fw_walk_apply_merges((void *)0x1, 1), 0);               /* a temporary apply always constructs */
    CHECK_EQ(fw_walk_apply_merges(NULL, 0), 0);
    CHECK_EQ(fw_walk_apply_merges(NULL, 1), 0);
}

TEST(merge_stacks_adds_and_records_the_applier_and_its_owner) {
    unsigned char st[FAKE_STATUS_BYTES]; make_status(st, VT_A, 3, 0, 0, NULL);
    unsigned char applierBlock[16]; memset(applierBlock, 0, sizeof applierBlock);
    void *applier = applierBlock + 8;                                 /* owner sits at applier + OFF_APPLIER_OWNER (negative) */
    *(void **)((char *)applier + OFF_APPLIER_OWNER) = (void *)0x0F;
    CHECK_EQ(fw_walk_merge_stacks(st, 2, applier), 5);
    CHECK_EQ(*fw_walk_status_stacks(st), 5);
    CHECK(*(void **)(st + OFF_STATUS_APPLIER) == applier);
    CHECK(*(void **)(st + OFF_STATUS_APPLIER_OWNER) == (void *)0x0F);
    CHECK_EQ(fw_walk_merge_stacks(st, -5, NULL), 0);                 /* reaching 0 is the caller's cue to remove */
    CHECK(*(void **)(st + OFF_STATUS_APPLIER) == NULL);
    CHECK(*(void **)(st + OFF_STATUS_APPLIER_OWNER) == NULL);
    CHECK_EQ(st[OFF_STATUS_REMOVING], 0);                            /* the walk never flags removal itself */
}

TEST(adopt_swaps_the_vtable_and_stores_the_temporary_flag) {
    unsigned char st[FAKE_STATUS_BYTES]; make_status(st, VT_GAME, 1, 0, 0, NULL);
    void *vt[4] = { 0 };
    fw_walk_adopt(st, vt, 1);
    CHECK(fw_walk_status_vt(st) == vt);
    CHECK_EQ(st[OFF_STATUS_TEMPORARY], 1);
    CHECK_EQ(*fw_walk_status_stacks(st), 1);                         /* nothing else is touched */
}

TEST(set_stacks_writes_and_touch_passives_marks_the_character) {
    Fakes f; make_character(&f, 0);
    make_status(f.status[0], VT_A, 3, 0, 0, f.character);
    fw_walk_write_stacks(f.status[0], 9);
    CHECK_EQ(*fw_walk_status_stacks(f.status[0]), 9);
    CHECK_EQ(f.character[OFF_CH_TOUCHED_PASSIVES], 0);               /* writing stacks alone does not touch */
    CHECK_EQ(fw_walk_touch_passives(f.status[0]), 1);
    CHECK_EQ(f.character[OFF_CH_TOUCHED_PASSIVES], 1);
    make_status(f.status[1], VT_A, 3, 0, 0, NULL);                   /* no character: nothing to mark */
    CHECK_EQ(fw_walk_touch_passives(f.status[1]), 0);
}

int main(void) { return MT_RUN_ALL(); }
