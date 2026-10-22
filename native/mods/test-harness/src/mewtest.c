/*
 * mewtest.dll — in-game test harness for Mewgenics mods, on top of mewframework.dll.
 *
 * Inert unless the game was launched with -mewtest <script> (and -savesuffix, which the
 * framework already requires). Then, from the per-frame hook on the main thread, it runs
 * the script one directive per frame: console commands go straight into the game's
 * DebugConsole::Execute, console output is read from the console's own vector, turns are
 * counted through TurnControl::NextTurn, and combat state is read through guarded memory
 * reads. Every event is appended to a JSON-lines file; the process exit code is the
 * verdict. Contracts: docs/ingame-testing.md. Everything game-agnostic lives in mt_*.c
 * (host-tested); this file is the only one that touches Windows and the game.
 *
 * Exit codes: 0 pass, 1 expect failed, 2 timeout, 3 crash, 4 harness error.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdarg.h>
#include <string.h>

#include "mewjector.h"
#include "framework_api.h"
#include "mt_pure.h"

#define MOD_OWNER "mewtest"
/* MT_GRACE_CLEAN_MS / MT_GRACE_CRASH_MS live in mt_pure.h next to mt_exit_decide, which owns the decision */

/* --- game layout: struct offsets and vtable slots come from the generated offsets.h (bindings/<build>.json) --- */
#include "offsets.h"
#define MAX_UNITS              64

typedef void (*fn_Execute)(void *dc, MtMsvcString *line);
typedef void (*fn_DCInit)(void *dc, void *nameStr);
typedef void (*fn_FrameBegin)(void *app);
typedef void (*fn_NextTurn)(void *tc);
typedef void *(*fn_Allocate)(size_t bytes);
typedef void (*fn_TidyDeallocate)(MtMsvcString *s);
typedef MtMsvcString *(*fn_GetTypeName)(void *self, MtMsvcString *out);
typedef int (*fn_IsA)(void *self, MtMsvcString *name);
typedef int (*fn_SDL_SetSwapInterval)(int);
typedef int (*fn_SDL_HideWindow)(void *window);
/* run entry (framework v4 symbols): the dev menu's TacticsTest button, replayed */
typedef void *(*fn_CreateScene)(void *sceneManager, MtMsvcString *name);   /* by-value string, callee destroys */
typedef void *(*fn_CreateEntity)(void *scene);
typedef void *(*fn_AddTacticsTest)(void *scene, void *entity);
typedef void (*fn_DestroyOwnerOf)(void *component);                  /* Entity::destroy of the component's entity */
typedef void *(*fn_AddDirectorNamed)(void *scene, void *entity, MtMsvcString *saveName); /* AddComponent<MewDirector>; copies the name */
typedef void (*fn_DirectorStart)(void *director);
typedef void **(*fn_SavePropGet)(void *propMap, void **out16, MtMsvcString *key);  /* returns out; *out = the property node (value at +0x30) */                    /* MewDirector::start: new game or resume from the save */
typedef void *(*fn_AddDirectorTest)(void *scene, void *entity);   /* the test director on test00.sav (name hard-coded in the callee) */
typedef void *(*fn_GetGame)(void *component);                       /* Component::GetGame: the MewGame object of the component's scene */
typedef uint64_t *(*fn_RngSeedState)(uint64_t *out4, uint64_t seed); /* expands a seed into the 32-byte RNG state */

static MewjectorAPI g_mj;
static int g_mjOk;
static FwApi g_fw;
static FILE *g_log;
static MtArgs g_args;
static MtScript g_script;
static MtRunner g_runner;
static int g_scriptOk;
static char g_scriptErr[256];
static int g_scriptErrLine;
static HANDLE g_out = INVALID_HANDLE_VALUE;
static CRITICAL_SECTION g_outLock, g_runLock;
/* interactive mode (-mewtest_pipe 1): one named pipe, one reader thread, one request queue shared with the runner.
 * g_pipeLock guards the queue and every pipe write; the frame thread holds it for the whole runner step (it never
 * waits on anything while holding it), the pipe thread only for push / poll / release. Never taken with g_outLock. */
static HANDLE g_pipe = INVALID_HANDLE_VALUE;
static CRITICAL_SECTION g_pipeLock;
static MtQueue g_queue;
static char g_pipeName[64];
static int g_active;
static DWORD g_startTick;
static uintptr_t g_base, g_imageEnd;

static fn_Execute g_Execute;
static fn_Allocate g_Allocate;
static fn_TidyDeallocate g_Tidy;
static fn_DCInit g_origDCInit;
static fn_FrameBegin g_origFrameBegin;
static fn_NextTurn g_origNextTurn;
static fn_CreateScene g_CreateScene;        /* NULL when the framework predates v4: `enter` reports enter_unavailable */
static fn_CreateEntity g_CreateEntity;
static fn_AddTacticsTest g_AddTacticsTest;
static fn_DestroyOwnerOf g_DestroyOwnerOf;
static fn_AddDirectorNamed g_AddDirectorNamed;
static fn_DirectorStart g_DirectorStart;
static fn_SavePropGet g_SavePropGet;
static fn_AddDirectorTest g_AddDirectorTest;
static fn_GetGame g_GetGame;
static fn_RngSeedState g_RngSeedState;

static void *volatile g_dc;
static volatile LONG g_dcInits;
static void *volatile g_tc;
static volatile LONG g_turns;
static void *g_sdlInitial[FW_DATA_COUNT_];
static int g_hidden;
static volatile LONG g_crashed;
static DWORD g_crashTick;
static volatile LONG g_endWritten;
static int g_exitCode = -1;
static DWORD g_cleanExitTick;
static volatile LONG g_exitFired;   /* the watchdog acted on an mt_exit_decide answer */
static LPTOP_LEVEL_EXCEPTION_FILTER g_prevFilter;

/* ----------------------------------------------------------------------- */
/* logging + result file                                                    */
/* ----------------------------------------------------------------------- */
static void logf_(const char *fmt, ...) {
    char buf[1024];
    va_list ap; va_start(ap, fmt); vsnprintf(buf, sizeof buf, fmt, ap); va_end(ap);
    if (g_mjOk && g_mj.Log) g_mj.Log(MOD_OWNER, "%s", buf);
    if (g_log) { fprintf(g_log, "%s\n", buf); fflush(g_log); }
    OutputDebugStringA(buf);
}

static void write_raw(const char *line) {
    if (g_out == INVALID_HANDLE_VALUE) return;
    DWORD n = 0;
    WriteFile(g_out, line, (DWORD)strlen(line), &n, NULL);
    FlushFileBuffers(g_out);
}

static void emit_locked(const char *line) {
    EnterCriticalSection(&g_outLock);
    write_raw(line);
    LeaveCriticalSection(&g_outLock);
}

static long long t_ms(void) { return (long long)(GetTickCount() - g_startTick); }

/* ----------------------------------------------------------------------- */
/* guarded memory access                                                    */
/* ----------------------------------------------------------------------- */
static int safe_read(const void *addr, void *out, size_t n) {
    MEMORY_BASIC_INFORMATION mbi;
    if (!addr || n == 0) return 0;
    const char *p = (const char *)addr;
    size_t done = 0;
    while (done < n) {
        if (!VirtualQuery(p + done, &mbi, sizeof mbi)) return 0;
        if (mbi.State != MEM_COMMIT) return 0;
        DWORD prot = mbi.Protect & 0xff;
        if (mbi.Protect & PAGE_GUARD) return 0;
        if (prot == PAGE_NOACCESS || prot == 0) return 0;
        size_t avail = (size_t)((const char *)mbi.BaseAddress + mbi.RegionSize - (p + done));
        size_t chunk = avail < n - done ? avail : n - done;
        memcpy((char *)out + done, p + done, chunk);
        done += chunk;
    }
    return 1;
}
static int read_ptr(const void *addr, void **out) { return safe_read(addr, out, sizeof *out); }
static int read_u32(const void *addr, uint32_t *out) { return safe_read(addr, out, sizeof *out); }
static int read_i32(const void *addr, int *out) { return safe_read(addr, out, sizeof *out); }
#define AT(base, off) ((const void *)((const char *)(base) + (off)))
/* a code pointer the harness may call: inside the game image, or inside mewframework.dll — a framework-registered
 * status (Joker's Luck) carries a cloned vtable whose slots 0-3 are the framework's thunks, outside the exe */
static uintptr_t g_fwBase, g_fwEnd;
static int code_ptr_ok(const void *p) {
    uintptr_t a = (uintptr_t)p;
    return (a >= g_base && a < g_imageEnd) || (g_fwBase && a >= g_fwBase && a < g_fwEnd);
}

