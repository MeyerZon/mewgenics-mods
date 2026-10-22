/* Host-side tests for mewtest's pure modules (src/mt_*.c). No windows.h, no game.
 * Sections: jsonl, args, msvcstr, script, console, runner (with a fake host). */
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../../../test/minitest.h"
#include "mt_pure.h"
#include "offsets.h"   /* OFF_GON_* / GON_NODE_SIZE / OFF_CH_*: the fake GON nodes are shaped only by the generated macros */

/* ====================================================================== */
/* mt_jsonl                                                               */
/* ====================================================================== */
TEST(json_escape_plain_and_specials) {
    char out[64];
    size_t n = mt_json_escape("ab", 2, out, sizeof out);
    CHECK_EQ(n, 4);
    CHECK_STR(out, "\"ab\"");
    n = mt_json_escape("a\"b\\c", 5, out, sizeof out);
    CHECK_STR(out, "\"a\\\"b\\\\c\"");
    n = mt_json_escape("\n\r\t", 3, out, sizeof out);
    CHECK_STR(out, "\"\\n\\r\\t\"");
    n = mt_json_escape("\x01", 1, out, sizeof out);
    CHECK_STR(out, "\"\\u0001\"");
    n = mt_json_escape("", 0, out, sizeof out);
    CHECK_STR(out, "\"\"");
}

TEST(json_escape_passes_utf8_bytes_and_reports_needed_length) {
    char out[64];
    const char *s = "caf\xC3\xA9";
    mt_json_escape(s, strlen(s), out, sizeof out);
    CHECK_STR(out, "\"caf\xC3\xA9\"");
    char tiny[4];
    size_t need = mt_json_escape("hello", 5, tiny, sizeof tiny);
    CHECK_EQ(need, 7);               /* "hello" with quotes */
    CHECK_EQ(strlen(tiny) < sizeof tiny, 1); /* always NUL-terminated */
}

TEST(jsonl_writer_exact_output) {
    char buf[256];
    MtJsonW w;
    mt_jw_begin(&w, buf, sizeof buf, "x");
    mt_jw_int(&w, "n", 1);
    mt_jw_bool(&w, "ok", 1);
    mt_jw_str(&w, "s", "q\"");
    mt_jw_hex(&w, "addr", 0x1404929c0ULL);
    CHECK_EQ(mt_jw_end(&w), 1);
    CHECK_STR(buf, "{\"ev\":\"x\",\"n\":1,\"ok\":true,\"s\":\"q\\\"\",\"addr\":\"0x1404929c0\"}\n");
}

TEST(jsonl_writer_nested_arrays_and_objects) {
    char buf[256];
    MtJsonW w;
    mt_jw_begin(&w, buf, sizeof buf, "units");
    mt_jw_arr_begin(&w, "list");
    mt_jw_obj_begin(&w, NULL);
    mt_jw_int(&w, "i", 0);
    mt_jw_arr_begin(&w, "statuses");
    mt_jw_arr_str(&w, "LuckUp");
    mt_jw_arr_str(&w, "Burn");
    mt_jw_arr_end(&w);
    mt_jw_obj_end(&w);
    mt_jw_obj_begin(&w, NULL);
    mt_jw_int(&w, "i", 1);
    mt_jw_obj_end(&w);
    mt_jw_arr_end(&w);
    mt_jw_int(&w, "count", 2);
    CHECK_EQ(mt_jw_end(&w), 1);
    CHECK_STR(buf, "{\"ev\":\"units\",\"list\":[{\"i\":0,\"statuses\":[\"LuckUp\",\"Burn\"]},{\"i\":1}],\"count\":2}\n");
}

TEST(jsonl_writer_overflow_is_flagged_and_terminated) {
    char buf[24];
    MtJsonW w;
    mt_jw_begin(&w, buf, sizeof buf, "start");
    mt_jw_str(&w, "harness", "mewtest 0.1.0 with a long value");
    CHECK_EQ(mt_jw_end(&w), 0);
    CHECK_EQ(w.overflow, 1);
    CHECK(strlen(buf) < sizeof buf);
}

/* ====================================================================== */
/* mt_args                                                                */
/* ====================================================================== */
TEST(args_absent_flag_is_not_present) {
    MtArgs a;
    CHECK_EQ(mt_args_parse("\"C:\\G\\Mewgenics.exe\" -savesuffix dev -modpaths C:\\m", &a), 0);
    CHECK_EQ(a.present, 0);
    CHECK_EQ(a.hasSaveSuffix, 1);
    CHECK_STR(a.err, "");
}

TEST(args_defaults_and_derived_out) {
    MtArgs a;
    CHECK_EQ(mt_args_parse("Mewgenics.exe -savesuffix dev -mewtest C:\\r\\script.mewtest -modpaths C:\\m", &a), 1);
    CHECK_EQ(a.present, 1);
    CHECK_STR(a.script, "C:\\r\\script.mewtest");
    CHECK_STR(a.out, "C:\\r\\script.jsonl");
    CHECK_EQ(a.hide, 1);
    CHECK_EQ(a.timeoutMs, 120000);
    CHECK_EQ(a.clean, 0);
    CHECK_EQ(a.hasSaveSuffix, 1);
}

TEST(args_quoted_paths_with_spaces_and_all_flags) {
    MtArgs a;
    CHECK_EQ(mt_args_parse("\"C:\\Program Files\\Mewgenics.exe\" -mewtest_hide 0 -mewtest \"C:\\My Dir\\s.mewtest\" -mewtest_out \"C:\\My Dir\\r.jsonl\" -mewtest_timeout 5000 -mewtest_clean 1 -savesuffix dev", &a), 1);
    CHECK_STR(a.script, "C:\\My Dir\\s.mewtest");
    CHECK_STR(a.out, "C:\\My Dir\\r.jsonl");
    CHECK_EQ(a.hide, 0);
    CHECK_EQ(a.timeoutMs, 5000);
    CHECK_EQ(a.clean, 1);
}

TEST(args_derived_out_without_extension_appends) {
    MtArgs a;
    mt_args_parse("x -mewtest C:\\r\\script", &a);
    CHECK_STR(a.out, "C:\\r\\script.jsonl");
    mt_args_parse("x -mewtest C:\\r.d\\script", &a);
    CHECK_STR(a.out, "C:\\r.d\\script.jsonl"); /* dot in a directory name is not an extension */
}

TEST(args_errors) {
    MtArgs a;
    CHECK_EQ(mt_args_parse("x -mewtest", &a), 0);
    CHECK(strlen(a.err) > 0);
    CHECK_EQ(mt_args_parse("x -mewtest s.mewtest -mewtest_timeout abc", &a), 0);
    CHECK(strstr(a.err, "timeout") != NULL);
    CHECK_EQ(mt_args_parse("x -mewtest s.mewtest -mewtest_hide", &a), 0);
    CHECK_EQ(mt_args_parse("x -savesuffix", &a), 0);
    CHECK_EQ(a.hasSaveSuffix, 0);
}

/* ====================================================================== */
/* mt_msvcstr                                                             */
/* ====================================================================== */
static size_t g_allocAsked;
static int g_allocFail;
static void *fake_alloc(size_t n) { g_allocAsked = n; return g_allocFail ? NULL : malloc(n); }

TEST(msvcstr_sso_boundaries) {
    MtMsvcString s;
    g_allocAsked = 0;
    CHECK_EQ(mt_msvcstr_build(&s, "", 0, fake_alloc), 1);
    CHECK_EQ(s.size, 0); CHECK_EQ(s.cap, 15); CHECK_EQ(g_allocAsked, 0);
    CHECK_STR(mt_msvcstr_data(&s), "");
    CHECK_EQ(mt_msvcstr_build(&s, "123456789012345", 15, fake_alloc), 1);
    CHECK_EQ(s.cap, 15); CHECK_EQ(g_allocAsked, 0);
    CHECK_STR(mt_msvcstr_data(&s), "123456789012345");
    CHECK(mt_msvcstr_data(&s) == s.u.buf);
}

TEST(msvcstr_heap_capacity_rule) {
    MtMsvcString s;
    g_allocAsked = 0;
    CHECK_EQ(mt_msvcstr_build(&s, "1234567890123456", 16, fake_alloc), 1);
    CHECK_EQ(s.size, 16); CHECK_EQ(s.cap, 31); CHECK_EQ(g_allocAsked, 32);
    CHECK_STR(mt_msvcstr_data(&s), "1234567890123456");
    CHECK(mt_msvcstr_data(&s) == s.u.ptr);
    free(s.u.ptr);
    char big[48]; memset(big, 'a', 31); big[31] = 0;
    CHECK_EQ(mt_msvcstr_build(&s, big, 31, fake_alloc), 1);
    CHECK_EQ(s.cap, 31); CHECK_EQ(g_allocAsked, 32);
    free(s.u.ptr);
    memset(big, 'b', 32); big[32] = 0;
    CHECK_EQ(mt_msvcstr_build(&s, big, 32, fake_alloc), 1);
    CHECK_EQ(s.cap, 47); CHECK_EQ(g_allocAsked, 48);
    free(s.u.ptr);
}

TEST(msvcstr_alloc_failure_and_big_alloc_guard) {
    MtMsvcString s;
    g_allocFail = 1;
    CHECK_EQ(mt_msvcstr_build(&s, "1234567890123456", 16, fake_alloc), 0);
    g_allocFail = 0;
    char *huge = malloc(5000); memset(huge, 'x', 4999); huge[4999] = 0;
    CHECK_EQ(mt_msvcstr_build(&s, huge, 4079, fake_alloc), 0);  /* cap+1 would be 0x1000: large-alloc path */
    CHECK_EQ(mt_msvcstr_build(&s, huge, 4078, fake_alloc), 1);
    CHECK_EQ(s.cap, 4079); CHECK_EQ(g_allocAsked, 4080);
    free(s.u.ptr);
    free(huge);
}

TEST(msvcstr_copy_out) {
    MtMsvcString s; char out[8];
    mt_msvcstr_build(&s, "hello world", 11, fake_alloc);   /* 11 bytes: SSO, nothing to free */
    CHECK_EQ(mt_msvcstr_copy(&s, out, sizeof out), 7);
    CHECK_STR(out, "hello w");
    CHECK_EQ(mt_msvcstr_copy(&s, NULL, 0), 0);
    mt_msvcstr_build(&s, "hello world, heap edition", 25, fake_alloc);
    CHECK_EQ(mt_msvcstr_copy(&s, out, sizeof out), 7);
    CHECK_STR(out, "hello w");
    free(s.u.ptr);
}

TEST(wstring_sso_and_heap_and_utf8) {
    MtMsvcWString w; uint16_t heap[12]; char out[32];
    uint16_t sso[7] = { 'L','u','m','e','e',0,0 };
    memcpy(w.u.buf, sso, sizeof sso); w.size = 5; w.cap = 7;
    CHECK(mt_msvcwstr_data(&w) == w.u.buf);
    CHECK_EQ(mt_wstr_to_utf8(mt_msvcwstr_data(&w), w.size, out, sizeof out), 5);
    CHECK_STR(out, "Lumee");
    for (int i = 0; i < 12; i++) heap[i] = (uint16_t)('a' + i);
    w.u.ptr = heap; w.size = 12; w.cap = 15;
    CHECK(mt_msvcwstr_data(&w) == heap);
    CHECK_EQ(mt_wstr_to_utf8(heap, 12, out, sizeof out), 12);
    CHECK_STR(out, "abcdefghijkl");
}

TEST(wstr_to_utf8_bmp_surrogates_and_truncation) {
    char out[16];
    uint16_t s1[] = { 0x00E9 };               /* é */
    CHECK_EQ(mt_wstr_to_utf8(s1, 1, out, sizeof out), 2);
    CHECK_STR(out, "\xC3\xA9");
    uint16_t s2[] = { 0xD83D, 0xDC31 };       /* 🐱 */
    CHECK_EQ(mt_wstr_to_utf8(s2, 2, out, sizeof out), 4);
    CHECK_STR(out, "\xF0\x9F\x90\xB1");
    uint16_t s3[] = { 'a','b','c','d' };
    CHECK_EQ(mt_wstr_to_utf8(s3, 4, out, 3), 2);     /* cap 3 -> 2 chars + NUL */
    CHECK_STR(out, "ab");
}

/* ====================================================================== */
/* mt_script                                                              */
/* ====================================================================== */
static MtScript g_s;
static int parse_ok(const char *text, char *err, int *line) {
    err[0] = 0; *line = 0;
    return mt_script_parse(text, strlen(text), &g_s, err, 256, line);
}

TEST(script_empty_and_comments_only) {
    char err[256]; int line;
    CHECK_EQ(parse_ok("", err, &line), 1);
    CHECK_EQ(g_s.count, 0);
    CHECK_EQ(parse_ok("# only\n\n   # more\r\n", err, &line), 1);
    CHECK_EQ(g_s.count, 0);
}

