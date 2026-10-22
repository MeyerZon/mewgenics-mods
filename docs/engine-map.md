# Mewgenics engine map

Working notes for modding Mewgenics (Steam app 686060). Everything here is derived from the
installed binary and public documentation; no game bytes or assets are stored in this repo
beyond short byte signatures needed to locate functions.

## Target build

| Item | Value |
|---|---|
| Game version | 1.1.21239 (Steam build id 25143593, depot updated 2026-09-17) |
| `Mewgenics.exe` | 22,019,072 bytes, x64 PE, unsigned, MSVC, RTTI retained. SHA-256 `4127cd6a792ae528bca6f65a8873dd61789591937d87656c2b586a5e30eb77ea`. PE TimeDateStamp `0x6a9c51e5` (2026-09-05), SizeOfImage `0x1574000`, entry RVA `0xd3e8ac`, image base `0x140000000`. Ghidra: 56,360 procedures, 26,742 defined strings; `.text` 0x140001000..0x140e3e800 |
| `resources.gpak` | 5,134,616,316 bytes, 19,979 entries |
| Install | `C:\Program Files (x86)\Steam\steamapps\common\Mewgenics` |
| User data | `%APPDATA%\Glaiel Games\Mewgenics\<steamid>\` (`settings.txt`, `saves\`, `logs\debug.log`) |

## Engine

- Tyler Glaiel's custom C++ engine, namespace `glaiel`. Source layout visible via assert strings:
  `SVN\Engine\code\{engine\{ComponentSystem,CoreComponents,UtilComponents,Startup},glaielswf,audio,util,rendering,resource_manager}`
  and `SVN\Mewgenics\game\code\*.cpp` (Ability, Character, Brain, TurnControl, TacticsGrid, MewSaveFile, ...).
- SDL 3.2.12 statically linked (DYNAPI table present; hook DYNAPI slots, not thunks). Rendering: OpenGL via SDL.
- Dear ImGui 1.91 WIP compiled in (`imgui_impl_sdl3`, `imgui_impl_opengl3`), `glaiel::IMGUISceneBase`,
  `glaiel::DebugConsole` (component). Config keys: `enable_debugconsole`, `dev_mode`.
- Audio: FAudio (`FAudio_SetDebugConfiguration` present), MIDI resources, multi-layer music player.
- Art: custom SWF player ("glaielswf") with an ActionScript interpreter (`ScriptBindings.cpp`).
- Saves: SQLite (`SQLSaveFile.cpp`, `MewSaveFile.cpp`), files `steamcampaign01..03.sav`, LZ4-compressed blobs.
- Steamworks: SteamUserStats v013, SteamRemoteStorage v016, SteamUGC v021 (Workshop interface linked, not yet used).
- No scripting VM (no Lua/LuaJIT/AngelScript/Squirrel/Wren strings).

## Command line (handled in `glaiel::ApplicationBase::ProcessCmds`)

| Flag | Meaning (community-documented; confirm by decompile) |
|---|---|
| `-modpaths <dir>[,<dir>...]` | Mod folders mirroring the gpak layout. Since 1.0.20941 later paths override earlier; `.` = loose files next to exe. |
| `-savesuffix <s>` | Separate save files for this launch ("Save File Suffix: "). |
| `-inheritsave <s>` | Copy from another suffix ("Inherit Save File Suffix: "). |
| `-enable_debugconsole true` | Debug console (backtick). |
| `-dev_mode true` | Dev mode. |
| `-validate_pedigree_tables true` | Repairs family-tree tables (added 1.0.20941 after a save editor broke saves). |

Overlay file semantics for `.gon`, `.csv`, `.txt`: `X.append`, `X.merge`, `X.patch` map (in `Gon_overlay_apply` = `GonResource::combined_decode`
`0x9a64a0`) to `Gon_Append` `0x945410`, `Gon_DeepMerge_plain` `0x945c30` under the constant MERGE policy
(`Gon_DefaultMergeMode` `0x9451c0` returns 2, so `.merge` files never read key suffixes) and the policy-driven
`0x946680`; row by row in `docs/data-mods.md` "Fidelity to the decompiled merges".

## gpak contents

`u32 count; count x {u16 len; path; u32 size}; bodies in order` (see `tools/gpak.py`).
16,076 `.wav`, 2,361 `.lvl`, 835 `.ogg`, 447 `.gon`, 115 `.swf`, 53 `.png`, 50 `.shader`, 21 `.mid`,
`data/text/combined.csv` (localization, 12.5 MB), cat name lists.

Data directories: `data/abilities` (33), `data/characters` (23), `data/events` (28), `data/items` (15),
`data/passives` (16), `data/mutations` (9), `data/npc_scripts` (12), `data/maps` (22), `data/shops` (4),
`data/classes` (2), `data/item_pools` (6), `data/ai_presets` (2), `data/ability_templates`, plus top-level
tables (`catgen`, `spawns`, `particles`, `furniture_effects`, `weather`, `difficulties`, `tiles`, `tilesets`...).
`swfs/swflist.gon` lists every SWF the game loads; a mod adding art appends to it.

## Data model

**GON parser (OBSERVED 2026-10-21/22, `.analysis/decompiled/Gon_{LoadText_0x940840,Tokenize_0x93f090,ParseTokens_0x93fcf0}.c`).**
`Gon_LoadText` wraps the text in `{ }`, tokenizes, parses the root as an object and logs `GON ERROR: More symbols
exists after file completed parsing` if tokens remain. Tokenizer: `{ } [ ]` single-char tokens; `,` `:` `=` are
whitespace (char mask `0x2400100000000000` over chars `< 0x3e`); `#` comments to end of line (one still open at the
end logs `GON ERROR: didn't close a comment somewhere`); `"` opens a quoted token, `\` escapes the next char (only
`\n` → newline), the quotes are dropped and no flag survives. Parser: `{` → type 3 object, `[` → type 4 array, a
scalar is typed from its text: string (1) unless `strtol(tok, &end, 0)` or `strtod` consumes it entirely → number (2)
with int view `+0x50` and double view `+0x58` both stored, exact `null` → 0, `true`/`false` → bool (5, `+0x60`); text
kept at `+0x68`, type at `+0xa8`. `.add` / `.multiply` in `Gon_DeepMerge` 0x946680 use the double view and re-render
the text. The editor reproduces the typing in `editor/src/core/gon/typing.ts` (pinned by `editor/test/gon-tests.ts`);
the full rule-by-rule comparison is `docs/data-mods.md` "GON typing fidelity".

**GON text pre-pass: `//`, `/* */`, `#include`, `#define` (OBSERVED 2026-10-22, RE session inc,
`.analysis/notes-inc.md`, `.analysis/decompiled/Gon_Pre*_0x*.c`, `GonResource_decode_real_0x9a6100.c`).** The tokenizer
never sees comments or includes: `GonResource::decode(File*)` **0x9a6100** (no overlays) and
`GonResource::combined_decode(vector<CombineFile>)` **0x9a64a0** (the function called `Gon_overlay_apply` elsewhere
here; once **per CombineFile — the base file and every `.append/.merge/.patch` overlay**) call
**`Gon_Preprocess` 0xa50bd0**`(text, includeResolver, 0x100, 1)` and hand its output to `Gon_LoadText`. Its passes:
(1) **`Gon_Pre_StripComments` 0xa4eb80** — `//` up to the newline, which is kept; `/* … */` removed together with any
newlines inside; no nesting (the first `*/` closes); a `/` whose previous char is `*` closes, so `/*/` closes at once;
an unterminated `/*` silently drops the rest; neither applies inside `"…"`, where a `"` not preceded by `\` toggles
the string state; `#` is not a comment to this pass (a `"` or `/*` inside a `#` comment still counts). (2)
**`Gon_Pre_ExpandIncludes` 0xa4edf0** — outside strings, at any `#` (`CMP byte ptr [RAX+RDX*1],0x23` at 0x140a4ef23)
whose blank-delimited word is exactly `#include` (`CMP RCX,0x8` 0x140a4f124 + `memcmp` with the literal 0x141134cf8),
`Gon_Pre_ReadWord` 0xa4e650 reads the name: blanks (space/TAB/CR/LF/NUL) skipped first — newlines included —, then
up to the next blank; a `"` toggles a quoted part that is not copied and a closing `"` ends the name; no escapes.
`#include <name>` is replaced by `Gon_Preprocess(resolve(name), resolve, 0x100, 0)` (`MOV byte ptr [RSP+0x20],0x0`
0x140a4f32b, `CALL 0x140a50bd0` 0x140a4f340): the included text gets passes 1–2 with the **same** resolver; text
after the name on the line stays; no separator is added; **no depth limit and no cycle guard** (a self-include
recurses until the stack overflows — INFERRED crash). (3/4, top level only) **`Gon_Pre_CollectDefines` 0xa4f4a0 /
`Gon_Pre_ExpandMacros` 0xa501c0** — `#define NAME(a, b) … #end` macros (strings at 0x141134ce4: `#`, `#end`,
`#define`, `#include`); unused by vanilla (0 of 210 files); each `Gon_Preprocess` call has its own macro table, so a
base file's macros are invisible to its overlays. Syntax (OBSERVED in the decompiles 2026-10-22, `notes-inc2.md`;
in-game for a 2-argument macro, `mods/_incprobe`): one delimiter set throughout — blanks (mask 0x100002601) and
`( ) , : = [ ] { }` (`Gon_Pre_ReadBraced` 0xa4e880 masks 0x28000000240013 over `c-0x28` + `{` `}`;
`Gon_Pre_SubstituteArgs` 0xa4e0b0 0x2400130100002601 + 0x500000005 over `c-0x5b`). CollectDefines: outside strings, a
`#`-word exactly `#define`; the name = ReadBraced (delimiters skipped, read to a delimiter); blanks skipped; if the next
char is `(` a parameter list (repeat: `)` ends it; else skip blanks, skip delimiters, read a token, skip blanks, an
optional `,` + blanks — an unterminated list reads past the text, undefined); the body runs from right after `)` (no
parameters: from the first non-blank) up to the `#`-word `#end` (consumed; may sit mid-word); the definition is
dropped from the text and stored under `String_ConcatParts` 0x51d00`("#", name)` (call 0x140a4ffc6, `R9 =
0x141134ce4`, length 1) via 0xa510c0 (operator[]-shaped: a later definition replaces). ExpandMacros, looped by
`Gon_Preprocess` while it returns true, at most `0x100` rounds: outside strings, at a `#` whose word (to a blank) is a
key, ReadWord consumes it, one token per parameter is read (delimiters skipped, read to a delimiter; text after the
last argument stays — `#NAME (a, b)` leaves `)`), and the output gets SubstituteArgs(body): body tokens are cut at
each delimiter and a token equal to a parameter name becomes the argument; the final token (no delimiter after it) is
flushed unsubstituted. The editor ports all four passes. Nothing
else is rewritten: no BOM, `\r\n` or TAB handling (vanilla has no BOM / CRLF file).
**Where an include resolves:** the resolver is a lambda (`GonResource::decode::<lambda_1>` 0x9a7610,
`combined_decode::<lambda_1>` 0x9a7490 — the files `.analysis/decompiled/GonResource_{decode_0x9a7610,
combined_decode_0x9a7490}.c` are these lambdas) capturing **the directory of the resource being loaded** (`this->path`
cut after its last `/`, e.g. `data/maps/` for `data/maps/alley.gon`; for an overlay file the BASE resource's
directory): `path = dir + name` by plain concatenation (`0x6bd40`, no `..` / `./` normalisation), fetched with
**`ResourceManager_GetTextResource` 0x7c10e0** (cache key `"txt"` + path). Missing → the no-return
`Fatal_Error` 0x951ee0: category `GonResource`, **`Could not locate include file: <name>`** (0x14112d8d8, the name as
written), `BasicResourceTypes.cpp` line 89 / 106, an SDL `ERROR` message box, then exit — **fatal, not a log line**.
**Includes vs `-modpaths` overlays:** `GetTextResource` uses the same file manager as every data file — when the
path exists, `0x9a1790` (path or `path.append/.merge/.patch` exists) → `FileManager_ResolveWithOverlays` 0x9a09f0 →
**`TextResource::combined_decode` 0x9a5a20, which concatenates the raw text of every CombineFile and ignores the
mode**; otherwise `FileManager_GetFile` 0x99ff50 → `TextResource::decode` 0x9a59b0. So a mod's full copy of an
included file replaces it, and an overlay **on the included name** is pasted after the base text (never merged; a
`.patch` suffix arrives literally); the includer's own overlays apply normally after inlining (they see the included
entries as base); a mod can include a file it ships at the mirrored path (**OBSERVED in-game 2026-10-22**,
`mods/_incprobe/tests/include-probe.mewtest`: a `data/characters/enemies.gon.append` entry `#include`s
`incprobe_props.gon`, shipped only in the mod's `data/characters/`, and the spawned unit holds its `health 77`).
**The joined path is never normalised** (OBSERVED, `notes-inc2.md`): the pack test `Pak_HasFile` 0xa4d7b0 /
`Pak_ReadFile` 0xa4d670 looks up `String_ToLower` 0x949320(path) — a per-char `tolower`, nothing else — in the
`std::set` at `pak+0x180` (exact, case-insensitive); a loose file is `<modpath> + path` through `std::filesystem::exists`
(`FileManager_FileExists` 0x9a14c0) and a binary `std::ifstream` (`File_ctor_ReadLoose` 0x99ec60, called per mod path by
`FileManager_GetFile` 0x99ff50). So `..`, `.`, empty segments, a backslash and a leading `/` never match the pack (→ the fatal
miss) and are resolved by the OS for loose files (`..` can leave the mod folder); the validator's
`include-path-unsafe`. `FileManager_enumerate` 0x15e960's three callers (0x15e6f0, `MewApplication::OnLoad` 0x745f60,
0x912150) all list `data/text/*.csv`; `data/characters` is listed by SpawnDatabase_LoadGonDir 0x7c0cb0 through
FileManager_ListDir 0x9a1900, which also walks the mod paths ("Maps, rooms and level files"; INFERRED: a mod's helper
file there is loaded as a file of entries too — keep include fragments free of top-level names that collide). The editor ports the pre-pass in `editor/src/core/gon/preprocess.ts` and the
resolver in `editor/src/core/gon-includes.ts` (pinned by `editor/test/gon-tests.ts` "gon pre-pass" / "gon include",
fixtures `editor/test/fixtures/gon-include/`); the validator and the merge preview parse the pre-passed text.

GON objects reference C++ behavior components by class name. 1,750 RTTI classes live in `glaiel::`;
hundreds are small composable behaviors (`AddStatusToBasicAttack`, `AbilityEnabledIfHasStatus`,
`AggroTargetIsLowestHealthEnemy`, ...). Characters use `variant_of` inheritance. So the data layer can
recombine existing behaviors; new behaviors need native code.

## Verified behavior (2026-10-17, Ghidra decompilation + live launch)

- `glaiel::ApplicationBase::ProcessCmds` is at RVA `0x9b8bb0`. It handles `-savesuffix <s>` (logged as
  "Save File Suffix: s"), `-inheritsave <s>`, and `-modpaths`: if the next argument parses as an integer N, the
  following N arguments are mod paths; otherwise every remaining argument is a mod path. A path of exactly `.`
  is the loose-files entry. Each path is logged as "Mod Path: ...".
- The file manager (RVA `0x9a09f0`) resolves a requested relative path by taking the pack copy first, then walking
  the mod-path list from last to first; for each path it looks for the plain file and for `.append`, `.merge` and
  `.patch` variants and returns their paths tagged 1 / 2 / 3; `Gon_overlay_apply` `0x9a64a0` parses each overlay and
  dispatches on the tag: 1 → `Gon_Append` `0x945410` (push every child; a clashing name keeps both, the name index
  `FUN_14012a310` points at the appended one; strings concatenate; anything else is `GON ERROR: Append incompatible
  types`), 2 → `Gon_DeepMerge_plain` `0x945c30` with `Gon_DefaultMergeMode` `0x9451c0` (constant 2 = MERGE: by-name
  recursion, nth occurrence to nth, arrays element-wise + extras appended, scalars and type mismatches overwritten
  via `GonObject_assign` `0x30cd0`, no suffix read), 3 → `0x946680`, the policy-driven merge `.patch` needs, with
  `0x944cc0` the key-suffix -> policy parser and `0x944f50` the recursive suffix stripper; child lookup by
  `(name, nth)` is `GonObject_has_child_name` `0x942910` / `GonObject_child_by_name` `0x942b50`
  (`.analysis/decompiled/Gon*.c`; row-by-row in `docs/data-mods.md` "Fidelity to the decompiled merges").
- Live check: `launch-dev.bat` produced log lines `Save File Suffix: dev` and `Mod Path: <repo>\mods\dev-sandbox`
  with no GON errors; the main save file hash was unchanged; the game added default `debug_*` keys to
  `settings.txt` but did not persist `enable_debugconsole` or `dev_mode`.

## Functions and signatures

`bindings/25143593.json` (the manifest, `docs/binding-port.md`) holds every binding with its anchors; the byte
signatures (shortest unique masked prefix, relocation bytes wildcarded, generated by
`tools/bindings/make-signature.ts`) cover: ProcessCmds `0x9b8bb0`, FileManager resolve `0x9a09f0`, GetFile `0x99ff50`,
GetFileRawLoose `0x9a0300`, GetFileRawPak `0x9a0670`, FileExists `0x9a14c0`, gpak load `0x9b5380`,
TurnControl::NextTurn `0x8e3c60`, Character::BeginTurn `0x10a9b0`, Ability::trigger `0x320a0`,
MewSaveFile::open_or_create `0x229cd0`, SQLSaveFile::open `0xa0d3c0`, ApplicationBase::appmain `0x9b9970`
(previously mislabeled "DebugConsole init"; it is the main loop, see below), MewApplication ctor `0x745390`
(labeled "settings user-data path"), MewApplication::OnLoad `0x745f60` (labeled "settings load"), save selection
`0x1ba060`, and (v3, 2026-10-18) DebugConsole::Execute `0xa14aa0`, DebugConsole::init `0xa11ef0`,
ApplicationBase::FrameBegin `0x9b7870`, FrameEnd `0x9b7d80`, Step `0x9bad00`, `std::_Allocate<16>` `0x52a40`,
plus data entries for the App global `0x13c4a30`, the SDL3 DYNAPI jump table (`0x12e7000`, the `jump_table` struct
written by `SDL_InitDynamicAPI` `0xba6fd0`; the exported slots start at +0x78) and its slots, `DefaultStatusSource`
`0x13c4d30`, both vftables (RTTI-anchored), the LuckUp type id and 32 struct offsets. The 13 status-name lookups
hooked by `status_engine.c` (`get_status_type` `0x4929c0`, `get_status_stackmode` `0x492c20`, a name-exists predicate
`0x492e80`, `get_status_value` `0x492f20`, `get_status_flags` `0x493190`, `IsHitEffect` `0x5028e0`,
`OnStatusAppliedToDamageInstance` `0x493690`, `OnStatusAppliedToTile` `0x493910`, `OnStatusKilledCharacter` `0x493b80`,
`OnStatusDamageReport` `0x493e00`, `get_status_icon` `0x4933e0`, `attach_passive` `0x494080`, `SpawnTile` `0x502b40`)
are raw RVAs in `signatures.h`; 12 of them are anchored by the unique MSVC `__FUNCSIG__` string each references.
ParaboxAPI's `GameSymbols.h` (TheMegax/Mewtiplayer) targets this exact build and its RVAs matched the
decompiled code. Known community hook points: `ApplicationBase::FrameBegin`, `TurnControl::NextTurn`,
`StatusMenu::update`, SDL3 DYNAPI `SDL_GL_SwapWindow`.

Full inventories from the Ghidra session live in `.analysis/` (git-ignored): `list_procedures.tsv` (56,360 rows) and
`list_names.tsv` (452,868 rows incl. RTTI vftables) were lost in the 2026-10-19 wipe and **regenerated 2026-10-22**
(session `gon`, recipe under "REA / Ghidra sessions" — the plain `list_names` / `list_procedures` calls exceed the
MCP response budget); `npm run build:index` rebuilt from them gives the same 2007 `glaiel::` classes as before.
`decompiled/*.c` was rebuilt 2026-10-20 and grew by ~500 files on 2026-10-21/22 (every manifest evidence path exists,
pinned by a test in `editor/test/bindings-tests.ts`); the exe copy is at `.analysis/exe/25143593/Mewgenics.exe`
(sha256 `4127cd6a…`, as in the manifest).

## Debug console and application loop (static decode 2026-10-18)

Found by scanning the exe for references to the console strings and reading the result with objdump; drives the
in-game test harness (`docs/ingame-testing.md`). Absolute addresses, image base `0x140000000`.

- **App global** `0x1413c4a30` (`ApplicationBase*`). `appmain` `0x1409b9970` (the function `bindings/` used to
  call `DebugConsole_init`) runs `*(char*)(app+0x10) = 1; while (*(char*)(app+0x10)) { pump SDL events;
  Step(app, dt) }`, then writes `settings.txt` and calls `SDL_Quit`. Clearing `app+0x10` is therefore a clean quit.
  `SDL_Window*` is at `app+0xdd0`. `Step` `0x1409bad00` calls **FrameBegin** `0x1409b7870` and FrameEnd
  `0x1409b7d80` (both `void(ApplicationBase*)`, main thread, once per frame). FrameBegin's prologue is generic, so
  its 20-byte signature is unique on this build only; `Step` (12 bytes) is the fallback hook point.
- **DebugConsole** (`glaiel::DebugConsole : Component`, type id 21, vftable `0x141134448`) is created by the
  DebugScene setup `0x140757bb0` through AddComponent `0x140a33050`, then `DebugConsole::init` `0x140a11ef0`
  (rcx = the console; loads `debug_console_history.txt` / `debug_console_macros.txt`; sets `DC+0x174 = 1` when
  the config key `enable_debugconsole` is true).
- **Execute** `0x140a14aa0`: `void (DebugConsole* this, std::string* line)`. The string is an MSVC by-value
  argument: the caller builds a temporary, **the callee destroys it** (frees the heap buffer when capacity > 15).
  Splits on spaces; `tokens[0]` is the command name. Scans the registry vector at `DC+0xa8/+0xb0` (element
  0x78 bytes: `+0x10` name, `+0x30` minimum argument count, `+0x38` `std::function`, impl at `+0x70`); every entry
  whose name matches and whose arity fits is called, so overloads exist. Unmatched names fall through to the macro
  map `DC+0x128`. Messages `No command named "X" found`, `command "X" needs at least N arguments` and
  `Executed: ` are pushed to the console's own output `vector<string>` at `DC+0xc8/+0xd0/+0xd8` and are **not**
  written to `debug.log`. The ImGui submit path `0x140a146b0` copies the input line from `DC+0x178`, calls Execute,
  then appends to history `DC+0xe0`.
- **By-value strings from a DLL**: allocate the buffer with the game's own `std::_Allocate<16>` `0x140052a40`
  (`cap = len | 15`, request `cap + 1` bytes) so Execute's `_Tidy_deallocate` `0x140052780` frees it with the
  matching allocator. Keep `cap + 1 < 0x1000`: the large-allocation path stores an alignment pointer at `ptr[-8]`.
- **SDL3 DYNAPI**: SDL3 is static; every export is a thunk `48 FF 25 disp32` (`jmp [slot]`) through a `.data`
  table at `0x1412e7078…0x1412e9678` (1,175 entries). Slots: `SDL_GL_SetSwapInterval` `0x1412e7648`,
  `SDL_GL_SwapWindow` `0x1412e7650`, `SDL_HideWindow` `0x1412e82a0`, `SDL_ShowWindow` `0x1412e8c60`,
  `SDL_MinimizeWindow` `0x1412e8438`, `SDL_PollEvent` `0x1412e8528`, `SDL_CreateWindow` `0x1412e73f0`,
  `SDL_CreateWindowWithProperties` `0x1412e7400`. On disk (and until SDL initializes) the slots point at init
  stubs, so read or patch them only once the window exists. `mewtest.dll` (not `mewframework`) swaps the `SDL_GL_SwapWindow` slot
  once the window exists, to read the GL back buffer for `shot` (2026-10-22, docs/ingame-testing.md "Shots"; OBSERVED:
  the game presents every frame through it on the main thread with its context current, also with the window hidden).
  Nothing in `mewframework` hooks these slots yet
  (earlier notes claiming otherwise were wrong).
- **RNG**: the global state is 4 qwords (32 bytes) in the main thread's static TLS block at `+0x178` (the exe's
  TLS slot, index from its PE TLS directory; the save's `random_seed` property is loaded into it). `Rng_SeedState`
  0x94ee40 (`uint64_t* (uint64_t out[4], uint64_t seed)`) expands a seed into that state; `Rng_Reseed` 0x94f0a0
  calls it with an FNV-1a mix of `clock()`, `_time64`, the thread id and a counter, and copies the 4 qwords (the
  boot's non-dev branch and every dev-menu fight button reseed this way; the dev-mode boot does not). OBSERVED
  2026-10-20: the harness's `seed 42` right before `enter TacticsTest` makes the generated party and every roll
  after it identical run to run (`mods/jokers-luck/tests/luck-seeded.mewtest`); the state before the pin was already
  identical across launches of the same `test00.sav`. Native mods do not draw from this state: they use the
  framework's own stream `FW_Random` (API v5, splitmix64 in `native/framework/src/fw_rng.c`), which the same `seed`
  directive re-seeds. The CRT `rand` is not pinnable (msvcrt keeps its state per thread; OBSERVED 2026-10-22: Joker's
  Luck's `srand(GetTickCount())` + `rand()` gave different rerolls on every seeded launch).
- The framework exposes the code symbols as `FW_SYM_DebugConsole_Execute`, `FW_SYM_DebugConsole_init`,
  `FW_SYM_ApplicationBase_FrameBegin`, `FW_SYM_string_Allocate` and the data addresses as `FW_DATA_*`
  (`FW_GetData`, API v3).

## Frame timing and game speed (2026-10-22)

Ghidra session `speed` (`.analysis/notes-speed.md`, decompiles `TurnControl_Update_0x8e2a30.c`,
`HitPause_Update_0x7942b0.c`, `HitPause_GetOrCreate_0x122d70.c`, `PauseMenu_SetupGameSettings_0x28eee0.c`,
`PauseMenu_SetCombatSpeed_lambda8_0x29c3f0.c`, `PauseMenu_Open_0x289d90.c`, `Settings_GetFloat_0x9d3b40.c`,
`Settings_GetOrCreate_0x9d34c0.c`, `FastTestMode_*`, `App_UpdateTimed_0x9bb110.c`, `App_RenderFrame_fast_0x9bb1a0.c`)
plus objdump of `appmain` / `Step`.

- **Fixed-step loop (OBSERVED).** appmain reads `update_rate` (float, default 60) → fixed dt `App+0xe08` = 1/rate and
  step `App+0xe00` = perf-frequency/rate; `update_multiplicity` (default 1) `App+0xe18`; `unlock_framerate` (default
  true) `App+0xe1c`; `framerate_cap` (default 0) `App+0xe10`. Per loop iteration: a smoothed frame delta `d` (perf
  ticks); `App+0x11` pauses (`App+0x12` single-steps), `App+0x13` multiplies `d` by 0.25, `App+0x14` by 4 (no writer of
  either found: debug-only); then **`accumulator App+0xdf8 += d × App+0xdc0`** (`movsd xmm2,[rsi+0xdc0]` at
  `0x1409ba895`) — `App+0xdc0` (`App_timescale`, double) is the global time scale, `App+0xdc8` a copy of it. A
  catch-up guard drops time when the accumulator exceeds `max(scale,1) × 8` steps (it scales with the time scale, so
  it does not clamp speed). `Step` then runs `while (acc > mult × step) { acc -= step; App_UpdateTimed(dt) }` —
  **every update gets the same dt** — then FrameBegin, render, FrameEnd. Speed therefore = how many identical updates
  run per rendered frame; the logic, the RNG sequence and the turn order do not depend on it (OBSERVED below).
- **Who writes the time scale (OBSERVED).** `HitPause_Update` `0x7942b0` (glaiel::HitPause, component type 0x440,
  vtable `0x140ede408` slot 16) on every update: `App+0xdc0 = hp+0x50` (× `hp+0x48` during a hit pause).
  `TurnControl_Update` `0x8e2a30` (TurnControl vtable slot 10) on every update: `speed = TC+0x180 ? 1.0 :
  Settings_GetFloat("combat_speed", 1.0)`, stored to `TC+0x178` and `HitPause+0x50`; `TC+0x180` is set by
  `Ability_trigger` `0x320a0` for abilities with `graphics { bypass_combatspeed true }` (they animate at 1x).
  `PauseMenu_Open` `0x289d90` and HitPause's reset write 1.0.
- **The vanilla speed-up and its limit (OBSERVED, static).** The `combat_speed` setting (settings.txt; the owner's is
  2). `PauseMenu::SetupGameSettings` `0x28eee0` builds its dropdown from exactly four options `"1"`..`"4"`; the setter
  lambda `0x29c3f0` stores the string. **The limit is only the UI list**: the reader is an unclamped float. So
  `combat_speed 8` in settings.txt, or `-combat_speed 8` on the command line, should run combat at 8x. The command
  line form does not persist: `Settings_GetOrCreate` `0x9d34c0` looks the key up first in `App+0x3b8`, the map
  `ProcessCmds` fills from every `-key value` pair, and only then in the persistent map (INFERRED: the settings.txt
  writer reads only the latter). Not run in-game here (the harness runner passes no extra flags); it affects combat
  only (TurnControl exists only in a fight) and keeps `bypass_combatspeed` animations at 1x.
- **The dev fast mode (OBSERVED).** `App+0xe1d`: set by the TacticsTest dev menu's `fuzz_test_fast` /
  `replay_test_fast` / `stress_test_fast` (`FastTestMode_Enable` `0x368980` / `0x36bda0`, with
  `SDL_GL_SetSwapInterval(0)` and movieclip interpolation off), cleared by `0x3690c0`. In that mode `Step` runs one
  update per loop iteration and renders at most once per step of wall time — the simulation runs CPU-bound. Not
  exposed by the framework (yet).
- **Framework lever (API v6, `FW_SetTimeScale(double)` / `FW_GetTimeScale`, `native/framework/src/speed_engine.c` over
  the host-tested `fw_speed_rules.c`).** A FrameBegin hook (hook plan, last row) multiplies whatever the game left in
  `App+OFF_APP_TIMESCALE` once per rendered frame — after that frame's updates, before the next accumulation — so it
  composes with combat_speed and hit pauses, and works outside combat too. The value written is nudged up one ulp so
  the next frame can tell its own write (multiply nothing) from a game rewrite (multiply the new base); factor 1
  restores the game's base. Clamp [1/16, 64]; NaN / ≤ 0 → 1. Harness: `speed <factor>` / `speed off`.
- **Measured (T2, 2026-10-22, `mods/jokers-luck/tests/luck-seeded*.mewtest`, seed 42, autoplay fight of 11 turns,
  hidden window = vsync off, this machine).** Wall time from `enter TacticsTest` to `end`: 1x 11968 / 11859 ms;
  4x 3329 ms (3.6x); 8x 1922 / 2687 / 2141 ms (~5x); 12x 1625 ms (7.3x); 16x 1406 ms (8.5x); 32x 1516 ms (no gain:
  CPU-bound, ~500 updates/s). Whole run (boot is loading, not scaled) 19.3 s → 8.9–11.3 s at 8x. At 1x, 4x, 8x and
  12x every expectation held and at 8x the three unit dumps (hp, stats, statuses, stacks of all 8 units) are
  byte-identical to 1x (fixtures `result-speed-1x.jsonl` / `result-speed-8x.jsonl`). **What broke: at 16x and 32x
  the expectations after `wait rounds` failed** — several turns now resolve inside one rendered frame and the harness
  samples once per frame, so it observed a later turn (16x: the round-2 sample saw round 3's value; the turn count
  at the end was still 11). That is the harness's observation granularity, not a different fight; scripts that
  sample after `wait turns|rounds` should stay at ≤ 12x. Audio pitch was not measured (harness runs are muted).

## REA / Ghidra sessions

The only decompiler available here is Ghidra inside the Docker image `rea-ghidra:12.1.4` (the REA MCP server built
into Claude Code has no Ghidra configured on Windows). Start a long-lived session from the repo root, in the
background, with **your own** container name and queue directory:

```
node tools/rea-mcp.mjs --server "docker run --rm -i --name rea_ghidra_<tag> -v \"C:\Program Files (x86)\Steam\steamapps\common\Mewgenics:/game:ro\" -e REA_GHIDRA_STARTUP_TIMEOUT_MS=1800000 rea-ghidra:12.1.4 --mcp" watch .analysis/queue-<tag>
```

`.analysis/` is git-ignored and has no backup: the decompiles, `list_procedures.tsv` and the saved exes under
`.analysis/exe/<build>/` exist only on this disk. On 2026-10-19 a `git worktree remove` of a worktree that held a
junction to `.analysis` emptied the directory (see `CLAUDE.md` "Worktrees with junctions"); every decompile the docs
cite now has to be re-done from a fresh import, and the old-build exe re-fetched with Steam `download_depot`. Keep
junctions out of worktrees, or unlink them (`cmd /c rmdir`) before deleting the tree.

Protocol (see `tools/rea-mcp.mjs`): drop `req-<name>.json` — a JSON array of `{id, tool, arguments, timeoutMs}` —
into the queue dir; results appear as `res-<name>.json` and the request is renamed `done-<name>.json`. The first
request must be `open_binary {"path":"/game/Mewgenics.exe","provider_id":"ghidra"}` (timeoutMs 3600000) followed by
`binary_overview`; import + auto-analysis takes ~16-17 min (`binary_overview` ≈ 960 s). Useful tools afterwards:
`procedure_pseudo_code {procedure:"0x..."}`, `xrefs {address}`, `search_strings {pattern, mode}`,
`search_procedures`, `procedure_callers/callees`, `read_bytes`. Create a `stop` file in your queue dir to end the
session; the container is `--rm` and disappears.

**Concurrency rules** (several sessions/subagents run at once; a killed import costs 17 minutes):
- One `rea_ghidra_<tag>` + `.analysis/queue-<tag>` per agent. `.analysis/queue` and other agents' queue dirs are
  off limits.
- Stop only your own container, by exact name. Never stop/kill/rm by image filter or `docker ps -q`
  (`docker events` on 2026-10-18 shows `kill … signal 15` on `rea_ghidra_3d` and `rea_ghidra_3d2` from exactly such
  a filter in another session).
- A result of `"error": "Error: server exited with code 0"` on `binary_overview` means the container was stopped from
  outside, not that Ghidra failed; check `docker events --since 1h` before retrying.
- Persist what you decompile to `.analysis/decompiled/<Name>_<addr>.c` and check there first — many functions are
  already on disk.

**Lessons from the 2026-10-21/22 parallel run** (ten sessions over two days — `catA`, `catB`, `catC`, `disp`, `glow`,
`loc`, `bind`, `gon`, `rim`, plus the harness one — each with its own container and queue dir, ~500 new decompiles,
notes in `.analysis/notes-<tag>.md`):
- **Concurrency.** One container + one queue dir per agent held up with up to seven sessions at once (the queue dirs
  are still under `.analysis/queue-*`). The Docker Desktop VM is capped at **30.19 GB** (host 64 GB; owner screenshot
  2026-10-21): four concurrent imports used ~6.4 GB and ~530 % of 1600 % CPU, so memory is not the limit — one
  oversized decompile is (`TacticsTest::init` 0x833390, 345 KB, exhausted the cap once; decompile its lambdas and
  helpers by address instead, never the whole function).
- **Inventories exceed the MCP budget.** `list_names` / `list_procedures` fail with `resource_constraint` (10.55 MB /
  10.52 MB against a 10 MB response cap). Recipe (session `gon`): `export_evidence_bundle {path:"/tmp/ev-<tag>.json",
  overwrite:true}` inside the container (≈150 MB) → `docker cp rea_ghidra_<tag>:/tmp/ev-<tag>.json
  .analysis/queue-<tag>/` → take the records whose `operation` is `list_names` / `list_procedures` and flatten
  `normalized_result[]` to TSV (`address, value, symbol_dynamic, symbol_external, symbol_primary, symbol_source,
  symbol_type` / `address, value, procedure_external, procedure_thunk, procedure_thunk_target`; header row; tabs and
  newlines in values replaced by spaces) → `.analysis/list_names.tsv` (452,868 rows) and `list_procedures.tsv`
  (56,360 rows). The bundle itself stays in the queue dir (git-ignored).
- **Short strings are invisible to `search_strings`.** Literals under Ghidra's string threshold (`1hp`, `999`, three
  bytes) are found with `search_bytes` on the NUL-terminated bytes (`"31 68 70 00"` → the `.rdata` address → `xrefs`),
  the same way the inline 8-byte immediates (`OverridePalette`, `tex`, `scars`) were matched in the decompiles.
- `close_binary` returns a `snapshot_path` that could skip the 17-minute import next time; **untested** on this image
  — every session so far re-imported.
- `procedure_pseudo_code` on a function that is only reachable through a `std::function` vtable (the console lambdas,
  the reference-node visitor 0x7425e0) needs the `_Do_call` slot address from `list_names.tsv`, not an xref walk.

## Status effects (decompiled 2026-10-17)

- Every status is a C++ class `glaiel::<Name> : Status : Passive : Component` (268 Status subclasses, 946 Passive
  subclasses; the `DeriveComponentWithBoilerplate<Class, Base, TypeId>` template supplies name, type id and the
  type hierarchy). Objects are 0xF0 bytes, pool-allocated, with a 172-slot vtable. `glaiel::Status::vftable` is at
  RVA `0xed1960`, `glaiel::LuckUp::vftable` at `0xf57ab8` (type id 0x4d6). The type id is read from two places that
  must agree: slot 1 of the LuckUp vftable (`B8 D6 04 00 00 C3`) and the `mov r8d, 0x4d6` (`41 B8 D6 04 00 00`) four
  instructions before `Status_ApplyLuckUp`'s call to `Entity_FindComponentsByTypeId` (its 5th E8 call; OBSERVED
  2026-10-19, pinned by the T1 bindings test and `bindings/25143593.json` `LuckUp_typeid.anchors.witness`).
