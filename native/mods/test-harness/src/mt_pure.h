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
    int pipe;                    /* -mewtest_pipe 0|1, default 0: interactive mode (named pipe, idle at end of script) */
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
    MT_D_SEED,          /* seed <N>: pin the game's RNG state through the host (reproducible party and fight) */
    MT_D_EXPECT_UNIT,   /* expect unit <unit> <field> <op> <value>: a field of one unit in the units event */
    MT_D_EXPECT_GON     /* expect gon <unit> <path> (<op> <number> | ==|!= "<string>" | ==|!= true|false | exists | missing): the unit's GON entry */
} MtDirKind;
/* expect unit: which MtUnit field; name|class|namekey compare as strings (== !=), the rest as integers (any op).
 * Order = mt_script.c UNIT_FIELDS = script.ts UNIT_FIELDS; the stat fields follow MT_STAT_* (data/characters order). */
typedef enum MtUnitField {
    MT_F_NAME, MT_F_CLASS, MT_F_NAMEKEY, MT_F_FACTION, MT_F_MOVE, MT_F_ACT, MT_F_TURNKIND, MT_F_HP, MT_F_SHIELD, MT_F_DIVINESHIELD,
    MT_F_STRENGTH, MT_F_DEXTERITY, MT_F_CONSTITUTION, MT_F_INTELLIGENCE, MT_F_SPEED, MT_F_CHARISMA, MT_F_LUCK
} MtUnitField;
int mt_unit_field_parse(const char *p, size_t n, MtUnitField *out);   /* 1 ok */
/* expect gon: how the value is compared (decided by the literal's shape at parse time) */
typedef enum MtGonCheck { MT_G_NUM, MT_G_STR, MT_G_BOOL, MT_G_EXISTS, MT_G_MISSING } MtGonCheck;
const char *mt_unit_field_name(MtUnitField f);
#define MT_SHOT_HOLD_MS 700
typedef enum MtOp { MT_OP_EQ, MT_OP_NE, MT_OP_GE, MT_OP_LE, MT_OP_GT, MT_OP_LT } MtOp;
/* scenes `enter` knows; 0 = unknown. The DLL and the Node parser (script.ts KNOWN_SCENES) must agree. */
#define MT_SCENE_TACTICS_TEST 1
#define MT_SCENE_CAMPAIGN     2   /* the save-slot click replayed on the harness-owned slot MT_CAMPAIGN_SAVE */
/* the disposable campaign slot: created/opened by `enter Campaign`, moved aside by the runner before every such run
 * (editor savecheck.ts CAMPAIGN_SLOT_FILE must agree); no save-select UI lists this name. Under 16 chars (SSO). */
#define MT_CAMPAIGN_SAVE "mewtest01.sav"
/* enter modes: default; house = Campaign only: mark the fresh slot as begun (game_began 1, what the new-game branch
 * 0x3af310 writes before the intro) so MewDirector::start resumes into the House instead of the interactive intro */
#define MT_ENTER_DEFAULT 0
#define MT_ENTER_HOUSE   1
const char *mt_enter_mode_name(int mode);     /* "" for the default */
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
    int enterMode;      /* enter: MT_ENTER_* */
    MtUnitField field;  /* expect unit: the field; a string value lives in a, an integer one in value */
    const char *c;      /* expect gon: the quoted string value (a = the path, b/n = the unit) */
    double dvalue;      /* expect gon: the numeric value; a bool value lives in value */
    MtGonCheck gonCheck;
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

/* ---- mt_queue.c: interactive-mode requests (pipe thread -> frame thread) ---- */
#define MT_Q_SLOTS 8
#define MT_Q_TEXT 4096
#define MT_Q_REPLY 8192
#define MT_Q_FRAMES_DEFAULT 3
#define MT_Q_FRAMES_MAX 600
typedef enum MtQState { MT_Q_FREE = 0, MT_Q_PENDING, MT_Q_ACTIVE, MT_Q_DONE } MtQState;
typedef enum MtQOp { MT_QOP_EXEC = 0, MT_QOP_DUMP, MT_QOP_QUIT } MtQOp;
typedef struct MtRequest {
    MtQState state;
    unsigned seq;           /* push order (FIFO) */
    long id;                /* the client's id, echoed in the reply */
    MtQOp op;
    int frames;             /* exec: frames to keep collecting console lines after the command ran */
    char text[MT_Q_TEXT];   /* exec: the console line */
    char reply[MT_Q_REPLY]; /* the JSON line the runner emitted for it (DONE) */
} MtRequest;
typedef struct MtQueue { MtRequest slots[MT_Q_SLOTS]; unsigned nextSeq; } MtQueue;
void       mt_queue_init(MtQueue *q);
MtRequest *mt_queue_push(MtQueue *q, long id, MtQOp op, const char *text, int frames);   /* NULL: full or text > MT_MAX_CMD */
MtRequest *mt_queue_take(MtQueue *q);                                                    /* oldest PENDING -> ACTIVE; NULL when none or one is ACTIVE */
void       mt_queue_complete(MtRequest *r, const char *replyJson);                       /* ACTIVE -> DONE */
void       mt_queue_release(MtRequest *r);                                               /* -> FREE */
/* {"id":N,"op":"exec"|"dump"|"quit","text":"...","frames":K}: 1 ok; 0 with err. frames defaults to MT_Q_FRAMES_DEFAULT, clamped to MT_Q_FRAMES_MAX */
int        mt_pipe_parse_request(const char *line, long *id, MtQOp *op, char *text, size_t cap, int *frames, char *err, size_t errCap);
int        mt_pipe_error_reply(char *out, size_t cap, long id, const char *msg);        /* {"ev":"exec","id":N,"ok":false,"error":"..."} (no newline) */

