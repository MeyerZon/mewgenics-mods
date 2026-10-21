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

Overlay file semantics for `.gon`, `.csv`, `.txt`: `X.append`, `X.merge`, `X.patch` map to GON's
Append / ShallowMerge-DeepMerge / PatchMerge.

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
  `.patch` variants, applied through GON's Append / DeepMerge / PatchMerge (RVAs `0x944cc0`, `0x944f50`, `0x946680`).
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

Full inventories from the Ghidra session lived in `.analysis/` (git-ignored): `list_procedures.tsv` (56,360 rows) and
`list_names.tsv` (452,868 rows incl. RTTI vftables) are not on disk since the 2026-10-19 wipe — regenerate with the
REA `list_procedures` / `list_names` tools when a task needs them; `decompiled/*.c` was rebuilt 2026-10-20 (every
manifest evidence path exists again, pinned by a test in `editor/test/bindings-tests.ts`), and the exe copy is back at
`.analysis/exe/25143593/Mewgenics.exe` (sha256 `4127cd6a…`, as in the manifest).

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
  stubs, so read or patch them only once the window exists. Nothing in `mewframework` hooks these slots yet
  (earlier notes claiming otherwise were wrong).
- **RNG**: the global state is 4 qwords (32 bytes) in the main thread's static TLS block at `+0x178` (the exe's
  TLS slot, index from its PE TLS directory; the save's `random_seed` property is loaded into it). `Rng_SeedState`
  0x94ee40 (`uint64_t* (uint64_t out[4], uint64_t seed)`) expands a seed into that state; `Rng_Reseed` 0x94f0a0
  calls it with an FNV-1a mix of `clock()`, `_time64`, the thread id and a counter, and copies the 4 qwords (the
  boot's non-dev branch and every dev-menu fight button reseed this way; the dev-mode boot does not). OBSERVED
  2026-10-20: the harness's `seed 42` right before `enter TacticsTest` makes the generated party and every roll
  after it identical run to run (`mods/jokers-luck/tests/luck-seeded.mewtest`); the state before the pin was already
  identical across launches of the same `test00.sav`.
- The framework exposes the code symbols as `FW_SYM_DebugConsole_Execute`, `FW_SYM_DebugConsole_init`,
  `FW_SYM_ApplicationBase_FrameBegin`, `FW_SYM_string_Allocate` and the data addresses as `FW_DATA_*`
  (`FW_GetData`, API v3).

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
  data, applier)`, 33 `OnApplied`, 82 `ApplyStatModifiers` (LuckUp: `character->luckBonus(+0x5d4) += stacks`, and
  marks removal when stacks reach 0), 170 `OnStacksChanged`, 171 stacks-cleared callback.
- Object fields: +0x18 entity, +0x20 owner character (also +0x38), +0x5c `int stacks`, +0x68 GON data, +0x74 applied,
  +0x75 removing, +0x76 `tickdown_this_turn`, +0xc8 applier, +0xe9 "temporary" flag.
- Character +0x18 = `Entity*`; Entity +0x24 = component count (u32), +0x28 = `Component**` array. Character +0xe50 =
  `touched_passives` (forces a stat recompute), +0x5d4 = accumulated luck bonus.
- `Status_ApplyByName` (RVA `0x483120`): `Status* f(std::string* name, void* ctx, int stacks, void* src, void* p5,
  void* p6, char temporary, char p8)`, a 793-way if-chain on the name calling a per-status apply function; the
  callee destroys the by-value string (`std::string::_Tidy_deallocate`, RVA `0x52780`). `ctx` holds the entity at
  +0x18 and the character at +0x20. The LuckUp branch (`0x5f9760`) merges into an existing LuckUp found through
  `Entity_FindComponentsByTypeId` (`0x969f90`) or constructs via `LuckUp_ctor` (`0x711c90`:
  `(Character*, Entity*, int* stacks, void** src, void** applier)`) which runs slot 30 before returning.
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
names — and the alias rewrite itself live in the pure `fw_status_rules.c` (host tests `test_status_rules.c`);
`FW_RegisterStatus` validates against them before it claims the name with Mewjector.
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
