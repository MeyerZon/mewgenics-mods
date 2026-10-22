/* Host-side tests for catrig_sample.dll's pure part (src/catrig_sample_rules.c): the pairs it registers, the checks
 * a pair passes before it reaches FW_RegisterCatRig, and the bind loop (register, read back with FW_CatRigFor, log).
 * The framework is a fake built on the framework's own rules (fw_catrig_rules.c: first registration wins, the same
 * pair is idempotent, _Champion / _Elite stripped on lookup), so the loop is tested against what the real registry
 * answers. The DllMain wiring (FW_Resolve, IsActive) and the redirect itself are verified in game
 * (the .mewtest scripts in mods/catrig-sample/tests, T2). */
#define FW_NO_WINDOWS
#include <string.h>
#include <stdio.h>
#include "../../../test/minitest.h"
#include "catrig_sample_rules.h"
#include "fw_catrig_rules.h"

static FwCatRigRegistry g_reg;
static int g_regCalls;
static char g_log[16][160];
static int g_logN;
static int fake_reg(const FwCatRigDef *d) {
    g_regCalls++;
    FwCatRigResult r = fw_catrig_add(&g_reg, d->character, d->rig_clip, 0);
    return r == FW_CATRIG_OK || r == FW_CATRIG_SAME;
}
static int refuse_reg(const FwCatRigDef *d) { (void)d; g_regCalls++; return 0; }
static const char *fake_for(const char *c) { const FwCatRig *g = fw_catrig_find(&g_reg, c, strlen(c)); return g ? g->clip : NULL; }
static void fake_log(void *user, const char *line) { (void)user; if (g_logN < 16) snprintf(g_log[g_logN++], sizeof g_log[0], "%s", line); }
static void reset(void) { fw_catrig_init(&g_reg); g_regCalls = 0; g_logN = 0; memset(g_log, 0, sizeof g_log); }

TEST(the_sample_registers_RigSampleCat_with_a_clip_that_is_not_a_data_export) {
    CHECK_EQ(CS_RIG_COUNT, 1);
    CHECK_STR(CS_RIGS[0].character, "RigSampleCat");
    CHECK_STR(CS_RIGS[0].rig_clip, "RigSampleCatClip");
    CHECK(strncmp(CS_RIGS[0].rig_clip, CS_DATA_PREFIX, strlen(CS_DATA_PREFIX)) != 0);   /* only the DLL route binds it */
    CHECK_EQ(cs_check_def(&CS_RIGS[0]), CS_DEF_OK);
}

TEST(check_def_applies_the_framework_limits_and_refuses_a_data_export) {
    FwCatRigDef d = { "RigSampleCat", "RigSampleCatClip" };
    CHECK_EQ(cs_check_def(NULL), CS_DEF_NULL);
    d.character = NULL; CHECK_EQ(cs_check_def(&d), CS_DEF_NULL);
    d.character = "RigSampleCat"; d.rig_clip = NULL; CHECK_EQ(cs_check_def(&d), CS_DEF_NULL);
    d.rig_clip = ""; CHECK_EQ(cs_check_def(&d), CS_DEF_EMPTY);
    d.rig_clip = "X"; d.character = ""; CHECK_EQ(cs_check_def(&d), CS_DEF_EMPTY);
    char e63[64], e64[65], c71[72], c72[73];
    memset(e63, 'a', 63); e63[63] = 0; memset(e64, 'a', 64); e64[64] = 0;
    memset(c71, 'b', 71); c71[71] = 0; memset(c72, 'b', 72); c72[72] = 0;
    d.character = e63; d.rig_clip = c71; CHECK_EQ(cs_check_def(&d), CS_DEF_OK);
    d.character = e64; CHECK_EQ(cs_check_def(&d), CS_DEF_TOO_LONG);
    d.character = e63; d.rig_clip = c72; CHECK_EQ(cs_check_def(&d), CS_DEF_TOO_LONG);
    d.character = "RigSampleCat"; d.rig_clip = "_CatRig_RigSampleCat"; CHECK_EQ(cs_check_def(&d), CS_DEF_DATA_EXPORT);
    d.rig_clip = "_CatRigX"; CHECK_EQ(cs_check_def(&d), CS_DEF_OK);   /* only the exact prefix is the data seam */
    CHECK_EQ(CS_ENTRY_MAX, FW_CATRIG_NAME_MAX);
    CHECK_EQ(CS_CLIP_MAX, FW_CATRIG_CLIP_MAX);
    CHECK(strlen(cs_check_text(CS_DEF_DATA_EXPORT)) > 0);
    CHECK(strlen(cs_check_text((CsDefCheck)99)) > 0);
}