TEST(script_every_directive_kind) {
    char err[256]; int line;
    const char *t =
        "wait frames 120\n"
        "cmd bind JokersGambit # verbatim\n"
        "expect console \"No command named \\\"bind\\\" found\" within 5\n"
        "expect noconsole \"NO_ABILITY_NAMED\"\n"
        "expect status JokersLuck on \"Mr Whiskers\"\n"
        "expect status LuckUp on 0\n"
        "expect status LuckUp on Lumee\n"
        "expect units >= 2\n"
        "dump\n"
        "log \"hello \\\"world\\\"\"\n"
        "wait turns 2\n"
        "wait ms 500\n"
        "quit 7\n"
        "quit\n";
    CHECK_EQ(parse_ok(t, err, &line), 1);
    if (g_s.count != 14) { printf("      err=%s line=%d\n", err, line); }
    CHECK_EQ(g_s.count, 14);
    CHECK_EQ(g_s.d[0].kind, MT_D_WAIT_FRAMES); CHECK_EQ(g_s.d[0].n, 120); CHECK_EQ(g_s.d[0].line, 1);
    CHECK_EQ(g_s.d[1].kind, MT_D_CMD); CHECK_STR(g_s.d[1].a, "bind JokersGambit # verbatim");
    CHECK_EQ(g_s.d[2].kind, MT_D_EXPECT_CONSOLE); CHECK_STR(g_s.d[2].a, "No command named \"bind\" found"); CHECK_EQ(g_s.d[2].within, 5);
    CHECK_EQ(g_s.d[3].kind, MT_D_EXPECT_NOCONSOLE); CHECK_STR(g_s.d[3].a, "NO_ABILITY_NAMED"); CHECK_EQ(g_s.d[3].within, 0);
    CHECK_EQ(g_s.d[4].kind, MT_D_EXPECT_STATUS); CHECK_STR(g_s.d[4].a, "JokersLuck"); CHECK_STR(g_s.d[4].b, "Mr Whiskers"); CHECK_EQ(g_s.d[4].unitIsIndex, 0);
    CHECK_EQ(g_s.d[5].kind, MT_D_EXPECT_STATUS); CHECK_EQ(g_s.d[5].unitIsIndex, 1); CHECK_EQ(g_s.d[5].n, 0);
    CHECK_EQ(g_s.d[6].unitIsIndex, 0); CHECK_STR(g_s.d[6].b, "Lumee");
    CHECK_EQ(g_s.d[7].kind, MT_D_EXPECT_UNITS); CHECK_EQ(g_s.d[7].op, MT_OP_GE); CHECK_EQ(g_s.d[7].n, 2);
    CHECK_EQ(g_s.d[8].kind, MT_D_DUMP);
    CHECK_EQ(g_s.d[9].kind, MT_D_LOG); CHECK_STR(g_s.d[9].a, "hello \"world\"");
    CHECK_EQ(g_s.d[10].kind, MT_D_WAIT_TURNS); CHECK_EQ(g_s.d[10].n, 2);
    CHECK_EQ(g_s.d[11].kind, MT_D_WAIT_MS); CHECK_EQ(g_s.d[11].n, 500);
    CHECK_EQ(g_s.d[12].kind, MT_D_QUIT); CHECK_EQ(g_s.d[12].hasCode, 1); CHECK_EQ(g_s.d[12].n, 7);
    CHECK_EQ(g_s.d[13].kind, MT_D_QUIT); CHECK_EQ(g_s.d[13].hasCode, 0); CHECK_EQ(g_s.d[13].line, 14);
}

TEST(script_all_units_ops) {
    char err[256]; int line;
    const char *ops[] = { "==", "!=", ">=", "<=", ">", "<" };
    int want[] = { MT_OP_EQ, MT_OP_NE, MT_OP_GE, MT_OP_LE, MT_OP_GT, MT_OP_LT };
    for (int i = 0; i < 6; i++) {
        char t[64]; snprintf(t, sizeof t, "expect units %s 3\n", ops[i]);
        CHECK_EQ(parse_ok(t, err, &line), 1);
        CHECK_EQ(g_s.d[0].op, want[i]);
    }
    CHECK_EQ(parse_ok("expect units ~= 3\n", err, &line), 0);
    CHECK_EQ(line, 1);
}

TEST(script_errors_with_line_numbers) {
    char err[256]; int line;
    const char *bad[] = {
        "cmd ok\nfrobnicate now\n",
        "cmd ok\nwait seconds 3\n",
        "cmd ok\nwait frames 0\n",
        "cmd ok\nexpect console \"unterminated\n",
        "cmd ok\nexpect console\n",
        "cmd ok\ncmd\n",
        "cmd ok\nexpect status X\n",
        "cmd ok\nquit 300\n",
        "cmd ok\ndump now\n",
        "cmd ok\nlog nope\n",
    };
    for (size_t i = 0; i < sizeof bad / sizeof bad[0]; i++) {
        int ok = parse_ok(bad[i], err, &line);
        if (ok || line != 2) printf("      case %d: ok=%d line=%d err=%s\n", (int)i, ok, line, err);
        CHECK_EQ(ok, 0);
        CHECK_EQ(line, 2);
        CHECK(strlen(err) > 0);
    }
}

TEST(script_crlf_tabs_and_limits) {
    char err[256]; int line;
    CHECK_EQ(parse_ok("\tcmd   listcmds  \r\n  quit\r\n", err, &line), 1);
    CHECK_EQ(g_s.count, 2);
    CHECK_STR(g_s.d[0].a, "listcmds");
    /* a 4079-byte cmd is rejected, 4078 accepted */
    char *t = malloc(4200);
    memcpy(t, "cmd ", 4); memset(t + 4, 'x', 4079); t[4 + 4079] = '\n'; t[4 + 4080] = 0;
    CHECK_EQ(parse_ok(t, err, &line), 0);
    CHECK_EQ(line, 1);
    memset(t + 4, 'x', 4078); t[4 + 4078] = '\n'; t[4 + 4079] = 0;
    CHECK_EQ(parse_ok(t, err, &line), 1);
    free(t);
    /* directive cap: 1025 lines of "dump" */
    char *many = malloc(1025 * 5 + 1); many[0] = 0;
    for (int i = 0; i < 1025; i++) strcat(many, "dump\n");
    CHECK_EQ(parse_ok(many, err, &line), 0);
    CHECK_EQ(line, 1025);
    free(many);
}

/* ====================================================================== */
/* mt_console                                                             */
/* ====================================================================== */
TEST(console_track_diff_shrink_window) {
    MtConsoleTrack t = { 0, 0 };
    int first, num;
    CHECK_EQ(mt_console_poll(&t, 0, &first, &num), 0);
    CHECK_EQ(mt_console_poll(&t, 3, &first, &num), 3);
    CHECK_EQ(first, 0); CHECK_EQ(num, 3);
    CHECK_EQ(mt_console_poll(&t, 3, &first, &num), 0);
    mt_console_mark_window(&t);
    CHECK_EQ(t.windowStart, 3);
    CHECK_EQ(mt_console_poll(&t, 5, &first, &num), 2);
    CHECK_EQ(first, 3);
    /* the console was cleared: the count shrank -> reset */
    CHECK_EQ(mt_console_poll(&t, 1, &first, &num), 1);
    CHECK_EQ(first, 0); CHECK_EQ(t.windowStart, 0); CHECK_EQ(t.seen, 1);
}

/* ====================================================================== */
/* mt_runner with a fake host                                             */
/* ====================================================================== */
/* ---- a fake GonObject tree for the walker and `expect gon` (2026-10-22) ----
 * Nodes live in one arena laid out by the generated macros; the reader refuses any address outside it, the way the
 * DLL's guarded read refuses an unmapped page, so a bad children vector is "unreadable", never a crash. */
#define FG_NODES 16
static unsigned char fg_arena[FG_NODES * GON_NODE_SIZE];
static char fg_heap[4][64];   /* heap buffers for the std::strings longer than the 15-byte SSO */
static int fg_heapUsed;
static int fg_mem_read(void *u, const void *addr, void *out, size_t n) {
    (void)u;
    const unsigned char *a = (const unsigned char *)addr;
    if (a < fg_arena || a + n > fg_arena + sizeof fg_arena) return 0;
    memcpy(out, a, n);
    return 1;
}
static unsigned char *fg_node(int i) { return fg_arena + (size_t)i * GON_NODE_SIZE; }
/* an MSVC std::string (buf/ptr, size, cap) at p */
static void fg_set_str(unsigned char *p, const char *s) {
    size_t len = strlen(s);
    memset(p, 0, 32);
    if (len <= 15) { memcpy(p, s, len); *(size_t *)(p + 16) = len; *(size_t *)(p + 24) = 15; }
    else { char *h = fg_heap[fg_heapUsed++ % 4]; snprintf(h, 64, "%s", s); *(char **)p = h; *(size_t *)(p + 16) = len; *(size_t *)(p + 24) = len < 31 ? 31 : len; }
}
static void fg_scalar(int i, const char *name, int type, const char *text, int iv, double dv, int bv) {
    unsigned char *n = fg_node(i);
    memset(n, 0, GON_NODE_SIZE);
    *(int *)(n + OFF_GON_TYPE) = type;
    fg_set_str(n + OFF_GON_NAME, name);
    fg_set_str(n + OFF_GON_TEXT, text);
    *(int *)(n + OFF_GON_INT) = iv;
    *(double *)(n + OFF_GON_DOUBLE) = dv;
    n[OFF_GON_BOOL] = (unsigned char)bv;
}
static void fg_container(int i, const char *name, int type, int firstChild, int count) {
    unsigned char *n = fg_node(i);
    memset(n, 0, GON_NODE_SIZE);
    *(int *)(n + OFF_GON_TYPE) = type;
    fg_set_str(n + OFF_GON_NAME, name);
    *(unsigned char **)(n + OFF_GON_CHILDREN) = fg_node(firstChild);
    *(unsigned char **)(n + OFF_GON_CHILDREN_END) = fg_node(firstChild + count);
}
/* Pooter-like entry: root { graphics { name } stats { strength speed } properties { health flying faction a_rather_long_key_name } spells [ Fireball 2 ] broken {...} } */
static void fg_tree(void) {
    memset(fg_arena, 0, sizeof fg_arena);
    fg_heapUsed = 0;
    fg_container(0, "Pooter", 3, 1, 5);
    fg_container(1, "graphics", 3, 6, 1);
    fg_container(2, "stats", 3, 7, 2);
    fg_container(3, "properties", 3, 9, 4);
    fg_container(4, "spells", 4, 13, 2);
    fg_container(5, "broken", 3, 0, 0);
    *(void **)(fg_node(5) + OFF_GON_CHILDREN) = (void *)0x10;                    /* a children vector outside readable memory */
    *(void **)(fg_node(5) + OFF_GON_CHILDREN_END) = (void *)(0x10 + GON_NODE_SIZE);
    fg_scalar(6, "name", 1, "ENEMY_POOTER_NAME", 0, 0.0, 0);                     /* heap text (17 chars) */
    fg_scalar(7, "strength", 2, "5", 5, 5.0, 0);
    fg_scalar(8, "speed", 2, "15", 15, 15.0, 0);
    fg_scalar(9, "health", 2, "12", 12, 12.0, 0);
    fg_scalar(10, "flying", 5, "true", 0, 0.0, 1);
    fg_scalar(11, "faction", 1, "allies", 0, 0.0, 0);
    fg_scalar(12, "a_rather_long_key_name", 2, "1.5", 1, 1.5, 0);               /* heap name (22 chars); 1.5 -> int 1, double 1.5 */
    fg_scalar(13, "", 1, "Fireball", 0, 0.0, 0);                                 /* array children are unnamed */
    fg_scalar(14, "", 2, "2", 2, 2.0, 0);
}

#define FK_MAX 64
typedef struct Fake {
    int ready;
    char lines[FK_MAX][128]; int lineCount;
    char cmds[FK_MAX][128]; int cmdCount;
    char reply[FK_MAX][128]; int replyCount; /* lines pushed when the next cmd executes */
    long turns; int round; uint64_t now;
    int unitsAvailable; MtUnit units[8]; int unitCount;
    char emitted[FK_MAX][1024]; int emitCount;
    int exitCode; int exitCalls;
    int enterResult; int enterCalls; int enterScene; int enterMode;   /* enter_scene: programmable result (1 ok / 0 refused / -1 unavailable) */
    int seedResult; int seedCalls; unsigned long long seedValue;   /* seed_rng: programmable result (1 ok / 0 refused / -1 unavailable) */
    char pipeReply[8192]; int pipeReplies;                          /* pipe_reply: the last reply the runner handed to the glue */
    const void *gon[8];                                             /* unit_gon: the unit's entry node (NULL = unreadable) */
} Fake;
static Fake fk;

