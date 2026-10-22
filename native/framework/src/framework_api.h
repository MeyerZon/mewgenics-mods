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
#define FW_VERSION_MINOR 4
#define FW_VERSION_PATCH 0
#define FW_API_VERSION 4   /* bumped when functions are added; existing signatures never change */

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
    /* v4: run entry through the dev menu's scene drivers (test harness `enter`) */
    FW_SYM_SceneManager_CreateScene,    /* Scene* (SceneManager*, std::string* name) — by-value string, callee destroys */
    FW_SYM_Scene_CreateEntity,          /* Entity* (Scene*) — NULL while the scene is being destroyed */
    FW_SYM_AddComponent_TacticsTest,    /* TacticsTest* (Scene*, Entity*) — AddComponent<TacticsTest> + TacticsTest::init */
    FW_SYM_Component_GetGame,           /* MewGame* (Component*) */
    FW_SYM_TacticsTest_init,            /* reference only: registers the run console commands (bind, load, win, …) */
    FW_SYM_MewDirector_init,            /* reference only: void (MewDirector*, std::string name) — opens/creates that save */
    FW_SYM_AddComponent_MewDirector_test, /* MewDirector* (Scene*, Entity*) — the test director on test00.sav, as the load path makes it */
    FW_SYM_Rng_SeedState,               /* uint64_t* (uint64_t out[4], uint64_t seed) — expands a seed into the 32-byte RNG state */
    FW_SYM_Rng_Reseed,                  /* reference only: void (uint64_t state[4]) — the game's time-based reseed */
    FW_SYM_Entity_DestroyOwnerOf,       /* void (Component*) — destroys the component's entity (what the save-slot click does to the old director) */
    FW_SYM_AddComponent_MewDirector_named, /* MewDirector* (Scene*, Entity*, std::string* saveName) — caller keeps the string */
    FW_SYM_MewDirector_start,           /* void (MewDirector*) — new game / resume from the save's properties */
    FW_SYM_SaveProps_GetOrCreate,       /* Node** (PropMap* map, Node** out, std::string* key) — the save's property node (value at +0x30), created when absent */
    /* API v4: per-unit glow (glow_engine.c rides the combat outline mask; docs/engine-map.md "Per-unit glow") */
    FW_SYM_TacticsTest_LateRender,      /* void (TacticsTest*) — vftable slot 19, hooked; the plan runs after the original */
    FW_SYM_vec_u32_AddUnique,           /* bool (vec_u32* {cap,count,data}, const uint32_t*) — push_back unless present */
    FW_SYM_ShaderManager_GetOrCreateMaterial, /* Material* (ShaderManager*, std::string name, std::string shaderFile) — by-value strings, callee destroys */
    FW_SYM_Material_SetUniformVec4,     /* void (Material*, std::string name, float x, float y, float z, float w) — callee destroys name */
    FW_SYM_Material_SetUniformFloat,    /* void (Material*, std::string name, float v) — callee destroys name */
    FW_SYM_Material_SetTexture,         /* void (Material*, std::string name, Texture*, int slot) — callee destroys name */
    FW_SYM_Camera_AddPostProcessPass,   /* Pass* (Camera*, Material*, int layer) — owned by the camera; never cache the Pass* */
    /* glow v2: a unit's screen rect, as TacticsTest::LateRender computes the hovered unit's (per-unit colours) */
    FW_SYM_Renderer_GetScreenMatrix,    /* float* (Renderer*, float out[16]) — the renderer's world-to-canvas matrix */
    FW_SYM_Position_GetViewMatrix,      /* float* (Position*, float out[16], double interp) — a camera's view matrix (LateRender inverts it) */
    /* the 3D block (docs/possible_3d_work.md): the phase-0 observer's hook, and the view-projection a perspective camera replaces */
    FW_SYM_Camera_render,               /* void (Camera*) — binds the RT (RTT cameras), stack top *= Camera_GetViewProjection, draws the enabled layers + passes */
    FW_SYM_Camera_GetViewProjection,    /* float* (Camera*, float out[16]) — K x inverse(view): zoom +0x168, y-flip int +0x170, 1280x720 canvas centre 640,360 */
    FW_SYM_Camera_RenderOneLayer,       /* void (Camera*, int layer) — how the world (TacticsTest+0x68) and UI cameras draw: one layer, own VP push */
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
    FW_DATA_MewDirector,                       /* MewDirector* global; non-null at the main menu of a dev launch (test director) */
    FW_DATA_ShaderManager,                     /* ShaderManager* global (API v4): the App object itself, material map at +0x278 */
    /* the 3D block: render globals (docs/possible_3d_work.md K1-K13) */
    FW_DATA_Iso,                               /* float[16] col-major: the iso basis (x, height, z columns) RendererIso projects through */
    FW_DATA_IsoInverse,                        /* float[16]: the 2x2 ground inverse of Iso (picking) */
    FW_DATA_RenderStateFlags,                  /* u8: current group flags (bit0 force, 2 depth test, 4 stencil, 8 colour+depth mask) */
    FW_DATA_CullDisableCounter,                /* int: the 2D screen-space cull runs only while 0 */
    FW_DATA_DepthBias,                         /* float: global depth_bias (+1 per depth-tested layer) */
    FW_DATA_MatStackTop,                       /* int: matrix stack top index */
    FW_DATA_CurrentCamera,                     /* Camera*: the camera rendering right now */
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
/* --- API v4: per-unit glow (combat scenes only; call on the game's main thread, e.g. from a turn callback or the
 * harness). Draws a coloured rim around the unit through the game's own outline-mask pipeline, in the unit's own
 * colour (glow v2: one material per distinct colour; with several colours each rim is scissored to its unit's screen
 * rect, so units whose rects overlap share both colours there); up to 16 units; registrations belong to the current
 * fight scene and a unit whose pool slot is reused is dropped. Same ABI as v4's first release. 1 on success. */
FW_EXPORT int FW_SetUnitGlow(void *character, float r, float g, float b, float a);
FW_EXPORT int FW_ClearUnitGlow(void *character);   /* 1 when it was registered */

typedef int (*FW_fn_GetVersion)(void);
typedef int (*FW_fn_IsActive)(void);
typedef uintptr_t (*FW_fn_GetSymbol)(int);
typedef const char *(*FW_fn_GetBuildName)(void);
typedef int (*FW_fn_RegisterStatus)(const FwStatusDef *);
typedef int (*FW_fn_SetStatusStacks)(void *, int);
typedef int (*FW_fn_CharacterHasStatus)(void *, const char *);
typedef uintptr_t (*FW_fn_GetData)(int);
typedef int (*FW_fn_SetUnitGlow)(void *, float, float, float, float);
typedef int (*FW_fn_ClearUnitGlow)(void *);

typedef struct FwApi {
    FW_fn_GetVersion GetVersion;
    FW_fn_IsActive IsActive;
    FW_fn_GetSymbol GetSymbol;
    FW_fn_GetBuildName GetBuildName;
    FW_fn_RegisterStatus RegisterStatus;
    FW_fn_SetStatusStacks SetStatusStacks;
    FW_fn_CharacterHasStatus CharacterHasStatus;
    FW_fn_GetData GetData;            /* v3 */
    FW_fn_SetUnitGlow SetUnitGlow;    /* v4 */
    FW_fn_ClearUnitGlow ClearUnitGlow; /* v4; new fields are appended so older layouts stay valid prefixes */
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
    FW__R(SetUnitGlow) FW__R(ClearUnitGlow)
#undef FW__R
    return 1;
}
#endif /* FW_NO_WINDOWS */

#ifdef __cplusplus
}
#endif
