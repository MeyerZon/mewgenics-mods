/* Public C API of mewframework.dll.
 *
 * Mod DLLs call FW_Resolve() (static inline below) to fetch the function table from the already
 * loaded mewframework.dll, so no import library is needed and a missing framework fails gracefully.
 * The framework itself exports the FW_* functions declared under FW_BUILDING. */
#pragma once
#include <stdint.h>
#include <windows.h>

#define FW_OWNER "mewframework"
#define FW_VERSION_MAJOR 0
#define FW_VERSION_MINOR 2
#define FW_VERSION_PATCH 0
#define FW_API_VERSION 2   /* bumped when functions are added; existing signatures never change */

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

typedef int (*FW_fn_GetVersion)(void);
typedef int (*FW_fn_IsActive)(void);
typedef uintptr_t (*FW_fn_GetSymbol)(int);
typedef const char *(*FW_fn_GetBuildName)(void);
typedef int (*FW_fn_RegisterStatus)(const FwStatusDef *);
typedef int (*FW_fn_SetStatusStacks)(void *, int);
typedef int (*FW_fn_CharacterHasStatus)(void *, const char *);

typedef struct FwApi {
    FW_fn_GetVersion GetVersion;
    FW_fn_IsActive IsActive;
    FW_fn_GetSymbol GetSymbol;
    FW_fn_GetBuildName GetBuildName;
    FW_fn_RegisterStatus RegisterStatus;
    FW_fn_SetStatusStacks SetStatusStacks;
    FW_fn_CharacterHasStatus CharacterHasStatus;
} FwApi;

/* Resolve the framework's exports from the loaded module. Returns 1 when every function of
 * FW_API_VERSION is available, 0 when the framework is absent or older. */
static inline int FW_Resolve(FwApi *api) {
    HMODULE h = GetModuleHandleA("mewframework.dll");
    if (!h || !api) return 0;
#define FW__R(field) api->field = (FW_fn_##field)(void *)GetProcAddress(h, "FW_" #field); if (!api->field) return 0;
    FW__R(GetVersion)
    if (api->GetVersion() < FW_API_VERSION) return 0;
    FW__R(IsActive) FW__R(GetSymbol) FW__R(GetBuildName)
    FW__R(RegisterStatus) FW__R(SetStatusStacks) FW__R(CharacterHasStatus)
#undef FW__R
    return 1;
}

#ifdef __cplusplus
}
#endif