static int fk_console_ready(void *u) { (void)u; return fk.ready; }
static int fk_exec_cmd(void *u, const char *line) {
    (void)u;
    if (fk.cmdCount < FK_MAX) snprintf(fk.cmds[fk.cmdCount++], 128, "%s", line);
    for (int i = 0; i < fk.replyCount && fk.lineCount < FK_MAX; i++) snprintf(fk.lines[fk.lineCount++], 128, "%s", fk.reply[i]);
    fk.replyCount = 0;
    return 1;
}
static int fk_console_count(void *u) { (void)u; return fk.lineCount; }
static int fk_console_line(void *u, int i, char *buf, size_t cap) { (void)u; if (i < 0 || i >= fk.lineCount) return 0; snprintf(buf, cap, "%s", fk.lines[i]); return 1; }
static long fk_turn_count(void *u) { (void)u; return fk.turns; }
static int fk_round(void *u) { (void)u; return fk.round; }
static uint64_t fk_now(void *u) { (void)u; return fk.now; }
static int fk_units_available(void *u) { (void)u; return fk.unitsAvailable; }
static int fk_unit_count(void *u) { (void)u; return fk.unitCount; }
static int fk_unit_info(void *u, int i, MtUnit *out) { (void)u; if (i < 0 || i >= fk.unitCount) return 0; *out = fk.units[i]; return 1; }
static int fk_unit_has_status(void *u, int i, const char *st) {
    (void)u;
    if (i < 0 || i >= fk.unitCount) return 0;
    for (int k = 0; k < fk.units[i].statusCount; k++) if (strcmp(fk.units[i].statuses[k], st) == 0) return 1;
    return 0;
}
static void fk_emit(void *u, const char *json) { (void)u; if (fk.emitCount < FK_MAX) snprintf(fk.emitted[fk.emitCount++], 1024, "%s", json); }
static void fk_request_exit(void *u, int code) { (void)u; fk.exitCode = code; fk.exitCalls++; }
static int fk_enter_scene(void *u, int scene, int mode, char *detail, size_t cap) {
    (void)u;
    fk.enterCalls++; fk.enterScene = scene; fk.enterMode = mode;
    snprintf(detail, cap, "fake enter %d", scene);
    return fk.enterResult;
}

static int fk_seed_rng(void *u, unsigned long long seed, char *detail, size_t cap) {
    (void)u;
    fk.seedCalls++; fk.seedValue = seed;
    snprintf(detail, cap, "fake seeded %llu", seed);
    return fk.seedResult;
}

static void fk_pipe_reply(void *u, const char *json) { (void)u; fk.pipeReplies++; snprintf(fk.pipeReply, sizeof fk.pipeReply, "%s", json); }
static const void *fk_unit_gon(void *u, int i) { (void)u; return i >= 0 && i < fk.unitCount ? fk.gon[i] : NULL; }

static const MtHost HOST = {
    NULL, fk_console_ready, fk_exec_cmd, fk_console_count, fk_console_line, fk_turn_count, fk_round, fk_now,
    fk_units_available, fk_unit_count, fk_unit_info, fk_unit_has_status, fk_emit, fk_request_exit, fk_enter_scene, fk_seed_rng,
    fk_pipe_reply, fg_mem_read, fk_unit_gon,
};

static MtRunner rr;
static void fk_reset(const char *script) {
    memset(&fk, 0, sizeof fk);
    fk.ready = 1; fk.round = 1; fk.now = 1000;
    char err[256]; int line;
    if (!mt_script_parse(script, strlen(script), &g_s, err, sizeof err, &line)) printf("      fk_reset: parse error line %d: %s\n", line, err);
    mt_runner_init(&rr, &g_s, fk.now);
}
static void fk_reply(const char *l) { snprintf(fk.reply[fk.replyCount++], 128, "%s", l); }
static void fk_push(const char *l) { snprintf(fk.lines[fk.lineCount++], 128, "%s", l); }
static int steps_until_done(int max) { int n = 0; while (n < max && mt_runner_step(&rr, &HOST)) n++; return n; }
static const char *ev(int i) { return i < fk.emitCount ? fk.emitted[i] : ""; }
static int has(const char *s, const char *sub) { return strstr(s, sub) != NULL; }
static int count_ev(const char *kind) { int c = 0; char k[64]; snprintf(k, sizeof k, "{\"ev\":\"%s\"", kind); for (int i = 0; i < fk.emitCount; i++) if (strncmp(fk.emitted[i], k, strlen(k)) == 0) c++; return c; }
static const char *last_ev(void) { return fk.emitCount ? fk.emitted[fk.emitCount - 1] : ""; }

TEST(runner_cmd_then_same_step_console_then_expect_ok) {
    fk_reset("cmd listcmds\nexpect console \"listcmds\"\nquit\n");
    fk_reply("listcmds"); fk_reply("load");
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);
    CHECK_EQ(fk.cmdCount, 1); CHECK_STR(fk.cmds[0], "listcmds");
    CHECK(has(ev(0), "{\"ev\":\"cmd\"")); CHECK(has(ev(0), "\"line\":1")); CHECK(has(ev(0), "\"text\":\"listcmds\""));
    CHECK(has(ev(1), "{\"ev\":\"console\"")); CHECK(has(ev(1), "\"text\":\"listcmds\""));
    CHECK(has(ev(2), "{\"ev\":\"console\"")); CHECK(has(ev(2), "\"text\":\"load\""));
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);
    CHECK(has(last_ev(), "{\"ev\":\"expect\"")); CHECK(has(last_ev(), "\"kind\":\"console\"")); CHECK(has(last_ev(), "\"ok\":true"));
    CHECK_EQ(mt_runner_step(&rr, &HOST), 0);
    CHECK(has(last_ev(), "{\"ev\":\"end\"")); CHECK(has(last_ev(), "\"code\":0")); CHECK(has(last_ev(), "\"reason\":\"quit\""));
    CHECK(has(last_ev(), "\"expect_pass\":1")); CHECK(has(last_ev(), "\"expect_fail\":0"));
    CHECK_EQ(fk.exitCalls, 1); CHECK_EQ(fk.exitCode, 0);
    CHECK_EQ(mt_runner_step(&rr, &HOST), 0); /* stepping after finished is a no-op */
    CHECK_EQ(fk.exitCalls, 1);
}

/* ---- enter <SceneName>: the harness replays the dev menu's "TacticsTest" entry through the host ---- */
TEST(script_enter_directive_parses_known_scene_and_rejects_unknown_or_missing) {
    char err[256]; int line = 0;
    CHECK(mt_script_parse("enter TacticsTest\nquit\n", 23, &g_s, err, sizeof err, &line));
    CHECK_EQ(g_s.count, 2);
    CHECK_EQ(g_s.d[0].kind, MT_D_ENTER);
    CHECK_EQ(g_s.d[0].scene, MT_SCENE_TACTICS_TEST);
    CHECK_EQ(g_s.d[0].line, 1);
    CHECK_STR(mt_scene_name(MT_SCENE_TACTICS_TEST), "TacticsTest");
    CHECK_EQ(mt_scene_id("TacticsTest"), MT_SCENE_TACTICS_TEST);
    CHECK_EQ(mt_scene_id("Campaign"), MT_SCENE_CAMPAIGN);
    CHECK_STR(mt_scene_name(MT_SCENE_CAMPAIGN), "Campaign");
    CHECK_EQ(mt_scene_id("Nope"), 0);
    const char *bad = "enter Nope\n";
    CHECK(!mt_script_parse(bad, strlen(bad), &g_s, err, sizeof err, &line));
    CHECK(strstr(err, "unknown scene") != NULL); CHECK_EQ(line, 1);
    bad = "enter\n";
    CHECK(!mt_script_parse(bad, strlen(bad), &g_s, err, sizeof err, &line));
    CHECK(strstr(err, "scene name") != NULL);
    bad = "enter TacticsTest extra\n";
    CHECK(!mt_script_parse(bad, strlen(bad), &g_s, err, sizeof err, &line));
}

/* ---- enter Campaign house: skip the interactive intro, start the campaign in the House ---- */
TEST(script_enter_campaign_house_mode_parses_and_other_modes_are_rejected) {
    char err[256]; int line = 0;
    const char *s = "enter Campaign house\nquit\n";
    CHECK(mt_script_parse(s, strlen(s), &g_s, err, sizeof err, &line));
    CHECK_EQ(g_s.d[0].kind, MT_D_ENTER); CHECK_EQ(g_s.d[0].scene, MT_SCENE_CAMPAIGN); CHECK_EQ(g_s.d[0].enterMode, MT_ENTER_HOUSE);
    s = "enter Campaign\nquit\n";
    CHECK(mt_script_parse(s, strlen(s), &g_s, err, sizeof err, &line));
    CHECK_EQ(g_s.d[0].enterMode, MT_ENTER_DEFAULT);
    const char *bad[] = { "enter TacticsTest house\n", "enter Campaign tower\n", "enter Campaign house now\n" };
    for (size_t i = 0; i < sizeof bad / sizeof bad[0]; i++) CHECK(!mt_script_parse(bad[i], strlen(bad[i]), &g_s, err, sizeof err, &line));
    CHECK_STR(mt_enter_mode_name(MT_ENTER_HOUSE), "house");
}

TEST(runner_enter_passes_the_mode_to_the_host_and_reports_it) {
    fk_reset("enter Campaign house\nquit\n");
    fk.enterResult = 1;
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);
    CHECK_EQ(fk.enterScene, MT_SCENE_CAMPAIGN); CHECK_EQ(fk.enterMode, MT_ENTER_HOUSE);
    CHECK(has(last_ev(), "\"name\":\"Campaign\"")); CHECK(has(last_ev(), "\"mode\":\"house\""));
    fk_reset("enter TacticsTest\nquit\n");
    fk.enterResult = 1;
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);
    CHECK_EQ(fk.enterMode, MT_ENTER_DEFAULT); CHECK(!has(last_ev(), "\"mode\""));   /* the default mode adds no key */
}

TEST(runner_enter_waits_for_console_then_calls_host_and_emits_enter_event) {
    fk_reset("enter TacticsTest\nquit\n");
    fk.ready = 0; fk.enterResult = 1;
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);
    CHECK_EQ(fk.enterCalls, 0);                       /* like cmd: no console yet, no call */
    CHECK_EQ(rr.state, MT_S_WAIT_CONSOLE);
    fk.ready = 1;
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);
    CHECK_EQ(fk.enterCalls, 1); CHECK_EQ(fk.enterScene, MT_SCENE_TACTICS_TEST);
    CHECK(has(last_ev(), "{\"ev\":\"enter\"")); CHECK(has(last_ev(), "\"line\":1"));
    CHECK(has(last_ev(), "\"name\":\"TacticsTest\"")); CHECK(has(last_ev(), "\"ok\":true"));
    CHECK(has(last_ev(), "\"detail\":\"fake enter 1\""));
    CHECK_EQ(rr.entered, 1);
    CHECK_EQ(mt_runner_step(&rr, &HOST), 0);          /* quit */
    CHECK(has(last_ev(), "\"code\":0")); CHECK_EQ(fk.exitCode, 0);
}

TEST(runner_enter_failure_ends_script_with_code_1_enter_failed) {
    fk_reset("enter TacticsTest\nquit\n");
    fk.enterResult = 0;
    CHECK_EQ(mt_runner_step(&rr, &HOST), 0);
    CHECK_EQ(fk.enterCalls, 1);
    CHECK_EQ(count_ev("enter"), 1);
    CHECK(has(ev(0), "\"ok\":false")); CHECK(has(ev(0), "\"detail\":\"fake enter 1\""));
    CHECK(has(last_ev(), "{\"ev\":\"end\"")); CHECK(has(last_ev(), "\"code\":1")); CHECK(has(last_ev(), "\"reason\":\"enter_failed\""));
    CHECK_EQ(fk.exitCode, 1); CHECK_EQ(fk.exitCalls, 1);
}

TEST(runner_enter_unavailable_ends_script_with_code_4) {
    fk_reset("enter TacticsTest\nquit\n");
    fk.enterResult = -1;
    CHECK_EQ(mt_runner_step(&rr, &HOST), 0);
    CHECK(has(ev(0), "{\"ev\":\"enter\"")); CHECK(has(ev(0), "\"ok\":false"));
    CHECK(has(last_ev(), "\"code\":4")); CHECK(has(last_ev(), "\"reason\":\"enter_unavailable\""));
    CHECK_EQ(fk.exitCode, 4);
}

TEST(runner_enter_retries_while_the_host_says_not_ready_then_enters) {
    fk_reset("enter TacticsTest\nquit\n");
    fk.enterResult = 2;                               /* 2 = not ready yet (e.g. the game has not made its director) */
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);
    CHECK_EQ(fk.enterCalls, 2);
    CHECK_EQ(count_ev("enter"), 0);                   /* no event while retrying */
    CHECK_EQ(rr.pc, 0);
    fk.enterResult = 1;
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);
    CHECK_EQ(count_ev("enter"), 1); CHECK(has(last_ev(), "\"ok\":true"));
    CHECK_EQ(rr.pc, 1);
}

TEST(runner_enter_not_ready_for_too_long_ends_with_code_1_enter_failed) {
    fk_reset("enter TacticsTest\nquit\n");
    fk.enterResult = 2;
    fk.now = 1000;
    mt_runner_step(&rr, &HOST);
    fk.now = 1000 + MT_CONSOLE_WAIT_MS + 1;           /* the same budget cmd gives the console */
    CHECK_EQ(mt_runner_step(&rr, &HOST), 0);
    CHECK(has(ev(0), "{\"ev\":\"enter\"")); CHECK(has(ev(0), "\"ok\":false")); CHECK(has(ev(0), "not ready"));
    CHECK(has(last_ev(), "\"reason\":\"enter_failed\"")); CHECK_EQ(fk.exitCode, 1);
}

