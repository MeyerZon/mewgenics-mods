/* Host-side tests for the strict JSON tokenizer (src/fw_json.c) the glTF loader stands on. */
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdlib.h>
#include "../../test/minitest.h"
#include "fw_json.h"

static FwJsonTok T[512];
static int tok(const char *s) { FwJsonError e; return fw_json_tokenize(s, strlen(s), T, 512, &e); }

TEST(json_tokenizes_nested_objects_and_arrays) {
    const char *s = " {\"a\": [1, 2.5, {\"b\": true}], \"c\": null, \"d\": \"x\", \"e\": false} ";
    int n = tok(s);
    CHECK_EQ(n, 14);
    if (n != 14) return;
    CHECK_EQ(T[0].type, FW_JSON_OBJECT); CHECK_EQ(T[0].size, 4); CHECK_EQ(T[0].next, n); CHECK_EQ(T[0].parent, -1);
    int a = fw_json_find(s, T, 0, "a");
    CHECK_EQ(T[a].type, FW_JSON_ARRAY); CHECK_EQ(T[a].size, 3);
    CHECK_EQ(T[T[a].parent].type, FW_JSON_STRING);   /* a value's parent is its key */
    int third = fw_json_index(T, a, 2);
    CHECK_EQ(T[third].type, FW_JSON_OBJECT);
    CHECK_EQ(T[fw_json_find(s, T, third, "b")].type, FW_JSON_TRUE);
    CHECK_EQ(T[fw_json_find(s, T, 0, "c")].type, FW_JSON_NULL);
    CHECK_EQ(T[fw_json_find(s, T, 0, "e")].type, FW_JSON_FALSE);
    CHECK(fw_json_str_eq(s, T, fw_json_find(s, T, 0, "d"), "x"));
    double v; CHECK_EQ(fw_json_num(s, T, fw_json_index(T, a, 1), &v), 1); CHECK(v == 2.5);
    CHECK_EQ(tok("[]"), 1); CHECK_EQ(T[0].size, 0);
    CHECK_EQ(tok("{}"), 1);
    CHECK_EQ(tok("\xEF\xBB\xBF" "7"), 1); CHECK_EQ(T[0].type, FW_JSON_NUMBER);
}

TEST(json_rejects_trailing_comma_and_garbage) {
    const char *bad[] = { "[1,]", "{\"a\":1,}", "[1 2]", "{\"a\" 1}", "{1:2}", "[1] x", "", "   ", "[", "{\"a\":",
                          "\"abc", "\"a\\q\"", "\"a\nb\"", "tru", "nul", "01", "1.", ".5", "+1", "-", "1e", "NaN",
                          "[1,,2]", "{\"a\":1 \"b\":2}", "\"\\u12G4\"", "// c\n1", "1 2" };
    for (size_t i = 0; i < sizeof bad / sizeof bad[0]; i++)
        if (tok(bad[i]) != -1) MT_FAIL("accepted: %s", bad[i]);
    FwJsonError e; memset(&e, 0, sizeof e);
    CHECK_EQ(fw_json_tokenize("[1,]", 4, T, 512, &e), -1);
    CHECK(e.text[0] != 0); CHECK_EQ(e.offset, 3);
    CHECK_EQ(fw_json_tokenize("[1,]", 4, T, 512, NULL), -1);   /* err may be NULL */
}

TEST(json_numbers_follow_the_grammar) {
    const char *s = "[0, -0, -12.5e+2, 3E-1, 1e2, 9007199254740992, 2.5]";
    CHECK_EQ(tok(s), 8);
    double d; long long k;
    CHECK(fw_json_num(s, T, fw_json_index(T, 0, 2), &d) && d == -1250.0);
    CHECK(fw_json_num(s, T, fw_json_index(T, 0, 3), &d) && d > 0.2999999 && d < 0.3000001);
    CHECK(fw_json_int(s, T, fw_json_index(T, 0, 4), &k) && k == 100);   /* 1e2 is integral */
    CHECK(fw_json_int(s, T, fw_json_index(T, 0, 5), &k) && k == 9007199254740992LL);
    CHECK_EQ(fw_json_int(s, T, fw_json_index(T, 0, 6), &k), 0);         /* 2.5 is not */
    CHECK(fw_json_int(s, T, fw_json_index(T, 0, 1), &k) && k == 0);
    CHECK_EQ(fw_json_num(s, T, 0, &d), 0);                               /* an array is not a number */
    CHECK_EQ(fw_json_num(s, T, -1, &d), 0);
}

