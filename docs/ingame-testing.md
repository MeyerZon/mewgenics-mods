# In-game testing: the `mewtest` harness

The one layer the editor's validator cannot cover is "the game actually loads and runs the mod". The game has no
headless mode, no autoexec and no seed control, so this harness closes the gap with a native DLL that executes
debug-console commands in-process and a Node runner that launches the game, waits, and turns the evidence into a
verdict. Agents use it to TDD mods end to end without anyone at the keyboard.

This file is the single source of truth for the contracts shared by the three parts:

| Part | Where |
|---|---|
| Node runner, MCP tools, CLI | `editor/src/core/ingame/`, `editor/src/mcp/tools.mjs`, `editor/scripts/ingame.mjs` |
| Framework API v3 (console/frame-loop symbols + data addresses) | `native/framework/` |
| `mewtest.dll` (the harness) | `native/mods/test-harness/` (build with its `build.bat`, copy to `native/dist/`) |

Without `native/dist/mewtest.dll` every real run reports `cannot-run` naming the missing piece; the runner itself
is fully covered by `npm test` through a fake game (`editor/test/fixtures/fake-game.mjs`), and the DLL's pure
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
  snapshot the real save (read-only sha256)       every event appended to the JSONL file and flushed
  spawn with cwd = game dir, SteamAppId=686060    quit / end of script / timeout / crash -> end event + exit code
  backstop kill at timeout + 45 s
  read JSONL, scan the three logs, re-hash the save, decide the verdict, write report.json
```

Argument order matters: `ApplicationBase::ProcessCmds` treats **every** argument after `-modpaths` as a mod path, so
the runner always emits

```
-savesuffix <s> -enable_debugconsole true -dev_mode true
-mewtest <script> -mewtest_out <jsonl> -mewtest_hide 0|1 -mewtest_timeout <ms>
-modpaths <abs mod dir>...
```

## Script format (`.mewtest`)

Header lines `key: value` end at the first blank, comment or directive line. The runner owns the header and strips
it; the DLL only ever sees directives (it tolerates whole-line `#` comments). Scripts committed with a mod live in
`mods/<mod>/tests/*.mewtest`; inline scripts (MCP `script`) are allowed too.

```
mods: jokers-luck, dev-sandbox   # -modpaths order, later overrides earlier; default = the owning mod
savesuffix: dev                  # /^[A-Za-z0-9_-]{1,32}$/, default dev (the existing dev save; never the real save)
timeout: 120s                    # 5000 | 90s | 2m, default 120000 ms
hide: true                       # default true: hide the window + swap interval 0

cmd <rest of line verbatim, 1..4078 bytes>       run a debug-console command
wait frames|turns|ms <N>                         N >= 1; turns = TurnControl::NextTurn calls
expect console "<substr>" [within <frames>]      a console line since the last cmd contains substr
expect noconsole "<substr>"                      no such line since the last cmd
expect status <Name> on <index|bareword|"name">  a unit carries the status (vanilla or framework-registered)
expect units <==|!=|>=|<=|>|<> <N>               unit count in the current combat
dump                                             snapshot the units into a units event
log "<text>"                                     echo into the result file
quit [code]                                      no code: 0 if every expect passed, else 1; end of script == quit
```

String literals use double quotes with `\"` and `\\` escapes. Limits: 1024 directives, 1024-byte lines. Everything
executes on the game's main thread from the per-frame hook, one directive per frame; waits consume frames.

## Result file (JSON lines)

Every event carries `t` (ms since harness start) and `frame`.

```
{"ev":"start","harness":"mewtest 0.1.0","build":"1.1.21239 (steam 25143593)","script":"...","out":"...","pid":N,"hide":1,"timeout_ms":N,"clean":0}
{"ev":"script_error","line":N,"msg":"..."}
{"ev":"cmd","line":N,"text":"..."}
{"ev":"console","text":"..."}
{"ev":"turn","n":N,"round":N}
{"ev":"wait","line":N,"kind":"frames","n":N,"actual":N}
{"ev":"expect","line":N,"kind":"console","arg":"...","ok":true,"detail":"..."}
{"ev":"units","available":true,"round":N,"count":N,"list":[{"i":0,"name":"...","class":"...","faction":0,"move":3,"act":1,"turnkind":2,"statuses":["LuckUp"]}]}
{"ev":"log","text":"..."}
{"ev":"crash","code":"0xC0000005","addr":"0x...","module":"Mewgenics.exe","rva":"0x...","tid":N}
{"ev":"end","code":N,"reason":"quit|eof|timeout|crash|script_error|console_unavailable|framework_inactive|framework_missing|harness_error","frames":N,"turns":N,"elapsed_ms":N,"expect_pass":N,"expect_fail":N}
```

Harness exit codes: `0` pass, `1` an expect failed or `quit 1`, `2` script timeout, `3` crash, `4` harness error
(script parse error, console never appeared, framework inactive or missing), `N` from `quit N`. When mewframework is
inactive (unknown build or a failed signature) the harness still writes `start` + `end{code 4, reason
framework_inactive}` and exits 4 from a helper thread ~1.5 s after load, so the runner never waits for the backstop.
A `cmd` waits up to 30 s of wall clock (`MT_CONSOLE_WAIT_MS`) for the debug console to appear: with the window hidden
the game runs hundreds of frames per second, so a frame budget was never a time budget.