TEST(bind_all_registers_reads_back_and_logs_one_line_per_pair) {
    reset();
    CsBinder b = { fake_reg, fake_for, fake_log, NULL };
    CHECK_EQ(cs_bind_all(&b, CS_RIGS, CS_RIG_COUNT), 1);
    CHECK_EQ(g_regCalls, 1);
    CHECK_STR(fake_for("RigSampleCat"), "RigSampleCatClip");
    CHECK_STR(fake_for("RigSampleCat_Champion"), "RigSampleCatClip");   /* the framework strips the suffix */
    CHECK_STR(fake_for("RigSampleCat_Elite"), "RigSampleCatClip");
    CHECK_EQ(g_logN, 1);
    CHECK_STR(g_log[0], "bound RigSampleCat -> RigSampleCatClip (FW_CatRigFor agrees)");
    /* idempotent: a second bind (the same pair) still reads back */
    g_logN = 0;
    CHECK_EQ(cs_bind_all(&b, CS_RIGS, CS_RIG_COUNT), 1);
    CHECK_STR(g_log[0], "bound RigSampleCat -> RigSampleCatClip (FW_CatRigFor agrees)");
}

TEST(bind_all_skips_a_bad_pair_without_calling_the_framework) {
    reset();
    CsBinder b = { fake_reg, fake_for, fake_log, NULL };
    const FwCatRigDef defs[] = { { "RigSampleCat", "_CatRig_RigSampleCat" }, { "", "Clip" }, { "Other", "OtherClip" } };
    CHECK_EQ(cs_bind_all(&b, defs, 3), 1);
    CHECK_EQ(g_regCalls, 1);
    CHECK_EQ(g_logN, 3);
    CHECK(strncmp(g_log[0], "skipped _CatRig_RigSampleCat for RigSampleCat: ", 47) == 0);
    CHECK(strncmp(g_log[1], "skipped Clip for : ", 19) == 0);
    CHECK_STR(g_log[2], "bound Other -> OtherClip (FW_CatRigFor agrees)");
}

TEST(bind_all_reports_a_refusal_and_a_rig_registered_first_from_data) {
    reset();
    CsBinder r = { refuse_reg, fake_for, fake_log, NULL };
    CHECK_EQ(cs_bind_all(&r, CS_RIGS, CS_RIG_COUNT), 0);
    CHECK_STR(g_log[0], "FW_RegisterCatRig refused RigSampleCatClip for RigSampleCat");
    /* a data export registered first for the same entry: the framework refuses ours (first registration wins) */
    reset();
    CHECK_EQ(fw_catrig_add(&g_reg, "RigSampleCat", "_CatRig_RigSampleCat", 1), FW_CATRIG_OK);
    CsBinder b = { fake_reg, fake_for, fake_log, NULL };
    CHECK_EQ(cs_bind_all(&b, CS_RIGS, CS_RIG_COUNT), 0);
    CHECK_STR(g_log[0], "FW_RegisterCatRig refused RigSampleCatClip for RigSampleCat");
}

static const char *wrong_for(const char *c) { (void)c; return "SomethingElse"; }
static const char *null_for(const char *c) { (void)c; return NULL; }
TEST(bind_all_does_not_count_a_pair_the_read_back_disagrees_with) {
    reset();
    CsBinder b = { fake_reg, wrong_for, fake_log, NULL };
    CHECK_EQ(cs_bind_all(&b, CS_RIGS, CS_RIG_COUNT), 0);
    CHECK_STR(g_log[0], "FW_CatRigFor(RigSampleCat) = SomethingElse after registering RigSampleCatClip");
    reset();
    CsBinder n = { fake_reg, null_for, fake_log, NULL };
    CHECK_EQ(cs_bind_all(&n, CS_RIGS, CS_RIG_COUNT), 0);
    CHECK_STR(g_log[0], "FW_CatRigFor(RigSampleCat) = (null) after registering RigSampleCatClip");
}

TEST(bind_all_with_no_binder_or_functions_does_nothing) {
    reset();
    CHECK_EQ(cs_bind_all(NULL, CS_RIGS, CS_RIG_COUNT), 0);
    CsBinder b = { NULL, fake_for, fake_log, NULL };
    CHECK_EQ(cs_bind_all(&b, CS_RIGS, CS_RIG_COUNT), 0);
    CsBinder c = { fake_reg, NULL, fake_log, NULL };
    CHECK_EQ(cs_bind_all(&c, CS_RIGS, CS_RIG_COUNT), 0);
    CHECK_EQ(g_regCalls, 0);
    CHECK_EQ(g_logN, 0);
    CsBinder quiet = { fake_reg, fake_for, NULL, NULL };   /* no logger is fine */
    CHECK_EQ(cs_bind_all(&quiet, CS_RIGS, CS_RIG_COUNT), 1);
}

int main(void) { return MT_RUN_ALL(); }
