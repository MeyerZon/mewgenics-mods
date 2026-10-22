/* Host-side tests for the framework's GON walker (src/fw_gon.c, promoted from the harness's mt_gon.c): the string
 * at a path of a fake GonObject tree laid out by the GENERATED offsets.h only (OFF_GON_* / GON_NODE_SIZE), SSO and
 * heap std::strings, index segments, a non-string value, missing keys, and unreadable pointers — refused by the
 * guarded fake reader the way the DLL's VirtualQuery reader refuses an unmapped page. Plus the 3D data seam:
 * fw_gon_model / fw_gon_entry_model reading `graphics.model`. No windows.h, no game. */
#define FW_NO_WINDOWS
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdio.h>
#include "../../test/minitest.h"
#include "fw_gon.h"

#define FG_NODES 64
static unsigned char fg_arena[FG_NODES * GON_NODE_SIZE];
static char fg_heap[16][64];  /* heap buffers of the std::strings longer than the 15-byte SSO */
static int fg_heapUsed;
static int fg_reads;
static int fg_mem_read(void *u, const void *addr, void *out, size_t n) {
    (void)u;
    fg_reads++;
    const unsigned char *a = (const unsigned char *)addr;
    const unsigned char *heap = (const unsigned char *)fg_heap;
    int inArena = a >= fg_arena && a + n <= fg_arena + sizeof fg_arena;
    int inHeap = a >= heap && a + n <= heap + sizeof fg_heap;
    if (!inArena && !inHeap) return 0;
    memcpy(out, a, n);
    return 1;
}
static unsigned char *fg_node(int i) { return fg_arena + (size_t)i * GON_NODE_SIZE; }
static void fg_set_str(unsigned char *p, const char *s) {
    size_t len = strlen(s);
    memset(p, 0, 32);
    if (len <= 15) { memcpy(p, s, len); *(size_t *)(p + 16) = len; *(size_t *)(p + 24) = 15; }
    else { char *h = fg_heap[fg_heapUsed++ % 16]; snprintf(h, 64, "%s", s); *(char **)p = h; *(size_t *)(p + 16) = len; *(size_t *)(p + 24) = len < 31 ? 31 : len; }
}
static void fg_scalar(int i, const char *name, int type, const char *text) {
    unsigned char *n = fg_node(i);
    memset(n, 0, GON_NODE_SIZE);
    *(int *)(n + OFF_GON_TYPE) = type;
    fg_set_str(n + OFF_GON_NAME, name);
    fg_set_str(n + OFF_GON_TEXT, text);
}
static void fg_container(int i, const char *name, int type, int firstChild, int count) {
    unsigned char *n = fg_node(i);
    memset(n, 0, GON_NODE_SIZE);
    *(int *)(n + OFF_GON_TYPE) = type;
    fg_set_str(n + OFF_GON_NAME, name);
    *(unsigned char **)(n + OFF_GON_CHILDREN) = fg_node(firstChild);
    *(unsigned char **)(n + OFF_GON_CHILDREN_END) = fg_node(firstChild + count);
}
/* 0 Crate { 1 graphics { 4 movieclip Crate  5 model "models/crate.obj" }  2 properties { 6 health 10 }  3 broken {..} }
 * 7 Rock { 8 graphics { 9 movieclip Rock } }      10 Num { 11 graphics { 12 model 5 } }      13 Short { 14 graphics { 15 model "models/a.obj" } } */
