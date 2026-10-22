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
    if (!name) return 0;
    if (strcmp(name, "TacticsTest") == 0) return MT_SCENE_TACTICS_TEST;
    if (strcmp(name, "Campaign") == 0) return MT_SCENE_CAMPAIGN;
    return 0;
}
const char *mt_enter_mode_name(int mode) { return mode == MT_ENTER_HOUSE ? "house" : ""; }
const char *mt_scene_name(int scene) {
    return scene == MT_SCENE_TACTICS_TEST ? "TacticsTest" : scene == MT_SCENE_CAMPAIGN ? "Campaign" : "";
}

static int parse_op(const char *p, size_t n, MtOp *out) {
    if (n == 2 && !strncmp(p, "==", 2)) *out = MT_OP_EQ;
    else if (n == 2 && !strncmp(p, "!=", 2)) *out = MT_OP_NE;
    else if (n == 2 && !strncmp(p, ">=", 2)) *out = MT_OP_GE;
    else if (n == 2 && !strncmp(p, "<=", 2)) *out = MT_OP_LE;
    else if (n == 1 && p[0] == '>') *out = MT_OP_GT;
    else if (n == 1 && p[0] == '<') *out = MT_OP_LT;
    else return 0;
    return 1;
}

/* MtUnitField order; the units event's keys; script.ts UNIT_FIELDS */
static const char *const UNIT_FIELDS[] = { "name", "class", "namekey", "faction", "move", "act", "turnkind", "hp", "shield", "divineshield",
                                           "strength", "dexterity", "constitution", "intelligence", "speed", "charisma", "luck",
                                           "strength.effective", "dexterity.effective", "constitution.effective", "intelligence.effective",
                                           "speed.effective", "charisma.effective", "luck.effective", "maxhp.effective" };
int mt_unit_field_parse(const char *p, size_t n, MtUnitField *out) {
    for (size_t i = 0; i < sizeof UNIT_FIELDS / sizeof UNIT_FIELDS[0]; i++) {
        if (strlen(UNIT_FIELDS[i]) == n && !strncmp(p, UNIT_FIELDS[i], n)) { *out = (MtUnitField)i; return 1; }
    }
    return 0;
}
const char *mt_unit_field_name(MtUnitField f) { return (unsigned)f < sizeof UNIT_FIELDS / sizeof UNIT_FIELDS[0] ? UNIT_FIELDS[f] : "?"; }

static int parse_uint(const char *p, size_t n, long *out) {
    if (n == 0 || n > 9) return 0;
    for (size_t i = 0; i < n; i++) if (p[i] < '0' || p[i] > '9') return 0;
    *out = strtol(p, NULL, 10);
    return 1;
}
/* an optionally negative integer (hp / stat fields can go below 0 in play) */
static int parse_int(const char *p, size_t n, long *out) {
    int neg = n > 1 && p[0] == '-';
    if (!parse_uint(p + neg, n - neg, out)) return 0;
    if (neg) *out = -*out;
    return 1;
}
/* -?digits[.digits]: the shape of an expect gon numeric literal (strtod does the value) */
static int parse_number(const char *p, size_t n, double *out) {
    size_t i = 0, digits = 0;
    if (i < n && p[i] == '-') i++;
    while (i < n && p[i] >= '0' && p[i] <= '9') { i++; digits++; }
    if (i < n && p[i] == '.') { i++; while (i < n && p[i] >= '0' && p[i] <= '9') { i++; digits++; } }
    if (i != n || !digits) return 0;
    char tmp[40];
    if (n >= sizeof tmp) return 0;
    memcpy(tmp, p, n); tmp[n] = 0;
    *out = strtod(tmp, NULL);
    return 1;
}
/* a GON path: non-empty dot-separated segments, none empty ("a.b.0"; not ".a", "a.", "a..b") */
static int path_ok(const char *p, size_t n) {
    if (!n || p[0] == '.' || p[n - 1] == '.') return 0;
    for (size_t i = 1; i < n; i++) if (p[i] == '.' && p[i - 1] == '.') return 0;
    return 1;
}
/* <idx|bareword|"name"> at p: fills d (unitIsIndex/n or b); returns the char after it, NULL on a bad quoted name / arena */
static const char *parse_unit(MtScript *s, const char *p, MtDirective *d, char *q, size_t qcap, int *arenaFull) {
    size_t qn = 0;
    *arenaFull = 0;
    if (*p == '"') {
        const char *after = parse_quoted(p, q, qcap, &qn);
        if (!after) return NULL;
        if (!(d->b = arena_add(s, q, qn))) { *arenaFull = 1; return NULL; }
        return after;
    }
    size_t ul = tok_len(p);
    long idx;
    if (parse_uint(p, ul, &idx)) { d->unitIsIndex = 1; d->n = idx; }
    else if (!(d->b = arena_add(s, p, ul))) { *arenaFull = 1; return NULL; }
    return p + ul;
}

