/* Host-side tests for the pure vtable work of a custom status (src/fw_vtable.c): cloning a template vtable into
 * caller-supplied memory with slots 0-3 patched, the per-definition thunk bodies (GetTypeName / GetTypeId / IsA /
 * GetTypeHierarchy) over a fake template vtable, the hierarchy copy + rewrite and the MSVC std::string helpers.
 * No windows.h, no game: the only game-derived input is the git-ignored dump `.analysis/luckup-vtable.hex`, used
 * as a T1 fixture when present (skipped with a logged reason otherwise). */
#define FW_NO_WINDOWS
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../../test/minitest.h"
#include "fw_vtable.h"

/* ---- fakes ---- */
static int g_deallocCalls = 0;
static MsvcString *g_deallocLast = NULL;
static void fake_dealloc(MsvcString *s) { g_deallocCalls++; g_deallocLast = s; }

static int g_templateIsACalls = 0;
static void *g_templateIsASelf = NULL;
static int fake_template_is_a(void *self, MsvcString *name) { (void)name; g_templateIsACalls++; g_templateIsASelf = self; return 7; }

static void sso(MsvcString *s, const char *text) {
    memset(s, 0, sizeof *s);
    size_t n = strlen(text);
    memcpy(s->u.buf, text, n); s->u.buf[n] = 0; s->size = n; s->cap = 15;
}

/* a template vtable whose slot i is the distinct fake pointer 0x1000 + 8*i (slot VT_ISA is a real fake IsA) */
static void *g_template[VT_SLOTS];
static void fill_template(void) {
    for (size_t i = 0; i < VT_SLOTS; i++) g_template[i] = (void *)(uintptr_t)(0x1000 + 8 * i);
    g_template[VT_ISA] = (void *)fake_template_is_a;
}

static void *const THUNKS[FW_VTABLE_PATCHED_SLOTS] = { (void *)0xA0, (void *)0xA1, (void *)0xA2, (void *)0xA3 };

TEST(clone_copies_every_slot_and_patches_the_first_four) {
    fill_template();
    void *dst[VT_SLOTS];
    memset(dst, 0xEE, sizeof dst);
    CHECK_EQ(fw_vtable_clone(dst, g_template, VT_SLOTS, THUNKS), VT_SLOTS);
    CHECK(dst[VT_GETTYPENAME] == THUNKS[0]);
    CHECK(dst[VT_GETTYPEID] == THUNKS[1]);
    CHECK(dst[VT_ISA] == THUNKS[2]);
    CHECK(dst[VT_GETTYPEHIERARCHY] == THUNKS[3]);
    for (size_t i = FW_VTABLE_PATCHED_SLOTS; i < VT_SLOTS; i++) CHECK(dst[i] == g_template[i]);
    CHECK(dst[VT_ONSTACKSCHANGED] == g_template[VT_ONSTACKSCHANGED]);   /* the slot the engine calls on merge */
    CHECK_EQ(FW_VTABLE_PATCHED_SLOTS, 4);
    CHECK_EQ(VT_GETTYPEHIERARCHY, 3);                                    /* the patched slots are exactly 0..3 */
}

TEST(clone_leaves_the_template_untouched) {
    fill_template();
    void *before[VT_SLOTS]; memcpy(before, g_template, sizeof before);
    void *dst[VT_SLOTS];
    fw_vtable_clone(dst, g_template, VT_SLOTS, THUNKS);
    CHECK_MEM(g_template, before, sizeof before);
}

TEST(clone_matches_the_golden_bytes) {
    /* a 6-slot template 0x1000,0x1008,...; after the clone: thunks A0..A3 then the template's slots 4 and 5 */
    void *tpl[6];
    for (size_t i = 0; i < 6; i++) tpl[i] = (void *)(uintptr_t)(0x1000 + 8 * i);
    void *dst[6];
    CHECK_EQ(fw_vtable_clone(dst, tpl, 6, THUNKS), 6);
    static const uint8_t golden[48] = {
        0xA0,0,0,0,0,0,0,0,  0xA1,0,0,0,0,0,0,0,  0xA2,0,0,0,0,0,0,0,  0xA3,0,0,0,0,0,0,0,
        0x20,0x10,0,0,0,0,0,0,  0x28,0x10,0,0,0,0,0,0 };
    CHECK_MEM(dst, golden, sizeof golden);
}

