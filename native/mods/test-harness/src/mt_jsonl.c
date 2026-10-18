/* JSON-lines writer into a caller-provided buffer. No heap, no partial escapes on
 * overflow, output always NUL-terminated. */
#include "mt_pure.h"
#include <stdio.h>
#include <string.h>

static void put(MtJsonW *w, const char *s, size_t n) {
    if (w->overflow) return;
    if (w->len + n + 1 > w->cap) { w->overflow = 1; return; }
    memcpy(w->buf + w->len, s, n);
    w->len += n;
    w->buf[w->len] = 0;
}
static void puts_(MtJsonW *w, const char *s) { put(w, s, strlen(s)); }

/* one escaped piece for byte c (or NULL to pass it through) */
static const char *escape_of(unsigned char c, char *tmp) {
    switch (c) {
        case '"': return "\\\"";
        case '\\': return "\\\\";
        case '\n': return "\\n";
        case '\r': return "\\r";
        case '\t': return "\\t";
        default:
            if (c < 0x20) { snprintf(tmp, 8, "\\u%04x", c); return tmp; }
            return NULL;
    }
}

size_t mt_json_escape(const char *in, size_t n, char *out, size_t cap) {
    size_t need = 2, w = 0;
    char tmp[8];
    if (cap) out[0] = 0;
    if (cap >= 2) { out[w++] = '"'; }
    for (size_t i = 0; i < n; i++) {
        const char *e = escape_of((unsigned char)in[i], tmp);
        size_t len = e ? strlen(e) : 1;
        need += len;
        if (cap && w + len + 2 <= cap) {        /* leave room for the closing quote + NUL */
            if (e) memcpy(out + w, e, len); else out[w] = in[i];
            w += len;
        }
    }
    if (cap >= 2 && w + 2 <= cap) { out[w++] = '"'; }
    if (cap) out[w < cap ? w : cap - 1] = 0;
    return need;
}

static void put_escaped(MtJsonW *w, const char *s, size_t n) {
    char tmp[8];
    if (w->overflow) return;
    size_t need = mt_json_escape(s, n, tmp, 0);
    if (w->len + need + 1 > w->cap) { w->overflow = 1; return; }
    mt_json_escape(s, n, w->buf + w->len, w->cap - w->len);
    w->len += need;
}

static void key(MtJsonW *w, const char *k) {
    if (w->needComma) puts_(w, ",");
    puts_(w, "\"");
    puts_(w, k);
    puts_(w, "\":");
}

void mt_jw_begin(MtJsonW *w, char *buf, size_t cap, const char *ev) {
    w->buf = buf; w->cap = cap; w->len = 0; w->overflow = 0; w->needComma = 0;
    if (cap) buf[0] = 0;
    puts_(w, "{\"ev\":");
    put_escaped(w, ev, strlen(ev));
    w->needComma = 1;
}
void mt_jw_strn(MtJsonW *w, const char *k, const char *val, size_t n) { key(w, k); put_escaped(w, val, n); w->needComma = 1; }
void mt_jw_str(MtJsonW *w, const char *k, const char *val) { mt_jw_strn(w, k, val ? val : "", val ? strlen(val) : 0); }
void mt_jw_int(MtJsonW *w, const char *k, long long v) { char t[32]; snprintf(t, sizeof t, "%lld", v); key(w, k); puts_(w, t); w->needComma = 1; }
void mt_jw_hex(MtJsonW *w, const char *k, unsigned long long v) { char t[40]; snprintf(t, sizeof t, "\"0x%llx\"", v); key(w, k); puts_(w, t); w->needComma = 1; }
void mt_jw_bool(MtJsonW *w, const char *k, int v) { key(w, k); puts_(w, v ? "true" : "false"); w->needComma = 1; }
void mt_jw_arr_begin(MtJsonW *w, const char *k) { key(w, k); puts_(w, "["); w->needComma = 0; }
void mt_jw_arr_str(MtJsonW *w, const char *v) { if (w->needComma) puts_(w, ","); put_escaped(w, v, strlen(v)); w->needComma = 1; }
void mt_jw_arr_end(MtJsonW *w) { puts_(w, "]"); w->needComma = 1; }
void mt_jw_obj_begin(MtJsonW *w, const char *k) {
    if (k) key(w, k); else if (w->needComma) puts_(w, ",");
    puts_(w, "{"); w->needComma = 0;
}
void mt_jw_obj_end(MtJsonW *w) { puts_(w, "}"); w->needComma = 1; }
int mt_jw_end(MtJsonW *w) { puts_(w, "}\n"); return !w->overflow; }