TEST(runner_enter_twice_is_refused_without_a_host_call) {
    fk_reset("enter TacticsTest\nenter TacticsTest\nquit\n");
    fk.enterResult = 1;
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);          /* first: ok */
    CHECK_EQ(fk.enterCalls, 1);
    CHECK_EQ(mt_runner_step(&rr, &HOST), 0);          /* second: refused, script ends */
    CHECK_EQ(fk.enterCalls, 1);
    CHECK_EQ(count_ev("enter"), 2);
    CHECK(has(ev(1), "\"ok\":false")); CHECK(has(ev(1), "once"));
    CHECK(has(last_ev(), "\"reason\":\"enter_failed\"")); CHECK_EQ(fk.exitCode, 1);
}

TEST(runner_expect_console_fail_and_quit_code_1) {
    fk_reset("cmd x\nexpect console \"nope\"\nquit\n");
    fk_reply("No command named \"x\" found");
    steps_until_done(10);
    CHECK_EQ(count_ev("expect"), 1);
    CHECK(has(ev(2), "\"ok\":false")); CHECK(has(ev(2), "\"arg\":\"nope\""));
    CHECK(has(last_ev(), "\"code\":1")); CHECK(has(last_ev(), "\"expect_fail\":1"));
    CHECK_EQ(fk.exitCode, 1);
}

TEST(runner_window_resets_per_cmd) {
    fk_reset("cmd a\ncmd b\nexpect console \"from-a\"\nquit\n");
    fk_reply("from-a");
    mt_runner_step(&rr, &HOST);            /* cmd a -> from-a */
    fk_reply("from-b");
    mt_runner_step(&rr, &HOST);            /* cmd b -> from-b */
    mt_runner_step(&rr, &HOST);            /* expect from-a: not in b's window */
    CHECK(has(last_ev(), "\"ok\":false"));
}

TEST(runner_within_polls_later_steps_then_fails_after_deadline) {
    fk_reset("cmd a\nexpect console \"late\" within 3\nquit\n");
    mt_runner_step(&rr, &HOST);            /* cmd */
    mt_runner_step(&rr, &HOST);            /* expect: not yet, within 3 left */
    CHECK_EQ(count_ev("expect"), 0);
    fk_push("late");
    mt_runner_step(&rr, &HOST);            /* found on a later step */
    CHECK_EQ(count_ev("expect"), 1);
    CHECK(has(last_ev(), "\"ok\":true"));
    fk_reset("cmd a\nexpect console \"never\" within 2\nquit\n");
    mt_runner_step(&rr, &HOST);
    mt_runner_step(&rr, &HOST); mt_runner_step(&rr, &HOST); mt_runner_step(&rr, &HOST);
    CHECK_EQ(count_ev("expect"), 1);
    CHECK(has(last_ev(), "\"ok\":false"));
}

TEST(runner_noconsole_ok_and_fail) {
    fk_reset("cmd a\nexpect noconsole \"bad\"\nquit\n");
    fk_reply("fine");
    steps_until_done(10);
    CHECK(has(ev(2), "\"kind\":\"noconsole\"")); CHECK(has(ev(2), "\"ok\":true"));
    fk_reset("cmd a\nexpect noconsole \"bad\"\nquit\n");
    fk_reply("something bad happened");
    steps_until_done(10);
    CHECK(has(ev(2), "\"ok\":false")); CHECK(has(ev(2), "found in console line 0"));
}

TEST(runner_wait_frames_consumes_exactly_n_steps) {
    fk_reset("wait frames 3\nquit\n");
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);
    CHECK_EQ(count_ev("wait"), 0);
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);
    CHECK_EQ(count_ev("wait"), 1);
    CHECK(has(last_ev(), "\"kind\":\"frames\"")); CHECK(has(last_ev(), "\"n\":3")); CHECK(has(last_ev(), "\"actual\":3"));
    CHECK_EQ(mt_runner_step(&rr, &HOST), 0);
    CHECK(has(last_ev(), "\"frames\":4"));
}

TEST(runner_wait_turns_and_turn_events) {
    fk_reset("wait turns 2\nquit\n");
    mt_runner_step(&rr, &HOST);
    fk.turns = 1; mt_runner_step(&rr, &HOST);
    CHECK_EQ(count_ev("turn"), 1); CHECK(has(ev(0), "\"n\":1")); CHECK(has(ev(0), "\"round\":1"));
    CHECK_EQ(count_ev("wait"), 0);
    fk.turns = 3; fk.round = 2; mt_runner_step(&rr, &HOST);
    CHECK_EQ(count_ev("turn"), 3);
    CHECK(has(ev(2), "\"n\":3")); CHECK(has(ev(2), "\"round\":2"));
    CHECK_EQ(count_ev("wait"), 1);
    CHECK(has(last_ev(), "\"kind\":\"turns\""));
    mt_runner_step(&rr, &HOST);
    CHECK(has(last_ev(), "\"turns\":3"));
}

TEST(runner_wait_ms_uses_injected_clock) {
    fk_reset("wait ms 500\nquit\n");
    mt_runner_step(&rr, &HOST);
    fk.now += 200; mt_runner_step(&rr, &HOST);
    CHECK_EQ(count_ev("wait"), 0);
    fk.now += 300; mt_runner_step(&rr, &HOST);
    CHECK_EQ(count_ev("wait"), 1);
    CHECK(has(last_ev(), "\"kind\":\"ms\""));
    mt_runner_step(&rr, &HOST);
    CHECK(has(last_ev(), "\"elapsed_ms\":500"));
}

static void fk_two_units(void) {
    fk.unitsAvailable = 1; fk.unitCount = 2;
    snprintf(fk.units[0].name, 64, "Lumee"); snprintf(fk.units[0].cls, 64, "Fighter");
    fk.units[0].faction = 0; fk.units[0].move = 3; fk.units[0].act = 1; fk.units[0].turnKind = 2;
    fk.units[0].statusCount = 2; snprintf(fk.units[0].statuses[0], 32, "LuckUp"); snprintf(fk.units[0].statuses[1], 32, "JokersLuck");
    snprintf(fk.units[1].name, 64, "Rat"); snprintf(fk.units[1].cls, 64, "Rat"); fk.units[1].faction = 1;
}

TEST(runner_dump_with_and_without_units) {
    fk_reset("dump\nquit\n");
    steps_until_done(5);
    CHECK(has(ev(0), "{\"ev\":\"units\"")); CHECK(has(ev(0), "\"available\":false"));
    fk_reset("dump\nquit\n");
    fk_two_units();
    steps_until_done(5);
    CHECK(has(ev(0), "\"available\":true")); CHECK(has(ev(0), "\"count\":2"));
    CHECK(has(ev(0), "{\"i\":0,\"name\":\"Lumee\",\"class\":\"Fighter\",\"entry\":\"\",\"faction\":0,\"move\":3,\"act\":1,\"turnkind\":2,\"hp\":0,\"shield\":0,\"divineshield\":0,\"strength\":0,\"dexterity\":0,\"constitution\":0,\"intelligence\":0,\"speed\":0,\"charisma\":0,\"luck\":0,\"statuses\":[\"LuckUp\",\"JokersLuck\"],\"stacks\":[0,0]}"));
    CHECK(has(ev(0), "{\"i\":1,\"name\":\"Rat\""));
}

TEST(runner_expect_status_by_index_and_name) {
    fk_reset("expect status JokersLuck on 0\nexpect status JokersLuck on Lumee\nexpect status JokersLuck on Rat\nexpect status LuckUp on Nobody\nexpect status LuckUp on 9\nquit\n");
    fk_two_units();
    steps_until_done(10);
    CHECK(has(ev(0), "\"kind\":\"status\"")); CHECK(has(ev(0), "\"ok\":true"));
    CHECK(has(ev(1), "\"ok\":true"));
    CHECK(has(ev(2), "\"ok\":false"));
    CHECK(has(ev(3), "\"ok\":false")); CHECK(has(ev(3), "unit not found"));
    CHECK(has(ev(4), "\"ok\":false"));
    CHECK(has(last_ev(), "\"expect_pass\":2")); CHECK(has(last_ev(), "\"expect_fail\":3"));
}

/* ---- combat assertions: stacks in the units event, wait rounds, expect round, expect stacks (op | varied) ---- */
static void fk_two_units_with_stacks(void) {
    fk_two_units();
    fk.units[0].stacks[0] = 2; fk.units[0].stacks[1] = 7;    /* LuckUp 2, JokersLuck 7 */
}

TEST(script_wait_rounds_and_expect_round_and_expect_stacks_parse) {
    char err[256]; int line = 0;
    const char *s = "wait rounds 2\nexpect round >= 3\nexpect stacks JokersLuck on 0 == 7\nexpect stacks JokersLuck on \"Mr Whiskers\" != 0\nexpect stacks LuckUp on Lumee varied\nquit\n";
    CHECK(mt_script_parse(s, strlen(s), &g_s, err, sizeof err, &line));
    CHECK_EQ(g_s.count, 6);
    CHECK_EQ(g_s.d[0].kind, MT_D_WAIT_ROUNDS); CHECK_EQ(g_s.d[0].n, 2);
    CHECK_EQ(g_s.d[1].kind, MT_D_EXPECT_ROUND); CHECK_EQ(g_s.d[1].op, MT_OP_GE); CHECK_EQ(g_s.d[1].n, 3);
    CHECK_EQ(g_s.d[2].kind, MT_D_EXPECT_STACKS); CHECK_STR(g_s.d[2].a, "JokersLuck"); CHECK_EQ(g_s.d[2].unitIsIndex, 1); CHECK_EQ(g_s.d[2].n, 0); CHECK_EQ(g_s.d[2].op, MT_OP_EQ); CHECK_EQ(g_s.d[2].value, 7); CHECK_EQ(g_s.d[2].varied, 0);
    CHECK_EQ(g_s.d[3].kind, MT_D_EXPECT_STACKS); CHECK_STR(g_s.d[3].b, "Mr Whiskers"); CHECK_EQ(g_s.d[3].op, MT_OP_NE); CHECK_EQ(g_s.d[3].value, 0);
    CHECK_EQ(g_s.d[4].kind, MT_D_EXPECT_STACKS); CHECK_STR(g_s.d[4].b, "Lumee"); CHECK_EQ(g_s.d[4].varied, 1);
    const char *bad = "expect stacks LuckUp on 0\n";
    CHECK(!mt_script_parse(bad, strlen(bad), &g_s, err, sizeof err, &line));
    bad = "expect round 3\n";
    CHECK(!mt_script_parse(bad, strlen(bad), &g_s, err, sizeof err, &line));
    bad = "wait rounds 0\n";
    CHECK(!mt_script_parse(bad, strlen(bad), &g_s, err, sizeof err, &line));
}

TEST(runner_dump_emits_stacks_parallel_to_statuses) {
    fk_reset("dump\nquit\n");
    fk_two_units_with_stacks();
    steps_until_done(5);
    CHECK(has(ev(0), "\"statuses\":[\"LuckUp\",\"JokersLuck\"],\"stacks\":[2,7]}"));
    CHECK(has(ev(0), "{\"i\":1,\"name\":\"Rat\",\"class\":\"Rat\",\"entry\":\"\",\"faction\":1,\"move\":0,\"act\":0,\"turnkind\":0,\"hp\":0,\"shield\":0,\"divineshield\":0,\"strength\":0,\"dexterity\":0,\"constitution\":0,\"intelligence\":0,\"speed\":0,\"charisma\":0,\"luck\":0,\"statuses\":[],\"stacks\":[]}"));
}

TEST(runner_wait_rounds_advances_on_round_counter) {
    fk_reset("wait rounds 2\nquit\n");
    fk_two_units(); fk.round = 1;
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);
    fk.round = 2; CHECK_EQ(mt_runner_step(&rr, &HOST), 1);
    CHECK_EQ(count_ev("wait"), 0);
    fk.round = 3; CHECK_EQ(mt_runner_step(&rr, &HOST), 1);
    CHECK_EQ(count_ev("wait"), 1);
    CHECK(has(last_ev(), "\"kind\":\"rounds\"")); CHECK(has(last_ev(), "\"n\":2")); CHECK(has(last_ev(), "\"actual\":2"));
    CHECK_EQ(mt_runner_step(&rr, &HOST), 0);
}

TEST(runner_expect_round_ops_and_zero_without_combat) {
    fk_reset("expect round >= 2\nexpect round == 3\nquit\n");
    fk_two_units(); fk.round = 2;
    steps_until_done(5);
    CHECK(has(ev(0), "\"kind\":\"round\"")); CHECK(has(ev(0), "\"ok\":true")); CHECK(has(ev(0), "\"detail\":\"round 2\""));
    CHECK(has(ev(1), "\"ok\":false"));
    fk_reset("expect round == 0\nquit\n");          /* no combat: round reads as 0 */
    steps_until_done(5);
    CHECK(has(ev(0), "\"ok\":true"));
}

