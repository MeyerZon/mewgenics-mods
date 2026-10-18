# Automation feasibility: driving Mewgenics for automated mod testing

Target build 1.1.21239 (Steam build id 25143593), `Mewgenics.exe`
SHA-256 `4127cd6a…eb77ea`. Read-only reconnaissance: no game bytes, no
`resources.gpak`, no save files were modified; nothing was launched against the
real save.

**Evidence tags:** `OBSERVED` = from this build's binary strings / decompiled
code / extracted `.gon` data in `.analysis/` and `.extracted/`. `INFERRED` =
reasoned from that evidence, not directly seen. `COMMUNITY` = public docs
(mewgenics.wiki.gg, Nexus mods, TheMegax/ParaboxAPI RE headers); community
sources are unofficial and the wiki carries "TODO"/WIP entries.

---

## TL;DR verdict

| Capability | Verdict | Basis |
|---|---|---|
| Launch a specific fight | **Yes**, via console `load <1-10 \| path.lvl>` (+ `tileset`) | COMMUNITY, corroborated OBSERVED |
| Hand a player unit to AI (auto-resolve a fight) | **Yes, data-only, feasible now** — `Uncontrollable` passive, `ReplaceBrain` component, or `ai{brain GenericBrain}` overlay on `PlayerCat` | OBSERVED + COMMUNITY |
| Deterministic RNG seeding | **No user-facing control.** Seed is stored per-save; only settable via memory/DLL. Internal replay system exists but undocumented | OBSERVED + COMMUNITY |
| Startup macro / headless / batch | **No.** No autoexec/`-execmacro`, no headless mode. `macro <name>` must be typed in-console. `stress_test`/`fuzz_test` self-run then self-terminate | OBSERVED + COMMUNITY |
| Per-turn state observation hooks | **Yes**, already proven (`TurnControl::NextTurn` hook installed by our mewframework) | OBSERVED |
| Full programmatic action layer (move/ability/end-turn via IPC) | **Needs more RE**; no IPC exists in any framework | INFERRED |

The single highest-value, lowest-effort lever is **AI-brain auto-resolve via a
data overlay** — the game already ships this exact configuration.

---

## 1. Debug console

### Enabling (OBSERVED + COMMUNITY)
- Config key `enable_debugconsole` (OBSERVED string `0x1411327f0`) and `dev_mode`
  (OBSERVED `0x141115b98`). Set either via `settings.txt` or as a launch flag.
- **How flags work (OBSERVED, decompiled `ProcessCmds` RVA `0x9b8bb0`):**
  `ApplicationBase::ProcessCmds` explicitly parses only `-savesuffix`,
  `-inheritsave`, `-modpaths`. **Every other `-<key> <value>` pair is a generic
  config-map override** (stored via the settings object at `+0x3b8`). So
  `-enable_debugconsole true`, `-dev_mode true`, `-validate_pedigree_tables true`
  are not hardcoded flags — they set arbitrary config keys. Any `settings.txt`
  key can be set the same way at launch.
- Open with backtick/tilde after launch (COMMUNITY). `listcmds` prints the
  authoritative in-build command list with overloads (COMMUNITY) — run it once
  in-game to get the ground-truth enumeration.

### Command set
Engine built-ins — macro/debug system (OBSERVED, string cluster `0x14113257x–
0x1411328xx`, same region as the 8 `DebugConsole::init` command lambdas):

| Command | Notes | Source |
|---|---|---|
| `record_macro <name>` | start recording; new recording cancels current | OBSERVED+COMMUNITY |
| `end_recording_macro` | finish + save. (Binary also has an `endmacro` string, but the command is `end_recording_macro`; `endmacro` is not the command name) | OBSERVED+COMMUNITY |
| `macro <name>` | **plays** a saved macro | COMMUNITY |
| `save_commands_as_macro <name> <n>` | save last n commands | OBSERVED+COMMUNITY |
| `clear_macros <name>` | remove a macro | OBSERVED+COMMUNITY |
| `clear_history` | clear command history | OBSERVED+COMMUNITY |
| `showdebug` / `hidedebug` | debug text overlay | OBSERVED+COMMUNITY |