static void fg_tree(void) {
    memset(fg_arena, 0, sizeof fg_arena);
    fg_heapUsed = 0;
    fg_container(0, "Crate", 3, 1, 3);
    fg_container(1, "graphics", 3, 4, 2);
    fg_container(2, "properties", 3, 6, 1);
    fg_container(3, "broken", 3, 0, 0);
    *(void **)(fg_node(3) + OFF_GON_CHILDREN) = (void *)0x10;                    /* a children vector outside readable memory */
    *(void **)(fg_node(3) + OFF_GON_CHILDREN_END) = (void *)(0x10 + GON_NODE_SIZE);
    fg_scalar(4, "movieclip", 1, "Crate");
    fg_scalar(5, "model", 1, "models/crate.obj");                                /* 16 chars: a heap std::string */
    fg_scalar(6, "health", 2, "10");
    fg_container(7, "Rock", 3, 8, 1);
    fg_container(8, "graphics", 3, 9, 1);
    fg_scalar(9, "movieclip", 1, "Rock");
    fg_container(10, "Num", 3, 11, 1);
    fg_container(11, "graphics", 3, 12, 1);
    fg_scalar(12, "model", 2, "5");
    fg_container(13, "Short", 3, 14, 1);
    fg_container(14, "graphics", 3, 15, 1);
    fg_scalar(15, "model", 1, "models/a.obj");                                   /* 12 chars: SSO */
}

TEST(get_string_by_name_heap_and_sso_and_index_segments) {
    fg_tree();
    char out[FW_GON_TEXT];
    CHECK_EQ(fw_gon_get_string(fg_mem_read, NULL, fg_node(0), "graphics.model", out, sizeof out), 1);
    CHECK_STR(out, "models/crate.obj");
    CHECK_EQ(fw_gon_get_string(fg_mem_read, NULL, fg_node(0), "graphics.movieclip", out, sizeof out), 1);
    CHECK_STR(out, "Crate");
    CHECK_EQ(fw_gon_get_string(fg_mem_read, NULL, fg_node(0), "0.1", out, sizeof out), 1);       /* graphics is child 0, model child 1 */
    CHECK_STR(out, "models/crate.obj");
    CHECK_EQ(fw_gon_get_string(fg_mem_read, NULL, fg_node(13), "graphics.model", out, sizeof out), 1);
    CHECK_STR(out, "models/a.obj");
    CHECK_EQ(fw_gon_get_string(fg_mem_read, NULL, fg_node(4), "", out, sizeof out), 1);          /* "" = the node itself */
    CHECK_STR(out, "Crate");
}

TEST(get_string_missing_not_a_string_and_truncation) {
    fg_tree();
    char out[FW_GON_TEXT];
    CHECK_EQ(fw_gon_get_string(fg_mem_read, NULL, fg_node(7), "graphics.model", out, sizeof out), 0);   /* no model key */
    CHECK_STR(out, "");
    CHECK_EQ(fw_gon_get_string(fg_mem_read, NULL, fg_node(10), "graphics.model", out, sizeof out), 0);  /* a number, not a string */
    CHECK_STR(out, "");
    CHECK_EQ(fw_gon_get_string(fg_mem_read, NULL, fg_node(0), "properties.health", out, sizeof out), 0);
    CHECK_EQ(fw_gon_get_string(fg_mem_read, NULL, fg_node(0), "graphics", out, sizeof out), 0);         /* an object */
    CHECK_EQ(fw_gon_get_string(fg_mem_read, NULL, fg_node(0), "graphics.model.x", out, sizeof out), 0); /* through a scalar */
    CHECK_EQ(fw_gon_get_string(fg_mem_read, NULL, fg_node(0), "graphics.5", out, sizeof out), 0);       /* index out of range */
    char small[7];
    CHECK_EQ(fw_gon_get_string(fg_mem_read, NULL, fg_node(0), "graphics.model", small, sizeof small), 1);
    CHECK_STR(small, "models");
}

