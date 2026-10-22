/* Host-side tests for the named-model registry (src/fw_model_names.c, 3D phase M3 "@Name"): data/models.gon read from a
 * fake GonObject tree laid out by the GENERATED offsets.h only (OFF_GON_* / GON_NODE_SIZE), through a guarded fake
 * reader; the model value parse on a node (fw_gon_model_node) and its `given` bits; the entry rules (string / block,
 * no file, an "@" chain, a non-model path, not a model at all), the last duplicate winning, the cap; resolving a unit's
 * "@Name" (string form and block form, the unit's keys over the entry's), the unknown name and the refused entry; the
 * log lines and the once-per-reference gate. No windows.h, no game. */
#define FW_NO_WINDOWS
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdio.h>
#include "../../test/minitest.h"
#include "fw_model_names.h"

#define NN 160
static unsigned char arena[NN * GON_NODE_SIZE];
static char heap[32][96];
static int heapUsed;
static int mem_read(void *u, const void *addr, void *out, size_t n) {
    (void)u;
    const unsigned char *a = (const unsigned char *)addr, *h = (const unsigned char *)heap;
    if (!((a >= arena && a + n <= arena + sizeof arena) || (a >= h && a + n <= h + sizeof heap))) return 0;
    memcpy(out, a, n);
    return 1;
}
static unsigned char *node(int i) { return arena + (size_t)i * GON_NODE_SIZE; }
static void set_str(unsigned char *p, const char *s) {
    size_t len = strlen(s);
    memset(p, 0, 32);
    if (len <= 15) { memcpy(p, s, len); *(size_t *)(p + 16) = len; *(size_t *)(p + 24) = 15; }
    else { char *b = heap[heapUsed++ % 32]; snprintf(b, 96, "%s", s); *(char **)p = b; *(size_t *)(p + 16) = len; *(size_t *)(p + 24) = len < 31 ? 31 : len; }
}
static void str(int i, const char *name, const char *text) {
    unsigned char *n = node(i);
    memset(n, 0, GON_NODE_SIZE);
    *(int *)(n + OFF_GON_TYPE) = FW_GON_TYPE_STRING;
    set_str(n + OFF_GON_NAME, name);
    set_str(n + OFF_GON_TEXT, text);
}
static void num(int i, const char *name, double v) {
    char t[32];
    snprintf(t, sizeof t, "%g", v);
    str(i, name, t);
    *(int *)(node(i) + OFF_GON_TYPE) = FW_GON_TYPE_NUMBER;
    *(double *)(node(i) + OFF_GON_DOUBLE) = v;
}
static void boolean(int i, const char *name, int b) {
    str(i, name, b ? "true" : "false");
    *(int *)(node(i) + OFF_GON_TYPE) = FW_GON_TYPE_BOOL;
    *(node(i) + OFF_GON_BOOL) = (unsigned char)b;
}
static void box(int i, const char *name, int type, int first, int count) {
    unsigned char *n = node(i);
    memset(n, 0, GON_NODE_SIZE);
    *(int *)(n + OFF_GON_TYPE) = type;
    set_str(n + OFF_GON_NAME, name);
    *(unsigned char **)(n + OFF_GON_CHILDREN) = node(first);
    *(unsigned char **)(n + OFF_GON_CHILDREN_END) = node(first + count);
}

/* 0 root { 1 Box {..}  2 Pillar "models/pillar.glb"  3 Chain { file "@Box" }  4 NoFile { scale 1 }  5 Num 5
 *          6 BadPath { file "textures/x.png" }  7 Pillar { file "models/p2.obj" yaw 90 } }
 * Box (10..): file "models/box.gltf"  scale 2  yaw 45  tint [1 0 0]  palette false
 * unit blocks (40..): 40 U1 { file "@Box" scale 3 offset [0 0.5 0] texture "models/u.png" }  45 U2 { file "@Box" } */