TEST(runner_expect_stacks_op_by_index_and_name_and_missing_status) {
    fk_reset("expect stacks JokersLuck on 0 == 7\nexpect stacks JokersLuck on Lumee > 5\nexpect stacks LuckUp on 0 == 3\nexpect stacks Poison on 0 == 0\nexpect stacks LuckUp on Rat == 0\nexpect stacks LuckUp on 9 == 0\nquit\n");
    fk_two_units_with_stacks();
    steps_until_done(10);
    CHECK(has(ev(0), "\"kind\":\"stacks\"")); CHECK(has(ev(0), "\"ok\":true")); CHECK(has(ev(0), "\"arg\":\"JokersLuck on 0 == 7\"")); CHECK(has(ev(0), "JokersLuck 7 on unit 0"));
    CHECK(has(ev(1), "\"ok\":true"));
    CHECK(has(ev(2), "\"ok\":false")); CHECK(has(ev(2), "LuckUp 2 on unit 0"));
    CHECK(has(ev(3), "\"ok\":false")); CHECK(has(ev(3), "absent"));
    CHECK(has(ev(4), "\"ok\":false")); CHECK(has(ev(4), "absent"));
    CHECK(has(ev(5), "\"ok\":false")); CHECK(has(ev(5), "unit not found"));
    CHECK(has(last_ev(), "\"expect_pass\":2")); CHECK(has(last_ev(), "\"expect_fail\":4"));
}

/* ---- expect unit <unit> <field> <op> <value>: name|class (quoted, == !=), faction|move|act|turnkind (int, any op) ---- */
TEST(script_expect_unit_parses_fields_ops_and_rejects_bad_forms) {
    char err[256]; int line = 0;
    const char *s = "expect unit 6 faction == 1\nexpect unit \"Lil' Rat\" name == \"Lil' Rat\"\nexpect unit Pooter turnkind >= 0\nexpect unit 0 class != \"Mage\"\nquit\n";
    CHECK(mt_script_parse(s, strlen(s), &g_s, err, sizeof err, &line));
    CHECK_EQ(g_s.count, 5);
    CHECK_EQ(g_s.d[0].kind, MT_D_EXPECT_UNIT); CHECK_EQ(g_s.d[0].unitIsIndex, 1); CHECK_EQ(g_s.d[0].n, 6); CHECK_EQ(g_s.d[0].field, MT_F_FACTION); CHECK_EQ(g_s.d[0].op, MT_OP_EQ); CHECK_EQ(g_s.d[0].value, 1);
    CHECK_EQ(g_s.d[1].kind, MT_D_EXPECT_UNIT); CHECK_EQ(g_s.d[1].unitIsIndex, 0); CHECK_STR(g_s.d[1].b, "Lil' Rat"); CHECK_EQ(g_s.d[1].field, MT_F_NAME); CHECK_EQ(g_s.d[1].op, MT_OP_EQ); CHECK_STR(g_s.d[1].a, "Lil' Rat");
    CHECK_EQ(g_s.d[2].kind, MT_D_EXPECT_UNIT); CHECK_STR(g_s.d[2].b, "Pooter"); CHECK_EQ(g_s.d[2].field, MT_F_TURNKIND); CHECK_EQ(g_s.d[2].op, MT_OP_GE); CHECK_EQ(g_s.d[2].value, 0);
    CHECK_EQ(g_s.d[3].field, MT_F_CLASS); CHECK_EQ(g_s.d[3].op, MT_OP_NE); CHECK_STR(g_s.d[3].a, "Mage");
    const char *bad[] = { "expect unit 6 faction\n", "expect unit 6 mana == 1\n", "expect unit 6 name >= \"x\"\n", "expect unit 6 name == bare\n",
                          "expect unit faction == 1\n", "expect unit 6 faction == x\n", "expect unit 6 move == 1 extra\n", "expect unit\n" };
    for (size_t i = 0; i < sizeof bad / sizeof bad[0]; i++) CHECK(!mt_script_parse(bad[i], strlen(bad[i]), &g_s, err, sizeof err, &line));
}

TEST(runner_expect_unit_by_index_and_name_string_and_int_fields) {
    fk_reset("expect unit 1 faction == 1\nexpect unit Lumee move >= 3\nexpect unit 0 name == \"Lumee\"\nexpect unit 0 class != \"Fighter\"\nexpect unit \"Lumee\" act == 1\nexpect unit 0 turnkind < 2\nexpect unit 9 faction == 1\nexpect unit Nope name == \"x\"\nquit\n");
    fk_two_units();
    steps_until_done(12);
    CHECK(has(ev(0), "\"kind\":\"unit\"")); CHECK(has(ev(0), "\"ok\":true")); CHECK(has(ev(0), "\"arg\":\"1 faction == 1\"")); CHECK(has(ev(0), "\"detail\":\"unit 1 \\\"Rat\\\": faction 1\""));
    CHECK(has(ev(1), "\"ok\":true")); CHECK(has(ev(1), "\"arg\":\"Lumee move >= 3\"")); CHECK(has(ev(1), "move 3"));
    CHECK(has(ev(2), "\"ok\":true")); CHECK(has(ev(2), "\"arg\":\"0 name == \\\"Lumee\\\"\"")); CHECK(has(ev(2), "name \\\"Lumee\\\""));
    CHECK(has(ev(3), "\"ok\":false")); CHECK(has(ev(3), "class \\\"Fighter\\\""));
    CHECK(has(ev(4), "\"ok\":true")); CHECK(has(ev(4), "\"arg\":\"Lumee act == 1\""));   /* the unit is quoted in the arg only when its name has a space */
    CHECK(has(ev(5), "\"ok\":false")); CHECK(has(ev(5), "turnkind 2"));
    CHECK(has(ev(6), "\"ok\":false")); CHECK(has(ev(6), "unit not found: index 9 of 2"));
    CHECK(has(ev(7), "\"ok\":false")); CHECK(has(ev(7), "unit not found: \\\"Nope\\\""));
    CHECK(has(last_ev(), "\"expect_pass\":4")); CHECK(has(last_ev(), "\"expect_fail\":4"));
    fk_reset("expect unit 0 faction == 0\nquit\n");     /* no combat */
    steps_until_done(5);
    CHECK(has(ev(0), "\"ok\":false")); CHECK(has(ev(0), "no combat (units unavailable)"));
}

/* ---- interactive mode: a request queue fed by the pipe thread, served by the runner on the frame thread ---- */
TEST(queue_push_take_fifo_full_and_text_limit) {
    MtQueue q;
    mt_queue_init(&q);
    CHECK(mt_queue_take(&q) == NULL);
    for (int i = 0; i < MT_Q_SLOTS; i++) { char t[32]; snprintf(t, sizeof t, "cmd %d", i); CHECK(mt_queue_push(&q, 100 + i, MT_QOP_EXEC, t, 3) != NULL); }
    CHECK(mt_queue_push(&q, 999, MT_QOP_EXEC, "one too many", 3) == NULL);          /* full */
    MtRequest *a = mt_queue_take(&q);
    CHECK(a != NULL); CHECK_EQ(a->state, MT_Q_ACTIVE); CHECK_EQ(a->id, 100); CHECK_STR(a->text, "cmd 0"); CHECK_EQ(a->op, MT_QOP_EXEC); CHECK_EQ(a->frames, 3);
    CHECK(mt_queue_take(&q) == NULL);                                               /* one active at a time */
    mt_queue_complete(a, "{\"ev\":\"exec\",\"id\":100}");
    CHECK_EQ(a->state, MT_Q_DONE); CHECK_STR(a->reply, "{\"ev\":\"exec\",\"id\":100}");
    MtRequest *b = mt_queue_take(&q);
    CHECK(b != NULL); CHECK_EQ(b->id, 101);                                          /* FIFO */
    mt_queue_release(a);
    CHECK_EQ(a->state, MT_Q_FREE);
    CHECK(mt_queue_push(&q, 200, MT_QOP_DUMP, "", 0) != NULL);                      /* the freed slot is reusable */
    char big[MT_MAX_CMD + 2]; memset(big, 'x', sizeof big - 1); big[sizeof big - 1] = 0;
    CHECK(mt_queue_push(&q, 201, MT_QOP_EXEC, big, 3) == NULL);                     /* text over MT_MAX_CMD */
}

TEST(pipe_parse_request_minimal_json_and_errors) {
    long id = -1; MtQOp op; char text[MT_Q_TEXT]; int frames = -1; char err[128];
    CHECK(mt_pipe_parse_request("{\"id\":3,\"op\":\"exec\",\"text\":\"spawn Rat\"}", &id, &op, text, sizeof text, &frames, err, sizeof err));
    CHECK_EQ(id, 3); CHECK_EQ(op, MT_QOP_EXEC); CHECK_STR(text, "spawn Rat"); CHECK_EQ(frames, 3);   /* frames default 3 */
    CHECK(mt_pipe_parse_request("{\"op\":\"exec\",\"frames\":900,\"id\":7,\"text\":\"say \\\"hi\\\" \\\\ ok\"}", &id, &op, text, sizeof text, &frames, err, sizeof err));
    CHECK_EQ(id, 7); CHECK_STR(text, "say \"hi\" \\ ok"); CHECK_EQ(frames, 600);                     /* escapes; frames clamped to 600 */
    CHECK(mt_pipe_parse_request("{\"id\":1,\"op\":\"dump\"}", &id, &op, text, sizeof text, &frames, err, sizeof err));
    CHECK_EQ(op, MT_QOP_DUMP); CHECK_STR(text, "");
    CHECK(mt_pipe_parse_request("{\"id\":2,\"op\":\"quit\"}", &id, &op, text, sizeof text, &frames, err, sizeof err));
    CHECK_EQ(op, MT_QOP_QUIT);
    CHECK(!mt_pipe_parse_request("{\"op\":\"exec\",\"text\":\"x\"}", &id, &op, text, sizeof text, &frames, err, sizeof err)); CHECK(has(err, "id"));
    CHECK(!mt_pipe_parse_request("{\"id\":1,\"text\":\"x\"}", &id, &op, text, sizeof text, &frames, err, sizeof err)); CHECK(has(err, "op"));
    CHECK(!mt_pipe_parse_request("{\"id\":1,\"op\":\"fly\"}", &id, &op, text, sizeof text, &frames, err, sizeof err)); CHECK(has(err, "op"));
    CHECK(!mt_pipe_parse_request("{\"id\":1,\"op\":\"exec\"}", &id, &op, text, sizeof text, &frames, err, sizeof err)); CHECK(has(err, "text"));
    CHECK(!mt_pipe_parse_request("not json", &id, &op, text, sizeof text, &frames, err, sizeof err));
    char out[256];
    CHECK(mt_pipe_error_reply(out, sizeof out, 5, "queue full"));
    CHECK_STR(out, "{\"ev\":\"exec\",\"id\":5,\"ok\":false,\"error\":\"queue full\"}");
}

static MtQueue g_q;
TEST(runner_serves_exec_during_wait_frames_collects_lines_for_n_frames_and_replies_with_the_event) {
    fk_reset("wait frames 10\nquit\n");
    mt_queue_init(&g_q);
    mt_runner_attach_queue(&rr, &g_q);
    MtRequest *req = mt_queue_push(&g_q, 42, MT_QOP_EXEC, "spawn Rat", 2);
    fk_reply("Spawned Rat");                                   /* pushed when the cmd executes */
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);                   /* step 1: wait starts; the request is served in the same step */
    CHECK_EQ(fk.cmdCount, 1); CHECK_STR(fk.cmds[0], "spawn Rat");
    CHECK_EQ(req->state, MT_Q_ACTIVE);                          /* still collecting */
    fk_push("Executed: spawn Rat");                             /* a line that arrives one frame later */
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);                   /* 2 frames after the exec: complete */
    CHECK_EQ(req->state, MT_Q_DONE);
    CHECK(has(req->reply, "{\"ev\":\"exec\"")); CHECK(has(req->reply, "\"id\":42")); CHECK(has(req->reply, "\"op\":\"exec\""));
    CHECK(has(req->reply, "\"text\":\"spawn Rat\"")); CHECK(has(req->reply, "\"ok\":true"));
    CHECK(has(req->reply, "\"lines\":[\"Spawned Rat\",\"Executed: spawn Rat\"]"));
    CHECK(has(req->reply, "\"frame\":"));
    CHECK_EQ(count_ev("exec"), 1); CHECK_STR(last_ev(), req->reply);   /* the same line went to the result file */
    int n = 3;
    while (mt_runner_step(&rr, &HOST)) n++;
    CHECK_EQ(n, 10); CHECK_EQ(count_ev("wait"), 1); CHECK(has(ev(3), "\"actual\":10"));   /* events: console, console, exec, wait, end: the wait still lasted exactly 10 frames; quit was the 11th step */
    CHECK(has(last_ev(), "\"reason\":\"quit\""));
}

