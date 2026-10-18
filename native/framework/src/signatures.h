/* Build identity table and byte signatures (Geode-style per-build bindings).
 *
 * A build is identified by the main module PE TimeDateStamp + SizeOfImage. Each symbol is located by a
 * unique byte pattern inside executable sections; expectedRva is the RVA on the authoring build (drift log
 * only). Data addresses (vtables, globals, SDL DYNAPI slots) cannot be pattern-scanned; they live in
 * BuildInfo and are sanity-checked at runtime before use. GENERATED from bindings/25143593.sig.tsv; see
 * docs/engine-map.md. The FwSymbol / FwData enums are public (framework_api.h); the tables here must
 * stay in the same order.
 */
#pragma once
#include <stdint.h>
#include <stddef.h>
#include "framework_api.h"

typedef struct BuildInfo {
    const char *name;
    uint32_t timeDateStamp;           /* IMAGE_FILE_HEADER.TimeDateStamp */
    uint32_t sizeOfImage;             /* IMAGE_OPTIONAL_HEADER64.SizeOfImage */
    uint32_t rva_LuckUp_vftable;      /* glaiel::LuckUp::vftable (172 slots) */
    uint32_t rva_Status_vftable;      /* glaiel::Status::vftable */
    uint32_t rva_DefaultStatusSource; /* game default applier source when the caller passes null */
    uint32_t luckUpTypeId;            /* value returned by LuckUp vtable slot 1 */
    uint32_t rva_data[FW_DATA_COUNT_]; /* FwData order: App global, then the SDL3 DYNAPI slots */
} BuildInfo;

static const BuildInfo FW_BUILDS[] = {
    /* Mewgenics 1.1.21239, Steam build 25143593, exe sha256 4127cd6a...eb77ea, linked 2026-09-05 */
    { "1.1.21239 (steam 25143593)", 0x6a9c51e5u, 0x01574000u, 0x00f57ab8u, 0x00ed1960u, 0x013c4d30u, 0x4d6u,
      { 0x013c4a30u,  /* FW_DATA_App */
        0x012e7648u,  /* SDL_GL_SetSwapInterval slot */
        0x012e7650u,  /* SDL_GL_SwapWindow slot */
        0x012e82a0u,  /* SDL_HideWindow slot */
        0x012e8c60u,  /* SDL_ShowWindow slot */
        0x012e8438u,  /* SDL_MinimizeWindow slot */
        0x012e8528u,  /* SDL_PollEvent slot */
        0x012e73f0u,  /* SDL_CreateWindow slot */
        0x012e7400u   /* SDL_CreateWindowWithProperties slot */ } },
};
#define FW_BUILD_COUNT (sizeof(FW_BUILDS) / sizeof(FW_BUILDS[0]))

typedef struct SymbolSig { const char *name; const char *pattern; intptr_t offset; uintptr_t expectedRva; } SymbolSig;

/* Roles:
 *  Status_ApplyByName    Status* f(std::string* name, void* ctx, int stacks, void* src, void* p5, void* p6, char p7, char p8)
 *  Status_GetCategory    glaiel::get_status_type(std::string) -> category enum (0 buff,1 debuff,...)
 *  Status_GetFlags       hit-effect flag bits by name (same by-value string shape)
 *  LuckUp_ctor           Status* f(Character*, Entity*, int* stacks, void** src, void** applier)
 *  Status_Remove         void f(Status*)
 *  string_TidyDeallocate std::string::_Tidy_deallocate(std::string*)  (callee-destroys by-value args)
 *  DebugConsole_Execute  void f(DebugConsole* this, std::string* line) — splits on spaces, dispatches the
 *                        registered std::function, pushes "No command named"/"Executed:" to the console's
 *                        output vector (this+0xc8). By-value string: callee destroys.
 *  DebugConsole_init     void f(DebugConsole* this, std::string name) — rcx is the console instance
 *  ApplicationBase_FrameBegin  void f(ApplicationBase*) from the per-frame step (0x9bad00); main thread
 *  string_Allocate       void* std::_Allocate<16>(size_t) — the game's string heap; use for by-value args */