Macros persist to `%APPDATA%\Glaiel Games\Mewgenics\<SteamID>\debug_console_macros.txt`
(OBSERVED string `debug_console_macros.txt`; path COMMUNITY). History file
`debug_console_history.txt` (OBSERVED). On a missing command the console logs
`No command named "X"` / `command "X" needs at least N arguments` / `Executed:`
(OBSERVED) — usable as parse-success signals from a keystroke driver.

Game commands — verified present as binary strings AND documented by the wiki
(OBSERVED strings listed; all also COMMUNITY unless noted). Grouped by purpose:

- **Start a fight / arena:** `load <1-10 | path.lvl>` (COMMUNITY; corroborated
  OBSERVED by `No_level_named`, `Level_name_exists_in_multiple_folders`,
  `levels/`, `no_layer_named`), `tileset <name>`.
- **Auto-run combat (self-terminating):** `stress_test <arena|.lvl>`,
  `stress_test_fast`, `fuzz_test <arena|.lvl>`, `fuzz_test_fast`, `benchmark`
  (OBSERVED cluster `0x1411205c0–0x141120640`). `replay_test`, `replay_test_fast`,
  `replay_test_full` (OBSERVED; wiki = TODO/no description).
- **Spawn / give:** `spawn <Enemy> [mod] [buff]` (OBSERVED `No_enemy_named`;
  `spawn_custom_stray`, `spawn_unit_next_fight`, `spawn_reflection_next_fight`,
  `spawn_side` OBSERVED), `spawntile <Tile>` (OBSERVED), `ObtainCoins/ObtainFood/
  ObtainItem/ObtainItemSet/ObtainRandomItems` (COMMUNITY; OBSERVED `money`,
  `No_item_named`), `get_furniture`, `equip <Item>` (OBSERVED), `swagout` (OBSERVED).
- **Unit / build:** `bind <Ability> [slot]`, `bind_passive <Passive> [lvl]`
  (OBSERVED), `passive <Effect>`, `mutate <part>` (OBSERVED; `No_mutatable_part_named`),
  `voice`, `music`, `weather`/`global <Weather>` (OBSERVED; `No_weather_named`).
- **Combat control / end turn:** `takeover` / `untakeover` (OBSERVED
  `0x141120730/0x141120720` — hand AI units to the human), `win` (auto-succeed),
  `killall` (OBSERVED), `999` (999 dmg to enemies), `1hp`, `wtf` (free actions),
  `refresh_turns` (OBSERVED — end the round).
- **Unlocks / progression (OBSERVED cluster `0x140ee8dc8+`):** `unlock`,
  `unlock_item`, `unlock_ability`, `unlock_passive`, `unlock_boss`, `unlock_npc`,
  `unlock_class`, `UnlockClass`, `TriggerProgressionUnlock`,
  `TriggerAllProgressionUnlocks`, `UnlockAllAdventureContent`, etc.
- **Misc (COMMUNITY):** `clear`, `crash`, `crash_silent`, `freeze` (OBSERVED),
  `soft_reset` (OBSERVED), `vsync on|off`, `set_day <n>`, `set_language`,
  `nohud`/`noui` (OBSERVED `nohud`), `skip_tutorial` (OBSERVED), `sequence`,
  `movieclip`, `go`, `lookup`, plus many `debug_*` / `gen_*` dev utilities.

> The binary string clusters confirm these are real command tokens for this exact
> build; the wiki supplies argument syntax. For a canonical per-build list, run
> `listcmds` in-game — cheaper and more reliable than re-deriving from the binary.

---

## 2. Launching specific fights — YES