TEST(runner_does_not_serve_while_waiting_for_the_console_or_between_run_directives) {
    fk_reset("cmd listcmds\nlog \"a\"\nlog \"b\"\nwait frames 2\nquit\n");
    mt_queue_init(&g_q);
    mt_runner_attach_queue(&rr, &g_q);
    fk.ready = 0;
    MtRequest *req = mt_queue_push(&g_q, 1, MT_QOP_EXEC, "spawn Rat", 1);
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);                   /* cmd waits for the console: not served */
    CHECK_EQ(req->state, MT_Q_PENDING); CHECK_EQ(fk.cmdCount, 0);
    fk.ready = 1;
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);                   /* cmd listcmds runs (MT_S_RUN): not served between directives */
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);                   /* log a */
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);                   /* log b */
    CHECK_EQ(req->state, MT_Q_PENDING); CHECK_EQ(fk.cmdCount, 1);
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);                   /* wait frames 2 starts: served now */
    CHECK_EQ(fk.cmdCount, 2); CHECK_STR(fk.cmds[1], "spawn Rat");
}

TEST(runner_does_not_serve_before_the_console_exists) {
    /* OBSERVED 2026-10-20: an exec served at frame 1 (inside `wait frames 120`, before DebugConsole::init) crashed
     * the game inside DebugConsole::Execute; requests wait for the console like a cmd directive does */
    fk_reset("wait frames 5\nquit\n");
    mt_queue_init(&g_q);
    mt_runner_attach_queue(&rr, &g_q);
    fk.ready = 0;
    MtRequest *req = mt_queue_push(&g_q, 1, MT_QOP_EXEC, "spawn Rat", 1);
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);
    CHECK_EQ(req->state, MT_Q_PENDING); CHECK_EQ(fk.cmdCount, 0);
    fk.ready = 1;
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);
    CHECK_EQ(fk.cmdCount, 1); CHECK_STR(fk.cmds[0], "spawn Rat");
}

TEST(runner_interactive_eof_goes_idle_emits_idle_once_and_serves_dump) {
    fk_reset("wait frames 1\n");
    mt_queue_init(&g_q);
    mt_runner_attach_queue(&rr, &g_q);
    mt_runner_set_interactive(&rr, 1);
    fk_two_units();
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);                   /* wait frames 1 */
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);                   /* eof: idle, not end */
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);
    CHECK_EQ(count_ev("idle"), 1); CHECK_EQ(count_ev("end"), 0); CHECK_EQ(fk.exitCalls, 0);
    CHECK_EQ(rr.state, MT_S_IDLE);
    MtRequest *req = mt_queue_push(&g_q, 9, MT_QOP_DUMP, "", 0);
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);
    CHECK_EQ(req->state, MT_Q_DONE);
    CHECK(has(req->reply, "{\"ev\":\"units\"")); CHECK(has(req->reply, "\"id\":9")); CHECK(has(req->reply, "\"count\":2"));
    CHECK_EQ(count_ev("units"), 1);
}

TEST(runner_quit_request_ends_with_reason_quit_and_the_expect_derived_code) {
    fk_reset("expect units == 99\nwait frames 100\n");
    mt_queue_init(&g_q);
    mt_runner_attach_queue(&rr, &g_q);
    mt_runner_set_interactive(&rr, 1);
    fk_two_units();
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);                   /* expect fails */
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);                   /* wait starts */
    MtRequest *req = mt_queue_push(&g_q, 3, MT_QOP_QUIT, "", 0);
    CHECK_EQ(mt_runner_step(&rr, &HOST), 0);                   /* quit during the wait */
    CHECK_EQ(req->state, MT_Q_DONE);
    CHECK(has(req->reply, "\"op\":\"quit\"")); CHECK(has(req->reply, "\"id\":3")); CHECK(has(req->reply, "\"ok\":true"));
    CHECK_EQ(fk.pipeReplies, 1); CHECK_STR(fk.pipeReply, req->reply);   /* written to the pipe before the exit */
    CHECK(has(last_ev(), "\"reason\":\"quit\"")); CHECK(has(last_ev(), "\"code\":1"));
    CHECK_EQ(fk.exitCalls, 1); CHECK_EQ(fk.exitCode, 1);
}

TEST(runner_non_interactive_eof_still_ends) {
    fk_reset("wait frames 1\n");
    mt_queue_init(&g_q);
    mt_runner_attach_queue(&rr, &g_q);                          /* a queue without interactive: eof ends as before */
    steps_until_done(5);
    CHECK(has(last_ev(), "\"reason\":\"eof\"")); CHECK_EQ(count_ev("idle"), 0); CHECK_EQ(fk.exitCalls, 1);
}

TEST(args_pipe_flag) {
    MtArgs a;
    CHECK(mt_args_parse("game.exe -mewtest s.mewtest", &a)); CHECK_EQ(a.pipe, 0);
    CHECK(mt_args_parse("game.exe -mewtest s.mewtest -mewtest_pipe 1", &a)); CHECK_EQ(a.pipe, 1);
    CHECK(!mt_args_parse("game.exe -mewtest s.mewtest -mewtest_pipe yes", &a)); CHECK(has(a.err, "-mewtest_pipe"));
}

TEST(script_enter_errors_name_both_scenes) {
    char err[256]; int line = 0;
    const char *bad = "enter Nope\n";
    CHECK(!mt_script_parse(bad, strlen(bad), &g_s, err, sizeof err, &line)); CHECK(has(err, "TacticsTest|Campaign"));
    bad = "enter\n";
    CHECK(!mt_script_parse(bad, strlen(bad), &g_s, err, sizeof err, &line)); CHECK(has(err, "TacticsTest|Campaign"));
}

TEST(runner_expect_stacks_varied_needs_two_distinct_recorded_values) {
    fk_reset("dump\nexpect stacks LuckUp on 0 varied\ndump\nexpect stacks LuckUp on 0 varied\nexpect stacks LuckUp on 0 == 5\nexpect stacks LuckUp on 0 varied\nquit\n");
    fk_two_units_with_stacks();
    mt_runner_step(&rr, &HOST);                 /* dump: records LuckUp 2 */
    mt_runner_step(&rr, &HOST);                 /* varied: one value so far -> fail */
    CHECK(has(last_ev(), "\"kind\":\"stacks\"")); CHECK(has(last_ev(), "\"ok\":false")); CHECK(has(last_ev(), "1 distinct"));
    mt_runner_step(&rr, &HOST);                 /* dump again: still 2 */
    mt_runner_step(&rr, &HOST);                 /* varied: still one value */
    CHECK(has(last_ev(), "\"ok\":false"));
    fk.units[0].stacks[0] = 5;
    mt_runner_step(&rr, &HOST);                 /* == 5 records 5 (ok) */
    CHECK(has(last_ev(), "\"ok\":true"));
    mt_runner_step(&rr, &HOST);                 /* varied: 2 and 5 -> ok */
    CHECK(has(last_ev(), "\"ok\":true")); CHECK(has(last_ev(), "2 distinct"));
}

/* ---- seed <N>: pin the game's RNG (TLS+0x178) through the host so a fight is reproducible ---- */
TEST(script_seed_parses_an_unsigned_64_bit_value_and_rejects_junk) {
    char err[256]; int line = 0;
    const char *s = "seed 42\nseed 18446744073709551615\nquit\n";
    CHECK(mt_script_parse(s, strlen(s), &g_s, err, sizeof err, &line));
    CHECK_EQ(g_s.d[0].kind, MT_D_SEED); CHECK_EQ((long long)g_s.d[0].seed, 42);
    CHECK(g_s.d[1].seed == 18446744073709551615ULL);
    const char *bad = "seed\n";
    CHECK(!mt_script_parse(bad, strlen(bad), &g_s, err, sizeof err, &line));
    bad = "seed -1\n";
    CHECK(!mt_script_parse(bad, strlen(bad), &g_s, err, sizeof err, &line));
    bad = "seed 42 43\n";
    CHECK(!mt_script_parse(bad, strlen(bad), &g_s, err, sizeof err, &line));
}

TEST(runner_seed_calls_host_emits_seed_event_and_continues) {
    fk_reset("seed 42\nquit\n");
    fk.seedResult = 1;
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);
    CHECK_EQ(fk.seedCalls, 1); CHECK(fk.seedValue == 42ULL);
    CHECK(has(ev(0), "{\"ev\":\"seed\"")); CHECK(has(ev(0), "\"line\":1")); CHECK(has(ev(0), "\"seed\":42")); CHECK(has(ev(0), "\"ok\":true"));
    CHECK(has(ev(0), "\"detail\":\"fake seeded 42\""));
    CHECK_EQ(mt_runner_step(&rr, &HOST), 0);
    CHECK(has(last_ev(), "\"code\":0"));
}

TEST(runner_seed_retries_while_not_ready_then_seeds) {
    /* the game reseeds during its own startup; the host answers 2 until that is over (director exists) */
    fk_reset("seed 42\nquit\n");
    fk.seedResult = 2;
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);
    CHECK_EQ(fk.seedCalls, 2); CHECK_EQ(count_ev("seed"), 0); CHECK_EQ(rr.pc, 0);
    fk.seedResult = 1;
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);
    CHECK_EQ(count_ev("seed"), 1); CHECK(has(last_ev(), "\"ok\":true")); CHECK_EQ(rr.pc, 1);
}

TEST(runner_seed_refused_or_unavailable_ends_the_script) {
    fk_reset("seed 7\nquit\n");
    fk.seedResult = 0;
    CHECK_EQ(mt_runner_step(&rr, &HOST), 0);
    CHECK(has(ev(0), "\"ok\":false"));
    CHECK(has(last_ev(), "\"code\":1")); CHECK(has(last_ev(), "\"reason\":\"seed_failed\""));
    fk_reset("seed 7\nquit\n");
    fk.seedResult = -1;
    CHECK_EQ(mt_runner_step(&rr, &HOST), 0);
    CHECK(has(last_ev(), "\"code\":4")); CHECK(has(last_ev(), "\"reason\":\"seed_unavailable\""));
}

/* ---- shot "<label>": emit a shot event, then hold the frame for MT_SHOT_HOLD_MS so the runner can capture it ---- */
TEST(script_shot_parses_a_quoted_label_and_rejects_bare_or_missing) {
    char err[256]; int line = 0;
    const char *s = "shot \"round one\"\nquit\n";
    CHECK(mt_script_parse(s, strlen(s), &g_s, err, sizeof err, &line));
    CHECK_EQ(g_s.d[0].kind, MT_D_SHOT); CHECK_STR(g_s.d[0].a, "round one");
    const char *bad = "shot bare\n";
    CHECK(!mt_script_parse(bad, strlen(bad), &g_s, err, sizeof err, &line));
    bad = "shot\n";
    CHECK(!mt_script_parse(bad, strlen(bad), &g_s, err, sizeof err, &line));
}

TEST(runner_shot_emits_event_then_holds_then_continues) {
    fk_reset("shot \"menu\"\nquit\n");
    fk.now = 1000;
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);
    CHECK_EQ(count_ev("shot"), 1);
    CHECK(has(ev(0), "{\"ev\":\"shot\"")); CHECK(has(ev(0), "\"line\":1")); CHECK(has(ev(0), "\"label\":\"menu\""));
    CHECK(has(ev(0), "\"hold_ms\":"));
    fk.now = 1000 + MT_SHOT_HOLD_MS - 1;
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);          /* still holding: quit not reached */
    CHECK_EQ(count_ev("end"), 0);
    fk.now = 1000 + MT_SHOT_HOLD_MS + 1;
    mt_runner_step(&rr, &HOST);                       /* hold over -> advance */
    mt_runner_step(&rr, &HOST);                       /* quit */
    CHECK_EQ(count_ev("end"), 1); CHECK_EQ(fk.exitCode, 0);
}

TEST(runner_expect_status_without_combat_fails) {
    fk_reset("expect status LuckUp on 0\nquit\n");
    steps_until_done(5);
    CHECK(has(ev(0), "\"ok\":false")); CHECK(has(ev(0), "no combat"));
}

TEST(runner_expect_units_ops) {
    fk_reset("expect units >= 2\nexpect units == 2\nexpect units > 2\nexpect units != 2\nexpect units < 3\nexpect units <= 1\nquit\n");
    fk_two_units();
    steps_until_done(10);
    CHECK(has(ev(0), "\"ok\":true")); CHECK(has(ev(1), "\"ok\":true")); CHECK(has(ev(2), "\"ok\":false"));
    CHECK(has(ev(3), "\"ok\":false")); CHECK(has(ev(4), "\"ok\":true")); CHECK(has(ev(5), "\"ok\":false"));
    CHECK(has(ev(0), "\"arg\":\">= 2\"")); CHECK(has(ev(0), "\"detail\":\"2 units\""));
    fk_reset("expect units == 0\nquit\n");
    steps_until_done(5);
    CHECK(has(ev(0), "\"ok\":true")); /* no combat counts as 0 units */
}

TEST(runner_quit_codes_and_eof) {
    fk_reset("quit 5\n");
    steps_until_done(5);
    CHECK(has(last_ev(), "\"code\":5")); CHECK_EQ(fk.exitCode, 5);
    fk_reset("log \"done\"\n");
    steps_until_done(5);
    CHECK(has(ev(0), "{\"ev\":\"log\"")); CHECK(has(ev(0), "\"text\":\"done\""));
    CHECK(has(last_ev(), "\"reason\":\"eof\"")); CHECK(has(last_ev(), "\"code\":0"));
    fk_reset("cmd a\nexpect console \"x\"\n");
    steps_until_done(5);
    CHECK(has(last_ev(), "\"reason\":\"eof\"")); CHECK(has(last_ev(), "\"code\":1"));
}

