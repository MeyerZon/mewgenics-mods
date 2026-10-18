/* Frame-driven directive state machine. One mt_runner_step() per game frame (called from
 * the FrameBegin hook on the main thread). Every step: emit new turns, emit new console
 * lines, then advance one directive (waits consume steps). All game access goes through
 * the MtHost vtable so this file is host-testable with a fake. */
#include "mt_pure.h"
#include <string.h>
#include <stdio.h>

static char g_json[65536];
static char g_line[4096];

static void stamp_and_emit(MtRunner *r, const MtHost *h, MtJsonW *w) {
    mt_jw_int(w, "t", (long long)(r->now - r->t0));
    mt_jw_int(w, "frame", r->frame);
    mt_jw_end(w);
    h->emit(h->user, g_json);
}

static void emit_turn(MtRunner *r, const MtHost *h) {
    MtJsonW w;
    mt_jw_begin(&w, g_json, sizeof g_json, "turn");
    mt_jw_int(&w, "n", r->turnsSeen);
    mt_jw_int(&w, "round", h->round_number(h->user));
    stamp_and_emit(r, h, &w);
}

static void poll_console(MtRunner *r, const MtHost *h) {
    int first, num;
    mt_console_poll(&r->con, h->console_count(h->user), &first, &num);
    for (int i = 0; i < num; i++) {
        if (!h->console_line(h->user, first + i, g_line, sizeof g_line)) continue;
        MtJsonW w;
        mt_jw_begin(&w, g_json, sizeof g_json, "console");
        mt_jw_str(&w, "text", g_line);
        stamp_and_emit(r, h, &w);
    }
}

static void emit_expect(MtRunner *r, const MtHost *h, const MtDirective *d, const char *kind, const char *arg, int ok, const char *detail) {
    if (ok) r->expectPass++; else r->expectFail++;
    MtJsonW w;
    mt_jw_begin(&w, g_json, sizeof g_json, "expect");
    mt_jw_int(&w, "line", d->line);
    mt_jw_str(&w, "kind", kind);
    mt_jw_str(&w, "arg", arg);
    mt_jw_bool(&w, "ok", ok);
    mt_jw_str(&w, "detail", detail);
    stamp_and_emit(r, h, &w);
}

static void emit_wait(MtRunner *r, const MtHost *h, const MtDirective *d, const char *kind, long actual) {
    MtJsonW w;
    mt_jw_begin(&w, g_json, sizeof g_json, "wait");
    mt_jw_int(&w, "line", d->line);
    mt_jw_str(&w, "kind", kind);
    mt_jw_int(&w, "n", d->n);
    mt_jw_int(&w, "actual", actual);
    stamp_and_emit(r, h, &w);
}

static void finish(MtRunner *r, const MtHost *h, int code, const char *reason) {
    if (r->finished) return;
    r->finished = 1;
    r->exitCode = code;
    MtJsonW w;
    mt_jw_begin(&w, g_json, sizeof g_json, "end");
    mt_jw_int(&w, "code", code);
    mt_jw_str(&w, "reason", reason);
    mt_jw_int(&w, "frames", r->frame);
    mt_jw_int(&w, "turns", r->turnsSeen);
    mt_jw_int(&w, "elapsed_ms", (long long)(r->now - r->t0));
    mt_jw_int(&w, "expect_pass", r->expectPass);
    mt_jw_int(&w, "expect_fail", r->expectFail);
    stamp_and_emit(r, h, &w);
}

/* index of the first console line in the current window containing `sub`, or -1 */
static int find_in_window(MtRunner *r, const MtHost *h, const char *sub) {
    for (int i = r->con.windowStart; i < r->con.seen; i++) {
        if (!h->console_line(h->user, i, g_line, sizeof g_line)) continue;
        if (strstr(g_line, sub)) return i;
    }
    return -1;
}

static int resolve_unit(const MtHost *h, const MtDirective *d, MtUnit *u) {
    int count = h->unit_count(h->user);
    if (d->unitIsIndex) {
        if (d->n < 0 || d->n >= count) return -1;
        return h->unit_info(h->user, (int)d->n, u) ? (int)d->n : -1;
    }
    for (int i = 0; i < count; i++) {
        if (h->unit_info(h->user, i, u) && !strcmp(u->name, d->b)) return i;
    }
    return -1;
}

