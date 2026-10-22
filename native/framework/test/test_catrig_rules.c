/* Host-side tests for the pure rules of the cat rig redirect (src/fw_catrig_rules.c, API v5): the registry
 * {character entry -> rig clip} (cap FW_CATRIG_MAX, names <= FW_CATRIG_NAME_MAX bytes, one rig per character,
 * re-registering the same pair is idempotent), the lookup Character::init makes with the entry name (exact, then
 * the game's _Champion / _Elite suffixes stripped), the `_CatRig_<Entry>` export-name parser, the "is this the
 * vanilla cat clip" test the by-name lookup hook makes, and the scan of one SWF file's SymbolClass std::list
 * (file + OFF_SWF_SYMBOL_LIST; node + OFF_SYMNODE_NAME = std::string, the int id OFF_SYMNODE_ID_FROM_NAME after it)
 * that process_animation_merges walks. The fakes are byte buffers shaped by the GENERATED offsets.h macros only;
 * no windows.h, no game. The hooks themselves (catrig_engine.c) are verified in-game (T2, render-rig.mewtest). */
#define FW_NO_WINDOWS
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdlib.h>
#include "../../test/minitest.h"
#include "fw_catrig_rules.h"

/* ---- registry ---- */
TEST(add_then_find_by_exact_entry_name) {
    FwCatRigRegistry r; fw_catrig_init(&r);
    CHECK_EQ(fw_catrig_add(&r, "ArtProbeRigCat", "_CatRig_ArtProbeRigCat", 1), FW_CATRIG_OK);
    CHECK_EQ(r.count, 1);
    const FwCatRig *g = fw_catrig_find(&r, "ArtProbeRigCat", strlen("ArtProbeRigCat"));
    CHECK(g != NULL);
    CHECK_STR(g->character, "ArtProbeRigCat");
    CHECK_STR(g->clip, "_CatRig_ArtProbeRigCat");
    CHECK_EQ(g->fromData, 1);
    CHECK(fw_catrig_find(&r, "ArtProbeVanillaCat", strlen("ArtProbeVanillaCat")) == NULL);
    CHECK(fw_catrig_find(&r, "ArtProbeRigCa", 13) == NULL);            /* a prefix is not the entry */
    CHECK(fw_catrig_find(&r, "ArtProbeRigCatX", 15) == NULL);
    CHECK(fw_catrig_find(&r, NULL, 0) == NULL);
}

TEST(find_uses_the_length_not_a_terminator) {
    FwCatRigRegistry r; fw_catrig_init(&r);
    CHECK_EQ(fw_catrig_add(&r, "Rat", "_CatRig_Rat", 0), FW_CATRIG_OK);
    const char buf[] = { 'R', 'a', 't', 'X', 'Y' };   /* not NUL-terminated: std::string data + size */
    CHECK(fw_catrig_find(&r, buf, 3) != NULL);
    CHECK(fw_catrig_find(&r, buf, 4) == NULL);
}

TEST(find_strips_the_champion_and_elite_suffixes_the_game_appends) {
    FwCatRigRegistry r; fw_catrig_init(&r);
    CHECK_EQ(fw_catrig_add(&r, "TomTom", "_CatRig_TomTom", 1), FW_CATRIG_OK);
    CHECK(fw_catrig_find(&r, "TomTom_Champion", 15) != NULL);
    CHECK(fw_catrig_find(&r, "TomTom_Elite", 12) != NULL);
    CHECK(fw_catrig_find(&r, "TomTom_Boss", 11) == NULL);
    /* an exact registration of the suffixed name wins over the stripped one */
    CHECK_EQ(fw_catrig_add(&r, "TomTom_Champion", "MyChampionRig", 0), FW_CATRIG_OK);
    CHECK_STR(fw_catrig_find(&r, "TomTom_Champion", 15)->clip, "MyChampionRig");
    CHECK_STR(fw_catrig_find(&r, "TomTom_Elite", 12)->clip, "_CatRig_TomTom");
}

TEST(same_pair_twice_is_idempotent_another_clip_is_a_duplicate) {
    FwCatRigRegistry r; fw_catrig_init(&r);
    CHECK_EQ(fw_catrig_add(&r, "A", "_CatRig_A", 1), FW_CATRIG_OK);
    CHECK_EQ(fw_catrig_add(&r, "A", "_CatRig_A", 1), FW_CATRIG_SAME);
    CHECK_EQ(fw_catrig_add(&r, "A", "OtherRig", 0), FW_CATRIG_ERR_DUPLICATE);
    CHECK_EQ(r.count, 1);
    CHECK_STR(fw_catrig_find(&r, "A", 1)->clip, "_CatRig_A");   /* the first registration stays */
}

