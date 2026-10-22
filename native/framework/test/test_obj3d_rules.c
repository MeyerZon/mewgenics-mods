/* Host-side tests for the pure 3D-object registry (src/fw_obj3d_rules.c, API v8): Character objects (one per unit,
 * pool generation at Character-8 captured and pruned, the glow registry's idiom), tile objects (anchored at the tile
 * centre), handles (never reused, survive nothing across clear), the cap, the model-name and GON model-path rules,
 * and the model matrix = translation to the anchor x the object's own transform (column-major). Plus the API v8
 * shape of framework_api.h (version numbers and the FwApi layout a mod resolves). No windows.h, no game. */
#define FW_NO_WINDOWS
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <math.h>
#include "../../test/minitest.h"
#include "fw_obj3d_rules.h"
#include "fw_mesh_rules.h"
#include "framework_api.h"

_Static_assert(OFF_CH_GENERATION == -8, "the generation sits right before the Character (the pool header)");

/* a Character with its pool generation at -8 (what OFF_CH_GENERATION reads); fake size is a test choice */
typedef struct FakeCharacter { uint64_t generation; unsigned char body[0x40]; } FakeCharacter;
static void *make_character(FakeCharacter *c, uint64_t gen) { memset(c, 0, sizeof *c); c->generation = gen; return c->body; }

static int near(float a, float b) { return fabsf(a - b) < 1e-5f; }
static int mat_eq(const float a[16], const float b[16]) { for (int i = 0; i < 16; i++) if (!near(a[i], b[i])) return 0; return 1; }
static const float ID[16] = { 1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1 };
/* scale 2 with its own translation (0, 1, 0): column-major */
static const float S2T[16] = { 2,0,0,0, 0,2,0,0, 0,0,2,0, 0,1,0,1 };

TEST(empty_registry_after_init) {
    Fw3dRegistry r; fw_obj3d_init(&r);
    CHECK_EQ(fw_obj3d_count(&r), 0);
    CHECK(fw_obj3d_at(&r, 0) == NULL);
    CHECK(fw_obj3d_at(&r, -1) == NULL);
    CHECK_EQ(fw_obj3d_find_handle(&r, 1), -1);
    CHECK_EQ(fw_obj3d_find_character(&r, NULL), -1);
}

TEST(character_object_captures_generation_copies_model_and_defaults_to_identity) {
    Fw3dRegistry r; fw_obj3d_init(&r);
    FakeCharacter fc; void *ch = make_character(&fc, 0x1234567890ull);
    int h = fw_obj3d_add_character(&r, ch, "models/crate.obj", NULL);
    CHECK(h > 0);
    CHECK_EQ(fw_obj3d_count(&r), 1);
    const Fw3dObject *o = fw_obj3d_at(&r, 0);
    CHECK(o != NULL);
    if (!o) return;
    CHECK_EQ(o->handle, h);
    CHECK(o->character == ch);
    CHECK(o->generation == 0x1234567890ull);
    CHECK_STR(o->model, "models/crate.obj");
    CHECK(mat_eq(o->transform, ID));
    CHECK_EQ(o->byTile, 0);
    CHECK_EQ(fw_obj3d_find_character(&r, ch), 0);
    CHECK_EQ(fw_obj3d_find_handle(&r, h), 0);
}

TEST(registering_the_same_character_again_replaces_model_and_transform_in_place_and_keeps_the_handle) {
    Fw3dRegistry r; fw_obj3d_init(&r);
    FakeCharacter a, b; void *ca = make_character(&a, 1), *cb = make_character(&b, 2);
    int ha = fw_obj3d_add_character(&r, ca, "Crate3D", NULL);
    int hb = fw_obj3d_add_character(&r, cb, "models/b.obj", NULL);
    CHECK(ha > 0 && hb > 0 && ha != hb);
    CHECK_EQ(fw_obj3d_add_character(&r, ca, "models/other.obj", S2T), ha);
    CHECK_EQ(fw_obj3d_count(&r), 2);
    const Fw3dObject *o = fw_obj3d_at(&r, 0);
    CHECK(o && o->character == ca);
    if (!o) return;
    CHECK_STR(o->model, "models/other.obj");
    CHECK(mat_eq(o->transform, S2T));
}