## Verdicts (runner side, first match wins)

| Verdict | Meaning |
|---|---|
| `skipped` | `MEWTEST_SKIP=1` |
| `cannot-run` | preflight failed (missing exe / `version.dll` / `chainloader.ini` / DLLs / appdata logs dir / Steam not running / mod folder) or another run holds the lock |
| `launch-error` | script errors, bad suffix, a path under `saves/`, spawn failure |
| `unknown-build` | `mewframework.log` says `unknown build: TimeDateStamp=… SizeOfImage=…`: the game updated and the native layer fails closed (data mods still load). Decided before `backstop-timeout` because an older harness sits at the menu. Next: `check_game_build`, then `docs/binding-port.md` |
| `backstop-timeout` | the game outlived the script timeout plus 45 s and was killed |
| `safety-violation` | `debug.log` reports a different `Save File Suffix:` than requested, or the real save's hash changed |
| `crash` | crash event, exit code 3, an abnormal exit code, or a new crash report under `mod_logs/crashes/` or the appdata logs |
| `harness-error` | exit code 4 / `script_error` / framework inactive on a *known* build (the reason names the failed signature(s)) |
| `timeout` | exit code 2 |
| `fail` | exit code 1 or any failed `expect` |
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
#   --timeout <ms>  --no-hide  --no-savecheck
```

Exit 0 when everything passed or was skipped, 1 on any failure, 2 on a usage error. A machine-level reason (no game,
no DLL, Steam down, lock held) is printed once and the rest is skipped.

MCP (`mewgenics-editor`): `list_ingame_tests { mod? }` and
`run_ingame_test { mod, test | script, timeoutMs?, hide?, savesuffix?, includeEvents? }`. The call blocks until the
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
  `safety-violation`. This read lives in `editor/src/core/ingame/savecheck.mjs` only, approved by the owner on
  2026-10-18 for this purpose; the editor's no-saves rules are not loosened anywhere else.
- The harness DLL is inert without `-mewtest` and without `-savesuffix` (the framework already refuses vanilla
  launches), and never writes anything but its result file and `mod_logs\mewtest.log`.

## Game-state assumptions (verified 2026-10-18 on build 25143593)

- Launch lands on the main menu with the debug console created (`DebugConsole::init` fires once, before the first
  frame) and **only the engine's own 11 commands registered**: `listcmds`, `clear`, `clear_history`,
  `record_macro arg0`, `end_recording_macro`, `save_commands_as_macro arg0 arg1`, `macro arg0`,
  `clear_macros arg0`, `nofilter`, `toggle_filter`, `soundevent_debug arg0`. Game commands (`spawn`, `bind`,
  `load`, `win`, `crash`, ...) are registered by the run's scenes (`MewDirector::init`, `GameBase::init`,
  `TacticsTest::init`, ...) and answer `No command named "X" found` at the main menu.
- `listcmds` pushes one line per command (`<name> arg0 arg1 ...`) followed by `Executed: listcmds`; every
  successful command ends with `Executed: <line>`. An unknown name gives `No command named "X" found`; too few
  arguments gives `command "X" needs at least N arguments`.
- A hidden window keeps the simulation running: with `hide: true` the harness hides the window at frame 0 and
  sets the swap interval to 0, after which the game ran ~180 frames per second (487 frames in 2.6 s) and every
  expectation behaved as with a visible window.
- Combat commands need a run in progress on the `dev` save. **Entering that run from the main menu through the
  console is still open** (no console command does it; the menu is mouse-driven). Until it is solved, committed
  scripts assert only main-menu-safe things, the unit walk (`dump`, `expect status`, `expect units`) is
  exercised only with `available:false` / `0 units`, and the crash path (`cmd crash`) is unverified in-game.
- With the default immediate exit the game's own `debug.log` is block-buffered and ends mid-line; load-time
  markers (`NO_*_NAMED`, `GON_ERROR:`) are written long before, so the `log-errors` check still works. Pass
  `-mewtest_clean 1` (not yet exposed by the runner) when a complete `debug.log` matters.
- Mewjector loads mods on the first `version.dll` proxy call, which on this machine is after SDL has initialized;
  the DYNAPI slots therefore already hold their final values when `DllMain` runs.

## Writing a test (TDD)

1. Write `mods/<mod>/tests/<name>.mewtest` asserting the behaviour you are about to add (an `expect noconsole
   "No command named"` after `cmd bind <YourAbility>` is the minimum for a new ability).
2. Run it: `npm run test:ingame -- <mod> <name>`. It must fail for the right reason (`fail`, or `log-errors` with the
   `NO_*_NAMED` marker for the missing content).
3. Write the overlay / native code. Run again until `pass`. Paste both runs' summary lines into the PR body.
4. Any reverse-engineering fact the test relies on (a console string, an offset, a log marker) is recorded in
   `docs/engine-map.md` and pinned by a fixture under `editor/test/fixtures/ingame/`.