TEST(runner_cmd_waits_for_console_then_gives_up_with_4) {
    fk_reset("cmd listcmds\nquit\n");
    fk.ready = 0;
    for (int i = 0; i < 5; i++) CHECK_EQ(mt_runner_step(&rr, &HOST), 1);
    CHECK_EQ(fk.cmdCount, 0);
    fk.ready = 1;
    mt_runner_step(&rr, &HOST);
    CHECK_EQ(fk.cmdCount, 1);
    /* the wait is wall-clock, not frame-count: with vsync off and a hidden window the game runs
     * hundreds of frames per second and a cold-cache load outlasted the old 1800-frame budget */
    fk_reset("cmd listcmds\nquit\n");
    fk.ready = 0;
    int n = steps_until_done(5000);
    CHECK_EQ(n, 5000); /* time did not advance: still waiting after 5000 frames */
    CHECK_EQ(fk.exitCalls, 0);
    fk.now += MT_CONSOLE_WAIT_MS;
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1); /* exactly at the budget: still waiting */
    fk.now += 1;
    CHECK_EQ(mt_runner_step(&rr, &HOST), 0);
    CHECK(has(last_ev(), "\"code\":4")); CHECK(has(last_ev(), "\"reason\":\"console_unavailable\""));
    CHECK_EQ(fk.exitCode, 4);
    /* the console appearing late is fine */
    fk_reset("cmd listcmds\nquit\n");
    fk.ready = 0;
    fk.now += MT_CONSOLE_WAIT_MS - 1;
    CHECK_EQ(mt_runner_step(&rr, &HOST), 1);
    fk.ready = 1;
    mt_runner_step(&rr, &HOST);
    CHECK_EQ(fk.cmdCount, 1);
}

TEST(runner_one_directive_per_step) {
    fk_reset("log \"a\"\nlog \"b\"\nlog \"c\"\nquit\n");
    mt_runner_step(&rr, &HOST);
    CHECK_EQ(fk.emitCount, 1);
    mt_runner_step(&rr, &HOST);
    CHECK_EQ(fk.emitCount, 2);
}

TEST(runner_abort_emits_end_once_and_does_not_request_exit) {
    fk_reset("wait frames 100\nquit\n");
    mt_runner_step(&rr, &HOST);
    mt_runner_abort(&rr, &HOST, 2, "timeout");
    CHECK_EQ(count_ev("end"), 1);
    CHECK(has(last_ev(), "\"code\":2")); CHECK(has(last_ev(), "\"reason\":\"timeout\""));
    CHECK_EQ(fk.exitCalls, 0);
    mt_runner_abort(&rr, &HOST, 3, "crash");
    CHECK_EQ(count_ev("end"), 1);
    CHECK_EQ(mt_runner_step(&rr, &HOST), 0);
}

TEST(runner_log_escapes) {
    fk_reset("log \"a\\\"b\"\n");
    mt_runner_step(&rr, &HOST);
    CHECK(has(ev(0), "\"text\":\"a\\\"b\""));
}

TEST(runner_events_carry_t_and_frame) {
    fk_reset("log \"x\"\nquit\n");
    fk.now = 1250;
    mt_runner_step(&rr, &HOST);
    CHECK(has(ev(0), "\"t\":250")); CHECK(has(ev(0), "\"frame\":1"));
}

/* ====================================================================== */
/* mt_exit — the watchdog decision (TODO.md: -mewtest_clean never exited)   */
/* ====================================================================== */
static MtExitState xs(void) { MtExitState s; memset(&s, 0, sizeof s); s.exitCode = -1; s.timeoutMs = 120000; return s; }

TEST(exit_clean_grace_fires_after_grace_without_any_active_flag) {
    MtExitState s = xs();
    s.cleanRequested = 1; s.cleanTick = 1000; s.exitCode = 1;
    int code = -7;
    CHECK_EQ(mt_exit_decide(&s, 1000 + MT_GRACE_CLEAN_MS, &code), MT_X_NONE);       /* exactly the grace: not yet */
    CHECK_EQ(mt_exit_decide(&s, 1000 + MT_GRACE_CLEAN_MS + 1, &code), MT_X_EXIT_CLEAN);
    CHECK_EQ(code, 1);
}

TEST(exit_clean_unset_code_becomes_4) {
    MtExitState s = xs();
    s.cleanRequested = 1; s.cleanTick = 0; s.exitCode = -1;
    int code = 0;
    CHECK_EQ(mt_exit_decide(&s, MT_GRACE_CLEAN_MS + 1, &code), MT_X_EXIT_CLEAN);
    CHECK_EQ(code, 4);
}

TEST(exit_crash_grace_wins_over_clean) {
    MtExitState s = xs();
    s.crashed = 1; s.crashTick = 0; s.cleanRequested = 1; s.cleanTick = 0; s.exitCode = 0;
    int code = 0;
    CHECK_EQ(mt_exit_decide(&s, MT_GRACE_CRASH_MS, &code), MT_X_EXIT_CLEAN);          /* clean grace already over, crash not yet */
    CHECK_EQ(mt_exit_decide(&s, MT_GRACE_CRASH_MS + 1, &code), MT_X_EXIT_CRASH);
    CHECK_EQ(code, 3);
}

TEST(exit_timeout_only_while_running) {
    MtExitState s = xs();
    s.startTick = 0; s.timeoutMs = 1000;
    int code = 0;
    CHECK_EQ(mt_exit_decide(&s, 1000, &code), MT_X_NONE);
    CHECK_EQ(mt_exit_decide(&s, 1001, &code), MT_X_TIMEOUT);
    CHECK_EQ(code, 2);
    s.runnerFinished = 1;
    CHECK_EQ(mt_exit_decide(&s, 5000, &code), MT_X_NONE);                              /* end written: no timeout */
    s.runnerFinished = 0; s.cleanRequested = 1; s.cleanTick = 4000;
    CHECK_EQ(mt_exit_decide(&s, 5000, &code), MT_X_NONE);                              /* clean branch owns the exit now */
}

TEST(exit_fires_once) {
    MtExitState s = xs();
    s.fired = 1;
    s.crashed = 1; s.cleanRequested = 1; s.timeoutMs = 1;
    int code = 0;
    CHECK_EQ(mt_exit_decide(&s, 100000, &code), MT_X_NONE);
}

TEST(exit_tick_wraparound) {
    MtExitState s = xs();
    s.cleanRequested = 1; s.cleanTick = 0xFFFFF000u; s.exitCode = 0;
    int code = -1;
    CHECK_EQ(mt_exit_decide(&s, 0x00000BB9u, &code), MT_X_EXIT_CLEAN);                /* 7097 ms later, across the wrap */
    CHECK_EQ(code, 0);
}

/* ====================================================================== */
/* GON at runtime (2026-10-22): the walker, entry/hp/stats in the units    */
/* event, expect gon, expect unit hp|shield|divineshield|<stat>|entry      */
/* ====================================================================== */
static void fk_units_with_numbers(void) {
    fk_two_units();
    snprintf(fk.units[0].entry, MT_UNIT_NAME, "PlayerCat");
    fk.units[0].hp = 23; fk.units[0].shield = 2; fk.units[0].divineShield = 1;
    for (int k = 0; k < MT_STAT_COUNT; k++) fk.units[0].stats[k] = 4 + k;       /* 4 5 6 7 8 9 10 */
    snprintf(fk.units[1].entry, MT_UNIT_NAME, "Pooter");
    fk.units[1].hp = 12;
    for (int k = 0; k < MT_STAT_COUNT; k++) fk.units[1].stats[k] = 5;
    fk.units[1].stats[MT_STAT_SPEED] = 15;
    fg_tree();
    fk.gon[1] = fg_node(0);    /* unit 1 carries the fake entry; unit 0 has none (an unreadable +0x240) */
}

TEST(gon_stat_names_are_the_seven_data_characters_keys_in_order) {
    CHECK_EQ(MT_STAT_COUNT, 7);
    CHECK_STR(mt_stat_name(0), "strength"); CHECK_STR(mt_stat_name(1), "dexterity"); CHECK_STR(mt_stat_name(2), "constitution");
    CHECK_STR(mt_stat_name(3), "intelligence"); CHECK_STR(mt_stat_name(MT_STAT_SPEED), "speed"); CHECK_STR(mt_stat_name(5), "charisma"); CHECK_STR(mt_stat_name(6), "luck");
    CHECK_STR(mt_gon_type_name(0), "null"); CHECK_STR(mt_gon_type_name(1), "string"); CHECK_STR(mt_gon_type_name(2), "number");
    CHECK_STR(mt_gon_type_name(3), "object"); CHECK_STR(mt_gon_type_name(4), "array"); CHECK_STR(mt_gon_type_name(5), "bool"); CHECK_STR(mt_gon_type_name(9), "type 9");
}

TEST(gon_walker_by_name_and_index_scalars_containers_missing_and_unreadable) {
    fg_tree();
    MtGonValue v; char why[200];
    CHECK_EQ(mt_gon_get(fg_mem_read, NULL, fg_node(0), "properties.health", &v, why, sizeof why), 1);
    CHECK_EQ(v.type, 2); CHECK_EQ(v.i, 12); CHECK(v.d == 12.0); CHECK_STR(v.text, "12"); CHECK_EQ(v.childCount, 0);
    CHECK_EQ(mt_gon_get(fg_mem_read, NULL, fg_node(0), "properties.flying", &v, why, sizeof why), 1);
    CHECK_EQ(v.type, 5); CHECK_EQ(v.b, 1); CHECK_STR(v.text, "true");
    CHECK_EQ(mt_gon_get(fg_mem_read, NULL, fg_node(0), "properties.faction", &v, why, sizeof why), 1);
    CHECK_EQ(v.type, 1); CHECK_STR(v.text, "allies");
    CHECK_EQ(mt_gon_get(fg_mem_read, NULL, fg_node(0), "properties.a_rather_long_key_name", &v, why, sizeof why), 1);   /* heap name */
    CHECK_EQ(v.type, 2); CHECK_EQ(v.i, 1); CHECK(v.d == 1.5); CHECK_STR(v.text, "1.5");
    CHECK_EQ(mt_gon_get(fg_mem_read, NULL, fg_node(0), "graphics.name", &v, why, sizeof why), 1);                        /* heap text */
    CHECK_EQ(v.type, 1); CHECK_STR(v.text, "ENEMY_POOTER_NAME");
    CHECK_EQ(mt_gon_get(fg_mem_read, NULL, fg_node(0), "spells.0", &v, why, sizeof why), 1);                             /* numeric segment = index */
    CHECK_EQ(v.type, 1); CHECK_STR(v.text, "Fireball");
    CHECK_EQ(mt_gon_get(fg_mem_read, NULL, fg_node(0), "spells.1", &v, why, sizeof why), 1);
    CHECK_EQ(v.type, 2); CHECK_EQ(v.i, 2);
    CHECK_EQ(mt_gon_get(fg_mem_read, NULL, fg_node(0), "4.1", &v, why, sizeof why), 1);                                  /* indices work on objects too */
    CHECK_EQ(v.type, 2); CHECK_EQ(v.i, 2);
    CHECK_EQ(mt_gon_get(fg_mem_read, NULL, fg_node(0), "stats", &v, why, sizeof why), 1);
    CHECK_EQ(v.type, 3); CHECK_EQ(v.childCount, 2);
    CHECK_EQ(mt_gon_get(fg_mem_read, NULL, fg_node(0), "", &v, why, sizeof why), 1);                                     /* empty path = the node itself */
    CHECK_EQ(v.type, 3); CHECK_EQ(v.childCount, 5);
    /* missing: a name, an index, a scalar used as a container */
    CHECK_EQ(mt_gon_get(fg_mem_read, NULL, fg_node(0), "properties.nope", &v, why, sizeof why), 0);
    CHECK(has(why, "no child named \"nope\"")); CHECK(has(why, "among 4"));
    CHECK_EQ(mt_gon_get(fg_mem_read, NULL, fg_node(0), "spells.2", &v, why, sizeof why), 0);
    CHECK(has(why, "index 2")); CHECK(has(why, "2 children"));
    CHECK_EQ(mt_gon_get(fg_mem_read, NULL, fg_node(0), "properties.health.x", &v, why, sizeof why), 0);
    CHECK(has(why, "number")); CHECK(has(why, "not a container"));
    /* unreadable: a children vector outside readable memory, a root outside it, no root */
    CHECK_EQ(mt_gon_get(fg_mem_read, NULL, fg_node(0), "broken.x", &v, why, sizeof why), -1);
    CHECK(has(why, "unreadable"));
    CHECK_EQ(mt_gon_get(fg_mem_read, NULL, (const void *)0x40, "stats", &v, why, sizeof why), -1);
    CHECK_EQ(mt_gon_get(fg_mem_read, NULL, NULL, "stats", &v, why, sizeof why), -1);
}

