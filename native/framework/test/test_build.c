/* Host-side tests for the build gate (src/fw_build.c) and the GENERATED per-build tables
 * (src/signatures.h, src/offsets.h from bindings/<build>.json). No windows.h, no game:
 * framework_api.h is included with FW_NO_WINDOWS so the FW_Resolve helper is left out. */
#define FW_NO_WINDOWS
#include <stdint.h>
#include <stddef.h>
#include "../../test/minitest.h"
#include "fw_sig.h"
#include "fw_build.h"
#include "offsets.h"

TEST(identify_known_build_returns_its_index) {
    CHECK_EQ(fw_identify_build(0x6a9c51e5u, 0x01574000u, FW_BUILDS, FW_BUILD_COUNT), 0);
}

TEST(identify_rejects_timestamp_mismatch) {
    CHECK_EQ(fw_identify_build(0x6a9c51e6u, 0x01574000u, FW_BUILDS, FW_BUILD_COUNT), -1);
}

TEST(identify_rejects_size_mismatch) {
    CHECK_EQ(fw_identify_build(0x6a9c51e5u, 0x01574001u, FW_BUILDS, FW_BUILD_COUNT), -1);
}

TEST(identify_empty_table_is_unknown) {
    CHECK_EQ(fw_identify_build(0x6a9c51e5u, 0x01574000u, FW_BUILDS, 0), -1);
}

TEST(generated_tables_are_internally_consistent) {
    CHECK(FW_BUILD_COUNT >= 1);
    for (size_t b = 0; b < FW_BUILD_COUNT; b++) {
        const BuildInfo *bi = &FW_BUILDS[b];
        CHECK(bi->name != NULL);
        CHECK(bi->symbols != NULL);
        CHECK(bi->lkRvas != NULL);
        for (size_t i = 0; i < FW_SYMBOL_COUNT_; i++) {
            uint8_t bytes[FW_SIG_MAX_BYTES], mask[FW_SIG_MAX_BYTES];
            const SymbolSig *s = &bi->symbols[i];
            CHECK(s->name != NULL);
            CHECK(s->expectedRva != 0);
            if (!s->pattern) continue;   /* signature: null in the manifest -> the DLL takes expectedRva on the identified build */
            int n = fw_parse_pattern(s->pattern, bytes, mask, sizeof bytes);
            if (n <= 0) MT_FAIL("symbol %s: pattern does not parse under FW_SIG_MAX_BYTES (%d)", s->name, n);
            else if (!mask[n - 1]) MT_FAIL("symbol %s: pattern ends in a wildcard", s->name);
        }
        for (size_t i = 0; i < FW_LK_COUNT; i++) CHECK(bi->lkRvas[i] != 0);
        for (size_t i = 0; i < FW_DATA_COUNT_; i++) CHECK(bi->rva_data[i] != 0);
        CHECK(bi->rva_LuckUp_vftable != 0);
        CHECK(bi->rva_Status_vftable != 0);
        CHECK(bi->rva_DefaultStatusSource != 0);
        CHECK(bi->luckUpTypeId != 0);
        CHECK(bi->rva_TacticsTest_vftable != 0);   /* v4 glow: the combat driver whose slot 19 the glow engine hooks */
    }
}

