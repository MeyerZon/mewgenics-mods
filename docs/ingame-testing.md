# In-game testing: the `mewtest` harness

The one layer the editor's validator cannot cover is "the game actually loads and runs the mod". The game has no
headless mode, no autoexec and no seed control, so this harness closes the gap with a native DLL that executes
debug-console commands in-process and a Node runner that launches the game, waits, and turns the evidence into a
verdict. Agents use it to TDD mods end to end without anyone at the keyboard.

This file is the single source of truth for the contracts shared by the three parts:

| Part | Where |
|---|---|
| Node runner, MCP tools, CLI | `editor/src/core/ingame/`, `editor/src/mcp/tools.ts`, `editor/scripts/ingame.ts` |
| Framework API v3 (console/frame-loop symbols + data addresses) | `native/framework/` |
| `mewtest.dll` (the harness) | `native/mods/test-harness/` (build with its `build.bat`, copy to `native/dist/`) |

Without `native/dist/mewtest.dll` every real run reports `cannot-run` naming the missing piece; the runner itself
is fully covered by `npm test` through a fake game (`editor/test/fixtures/fake-game.ts`), and the DLL's pure
modules by `native/test-all.bat`.

## How a run works

```
editor runner                                   Mewgenics.exe + Mewjector + mewframework.dll + mewtest.dll
  parse .mewtest (header + directives)            DllMain: inert unless -mewtest <path> and the framework is active
  preflight: exe, version.dll, chainloader.ini,   hooks DebugConsole::init (captures the console), FrameBegin (steps the
    mewframework.dll, mewtest.dll, appdata, Steam    script, one directive per frame), TurnControl::NextTurn (counts turns)
  take the lock (one game at a time)              cmd -> DebugConsole::Execute(console, msvc_string)
  write the directive body to the run dir         console output diffed from the console's own vector<string>
  record mewframework.log size (append-mode)      expect/dump read combat state through guarded memory reads
  hash every *.sav in the saves dir (read-only)     every event appended to the JSONL file and flushed
  spawn with cwd = game dir, SteamAppId=686060    quit / end of script / timeout / crash -> end event + exit code
  backstop kill at timeout + 45 s; kill 5 s after the end record if the game lingers (clean mode)
  read JSONL, scan the three logs, re-hash the save, decide the verdict, write report.json
```

Argument order matters: `ApplicationBase::ProcessCmds` treats **every** argument after `-modpaths` as a mod path, so
the runner always emits

```
-savesuffix <s> -enable_debugconsole true -dev_mode true
-mewtest <script> -mewtest_out <jsonl> -mewtest_hide 0|1 -mewtest_timeout <ms> -mewtest_clean 0|1
-modpaths <abs mod dir>...
```

## Script format (`.mewtest`)

Header lines `key: value` end at the first blank, comment or directive line. The runner owns the header and strips
it; the DLL only ever sees directives (it tolerates whole-line `#` comments) — a runner-side directive such as
`expect log` is passed to the DLL as a `# runner: …` comment so the body's line numbers stay the script's. Scripts committed with a mod live in
`mods/<mod>/tests/*.mewtest`; inline scripts (MCP `script`) are allowed too.