/* copy an MSVC std::string living in game memory into buf */
static int read_msvc_string(const void *addr, char *buf, size_t cap) {
    MtMsvcString s;
    if (!safe_read(addr, &s, sizeof s)) return 0;
    if (s.cap < 15 || s.size > s.cap || s.size > 4096) return 0;
    if (s.cap > 15) {
        size_t n = s.size < cap - 1 ? s.size : cap - 1;
        if (!safe_read(s.u.ptr, buf, n)) return 0;
        buf[n] = 0;
    } else {
        mt_msvcstr_copy(&s, buf, cap);
    }
    return 1;
}
static int read_msvc_wstring(const void *addr, char *buf, size_t cap) {
    MtMsvcWString s;
    uint16_t tmp[256];
    if (!safe_read(addr, &s, sizeof s)) return 0;
    if (s.cap < 7 || s.size > s.cap || s.size > 255) return 0;
    const uint16_t *src = s.cap > 7 ? s.u.ptr : s.u.buf;
    if (s.cap > 7 && !safe_read(src, tmp, s.size * 2)) return 0;
    if (s.cap <= 7) memcpy(tmp, s.u.buf, s.size * 2);
    mt_wstr_to_utf8(tmp, s.size, buf, cap);
    return 1;
}

/* ----------------------------------------------------------------------- */
/* hooks                                                                    */
/* ----------------------------------------------------------------------- */
static void hook_DCInit(void *dc, void *nameStr) {
    g_dc = dc;
    LONG n = InterlockedIncrement(&g_dcInits);
    logf_("DebugConsole::init #%ld (dc=%p)", n, dc);
    g_origDCInit(dc, nameStr);
}

static void hook_NextTurn(void *tc) {
    g_tc = tc;
    InterlockedIncrement(&g_turns);
    g_origNextTurn(tc);
}

/* diagnostic: every MewDirector::init(this, name) with the caller chain as RVAs, so "More than one mew director"
 * can be attributed (the harness never creates more than one itself) */
typedef void (*fn_DirectorInit)(void *director, void *nameStr);
static fn_DirectorInit g_origDirectorInit;
static void hook_DirectorInit(void *director, void *nameStr) {
    void *frames[12];
    USHORT n = RtlCaptureStackBackTrace(1, 12, frames, NULL);
    char chain[400] = "";
    for (USHORT i = 0; i < n; i++) {
        uintptr_t a = (uintptr_t)frames[i];
        char piece[40];
        if (a >= g_base && a < g_imageEnd) snprintf(piece, sizeof piece, " exe+0x%llx", (unsigned long long)(a - g_base));
        else snprintf(piece, sizeof piece, " %p", (void *)a);
        strncat(chain, piece, sizeof chain - strlen(chain) - 1);
    }
    char nm[64] = "?";
    read_msvc_string(nameStr, nm, sizeof nm);
    logf_("MewDirector::init(%p, \"%s\") from%s", director, nm, chain);
    g_origDirectorInit(director, nameStr);
}

static void maybe_hide(void) {
    if (g_hidden || !g_args.hide) return;
    void *appGlobal = (void *)g_fw.GetData(FW_DATA_App);
    void *app = NULL, *window = NULL;
    if (!appGlobal || !read_ptr(appGlobal, &app) || !app || !read_ptr(AT(app, OFF_APP_WINDOW), &window) || !window) return;
    void **hideSlot = (void **)g_fw.GetData(FW_DATA_SDL_HideWindow);
    void **swapSlot = (void **)g_fw.GetData(FW_DATA_SDL_GL_SetSwapInterval);
    void *hideFn = NULL, *swapFn = NULL;
    if (!hideSlot || !swapSlot || !read_ptr(hideSlot, &hideFn) || !read_ptr(swapSlot, &swapFn)) return;
    /* The window exists, so SDL_Init has run and the DYNAPI table is populated. (The
     * DllMain-time snapshot of the slots is only logged: Mewjector loads mods on the first
     * proxy call, which may already be after SDL init, so "slot changed" is not a usable test.) */
    if (!code_ptr_ok(hideFn) || !code_ptr_ok(swapFn)) { logf_("SDL slots point outside the game image; not hiding"); g_hidden = 1; return; }
    int h = ((fn_SDL_HideWindow)hideFn)(window);
    int s = ((fn_SDL_SetSwapInterval)swapFn)(0);
    g_hidden = 1;
    logf_("window hidden at frame %ld (SDL_HideWindow=%d, SDL_GL_SetSwapInterval(0)=%d; slot %p, DllMain-time value %p)",
          g_runner.frame, h, s, hideFn, g_sdlInitial[FW_DATA_SDL_HideWindow]);
}

static void write_script_error_and_end(void);
static void step_runner(void); /* defined after the MtHost table */
static void hook_FrameBegin(void *app) {
    g_origFrameBegin(app);
    if (!g_active) return;
    maybe_hide();
    EnterCriticalSection(&g_runLock);
    if (!g_scriptOk) {
        write_script_error_and_end();
    } else if (!g_runner.finished) {
        step_runner();
    }
    LeaveCriticalSection(&g_runLock);
}

/* ----------------------------------------------------------------------- */
/* MtHost implementation                                                    */
/* ----------------------------------------------------------------------- */
static int h_console_ready(void *u) {
    (void)u;
    void *b = NULL, *e = NULL;
    void *dc = g_dc;
    if (!dc) return 0;
    if (!read_ptr(AT(dc, OFF_DC_OUT_BEGIN), &b) || !read_ptr(AT(dc, OFF_DC_OUT_END), &e)) return 0;
    return e >= b;
}
static int h_exec_cmd(void *u, const char *line) {
    (void)u;
    MtMsvcString s;
    if (!mt_msvcstr_build(&s, line, strlen(line), (MtAllocFn)g_Allocate)) { logf_("exec_cmd: cannot build string for %.40s", line); return 0; }
    g_Execute(g_dc, &s); /* callee destroys the string */
    return 1;
}
static int h_console_count(void *u) {
    (void)u;
    void *b = NULL, *e = NULL;
    void *dc = g_dc;
    if (!dc || !read_ptr(AT(dc, OFF_DC_OUT_BEGIN), &b) || !read_ptr(AT(dc, OFF_DC_OUT_END), &e) || e < b) return 0;
    size_t n = ((size_t)((char *)e - (char *)b)) / sizeof(MtMsvcString);
    return n > 100000 ? 0 : (int)n;
}
static int h_console_line(void *u, int i, char *buf, size_t cap) {
    (void)u;
    void *b = NULL;
    void *dc = g_dc;
    if (!dc || !read_ptr(AT(dc, OFF_DC_OUT_BEGIN), &b) || !b) return 0;
    return read_msvc_string(AT(b, (size_t)i * sizeof(MtMsvcString)), buf, cap);
}
static long h_turn_count(void *u) { (void)u; return (long)g_turns; }
static int h_round_number(void *u) {
    (void)u;
    int r = 0;
    void *tc = g_tc;
    if (!tc || !read_i32(AT(tc, OFF_TC_ROUND), &r)) return 0;
    return r;
}
static uint64_t h_now_ms(void *u) { (void)u; return (uint64_t)GetTickCount64(); }

/* resolve the live Character* array: returns count and fills data (up to MAX_UNITS) */
static int char_array(void **data, int *count) {
    void *tc = g_tc, *scene = NULL, *em = NULL, *x = NULL, *arr = NULL, *dataPtr = NULL;
    uint32_t n = 0;
    *count = 0;
    if (!tc) return 0;
    if (!read_ptr(AT(tc, OFF_TC_SCENE), &scene) || !scene) return 0;
    if (!read_ptr(AT(scene, OFF_SCENE_EM), &em) || !em) return 0;
    if (!read_ptr(AT(em, OFF_EM_X), &x) || !x) return 0;
    if (!read_ptr(AT(x, OFF_X_CHARARRAY), &arr) || !arr) return 0;
    if (!read_u32(AT(arr, OFF_ARR_COUNT), &n) || n > MAX_UNITS) return 0;
    if (!read_ptr(AT(arr, OFF_ARR_DATA), &dataPtr) || !dataPtr) return 0;
    if (n && !safe_read(dataPtr, data, n * sizeof(void *))) return 0;
    *count = (int)n;
    return 1;
}
/* enter <scene>: replay what the dev menu's "TacticsTest" button does (DevMenu_TacticsTest_lambda_0x32fc00.c):
 * a new scene named "Battle" from the scene manager, one entity in it, AddComponent<TacticsTest>(scene, entity)
 * whose init registers the run console commands and starts the test fight. Runs on the game thread (FrameBegin
 * hook, same as cmd). The lambda also reseeds the RNG and copies three dev-menu widget values into the director's
 * settings; neither is replayed (the director keeps its defaults, the RNG stays as it is). No save file is opened:
 * the boot-time test director (test00.sav) is the one TacticsTest reads. Returns 1 / 0 (detail) / -1 (symbols). */
