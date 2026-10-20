/* Interactive mode: the request queue between the pipe thread (push, read the reply, release) and the frame
 * thread (take, complete), plus the line-JSON request parser and the error reply. No threads and no locks here —
 * the glue serialises access with its own critical section — so every function is host-testable. */
#include "mt_pure.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>

void mt_queue_init(MtQueue *q) {
    memset(q, 0, sizeof *q);
    q->nextSeq = 1;
}

MtRequest *mt_queue_push(MtQueue *q, long id, MtQOp op, const char *text, int frames) {
    size_t n = text ? strlen(text) : 0;
    if (n > MT_MAX_CMD) return NULL;
    for (int i = 0; i < MT_Q_SLOTS; i++) {
        MtRequest *r = &q->slots[i];
        if (r->state != MT_Q_FREE) continue;
        r->state = MT_Q_PENDING;
        r->seq = q->nextSeq++;
        r->id = id;
        r->op = op;
        r->frames = frames;
        memcpy(r->text, text ? text : "", n);
        r->text[n] = 0;
        r->reply[0] = 0;
        return r;
    }
    return NULL;
}

MtRequest *mt_queue_take(MtQueue *q) {
    MtRequest *oldest = NULL;
    for (int i = 0; i < MT_Q_SLOTS; i++) {
        MtRequest *r = &q->slots[i];
        if (r->state == MT_Q_ACTIVE) return NULL;           /* one request in flight at a time */
        if (r->state == MT_Q_PENDING && (!oldest || r->seq < oldest->seq)) oldest = r;
    }
    if (oldest) oldest->state = MT_Q_ACTIVE;
    return oldest;
}

void mt_queue_complete(MtRequest *r, const char *replyJson) {
    snprintf(r->reply, sizeof r->reply, "%s", replyJson ? replyJson : "");
    r->state = MT_Q_DONE;
}

void mt_queue_release(MtRequest *r) {
    r->state = MT_Q_FREE;
    r->text[0] = 0;
    r->reply[0] = 0;
}

/* ---- request line: {"id":N,"op":"exec"|"dump"|"quit","text":"...","frames":K} (any key order) ---- */
static const char *skip_ws(const char *p) { while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++; return p; }

/* parse a JSON string at p (p points at the opening quote) into out; returns the position after the closing quote */
static const char *read_string(const char *p, char *out, size_t cap) {
    if (*p != '"') return NULL;
    p++;
    size_t n = 0;
    while (*p && *p != '"') {
        char c = *p++;
        if (c == '\\') {
            char e = *p++;
            if (!e) return NULL;
            switch (e) {
                case '"': c = '"'; break;
                case '\\': c = '\\'; break;
                case '/': c = '/'; break;
                case 'n': c = '\n'; break;
                case 't': c = '\t'; break;
                case 'r': c = '\r'; break;
                case 'b': c = '\b'; break;
                case 'f': c = '\f'; break;
                case 'u': {
                    unsigned v = 0;
                    for (int k = 0; k < 4; k++) {
                        char h = *p++;
                        v <<= 4;
                        if (h >= '0' && h <= '9') v |= (unsigned)(h - '0');
                        else if (h >= 'a' && h <= 'f') v |= (unsigned)(h - 'a' + 10);
                        else if (h >= 'A' && h <= 'F') v |= (unsigned)(h - 'A' + 10);
                        else return NULL;
                    }
                    c = v < 0x80 ? (char)v : '?';
                    break;
                }
                default: return NULL;
            }
        }
        if (n + 1 < cap) out[n++] = c;
    }
    if (*p != '"') return NULL;
    out[n] = 0;
    return p + 1;
}