```
mods: jokers-luck, dev-sandbox   # -modpaths order, later overrides earlier; default = the owning mod
savesuffix: dev                  # /^[A-Za-z0-9_-]{1,32}$/, default dev (the existing dev save; never the real save)
timeout: 120s                    # 5000 | 90s | 2m, default 120000 ms
hide: true                       # default true: hide the window + swap interval 0
clean: false                     # default false: ExitProcess right after the end event. true: clear the app's running
                                 # flag and let the game shut down; the DLL terminates after 3 s, the runner kills after 5 s
interactive: false               # default false. true: -mewtest_pipe 1 — the DLL serves a named pipe and, at the end of
                                 # the script, idles for requests instead of ending (see "Interactive mode"); no quit needed

cmd <rest of line verbatim, 1..4078 bytes>       run a debug-console command
enter <SceneName>                                TacticsTest: replay the dev menu's test-fight button (no save opened);
                                                 Campaign: replay the save-slot click on the harness-owned disposable
                                                 slot mewtest01.sav (moved aside by the runner before the run, so it is
                                                 always a new game: the intro cutscene). Waits for the console like cmd;
                                                 once per script; an unknown name fails before launch
enter Campaign house                             the same fresh campaign, but the slot is marked as begun first
                                                 (game_began 1) so MewDirector::start resumes into the real House — no
                                                 interactive intro. Day 1, no cats, the neighbor's tutorial dialogue up;
                                                 the campaign director's commands exist (pinned in
                                                 editor/test/fixtures/ingame/console-campaign-listcmds.txt: the test
                                                 director's 17 + upgrade, upgrade_all, house_boss_event, max_npc_favor,
                                                 interstitial_test, spawn_custom_stray, house_weather, get_furniture, …).
                                                 The enter event carries "mode":"house"
seed <N>                                         pin the game's RNG (TLS+0x178) to N (0..2^64-1) once the game's own
                                                 startup is over (it reseeds there; the harness retries until the
                                                 director exists). Put it right before `enter`: the party and every
                                                 roll after it are then identical run to run, so assertions can be exact.
                                                 It also re-seeds the native mods' FW_Random stream (framework API v5)
                                                 with N, so a native status's rolls are pinned too (never CRT rand)
glow <unit> <r> <g> <b> <a>                      FW_SetUnitGlow (framework API v4) on a unit of the walk (index, bareword or
glow <unit> off                                  "name"): a coloured rim through the game's outline mask (0..1 floats; each
                                                 unit its own colour since glow v2); `off` = FW_ClearUnitGlow. Needs the fight and
                                                 `mods: …, fw-glow` (the rim shader). A missing unit or a refusal ends the
                                                 script with code 1 (glow_failed); a framework without API v4 with code 4
wait frames|turns|rounds|ms <N>                  N >= 1; turns = TurnControl::NextTurn calls; rounds = TurnControl's
                                                 round counter advancing by N from the directive
expect console "<substr>" [within <frames>]      a console line since the last cmd contains substr
expect noconsole "<substr>"                      no such line since the last cmd
expect status <Name> on <index|bareword|"name">  a unit carries the status (vanilla or framework-registered)
expect units <==|!=|>=|<=|>|<> <N>               unit count in the current combat
expect round <op> <N>                            TurnControl's round (0 outside combat)
expect stacks <Status> on <unit> <op> <N>        the status's stacks on that unit (absent status = fail)
expect stacks <Status> on <unit> varied          >= 2 distinct stacks values seen for (unit, status) by earlier dump /
                                                 expect stacks directives (and this one)
expect unit <unit> <field> <op> <value>          one field of one unit as the units event shows it: name|class|namekey
                                                 take a quoted value with == or !=; faction|move|act|turnkind|hp|shield|
                                                 divineshield|strength|dexterity|constitution|intelligence|speed|
                                                 charisma|luck take an integer (negatives allowed) with any op. Event
                                                 kind "unit", arg e.g. `8 name == "Lil' Rat"`, detail `unit 8 "Lil'
                                                 Rat": name "Lil' Rat"`. Faction numbers seen: allies 1, coins 0,
                                                 enemies 2. namekey is the graphics.name loc key (ENEMY_POOTER_NAME);
                                                 hp is current HP (= properties.health right after a spawn), the seven
                                                 stats are what Character::init stored (data value, default 5)