TEST(json_unescapes_u_sequences_to_utf8) {
    const char *s = "[\"a\\\"b\\\\c\\/d\\n\\t\", \"\\u00e9\\u20AC\", \"\\ud83d\\ude00\", \"\\ud83d\"]";
    CHECK_EQ(tok(s), 5);
    char out[32];
    CHECK_EQ(fw_json_str_copy(s, T, 1, out, sizeof out), 9);
    CHECK_STR(out, "a\"b\\c/d\n\t");
    CHECK_EQ(fw_json_str_copy(s, T, 2, out, sizeof out), 5);
    CHECK_STR(out, "\xC3\xA9\xE2\x82\xAC");
    CHECK_EQ(fw_json_str_copy(s, T, 3, out, sizeof out), 4);
    CHECK_STR(out, "\xF0\x9F\x98\x80");
    CHECK_EQ(fw_json_str_copy(s, T, 4, out, sizeof out), -1);           /* a lone high surrogate */
    CHECK(fw_json_str_eq(s, T, 2, "\xC3\xA9\xE2\x82\xAC"));
    CHECK(!fw_json_str_eq(s, T, 2, "\xC3\xA9"));
    CHECK_EQ(fw_json_str_copy(s, T, 1, out, 9), -1);                     /* 9 bytes need cap 10 */
    CHECK_STR(out, "");
    CHECK_EQ(fw_json_str_copy(s, T, 0, out, sizeof out), -1);           /* not a string */
}

TEST(json_depth_limit_is_an_error_not_a_crash) {
    char deep[200];
    memset(deep, '[', 64); memset(deep + 64, ']', 64); deep[128] = 0;
    CHECK_EQ(tok(deep), 64);
    memset(deep, '[', 65); memset(deep + 65, ']', 65); deep[130] = 0;
    FwJsonError e;
    CHECK_EQ(fw_json_tokenize(deep, 130, T, 512, &e), -1);
    CHECK(strstr(e.text, "deep") != NULL);
    /* a megabyte of '[' must not recurse */
    size_t big = 1 << 20;
    char *b = (char *)malloc(big);
    memset(b, '[', big);
    CHECK_EQ(fw_json_tokenize(b, big, T, 512, &e), -1);
    free(b);
}

TEST(json_token_cap_is_an_error) {
    FwJsonTok few[3]; FwJsonError e;
    CHECK_EQ(fw_json_tokenize("[1,2]", 5, few, 3, &e), 3);
    CHECK_EQ(fw_json_tokenize("[1,2,3]", 7, few, 3, &e), -1);
    CHECK(strstr(e.text, "tokens") != NULL);
}

TEST(json_find_and_index_walk_siblings_by_size) {
    const char *s = "{\"x\": {\"y\": [[1], {\"z\": 2}]}, \"w\": [3, 4], \"k\": 5, \"x2\": 6}";
    if (tok(s) <= 0) { MT_FAIL("tokenize failed: %s", s); return; }
    int w = fw_json_find(s, T, 0, "w");
    CHECK(w > 0);
    long long k;
    CHECK(fw_json_int(s, T, fw_json_index(T, w, 1), &k) && k == 4);
    CHECK(fw_json_int(s, T, fw_json_find(s, T, 0, "k"), &k) && k == 5);
    CHECK(fw_json_int(s, T, fw_json_find(s, T, 0, "x2"), &k) && k == 6);
    CHECK_EQ(fw_json_find(s, T, 0, "z"), -1);                            /* not a direct key */
    CHECK_EQ(fw_json_find(s, T, 0, "nope"), -1);
    CHECK_EQ(fw_json_index(T, w, 2), -1);
    CHECK_EQ(fw_json_index(T, w, -1), -1);
    CHECK_EQ(fw_json_find(s, T, w, "a"), -1);                            /* an array has no keys */
    CHECK_EQ(fw_json_index(T, 0, 0), -1);                                /* an object has no elements */
    int y = fw_json_find(s, T, fw_json_find(s, T, 0, "x"), "y");
    CHECK(fw_json_int(s, T, fw_json_find(s, T, fw_json_index(T, y, 1), "z"), &k) && k == 2);
}

TEST(json_input_is_not_nul_terminated) {
    const char s[] = "[1, 2]9";
    CHECK_EQ(fw_json_tokenize(s, 6, T, 512, NULL), 3);
    CHECK_EQ(fw_json_tokenize("\"ab\"", 3, T, 512, NULL), -1);          /* the closing quote is past n */
    CHECK_EQ(fw_json_tokenize("12", 1, T, 512, NULL), 1);
    CHECK_EQ(T[0].end, 1);
}

int main(void) { return MT_RUN_ALL(); }
