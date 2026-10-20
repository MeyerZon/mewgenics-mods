/* .mewtest directive parser (the DLL side: directives only; the Node runner strips the
 * header). Whole-line '#' comments; `cmd` takes the rest of the line verbatim. */
#include "mt_pure.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>

static int fail(char *err, size_t cap, int *line, int lineNo, const char *msg) {
    if (err && cap) snprintf(err, cap, "%s", msg);
    if (line) *line = lineNo;
    return 0;
}

static const char *arena_add(MtScript *s, const char *text, size_t n) {
    if (s->arenaUsed + n + 1 > MT_ARENA_BYTES) return NULL;
    char *p = s->arena + s->arenaUsed;
    memcpy(p, text, n);
    p[n] = 0;
    s->arenaUsed += n + 1;
    return p;
}

static int is_ws(char c) { return c == ' ' || c == '\t'; }
static const char *skip_ws(const char *p) { while (is_ws(*p)) p++; return p; }

/* token = run of non-whitespace starting at p; returns its length */
static size_t tok_len(const char *p) { size_t n = 0; while (p[n] && !is_ws(p[n])) n++; return n; }

/* parse "..." at p into out (unescaped); returns the char after the closing quote, NULL if bad */
static const char *parse_quoted(const char *p, char *out, size_t cap, size_t *outLen) {
    if (*p != '"') return NULL;
    p++;
    size_t n = 0;
    while (*p) {
        if (*p == '\\' && (p[1] == '"' || p[1] == '\\')) { if (n + 1 < cap) out[n++] = p[1]; p += 2; continue; }
        if (*p == '"') { out[n] = 0; *outLen = n; return p + 1; }
        if (n + 1 < cap) out[n++] = *p;
        p++;
    }
    return NULL;
}

int mt_scene_id(const char *name) {
    return name && strcmp(name, "TacticsTest") == 0 ? MT_SCENE_TACTICS_TEST : 0;
}
const char *mt_scene_name(int scene) {
    return scene == MT_SCENE_TACTICS_TEST ? "TacticsTest" : "";
}

static int parse_uint(const char *p, size_t n, long *out) {
    if (n == 0 || n > 9) return 0;
    for (size_t i = 0; i < n; i++) if (p[i] < '0' || p[i] > '9') return 0;
    *out = strtol(p, NULL, 10);
    return 1;
}

