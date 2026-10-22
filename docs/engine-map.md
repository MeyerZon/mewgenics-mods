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

Overlay file semantics for `.gon`, `.csv`, `.txt`: `X.append`, `X.merge`, `X.patch` map (in `Gon_overlay_apply`
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
whitespace (char mask `0x2400100000000000` over chars `< 0x3e`); `#` comments to end of line; `"` opens a quoted
token, `\` escapes the next char (only `\n` → newline), the quotes are dropped and no flag survives; no `//` /
`/* */` / `#include` handling, so a pre-pass must supply them (INFERRED, vanilla relies on all three; candidate
`0xa50bd0`). Parser: `{` → type 3 object, `[` → type 4 array, a scalar is typed from its text: string (1) unless
`strtol(tok, &end, 0)` or `strtod` consumes it entirely → number (2) with int view `+0x50` and double view
`+0x58` both stored, exact `null` → 0, `true`/`false` → bool (5, `+0x60`); text kept at `+0x68`, type at `+0xa8`.
`.add` / `.multiply` in `Gon_DeepMerge` 0x946680 use the double view and re-render the text. The editor reproduces
the typing in `editor/src/core/gon/typing.ts` (pinned by `editor/test/gon-tests.ts`); the full rule-by-rule
comparison is `docs/data-mods.md` "GON typing fidelity".

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
- OBSERVED 2026-10-21 (session `bind`, `.analysis/notes-bind.md`, cross-checked in Ghidra): `LuckUp_ctor`
  (`0x711c90`, 292 B) pool-allocates **0xF0 bytes** (`41 B8 F0 00 00 00` memset length; pool global `0x1414e40`,
  element size 0xf8, referenced only by the ctor and its 54-byte static initialiser `0x1fa40`), runs the base
  `Passive::Passive` (`0x4c940`), zeroes +0xc8..+0xe0, writes word 1 at +0xe8 (so +0xe8 = 1, +0xe9 `temporary` = 0),
  stores `LuckUp_vftable` (`lea rax,[0xf57ab8]; mov [rbx],rax` at +140 — the **only** code reference to that vftable
  image-wide), sets **+0x18 = entity, +0x20 = owner character**, +0x28 = the owner's first qword, pushes itself into
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
IntOr; mov [r14+N],eax` from 0xf99ba, 0x3a apart). INFERRED: `+0x5bc..+0x5d4` are the per-stat bonus ints (the
known LuckUp `+0x5d4 += stacks` is the 7th = luck). Base block from `entry.properties`, the stat share subtracted so
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
(`OFF_CH_DIVINE_SHIELD`). **Max HP**: no stored field was found; the champion scaling treats `+0x5e8 + 4*con` as the
base formula (INFERRED for the runtime value, the getter with stat bonuses and status modifiers is unknown).
`Character_BeginTurn` / `GetTurnControl` touch none of these (`+0xeb4/+0xebc` there are re-entrancy counters).

**Parser scalar typing (OBSERVED: `Gon_LoadText` 0x940840, `Gon_Tokenize` 0x93f090, `Gon_ParseTokens` 0x93fcf0).**
`LoadText` wraps the text in `{ … }`, tokenizes, parses the root as an object and logs `GON ERROR: More symbols
exists after file completed parsing` if tokens remain. The tokenizer splits on whitespace where **`,` `:` `=` count
as whitespace**; `{ } [ ]` are single-char tokens; `#` starts a comment to end of line; `"` opens a quoted token
(`\` escapes the next char, the closing `"` flushes it) and **the quotes are dropped with no "was quoted" flag**;
unclosed quote / comment → the two `GON ERROR: didn't close …` messages. `//` comments (the pack's `.gon` files use
them) are not handled by the tokenizer — INFERRED stripped by an earlier pass (the overlay text goes through
`0xa50bd0(&gon, &text, …, 0x100, 1)` first). The parser: `{` → type 3 (`name value` pairs), `[` → type 4 (values),
anything else is a scalar that starts as type 1 with the token in `+0x68`, then `strtol(tok, &end, 0)` consuming the
whole token → type 2 with `+0x50`, `strtod` consuming it → type 2 with `+0x58` (both are always stored: `1.5` → int
1, double 1.5), then exact `null` → 0, `true` / `false` → 5. Consequences: bare `5` and `"5"` are identical number
nodes; `yes` / `True` / `1` are not bools (`Bool()` on them logs `is not a bool`); `1e3`, `0x10`, `-3` are numbers;
`5%` is a string `Percent()` reads as 0.05; `""` is an empty token → number 0 (INFERRED). The overlay engine's
`.add` / `.multiply` (PatchMerge) rewrite the int, the double **and** the token text (OBSERVED in-game:
`health.multiply 2` → int 12, double 12, text `"12"`). The editor-side parser's typing is another PR's concern;
these are the facts it must mirror.

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