- Vtable slots identified: 0 `GetTypeName(this, std::string* out)`, 1 `GetTypeId()`, 2 `IsA(this, std::string*)`,
  3 `GetTypeHierarchy()` (`{int ids[16]; uint64 count}`), 5 scalar deleting dtor, 30 `OnInit(stacks, GonObject*
  data, applier)`, 33 `OnApplied`, 82 `ApplyStatModifiers` (LuckUp: `character->effectiveLuck(+0x5d4) += stacks`, called by `Character::recompute_stats` — "Effective stats" below — and
  marks removal when stacks reach 0), 170 `OnStacksChanged`, 171 stacks-cleared callback.
- Object fields: +0x18 entity, +0x20 the **Scene** (+0x28 = its first qword, the scene manager: the Component layout), +0x38 the unit (Character*), +0x5c `int stacks`, +0x68 GON data, +0x74 applied,
  +0x75 removing, +0x76 `tickdown_this_turn`, +0xc8 applier, +0xe9 "temporary" flag.
- OBSERVED 2026-10-21 (session `bind`, `.analysis/notes-bind.md`, cross-checked in Ghidra): `LuckUp_ctor`
  (`0x711c90`, 292 B) pool-allocates **0xF0 bytes** (`41 B8 F0 00 00 00` memset length; pool global `0x1414e40`,
  element size 0xf8, referenced only by the ctor and its 54-byte static initialiser `0x1fa40`), runs the base
  `Passive::Passive` (`0x4c940`), zeroes +0xc8..+0xe0, writes word 1 at +0xe8 (so +0xe8 = 1, +0xe9 `temporary` = 0),
  stores `LuckUp_vftable` (`lea rax,[0xf57ab8]; mov [rbx],rax` at +140 — the **only** code reference to that vftable
  image-wide), sets **+0x18 = entity, +0x20 = its first argument, the Scene** (2026-10-22, below), +0x28 = the scene's first qword, pushes itself into
  `entity+0x20` (`{cap u32, count u32, T** data}`, so Entity +0x24 = count, +0x28 = `Component**`), copies
  `entity+0x19` to +0xe and calls slot 30 `OnInit` devirtualised (`0x8104b0`: stores data at +0x68, stacks at +0x5c,
  reads GON `tickdown_this_turn` into +0x76). It is a byte-twin of the `AIControlNextTurn` ctor (`0x705db0`) and one
  more 0xF0-byte Status ctor (`0x705ee0`) modulo relocations: no relocation-free byte signature exists for it.
- `Status_NameExists` (`0x492e80`) and `Status_GetValue` (`0x492f20`) share the **same map global `0x13c4830`**
  (end sentinel +8) — the only two functions referencing it: NameExists is "the status-value map has this name".
  Each of the other lookups owns its own map global (GetCategory `0x13c47b0`, GetStackMode `0x13c47f0`, GetFlags
  `0x13c4870`, GetIcon `0x13c48b0`, OnAppliedToDamageInstance `0x13c48f0`, OnKilledCharacter `0x13c4930`,
  OnAppliedToTile `0x13c4970`, OnDamageReport `0x13c49b0`, IsHitEffect `0x13c49f0`); the log sink context
  `0x12f7b08` is shared. The 13 are one template body each (FNV-1a, `0x4c340` map find, `NO STATUS NAMED` assert
  with `{__LINE__, column, __FILE__, __FUNCSIG__}` → `0x9522c0`); the twins differ only in relocations and the assert
  line/column (GetCategory 72, GetStackMode 77, GetValue 88, GetFlags 96, GetIcon 105, OnAppliedToDamageInstance
  118, OnAppliedToTile 127, OnKilledCharacter 136, OnDamageReport 145, IsHitEffect 201). They sit in one `.pdata`
  run after `apply_status` (11368 → 11369 GetCategory … 11379 AttachPassive; 11383 IsHitEffect → 11384 SpawnTile).
- `Status_ApplyLuckUp` (`0x5f9760`, 711 B): the only relocation-free bytes unique to it image-wide are the type id
  `41 B8 D6 04 00 00` (`mov r8d, LuckUp_typeid`, +357, four instructions before `Entity_FindComponentsByTypeId`);
  every reloc-masked window of its body also matches the `Bruise` (`0x5c4240`) / `Bleed` (`0x5bf1a0`) apply siblings.
  It has exactly three E8 callers — `apply_status` (`0x48b4cb`), `attach_passive` (`0x4b24b0`) and the third by-name
  dispatcher `0x4ccb20` — in each the call is the first in-tolerance E8 after `lea rdx,[rip+"LuckUp"]` + the
  `std::string == const char*` compare (`0x52560`). `"LuckUp\0"` occurs once in .rdata (`0xee23d8`) and is lea'd from
  12 `.pdata` functions; adding `"None"` (`0xed0b90`) and the size tolerance leaves this one. These facts are the
  `bindings/25143593.json` anchors `imm32Witness`, `callers[].afterStringLea`, `vtableStore` and `sharedDataRef`.
- Character +0x18 = `Entity*`; Entity +0x24 = component count (u32), +0x28 = `Component**` array. Character +0xe50 =
  `touched_passives` (forces a stat recompute), +0x5d4 = effective luck (base + every modifier; "Effective stats").
- `Status_ApplyByName` (RVA `0x483120`): `Status* f(std::string* name, void* ctx, int stacks, void* src, void* p5,
  void* p6, char temporary, char p8)`, a 793-way if-chain on the name calling a per-status apply function; the
  callee destroys the by-value string (`std::string::_Tidy_deallocate`, RVA `0x52780`). **`ctx` is a Component in every shape: +0x18 = the unit's Entity, +0x20 = the
  Scene** (+0x28 the scene manager — the Component layout of "Dev scenes and run entry"). Shapes seen: the passive
  component under `StatusOnBattleStart`, the Character itself (a Component too) under `StatusOnSpawnIn`. OBSERVED
  2026-10-22 (`mods/jokers-luck/tests/merge-contexts.mewtest`, red run `20261022-115757`): the framework logged
  "JokersLuck: created on <ctx+0x20>" for all 6 applies of both shapes with the one pointer the harness `enter` event
  reports as `scene=`. CONFIRMED by the decompiles: `Status_ApplyLuckUp` checks `[ctx+0x20]+0x4b0` (`Scene_destroyed`),
  merges through `Entity_FindComponentsByTypeId(ctx+0x18, 0x4d6)` and passes ctx+0x20 as `LuckUp_ctor`'s first argument,
  which hands it to `Owner_RegisterComponentTypeIds` (0x96b340: the scene's per-type component arrays at +0x18/+0x20
  and its +0x488 vector). So **a status is found through ctx+0x18, never through ctx+0x20**, and the unit is the new
  status's `+0x38` (`OFF_STATUS_CHARACTER`). The manifest entry is `ApplyCtx_scene` (`OFF_APPLYCTX_SCENE`; it was
  `ApplyCtx_character` until then). Until this fix the framework's JokersLuck merge walked `(ctx+0x20)+0x18`, never
  found the first instance, and a second apply built a second object (`[JokersLuck=1, JokersLuck=2]` on every unit);
  `fw_walk_apply_existing` (the one merge lookup of the custom-status and glow paths; host test
  `apply_existing_finds_the_units_status_under_both_ctx_shapes_never_through_ctx_plus_0x20`) walks ctx+0x18, and the
  green run `20261022-121252` shows one JokersLuck with 3 stacks per unit (fixture `result-merge-contexts.jsonl`). The
  TacticsTest console command `status <name>` with no unit selected reaches no apply_status at all (OBSERVED, same runs). The LuckUp branch (`0x5f9760`) merges into an existing LuckUp found through
  `Entity_FindComponentsByTypeId` (`0x969f90`) or constructs via `LuckUp_ctor` (`0x711c90`:
  `(Scene*, Entity*, int* stacks, void** src, void** applier)`) which runs slot 30 before returning.
- `glaiel::get_status_type(std::string)` (`0x4929c0`) and the hit-effect flags lookup (`0x493190`) are FNV-1a
  hash-map lookups keyed by name; unknown names log `NO STATUS NAMED <x>` to the game log.
- `Status_Remove` (`0x767fa0`): marks +0x75, sets `touched_passives`, calls slot 45.
- GON: abilities apply statuses via `damage_instance { effects { Name N } }` or `Temporary { status Name stacks N
  turns T expires_on_end_turn true }`; `keyword_tooltips.gon` maps names to `KEYWORD_*` text keys and supports
  `alias`.

### How mewframework adds a status
`FW_RegisterStatus` clones the template's vtable (LuckUp only on this build), replaces slots 0-3 with per-definition
thunks (new name, Mewjector-allocated type id, `IsA` that also answers to the new name, hierarchy with the template id
swapped), and hooks `Status_ApplyByName` (handles the new name: merge into an existing instance or construct with the
template ctor and swap the vtable), `get_status_type` and the flags lookup (alias the new name to the template so
category and hit-effect rules apply), and `Character::BeginTurn` (dispatches `on_turn_begin` to carriers).
`FW_SetStatusStacks` writes +0x5c, calls slot 170, sets `touched_passives`, and removes at 0.
The rules a definition must satisfy — at most 8 definitions (one vtable-thunk row each), a non-empty name of at
most 15 bytes (the std::string SSO buffer, so the alias rewrite never reallocates), template `LuckUp` only, unique
names, none starting with `FwGlow_` (since 2026-10-22 that namespace is the data-level glow, which needs no
registration: "Per-unit glow" v3) — and the alias rewrite itself live in the pure `fw_status_rules.c` (host tests `test_status_rules.c`);
`FW_RegisterStatus` validates against them before it claims the name with Mewjector. Since 2026-10-21 the rest of
the logic is pure and host-tested as well: the vtable clone into caller-supplied memory + the thunk bodies
(`fw_vtable.c`, `test_vtable.c`; a T1 check clones the real dump `.analysis/luckup-vtable.hex` and pins slots 0/1 at
`0x140566ed0` / `0x140566ec0`), the Character → Entity → component walks and the apply_status argument resolution,
merge writes (+0x5c, +0xc8, +0xd0 = applier−8) and set-stacks writes over `offsets.h`-shaped fake objects
(`fw_walk.c`, `test_walk.c`), and the load-time policy — symbol resolution over executable sections only with
exactly one hit, the `-savesuffix` gate, `FW_GetSymbol`/`FW_GetData` bounds and the hook plan: `Character::BeginTurn`
(priority 20, abort on failure) → LuckUp vtable sanity check → `apply_status` + the 13 lookups (priority 20, all
attempted, counted) → `TurnControl::NextTurn` (priority 100) (`fw_resolve.c`, `test_resolve.c`).
Verified in process on 2026-10-17: all hooks installed, Mewjector integrity ALL OK, `JokersLuck` registered with
type id 0x1000. Combat behavior still needs a played fight to confirm.

## Native loading

Mewjector v3.5 (`version.dll` proxy, MIT) is installed in the game folder, **built from its audited source**
(full read of all 3,759 lines on 2026-10-17: no network, registry, process or persistence behavior; details in
the project status page). GCC rejects its `__try/__except` blocks, so it was cross-compiled with Debian clang 14
targeting MinGW-w64 in a throwaway container (`tools/mewjector-build/build.sh`, notes in
`native/third_party/mewjector/built-from-source/BUILD.md`, sha256 `aa2ca6d6...9d10ec`). The upstream MSVC
release binary is not used. `native/chainloader.ini` points `ScanPath` at this repo's `native/dist/`.

Verified 2026-10-17 (three launches, main save hash unchanged each time, no crash reports):
- Mewjector loaded the real `C:\WINDOWS\system32\version.dll`, then `mewframework.dll` from `native/dist`.
- With `-savesuffix dev`: framework recognized build 1.1.21239, resolved 5 signatures uniquely, installed an
  observer hook on `TurnControl::NextTurn` (RVA 0x8e3c60, 15 stolen bytes, priority 100) through
  `MJ_InstallHook`; Mewjector's post-load integrity check reported ALL OK.
- Without `-savesuffix`: framework logged "vanilla launch ... framework inactive" and installed nothing.
- Lesson recorded: signatures must be copied at their full unique length; a shortened prefix matched twice in
  memory and the framework correctly refused to activate. Since 2026-10-19 `signatures.h` is generated from the
  manifest and a host test re-validates every pattern, so this cannot regress by hand-editing.
- Porting to a new build: `docs/binding-port.md` (identity gate → `unknown-build` verdict; `port_bindings`).
- Not yet observed: the hook firing in combat (needs someone to play a fight on the `dev` save).

## Art / SWF subsystem (decompiled 2026-10-18)

Art is vector SWF played by `glaiel::swf` ("glaielswf"); `swfs/swflist.gon` lists every clip the game loads. Key
functions resolved while diagnosing the emitter crash (static PE decode + Ghidra; full chain and 6 decompiles in
`.analysis/decompiled/` and `docs/swf-emitter-fix-spec.md`):

- `load_swf` RVA `0x9bb9e0` — parses a clip; our hand-emitted minimal SWF parses here **without error**.
- `ApplicationBase::process_animation_merges` RVA `0x9bc070` — after load, a clip whose SymbolClass carries the
  8-byte prefix `_Append_` is merged frame-by-frame into the live target sprite named by the suffix (e.g.
  `_Append_AbilityIcon` → sprite id 1346, 901 frames). This is the mod art-append mechanism.
- The post-load scripted call path that faults on a structurally-naive appended frame: `RunObjectScript` `0xb7f2b0`
  → DisplayObjectContainer call-by-name `0x99dec0` → `std::function::_Do_call` `0x29ae10` → adventure-cutscene
  handler `0x3c0210` → team-name / cat-quote builder `0x8e130` (reads `data/catquotes.gon`) → **null double-deref**
  when there is no active adventure run.

- **`AbilityIcon` per-frame layout (OBSERVED 2026-10-19, read-only parse of `swfs/ability_icons.swf`; T1 test in
  `editor/test/art-emitter-tests.ts`):** sprite 1346, 901 frames, 842 unique labels (first `unknown`; `Spin`
  present, `JokersGambit` absent). Every labeled icon frame = `FrameLabel` + one `PlaceObject2` at **depth 3** of a
  bare `DefineShape/2/3/4` (flags 6 HasCharacter|HasMatrix identity on first use, flags 3 Move|HasCharacter on
  swaps); **no nested movieclip is ever placed**. Frame 0 also holds a background shape at depth 1, a
  `DefineEditText` named `label` at depth 2 (removed at frame 1) and a border `DefineShape4` at depth 5; the tail
  removes depths 5 and 1 then runs seven empty frames; the ABC registers only `frame1 → stop()`. `PassiveIcon`
  (id 515, 915 frames) is the same pattern at depth 4. An `_Append_AbilityIcon` donor therefore mirrors a vanilla
  frame by placing its icon shape at depth 3 (`ABILITY_ICON_DEPTH` in `swf-emitter.ts`).
- **Append merge witness (OBSERVED 2026-10-19 via the harness):** an `_Append_<unknown>` SymbolClass logs
  `Application.cpp; line: 1363;] Append movieclip: _Append_<unknown> could not locate original movieclip to append
  to` and the boot then never reaches the console / main menu (no crash report) — a silent stall, not a warning,
  for modders who mistype the target. Real targets (`_Append_AbilityIcon` with the icon at depth 1 or 3, nested or
  bare) all boot to the main menu.

Conclusion: the emitted SWF is not malformed and the merge itself is survivable: the 2026-10-18 null-deref did not
reproduce at boot with the exact pre-fix donor (`npm run test:swfgate -- legacy`), so the fault is tied to the
appended frame being *displayed* inside a run (outer crash frames are the running frame loop), which the harness
cannot drive yet (TODO target 1). The donor now mirrors the vanilla frame (depth 3); the remaining check is the T3
visual one. Evidence and gate table: `docs/swf-emitter-fix-spec.md` §0. The `_Append_AbilityIcon` name is correct;
char-ID collision was ruled out.

**How the game draws a mod's character art (OBSERVED 2026-10-20, `npm run test:artprobe`).** `mods/_artprobe/`
appends an enemy `ArtProbe { variant_of Rat; graphics { movieclip ArtProbe … } }`; `spawn ArtProbe` in a harness
fight draws the `ArtProbe` SymbolClass from the mod's own `probe.swf` (listed by `swfs/swflist.gon.append`). Six
shots, read by `editor/src/core/art/probe-compare.ts` (a pure-yellow-bordered checker bitmap is the marker and gives
the scale, about 1.72 screen px per clip px at 3440×1440): enemy clips are mirrored; a nested sprite inside a
one-frame parent advances on its own clock; bitmap fills are sampled smoothly and clamped at the edge; PlaceObject
cxform applies; enemies have no palette row (gray stays gray). Fixture: `editor/test/fixtures/ingame/artprobe-summary.json`.

### Imports are not linked (the cat-parts import experiment, 2026-10-20)

`Swf_GetCharacter` RVA `0xa4a190` (113 bytes; `.analysis/decompiled/Swf_GetCharacter_0xa4a190.c`) is the per-file
character lookup with lazy init: `table = file+0x28` (`Character*[]` by id), `entry = table[id]`, and on first use
`entry->vtable[2](entry)` initialises it. Callers: `0x9a8f30` (MovieClipAdvance, places characters), `0x9bb6f0`,
`0x9bc070` (process_animation_merges), `0xa2f900`, `0xa4b740`, `0xb79410`.

- A SWF carrying `ImportAssets2(url, [{ id, name }])` **loads** (gate variant `import`: boot pass).
- Placing an imported id **crashes**: `table[id]` is null for it, and the read of `entry[4]` faults
  (`0xc0000005` at `Mewgenics.exe+0xa4a1a9`, on `spawn` of a character whose clip places imported catparts.swf
  CatTail / CatBody / CatHead; the same clip without those layers runs).
- So glaiel::swf parses `ImportAssets2` but does not link its entries. Vanilla only ever uses it with **zero** entries
  (`fonts.swf`), and fonts resolve by class name in `DefineEditText`, not through the import.
- Pinned: `editor/test/fixtures/ingame/artprobe-cat-summary.json` `importParts`; the validator refuses any
  `scene.imports` (`import-unsupported`).

### CatTest and the cat animation clips (2026-10-21)

Facts from a read-only parse of `.extracted/swfs/*.swf` with `editor/src/core/art/swf-reader.ts` (the slot layout is
T1-pinned in `editor/test/fixtures/art/cat-rig-slots.json`):

- **`_CAT` is not a SymbolClass in any vanilla SWF**; it is an engine-reserved `graphics.movieclip` value. Every real
  cat uses `movieclip _CAT` plus `custom_cat_data <Name>` (part indices in `custom_cats.gon`): `player_cat.gon`,
  `cat_enemies.gon` (e.g. `TomTom { graphics { movieclip _CAT; name "ENEMY_TOMTOM_NAME"; custom_cat_data TomTom;
  scale 1.1; shadow_size 1.1 } … properties { tag cat; type cat; faction enemies } }`).
- **The vanilla cat clip is `CatTest`** (catanis.swf SymbolClass id 1614, 854 frames, 776 labels). Each labeled frame
  places **one nested sprite at depth 1** (instance name `pawing` in 423 frames, none in 252, an animation name in the
  rest; `idleF` → sprite 9, 180 frames, matrix translation (77, −959) twips). Labels are facing pairs `<anim>F` /
  `<anim>B` (`idleF/idleB`, `FighterIdleF/B`, `StartTurnF/B`, `dashF/B`, …) plus `_R` variants. The nested sprites
  carry the seven named slots `tail@1 leg2@3 arm2@5 body@7 leg1@9 arm1@11 head@13` (= `CAT_SLOTS` in `cat-rig.ts`),
  and **every slot instance is a 1-frame DefineSprite wrapping one placeholder DefineShape** (ids 2/4/6/8; the four
  limbs share id 4) — never a bare shape.
- **Vanilla extends `CatTest` with the append mechanism:** catanis2.swf exports `_Append_CatTest` (id 590, 296 frames,
  239 labels such as `crawlingIdleF`, `cultistIdleF`, `robotWalkF`) — the same `_Append_<Target>` merge
  (`process_animation_merges` 0x9bc070 → `Swf_Merge` 0xa58440) our emitter uses for `_Append_AbilityIcon`. Its frames
  place the nested sprite **unnamed** (215 of 217; `pawing` twice; `splitfileidleF` places a bare DefineShape); its
  nested sprites have the same seven slot sprites (depths vary per frame: `crawlingIdleF` has head@11, arm1@13),
  placed with ~0.6-scale matrices. Both files carry one `DoABC`.
- **`Swf_Merge`** (`.analysis/decompiled/Swf_Merge_0xa58440.c`) builds a merged copy at `original+0x130` on first
  use, appends the donor's frames (frame numbers offset by the original's frame count, place records' character index
  offset by the original's character count), adds the donor's labels to the map at `+0x20` and copies the donor's
  character table (`+0xa0/+0xa4/+0xa8`). `process_animation_merges` walks **every** SymbolClass entry (list at
  `+0x78`), so an `_Append_` export need not be a file's first entry.
- `alt_animations [[idle <label>]]` on a character entry is valid (cat_enemies.gon `CatCaller`: `girlyIdle`,
  `GlassSpitter`: `twitchyIdle`); the engine appends the facing suffix. catparts.swf exports `CatBody#8845 CatHead#7132
  CatLeg#9925 CatTail#10982 CatEar CatEye CatEyebrow CatMouth CatEyeClosed CatMouthOpen CatMouthSmile
  CatHeadPlacements#11006`.

**How a cat clip's slots are filled — `glaiel::CatParts` (OBSERVED, Ghidra session catB 2026-10-21,
`.analysis/notes-catB.md`; decompiles in `.analysis/decompiled/CatParts_*.c`).** Nothing is keyed to `CatTest`: the
fill is by instance name, on whatever clip the renderer plays, on every prerender.

- **`CatParts::prerender()` 0x742350** (vftable 0xed6a30 slot 19; type id 0x1cc, size 0xa90) walks the renderer's root
  clip with `DisplayObjectContainer::IterateChildren(fn, namedOnly = 1)` 0x99c270 (vtable slot 14 — recursive through
  nested and unnamed sprites, visiting named instances only; a matched slot's subtree is skipped; re-resolved every
  prerender, no cache). The visitor `prerender::<lambda_2>` 0x742bd0 dispatches on `DisplayObject+0x48` (the name):
  `body tail arm1 arm2 arm1_claws arm2_claws leg1 leg2 head bhead head<face> headblend<face> weapon trinket`
  (optionally prefixed, e.g. `other_`); unknown names return 0 (ignored); a missing slot is simply not drawn.
- **The slot helper 0x741f10 `(holder, child, material, CatParts*, flip)`** makes the slot sprite host a
  `glaiel::swf::ReferenceRenderer` (vftable 0x112ed30) whose target `+0x98/+0xa0` is CatParts' own per-part holder
  container (`this+0x8b0…`, one per part, holding the `catparts.swf` symbol instance — `CatBody/CatLeg/CatTail/CatHead`
  … — already `gotoFrame`'d to the cat's part index, with `tex`/`scars`/`aux` children, palette and face applied):
  ```
  if ((child+8 & 0x20) == 0 || child->childCount(+0xac) == 0) {   // hidden, or no children: the CREATE path
      child+8 |= 0x20; removeChildren(child);                      // drop the placeholder art
      ref = new ReferenceRenderer (DisplayObject ctor 0x9b08b0); ref+0x98 = holder container; ref+0xa0 = generation;
      addChild(child, ref, true);                                  // children[0]
  } else {                                                         // the ELSE path: "already converted"
      ref = child->children[0];   ref+0x98 = holder container;     // 0x741f5a / 0x741f5d
  }
  ```
  The slot child keeps its own timeline matrix and cxform; the reference draws the cat's actual part in place.
- **Why A0 crashed.** `DisplayObject_ctor` 0x9b08b0 sets bit 0x20 (visible) by default; children are stored by depth
  (`setChildAtDepth` 0x999e40: `children[depth] = child`, holes zero-filled). Our slot sprites were visible and
  non-empty (a shape at depth 1 → `children[0]` is a depth hole, NULL) → the else path → `MOV [RBX+0x98],RAX` at
  `+0x741f5d`; a bare DefineShape in a slot has no child vector → the read fault at `+0x741f5a`. Vanilla's slot
  sprites are visible and non-empty too, but each is bound by SymbolClass to a Flash class (`catanis_fla.AniTail_5`,
  `AniLeg_6`, `AniBody_7`, `AniFace1_8`) whose frame-1 script calls `setInvisible()` — `Swf_RunFrameScript5` 0xa51fd0
  clears bit 0x20 for that call name — so a vanilla slot arrives **hidden** → the create path.
- **The rule for mods: every slot is an EMPTY named 1-frame DefineSprite** (ShowFrame + End; `count == 0` → the
  create path; the placeholder would be deleted by `removeChildren` anyway). No native code is involved: the
  ReferenceRenderer is created by CatParts itself. The editor emits exactly that for a `parts: "game"` cat rig
  (`cat-rig.ts` `addCatRig(scene, name, { parts: "game" })`; validator `rig-slot-not-empty` / `cat-anim-slot-not-empty`
  for a slot that holds art). The named child the animation driver restarts on every play is `ani`
  (`Character::PlayAnimation` 0x9abda0 → 0x9ac790, `.analysis/notes-catA.md`); vanilla's `pawing` name is never read.

**Experiment A0, resolved (OBSERVED 2026-10-22, `npm run test:artprobe -- --cat-append`; fixture
`editor/test/fixtures/ingame/artprobe-cat-append-summary.json`): appended cat animations work at the data layer with
empty slots.** `mods/_artprobe` exports `_Append_CatTest` (`CatAppendRoot`: `probeIdleF` / `probeIdleB`, each placing
the `CatProbe` rig as the child `ani` at depth 1 at vanilla `idleF`'s offset (77, −959) twips); `CatProbe` is a
`parts: "game"` rig — seven empty slot sprites at the vanilla depths with `idleF`'s own slot matrices (pinned T1 against
catanis.swf) and the checker marker at the non-slot depth 15; `ArtProbeCatReal` = TomTom + `alt_animations [[idle
probeIdle]]`.

- `spawn ArtProbeCatReal`: **no crash** — a second TomTom (gray cat, palette 9, the real parts: face, texture, the
  tail) stands in our frame with our marker above it, mirrored like every enemy clip, at the vanilla idle layout. The
  controls (a vanilla appended label, a missing label) pass as before; the primer (the coloured `CatProbeColours` rig
  as a plain `movieclip` on a Rat, no CatParts) still draws its colours — the fill happens only on a unit that has
  CatParts, i.e. a `_CAT` cat.
