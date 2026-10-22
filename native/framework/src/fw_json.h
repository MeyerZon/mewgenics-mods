/* fw_json — a small strict JSON tokenizer written from scratch for the glTF loader (fw_mesh_gltf.c): one pass, a
 * caller-sized token array, no allocation, strings unescaped on demand. Pure C11, host-tested (test/test_json.c).
 *
 * Tokens are in document (pre-)order. An object token's children are its keys (STRING tokens, parent = the object),
 * each key's single child is its value (parent = the key). An array's children are its elements. `size` = number of
 * keys / elements (1 for a key, 0 for scalars); `next` = the index just past the token's subtree, so siblings are
 * walked with i = toks[i].next. Strings' [start, end) excludes the quotes (still escaped); numbers / literals span
 * their text. Input is NOT NUL-terminated. */
#pragma once
#include <stddef.h>

#define FW_JSON_OBJECT 1
#define FW_JSON_ARRAY  2
#define FW_JSON_STRING 3
#define FW_JSON_NUMBER 4
#define FW_JSON_TRUE   5
#define FW_JSON_FALSE  6
#define FW_JSON_NULL   7
#define FW_JSON_MAX_DEPTH 64

typedef struct FwJsonTok { int type; int start, end; int size; int parent; int next; } FwJsonTok;
typedef struct FwJsonError { char text[96]; size_t offset; } FwJsonError;

/* Tokenizes exactly one JSON value (RFC 8259, strict: no trailing commas, no comments, no leading zeros, no NaN; raw
 * control characters in strings rejected; surrounding whitespace and a leading UTF-8 BOM allowed). Returns the token
 * count (>= 1) or -1 with err set (err may be NULL): syntax errors, trailing garbage, depth > FW_JSON_MAX_DEPTH,
 * more than maxToks tokens, input longer than INT32_MAX. */
int fw_json_tokenize(const char *s, size_t n, FwJsonTok *toks, int maxToks, FwJsonError *err);

/* value token of `key` in object `obj` (the first match), -1 when absent / obj is not an object */
int fw_json_find(const char *s, const FwJsonTok *t, int obj, const char *key);
/* element i of array `arr`, -1 when out of range / arr is not an array */
int fw_json_index(const FwJsonTok *t, int arr, int i);
/* NUMBER token -> double; 0 when not a number token (or i < 0) */
int fw_json_num(const char *s, const FwJsonTok *t, int i, double *out);
/* NUMBER token with an integral value in [-2^53, 2^53] -> long long; 0 otherwise */
int fw_json_int(const char *s, const FwJsonTok *t, int i, long long *out);
/* STRING token equal (after unescaping) to the NUL-terminated lit */
int fw_json_str_eq(const char *s, const FwJsonTok *t, int i, const char *lit);
/* STRING token unescaped (\uXXXX -> UTF-8, surrogate pairs joined) into out (NUL-terminated); returns the byte
 * length, or -1 when not a string or it does not fit in cap - 1 bytes (out = "" when cap > 0) */
int fw_json_str_copy(const char *s, const FwJsonTok *t, int i, char *out, size_t cap);
