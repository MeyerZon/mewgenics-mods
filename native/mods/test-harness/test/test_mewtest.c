/* Host-side tests for mewtest's pure modules (src/mt_*.c). No windows.h, no game.
 * Sections: jsonl, args, msvcstr, script, console, runner (with a fake host). */
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../../../test/minitest.h"
#include "mt_pure.h"

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
    mt_msvcstr_build(&s, "hello world", 11, fake_alloc);
    CHECK_EQ(mt_msvcstr_copy(&s, out, sizeof out), 7);
    CHECK_STR(out, "hello w");
    CHECK_EQ(mt_msvcstr_copy(&s, NULL, 0), 0);
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

static const MtHost HOST = {
    NULL, fk_console_ready, fk_exec_cmd, fk_console_count, fk_console_line, fk_turn_count, fk_round, fk_now,
    fk_units_available, fk_unit_count, fk_unit_info, fk_unit_has_status, fk_emit, fk_request_exit,
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
    CHECK(has(ev(0), "{\"i\":0,\"name\":\"Lumee\",\"class\":\"Fighter\",\"faction\":0,\"move\":3,\"act\":1,\"turnkind\":2,\"statuses\":[\"LuckUp\",\"JokersLuck\"]}"));
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
    fk_reset("cmd listcmds\nquit\n");
    fk.ready = 0;
    int n = steps_until_done(MT_CONSOLE_WAIT_FRAMES + 10);
    CHECK_EQ(n, MT_CONSOLE_WAIT_FRAMES);
    CHECK(has(last_ev(), "\"code\":4")); CHECK(has(last_ev(), "\"reason\":\"console_unavailable\""));
    CHECK_EQ(fk.exitCode, 4);
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

int main(void) { return MT_RUN_ALL(); }