static void do_dump(MtRunner *r, const MtHost *h) {
    int avail = h->units_available(h->user);
    int count = avail ? h->unit_count(h->user) : 0;
    MtJsonW w;
    mt_jw_begin(&w, g_json, sizeof g_json, "units");
    mt_jw_bool(&w, "available", avail);
    mt_jw_int(&w, "round", h->round_number(h->user));
    mt_jw_int(&w, "count", count);
    mt_jw_arr_begin(&w, "list");
    for (int i = 0; i < count; i++) {
        MtUnit u;
        memset(&u, 0, sizeof u);
        if (!h->unit_info(h->user, i, &u)) continue;
        mt_jw_obj_begin(&w, NULL);
        mt_jw_int(&w, "i", i);
        mt_jw_str(&w, "name", u.name);
        mt_jw_str(&w, "class", u.cls);
        mt_jw_int(&w, "faction", u.faction);
        mt_jw_int(&w, "move", u.move);
        mt_jw_int(&w, "act", u.act);
        mt_jw_int(&w, "turnkind", u.turnKind);
        mt_jw_arr_begin(&w, "statuses");
        for (int k = 0; k < u.statusCount && k < MT_UNIT_STATUSES; k++) mt_jw_arr_str(&w, u.statuses[k]);
        mt_jw_arr_end(&w);
        mt_jw_obj_end(&w);
    }
    mt_jw_arr_end(&w);
    stamp_and_emit(r, h, &w);
}

static const char *op_text(MtOp op) {
    switch (op) { case MT_OP_EQ: return "=="; case MT_OP_NE: return "!="; case MT_OP_GE: return ">="; case MT_OP_LE: return "<="; case MT_OP_GT: return ">"; default: return "<"; }
}
static int op_apply(MtOp op, long a, long b) {
    switch (op) { case MT_OP_EQ: return a == b; case MT_OP_NE: return a != b; case MT_OP_GE: return a >= b; case MT_OP_LE: return a <= b; case MT_OP_GT: return a > b; default: return a < b; }
}

void mt_runner_init(MtRunner *r, const MtScript *s, uint64_t now) {
    memset(r, 0, sizeof *r);
    r->s = s;
    r->t0 = now;
    r->now = now;
}

void mt_runner_abort(MtRunner *r, const MtHost *h, int code, const char *reason) {
    r->now = h->now_ms(h->user);
    finish(r, h, code, reason);
}