static void tree(void) {
    memset(arena, 0, sizeof arena);
    heapUsed = 0;
    box(0, "", FW_GON_TYPE_OBJECT, 1, 7);
    box(1, "Box", FW_GON_TYPE_OBJECT, 10, 5);
    str(2, "Pillar", "models/pillar.glb");
    box(3, "Chain", FW_GON_TYPE_OBJECT, 20, 1);
    box(4, "NoFile", FW_GON_TYPE_OBJECT, 21, 1);
    num(5, "Num", 5);
    box(6, "BadPath", FW_GON_TYPE_OBJECT, 22, 1);
    box(7, "Pillar", FW_GON_TYPE_OBJECT, 23, 2);
    str(10, "file", "models/box.gltf");
    num(11, "scale", 2);
    num(12, "yaw", 45);
    box(13, "tint", FW_GON_TYPE_ARRAY, 30, 3);
    boolean(14, "palette", 0);
    str(20, "file", "@Box");
    num(21, "scale", 1);
    str(22, "file", "textures/x.png");
    str(23, "file", "models/p2.obj");
    num(24, "yaw", 90);
    num(30, "", 1); num(31, "", 0); num(32, "", 0);
    box(40, "model", FW_GON_TYPE_OBJECT, 50, 4);
    str(50, "file", "@Box");
    num(51, "scale", 3);
    box(52, "offset", FW_GON_TYPE_ARRAY, 60, 3);
    str(53, "texture", "models/u.png");
    num(60, "", 0); num(61, "", 0.5); num(62, "", 0);
    box(45, "model", FW_GON_TYPE_OBJECT, 46, 1);
    str(46, "file", "@Box");
}

TEST(model_node_parses_both_forms_and_records_the_given_keys) {
    tree();
    FwGonModel m;
    CHECK_EQ(fw_gon_model_node(mem_read, NULL, node(1), &m), 1);
    CHECK_EQ(m.isBlock, 1);
    CHECK_STR(m.file, "models/box.gltf");
    CHECK(m.scale == 2 && m.yaw == 45 && m.tint[0] == 1 && m.tint[1] == 0 && m.tint[3] == 1 && m.palette == 0);
    CHECK_EQ(m.given, FW_GON_MODEL_HAS_SCALE | FW_GON_MODEL_HAS_YAW | FW_GON_MODEL_HAS_TINT);
    CHECK_EQ(m.invalid, 0);
    CHECK_EQ(fw_gon_model_node(mem_read, NULL, node(2), &m), 1);
    CHECK_EQ(m.isBlock, 0);
    CHECK_STR(m.file, "models/pillar.glb");
    CHECK_EQ(m.given, 0);
    CHECK_EQ(fw_gon_model_node(mem_read, NULL, node(4), &m), 0);     /* a block without file */
    CHECK(m.invalid & FW_GON_MODEL_BAD_FILE);
    CHECK_EQ(fw_gon_model_node(mem_read, NULL, node(5), &m), 0);     /* a number */
    CHECK_EQ(fw_gon_model_node(mem_read, NULL, (const void *)0x10, &m), -1);
    CHECK_EQ(fw_gon_model_node(mem_read, NULL, node(40), &m), 1);    /* a unit block: scale + offset given, texture set */
    CHECK_EQ(m.given, FW_GON_MODEL_HAS_SCALE | FW_GON_MODEL_HAS_OFFSET);
    CHECK_STR(m.texture, "models/u.png");
}

TEST(children_of_a_container_a_scalar_and_an_unreadable_node) {
    tree();
    const void *b = NULL;
    long c = -1;
    CHECK_EQ(fw_gon_children(mem_read, NULL, node(0), &b, &c), 1);
    CHECK_EQ(c, 7);
    CHECK(b == node(1));
    CHECK_EQ(fw_gon_children(mem_read, NULL, node(2), &b, &c), 0);
    CHECK_EQ(c, 0);
    CHECK_EQ(fw_gon_children(mem_read, NULL, (const void *)0x10, &b, &c), -1);
}