- The measure: our marker (a yellow box that is not the primer's; it sits at clip (−48, −330) so it cannot merge
  with the primer's) in the rig shots, and the new near-black pixels in a 350 px window centred on the cat under it
  vs the primer shot (a real cat's outline) compared with TomTom's outline vs the baseline, TomTom located as the
  largest new dark blob inside the arena (`probe-compare.ts` `darkPixelsNear`, `largestChangedRegion { dark, within }`).
  Plain diffs and colour counts are noise here: the move-range overlay toggles between shots and re-tints the units
  it touches, and the HUD (End Turn, portraits) animates (OBSERVED in all three runs; kept in the fixture for the
  record). Run 20261022-063637: TomTom's outline **10946** px; under our marker **11088** (rig 1) and **11695**
  (rig 2) — the same parts; in rig 3 (+160 frames) the cat is in the vanilla hit animation (a `-5` from
  `_autoplay`'s party; the appended idle is replaced for its duration, then comes back), so only the primer's marker
  is found — the fixture asks for our marker in at least two of three shots.
- Earlier runs: 20261021-194143 (our marker in rig 1 and 2 with the cat under it; rig 3 at +200 frames: the cat dead
  in the vanilla death pose) and 20261022-063154 (rig 2 mid-hit). The controls passed every time; every run:
  `real save file(s) unchanged`.
- Conclusion: **the game fills a mod-appended cat frame's slots by name; the only requirement is that each slot is an
  empty (or hidden) sprite.** A native hook is needed only for scoped standalone rig clips (a non-`_CAT` character
  that should get a cat's parts), not for appended cat animations.
- **Animated poses too (OBSERVED 2026-10-22, `npm run test:artprobe -- --cat-wave`, run 20261022-101117; fixture
  `editor/test/fixtures/ingame/artprobe-cat-wave-summary.json`).** `wave` authored with `newCatAnimation` (`waveF` /
  `waveB` on the same donor, placing `wavePose`: a `parts: "game"` rig whose empty `arm1` / `arm2` / `head` slots are
  keyed over its own 30-frame timeline, linear tweens) on `ArtProbeCatWave` = TomTom + `alt_animations [[idle wave]]`,
  no `_autoplay` (nobody acts, so the cat is not hit or moved): our marker in 5/5 shots, the cat's outline under it
  ~10.7k px (TomTom's 11.0k), no slot colour beyond what TomTom's own fur matches, and the outline changes by up to
  10773 px between shots ~130 ms apart vs 4380 for the idle TomTom. The slot sprites' timeline matrices drive the
  game's parts: the arm visibly swings and the head bobs. The nested `ani` plays its own timeline on the held root
  label.

**The back facing and the four-way quartet (2026-10-22; T1-pinned in `editor/test/fixtures/art/cat-back-facing.json`,
`editor/test/art-cat-back-tests.ts`).**
- OBSERVED (read-only parse): a `<anim>B` frame places **its own pose sprite**, not its `<anim>F` partner's. `idleB`
  (sprite 10; `idleF` is sprite 9, both at (77, −959) twips) stacks **`head_back@1 arm2@3 leg2@5 body@7 arm1@9 leg1@11
  tail@13`** — the head behind the body, the tail in front, the far limbs swapped (= `CAT_BACK_SLOTS` in `cat-rig.ts`).
  Across the B frames, `head_back` is in the pose of 356 of 362 CatTest labels and 88 of 91 `_Append_CatTest` labels
  (a plain `head` in 19 / 7: frames that turn the face to the camera); the visitor's `bhead` spelling (0x742bd0) is in
  **no** vanilla cat frame.
- OBSERVED (decompile): **`head_back` is not a separate part.** `CatParts::load_faces` 0x73a990 builds the slot names
  `"head_" + <face>` (list 0x1413c60f0) and `"headblend_" + <face>` (0x1413c6108) for every `catgen.gon faces` entry,
  and the first face is `back { back true }`; the visitor matches `head_<face>` → the head holder `+0x8c8` with that
  preset's flip (`preset+0x4c`) and pose (`ApplyFacePose` 0x740a00). So `head_back` = the cat's own head drawn from
  behind, and `head_faceleft`, `head_dead`, … in vanilla frames are the same head with other face presets.
- OBSERVED (read-only parse): the four-way clips (`MegaFetus` enemies.swf, `Thump` enemies2.swf, `TracyX` enemies4.swf,
  `ManglersMonster` bosses3.swf — the characters with `graphics.four_way_animations true`) carry only complete
  `<anim>LF/RF/LB/RB` quartets; **no CatTest label is four-way**. With the flag, `Character_SetOrientation` 0x10ce50
  appends L/R + F/B and never mirrors the character (catC), so a four-way cat needs a quartet for every animation it
  plays (vanilla idle, walk, hit, … included) or those are silent no-ops; the editor's quartet draws the L frames
  mirrored (sx −1) — INFERRED from the two-way rule (the engine flips exactly the L directions there), not observed.
- Authoring (`cat-rig.ts`): `newCatAnimation` adds a front rig `<name>Pose` and a back rig `<name>PoseBack`
  (`facing: "back"`, the back layout, empty slots); `<name>B` places the back rig. `{ fourWay: true }` emits the
  quartet (LF / RF on the front rig, LB / RB on the back rig). Validator: `rig-back-head` (a back rig with `head`),
  `sprite-facing`, `cat-anim-back-facing` (a B frame placing a front rig or the reverse), `cat-anim-four-way-incomplete`,
  `cat-anim-four-way` (info).
- **In the game (OBSERVED 2026-10-22, `npm run test:artprobe -- --cat-back`, run 20261022-114912; fixture
  `editor/test/fixtures/ingame/artprobe-cat-back-summary.json`): the back rig works.** `ArtProbeCatBackShown` (TomTom +
  `alt_animations [[idle probeBackShow]]`, both labels placing the back rig `probeBackPoseBack` at 1.5x) spawns
  without a crash and is drawn **from behind with TomTom's own parts** — `head_back` filled with the head seen from
  behind (ears, no face), the body, the tail in front of it — at 1.572x TomTom's height (21.6k vs 9.8k dark px), so it
  is our frame, not vanilla idleB. Every run: `real save file(s) unchanged`.
- ~~A non-slot child of the back rig is not drawn~~ — **wrong, corrected 2026-10-22 (backmarker): it is drawn; it was
  out of frame.** See the last bullet of this section.
- ~~Turning a unit away in a test fight is not solved~~ — **solved 2026-10-22** ("Facing: Character::Face"): the
  #105 runs put `lock_orientation` / `start_orientation` under `graphics`, where `Character::init` never reads them
  (they are `properties` keys). OBSERVED (run 20261022-124301, fixture `artprobe-cat-back-summary.json`, all 16
  expects ok, real save unchanged): `face 9 back` turns the spawned ArtProbeCatFacing to `B`, dir (1,0), flip +1,
  and **our 1.5x back rig is drawn on that genuinely back-facing unit** (`face 9 front` afterwards swaps it for the 1x
  front rig: the vanished pose is 1.438x the height of the one that replaced it); ArtProbeCatBack with
  `properties { lock_orientation [1 0] }` spawns on `B` and `face 10 front` leaves it on `B` (effective (1,0)).
- **A B pose keeps every child; the "missing" depth-15 marker was out of frame (OBSERVED 2026-10-22, backmarker).**
  - The engine side. The slot visitor `CatParts::prerender::<lambda_2>` 0x742bd0 starts with `xor r14d,r14d`
    (0x742c06, `45 33 F6`: result = 0) and sets the result to 1 only at the end of a matched slot's path
    (0x743a95, `41 BE 01 00 00 00`). It returns through `mov eax,r14d` (0x743ad8). The only DisplayObject it writes is
    the visited child itself (`child+9` bit 7 at 0x743a90 `41 80 4D 09 80`, and the slot fill through 0x741f10).
    So a name that is not a slot (`marker`) returns 0. `IterateChildren` 0x99c270 then descends into it and nothing
    touches it. `head_back` is matched like any `head<face>` entry: it fills the head slot and skips only that slot's
    own subtree. Nothing keys on the `B` suffix here, and no sibling at any depth is hidden, removed or masked.
  - The pixels. In run 20261022-124301 `shot-shown-2` (a window capture), the checker's lower two thirds sit at the
    top edge of the window, above unit 9: x 1712..1985, y ≈ 8..107. The magenta and cyan cells are at y 27..75. A
    foreground beam of the stage crosses the marker at y 33..47, and the rest of it lies above y 0. It is also tinted
    to ~0.78 (yellow 199,197,0), below the old analyzer's near-#ffff00 tolerance. In `shot-turned-back`, after
    `face 9 front`, it is gone (0 checker pixels).
  - The geometry. The marker was authored at (−48, −330) in a rig placed at 1.5x. Its top lands at
    −47.95 + 1.5·(−330) = −542.95 in the donor, against −377.95 for the 1x front rigs. At ~1.9 screen px per clip
    px, that puts it ~1030 px above the feet, so it is cut off for every unit standing above y ≈ 1030.
  - Fix. `probeBackPoseBack`'s marker is now at clip y −220, which gives the same donor top (−377.95).
    `analyzeProbeShot` accepts a tinted yellow and reports a marker cut by the shot edge as `clipped`.
  - Run 20261022-132159 (window captures, 16/16 expects, real save unchanged; fixture
    `artprobe-cat-back-summary.json`):
    - The marker is found at 1711,240–1986,423, above unit 9, in back 1..3, locked 1..2 and shown 1..2.
    - Its scale is 2.875 px per clip px, 1.5x the front rigs' 1.92.
    - It is in neither `front` nor `turned back`.
  - So a back-pose overlay **can** ride inside the back rig like any front-rig child. Keep it within the frame at the
    rig's placement scale.

### Several mods appending to one clip (2026-10-22)

Static reading of the decompiles already on disk plus five in-game runs (`npm run test:artprobe -- --multi-append`,
probe mods `_catappendA` / `_catappendB` / `_catappendSame`; fixture `editor/test/fixtures/ingame/multi-append-summary.json`).

- **When and how often (OBSERVED, decompile).** `process_animation_merges_caller` 0x9baaa0 loads every swflist entry
  (`app+0x1c0`, 0x9bb9e0 per path), sorts the loaded-SWF array `app+0x118[0..app+0x114)` with 0x9bc690 (comparator
  not read), then calls `process_animation_merges(app, swf)` 0x9bc070 **once per SWF**. That function walks the
  file's SymbolClass list (`swf+0x78`) and, for each entry named `_Append_<T>` with a nonzero id, finds the target
  `T` through the global lookup 0x9bb6f0 (last loaded first), finds the donor by its own id in that file, and calls
  `Swf_Merge(target, donor)` 0xa58440. A target that cannot be found logs `Append movieclip: <name> could not locate
  original movieclip to append to`. So the merge runs once per (SWF, `_Append_` export), all at boot, before any
  instance exists.
- **Accumulation (OBSERVED, decompile).** On the first merge `Swf_Merge` copies the target's timeline (`target+0x60`)
  into `target+0x130`. Every merge, including the first, then appends to that copy: frame count `+0` += donor frames
  (each donor's frames start at the current count); the per-clip file table `+0xa0/+0xa4/+0xa8` grows by the donor's
  files, and every donor place op's byte 1, the file index (u8; so at most 256 contributing SWFs per clip, INFERRED
  from the byte add), is shifted by the old count; the max depth `+4` = max(old, donor); frame 0 gets a remove op for
  each new depth; the keyframe cache `+0xb0..+0xb8` is cleared and the baked byte `+0xc8` reset. A donor that was
  itself a merge target contributes its own merged copy. Nothing is re-copied per SWF; the target grows in merge order.
- **Labels: last merge wins (OBSERVED in-game and in the bytes).** Each donor label goes through find-or-insert
  `0x123a00` (called at **0xa58a1b**) into the merged label map `+0x20`, then a plain store **`mov dword [rcx+0x30],
  esi` at 0xa58a23** (`89 71 30`, esi = donor frame + offset) overwrites any earlier frame. The frame→name map `+0x60`
  (0x9a9ad0 at 0xa58a61) is keyed by the new frame numbers and never collides. In-game: with `-modpaths _catappendA
  _catappendB`, `probeC` (both mods define it) shows B's frame; with `_catappendB _catappendA` it shows A's. The merge
  order is therefore the `-modpaths` order for mod SWFs (the sort at 0x9bc690 kept it for these two). A mod label that
  equals a vanilla `CatTest` / catanis2 label is overwritten the same way: INFERRED, same instruction, not run.
- **Coexistence (OBSERVED).** In both orders both mods' own labels (`probeA`, `probeB`) play their own frames on
  their own cats, with fresh spawns and no hits. Two cat-animation mods can coexist; only shared label names conflict.
- **Same file name (OBSERVED).** `_catappendSame` ships B's content as `swfs/catappendA.swf`, the name `_catappendA`
  uses. With `-modpaths _catappendA _catappendSame`, A's marker never shows and B's content plays: swflist entries
  resolve by file name through the mod paths, later first (debug.log lists the mod dirs in reverse at App.cpp:136), so
  the later mod's file loads for both entries.
- **What PR #124 saw was a measuring artefact, not a merge failure.** A0's marker sits at clip y −330. At game scale
  (about 1.9 screen px per clip px at 3440×1440) that is about 630 px above the feet, so it leaves the top of the
  screen for a cat in the back rows. In the #124 `render-raster-cat` shot the cat stands at y ≈ 410, so its marker
  would be at y ≈ −220. The cat itself looks like the vanilla idle because the rig uses `idleF`'s slot matrices. The
  probe now puts its markers at y −150.
- **Editor side.** `src/core/art/append-conflicts.ts` + `validateMod(…, { modpaths })` / MCP `validate_mod { modpaths }`:
  `swf-file-conflict`, `swf-file-shadows-vanilla`, `cat-append-conflict`, `cat-append-shadows-vanilla`,
  `cat-append-shared` (info). Nothing in our emitter collides: each SWF has its own character ids and file-table
  entry, so ids never cross files.
- **Possible native follow-up (proposed, not built).** A post-hook on 0x9bc070, or a hook at the label store, could
  log every label overwrite with both files' names, or keep the first definition. The validator already covers the
  authoring side, so this is optional.

### SWF loader and display path (closed, 2026-10-21)

RE session `disp` (Ghidra 12.1.4, static scans, the shipped shaders in `.extracted/shaders/`); every decompile cited
is in `.analysis/decompiled/<Name>_<0xrva>.c`, the working notes in `.analysis/notes-disp.md`. The editor turns these
facts into rules: `editor/src/core/art/engine-behaviour.ts` (the constants), `swf-rules.ts` (the loader's rules over
parsed bytes, behind `inspect_swf` and the build self-check), `scene.ts` (the scene-level codes) and
`web/src/art/preview-gl.ts` (what the preview draws); `editor/test/art-engine-rules-tests.ts` pins each one.

**Loader.** `glaiel::swf::SWF::load` `0x9b1d80` (dictionary at `file+0x28`; `dict+0x40` = name → id map); a second
load of a file is FATAL `DOUBLE LOADING SWF`; `ApplicationBase::load_swf` `0x9bb9e0` is FATAL on a missing swflist
file (`SWF File does not exist:`). The tag dispatcher `SWFTag::createTag` **`0xa2e990`** is one `switch (code)`,
OBSERVED complete:

| code | tag | decode RVA | the game does |
|---|---|---|---|
| 1 | ShowFrame | — | accepted |
| 2 / 22 / 32 / 83 | DefineShape 1–4 | decode `0xb72ac0`, init `0xb72c40` (tessellates), instantiate `0xb760d0` | accepted; v4's EdgeBounds + flags are read but **UsesFillWindingRule is never used** |
| 4 | PlaceObject | `0xb77c10` | accepted; a CXFORM is **ignored** (`Warning: color transform not supported on PlaceObject1`) → `place-cxform-ignored` |
| 26 | PlaceObject2 | `0xb77e60` | accepted (Move, HasCharacter, HasMatrix, HasCxform, HasRatio, HasName, HasClipDepth; no ClipActions) |
| 70 | PlaceObject3 | `0xb78210` | blend byte kept (object `+0xb`); **a filter list is FATAL** `ERROR: FILTERS NOT SUPPORTED` → `filter-unsupported` |
| 5 / 28 | RemoveObject / 2 | `0xb78810` | accepted |
| 6 / 21 / 35 / 90 (+8 JPEGTables) | DefineBits / DefineBitsJPEG2–4 | `0xb79d90` (stb_image `0xa8ca40`) | decoded, logs `WARNING: TEXTURE ENCODED AS JPG INSTEAD OF PNG` → `jpeg-bitmap` |
| 20 / 36 | DefineBitsLossless / 2 | decode `0xb7a3d0`, init `0xb7a4e0` | accepted (formats 3 / 4 / 5); atlas-registered via `0xa25950` — size limit below → `bitmap-too-large` |
| 9 | SetBackgroundColor | — | accepted |
| 10 / 48 / 75 | DefineFont / 2 / 3 | `0xa2a4a0` | **only DefineFont3 decodes; 10 and 48 are FATAL** `ERROR: DefineFont version unsupported` → `font-tag-unsupported` |
| 11 / 33 | DefineText / 2 | `0xb78b80` | accepted (static text) |
| 12 | DoAction | `0xa51fd0` | AVM1 `play` / `stop` / `gotoAndPlay` / `gotoAndStop` only (else `UNKNOWN ACTION:`) |
| 37 | DefineEditText | decode `0xb78e50`, init `0xb79410`, instantiate `0xb797e0` | accepted; font *class* string kept (`+0x68`), HTML `<p>` → newline |
| 39 | DefineSprite | decode `0xa576a0`, init `0xa57a50`, instantiate `0xa583d0` | accepted; init compiles the child tags into 0x50-byte frame ops |
| 43 | FrameLabel | `0xb78900` | accepted (FNV-1a label map at `def+0x80`) |
| 56 / 76 | ExportAssets / SymbolClass | **one class**, `0xa58b30` | both write `dict+0x40[name] = id`: ExportAssets binds names exactly like SymbolClass |
| 82 | DoABC | `0xa4a740` | accepted once; **a second DoABC is FATAL** `Multiple DoABC tags in one SWF` → `abc-count` |
| 46 / 84 | DefineMorphShape / 2 | — | logs `WARNING: SHAPE TWEEN NOT SUPPORTED`, then skipped → `morph-shape-skipped` |
| 78 | DefineScalingGrid | — | `default:` → skipped silently, **no 9-slice** → `scaling-grid-ignored` |
| 57 / 71 | ImportAssets / 2 | — | skipped silently: entries never get a dictionary slot (see "Imports are not linked") → `import-unsupported` when entries > 0 |
| everything else (69, 77, 86, 73, 74, 88, 59, 64/65, 87 …) | — | `default:` → generic `SWFTag` whose decode slot is a nop (`0x35bd0`) | skipped, no log line (the `Unknown Tag` string is only the debug tag-name table of `0xa2f4a0`) → `tag-ignored` info for the non-metadata ones |

Tag vtable: 0 dtor, 1 `decode()`, 2 `init()` (lazy, run by `Swf_GetCharacter` `0xa4a190` on first use), 3
`instantiate()` → DisplayObject.

**By-name registry.** `App_FindMovieClipByName` **`0x9bb6f0`**: FNV-1a cache at `app+0x2b8`; on a miss it scans the
loaded SWF array (`app+0x118`, count `+0x114`) **from the last loaded file backwards** through `dict+0x40`, first hit
wins. Consequence (INFERRED, not run in-game): a mod SWF listed later (`swflist.gon.append`) shadows a vanilla
SymbolClass / ExportAssets name of the same spelling for every by-name lookup (characters, `_Append_` targets, UI
clips, `[img]` font icons) → validator info `export-shadows-vanilla` (vanilla names pinned in `vanilla-exports.ts`).

**Render path.** `DisplayObjectContainer` slot 5 `0x998a50` → `RenderChildren` `0x998ee0` (depth order; a child with
a clip depth opens a stencil mask `0xa35430` / `0xa354c0`) → `DisplayObject::Render` **`0x9b0a50`** per child: matrix
stack `0x13c5bd8`, cxform stack `0x13c5be8`, concatenated Flash-style (`mul = child.mul × parent.mul`, `add =
child.add × parent.mul + parent.add`), view-rect cull, then the blend byte dispatch (0 normal, 2 layer, 3 multiply, 8
add, 15 erase, 13 overlay special-cased; the other SWF modes draw normally — INFERRED). Shapes: `ShapeMesh::Render`
**`0xa31180`** (lazy `Tesselator::tesselate` `0xa2f900`, atlas / `default_full` / `default_gradient` material,
batch draw `0xa47e50`).
- **Fill rule: EVEN-ODD per fill style.** `Tesselator::tesselate` `0xa2f900` feeds each fill style's contours
  (`tessAddContour` `0xa73a80`) to libtess2's `tessTesselate` **`0xa73bb0`**, which this build compiles with
  `windingRule = TESS_WINDING_ODD` baked in (`mov [rbx+0x48], edi`, edi = 0, at `0x140a73c69`; `elementType =
  TESS_POLYGONS`, `polySize = 3`). Overlapping sub-contours of one fill style XOR; separate fill styles are
  tessellated and drawn in style order (INFERRED paint order). The SWF fill-winding flag is never read. The editor:
  the emitter still resolves which sub-paths carry the fill (nesting comes out as authored), the preview fills those
  even-odd, and `fill-rule-ignored` warns only where a `nonzero` path's sub-paths cross or self-overlap (a hole
  in-game). `WARNING: EXTRA LARGE VERTEX BUFFER` is logged above a size threshold, not fatal.
- **Fill styles** (`FillStyle_read` `0xb6ebc0`): 0x00 solid; gradients 0x10 linear, 0x12 radial, 0x13 focal radial
  (records `0xb70b30`, focal `0xb70cf0`); bitmaps 0x40 (repeat) / 0x41 (clipped) smoothed, 0x42 / 0x43 their
  pixel-snapped twins. **Gradients pad only**: `GradientAtlas::AddGradient` `0xa28500` → `RasterizeRow` `0xa27de0`
  rasterizes 256 texels over t ∈ [0,1] (interpolation mode honoured, linear-RGB branch converts sRGB) and neither it
  nor `default_gradient.shader` / `swf_lib.shader` has reflect/repeat arithmetic → `gradient-spread-ignored`.
- **Line styles** (`LineStyle_read` `0xb6f220`): width, LineStyle2 caps / join / miter (8.8) / NoHScale / NoVScale
  / PixelHinting / NoClose, HasFill strokes. Caps OBSERVED honoured in-game; **joins, miter and hairline (width 0)
  remain unknown** (parsed, not traced through the outline builder `0xb74fb0` / `0xb748a0` / `0xb74d60`).
- **Bitmaps / atlas** (`BitmapFillAtlas.cpp`): page size = setting **`texture_atlas_size`** (default 0x1000 = 4096,
  read in `LoadNeededTextures` `0xa241a0`); pages are layers of a `GL_TEXTURE_2D_ARRAY` bounded by
  `GL_MAX_ARRAY_TEXTURE_LAYERS` (`initGraphics` `0x9b5ed0`, logged `Max Texture Layers N`). `fit_texture` **`0xa24540`**
  is FATAL `Bitmap Fill could not fit into atlas` for a bitmap whose width or height is **≥ the page**; otherwise
  shelf-packed, `AddLayer` `0xa24bb0`, mipmapped upload `GenerateAllTextures` `0xa252a0`. Sampling (`swf_lib.shader`):
  `textureLod` LINEAR + mip (bias −0.5) for 0x40 / 0x41, `clamp_to_nearest` mip 0 for 0x42 / 0x43; repeat =
  `mod(uv,1)`, clipped = `clamp(uv, .5/size, 1−.5/size)`; stored premultiplied, un-premultiplied in the shader. The
  emitter writes 0x41 → LINEAR + clamp, what the probe saw. Editor constant `TEXTURE_ATLAS_SIZE` → `bitmap-too-large`.
  **OBSERVED in-game 2026-10-22** (`npm run test:artprobe -- --raster`, run `20261022-134011`, fixture
  `artprobe-raster-summary.json`; `src/core/art/probe-raster.ts`): a raster-only character clip draws; 0x41 blends
  between magnified texels (37 % of a ×32 red/blue stripe's row purple) and 0x43 does not (1 %); 0x40 repeats outside
  the bitmap (7 crossings over 4 periods of a 2×2 tile, strongly blended at 8 clip px per texel); a 1-texel checker
  minified to ≈0.43 screen px per texel is flat gray (σ 3.5: mipmapped). The editor now writes all four fill types
  (`scene.bitmaps[id].repeat / smooth`, `raster.ts bitmapFillType`). Vanilla census (T1, `vanilla-raster.json`): 22
  files carry bitmaps, all lossless format 5, none JPEG, max 3373×2784; `backgrounds.swf AlleyBGTest` = one 2000×1500
  plate per frame at 0.7667 from (0,0). A `tilesets.gon.merge` `alley { combat_background <ModClip> }` with a 1-frame
  plate clip replaces the arena picture (`mods/_bgprobe`). `DefineBitsLossless_init` 0xb7a4e0 has branches for formats
  3 / 4 / 5 only → `bitmap-unsupported-format` for any other (INFERRED: no pixels).
- **Palette + cxform order** (`shaders/paletted_full.shader`): `out = compute_color_full(v)` → if `r≈g≈b` (±0.001)
  `out.rgb = texelFetch(palettemap, (r·15+.5, palette))` → **`frag = out × color_xform[0] + color_xform[1]`**. The
  concatenated PlaceObject cxform applies **after** the palette remap; `default_full` is the same minus the remap.
  The preview's shader is this order (both renderers; pinned by `remapColor`'s test).
- **Mirroring**: nothing in glaielswf flips by itself; a negative x-scale on an ancestor (`SetPosScale` `0x9b16c0`,
  `SetVariable("_xscale")` `0x99b590`, `UpdateMatrix` `0x9b1750`) propagates through the matrix stack. **Autoflip**
  (`+0xa` bit 2, set only by AS3 `SetAutoflip`) un-mirrors text / UI clips under a mirrored parent. Facing is a
  label-suffix convention in game code (`Character_FacingSuffix` `0xf0490`).
- **Text**: `DefineEditText::decode` `0xb78e50` keeps the font class string; `init` `0xb79410` resolves a font id via
  `Swf_GetCharacter` and pre-parses the HTML; `instantiate` `0xb797e0` → `DynamicTextBox` `0x98d910`.
  `data/font_remap.gon` (`0x746a80`) remaps font class names. **The exact font-class → font lookup RVA is unknown**
  (candidates `0x9bb910`, `0x98d910`). TextBox markup (`0x994080`): `[font]`, `[size]`, `[color]`, `[outline]`,
  `[style]`, `[animation shake|wave]`, `[img X]` → clips `FontIcon_X` / `RawFontIcon_X` / `X` by name (`0x9bb6f0`).

**MovieClip model** (`0x9a8720` update / `0x9a80c0` nextFrame / `0x9a88a0` gotoFrame / `0x9a8f30` op applier).
Every clip, nested or root, advances on its **own accumulator** (`+0x30`, `dt × timescale +0xe4`) — the OBSERVED
own-clock nested sprites. The root clip of a character is label-driven: `Character::PlayAnimation` `0x117060` →
`AnimStateMachine::PlayAnimation` **`0x9abda0`** (checks `hasLabel` `0x9a8e80` + the alias table `0x9acc20`) →
`gotoAndPlay(label)` `0x9a8b30` / `gotoAndStop(label)` `0x9a8c00`; **an unknown label is a silent no-op**. Frame
interpolation (`interpolate_movieclips`, `0x12fbb7c`, Settings `0x745b70`) only applies to clips whose DoABC calls
`EnableInterpolation` — a no-ABC mod clip never interpolates (INFERRED default). AS3 names the engine honours in frame
scripts (`DoABC::decode` `0xa4a740` → `AVM2Bytecode::RunObjectScript` `0xb7f2b0`): `stop`, `play`, `gotoAndPlay` /
`gotoAndStop` (int or label), `random`, `floor`, `setRandomFrame`, `startAtRandomFrame`, `setInvisible`,
`setCanIgnoreMasks`, `setUseDefaultShader` / `setUseShader`, `SetAutoflip`, `Enable` / `DisableInterpolation`,
`Enable` / `DisableLoopInterpolation`, `SetTimescale`; anything else logs `PARSE ERROR CALLING FUNCTION OTHER THAN
addFrameScript` / `UNSUPPORTED INSTRUCTION:`. Manifest-ready prologues for these functions are in
`.analysis/notes-disp.md` "Manifest-ready rows" (the two `goto*Label` twins differ only at their tail).

**Clip-name remap through `data/tilesets.gon` (OBSERVED in-game 2026-10-22).** `ResolveClipName` **`0x7bdbb0`**:
`node = tilesets[<current tileset, game+0x14f8>][name]`; a string node is returned, else `name` itself when the
fallback is `"auto"`. `CharacterGraphics_build` `0xf1150` calls it with `(graphics.movieclip, "auto")` before the
SymbolClass lookup `0x9bb890`, for every **non-cat** character (the `_CAT` branch does not pass through it);
`TacticsTest::init` uses it for `battlefield_postprocess_effect`. `tilesets.gon` (loaded once in `SpawnDatabase_init`
`0x7a74b0`, so overlays apply) holds one flat object per tileset (22 in this build: `alley`, `junkyard`, `sewers`, …,
`house`, `tutorial`, `finalboss`) whose key namespace is shared with the slot names (`combat_background`,
`static_*`, `debris`, `event_piece_frame`, `reverb`, `global_objects`); vanilla uses it for
`non_interactive_objects.gon`'s `static_1x1_a` / `static_tall_a`. So a `data/tilesets.gon.merge` adding `<tileset>
{ Rat MyModRat }` per tileset redirects `graphics.movieclip Rat` to a mod SymbolClass without touching `enemies.gon`.
**OBSERVED 2026-10-22** (`mods/_tileprobe`: `alley { Rat ArtProbe }`; TacticsTest plays in alley): after `spawn Rat`
the `_artprobe` ArtProbe clip is drawn (probe marker in both post-spawn shots, scale 1.72, mirrored, the ArtProbe
enemy's own screen box 2528..2692 × 781..890; none in the pre-spawn baseline) — run
`20261022-090748-_tileprobe-render-tileset-redirect`; the control without the overlay
(`20261022-090756-_artprobe-render-tileset-control`) draws the vanilla Rat, no marker. Both pass, real save unchanged;
fixture `artprobe-tileset-summary.json`. No vanilla tileset has a key `Rat` (T1). `docs/data-mods.md` has the recipe.

**Hook seams** (for a future native "alias animation" or clip redirect): `AnimStateMachine::PlayAnimation` `0x9abda0`
(label by `std::string*` in rdx, 7 callers, plain prologue), `gotoFrame` `0x9a88a0` (116 callers, every frame change),
`createTag` `0xa2e990` (the one place to add a tag), `App_FindMovieClipByName` `0x9bb6f0` (the by-name seam). The
render-side flip and the palette uniform are per-frame hot paths, not hook targets.

## Dev scenes and run entry (static decode + Ghidra, 2026-10-20)

How the harness enters a fight from the main menu (`enter TacticsTest`, `docs/ingame-testing.md`). Every address is
build 25143593; the function ones are in `bindings/25143593.json` (`FW_SYM_*` v4) with signatures and anchors.

- **The dev menu's entries are component classes.** Under `-dev_mode true` the dev menu lists scene drivers by
  class name — `TacticsTest`, `LevelAutoPlay`, `LevelAutoPlay_Kaiju`, `BreedingTest`, `DebugScene`, `ShopScene`,
  `Tutorial`, "Kaiju Fight Rapid Sim", plus house-boss `.lvl` and world `.gon` names (`.rdata` 0xf0c2e0…). Each
  class has an RTTI `.?AV<Name>@glaiel@@` and a 171-byte `IsA(name)` (`TacticsTest`: 0x31add0). `TacticsTest`:
  TypeDescriptor 0x134fc50, COL 0x1167810, vftable 0xf0f4b8, ctor 0x31c5f0 (no `.pdata` entry).
- **`AddComponent<TacticsTest>(Scene*, Entity*)` 0x31c3e0** (520 bytes): pool alloc 0x120 bytes, ctor, attach, push
  into the scene's two component arrays, then `TacticsTest::init(this, "blank", 0, 0, 0)` 0x833390 (345 KB; the
  sole referrer of the console-command names `bind`, `load`, `win`, `battle`, `spawn`, `spawntile`, `champion`,
  `elite`, `status`, `passive`, `killall`, `takeover`, `noui`, `equip`, `weather`, `benchmark`, …).
- **The dev-menu button** (`std::function` body 0x32fc00; 0x32fd40 is its sibling with `+0x784 = 4` instead of
  `+0x78c = 1`) reads two captures and does, in order: `d = Component::GetGame(menu)` (0x908e0 — **type id 0x50c is
  `MewDirector`**: the component of that type on the component's scene, else on the manager's main scene);
  `d->+0x780 = 1; d->+0x78c = 1`; `cap1->+0x5a8->{+0x410,+0x428,+0x440} = menu->+0x5c` (a widget value);
  `cap1->+0x6dc = 1`; `menu->scene->+0x4db = 1` (closes the menu's scene); reseeds the RNG (`0x94f0a0(TLS+0x178)`);
  `battle = SceneManager::CreateScene(menu->+0x28, "Battle")` (0x9d4950: pool-allocates a Scene, name at +0x4b8,
  `+0x4b0` destroyed flag, pushes it into the manager's vector at +0..+8; by-value string, callee destroys); if the
  scene is not destroyed: `e = Scene::CreateEntity(battle)` (0x96b3e0; NULL when +0x4b0 is set) and
  `AddComponent<TacticsTest>(battle, e)`.
- **Component layout used:** `+0x18` entity, `+0x20` scene, `+0x28` scene manager (= `*scene`, the scene's first
  field). Scene manager: `+0..+8` scene vector (begin, end), `+0x18` main scene.
- **`MewDirector::init(this, std::string name)` 0x3a6b90** sets the global `DAT_1413dac30` (`FW_DATA_MewDirector`)
  and `DAT_1413dac38 = *(this-8)` (pool generation), and asserts **"More than one mew director"** when the global
  is set and its generation still matches. Three creation helpers: 0x1be1a0 (name argument; the save-slot path),
  0x31c1e0 (`housetest01.sav`; dev-menu house-test buttons 0x317230/0x317c50/0x318b50), 0x758650 (`test00.sav`;
  the boot path 0x750f90 ← 0x748200 ← 0x7469b0, which also creates the `DebugOverlay`/`ToolTip`/`PostProcess`/
  `PauseMenu` scenes and then either plays `game_intro` or, in dev mode, calls 0x3af490(director)).
- **OBSERVED at the main menu of a dev launch (harness, 2026-10-20):** 6 scenes — `Shared` (the manager's main
  scene), `Base`, `DebugOverlay`, `ToolTip`, `PostProcess`, `PauseMenu` — and no MewDirector yet (type 0x50c count 0
  on every scene; the global is NULL) **until the game's own load-complete path runs a few frames later**: with
  `dev_mode` set, 0x750f90 (← 0x748200 ← 0x7469b0; caller chain from a hook on `MewDirector::init`:
  `exe+0x758834 ← exe+0x751886 ← exe+0x748395 ← exe+0x746a73 ← exe+0x9ba2cb`) creates the test director on
  `test00.sav` (c3) on the main scene, adds the `Tutorial` scene and calls 0x3af490(director) (sets `+0x78d = 1`,
  creates a `House` scene with its driver 0x3c43a0). Without `dev_mode` it plays `game_intro` instead.
- **`MewDirector::DebugGenAdventureCats(this, TeamType, int)` 0x3b24c0** (what `TacticsTest::init` uses for the
  party): if `director->+0x78c` is set it reads the saved winning teams from the save (0x231e20) and returns when
  there are any; otherwise it warns `no saved winning teams - win at least one run first!` (0x9522c0 = log +
  modal MessageBox "WARNING" — the frame loop blocks until it is closed) unless `+0x784 != 0`, clears `+0x78c`,
  and **generates a party** anyway. The dev-menu button sets `+0x78c = 1` (play with the last winning team); the
  harness leaves it 0 so a fresh `test00.sav` gets a generated party with no popup.
- **The entry that works (`mods/dev-sandbox/tests/enter-fight.mewtest`, harness `enter TacticsTest`):** wait for
  the game's director (retry per frame; never create one — an earlier attempt that did raced the game's own
  creation and hit "More than one mew director", the no-return assert → the harness's crash path), set `+0x780 = 1`,
  `+0x78c = 0`, `+0x6dc = 1` on it, `CreateScene("Battle")`, `CreateEntity`, `AddComponent<TacticsTest>`. Result:
  `listcmds` grows from 11 to 84 commands (`editor/test/fixtures/ingame/console-tacticstest-listcmds.txt`),
  `TurnControl::NextTurn` fires (round 1) ~25 frames later, `dump` lists 6 units (`result-enter-fight.jsonl`:
  e.g. `Antonieta/Thief`, `Shadok/Mage`, faction 1; the unit walk `TurnControl+0x18 → Scene+0x8 → EntityManager
  +0x20 → +0x1f90` verified on a real fight). With `seed 42` the fight starts with 8 units (the party plus four
  Coins); spawned enemies append in spawn order. The dump's `faction` is 1 for the party (`allies`), 0 for Coins and
  2 for `enemies` (OBSERVED 2026-10-20, `result-golden-{vanilla,merge}.jsonl`); its `name` is the localized
  `graphics.name` row, so a `.merge` on `graphics.name` plus a `combined.csv.append` row is visible there, and
  `spawn <Entry>` accepts an entry added by an `enemies.gon.append`. Other facts from the attempts: without a director `TacticsTest::init`
  crashes at `+0x835a32`; `Scene+0x4db` is zeroed by `CreateScene` and set by the dev-menu buttons on their own
  scene (not the being-destroyed flag, which is `+0x4b0`).
- **The campaign route (wired 2026-10-20 as `enter Campaign`):** the save-slot click is the `std::function` body 0x1c06c0 (`scene->+0x4db = 1`,
  `GetGame`, 0x94eba0, `AddComponent<MewDirector>(mainScene, e, slotName)` (c1), then `MewDirector::start`
  0x3aefd0, which reads `game_began` / `on_adventure` / `house_night` from the save and creates `House` (0x3c3ee0)
  or resumes the adventure (0x3bbff0)); the director's own battle starter 0x3b1830 (`FindScene("House")`, act from
  a GON node into `+0x6dc`, `CreateScene("Battle")`, `AddComponent<TacticsTest>(battle, e, levelName)` 0x3c4e60 —
  the variant that takes a level name); `TacticsTest_restart` 0x3c5570 (an `EventScene` + team generation
  0x2e3720 with `TeamType 1, 4`).
- **Save safety of the route:** only `test00.sav` is ever named (hard-coded in 0x758650, and now only by the game
  itself); `savecheck.ts` allows that family; every run ended with `1 real save file(s) unchanged`.
- **`enter Campaign house` (OBSERVED 2026-10-20, `mods/dev-sandbox/tests/enter-house.mewtest`):** the intro is
  interactive (`BeaniesIntroSequence`, 0x3c4130's component; `data/npc_scripts/beanies_gameintro.gon` waits for
  `choose_cat1` / `choose_cat2` / `reject_cat`), so it never ends on its own. The new-game branch 0x3af310 first writes
  the save property `game_began = 1` through `SaveProps_GetOrCreate` 0x61ea0 (`(director+0x38 map, out, std::string*
  key)`; FNV-1a hashed, a 0x38-byte node, value at `+0x30`), runs the same four loaders as the resume path, sets three
  settings flags and creates `Cutscene` + the intro driver. `MewDirector::start` 0x3aefd0 resumes when `game_began`
  exists: `on_adventure` absent → `CreateScene("House")` + the campaign House driver 0x3c3ee0 (`house_night` as its
  flag). The harness writes `game_began = 1` on the new director before calling `start` → the real House on day 1 with
  no cats (the intro would have added them) and the neighbor's tutorial dialogue. Not taken: the dev start 0x3af490
  (`+0x78d = 1`, a `HousePlaceholder` driver 0x3c43a0 — a different house; its callers are the load path and two
  director functions 0x3b4750 / 0x3b5430). `SceneManager` name-match 0x9d4bc0 only marks a scene `+0x4d8`
  (destroy-next); not needed on this route. Decompiles: `newgame_branch_0x3af310.c`, `save_prop_getorcreate_0x61ea0.c`,
  `intro_driver_0x3c4130.c`, `house_{dev,campaign}_driver_0x3c43a0/0x3c3ee0.c`.
- **`enter Campaign` (OBSERVED 2026-10-20):** the harness replays 0x1c06c0 minus the `+0x4db` flag (no save-select
  scene exists): `Entity_DestroyOwnerOf` 0x94eba0 on the test director (marks its entity destroyed, destroys each
  component through vtable+0x38 and bumps the generation at `component-8`, which is exactly what
  `MewDirector::init`'s "More than one mew director" check compares against `DAT_1413dac38` — so the global may
  still point at the old director when the new one is created, and does: "global after destroy" = old pointer),
  `Scene_CreateEntity` on `SceneManager+0x18` (main scene), `AddComponent_MewDirector_named` 0x1be1a0 (copies the
  `std::string*` it is given; `MewDirector::init` → `MewSaveFile::open_or_create("mewtest01.sav")`), then
  `MewDirector_start` 0x3aefd0 (`+0x78e = 0`, `game_began` absent → 0x3af310: a `Cutscene` scene with the intro
  driver 0x3c4130). The global then points at the new director. Bindings: `FW_SYM_Entity_DestroyOwnerOf`,
  `FW_SYM_AddComponent_MewDirector_named`, `FW_SYM_MewDirector_start`. The slot name is arbitrary (the game uses it
  as the file name under `<userdata>\saves\`); `mewtest01.sav` was chosen because no slot list produces it.

## Maps, rooms and level files (2026-10-22)

RE session `rooms` (Ghidra 12.1.4, build 25143593); decompiles in `.analysis/decompiled/` (names below), notes in
`.analysis/notes-rooms.md`. The modding recipe is `docs/data-mods.md` "Maps, rooms and encounters".

- **`.lvl` format (OBSERVED, all 2361 vanilla files re-encode byte for byte, `editor/src/core/level/lvl.ts`,
  `test/level-tests.ts` T1):** little-endian `u32 version (2; four old test levels 1), u32 width, u32 height, u32 1,
  u32 objectCount, u32 0, u32 0, u32 width, u32 height, str objectPalette "spawns.gon", str tilePalette "tiles.gon"
  ("" in v1), u32 0, u32 0`, then `width*height` row-major u16 tile ids (`data/tiles.gon`), then `objectCount` ×
  `u16 x, u16 y, u32 id` (`data/spawns.gon`), then `u32 0`. A cell or object id `0xffff` is followed by `u16 n` and
  n × `u16 id, u16 weight` (a weighted random pick, id 0 = nothing). Strings are `u32 length` + bytes. Every vanilla
  level is 10x10. `Level_decode_palettes` 0x376230 sets the palette names (literals "spawns.gon"/"tiles.gon").
- **`Level::init` / load `0x35aaf0`** (`Level_LoadFile_0x35aaf0.c`): `"levels/" + name + ".lvl"` through the file
  manager; the function also holds `levels/missing.lvl` (`.rdata` 0xf12778), the name "missing" and a
  "does not exist" message (INFERRED: the fallback for a missing level). So a mod's new `levels/<path>.lvl` is a loadable level by name (the same resolver as every data file).
- **Console `load <arg>` = `TacticsTest_cmd_load` 0x888870** (TacticsTest::init lambda, registered with the run
  commands): `FileExists("levels/" + arg + ".lvl")` (0x9a14c0); when absent, `FileManager_ListDir` 0x9a1900
  (`"levels"`, `".lvl"`, recursive = 1) and keep the paths ending in `arg + ".lvl"` (one → load it). OBSERVED
  2026-10-22: `load roomprobe/probe` loads the mod's `levels/roomprobe/probe.lvl`; `load rp_nested_find` finds the
  mod-only `levels/roomprobe/deep/rp_nested_find.lvl` (`mods/_roomprobe`, fixture `roomprobe-summary.json`).
- **`FileManager_ListDir` 0x9a1900** (`FileManager_ListDir_0x9a1900.c`; `(fm=&DAT_1413c5650, out, dir, ext,
  recursive)`): walks the pack's path set (`fm+0x1c0`, prefix `dir/`, suffix `ext`, direct children only unless
  recursive) **and then every `-modpaths` dir** (`fm+0x268..0x270`, 0x20-byte strings): `std::filesystem::exists(mod +
  dir)` then a directory iterator (non-recursive: FindNextFile until 0x12; recursive: `recursive_directory_iterator`),
  merged into one sorted set. **So every listing the game does sees mod files**: SpawnDatabase_LoadGonDir 0x7c0cb0
  (`data/characters`, `data/abilities`, …, `data/maps` — a mod's *new* `.gon` there is loaded), the level pools and
  the console search. (Correction to "GON text pre-pass": `data/characters` *is* enumerated, by this function.)
- **Map level pools — `MapLevelPool_build` 0x394450** (`MapLevelPool_build_0x394450.c`, with 0x395930 / 0x3968e0 for
  the boss / miniboss paths): reads the map GON (`map+0xb8`): `levels.folder`, then `levels.<pool>` (`easy`, `rare`,
  …) as sub-folder names, builds `"levels/" + folder + "/" + sub` and lists it with 0x9a1900 (`".lvl"`, recursive 0);
  candidates go through the director's level registry (`director+0x590`, 0x8dda40 / 0x8ddec0; INFERRED: "already
  played"), and the `easy` path also reads the map's `chapter_id` and a random roll (not decoded further). OBSERVED 2026-10-22 ("Campaign walk" below): a pool that names a mod-only sub-folder hands the battle that folder's `.lvl` (`levels/alley/walkprobe/wp_alley.lvl`).
- **Map files**: SpawnDatabase_init 0x7a74b0 lists `data/maps` (0x7c0cb0) but only folds each map's
  `enemy_pools.medium` into a global list (`+0x13c0`); a run loads a map by path, `"data/maps/" + name` →
  `Gon_LoadFile` 0x611a0 (`MewDirector_maps_3b0d20` 0x3b0d20), name = an exit node's `next_map`. `data/maps/alley.gon`
  is a literal at 0xf0c250 (INFERRED: the run's first map). `chapter_id_enum.gon` is read into a name → position map
  (`SpawnDatabase+0x15b8`) and a vector (`+0x15f8`); the file says it mirrors a C++ enum in MewDirector.h (INFERRED: a
  new chapter id has no C++ meaning).
- **Node types are hard-coded — `MapNode::str_to_type` 0x225680** (`MapNode_type_225680_0x225680.c`): none 0, npc 1,
  enter 2, exit 3, home 4, battle 5, hard 6, miniboss 7, boss 8, event 9, optional_event 10, special_event 11, shop 12,
  treasure 13, furniturebox 14, foodbox 15, bonus 16, empty 17, any 18; anything else →
  `Fatal_Error` "No node type named: " (MapNode.cpp). The validator's `map-node-type-unknown`.
- **Tilesets**: `data/tilesets.gon` is one GON (`SpawnDatabase+0xa88`, overlays apply); `default_tileset` → the
  current tileset string `+0x14f8`; the console `tileset <name>` sets it. OBSERVED 2026-10-22: a new name added by
  `tilesets.gon.append` (`roomprobe_yard`, a junkyard copy) selected with `tileset roomprobe_yard` draws the junkyard
  background around the next `load`ed room (run `20261022-131707-_roomprobe-new-tileset`, shot `roomprobe_yard`).
- **Tile art (read-only look at `tiles.swf` + the exe's string table, 2026-10-22; no decompile):** `tiles.swf`
  exports one clip per tile class under the class name (`WaterTile`, `GrassTile`, `FireTile`, `IceTile`, `MetalTile`,
  `RockTile`, `CreepTile`, `OilTile`, `LavaTile`, `ShadowTile`, `GlassTile`, `SnowTile`, `DirtTile`, `RoadTile`,
  `BrambleTile`, `FlowerTile`, `StalagmiteTile`, …), each registered at the diamond's centre. Classes without a clip of
  their own name have one the string table holds next to them: `ToxicTile` → `ToxTile`, `TallGrassTile` →
  `TallGrassBack` / `TallGrassFront`, `TallFlowerTile` → `TallFlowerBack` / `Front`, `TallBrambleTile` →
  `TallBrambleTileBack` / `Front`, `FloatingGlassTile` → `FloatingGlassTileBottom` / `Front` (INFERRED pairing; the
  Room editor's `TILE_CLIP_ALIASES`). `WaterTile_Current` derives from `WaterTile` (RTTI) and is drawn as it
  (INFERRED). `SupercooledWater` and `GlitchTile` have no clip in `tiles.swf`; `BlankTile` draws nothing. The
  shader-filled tiles (water, ice, lava, creep, oil, toxic) fill their surface with pure magenta `#ff00ff` (INFERRED:
  a key the tile shaders replace). `data/tilesets.gon` has no per-tile-class art slot; its only tile key is
  `water_alt_tile BloodTile` (meatworld, theend; INFERRED to replace the water clip). The `SetTilesetFrame` string
  belongs to the map screen / CatParts UI (`MapScreen_init_0x38d150.c`), not to tiles. Pinned by the T1 test in
  `editor/test/level-art-tests.ts` (every `alley` tile id resolves to a clip or a named reason; the clips render).
- `"No room named: "` (0x2e8d50) belongs to `FurnitureGrid::init` (the house's rooms), not to combat levels.

## Campaign walk (2026-10-22)

RE session `walk` (Ghidra 12.1.4, build 25143593); decompiles in `.analysis/decompiled/` (file names below), notes in
`.analysis/notes-walk.md`. The harness drives it with `run start` / `run travel <type>` / `run fight` / `expect level`
(`docs/ingame-testing.md` "Campaign walk"); bindings: the walk block at the end of `bindings/25143593.json`.

- **`MewDirector::GoOnAnAdventure(std::string map, TeamType, int, bool debug)` 0x3b01c0** (OBSERVED name: RTTI lambda
  `.?AV<lambda_1>@?1??GoOnAnAdventure@MewDirector@glaiel@@QEAAXV?$basic_string…W4TeamType@3@H_N@Z@`;
  `MewDirector_StartDebugAdventure_0x3b01c0.c`). `debug = false` (the House's door / the house-test dev buttons
  0x317230 / 0x318db0 with `"alley.gon"`): destroy-next the House, generate the strays, `CreateScene("ClassChooser")` —
  the interactive class pick. `debug = true` (the event-debug dev button 0x32efc0 with `"eventdebug.gon"`):
  `DebugGenAdventureCats(TeamType, n)` 0x3b24c0 (a generated party, no popup while `+0x78c` is 0) and then the start lambda
  0x3b0550 directly: destroy-next `House` (0x9d4e00), **`StartAdventure` 0x3b38c0(director, map, debug)** =
  `CreateScene("Map")` + `AddComponent<MapTest>` 0x3c5210 → `MapTest::init` 0x39df90 → `AddComponent<MapScreen>`
  0x39e570 → `MapScreen::init`, then `Gon_LoadFile("data/maps/" + map)` for `innate_weather` / `chapter`, save prop
  `adventure_started`. The map string is by value (callee destroys). TeamType comes from a `{0,1,2,3}` table at
  `.rdata` 0xee9700 indexed by the dev widget; the harness passes 1 (INFERRED meaning; the party is generated either way).
- **`MapScreen::init(std::string map, bool)` 0x38d150** (`__FUNCSIG__` 0xf14040; `MapScreen_init_0x38d150.c`):
  0x21ae00 (INFERRED: `load_map`), `generate_map` 0x21ca60 (`__FUNCSIG__` 0xeff8f8), then the start node = the first node of type
  2 (enter) — else the fatal "Map generated without a start node somehow"; the marker component (0x39b2f0) goes to
  **`+0xa0`**, its `+0x80` std::function is the on-arrive lambda **0x39b180** (`MapScreen_EnterNode_caller_0x39b180.c`):
  unless the nemesis check 0x392ed0 fires (a nemesis marker at `+0xa8` on the same node) or **`node+0x168`** is set,
  `EnterNode(mapScreen, node)`. Nodes: glaiel vector **`+0x78` cap, `+0x7c` count, `+0x80` MapNode** data**. Map GON at
  `+0xb8` (`levels`, `groups`, …). OBSERVED: alley.gon generates 22 nodes / 39 next edges; the marker starts on the
  enter node (#19).
- **MapNode** (`MapNode_load_0x21dbc0.c`, `MapNode_load_connections_0x227df0.c`): `+0x50` std::string `level`
  (a fixed level, e.g. the treasure nodes' `level TreasureHard`; MapLevelPool_build's `param_4+0x50`), `+0xf0` a
  tileset override EnterNode copies into the current tileset, `+0x114` music layer (-1 = default; INFERRED from its use at 0x151d00), `+0x118..+0x137`
  the node's own 32-byte RNG state (EnterNode copies it into TLS+0x178 — every node rolls the same way for the same
  map), **`+0x138` MapNodeType** (str_to_type order; `MapNode_load` re-rolls typed options), **`+0x140` next edges**
  (glaiel vector: `+0x144` count, `+0x148` data; `load_connections` adds a GON `next` target there with 0x21aac0
  and the reverse edge at `+0x150`; generate_map walks `+0x148`/`+0x144`), `+0x160` the node's display object
  (position `+0x70/+0x74`), `+0x168` done flag. The marker's current node is `marker+0x50`.
- **`MapScreen::EnterNode(MapNode*)` 0x391c20** (RTTI lambda names `…EnterNode@MapScreen@glaiel@@QEAAXPEAUMapNode@3@@Z@`;
  `MapScreen_EnterNode_0x391c20.c`): does nothing while a key is held (SDL keycode 0x400000e1, INFERRED left shift); reseeds the RNG from the node; then by type:
  **5 battle** / 6 hard → `mapScreen+0x1e8 = 1` and, when the transition host `DAT_1413c5ba8` is live, the
  `BattleInTransition` component 0x39b8e0 / 0x39bd20 whose lambda (0x3929e0 battle, 0x39dc90 hard) runs
  **`MapLevelPool_build(mapScreen, out, "easy"|"hard", node, 1)` 0x394450** (`"hard"` when the save flag
  `upgrade_basic_combats_to_hard` is set) and **`MewDirector::StartMapBattle(director, out, …)` 0x3b6d10**; 7/8 miniboss
  /boss → `select_boss_level` 0x395930; 9/10 event, 0xb special event, 0xc shop, 0xd treasure, 0xe furniturebox, 0xf
  foodbox, 3 exit, 4 home (`return` / `return_early` cutscene). Nothing in EnterNode needs a mouse: the harness calls it
  on a node it picks (no path animation; the marker stays where it was).
- **`StartMapBattle(director, std::string levelPath, bool, bool)` 0x3b6d10** (`MewDirector_StartMapBattle_0x3b6d10.c`):
  registers the level in the played registry (`director+0x590`, 0x8dda40), team bookkeeping, hides the Map scene
  (0x9d4c80), `CreateScene("Battle")` + `AddComponent<TacticsTest>(battle, e, level)` 0x31e6e0 (→ `TacticsTest::init(level)`),
  `+0x710 = 1`. The path is the pool's full file path. OBSERVED 2026-10-22: `"levels/alley/walkprobe/wp_alley.lvl"` with
  `mods/_roomprobe`'s `alley.gon.merge` (run `20261022-141225`), `"levels/alley/easy/ch1-82.lvl"` without (run
  `20261022-141324`, `seed 42`); the battle starts ~280 frames after EnterNode (the transition), round 1 fires.
- **Side effect (OBSERVED):** starting the adventure makes the game write a backup of the slot,
  `saves/backups/mewtest01_<date>_<time>.savbackup` (only after `run start`; earlier `enter Campaign` runs left none).
  The real save and every other file are untouched; the backups accumulate (one per minute of runs) — an owner
  decision (TODO.md) whether the runner may move them into the run dir like the slot itself.
- Not driven: the class chooser (debug start skips it), walking the marker along a path, node rewards after the fight,
  exits to the next map. The pool pick itself (`MapLevelPool_build` 0x394450): `levels.<pool>` entries are filtered by
  0x232aa0(`director+0x38` save props, entry) (INFERRED: an unlock check), listed with `ListDir`, run through the
  played registry; the `easy` pool may swap to `rare` on a roll scaled by a director setting (≤ 1/60).

## Glow and outline passes (2026-10-21)

Ghidra session `glow` (container `rea_ghidra_glow`, build 25143593; notes in `.analysis/notes-glow.md`, decompiles
named below in `.analysis/decompiled/`). Addresses are RVAs (image base 0x140000000). The question was "how does the
game draw a glow, and can a mod get one?" The answer: the SWF player has no filter rendering at all, the combat
outline is a hover effect with a compile-time white colour, and the only data-level knobs are a ground light and a
colour transform. Hence the editor's **baked halo** (`editor/src/core/art/glow.ts`, MCP `bake_glow`): an ordinary
shape under the source, which every one of these facts allows.

- **PlaceObject3 filters are fatal (OBSERVED).** `glaiel::swf::PlaceObject::decode3` `0xb78210`
  (`PlaceObject_decode3_0xb78210.c`) reads the 16 PlaceObject3 flag bits; when `HasFilterList` is set it does not
  parse the list — it formats `"ERROR: FILTERS NOT SUPPORTED " + <swf path>` (string `0x113dbc8`, single xref
  `0xb7875d`) on the `SWF_Loading` channel and calls the no-return fatal `0x951ee0` with `{ ControlTags.cpp line
  0x7e, "void __cdecl glaiel::swf::PlaceObject::decode3(void)" }`. Any filter id, any options, the flag bit alone;
  no filter renderer exists in the player, so patching the check out would only skip the error. Pinned at T0 by the
  validator's `filter-unsupported` (`editor/test/art-po3-tests.ts`, `art-glow-tests.ts`) and at T2 by the SWF gate
  variant `filters` (expects `crash`).
- **Post-process pass system (OBSERVED; shared by Battle, House and Lighting).** `ShaderManager::GetOrCreateMaterial`
  `0x9bb5d0` `(mgr, std::string name, std::string shaderFile) → Material*` (FNV-1a map at `mgr+0x278`; an existing
  name is returned as-is, the shader file then ignored; the manager is the global `DAT_1413c4a30`, witness
  `mov rcx,[rip+…]` at `0x834f20`). `Material::SetUniform` `0x9bdbf0` `(mat, name, data, bytes)` with typed wrappers
  vec4 `0x9bde70`, float `0x9bddc0`, vec2 `0x9bdf90`, int `0x9bdd40`, texture `0x9bdcd0 (mat, name, Texture*, slot)`.
  `RendererBase::AddPostProcessPass` `0x979880` `(renderer, Material*, passIndex) → Pass*` (0xa0-byte pass: `+0x10`
  enabled, `+0x0c` `std::function<bool()>` enable predicate, `+0x18..0x58` two rect doubles, `+0x58` blend/flags;
  pushed into `(renderer+0xb0)[passIndex]`); list form `0x979a00`. Pass indices seen: 9 ground lighting, 0x18 mask
  stage, 0x1a composite stage, 0x22 full-screen effect. Files `ShaderManager_GetOrCreateMaterial_0x9bb5d0.c`,
  `Material_SetUniform_0x9bdbf0.c`, `Material_SetTexture_0x9bdcd0.c`, `Renderer_AddPostProcessPass_0x979880.c`.
- **Combat outline pass (OBSERVED in `TacticsTest::init` `0x833390`, inline `0x834e00–0x8359a0`, read as asm).**
  Materials: `ol_blur_x` / `ol_blur_y` = `variable_piecewise_glow.shader` (`axis` (1,0)/(0,1), `radius` 20.0f
  `0x113ff98`, `alpha_cutoff` 0.75f `0x113f75c`, `framebuf` slot 4), one chain at pass 0x18 (`0x83531c`);
  `composite_outlines` = `composite_glow.shader` (`framebuf` slot 6, **`glow_color = (1,1,1,1)`** — four loads of
  1.0f `0x113f83c` at `0x8354d4..0x8354f8`, set at `0x835510`; **`glow_strength = 100.0f`** `0x1140020` at `0x83555a`)
  at pass 0x1a (`0x83558a`). **The string `glow_color` has exactly one xref (`0x8354b8`): the colour is a
  compile-time constant, white, nothing writes it at runtime**; with strength 100 the blurred mask saturates, i.e.
  the pass draws a hard white rim, not a soft coloured halo. A second route: `jumpflood_init`
  (`jump_flood_init.shader`, `alpha_cutoff` 0.75, pass 0x18 at `0x835712`) + `jumpflood_composite`
  (`jump_flood_composite.shader`, `framebuf` slot 6, pass 0x1a at `0x8358c8`). All four passes get enable
  predicates (init lambdas 6–9, helpers `0x8939a0/0x893a00/0x893a60/0x893ac0`, shared `_Do_call` `0x8967b0`
  returning `TacticsTest->+0x58->+0x9c`; INFERRED: one "outline effects enabled" flag).
- **Who gets outlined (OBSERVED driver, INFERRED mask draw).** Right after the passes, init adds a
  `glaiel::ImmediateModeGameUI` component (`0x893b20` → AddComponent `0x896be0`, vftable `0x140f0f4b8`). Its slot 19
  `0x88d780` (`ImmediateModeGameUI_init_0x88d780.c`) is the outline driver: it fetches the scene's `StatusMenu` (type
  id 0x75d via `0x8163b0`), takes the menu's tracked entry (`StatusMenu+0xf8` vector, `entry+0x38` → doubles
  `+0x68/+0xb0` tweened by `this+0x28->+0x30`), transforms that rect through the camera (`0x9b4c90` / `0xa07c70`),
  writes it (±4.0 / 3.5 in 1280×720 units, scaled by the screen size from `DAT_1413c4a30+0xde0`) into the pass rects
  of the passes it holds (`this+0x80` jump_flood_loop passes, one per `offset` 1<<n; `+0x88` composite with `radius`
  and `outline_color`; `+0x90` blur chain; `+0x98` composite_outlines) and flips their `+0x10` enable bytes by mode
  `this+0xa0` (1 = jump-flood on, else blur + composite on). `outline_color` is `DAT_1412f7da0` (white) or, on one
  branch, (0.796, 0.439, 1.0): a hard-coded pair. So the outlined object is the **hovered / inspected unit** (the
  status-menu target), the colour is a constant, and **no per-Character glow/outline field exists**. INFERRED (not
  located): the draw that puts that unit's clip into the mask renderer the blur reads. `CombatShaders::init`
  `0x891300` only creates the named combat materials (water, toxic, ice, godray, fog, ground_lighting_mul/add,
  meatpulse, vignettes, shadow_occluded_spelldissolve) and has nothing to do with glows (`CombatShaders_init_0x891300.c`).
- **House outline + palette colours (OBSERVED, `HouseTest::init` `0x332d40`, `HouseTest_init_0x332d40.c`).**
  Renderers `this[0xb]` depth 1..1, `this[0xc]` depth 2..2 (the outline mask renderer), `this[7]` main (0x20..0x30);
  `0x979c30(renderer, depthMin, depthMax)` sets a renderer's depth range, `renderer+0x50` is its texture. Passes:
  `postprocess_blur` (0x22, main), `dropshadow` = `transparent_texture.shader` over a blurred texture (INFERRED: the
  furniture/cat layer drawn offset = soft drop shadow), two `variable_piecewise_blur` materials, `jumpflood_init`
  (pass 0x18 on the depth-2 renderer) and `jumpflood_composite` (`framebuf` = `this[0xc]+0x50`, pass 0x1a on main).
  `HouseTest_outline_update_0x3363f0.c` builds the `jump_flood_loop` materials per offset and sets `radius` (× screen
  size × 0.002734375) and `outline_color = HouseTest+0xd8`, a vec4 fed from the UI SWF: `0x1a6e40`
  (`HouseBuilder_PaletteColors_0x1a6e40.c`) reads the `BuilderUI_Palette` clip's frames `solid`, `hole`,
  `screw_out`, `screw_in`, `screw_linked`, `poop`, `blocked`, `outline_room`, `outline_valid`, `outline_invalid` and
  stores each frame's colour transform (× white `DAT_1412f7da0`) into `DAT_1412f77a4..`. The house outline colours
  are therefore **data (ui.swf palette frames)**; the outlined object is whatever is drawn at depth 2 (INFERRED: the
  hovered cat / the furniture being placed). The pass machinery is identical to combat's; only the mask draw differs.
- **`CharacterLightSource { color glow size }` → `Lighting` (OBSERVED).** Types: `glaiel::Lighting :
  Instantiatable_InCombat` 0x4c5 (vftable `0x140f238d0`), `LightSource : Component` 0x4c4, `CharacterLightSource :
  Passive` 0x1fa. `CharacterLightSource_init_0x8fbc70.c`: GON `color [r g b]` → `light+0x90..0x9c` (a = 1), `glow [r g
  b a]` (only when the key exists) → `light+0xa0..0xac`, `size N` (double, default 1.0) → `light+0x88`; the light is
  `AddComponent<LightSource>` `0x792e80` on the character's entity (`+0x48` Position, `+0x38` the scene's Lighting via
  get-or-create `0x793670`; defaults white colour / zero glow `DAT_1413c6290`). The only other creator of a LightSource
  is the SWF script hook `SetLightSource(clip, bool)` (`AnimatedLightSourceHooks` `0x792520` → `0x7926a0`).
  `Lighting::init` `0x78f820` (tileset `global_objects { Lighting { ambient N [glow_strength N] … } }`, glow_strength ×
  0.3 → `+0xd8`; materials `ground_lighting_mul` (texture `this+0x40`, blend 0x300) and `ground_lighting_add` (texture
  `this+0x60`, blend 0xb00, `offsetmax` (0,256)), both `lightmap_padding 1.0`, both at pass 9). `Lighting::update`
  `0x790510` (slot 11) lerps the ambient (the `LowerAmbientLight` GlobalModifier route) and calls
  `LightSource_Accumulate` `0x791850` per light: tile position from Position `+0x80/+0x90` (+ light offset
  `+0x50/+0x60` when `+0x81`), radius = `size·0.5` with a one-tile soft edge `d = 1 − clamp(dist − size/2, 0, 1)`;
  the **mul table** (`Lighting+0xf4`, 10×10 vec4) screen-blends `color.rgb·d` (the light pool, visible only where
  ambient < 1); the **add table** (`+0x734`) does `rgb += glow.rgb·d`, `a = screen(glow.a·d·glow_strength)`. Upload
  `0x7907b0` (slot 19) normalises the add rgb to max 1 and writes both tables as 12×12 padded RGBA32F textures that
  `ground_lighting.shader` samples bicubically in world-tile space. Visual meaning of `glow`: **an additive,
  bicubic-smoothed disc of colour on the ground tiles around the unit** (radius ≈ size/2 tiles + 1 soft tile,
  per-tile resolution), composited full-screen at pass 9 — it brightens whatever is drawn over those tiles (so it
  bleeds onto the unit's own sprite and its neighbours) but it is not sprite-shaped and has no rim. Combat-visible:
  vanilla gives it to enemies (`characters/enemies.gon` ~1729, `small_enemies.gon` ~437, `cat_enemies.gon`,
  `minibosses.gon`) and `Lighting` is `Instantiatable_InCombat`.
- **Sprite colour routes that are not halos (OBSERVED class names + GON use).** `graphics { tint [r g b a] }` = colour
  transform multiply (art-pipeline §5). **`AdvancedTint [ mul r g b a  add r g b a ]`** Passive (`finalboss.gon:115`): a
  full cxform including the **additive** term — the only data-level way to add brightness to a sprite's own pixels;
  per pixel, no rim. `EliteTint [r g b a]` / `EliteFlatTint [r g b]` (elite_buffs.gon), `IllusionTint 1`, `TintItem {
  mul [r g b] add [r g b] ignore_if_str_aux_equals … }` (type 0x818, `items/weapons.gon:1506`, applied through the
  item passive path `0x73e3c0`). `AddPostProcessEffect { shader X requires_framebuffer … }` GlobalModifier
  (`weather.gon:753`, type 0xac) and the tileset key `battlefield_postprocess_effect` (resolved by `0x7bdbb0`, default
  `"auto"`, pass 0x22; vanilla has it commented out) are whole-screen, not per unit. No status or passive references
  `composite_outlines`, `glow_color` or the jump-flood materials: there is no per-status aura.
- **What a native glow would need (assessment).** Recolouring the hover rim is calls only: `GetOrCreateMaterial(g,
  "composite_outlines", "")` + `SetUniformVec4(mat, "glow_color", rgba)` (and `jumpflood_composite` / `outline_color`),
  but it stays hover-driven and white-or-this-colour. A per-unit, always-on glow needs (a) a mask — the unit's clip
  drawn into a side renderer (the draw site was not located) or a new renderer with a depth range the mod moves the
  clip into — and (b) `AddPostProcessPass` with the blur/composite materials under new names and a per-unit colour.
  Everything but the mask draw is reachable through the functions above; being pursued as session `rim`. Until then
  the data-level answers are the baked halo (sprite-shaped, static colour, no engine cost), `CharacterLightSource.glow`
  (ground disc) and `AdvancedTint` (brightness lift).
- **The baked halo in the arena (OBSERVED 2026-10-22, `npm run test:artprobe -- --glow-arena`, run 20261022-101249;
  fixture `editor/test/fixtures/ingame/artprobe-glow-arena-summary.json`).** `ArtProbeGlow` (a Rat's
  `graphics.movieclip`): a 60 px square with a `bakeGlow` halo (#ff8000, blur 24, 4 bands), the identical unglowed
  square and a swatch of the colour (`probe-outcomes.ts` `GLOW_ARENA_PROBE` / `measureGlowArena`: per-pixel halo alpha
  against a pre-spawn baseline along four rays). The halo is drawn under the unit's tint like its other fills: inner
  band ≈ the swatch (196,99,1 vs 235,119,0), alpha falling off outward on 4/4 rays (~.86 → .66 → .44 → .21 → 0), the
  control square's ring unchanged (alpha 0.00). The bands are visible as plateaus at game scale (1.72 screen px per
  clip px); the lower ray is cut early where the arena's foreground props overdraw the clip.

Manifest-ready rows (for `bindings/25143593.json` when the native route lands): `ShaderManager_GetOrCreateMaterial`
0x9bb5d0 (pin by the FNV-1a constants `0xcbf29ce484222325`/`0x100000001b3` + the `+0x278/+0x280` map offsets; callees
#1 0x4c340 map find, #3 0x9bb220 LoadShader, #5 0x9bcfc0 Material ctor), `Material_SetUniform` 0x9bdbf0 (`+0x40` map,
0x50 slot stride, `+0x48`/`+0x80` dirty), `Material_SetUniformVec4` 0x9bde70, `_Float` 0x9bddc0, `_Vec2` 0x9bdf90,
`_Int` 0x9bdd40, `Material_SetTexture` 0x9bdcd0, `RendererBase_AddPostProcessPass` 0x979880 (pass `+0x10 = 1`,
`+0x14 = -1`, doubles 1.0 at `+0x24/+0x34/+0x44/+0x54`), `LightSource_AddComponent` 0x792e80, `CharacterLightSource_init`
0x8fbc70 (inline immediates `"color"` 0x726f6c6f63, `"glow"` 0x776f6c67, `"size"` 0x657a6973), `LightSource_Accumulate`
0x791850, `Lighting_init` 0x78f820 (`"ground_lighting_mul"` 0x1119c08, `"glow_strength"` 0x1119be0),
`ImmediateModeGameUI_init` 0x88d780 (`"outline_color"` 0xf073b0), `PlaceObject_decode3` 0xb78210; data `g_ShaderManager`
= `DAT_1413c4a30`; `LightSource` `+0x88` size, `+0x90` color, `+0xa0` glow, `+0x48` Position*, `+0x38` Lighting*;
`Lighting` `+0x90..0xa0` ambient, `+0xd8` glow_strength×0.3, `+0xf4` mul table, `+0x734` add table; `Material` `+0x28`
uniform slots (0x50 each), `+0x38` texture slots, `+0x40` name map, `+0x80/+0x81` dirty; `Pass` (0xa0) `+0x0c`
predicate, `+0x10` enabled, `+0x18..0x50` rects, `+0x58` flags; type ids LightSource 0x4c4, Lighting 0x4c5,
CharacterLightSource 0x1fa, CombatShaders 0x224, StatusMenu 0x75d, AddPostProcessEffect 0xac, TintItem 0x818.

## GON at runtime (2026-10-21)

RE session `gon` (Ghidra 12.1.4, build 25143593; the working notes are `.analysis/notes-gon.md`, the decompiles
`.analysis/decompiled/GonObject_*.c`, `Gon_{Tokenize,ParseTokens,LoadText}_*.c`, `Character_init_0xf70f0.c`,
`TacticsTest_init_lambda36_1hp_DoCall_0x895160.c`). Everything here is pinned by `bindings/25143593.json`
(`Character_hp` … `GonObject_size`, each with a byte witness `harvest.ts` verifies) and read in-game by `mewtest.dll`
(`mt_gon.c`, the `hp`/stats fields of the units event, `expect gon`; `docs/ingame-testing.md`). OBSERVED = read in a
decompile / disassembly or seen in a harness run; INFERRED = a consistent reading not itself witnessed.

**The node.** `GonObject` is 0xb0 bytes (`GON_NODE_SIZE`; the children vector's stride — `add rbx,0xb0` in
`child_by_name` 0x942b50, `imul 0xb0` in `Index` 0x942ee0, `/0xb0` in `Size` 0x942f30):

| offset | field | macro / witness |
|---|---|---|
| `+0x00..+0x38` | name index: an absl/Swiss-table style flat hash map `std::string -> int childIndex` (ctrl bytes `+0`, 0x28-byte slots `+8` with the index at slot `+0x20`, capacity mask `+0x18`); FNV-1a 64 over the key, folded by a 128-bit multiply; probed by `GonObject_NameIndex_Find` 0x124df0 | not read by the harness |
| `+0x38` / `+0x40` / `+0x48` | `std::vector<GonObject>` children begin / end / capacity | `OFF_GON_CHILDREN`, `OFF_GON_CHILDREN_END` (`child_by_name`) |
| `+0x50` | `int` value | `OFF_GON_INT` (`Int` 0x941540 returns it whatever the type) |
| `+0x58` | `double` value | `OFF_GON_DOUBLE` (`Number` 0x941920) |
| `+0x60` | `bool` value | `OFF_GON_BOOL` (`Bool` 0x942290) |
| `+0x68` | `std::string` text — **every scalar keeps its raw token**, numbers and bools included | `OFF_GON_TEXT` (`StringRef` 0x941140 returns `node+0x68` for types 1, 2, 5) |
| `+0x88` | `std::string` name (the key under the parent; size `+0x98`, capacity `+0xa0`) | `OFF_GON_NAME` (`child_by_name`'s scan compares it) |
| `+0xa8` | `int` type: 0 null, 1 string, 2 number, 3 object, 4 array, 5 bool (6 is also tested by `StringOr` and treated as "no value"; INFERRED an internal marker) | `OFF_GON_TYPE` (`cmp [rbp+0xa8],3` in `child_by_name`; the 11-byte `Exists` 0x9429d0 is `type != 0`) |

Two static null nodes, `0x1413c4d30` (`Get` misses; also `DefaultStatusSource`) and `0x1413c4de0` (`Get_const` /
`Index` / `child_by_name` misses). Every typed getter on a null node logs `GON ERROR: Field "<name>" does not
exist` through the error sink (`PTR_PTR_1412f7ad8`, vtable slot `+0x10`) and still returns the zero field — never
fatal; `<name>` is the global `std::string` `DAT_1412f7ae0` that `Get` / `Get_const` overwrite with the **last key
asked for**, so the message names the last lookup, not the node.

**Read API** (all `__fastcall`, `this = GonObject*`, strings MSVC `std::string*`; OBSERVED): `Get_const` 0x942da0
`(node, key)` — type 3 → hash lookup → `children[idx]`, else null; `Get` 0x942ca0 the same with the other null node
(the non-const `operator[]`; `Character::init` uses it for `stats`); `Index` 0x942ee0 `(node, int)` — object/array
`0 <= i < size` → child i else null, **a scalar returns itself**; `Size` 0x942f30 — null 0, scalar 1, container count;
`Begin`/`End` 0x942f70/0x942f90; `Exists` 0x9429d0 `type != 0`; `Contains` 0x942880; `child_by_name` 0x942b50
`(node, key, nth)` — nth 0 takes the hash path, nth > 0 scans the vector comparing `+0x88` and returns the nth
duplicate (DeepMerge's path); `Int` 0x941540 / `Number` 0x941920 / `Bool` 0x942290 / `Percent` 0x941d00 (number, or a
string ending in `%` → `strtod(prefix)*0.01`) / `String` 0x940d30 / `StringRef` 0x941140 log on a miss and return the
field anyway; the no-logging defaults `IntOr` 0x9426b0 (`type == 2 ? +0x50 : def`, 15 bytes), `NumberOr` 0x9426c0,
`PercentOr` 0x9426e0, `BoolOr` 0x942860 (`type == 5 ? +0x60 : def`), `StringOr` 0x942670 (types 1/2/5 → copy of
`+0x68`). `IntOr` / `NumberOr` / `BoolOr` / `Exists` / `Index` / `Size` are leaf functions **without a `.pdata`
entry**, which is why the manifest witnesses the layout in `child_by_name` and the logging getters instead.
`Character::deval(const GonObject&, double def, int, int, int, int, bool)` 0x103320 (funcsig 0x140edd5c0) evaluates
"a number, else a stat-scaled expression" for damage (INFERRED; not decoded).

**Where a unit keeps its entry (OBSERVED, `Character::init(std::string, bool, bool)` 0xf70f0).** `db =
*(SpawnDatabase**)0x1413c79d0` (through `FUN_140047dc0`, `mov rax,[rcx]; ret`); `entry = Get_const(db + 0x38, name)`;
`!Exists(entry)` → two alternative resolutions (0x7be2d0 / 0x7be820) and finally the fatal `No Character Named <name>`
(`Character.cpp` line 0x27c). INFERRED: `0x1413c79d0` is the SpawnDatabase singleton and `+0x38` the merged
`data/characters` object (`SpawnDatabase_init` 0x7a74b0 fills it through `process_gon_variants` 0x94be60, so the
entry is already `variant_of`-resolved and overlay-merged — OBSERVED in-game: a `.patch`ed `properties.health` reads
12 there). Stores: **`Character+0x240 = const GonObject*` entry** (`mov [r14+0x240],r13` at 0xf79c9, `OFF_CH_GON_ENTRY`;
six `mov rbx,[r14+0x240]` reads follow); sub-nodes init reads: `properties`, `abilities`, `passives`, `stats`
(non-const `Get`), `graphics`. **`Character+0x248 = std::string`** (`OFF_CH_NAME_KEY`): the notes inferred the entry
name; OBSERVED 2026-10-22 on spawned units it holds the **`graphics.name` loc key** (`ENEMY_POOTER_NAME`,
`GOLDEN_RAT_NAME` after a `.merge`), so the units event calls it `namekey`. Where the entry name itself lives is
still open. (`Status+0x68 = const GonObject*` is the status's data node, known.)

**Stats and HP (OBSERVED unless marked).** Seven `int32` read as `IntOr(Get(stats, name), 5)` (default 5) in
`data/characters` order at **`+0x5a0` strength, `+0x5a4` dexterity, `+0x5a8` constitution, `+0x5ac` intelligence,
`+0x5b0` speed, `+0x5b4` charisma, `+0x5b8` luck** (`OFF_CH_STATS`, `int32[7]`; seven `mov edx,edi; mov rcx,rax; call
IntOr; mov [r14+N],eax` from 0xf99ba, 0x3a apart). `+0x5bc..+0x5d4` are the EFFECTIVE stats (OBSERVED 2026-10-22, "Effective stats" below; the
earlier "per-stat bonus ints" reading was wrong: LuckUp's `+0x5d4 += stacks` lands on base + bonuses). Base block from `entry.properties`, the stat share subtracted so
the runtime formula re-adds it: `+0x5d8` base movement (`IntOr(base_movement, 4)`; with `movement`: `Int(movement) -
(speed-5)/2`), `+0x5dc` base initiative (`Int(initiative) - 2*speed`), `+0x5e4` health regen, **`+0x5e8` base health
= `Int(properties.health) - 4*constitution`** (`OFF_CH_BASE_HEALTH`; `mov ebx,[r14+0x5a8]; shl ebx,2; … sub eax,ebx;
mov [r14+0x5e8],eax` at 0xfa91e; champions/bosses — `+0xce0` set — `round((base + 4*con) * +0xce8, +0xcf0) -
4*con`), `+0x5ec` a copy taken at the end of init (INFERRED the unmodified base), `+0x5f0` base mana (`Int(mana) -
3*charisma`), `+0x624` a luck-scaled base (`- 2*luck`; key not read). **`+0x4b0` current HP** (`OFF_CH_HP`): init
stores `Int(properties.initial_health)` × the champion multiplier when present; the `1hp` console lambda (0x895160,
`TacticsTest::init` lambda_36, registered through `DebugConsole_AddCommand` 0xa168e0) walks the live Character
array and does `if (+0x4b0 > 1) +0x4b0 = 1; +0x4b4 = 0` — the one direct HP witness (`999` is "deal 999 damage to
every non-ally" through `Character_TakeDamage` 0x110120, not an HP write). OBSERVED in-game: ten frames after
`spawn`, `+0x4b0` equals `properties.health` (Pooter 6; 12 with `health.multiply 2`; Rat 5). `+0x4b4` shield =
`IntOr(properties.shield, 0)` × multiplier (`OFF_CH_SHIELD`), `+0x4b8` divine shield likewise
(`OFF_CH_DIVINE_SHIELD`). **Max HP**: `+0x4bc` = max(1, `+0x5e8` + 4 * effective constitution), stored by `Character::recompute_stats`
(OBSERVED 2026-10-22, `OFF_CH_MAX_HP`; "Effective stats" below).
`Character_BeginTurn` / `GetTurnControl` touch none of these (`+0xeb4/+0xebc` there are re-entrancy counters).

**Parser scalar typing (OBSERVED: `Gon_LoadText` 0x940840, `Gon_Tokenize` 0x93f090, `Gon_ParseTokens` 0x93fcf0).**
`LoadText` wraps the text in `{ … }`, tokenizes, parses the root as an object and logs `GON ERROR: More symbols
exists after file completed parsing` if tokens remain. The tokenizer splits on whitespace where **`,` `:` `=` count
as whitespace**; `{ } [ ]` are single-char tokens; `#` starts a comment to end of line; `"` opens a quoted token
(`\` escapes the next char, the closing `"` flushes it) and **the quotes are dropped with no "was quoted" flag**;
unclosed quote / comment → the two `GON ERROR: didn't close …` messages. `//`, `/* */` and `#include` never reach
the tokenizer: `Gon_Preprocess` 0xa50bd0 handles them first ("GON text pre-pass" in "Data model" above). The parser: `{` → type 3 (`name value` pairs), `[` → type 4 (values),
anything else is a scalar that starts as type 1 with the token in `+0x68`, then `strtol(tok, &end, 0)` consuming the
whole token → type 2 with `+0x50`, `strtod` consuming it → type 2 with `+0x58` (both are always stored: `1.5` → int
1, double 1.5), then exact `null` → 0, `true` / `false` → 5. Consequences: bare `5` and `"5"` are identical number
nodes; `yes` / `True` / `1` are not bools (`Bool()` on them logs `is not a bool`); `1e3`, `0x10`, `-3` are numbers;
`5%` is a string `Percent()` reads as 0.05; `""` is an empty token → number 0 (INFERRED). The overlay engine's
`.add` / `.multiply` (PatchMerge) rewrite the int, the double **and** the token text (OBSERVED in-game:
`health.multiply 2` → int 12, double 12, text `"12"`). The editor-side parser's typing is another PR's concern;
these are the facts it must mirror.

## Component GON keys (2026-10-22)

RE run `compmap` (lead) + `compA`..`compE` (Ghidra 12.1.4, build 25143593; notes `.analysis/notes-comp{A..E}.md`,
decompiles `.analysis/decompiled/<Class>_<slotN|callee|lambda>_0x<rva>.c`, work lists `.analysis/compmap/`). The result
is `editor/component-schema.json` (data-mods.md "Component keys"), pinned by `editor/test/component-schema-tests.ts`
(shape + T1 vanilla zero findings).

- **Work list (OBSERVED, objdump over `.analysis/exe/25143593/Mewgenics.exe`).** Each class's base and type id come
  from the RTTI name `DeriveComponentWithBoilerplate<glaiel::X, glaiel::Base, id>`; its slots from the vftable in
  `list_names.tsv`. "Own" slots = where X's vftable differs from its base's at the same index; slots 0/1/2/3/5 are the
  boilerplate (name, id, IsA, hierarchy, dtor). 1741 vftables; `Passive` has 170 slots, `Status` 172.
- **Init slots (OBSERVED).** Status: slot 30 `OnInit(stacks, data, applier)` 0x8104b0 (`tickdown_this_turn` bool →
  +0x76, `stacks` int → +0x5c, then `Passive_init_full` 0x767b30). Passive: slot 31 (`+0xf8`) `Passive_init_gon`
  0x767cd0, devirtualised in every passive ctor (`cmp r8, 0x140767cd0`), reads only `stacks` from the node; Passive
  slot 30 is a "not implemented" assert. Data node = `this+0x68`.
- **Lookups.** Besides `Get` / `Get_const` / `Contains`, most reads are an inlined lookup: the key built inline as a
  `std::string` (length store + `movups`/`movabs` from `.rdata`), an FNV-1a loop (`0xcbf29ce484222325`,
  `0x100000001b3`) and `GonObject_NameIndex_Find` 0x124df0. When the node is a scalar or the key is missing the inline
  pattern falls back to the node itself ("child-or-self"), which is how scalar forms carry a value.
- **Children walks.** The `/0xb0` magic `0x2e8ba2e8ba2e8ba3` over `[node+0x38]/[node+0x40]` iterates children.
  `Passive_ApplyStatusChildren` 0x76a160 (via 0x76a0c0) applies every child except a passed list of the class's own
  keys; each child decodes through `DamageInstance::DecodeStatusApplication` 0x2bbab0 (scalar = stacks, `[stacks
  chance]`, `{stacks (1) chance (percent or expression, 1)}`). `ConditionalPassive` slot 33 0x1520b0 (the base of the
  `Passive{At,When,While,If}*` family) reads `passives` (child-or-self) and sends each child to
  `Status_NameExists` 0x492e80 → 0x2bbab0 or to `attach_passive` 0x494080. `GonObject_IsPercentString` 0x9429e0.
- **Shared parsers.** `DamageInstance::FromGon` 0x2ba080; `Brain_InitFromGon` 0x134400 (from `Brain_CreateByName`
  0x3d5880); `Passive::QueueAbility` 0x76b4a0 (lambda body 0x76b650 reads `even_if_stunned`, `force_display_name`;
  the cast helpers 0x76ad70 / 0x76b290 / 0x76bb20 likewise); FormChanger forms in slot 33 0x199010.
- **Keys in lambdas.** Many keys are read only in `std::function` bodies: the RTTI-named
  `_Func_impl_no_alloc<…lambda…>::vftable` rows in `list_names.tsv`, `vftable+0x10` = `_Do_call` → the body (compB
  followed 309 of them across 75 classes). INFERRED: classes whose vanilla keys were not found (`vanillaMissed` in
  the schema) mostly hide them in a lambda not yet located.
- **Dispatch names.** The names `apply_status` 0x483120, `attach_passive` 0x494080 and 0x4ccb20 compare against
  (`lea rdx,[rip+str]` before `std::string == const char*` 0x52560): 1923 names, 386 of them not `glaiel::` classes
  (`HealthGain`, `Conditional_*`, `TakeExtraTurn`, …) — `.analysis/compmap/dispatch-names.json` →
  `effectNames` in the schema (the scan ranges are approximate, so the list is permissive).

## Effective stats: Character::recompute_stats (2026-10-22)

RE session `fxstats` (`.analysis/notes-fxstats.md`; decompiles `Character_recompute_stats_0x102520.c`,
`Character_recompute_stats_lambda1_DoCall_0x129220.c`, `Character_GetPassiveList_0x117c40.c`). OBSERVED unless marked.

- **There is no `GetStat(id)` / per-stat getter.** Effective stats are stored fields written by one function,
  **`glaiel::Character::recompute_stats(Ability*, bool)` at RVA `0x102520`** (3447 B; named by the RTTI of the six
  `std::_Func_impl_no_alloc<lambda_N … recompute_stats@Character@glaiel@@QEAAXPEAVAbility@4@_N@Z …>` functors whose
  vftables `0x140ee0eb8`/`e80`/`e48`/`e10`/`dd8`/`da0` are lea'd only there). 48 direct call sites in 34 functions,
  among them `Character_init` and `Character_BeginTurn` (the manifest's callee witnesses).
- **Order.** Early-out `if (+0xeb4 != 0 && touched_passives +0xe50) return` (a re-entrant call during a pass);
  snapshot of the old values; **base → effective copy** `+0x5a0..+0x5b8 → +0x5bc..+0x5d4` (`mov eax,[rdi+0x5a0]; mov
  [rdi+0x5bc],eax` …, `OFF_CH_STATS_EFF`); **lambda_1 over the passive list** (`0x117c40`, counter `+0xeb4`; statuses
  are passives) whose `_Do_call` `0x129220` calls **vtable slot 82 `ApplyStatModifiers`** (`+0x290`) and, when an
  `Ability*` is passed, slot 87 (`+0x2b8`, ability-specific modifiers, INFERRED); lambda_2 over list `0x118300`
  (`+0xeb8`) → slot 152, lambda_3 over a `TacticsTile` list `0x117fc0` (`+0xebc`) → slot 39. Then the derived values,
  all from the **effective** stats: `+0x950` movement = max(1, `+0x5d8` + (spd−5)/2), `+0x954` initiative = `+0x5dc` +
  2·spd, **`+0x4bc` max HP = max(1, `+0x5e8` + 4·con)** (`lea ecx,[rax+r9*4]; cmp ecx,1; cmovg r12d,ecx; mov
  [rdi+0x4bc],r12d`, `OFF_CH_MAX_HP`), `+0xd1c` max mana = max(0, `+0x5f0` + 3·cha), `+0x960` = max(0, `+0x5e0` + int),
  `+0x96c` = `+0x5f8` + str − 5, `+0x970` = `+0x5fc` + (dex−5)/2, `+0xc60` = max(0, `+0x624` + 2·luck), `+0xc70` =
  (luck−5)·0.1. A second round of lambdas 4–6 over the same lists follows (INFERRED: modifiers of derived values);
  current HP `+0x4b0` / mana `+0xd18` are clamped to the new maxima under a condition; any change bumps `+0xe68`
  (INFERRED a stats version counter).
- **Readers.** `StatusMenu_update` (0x81aee0) shows strength…luck from `+0x5bc..+0x5d4` and max HP from `+0x4bc`;
  `Character::deval` (0x103320) binds its expression variables to the same block.
- **In-game (run `20261022-120539-_effective-stats-effective-luck`, seed 42).** Ten frames after `spawn`, a Rat
  (luck unset → 5) reads luck 5 / effective 5 / max HP 5; `LuckyRat` (`StatusOnSpawnIn { LuckUp 3 }`,
  `mods/_effective-stats`) base 5 / **effective 8**; `FwGlowRat` (`FwGlow_ff00ff`, LuckUp's vtable with slot 82
  replaced, "Per-unit glow" v3) **effective 5**; every fresh cat reads `hp == +0x4bc`. So the recompute had run for
  the spawned units by then. The harness reads these fields (`dump`'s `effective` block, `expect unit <stat>.effective`
  / `maxhp.effective`; `docs/ingame-testing.md`) and never calls the function. Fixture
  `editor/test/fixtures/ingame/result-effective-stats.jsonl`; manifest `Character_recompute_stats`,
  `Character_statsEffective`, `Character_maxHp`.

## Save safety

Backups: `%USERPROFILE%\Documents\Mewgenics-save-backups\<timestamp>\` (first: 2026-10-17_1911, 24 files, hashes verified;
`steamcampaign01.sav` SHA-256 `09A68A36F6337E4EB493A7B2C119FDAE494C02D0EF5438881E032FAA03A7AF08`).
All modded launches use `-savesuffix dev` through a launcher script; Steam launch options stay empty.

**Which file a launch writes (decoded 2026-10-19, build 25143593; `.analysis/decompiled/MewSaveFile_*.c`,
`SaveSelection_Build_0x1ba060.c`, `opencaller_c*.c`).** `MewDirector::init(std::string name)` (`0x3a6b90`) calls
`MewSaveFile::open_or_create(name)` (`0x229cd0`), which opens `<userdata>\saves\<name>` through
`SQLSaveFile::open` (`0xa0d3c0`); `<userdata>` is the global string the FileManager fills at startup
(`DAT_1413c58f0`, `%APPDATA%\Glaiel Games\Mewgenics\<steamid>`). Three callers choose the name: the save-selection
screen passes a slot from its list — `SaveSelection_Build` (`0x1ba060`) assigns `campaign01..03.sav` and then
`steamcampaign01..03.sav` to the same vector (`vector::assign`, `0xecfc0`), so the Steam-cloud names are the live
slots and the local names a fallback family; the test director (`0x758650`) passes `test00.sav` (the name
`MewDirector::init` compares against to flag a test run); the house test (`0x31c1e0`) passes `housetest01.sav`.
**The `-savesuffix` value is not part of any save path on this build.** `ApplicationBase::ProcessCmds` stores it at
`ApplicationBase+0x370` and logs it; a scan of every `[reg+0x370]` access in `.text` (77 functions) intersected with
the functions that reference the App global or build the saves root finds no reader besides `ProcessCmds` and the
`MewApplication` destructor (`0x7459b0`, which frees the string after `SteamAPI_Shutdown`). The isolation we rely on
is therefore **not** a renamed save: a dev launch that enters a Steam slot would write `steamcampaign0N.sav`. The
harness enforces the rule instead (`editor/src/core/ingame/savecheck.ts`): every `*.sav` in the saves dir is hashed
before and after a run and only `campaign0N.sav`, `test0N.sav`, `housetest0N.sav`, the harness's own
`mewtestNN.sav` (the disposable `enter Campaign` slot, 2026-10-20) (and `<suffix>`-prefixed forms,
in case a future build uses the suffix) may change; any other change is a `safety-violation`. OBSERVED 2026-10-18:
dev launches wrote `campaign02.sav` and `test00.sav`; `steamcampaign01.sav` untouched since 2026-03-31. Open: what
else the game does with the suffix (`Inherit Save File Suffix` exists in `ProcessCmds`); Steam Cloud's
`steam_autocloud.vdf` in the same dir suggests the `steam` family is what Steam syncs.

## Cat parts: entry path, palette, faces, mirroring (2026-10-21)

Ghidra sessions `catA` (the `_CAT` entry path and the clip lookup; `.analysis/notes-catA.md`) and `catC` (the "look"
pipeline on the doll; `.analysis/notes-catC.md`), build 25143593, RVAs (image base 0x140000000); decompiles named
below are in `.analysis/decompiled/`. The slot fill itself — `CatParts::prerender` 0x742350 converting every
slot-named instance of whatever clip the renderer plays, the empty-slot rule and experiment A0 — is session `catB`'s
and lives in "CatTest and the cat animation clips" (PR #74); the loader, registry and render path are "SWF loader and
display path" (PR #81). This section is what sits around them: how a `_CAT` unit reaches `CatTest`, and what the
game does to a doll after the slots are filled. Together they make cat parts in mod animations a **data-only**
matter (no hook needed: `_Append_CatTest` frames with empty slots, `docs/art-pipeline.md` §4).

**Entry path (catA, OBSERVED).**
- `glaiel::Character::init(std::string name, bool, bool)` 0xf70f0 (funcsig string at 0xedc7e0, `Character.cpp`;
  rcx this, rdx a by-value `std::string*` the callee destroys, r8b/r9b) reads the entry node (`Character+0x240`, from
  the global characters table `SpawnDatabase(*0x1413c79d0)+0x38`), handles `_Champion`/`_Elite` suffixes,
  `properties`, `stats`, `abilities`, `passives`, `ai`, `equipment`, then `graphics`: `movieclip` →
  `Gon_PickRandom` 0x94fe40 (a list picks one entry) → **`Gon_StringOr(node, out, "_CAT")` 0x942670 — `_CAT` is the
  default when `movieclip` is absent**; `shadow` → `Gon_StringOr(…, "DefaultShadow")`; then
  `Character::init(std::string movieclip, std::string shadow)` **0xf1150** (PR #81 calls it `CharacterGraphics_build`;
  identity from its lambda vftable names). A second `"_CAT"` compare in 0xf70f0 (0xf8b3e) is `graphics.name == "_CAT"`
  → a generated cat name (0x7ad2f0) and has nothing to do with the clip.
- **0xf1150 at 0xf11e8: `movieclip.size() == 4 && memcmp(buf, "_CAT", 4) == 0`.** The `_CAT` branch: 0x1219b0 →
  `AddComponent<MaskedRendererIso>` **0x12c960**, built with the literal **`"CatTest"`** (`FUN_140051350(&s, "CatTest",
  7)`, call #8); `custom_cat_data` (a name looked up in the `custom_cats` table `game+0x7c8`, `<name>_Champion` first
  for champions, or an inline block) → `CatData` (0xc58 bytes, ctor 0x5d6b0, `CatData::load` 0xb7ca0) at
  `Character+0x88`, stats / equipment copied into it; `CatParts` via 0x90a70 → `AddComponent<CatParts>` 0x90ea0 at
  `Character+0x90` (`CatParts::init(CatData*, "", 0)`: an **empty instance-name prefix**, so slot and reference
  children match by their plain names). The other branch: `ResolveClipName` 0x7bdbb0 (the `tilesets.gon` remap, PR
  #81) → 0x121a90 → `AddComponent` 0xa5cf0 with the mod's `graphics.movieclip`, plus a `glaiel::FaceHooks` component
  (0x121ae0). **Both branches create the same class** `glaiel::MaskedRendererIso` (vftable 0xed81e8, type id 0x4f7,
  0x140 bytes, ctor 0xa5ec0, pool `DAT_1413ee920`); the only difference is the name handed to
  `MaskedRendererIso::init(std::string)` 0x78ceb0 → `Renderer::init` **0x97a900** (`Renderer+0xa8` = the name,
  `+0x80` = the instance, `+0x54` = layer 0x19; fatal 0x951ee0 `Could Not Find MovieClip named: <name>` when the name
  is unknown and not `"none"`) → `Swf_GetCharacterByName` **0x9bb890** (rcx unused; `rdx` = by-value `std::string*`;
  returns the freshly created **instance**, NULL when unknown) → `ApplicationBase::FindCharacter` **0x9bb6f0** (one
  function, three names in our notes: PR #81's `App_FindMovieClipByName`, session loc's
  `Swf_FindCharacterByExportName_global`): cache `app+0x2b8` (FNV-1a 64, sentinel `+0x2c0`), on a miss the loaded-SWF
  array `app+0x118[0..app+0x114)` **last loaded first**, per file the SymbolClass name → id map at `file+0x70`
  (0x123a00, find-or-insert; a miss inserts `{name, 0}`, harmless) and `Swf_GetCharacter` 0xa4a190 on the sub-object
  `file+0x30` (its table at `+0x28`, i.e. absolute `file+0x58`; "Imports are not linked" above says `file+0x28`,
  which is relative to that sub-object); the result is cached even when null; then `def->vtable[3]` (+0x18, INFERRED
  `CreateInstance`) makes the MovieClip. `0x9a88a0` is **`MovieClip::GotoFrame(this, int)`** (clamps to `[0,
  numFrames−1]`, runs the frame's tag list through `Swf_MovieClipAdvance` 0x9a8f30), not a creator.
- **Not on the path:** 0xde040 references `CatTest`, `DefaultShadow`, `alt_animations` and calls
  `AddComponent<CatParts>`, but its callers are 0x142070 and 0x93c7c0 — INFERRED a standalone cat-doll builder for a
  UI/menu context (the dev "Cat Animation Tester" 0x37a290 is a sibling).
- **Consequences.** (1) A mod SymbolClass literally named `CatTest` in a later-listed SWF replaces the cat clip for
  *every* cat (global registry, not scoped) — the validator refuses it (`cat-clip-override`, PR #76). (2) `_CAT`
  characters never pass through the `tilesets.gon` remap. (3) **Unknown `graphics.*` keys are ignored silently**: every
  read is `node["graphics"]["key"]` through the GON accessors 0x942da0 / 0x942ca0 plus a default-taking getter; there
  is no key enumeration, so `graphics { cat_rig MyRig }` is inert. (4) The `app+0x2b8` cache is keyed by the
  requested name, so repeated spawns are cheap.
- `graphics.*` keys 0xf70f0 reads: `movieclip`, `shadow`, `shadow_size` (→ `+0x3d0`, and `*(+0x48)+0x60`, ×1.15
  champion / ×1.1 elite), `piece_alt_frame`, `portrait` (→ `+0x3b8` = value−1), `tint`, `flat_tint`, `art_flip` (→
  `+0x3a0`, default 1), `name` (`+0x248`), `tooltip` (`+0x268`), `keyword_tooltips` (`+0x288`),
  `default_projectile` (`+0x2d0`, default `Projectile`), `default_attack_animation` (`+0x2f0`, default `attack`),
  `tactical_view_frame` (`+0x330`, default `auto`), `projectile_spawn_offset` (`+0xdd8`), `uifloaters_offset`,
  `shadow_occluded`, `shade_occluded_objects`, `visually_spiky`, `use_turn_animations`, `static`,
  `start_orientation`, `lock_orientation`, `size` (`1x1`/`2x2`/`3x3`/`5x10`), `type` (`normal`/`small`/`boss`/`cat`
  /`object` → `+0xcf4` = 0..4). **Correction (2026-10-22, session facing, OBSERVED):** `type`, `lock_orientation`,
  `always_face_forward`, `start_orientation`, `two_fronts`, `two_fronts_switch`, `size`, `static` and
  `visually_spiky` are read from the entry's **`properties`** node (r15 = `entry["properties"]`, 0xf79f0), not from
  `graphics`; vanilla data agrees (`bosses.gon`, `inanimate_objects.gon`: `properties { lock_orientation [-1 0] }`).
  `art_flip`, `no_horizontal_flip`, `use_turn_animations` and the portrait / tint / shadow keys are `graphics`.
  0xf1150 reads: `custom_cat_data` (+ nested `default_face`, `class_anis`),
  `override_portrait` (else `<name>Portrait` / `<name>ChampionPortrait` through 0x9bb890 ×6 → `+0x400`), `scale` (→
  `+0x3c8`, ×1.15 / ×1.1 unless `type == 2`, copied to the root node `*(+0x38)+0x98`), `water_mask` (→ `+0x310`,
  default `default`), `four_way_animations` (→ `+0x4cd`), `alt_animations` (own entry and, for cats,
  `classes[CatData+0xc10].graphics.alt_animations` and `classes[class_anis].graphics.alt_animations`), the class-level
  `default_face`, plus `abilities.move/attack`, `stats.*`, `equipment.*`, `sound.animation_prefix` (default `Cat`
  when the clip is `_CAT`, else the movieclip name → `sm+0xd8`, played as `<prefix>_<anim>` by 0x9abda0).

**Animation name → frame label (catA, OBSERVED unless marked; PR #74/#76 cite the label and `ani` facts).**
- The driver is the **animation state machine at `Character+0x58`** (0x90a90 → 0x91e10; `AnimStateMachine::Load`
  0x9ac490 binds the per-character-type table → `sm+0x60`; when no prebuilt table exists 0xf1150 defines states 0..15
  — `idle`, `walk`, `stunned`, `sleepLoop`, `knockback`, `splat`, `primed`, `Victory`, `hit_up`, `hit_down`,
  `toidle`, `hit_jump`, `hit_land`, … — with `DefineState` 0x9ac1e0 and transitions such as `idle2primed` with
  `AddTransition` 0x9ac2a0). Facing suffix: the `std::string` at `sm+0xb8`, initialised `"F"` (`"RF"` with
  `four_way_animations`), rewritten by `Character_SetOrientation` 0x10ce50 (below); `Character::IsFacingFront`
  0xf0490 = `sm+0xb8 == "F"`.
- `Character::AddAnimationAlias(this, to, from)` 0x103da0 (`alt_animations [[from to]]`) inserts **two** entries into
  the map at `*(Character+0x58)+0x78`: `from+"F" → to+"F"` and `from+"B" → to+"B"` (the letters are appended at
  registration); four-way `L`/`R` variants go through `Character_AddAnimVariant` 0xf4ad0 → `SetAlias` 0x9ac240 into
  the second map `sm+0xa8` (fallbacks such as `stunned+suffix → idle+suffix`).
- `AnimStateMachine::Update` 0x9aae00 → `PlayAnimation(sm, name, fallback)` **0x9abda0** (also `Character::start`
  0x1057d0 for `spawnin_*`, `Character::Splat` 0x117060): `0x9ab740` turns `_DEFAULT` into `sm+0xb8`;
  `0x9ac790(table, out, name, suffix)` looks up **`name + suffix`** in the bound table `sm+0x68`, falling back to
  `name`; `0x9acaa0` is a second remap; the alias map `sm+0x78[name]` is used when `MovieClip::HasLabel` 0x9a8e80 or
  the table has it; then `HasLabel(clip, name)` → `MovieClip::GotoLabel` 0x9a8c00 (label map `def+0x20`, sentinel
  `+0x28`) → `GotoFrame` 0x9a88a0, the nested child named **`ani`** (`GetClip2` 0x9aabb0 = `0x99a1b0(clip, "ani")`,
  must be a MovieClip) is reset to frame 0 and set playing (`+9 |= 2`), the sound `<sm+0xd8>_<name>` fires
  (0x95b770). **A missing label returns 0 — no log, no crash**; `Update` clears the pending name (`0x9b0830(sm+0x190)`)
  and the clip keeps its frame. `MovieClip::FindFrameByLabel` 0x9a8da0 (the AVM1 `gotoAndStop` path in
  `DoAction::simpleParse` 0xa51fd0, UI code) returns −1 on a miss, also silently.
- Which clip: `GetClip` 0x9aac70 returns the renderer's root instance `sm+0x38` (unless `sm+0x50` names a child via
  `sm+0x40`, INFERRED unused for cats), so the labels of the **`CatTest` root timeline** are what resolves; the
  per-frame sprite is addressed only as the child `ani`. Ability `animation` keys were not traced (INFERRED: they end
  in `SetState` 0x9aa360 / `PlayAnimation` with the same `_DEFAULT` suffix path, since every `SetState` caller passes a
  bare name).

**Palette (catC, OBSERVED unless marked).**
- **One `paletted` material per doll, on one node.** `CatParts::init` 0x73cc70 (`CatArt.cpp`; vftable 0xed6a30)
  creates `Material::create(shader "paletted")` — `0x9bb5d0(DAT_1413c4a30, "paletted", "")` → `Material_Create`
  0x9bd800 — into **`CatParts+0x160`** and sets the uniform `palette` (`Material_SetUniformInt` 0x9bdee0) to the
  base row `+0x1b4`, then again to the override `+0x1b8` when it is neither −1 nor −69. `CatParts_Refresh` 0x73f7d0
  (32 callers) repeats that; its tail 0x73e240 attaches the material to the render proxy at `CatParts+0xb8`
  (`DisplayObject+0x98 = Material*`) and explicitly resets the five **item** sprites to the default material
  `DAT_1413c5a00`; `FillTexScars` 0x73a450 resets each part's `scars` child likewise. INFERRED from those explicit
  resets: the material is inherited down the display subtree, so **every grayscale pixel under the doll root is
  palette-remapped**; only nodes with their own `+0x98` escape. The shader registry name is `paletted`; the file is
  `paletted_full.shader` (name → file INFERRED).
- Base row `+0x1b4`: written by the part applier 0x73bfe0 (line 341) from the CatData property entry named
  `palette`; `CatData_GetPalette` 0xbdc70 handles `Jester` (→ `Colorless`) and `classes[class].graphics.palette`.
  Override `+0x1b8`: (a) every passive named **`OverridePalette`** on the CatData (`CatParts::apply_passives`
  0x73e3c0, `0xbe200(catdata, out, "OverridePalette")` → its `palette` int via 0x941540; `OverridePalette_OnInit`
  0x8068d0 also reads `eyebrow1`, `eyebrow2`, `exit_ability…` and calls `CatParts_Refresh`; `JesterPaletteCycler`
  0x902a40 does the same per cycle); (b) a `palette` key in the CatParts prop map (`+0x828..`, lookup 0xa2ec0).
  **−69 (`−0x45`) is the multi-palette sentinel**: `CatParts_Refresh` builds 14 extra `paletted` materials (`+0x16c`
  count / `+0x170` array) with `palette` = the class's `graphics.palette [list]` (first three fixed, the rest random)
  — INFERRED the per-part rainbow.
- **`tint` vs palette.** `graphics.tint` is a cxform multiply on the Character's root display node (0xf70f0 lines
  560–640: 1 arg = colour name × 0.5, 2 = `[name amount]`, 3 = `[r g b]` × 0.5, 4 = `[r g b a]`; `flat_tint` via
  0x9bf030) applied **after** the palette lookup (`paletted_full.shader`, PR #81), so it multiplies the paletted
  colour. `TintItem` passives (0x73e3c0 lines 221–616) write per-**item-slot** `mul`/`add` floats (skipped when the
  item's string aux is in `ignore_if_str_aux_equals`) that `FillTexScars` copies into the item sprite's cxform; items
  are un-paletted, so that tint is their only recolour.
- **Texture / scars / age.** `CatParts_FillTexScars` 0x73a450 `(PartSlot*, PartIndices*, CatData*, int age)`, called
  once per slot (15×) from 0x73bfe0: `gotoFrame(part, frame−1)`; child **`tex`** (`0x99a1b0`, child by instance
  name) → `gotoFrame(tex, texture−1)`; child **`scars`** → default material + `gotoFrame(scars−1)`; inside `tex`
  **`greyhair`** (frame `CatData+0x24`) and **`wrinkles`** (`CatData+0x28`) visible only when `age == 2`; child
  **`aux`** → `gotoFrame(aux−1)`; then the slot's matrix (0x30 bytes → `sprite+0x60`) and cxform (0x20 bytes →
  `+0x78`); `frame < 0` hides. These children live **inside the vanilla part symbols** (`CatBody`, `CatHead`, …):
  a rig only hosts the slots, and a rig that draws its own body art gets no texture, scars, age or palette-independent
  tint.

**Faces (catC, OBSERVED unless marked).**
- Face sprites are not looked up inside the head part: `CatParts::init` 0x73cc70 (lines 340–450) instantiates
  `CatEye`, `CatEyeClosed`, `CatEye_Right`, `CatEyeClosed_Right`, `CatMouth`, `CatMouthOpen`, `CatMouthSmile`,
  `CatEyebrow` ×2 from catparts.swf **by export name** (`CatPartHolder_init` 0x73a2f0 = addChild + `addSymbol(name)`
  0x73a350) into the head container `CatParts+0xb0`; `CatEar` ×2 and `CatHead` go on the doll root `+0xa8`; items
  into `HeadItemF`/`HeadItemB` (`+0xa18`), `FaceItemF`/`FaceItemB` (`+0xa48`), `Weapon` (`+0xa60`), `Trinket`
  (`+0xa78`). Holder fields: `+0x958` CatHead, `+0x970`/`+0x988` ears, `+0x9a0` eyes (count `+0x9ac`, ptr `+0x9b0`),
  `+0x9b8` right eyes, `+0x9d0` mouths, `+0x9e8`/`+0xa00` brows.
- **`FaceData`** (0x58 bytes): `+0x00/+0x08` eyebrow_up L/R, `+0x10/+0x18` eyebrow_rotation L/R, `+0x20/+0x28`
  ear_rotation L/R, `+0x30/+0x38` face_offset x/y (default `[10 0]`), `+0x40` int mouth (0 closed / 1 open / 2
  smile), `+0x44/+0x48` int eyes L/R (0 open / 1 closed), `+0x4c` byte back, `+0x4d..+0x53` "field present" bits
  (unset fields fall back to the cat's default face). Loaded by `CatParts::load_faces` 0x73a990 (funcsig at
  0x1114158; keys `faces`, `eyebrow_rotation`, `ear_rotation`, `smile`, `closed`, `face_offset`) from
  `data/catgen.gon faces{}` into the global map `DAT_1413c6148` (`CatParts_FindFace` 0x11e7b0 inserts missing
  entries lazily: 0x88 bytes, name `+0x10`, data `+0x30`); `CatParts_SetFaceByName` 0x744890 copies the preset into
  `CatParts+0xc8..+0x11f` (name at `+0x120`; `default` → `classes[…].graphics.default_face`); the current face name
  is `+0x140`.
- `CatParts_ApplyFace` 0x740a00 `(parts, FaceData*, byte, char blink, char talk, FaceData* blend, double t)` (callers
  0x73cc70, 0x73e240, 0x742bd0): one visible sprite per list by index (mouth `+0x40`, eyes `+0x44/+0x48`, `back` →
  the HeadItem/FaceItem F/B lists), eyebrow_up / rotation and ear_rotation as matrices on the brow / ear sprites;
  when the **mirrored flag `CatParts+0x66`** is set it swaps the left/right matrices and multiplies by scale(−1, 1)
  (`0x3f800000bf800000`); `blink` forces eyes 1, `talk` forces mouth 1.
- Positions come from **`CatHeadPlacements`** (catparts.swf id 11006; 0x7393e0 line 46: `0x9bb890(0x73,
  "CatHeadPlacements")`, `gotoFrame(head_index − 1)`, named children `mouth`, `ahead`, `aneck`, `aface` + others
  compared by inlined hash give the anchor matrices).
- **Reference-node matcher 0x7425e0** (reached through the 12-byte thunk 0x744ea0 whose address sits in the visitor
  table 0x141114680 — a per-child `std::function` callback, so it has no code caller): strips the CatParts prefix from
  the child's instance name, then `referencepoint` → kind 2 (highest priority, stops); else `body` → 1; else `head`
  (but not `headblend`) → 0; `bhead…` is the back-head variant. INFERRED: run on the character's root clip to find the
  node the doll is positioned against; the consumer was not confirmed. Nothing else on the ROOT clip is read by the
  face code — all face work is on sprites the game creates itself.

**Mirroring and facing (catC, OBSERVED).** `Character_SetOrientation` 0x10ce50 `(Character*, packed dir, char,
char)`, 40+ callers incl. 0xf70f0: stores the direction at `Character+0x388/+0x38c` (`lock_orientation [x y]` at
`+0x3ac/+0x3b0` overrides it; `always_face_forward` `+0x3b4` skips turn animations; `start_orientation [x y]` →
`+0x388/+0x38c`).
- **Two-way** (`Character+0x4cd == 0`): `sx = +0x3a4·dx`, `sy = +0x3a4·dy`; unless `no_horizontal_flip` (`+0x3a8`),
  facing (`sx<0 || sy>0`) writes `anim+0x14c = −art_flip` and the root node's x-scale `(*(anim+0x70))+0xb8 =
  (double)(−art_flip)`, the other way `+art_flip` (`art_flip` = `+0x3a0`, default 1). Suffix: the prefix string
  `Character+0x3e0` as is (default `"F"`, set in 0xf1150) for `sx<=0 && sy<=0` with one negative, else prefix +
  `"B"`. So the clip needs `<anim>F` / `<anim>B` and **the x-flip is a scale(−1) on the character's root node,
  applied by the engine, not by the clip** — enemies mirror because they face left.
- **Four-way** (`+0x4cd != 0`): no flip; suffix = prefix + (`L` if `dx<0 || dy>0` else `R`) + (`F` / `B`) →
  `<anim>LF/RF/LB/RB`; 0xf1150 (lines 1134–1140) pre-registers `"RF"` and the `L`/`R` slot names. Turning plays
  `turnFlip` / `turnRev` / `turn180` through 0x9aaab0 when the new direction is opposite / perpendicular (`+0xc86`,
  `+0x390/+0x394` gate it). `four_way_animations` is read once (0xf31c5 in 0xf1150); the only other readers are
  0x10ce50 and 0x7e7d60 (a projectile/aoe helper, INFERRED). The `_R` labels (`dodge_R`, `backflip_R`) are **not**
  produced here (INFERRED ability-side variant names).

**Scale and shadow (catC, OBSERVED).** `graphics.scale` → `Character+0x3c8` (×1.15 when `+0xce0`, ×1.1 when
`+0xcac > 0`, unless `+0xcf4 == 2`) → a 2-double scale on the character's **root transform node** `*(Character+0x38)
+0x98` (0xf1150 lines 979–1004) — root, not doll. The shadow is a separate **`glaiel::Shadow` component** (0x80 bytes;
`Character_CreateShadow` 0x121ed0 → `Entity_AddShadow` 0x129e50, pool `DAT_1413f9110` → `Shadow_SetClipByName`
0x7946c0 = `Shadow::init(std::string)` (`Shadow.cpp:35`, `Added a shadow to an object that doesn't yet exist`) →
0x12ccb0: a sprite of the named symbol, layer 10); `shadow_size` → `+0x3d0` → `Shadow+0x60`; `shadow none` → no
component. INFERRED: when `Character+0x90` exists, `*(shadow_sprite+0x48)+0x48 = CatParts+0x160` — the cat's shadow
is drawn with the doll's paletted material.

**GeminiTwin::OnInit 0x8fa4b0 (catC, OBSERVED).** Reads `graphics.movieclip` (default `_CAT`) and `graphics.shadow`
(default `DefaultShadow`), creates a **second plain Sprite** of that clip name via `Entity_AddSpriteByName` 0x1b85b0
→ `Sprite_SetClipByName` 0x78ceb0 → 0x97a900 (**no `_CAT` special case**), a second Shadow (0x900cd0, size from
`*(Character+0x48)+0x60`), a node (0x12dfc0, layer 0x1d), then `0x9ac490(animctrl, Character->vtable[1](), 0)` = the
global AnimSet keyed by the character's id (`PTR_DAT_1412f7cf0`); missing → the no-return assert `gemini twin couldn't
copy animations, this shouldn't happen` (`VisualPassives.cpp:41`); suffix `+0xb8 = "F"`. 0xf1150 creates that AnimSet
for every character, so the assert cannot fire from a different root clip; INFERRED beyond the lookup: the twin of a
vanilla cat is whatever 0x97a900 resolves for `_CAT` (not a real export), and a rig cat with a real clip name gets an
un-dolled copy of the rig.

**SpawnDatabase::init 0x7a74b0 (catC, OBSERVED; `SpawnDatabase_init_0x7a74b0.c`).** `SpawnDatabase_LoadGonDir`
0x7c0cb0 `(out, dir, ".gon", recursive = 1)` → filesystem listing 0x9a1900 → `Gon_LoadFile` 0x611a0 per file, for
`data/characters`, `data/abilities`, `data/ability_templates`, `data/classes`, `data/items`, `data/passives`,
`data/mutations`, `data/maps`, `data/events`, `data/shops`, …; each list is merged file by file (0x945760; a duplicate
name logs `" defined in multiple places"` through 0x9522c0, non-fatal). So **every `.gon` under `data/characters` is
loaded regardless of name**, and a mod's `cat_enemies.gon.append` / `enemies.gon.append` entry lands in the same DB
(`spawn <Entry>` works — OBSERVED for the walk, the overlay is the known loader). `process_gon_variants(GonObject&
merged, GonObject& db, std::string what)` **0x94be60** (`Engine\code\util\util.cpp`) runs three times on the
**already-merged** objects (characters → `SpawnDatabase+0x38`, abilities → `+0x198`, a third list → `+0x5b8`), so
`variant_of` **across files works** (an appended entry may be a `variant_of` a vanilla one); a variant whose name
already exists is a fatal boot error (`… Named <x> exists (variant_of)`, 0x951ee0). `custom_cat_data` is read only in
0xf1150 (5 sites). Sole caller 0x32c3b0.

**What a rig clip must contain / must not do (catC, condensed; the slot rule is PR #74's).**
1. Every grayscale pixel under the doll root is palette-remapped (material on `CatParts+0xb8`, inherited) — draw
   rig-only art in colour or accept the cat's row (0x73e240, 0x73cc70).
2. Texture / scars / age overlays exist only inside the vanilla part symbols — keep the slots empty so the game places
   `CatBody` etc.; a rig drawing its own body gets none of it (0x73a450).
3. Faces are instantiated by the game from catparts.swf export names and parented to the head container, positioned
   by `CatHeadPlacements` — never rename or remove the head slot, never nest your own eye/mouth symbols expecting the
   engine to drive them (0x73cc70, 0x7393e0, 0x740a00).
4. Provide a prefix-free child `referencepoint` (or at least `body` / `head`) for the matcher 0x7425e0; `headblend`
   and `bhead` are reserved names.
5. Labels: two-way rigs need `<anim>F` and `<anim>B` for every animation the character plays (the states above plus
   `idle2primed` and the turn clips `turnFlip` / `turnRev` / `turn180`); four-way rigs the `LF/RF/LB/RB` quartet and
   no mirroring (0x10ce50, 0xf1150).
6. Do not bake a mirror into the rig: the engine writes `scale.x = ±art_flip` on the root node (two-way only);
   `no_horizontal_flip true` stops it, `art_flip -1` inverts it (0x10ce50).
7. `scale`, `shadow`, `shadow_size` are character-level (root transform, a separate Shadow sprite) — no own shadow,
   no pre-scaled art (0xf1150, 0x129e50, 0x7946c0).
8. Items go into game-created `HeadItemF/B`, `FaceItemF/B`, `Weapon`, `Trinket` sprites and are un-paletted; `TintItem`
   tints only them (0x73cc70, 0x73e240, 0x73e3c0).
9. `GeminiTwin` builds a plain sprite from `graphics.movieclip`; it never asserts for a normally spawned character
   (0x8fa4b0).

**Hook seams (assessment; none is needed for appended cat animations since A0).**
- **S1, scoped rig redirect — parked, optional.** The requested name is observable as a `std::string` in `rdx` at
  0x9bb890 (`"CatTest"` for every `_CAT` character; `<name>Portrait` from the same frame for portraits, so match on
  `"CatTest"` only); the registry is global, so a scoped rig must use a distinct export (e.g. `_CatRig_<Entry>`) and
  the hook can simply rewrite the name — before the lookup, since the cache is keyed by the rewritten name — with the
  current entry known from a 0xf70f0 prologue hook (same thread, synchronous: 0xf70f0 → 0xf1150 → 0x1219b0 → 0x12c960
  → 0x78ceb0 → 0x97a900 → 0x9bb890). Must verify the rewritten name with 0x9bb6f0 first and fall back to `CatTest`
  (0x97a900 is fatal otherwise). Everything downstream assumes the `CatTest` layout (root labels, `ani`, the seven
  slots). No blocker found; not built because PR #74 showed `_Append_CatTest` frames need no hook, and a native hook
  would only serve a non-`_CAT` character that should get a cat's parts.
- **Palette row (read or force per cat):** hook `Material_SetUniformInt` 0x9bdee0 / `Material_SetUniform` 0x9bdbf0
  with name `palette` and material `== CatParts+0x160` (one choke point for init and every refresh), or write
  `CatParts+0x1b8` and call `CatParts_Refresh` 0x73f7d0 — what `OverridePalette` does, a supported path.
- **Custom face preset:** insert into `DAT_1413c6148` (`CatParts_FindFace` 0x11e7b0 creates entries lazily), then
  `CatParts_SetFaceByName` 0x744890 / `CatParts_ApplyFace` 0x740a00.
- **Never mirror this enemy:** set `Character+0x3a8 = 1` after `Character::init` (read live by 0x10ce50).
- Validator rule candidates: labels `<anim>F/<anim>B` (or the four-way quartet) for the registered animation list;
  the slot children + a `referencepoint`/`body` child; `palette` an int row or a class name, −69 = multi.

Offsets (witness): `Character+0x40` MaskedRendererIso* (0xf1150, both branches, `+0x138 = 1` on it), `+0x58`
AnimStateMachine*, `+0x88` CatData*, `+0x90` CatParts*, `+0x240` entry node, `+0x248` name, `+0x3a0` art_flip,
`+0x3a4` sign, `+0x3a8` no_horizontal_flip, `+0x3ac/+0x3b0` lock_orientation, `+0x3b4` always_face_forward, `+0x388/
+0x38c` orientation, `+0x3b8` portrait idx, `+0x3c8` scale, `+0x3d0` shadow_size, `+0x3e0` suffix prefix, `+0x400`
portrait clip, `+0x48` Shadow*, `+0x38` root node (`+0x98` scale vec2), `+0x4cd` four_way, `+0xcde` champion,
`+0xcdf` elite, `+0xce0` boss-ish; `Renderer+0x80` instance, `+0xa8` name, `+0x54` layer; `MovieClip+0xd0`
definition, `+0xd8` current frame; `def+0x20` label map, `+0xb0` per-frame tag arrays; `App+0x114/+0x118` SWF
count/array, `+0x2b8/+0x2c0` name cache; `SWF file+0x30` sub-object (table at its `+0x28`), `+0x70` SymbolClass map,
`+0x78` SymbolClass `std::list` head (nodes 0x38 bytes: next, prev, `std::string` name `+0x10`, int id `+0x30` — what
`process_animation_merges` 0x9bc070 walks; a framework scanner of `_CatRig_*` exports would walk it over
`app+0x118[]`); `AnimStateMachine+0x38` root clip, `+0x60` type table, `+0x68` bound table, `+0x78` F/B alias map,
`+0xa8` variant alias map, `+0xb8` facing suffix, `+0xd8` sound prefix, `+0x148` target state, `+0x170` target name,
`+0x14c` flip sign, `+0x70` root node; `CatParts+0x80` name prefix, `+0xa8` doll root, `+0xb0` head container,
`+0xb8` material proxy, `+0x66` mirrored, `+0xc8..+0x11f` default FaceData, `+0x120` preset name, `+0x140` face name,
`+0x160` Material*, `+0x1b4` base palette, `+0x1b8` override palette, `+0x1c4..+0x65c` 14 PartSlots (stride 0x54:
`+0x1c` matrix ×`CatPartsSizeScale`, `+0x34` cxform mul, `+0x44` cxform add; CatPartID → slot: 0→0x1c4, 1→0x218,
2→0x26c, 0xb→0x2c0, 0xc→0x314, 0xd→0x368, 0xe→0x3bc, 0xf→0x410, 0x10→0x464, 0x11→0x4b8, 0x12→0x50c, 0x13→0x560,
0x14→0x5b4, 9→0x608; item slots 0x65c, 0x6b0, 0x704, 0x758, 0x7ac), `+0x8a8` CatData* (equipment at `+0x9b0,+0xa10,
+0xa70,+0xad0,+0xb30`, 5 × 0x60, item name `+0x28`; class name `+0xc10`); `DisplayObject+0x08` flags (0x20 visible,
0x40 has-frame), `+0x09` bit 2 playing, `+0x48` instance name, `+0x60` matrix, `+0x78` cxform, `+0x98` Material*,
`+0xb8` x-scale; `Material+0x28` params (stride 0x50), `+0x40` FNV name map, `+0x80` dirty; `Shadow+0x60` size.

Manifest-ready rows (prologue bytes and callee ordinals in `notes-catA.md` / `notes-catC.md`): `Character_init`
0xf70f0, `Character_init_clip` 0xf1150, `Swf_GetCharacterByName` 0x9bb890, `ApplicationBase_FindCharacter` 0x9bb6f0
(anchor: `lea r15,[rcx+0x2b8]` + the FNV constants), `MovieClip_GotoFrame` 0x9a88a0, `MaskedRendererIso_AddCat`
0x12c960 (call #8 = 0x51350 with `"CatTest"`; its twin `_AddNamed` 0xa5cf0 has 0x52460 there), `Renderer_init` 0x97a900,
`CatParts_apply_passives` 0x73e3c0, `CatParts_Refresh` 0x73f7d0, `CatParts_SetFaceByName` 0x744890, `CatParts_ApplyFace`
0x740a00, `CatParts_FillTexScars` 0x73a450, `CatParts_load_faces` 0x73a990, `CatParts_RefNodeMatcher` 0x7425e0,
`Character_SetOrientation` 0x10ce50, `GeminiTwin_OnInit` 0x8fa4b0, `SpawnDatabase_init` 0x7a74b0,
`SpawnDatabase_LoadGonDir` 0x7c0cb0, `Material_SetUniform` 0x9bdbf0 / `_SetUniformInt` 0x9bdee0 / `Material_Create`
0x9bd800, `Entity_AddShadow` 0x129e50, `Shadow_SetClipByName` 0x7946c0, `Entity_AddSpriteByName` 0x1b85b0,
`process_gon_variants` 0x94be60. Decompiles: `CharacterGraphics_build_0xf1150.c`, `Swf_GetCharacterByName_0x9bb890.c`,
`Swf_SymbolLookup_0x9bb6f0.c`, `MovieClip_GotoFrame_0x9a88a0.c`, `Renderer_SetClip_0x97a900.c`,
`AddComponent_CatClip_0x12c960.c`, `Character_AddAnimationAlias_0x103da0.c`, `AnimStateMachine_*.c`, `AnimTable_*.c`,
`MovieClip_{FindFrameByLabel,HasLabel,GotoLabel}_*.c`, `Character_UpdateFacing_0x10ce50.c` (catA);
`CatParts_{apply_passives,Refresh,load_faces,HeadReference,ApplyFace,FindFace,SetFaceByName,FillTexScars}_*.c`,
`CatParts_helper_73e240_0x73e240.c`, `Material_{SetUniform,Create}_*.c`, `Character_SetOrientation_0x10ce50.c`,
`Entity_AddShadow_0x129e50.c`, `Shadow_SetClipByName_0x7946c0.c`, `GeminiTwin_OnInit_0x8fa4b0.c`,
`SpawnDatabase_{init_0x7a74b0,LoadGonDir_0x7c0cb0}.c`, `CatData_GetPalette_0xbdc70.c`, `OverridePalette_OnInit_0x8068d0.c`
(catC; the full lists are at the end of each notes file).

### Facing: Character::Face (2026-10-22)

RE session `facing` (Ghidra 12.1.4 + objdump of the installed exe; decompiles in `.analysis/decompiled/`, the T2 run
below). Pinned in `bindings/25143593.json` (the facing block: `Character_Face` = `FW_SYM_Character_Face`, and 10 offsets
witnessed inside it) and host-tested as a pure rule in `native/mods/test-harness/src/mt_face.c`.

- OBSERVED (the 12 lambda vftable names inside it): **0x10ce50 is `glaiel::Character::Face(iVec2D, bool, bool)`** —
  what catA/catC called `Character_SetOrientation` / `Character_UpdateFacing`. rcx `Character*`, rdx the `iVec2D` by
  value (x in the low dword, y in the high), r8b `instant`, r9b force the turn animation. `instant` only counts when the
  byte `Character+0x11` is set; otherwise every call is instant.
- OBSERVED (0x10ce95..0x10cf03): a non-zero `lock_orientation` (`+0x3ac/+0x3b0`) **replaces** the argument; a
  non-instant call parks it at `+0x390` (the pending facing); `Facing_Candidates` 0x352aa0 turns it into its cardinal
  candidates (a diagonal gives both axes, (0,0) all four) and the current facing (`+0x388/+0x38c`) is kept when it is one
  of them, else the dominant axis wins.
- OBSERVED: `two_fronts_switch` (`+0xc86`, read by `Character::init` next to `two_fronts` `+0xc85`) negates the
  **facing sign `+0x3a4`** on a 180-degree turn; `always_face_forward` (`+0x3b4`) maps (1,0) → (0,−1) and (0,1) →
  (−1,0). Not instant + (`use_turn_animations` `+0x4cc` or force) + a changed direction → `turnFlip` / `turnRev` /
  `turn180` through `AnimStateMachine::Play` 0x9aaab0 with a lambda that finishes the turn, and return.
- OBSERVED (0x10dafb..0x10dcdb, two-way, `+0x4cd == 0`): `d' = sign · d`. Flip: unless `no_horizontal_flip` (`+0x3a8`),
  `d'x < 0 || d'y > 0` → `AnimSM+0x14c = −art_flip` (`+0x3a0`), `d'x > 0 || d'y < 0` → `+art_flip`; when instant also
  the root node's x-scale (`*(AnimSM+0x70)+0xb8`). **Suffix** (`AnimSM+0xb8`): `d'x > 0 || d'y > 0` → prefix + `"B"`,
  else (one negative) prefix + `"F"` (the literal at 0x140ed46bc), where the prefix is the `std::string` at
  `Character+0x3e0` — **empty by default**, so the suffix is plain `"F"` / `"B"` (catC read the prefix as `"F"`; the `F`
  is appended). Four-way: no sign, no flip, prefix + (`L` when `dx < 0 || dy > 0`, else `R`) + `F`/`B`.
- OBSERVED (0x10da7f..0x10dad6): a non-zero result is stored at `+0x388`; when instant, `AnimStateMachine::SetState`
  0x9aa360 replays the current state (`sm+0x148`) with `_DEFAULT`, so the new `<anim>F` / `<anim>B` label is drawn on
  the next frame.
- So, for a unit with sign +1: **(0,−1) and (−1,0) face the camera** (F; (−1,0) mirrored), **(1,0) and (0,1) face away**
  (B; (0,1) mirrored). A lock overrides every later turn. The orientation keys live under **`properties`** (below);
  PR #105 had them under `graphics`, which is why they did nothing.
- OBSERVED in the game (T2 run 20261022-124301, `mods/_artprobe/tests/render-cat-back.mewtest`): every unit of the
  seeded TacticsTest fight dumps sign 1; spawned units start at (−1,0) (F, flip −1) or (0,−1) (F, flip +1); `face 9
  back` → `facing "B"`, dir (1,0), flip 1, and the B frame is drawn on the next frame; `properties.lock_orientation
  [1 0]` spawns a unit on `B` that `face … front` cannot turn; the decompiled rule (`mt_face.c`) predicted every one
  of the three face events. Real save unchanged on every run.
- OBSERVED (0xf91c6..0xf9382, `Character::init`, all on `entry["properties"]`): `lock_orientation` → `+0x3ac/+0x3b0`,
  `always_face_forward` → `+0x3b4`, `start_orientation`, `two_fronts` → `+0xc85`, `two_fronts_switch` → `+0xc86`.
- OBSERVED (0xf92b6..0xf93c8, `Character::init`): `start_orientation [x y]` defaults to the lock (`IntOr(…, +0x3ac)`),
  is stored at `+0x388`, and a non-zero one is applied with `Face(+0x388, instant = 1, 0)` — the one `Character_init`
  call the manifest's `callers` anchor pins.
- What turns a unit in play (OBSERVED call sites of 0x10ce50: 112 calls in 89 functions plus 4 tail jumps from chunks without a `.pdata` entry, by an E8/E9 scan):
  `Character::DoAction(TurnAction, bool)` 0x10e550 faces the action's direction (`TurnAction+0x18`) for an ability
  unless the ability's `graphics.dont_orient`; `Character_FaceTowards` 0x10deb0 = `Face(Character_DirectionTo(tile)
  0x10e1e0, 0, force)` (`DirectionTo`: the doubled grid delta from `Character+0x60`, current facing kept when it is a
  candidate); the per-turn update 0x108490 faces the next tile of the move in progress (`+0x118`, INFERRED from the
  path-tile read) and applies the pending `+0x390` once the animation state machine is idle; the targeting UI
  0x778da0 (`target_empty_requires_doubleclick`, `move_hastargets` …) turns the selected unit toward the hovered tile;
  the health-gain sync 0x117410 turns a unit facing away ((1,0)/(0,1)) to the front before its floater; 0x7f4990
  clears the lock, faces a target and locks the new direction; about 40 ability-effect helpers 0x7c4680..0x7d46a0 face
  once each (INFERRED role).
- Harness: `face <unit> <dx> <dy> | front | back` calls `Face(dir, instant 1, 0)`; front / back = the unmirrored
  facing for the unit's sign (front `(0, −s)`, back `(s, 0)`); `dump` reports `facing` / `dir` / `lock` / `sign` /
  `flip` / `fourway` and `expect unit` reads them (docs/ingame-testing.md).

## Localization and text fields (2026-10-21)

Ghidra session `loc` (`.analysis/notes-loc.md`; decompiles `StringsDatabase_*.c`, `DynamicTextBox_*.c`,
`Clip_SetTextFieldByName_0x97c6f0.c`, `Swf_FindCharacterByClassName_0x9bb910.c`, `DamageText_*.c`, …). RVAs, build
25143593. The question was how the game gets localized text into SWF text fields, and whether a mod can — the answer:
**a data-only route exists** (the text-box constructor localizes an initial text that is a loc key) — **OBSERVED
in-game 2026-10-22 for a DefineEditText without the HTML flag; with vanilla's HTML wrapper the key is drawn as
written** (`docs/data-mods.md` "Localized text for mods").

**The strings database (`glaiel::StringsDatabase`, util/Localization.cpp; OBSERVED).**
- Global instance **`DAT_1413c5530`** (717 xrefs). `+0x00` `unordered_map<std::string, LanguageTable*>` keyed by
  FNV-1a 64 of the column name (find 0x4c340, the string-keyed map get `SaveProps_GetOrCreate` 0x61ea0's family), list
  sentinel `+0x08`, size `+0x10`; **`+0x40` current language `std::string`**; **`+0x88` gender int** for suffixed keys
  (0 → `KEY_M`, 1 → `KEY_F`, 2 → `KEY_N`, 3 → no suffix). A LanguageTable node is 0x70 bytes (`+0x10` name, `+0x30`
  `unordered_map<std::string, Entry*>` by FNV-1a of the key, `+0x38` sentinel); an Entry holds the text as a
  **`std::wstring` (UTF-16) at `+0x30`** (size `+0x40`, capacity `+0x48`).
- **Loading** (`MewApplication::OnLoad` 0x745f60, the debug reload 0x912150): `StringsDatabase_clear` 0x964750 →
  `FileManager_enumerate` 0x15e960(`"data"`, &files, `"data/text"`, `".csv"`, flag) → per file
  `StringsDatabase_load_csv` **0x9610a0**(&DB, parsed CSV table). **There is no `combined.csv` literal in the exe:
  every `.csv` under `data/text` is loaded**, through the file manager, so `-modpaths` copies and
  `combined.csv.append` go through the same resolver. The loader walks columns from index 1, takes the row-0 cell as
  the language name, converts every cell UTF-8 → UTF-16 (0x2d8f00, converter `DAT_1413c55d0`), replaces the wide
  `&nbsp;` with `DAT_1412f7ba8`, stores under the row's key (0x967050); an empty cell takes a fallback path (INFERRED:
  the `en` text; cf. the settings key `use_text_fallback_for_nonenglish` 0xf13fc8, read by 0x38d150). The `notes`
  column has no special case I could see (INFERRED skipped; `"notes"` sits at 0xf04664 right after `"mmm"`). Gendered
  rows are plain rows `KEY_M` / `KEY_F` / `KEY_N` — the suffix is appended at lookup, not a column.
- **Lookup — `StringsDatabase::get`, the game-wide one (100+ callers):** `std::wstring* get(StringsDatabase* db,
  std::wstring* out, const std::string* key, bool gendered)` **0x9616d0**. Empty key → empty. If `gendered` and
  `db+0x88 != 3`, tries `key + "_M"/"_F"/"_N"` with `has_key_nonempty` 0x9631e0 and recurses on a hit; otherwise
  language = `db+0x40` (the debug language `"mmm"` uses the `en` table and replaces every letter outside `[...]` with
  `M`), `find_language_table` 0x967500 (inserts an empty table on a miss), FNV-1a of the key into `table+0x30`; **on a
  miss the result is the key itself as a wstring** (0x9668d0) — that is the "missing text" display (the `*Missing
  Text*` literal 0x1130038 belongs to ImGui 0x9f1620, not to localization). Variants: `get_simple` **0x962430**(db,
  out, key) = get(…, gendered = 1) + `do_replacements`; `postprocess` 0x9624b0 = `String_ReplaceTokens` **0x94a1a0**
  (`'{'`, `'}'`; `MewControls::SetLocalizationReplacements` lambdas feed control glyph names, INFERRED from RTTI);
  `get_in_language` 0x962360 (set_language → get → restore); `has_key_current_lang` **0x963070** (used by SetText and
  the text-box init).
- **Language selection:** `StringsDatabase::set_language(db, const std::string& name, bool notify)` **0x960ad0**
  (funcsig 0x1129c80): `"system_default"` → `"en"`; else the name must be a loaded column or `"mmm"`, otherwise the
  no-return `UNSUPPORTED LANGUAGE: ` assert (0x951ee0); stores into `db+0x40`; with `notify` calls `app->vtable[7]`
  = `MewApplication::OnChangeLanguage(std::string)` (body 0x746a80, reloads `font_remap.gon`). **OnLoad order**
  (0x745f60): load all `data/text/*.csv` → `SteamLanguage_to_column` **0xa106c0** maps Steam's
  `GetCurrentGameLanguage()` to a column (`schinese` → `zh-CN`, `tchinese` → `zh-TW`, `koreana`, `brazilian` → `pt-BR`,
  `latam`/`spanish` → `es` …; OBSERVED strings) → 0x949320 (INFERRED to-lower) → `"es"` special-cased (INFERRED → `sp`,
  the CSV's Spanish column) → settings `prev_steam_language` (default `"default"`): **if the Steam language changed
  since the last run, both `prev_steam_language` and `current_language` are overwritten with it** → `current_language`
  (default `"system_default"`) → `set_language(&DB, value, 0)`. No `-language` command-line flag exists; the console
  command `set_language` (0x1115d70, registered in 0x750f90) does. Settings keys `current_language` (0xf04550),
  `prev_steam_language` (0x1114900); CSV rows `CURRENT_LANGUAGE_NAME` / `CURRENT_LANGUAGE_SHIPPABLE` feed the settings
  selector 0x28eee0, whose apply path 0x291030 writes `current_language`, calls `set_language(…, 1)`, fires
  `OnChangedLanguage` (0x29a340) and the popup `POPUP_SWITCH_LANGUAGE_INGAME_WARNING`.

**Text boxes (`glaiel::swf::DynamicTextBox`, glaielswf/renderer/TextBox.cpp; OBSERVED).**
- RTTI: `DynamicTextBox` 0x13af148, `StaticTextBox` 0x13af178, tag `DefineEditText` 0x13b3608. Instance creation:
  `DefineEditText_CreateInstance` **0xb797e0** (pool `DAT_14141f030`) → **`DynamicTextBox_init_from_DefineEditText`
  0x98d910**(tb, def): `tb+0x98 = def`; bounds from `def+0xc8/0xcc` and margins `def+0x58/0x5c` (±2 px); font
  `tb+0xb0 = def+0xf8` (the font character resolved from the id) **unless `def+0x40` (HasFontClass) → `tb+0xb0 =
  Swf_FindCharacterByClassName` 0x9bb910(`def+0x68`, the font class string)**; colour `def+0x50`, size `def+0x4c`,
  `def+0x44` outline flag (light or dark outline by the text colour's luminance, `< 0x17f`); then **the initial text
  `def+0xd8` (UTF-8) is passed to `has_key_current_lang` 0x963070 — if it is a key, the text becomes `get(key,
  gendered = 1)` + `{}` replacements, else the literal converted to UTF-16** → `tb+0xb8`, then
  `DynamicTextBox_layout_plain` 0x990480. **This is the data-only localization hook**: a DefineEditText whose initial
  text is exactly a key in the current language's table shows the localized text with no code. **OBSERVED in-game
  2026-10-22** (run `20261022-090100-_artprobe-render-loctext`, `mods/_artprobe` clip `ArtProbeLoc`, fixture
  `artprobe-loctext-summary.json`): with the HTML flag clear (flags 0xeca1, initial text the bare key) both
  `ENEMY_TOMTOM_NAME` → "Tom Tom" and a mod key added by `combined.csv.append` (`ARTPROBE_LOCTEST` → "LOCALIZED OK")
  are localized; **with vanilla's HTML wrapper (flags 0xeca3, `<p align><font …>KEY</font></p>`) the key is drawn as
  written** (2 readable shots of 3 vote per question, all agree; shot 1 is covered by the "Battle Start!" banner). The
  vanilla initial text is HTML; PR #81 places the HTML pre-parse in `DefineEditText::init` 0xb79410 (`<p>` → newline),
  so the string `has_key_current_lang` sees for an HTML box is not the bare key (INFERRED: the newline-terminated
  stripped text or the raw HTML; the tag decoder is still not located — no `<font` literal in the exe).
- **Setting text at runtime:** `DynamicTextBox_SetText_wide` **0x98e8a0**(tb, const std::wstring*, bool force, bool
  allowMarkup): clears `tb+0x269`; equal text and not `force` → no-op; `allowMarkup` with `tb+0x26a == 0` and a `[`
  in the text → 0x991230 (fancy mode); copies into `tb+0xb8`, `tb+0xe0 = 1.0` (scale), **re-lays out synchronously on
  every call** (0x990480 plain / 0x991900 fancy, the caller of the markup parser 0x994080), `tb+0x268 = 1` (dirty).
  `DynamicTextBox_SetText_utf8` **0x98e790**(tb, std::string, bool localize, byte): with `localize`, a key
  (`has_key_current_lang`) → `get_simple` → the wide setter, else UTF-8 → UTF-16 → the wide setter — "a key if it is
  one, else literal" (41 callers: the cat-quote builder 0x8e130, tooltips, the damage text spawner).
  `Clip_SetTextFieldByName` **0x97c6f0**(clip, std::string name, std::wstring) = `0x5a100(clip+0x38, name)` (child by
  instance name) → the wide setter (force 0, markup 1); 0x97c680(clip, name, std::string) = SetText_utf8(localize = 1);
  0x97c760 = the same forcing fancy mode first (`+0x26a = 1`). Finding a box: `Clip_GetTextBox_by_name` **0x99a1b0**
  (via the component helper `GetTextBox_by_name` 0xe8fb0, which first loads the component's clip `+0x80`) and
  0x99a5a0(clip, name, 0) (Button widget, damage text). `DisplayObjectContainer::SetVariable` 0x99b590 (funcsig
  0x112d290) is the AS2 property setter (`_x _y _xscale _yscale _alpha _visible _rotation`; `_name` asserts `SETTING
  _name DONT WORK CURRENTLY`; anything else goes into a per-container map at `+0xa0`) — it does **not** set text; the
  DefineEditText `VariableName` field was not seen used.
- **Markup ("fancy text"; `DynamicTextBox::process_command` 0x996ff0, parser 0x994080):** square-bracket commands
  `bold`/`b`, `italic`/`i`, `font`/`f`, `size`/`s`, `color`, `outline`/`o`, `style`/`st`, `animation`/`a` (`shake`,
  `wave`, `pulse`), `image`, `nbsp`, `FontIcon_*` / `RawFontIcon_*`, each with a `/x` closer; error `too many nested
  color changes in text`. **The HTML subset in a DefineEditText (`<p align><font size color letterSpacing kerning>`) is
  not interpreted by the runtime text path** — no such literals exist; the CSV uses `[b]…[/b]`. `[font X]` resolves X
  through 0x9bb910.
- **Button widget** (0x97dfb0 init / 0x97ec60 apply-label / 0x97f6f0 state machine, `_Hover` / `_Press` labels): the
  label `std::wstring` at `widget+0x1b8` is pushed into the clip's text box named **`label`**; call sites assign
  `+0x1b8` after `Clip_GetChildByName` 0x97c4f0(clip, name, create = 1).
- **Bind sites:** 0x20d400 (house interstitial): `Clip_SetTextFieldByName(clip, "label", …)` then
  `get(&DB, &w, "HOUSE_INTERSTITIAL_BUTTON_OK", 1)` → `ReplaceTokens` → `child = Clip_GetChildByName(clip, "ok", 1)`
  → `child+0x1b8 = w`; 0x7988e0 / 0x912610 / 0x20c140 follow the same pattern. The debug reload 0x912150 (press R)
  reloads the CSVs and does `SetText_utf8(tb, "DEBUG_TEST_CHINESE_WORDWRAPPING", 1)` with `tb+0x3b0 =
  FindCharacterByClassName("NPCFont_Frank")`. `AbilityTooltip` 0xed2fc0 is a component name (0x53e20), not a text
  site. **`LocalizedMovieclips`** component (0x74830 registration; ctor 0x74dc0 binds `OnChangedLanguage` → 0x746e0,
  which re-applies per-clip alt frames) and the global ActionScript binding **`SetLocalizedAltFrame(MovieClip*)`**
  (0x74380 registers it into `DAT_1413c59e0`) let SWF script select a per-language frame (drawn `ADVENTURE_BOX_LABEL`
  art vs. a text box); names OBSERVED, lambda bodies not decompiled.

**Fonts (OBSERVED).** `Swf_FindCharacterByClassName` **0x9bb910**(_, std::string* name): (1) the per-language
override map `app+0x320` (filled by 0x746a80 from `data/font_remap.gon` `overrides`, e.g. `Peralta → TikaFont`)
replaces the name; (2) `ApplicationBase::FindCharacter` 0x9bb6f0 — the same global export-name registry as the clips
(cache `app+0x2b8`, last-loaded file first, `file+0x70`); (3) only tag types 10 / 48 / 75 (`DefineFont`/`2`/`3`,
`char+0x24`) are accepted, else null. **This is the font-class → font lookup PR #81 left as "unknown (candidates
0x9bb910, 0x98d910)": 0x98d910 is the caller, 0x9bb910 the lookup.** So a mod SWF can provide a font class: a
DefineFont3 (only version 3 decodes — PR #81) with a SymbolClass / ExportAssets name is found the same way, and a
later file in `swflist.gon` shadows an earlier one of the same name (INFERRED from the walk order). 0x746a80 reads
`languages`, `overrides`, `glyph_lookup_order`, `font_adjustments`, `dialate` (`No font info found for language: `);
`DAT_1413c6c80 = FindCharacterByClassName("NotoSans")` is the global fallback (0x7469b0). `DefineFont::decode`
0xa2a4a0 (`ERROR: DefineFont version unsupported`): reads flags, the NUL-terminated name, the offset table (wide with
flag 0x08), the code table (wide with 0x04) into a code → glyph map, and with HasLayout (0x80) ascent / descent /
leading and the advance table ×0.05 (`+0x40`), skipping the bounds and reading the kerning pairs.
**OBSERVED in-game 2026-10-22** (run `20261022-134011`, fixture `artprobe-raster-summary.json`): a mod SWF's own
DefineFont3 (`scene.fonts`, `src/core/art/font.ts`: vanilla's flags 0x84, glyphs with FillStyle0 = 1) exported by
SymbolClass is found by a DefineEditText naming its class and drawn with its own glyph shapes; a character the font
lacks is drawn from another font (the fallback above; `font-glyph-missing` warns); **a class that no loaded SWF exports
crashes the game when the text is shown: 0xc0000005 at `Mewgenics.exe+0xa2addf`** (run `20261022-134035`; the
`font-class-unknown` error).

**Damage / floating text (OBSERVED calls).** Same path: `data/damage_text_styles.gon` is parsed by 0x7a74b0 (GON
only; `outline_color` users 0x2bcf90 / 0x3363f0 / 0x88d780); `DamageText_build` 0x2bcf90 builds the style + wstrings
(`get` for suffix-like keys, `_thresholds`); `DamageText_spawn` **0x2b3ae0** fetches the boxes from the damage clip
with 0x99a5a0, sets frames (0x9a88a0 / 0x9a8c00: `Colorless`, `classed_indicator`, `itemx`) and writes with 0x98e8a0 /
0x98e790 — ordinary `DynamicTextBox`es in a vanilla clip, styled by colour / outline / scale from the GON; no separate
renderer.

**What localized mod text takes (OBSERVED 2026-10-22).** Data-only: (a) a `combined.csv.append` row `MY_KEY,…` and
(b) a `DefineEditText` whose initial text is exactly `MY_KEY` **without the HTML flag** — `scene.texts[].html: false`
in the editor (`text.ts` `EDIT_TEXT_FLAGS_PLAIN` 0xeca1); the default HTML wrapper is not localized. Gendered variants and `{}` tokens come for free. Caveats:
the key must exist in the *current* language's table (a key only in `en` is not found while playing `fr` unless the
loader's empty-cell fallback filled it — INFERRED), and the text is resolved once at instance creation (no live update
on a language change unless the clip is recreated). A native hook is needed only for text that changes at runtime
(`SetText_wide` 0x98e8a0 / `Clip_SetTextFieldByName` 0x97c6f0 are small, non-virtual, stable-callee targets) — not for
fonts (0x9bb6f0 already finds mod-exported DefineFont3 classes).

Offsets: `StringsDatabase+0x40` language (0x960ad0 `lea rcx,[rbx+0x40]`), `+0x88` gender (0x9616d0 `cmp dword
[rcx+0x88],3`); `DynamicTextBox+0x98` DefineEditText*, `+0xb0` font, `+0xb8` text wstring, `+0xe0` scale, `+0x268`
dirty, `+0x269`, `+0x26a` fancy mode, `+0x3b0` font override (0x98e8a0 / 0x912150); `DefineEditText+0x40`
HasFontClass, `+0x44` outline flag, `+0x4c` size, `+0x50` colour, `+0x58/0x5c` margins, `+0x68` font class string,
`+0xc8..0xd4` rect, `+0xd8` initial text, `+0xf8` font char (0x98d910); `MewApplication+0x2b8` export-name cache,
`+0x320` font overrides, `+0x360` Steam, `+0x3b0` settings store, `+0x114/+0x118` loaded SWF count/array. Manifest-ready
rows with prologue bytes and callee ordinals: `notes-loc.md` (`Loc_Get` 0x9616d0, `set_language` 0x960ad0, `load_csv`
0x9610a0, `has_key_current_lang` 0x963070, `get_simple` 0x962430, `TextField_SetText` 0x98e8a0, `_utf8` 0x98e790,
`Clip_SetTextFieldByName` 0x97c6f0, `Clip_GetTextBox_by_name` 0x99a1b0, `TextBox_init_from_DefineEditText` 0x98d910,
`Swf_FindCharacterByClassName` 0x9bb910, `String_ReplaceTokens` 0x94a1a0).

The same session also decompiled the GON overlay dispatch (`Gon_overlay_apply` 0x9a64a0 → `Gon_Append` 0x945410 /
`Gon_DeepMerge_plain` 0x945c30 under `Gon_DefaultMergeMode` 0x9451c0 / 0x946680) — folded into "Verified behavior"
and `docs/data-mods.md` "Fidelity to the decompiled merges" by PR #78; nothing from it is missing there.

## Per-unit glow (native, 2026-10-22)

The native half of a per-unit glow: `FW_SetUnitGlow(Character*, r, g, b, a)` / `FW_ClearUnitGlow(Character*)` (API v4,
`native/framework/src/glow_engine.c` over the host-tested `fw_glow_rules.c`), proven in-game by
`mods/dev-sandbox/tests/unit-glow.mewtest` + `npm run test:unitglow` (fixture `editor/test/fixtures/ingame/unit-glow-summary.json`).
It follows the "Glow and outline passes (2026-10-21)" decode (PR #80) and Ghidra session `rim` (`.analysis/notes-rim.md`,
container `rea_ghidra_rim`, decompiles under `.analysis/decompiled/`: `StatusMenu_update_0x81aee0.c`,
`MaskedRendererIso_Submit_0x78d4c0.c`, `Scene_SubmitDraw_0x989be0.c`, `Camera_render_0x9787c0.c`,
`Renderer_AddPostProcessPass_0x979880.c`, `PostProcessEffect_process_0x9776a0.c`, `vec_u32_AddUnique_0x72cd0.c`,
`TacticsTest_ctor_0x31c5f0.c`, `ImmediateModeGameUI_init_0x88d780.c` — the file name is the glow session's, the content is
TacticsTest's). Every number below is in `bindings/25143593.json` (one contiguous block after `DevMenu_TacticsTest_lambda`)
and reaches the DLL through the generated `signatures.h` / `offsets.h`.

- **The mask is a layer, not a draw call (OBSERVED).** Combat draw layer **0x18** (`CONST_MASK_LAYER`) is the outline mask.
  `StatusMenu::update` **0x81aee0** (StatusMenu vftable `0x141120ff8` slot 11) swap-removes every 0x18 from the previously
  hovered unit's renderer extra-layer vector (`StatusMenu+0xf8`, validated by the pool generation at `Character-8` against
  `+0x100`) and pushes 0x18 onto the newly hovered unit's with `vec_u32_AddUnique` **0x72cd0** (`(Character+0x40)->+0x68`:
  `{cap, count, data}` of uint32 at `+0x68/+0x6c/+0x70`). The unit's own `MaskedRendererIso_Submit` **0x78d4c0** (vftable
  `0x140ed81e8` slot 19) then calls `Scene_SubmitDraw` **0x989be0** once for its main layer (`+0x54` = 0x19) and once more
  per extra layer, every frame. Nothing re-draws anything.
- **The cameras and passes (OBSERVED).** `glaiel::TacticsTest` (vftable **0xf0f4b8**, RTTI `.?AVTacticsTest@glaiel@@`,
  28 slots; the glow notes first pinned this vftable on ImmediateModeGameUI, session rim corrected it) holds the combat
  cameras: `+0x58` the mask camera (RTT, layer 0x18 only, texture at `Camera+0x50`), `+0x68` the main camera (its passes
  at layer **0x1a** = `CONST_COMPOSITE_LAYER` composite the outline), the passes `+0x80` jumpflood_init, `+0x88`
  jumpflood_composite, `+0x90` the `ol_blur_x/y` chain, `+0x98` the white `composite_outlines`, and the mode int `+0xa0`
  (1 = jump-flood, else blur; no write to it was found in the ctor decompile). `Camera_render` **0x9787c0** clears
  `Camera+0x9c`, sets it when an enabled layer has items, draws each enabled layer and then runs every pass in
  `(Camera+0xb0)[layer]` through `PostProcessEffect_process` 0x9776a0 (returns on `pass+0x10 == 0` or a false predicate at
  `pass+0x60`/impl `+0x98`; rects `+0x18`/`+0x38` are normalized scissors; `+0x58` ping-pong). `Camera_AddPostProcessPass`
  **0x979880** `(Camera*, Material*, layer) -> Pass*` (0xa0 bytes, enabled, full-screen rects, flags 1, one `{Material*, 1}`
  entry; owned by the camera — never cache a `Pass*` across frames). Materials: `ShaderManager_GetOrCreateMaterial`
  **0x9bb5d0** `(mgr = the App global 0x13c4a30 itself, map at +0x278; std::string name, std::string shaderFile — both
  by value, callee destroys)`, `Material_SetUniformVec4` **0x9bde70** `(mat, name, x (xmm2), y (xmm3), z, w)`,
  `Material_SetUniformFloat` **0x9bddc0**, `Material_SetTexture` **0x9bdcd0** `(mat, name, Texture*, slot)`; the
  composites bind the mask texture as `framebuf` in slot **6** (`CONST_GLOW_FRAMEBUF_SLOT`). The 1.0-scale RTT textures are
  window-sized RGBA8 (`Camera_render`: internal format `0x8058`; the `+0x81` byte picks 1 or 4 bytes per channel).
- **What the shots corrected (OBSERVED 2026-10-22, four launches; the numbers are in the fixture).** The mask layer's draw
  mode 3 ("flat white") is `MovieClip_DrawFlat(clip, (1,1,1,1))` = the sprite **multiplied** by white: the mask's rgb is
  the sprite's own luminance (a black outline is 0, the Rat's gray body about 0.55) and its **alpha is the coverage**.
  Consequences: the game's blur route (`alpha_cutoff 0.75` on `.r`) and `composite_glow.shader`'s `(1 - tex.g)` cutout are
  luminance-based (they fit the light cat sprites); forcing the `ol_blur` chain on for our pass did not shape it at all
  (launch 1: a flat 50 % magenta fill over the whole Rat = `(1 - 0.55)` of the body); a rim keyed on `.r` lands inside
  the black outline (launch 2); and the game's `composite_outlines` pass starts **enabled** with full-screen rects and a
  predicate that is simply "the mask had content", so it paints `(1 - luminance)` white over the body of every masked
  unit — i.e. over any unit a mod glows — until a hover in jump-flood mode turns it off.
- **The hook (`glow_engine.c`).** `TacticsTest::LateRender` **0x88d780** = vftable slot **19** (`VT_TT_LATERENDER`, the
  only slot whose body starts with its prologue) is hooked with `MJ_InstallHook` like every other framework hook, after
  checking `TacticsTest_vftable[19]` is the signature-resolved address (a vtable slot swap was the notes' first choice;
  the prologue hook sees the same calls, chains with Mewjector and is undone on unload). After the original, every frame:
  a new `TacticsTest*` resets the registry (a new fight); units whose pool generation (`Character-8`, `OFF_CH_GENERATION`)
  moved are dropped; `vec_u32_AddUnique(renderer+0x68, 0x18)` for each registered unit unless present (StatusMenu strips
  it from the unit the hover left); the game's `composite_outlines` (`+0x98`) is disabled (restored when the last unit is
  cleared); our pass is re-found in `(mainCamera+0xb0)[0x1a]` by its first material or added
  (`AddPostProcessPass(mainCamera, fw_unit_glow, 0x1a)`, flags zeroed, `framebuf` = `maskCamera->+0x50` in slot 6,
  re-bound when the texture changes); `glow_color` is set when it changes. The material is created once
  (`GetOrCreateMaterial(App, "fw_unit_glow", "fw_unit_glow.shader")`, `glow_radius` 12) and lives in the manager's map.
- **The rim shader is data: `mods/fw-glow/shaders/fw_unit_glow.shader`.** Same vertex stage as `composite_glow.shader`;
  the fragment samples the mask's alpha in 16 directions x 3 rings up to `glow_radius` texels and paints `glow_color`
  with `clamp(max_ring(alpha * falloff) - alpha_here)`: a band outside the silhouette (black outline included), zero
  inside, fading outward. A `.shader` file in a mod path loads like any pack file (`-modpaths`), so the mod that calls
  `FW_SetUnitGlow` lists `fw-glow` next to itself; without it the material has no shader and draws nothing. Measured
  (launch 4, 3440x1440): `glow "Lil' Rat" 1 0 1 1` -> one connected magenta patch of **5653 px**, bbox (2628,692)-(2759,825)
  around the sprite 2646..2741 x 724..808, fading over ~16 px, outline and body untouched; after `FW_ClearUnitGlow` the
  noglow shot holds **0** magenta px; the run passed with the real save unchanged.
- **v2: per-unit colours (2026-10-22, OBSERVED in-game).** The mask is one texture holding every glowing unit with no
  identity (draw mode 3 writes the sprite's luminance and coverage, nothing per unit), and a `Material` holds ONE value
  per uniform when the main camera later runs its passes — so one material cannot draw two colours, and one pass cannot
  tell units apart. v2 therefore (a) groups the registry by exact rgba (stable, first appearance; `fw_glow_groups`)
  and creates one material per colour group (`fw_unit_glow`, `fw_unit_glow_1`, …, same shader); (b) with ONE colour
  draws one full-screen pass (exactly v1); with several, one composite pass per unit carrying its group's material
  (the pass's first `{Material*, int}` entry is rewritten in place each frame), **scissored with pass rect B** to the
  unit's screen rect. The rect is computed exactly as `TacticsTest::LateRender` computes the hovered unit's
  (disassembly 0x88e24e..0x88e4a0, the second of two identical blocks; the first, 0x88de1d.., does the StatusMenu's own
  renderer): `clip = renderer+0x80` only when the clip's vtable slot 0 returns 1 or 2; bounds `{x0,x1,y0,y1}` = clip
  vtable slot **16** (`call [rax+0x80]`); mapped by the leaf **0x9d46d0** with the clip matrix at **clip+0x60**
  (`x' = m0 x + m3 y + m4`, `y' = m2 x + m1 y + m5`, as a box; replicated in C); then by `Renderer_GetScreenMatrix`
  **0x78d600** (`x` from M0/M4/M12, `y` from M1/M5/M13); then `C = inverse(Position_GetViewMatrix` **0x9b4c90**
  `(maskCamera+0x38, out, interp))` (the inverse is the leaf **0xa07c70**, replaced by a C cofactor inverse; `interp`
  = `maskCamera+0x28` (scene manager) `+0x30`, a double passed in xmm2), `P = C x K` with
  `K = {zoom,0,0,0 / 0,zoom*zi,0,0 / 0,0,1,0 / 640,360,0,1}` (`zoom` = camera `+0x168` double, `zi` = the int at
  `+0x170`; `K`'s rows 2/3 are the .rdata vectors 0x141140520 / 0x141140960), and the canvas `x/1280`, `1 - y/720`
  (0x14113f47c, 0x14113f488; the canvas size is the manifest constants `CONST_GLOW_CANVAS_W/H`, read back from those
  floats by an rdata witness). A 20-canvas-px margin covers the band. A unit whose rect cannot be computed (no clip of
  those kinds, a singular view) has its pass disabled — never a full-screen pass that would paint its colour on every
  unit. Host-tested in `test_glow_rules.c` (groups, plan, the rect stages, pass writes); proven in-game by the "two"
  shot of `unit-glow.mewtest`: the Rat magenta + unit 0 (a cat) cyan gave a 5515 px magenta patch around the Rat and a
  9961 px cyan patch around the cat, apart (`unit-glow-summary.json` `two`). **Rejected:** one RTT camera + spare layer
  per colour (`Component_AddCamera`, layer bitset and draw-mode writes on layers the rim notes only INFERRED free, a
  full-window RGBA texture per colour, and a one-frame lag because a camera created after the main camera renders
  after it) — the rect route reuses only what LateRender already does every hovered frame. Bindings (glow v2 block,
  harvest-verified): `Renderer_GetScreenMatrix` 0x78d600, `Position_GetViewMatrix` 0x9b4c90 (FwSymbol 35/36),
  `OFF_RND_CLIP` 0x80, `OFF_CLIP_MATRIX` 0x60, `OFF_CAM_POSITION` 0x38, `OFF_SCENEMANAGER_INTERP` 0x30, `OFF_CAM_ZOOM`
  0x168, `OFF_CAM_ZOOM_Y` 0x170, `VT_CLIP_BOUNDS` 16, `CONST_CLIP_KIND_A/B` 1/2, every witness in
  `TacticsTest_LateRender`'s first `.pdata` chunk.
- **Limits.** Several colours: units whose rects overlap share both colours inside the overlap (the scissor is a
  rectangle, the mask has no identity); combat scenes only (`TacticsTest`); up to 16 units (and up to 16 colour
  materials, which live for the process); registrations belong to the current fight scene (register during the fight);
  main thread only; while any unit glows the game's white hover rim (blur mode) is off — the jump-flood passes
  (`+0x80/+0x88`) are not touched, so a jump-flood hover still works. A data mod asks for a glow with a status named
  `FwGlow_<hex>` (v3, below; `docs/data-mods.md` "Asking for a unit glow from data").
- **v3: a glow asked for from DATA (2026-10-22, OBSERVED in-game).** The request is a status NAME: `FwGlow_<rrggbb>` or
  `FwGlow_<rrggbbaa>` (`fw_glow_parse_status_name`, 13 or 15 bytes, so the std::string SSO alias rewrite applies). A data
  mod grants it through any vanilla mechanism that applies a status (`StatusOnSpawnIn` / `StatusOnBattleStart` passives,
  an ability's `effects`, a Temporary). `fw_status_table_find` answers `FW_STATUS_GLOW_SLOT` for any valid glow name
  without registration, so the 13 name-keyed lookups alias it to LuckUp like a registered name (no `NO STATUS NAMED`,
  no zero divisor) and the `apply_status` hook builds it: the LuckUp ctor, then the **glow vtable** = LuckUp's with the
  identity slots answering per object (one vtable for every colour; the object -> name table `FwGlowStatusObjs`, a
  32-entry ring) and slot **82** `VT_APPLYSTATMODIFIERS` replaced: LuckUp's (`0x1408a8f80`, objdump of the saved exe:
  `mov rdx,[rcx+0x38]; mov eax,[rcx+0x5c]; add [rdx+0x5d4],eax; cmp dword [rcx+0x5c],0; je Status_Remove; ret`) adds the
  stacks to the unit's luck; ours keeps only the removal at 0 stacks. The unit is registered with
  `fw_glow_set_from_status` (`fromStatus`); every frame, after the pool-generation prune, `fw_glow_sweep` asks
  `status_engine_glow_probe` (`fw_walk_find_live`: a non-removing glow object in the unit's entity, temporary ones
  included) and clears the rim of a unit that no longer carries one, so every vanilla removal ends the glow; a new
  fight scene drops native registrations only (`fw_glow_reset_scene`). `FW_RegisterStatus` refuses the `FwGlow_`
  prefix (`FW_STATUS_ERR_RESERVED`). **OBSERVED (run `20261022-113119-fw-glow-data-glow`):** under `StatusOnSpawnIn` the
  `apply_status` ctx **is the Character itself** — ctx+0x18 is the entity holding the statuses and the new object's
  `+0x38` (`OFF_STATUS_CHARACTER`) = ctx — while ctx+0x20 is the Scene, in this and every other shape ("Status effects",
  `Status_ApplyByName`; then still called the "character" of `fw_walk_apply_resolve`), whose +0x18 holds **no** components: the first
  launch registered that object, the sweep found no glow status on it and cleared the rim the same frame. The glow
  path therefore merges by the resolved **entity** (`fw_walk_entity_find_status`) and glows the status's own
  `+0x38`. With that, `spawn FwGlowRat` (mods/fw-glow) gave a 5620 px magenta patch (2628,693)-(2759,825) the pre-spawn
  shot lacks, `expect status FwGlow_ff00ff on "Lil' Rat"` passed, the real save unchanged
  (`editor/test/fixtures/ingame/data-glow-summary.json`). The unit's status bar shows LuckUp's clover icon for the
  status (the icon lookup is aliased to the template). **Rejected:** a per-frame scan of every unit's status list for
  `FwGlow_` names from the LateRender hook — the game never makes a component for an unknown name (apply_status falls
  through, the lookups say `NO STATUS NAMED` and one default is a divisor), so the name must be handled where the
  framework already hooks `apply_status`; the per-frame part is only the removal check of units already registered.
  **Removal, OBSERVED 2026-10-22 (run `20261022-120852-fw-glow-data-glow-expiry`, `mods/fw-glow/tests/data-glow-expiry.mewtest`):**
  a Temporary works and its expiry ends the rim. `FwGlowTempRat`'s `StatusOnSpawnIn { Temporary { status FwGlow_ff00ff
  stacks 1 turns 1 expires_on_end_turn true } }` reaches the same `apply_status` hook with the temporary flag set (log:
  `FwGlow_ff00ff: glow status created on … with 1 stacks (obj …, temporary)`) and the rim is drawn (5566 px magenta patch
  (2630,693)-(2757,825), none before the spawn). Spawned during the cats' turn in round 1, the status is gone from the
  `dump` after round 1 (the rat's own end of turn) and from the one after round 2; the sweep logged `glow: … no longer
  carries a FwGlow_ status; rim cleared (0 registered)`; the round-3 shot of the still-living rat (hp 964) holds 0 magenta
  px. Pinned by `editor/test/fixtures/ingame/data-glow-expiry-summary.json` (`compareExpiry`, glow-measure.ts). Not run
  in-game: stacks reaching 0 and a cleanse (they go through the same `Status_Remove` mark the sweep's
  `fw_walk_find_live` skips; host-tested only).
- **Bindings added (glow block, all harvest-verified):** functions `TacticsTest_LateRender` 0x88d780, `vec_u32_AddUnique`
  0x72cd0, `ShaderManager_GetOrCreateMaterial` 0x9bb5d0, `Material_SetUniformVec4` 0x9bde70, `Material_SetUniformFloat`
  0x9bddc0, `Material_SetTexture` 0x9bdcd0, `Camera_AddPostProcessPass` 0x979880 (`FW_SYM_*`), reference
  `Scene_SubmitDraw` 0x989be0, `MaskedRendererIso_Submit` 0x78d4c0, `StatusMenu_update` 0x81aee0,
  `Camera_SetRenderToTexture` 0x979d50; data `ShaderManager_global` 0x13c4a30 (`FW_DATA_ShaderManager`, = App_global);
  vtable `TacticsTest_vftable` 0xf0f4b8 (`BuildInfo.rva_TacticsTest_vftable`); offsets `OFF_TT_MASK_CAMERA` 0x58,
  `OFF_TT_MAIN_CAMERA` 0x68, `OFF_TT_BLUR_PASS` 0x90, `OFF_TT_COMPOSITE_PASS` 0x98, `OFF_CAM_RTT_TEXTURE` 0x50,
  `OFF_CAM_PASSES` 0xb0, `OFF_CH_RENDERER` 0x40, `OFF_CH_GENERATION` -8, `OFF_RND_EXTRA_LAYERS/COUNT/DATA`
  0x68/0x6c/0x70, `OFF_PASS_MAT_COUNT` 4, `OFF_PASS_MATERIALS` 8, `OFF_PASS_ENABLED` 0x10, `OFF_PASS_RECT_A/B` 0x18/0x38,
  `OFF_PASS_FLAGS` 0x58; constants `CONST_MASK_LAYER` 0x18, `CONST_COMPOSITE_LAYER` 0x1a, `CONST_GLOW_FRAMEBUF_SLOT` 6,
  `VT_TT_LATERENDER` 19. **Not bound, and why:** `Camera_AddLayer` 0x979bd0 and the pass-predicate lambda 0x8967b0 have no
  `.pdata` entry (leaf functions; the T1 test requires one); `Camera_render` 0x9787c0 is PGO-split into chained
  `.pdata` chunks (0x9787c0..dc, 0x9787dc..c42, 0x978ded..f98, ...) and the harvester reads only the first, so `Camera+0x9c`
  (had-content) has no witness — the engine never writes it (the predicate reads it). Following chained chunks is an
  improvement candidate for `readOffsetWitness`.

## Particle systems and effect clips (2026-10-22)

Ghidra session `particles` (`.analysis/notes-particles.md`, container `rea_ghidra_particles`; decompiles under
`.analysis/decompiled/`: `ParticleSystemData_decode_0x9c5970.c`, `ParticleCore_LoadSystems_0x9c88d0.c`,
`ParticleCore_LoadSystems2D_or_byName_0x9c7c40.c`, `Particle_decode_vec_0x9c3af0.c`, `Particle_decode_aabb_0x9c3e50.c`,
`AbilityGraphics_decode_0x96c20.c`, `ParticleBurst_spawn_0x604b00.c`, `Particles2D_load_0x338a30.c`). Data-side
summary and recipe: `docs/data-mods.md` "Particles and VFX"; the key list the editor uses: `editor/src/core/particles.ts`.

- **Decoder** — OBSERVED. `glaiel::decode(const GonObject&) -> ParticleSystemData` **0x9c5970** (funcsig string 0x112f1b0,
  `Particles.cpp` 0x112ef40). `movieclip` → `App_FindMovieClipByName(DAT_1413c4a30, name)` **0x9bb6f0**; on a miss it logs
  `"No Movieclip Named " + name` (category `Particles`, 0x951bc0) and substitutes **`ParticleError`**. `material` → material
  create 0x9bb5d0. Then `adaptive_growth`, `max_particles`, `render_layer`, `render_mode` (`default`/`separate`),
  `update_mode` (`unlocked`/`locked`), `simulation_space` (`global`/`local`), `ownership`, `projection_matrix`,
  `flat_movement`, `live_bounds` (`decode_aabb` 0x9c3e50, "needs 4 or 6 values"), the `emit_*` keys (`decode_vec` 0x9c3af0
  for directions), `emit_timespread_curve` (`flat`/`ease_in`/`ease_out`), `chain`, `spurt`, `chain_chance`,
  `particle_lifetime`, the curves `speed` / `rotation` / `rotation_speed` / `size` / `alpha` / `force` / `friction`
  (each `X`, `X_start`, `X_end`, `X_in`, `X_out`: suffix strings 0x112f068 / 0x112f040 / 0x112f048 / 0x112f21c; readers
  0x9c3500 / 0x9c4370 / 0x9c4740 / 0x9c53d0), `inherit_speed`, `face_moving_direction`, `speed_scale`, `tags`. Key names
  are built as immediates, so a plain string scan misses most of them.
- **No colour key.** Neither the decoder nor the .rdata key block 0x112ef00..0x112f5d0 has `color`/`tint`; a particle's
  colour is its clip's art. `continual_emission` (one vanilla use) has no string in the exe: a dead key. OBSERVED.
- **Elsewhere:** `scripts` 0x9c9810 (seven components: ParticleBouncePlane, ParticleAttractor, ParticleGlobalForce,
  ParticleCharacterCollision, ParticleRandomForce, ParticleLineCollisions, ParticleTornadoForce; `towards` 0x9ccdd0);
  `depth_bias` read at 0xa561be (0xa55470, renderer side); `unlit`, `is_3D`, `variant_of` INFERRED (renderer / GON loader).
- **Loader** `ParticleCore_LoadSystems` **0x9c88d0** (callers 0x3cef90, 0x7666a0, 0x766bd0) and 0x9c7c40 (callers 0x338a30
  particles2D, 0x3d1590): the file comes through the GON loader 0x9c78a0 (file manager, so `-modpaths` overlays apply);
  per top-level child without `combo` → decode → a name-keyed map (0x9c8410 assigns into an existing node: a duplicate
  name overwrites, INFERRED last-wins); with `combo` → a list of system names. `data/particles.gon` (0xf183a0) is loaded
  from TacticsTest::init 0x833ec2, AlleyBGTest 0x3cd2c5, ParticleTest 0x765968; `data/particles2D.gon` (0xf0fea8) 0x338b04.
- **Ability effect clips** — `graphics { particle / affected_particle / center_particle / area_particle / miss_particle /
  orient_particle }` decoded by **0x96c20** and resolved through `App_FindMovieClipByName` 0x9bb6f0: SWF clip names, played
  by `SpellParticle` (DetatchedCombatEffect, RTTI 0x132e718). Not particles.gon systems. OBSERVED (decompile).
- **References to systems:** `EliteParticle` (Passive; RTTI 0x138fa58, IsA 0x5aea90, string 0xf196b0), `ParticleBurst`
  (0xf222e0; 0x604b00), `GlobalParticle` (GlobalModifier, 0xf224d0), `global_particles` (TacticsTest::init 0x8347d7),
  `StatusEffectParticles` (component, 0xed88d8).
- **OBSERVED in-game 2026-10-22** (`mods/_vfxprobe`, `npm run test:artprobe -- --vfx`, fixture
  `editor/test/fixtures/ingame/vfxprobe-summary.json`): a `particles.gon.append` system whose `movieclip` is a mod SWF export,
  worn through `EliteParticle` by a spawned Rat, draws (a moving cloud of the mod's #ff0090 discs); a `particles.gon.merge`
  re-pointing vanilla `SparkleBuff`'s `movieclip` to a mod clip draws the mod clip. The window capture lagged the shot event
  by up to ~1 s in that run (the probe now waits 240 frames after each shot before changing the scene).

## Audio (2026-10-22)

Session `audio` (`.analysis/notes-audio.md`, 11 decompiles in `.analysis/decompiled/` with the "RE session audio"
header); the modder-facing summary is `docs/data-mods.md` "Sounds and music". OBSERVED unless marked.

- **Backend**: FAudio (XAudio2 API) over SDL3 audio; Ogg Vorbis by statically linked **stb_vorbis**
  (`stb_vorbis_decode_memory` 0xa47080 `(mem, len, int* ch, int* rate, short** out)`, open-from-memory 0xa45fd0);
  WAV by the engine's `WAVResource::decode` 0x9a6dd0. `AudioCore_init` 0x954e20 creates the submix voices
  `music_main`, `voice_main`, `ambience_main`, `environment`, reads the settings keys `soundeffect_cache_size_mb`
  (default 200 → cache budget `DAT_1413c1940[0x16]` = MB<<20) and `debug_check_audio_files_exist` (→ AudioCore+0x3a),
  registers the engine console command `soundevent_debug off|all|real` and the SWF frame-script callback `PlaySound`.
- **Pack layout**: `audio/` holds 16,076 `.wav` + 835 `.ogg` + 21 `.mid` + 235 `.gon`; sets `audio/combat_sfx.gon`
  (Folder `combat_sfx`, 7,622 files), `ui_sfx.gon`, `house_sfx.gon`, `audio/voices/*.gon` (cat voices, `#include
  voice_template.gon`), `audio/npcvoices/*.gon`; music `audio/music/<area>/*.ogg` + `music_info.gon` + `radio.gon`;
  `audio/ambience/*.ogg`, `audio/cutscenes/*_{music,sfx}.ogg`. Every vanilla WAV is PCM 16-bit, 1 ch (8,989 @ 48 kHz,
  6,898 @ 44.1 kHz) or 2 ch (189 @ 48 kHz); every music .ogg is 2 ch 44.1 kHz. All 22,525 file refs of the 232 sets
  resolve at `audio/<Folder>/<file>` lower-cased (T1 `editor/test/audio-tests.ts`).
- **`AudioCore::LoadSoundEffectSet(name, bool, bool)` 0x956110**: `Gon_LoadFile` 0x611a0 on `"audio/" + name`
  (`"audio/"` = 0x141115c04) — the overlay path, so `.merge`/`.patch`/`.append` apply (OBSERVED in game:
  `debug_list_loaded_files` lists `<mod>/audio/combat_sfx.gon.merge.raw`). A SetName already loaded is skipped.
  `SoundEffectGroups` is looked up **by name** (FNV index), so an `.append`ed second block hides the vanilla one.
  Each file → `Folder + "/" + file` → `SoundData_GetOrCreate` 0xa3b600 (cached handle, deferred load). With
  AudioCore+0x3a set, `FileManager_FileExists` 0x9a14c0 first, a miss logs (0x9522c0, non-fatal) `Sound File Missing:
  <path>\nWhen Loading Set: <SetName>`; default off. Channel parents other than `environment`/none/a defined channel
  log `NO SOUND EFFECT CHANNEL NAMED: `.
- **Which sets load**: `App_init_audio_sets` 0x750f90 — `combat_sfx.gon`, `ui_sfx.gon`, `house_sfx.gon`, then
  `voices/<n>.gon` for `data/catgen.gon` `voice_sets` + `special_voice_sets`, then each `.gon` from
  `FileManager_ListDir` 0x9a1900 on `audio/npcvoices` (pak index at FileManager+0x1c0, then every mod path at
  FileManager+0x268..0x270 = the mod-path vector 0x1413c58b8 via `directory_iterator`; code only, not run).
- **`SoundData::load` 0x9718a0** (async `load_deferred`): extension after the last `.` by `memcmp`, case-sensitive:
  `"wav"` 0x14112b440 → `GetWAVResource` 0x973380, fmt fields copied into the FAudio WAVEFORMATEX (+0x90 tag, +0x92
  ch, +0x94 rate, +0x9c align, +0x9e bits), data borrowed; `"ogg"` 0x14112a094 → `GetBinaryResource` 0x973750 +
  stb_vorbis decode to PCM16; else fatal `Unsupported Sound File: <path>`. Resource NULL (no file) → 0x971de0: 4096
  bytes of silence, mono 16-bit 41000 Hz — no log, no crash. `DAT_1413c6cb0` += data bytes (WAV) / file + decoded
  bytes (OGG): the number `debug_sfx_memory_use` 0x754930 prints as `Total loaded sfx: N bytes (M mb)`.
- **Lookup**: both getters → `FileManager_GetFile` 0x99ff50, mod paths first (r3dE). OBSERVED in game
  (`mods/_audioprobe`): a mod-only file loads (+35280 = its data chunk), a mod file at a vanilla path replaces it
  (+24000 vs +44714 vanilla, `pickup-vanilla-control.mewtest`), an absent file adds 0.
- **Music**: `MewsicController::init` 0x23f440 loads `audio/music/music_info.gon` with `Gon_LoadFile` (overlays
  apply); under `debug_check_audio_files_exist` a missing file is fatal `Music File Doesn't Exist: `.
  `SoundStream::QueueSongChunk` 0xb511b0: `GetBinaryResource(path)` (missing → fatal `Couldn't Find Song File: `),
  the whole .ogg stays in memory, decoded progressively (0xa45fd0); chunk 2+ must match chunk 1's rate and channels
  (fatal `Song Chunk Mismatched Sample Rate` / `… Channels`); the voice is 32-bit float, block = ch*4.
  Ambience: `"audio/ambience/" + name` (0x2443a0; INFERRED to stream like music, not followed).
- **Debug surface**: `debug_list_loaded_files` (App command, after `enter`) prints every loaded file key — text files
  as `<path>.rawpak` (pak) or `<modpath>/<path>.<mode>.raw` (loose), sounds as their pack path;
  `debug_sfx_memory_use`; `play_sound <Group>` (TacticsTest). The harness reads them with `expect console` and the
  runner-side `expect deltas` (`docs/ingame-testing.md`). Pinned by `editor/test/fixtures/ingame/result-audioprobe-sounds.jsonl`.

## Cat rig redirect (native S1, 2026-10-22)

Strategy S1 of the cat-parts plan, built on catA's entry path ("Cat parts: entry path, palette, faces, mirroring"
above; `.analysis/notes-catA.md`): a WHOLE custom cat clip for one `movieclip _CAT` character entry, the game's cat
path otherwise untouched. `native/framework/src/catrig_engine.c` (hooks) + `fw_catrig_rules.c` (pure, host-tested),
framework API v7 (`FW_RegisterCatRig`, `FW_CatRigFor`); data seam: a SymbolClass export `_CatRig_<Entry>`
(`docs/data-mods.md` "A whole cat rig for one character"). Bytes re-read from the installed exe (objdump) on
2026-10-22; decompiles on disk: `Swf_GetCharacterByName_0x9bb890.c`, `Swf_SymbolLookup_0x9bb6f0.c`,
`Renderer_SetClip_0x97a900.c`, `CharacterGraphics_build_0xf1150.c`, `Character_init_0xf70f0.c`,
`process_animation_merges_0x9bc070.c`, `process_animation_merges_caller_0x9baaa0.c`.

- **Hook sites (OBSERVED, prologues relocatable):** `Character::init(name, bool, bool)` **0xf70f0** (`mov rax,rsp;
  mov [rax+0x20],r9b; …` — rcx this, rdx the by-value `std::string*` entry name the callee destroys, r8b/r9b);
  `Swf_GetCharacterByName` **0x9bb890** (`mov [rsp+0x10],rdx; mov [rsp+8],rcx; push rbx/rsi/rdi; sub rsp,0x60` — rcx
  unused, rdx the by-value name; copies it twice, `ApplicationBase::FindCharacter` 0x9bb6f0, `def->vtable[3]`, destroys
  both copies and the argument; returns the instance or NULL); `ApplicationBase::process_animation_merges` **0x9bc070**
  (`mov [rsp+0x20],rbx; …` — rcx app, rdx the SWF file; called once per loaded file by 0x9baaa0's loop over
  `app+0x118[0..app+0x114)`).
- **SymbolClass list (OBSERVED in 0x9bc070, the manifest witnesses):** `mov rdi,[rdx+0x78]; mov rbx,[rdi]; cmp rbx,rdi`
  → `SWF+0x78` = the `std::list` sentinel (`OFF_SWF_SYMBOL_LIST`); `lea r14,[rbx+0x10]` → node+0x10 = the export name
  `std::string` (`OFF_SYMNODE_NAME`); `cmp dword [r14+0x20],0` → the int id 0x20 after the name (node+0x30,
  `OFF_SYMNODE_ID_FROM_NAME`), entries with id 0 skipped. The framework walks the same list after the original ran.
- **The redirect.** The `Character::init` hook keeps the entry's rig (registry lookup: exact, then `_Champion` /
  `_Elite` stripped) in a thread-local for the call, saved and restored. The by-name hook, while that is set and the
  name is exactly `CatTest`, calls the original with the rig name (a new by-value string, game allocator) — the
  creation chain 0xf1150 → 0x12c960 → 0x78ceb0 → `Renderer::init` 0x97a900 → 0x9bb890 is synchronous on the same
  thread, so only that entry's cat clip is affected; the portrait lookups (`<entry>Portrait`) and CatParts' part
  symbols pass through. A NULL from the rig name (no loaded SWF exports it) falls back to the original `CatTest`
  call (logged once), because `Renderer::init` is fatal on NULL. The `app+0x2b8` cache is keyed by the requested name,
  so the vanilla `CatTest` entry is never touched.
- **OBSERVED in game (run 20261022-121534, `render-rig.mewtest`; fixture `artprobe-rig-summary.json`):** the log shows
  `catrig: registered _CatRig_ArtProbeRigCat for ArtProbeRigCat (from data, …)` at load and `catrig: ArtProbeRigCat:
  CatTest -> _CatRig_ArtProbeRigCat` at the spawn; ArtProbeRigCat (`movieclip _CAT`, `custom_cat_data ArtProbeParts`)
  is drawn by our clip — the rig's yellow marker above a real cat (new dark outline 16998 / 22256 / 17537 px under it
  vs 10628 for the vanilla control), in all three shots, scale 1.91, mirrored like every enemy; ArtProbeVanillaCat on
  the same parts shows no marker (scoped). No crash; `real save file(s) unchanged`. So CatParts, CatData and the state
  machine accept a non-CatTest clip of CatTest's shape (root `idleF`/`idleB`/…, pose as `ani`, empty slots).
- **Limits.** The rig replaces CatTest wholesale: every animation the rig has no label for is a silent no-op (the cat
  keeps its frame) — a full rig needs the labels the cat plays (`idle`, `walk`, hits, `attack`, … × F/B); one rig per
  entry, 16 entries, names ≤ 63 bytes (clips ≤ 71: `_CatRig_` + entry); dev launches with a known build only (the
  framework's gate) — elsewhere the export is inert.
- **OBSERVED with the sample pairing (plan A2.4, 2026-10-22; `native/mods/catrig-sample` + `mods/catrig-sample`,
  `npm run test:catrigsample`, runs `20261022-130356…130611-catrig-sample-*`, fixture `catrig-sample-summary.json`):**
  1. *The DLL route.* `FW_RegisterCatRig({"RigSampleCat", "RigSampleCatClip"})` called from a mod DLL's `DllMain` (after
     `FW_Resolve` + `IsActive`; the framework is loaded first by `[LoadOrder]`) registers before any SWF loads (log
     `catrig: registered RigSampleCatClip for RigSampleCat (from a DLL)`; the DLL's `FW_CatRigFor` read-back agrees, its
     own lines go to `chainloader.log` as `[catrig_sample] …`), and the redirect works for an export with **no**
     `_CatRig_` prefix (`catrig: RigSampleCat: CatTest -> RigSampleCatClip`): marker over real parts 3/3, the control on
     the same parts none.
  2. *`_Champion` / `_Elite`.* The console's `spawn` refuses a name that is no entry (`No enemy named
     RigSampleCat_Champion`), so the game's own champion path (`r3dC_IsoOrPickUser_0x8d66c0.c` appends `_Champion` to an
     entry name; `Character::init` strips it and sets `+0xcde`/`+0xcdf`) is out of the harness's reach. With
     `RigSampleCat_Champion` / `_Elite` declared as plain entries (`variant_of RigSampleCat`), `Character::init` receives
     exactly that string, no rig is registered under it, and the framework's suffix stripping gave both the entry's rig
     (redirect line naming `RigSampleCat`, marker 3/3 each).
  3. *A label the rig lacks.* Rig with `idleF/B`, `hitF/B`, `hithardF/B`, `hitupF/B`, `knockbackF/B` only, in a seeded
     `_autoplay` fight vs the same fight against the vanilla-clip control: the two non-lethal hits played **our
     `hitF/B`** pose (1x marker caught in 2 shots); everything else the rig lacks was a silent no-op as decoded (the cat
     keeps its frame; nothing in debug.log or mewframework.log, no crash) and the fight ran identically (HP per dump
     15 10 5 0 0 0 0 0 0, rounds 1 → 5 in both). The one visible consequence: with no death label the killed rig cat
     **stays standing in its idle pose** for the rest of the run where the vanilla cat lies dead on its tile. Whether a
     swap rig should fall back to the vanilla labels it lacks is an owner decision (TODO).

## 3D rendering path (2026-10-22)

Ghidra sessions `r3dA`..`r3dE` (containers `rea_ghidra_r3dA`..`E`; notes `.analysis/notes-r3dA.md`..`notes-r3dE.md`,
build design `.analysis/notes-r3dF.md`, decompiles named there under `.analysis/decompiled/`) and the first T2 run of
the phase-0 observer (`MEWFW_OBSERVE3D=3`, `mods/dev-sandbox/tests/observe3d.mewtest`, lines pinned in
`editor/test/fixtures/ingame/observe3d-log.txt`). The full fact list, the remaining unknowns and the build steps are
[`possible_3d_work.md`](possible_3d_work.md); every address below is an entry of the manifest's 3D block (the last 61
entries of `bindings/25143593.json`). RVAs.

- **Two camera lists (OBSERVED, T2 + RenderCore 0x989020 asm 0x1409892c0..0x140989330).** List 1 → `Camera_render`
  0x9787c0 per camera (the 5 RTT side cameras of a fight; 5 calls per frame). List 2 → for every layer index × every
  camera, `Camera_RenderOneLayer` 0x979210 `(Camera*, int layer)` (unless `cam+0x58 == 1`): the world camera
  `TacticsTest+0x68`, the UI camera and other scenes' cameras. Both push `stack top × Camera_GetViewProjection` 0x9785e0
  (`K × inverse(Position_GetViewMatrix)`, zoom `+0x168`, y-flip int `+0x170`) and set the current camera 0x13c6d88.
- **World camera in a fight (OBSERVED, T2):** rtt 0, hdr 0, **zoom 78.2624**, flip −1, bitset 0x41fde1ffff1, VP m0 =
  68.0542 = zoom / 1.15 (the camera Position's scale), det < 0; non-empty layers 0x0, 0xa (shadows), 0xd, 0x12, 0x19
  (units), 0x23, all draw mode 0. A unit's `Renderer_GetScreenMatrix`: m12/m13 = ISO projection of its tile centre,
  m14 = 0. Render globals: flags 0x9, cull counter 0, depth bias 0, stack top 0.
- **Main RT (OBSERVED, r3dD + T2):** `App+0xc10` (RGBA8 + D24S8 MSAA, FBO `rt+0x1c`, samples `rt+0x50` = the
  `antialias` setting `App+0xdf4`, 32 on the owner's machine) is the target of every non-RTT camera; FrameBegin clears
  it once per frame with `App+0xd98/0xd99/0xd9a` = 1/1/1 (COLOR|DEPTH|STENCIL). Resolve blits colour only.
- **Frame model (OBSERVED, r3dA):** `Batch_SubmitFunctor` 0xa47820 copies a `std::function<void()>` (impl slot 0
  `_Copy`, slot 4 `_Delete_this`) into a state-only group; `Batch_Replay` 0xa481d0 calls slot 2 `_Do_call` in FrameEnd.
  The force bit (flags bit 0) stays set all frame, so the material/shader/texture caches (0x1413c1980, 0x1413c42b8,
  0x1413c19a0[], 0x1412f713c) and the instance VBO / indirect buffer / VAO bindings are what a functor must restore.
- **Depth (OBSERVED, r3dD):** sprite shaders never discard and always write `gl_FragDepth`; depth is tested and written
  only while flags bit 2 is set (mode-1 layers, drawn in reverse). `Shader_compile` 0xa55470 = text replacement
  (`" vert()"`/`" frag()"` → `" main()"`, `COMPILING_*_PROGRAM`, `MATRICES_AS_ATTRIBS`).
- **Assets (OBSERVED, r3dE):** `ResourceManager_GetBinaryResource` 0x973750 serves any path (first `-modpaths` entry
  that has it, then the gpak; overlays alone apply last-to-first); `App_GetTexture` 0x9bb490 loads `textures/<name>`
  through stb_image and crashes on a missing file (check `FileManager_FileExists` first).
- **Binding notes.** `Camera_render`'s and `Swf_DisplayObject_Render`'s witnesses live in their second `.pdata`
  chunks, entered as the witness hosts `Camera_render_body` 0x9787dc and `Swf_DisplayObject_Render_cull` 0x9b0b78;
  `MaskedRendererIso_RefreshSortKey` 0x78d480 and `Renderer_UpdateRootScale` 0x97ac40 are pdata-less leaves (documented,
  not entered; the Position offsets are witnessed in `Position_GetInterpolated` 0x9b4a30).
