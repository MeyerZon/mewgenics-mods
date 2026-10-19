/* Public C API of mewframework.dll.
 *
 * Mod DLLs call FW_Resolve() (static inline below) to fetch the function table from the already
 * loaded mewframework.dll, so no import library is needed and a missing framework fails gracefully.
 * The framework itself exports the FW_* functions declared under FW_BUILDING. */
#pragma once
#include <stdint.h>
#ifndef FW_NO_WINDOWS
#include <windows.h>
#endif

#define FW_OWNER "mewframework"
#define FW_VERSION_MAJOR 0
#define FW_VERSION_MINOR 3
#define FW_VERSION_PATCH 0
#define FW_API_VERSION 3   /* bumped when functions are added; existing signatures never change */

/* Code symbols located by byte signature (see signatures.h). APPEND ONLY: mods compiled against an
 * older header keep working because the existing values never move. */
typedef enum FwSymbol {
    /* v1/v2 */
    FW_SYM_TurnControl_NextTurn,
    FW_SYM_Character_BeginTurn,
    FW_SYM_Ability_trigger,
    FW_SYM_FileManager_GetFile,
    FW_SYM_FileManager_ResolveWithOverlays,
    FW_SYM_Status_ApplyByName,
    FW_SYM_Status_GetCategory,
    FW_SYM_Status_GetFlags,
    FW_SYM_LuckUp_ctor,
    FW_SYM_Status_Remove,
    FW_SYM_string_TidyDeallocate,
    /* v3: debug console + application loop (test harness) */
    FW_SYM_DebugConsole_Execute,        /* void (DebugConsole* this, std::string* line) — by-value string, callee destroys */
    FW_SYM_DebugConsole_init,           /* void (DebugConsole* this, std::string name); rcx = the console instance */
    FW_SYM_ApplicationBase_FrameBegin,  /* void (ApplicationBase*) — once per frame on the main thread */
    FW_SYM_string_Allocate,             /* void* std::_Allocate<16>(size_t bytes) — pairs with string_TidyDeallocate */
    FW_SYMBOL_COUNT_
} FwSymbol;

/* Data addresses that cannot be pattern-scanned (globals, SDL3 DYNAPI slots). Per build. APPEND ONLY.
 * SDL slots hold init stubs until SDL initializes; read them only after the window exists. */
typedef enum FwData {
    FW_DATA_App,                               /* ApplicationBase* global; +0x10 running flag, +0xdd0 SDL_Window* */
    FW_DATA_SDL_GL_SetSwapInterval,            /* DYNAPI slot: int (*)(int) */
    FW_DATA_SDL_GL_SwapWindow,                 /* DYNAPI slot: bool (*)(SDL_Window*) */
    FW_DATA_SDL_HideWindow,                    /* DYNAPI slot: bool (*)(SDL_Window*) */
    FW_DATA_SDL_ShowWindow,
    FW_DATA_SDL_MinimizeWindow,
    FW_DATA_SDL_PollEvent,
    FW_DATA_SDL_CreateWindow,
    FW_DATA_SDL_CreateWindowWithProperties,
    FW_DATA_COUNT_
} FwData;

/* Status categories, mirroring the game's registry field the template is cloned from. */
typedef enum FwStatusCategory {
    FW_STATUS_KEEP_TEMPLATE = -1, /* leave whatever the template status has */
    FW_STATUS_DEBUFF = 0,
    FW_STATUS_BUFF = 1,
} FwStatusCategory;

/* Callbacks receive the game's Character* and the Status* instance (opaque). */
typedef void (*FwStatusTurnCallback)(void *character, void *status, void *user);

typedef struct FwStatusDef {
    const char *name;              /* new status name as referenced from GON (e.g. "JokersLuck") */
    const char *template_name;     /* vanilla status to clone registry entry and vtable from */
    int category;                  /* FwStatusCategory */
    FwStatusTurnCallback on_turn_begin; /* fired at the start of the carrier's turn, may be NULL */
    FwStatusTurnCallback on_turn_end;   /* fired at the end of the carrier's turn, may be NULL */
    void *user;
} FwStatusDef;

#ifdef FW_BUILDING
#define FW_EXPORT __declspec(dllexport)
#else
#define FW_EXPORT
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* --- API v1 --- */
FW_EXPORT int FW_GetVersion(void);
FW_EXPORT int FW_IsActive(void);             /* 1 only when -savesuffix launch + known build + all signatures */
FW_EXPORT uintptr_t FW_GetSymbol(int symbol); /* absolute address of a FwSymbol, 0 if inactive */
FW_EXPORT const char *FW_GetBuildName(void);
/* --- API v2: custom statuses --- */
FW_EXPORT int FW_RegisterStatus(const FwStatusDef *def);       /* 1 on success */
FW_EXPORT int FW_SetStatusStacks(void *status, int value);       /* set a custom status instance's stacks; 0 removes it */
FW_EXPORT int FW_CharacterHasStatus(void *character, const char *statusName);
/* --- API v3: data addresses --- */
FW_EXPORT uintptr_t FW_GetData(int dataId);   /* absolute address of a FwData entry, 0 if inactive/unknown */

typedef int (*FW_fn_GetVersion)(void);
typedef int (*FW_fn_IsActive)(void);
typedef uintptr_t (*FW_fn_GetSymbol)(int);
typedef const char *(*FW_fn_GetBuildName)(void);
typedef int (*FW_fn_RegisterStatus)(const FwStatusDef *);
typedef int (*FW_fn_SetStatusStacks)(void *, int);
typedef int (*FW_fn_CharacterHasStatus)(void *, const char *);
typedef uintptr_t (*FW_fn_GetData)(int);

typedef struct FwApi {
    FW_fn_GetVersion GetVersion;
    FW_fn_IsActive IsActive;
    FW_fn_GetSymbol GetSymbol;
    FW_fn_GetBuildName GetBuildName;
    FW_fn_RegisterStatus RegisterStatus;
    FW_fn_SetStatusStacks SetStatusStacks;
    FW_fn_CharacterHasStatus CharacterHasStatus;
    FW_fn_GetData GetData;            /* v3; always the last field so older layouts stay valid prefixes */
} FwApi;

/* Resolve the framework's exports from the loaded module. Returns 1 when every function of
 * FW_API_VERSION is available, 0 when the framework is absent or older. */
#ifndef FW_NO_WINDOWS
static inline int FW_Resolve(FwApi *api) {
    HMODULE h = GetModuleHandleA("mewframework.dll");
    if (!h || !api) return 0;
#define FW__R(field) api->field = (FW_fn_##field)(void *)GetProcAddress(h, "FW_" #field); if (!api->field) return 0;
    FW__R(GetVersion)
    if (api->GetVersion() < FW_API_VERSION) return 0;
    FW__R(IsActive) FW__R(GetSymbol) FW__R(GetBuildName)
    FW__R(RegisterStatus) FW__R(SetStatusStacks) FW__R(CharacterHasStatus)
    FW__R(GetData)
#undef FW__R
    return 1;
}
#endif /* FW_NO_WINDOWS */

#ifdef __cplusplus
}
#endif