expect gon <unit> <path> <op> <number>           one node of the unit's merged data/characters entry, as the game holds
expect gon <unit> <path> ==|!= "<string>"        it (Character+0x240; variant_of-resolved, every overlay applied): the
expect gon <unit> <path> ==|!= true|false        DLL walks <path> (dot-separated; an all-digit segment indexes the
expect gon <unit> <path> exists|missing          children, any other is the first child of that name) without calling
                                                 the game. A number literal matches a number node only (compared on
                                                 the node's double, any op), a quoted string a string node only, true/
                                                 false a bool node only; `exists` = present and not null, `missing` =
                                                 absent or null. Event kind "gon", arg e.g. `8 properties.health == 12`,
                                                 detail `unit 8 "Pooter" (ENEMY_POOTER_NAME): properties.health =
                                                 number 12 (int 12, double 12, text "12")` / `… = string "allies"` /
                                                 `… = bool true` / `… = array with 0 children` / `… missing: no child
                                                 named "nope" among 5 at segment 2` / `… unreadable: …`. Nothing is
                                                 logged by the game (its own getters would log GON ERROR on a miss)
expect log "<substr>"                            (runner side) debug.log contains substr after the [file: …] prefix;
                                                 evaluated once, after the run — no within; no JSONL event, see report.logExpects
dump                                             snapshot the units into a units event
shot "<label>"                                   screenshot: the DLL emits a shot event and holds the scene 700 ms while
                                                 the runner captures the game window to <run dir>/shot-<label>.png
                                                 (artifacts.shots); needs `hide: false`, else the file shows the desktop
                                                 and the shot is flagged hidden. Frame 0..~250 is the black loading
                                                 screen: shoot after `wait frames 300` or after `enter`
log "<text>"                                     echo into the result file
quit [code]                                      no code: 0 if every expect passed, else 1; end of script == quit
```

String literals use double quotes with `\"` and `\\` escapes. Limits: 1024 directives, 4096-byte lines (`MT_MAX_LINE`). Everything
executes on the game's main thread from the per-frame hook, one directive per frame; waits consume frames.

## Result file (JSON lines)

Every event carries `t` (ms since harness start) and `frame`.

```
{"ev":"start","harness":"mewtest 0.1.0","build":"1.1.21239 (steam 25143593)","script":"...","out":"...","pid":N,"hide":1,"timeout_ms":N,"clean":0}
{"ev":"script_error","line":N,"msg":"..."}
{"ev":"cmd","line":N,"text":"..."}
{"ev":"enter","line":N,"name":"TacticsTest","ok":true,"detail":"scene=0x… entity=0x… component=0x… director=0x… …"}
{"ev":"console","text":"..."}
{"ev":"turn","n":N,"round":N}
{"ev":"wait","line":N,"kind":"frames","n":N,"actual":N}
{"ev":"expect","line":N,"kind":"console","arg":"...","ok":true,"detail":"..."}
{"ev":"units","available":true,"round":N,"count":N,"list":[{"i":0,"name":"...","class":"...","namekey":"ENEMY_POOTER_NAME","faction":0,"move":3,"act":1,"turnkind":2,"hp":6,"shield":0,"divineshield":0,"strength":5,"dexterity":5,"constitution":5,"intelligence":5,"speed":5,"charisma":5,"luck":5,"statuses":["LuckUp"],"stacks":[2]}]}
                                                stacks is parallel to statuses (Status+0x5c, the field FW_SetStatusStacks writes);
                                                namekey/hp/shield/divineshield/the seven stats (2026-10-22) read Character+0x248/+0x4b0/+0x4b4/+0x4b8/+0x5a0..+0x5b8
                                                (docs/engine-map.md "GON at runtime"); an unreadable field reads as 0 / ""
{"ev":"log","text":"..."}
{"ev":"shot","line":N,"label":"...","hold_ms":700}   the runner captures the window on seeing this (report.artifacts.shots)
{"ev":"seed","line":N,"seed":N,"ok":true,"detail":"state at 0x…: <before> -> <after>; FW_Random seeded"}
{"ev":"glow","line":N,"unit":N,"name":"...","arg":"<the directive's argument text>","ok":true,"detail":"FW_SetUnitGlow on 0x…: ok"}   unit -1 when no unit matched
{"ev":"idle","line":N}                               interactive mode: the script ran to its end; the DLL now serves the pipe
{"ev":"exec","id":N,"op":"exec","text":"...","ok":true,"lines":["..."]}   a pipe request served (also the reply on the pipe)
{"ev":"units","id":N,...}                            a dump requested over the pipe carries the request id
{"ev":"exec","id":N,"op":"quit","ok":true,"code":N}  the quit request's reply; the end record follows
{"ev":"popup","title":"WARNING","text":"..."}   a modal dialog of the game (its own WARNING/ERROR boxes) that the watchdog
                                                closed — it would otherwise stop the frame loop for good under a hidden
                                                window; never decides the verdict, appended to its reason
{"ev":"crash","code":"0xC0000005","addr":"0x...","module":"Mewgenics.exe","rva":"0x...","tid":N}
{"ev":"end","code":N,"reason":"quit|eof|timeout|crash|script_error|console_unavailable|enter_failed|enter_unavailable|seed_failed|seed_unavailable|glow_failed|glow_unavailable|framework_inactive|framework_missing|harness_error","frames":N,"turns":N,"elapsed_ms":N,"expect_pass":N,"expect_fail":N}
```

Harness exit codes: `0` pass, `1` an expect failed or `quit 1`, `2` script timeout, `3` crash, `4` harness error
(script parse error, console never appeared, framework inactive or missing), `N` from `quit N`. When mewframework is
inactive (unknown build or a failed signature) the harness still writes `start` + `end{code 4, reason
framework_inactive}` and exits 4 from a helper thread ~1.5 s after load, so the runner never waits for the backstop.
A `cmd` waits up to 30 s of wall clock (`MT_CONSOLE_WAIT_MS`) for the debug console to appear: with the window hidden
the game runs hundreds of frames per second, so a frame budget was never a time budget.

**Clean mode** (`clean: true` / `-mewtest_clean 1`): after the `end` record the harness closes the result file, clears
the app's running flag and lets the game shut itself down. The process exit code is then the game's own (or the
harness's after its grace), so the runner treats the `end` record as authoritative: `end.code` ≠ 0 with a 0/absent
exit code is still a `fail`. The exit/grace decision is the pure `mt_exit_decide` (`src/mt_exit.c`, host-tested):
crash grace 5 s > clean grace 3 s > script timeout, fired once, independent of any other harness state (the old inline
version skipped the grace when the script-error path had already deactivated the harness — the "never exits" bug). The
watchdog leaves via `TerminateProcess` (an `ExitProcess` from a helper thread can block on the loader lock). The runner
has its own fallback: once `end` is on disk it kills a game that still lingers after 5 s (`END_GRACE_MS`) and reports
`killedAfterEnd`. OBSERVED 2026-10-19 (build 25143593, `dev-sandbox/console-smoke-clean`): the flag is cleared and the
game does **not** shut down within 3 s; the DLL grace ends it with the script's code (`clean exit grace elapsed … exiting
0`), run time 6.5 s vs 3.2 s immediate. The hoped-for complete `debug.log` did not materialise: it is still cut
mid-line, because the game never reaches its own shutdown/flush. Clean mode is therefore safe but currently useless
for logs; a flush of the game's log stream would need a different lever.

## Verdicts (runner side, first match wins)

| Verdict | Meaning |
|---|---|
| `skipped` | `MEWTEST_SKIP=1` |
| `cannot-run` | preflight failed (missing exe / `version.dll` / `chainloader.ini` / DLLs / appdata logs dir / Steam not running / mod folder) or another run holds the lock |
| `launch-error` | script errors, bad suffix, a path under `saves/`, spawn failure |
| `unknown-build` | `mewframework.log` says `unknown build: TimeDateStamp=… SizeOfImage=…`: the game updated and the native layer fails closed (data mods still load). Decided before `backstop-timeout` because an older harness sits at the menu. Next: `check_game_build`, then `docs/binding-port.md` |
| `backstop-timeout` | the game outlived the script timeout plus 45 s and was killed (a game that lingers *after* writing `end` is killed after 5 s instead and keeps its JSONL verdict, `killedAfterEnd: true`) |
| `safety-violation` | `debug.log` reports a different `Save File Suffix:` than requested, or the real save's hash changed |
| `crash` | crash event, exit code 3, an abnormal exit code, or a new crash report under `mod_logs/crashes/` or the appdata logs |
| `harness-error` | exit code 4 / `script_error` / framework inactive on a *known* build (the reason names the failed signature(s)) |
| `timeout` | exit code 2 |
| `fail` | exit code 1, any failed `expect`, an `end` code ≠ 0 while the process exit code is 0/absent (clean mode), or a runner-side `expect log` whose substring is not in `debug.log` (`expect log failed at line N: "…" not found in debug.log`; decided after `log-errors`, which names the root cause). Mind that `debug.log` is cut mid-line (block-buffered), so only text the game flushed early is reliable |
| `no-result` | exit 0 but no result file or no `end` event (truncated) |
| `log-errors` | exit 0 but `debug.log` contains a known marker: `NO_STATUS_NAMED`, `NO_BRAIN_NAMED`, `NO_ABILITY_NAMED`, `NO_PASSIVE_NAMED`, `No level named`, `No enemy named`, `GON_ERROR:` |
| `pass` | everything above is clean |

## Running it

```sh
cd editor
npm run test:ingame                      # every mods/*/tests/*.mewtest, one game at a time
npm run test:ingame -- jokers-luck       # one mod
npm run test:ingame -- jokers-luck smoke # one script
npm run test:ingame -- --json            # machine-readable reports
#   --timeout <ms>  --no-hide  --clean  --no-savecheck
npm run test:unitglow                    # the per-unit glow proof: dev-sandbox/unit-glow + the shot measure (glow-measure.ts)
```

Exit 0 when everything passed or was skipped, 1 on any failure, 2 on a usage error. A machine-level reason (no game,
no DLL, Steam down, lock held) is printed once and the rest is skipped.

MCP (`mewgenics-editor`): `list_ingame_tests { mod? }` and
`run_ingame_test { mod, test | script, timeoutMs?, hide?, clean?, savesuffix?, includeEvents? }`. The call blocks until the
game exits and returns the full report.

`npm test` never launches the game: it covers the runner through the fake game only. In-game runs are the T2 tier,
run on demand, because they need Steam, a window and a save, and several agents share one machine.

## Environment knobs

| Variable | Effect |
|---|---|
| `MEWGENICS_DIR` | game folder (default `C:\Program Files (x86)\Steam\steamapps\common\Mewgenics`) |
| `MEWTEST_SKIP=1` | report `skipped` without touching anything |
| `MEWTEST_RESULTS_DIR` | where run dirs go (default `editor/data/ingame-runs/`, git-ignored) |
| `MEWTEST_SAVECHECK=0` | disable the read-only hash of the real save (default on) |
| `MEWTEST_FAKE_GAME=<path>` | spawn `node <path>` instead of the exe (tests only) |

## Artifacts

Each run writes `editor/data/ingame-runs/<YYYYMMDD-HHMMSS>-<mod>-<name>/` containing `script.mewtest` (directives
only), `result.jsonl`, `debug.log` (copy), `mewframework.window.log` (only this launch's slice of the append-mode
log), `chainloader.log` (copy) and `report.json` (the full report). The JSONL is written into the run dir, never
under `mods/`.

## Safety model

- The real save is never used: the suffix is validated before spawn, `-savesuffix` is always passed, and after the
  run the `Save File Suffix:` line in `debug.log` must match what was requested.
- Every path handed to the game (script, result file, game dir, mod dirs) is refused if any segment is `saves`
  (`repo.touchesSaves`, unchanged).
- The real save (`steamcampaign01.sav`) is hashed read-only before and after each run; a change is a
  `safety-violation`. This read lives in `editor/src/core/ingame/savecheck.ts` only, approved by the owner on
  2026-10-18 for this purpose; the editor's no-saves rules are not loosened anywhere else.
- The harness DLL is inert without `-mewtest` and without `-savesuffix` (the framework already refuses vanilla
  launches), and never writes anything but its result file and `mod_logs\mewtest.log`. `enter` is the one directive
  that can make the game open a save: `enter TacticsTest` uses the test director's `test00.sav`, whose name is
  hard-coded in the game function the harness calls; `enter Campaign` opens the harness-owned `mewtest01.sav`
  (`MT_CAMPAIGN_SAVE` in the DLL = `CAMPAIGN_SLOT_FILE` in `savecheck.ts`; no save-select screen lists that name,
  so nobody plays it). Never a `steamcampaign` slot; the save-set check allows those two families only.
- The one write the editor makes under `saves/` (owner decision 2026-10-20): before a script with `enter Campaign`
  the runner moves an existing `mewtest01.sav` into the run dir as `mewtest01.sav.before` (a rename, never a
  delete, never another name — `savecheck.resetCampaignSlot`), so every such run is a fresh new game and the
  previous slot is kept with the run's artifacts. `report.safety.campaignSlot` = `{file, reset, backup, after}`
  (`after`: whether the game wrote a new slot). The game may also keep its own `saves/backups/mewtest01_*.savbackup`.

## Game-state assumptions (verified 2026-10-18 on build 25143593)

- Launch lands on the main menu with the debug console created (`DebugConsole::init` fires once, before the first
  frame) and **only the engine's own 11 commands registered**: `listcmds`, `clear`, `clear_history`,
  `record_macro arg0`, `end_recording_macro`, `save_commands_as_macro arg0 arg1`, `macro arg0`,
  `clear_macros arg0`, `nofilter`, `toggle_filter`, `soundevent_debug arg0`. Game commands (`spawn`, `bind`,
  `load`, `win`, `crash`, ...) are registered by the run's scenes (`MewDirector::init`, `GameBase::init`,
  `TacticsTest::init`, ...) and answer `No command named "X" found` at the main menu. After `enter TacticsTest`
  the list is 84 lines (the engine's 11, the director's 17 — `ObtainItem arg0`, `UnlockClass arg0`,
  `skip_tutorial`, `set_day arg0`, … — the app's, and TacticsTest's: `refresh_turns`, `spawn arg0`,
  `spawntile arg0`, `load arg0`, `benchmark arg0`, `stress_test arg0`, `fuzz_test arg0`, `replay_test`,
  `passive arg0`, `status arg0`, `global arg0`, `weather arg0`, `bind arg0`, `bind_passive arg0`, `win`, `999`,
  `wtf`, `killall`, `1hp`, `takeover`, `untakeover`, `noui`, `nohud`, `equip arg0`, `swagout`, `mutate arg0`,
  `voice arg0`, `zoomout arg0 arg1`, `music arg0`, `tileset arg0`, `play_sound arg0`; pinned verbatim in
  `editor/test/fixtures/ingame/console-tacticstest-listcmds.txt`).
- `listcmds` pushes one line per command (`<name> arg0 arg1 ...`) followed by `Executed: listcmds`; every
  successful command ends with `Executed: <line>`. An unknown name gives `No command named "X" found`; too few
  arguments gives `command "X" needs at least N arguments`.
- A hidden window keeps the simulation running: with `hide: true` the harness hides the window at frame 0 and
  sets the swap interval to 0, after which the game ran ~180 frames per second (487 frames in 2.6 s) and every
  expectation behaved as with a visible window.
- Combat commands need a run in progress. No console command enters one (the menu is mouse-driven); **`enter
  TacticsTest` does** (OBSERVED 2026-10-20, `mods/dev-sandbox/tests/enter-fight.mewtest`): it replays the dev
  menu's "TacticsTest" button inside the DLL (`docs/engine-map.md` "Dev scenes and run entry"). In dev mode the
  game itself creates the test director on `test00.sav` a few frames after the menu is up; `enter` waits for it
  (retrying every frame, same budget as the console wait), sets the button's flags on it (party generated, not read
  from a saved winning team), then creates a `Battle` scene with the `TacticsTest` driver. ~0.3 s later the console
  lists the run commands (`editor/test/fixtures/ingame/console-tacticstest-listcmds.txt`: `spawn`, `spawntile`,
  `load`, `bind`, `bind_passive`, `status`, `passive`, `win`, `killall`, `takeover`, `noui`, `equip`, `mutate`,
  `weather`, `tileset`, …), `TurnControl::NextTurn` fires (round 1) and `dump` lists the generated party and its
  opponents (6 units; `editor/test/fixtures/ingame/result-enter-fight.jsonl`). The unit walk is therefore verified
  on a real fight, and so is the crash path (an access violation inside an earlier attempt produced the `crash`
  event, exit 3 and the game's crash log, with no dialog). Every run left `1 real save file(s) unchanged`.
- **`enter Campaign`** (OBSERVED 2026-10-20, `mods/dev-sandbox/tests/enter-campaign.mewtest`,
  `editor/test/fixtures/ingame/result-enter-campaign.jsonl`): the DLL replays the save-slot click — destroys the
  entity of the game's test director (its "More than one mew director" check compares generations, which the
  destroy bumps), `AddComponent<MewDirector>(mainScene, entity, "mewtest01.sav")` (init creates the slot) and
  `MewDirector::start` (a fresh slot = the new-game intro cutscene; a kept one would resume). ~900 frames later
  the game was still running the cutscene (seen in a `shot`), the slot existed (32 KB), no popup, real saves
  unchanged. A second run moved the first slot into its run dir (`reset: true`). No combat commands exist on this
  path until the cutscene is over and the house is reached (open: skipping the intro from the harness).
- The game's own `debug.log` is block-buffered and ends mid-line — in immediate **and** in clean mode (see "Clean
  mode" above: the game does not shut itself down when its running flag is cleared, so nothing flushes). Load-time
  markers (`NO_*_NAMED`, `GON_ERROR:`) are written long before, so the `log-errors` check still works.
- Mewjector loads mods on the first `version.dll` proxy call, which on this machine is after SDL has initialized;
  the DYNAPI slots therefore already hold their final values when `DllMain` runs.

## Interactive mode (named pipe)

`interactive: true` (or MCP `start_ingame_session`, which forces it) launches the game with `-mewtest_pipe 1`: the DLL
creates `\\.\pipe\mewtest-<pid>` (named in the `start` event as `pipe`), runs the script as usual and, when the script
is over, emits `idle` and keeps serving the pipe until a quit request or the script's timeout (the usual `timeout`
verdict). Requests are one JSON object per line, replies one JSON line each — and every reply is the very event the
DLL appended to `result.jsonl`, so the report (`report.result.execs`, `report.result.idle`), the log checks and the
save-set check are those of a scripted run.

```
-> {"id":1,"op":"exec","text":"spawn Rat","frames":10}    run a console line; collect its console output for N frames (default 3, max 600)
<- {"ev":"exec","id":1,"op":"exec","text":"spawn Rat","ok":true,"lines":["Spawned Rat","Executed: spawn"],"t":…,"frame":…}
-> {"id":2,"op":"dump"}                                   the units event (with "id")
-> {"id":3,"op":"quit"}                                   reply {"ev":"exec","id":3,"op":"quit","ok":true,"code":N}, then end, then exit
<- {"ev":"exec","id":N,"ok":false,"error":"…"}            a bad request, a full queue (8 slots), or a request the runner never served
```

Rules the runner follows: a request is served on the frame thread, one per frame, only while the script is **idle or
inside a wait** (`wait frames/turns/ms/rounds`, a `shot` hold) and only once the debug console exists — never between
two `MT_S_RUN` directives, never while a `cmd` waits for the console, never inside `expect console … within` (an
exec moves the console window that expect reads). An `exec` stays active until its `frames` have passed, then its
reply carries every console line seen since the command. OBSERVED 2026-10-20: a request sent right after the launch
was served inside `wait frames 120`, before the fight — so a driver waits for `idle` first (`session.waitForIdle()`;
`start_ingame_session` does that by default, `waitIdle: false` returns as soon as the pipe is up) and an exec at frame 1,
before `DebugConsole::init`, crashed the game inside `DebugConsole::Execute` — hence the console guard.

Node: `ingame.startSession({ plan, test, … })` → `{ pid, runDir, pipe, idle, ended, waitForIdle(), exec(cmd, frames?),
dump(), stop() }` (`editor/src/core/ingame/session.ts`, over `pipe.ts`'s `connectPipe`/`pipePath`). MCP:
`start_ingame_session { mod, test | script, timeoutMs?, hide?, savesuffix?, connectTimeoutMs?, waitIdle? }` →
`{ sessionId, pid, runDir, pipe, idle }`; `ingame_exec { sessionId, cmd | op: dump | op: quit, frames? }`;
`stop_ingame_session { sessionId, includeEvents? }` → the report. One client at a time, one game at a time (the run lock
is held for the session). `npm run test:ingame` skips interactive scripts ("drive it through a session"):
`mods/dev-sandbox/tests/interactive-smoke.mewtest` is the one to start a fight session from.

## Writing a test (TDD)

1. Write `mods/<mod>/tests/<name>.mewtest` asserting the behaviour you are about to add (an `expect noconsole
   "No command named"` after `cmd bind <YourAbility>` is the minimum for a new ability).
2. Run it: `npm run test:ingame -- <mod> <name>`. It must fail for the right reason (`fail`, or `log-errors` with the
   `NO_*_NAMED` marker for the missing content).
3. Write the overlay / native code. Run again until `pass`. Paste both runs' summary lines into the PR body.
4. Any reverse-engineering fact the test relies on (a console string, an offset, a log marker) is recorded in
   `docs/engine-map.md` and pinned by a fixture under `editor/test/fixtures/ingame/`.