TEST(refusals_null_character_bad_model_full_registry) {
    Fw3dRegistry r; fw_obj3d_init(&r);
    FakeCharacter fc; void *ch = make_character(&fc, 7);
    char longName[FW_OBJ3D_MODEL_MAX + 1];
    memset(longName, 'a', FW_OBJ3D_MODEL_MAX); longName[FW_OBJ3D_MODEL_MAX] = 0;   /* 64 chars: no room for the NUL */
    CHECK_EQ(fw_obj3d_add_character(&r, NULL, "models/a.obj", NULL), 0);
    CHECK_EQ(fw_obj3d_add_character(&r, ch, NULL, NULL), 0);
    CHECK_EQ(fw_obj3d_add_character(&r, ch, "", NULL), 0);
    CHECK_EQ(fw_obj3d_add_character(&r, ch, longName, NULL), 0);
    CHECK_EQ(fw_obj3d_add_character(&r, ch, "models\\a.obj", NULL), 0);
    CHECK_EQ(fw_obj3d_add_character(&r, ch, "bad\nname", NULL), 0);
    longName[FW_OBJ3D_MODEL_MAX - 1] = 0;                                            /* 63 chars fit */
    CHECK(fw_obj3d_add_character(&r, ch, longName, NULL) > 0);
    CHECK_EQ(fw_obj3d_count(&r), 1);
    for (int i = 1; i < FW_OBJ3D_MAX; i++) CHECK(fw_obj3d_add_tile(&r, i, 0, "models/a.obj", NULL) > 0);
    CHECK_EQ(fw_obj3d_count(&r), FW_OBJ3D_MAX);
    CHECK_EQ(fw_obj3d_add_tile(&r, 0, 0, "models/a.obj", NULL), 0);
    FakeCharacter fd; void *cd = make_character(&fd, 8);
    CHECK_EQ(fw_obj3d_add_character(&r, cd, "models/a.obj", NULL), 0);
    CHECK(fw_obj3d_add_character(&r, ch, "models/b.obj", NULL) > 0);                  /* an update in place still works when full */
}

TEST(tile_objects_many_per_tile_bounds_and_distinct_increasing_handles) {
    Fw3dRegistry r; fw_obj3d_init(&r);
    int h1 = fw_obj3d_add_tile(&r, 3, 5, "models/crate.obj", NULL);
    int h2 = fw_obj3d_add_tile(&r, 3, 5, "models/crate.obj", S2T);
    CHECK(h1 > 0 && h2 > h1);
    CHECK_EQ(fw_obj3d_count(&r), 2);
    const Fw3dObject *o = fw_obj3d_at(&r, 1);
    CHECK(o != NULL);
    if (!o) return;
    CHECK_EQ(o->byTile, 1); CHECK_EQ(o->tileCol, 3); CHECK_EQ(o->tileRow, 5);
    CHECK(o->character == NULL);
    CHECK(mat_eq(o->transform, S2T));
    CHECK_EQ(fw_obj3d_add_tile(&r, -1, 0, "models/a.obj", NULL), 0);
    CHECK_EQ(fw_obj3d_add_tile(&r, 0, -1, "models/a.obj", NULL), 0);
    CHECK_EQ(fw_obj3d_add_tile(&r, FW_OBJ3D_TILE_MAX, 0, "models/a.obj", NULL), 0);
    CHECK_EQ(fw_obj3d_add_tile(&r, 0, FW_OBJ3D_TILE_MAX, "models/a.obj", NULL), 0);
    CHECK_EQ(fw_obj3d_add_tile(&r, 0, 0, "", NULL), 0);
    CHECK(fw_obj3d_add_tile(&r, FW_OBJ3D_TILE_MAX - 1, 0, "models/a.obj", NULL) > 0);
}

TEST(remove_by_character_and_by_handle_keeps_order_and_refuses_absent) {
    Fw3dRegistry r; fw_obj3d_init(&r);
    FakeCharacter a, b; void *ca = make_character(&a, 1), *cb = make_character(&b, 2);
    int ha = fw_obj3d_add_character(&r, ca, "models/a.obj", NULL);
    int ht = fw_obj3d_add_tile(&r, 1, 1, "models/t.obj", NULL);
    int hb = fw_obj3d_add_character(&r, cb, "models/b.obj", NULL);
    CHECK_EQ(fw_obj3d_remove_character(&r, ca), 1);
    CHECK_EQ(fw_obj3d_remove_character(&r, ca), 0);
    CHECK_EQ(fw_obj3d_remove_character(&r, NULL), 0);
    CHECK_EQ(fw_obj3d_count(&r), 2);
    CHECK_EQ(fw_obj3d_at(&r, 0)->handle, ht);
    CHECK_EQ(fw_obj3d_at(&r, 1)->handle, hb);
    CHECK_EQ(fw_obj3d_remove_handle(&r, ha), 0);          /* already gone */
    CHECK_EQ(fw_obj3d_remove_handle(&r, 0), 0);
    CHECK_EQ(fw_obj3d_remove_handle(&r, -3), 0);
    CHECK_EQ(fw_obj3d_remove_handle(&r, ht), 1);
    CHECK_EQ(fw_obj3d_count(&r), 1);
    CHECK_EQ(fw_obj3d_at(&r, 0)->handle, hb);
    CHECK_EQ(fw_obj3d_remove_handle(&r, hb), 1);          /* a Character object can go by handle too */
    CHECK_EQ(fw_obj3d_count(&r), 0);
    CHECK_EQ(fw_obj3d_find_character(&r, cb), -1);
}

