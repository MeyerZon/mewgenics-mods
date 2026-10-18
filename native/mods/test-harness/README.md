# mewtest — in-game test harness DLL

Runs a `.mewtest` script inside Mewgenics: console commands through the game's own
`DebugConsole::Execute`, console output read back from the console's vector, turns counted
through `TurnControl::NextTurn`, combat state through guarded memory reads, and every event
appended to a JSON-lines file. The process exit code is the verdict. The contracts (script
grammar, events, exit codes) live in `docs/ingame-testing.md`; the Node runner that drives
it is `editor/src/core/ingame/` (`npm run test:ingame`, MCP `run_ingame_test`).

Layout:

- `src/mt_*.c` + `src/mt_pure.h` — pure modules (JSONL writer, argument parsing, MSVC
  `std::string` layout, script parser, console diff, frame-driven runner). No `windows.h`;
  host-tested by `test.bat` (`test/test_mewtest.c`, 40 tests).
- `src/mewtest.c` — the Windows/game glue: `DllMain`, the three Mewjector hooks
  (`DebugConsole::init` prio 50 captures the console, `ApplicationBase::FrameBegin` prio 50
  steps the script, `TurnControl::NextTurn` prio 110 counts turns), the `MtHost`
  implementation, window hiding through the SDL3 DYNAPI slots, the vectored exception
  handler + top-level filter (crash → `crash` event, `end` code 3), and the watchdog thread
  (timeout → code 2, clean-exit grace).
- `scripts/smoke.mt` — raw-directive smoke for a manual launch.

Build and deploy:

```
native\mods\test-harness\test.bat     # host tests (also run by native\test-all.bat)
native\mods\test-harness\build.bat    # build\mewtest.dll
copy build\mewtest.dll ..\..\dist\    # Mewjector's ScanPath loads it after mewframework.dll
```

Requires `mewframework.dll` API v3 (`FW_GetData`, the console/frame-loop symbols). Inert
unless the command line carries both `-savesuffix` and `-mewtest <script>`.

Flags: `-mewtest <script>` `-mewtest_out <jsonl>` (default: script with `.jsonl`)
`-mewtest_hide 0|1` (default 1) `-mewtest_timeout <ms>` (default 120000)
`-mewtest_clean 0|1` (default 0: `ExitProcess` right after the `end` event; 1: clear the
app's running flag and let the game shut down, with a 3 s grace).

Logs: `<gamedir>\mod_logs\mewtest.log` (also mirrored into `chainloader.log` under `[mewtest]`).