TEST(script_expect_gon_parses_number_string_bool_exists_missing_and_rejects_bad_forms) {
    char err[256]; int line = 0;
    const char *s = "expect gon 8 properties.health == 12\nexpect gon \"Lil' Rat\" stats.speed >= 1.5\nexpect gon Pooter properties.faction == \"allies\"\n"
                    "expect gon 8 properties.flying != true\nexpect gon 8 abilities.spells.0 exists\nexpect gon 8 properties.nope missing\nexpect gon 8 x == -3\nquit\n";
    CHECK(mt_script_parse(s, strlen(s), &g_s, err, sizeof err, &line));
    CHECK_EQ(g_s.count, 8);
    CHECK_EQ(g_s.d[0].kind, MT_D_EXPECT_GON); CHECK_EQ(g_s.d[0].unitIsIndex, 1); CHECK_EQ(g_s.d[0].n, 8); CHECK_STR(g_s.d[0].a, "properties.health"); CHECK_EQ(g_s.d[0].gonCheck, MT_G_NUM); CHECK_EQ(g_s.d[0].op, MT_OP_EQ); CHECK(g_s.d[0].dvalue == 12.0);
    CHECK_EQ(g_s.d[1].unitIsIndex, 0); CHECK_STR(g_s.d[1].b, "Lil' Rat"); CHECK_STR(g_s.d[1].a, "stats.speed"); CHECK_EQ(g_s.d[1].op, MT_OP_GE); CHECK(g_s.d[1].dvalue == 1.5);
    CHECK_STR(g_s.d[2].b, "Pooter"); CHECK_EQ(g_s.d[2].gonCheck, MT_G_STR); CHECK_STR(g_s.d[2].c, "allies"); CHECK_EQ(g_s.d[2].op, MT_OP_EQ);
    CHECK_EQ(g_s.d[3].gonCheck, MT_G_BOOL); CHECK_EQ(g_s.d[3].op, MT_OP_NE); CHECK_EQ(g_s.d[3].value, 1);
    CHECK_EQ(g_s.d[4].gonCheck, MT_G_EXISTS); CHECK_STR(g_s.d[4].a, "abilities.spells.0");
    CHECK_EQ(g_s.d[5].gonCheck, MT_G_MISSING);
    CHECK_EQ(g_s.d[6].gonCheck, MT_G_NUM); CHECK(g_s.d[6].dvalue == -3.0);
    const char *bad[] = { "expect gon 8 properties.health\n", "expect gon 8 properties.health ==\n", "expect gon 8 properties.health == abc\n", "expect gon 8 properties.health exists now\n",
                          "expect gon 8 properties.flying > true\n", "expect gon 8 properties.faction >= \"x\"\n", "expect gon 8 == 1\n", "expect gon 8 .a == 1\n", "expect gon 8 a..b == 1\n",
                          "expect gon 8 a. == 1\n", "expect gon\n", "expect gon 8\n", "expect gon 8 a == 1 extra\n", "expect gon 8 a == \"x\" extra\n" };
    for (size_t i = 0; i < sizeof bad / sizeof bad[0]; i++) CHECK(!mt_script_parse(bad[i], strlen(bad[i]), &g_s, err, sizeof err, &line));
}

TEST(script_expect_unit_accepts_hp_shield_divineshield_stats_entry_and_negative_ints) {
    char err[256]; int line = 0;
    const char *s = "expect unit 1 hp == 12\nexpect unit Rat speed >= 15\nexpect unit 0 entry == \"PlayerCat\"\nexpect unit 0 luck != -1\nexpect unit 0 shield == 0\nexpect unit 0 divineshield == 0\nexpect unit 0 constitution > 0\nquit\n";
    CHECK(mt_script_parse(s, strlen(s), &g_s, err, sizeof err, &line));
    CHECK_EQ(g_s.count, 8);
    CHECK_EQ(g_s.d[0].kind, MT_D_EXPECT_UNIT); CHECK_EQ(g_s.d[0].field, MT_F_HP); CHECK_EQ(g_s.d[0].value, 12);
    CHECK_EQ(g_s.d[1].field, MT_F_SPEED); CHECK_EQ(g_s.d[1].op, MT_OP_GE); CHECK_EQ(g_s.d[1].value, 15);
    CHECK_EQ(g_s.d[2].field, MT_F_ENTRY); CHECK_STR(g_s.d[2].a, "PlayerCat");
    CHECK_EQ(g_s.d[3].field, MT_F_LUCK); CHECK_EQ(g_s.d[3].value, -1);
    CHECK_EQ(g_s.d[4].field, MT_F_SHIELD); CHECK_EQ(g_s.d[5].field, MT_F_DIVINESHIELD); CHECK_EQ(g_s.d[6].field, MT_F_CONSTITUTION);
    CHECK_STR(mt_unit_field_name(MT_F_HP), "hp"); CHECK_STR(mt_unit_field_name(MT_F_ENTRY), "entry"); CHECK_STR(mt_unit_field_name(MT_F_LUCK), "luck");
    const char *bad[] = { "expect unit 1 hp == \"x\"\n", "expect unit 1 entry == bare\n", "expect unit 1 entry > \"x\"\n", "expect unit 1 divine_shield == 0\n", "expect unit 1 hp == -\n" };
    for (size_t i = 0; i < sizeof bad / sizeof bad[0]; i++) CHECK(!mt_script_parse(bad[i], strlen(bad[i]), &g_s, err, sizeof err, &line));
}

TEST(runner_dump_emits_entry_hp_shield_divineshield_and_the_seven_stats) {
    fk_reset("dump\nquit\n");
    fk_units_with_numbers();
    steps_until_done(5);
    CHECK(has(ev(0), "{\"i\":0,\"name\":\"Lumee\",\"class\":\"Fighter\",\"entry\":\"PlayerCat\",\"faction\":0,\"move\":3,\"act\":1,\"turnkind\":2,\"hp\":23,\"shield\":2,\"divineshield\":1,\"strength\":4,\"dexterity\":5,\"constitution\":6,\"intelligence\":7,\"speed\":8,\"charisma\":9,\"luck\":10,\"statuses\":[\"LuckUp\",\"JokersLuck\"],\"stacks\":[0,0]}"));
    CHECK(has(ev(0), "{\"i\":1,\"name\":\"Rat\",\"class\":\"Rat\",\"entry\":\"Pooter\",\"faction\":1,\"move\":0,\"act\":0,\"turnkind\":0,\"hp\":12,\"shield\":0,\"divineshield\":0,\"strength\":5,\"dexterity\":5,\"constitution\":5,\"intelligence\":5,\"speed\":15,\"charisma\":5,\"luck\":5,\"statuses\":[],\"stacks\":[]}"));
}

TEST(runner_expect_unit_hp_shield_stats_and_entry) {
    fk_reset("expect unit 1 hp == 12\nexpect unit Lumee hp > 20\nexpect unit 0 shield == 2\nexpect unit 1 speed == 15\nexpect unit 0 luck == 10\nexpect unit 0 constitution == 5\nexpect unit 1 entry == \"Pooter\"\nexpect unit 0 entry != \"Pooter\"\nexpect unit 0 divineshield == 1\nquit\n");
    fk_units_with_numbers();
    steps_until_done(12);
    CHECK(has(ev(0), "\"kind\":\"unit\"")); CHECK(has(ev(0), "\"ok\":true")); CHECK(has(ev(0), "\"arg\":\"1 hp == 12\"")); CHECK(has(ev(0), "\"detail\":\"unit 1 \\\"Rat\\\": hp 12\""));
    CHECK(has(ev(1), "\"ok\":true")); CHECK(has(ev(1), "hp 23"));
    CHECK(has(ev(2), "\"ok\":true")); CHECK(has(ev(2), "shield 2"));
    CHECK(has(ev(3), "\"ok\":true")); CHECK(has(ev(3), "speed 15"));
    CHECK(has(ev(4), "\"ok\":true")); CHECK(has(ev(4), "luck 10"));
    CHECK(has(ev(5), "\"ok\":false")); CHECK(has(ev(5), "constitution 6"));
    CHECK(has(ev(6), "\"ok\":true")); CHECK(has(ev(6), "\"arg\":\"1 entry == \\\"Pooter\\\"\"")); CHECK(has(ev(6), "entry \\\"Pooter\\\""));
    CHECK(has(ev(7), "\"ok\":true")); CHECK(has(ev(7), "entry \\\"PlayerCat\\\""));
    CHECK(has(ev(8), "\"ok\":true")); CHECK(has(ev(8), "divineshield 1"));
    CHECK(has(last_ev(), "\"expect_pass\":8")); CHECK(has(last_ev(), "\"expect_fail\":1"));
}

TEST(runner_expect_gon_number_string_bool_exists_missing_no_entry_unreadable_and_no_combat) {
    fk_reset("expect gon 1 properties.health == 12\nexpect gon Rat stats.speed >= 10\nexpect gon 1 properties.health < 12\nexpect gon 1 properties.faction == \"allies\"\nexpect gon 1 properties.faction != \"allies\"\n"
             "expect gon 1 properties.flying == true\nexpect gon 1 properties.flying == false\nexpect gon 1 abilities exists\nexpect gon 1 stats exists\nexpect gon 1 properties.nope missing\n"
             "expect gon 1 properties.health missing\nexpect gon 1 properties.health == \"12\"\nexpect gon 1 properties.faction == 1\nexpect gon 0 properties.health == 12\nexpect gon 1 broken.x exists\nexpect gon 9 stats exists\n"
             "expect gon 1 properties.a_rather_long_key_name == 1.5\nexpect gon 1 spells.0 == \"Fireball\"\nexpect gon 1 spells.1 == 2\nquit\n");
    fk_units_with_numbers();
    steps_until_done(25);
    CHECK(has(ev(0), "\"kind\":\"gon\"")); CHECK(has(ev(0), "\"ok\":true")); CHECK(has(ev(0), "\"arg\":\"1 properties.health == 12\"")); CHECK(has(ev(0), "\"detail\":\"unit 1 \\\"Rat\\\" (Pooter): properties.health = number 12 (int 12, double 12, text \\\"12\\\")\""));
    CHECK(has(ev(1), "\"ok\":true")); CHECK(has(ev(1), "\"arg\":\"Rat stats.speed >= 10\"")); CHECK(has(ev(1), "number 15"));
    CHECK(has(ev(2), "\"ok\":false")); CHECK(has(ev(2), "number 12"));
    CHECK(has(ev(3), "\"ok\":true")); CHECK(has(ev(3), "\"arg\":\"1 properties.faction == \\\"allies\\\"\"")); CHECK(has(ev(3), "string \\\"allies\\\""));
    CHECK(has(ev(4), "\"ok\":false"));
    CHECK(has(ev(5), "\"ok\":true")); CHECK(has(ev(5), "\"arg\":\"1 properties.flying == true\"")); CHECK(has(ev(5), "bool true"));
    CHECK(has(ev(6), "\"ok\":false"));
    CHECK(has(ev(7), "\"ok\":false")); CHECK(has(ev(7), "\"arg\":\"1 abilities exists\"")); CHECK(has(ev(7), "missing: no child named \\\"abilities\\\" among 5"));
    CHECK(has(ev(8), "\"ok\":true")); CHECK(has(ev(8), "object with 2 children"));
    CHECK(has(ev(9), "\"ok\":true")); CHECK(has(ev(9), "\"arg\":\"1 properties.nope missing\"")); CHECK(has(ev(9), "missing: no child named \\\"nope\\\" among 4"));
    CHECK(has(ev(10), "\"ok\":false")); CHECK(has(ev(10), "number 12"));
    CHECK(has(ev(11), "\"ok\":false")); CHECK(has(ev(11), "number 12"));         /* a quoted value only matches a string node */
    CHECK(has(ev(12), "\"ok\":false")); CHECK(has(ev(12), "string \\\"allies\\\""));  /* a number only matches a number node */
    CHECK(has(ev(13), "\"ok\":false")); CHECK(has(ev(13), "unit 0 \\\"Lumee\\\" (PlayerCat): no GON entry"));
    CHECK(has(ev(14), "\"ok\":false")); CHECK(has(ev(14), "unreadable"));
    CHECK(has(ev(15), "\"ok\":false")); CHECK(has(ev(15), "unit not found: index 9 of 2"));
    CHECK(has(ev(16), "\"ok\":true")); CHECK(has(ev(16), "number 1.5 (int 1, double 1.5, text \\\"1.5\\\")"));
    CHECK(has(ev(17), "\"ok\":true")); CHECK(has(ev(17), "string \\\"Fireball\\\""));
    CHECK(has(ev(18), "\"ok\":true"));
    CHECK(has(last_ev(), "\"expect_pass\":9")); CHECK(has(last_ev(), "\"expect_fail\":10"));
    fk_reset("expect gon 0 stats exists\nquit\n");      /* no combat */
    steps_until_done(5);
    CHECK(has(ev(0), "\"kind\":\"gon\"")); CHECK(has(ev(0), "\"ok\":false")); CHECK(has(ev(0), "no combat (units unavailable)"));
}

int main(void) { return MT_RUN_ALL(); }