TEST(prune_drops_character_objects_whose_pool_generation_moved_and_keeps_tiles) {
    Fw3dRegistry r; fw_obj3d_init(&r);
    FakeCharacter a, b; void *ca = make_character(&a, 10), *cb = make_character(&b, 20);
    fw_obj3d_add_character(&r, ca, "models/a.obj", NULL);
    int ht = fw_obj3d_add_tile(&r, 2, 2, "models/t.obj", NULL);
    int hb = fw_obj3d_add_character(&r, cb, "models/b.obj", NULL);
    CHECK_EQ(fw_obj3d_prune(&r), 0);
    a.generation = 11;                                      /* slot of `a` reused */
    CHECK_EQ(fw_obj3d_prune(&r), 1);
    CHECK_EQ(fw_obj3d_count(&r), 2);
    CHECK_EQ(fw_obj3d_at(&r, 0)->handle, ht);
    CHECK_EQ(fw_obj3d_at(&r, 1)->handle, hb);
    CHECK_EQ(fw_obj3d_find_character(&r, ca), -1);
}

TEST(clear_drops_everything_but_never_reuses_a_handle) {
    Fw3dRegistry r; fw_obj3d_init(&r);
    FakeCharacter a; void *ca = make_character(&a, 1);
    int h1 = fw_obj3d_add_character(&r, ca, "models/a.obj", NULL);
    int h2 = fw_obj3d_add_tile(&r, 0, 0, "models/a.obj", NULL);
    fw_obj3d_clear(&r);
    CHECK_EQ(fw_obj3d_count(&r), 0);
    CHECK_EQ(fw_obj3d_find_handle(&r, h1), -1);
    int h3 = fw_obj3d_add_tile(&r, 0, 0, "models/a.obj", NULL);
    CHECK(h3 > h2);
    CHECK_EQ(fw_obj3d_remove_handle(&r, h1), 0);
}

TEST(model_name_and_gon_model_path_rules) {
    CHECK(fw_obj3d_model_ok("Crate3D"));
    CHECK(fw_obj3d_model_ok("models/crate.obj"));
    CHECK(!fw_obj3d_model_ok(NULL));
    CHECK(!fw_obj3d_model_ok(""));
    CHECK(!fw_obj3d_model_ok("a\\b"));
    CHECK(!fw_obj3d_model_ok("tab\there"));
    CHECK(fw_obj3d_model_path_ok("models/crate.obj"));
    CHECK(fw_obj3d_model_path_ok("models/props/crate.obj"));
    CHECK(!fw_obj3d_model_path_ok(NULL));
    CHECK(!fw_obj3d_model_path_ok("crate.obj"));                 /* not under models/ */
    CHECK(fw_obj3d_model_path_ok("models/crate.glb"));           /* the mesh loader reads glTF too: one rule (fw_mesh_model_kind) */
    CHECK(fw_obj3d_model_path_ok("models/props/tire.gltf"));
    const char *same[] = { "models/crate.obj", "models/props/tire.obj", "models/a b.obj", "models/crate.fbx", "models/../x.obj", "models/crate.OBJ", "Crate3D" };
    for (size_t i = 0; i < sizeof same / sizeof same[0]; i++) CHECK_EQ(fw_obj3d_model_path_ok(same[i]), fw_mesh_model_kind(same[i]) != 0);
    CHECK(!fw_obj3d_model_path_ok("models/crate.OBJ.txt"));
    CHECK(!fw_obj3d_model_path_ok("models/.obj"));               /* empty base name */
    CHECK(!fw_obj3d_model_path_ok("models/../crate.obj"));
    CHECK(!fw_obj3d_model_path_ok("models//crate.obj"));
    CHECK(!fw_obj3d_model_path_ok("models\\crate.obj"));
    CHECK(!fw_obj3d_model_path_ok("/models/crate.obj"));
    CHECK(!fw_obj3d_model_path_ok("C:/models/crate.obj"));
    CHECK(!fw_obj3d_model_path_ok("Crate3D"));
}