TEST(clone_refuses_bad_arguments) {
    fill_template();
    void *dst[VT_SLOTS];
    CHECK_EQ(fw_vtable_clone(NULL, g_template, VT_SLOTS, THUNKS), 0);
    CHECK_EQ(fw_vtable_clone(dst, NULL, VT_SLOTS, THUNKS), 0);
    CHECK_EQ(fw_vtable_clone(dst, g_template, VT_SLOTS, NULL), 0);
    CHECK_EQ(fw_vtable_clone(dst, g_template, FW_VTABLE_PATCHED_SLOTS - 1, THUNKS), 0);   /* too short to patch */
    CHECK_EQ(fw_vtable_clone(dst, g_template, FW_VTABLE_PATCHED_SLOTS, THUNKS), FW_VTABLE_PATCHED_SLOTS);
}

TEST(make_hier_copies_and_swaps_the_template_id) {
    FwTypeHierarchy tpl; memset(&tpl, 0, sizeof tpl);
    tpl.ids[0] = 0x4d6; tpl.ids[1] = 0x1c3; tpl.ids[2] = 0x4d6; tpl.ids[3] = 0x4d6; tpl.count = 3;
    FwTypeHierarchy out; memset(&out, 0x55, sizeof out);
    CHECK_EQ(fw_vtable_make_hier(&out, &tpl, 0x4d6, 0x1000), 2);
    CHECK_EQ(out.count, 3);
    CHECK_EQ(out.ids[0], 0x1000); CHECK_EQ(out.ids[1], 0x1c3); CHECK_EQ(out.ids[2], 0x1000);
    CHECK_EQ(out.ids[3], 0x4d6);                      /* beyond count: copied, not rewritten */
    CHECK_EQ(tpl.ids[0], 0x4d6);                      /* the template's own hierarchy is untouched */
    CHECK_EQ(FW_HIER_WORDS, 16);
    CHECK_EQ(sizeof(FwTypeHierarchy), (size_t)(16 * 4 + 8));   /* {int ids[16]; uint64 count} as slot 3 returns it */
}

TEST(get_type_name_constructs_an_sso_string) {
    FwTypeHierarchy h; memset(&h, 0, sizeof h);
    FwVtableIdentity id = { "JokersLuck", 0x1000, g_template, &h };
    MsvcString out; memset(&out, 0xCC, sizeof out);   /* the out-string is uninitialised memory in the game */
    CHECK(fw_vtable_get_type_name(&id, &out) == &out);
    CHECK_STR(msvc_str(&out), "JokersLuck");
    CHECK_EQ(out.size, (size_t)10);
    CHECK_EQ(out.cap, (size_t)15);
}

TEST(get_type_name_truncates_to_the_sso_buffer) {
    FwVtableIdentity id = { "ABCDEFGHIJKLMNOPQRS", 1, g_template, NULL };
    MsvcString out;
    fw_vtable_get_type_name(&id, &out);
    CHECK_STR(msvc_str(&out), "ABCDEFGHIJKLMNO");
    CHECK_EQ(out.size, (size_t)15);
    CHECK_EQ(out.cap, (size_t)15);
}

TEST(get_type_id_and_hier_answer_from_the_identity) {
    FwTypeHierarchy h; memset(&h, 0, sizeof h); h.count = 2;
    FwVtableIdentity id = { "X", 0x1001, g_template, &h };
    CHECK_EQ(fw_vtable_get_type_id(&id), 0x1001);
    CHECK(fw_vtable_get_hier(&id) == &h);
}

TEST(is_a_answers_the_custom_name_and_destroys_the_string) {
    fill_template();
    FwVtableIdentity id = { "JokersLuck", 0x1000, g_template, NULL };
    MsvcString name; sso(&name, "JokersLuck");
    g_deallocCalls = 0; g_templateIsACalls = 0;
    CHECK_EQ(fw_vtable_is_a(&id, (void *)0x77, &name, fake_dealloc), 1);
    CHECK_EQ(g_deallocCalls, 1);                      /* by-value std::string: the callee destroys it */
    CHECK(g_deallocLast == &name);
    CHECK_EQ(g_templateIsACalls, 0);
}

TEST(is_a_delegates_other_names_to_the_template) {
    fill_template();
    FwVtableIdentity id = { "JokersLuck", 0x1000, g_template, NULL };
    MsvcString name; sso(&name, "LuckUp");
    g_deallocCalls = 0; g_templateIsACalls = 0; g_templateIsASelf = NULL;
    CHECK_EQ(fw_vtable_is_a(&id, (void *)0x77, &name, fake_dealloc), 7);
    CHECK_EQ(g_templateIsACalls, 1);
    CHECK(g_templateIsASelf == (void *)0x77);
    CHECK_EQ(g_deallocCalls, 0);                      /* the template's IsA owns the destruction then */
    MsvcString prefix; sso(&prefix, "Jokers");         /* a prefix is not the name */
    CHECK_EQ(fw_vtable_is_a(&id, NULL, &prefix, fake_dealloc), 7);
    CHECK_EQ(g_templateIsACalls, 2);
}

