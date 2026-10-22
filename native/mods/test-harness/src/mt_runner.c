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

/* the shot event, then the hold. gl = the in-process capture's file (source "gl"); else the runner captures the
 * window (source "window", glWhy = why the in-process capture did not happen; both NULL = a glue without one). */
static void emit_shot(MtRunner *r, const MtHost *h, const MtDirective *d, const MtShotResult *gl, const char *glWhy) {
    MtJsonW w;
    mt_jw_begin(&w, g_json, sizeof g_json, "shot");
    mt_jw_int(&w, "line", d->line);
    mt_jw_str(&w, "label", d->a);
    mt_jw_int(&w, "hold_ms", MT_SHOT_HOLD_MS);
    if (gl) {
        mt_jw_str(&w, "source", "gl");
        mt_jw_str(&w, "file", gl->path);
        mt_jw_int(&w, "w", gl->w);
        mt_jw_int(&w, "h", gl->h);
        if (gl->detail[0]) mt_jw_str(&w, "detail", gl->detail);
    } else if (glWhy) {
        mt_jw_str(&w, "source", "window");
        mt_jw_str(&w, "gl", glWhy);
    }
    stamp_and_emit(r, h, &w);
    r->waitDeadline = r->now + MT_SHOT_HOLD_MS;   /* keep the script (and so the scene) still while the runner captures */
    r->state = MT_S_WAIT_SHOT;
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

/* remember a (unit, status) stacks value; returns the track (NULL when the table is full) */
static MtStackTrack *record_stacks(MtRunner *r, int unit, const char *status, int value) {
    MtStackTrack *free = NULL;
    for (int i = 0; i < MT_STACK_TRACKS; i++) {
        MtStackTrack *t = &r->tracks[i];
        if (t->used && t->unit == unit && !strcmp(t->status, status)) {
            if (value != t->first) t->sawDifferent = 1;
            return t;
        }
        if (!t->used && !free) free = t;
    }
    if (!free) return NULL;
    free->used = 1; free->unit = unit; free->first = value; free->sawDifferent = 0;
    snprintf(free->status, sizeof free->status, "%s", status);
    return free;
}

static void jw_pair(MtJsonW *w, const char *key, int a, int b) {
    mt_jw_arr_begin(w, key); mt_jw_arr_int(w, a); mt_jw_arr_int(w, b); mt_jw_arr_end(w);
}
/* the facing fields of a unit (units event; Character::Face 0x10ce50 writes them) */
static void emit_facing_fields(MtJsonW *w, const MtUnit *u) {
    mt_jw_str(w, "facing", u->facing);
    jw_pair(w, "dir", u->dirX, u->dirY);
    jw_pair(w, "lock", u->lockX, u->lockY);
    mt_jw_int(w, "sign", u->faceSign);
    mt_jw_int(w, "flip", u->flip);
    mt_jw_int(w, "fourway", u->fourWay);
}

/* id >= 0: a dump requested over the pipe (the id is echoed so the reply can be matched) */
static void do_dump(MtRunner *r, const MtHost *h, long id) {
    int avail = h->units_available(h->user);
    int count = avail ? h->unit_count(h->user) : 0;
    MtJsonW w;
    mt_jw_begin(&w, g_json, sizeof g_json, "units");
    if (id >= 0) mt_jw_int(&w, "id", id);
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
        mt_jw_str(&w, "namekey", u.nameKey);
        mt_jw_int(&w, "faction", u.faction);
        mt_jw_int(&w, "move", u.move);
        mt_jw_int(&w, "act", u.act);
        mt_jw_int(&w, "turnkind", u.turnKind);
        mt_jw_int(&w, "hp", u.hp);
        mt_jw_int(&w, "shield", u.shield);
        mt_jw_int(&w, "divineshield", u.divineShield);
        for (int k = 0; k < MT_STAT_COUNT; k++) mt_jw_int(&w, mt_stat_name(k), u.stats[k]);
        /* what Character::recompute_stats made of them (every passive's / status's ApplyStatModifiers folded in) */
        mt_jw_obj_begin(&w, "effective");
        for (int k = 0; k < MT_STAT_COUNT; k++) mt_jw_int(&w, mt_stat_name(k), u.eff[k]);
        mt_jw_int(&w, "maxhp", u.maxHp);
        mt_jw_obj_end(&w);
        mt_jw_arr_begin(&w, "statuses");
        for (int k = 0; k < u.statusCount && k < MT_UNIT_STATUSES; k++) mt_jw_arr_str(&w, u.statuses[k]);
        mt_jw_arr_end(&w);
        mt_jw_arr_begin(&w, "stacks");
        for (int k = 0; k < u.statusCount && k < MT_UNIT_STATUSES; k++) { mt_jw_arr_int(&w, u.stacks[k]); record_stacks(r, i, u.statuses[k], u.stacks[k]); }
        mt_jw_arr_end(&w);
        emit_facing_fields(&w, &u);
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
static int op_apply_d(MtOp op, double a, double b) {
    switch (op) { case MT_OP_EQ: return a == b; case MT_OP_NE: return a != b; case MT_OP_GE: return a >= b; case MT_OP_LE: return a <= b; case MT_OP_GT: return a > b; default: return a < b; }
}
/* the integer MtUnit field an expect unit directive names (the string fields are handled by the caller) */
static long unit_int_field(const MtUnit *u, MtUnitField f) {
    switch (f) {
        case MT_F_FACTION: return u->faction; case MT_F_MOVE: return u->move; case MT_F_ACT: return u->act; case MT_F_TURNKIND: return u->turnKind;
        case MT_F_HP: return u->hp; case MT_F_SHIELD: return u->shield; case MT_F_DIVINESHIELD: return u->divineShield;
        case MT_F_DIRX: return u->dirX; case MT_F_DIRY: return u->dirY; case MT_F_FLIP: return u->flip; case MT_F_SIGN: return u->faceSign;
        case MT_F_MAXHP_EFF: return u->maxHp;
        default:
            if (f >= MT_F_STRENGTH && f <= MT_F_LUCK) return u->stats[f - MT_F_STRENGTH];
            if (f >= MT_F_STRENGTH_EFF && f <= MT_F_LUCK_EFF) return u->eff[f - MT_F_STRENGTH_EFF];
            return 0;
    }
}
/* the unit as an expect arg: the index, the bare name, or the quoted name when it has a space */
static void unit_text(const MtDirective *d, char *buf, size_t cap) {
    if (d->unitIsIndex) snprintf(buf, cap, "%ld", d->n);
    else if (strchr(d->b, 0x20)) snprintf(buf, cap, "\"%s\"", d->b);
    else snprintf(buf, cap, "%s", d->b);
}
/* one scalar / container as the expect gon detail shows it */
static void gon_value_text(const MtGonValue *v, char *buf, size_t cap) {
    switch (v->type) {
        case 1: snprintf(buf, cap, "string \"%s\"", v->text); break;
        case 2: snprintf(buf, cap, "number %g (int %d, double %g, text \"%s\")", v->d, v->i, v->d, v->text); break;
        case 3: snprintf(buf, cap, "object with %ld children", v->childCount); break;
        case 4: snprintf(buf, cap, "array with %ld children", v->childCount); break;
        case 5: snprintf(buf, cap, "bool %s", v->b ? "true" : "false"); break;
        default: snprintf(buf, cap, "%s", mt_gon_type_name(v->type)); break;
    }
}

void mt_runner_init(MtRunner *r, const MtScript *s, uint64_t now) {
    memset(r, 0, sizeof *r);
    r->s = s;
    r->t0 = now;
    r->now = now;
}
void mt_runner_set_interactive(MtRunner *r, int on) { r->interactive = on ? 1 : 0; }
void mt_runner_attach_queue(MtRunner *r, MtQueue *q) { r->queue = q; }

void mt_runner_abort(MtRunner *r, const MtHost *h, int code, const char *reason) {
    r->now = h->now_ms(h->user);
    finish(r, h, code, reason);
}

/* run the directive at pc; returns 1 to keep running, 0 when the script finished */
static int exec_directive(MtRunner *r, const MtHost *h) {
    char arg[160], detail[512];   /* enter details name pointers and the house note */
    if (r->pc >= r->s->count) {
        if (r->interactive) {
            /* interactive mode: the script is over but the session is not — idle and serve the pipe until quit */
            r->state = MT_S_IDLE;
            if (!r->idleEmitted) {
                r->idleEmitted = 1;
                MtJsonW w;
                mt_jw_begin(&w, g_json, sizeof g_json, "idle");
                mt_jw_int(&w, "line", r->s->count ? r->s->d[r->s->count - 1].line : 0);
                stamp_and_emit(r, h, &w);
            }
            return 1;
        }
        finish(r, h, r->expectFail ? 1 : 0, "eof"); h->request_exit(h->user, r->exitCode); return 0;
    }
    const MtDirective *d = &r->s->d[r->pc];
    switch (d->kind) {
        case MT_D_CMD: {
            if (!h->console_ready(h->user)) {
                r->state = MT_S_WAIT_CONSOLE;
                if (!r->consoleWaitSince) r->consoleWaitSince = r->now ? r->now : 1;
                if (r->now - r->consoleWaitSince > MT_CONSOLE_WAIT_MS) { finish(r, h, 4, "console_unavailable"); h->request_exit(h->user, 4); return 0; }
                return 1;
            }
            r->consoleWaitSince = 0;
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
        case MT_D_SEED: {
            detail[0] = 0;
            int rc = h->seed_rng(h->user, d->seed, detail, sizeof detail);
            if (rc == 2) {
                /* not ready: the game is still in its own startup (it reseeds there); retry next frame, same budget as the console wait */
                r->state = MT_S_WAIT_CONSOLE;
                if (!r->consoleWaitSince) r->consoleWaitSince = r->now ? r->now : 1;
                if (r->now - r->consoleWaitSince <= MT_CONSOLE_WAIT_MS) return 1;
                rc = 0;
                snprintf(detail, sizeof detail, "not ready after %d ms", MT_CONSOLE_WAIT_MS);
            }
            r->consoleWaitSince = 0;
            r->state = MT_S_RUN;
            MtJsonW w;
            mt_jw_begin(&w, g_json, sizeof g_json, "seed");
            mt_jw_int(&w, "line", d->line);
            mt_jw_int(&w, "seed", (long long)d->seed);
            mt_jw_bool(&w, "ok", rc == 1);
            mt_jw_str(&w, "detail", detail);
            stamp_and_emit(r, h, &w);
            if (rc == 1) { r->pc++; return 1; }
            if (rc < 0) { finish(r, h, 4, "seed_unavailable"); h->request_exit(h->user, 4); return 0; }
            finish(r, h, 1, "seed_failed");
            h->request_exit(h->user, 1);
            return 0;
        }
        case MT_D_GLOW: {
            MtUnit u;
            memset(&u, 0, sizeof u);
            int avail = h->units_available(h->user);
            int idx = avail ? resolve_unit(h, d, &u) : -1;
            int rc;
            detail[0] = 0;
            if (idx < 0) { rc = 0; snprintf(detail, sizeof detail, "no such unit%s", avail ? "" : " (no combat)"); }
            else rc = h->set_unit_glow(h->user, idx, d->glowOff ? NULL : d->rgba, detail, sizeof detail);
            MtJsonW w;
            mt_jw_begin(&w, g_json, sizeof g_json, "glow");
            mt_jw_int(&w, "line", d->line);
            mt_jw_int(&w, "unit", idx);
            mt_jw_str(&w, "name", idx >= 0 ? u.name : "");
            mt_jw_str(&w, "arg", d->a);
            mt_jw_bool(&w, "ok", rc == 1);
            mt_jw_str(&w, "detail", detail);
            stamp_and_emit(r, h, &w);
            if (rc == 1) { r->pc++; return 1; }
            if (rc < 0) { finish(r, h, 4, "glow_unavailable"); h->request_exit(h->user, 4); return 0; }
            finish(r, h, 1, "glow_failed");
            h->request_exit(h->user, 1);
            return 0;
        }
        case MT_D_FACE: {
            /* Character::Face(dir, instant) on a unit of the walk, then the unit read back: what the game wrote next to
             * what the decompiled rule (mt_face.c) says it should have written */
            MtUnit u;
            memset(&u, 0, sizeof u);
            int avail = h->units_available(h->user);
            int idx = avail ? resolve_unit(h, d, &u) : -1;
            int dx = d->faceDx, dy = d->faceDy, rc;
            MtFaceOut want;
            memset(&want, 0, sizeof want);
            detail[0] = 0;
            if (idx >= 0 && d->faceNamed != MT_FACE_RAW) mt_face_named_dir(d->faceNamed, u.faceSign, &dx, &dy);
            if (idx < 0) { rc = 0; snprintf(detail, sizeof detail, "no such unit%s", avail ? "" : " (no combat)"); }
            else if (!h->face_unit) { rc = -1; snprintf(detail, sizeof detail, "host without face_unit"); }
            else {
                MtFaceIn in = { dx, dy, u.lockX, u.lockY, u.faceSign, u.fourWay, u.noHFlip, u.alwaysFront };
                mt_face_predict(&in, &want);
                rc = h->face_unit(h->user, idx, dx, dy, detail, sizeof detail);
                if (rc == 1 && (u.lockX || u.lockY)) {
                    size_t dl = strlen(detail);
                    snprintf(detail + dl, sizeof detail - dl, "; lock_orientation [%d %d] replaces the direction", u.lockX, u.lockY);
                }
                MtUnit after;
                memset(&after, 0, sizeof after);
                if (h->unit_info(h->user, idx, &after)) u = after;
            }
            MtJsonW w;
            mt_jw_begin(&w, g_json, sizeof g_json, "face");
            mt_jw_int(&w, "line", d->line);
            mt_jw_int(&w, "unit", idx);
            mt_jw_str(&w, "name", idx >= 0 ? u.name : "");
            mt_jw_str(&w, "arg", d->a);
            jw_pair(&w, "dir", dx, dy);
            jw_pair(&w, "effective", want.dx, want.dy);
            mt_jw_str(&w, "expect", want.suffix);
            mt_jw_str(&w, "facing", idx >= 0 ? u.facing : "");
            mt_jw_int(&w, "flip", idx >= 0 ? u.flip : 0);
            mt_jw_bool(&w, "ok", rc == 1);
            mt_jw_str(&w, "detail", detail);
            stamp_and_emit(r, h, &w);
            if (rc == 1) { r->pc++; return 1; }
            if (rc < 0) { finish(r, h, 4, "face_unavailable"); h->request_exit(h->user, 4); return 0; }
            finish(r, h, 1, "face_failed");
            h->request_exit(h->user, 1);
            return 0;
        }
        case MT_D_SHOT: {
            if (h->shot_arm && h->shot_poll) {
                if (h->shot_arm(h->user, d->line) == 1) {   /* the glue reads the back buffer at the next present */
                    r->waitLeft = MT_SHOT_GL_FRAMES;
                    r->state = MT_S_WAIT_SHOT_GL;
                    return 1;
                }
                emit_shot(r, h, d, NULL, "unavailable");
                return 1;
            }
            emit_shot(r, h, d, NULL, NULL);
            return 1;
        }
        case MT_D_WAIT_ROUNDS:
            r->waitStartRound = h->units_available(h->user) ? h->round_number(h->user) : 0;
            r->waitTargetRound = r->waitStartRound + d->n;
            r->state = MT_S_WAIT_ROUNDS;
            return 1;
        case MT_D_EXPECT_ROUND: {
            long round = h->units_available(h->user) ? h->round_number(h->user) : 0;
            snprintf(arg, sizeof arg, "%s %ld", op_text(d->op), d->n);
            snprintf(detail, sizeof detail, "round %ld", round);
            emit_expect(r, h, d, "round", arg, op_apply(d->op, round, d->n), detail);
            r->pc++;
            return 1;
        }
        case MT_D_EXPECT_STACKS: {
            if (d->unitIsIndex) snprintf(arg, sizeof arg, "%s on %ld %s", d->a, d->n, d->varied ? "varied" : op_text(d->op));
            else snprintf(arg, sizeof arg, "%s on %s %s", d->a, d->b, d->varied ? "varied" : op_text(d->op));
            if (!d->varied) snprintf(arg + strlen(arg), sizeof arg - strlen(arg), " %ld", d->value);
            if (!h->units_available(h->user)) { emit_expect(r, h, d, "stacks", arg, 0, "no combat (units unavailable)"); r->pc++; return 1; }
            MtUnit u;
            memset(&u, 0, sizeof u);
            int idx = resolve_unit(h, d, &u);
            if (idx < 0) {
                if (d->unitIsIndex) snprintf(detail, sizeof detail, "unit not found: index %ld of %d", d->n, h->unit_count(h->user));
                else snprintf(detail, sizeof detail, "unit not found: \"%s\"", d->b);
                emit_expect(r, h, d, "stacks", arg, 0, detail);
                r->pc++;
                return 1;
            }
            int k = -1;
            for (int s = 0; s < u.statusCount && s < MT_UNIT_STATUSES; s++) if (!strcmp(u.statuses[s], d->a)) { k = s; break; }
            if (k < 0) {
                snprintf(detail, sizeof detail, "%s absent on unit %d \"%s\"", d->a, idx, u.name);
                emit_expect(r, h, d, "stacks", arg, 0, detail);
                r->pc++;
                return 1;
            }
            MtStackTrack *t = record_stacks(r, idx, d->a, u.stacks[k]);
            if (d->varied) {
                int distinct = t ? (t->sawDifferent ? 2 : 1) : 1;
                snprintf(detail, sizeof detail, "%s %d on unit %d \"%s\"; %d distinct value(s) recorded%s", d->a, u.stacks[k], idx, u.name, distinct, t ? "" : " (track table full)");
                emit_expect(r, h, d, "stacks", arg, distinct >= 2, detail);
            } else {
                snprintf(detail, sizeof detail, "%s %d on unit %d \"%s\"", d->a, u.stacks[k], idx, u.name);
                emit_expect(r, h, d, "stacks", arg, op_apply(d->op, u.stacks[k], d->value), detail);
            }
            r->pc++;
            return 1;
        }
        case MT_D_EXPECT_UNIT: {
            int isStr = mt_unit_field_is_string(d->field);
            char unitText[80];
            unit_text(d, unitText, sizeof unitText);
            if (isStr) snprintf(arg, sizeof arg, "%s %s %s \"%s\"", unitText, mt_unit_field_name(d->field), op_text(d->op), d->a);
            else snprintf(arg, sizeof arg, "%s %s %s %ld", unitText, mt_unit_field_name(d->field), op_text(d->op), d->value);
            if (!h->units_available(h->user)) { emit_expect(r, h, d, "unit", arg, 0, "no combat (units unavailable)"); r->pc++; return 1; }
            MtUnit u;
            memset(&u, 0, sizeof u);
            int idx = resolve_unit(h, d, &u);
            if (idx < 0) {
                if (d->unitIsIndex) snprintf(detail, sizeof detail, "unit not found: index %ld of %d", d->n, h->unit_count(h->user));
                else snprintf(detail, sizeof detail, "unit not found: \"%s\"", d->b);
                emit_expect(r, h, d, "unit", arg, 0, detail);
                r->pc++;
                return 1;
            }
            int ok;
            if (isStr) {
                const char *actual = d->field == MT_F_NAME ? u.name : d->field == MT_F_CLASS ? u.cls : d->field == MT_F_FACING ? u.facing : u.nameKey;
                int same = strcmp(actual, d->a) == 0;
                ok = d->op == MT_OP_EQ ? same : !same;
                snprintf(detail, sizeof detail, "unit %d \"%s\": %s \"%s\"", idx, u.name, mt_unit_field_name(d->field), actual);
            } else {
                long actual = unit_int_field(&u, d->field);
                ok = op_apply(d->op, actual, d->value);
                snprintf(detail, sizeof detail, "unit %d \"%s\": %s %ld", idx, u.name, mt_unit_field_name(d->field), actual);
            }
            emit_expect(r, h, d, "unit", arg, ok, detail);
            r->pc++;
            return 1;
        }
        case MT_D_EXPECT_GON: {
            /* the unit's merged data/characters entry (Character+OFF_CH_GON_ENTRY), walked with mt_gon_get through
             * the host's guarded reader; the value's type decides what a literal can match (a number only a number
             * node, a quoted string only a string node, true/false only a bool node) */
            char unitText[80], valueText[MT_GON_TEXT + 64], why[200];
            unit_text(d, unitText, sizeof unitText);
            switch (d->gonCheck) {
                case MT_G_NUM: snprintf(arg, sizeof arg, "%s %s %s %g", unitText, d->a, op_text(d->op), d->dvalue); break;
                case MT_G_STR: snprintf(arg, sizeof arg, "%s %s %s \"%s\"", unitText, d->a, op_text(d->op), d->c); break;
                case MT_G_BOOL: snprintf(arg, sizeof arg, "%s %s %s %s", unitText, d->a, op_text(d->op), d->value ? "true" : "false"); break;
                default: snprintf(arg, sizeof arg, "%s %s %s", unitText, d->a, d->gonCheck == MT_G_EXISTS ? "exists" : "missing"); break;
            }
            if (!h->units_available(h->user)) { emit_expect(r, h, d, "gon", arg, 0, "no combat (units unavailable)"); r->pc++; return 1; }
            MtUnit u;
            memset(&u, 0, sizeof u);
            int idx = resolve_unit(h, d, &u);
            if (idx < 0) {
                if (d->unitIsIndex) snprintf(detail, sizeof detail, "unit not found: index %ld of %d", d->n, h->unit_count(h->user));
                else snprintf(detail, sizeof detail, "unit not found: \"%s\"", d->b);
                emit_expect(r, h, d, "gon", arg, 0, detail);
                r->pc++;
                return 1;
            }
            const char *entry = u.nameKey[0] ? u.nameKey : "?";   /* the name key identifies the unit in the detail */
            const void *node = h->unit_gon ? h->unit_gon(h->user, idx) : NULL;
            if (!node || !h->mem_read) {
                snprintf(detail, sizeof detail, "unit %d \"%s\" (%s): no GON entry (Character+OFF_CH_GON_ENTRY unreadable)", idx, u.name, entry);
                emit_expect(r, h, d, "gon", arg, 0, detail);
                r->pc++;
                return 1;
            }
            MtGonValue v;
            int rc = mt_gon_get(h->mem_read, h->user, node, d->a, &v, why, sizeof why);
            int ok = 0;
            if (rc < 0) {
                snprintf(detail, sizeof detail, "unit %d \"%s\" (%s): %s unreadable: %s", idx, u.name, entry, d->a, why);
            } else if (rc == 0 || v.type == 0) {
                ok = d->gonCheck == MT_G_MISSING;
                snprintf(detail, sizeof detail, "unit %d \"%s\" (%s): %s missing: %s", idx, u.name, entry, d->a, rc == 0 ? why : "a null node");
            } else {
                gon_value_text(&v, valueText, sizeof valueText);
                switch (d->gonCheck) {
                    case MT_G_NUM: ok = v.type == 2 && op_apply_d(d->op, v.d, d->dvalue); break;
                    case MT_G_STR: ok = v.type == 1 && ((strcmp(v.text, d->c) == 0) == (d->op == MT_OP_EQ)); break;
                    case MT_G_BOOL: ok = v.type == 5 && (((v.b != 0) == (d->value != 0)) == (d->op == MT_OP_EQ)); break;
                    case MT_G_EXISTS: ok = 1; break;
                    default: ok = 0; break;
                }
                snprintf(detail, sizeof detail, "unit %d \"%s\" (%s): %s = %s", idx, u.name, entry, d->a, valueText);
            }
            emit_expect(r, h, d, "gon", arg, ok, detail);
            r->pc++;
            return 1;
        }
        case MT_D_DUMP:
            do_dump(r, h, -1);
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
        case MT_D_EXPECT_LEVEL: {
            int ok = r->battleLevel[0] && strstr(r->battleLevel, d->a) != NULL;
            if (r->battleLevel[0]) snprintf(detail, sizeof detail, "battle level \"%s\"", r->battleLevel);
            else snprintf(detail, sizeof detail, "no battle level yet (run fight first)");
            emit_expect(r, h, d, "level", d->a, ok, detail);
            r->pc++;
            return 1;
        }
        case MT_D_RUN: {
            /* like enter: the walk needs the game's console (the main menu has been reached) */
            if (!h->console_ready(h->user)) {
                r->state = MT_S_WAIT_CONSOLE;
                if (!r->consoleWaitSince) r->consoleWaitSince = r->now ? r->now : 1;
                if (r->now - r->consoleWaitSince > MT_CONSOLE_WAIT_MS) { finish(r, h, 4, "console_unavailable"); h->request_exit(h->user, 4); return 0; }
                return 1;
            }
            MtRunInfo info;
            memset(&info, 0, sizeof info);
            info.node = info.nodeType = info.depth = -1;
            detail[0] = 0;
            int rc = h->run_step ? h->run_step(h->user, (int)d->n, d->a, &info, detail, sizeof detail) : -1;
            if (!h->run_step) snprintf(detail, sizeof detail, "this host has no run_step");
            if (rc == 2) {
                /* not ready (e.g. run fight before the battle the node started exists): retry next frame, same budget as the console wait */
                r->state = MT_S_WAIT_CONSOLE;
                if (!r->consoleWaitSince) r->consoleWaitSince = r->now ? r->now : 1;
                if (r->now - r->consoleWaitSince <= MT_CONSOLE_WAIT_MS) return 1;
                rc = 0;
                char why[400];
                snprintf(why, sizeof why, "%s", detail[0] ? detail : "the game never reported ready");
                snprintf(detail, sizeof detail, "not ready after %d ms: %s", MT_CONSOLE_WAIT_MS, why);
            }
            r->consoleWaitSince = 0;
            r->state = MT_S_RUN;
            MtJsonW w;
            mt_jw_begin(&w, g_json, sizeof g_json, "run");
            mt_jw_int(&w, "line", d->line);
            mt_jw_str(&w, "op", mt_run_op_name((int)d->n));
            mt_jw_str(&w, "arg", d->a ? d->a : "");
            mt_jw_bool(&w, "ok", rc == 1);
            if (info.map[0]) mt_jw_str(&w, "map", info.map);
            if (info.node >= 0) mt_jw_int(&w, "node", info.node);
            if (info.nodeType >= 0) mt_jw_str(&w, "type", mt_node_type_name(info.nodeType));
            if (info.depth >= 0) mt_jw_int(&w, "depth", info.depth);
            if (info.level[0]) mt_jw_str(&w, "level", info.level);
            mt_jw_str(&w, "detail", detail);
            stamp_and_emit(r, h, &w);
            if (rc == 1) {
                if (d->n == MT_RUN_FIGHT && info.level[0]) snprintf(r->battleLevel, sizeof r->battleLevel, "%s", info.level);
                r->pc++;
                return 1;
            }
            if (rc < 0) { finish(r, h, 4, "run_unavailable"); h->request_exit(h->user, 4); return 0; }
            finish(r, h, 1, "run_failed");
            h->request_exit(h->user, 1);
            return 0;
        }
        case MT_D_ENTER: {
            /* like cmd: the scene entry needs the debug console (the main menu has been reached) */
            if (!h->console_ready(h->user)) {
                r->state = MT_S_WAIT_CONSOLE;
                if (!r->consoleWaitSince) r->consoleWaitSince = r->now ? r->now : 1;
                if (r->now - r->consoleWaitSince > MT_CONSOLE_WAIT_MS) { finish(r, h, 4, "console_unavailable"); h->request_exit(h->user, 4); return 0; }
                return 1;
            }
            int rc;
            if (r->entered) { rc = 0; snprintf(detail, sizeof detail, "refused: enter may run only once per script"); }
            else { detail[0] = 0; rc = h->enter_scene(h->user, d->scene, d->enterMode, detail, sizeof detail); }
            if (rc == 2) {
                /* not ready yet (the game has not finished its own startup): retry next frame, same budget as the console wait */
                r->state = MT_S_WAIT_CONSOLE;
                if (!r->consoleWaitSince) r->consoleWaitSince = r->now ? r->now : 1;
                if (r->now - r->consoleWaitSince <= MT_CONSOLE_WAIT_MS) return 1;
                rc = 0;
                snprintf(detail, sizeof detail, "not ready after %d ms: %s", MT_CONSOLE_WAIT_MS, detail[0] ? detail : "the game never reported ready");
            }
            r->consoleWaitSince = 0;
            r->state = MT_S_RUN;
            MtJsonW w;
            mt_jw_begin(&w, g_json, sizeof g_json, "enter");
            mt_jw_int(&w, "line", d->line);
            mt_jw_str(&w, "name", mt_scene_name(d->scene));
            if (d->enterMode) mt_jw_str(&w, "mode", mt_enter_mode_name(d->enterMode));
            mt_jw_bool(&w, "ok", rc == 1);
            mt_jw_str(&w, "detail", detail);
            stamp_and_emit(r, h, &w);
            if (rc == 1) { r->entered = 1; r->pc++; return 1; }
            if (rc < 0) { finish(r, h, 4, "enter_unavailable"); h->request_exit(h->user, 4); return 0; }
            finish(r, h, 1, "enter_failed");
            h->request_exit(h->user, 1);
            return 0;
        }
    }
    return 1;
}

/* an exec request finished collecting: emit the exec event (its reply) and hand it back */
static void complete_exec(MtRunner *r, const MtHost *h) {
    MtRequest *req = r->active;
    MtJsonW w;
    mt_jw_begin(&w, g_json, sizeof g_json, "exec");
    mt_jw_int(&w, "id", req->id);
    mt_jw_str(&w, "op", "exec");
    mt_jw_str(&w, "text", req->text);
    mt_jw_bool(&w, "ok", 1);
    mt_jw_arr_begin(&w, "lines");
    for (int i = r->con.windowStart; i < r->con.seen; i++) if (h->console_line(h->user, i, g_line, sizeof g_line)) mt_jw_arr_str(&w, g_line);
    mt_jw_arr_end(&w);
    stamp_and_emit(r, h, &w);
    mt_queue_complete(req, g_json);
    r->active = NULL;
}

/* serve one pipe request when the runner is idle or inside a wait (never between MT_S_RUN directives, never while
 * a cmd waits for the console, never inside expect console … within, whose console window an exec would move).
 * Returns 0 when a quit request ended the run. */
static int serve_request(MtRunner *r, const MtHost *h) {
    if (!r->queue || r->active || r->finished) return 1;
    if (!h->console_ready(h->user)) return 1;   /* before the main menu nothing can be executed: requests stay queued */
    switch (r->state) {
        case MT_S_IDLE: case MT_S_WAIT_FRAMES: case MT_S_WAIT_TURNS: case MT_S_WAIT_MS: case MT_S_WAIT_ROUNDS: case MT_S_WAIT_SHOT: break;
        default: return 1;
    }
    MtRequest *req = mt_queue_take(r->queue);
    if (!req) return 1;
    switch (req->op) {
        case MT_QOP_EXEC:
            mt_console_mark_window(&r->con);
            h->exec_cmd(h->user, req->text);
            poll_console(r, h);
            r->active = req;
            r->activeFramesLeft = req->frames;
            if (r->activeFramesLeft <= 0) complete_exec(r, h);
            return 1;
        case MT_QOP_DUMP:
            do_dump(r, h, req->id);
            mt_queue_complete(req, g_json);
            return 1;
        case MT_QOP_QUIT: {
            /* the reply first (it carries the code), then the end record stays the last line of the result file */
            int code = r->expectFail ? 1 : 0;
            MtJsonW w;
            mt_jw_begin(&w, g_json, sizeof g_json, "exec");
            mt_jw_int(&w, "id", req->id);
            mt_jw_str(&w, "op", "quit");
            mt_jw_bool(&w, "ok", 1);
            mt_jw_int(&w, "code", code);
            stamp_and_emit(r, h, &w);
            mt_queue_complete(req, g_json);
            if (h->pipe_reply) h->pipe_reply(h->user, g_json);   /* before the exit: the pipe thread would be too late */
            finish(r, h, code, "quit");
            h->request_exit(h->user, code);
            return 0;
        }
    }
    return 1;
}

static int dispatch(MtRunner *r, const MtHost *h) {
    const MtDirective *d = r->pc < r->s->count ? &r->s->d[r->pc] : NULL;
    switch (r->state) {
        case MT_S_IDLE:
            return 1;
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
        case MT_S_WAIT_SHOT:
            if (r->now >= r->waitDeadline) { r->state = MT_S_RUN; r->pc++; }
            return 1;
        case MT_S_WAIT_SHOT_GL: {
            MtShotResult res;
            memset(&res, 0, sizeof res);
            int p = h->shot_poll(h->user, &res);
            if (p == 1) emit_shot(r, h, d, &res, NULL);
            else if (p < 0) emit_shot(r, h, d, NULL, res.detail[0] ? res.detail : "capture failed");
            else if (--r->waitLeft <= 0) {
                char why[64];
                snprintf(why, sizeof why, "no present within %d frames", MT_SHOT_GL_FRAMES);
                emit_shot(r, h, d, NULL, why);
            }
            return 1;
        }
        case MT_S_WAIT_ROUNDS: {
            long round = h->units_available(h->user) ? h->round_number(h->user) : 0;
            if (round >= r->waitTargetRound) { emit_wait(r, h, d, "rounds", round - r->waitStartRound); r->state = MT_S_RUN; r->pc++; }
            return 1;
        }
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

int mt_runner_step(MtRunner *r, const MtHost *h) {
    if (r->finished) return 0;
    r->frame++;
    r->now = h->now_ms(h->user);

    long tc = h->turn_count(h->user);
    while (r->turnsSeen < tc) { r->turnsSeen++; emit_turn(r, h); }
    poll_console(r, h);
    if (r->active && --r->activeFramesLeft <= 0) complete_exec(r, h);

    if (!dispatch(r, h)) return 0;
    return serve_request(r, h);
}