/* enter Campaign: replay the save-slot click (AddDirector_indirect_0x1c06c0.c) on the harness-owned slot
 * MT_CAMPAIGN_SAVE. The click: destroy the entity of the current director (here the dev-mode test director on
 * test00.sav; MewDirector::init's "More than one mew director" check compares the global's generation, which the
 * destroy bumps), a new entity on the main scene, AddComponent<MewDirector>(scene, entity, name) — init opens or
 * creates saves/<name> — then MewDirector::start, which reads game_began / on_adventure / house_night from that
 * save: a fresh slot starts the new-game cutscene, a kept one resumes. The runner moves the slot aside before
 * every such run (docs/ingame-testing.md "Save safety"), so a script always starts a new game. The click also flags
 * its own save-select scene for destruction (+0x4db); there is no such scene here, so that is not replayed. */
static int enter_campaign(int mode, char *detail, size_t cap) {
    if (!g_CreateEntity || !g_DestroyOwnerOf || !g_AddDirectorNamed || !g_DirectorStart) {
        snprintf(detail, cap, "symbols missing: FW_SYM_Entity_DestroyOwnerOf/AddComponent_MewDirector_named/MewDirector_start (framework older than v4?)");
        return -1;
    }
    void *dc = g_dc, *mgr = NULL, *director = NULL, *mainScene = NULL, *directorGlobal = (void *)g_fw.GetData(FW_DATA_MewDirector);
    if (!dc) { snprintf(detail, cap, "no debug console yet (main menu not reached)"); return 0; }
    if (g_tc) { snprintf(detail, cap, "a fight is already running (TurnControl seen)"); return 0; }
    if (!read_ptr(AT(dc, OFF_COMPONENT_SCENEMANAGER), &mgr) || !mgr) { snprintf(detail, cap, "no scene manager on the console component (+0x%x)", OFF_COMPONENT_SCENEMANAGER); return 0; }
    if (!directorGlobal || !read_ptr(directorGlobal, &director)) { snprintf(detail, cap, "cannot read the MewDirector global"); return 0; }
    /* the game's dev-mode startup makes its test director a few frames after the menu; replacing it before it exists would race it */
    if (!director) { snprintf(detail, cap, "no MewDirector yet (the game's dev-mode startup makes the test director after the menu)"); return 2; }
    char destroyed = 1;
    if (!read_ptr(AT(mgr, OFF_SCENEMANAGER_MAINSCENE), &mainScene) || !mainScene || !safe_read(AT(mainScene, OFF_SCENE_DESTROYED), &destroyed, 1) || destroyed) {
        snprintf(detail, cap, "main scene %p unusable (destroyed=%d)", mainScene, (int)destroyed);
        return 0;
    }
    _Static_assert(sizeof(MT_CAMPAIGN_SAVE) - 1 < 16, "the slot name must stay SSO: the callee copies it and nothing frees it");
    MtMsvcString name;
    if (!mt_msvcstr_build(&name, MT_CAMPAIGN_SAVE, sizeof(MT_CAMPAIGN_SAVE) - 1, (MtAllocFn)g_Allocate)) { snprintf(detail, cap, "cannot build the save name"); return 0; }
    g_DestroyOwnerOf(director);
    void *globalAfterDestroy = NULL;
    read_ptr(directorGlobal, &globalAfterDestroy);
    void *entity = g_CreateEntity(mainScene);
    if (!entity) { snprintf(detail, cap, "CreateEntity returned NULL on the main scene %p (old director %p destroyed)", mainScene, director); return 0; }
    void *d = g_AddDirectorNamed(mainScene, entity, &name);
    if (!d) { snprintf(detail, cap, "AddComponent<MewDirector>(\"%s\") returned NULL", MT_CAMPAIGN_SAVE); return 0; }
    char houseNote[96] = "";
    if (mode == MT_ENTER_HOUSE) {
        /* skip the interactive intro (BeaniesIntroSequence waits for the player to choose cats): write the save
         * property the new-game branch 0x3af310 writes before it (game_began = 1, std::string key, value at node+0x30)
         * so MewDirector::start takes its resume path: CreateScene("House") + the campaign House driver 0x3c3ee0 */
        if (!g_SavePropGet) { snprintf(detail, cap, "symbol missing: FW_SYM_SaveProps_GetOrCreate (framework older than this harness)"); return -1; }
        MtMsvcString key;
        if (!mt_msvcstr_build(&key, "game_began", 10, (MtAllocFn)g_Allocate)) { snprintf(detail, cap, "cannot build the property key"); return 0; }
        void *out[2] = { NULL, NULL };
        g_SavePropGet((char *)d + 0x38, out, &key);
        if (!out[0]) { snprintf(detail, cap, "SaveProps_GetOrCreate(game_began) gave no node"); return 0; }
        *(volatile long long *)((char *)out[0] + 0x30) = 1;
        snprintf(houseNote, sizeof houseNote, "; game_began set (node %p) -> resume into the House", out[0]);
    }
    g_DirectorStart(d);
    void *globalAfterStart = NULL;
    read_ptr(directorGlobal, &globalAfterStart);
    snprintf(detail, cap, "save=%s mainScene=%p entity=%p director=%p (old %p; global after destroy %p, after start %p)%s",
             MT_CAMPAIGN_SAVE, mainScene, entity, d, director, globalAfterDestroy, globalAfterStart, houseNote);
    logf_("enter Campaign: %s", detail);
    return 1;
}