`load <1-10 | path.lvl>` starts a chosen encounter from the current chapter or
any `.lvl` file (e.g. `load alley/miniboss/tankcat/ch1-tank1`); `tileset <name>`
sets the arena theme; `spawn`/`spawntile` populate it (COMMUNITY, corroborated by
OBSERVED level/enemy/tile lookup strings). The 2,361 `.lvl` files in the gpak are
the encounter catalogue.

**Determinism caveat (INFERRED):** `load` picks the *encounter*, but outcomes
depend on the save's RNG state (see §4). Fights are repeatable in content, not
bit-reproducible in result, without seed control.

---

## 3. AI-brain auto-resolve — YES (data-only, feasible now)

This is the highest-value testing lever and requires **no native code and no save
edits** — only a `-modpaths` GON overlay on the `dev` save.

**Brain model (OBSERVED):** brains are C++ classes selected by name in
`ai { brain <Name> }`. Classes present (vftables in `list_names.tsv`): `Brain`
(base), `PlayerBrain` (human input), `GenericBrain` (standard AI), `RandomBrain`,
`PatternBrain`, `DicerBrain`, `MountBrain`, `NoBrain`, plus debug/override
components `DbgPlayerBrain`, `DebugBrainTakeover`, `ReplaceBrain`,
`BrainFactionOverride`, `SwitchBrainFaction`, `InvertBrainFaction`. Unknown names
log `NO_BRAIN_NAMED`. The AI is a real decision engine driven by scored weight
tables in `data/ai_presets/{decision_presets,move_presets}.gon` (OBSERVED:
`damage_enemy`, `heal_ally`, `buff_self`, `consider_overkill`, movement presets
`keep_distance`/`stay_close`…).

**The game already ships AI-driven player-stat cats (OBSERVED,
`data/characters/player_cat.gon`):** `PlayerCat` has
`ai { brain PlayerBrain; decision_weights default; move_weights keep_distance }`,
but `CustomEnemyCat`, `PlayerCat_MiniMe`, `PlayerCat_MachineClone`,
`PlayerCat_ClotClone`, `PlayerCat_CambionMiniMe` are `variant_of PlayerCat` and
override `ai { brain GenericBrain }`. So "an AI brain plays a player-build cat" is
a first-class, shipped configuration.

**Three data-only ways to auto-control the real player roster:**
1. **`Uncontrollable` passive** — `glaiel::Uncontrollable` is a real passive class
   (vftable `0x140f9b830`, OBSERVED). Applying it makes a unit AI-play its turns
   (OBSERVED: `head_items.gon` Brain Chip = `Uncontrollable 1`; `parasites.gon`;
   `KEYWORD_POSSESSED`/`MADNESS` text = "takes turns, uncontrollable"). The Nexus
   "Auto-Battler Mode" mod is exactly this: add `Uncontrollable 1` to
   `player_cat.gon` (COMMUNITY). Overlay form:
   `data/characters/player_cat.gon.merge` adding `passives { Uncontrollable 1 }`.
2. **`ReplaceBrain` component** (OBSERVED, already used in `cat_minibosses.gon`,
   `disorders.gon`): `ReplaceBrain { brain GenericBrain; decision_weights default;
   move_weights keep_distance }` — swaps brain and configures the AI inline. Most
   controllable option. (Gated per-unit by the `allow_replacebrain` property,
   OBSERVED in `terminator.gon`.)
3. **Direct `ai.brain` override** — merge `ai { brain GenericBrain }` onto
   `PlayerCat`.

**Console alternatives (COMMUNITY):** `fuzz_test <arena>` runs player units under
*random/illogical* AI then crashes at battle end; `takeover`/`untakeover` hand the
*enemy* AI to the human (the inverse).

**Caveats:** (a) Default player AI is "dumb" (COMMUNITY); smarter class-specific
presets exist as community data mods if realistic play matters. (b) This
auto-resolves the *combat*, not the meta-flow — starting the encounter, advancing
between fights, and dismissing reward/event screens still need driving (console
`load`/`win` + a keystroke driver, or DLL automation).

---

## 4. RNG seeding — no user-facing control