TEST(names_are_bounded_and_non_empty) {
    FwCatRigRegistry r; fw_catrig_init(&r);
    char n63[64], n64[65];
    memset(n63, 'a', 63); n63[63] = 0;
    memset(n64, 'b', 64); n64[64] = 0;
    CHECK_EQ(FW_CATRIG_NAME_MAX, 63);
    CHECK_EQ(fw_catrig_add(&r, n63, n63, 0), FW_CATRIG_OK);
    CHECK_EQ(fw_catrig_add(&r, n64, "Rig", 0), FW_CATRIG_ERR_TOO_LONG);
    char n72[73]; memset(n72, 'c', 72); n72[72] = 0;
    CHECK_EQ(FW_CATRIG_CLIP_MAX, 71);   /* _CatRig_ + a 63-byte entry */
    CHECK_EQ(fw_catrig_add(&r, "B", n72, 0), FW_CATRIG_ERR_TOO_LONG);
    CHECK_EQ(fw_catrig_add(&r, "", "Rig", 0), FW_CATRIG_ERR_EMPTY);
    CHECK_EQ(fw_catrig_add(&r, "C", "", 0), FW_CATRIG_ERR_EMPTY);
    CHECK_EQ(fw_catrig_add(&r, NULL, "Rig", 0), FW_CATRIG_ERR_NULL);
    CHECK_EQ(fw_catrig_add(&r, "D", NULL, 0), FW_CATRIG_ERR_NULL);
    CHECK_EQ(fw_catrig_add(NULL, "E", "Rig", 0), FW_CATRIG_ERR_NULL);
    CHECK_EQ(r.count, 1);
}

TEST(the_registry_holds_sixteen_rigs) {
    FwCatRigRegistry r; fw_catrig_init(&r);
    CHECK_EQ(FW_CATRIG_MAX, 16);
    char name[16];
    for (int i = 0; i < FW_CATRIG_MAX; i++) { snprintf(name, sizeof name, "Cat%d", i); CHECK_EQ(fw_catrig_add(&r, name, "Rig", 0), FW_CATRIG_OK); }
    CHECK_EQ(fw_catrig_add(&r, "OneTooMany", "Rig", 0), FW_CATRIG_ERR_FULL);
    CHECK_EQ(fw_catrig_add(&r, "Cat3", "Rig", 0), FW_CATRIG_SAME);   /* a full registry still answers re-registrations */
    CHECK_EQ(r.count, FW_CATRIG_MAX);
    CHECK(fw_catrig_find(&r, "Cat15", 5) != NULL);
}

TEST(every_result_has_a_text) {
    for (int c = FW_CATRIG_OK; c <= FW_CATRIG_ERR_NOT_RIG_EXPORT; c++) {
        const char *t = fw_catrig_result_text((FwCatRigResult)c);
        CHECK(t != NULL && t[0] != 0);
    }
    CHECK(fw_catrig_result_text((FwCatRigResult)99) != NULL);
}

/* ---- export names ---- */
TEST(parse_export_takes_the_entry_after_the_prefix) {
    char out[FW_CATRIG_NAME_MAX + 1];
    CHECK_STR(FW_CATRIG_EXPORT_PREFIX, "_CatRig_");
    CHECK_EQ(fw_catrig_parse_export("_CatRig_ArtProbeRigCat", 22, out), FW_CATRIG_OK);
    CHECK_STR(out, "ArtProbeRigCat");
    CHECK_EQ(fw_catrig_parse_export("_CatRig_X", 9, out), FW_CATRIG_OK);
    CHECK_STR(out, "X");
    CHECK_EQ(fw_catrig_parse_export("_CatRig_", 8, out), FW_CATRIG_ERR_EMPTY);
    CHECK_EQ(fw_catrig_parse_export("_CatRig", 7, out), FW_CATRIG_ERR_NOT_RIG_EXPORT);
    CHECK_EQ(fw_catrig_parse_export("_catrig_X", 9, out), FW_CATRIG_ERR_NOT_RIG_EXPORT);   /* case-sensitive, like the game's _Append_ */
    CHECK_EQ(fw_catrig_parse_export("_Append_CatTest", 15, out), FW_CATRIG_ERR_NOT_RIG_EXPORT);
    CHECK_EQ(fw_catrig_parse_export("CatTest", 7, out), FW_CATRIG_ERR_NOT_RIG_EXPORT);
    CHECK_EQ(fw_catrig_parse_export(NULL, 0, out), FW_CATRIG_ERR_NULL);
    /* the length bounds the read: "_CatRig_AB" with size 9 is "_CatRig_A" */
    CHECK_EQ(fw_catrig_parse_export("_CatRig_AB", 9, out), FW_CATRIG_OK);
    CHECK_STR(out, "A");
    char longName[8 + 64 + 1];
    memcpy(longName, "_CatRig_", 8); memset(longName + 8, 'z', 64); longName[72] = 0;
    CHECK_EQ(fw_catrig_parse_export(longName, 72, out), FW_CATRIG_ERR_TOO_LONG);
    CHECK_EQ(fw_catrig_parse_export(longName, 71, out), FW_CATRIG_OK);   /* 63 bytes of entry fit */
    CHECK_EQ(strlen(out), 63);
}

