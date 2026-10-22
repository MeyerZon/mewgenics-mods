/* fw_json.c — the strict JSON tokenizer of fw_json.h. Recursive descent bounded by FW_JSON_MAX_DEPTH (so at most 64
 * frames), no allocation, numbers decoded here (no locale-dependent strtod). */
#include <stdio.h>
#include <string.h>
#include <limits.h>
#include "fw_json.h"

typedef struct P { const char *s; int n, pos; FwJsonTok *t; int nt, max; FwJsonError *err; } P;

static int fail(P *p, const char *msg) {
    if (p->err && !p->err->text[0]) {
        snprintf(p->err->text, sizeof p->err->text, "%s at offset %d", msg, p->pos);
        p->err->offset = (size_t)p->pos;
    }
    return -1;
}
static int add(P *p, int type, int start, int end, int parent) {
    if (p->nt >= p->max) return fail(p, "too many tokens");
    FwJsonTok *k = &p->t[p->nt];
    k->type = type; k->start = start; k->end = end; k->size = 0; k->parent = parent; k->next = p->nt + 1;
    return p->nt++;
}
static void ws(P *p) {
    while (p->pos < p->n) {
        char c = p->s[p->pos];
        if (c != ' ' && c != '\t' && c != '\n' && c != '\r') break;
        p->pos++;
    }
}
static int is_hex(char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }
static int is_dig(char c) { return c >= '0' && c <= '9'; }

static int string_tok(P *p, int parent) {
    int start = ++p->pos;   /* past the opening quote */
    while (p->pos < p->n) {
        unsigned char c = (unsigned char)p->s[p->pos];
        if (c == '"') { int i = add(p, FW_JSON_STRING, start, p->pos, parent); p->pos++; return i; }
        if (c < 0x20) return fail(p, "control character in a string");
        if (c == '\\') {
            if (p->pos + 1 >= p->n) break;
            char e = p->s[p->pos + 1];
            if (e == 'u') {
                if (p->pos + 6 > p->n) break;
                for (int k = 2; k < 6; k++) if (!is_hex(p->s[p->pos + k])) { p->pos += k; return fail(p, "bad \\u escape"); }
                p->pos += 6;
                continue;
            }
            if (!strchr("\"\\/bfnrt", e) || e == 0) { p->pos++; return fail(p, "bad escape"); }
            p->pos += 2;
            continue;
        }
        p->pos++;
    }
    return fail(p, "unterminated string");
}

static int number_tok(P *p, int parent) {
    int start = p->pos;
    const char *s = p->s;
    if (p->pos < p->n && s[p->pos] == '-') p->pos++;
    if (p->pos >= p->n || !is_dig(s[p->pos])) return fail(p, "bad number");
    if (s[p->pos] == '0') p->pos++;
    else while (p->pos < p->n && is_dig(s[p->pos])) p->pos++;
    if (p->pos < p->n && s[p->pos] == '.') {
        p->pos++;
        if (p->pos >= p->n || !is_dig(s[p->pos])) return fail(p, "bad number");
        while (p->pos < p->n && is_dig(s[p->pos])) p->pos++;
    }
    if (p->pos < p->n && (s[p->pos] == 'e' || s[p->pos] == 'E')) {
        p->pos++;
        if (p->pos < p->n && (s[p->pos] == '+' || s[p->pos] == '-')) p->pos++;
        if (p->pos >= p->n || !is_dig(s[p->pos])) return fail(p, "bad number");
        while (p->pos < p->n && is_dig(s[p->pos])) p->pos++;
    }
    return add(p, FW_JSON_NUMBER, start, p->pos, parent);
}

static int literal_tok(P *p, int parent, const char *word, int type) {
    int l = (int)strlen(word);
    if (p->n - p->pos < l || memcmp(p->s + p->pos, word, (size_t)l) != 0) return fail(p, "unexpected character");
    int i = add(p, type, p->pos, p->pos + l, parent);
    p->pos += l;
    return i;
}