- **No seed command or launch flag** (OBSERVED: `ProcessCmds` has no seed branch
  and no `-seed`/`set_seed`/startup config key was found; COMMUNITY: absent from
  wiki command list). Searched explicitly.
- **Seed state exists and is persisted per-save** (OBSERVED: `random_seed` sits in
  the save-file field cluster alongside `saves/`, `savefile_timer`,
  `winning_teams`, `unlocks`). COMMUNITY (ParaboxAPI RE headers): global
  `GameTLSLayout::rngState`, per-screen `MapScreen::generation_rng`,
  `LevelUpScreen::rng`, per-entity `CatData::random_seed`, `MapNode::seed`.
- **Replay system present** (OBSERVED: `replays/replay_info.txt`, `/replays/`,
  `no_replay_info_found`, and `replay_test*` commands). A replay harness implies a
  deterministic combat sim given fixed seed + input stream (INFERRED) — a real but
  undocumented/unverified determinism path.
- **Consequence:** deterministic runs require writing the seed into memory (via our
  framework DLL at the `rngState`/`CatData::random_seed` offsets) or reusing a
  fixed save. There is no flag-level reproducibility. For regression testing,
  either seed through the DLL or compare outcomes statistically across runs.
- Note: `VK_EXT_headless_surface` strings are vestigial SDL/Vulkan capability — the
  game renders via OpenGL and does not expose a Vulkan headless mode (OBSERVED).

---

## 5. Startup macros / headless / batch — NO

- **No autoexec and no `-execmacro`-style flag** (OBSERVED: no startup-command
  config key; `ProcessCmds` does only savesuffix/inheritsave/modpaths + generic
  `-key value`. COMMUNITY: none documented). Macros run only via `macro <name>`
  typed into the console after launch.
- **No headless/batch mode** (OBSERVED + COMMUNITY). Closest built-ins:
  `stress_test`/`stress_test_fast` auto-run an encounter then **close the game**;
  `fuzz_test`/`fuzz_test_fast` auto-run random-AI combat then **crash at battle
  end**; `_fast` skips HUD/skills/sounds but still renders. `auto_fuzz_test`
  (OBSERVED `0x140f0d038`) sits among dev-menu scene entries (`Cutscene_Viewer`,
  `texttester`, `trailercats`) — likely a dev-mode auto-fuzz scene (INFERRED), not
  a launch flag.
- **Practical startup automation** = launch with console enabled, then inject
  keystrokes to open the console and run commands or `macro <name>` (the Nexus
  "Mewgenics Sandbox Menu" tool already does exactly this: focus window → open
  console → type command → close; no injection, all manual — COMMUNITY). Or drive
  in-process from our framework DLL.

---

## 6. Hooks for a test harness — confirmed

- **Already proven (OBSERVED):** our mewframework installed a chainable observer
  hook on `TurnControl::NextTurn` (RVA `0x8e3c60`) via Mewjector `MJ_InstallHook`
  on three launches (main-save hash unchanged). `Character::BeginTurn`
  (`0x10a9b0`) is signatured and is where per-carrier turn logic dispatches.
- **Reachable combat state (OBSERVED offsets from status RE):** `Character+0x18` =
  `Entity*`; `Entity+0x24`/`+0x28` = component count + `Component**` array;
  `Character+0x5d4` = luck bonus; status objects carry owner/entity/stacks/GON
  data. Walking the entity's component array exposes statuses, passives, and brain.
- **Community-reconstructed hook surface (COMMUNITY, TheMegax/ParaboxAPI
  `GameSymbols.h`/`MewgenicsTypes.h`, targets this build):** `PlayerBrain_update`,
  `PlayerBrain_OnRequestAction`, `TurnControl_QueueAction`, `TurnControl_NextTurn`,
  `Character_BeginTurn`, `Brain::ai_metrics`, `Character::brain`/`brain_faction`/
  `is_player_cat`, `HouseCat::brain_has_control`/`brain_state`. `TurnControl::
  QueueAction` and `PlayerBrain_OnRequestAction` are the natural inject/observe
  points for a future action layer.

