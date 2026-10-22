/* fw_json.c — RED stub: the API of fw_json.h, nothing implemented. */
#include "fw_json.h"
int fw_json_tokenize(const char *s, size_t n, FwJsonTok *toks, int maxToks, FwJsonError *err) { (void)s; (void)n; (void)toks; (void)maxToks; (void)err; return -1; }
int fw_json_find(const char *s, const FwJsonTok *t, int obj, const char *key) { (void)s; (void)t; (void)obj; (void)key; return -1; }
int fw_json_index(const FwJsonTok *t, int arr, int i) { (void)t; (void)arr; (void)i; return -1; }
int fw_json_num(const char *s, const FwJsonTok *t, int i, double *out) { (void)s; (void)t; (void)i; (void)out; return 0; }
int fw_json_int(const char *s, const FwJsonTok *t, int i, long long *out) { (void)s; (void)t; (void)i; (void)out; return 0; }
int fw_json_str_eq(const char *s, const FwJsonTok *t, int i, const char *lit) { (void)s; (void)t; (void)i; (void)lit; return 0; }
int fw_json_str_copy(const char *s, const FwJsonTok *t, int i, char *out, size_t cap) { (void)s; (void)t; (void)i; if (out && cap) out[0] = 0; return -1; }