/* skip any JSON value (string, number, literal, nested object/array) */
static const char *skip_value(const char *p) {
    p = skip_ws(p);
    if (*p == '"') { char tmp[8]; return read_string(p, tmp, sizeof tmp); }
    if (*p == '{' || *p == '[') {
        int depth = 0;
        for (; *p; p++) {
            if (*p == '"') { char tmp[8]; const char *e = read_string(p, tmp, sizeof tmp); if (!e) return NULL; p = e - 1; continue; }
            if (*p == '{' || *p == '[') depth++;
            else if (*p == '}' || *p == ']') { if (--depth == 0) return p + 1; }
        }
        return NULL;
    }
    while (*p && *p != ',' && *p != '}' && *p != ' ' && *p != '\t' && *p != '\r' && *p != '\n') p++;
    return p;
}

int mt_pipe_parse_request(const char *line, long *id, MtQOp *op, char *text, size_t cap, int *frames, char *err, size_t errCap) {
    int haveId = 0, haveOp = 0, haveText = 0;
    *frames = MT_Q_FRAMES_DEFAULT;
    text[0] = 0;
    const char *p = skip_ws(line ? line : "");
    if (*p != '{') { snprintf(err, errCap, "request is not a JSON object"); return 0; }
    p = skip_ws(p + 1);
    while (*p && *p != '}') {
        char key[32];
        p = read_string(p, key, sizeof key);
        if (!p) { snprintf(err, errCap, "bad key"); return 0; }
        p = skip_ws(p);
        if (*p != ':') { snprintf(err, errCap, "missing ':' after \"%s\"", key); return 0; }
        p = skip_ws(p + 1);
        if (!strcmp(key, "id")) {
            char *end = NULL;
            long v = strtol(p, &end, 10);
            if (end == p) { snprintf(err, errCap, "id must be a number"); return 0; }
            *id = v; haveId = 1; p = end;
        } else if (!strcmp(key, "op")) {
            char v[16];
            p = read_string(p, v, sizeof v);
            if (!p) { snprintf(err, errCap, "op must be a string"); return 0; }
            if (!strcmp(v, "exec")) *op = MT_QOP_EXEC;
            else if (!strcmp(v, "dump")) *op = MT_QOP_DUMP;
            else if (!strcmp(v, "quit")) *op = MT_QOP_QUIT;
            else { snprintf(err, errCap, "unknown op \"%s\" (exec|dump|quit)", v); return 0; }
            haveOp = 1;
        } else if (!strcmp(key, "text")) {
            p = read_string(p, text, cap);
            if (!p) { snprintf(err, errCap, "text must be a string"); return 0; }
            haveText = 1;
        } else if (!strcmp(key, "frames")) {
            char *end = NULL;
            long v = strtol(p, &end, 10);
            if (end == p) { snprintf(err, errCap, "frames must be a number"); return 0; }
            if (v < 0) v = 0;
            if (v > MT_Q_FRAMES_MAX) v = MT_Q_FRAMES_MAX;
            *frames = (int)v; p = end;
        } else {
            p = skip_value(p);
            if (!p) { snprintf(err, errCap, "bad value for \"%s\"", key); return 0; }
        }
        p = skip_ws(p);
        if (*p == ',') p = skip_ws(p + 1);
        else if (*p != '}') { snprintf(err, errCap, "expected ',' or '}'"); return 0; }
    }
    if (!haveId) { snprintf(err, errCap, "missing id"); return 0; }
    if (!haveOp) { snprintf(err, errCap, "missing op (exec|dump|quit)"); return 0; }
    if (*op == MT_QOP_EXEC && !haveText) { snprintf(err, errCap, "exec needs text"); return 0; }
    if (*op != MT_QOP_EXEC) text[0] = 0;
    return 1;
}

int mt_pipe_error_reply(char *out, size_t cap, long id, const char *msg) {
    MtJsonW w;
    mt_jw_begin(&w, out, cap, "exec");
    mt_jw_int(&w, "id", id);
    mt_jw_bool(&w, "ok", 0);
    mt_jw_str(&w, "error", msg ? msg : "");
    int ok = mt_jw_end(&w);
    size_t n = strlen(out);
    if (n && out[n - 1] == '\n') out[n - 1] = 0;       /* the writer appends the newline itself */
    return ok;
}