/* a colour component: digits with at most one '.', no sign, 0 <= v <= 1 */
static int parse_unit_float(const char *p, size_t n, float *out) {
    char tmp[32];
    int digits = 0, dots = 0;
    if (n == 0 || n >= sizeof tmp) return 0;
    for (size_t i = 0; i < n; i++) {
        if (p[i] >= '0' && p[i] <= '9') digits++;
        else if (p[i] == '.') dots++;
        else return 0;
    }
    if (!digits || dots > 1) return 0;
    memcpy(tmp, p, n); tmp[n] = 0;
    double v = strtod(tmp, NULL);
    if (v < 0.0 || v > 1.0) return 0;
    *out = (float)v;
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
        else if (ul == 6 && !strncmp(rest, "rounds", 6)) d.kind = MT_D_WAIT_ROUNDS;
        else if (ul == 2 && !strncmp(rest, "ms", 2)) d.kind = MT_D_WAIT_MS;
        else return fail(err, errCap, errLine, lineNo, "bad wait unit (frames|turns|rounds|ms)");
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
        } else if ((kl == 5 && !strncmp(rest, "units", 5)) || (kl == 5 && !strncmp(rest, "round", 5))) {
            int isRound = rest[0] == 'r';
            d.kind = isRound ? MT_D_EXPECT_ROUND : MT_D_EXPECT_UNITS;
            size_t ol = tok_len(arg);
            const char *num = skip_ws(arg + ol);
            size_t nl = tok_len(num);
            if (!ol || !nl || *skip_ws(num + nl)) return fail(err, errCap, errLine, lineNo, isRound ? "expect round needs: <op> <N>" : "expect units needs: <op> <N>");
            if (!parse_op(arg, ol, &d.op)) return fail(err, errCap, errLine, lineNo, isRound ? "expect round: bad operator (== != >= <= > <)" : "expect units: bad operator (== != >= <= > <)");
            if (!parse_uint(num, nl, &d.n)) return fail(err, errCap, errLine, lineNo, isRound ? "expect round: N must be an integer" : "expect units: N must be an integer");
        } else if (kl == 6 && !strncmp(rest, "stacks", 6)) {
            /* expect stacks <Status> on <unit> (<op> <N> | varied) */
            d.kind = MT_D_EXPECT_STACKS;
            size_t sl = tok_len(arg);
            const char *on = skip_ws(arg + sl);
            if (!sl || tok_len(on) != 2 || strncmp(on, "on", 2)) return fail(err, errCap, errLine, lineNo, "expect stacks needs: <Status> on <unit> (<op> <N> | varied)");
            const char *unit = skip_ws(on + 2);
            if (!*unit) return fail(err, errCap, errLine, lineNo, "expect stacks needs: <Status> on <unit> (<op> <N> | varied)");
            if (!(d.a = arena_add(s, arg, sl))) return fail(err, errCap, errLine, lineNo, "script too large");
            const char *tail;
            if (*unit == '"') {
                tail = parse_quoted(unit, q, sizeof q, &qn);
                if (!tail) return fail(err, errCap, errLine, lineNo, "expect stacks: bad quoted unit name");
                if (!(d.b = arena_add(s, q, qn))) return fail(err, errCap, errLine, lineNo, "script too large");
            } else {
                size_t ul = tok_len(unit);
                long idx;
                if (parse_uint(unit, ul, &idx)) { d.unitIsIndex = 1; d.n = idx; }
                else if (!(d.b = arena_add(s, unit, ul))) return fail(err, errCap, errLine, lineNo, "script too large");
                tail = unit + ul;
            }
            tail = skip_ws(tail);
            size_t tl = tok_len(tail);
            if (tl == 6 && !strncmp(tail, "varied", 6)) {
                if (*skip_ws(tail + tl)) return fail(err, errCap, errLine, lineNo, "expect stacks: unexpected text after varied");
                d.varied = 1;
            } else {
                const char *num = skip_ws(tail + tl);
                size_t nl = tok_len(num);
                if (!tl || !nl || *skip_ws(num + nl)) return fail(err, errCap, errLine, lineNo, "expect stacks needs: <Status> on <unit> (<op> <N> | varied)");
                if (!parse_op(tail, tl, &d.op)) return fail(err, errCap, errLine, lineNo, "expect stacks: bad operator (== != >= <= > <) or `varied`");
                if (!parse_uint(num, nl, &d.value)) return fail(err, errCap, errLine, lineNo, "expect stacks: N must be an integer");
            }
        } else if (kl == 4 && !strncmp(rest, "unit", 4)) {
            /* expect unit <idx|bareword|"name"> <field> <op> <value> */
            d.kind = MT_D_EXPECT_UNIT;
            const char *unit = arg, *tail;
            if (!*unit) return fail(err, errCap, errLine, lineNo, "expect unit needs: <unit> <field> <op> <value>");
            if (*unit == '"') {
                tail = parse_quoted(unit, q, sizeof q, &qn);
                if (!tail) return fail(err, errCap, errLine, lineNo, "expect unit: bad quoted unit name");
                if (!(d.b = arena_add(s, q, qn))) return fail(err, errCap, errLine, lineNo, "script too large");
            } else {
                size_t ul = tok_len(unit);
                long idx;
                if (parse_uint(unit, ul, &idx)) { d.unitIsIndex = 1; d.n = idx; }
                else if (!(d.b = arena_add(s, unit, ul))) return fail(err, errCap, errLine, lineNo, "script too large");
                tail = unit + ul;
            }
            const char *field = skip_ws(tail);
            size_t fl = tok_len(field);
            if (!fl || !mt_unit_field_parse(field, fl, &d.field)) return fail(err, errCap, errLine, lineNo, "expect unit: unknown field (name|class|namekey|faction|move|act|turnkind|hp|shield|divineshield|strength|dexterity|constitution|intelligence|speed|charisma|luck, <stat>.effective, maxhp.effective)");
            const char *opp = skip_ws(field + fl);
            size_t ol = tok_len(opp);
            const char *val = skip_ws(opp + ol);
            if (!ol || !*val) return fail(err, errCap, errLine, lineNo, "expect unit needs: <unit> <field> <op> <value>");
            if (!parse_op(opp, ol, &d.op)) return fail(err, errCap, errLine, lineNo, "expect unit: bad operator (== != >= <= > <)");
            if (d.field == MT_F_NAME || d.field == MT_F_CLASS || d.field == MT_F_NAMEKEY) {
                if (d.op != MT_OP_EQ && d.op != MT_OP_NE) return fail(err, errCap, errLine, lineNo, "expect unit: name/class/namekey take == or != and a quoted value");
                const char *after = parse_quoted(val, q, sizeof q, &qn);
                if (!after || *skip_ws(after)) return fail(err, errCap, errLine, lineNo, "expect unit: name/class/namekey take == or != and a quoted value");
                if (!(d.a = arena_add(s, q, qn))) return fail(err, errCap, errLine, lineNo, "script too large");
            } else {
                size_t nl = tok_len(val);
                if (!parse_int(val, nl, &d.value) || *skip_ws(val + nl)) return fail(err, errCap, errLine, lineNo, "expect unit: the integer fields take one integer");
            }
        } else if (kl == 3 && !strncmp(rest, "gon", 3)) {
            /* expect gon <idx|bareword|"name"> <path> (<op> <number> | ==|!= "<string>" | ==|!= true|false | exists | missing) */
            static const char *const usage = "expect gon needs: <unit> <path> (<op> <number> | ==|!= \"<string>\" | ==|!= true|false | exists | missing)";
            d.kind = MT_D_EXPECT_GON;
            if (!*arg) return fail(err, errCap, errLine, lineNo, usage);
            int full = 0;
            const char *tail = parse_unit(s, arg, &d, q, sizeof q, &full);
            if (!tail) return fail(err, errCap, errLine, lineNo, full ? "script too large" : "expect gon: bad quoted unit name");
            const char *path = skip_ws(tail);
            size_t pl = tok_len(path);
            if (!pl) return fail(err, errCap, errLine, lineNo, usage);
            if (!path_ok(path, pl)) return fail(err, errCap, errLine, lineNo, "expect gon: the path is dot-separated segments, none empty (properties.health, abilities.spells.0)");
            if (!(d.a = arena_add(s, path, pl))) return fail(err, errCap, errLine, lineNo, "script too large");
            const char *word = skip_ws(path + pl);
            size_t wl2 = tok_len(word);
            if (!wl2) return fail(err, errCap, errLine, lineNo, usage);
            if ((wl2 == 6 && !strncmp(word, "exists", 6)) || (wl2 == 7 && !strncmp(word, "missing", 7))) {
                d.gonCheck = wl2 == 6 ? MT_G_EXISTS : MT_G_MISSING;
                if (*skip_ws(word + wl2)) return fail(err, errCap, errLine, lineNo, "expect gon: unexpected text after exists/missing");
            } else {
                if (!parse_op(word, wl2, &d.op)) return fail(err, errCap, errLine, lineNo, "expect gon: bad operator (== != >= <= > <) or exists/missing");
                const char *val = skip_ws(word + wl2);
                if (!*val) return fail(err, errCap, errLine, lineNo, usage);
                if (*val == '"') {
                    d.gonCheck = MT_G_STR;
                    if (d.op != MT_OP_EQ && d.op != MT_OP_NE) return fail(err, errCap, errLine, lineNo, "expect gon: a quoted string takes == or !=");
                    const char *after = parse_quoted(val, q, sizeof q, &qn);
                    if (!after || *skip_ws(after)) return fail(err, errCap, errLine, lineNo, "expect gon: bad quoted value or text after it");
                    if (!(d.c = arena_add(s, q, qn))) return fail(err, errCap, errLine, lineNo, "script too large");
                } else {
                    size_t vl = tok_len(val);
                    if (*skip_ws(val + vl)) return fail(err, errCap, errLine, lineNo, "expect gon: unexpected text after the value");
                    if ((vl == 4 && !strncmp(val, "true", 4)) || (vl == 5 && !strncmp(val, "false", 5))) {
                        d.gonCheck = MT_G_BOOL;
                        d.value = vl == 4;
                        if (d.op != MT_OP_EQ && d.op != MT_OP_NE) return fail(err, errCap, errLine, lineNo, "expect gon: true/false take == or !=");
                    } else {
                        d.gonCheck = MT_G_NUM;
                        if (!parse_number(val, vl, &d.dvalue)) return fail(err, errCap, errLine, lineNo, "expect gon: the value is a number (-?digits[.digits]), a quoted string or true/false");
                    }
                }
            }
        } else {
            return fail(err, errCap, errLine, lineNo, "expect needs a kind (console|noconsole|status|units|round|stacks|unit|gon)");
        }
    } else if (wl == 4 && !strncmp(p, "dump", 4)) {
        if (*rest) return fail(err, errCap, errLine, lineNo, "dump takes no arguments");
        d.kind = MT_D_DUMP;
    } else if (wl == 4 && !strncmp(p, "seed", 4)) {
        size_t nl = tok_len(rest);
        if (!nl || nl > 20 || *skip_ws(rest + nl)) return fail(err, errCap, errLine, lineNo, "seed needs one unsigned integer (0..18446744073709551615)");
        for (size_t i = 0; i < nl; i++) if (rest[i] < '0' || rest[i] > '9') return fail(err, errCap, errLine, lineNo, "seed needs one unsigned integer (0..18446744073709551615)");
        d.kind = MT_D_SEED;
        d.seed = strtoull(rest, NULL, 10);
    } else if (wl == 4 && !strncmp(p, "shot", 4)) {
        const char *after = parse_quoted(rest, q, sizeof q, &qn);
        if (!after || *skip_ws(after)) return fail(err, errCap, errLine, lineNo, "shot needs one quoted label");
        d.kind = MT_D_SHOT;
        if (!(d.a = arena_add(s, q, qn))) return fail(err, errCap, errLine, lineNo, "script too large");
    } else if (wl == 3 && !strncmp(p, "log", 3)) {
        const char *after = parse_quoted(rest, q, sizeof q, &qn);
        if (!after || *skip_ws(after)) return fail(err, errCap, errLine, lineNo, "log needs one quoted string");
        d.kind = MT_D_LOG;
        if (!(d.a = arena_add(s, q, qn))) return fail(err, errCap, errLine, lineNo, "script too large");
    } else if (wl == 5 && !strncmp(p, "enter", 5)) {
        size_t sl = tok_len(rest);
        if (!sl) return fail(err, errCap, errLine, lineNo, "enter needs a scene name (TacticsTest|Campaign)");
        const char *modeTok = *skip_ws(rest + sl) ? skip_ws(rest + sl) : NULL;   /* "enter Campaign house" */
        char name[64];
        snprintf(name, sizeof name, "%.*s", (int)(sl > 63 ? 63 : sl), rest);
        d.kind = MT_D_ENTER;
        d.scene = mt_scene_id(name);
        if (!d.scene) {
            char msg[128];
            snprintf(msg, sizeof msg, "unknown scene \"%s\" (TacticsTest|Campaign)", name);
            return fail(err, errCap, errLine, lineNo, msg);
        }
        if (modeTok) {
            size_t ml = tok_len(modeTok);
            if (d.scene != MT_SCENE_CAMPAIGN || ml != 5 || strncmp(modeTok, "house", 5)) return fail(err, errCap, errLine, lineNo, "enter: the only mode is: enter Campaign house");
            if (*skip_ws(modeTok + ml)) return fail(err, errCap, errLine, lineNo, "enter takes a scene name and at most one mode word");
            d.enterMode = MT_ENTER_HOUSE;
        }
    } else if (wl == 4 && !strncmp(p, "glow", 4)) {
        /* glow <idx|bareword|"name"> (<r> <g> <b> <a> | off) */
        d.kind = MT_D_GLOW;
        if (!*rest) return fail(err, errCap, errLine, lineNo, "glow needs: <unit> <r> <g> <b> <a> | <unit> off");
        if (!(d.a = arena_add(s, rest, strlen(rest)))) return fail(err, errCap, errLine, lineNo, "script too large");
        const char *unit = rest, *tail;
        if (*unit == '"') {
            tail = parse_quoted(unit, q, sizeof q, &qn);
            if (!tail) return fail(err, errCap, errLine, lineNo, "glow: bad quoted unit name");
            if (!(d.b = arena_add(s, q, qn))) return fail(err, errCap, errLine, lineNo, "script too large");
        } else {
            size_t ul = tok_len(unit);
            long idx;
            if (parse_uint(unit, ul, &idx)) { d.unitIsIndex = 1; d.n = idx; }
            else if (!(d.b = arena_add(s, unit, ul))) return fail(err, errCap, errLine, lineNo, "script too large");
            tail = unit + ul;
        }
        tail = skip_ws(tail);
        size_t tl = tok_len(tail);
        if (tl == 3 && !strncmp(tail, "off", 3)) {
            if (*skip_ws(tail + tl)) return fail(err, errCap, errLine, lineNo, "glow: unexpected text after off");
            d.glowOff = 1;
        } else {
            const char *t = tail;
            for (int k = 0; k < 4; k++) {
                size_t nl = tok_len(t);
                if (!nl || !parse_unit_float(t, nl, &d.rgba[k])) return fail(err, errCap, errLine, lineNo, "glow needs four colour values 0..1 (r g b a) or off");
                t = skip_ws(t + nl);
            }
            if (*t) return fail(err, errCap, errLine, lineNo, "glow: unexpected text after the colour");
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
