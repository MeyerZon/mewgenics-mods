/* Host-side tests for the pure status-definition rules (src/fw_status_rules.c): the single table cap,
 * the name/template rules, the name-keyed table lookup, the alias round-trip on an MSVC std::string
 * (SSO and heap-backed, names shorter than the template) and the type-hierarchy rewrite. No windows.h,
 * no game: these are the parts of status_engine.c that never touch game memory. */
#define FW_NO_WINDOWS
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include "../../test/minitest.h"
#include "fw_status_rules.h"

static FwStatusDef def_named(const char *name) {
    FwStatusDef d; memset(&d, 0, sizeof d);
    d.name = name; d.template_name = FW_STATUS_TEMPLATE;
    return d;
}

TEST(status_validate_accepts_a_luckup_def) {
    FwStatusTable t; fw_status_table_init(&t);
    FwStatusDef d = def_named("JokersLuck");
    CHECK_EQ(fw_status_validate(&d, &t), FW_STATUS_OK);
}

TEST(status_validate_rejects_null_def_name_or_template) {
    FwStatusTable t; fw_status_table_init(&t);
    CHECK_EQ(fw_status_validate(NULL, &t), FW_STATUS_ERR_NULL);
    FwStatusDef d = def_named("X"); d.name = NULL;
    CHECK_EQ(fw_status_validate(&d, &t), FW_STATUS_ERR_NULL);
    d = def_named("X"); d.template_name = NULL;
    CHECK_EQ(fw_status_validate(&d, &t), FW_STATUS_ERR_NULL);
}

TEST(status_validate_rejects_empty_name) {
    FwStatusTable t; fw_status_table_init(&t);
    FwStatusDef d = def_named("");
    CHECK_EQ(fw_status_validate(&d, &t), FW_STATUS_ERR_NAME_EMPTY);
}

TEST(status_validate_accepts_15_chars_and_rejects_16) {
    FwStatusTable t; fw_status_table_init(&t);
    FwStatusDef ok = def_named("ABCDEFGHIJKLMNO");      /* 15 = SSO max */
    FwStatusDef bad = def_named("ABCDEFGHIJKLMNOP");    /* 16 */
    CHECK_EQ(fw_status_validate(&ok, &t), FW_STATUS_OK);
    CHECK_EQ(fw_status_validate(&bad, &t), FW_STATUS_ERR_NAME_TOO_LONG);
    CHECK_EQ(FW_STATUS_NAME_MAX, 15);
}

TEST(status_validate_rejects_non_luckup_template) {
    FwStatusTable t; fw_status_table_init(&t);
    FwStatusDef d = def_named("X"); d.template_name = "Poison";
    CHECK_EQ(fw_status_validate(&d, &t), FW_STATUS_ERR_TEMPLATE);
}

TEST(status_validate_rejects_duplicate_name) {
    FwStatusTable t; fw_status_table_init(&t);
    FwStatusDef d = def_named("JokersLuck");
    FwStatusRule why = FW_STATUS_OK;
    CHECK_EQ(fw_status_table_add(&t, &d, &why), 0);
    CHECK_EQ(why, FW_STATUS_OK);
    CHECK_EQ(fw_status_validate(&d, &t), FW_STATUS_ERR_DUPLICATE);
    CHECK_EQ(fw_status_table_add(&t, &d, &why), -1);
    CHECK_EQ(why, FW_STATUS_ERR_DUPLICATE);
    CHECK_EQ(t.count, 1);
}

TEST(status_table_full_at_the_single_shared_cap) {
    FwStatusTable t; fw_status_table_init(&t);
    char names[FW_STATUS_MAX_DEFS + 1][8];
    FwStatusRule why = FW_STATUS_OK;
    for (int i = 0; i < FW_STATUS_MAX_DEFS; i++) {
        names[i][0] = 'S'; names[i][1] = (char)('0' + i); names[i][2] = 0;
        FwStatusDef d = def_named(names[i]);
        CHECK_EQ(fw_status_table_add(&t, &d, &why), i);
    }
    CHECK_EQ(t.count, FW_STATUS_MAX_DEFS);
    FwStatusDef extra = def_named("Extra");
    CHECK_EQ(fw_status_validate(&extra, &t), FW_STATUS_ERR_TABLE_FULL);
    CHECK_EQ(fw_status_table_add(&t, &extra, &why), -1);
    CHECK_EQ(why, FW_STATUS_ERR_TABLE_FULL);
    CHECK_EQ(FW_STATUS_MAX_DEFS, 8);   /* status_engine.c has exactly 8 thunk rows */
}

TEST(status_table_find_matches_exact_length_only) {
    FwStatusTable t; fw_status_table_init(&t);
    FwStatusRule why;
    FwStatusDef a = def_named("JokersLuck"), b = def_named("Jokers");
    CHECK_EQ(fw_status_table_add(&t, &a, &why), 0);
    CHECK_EQ(fw_status_table_add(&t, &b, &why), 1);
    CHECK_EQ(fw_status_table_find(&t, "JokersLuck", 10), 0);
    CHECK_EQ(fw_status_table_find(&t, "Jokers", 6), 1);
    CHECK_EQ(fw_status_table_find(&t, "JokersLuckX", 11), -1);
    CHECK_EQ(fw_status_table_find(&t, "JokersLuck", 9), -1);   /* prefix is not a match */
    CHECK_EQ(fw_status_table_find(&t, "LuckUp", 6), -1);       /* the template itself is not custom */
    CHECK_STR(fw_status_table_name(&t, 0), "JokersLuck");
}