TEST(material_texture_and_palette_row_per_object) {
    Fw3dRegistry r; fw_obj3d_init(&r);
    FakeCharacter fc; void *ch = make_character(&fc, 7);
    int ht = fw_obj3d_add_tile(&r, 4, 3, "models/crate.obj", NULL);
    int hc = fw_obj3d_add_character(&r, ch, "models/cat.glb", NULL);
    const Fw3dObject *t = fw_obj3d_at(&r, 0), *c = fw_obj3d_at(&r, 1);
    CHECK(t && c);
    if (!t || !c) return;
    CHECK_STR(t->texture, ""); CHECK_EQ(t->palette, -1);            /* defaults: the convention texture, palette off */
    CHECK_STR(c->texture, ""); CHECK_EQ(c->palette, -1);
    CHECK_EQ(fw_obj3d_set_material(&r, ht, "models/wood.png", 63), 1);
    CHECK_STR(t->texture, "models/wood.png"); CHECK_EQ(t->palette, 63);
    CHECK_EQ(fw_obj3d_set_material(&r, hc, NULL, 12), 1);            /* NULL texture = the convention */
    CHECK_STR(c->texture, ""); CHECK_EQ(c->palette, 12);
    CHECK_EQ(fw_obj3d_set_material(&r, hc, "", -5), 1);              /* any negative row = off */
    CHECK_EQ(c->palette, -1);
    CHECK_EQ(fw_obj3d_set_material(&r, 999, "models/wood.png", 1), 0);   /* unknown handle */
    CHECK_EQ(fw_obj3d_set_material(&r, ht, "bad\name.png", 1), 0);    /* a name fw_obj3d_model_ok refuses */
    CHECK_STR(t->texture, "models/wood.png"); CHECK_EQ(t->palette, 63);  /* unchanged by a refusal */
    /* re-registering a unit replaces model + transform and keeps its material (the unit agent re-registers per fight) */
    CHECK_EQ(fw_obj3d_set_material(&r, hc, "models/fur.png", 40), 1);
    CHECK_EQ(fw_obj3d_add_character(&r, ch, "models/cat2.glb", NULL), hc);
    CHECK_STR(c->texture, "models/fur.png"); CHECK_EQ(c->palette, 40);
}

TEST(mat4_mul_is_column_major_a_times_b) {
    /* T(1,2,3) x S(2): a point p maps to 2p + (1,2,3) */
    const float T[16] = { 1,0,0,0, 0,1,0,0, 0,0,1,0, 1,2,3,1 };
    const float S[16] = { 2,0,0,0, 0,2,0,0, 0,0,2,0, 0,0,0,1 };
    float out[16];
    fw_obj3d_mat4_mul(T, S, out);
    const float want[16] = { 2,0,0,0, 0,2,0,0, 0,0,2,0, 1,2,3,1 };
    CHECK(mat_eq(out, want));
    fw_obj3d_mat4_mul(S, T, out);                                /* S x T: translation scaled too */
    const float want2[16] = { 2,0,0,0, 0,2,0,0, 0,0,2,0, 2,4,6,1 };
    CHECK(mat_eq(out, want2));
    float id[16]; fw_obj3d_identity(id);
    CHECK(mat_eq(id, ID));
}