---

## Tiered testing recommendation

> **Update 2026-10-18.** Tiers A–C now have a driver: the `mewtest` harness
> (`docs/ingame-testing.md`). The debug-console dispatcher was located
> (`DebugConsole::Execute`, `docs/engine-map.md` "Debug console and application
> loop"), so a native DLL can run console commands in-process from the per-frame
> hook, count turns, walk units and write a JSON-lines result the Node runner
> turns into a verdict (`npm run test:ingame`, MCP `run_ingame_test`). The
> "startup macro" and "headless" gaps below are closed by that DLL rather than by
> the game; seed pinning (section 4) is still open.

**Tier A — Crash/load smoke test. Feasible now. Difficulty: low.**
Launch via `launch-dev.bat` (`-savesuffix dev`, `-modpaths …`), optionally with a
`load <lvl>` console macro, let it run or `stress_test` (self-closes), then scan
`%APPDATA%\Glaiel Games\Mewgenics\<id>\logs\debug.log` for `NO STATUS NAMED`/
`NO_BRAIN_NAMED`/GON parse errors and check the process exit code. Pure
plain-script orchestration; no RE needed. Catches load/merge regressions in a mod.

**Tier B — State-observation harness (framework DLL hooking turn events).
Feasible now. Difficulty: low–medium.**
Extend mewframework's existing `TurnControl::NextTurn` hook (and add
`Character::BeginTurn`) to dump combat state each turn (units, HP/mana, statuses,
active brain, turn order) to a log our harness reads. Foundation is already in
place and verified; remaining work is reading struct fields (many offsets known;
ParaboxAPI `MewgenicsTypes.h` fills gaps). Read-only — no action injection.

**Tier C — AI-brain auto-resolve. Feasible now. Difficulty: low (combat) /
medium (end-to-end).**
Data-only overlay on the `dev` save: add `Uncontrollable 1` (or a `ReplaceBrain`
component, or `ai{brain GenericBrain}`) to `PlayerCat` so player cats auto-play.
Combine with Tier B to record outcomes and Tier A to start fights. Combat
auto-resolves with no human input. End-to-end (map → fight → rewards → next fight)
still needs the meta-flow driven by console `load`/`win` + a keystroke driver or
in-process DLL automation — that glue is the medium-effort part. Default AI is
weak; use smarter decision/move presets if play realism matters.

**Tier D — Full IPC-driven action layer (move / use-ability / end-turn).
Needs more RE. Difficulty: high.**
No framework exposes a bot-facing IPC; it must be built into our DLL. Requires
REing and calling `TurnControl::QueueAction` / the ability-trigger path
(`Ability::trigger` RVA `0x320a0` is signatured) and `PlayerBrain`'s action-request
flow, plus an IPC channel (named pipe/socket) from our DLL to the harness. Highest
value for precise scripted tests, but the most RE and the only tier not reachable
with current artifacts.

**Determinism note (all tiers):** without seed control, prefer outcome assertions
that tolerate RNG (did combat complete? did the modded status/ability apply? no
crash? expected log lines?) rather than exact numeric reproduction, unless/until
the seed is pinned via the DLL (`rngState`/`CatData::random_seed`).

---

## Sources
- Binary: `.analysis/list_names.tsv`, `.analysis/decompiled/ProcessCmds.c`,
  `.extracted/data/{characters,ai_presets,items,passives}/`, `docs/engine-map.md`.
- Community: mewgenics.wiki.gg (Debug Console, Help:Debug console, Modding);
  TheMegax/Mewtiplayer → ParaboxAPI (`MewgenicsTypes.h`, `GameSymbols.h`);
  githubuser508/mewjector; Nexus mods 8/77/178 (auto-battle), 183 (mod framework),
  1 (Mewtator), Klkcpok/mewgenics-sandbox-menu. Community sources are unofficial;
  verify command behavior with `listcmds` in-game.