TEST(get_string_unreadable_null_node_bad_pointer_bad_children_vector) {
    fg_tree();
    char out[FW_GON_TEXT];
    CHECK_EQ(fw_gon_get_string(fg_mem_read, NULL, NULL, "graphics.model", out, sizeof out), -1);
    CHECK_EQ(fw_gon_get_string(fg_mem_read, NULL, (const void *)0x40, "graphics.model", out, sizeof out), -1);
    CHECK_EQ(fw_gon_get_string(fg_mem_read, NULL, fg_node(0), "broken.x", out, sizeof out), -1);
    CHECK_STR(out, "");
    /* an implausible std::string (size > cap) on the value is unreadable, not followed */
    *(size_t *)(fg_node(5) + OFF_GON_TEXT + 16) = 99; *(size_t *)(fg_node(5) + OFF_GON_TEXT + 24) = 31;
    CHECK_EQ(fw_gon_get_string(fg_mem_read, NULL, fg_node(0), "graphics.model", out, sizeof out), -1);
}

TEST(model_seam_reads_graphics_model_through_the_reader_and_the_direct_reader) {
    fg_tree();
    char out[FW_GON_TEXT];
    fg_reads = 0;
    CHECK_EQ(fw_gon_model(fg_mem_read, NULL, fg_node(0), out, sizeof out), 1);
    CHECK_STR(out, "models/crate.obj");
    CHECK(fg_reads > 0);                                                         /* every read went through the reader */
    CHECK_EQ(fw_gon_model(fg_mem_read, NULL, fg_node(7), out, sizeof out), 0);
    CHECK_STR(fw_gon_entry_model(fg_node(0)), "models/crate.obj");
    CHECK_STR(fw_gon_entry_model(fg_node(13)), "models/a.obj");
    CHECK(fw_gon_entry_model(fg_node(7)) == NULL);
    CHECK(fw_gon_entry_model(fg_node(10)) == NULL);
    CHECK(fw_gon_entry_model(NULL) == NULL);
    unsigned char buf[8] = { 1, 2, 3, 4, 5, 6, 7, 8 }, dst[8] = { 0 };
    CHECK_EQ(fw_gon_direct_read(NULL, buf, dst, sizeof dst), 1);
    CHECK_MEM(dst, buf, 8);
    CHECK_EQ(fw_gon_direct_read(NULL, NULL, dst, 4), 0);
    CHECK_EQ(fw_gon_direct_read(NULL, buf, dst, 0), 0);
}

/* ---- the block form of graphics.model (3D phase M2 item 4) ---- */
static void fg_number(int i, const char *name, double v, const char *text) {
    fg_scalar(i, name, FW_GON_TYPE_NUMBER, text);
    *(double *)(fg_node(i) + OFF_GON_DOUBLE) = v;
    *(int *)(fg_node(i) + OFF_GON_INT) = (int)v;
}
static void fg_bool(int i, const char *name, int b) {
    fg_scalar(i, name, FW_GON_TYPE_BOOL, b ? "true" : "false");
    *(fg_node(i) + OFF_GON_BOOL) = (unsigned char)(b ? 1 : 0);
}
/* fg_tree() plus, from node 16:
 * 16 Box { 17 graphics { 18 model { 19 file "models/box.gltf"  20 scale 2  21 yaw 90  22 offset [28 0.5 29 0 30 -0.25]
 *          23 texture "models/box.png"  24 tint [31 1 32 0.5 33 0.25]  25 palette false  26 double_sided true
 *          27 hide_sprite true } } }
 * 34 Bad { 35 graphics { 36 model { 37 file "models/b.obj"  38 scale -1  39 yaw "left"  40 offset [43 1 44 2]
 *          41 tint "red"  42 palette 1 } } }
 * 45 NoFile { 46 graphics { 47 model { 48 scale 2 } } } */
