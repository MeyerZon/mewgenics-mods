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
  /`object` → `+0xcf4` = 0..4). 0xf1150 reads: `custom_cat_data` (+ nested `default_face`, `class_anis`),
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

## Localization and text fields (2026-10-21)

Ghidra session `loc` (`.analysis/notes-loc.md`; decompiles `StringsDatabase_*.c`, `DynamicTextBox_*.c`,
`Clip_SetTextFieldByName_0x97c6f0.c`, `Swf_FindCharacterByClassName_0x9bb910.c`, `DamageText_*.c`, …). RVAs, build
25143593. The question was how the game gets localized text into SWF text fields, and whether a mod can — the answer:
**a data-only route looks to exist** (the text-box constructor localizes an initial text that is a loc key), pending
one in-game witness (`docs/data-mods.md` "Localized text for mods").

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
  text is exactly a key in the current language's table shows the localized text with no code (OBSERVED in the
  decompile, not yet witnessed in-game). The vanilla initial text is HTML; PR #81 places the HTML pre-parse in
  `DefineEditText::init` 0xb79410 (`<p>` → newline) — this session did not locate the tag decoder (no `<font` literal
  exists in the exe) and sees plain text at the init; whether the stripped string equals the key byte-for-byte is the
  open probe.
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
0xa2a4a0 (`ERROR: DefineFont version unsupported`).

**Damage / floating text (OBSERVED calls).** Same path: `data/damage_text_styles.gon` is parsed by 0x7a74b0 (GON
only; `outline_color` users 0x2bcf90 / 0x3363f0 / 0x88d780); `DamageText_build` 0x2bcf90 builds the style + wstrings
(`get` for suffix-like keys, `_thresholds`); `DamageText_spawn` **0x2b3ae0** fetches the boxes from the damage clip
with 0x99a5a0, sets frames (0x9a88a0 / 0x9a8c00: `Colorless`, `classed_indicator`, `itemx`) and writes with 0x98e8a0 /
0x98e790 — ordinary `DynamicTextBox`es in a vanilla clip, styled by colour / outline / scale from the GON; no separate
renderer.

**What localized mod text would take.** Data-only, pending one witness: (a) a `combined.csv.append` row `MY_KEY,…`
(the editor already supports it) and (b) a `DefineEditText` whose initial text is exactly `MY_KEY` — the editor's
`text.ts` currently wraps the text in `<p><font>` HTML; if the stripped string is not the key byte-for-byte, emit the
DefineEditText without the HTML flag / wrapper for key texts. Gendered variants and `{}` tokens come for free. Caveats:
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
