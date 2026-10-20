/* mt_pure.h — declarations of mewtest's pure modules (no windows.h, no game types).
 * Everything here is compiled twice: into mewtest.dll and into build/test_mewtest.exe.
 * Contracts: docs/ingame-testing.md. */
#pragma once
#include <stdint.h>
#include <stddef.h>

#define MT_VERSION "mewtest 0.1.0"
#define MT_MAX_DIRECTIVES 1024
#define MT_ARENA_BYTES 65536
#define MT_MAX_LINE 4096              /* a cmd line may carry MT_MAX_CMD bytes */
#define MT_MAX_CMD 4078              /* the game's std::string large-allocation boundary (cap+1 < 0x1000) */
#define MT_CONSOLE_WAIT_MS 30000      /* wall-clock ms a `cmd` waits for the debug console before giving up (code 4) */
#define MT_DEFAULT_TIMEOUT_MS 120000
#define MT_PATH_MAX 520

/* ---- mt_jsonl.c -------------------------------------------------------- */
typedef struct MtJsonW { char *buf; size_t cap, len; int overflow; int needComma; } MtJsonW;
void   mt_jw_begin(MtJsonW *w, char *buf, size_t cap, const char *ev);   /* {"ev":"<ev>" */
void   mt_jw_str(MtJsonW *w, const char *key, const char *val);
void   mt_jw_strn(MtJsonW *w, const char *key, const char *val, size_t n);
void   mt_jw_int(MtJsonW *w, const char *key, long long v);
void   mt_jw_hex(MtJsonW *w, const char *key, unsigned long long v);     /* "0x..." */
void   mt_jw_bool(MtJsonW *w, const char *key, int v);
void   mt_jw_arr_begin(MtJsonW *w, const char *key);
void   mt_jw_arr_str(MtJsonW *w, const char *v);
void   mt_jw_arr_int(MtJsonW *w, long long v);
void   mt_jw_arr_end(MtJsonW *w);
void   mt_jw_obj_begin(MtJsonW *w, const char *key);                      /* key NULL inside an array */
void   mt_jw_obj_end(MtJsonW *w);
int    mt_jw_end(MtJsonW *w);                                             /* appends "}\n"; 1 ok, 0 overflowed */
size_t mt_json_escape(const char *in, size_t n, char *out, size_t cap);   /* quoted; returns needed length */

/* ---- mt_args.c --------------------------------------------------------- */
typedef struct MtArgs {
    int present;                 /* -mewtest <script> given and everything well-formed */
    char script[MT_PATH_MAX];
    char out[MT_PATH_MAX];       /* -mewtest_out, default: script with its extension replaced by .jsonl */
    int hide;                    /* -mewtest_hide 0|1, default 1 */
    unsigned timeoutMs;          /* -mewtest_timeout, default MT_DEFAULT_TIMEOUT_MS */
    int clean;                   /* -mewtest_clean 0|1, default 0 */
    int hasSaveSuffix;           /* -savesuffix <value> seen */
    char err[128];
} MtArgs;
int mt_args_parse(const char *cmdline, MtArgs *out);   /* 1 = present and valid */

/* ---- mt_msvcstr.c ------------------------------------------------------ */
typedef struct MtMsvcString  { union { char buf[16]; char *ptr; } u; size_t size, cap; } MtMsvcString;
typedef struct MtMsvcWString { union { uint16_t buf[8]; uint16_t *ptr; } u; size_t size, cap; } MtMsvcWString;
typedef void *(*MtAllocFn)(size_t bytes);
int             mt_msvcstr_build(MtMsvcString *s, const char *text, size_t len, MtAllocFn alloc); /* 0 if len > MT_MAX_CMD or alloc fails */
const char     *mt_msvcstr_data(const MtMsvcString *s);
size_t          mt_msvcstr_copy(const MtMsvcString *s, char *out, size_t cap);
const uint16_t *mt_msvcwstr_data(const MtMsvcWString *s);
size_t          mt_wstr_to_utf8(const uint16_t *w, size_t n, char *out, size_t cap);