static void fg_tree_blocks(void) {
    fg_tree();
    fg_container(16, "Box", 3, 17, 1);
    fg_container(17, "graphics", 3, 18, 1);
    fg_container(18, "model", 3, 19, 9);
    fg_scalar(19, "file", 1, "models/box.gltf");
    fg_number(20, "scale", 2.0, "2");
    fg_number(21, "yaw", 90.0, "90");
    fg_container(22, "offset", 4, 28, 3);
    fg_scalar(23, "texture", 1, "models/box.png");
    fg_container(24, "tint", 4, 31, 3);
    fg_bool(25, "palette", 0);
    fg_bool(26, "double_sided", 1);
    fg_bool(27, "hide_sprite", 1);
    fg_number(28, "", 0.5, ".5");
    fg_number(29, "", 0.0, "0");
    fg_number(30, "", -0.25, "-.25");
    fg_number(31, "", 1.0, "1");
    fg_number(32, "", 0.5, ".5");
    fg_number(33, "", 0.25, ".25");
    fg_container(34, "Bad", 3, 35, 1);
    fg_container(35, "graphics", 3, 36, 1);
    fg_container(36, "model", 3, 37, 6);
    fg_scalar(37, "file", 1, "models/b.obj");
    fg_number(38, "scale", -1.0, "-1");
    fg_scalar(39, "yaw", 1, "left");
    fg_container(40, "offset", 4, 43, 2);
    fg_scalar(41, "tint", 1, "red");
    fg_number(42, "palette", 1.0, "1");
    fg_number(43, "", 1.0, "1");
    fg_number(44, "", 2.0, "2");
    fg_container(45, "NoFile", 3, 46, 1);
    fg_container(46, "graphics", 3, 47, 1);
    fg_container(47, "model", 3, 48, 1);
    fg_number(48, "scale", 2.0, "2");
}
static int dnear(double a, double b) { return a - b < 1e-9 && b - a < 1e-9; }

TEST(model_block_defaults) {
    FwGonModel m;
    memset(&m, 0x5a, sizeof m);
    fw_gon_model_defaults(&m);
    CHECK_EQ(m.isBlock, 0);
    CHECK_STR(m.file, "");
    CHECK(dnear(m.scale, 1.0) && dnear(m.yaw, 0.0));
    CHECK(dnear(m.offset[0], 0) && dnear(m.offset[1], 0) && dnear(m.offset[2], 0));
    CHECK_STR(m.texture, "");
    CHECK(m.tint[0] == 1.0f && m.tint[1] == 1.0f && m.tint[2] == 1.0f && m.tint[3] == 1.0f);
    CHECK_EQ(m.palette, -1);
    CHECK_EQ(m.doubleSided, -1);
    CHECK_EQ(m.invalid, 0);
}

TEST(model_block_reads_the_string_form_as_file_plus_defaults) {
    fg_tree_blocks();
    FwGonModel m;
    CHECK_EQ(fw_gon_model_block(fg_mem_read, NULL, fg_node(0), &m), 1);
    CHECK_EQ(m.isBlock, 0);
    CHECK_STR(m.file, "models/crate.obj");
    CHECK(dnear(m.scale, 1.0) && dnear(m.yaw, 0.0));
    CHECK_EQ(m.palette, -1);
    CHECK_EQ(m.invalid, 0);
    CHECK_EQ(fw_gon_model_block(fg_mem_read, NULL, fg_node(7), &m), 0);    /* no model key */
    CHECK_STR(m.file, "");
    CHECK_EQ(fw_gon_model_block(fg_mem_read, NULL, fg_node(10), &m), 0);   /* model 5: a number */
    CHECK_EQ(fw_gon_model_block(fg_mem_read, NULL, NULL, &m), -1);
    CHECK_EQ(fw_gon_model_block(fg_mem_read, NULL, (const void *)0x40, &m), -1);
}