TEST(model_matrix_anchors_at_the_tile_centre_or_the_unit_position_times_the_own_transform) {
    Fw3dRegistry r; fw_obj3d_init(&r);
    float c[3];
    fw_obj3d_tile_centre(3, 5, c);
    CHECK(near(c[0], 3.5f) && near(c[1], 0.0f) && near(c[2], 5.5f));
    fw_obj3d_add_tile(&r, 3, 5, "models/crate.obj", NULL);
    fw_obj3d_add_tile(&r, 3, 5, "models/crate.obj", S2T);
    FakeCharacter a; void *ca = make_character(&a, 1);
    fw_obj3d_add_character(&r, ca, "models/crate.obj", S2T);
    float out[16];
    fw_obj3d_model_matrix(fw_obj3d_at(&r, 0), NULL, out);
    const float tileId[16] = { 1,0,0,0, 0,1,0,0, 0,0,1,0, 3.5f,0,5.5f,1 };
    CHECK(mat_eq(out, tileId));
    fw_obj3d_model_matrix(fw_obj3d_at(&r, 1), NULL, out);
    const float tileS2T[16] = { 2,0,0,0, 0,2,0,0, 0,0,2,0, 3.5f,1,5.5f,1 };
    CHECK(mat_eq(out, tileS2T));
    const double xz[2] = { 1.25, -2.0 };
    fw_obj3d_model_matrix(fw_obj3d_at(&r, 2), xz, out);
    const float unitS2T[16] = { 2,0,0,0, 0,2,0,0, 0,0,2,0, 1.25f,1,-2.0f,1 };
    CHECK(mat_eq(out, unitS2T));
    fw_obj3d_model_matrix(fw_obj3d_at(&r, 2), NULL, out);        /* no position: the own transform at the origin */
    CHECK(mat_eq(out, S2T));
    fw_obj3d_model_matrix(fw_obj3d_at(&r, 0), xz, out);          /* a tile object ignores unitXZ */
    CHECK(mat_eq(out, tileId));
}

/* ---- 3D phase M2 item 4: the look fields of a GON model block, the facing mirror ---- */
TEST(new_objects_have_the_default_look_and_facing) {
    Fw3dRegistry r; fw_obj3d_init(&r);
    FakeCharacter a; void *ca = make_character(&a, 1);
    fw_obj3d_add_character(&r, ca, "models/crate.obj", NULL);
    fw_obj3d_add_tile(&r, 1, 1, "models/crate.obj", NULL);
    for (int i = 0; i < 2; i++) {
        const Fw3dObject *o = fw_obj3d_at(&r, i);
        CHECK(o != NULL);
        if (!o) return;
        CHECK_STR(o->texture, "");
        CHECK(o->tint[0] == 1.0f && o->tint[1] == 1.0f && o->tint[2] == 1.0f && o->tint[3] == 1.0f);
        CHECK_EQ(o->palette, -1);
        CHECK_EQ(o->usePalette, -1);
        CHECK_EQ(o->doubleSided, -1);
        CHECK_EQ(o->facing, 1);
        CHECK_EQ(o->fromGon, 0);
    }
}

TEST(set_look_set_facing_mark_gon_by_handle) {
    Fw3dRegistry r; fw_obj3d_init(&r);
    FakeCharacter a; void *ca = make_character(&a, 1);
    int h = fw_obj3d_add_character(&r, ca, "models/crate.obj", NULL);
    const float tint[4] = { 1.0f, 0.5f, 0.25f, 0.75f };
    CHECK_EQ(fw_obj3d_set_look(&r, h, "models/crate.png", tint, 0, 1), 1);
    const Fw3dObject *o = fw_obj3d_at(&r, 0);
    CHECK_STR(o->texture, "models/crate.png");
    CHECK(o->tint[1] == 0.5f && o->tint[3] == 0.75f);
    CHECK_EQ(o->usePalette, 0);
    CHECK_EQ(o->doubleSided, 1);
    CHECK_EQ(fw_obj3d_set_look(&r, h, NULL, NULL, -1, -1), 1);   /* NULLs: back to "" and 1 1 1 1 */
    CHECK_STR(o->texture, "");
    CHECK(o->tint[1] == 1.0f && o->tint[3] == 1.0f);
    CHECK_EQ(fw_obj3d_set_look(&r, h + 99, NULL, NULL, 1, 1), 0);
    CHECK_EQ(fw_obj3d_set_look(&r, h, "bad\\name.png", NULL, 1, 1), 0);   /* refused: nothing changed */
    CHECK_EQ(o->usePalette, -1);
    CHECK_EQ(fw_obj3d_set_facing(&r, h, -7), 1);
    CHECK_EQ(o->facing, -1);
    CHECK_EQ(fw_obj3d_set_facing(&r, h, 0), 1);
    CHECK_EQ(o->facing, 1);
    CHECK_EQ(fw_obj3d_set_facing(&r, 0, -1), 0);
    CHECK_EQ(fw_obj3d_mark_gon(&r, h), 1);
    CHECK_EQ(o->fromGon, 1);
    CHECK_EQ(fw_obj3d_mark_gon(&r, -1), 0);
    /* registering the same Character again keeps the look (a model change from the API does not reset the block) */
    fw_obj3d_set_look(&r, h, "models/t.png", NULL, 1, 0);
    CHECK_EQ(fw_obj3d_add_character(&r, ca, "models/other.obj", NULL), h);
    CHECK_STR(o->texture, "models/t.png");
}