/* ---- mt_script.c ------------------------------------------------------- */
typedef enum MtDirKind {
    MT_D_CMD, MT_D_WAIT_FRAMES, MT_D_WAIT_TURNS, MT_D_WAIT_MS,
    MT_D_EXPECT_CONSOLE, MT_D_EXPECT_NOCONSOLE, MT_D_EXPECT_STATUS, MT_D_EXPECT_UNITS,
    MT_D_DUMP, MT_D_LOG, MT_D_QUIT,
    MT_D_ENTER,         /* enter <SceneName>: replay a dev-menu scene entry (TacticsTest) through the host */
    MT_D_WAIT_ROUNDS,   /* wait rounds N: until TurnControl's round >= round-at-directive + N */
    MT_D_EXPECT_ROUND,  /* expect round <op> N (0 outside combat) */
    MT_D_EXPECT_STACKS, /* expect stacks <Status> on <unit> (<op> N | varied) */
    MT_D_SHOT,          /* shot "<label>": emit a shot event, then hold MT_SHOT_HOLD_MS so the runner can capture the window */
    MT_D_SEED           /* seed <N>: pin the game's RNG state through the host (reproducible party and fight) */
} MtDirKind;
#define MT_SHOT_HOLD_MS 700
typedef enum MtOp { MT_OP_EQ, MT_OP_NE, MT_OP_GE, MT_OP_LE, MT_OP_GT, MT_OP_LT } MtOp;
/* scenes `enter` knows; 0 = unknown. The DLL and the Node parser (script.ts KNOWN_SCENES) must agree. */
#define MT_SCENE_TACTICS_TEST 1
int         mt_scene_id(const char *name);    /* 0 if unknown */
const char *mt_scene_name(int scene);         /* "" if unknown */
typedef struct MtDirective {
    MtDirKind kind;
    int line;
    const char *a;      /* cmd text | expect substring | status name | log text */
    const char *b;      /* status: unit name (when !unitIsIndex) */
    long n;             /* wait count | units N | status unit index | quit code */
    MtOp op;
    int within;         /* expect console: extra frames to keep polling */
    int unitIsIndex;
    int hasCode;        /* quit with an explicit code */
    int scene;          /* enter: MT_SCENE_* */
    long value;         /* expect stacks: N (the unit index lives in n) */
    int varied;         /* expect stacks … varied: >= 2 distinct values recorded for (unit, status) so far */
    unsigned long long seed;   /* seed: the value (full 64-bit) */
} MtDirective;
typedef struct MtScript {
    MtDirective d[MT_MAX_DIRECTIVES];
    int count;
    char arena[MT_ARENA_BYTES];
    size_t arenaUsed;
} MtScript;
int mt_script_parse(const char *text, size_t len, MtScript *out, char *err, size_t errCap, int *errLine); /* 1 ok */

/* ---- mt_console.c ------------------------------------------------------ */
typedef struct MtConsoleTrack { int seen; int windowStart; } MtConsoleTrack;
int  mt_console_poll(MtConsoleTrack *t, int count, int *firstNew, int *numNew); /* returns numNew; shrink resets */
void mt_console_mark_window(MtConsoleTrack *t);

/* ---- mt_runner.c ------------------------------------------------------- */
#define MT_UNIT_NAME 64
#define MT_UNIT_STATUSES 24
#define MT_STATUS_NAME 32
typedef struct MtUnit {
    char name[MT_UNIT_NAME], cls[MT_UNIT_NAME];
    int faction, move, act, turnKind;
    int statusCount;
    char statuses[MT_UNIT_STATUSES][MT_STATUS_NAME];
    int stacks[MT_UNIT_STATUSES];          /* parallel to statuses (Status+OFF_STATUS_STACKS) */
} MtUnit;

/* values of (unit index, status) seen by dump / expect stacks, for `expect stacks … varied` */
#define MT_STACK_TRACKS 16
typedef struct MtStackTrack { int unit; char status[MT_STATUS_NAME]; int first; int sawDifferent; int used; } MtStackTrack;