TEST(model_block_reads_every_key_of_the_block_form) {
    fg_tree_blocks();
    FwGonModel m;
    CHECK_EQ(fw_gon_model_block(fg_mem_read, NULL, fg_node(16), &m), 1);
    CHECK_EQ(m.isBlock, 1);
    CHECK_STR(m.file, "models/box.gltf");
    CHECK(dnear(m.scale, 2.0));
    CHECK(dnear(m.yaw, 90.0));
    CHECK(dnear(m.offset[0], 0.5) && dnear(m.offset[1], 0.0) && dnear(m.offset[2], -0.25));
    CHECK_STR(m.texture, "models/box.png");
    CHECK(m.tint[0] == 1.0f && m.tint[1] == 0.5f && m.tint[2] == 0.25f && m.tint[3] == 1.0f);   /* 3 numbers: alpha 1 */
    CHECK_EQ(m.palette, 0);
    CHECK_EQ(m.doubleSided, 1);
    CHECK_EQ(m.invalid, 0);                                                    /* hide_sprite: unknown here, ignored */
}

TEST(model_block_bad_values_keep_their_defaults_and_set_their_bits) {
    fg_tree_blocks();
    FwGonModel m;
    CHECK_EQ(fw_gon_model_block(fg_mem_read, NULL, fg_node(34), &m), 1);
    CHECK_STR(m.file, "models/b.obj");
    CHECK(dnear(m.scale, 1.0) && dnear(m.yaw, 0.0));
    CHECK(dnear(m.offset[0], 0) && dnear(m.offset[2], 0));
    CHECK(m.tint[0] == 1.0f && m.tint[3] == 1.0f);
    CHECK_EQ(m.palette, -1);
    CHECK_EQ(m.invalid, FW_GON_MODEL_BAD_SCALE | FW_GON_MODEL_BAD_YAW | FW_GON_MODEL_BAD_OFFSET | FW_GON_MODEL_BAD_TINT | FW_GON_MODEL_BAD_PALETTE);
    CHECK_EQ(fw_gon_model_block(fg_mem_read, NULL, fg_node(45), &m), 0);   /* a block without file */
    CHECK_EQ(m.invalid & FW_GON_MODEL_BAD_FILE, FW_GON_MODEL_BAD_FILE);
    CHECK_STR(m.file, "");
}

TEST(model_block_unreadable_block_children_is_minus_one) {
    fg_tree_blocks();
    *(void **)(fg_node(18) + OFF_GON_CHILDREN) = (void *)0x10;               /* the model block's vector: unmapped */
    *(void **)(fg_node(18) + OFF_GON_CHILDREN_END) = (void *)(0x10 + GON_NODE_SIZE);
    FwGonModel m;
    CHECK_EQ(fw_gon_model_block(fg_mem_read, NULL, fg_node(16), &m), -1);
    CHECK_STR(m.file, "");
}

TEST(get_number_and_node_name) {
    fg_tree_blocks();
    double d = 0;
    CHECK_EQ(fw_gon_get_number(fg_mem_read, NULL, fg_node(16), "graphics.model.scale", &d), 1);
    CHECK(dnear(d, 2.0));
    CHECK_EQ(fw_gon_get_number(fg_mem_read, NULL, fg_node(16), "graphics.model.offset.2", &d), 1);
    CHECK(dnear(d, -0.25));
    CHECK_EQ(fw_gon_get_number(fg_mem_read, NULL, fg_node(16), "graphics.model.file", &d), 0);   /* a string */
    CHECK_EQ(fw_gon_get_number(fg_mem_read, NULL, fg_node(16), "graphics.nope", &d), 0);
    CHECK_EQ(fw_gon_get_number(fg_mem_read, NULL, NULL, "x", &d), -1);
    char name[32];
    CHECK_EQ(fw_gon_node_name(fg_mem_read, NULL, fg_node(0), name, sizeof name), 1);
    CHECK_STR(name, "Crate");
    CHECK_EQ(fw_gon_node_name(fg_mem_read, NULL, fg_node(16), name, sizeof name), 1);
    CHECK_STR(name, "Box");
    CHECK_EQ(fw_gon_node_name(fg_mem_read, NULL, (const void *)0x40, name, sizeof name), -1);
    CHECK_STR(name, "");
}

int main(void) { return MT_RUN_ALL(); }