TEST(msvc_helpers_init_and_compare) {
    MsvcString s; memset(&s, 0xCC, sizeof s);
    fw_msvc_init_sso(&s, "Hex");
    CHECK_STR(msvc_str(&s), "Hex");
    CHECK_EQ(s.size, (size_t)3); CHECK_EQ(s.cap, (size_t)15);
    CHECK_EQ(fw_msvc_eq(&s, "Hex"), 1);
    CHECK_EQ(fw_msvc_eq(&s, "He"), 0);
    CHECK_EQ(fw_msvc_eq(&s, "Hexx"), 0);
    char *heap = (char *)malloc(32); memcpy(heap, "JokersLuckLonger", 17);
    MsvcString h; memset(&h, 0, sizeof h); h.u.ptr = heap; h.size = 16; h.cap = 31;
    CHECK_EQ(fw_msvc_eq(&h, "JokersLuckLonger"), 1);   /* heap-backed strings compare through the pointer */
    CHECK_EQ(fw_msvc_eq(&h, "JokersLuck"), 0);
    free(heap);
}

/* a by-value std::string argument the game destroys: SSO for <= 15 bytes, else the game's allocator with MSVC's
 * capacity rule (len | 15, cap + 1 bytes asked) so _Tidy_deallocate frees it with the matching deallocator */
static int g_allocCalls; static size_t g_allocBytes;
static void *counting_alloc(size_t n) { g_allocCalls++; g_allocBytes = n; return malloc(n); }
static void *failing_alloc(size_t n) { (void)n; return NULL; }
TEST(msvc_init_builds_sso_or_a_heap_string_with_the_games_allocator) {
    MsvcString s; memset(&s, 0xCC, sizeof s);
    g_allocCalls = 0;
    CHECK_EQ(fw_msvc_init(&s, "glow_strength", counting_alloc), 1);   /* 13 bytes: SSO, no allocation */
    CHECK_EQ(g_allocCalls, 0);
    CHECK_STR(msvc_str(&s), "glow_strength"); CHECK_EQ(s.size, (size_t)13); CHECK_EQ(s.cap, (size_t)15);
    CHECK_EQ(fw_msvc_init(&s, "composite_glow.shader", counting_alloc), 1);   /* 21 bytes: heap, cap 31, 32 asked */
    CHECK_EQ(g_allocCalls, 1); CHECK_EQ(g_allocBytes, (size_t)32);
    CHECK_STR(msvc_str(&s), "composite_glow.shader"); CHECK_EQ(s.size, (size_t)21); CHECK_EQ(s.cap, (size_t)31);
    CHECK_EQ(s.u.ptr[21], 0);
    free(s.u.ptr);
    CHECK_EQ(fw_msvc_init(&s, "composite_glow.shader", failing_alloc), 0);   /* no memory: refused, not a dangling SSO */
    CHECK_EQ(fw_msvc_init(&s, "composite_glow.shader", NULL), 0);
    CHECK_EQ(fw_msvc_init(&s, "", counting_alloc), 1);
    CHECK_EQ(s.size, (size_t)0); CHECK_EQ(s.cap, (size_t)15);
}

/* ---- T1: the real LuckUp vtable dump (.analysis/luckup-vtable.hex, git-ignored; 172 little-endian qwords) ---- */
static int load_dump(void *slots[VT_SLOTS]) {
    char path[1024];
    const char *src = __FILE__;
    const char *end = src + strlen(src);
    while (end > src && end[-1] != '/' && end[-1] != '\\') end--;
    snprintf(path, sizeof path, "%.*s../../../.analysis/luckup-vtable.hex", (int)(end - src), src);
    FILE *f = fopen(path, "r");
    if (!f) return 0;
    size_t n = 0; int c, nib = 0; uint64_t v = 0; int digits = 0;
    while ((c = fgetc(f)) != EOF && n < VT_SLOTS) {
        int d = (c >= '0' && c <= '9') ? c - '0' : (c >= 'a' && c <= 'f') ? c - 'a' + 10 : (c >= 'A' && c <= 'F') ? c - 'A' + 10 : -1;
        if (d < 0) continue;
        nib = (nib << 4) | d;
        if (++digits % 2 == 0) { v |= (uint64_t)(nib & 0xFF) << (8 * ((digits / 2) - 1)); nib = 0; }
        if (digits == 16) { slots[n++] = (void *)(uintptr_t)v; v = 0; digits = 0; }
    }
    fclose(f);
    return n == VT_SLOTS ? 1 : -1;
}