/* ---- mt_gon.c: a read-only walk of the game's GonObject tree (layout: the generated offsets.h OFF_GON_* / GON_NODE_SIZE) ---- */
#define MT_STAT_COUNT 7           /* Character+OFF_CH_STATS: strength dexterity constitution intelligence speed charisma luck */
#define MT_STAT_SPEED 4
const char *mt_stat_name(int k);  /* the data/characters key of stat k, "?" out of range */
#define MT_GON_TEXT 256
typedef int (*MtMemRead)(void *u, const void *addr, void *out, size_t n);   /* guarded copy: 1 ok, 0 unreadable */
typedef struct MtGonValue {
    int type;               /* 0 null, 1 string, 2 number, 3 object, 4 array, 5 bool */
    int i; double d; int b; /* the int / double / bool fields (valid for the matching type; read regardless) */
    char text[MT_GON_TEXT]; /* the raw token text (every scalar keeps it) */
    long childCount;        /* object / array */
} MtGonValue;
const char *mt_gon_type_name(int type);
/* Walk `path` ("properties.health", "abilities.spells.0"; "" = the node itself) from `node`: an all-digit segment
 * indexes the children vector, any other segment is the first child whose name (+OFF_GON_NAME) equals it — the
 * linear scan of the game's child_by_name, without calling it. Returns 1 found (out filled), 0 missing (detail
 * names the segment), -1 unreadable (detail says where; a NULL node is unreadable). */
int mt_gon_get(MtMemRead rd, void *u, const void *node, const char *path, MtGonValue *out, char *detail, size_t cap);

/* ---- mt_runner.c ------------------------------------------------------- */
#define MT_UNIT_NAME 64
#define MT_UNIT_STATUSES 24
#define MT_STATUS_NAME 32
typedef struct MtUnit {
    char name[MT_UNIT_NAME], cls[MT_UNIT_NAME];
    char nameKey[MT_UNIT_NAME];            /* the display-name loc key, graphics.name (Character+OFF_CH_NAME_KEY; OBSERVED 2026-10-22, not the entry name) */
    int faction, move, act, turnKind;
    int hp, shield, divineShield;          /* Character+OFF_CH_HP / OFF_CH_SHIELD / OFF_CH_DIVINE_SHIELD */
    int stats[MT_STAT_COUNT];              /* Character+OFF_CH_STATS, mt_stat_name order */
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
    int      (*enter_scene)(void *u, int scene, int mode, char *detail, size_t cap);
    /* seed <N> on the game thread: 1 seeded, 0 refused (detail), -1 unavailable (symbol / TLS missing) */
    int      (*seed_rng)(void *u, unsigned long long seed, char *detail, size_t cap);
    /* interactive mode: hand a reply to the pipe right now (used for quit, which exits before the pipe thread
     * would get to it); NULL when there is no pipe */
    void     (*pipe_reply)(void *u, const char *jsonLine);
    /* GON at runtime (expect gon): a guarded memory copy and the unit's entry node (Character+OFF_CH_GON_ENTRY;
     * NULL when the unit or the pointer is unreadable). The walker reads through mem_read only. */
    int         (*mem_read)(void *u, const void *addr, void *out, size_t n);
    const void *(*unit_gon)(void *u, int i);
} MtHost;

typedef enum MtState { MT_S_RUN, MT_S_WAIT_CONSOLE, MT_S_WAIT_FRAMES, MT_S_WAIT_TURNS, MT_S_WAIT_MS, MT_S_WAIT_WITHIN, MT_S_WAIT_ROUNDS, MT_S_WAIT_SHOT, MT_S_IDLE } MtState;
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
    /* interactive mode: at end of script go MT_S_IDLE (emit idle once) and keep serving the queue until a quit request */
    int interactive;
    int idleEmitted;
    MtQueue *queue;         /* NULL: no pipe; requests are served one per frame while idle or inside a wait */
    MtRequest *active;      /* an exec still collecting console lines */
    int activeFramesLeft;
} MtRunner;
void mt_runner_init(MtRunner *r, const MtScript *s, uint64_t now);
void mt_runner_set_interactive(MtRunner *r, int on);
void mt_runner_attach_queue(MtRunner *r, MtQueue *q);
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
