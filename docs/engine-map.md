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
`tools/bindings/make-signature.mjs`) cover: ProcessCmds `0x9b8bb0`, FileManager resolve `0x9a09f0`, GetFile `0x99ff50`,
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

Full inventories from the Ghidra session live in `.analysis/` (git-ignored): `list_procedures.tsv` (56,360 rows),
`list_names.tsv` (452,868 rows incl. RTTI vftables), `decompiled/*.c`.

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
- **RNG**: the global state lives at `TLS block + 0x178`; the save's `random_seed` property is loaded into it.
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
  RVA `0xed1960`, `glaiel::LuckUp::vftable` at `0xf57ab8` (type id 0x4d6).
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
  `editor/test/art-emitter-tests.mjs`):** sprite 1346, 901 frames, 842 unique labels (first `unknown`; `Spin`
  present, `JokersGambit` absent). Every labeled icon frame = `FrameLabel` + one `PlaceObject2` at **depth 3** of a
  bare `DefineShape/2/3/4` (flags 6 HasCharacter|HasMatrix identity on first use, flags 3 Move|HasCharacter on
  swaps); **no nested movieclip is ever placed**. Frame 0 also holds a background shape at depth 1, a
  `DefineEditText` named `label` at depth 2 (removed at frame 1) and a border `DefineShape4` at depth 5; the tail
  removes depths 5 and 1 then runs seven empty frames; the ABC registers only `frame1 → stop()`. `PassiveIcon`
  (id 515, 915 frames) is the same pattern at depth 4. An `_Append_AbilityIcon` donor therefore mirrors a vanilla
  frame by placing its icon shape at depth 3 (`ABILITY_ICON_DEPTH` in `swf-emitter.mjs`).
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
harness enforces the rule instead (`editor/src/core/ingame/savecheck.mjs`): every `*.sav` in the saves dir is hashed
before and after a run and only `campaign0N.sav`, `test0N.sav`, `housetest0N.sav` (and `<suffix>`-prefixed forms,
in case a future build uses the suffix) may change; any other change is a `safety-violation`. OBSERVED 2026-10-18:
dev launches wrote `campaign02.sav` and `test00.sav`; `steamcampaign01.sav` untouched since 2026-03-31. Open: what
else the game does with the suffix (`Inherit Save File Suffix` exists in `ProcessCmds`); Steam Cloud's
`steam_autocloud.vdf` in the same dir suggests the `steam` family is what Steam syncs.