TEST(load_reads_every_entry_with_its_verdict_and_the_last_duplicate_wins) {
    tree();
    static FwModelNames r;
    CHECK_EQ(fw_model_names_load(mem_read, NULL, node(0), &r), 6);
    CHECK_EQ(r.loaded, 1);
    CHECK_EQ(r.dropped, 0);
    const FwModelName *e = fw_model_names_find(&r, "Box");
    CHECK(e && e->bad == FW_MODEL_ENTRY_OK && e->m.scale == 2);
    e = fw_model_names_find(&r, "Pillar");
    CHECK(e && e->bad == FW_MODEL_ENTRY_OK);
    if (e) { CHECK_STR(e->m.file, "models/p2.obj"); CHECK(e->m.yaw == 90); }
    e = fw_model_names_find(&r, "Chain");  CHECK(e && e->bad == FW_MODEL_ENTRY_CHAIN);
    e = fw_model_names_find(&r, "NoFile"); CHECK(e && e->bad == FW_MODEL_ENTRY_NO_FILE);
    e = fw_model_names_find(&r, "Num");    CHECK(e && e->bad == FW_MODEL_ENTRY_NOT_MODEL);
    e = fw_model_names_find(&r, "BadPath"); CHECK(e && e->bad == FW_MODEL_ENTRY_PATH);
    CHECK(fw_model_names_find(&r, "Crate") == NULL);
    CHECK(fw_model_names_find(&r, "box") == NULL);   /* GON keys are case-sensitive */
    CHECK(fw_model_names_find(&r, "") == NULL);
    CHECK(fw_model_names_find(NULL, "Box") == NULL);
}

TEST(load_of_an_absent_file_is_an_empty_registry_and_an_unreadable_root_is_minus_one) {
    tree();
    static FwModelNames r;
    CHECK_EQ(fw_model_names_load(mem_read, NULL, NULL, &r), 0);
    CHECK_EQ(r.loaded, 1);
    CHECK_EQ(r.n, 0);
    CHECK_EQ(fw_model_names_load(mem_read, NULL, (const void *)0x10, &r), -1);
    CHECK_EQ(r.loaded, -1);
    fw_model_names_clear(&r);
    CHECK_EQ(r.loaded, 0);
    CHECK_EQ(r.n, 0);
}

TEST(load_keeps_at_most_the_cap_and_counts_the_rest) {
    memset(arena, 0, sizeof arena);
    heapUsed = 0;
    int total = FW_MODEL_NAMES_MAX + 5;
    box(0, "", FW_GON_TYPE_OBJECT, 1, total);
    for (int i = 0; i < total; i++) { char nm[16]; snprintf(nm, sizeof nm, "M%d", i); str(1 + i, nm, "models/m.obj"); }
    static FwModelNames r;
    CHECK_EQ(fw_model_names_load(mem_read, NULL, node(0), &r), FW_MODEL_NAMES_MAX);
    CHECK_EQ(r.dropped, 5);
    CHECK(fw_model_names_find(&r, "M0") != NULL);
    CHECK(fw_model_names_find(&r, "M68") == NULL);
}