/* 3D phase M3 `face`: the model turns with the unit (Character::Face direction -> face yaw, fw_unit_face.h) instead of
 * mirroring with its sprite: model = T(anchor) x Ry(faceYaw) x transform. The sprite's facing sign alone no longer
 * changes the matrix (a mirror would turn a right-handed model inside out). */
TEST(face_yaw_rotates_about_the_anchor_and_facing_alone_does_not_mirror) {
    Fw3dRegistry r; fw_obj3d_init(&r);
    FakeCharacter a; void *ca = make_character(&a, 1);
    int h = fw_obj3d_add_character(&r, ca, "models/crate.obj", S2T);
    const Fw3dObject *o = fw_obj3d_at(&r, 0);
    CHECK(o->faceYaw == 0.0f);                                   /* new objects: no turn */
    const double xz[2] = { 1.25, -2.0 };
    float out[16];
    fw_obj3d_set_facing(&r, h, -1);
    fw_obj3d_model_matrix(o, xz, out);
    /* T(anchor) x S2T: S2T = scale 2 with its own translation (0, 1, 0) */
    const float plain[16] = { 2,0,0,0, 0,2,0,0, 0,0,2,0, 1.25f,1,-2.0f,1 };
    CHECK(mat_eq(out, plain));
    CHECK_EQ(fw_obj3d_set_face_yaw(&r, h, 270.0), 1);
    CHECK(o->faceYaw == 270.0f);
    fw_obj3d_model_matrix(o, xz, out);
    /* T(anchor) x Ry(270) x S2T: x -> 2*e_z, z -> -2*e_x (the front, world -z, turns to +x = dir (1,0), the back) */
    const float back[16] = { 0,0,2,0, 0,2,0,0, -2,0,0,0, 1.25f,1,-2.0f,1 };
    CHECK(mat_eq(out, back));
    CHECK_EQ(fw_obj3d_set_face_yaw(&r, h, 90.0), 1);
    fw_obj3d_model_matrix(o, xz, out);
    const float left[16] = { 0,0,-2,0, 0,2,0,0, 2,0,0,0, 1.25f,1,-2.0f,1 };
    CHECK(mat_eq(out, left));
    CHECK_EQ(fw_obj3d_set_face_yaw(&r, h + 99, 90.0), 0);       /* unknown handle */
    /* a tile object turns too (the yaw is per object), about its tile centre */
    int t = fw_obj3d_add_tile(&r, 2, 3, "models/crate.obj", NULL);
    CHECK_EQ(fw_obj3d_set_face_yaw(&r, t, 180.0), 1);
    fw_obj3d_model_matrix(fw_obj3d_at(&r, 1), NULL, out);
    const float tile180[16] = { -1,0,0,0, 0,1,0,0, 0,0,-1,0, 2.5f,0,3.5f,1 };
    CHECK(mat_eq(out, tile180));
}

TEST(api_v8_version_and_fwapi_layout) {
    CHECK_EQ(FW_API_VERSION, 8);
    CHECK_EQ(FW_VERSION_MINOR, 6);
    /* v1..v4 = 10 function pointers; v5 Random, SeedRandom; v6 SetTimeScale, GetTimeScale; v7 RegisterCatRig, CatRigFor;
     * v8 appends Register3DObject, Place3DObjectOnTile, Unregister3DObject (merge order of the 2026-10-22 PRs) */
    CHECK_EQ(sizeof(FwApi), 19 * sizeof(void *));
    CHECK_EQ(offsetof(FwApi, ClearUnitGlow), 9 * sizeof(void *));
    CHECK_EQ(offsetof(FwApi, Random), 10 * sizeof(void *));
    CHECK_EQ(offsetof(FwApi, SetTimeScale), 12 * sizeof(void *));
    CHECK_EQ(offsetof(FwApi, RegisterCatRig), 14 * sizeof(void *));
    CHECK_EQ(offsetof(FwApi, Register3DObject), 16 * sizeof(void *));
    CHECK_EQ(offsetof(FwApi, Place3DObjectOnTile), 17 * sizeof(void *));
    CHECK_EQ(offsetof(FwApi, Unregister3DObject), 18 * sizeof(void *));
}

int main(void) { return MT_RUN_ALL(); }