static int h_enter_scene(void *u, int scene, int mode, char *detail, size_t cap) {
    (void)u;
    if (scene == MT_SCENE_CAMPAIGN) return enter_campaign(mode, detail, cap);
    if (scene != MT_SCENE_TACTICS_TEST) { snprintf(detail, cap, "unknown scene id %d", scene); return 0; }
    if (!g_CreateScene || !g_CreateEntity || !g_AddTacticsTest) {
        snprintf(detail, cap, "symbols missing: FW_SYM_SceneManager_CreateScene/Scene_CreateEntity/AddComponent_TacticsTest (framework older than v4?)");
        return -1;
    }
    void *dc = g_dc, *mgr = NULL, *director = NULL, *directorGlobal = (void *)g_fw.GetData(FW_DATA_MewDirector);
    if (!dc) { snprintf(detail, cap, "no debug console yet (main menu not reached)"); return 0; }
    if (g_tc) { snprintf(detail, cap, "a fight is already running (TurnControl seen)"); return 0; }
    if (!read_ptr(AT(dc, OFF_COMPONENT_SCENEMANAGER), &mgr) || !mgr) { snprintf(detail, cap, "no scene manager on the console component (+0x%x)", OFF_COMPONENT_SCENEMANAGER); return 0; }
    if (!directorGlobal || !read_ptr(directorGlobal, &director)) { snprintf(detail, cap, "cannot read the MewDirector global"); return 0; }
    /* OBSERVED 2026-10-20: TacticsTest::init creates its own MewDirector (debug.log: "LOAD LEVEL: levels/blank.lvl"
     * right before it); a director made here first trips the game's "More than one mew director" assert, whose
     * handler never returns (the main loop stalls until the watchdog exits 2). So a director that already exists is
     * refused — nothing is created here — and the global is read only for the report. */
    /* OBSERVED 2026-10-20 (MewDirector::init hook): in dev mode the game's own load-complete path
     * (exe+0x751886 <- 0x748395) creates the test director (test00.sav) on the main scene a few frames after the
     * menu is up, and TacticsTest::init dereferences the director Component::GetGame returns (crash at +0x835a32
     * without one). An entry made before that director exists raced it ("More than one mew director"). So: not
     * ready until the game has made its director; the runner retries every frame for MT_CONSOLE_WAIT_MS. */
    if (!director) { snprintf(detail, cap, "no MewDirector yet (the game's dev-mode startup makes the test director after the menu)"); return 2; }
    /* diagnostic for the record: the scenes the manager holds (vector at +0 .. +8), each with its name (+0x4b8),
     * destroyed flag (+0x4b0) and whether it carries a MewGame (type 0x50c list at scene+0x20 -> +0x50c0) */
    {
        void *begin = NULL, *end = NULL, *mainScene = NULL;
        read_ptr(mgr, &begin); read_ptr(AT(mgr, 8), &end); read_ptr(AT(mgr, OFF_SCENEMANAGER_MAINSCENE), &mainScene);
        logf_("enter: scene manager %p, main scene %p, %d scene(s)", mgr, mainScene, (begin && end && end >= begin) ? (int)(((char *)end - (char *)begin) / 8) : -1);
        for (int i = 0; begin && end && i < 32 && (char *)begin + i * 8 < (char *)end; i++) {
            void *sc = NULL, *lists = NULL, *entry = NULL, *first = NULL, *firstArr = NULL;
            char nm[64] = "?", destroyedFlag = 0;
            uint32_t cnt = 0;
            if (!read_ptr(AT(begin, i * 8), &sc) || !sc) continue;
            read_msvc_string(AT(sc, 0x4b8), nm, sizeof nm);
            safe_read(AT(sc, OFF_SCENE_DESTROYED), &destroyedFlag, 1);
            if (read_ptr(AT(sc, 0x20), &lists) && lists && read_ptr(AT(lists, 0x50c0), &entry) && entry && read_u32(AT(entry, 0xc), &cnt) && cnt && read_ptr(AT(entry, 0x10), &firstArr) && firstArr) read_ptr(firstArr, &first);
            logf_("enter:   scene[%d] %p \"%s\" destroyed=%d MewGame(0x50c)=%p (count %u)", i, sc, nm, (int)destroyedFlag, first, cnt);
        }
    }
    /* the dev-menu button flags the director (Component::GetGame = the scene's MewDirector, type 0x50c) before it
     * creates the Battle scene (lambda 0x32fc00): +0x780 = 1, +0x78c = 1, +0x6dc = 1. Replay that on ours. */
    void *game = g_GetGame ? g_GetGame(dc) : NULL;   /* should now resolve to the director on the main scene */
    void *flagTarget = game ? game : director;
    char probe = 0;
    if (!safe_read(AT(flagTarget, OFF_DIRECTOR_DEVFIGHT_MODE), &probe, 1)) { snprintf(detail, cap, "director %p unreadable", flagTarget); return 0; }
    /* DECOMPILED (MewDirector::DebugGenAdventureCats 0x3b24c0): +0x78c = "take the party from a saved winning
     * team"; when none is saved it warns ("no saved winning teams - win at least one run first!"), clears the
     * flag and generates a party anyway. The harness leaves it 0 so a fresh test00.sav gets a generated party
     * without the popup. +0x780 is set by every dev-menu fight button; +0x6dc is the act (the button sets 1). */
    *(volatile char *)((char *)flagTarget + OFF_DIRECTOR_DEVFIGHT_FLAG) = 1;
    *(volatile char *)((char *)flagTarget + OFF_DIRECTOR_DEVFIGHT_MODE) = 0;
    *(volatile int *)((char *)flagTarget + OFF_DIRECTOR_HANDOFF_FLAG) = 1;
    /* the button also copies its party-source widget into the director's settings struct (+0x5a8 -> +0x410/+0x428/
     * +0x440); MewDirector::DebugGenAdventureCats(enum) refuses mode 0 without a saved winning team ("win at least
     * one run first!"), so the harness asks for the generated party instead (MEWTEST_PARTY_MODE overrides, default 1) */
    {
        void *settings = NULL;
        int mode = 1;
        char envMode[16];
        if (GetEnvironmentVariableA("MEWTEST_PARTY_MODE", envMode, sizeof envMode)) mode = atoi(envMode);
        if (read_ptr(AT(flagTarget, 0x5a8), &settings) && settings) {
            int probeI = 0;
            if (safe_read(AT(settings, 0x440), &probeI, 4)) {
                *(volatile int *)((char *)settings + 0x410) = mode;
                *(volatile int *)((char *)settings + 0x428) = mode;
                *(volatile int *)((char *)settings + 0x440) = mode;
                logf_("enter: director settings %p: party-source fields +0x410/+0x428/+0x440 set to %d", settings, mode);
            } else logf_("enter: director settings %p unreadable; party-source fields left alone", settings);
        } else logf_("enter: director %p has no settings struct at +0x5a8", flagTarget);
    }
    MtMsvcString name;
    if (!mt_msvcstr_build(&name, "Battle", 6, (MtAllocFn)g_Allocate)) { snprintf(detail, cap, "cannot build the scene name"); return 0; }
    void *battle = g_CreateScene(mgr, &name); /* callee destroys the string */
    char destroyed = 1;
    if (!battle || !safe_read(AT(battle, OFF_SCENE_DESTROYED), &destroyed, 1) || destroyed) { snprintf(detail, cap, "CreateScene(\"Battle\") gave %p (destroyed=%d)", battle, (int)destroyed); return 0; }
    void *entity = g_CreateEntity(battle);
    if (!entity) { snprintf(detail, cap, "CreateEntity returned NULL on scene %p", battle); return 0; }
    void *tt = g_AddTacticsTest(battle, entity);
    if (!tt) { snprintf(detail, cap, "AddComponent<TacticsTest> returned NULL (scene %p being destroyed?)", battle); return 0; }
    void *directorAfter = NULL;
    read_ptr(directorGlobal, &directorAfter);
    snprintf(detail, cap, "scene=%p entity=%p component=%p manager=%p director=%p GetGame(console)=%p director(after init)=%p",
             battle, entity, tt, mgr, director, game, directorAfter);
    logf_("enter TacticsTest: %s", detail);
    return 1;
}

/* The game's RNG state: 4 qwords in the main thread's static TLS block at +0x178 (Rng_Reseed_0x94f0a0.c writes it
 * there). The exe's TLS slot index comes from its PE TLS directory (AddressOfIndex); the thread's TLS array is at
 * gs:[0x58]. We run on the game thread (FrameBegin hook), so that is the block the game reads. */
static uint64_t *game_rng_state(char *why, size_t cap) {
    const IMAGE_DOS_HEADER *dos = (const IMAGE_DOS_HEADER *)g_base;
    const IMAGE_NT_HEADERS64 *nt = (const IMAGE_NT_HEADERS64 *)(g_base + dos->e_lfanew);
    const IMAGE_DATA_DIRECTORY *dd = &nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_TLS];
    if (!dd->VirtualAddress) { snprintf(why, cap, "the exe has no TLS directory"); return NULL; }
    const IMAGE_TLS_DIRECTORY64 *tls = (const IMAGE_TLS_DIRECTORY64 *)(g_base + dd->VirtualAddress);
    uint32_t index = 0;
    if (!read_u32((const void *)(uintptr_t)tls->AddressOfIndex, &index) || index > 64) { snprintf(why, cap, "cannot read the exe's TLS index"); return NULL; }
    uintptr_t tlsArray = 0;
    __asm__ volatile("movq %%gs:0x58, %0" : "=r"(tlsArray));
    void *block = NULL;
    if (!tlsArray || !read_ptr((const void *)(tlsArray + (uintptr_t)index * 8), &block) || !block) { snprintf(why, cap, "no TLS block for slot %u on this thread", index); return NULL; }
    return (uint64_t *)((char *)block + OFF_TLS_RNG_STATE);
}
static int h_seed_rng(void *u, unsigned long long seed, char *detail, size_t cap) {
    (void)u;
    if (!g_RngSeedState) { snprintf(detail, cap, "symbol missing: FW_SYM_Rng_SeedState (framework older than v4?)"); return -1; }
    /* the game's own startup reseeds (load-complete, MewDirector::init); pin only once the director exists */
    {
        void *directorGlobal = (void *)g_fw.GetData(FW_DATA_MewDirector), *director = NULL;
        if (!g_dc || !directorGlobal || !read_ptr(directorGlobal, &director) || !director) { snprintf(detail, cap, "not ready: the game has not finished its startup (no director yet)"); return 2; }
    }
    char why[120] = "";
    uint64_t *state = game_rng_state(why, sizeof why);
    if (!state) { snprintf(detail, cap, "RNG state not reachable: %s", why); return 0; }
    uint64_t before[4] = {0, 0, 0, 0}, tmp[4] = {0, 0, 0, 0};
    if (!safe_read(state, before, sizeof before)) { snprintf(detail, cap, "RNG state at %p unreadable", (void *)state); return 0; }
    uint64_t *expanded = g_RngSeedState(tmp, (uint64_t)seed);
    if (!expanded) { snprintf(detail, cap, "Rng_SeedState returned NULL"); return 0; }
    memcpy(state, expanded, sizeof tmp);
    g_fw.SeedRandom((uint64_t)seed);   /* the mods' FW_Random stream (API v5) restarts from the same seed */
    snprintf(detail, cap, "state at %p: %016llx… -> %016llx…; FW_Random seeded", (void *)state, (unsigned long long)before[0], (unsigned long long)state[0]);
    logf_("seed %llu: %s", seed, detail);
    return 1;
}