static int value(P *p, int parent, int depth) {
    ws(p);
    if (p->pos >= p->n) return fail(p, "unexpected end");
    char c = p->s[p->pos];
    if (c == '{' || c == '[') {
        if (depth >= FW_JSON_MAX_DEPTH) return fail(p, "nested too deep");
        int obj = c == '{';
        int idx = add(p, obj ? FW_JSON_OBJECT : FW_JSON_ARRAY, p->pos, 0, parent);
        if (idx < 0) return -1;
        p->pos++;
        ws(p);
        if (p->pos < p->n && p->s[p->pos] == (obj ? '}' : ']')) p->pos++;
        else for (;;) {
            if (obj) {
                ws(p);
                if (p->pos >= p->n || p->s[p->pos] != '"') return fail(p, "expected a key");
                int k = string_tok(p, idx);
                if (k < 0) return -1;
                ws(p);
                if (p->pos >= p->n || p->s[p->pos] != ':') return fail(p, "expected ':'");
                p->pos++;
                if (value(p, k, depth + 1) < 0) return -1;
                p->t[k].size = 1;
                p->t[k].next = p->nt;
            } else if (value(p, idx, depth + 1) < 0) return -1;
            p->t[idx].size++;
            ws(p);
            if (p->pos >= p->n) return fail(p, "unexpected end");
            if (p->s[p->pos] == ',') { p->pos++; continue; }
            if (p->s[p->pos] == (obj ? '}' : ']')) { p->pos++; break; }
            return fail(p, obj ? "expected ',' or '}'" : "expected ',' or ']'");
        }
        p->t[idx].end = p->pos;
        p->t[idx].next = p->nt;
        return idx;
    }
    if (c == '"') return string_tok(p, parent);
    if (c == '-' || is_dig(c)) return number_tok(p, parent);
    if (c == 't') return literal_tok(p, parent, "true", FW_JSON_TRUE);
    if (c == 'f') return literal_tok(p, parent, "false", FW_JSON_FALSE);
    if (c == 'n') return literal_tok(p, parent, "null", FW_JSON_NULL);
    return fail(p, "unexpected character");
}

int fw_json_tokenize(const char *s, size_t n, FwJsonTok *toks, int maxToks, FwJsonError *err) {
    P p;
    memset(&p, 0, sizeof p);
    p.err = err;
    if (err) { err->text[0] = 0; err->offset = 0; }
    if ((!s && n) || !toks || maxToks <= 0) return fail(&p, "bad arguments");
    if (n > (size_t)INT_MAX) return fail(&p, "input too long");
    p.s = s; p.n = (int)n; p.t = toks; p.max = maxToks;
    if (n >= 3 && (unsigned char)s[0] == 0xEF && (unsigned char)s[1] == 0xBB && (unsigned char)s[2] == 0xBF) p.pos = 3;
    if (value(&p, -1, 0) < 0) return -1;
    ws(&p);
    if (p.pos != p.n) return fail(&p, "trailing characters");
    return p.nt;
}

/* ---------------------------------------------------------------- lookups */
int fw_json_index(const FwJsonTok *t, int arr, int i) {
    if (!t || arr < 0 || t[arr].type != FW_JSON_ARRAY || i < 0 || i >= t[arr].size) return -1;
    int j = arr + 1;
    for (int k = 0; k < i; k++) j = t[j].next;
    return j;
}

int fw_json_find(const char *s, const FwJsonTok *t, int obj, const char *key) {
    if (!t || obj < 0 || t[obj].type != FW_JSON_OBJECT || !key) return -1;
    int j = obj + 1;
    for (int k = 0; k < t[obj].size; k++) {
        if (fw_json_str_eq(s, t, j, key)) return j + 1;
        j = t[j].next;
    }
    return -1;
}

int fw_json_num(const char *s, const FwJsonTok *t, int i, double *out) {
    if (!t || i < 0 || t[i].type != FW_JSON_NUMBER) return 0;
    const char *p = s + t[i].start, *e = s + t[i].end;
    int neg = 0, sig = 0, exp10 = 0;
    double mant = 0.0;
    if (p < e && *p == '-') { neg = 1; p++; }
    for (; p < e && is_dig(*p); p++) {
        if (sig < 19) { mant = mant * 10.0 + (*p - '0'); if (mant != 0.0) sig++; } else exp10++;
    }
    if (p < e && *p == '.')
        for (p++; p < e && is_dig(*p); p++)
            if (sig < 19) { mant = mant * 10.0 + (*p - '0'); if (mant != 0.0) sig++; exp10--; }
    if (p < e && (*p == 'e' || *p == 'E')) {
        p++;
        int eneg = 0; long ev = 0;
        if (p < e && (*p == '+' || *p == '-')) { eneg = *p == '-'; p++; }
        for (; p < e && is_dig(*p); p++) if (ev < 100000) ev = ev * 10 + (*p - '0');
        exp10 += (int)(eneg ? -ev : ev);
    }
    double v = mant;
    if (v != 0.0) {
        if (exp10 > 308) v = 1e308 * 10.0;   /* inf */
        else if (exp10 < -340) v = 0.0;
        else {
            int a = exp10 < 0 ? -exp10 : exp10;
            double pw = 1.0;
            for (int k = 0; k < a; k++) pw *= 10.0;
            v = exp10 < 0 ? v / pw : v * pw;
        }
    }
    *out = neg ? -v : v;
    return 1;
}