TEST(build_25143593_values_match_the_manifest) {
    const BuildInfo *b = &FW_BUILDS[0];
    CHECK_STR(b->name, "1.1.21239 (steam 25143593)");
    CHECK_EQ(b->symbols[FW_SYM_TurnControl_NextTurn].expectedRva, 0x8e3c60);
    CHECK_STR(b->symbols[FW_SYM_string_Allocate].name, "string_Allocate");
    /* 2026-10-21: no relocation-free unique window exists for these (notes-bind); raw RVA + anchors instead */
    CHECK(b->symbols[FW_SYM_LuckUp_ctor].pattern == NULL);
    CHECK_EQ(b->symbols[FW_SYM_LuckUp_ctor].expectedRva, 0x711c90);
    CHECK(b->symbols[FW_SYM_Status_GetCategory].pattern == NULL);
    CHECK_EQ(b->symbols[FW_SYM_Status_GetCategory].expectedRva, 0x4929c0);
    CHECK(b->symbols[FW_SYM_SaveProps_GetOrCreate].pattern != NULL);
    CHECK_EQ(b->lkRvas[0], 0x4929c0);
    CHECK_EQ(b->lkRvas[4], 0x493190);
    CHECK_EQ(b->lkRvas[12], 0x502b40);
    CHECK_EQ(b->luckUpTypeId, 0x4d6);
    CHECK_EQ(b->rva_LuckUp_vftable, 0xf57ab8);
    CHECK_EQ(b->rva_DefaultStatusSource, 0x13c4d30);
    CHECK_EQ(b->rva_data[FW_DATA_App], 0x13c4a30);
    CHECK_EQ(b->rva_data[FW_DATA_SDL_HideWindow], 0x12e82a0);
    CHECK_EQ(b->rva_data[FW_DATA_MewDirector], 0x13dac30);   /* v4: the live MewDirector* (dev scenes need one) */
    CHECK_EQ(FW_SYMBOLS_25143593[FW_SYM_AddComponent_TacticsTest].expectedRva, 0x31c3e0u);
    CHECK_EQ(FW_SYMBOLS_25143593[FW_SYM_SceneManager_CreateScene].expectedRva, 0x9d4950u);
    CHECK_EQ(FW_SYMBOLS_25143593[FW_SYM_Scene_CreateEntity].expectedRva, 0x96b3e0u);
    CHECK_EQ(OFF_COMPONENT_SCENEMANAGER, 0x28);
    CHECK_EQ(OFF_SCENE_DESTROYED, 0x4b0);
    CHECK_EQ(OFF_SCENEMANAGER_MAINSCENE, 0x18);
    CHECK_EQ(OFF_TLS_RNG_STATE, 0x178);
    CHECK_EQ(FW_SYMBOLS_25143593[FW_SYM_Rng_SeedState].expectedRva, 0x94ee40u);
    CHECK_EQ(FW_SYMBOLS_25143593[FW_SYM_MewDirector_start].expectedRva, 0x3aefd0u);
    CHECK_EQ(FW_SYMBOLS_25143593[FW_SYM_SaveProps_GetOrCreate].expectedRva, 0x61ea0u);
    CHECK_EQ(FW_SYMBOLS_25143593[FW_SYM_AddComponent_MewDirector_test].expectedRva, 0x758650u);
    CHECK_EQ(FW_LK_COUNT, 13);
    CHECK_EQ(OFF_STATUS_STACKS, 0x5c);
    CHECK_EQ(OFF_CH_ENTITY, 0x18);
    CHECK_EQ(OFF_X_CHARARRAY, 0x1f90);
    CHECK_EQ(OFF_APPLIER_OWNER, -8);
    CHECK_EQ(VT_SLOTS, 172);
    CHECK_EQ(VT_ONSTACKSCHANGED, 170);
    /* per-unit glow bindings (2026-10-22): the combat outline mask the glow engine rides (docs/engine-map.md "Per-unit glow") */
    CHECK_EQ(FW_SYMBOLS_25143593[FW_SYM_TacticsTest_LateRender].expectedRva, 0x88d780u);
    CHECK_EQ(FW_SYMBOLS_25143593[FW_SYM_vec_u32_AddUnique].expectedRva, 0x72cd0u);
    CHECK_EQ(FW_SYMBOLS_25143593[FW_SYM_ShaderManager_GetOrCreateMaterial].expectedRva, 0x9bb5d0u);
    CHECK_EQ(FW_SYMBOLS_25143593[FW_SYM_Material_SetUniformVec4].expectedRva, 0x9bde70u);
    CHECK_EQ(FW_SYMBOLS_25143593[FW_SYM_Material_SetUniformFloat].expectedRva, 0x9bddc0u);
    CHECK_EQ(FW_SYMBOLS_25143593[FW_SYM_Material_SetTexture].expectedRva, 0x9bdcd0u);
    CHECK_EQ(FW_SYMBOLS_25143593[FW_SYM_Camera_AddPostProcessPass].expectedRva, 0x979880u);
    CHECK_EQ(b->rva_data[FW_DATA_ShaderManager], 0x13c4a30);   /* the App global: the material map lives at +0x278 of it */
    CHECK_EQ(b->rva_TacticsTest_vftable, 0xf0f4b8);
    CHECK_EQ(OFF_TT_MASK_CAMERA, 0x58); CHECK_EQ(OFF_TT_MAIN_CAMERA, 0x68); CHECK_EQ(OFF_TT_BLUR_PASS, 0x90); CHECK_EQ(OFF_TT_COMPOSITE_PASS, 0x98);
    CHECK_EQ(OFF_CAM_RTT_TEXTURE, 0x50); CHECK_EQ(OFF_CAM_PASSES, 0xb0);
    CHECK_EQ(OFF_CH_RENDERER, 0x40); CHECK_EQ(OFF_CH_GENERATION, -8);
    CHECK_EQ(OFF_RND_EXTRA_LAYERS, 0x68); CHECK_EQ(OFF_RND_EXTRA_COUNT, 0x6c); CHECK_EQ(OFF_RND_EXTRA_DATA, 0x70);
    CHECK_EQ(OFF_PASS_MAT_COUNT, 0x4); CHECK_EQ(OFF_PASS_MATERIALS, 0x8); CHECK_EQ(OFF_PASS_ENABLED, 0x10);
    CHECK_EQ(OFF_PASS_RECT_A, 0x18); CHECK_EQ(OFF_PASS_RECT_B, 0x38); CHECK_EQ(OFF_PASS_FLAGS, 0x58);
    CHECK_EQ(CONST_MASK_LAYER, 0x18); CHECK_EQ(CONST_COMPOSITE_LAYER, 0x1a); CHECK_EQ(CONST_GLOW_FRAMEBUF_SLOT, 6);
    CHECK_EQ(VT_TT_LATERENDER, 19);
    /* GON at runtime (2026-10-22): the harness's hp / stats fields and its GonObject walker read these */
    CHECK_EQ(OFF_CH_HP, 0x4b0);
    CHECK_EQ(OFF_CH_SHIELD, 0x4b4);
    CHECK_EQ(OFF_CH_DIVINE_SHIELD, 0x4b8);
    CHECK_EQ(OFF_CH_STATS, 0x5a0);
    CHECK_EQ(OFF_CH_BASE_HEALTH, 0x5e8);
    CHECK_EQ(OFF_CH_GON_ENTRY, 0x240);
    CHECK_EQ(OFF_CH_NAME_KEY, 0x248);
    CHECK_EQ(OFF_GON_CHILDREN, 0x38);
    CHECK_EQ(OFF_GON_CHILDREN_END, 0x40);
    CHECK_EQ(OFF_GON_INT, 0x50);
    CHECK_EQ(OFF_GON_DOUBLE, 0x58);
    CHECK_EQ(OFF_GON_BOOL, 0x60);
    CHECK_EQ(OFF_GON_TEXT, 0x68);
    CHECK_EQ(OFF_GON_NAME, 0x88);
    CHECK_EQ(OFF_GON_TYPE, 0xa8);
    CHECK_EQ(GON_NODE_SIZE, 0xb0);
    /* effective stats (2026-10-22): what Character::recompute_stats (0x102520) writes — the harness's effective block */
#if defined(OFF_CH_STATS_EFF) && defined(OFF_CH_MAX_HP)
    CHECK_EQ(OFF_CH_STATS_EFF, 0x5bc);
    CHECK_EQ(OFF_CH_MAX_HP, 0x4bc);
#else
    CHECK(0 && "OFF_CH_STATS_EFF / OFF_CH_MAX_HP are not generated yet");
#endif
}

int main(void) { return MT_RUN_ALL(); }