static int h_units_available(void *u) { (void)u; void *d[MAX_UNITS]; int n; return char_array(d, &n); }
static int h_unit_count(void *u) { (void)u; void *d[MAX_UNITS]; int n; return char_array(d, &n) ? n : 0; }

/* type name of a component via vtable slot 0 (every glaiel::Component has it) */
static int component_type_name(void *comp, char *buf, size_t cap) {
    void **vt = NULL;
    void *fn = NULL;
    if (!read_ptr(comp, (void **)&vt) || !vt || !read_ptr(vt + VT_GETTYPENAME, &fn) || !code_ptr_ok(fn)) return 0;
    MtMsvcString out;
    memset(&out, 0, sizeof out);
    ((fn_GetTypeName)fn)(comp, &out);
    mt_msvcstr_copy(&out, buf, cap);
    if (out.cap > 15) g_Tidy(&out);
    return 1;
}
static int component_is_status(void *comp) {
    void **vt = NULL;
    void *fn = NULL;
    if (!read_ptr(comp, (void **)&vt) || !vt || !read_ptr(vt + VT_ISA, &fn) || !code_ptr_ok(fn)) return 0;
    MtMsvcString name;
    mt_msvcstr_build(&name, "Status", 6, NULL); /* SSO: nothing to free */
    return ((fn_IsA)fn)(comp, &name) != 0;
}
static int h_unit_info(void *u, int i, MtUnit *out) {
    (void)u;
    void *d[MAX_UNITS]; int n;
    memset(out, 0, sizeof *out);
    if (!char_array(d, &n) || i < 0 || i >= n) return 0;
    void *ch = d[i];
    if (!ch) return 0;
    if (!read_msvc_wstring(AT(ch, OFF_CH_NAME), out->name, sizeof out->name)) snprintf(out->name, sizeof out->name, "?");
    void *catdata = NULL;
    if (read_ptr(AT(ch, OFF_CH_CATDATA), &catdata) && catdata) {
        if (!read_msvc_string(AT(catdata, OFF_CATDATA_CLASS), out->cls, sizeof out->cls)) out->cls[0] = 0;
    }
    read_i32(AT(ch, OFF_CH_FACTION), &out->faction);
    read_i32(AT(ch, OFF_CH_MOVE), &out->move);
    read_i32(AT(ch, OFF_CH_ACT), &out->act);
    read_i32(AT(ch, OFF_CH_TURNKIND), &out->turnKind);
    /* GON at runtime (2026-10-22): the display-name key, current HP / shields and the seven stats Character::init stored */
    if (!read_msvc_string(AT(ch, OFF_CH_NAME_KEY), out->nameKey, sizeof out->nameKey)) out->nameKey[0] = 0;
    read_i32(AT(ch, OFF_CH_HP), &out->hp);
    read_i32(AT(ch, OFF_CH_SHIELD), &out->shield);
    read_i32(AT(ch, OFF_CH_DIVINE_SHIELD), &out->divineShield);
    if (!safe_read(AT(ch, OFF_CH_STATS), out->stats, sizeof out->stats)) memset(out->stats, 0, sizeof out->stats);
    void *ent = NULL;
    uint32_t cc = 0;
    void *comps = NULL;
    if (read_ptr(AT(ch, OFF_CH_ENTITY), &ent) && ent && read_u32(AT(ent, OFF_ENT_COMPCOUNT), &cc) && cc < 512 && read_ptr(AT(ent, OFF_ENT_COMPS), &comps) && comps) {
        for (uint32_t k = 0; k < cc && out->statusCount < MT_UNIT_STATUSES; k++) {
            void *comp = NULL;
            char removing = 0;
            if (!read_ptr(AT(comps, k * sizeof(void *)), &comp) || !comp) continue;
            if (!component_is_status(comp)) continue;
            if (safe_read(AT(comp, OFF_STATUS_REMOVING), &removing, 1) && removing) continue;
            if (component_type_name(comp, out->statuses[out->statusCount], MT_STATUS_NAME)) {
                int st = 0;
                read_i32(AT(comp, OFF_STATUS_STACKS), &st);   /* the same +0x5c status_engine.c writes */
                out->stacks[out->statusCount] = st;
                out->statusCount++;
            }
        }
    }
    return 1;
}
static int h_unit_has_status(void *u, int i, const char *status) {
    MtUnit info;
    if (!h_unit_info(u, i, &info)) return 0;
    for (int k = 0; k < info.statusCount; k++) if (!strcmp(info.statuses[k], status)) return 1;
    void *d[MAX_UNITS]; int n;
    if (char_array(d, &n) && i < n && d[i]) return g_fw.CharacterHasStatus(d[i], status); /* framework-registered statuses */
    return 0;
}
static void h_emit(void *u, const char *json) { (void)u; emit_locked(json); }
/* Called once by the runner after the end event (quit / eof / console_unavailable) and by the script-error path.
 * The result file is complete here, whatever happens to the process afterwards: close it first, in both modes. */
static void h_request_exit(void *u, int code) {
    (void)u;
    g_exitCode = code;
    g_endWritten = 1; /* a crash during the game's own shutdown must not append a second end record */
    logf_("script finished with code %d (%s exit)", code, g_args.clean ? "clean" : "immediate");
    EnterCriticalSection(&g_outLock);
    if (g_out != INVALID_HANDLE_VALUE) { FlushFileBuffers(g_out); CloseHandle(g_out); g_out = INVALID_HANDLE_VALUE; }
    LeaveCriticalSection(&g_outLock);
    if (g_args.clean) {
        /* clear the app's running flag so appmain returns and the game shuts itself down (complete debug.log);
         * the watchdog (mt_exit_decide) terminates the process MT_GRACE_CLEAN_MS later if it does not */
        void *appGlobal = (void *)g_fw.GetData(FW_DATA_App);
        void *app = NULL;
        int cleared = 0;
        if (appGlobal && read_ptr(appGlobal, &app) && app) { *(volatile char *)((char *)app + OFF_APP_RUNNING) = 0; cleared = 1; }
        logf_("clean exit: app=%p, running flag %s; watchdog exits %d in %d ms if the game does not",
              app, cleared ? "cleared" : "NOT cleared (no app pointer; exiting now instead)", code, MT_GRACE_CLEAN_MS);
        if (cleared) {
            DWORD t = GetTickCount();
            g_cleanExitTick = t ? t : 1; /* 0 means "not requested" */
            return;
        }
    }
    ExitProcess((UINT)code);
}

/* write one reply line to the pipe (adds the newline when the line has none); no-op without a client */
static void pipe_write_line(const char *line) {
    if (g_pipe == INVALID_HANDLE_VALUE) return;
    size_t n = strlen(line);
    DWORD written = 0;
    WriteFile(g_pipe, line, (DWORD)n, &written, NULL);
    if (!n || line[n - 1] != '\n') WriteFile(g_pipe, "\n", 1, &written, NULL);
    FlushFileBuffers(g_pipe);
}
static void h_pipe_reply(void *u, const char *json) { (void)u; pipe_write_line(json); }
/* expect gon: the walker (mt_gon.c) reads the game's GonObject nodes through the same guarded copy as everything
 * else here, and the unit's entry node is Character+OFF_CH_GON_ENTRY (the merged data/characters entry) */
static int h_mem_read(void *u, const void *addr, void *out, size_t n) { (void)u; return safe_read(addr, out, n); }
static const void *h_unit_gon(void *u, int i) {
    (void)u;
    void *d[MAX_UNITS]; int n;
    void *node = NULL;
    if (!char_array(d, &n) || i < 0 || i >= n || !d[i]) return NULL;
    if (!read_ptr(AT(d[i], OFF_CH_GON_ENTRY), &node)) return NULL;
    return node;
}

/* glow <unit> …: FW_SetUnitGlow / FW_ClearUnitGlow (framework API v4) on the Character* of the units walk */
static int h_set_unit_glow(void *u, int i, const float *rgba, char *detail, size_t cap) {
    (void)u;
    void *d[MAX_UNITS]; int n;
    if (!g_fw.SetUnitGlow || !g_fw.ClearUnitGlow) { snprintf(detail, cap, "framework older than API v4 (no FW_SetUnitGlow)"); return -1; }
    if (!char_array(d, &n) || i < 0 || i >= n || !d[i]) { snprintf(detail, cap, "unit %d is not in the units walk", i); return 0; }
    int ok = rgba ? g_fw.SetUnitGlow(d[i], rgba[0], rgba[1], rgba[2], rgba[3]) : g_fw.ClearUnitGlow(d[i]);
    snprintf(detail, cap, "%s on %p: %s", rgba ? "FW_SetUnitGlow" : "FW_ClearUnitGlow", d[i], ok ? "ok" : "refused (see mewframework.log)");
    return ok ? 1 : 0;
}