int fw_json_int(const char *s, const FwJsonTok *t, int i, long long *out) {
    double d;
    if (!fw_json_num(s, t, i, &d)) return 0;
    if (!(d >= -9007199254740992.0 && d <= 9007199254740992.0)) return 0;
    long long v = (long long)d;
    if ((double)v != d) return 0;
    *out = v;
    return 1;
}

/* unescape into out (cap bytes incl. NUL); length, or -1 (bad / does not fit) */
static int unescape(const char *s, const FwJsonTok *t, int i, char *out, size_t cap) {
    if (!t || i < 0 || t[i].type != FW_JSON_STRING || !out || cap == 0) return -1;
    const char *p = s + t[i].start, *e = s + t[i].end;
    size_t n = 0;
    while (p < e) {
        unsigned long cp;
        if (*p != '\\') { if (n + 1 >= cap) return -1; out[n++] = *p++; continue; }
        char c = p[1];
        p += 2;
        switch (c) {
        case '"': cp = '"'; break;  case '\\': cp = '\\'; break; case '/': cp = '/'; break;
        case 'b': cp = '\b'; break; case 'f': cp = '\f'; break;  case 'n': cp = '\n'; break;
        case 'r': cp = '\r'; break; case 't': cp = '\t'; break;
        case 'u': {
            unsigned long h = 0;
            for (int k = 0; k < 4; k++) { char x = p[k]; h = h * 16 + (unsigned long)(x <= '9' ? x - '0' : (x | 0x20) - 'a' + 10); }
            p += 4;
            if (h >= 0xDC00 && h <= 0xDFFF) return -1;          /* a lone low surrogate */
            if (h >= 0xD800 && h <= 0xDBFF) {
                if (e - p < 6 || p[0] != '\\' || p[1] != 'u') return -1;
                unsigned long l = 0;
                for (int k = 2; k < 6; k++) { char x = p[k]; l = l * 16 + (unsigned long)(x <= '9' ? x - '0' : (x | 0x20) - 'a' + 10); }
                if (l < 0xDC00 || l > 0xDFFF) return -1;
                p += 6;
                h = 0x10000 + ((h - 0xD800) << 10) + (l - 0xDC00);
            }
            if (h == 0) return -1;                               /* no NULs inside C strings */
            cp = h;
            break;
        }
        default: return -1;
        }
        unsigned char b[4]; int nb;
        if (cp < 0x80) { b[0] = (unsigned char)cp; nb = 1; }
        else if (cp < 0x800) { b[0] = (unsigned char)(0xC0 | cp >> 6); b[1] = (unsigned char)(0x80 | (cp & 63)); nb = 2; }
        else if (cp < 0x10000) { b[0] = (unsigned char)(0xE0 | cp >> 12); b[1] = (unsigned char)(0x80 | (cp >> 6 & 63)); b[2] = (unsigned char)(0x80 | (cp & 63)); nb = 3; }
        else { b[0] = (unsigned char)(0xF0 | cp >> 18); b[1] = (unsigned char)(0x80 | (cp >> 12 & 63)); b[2] = (unsigned char)(0x80 | (cp >> 6 & 63)); b[3] = (unsigned char)(0x80 | (cp & 63)); nb = 4; }
        if (n + (size_t)nb >= cap) return -1;
        memcpy(out + n, b, (size_t)nb);
        n += (size_t)nb;
    }
    out[n] = 0;
    return (int)n;
}

int fw_json_str_copy(const char *s, const FwJsonTok *t, int i, char *out, size_t cap) {
    int r = unescape(s, t, i, out, cap);
    if (r < 0 && out && cap) out[0] = 0;
    return r;
}

int fw_json_str_eq(const char *s, const FwJsonTok *t, int i, const char *lit) {
    if (!t || i < 0 || t[i].type != FW_JSON_STRING || !lit) return 0;
    size_t raw = (size_t)(t[i].end - t[i].start), ll = strlen(lit);
    if (!memchr(s + t[i].start, '\\', raw)) return raw == ll && memcmp(s + t[i].start, lit, ll) == 0;
    char buf[512];
    int n = unescape(s, t, i, buf, sizeof buf);
    return n >= 0 && (size_t)n == ll && memcmp(buf, lit, ll) == 0;
}