static const SymbolSig FW_SYMBOLS[] = {
    { "TurnControl_NextTurn", "48 89 4C 24 08 55 53 56 57 41 54 41 55 41 56 41 57 48 8D AC 24 28 EF FF FF B8 D8 11 00 00 E8 4D", 0, 0x8e3c60 },
    { "Character_BeginTurn", "48 89 5C 24 08 89 54 24 10 55 56 57 41 54 41 55 41 56 41 57 48 8D", 0, 0x10a9b0 },
    { "Ability_trigger", "48 89 54 24 10 55 53 56 57 41 54 41 55 41 56 41 57 48 8D AC 24 68 FD FF", 0, 0x320a0 },
    { "FileManager_GetFile", "48 89 5C 24 18 44 88 4C 24 20 48 89 54 24 10 48 89 4C 24 08 55 56 57 41 54 41 55 41 56 41 57 48 8D 6C 24 D9 48 81 EC A0 00 00 00 41", 0, 0x99ff50 },
    { "FileManager_ResolveWithOverlays", "44 88 4C 24 20 4C 89 44 24 18 48 89 54 24 10 48 89 4C 24 08 55 53", 0, 0x9a09f0 },
    { "Status_ApplyByName", "48 89 5C 24 10 48 89 74 24 18 48 89 4C 24 08 55 57 41 56 48 8D 6C", 0, 0x483120 },
    { "Status_GetCategory", "48 89 5C 24 20 48 89 4C 24 08 55 56 57 41 54 41 55 41 56 41 57 48 8D 6C 24 D9 48 81 EC D0 00 00 00 48 8B F9 45 33 E4 48 8B 71 10 48 8B D1 4C 8B 79 18 49 83 FF 0F 76 03 48 8B 11 49 B9 25 23 22 84 E4 9C F2 CB 49 8B CC 48 85 F6 74 26 49 B8 B3 01 00 00 00 01 00 00 66 0F 1F 84 00 00 00 00 00 0F B6 04 0A 4C 33 C8 4D 0F AF C8 48 FF C1 48 3B CE 72 ED 4C 8B C7 48 8D 55 F7 48 8D 0D 6F", 0, 0x4929c0 },
    { "Status_GetFlags", "48 89 4C 24 08 55 53 56 57 41 54 41 56 41 57 48 8D 6C 24 D9 48 81 EC C0 00 00 00 48 8B F9", 0, 0x493190 },
    { "LuckUp_ctor", "48 89 5C 24 10 48 89 6C 24 18 48 89 74 24 20 57 41 56 41 57 48 83 EC 20 4D 8B F1 4D 8B F8 48 8B F2 48 8B F9 33 ED 40 38 A9 B0 04 00 00 74 07 33 C0 E9 D5 00 00 00 48 8D 0D 73 31 D0", 0, 0x711c90 },
    { "Status_Remove", "40 53 48 83 EC 20 80 79 75 00 48 8B", 0, 0x767fa0 },
    { "string_TidyDeallocate", "40 53 48 83 EC 20 48 8B 51 18 48 8B D9 48 83 FA 0F 76", 0, 0x52780 },
    /* v3 */
    { "DebugConsole_Execute", "48 89 54 24 10 48 89 4C 24 08 55 53 56 57 41 54 41 55 41 56 41 57 48 8D AC 24 58 FF FF FF 48 81 EC A8 01 00 00 48 89 55", 0, 0xa14aa0 },
    { "DebugConsole_init", "48 89 54 24 10 48 89 4C 24 08 55 53 56 57 41 54 41 55 41 56 41 57 48 8D AC 24 F8 FE FF FF 48 81 EC 08 02 00 00 48", 0, 0xa11ef0 },
    { "ApplicationBase_FrameBegin", "48 8B C4 48 89 58 10 48 89 70 18 48 89 78 20 55 48 8D 68 A1", 0, 0x9b7870 },
    { "string_Allocate", "48 83 EC 28 48 85 C9 75 07 33 C0 48", 0, 0x52a40 },
};
#define FW_SYMBOL_COUNT ((size_t)FW_SYMBOL_COUNT_)