static const MtHost HOST = {
    NULL, h_console_ready, h_exec_cmd, h_console_count, h_console_line, h_turn_count, h_round_number, h_now_ms,
    h_units_available, h_unit_count, h_unit_info, h_unit_has_status, h_emit, h_request_exit, h_enter_scene, h_seed_rng,
    h_pipe_reply, h_set_unit_glow, h_mem_read, h_unit_gon,
};

/* the FrameBegin hook needs HOST, which is defined after it */
static void step_runner(void) {
    if (g_args.pipe) EnterCriticalSection(&g_pipeLock);
    mt_runner_step(&g_runner, &HOST);
    if (g_args.pipe) LeaveCriticalSection(&g_pipeLock);
}

/* one request line from the client: parse, queue, wait for the frame thread's reply, write it back */
static void handle_pipe_line(const char *line) {
    const char *p = line;
    while (*p == ' ' || *p == '\t' || *p == '\r') p++;
    if (!*p) return;
    long id = 0; MtQOp op; char text[MT_Q_TEXT]; int frames; char err[128]; char buf[MT_Q_REPLY];
    if (!mt_pipe_parse_request(p, &id, &op, text, sizeof text, &frames, err, sizeof err)) {
        mt_pipe_error_reply(buf, sizeof buf, id, err);
        pipe_write_line(buf);
        return;
    }
    EnterCriticalSection(&g_pipeLock);
    MtRequest *req = mt_queue_push(&g_queue, id, op, text, frames);
    LeaveCriticalSection(&g_pipeLock);
    if (!req) { mt_pipe_error_reply(buf, sizeof buf, id, "queue full"); pipe_write_line(buf); return; }
    DWORD t0 = GetTickCount();
    for (;;) {
        Sleep(5);
        EnterCriticalSection(&g_pipeLock);
        MtQState st = req->state;
        if (st == MT_Q_DONE) { snprintf(buf, sizeof buf, "%s", req->reply); mt_queue_release(req); }
        LeaveCriticalSection(&g_pipeLock);
        if (st == MT_Q_DONE) { pipe_write_line(buf); return; }
        if (st == MT_Q_FREE) return;                     /* the frame thread answered and released it itself (quit) */
        if (GetTickCount() - t0 > g_args.timeoutMs + 5000) {
            EnterCriticalSection(&g_pipeLock);
            if (req->state == MT_Q_PENDING) mt_queue_release(req);
            LeaveCriticalSection(&g_pipeLock);
            mt_pipe_error_reply(buf, sizeof buf, id, "request never served (the runner is not idle or waiting)");
            pipe_write_line(buf);
            return;
        }
    }
}

static DWORD WINAPI pipe_thread(LPVOID p) {
    (void)p;
    static char acc[MT_Q_TEXT + 512];
    for (;;) {
        if (!ConnectNamedPipe(g_pipe, NULL) && GetLastError() != ERROR_PIPE_CONNECTED) { Sleep(100); continue; }
        logf_("pipe: client connected on %s", g_pipeName);
        size_t used = 0;
        for (;;) {
            DWORD n = 0;
            if (!ReadFile(g_pipe, acc + used, (DWORD)(sizeof acc - used - 1), &n, NULL) || n == 0) break;
            used += n;
            acc[used] = 0;
            char *nl;
            while ((nl = (char *)memchr(acc, '\n', used)) != NULL) {
                *nl = 0;
                handle_pipe_line(acc);
                size_t rest = used - (size_t)(nl + 1 - acc);
                memmove(acc, nl + 1, rest);
                used = rest;
                acc[used] = 0;
            }
            if (used >= sizeof acc - 1) {
                char buf[256];
                mt_pipe_error_reply(buf, sizeof buf, 0, "request line too long");
                pipe_write_line(buf);
                used = 0;
            }
        }
        logf_("pipe: client disconnected");
        DisconnectNamedPipe(g_pipe);
    }
    return 0;
}

/* ----------------------------------------------------------------------- */
/* end-of-run paths: script error, timeout, crash                           */
/* ----------------------------------------------------------------------- */
static void write_end_once(int code, const char *reason) {
    if (InterlockedCompareExchange(&g_endWritten, 1, 0) != 0) return;
    char buf[512];
    MtJsonW w;
    mt_jw_begin(&w, buf, sizeof buf, "end");
    mt_jw_int(&w, "code", code);
    mt_jw_str(&w, "reason", reason);
    mt_jw_int(&w, "frames", g_runner.frame);
    mt_jw_int(&w, "turns", g_turns);
    mt_jw_int(&w, "elapsed_ms", t_ms());
    mt_jw_int(&w, "expect_pass", g_runner.expectPass);
    mt_jw_int(&w, "expect_fail", g_runner.expectFail);
    mt_jw_int(&w, "t", t_ms());
    mt_jw_int(&w, "frame", g_runner.frame);
    mt_jw_end(&w);
    write_raw(buf);
    g_runner.finished = 1;
}

static void write_script_error_and_end(void) {
    char buf[512];
    MtJsonW w;
    mt_jw_begin(&w, buf, sizeof buf, "script_error");
    mt_jw_int(&w, "line", g_scriptErrLine);
    mt_jw_str(&w, "msg", g_scriptErr);
    mt_jw_int(&w, "t", t_ms());
    mt_jw_int(&w, "frame", 0);
    mt_jw_end(&w);
    emit_locked(buf);
    EnterCriticalSection(&g_outLock);
    write_end_once(4, "script_error");
    LeaveCriticalSection(&g_outLock);
    g_active = 0;
    h_request_exit(NULL, 4);
}

static void write_crash_event(const EXCEPTION_RECORD *er, DWORD tid) {
    char buf[512], modName[MAX_PATH] = "?";
    HMODULE mod = NULL;
    uintptr_t addr = (uintptr_t)er->ExceptionAddress, rva = 0;
    if (GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, (LPCSTR)addr, &mod) && mod) {
        char full[MAX_PATH];
        if (GetModuleFileNameA(mod, full, sizeof full)) {
            const char *base = strrchr(full, '\\');
            snprintf(modName, sizeof modName, "%s", base ? base + 1 : full);
        }
        rva = addr - (uintptr_t)mod;
    }
    MtJsonW w;
    mt_jw_begin(&w, buf, sizeof buf, "crash");
    mt_jw_hex(&w, "code", er->ExceptionCode);
    mt_jw_hex(&w, "flags", er->ExceptionFlags);
    mt_jw_hex(&w, "addr", addr);
    mt_jw_str(&w, "module", modName);
    mt_jw_hex(&w, "rva", rva);
    mt_jw_int(&w, "tid", tid);
    mt_jw_int(&w, "t", t_ms());
    mt_jw_int(&w, "frame", g_runner.frame);
    mt_jw_end(&w);
    write_raw(buf);
}

static int is_fatal_code(DWORD code, DWORD flags) {
    switch (code) {
        case EXCEPTION_ACCESS_VIOLATION: case EXCEPTION_ILLEGAL_INSTRUCTION: case EXCEPTION_PRIV_INSTRUCTION:
        case EXCEPTION_STACK_OVERFLOW: case EXCEPTION_IN_PAGE_ERROR: case EXCEPTION_ARRAY_BOUNDS_EXCEEDED:
            return 1;
        case 0xE06D7363: case 0x406D1388: case EXCEPTION_BREAKPOINT: case EXCEPTION_SINGLE_STEP: case 0x40010006: case 0x4001000A:
            return 0;
        default:
            return (flags & EXCEPTION_NONCONTINUABLE) != 0;
    }
}

static LONG CALLBACK veh(EXCEPTION_POINTERS *ep) {
    if (!g_active || !ep || !ep->ExceptionRecord) return EXCEPTION_CONTINUE_SEARCH;
    const EXCEPTION_RECORD *er = ep->ExceptionRecord;
    if (!is_fatal_code(er->ExceptionCode, er->ExceptionFlags)) return EXCEPTION_CONTINUE_SEARCH;
    if (InterlockedCompareExchange(&g_crashed, 1, 0) != 0) return EXCEPTION_CONTINUE_SEARCH;
    g_crashTick = GetTickCount();
    /* best effort: do not block on the lock from a crashing thread */
    int locked = TryEnterCriticalSection(&g_outLock);
    write_crash_event(er, GetCurrentThreadId());
    write_end_once(3, "crash");
    if (locked) LeaveCriticalSection(&g_outLock);
    g_exitCode = 3;
    return EXCEPTION_CONTINUE_SEARCH; /* let Mewjector's handler write its report/dump */
}