/* ---- the vanilla clip test (the by-name lookup hook) ---- */
static void sso(MsvcString *s, const char *t) { memset(s, 0, sizeof *s); size_t n = strlen(t); memcpy(s->u.buf, t, n); s->size = n; s->cap = 15; }

TEST(vanilla_clip_is_exactly_CatTest) {
    MsvcString s;
    CHECK_STR(FW_CATRIG_VANILLA_CLIP, "CatTest");
    sso(&s, "CatTest"); CHECK_EQ(fw_catrig_is_vanilla_clip(&s), 1);
    sso(&s, "CatTest2"); CHECK_EQ(fw_catrig_is_vanilla_clip(&s), 0);
    sso(&s, "catTest"); CHECK_EQ(fw_catrig_is_vanilla_clip(&s), 0);
    sso(&s, "CatTes"); CHECK_EQ(fw_catrig_is_vanilla_clip(&s), 0);
    sso(&s, "TomTomPortrait"); CHECK_EQ(fw_catrig_is_vanilla_clip(&s), 0);   /* the portrait lookups share the function */
    sso(&s, ""); CHECK_EQ(fw_catrig_is_vanilla_clip(&s), 0);
    /* a heap-held "CatTest" (cap > 15) reads through the pointer */
    char heap[32] = "CatTest";
    memset(&s, 0, sizeof s); s.u.ptr = heap; s.size = 7; s.cap = 31;
    CHECK_EQ(fw_catrig_is_vanilla_clip(&s), 1);
    CHECK_EQ(fw_catrig_is_vanilla_clip(NULL), 0);
}

/* ---- the SymbolClass list scan ---- */
#define FAKE_FILE_BYTES 0x100
#define FAKE_NODE_BYTES 0x40
_Static_assert(OFF_SWF_SYMBOL_LIST + 8 <= FAKE_FILE_BYTES, "file fake too small");
_Static_assert(OFF_SYMNODE_NAME + OFF_SYMNODE_ID_FROM_NAME + 4 <= FAKE_NODE_BYTES, "node fake too small");
_Static_assert(OFF_SYMNODE_NAME >= 16, "next/prev come first (MSVC std::list node)");

typedef struct FakeNode { unsigned char b[FAKE_NODE_BYTES]; char heap[96]; } FakeNode;
typedef struct FakeFile { unsigned char file[FAKE_FILE_BYTES]; FakeNode head; FakeNode nodes[8]; int n; } FakeFile;

static void link_nodes(FakeFile *f) {
    unsigned char *prev = f->head.b;
    for (int i = 0; i < f->n; i++) {
        *(void **)(prev + 0) = f->nodes[i].b;          /* next */
        *(void **)(f->nodes[i].b + 8) = prev;          /* prev */
        prev = f->nodes[i].b;
    }
    *(void **)(prev + 0) = f->head.b;                  /* the last node points back at the sentinel */
    *(void **)(f->head.b + 8) = prev;
    *(void **)(f->file + OFF_SWF_SYMBOL_LIST) = f->head.b;
}
static void add_node(FakeFile *f, const char *name, int id) {
    FakeNode *nd = &f->nodes[f->n++];
    memset(nd, 0, sizeof *nd);
    MsvcString *s = (MsvcString *)(nd->b + OFF_SYMNODE_NAME);
    size_t len = strlen(name);
    if (len <= 15) { memcpy(s->u.buf, name, len); s->cap = 15; }
    else { memcpy(nd->heap, name, len); s->u.ptr = nd->heap; s->cap = len | 15; }
    s->size = len;
    *(int *)(nd->b + OFF_SYMNODE_NAME + OFF_SYMNODE_ID_FROM_NAME) = id;
}
static void make_file(FakeFile *f) { memset(f, 0, sizeof *f); }

typedef struct Seen { int n; char exports[8][96]; char chars[8][72]; FwCatRigResult codes[8]; } Seen;
static void on_rig(const char *exportName, const char *character, FwCatRigResult r, void *user) {
    Seen *s = (Seen *)user;
    if (s->n >= 8) return;
    snprintf(s->exports[s->n], sizeof s->exports[0], "%s", exportName);
    snprintf(s->chars[s->n], sizeof s->chars[0], "%s", character ? character : "");
    s->codes[s->n] = r;
    s->n++;
}