static void sso_string(MsvcString *s, const char *text) {
    memset(s, 0, sizeof *s);
    size_t n = strlen(text);
    memcpy(s->u.buf, text, n); s->u.buf[n] = 0; s->size = n; s->cap = 15;
}

TEST(alias_in_out_round_trips_an_sso_name) {
    FwStatusTable t; fw_status_table_init(&t);
    FwStatusRule why;
    FwStatusDef d = def_named("JokersLuck");
    fw_status_table_add(&t, &d, &why);
    MsvcString s; sso_string(&s, "JokersLuck");
    FwAliasSave sv;
    CHECK_EQ(fw_alias_in(&s, &t, &sv), 1);
    CHECK_STR(msvc_str(&s), FW_STATUS_TEMPLATE);
    CHECK_EQ(s.size, strlen(FW_STATUS_TEMPLATE));
    CHECK_EQ(s.cap, (size_t)15);
    fw_alias_out(&s, &sv);
    CHECK_STR(msvc_str(&s), "JokersLuck");
    CHECK_EQ(s.size, (size_t)10);
}

TEST(alias_in_out_round_trips_a_heap_backed_name) {
    FwStatusTable t; fw_status_table_init(&t);
    FwStatusRule why;
    FwStatusDef d = def_named("JokersLuck");
    fw_status_table_add(&t, &d, &why);
    char *heap = (char *)malloc(32);
    memset(heap, 'Z', 32); memcpy(heap, "JokersLuck", 11);
    MsvcString s; memset(&s, 0, sizeof s);
    s.u.ptr = heap; s.size = 10; s.cap = 31;        /* a reused std::string with a heap buffer */
    FwAliasSave sv;
    CHECK_EQ(fw_alias_in(&s, &t, &sv), 1);
    CHECK_STR(msvc_str(&s), FW_STATUS_TEMPLATE);
    CHECK_EQ(s.cap, (size_t)31);                     /* never reallocates */
    fw_alias_out(&s, &sv);
    CHECK_STR(msvc_str(&s), "JokersLuck");
    CHECK_EQ(s.size, (size_t)10);
    CHECK(s.u.ptr == heap);
    free(heap);
}

TEST(alias_in_out_restores_a_name_shorter_than_the_template) {
    FwStatusTable t; fw_status_table_init(&t);
    FwStatusRule why;
    FwStatusDef d = def_named("Hex");               /* 3 < strlen("LuckUp") */
    fw_status_table_add(&t, &d, &why);
    MsvcString s; sso_string(&s, "Hex");
    FwAliasSave sv;
    CHECK_EQ(fw_alias_in(&s, &t, &sv), 1);
    CHECK_STR(msvc_str(&s), FW_STATUS_TEMPLATE);
    fw_alias_out(&s, &sv);
    CHECK_STR(msvc_str(&s), "Hex");
    CHECK_EQ(s.size, (size_t)3);
}

TEST(alias_in_is_a_noop_for_unknown_names) {
    FwStatusTable t; fw_status_table_init(&t);
    FwStatusRule why;
    FwStatusDef d = def_named("JokersLuck");
    fw_status_table_add(&t, &d, &why);
    MsvcString s; sso_string(&s, "Poison");
    FwAliasSave sv;
    CHECK_EQ(fw_alias_in(&s, &t, &sv), 0);
    CHECK_STR(msvc_str(&s), "Poison");
    fw_alias_out(&s, &sv);                           /* must be safe to call after a no-op */
    CHECK_STR(msvc_str(&s), "Poison");
}

TEST(hier_rewrite_swaps_only_the_template_id) {
    int ids[4] = { 7, 0x4d6, 9, 0x4d6 };
    CHECK_EQ(fw_hier_rewrite(ids, 3, 4, 0x4d6, 0x9001), 1);   /* count 3: the 4th word is beyond the hierarchy */
    CHECK_EQ(ids[0], 7); CHECK_EQ(ids[1], 0x9001); CHECK_EQ(ids[2], 9); CHECK_EQ(ids[3], 0x4d6);
    CHECK_EQ(fw_hier_rewrite(ids, 16, 4, 0x4d6, 0x9001), 1);  /* count beyond cap is clamped to cap */
    CHECK_EQ(ids[3], 0x9001);
    CHECK_EQ(fw_hier_rewrite(ids, 4, 4, 0x4d6, 0x9001), 0);   /* nothing left to swap */
}

TEST(rule_text_names_every_rule) {
    CHECK_STR(fw_status_rule_text(FW_STATUS_OK), "ok");
    CHECK(strstr(fw_status_rule_text(FW_STATUS_ERR_TABLE_FULL), "table full") != NULL);
    CHECK(strstr(fw_status_rule_text(FW_STATUS_ERR_TEMPLATE), "LuckUp") != NULL);
    CHECK(strstr(fw_status_rule_text(FW_STATUS_ERR_NAME_TOO_LONG), "15") != NULL);
    CHECK(strstr(fw_status_rule_text(FW_STATUS_ERR_DUPLICATE), "already") != NULL);
    CHECK(strstr(fw_status_rule_text(FW_STATUS_ERR_NAME_EMPTY), "empty") != NULL);
    CHECK(strstr(fw_status_rule_text(FW_STATUS_ERR_NULL), "NULL") != NULL);
    CHECK(strstr(fw_status_rule_text((FwStatusRule)99), "unknown") != NULL);
}

int main(void) { return MT_RUN_ALL(); }