static LONG WINAPI top_filter(EXCEPTION_POINTERS *ep) {
    if (g_active && ep && ep->ExceptionRecord && InterlockedCompareExchange(&g_crashed, 1, 0) == 0) {
        g_crashTick = GetTickCount();
        write_crash_event(ep->ExceptionRecord, GetCurrentThreadId());
        write_end_once(3, "crash");
    }
    if (g_prevFilter) g_prevFilter(ep); /* Mewjector's report + minidump */
    if (g_active) { if (g_out != INVALID_HANDLE_VALUE) FlushFileBuffers(g_out); ExitProcess(3); }
    return EXCEPTION_CONTINUE_SEARCH;
}

/* Leave from the watchdog thread without running atexit/DLL-detach code: ExitProcess from a helper thread can
 * block on the loader lock while the main thread is mid-shutdown, which is one way a "clean" exit never ends. */
static __attribute__((noreturn)) void exit_now(int code) {
    if (g_out != INVALID_HANDLE_VALUE) FlushFileBuffers(g_out);
    if (g_log) fflush(g_log);
    TerminateProcess(GetCurrentProcess(), (UINT)code);
    ExitProcess((UINT)code); /* only if TerminateProcess somehow returned */
}

/* A modal message box on the game's main thread (its own WARNING popup, e.g. "no saved winning teams - win at least
 * one run first!" from MewDirector::DebugGenAdventureCats) stops the frame loop for as long as nobody clicks OK —
 * with a hidden window, forever. The watchdog closes every visible dialog-class window of this process and records
 * it as a `popup` event (title + text), so a run reports the message instead of hanging on it. */
static BOOL CALLBACK popup_text_enum(HWND child, LPARAM lp) {
    char cls[32] = "";
    GetClassNameA(child, cls, sizeof cls);
    if (strcmp(cls, "Static") != 0) return TRUE;
    char *out = (char *)lp;
    if (out[0]) return TRUE;                                 /* first non-empty Static wins (the icon is a Static too) */
    GetWindowTextA(child, out, 512);
    return TRUE;
}
static BOOL CALLBACK popup_enum(HWND h, LPARAM lp) {
    DWORD pid = 0;
    GetWindowThreadProcessId(h, &pid);
    if (pid != GetCurrentProcessId() || !IsWindowVisible(h)) return TRUE;
    char cls[32] = "", title[128] = "", text[512] = "";
    GetClassNameA(h, cls, sizeof cls);
    if (strcmp(cls, "#32770") != 0) return TRUE;           /* the dialog class MessageBox uses */
    GetWindowTextA(h, title, sizeof title);
    EnumChildWindows(h, popup_text_enum, (LPARAM)text);     /* the message is the dialog's text Static */
    char buf[1024];
    MtJsonW w;
    mt_jw_begin(&w, buf, sizeof buf, "popup");
    mt_jw_str(&w, "title", title);
    mt_jw_str(&w, "text", text);
    mt_jw_int(&w, "t", t_ms());
    mt_jw_int(&w, "frame", g_runner.frame);
    mt_jw_end(&w);
    emit_locked(buf);
    logf_("popup dismissed: [%s] %s", title, text);
    PostMessageA(h, WM_CLOSE, 0, 0);
    (*(int *)lp)++;
    return TRUE;
}
static void dismiss_popups(void) { int n = 0; EnumWindows(popup_enum, (LPARAM)&n); }

static DWORD WINAPI watchdog(LPVOID p) {
    (void)p;
    for (;;) {
        Sleep(250);
        if (g_active) dismiss_popups();
        MtExitState s;
        s.crashed = g_crashed != 0;             s.crashTick = g_crashTick;
        s.cleanRequested = g_cleanExitTick != 0; s.cleanTick = g_cleanExitTick;
        s.exitCode = g_exitCode;                s.runnerFinished = g_runner.finished;
        s.startTick = g_startTick;              s.timeoutMs = g_args.timeoutMs;
        s.fired = g_exitFired != 0;
        int code = 0;
        MtExitAction act = mt_exit_decide(&s, GetTickCount(), &code);
        if (act == MT_X_NONE) continue;
        if (InterlockedCompareExchange(&g_exitFired, 1, 0) != 0) continue;
        if (act == MT_X_EXIT_CRASH) { logf_("crash grace elapsed; exiting %d", code); exit_now(code); }
        if (act == MT_X_EXIT_CLEAN) { logf_("clean exit grace elapsed (the game did not shut down within %d ms); exiting %d", MT_GRACE_CLEAN_MS, code); exit_now(code); }
        /* MT_X_TIMEOUT */
        if (TryEnterCriticalSection(&g_runLock)) {
            EnterCriticalSection(&g_outLock);
            if (!g_runner.finished) { mt_runner_abort(&g_runner, &HOST, 2, "timeout"); g_endWritten = 1; }
            LeaveCriticalSection(&g_outLock);
            LeaveCriticalSection(&g_runLock);
        } else {
            EnterCriticalSection(&g_outLock);
            write_end_once(2, "timeout");
            LeaveCriticalSection(&g_outLock);
        }
        logf_("timeout after %u ms; exiting 2", g_args.timeoutMs);
        exit_now(2);
    }
    /* not reached: the loop only leaves through exit_now */
    return 0;
}