TEST(scan_registers_every_named_CatRig_export_of_a_file) {
    static FakeFile f; make_file(&f);
    add_node(&f, "ArtProbe", 3);
    add_node(&f, "_Append_CatTest", 9);
    add_node(&f, "_CatRig_ArtProbeRigCat", 12);   /* 22 bytes: a heap string */
    add_node(&f, "_CatRig_Rat", 13);               /* 11 bytes: SSO */
    add_node(&f, "_CatRig_Zero", 0);               /* id 0 is skipped, like process_animation_merges skips it */
    link_nodes(&f);
    FwCatRigRegistry r; fw_catrig_init(&r);
    Seen seen; memset(&seen, 0, sizeof seen);
    CHECK_EQ(fw_catrig_scan_file(&r, f.file, on_rig, &seen, 1000), 2);
    CHECK_EQ(r.count, 2);
    CHECK_STR(fw_catrig_find(&r, "ArtProbeRigCat", 14)->clip, "_CatRig_ArtProbeRigCat");
    CHECK_EQ(fw_catrig_find(&r, "ArtProbeRigCat", 14)->fromData, 1);
    CHECK_STR(fw_catrig_find(&r, "Rat", 3)->clip, "_CatRig_Rat");
    CHECK(fw_catrig_find(&r, "Zero", 4) == NULL);
    CHECK_EQ(seen.n, 2);   /* only _CatRig_ exports are reported */
    CHECK_STR(seen.exports[0], "_CatRig_ArtProbeRigCat"); CHECK_STR(seen.chars[0], "ArtProbeRigCat"); CHECK_EQ(seen.codes[0], FW_CATRIG_OK);
    CHECK_STR(seen.exports[1], "_CatRig_Rat"); CHECK_EQ(seen.codes[1], FW_CATRIG_OK);
    /* the same file again (a reload): nothing new, each reported as SAME */
    memset(&seen, 0, sizeof seen);
    CHECK_EQ(fw_catrig_scan_file(&r, f.file, on_rig, &seen, 1000), 0);
    CHECK_EQ(seen.n, 2); CHECK_EQ(seen.codes[0], FW_CATRIG_SAME); CHECK_EQ(r.count, 2);
}

TEST(scan_reports_malformed_and_refused_exports_and_registers_nothing_for_them) {
    static FakeFile f; make_file(&f);
    char longName[8 + 64 + 1];
    memcpy(longName, "_CatRig_", 8); memset(longName + 8, 'q', 64); longName[72] = 0;
    add_node(&f, "_CatRig_", 4);
    add_node(&f, longName, 5);
    add_node(&f, "_CatRig_Dup", 6);
    link_nodes(&f);
    FwCatRigRegistry r; fw_catrig_init(&r);
    CHECK_EQ(fw_catrig_add(&r, "Dup", "SomeoneElsesRig", 0), FW_CATRIG_OK);   /* a DLL registered Dup first */
    Seen seen; memset(&seen, 0, sizeof seen);
    CHECK_EQ(fw_catrig_scan_file(&r, f.file, on_rig, &seen, 1000), 0);
    CHECK_EQ(seen.n, 3);
    CHECK_EQ(seen.codes[0], FW_CATRIG_ERR_EMPTY);
    CHECK_EQ(seen.codes[1], FW_CATRIG_ERR_TOO_LONG);
    CHECK_EQ(seen.codes[2], FW_CATRIG_ERR_DUPLICATE);
    CHECK_EQ(r.count, 1);
    CHECK_STR(fw_catrig_find(&r, "Dup", 3)->clip, "SomeoneElsesRig");
}

TEST(scan_survives_an_empty_list_a_null_file_and_a_list_that_never_closes) {
    static FakeFile f; make_file(&f);
    link_nodes(&f);   /* sentinel only */
    FwCatRigRegistry r; fw_catrig_init(&r);
    CHECK_EQ(fw_catrig_scan_file(&r, f.file, NULL, NULL, 1000), 0);
    CHECK_EQ(fw_catrig_scan_file(&r, NULL, NULL, NULL, 1000), 0);
    make_file(&f);    /* no list head at all */
    CHECK_EQ(fw_catrig_scan_file(&r, f.file, NULL, NULL, 1000), 0);
    /* a cycle that skips the sentinel: the node budget ends the walk */
    make_file(&f);
    add_node(&f, "_CatRig_Loop", 1);
    link_nodes(&f);
    *(void **)(f.nodes[0].b + 0) = f.nodes[0].b;   /* next = itself */
    CHECK_EQ(fw_catrig_scan_file(&r, f.file, NULL, NULL, 50), 1);   /* registered once, then SAME until the budget runs out */
    CHECK_EQ(r.count, 1);
}

int main(void) { return MT_RUN_ALL(); }