static int parse_line(MtScript *s, const char *line, size_t len, int lineNo, char *err, size_t errCap, int *errLine) {
    char tmp[MT_MAX_LINE + 1];
    if (len > MT_MAX_LINE) return fail(err, errCap, errLine, lineNo, "line longer than 4096 bytes");
    memcpy(tmp, line, len);
    tmp[len] = 0;
    /* trim */
    char *p = tmp;
    while (is_ws(*p)) p++;
    size_t n = strlen(p);
    while (n && (is_ws(p[n - 1]) || p[n - 1] == '\r')) p[--n] = 0;
    if (!n || *p == '#') return 1;
    if (s->count >= MT_MAX_DIRECTIVES) return fail(err, errCap, errLine, lineNo, "too many directives (max 1024)");

    MtDirective d;
    memset(&d, 0, sizeof d);
    d.line = lineNo;
    size_t wl = tok_len(p);
    const char *rest = skip_ws(p + wl);
    char q[MT_MAX_LINE + 1];
    size_t qn = 0;

    if (wl == 3 && !strncmp(p, "cmd", 3)) {
        if (!*rest) return fail(err, errCap, errLine, lineNo, "cmd needs a console command");
        if (strlen(rest) > MT_MAX_CMD) return fail(err, errCap, errLine, lineNo, "cmd longer than 4078 bytes");
        d.kind = MT_D_CMD;
        if (!(d.a = arena_add(s, rest, strlen(rest)))) return fail(err, errCap, errLine, lineNo, "script too large");
    } else if (wl == 4 && !strncmp(p, "wait", 4)) {
        size_t ul = tok_len(rest);
        const char *num = skip_ws(rest + ul);
        size_t nl = tok_len(num);
        if (!ul || !nl || *skip_ws(num + nl)) return fail(err, errCap, errLine, lineNo, "wait needs a unit (frames|turns|ms) and a count");
        if (ul == 6 && !strncmp(rest, "frames", 6)) d.kind = MT_D_WAIT_FRAMES;
        else if (ul == 5 && !strncmp(rest, "turns", 5)) d.kind = MT_D_WAIT_TURNS;
        else if (ul == 2 && !strncmp(rest, "ms", 2)) d.kind = MT_D_WAIT_MS;
        else return fail(err, errCap, errLine, lineNo, "bad wait unit (frames|turns|ms)");
        if (!parse_uint(num, nl, &d.n) || d.n < 1) return fail(err, errCap, errLine, lineNo, "wait count must be an integer >= 1");
    } else if (wl == 6 && !strncmp(p, "expect", 6)) {
        size_t kl = tok_len(rest);
        const char *arg = skip_ws(rest + kl);
        if ((kl == 7 && !strncmp(rest, "console", 7)) || (kl == 9 && !strncmp(rest, "noconsole", 9))) {
            d.kind = kl == 7 ? MT_D_EXPECT_CONSOLE : MT_D_EXPECT_NOCONSOLE;
            const char *after = parse_quoted(arg, q, sizeof q, &qn);
            if (!after) return fail(err, errCap, errLine, lineNo, "expect console/noconsole needs a quoted substring");
            after = skip_ws(after);
            if (*after) {
                size_t tl = tok_len(after);
                const char *num = skip_ws(after + tl);
                size_t nl = tok_len(num);
                long w = 0;
                if (!(tl == 6 && !strncmp(after, "within", 6)) || !parse_uint(num, nl, &w) || w < 1 || *skip_ws(num + nl))
                    return fail(err, errCap, errLine, lineNo, "unexpected text after the quoted substring (only `within N` is allowed)");
                d.within = (int)w;
            }
            if (!(d.a = arena_add(s, q, qn))) return fail(err, errCap, errLine, lineNo, "script too large");
        } else if (kl == 6 && !strncmp(rest, "status", 6)) {
            d.kind = MT_D_EXPECT_STATUS;
            size_t sl = tok_len(arg);
            const char *on = skip_ws(arg + sl);
            if (!sl || tok_len(on) != 2 || strncmp(on, "on", 2)) return fail(err, errCap, errLine, lineNo, "expect status needs: <StatusName> on <unit>");
            const char *unit = skip_ws(on + 2);
            if (!*unit) return fail(err, errCap, errLine, lineNo, "expect status needs: <StatusName> on <unit>");
            if (!(d.a = arena_add(s, arg, sl))) return fail(err, errCap, errLine, lineNo, "script too large");
            if (*unit == '"') {
                const char *after = parse_quoted(unit, q, sizeof q, &qn);
                if (!after || *skip_ws(after)) return fail(err, errCap, errLine, lineNo, "expect status: bad quoted unit name");
                if (!(d.b = arena_add(s, q, qn))) return fail(err, errCap, errLine, lineNo, "script too large");
            } else {
                size_t ul = tok_len(unit);
                if (*skip_ws(unit + ul)) return fail(err, errCap, errLine, lineNo, "expect status: quote a unit name that contains spaces");
                long idx;
                if (parse_uint(unit, ul, &idx)) { d.unitIsIndex = 1; d.n = idx; }
                else if (!(d.b = arena_add(s, unit, ul))) return fail(err, errCap, errLine, lineNo, "script too large");
            }
        } else if (kl == 5 && !strncmp(rest, "units", 5)) {
            d.kind = MT_D_EXPECT_UNITS;
            size_t ol = tok_len(arg);
            const char *num = skip_ws(arg + ol);
            size_t nl = tok_len(num);
            if (!ol || !nl || *skip_ws(num + nl)) return fail(err, errCap, errLine, lineNo, "expect units needs: <op> <N>");
            if (ol == 2 && !strncmp(arg, "==", 2)) d.op = MT_OP_EQ;
            else if (ol == 2 && !strncmp(arg, "!=", 2)) d.op = MT_OP_NE;
            else if (ol == 2 && !strncmp(arg, ">=", 2)) d.op = MT_OP_GE;
            else if (ol == 2 && !strncmp(arg, "<=", 2)) d.op = MT_OP_LE;
            else if (ol == 1 && arg[0] == '>') d.op = MT_OP_GT;
            else if (ol == 1 && arg[0] == '<') d.op = MT_OP_LT;
            else return fail(err, errCap, errLine, lineNo, "expect units: bad operator (== != >= <= > <)");
            if (!parse_uint(num, nl, &d.n)) return fail(err, errCap, errLine, lineNo, "expect units: N must be an integer");
        } else {
            return fail(err, errCap, errLine, lineNo, "expect needs a kind (console|noconsole|status|units)");
        }
    } else if (wl == 4 && !strncmp(p, "dump", 4)) {
        if (*rest) return fail(err, errCap, errLine, lineNo, "dump takes no arguments");
        d.kind = MT_D_DUMP;
    } else if (wl == 3 && !strncmp(p, "log", 3)) {
        const char *after = parse_quoted(rest, q, sizeof q, &qn);
        if (!after || *skip_ws(after)) return fail(err, errCap, errLine, lineNo, "log needs one quoted string");
        d.kind = MT_D_LOG;
        if (!(d.a = arena_add(s, q, qn))) return fail(err, errCap, errLine, lineNo, "script too large");
    } else if (wl == 5 && !strncmp(p, "enter", 5)) {
        size_t sl = tok_len(rest);
        if (!sl) return fail(err, errCap, errLine, lineNo, "enter needs a scene name (TacticsTest)");
        if (*skip_ws(rest + sl)) return fail(err, errCap, errLine, lineNo, "enter takes exactly one scene name");
        char name[64];
        snprintf(name, sizeof name, "%.*s", (int)(sl > 63 ? 63 : sl), rest);
        d.kind = MT_D_ENTER;
        d.scene = mt_scene_id(name);
        if (!d.scene) {
            char msg[128];
            snprintf(msg, sizeof msg, "unknown scene \"%s\" (TacticsTest)", name);
            return fail(err, errCap, errLine, lineNo, msg);
        }
    } else if (wl == 4 && !strncmp(p, "quit", 4)) {
        d.kind = MT_D_QUIT;
        if (*rest) {
            size_t nl = tok_len(rest);
            if (!parse_uint(rest, nl, &d.n) || d.n > 255 || *skip_ws(rest + nl)) return fail(err, errCap, errLine, lineNo, "quit code must be an integer 0..255");
            d.hasCode = 1;
        }
    } else {
        char msg[96];
        snprintf(msg, sizeof msg, "unknown directive \"%.*s\"", (int)(wl > 40 ? 40 : wl), p);
        return fail(err, errCap, errLine, lineNo, msg);
    }
    s->d[s->count++] = d;
    return 1;
}

int mt_script_parse(const char *text, size_t len, MtScript *out, char *err, size_t errCap, int *errLine) {
    out->count = 0;
    out->arenaUsed = 0;
    if (err && errCap) err[0] = 0;
    if (errLine) *errLine = 0;
    size_t start = 0;
    int lineNo = 1;
    for (size_t i = 0; i <= len; i++) {
        if (i == len || text[i] == '\n') {
            if (!parse_line(out, text + start, i - start, lineNo, err, errCap, errLine)) return 0;
            start = i + 1;
            lineNo++;
        }
    }
    return 1;
}