/* ----------------------------------------------------------------------- */
/* init                                                                     */
/* ----------------------------------------------------------------------- */
static int read_file(const char *path, char **out, size_t *len) {
    HANDLE h = CreateFileA(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
    if (h == INVALID_HANDLE_VALUE) return 0;
    LARGE_INTEGER sz;
    if (!GetFileSizeEx(h, &sz) || sz.QuadPart > 1024 * 1024) { CloseHandle(h); return 0; }
    char *buf = (char *)HeapAlloc(GetProcessHeap(), 0, (size_t)sz.QuadPart + 1);
    DWORD n = 0;
    if (!buf || !ReadFile(h, buf, (DWORD)sz.QuadPart, &n, NULL)) { CloseHandle(h); return 0; }
    CloseHandle(h);
    buf[n] = 0;
    *out = buf; *len = n;
    return 1;
}

static int install_hook(int sym, void *fn, void **tramp, int prio, const char *name) {
    uintptr_t addr = g_fw.GetSymbol(sym);
    if (!addr) { logf_("symbol %s unavailable", name); return 0; }
    UINT_PTR rva = (UINT_PTR)(addr - g_mj.GetGameBase());
    if (!g_mj.InstallHook(rva, 0, fn, tramp, prio, MOD_OWNER)) { logf_("MJ_InstallHook failed for %s (rva 0x%llx)", name, (unsigned long long)rva); return 0; }
    logf_("hook installed: %s rva 0x%llx prio %d", name, (unsigned long long)rva, prio);
    return 1;
}

static void write_start_event(const char *build) {
    char buf[1200];
    MtJsonW w;
    mt_jw_begin(&w, buf, sizeof buf, "start");
    mt_jw_str(&w, "harness", MT_VERSION);
    mt_jw_str(&w, "build", build ? build : "unknown");
    mt_jw_str(&w, "script", g_args.script);
    mt_jw_str(&w, "out", g_args.out);
    mt_jw_int(&w, "pid", (long long)GetCurrentProcessId());
    mt_jw_int(&w, "hide", g_args.hide);
    mt_jw_int(&w, "timeout_ms", g_args.timeoutMs);
    mt_jw_int(&w, "clean", g_args.clean);
    if (g_args.pipe) mt_jw_str(&w, "pipe", g_pipeName);
    mt_jw_int(&w, "t", 0);
    mt_jw_int(&w, "frame", 0);
    mt_jw_end(&w);
    emit_locked(buf);
}

/* The framework is missing or inactive (unknown build, failed signature): still leave a result file
 * (start + end{code 4, reason}) so the runner can name the cause instead of waiting for its backstop,
 * then exit 4 from a helper thread once DllMain has returned (never ExitProcess under the loader lock). */
static DWORD WINAPI inactive_exit_thread(LPVOID p) { (void)p; Sleep(1500); ExitProcess(4); return 0; }
static void inactive_exit(const char *reason) {
    g_out = CreateFileA(g_args.out, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (g_out == INVALID_HANDLE_VALUE) {
        logf_("cannot create result file %s (err %lu)", g_args.out, GetLastError());
    } else {
        write_start_event(g_fw.GetBuildName ? g_fw.GetBuildName() : "unknown");
        EnterCriticalSection(&g_outLock);
        write_end_once(4, reason);
        FlushFileBuffers(g_out);
        CloseHandle(g_out);
        g_out = INVALID_HANDLE_VALUE;
        LeaveCriticalSection(&g_outLock);
    }
    logf_("%s: result written with code 4; exiting in 1.5 s", reason);
    CreateThread(NULL, 0, inactive_exit_thread, NULL, 0, NULL);
}

static void init(void) {
    g_startTick = GetTickCount();
    InitializeCriticalSection(&g_outLock);
    InitializeCriticalSection(&g_runLock);
    g_log = fopen("mod_logs\\mewtest.log", "a");
    g_mjOk = MJ_Require(MOD_OWNER) && MJ_Resolve(&g_mj);
    logf_("%s starting; mewjector=%s", MT_VERSION, g_mjOk ? "yes" : "no");

    /* command line first: stay inert cheaply */
    {
        const wchar_t *wcl = GetCommandLineW();
        char cl[8192];
        int n = WideCharToMultiByte(CP_UTF8, 0, wcl, -1, cl, sizeof cl, NULL, NULL);
        if (n <= 0) { logf_("cannot read the command line; inert"); return; }
        int present = mt_args_parse(cl, &g_args);
        if (g_args.err[0]) { logf_("bad -mewtest arguments: %s; inert", g_args.err); return; }
        if (!present) { logf_("no -mewtest on the command line; inert"); return; }
        if (!g_args.hasSaveSuffix) { logf_("-mewtest without -savesuffix; refusing to run against the real save; inert"); return; }
    }
    if (!FW_Resolve(&g_fw)) { logf_("mewframework.dll not loaded or older than API v%d; inert", FW_API_VERSION); inactive_exit("framework_missing"); return; }
    if (!g_fw.IsActive()) { logf_("framework inactive (unknown build or a signature failed); inert"); inactive_exit("framework_inactive"); return; }
    if (!g_mjOk) { logf_("Mewjector API unavailable; inert"); return; }

    g_base = (uintptr_t)GetModuleHandleW(NULL);
    {
        const IMAGE_DOS_HEADER *dos = (const IMAGE_DOS_HEADER *)g_base;
        const IMAGE_NT_HEADERS64 *nt = (const IMAGE_NT_HEADERS64 *)(g_base + dos->e_lfanew);
        g_imageEnd = g_base + nt->OptionalHeader.SizeOfImage;
    }
    {
        HMODULE fw = GetModuleHandleA("mewframework.dll");
        if (fw) {
            const IMAGE_DOS_HEADER *dos = (const IMAGE_DOS_HEADER *)fw;
            const IMAGE_NT_HEADERS64 *nt = (const IMAGE_NT_HEADERS64 *)((const char *)fw + dos->e_lfanew);
            g_fwBase = (uintptr_t)fw;
            g_fwEnd = g_fwBase + nt->OptionalHeader.SizeOfImage;
        }
    }
    g_Execute = (fn_Execute)g_fw.GetSymbol(FW_SYM_DebugConsole_Execute);
    g_Allocate = (fn_Allocate)g_fw.GetSymbol(FW_SYM_string_Allocate);
    g_Tidy = (fn_TidyDeallocate)g_fw.GetSymbol(FW_SYM_string_TidyDeallocate);
    if (!g_Execute || !g_Allocate || !g_Tidy) { logf_("required symbols missing; inert"); return; }
    /* v4 run-entry symbols: optional (an older framework returns 0 for an enum it does not know; `enter` then
     * reports enter_unavailable instead of the harness going inert) */
    g_CreateScene = (fn_CreateScene)g_fw.GetSymbol(FW_SYM_SceneManager_CreateScene);
    g_CreateEntity = (fn_CreateEntity)g_fw.GetSymbol(FW_SYM_Scene_CreateEntity);
    g_AddTacticsTest = (fn_AddTacticsTest)g_fw.GetSymbol(FW_SYM_AddComponent_TacticsTest);
    g_DestroyOwnerOf = (fn_DestroyOwnerOf)g_fw.GetSymbol(FW_SYM_Entity_DestroyOwnerOf);
    g_AddDirectorNamed = (fn_AddDirectorNamed)g_fw.GetSymbol(FW_SYM_AddComponent_MewDirector_named);
    g_DirectorStart = (fn_DirectorStart)g_fw.GetSymbol(FW_SYM_MewDirector_start);
    g_SavePropGet = (fn_SavePropGet)g_fw.GetSymbol(FW_SYM_SaveProps_GetOrCreate);
    g_AddDirectorTest = (fn_AddDirectorTest)g_fw.GetSymbol(FW_SYM_AddComponent_MewDirector_test);
    g_GetGame = (fn_GetGame)g_fw.GetSymbol(FW_SYM_Component_GetGame);
    g_RngSeedState = (fn_RngSeedState)g_fw.GetSymbol(FW_SYM_Rng_SeedState);
    logf_("run-entry symbols: CreateScene=%p CreateEntity=%p AddComponent<TacticsTest>=%p GetGame=%p AddComponent<MewDirector>(test, reference)=%p",
          (void *)g_CreateScene, (void *)g_CreateEntity, (void *)g_AddTacticsTest, (void *)g_GetGame, (void *)g_AddDirectorTest);
    for (int i = 0; i < FW_DATA_COUNT_; i++) {
        void **slot = (void **)g_fw.GetData(i);
        g_sdlInitial[i] = NULL;
        if (slot && i != FW_DATA_App) read_ptr(slot, &g_sdlInitial[i]); /* DllMain runs before SDL init: these are the stubs */
    }

    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);

    /* script + result file */
    {
        char *text = NULL; size_t len = 0;
        if (!read_file(g_args.script, &text, &len)) {
            g_scriptOk = 0;
            snprintf(g_scriptErr, sizeof g_scriptErr, "cannot read script %s", g_args.script);
            g_scriptErrLine = 0;
        } else {
            g_scriptOk = mt_script_parse(text, len, &g_script, g_scriptErr, sizeof g_scriptErr, &g_scriptErrLine);
            HeapFree(GetProcessHeap(), 0, text);
        }
        g_out = CreateFileA(g_args.out, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
        if (g_out == INVALID_HANDLE_VALUE) { logf_("cannot create result file %s (err %lu); inert", g_args.out, GetLastError()); return; }
    }
    mt_runner_init(&g_runner, &g_script, (uint64_t)GetTickCount64());
    if (g_args.pipe) {
        snprintf(g_pipeName, sizeof g_pipeName, "\\\\.\\pipe\\mewtest-%lu", (unsigned long)GetCurrentProcessId());
        g_pipe = CreateNamedPipeA(g_pipeName, PIPE_ACCESS_DUPLEX, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT, 1, 65536, 65536, 0, NULL);
        if (g_pipe == INVALID_HANDLE_VALUE) { logf_("cannot create the pipe %s (err %lu); interactive mode off", g_pipeName, GetLastError()); g_args.pipe = 0; }
        else {
            InitializeCriticalSection(&g_pipeLock);
            mt_queue_init(&g_queue);
            mt_runner_set_interactive(&g_runner, 1);
            mt_runner_attach_queue(&g_runner, &g_queue);
            CreateThread(NULL, 0, pipe_thread, NULL, 0, NULL);
            logf_("interactive mode: pipe %s (idle at end of script until a quit request)", g_pipeName);
        }
    }

    if (!install_hook(FW_SYM_DebugConsole_init, (void *)hook_DCInit, (void **)&g_origDCInit, 50, "DebugConsole::init")) return;
    if (!install_hook(FW_SYM_ApplicationBase_FrameBegin, (void *)hook_FrameBegin, (void **)&g_origFrameBegin, 50, "ApplicationBase::FrameBegin")) return;
    if (!install_hook(FW_SYM_TurnControl_NextTurn, (void *)hook_NextTurn, (void **)&g_origNextTurn, 110, "TurnControl::NextTurn")) return;
    install_hook(FW_SYM_MewDirector_init, (void *)hook_DirectorInit, (void **)&g_origDirectorInit, 120, "MewDirector::init (diagnostic)"); /* optional */

    AddVectoredExceptionHandler(1, veh);
    g_prevFilter = SetUnhandledExceptionFilter(top_filter);
    CreateThread(NULL, 0, watchdog, NULL, 0, NULL);

    write_start_event(g_fw.GetBuildName());
    g_active = 1;
    logf_("active: script %s (%d directive(s), parse %s), out %s, hide %d, timeout %u ms, clean %d",
          g_args.script, g_script.count, g_scriptOk ? "ok" : "FAILED", g_args.out, g_args.hide, g_args.timeoutMs, g_args.clean);
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved) {
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(inst);
        init();
    } else if (reason == DLL_PROCESS_DETACH) {
        if (g_log) fclose(g_log);
    }
    return TRUE;
}