TEST(resolve_a_reference_the_unit_keys_override_the_entry) {
    tree();
    static FwModelNames r;
    fw_model_names_load(mem_read, NULL, node(0), &r);
    FwGonModel unit, out;
    const FwModelName *hit = NULL;
    /* not a reference */
    fw_gon_model_node(mem_read, NULL, node(10), &unit);   /* the "file" scalar: a string model value */
    CHECK_EQ(fw_model_names_resolve(&r, &unit, &out, &hit), FW_MODEL_REF_NONE);
    CHECK_STR(out.file, "models/box.gltf");
    /* the string form "@Pillar": the entry, defaults where the entry has none */
    fw_gon_model_defaults(&unit);
    snprintf(unit.file, sizeof unit.file, "@Pillar");
    CHECK_EQ(fw_model_names_resolve(&r, &unit, &out, &hit), FW_MODEL_REF_OK);
    CHECK_STR(out.file, "models/p2.obj");
    CHECK(out.yaw == 90 && out.scale == 1);
    CHECK(hit && !strcmp(hit->name, "Pillar"));
    /* the block form: scale and offset and texture from the unit, yaw / tint / palette from the entry */
    fw_gon_model_node(mem_read, NULL, node(40), &unit);
    CHECK_EQ(fw_model_names_resolve(&r, &unit, &out, &hit), FW_MODEL_REF_OK);
    CHECK_STR(out.file, "models/box.gltf");
    CHECK(out.scale == 3 && out.yaw == 45 && out.offset[1] == 0.5);
    CHECK(out.tint[0] == 1 && out.tint[1] == 0 && out.palette == 0 && out.doubleSided == -1);
    CHECK_STR(out.texture, "models/u.png");
    CHECK_EQ(out.isBlock, 1);
    /* a bare reference block: all of the entry */
    fw_gon_model_node(mem_read, NULL, node(45), &unit);
    CHECK_EQ(fw_model_names_resolve(&r, &unit, &out, &hit), FW_MODEL_REF_OK);
    CHECK(out.scale == 2 && out.yaw == 45);
    CHECK_STR(out.texture, "");
}

/* integration of M3 hide + name: the unit's hide_sprite (-1 = not given) overrides the named entry's, like palette */
TEST(resolve_the_unit_hide_sprite_overrides_the_entry) {
    tree();
    static FwModelNames r;
    fw_model_names_load(mem_read, NULL, node(0), &r);
    FwGonModel unit, out;
    fw_gon_model_defaults(&unit);
    snprintf(unit.file, sizeof unit.file, "@Pillar");
    CHECK_EQ(fw_model_names_resolve(&r, &unit, &out, NULL), FW_MODEL_REF_OK);
    CHECK_EQ(out.hideSprite, -1);                        /* neither says: not given */
    unit.hideSprite = 1;
    CHECK_EQ(fw_model_names_resolve(&r, &unit, &out, NULL), FW_MODEL_REF_OK);
    CHECK_EQ(out.hideSprite, 1);                         /* the unit's true wins */
    unit.hideSprite = 0;
    CHECK_EQ(fw_model_names_resolve(&r, &unit, &out, NULL), FW_MODEL_REF_OK);
    CHECK_EQ(out.hideSprite, 0);
}

TEST(resolve_an_unknown_name_and_a_refused_entry_keep_the_unit_value) {
    tree();
    static FwModelNames r;
    fw_model_names_load(mem_read, NULL, node(0), &r);
    FwGonModel unit, out;
    const FwModelName *hit = (const FwModelName *)1;
    fw_gon_model_defaults(&unit);
    snprintf(unit.file, sizeof unit.file, "@Crate");
    CHECK_EQ(fw_model_names_resolve(&r, &unit, &out, &hit), FW_MODEL_REF_UNKNOWN);
    CHECK_STR(out.file, "@Crate");
    CHECK(hit == NULL);
    snprintf(unit.file, sizeof unit.file, "@");
    CHECK_EQ(fw_model_names_resolve(&r, &unit, &out, &hit), FW_MODEL_REF_UNKNOWN);
    snprintf(unit.file, sizeof unit.file, "@Chain");
    hit = NULL;
    CHECK_EQ(fw_model_names_resolve(&r, &unit, &out, &hit), FW_MODEL_REF_BAD);
    CHECK(hit && hit->bad == FW_MODEL_ENTRY_CHAIN);
    CHECK_STR(out.file, "@Chain");
    static FwModelNames empty;
    fw_model_names_clear(&empty);
    snprintf(unit.file, sizeof unit.file, "@Box");
    CHECK_EQ(fw_model_names_resolve(&empty, &unit, &out, &hit), FW_MODEL_REF_UNKNOWN);   /* never loaded = nothing named */
}