TEST(t1_real_luckup_vtable_clones_with_only_the_identity_slots_changed) {
    void *real[VT_SLOTS];
    int r = load_dump(real);
    if (r == 0) { printf("      (skipped: .analysis/luckup-vtable.hex absent)\n"); return; }
    CHECK_EQ(r, 1);                                                /* the dump holds exactly VT_SLOTS qwords */
    CHECK_EQ((uintptr_t)real[VT_GETTYPENAME], (uintptr_t)0x140566ed0u);   /* LuckUp_GetTypeName_0x566ed0.c */
    CHECK_EQ((uintptr_t)real[VT_GETTYPEID], (uintptr_t)0x140566ec0u);     /* LuckUp_GetTypeId_0x566ec0.c */
    CHECK(real[VT_ONSTACKSCHANGED] != real[VT_GETTYPENAME]);
    void *dst[VT_SLOTS];
    CHECK_EQ(fw_vtable_clone(dst, real, VT_SLOTS, THUNKS), VT_SLOTS);
    for (size_t i = 0; i < FW_VTABLE_PATCHED_SLOTS; i++) CHECK(dst[i] == THUNKS[i]);
    CHECK_MEM(dst + FW_VTABLE_PATCHED_SLOTS, real + FW_VTABLE_PATCHED_SLOTS, (VT_SLOTS - FW_VTABLE_PATCHED_SLOTS) * sizeof(void *));
}

/* ---- the glow status (data seam): LuckUp's vtable with the identity slots AND ApplyStatModifiers replaced ---- */
#ifdef VT_APPLYSTATMODIFIERS
static void *const NO_LUCK = (void *)0xD00D;
#endif

TEST(glow_clone_also_replaces_apply_stat_modifiers_the_slot_the_manifest_names) {
#ifdef VT_APPLYSTATMODIFIERS
    CHECK_EQ(VT_APPLYSTATMODIFIERS, 82);                          /* bindings/25143593.json VT_ApplyStatModifiers */
    void *tmpl[VT_SLOTS], *dst[VT_SLOTS];
    for (size_t i = 0; i < VT_SLOTS; i++) tmpl[i] = (void *)(uintptr_t)(0x1000 + i);
    CHECK_EQ(fw_vtable_clone_glow(dst, tmpl, VT_SLOTS, THUNKS, NO_LUCK), VT_SLOTS);
    for (size_t i = 0; i < VT_SLOTS; i++) {
        void *want = i < FW_VTABLE_PATCHED_SLOTS ? THUNKS[i] : i == VT_APPLYSTATMODIFIERS ? NO_LUCK : tmpl[i];
        if (dst[i] != want) { CHECK(dst[i] == want); printf("      slot %zu\n", i); break; }
    }
    CHECK_EQ(fw_vtable_clone_glow(dst, tmpl, VT_APPLYSTATMODIFIERS, THUNKS, NO_LUCK), 0);   /* too few slots for the override */
    CHECK_EQ(fw_vtable_clone_glow(dst, tmpl, VT_SLOTS, THUNKS, NULL), 0);
#else
    CHECK(!"VT_APPLYSTATMODIFIERS is missing from the generated offsets.h");
#endif
}

TEST(t1_real_luckup_apply_stat_modifiers_slot_is_the_luck_adder_not_the_shared_stub) {
#ifdef VT_APPLYSTATMODIFIERS
    void *real[VT_SLOTS];
    int r = load_dump(real);
    if (r == 0) { printf("      (skipped: .analysis/luckup-vtable.hex absent)\n"); return; }
    /* 0x1408a8f80: mov rdx,[rcx+0x38]; mov eax,[rcx+0x5c]; add [rdx+0x5d4],eax; cmp dword [rcx+0x5c],0; je Status_Remove; ret
     * (objdump of the saved exe, docs/engine-map.md "Status effects"); slot 33 & co. are the shared `ret 0` stub 0x140035bd0 */
    CHECK_EQ((uintptr_t)real[VT_APPLYSTATMODIFIERS], (uintptr_t)0x1408a8f80u);
    CHECK((uintptr_t)real[VT_APPLYSTATMODIFIERS + 1] == (uintptr_t)0x140035bd0u);
#else
    CHECK(!"VT_APPLYSTATMODIFIERS is missing from the generated offsets.h");
#endif
}

int main(void) { return MT_RUN_ALL(); }