/* run the directive at pc; returns 1 to keep running, 0 when the script finished */
static int exec_directive(MtRunner *r, const MtHost *h) {
    char arg[160], detail[200];
    if (r->pc >= r->s->count) { finish(r, h, r->expectFail ? 1 : 0, "eof"); h->request_exit(h->user, r->exitCode); return 0; }
    const MtDirective *d = &r->s->d[r->pc];
    switch (d->kind) {
        case MT_D_CMD: {
            if (!h->console_ready(h->user)) {
                r->state = MT_S_WAIT_CONSOLE;
                if (++r->consoleWaitFrames > MT_CONSOLE_WAIT_FRAMES) { finish(r, h, 4, "console_unavailable"); h->request_exit(h->user, 4); return 0; }
                return 1;
            }
            r->state = MT_S_RUN;
            MtJsonW w;
            mt_jw_begin(&w, g_json, sizeof g_json, "cmd");
            mt_jw_int(&w, "line", d->line);
            mt_jw_str(&w, "text", d->a);
            stamp_and_emit(r, h, &w);
            mt_console_mark_window(&r->con);
            h->exec_cmd(h->user, d->a);
            poll_console(r, h);
            r->pc++;
            return 1;
        }
        case MT_D_WAIT_FRAMES:
            r->waitLeft = d->n - 1;
            if (r->waitLeft <= 0) { emit_wait(r, h, d, "frames", d->n); r->pc++; }
            else r->state = MT_S_WAIT_FRAMES;
            return 1;
        case MT_D_WAIT_TURNS:
            r->waitStartTurns = r->turnsSeen;
            r->waitTarget = r->turnsSeen + d->n;
            r->state = MT_S_WAIT_TURNS;
            return 1;
        case MT_D_WAIT_MS:
            r->waitStartMs = r->now;
            r->waitDeadline = r->now + (uint64_t)d->n;
            r->state = MT_S_WAIT_MS;
            return 1;
        case MT_D_EXPECT_CONSOLE: {
            int i = find_in_window(r, h, d->a);
            if (i >= 0) { snprintf(detail, sizeof detail, "matched console line %d", i); emit_expect(r, h, d, "console", d->a, 1, detail); r->pc++; return 1; }
            if (d->within > 0) { r->withinLeft = d->within; r->state = MT_S_WAIT_WITHIN; return 1; }
            snprintf(detail, sizeof detail, "not found in %d console line(s) since the last cmd", r->con.seen - r->con.windowStart);
            emit_expect(r, h, d, "console", d->a, 0, detail);
            r->pc++;
            return 1;
        }
        case MT_D_EXPECT_NOCONSOLE: {
            int i = find_in_window(r, h, d->a);
            if (i >= 0) snprintf(detail, sizeof detail, "found in console line %d", i);
            else snprintf(detail, sizeof detail, "not found in %d console line(s) since the last cmd", r->con.seen - r->con.windowStart);
            emit_expect(r, h, d, "noconsole", d->a, i < 0, detail);
            r->pc++;
            return 1;
        }
        case MT_D_EXPECT_STATUS: {
            if (d->unitIsIndex) snprintf(arg, sizeof arg, "%s on %ld", d->a, d->n);
            else snprintf(arg, sizeof arg, "%s on %s", d->a, d->b);
            if (!h->units_available(h->user)) { emit_expect(r, h, d, "status", arg, 0, "no combat (units unavailable)"); r->pc++; return 1; }
            MtUnit u;
            memset(&u, 0, sizeof u);
            int idx = resolve_unit(h, d, &u);
            if (idx < 0) {
                if (d->unitIsIndex) snprintf(detail, sizeof detail, "unit not found: index %ld of %d", d->n, h->unit_count(h->user));
                else snprintf(detail, sizeof detail, "unit not found: \"%s\"", d->b);
                emit_expect(r, h, d, "status", arg, 0, detail);
                r->pc++;
                return 1;
            }
            int has = h->unit_has_status(h->user, idx, d->a);
            snprintf(detail, sizeof detail, "%s %s on unit %d \"%s\"", d->a, has ? "present" : "absent", idx, u.name);
            emit_expect(r, h, d, "status", arg, has, detail);
            r->pc++;
            return 1;
        }
        case MT_D_EXPECT_UNITS: {
            long count = h->units_available(h->user) ? h->unit_count(h->user) : 0;
            snprintf(arg, sizeof arg, "%s %ld", op_text(d->op), d->n);
            snprintf(detail, sizeof detail, "%ld units", count);
            emit_expect(r, h, d, "units", arg, op_apply(d->op, count, d->n), detail);
            r->pc++;
            return 1;
        }
        case MT_D_DUMP:
            do_dump(r, h);
            r->pc++;
            return 1;
        case MT_D_LOG: {
            MtJsonW w;
            mt_jw_begin(&w, g_json, sizeof g_json, "log");
            mt_jw_str(&w, "text", d->a);
            stamp_and_emit(r, h, &w);
            r->pc++;
            return 1;
        }
        case MT_D_QUIT: {
            int code = d->hasCode ? (int)d->n : (r->expectFail ? 1 : 0);
            finish(r, h, code, "quit");
            h->request_exit(h->user, code);
            return 0;
        }
    }
    return 1;
}

int mt_runner_step(MtRunner *r, const MtHost *h) {
    if (r->finished) return 0;
    r->frame++;
    r->now = h->now_ms(h->user);

    long tc = h->turn_count(h->user);
    while (r->turnsSeen < tc) { r->turnsSeen++; emit_turn(r, h); }
    poll_console(r, h);

    const MtDirective *d = r->pc < r->s->count ? &r->s->d[r->pc] : NULL;
    switch (r->state) {
        case MT_S_RUN:
        case MT_S_WAIT_CONSOLE:
            return exec_directive(r, h);
        case MT_S_WAIT_FRAMES:
            if (--r->waitLeft <= 0) { emit_wait(r, h, d, "frames", d->n); r->state = MT_S_RUN; r->pc++; }
            return 1;
        case MT_S_WAIT_TURNS:
            if (r->turnsSeen >= r->waitTarget) { emit_wait(r, h, d, "turns", r->turnsSeen - r->waitStartTurns); r->state = MT_S_RUN; r->pc++; }
            return 1;
        case MT_S_WAIT_MS:
            if (r->now >= r->waitDeadline) { emit_wait(r, h, d, "ms", (long)(r->now - r->waitStartMs)); r->state = MT_S_RUN; r->pc++; }
            return 1;
        case MT_S_WAIT_WITHIN: {
            char detail[200];
            int i = find_in_window(r, h, d->a);
            if (i >= 0) { snprintf(detail, sizeof detail, "matched console line %d", i); emit_expect(r, h, d, "console", d->a, 1, detail); r->state = MT_S_RUN; r->pc++; return 1; }
            if (--r->withinLeft <= 0) {
                snprintf(detail, sizeof detail, "not found within %d frame(s) (%d console line(s) since the last cmd)", d->within, r->con.seen - r->con.windowStart);
                emit_expect(r, h, d, "console", d->a, 0, detail);
                r->state = MT_S_RUN;
                r->pc++;
            }
            return 1;
        }
    }
    return 1;
}