TEST(the_error_and_load_lines) {
    tree();
    static FwModelNames r;
    fw_model_names_load(mem_read, NULL, node(0), &r);
    char b[512];
    fw_model_names_fmt_error(b, sizeof b, "@Crate", FW_MODEL_REF_UNKNOWN, "Pooter", &r, NULL);
    CHECK_STR(b, "mesh: @Crate: model-name-unknown: no data/models.gon entry named Crate (unit Pooter; 6 named models) \xe2\x80\x94 drawing the 2D clip");
    const FwModelName *hit = fw_model_names_find(&r, "Chain");
    fw_model_names_fmt_error(b, sizeof b, "@Chain", FW_MODEL_REF_BAD, "Rat", &r, hit);
    CHECK_STR(b, "mesh: @Chain: model-registry-entry: data/models.gon entry Chain names another @Name (@Box); an entry must name a models/<...>.obj|.gltf|.glb file (unit Rat) \xe2\x80\x94 drawing the 2D clip");
    fw_model_names_fmt_error(b, sizeof b, "@NoFile", FW_MODEL_REF_BAD, NULL, &r, fw_model_names_find(&r, "NoFile"));
    CHECK_STR(b, "mesh: @NoFile: model-registry-entry: data/models.gon entry NoFile is a block without a string file \xe2\x80\x94 drawing the 2D clip");
    fw_model_names_fmt_error(b, sizeof b, "@Num", FW_MODEL_REF_BAD, NULL, &r, fw_model_names_find(&r, "Num"));
    CHECK_STR(b, "mesh: @Num: model-registry-entry: data/models.gon entry Num is neither a model path nor a model block \xe2\x80\x94 drawing the 2D clip");
    fw_model_names_fmt_error(b, sizeof b, "@BadPath", FW_MODEL_REF_BAD, NULL, &r, fw_model_names_find(&r, "BadPath"));
    CHECK_STR(b, "mesh: @BadPath: model-registry-entry: data/models.gon entry BadPath: \"textures/x.png\" is not a models/<...>.obj|.gltf|.glb path \xe2\x80\x94 drawing the 2D clip");
    fw_model_names_fmt_loaded(b, sizeof b, &r, 0);
    CHECK_STR(b, "model names: data/models.gon: 6 entries: Box, Pillar, Chain, NoFile, Num, BadPath");
    static FwModelNames e;
    fw_model_names_load(mem_read, NULL, NULL, &e);
    fw_model_names_fmt_loaded(b, sizeof b, &e, 1);
    CHECK_STR(b, "model names: data/models.gon: absent (no mod on the mod path ships it; mods/fw-3d has the base)");
    fw_model_names_load(mem_read, NULL, (const void *)0x10, &e);
    fw_model_names_fmt_loaded(b, sizeof b, &e, 0);
    CHECK_STR(b, "model names: data/models.gon: unreadable");
    char s[8];
    CHECK(fw_model_names_fmt_error(s, sizeof s, "@Crate", FW_MODEL_REF_UNKNOWN, "Rat", &r, NULL) > 0);
    CHECK(strlen(s) == 7);
}

TEST(the_error_line_is_logged_once_per_reference) {
    static FwModelNamesLogged g;
    memset(&g, 0, sizeof g);
    CHECK_EQ(fw_model_names_log_first(&g, "@Crate"), 1);
    CHECK_EQ(fw_model_names_log_first(&g, "@Crate"), 0);
    CHECK_EQ(fw_model_names_log_first(&g, "@Box"), 1);
    CHECK_EQ(fw_model_names_log_first(&g, NULL), 0);
    for (int i = 0; i < FW_MODEL_NAMES_LOGGED_MAX + 3; i++) { char r[16]; snprintf(r, sizeof r, "@N%d", i); fw_model_names_log_first(&g, r); }
    CHECK_EQ(g.n, FW_MODEL_NAMES_LOGGED_MAX);
    CHECK_EQ(fw_model_names_log_first(&g, "@Other"), 0);   /* full: quiet */
}

int main(void) { return MT_RUN_ALL(); }