typedef struct MtHost {
    void *user;
    int      (*console_ready)(void *u);
    int      (*exec_cmd)(void *u, const char *line);
    int      (*console_count)(void *u);
    int      (*console_line)(void *u, int i, char *buf, size_t cap);
    long     (*turn_count)(void *u);
    int      (*round_number)(void *u);
    uint64_t (*now_ms)(void *u);
    int      (*units_available)(void *u);
    int      (*unit_count)(void *u);
    int      (*unit_info)(void *u, int i, MtUnit *out);
    int      (*unit_has_status)(void *u, int i, const char *status);
    void     (*emit)(void *u, const char *jsonLine);
    void     (*request_exit)(void *u, int code);   /* called once, after the end event, on quit/eof */
    /* enter <scene> on the game thread: 1 entered, 0 refused (detail says why), -1 unavailable (symbols missing),
     * 2 not ready yet (the runner retries next frame, for at most MT_CONSOLE_WAIT_MS) */
    int      (*enter_scene)(void *u, int scene, char *detail, size_t cap);
    /* seed <N> on the game thread: 1 seeded, 0 refused (detail), -1 unavailable (symbol / TLS missing) */
    int      (*seed_rng)(void *u, unsigned long long seed, char *detail, size_t cap);
} MtHost;

typedef enum MtState { MT_S_RUN, MT_S_WAIT_CONSOLE, MT_S_WAIT_FRAMES, MT_S_WAIT_TURNS, MT_S_WAIT_MS, MT_S_WAIT_WITHIN, MT_S_WAIT_ROUNDS, MT_S_WAIT_SHOT } MtState;
typedef struct MtRunner {
    const MtScript *s;
    int pc;
    MtState state;
    long frame;
    long turnsSeen;
    MtConsoleTrack con;
    long waitLeft;          /* frames */
    long waitTarget;        /* turns */
    long waitStartTurns;
    uint64_t waitDeadline;  /* ms */
    uint64_t waitStartMs;
    int withinLeft;
    uint64_t consoleWaitSince;    /* now_ms when the pending cmd first found no console; 0 = not waiting */
    int expectPass, expectFail;
    int exitCode;
    int finished;
    int entered;            /* enter succeeded once; a second enter is refused */
    long waitStartRound;    /* rounds */
    long waitTargetRound;
    MtStackTrack tracks[MT_STACK_TRACKS];
    uint64_t t0, now;
} MtRunner;
void mt_runner_init(MtRunner *r, const MtScript *s, uint64_t now);
int  mt_runner_step(MtRunner *r, const MtHost *h);                                 /* 1 running, 0 finished */
void mt_runner_abort(MtRunner *r, const MtHost *h, int code, const char *reason);  /* emits end once; no request_exit */

/* ---- mt_exit.c --------------------------------------------------------- */
/* The watchdog's decision, evaluated every tick from the glue's globals. Deliberately has no "active" input: once a
 * clean exit or a crash was requested the grace must elapse no matter what else the glue has switched off. Ticks are
 * GetTickCount-style unsigned ms (wraparound-safe). Priority: crash > clean > timeout. Fires at most once (fired). */
#define MT_GRACE_CLEAN_MS 3000
#define MT_GRACE_CRASH_MS 5000
typedef enum MtExitAction { MT_X_NONE = 0, MT_X_EXIT_CRASH = 1, MT_X_EXIT_CLEAN = 2, MT_X_TIMEOUT = 3 } MtExitAction;
typedef struct MtExitState {
    int crashed;          uint32_t crashTick;     /* a crash event was written at crashTick */
    int cleanRequested;   uint32_t cleanTick;     /* h_request_exit in clean mode at cleanTick */
    int exitCode;                                 /* code passed to request_exit; -1 = unset -> 4 */
    int runnerFinished;                           /* the end event was written */
    uint32_t startTick;   uint32_t timeoutMs;     /* script wall-clock budget */
    int fired;                                    /* the glue acted on a previous decision */
} MtExitState;
MtExitAction mt_exit_decide(const MtExitState *s, uint32_t nowMs, int *codeOut); /* codeOut: process exit code for EXIT_* */
