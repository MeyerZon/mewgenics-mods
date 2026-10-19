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
#define MT_GRACE_CLEAN_MS 3000
#define MT_GRACE_CRASH_MS 5000

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
static int g_active;
static DWORD g_startTick;
static uintptr_t g_base, g_imageEnd;

static fn_Execute g_Execute;
static fn_Allocate g_Allocate;
static fn_TidyDeallocate g_Tidy;
static fn_DCInit g_origDCInit;
static fn_FrameBegin g_origFrameBegin;
static fn_NextTurn g_origNextTurn;

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
static int code_ptr_ok(const void *p) { return (uintptr_t)p >= g_base && (uintptr_t)p < g_imageEnd; }

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
            if (component_type_name(comp, out->statuses[out->statusCount], MT_STATUS_NAME)) out->statusCount++;
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
static void h_request_exit(void *u, int code) {
    (void)u;
    g_exitCode = code;
    logf_("script finished with code %d (%s exit)", code, g_args.clean ? "clean" : "immediate");
    if (g_args.clean) {
        void *appGlobal = (void *)g_fw.GetData(FW_DATA_App);
        void *app = NULL;
        if (appGlobal && read_ptr(appGlobal, &app) && app) *(volatile char *)((char *)app + OFF_APP_RUNNING) = 0;
        g_cleanExitTick = GetTickCount();
        return;
    }
    EnterCriticalSection(&g_outLock);
    if (g_out != INVALID_HANDLE_VALUE) { FlushFileBuffers(g_out); CloseHandle(g_out); g_out = INVALID_HANDLE_VALUE; }
    LeaveCriticalSection(&g_outLock);
    ExitProcess((UINT)code);
}

static const MtHost HOST = {
    NULL, h_console_ready, h_exec_cmd, h_console_count, h_console_line, h_turn_count, h_round_number, h_now_ms,
    h_units_available, h_unit_count, h_unit_info, h_unit_has_status, h_emit, h_request_exit,
};

/* the FrameBegin hook needs HOST, which is defined after it */
static void step_runner(void) { mt_runner_step(&g_runner, &HOST); }

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

static DWORD WINAPI watchdog(LPVOID p) {
    (void)p;
    for (;;) {
        Sleep(250);
        if (!g_active) continue;
        DWORD now = GetTickCount();
        if (g_crashed && now - g_crashTick > MT_GRACE_CRASH_MS) { logf_("crash grace elapsed; exiting 3"); ExitProcess(3); }
        if (g_cleanExitTick && now - g_cleanExitTick > MT_GRACE_CLEAN_MS) { logf_("clean exit grace elapsed; exiting %d", g_exitCode); ExitProcess((UINT)(g_exitCode < 0 ? 4 : g_exitCode)); }
        if (!g_runner.finished && !g_cleanExitTick && now - g_startTick > g_args.timeoutMs) {
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
            if (g_out != INVALID_HANDLE_VALUE) FlushFileBuffers(g_out);
            ExitProcess(2);
        }
    }
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
    g_Execute = (fn_Execute)g_fw.GetSymbol(FW_SYM_DebugConsole_Execute);
    g_Allocate = (fn_Allocate)g_fw.GetSymbol(FW_SYM_string_Allocate);
    g_Tidy = (fn_TidyDeallocate)g_fw.GetSymbol(FW_SYM_string_TidyDeallocate);
    if (!g_Execute || !g_Allocate || !g_Tidy) { logf_("required symbols missing; inert"); return; }
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

    if (!install_hook(FW_SYM_DebugConsole_init, (void *)hook_DCInit, (void **)&g_origDCInit, 50, "DebugConsole::init")) return;
    if (!install_hook(FW_SYM_ApplicationBase_FrameBegin, (void *)hook_FrameBegin, (void **)&g_origFrameBegin, 50, "ApplicationBase::FrameBegin")) return;
    if (!install_hook(FW_SYM_TurnControl_NextTurn, (void *)hook_NextTurn, (void **)&g_origNextTurn, 110, "TurnControl::NextTurn")) return;

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
