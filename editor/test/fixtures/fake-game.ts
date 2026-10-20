#!/usr/bin/env node
// Stand-in for Mewgenics.exe + mewtest.dll so the runner can be tested without
// the game. Mimics the observable contract: reads -mewtest / -mewtest_out /
// -savesuffix / -modpaths from argv, writes the JSONL result file, appends a
// mewframework.log session + a chainloader.log into <cwd>/mod_logs, writes a
// debug.log into FAKE_GAME_APPDATA_LOGS (if set) and exits with the code the
// harness would. Behaviour is selected with FAKE_GAME_MODE.

import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const argAfter = (flag: string): string | undefined => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const scriptPath = argAfter("-mewtest");
const outPath = argAfter("-mewtest_out") || (scriptPath ? scriptPath.replace(/\.[^.]+$/, "") + ".jsonl" : undefined);
const suffix = argAfter("-savesuffix") || "";
const iMod = argv.indexOf("-modpaths");
const modPaths = iMod >= 0 ? argv.slice(iMod + 1) : [];
const mode = process.env.FAKE_GAME_MODE || "pass";
const cwd = process.cwd();

// --- logs the real stack would leave behind ---------------------------------
mkdirSync(join(cwd, "mod_logs"), { recursive: true });
// one appended session per launch, exactly as the real DLL writes it (the runner reads the window after launch)
const fwSession =
  mode === "unknown-build" || mode === "unknown-build-hang"
    ? ["mewframework 0.3.0 starting; mewjector=yes", "unknown build: TimeDateStamp=0x6b000000 SizeOfImage=0x01580000; framework disabled"]
    : [
        "mewframework 0.3.0 starting; mewjector=yes",
        "build 1.1.21239 (steam 25143593) recognized (base 0x7ff691ff0000)",
        "hook installed: Character::BeginTurn rva 0x10a9b0",
        "hook installed: TurnControl::NextTurn rva 0x8e3c60, chain depth 1",
        mode === "signature-failed" ? "signature DebugConsole_Execute: 0 matches (need exactly 1); framework disabled" : "framework active: 15 symbols resolved, mewjector api v3",
      ];
appendFileSync(join(cwd, "mod_logs", "mewframework.log"), fwSession.join("\n") + "\n");
writeFileSync(
  join(cwd, "mod_logs", "chainloader.log"),
  ["[00:00:00.000] === Mewjector v3.5 (API v3) ===", "[00:00:00.001] [LoadOrder]   Mod10 Loading: mewframework.dll", "[00:00:00.002] [ScanPath] Loading: mewtest.dll", ""].join("\n"),
);
if (process.env.FAKE_GAME_APPDATA_LOGS) {
  mkdirSync(process.env.FAKE_GAME_APPDATA_LOGS, { recursive: true });
  const reported = process.env.FAKE_GAME_SUFFIX_OVERRIDE || suffix;
  const lines = [
    "[file: C:\\Engine\\Application.cpp; line: 85;] Initiating Loader Resources...",
    `[file: C:\\Engine\\Application.cpp; line: 710;] Save File Suffix: ${reported}`,
    ...modPaths.map((p) => `[file: C:\\Engine\\Application.cpp; line: 744;] Mod Path: ${p}`),
    "[file: C:\\Engine\\Application.cpp; line: 843;] TOTAL LOADING TIME: 12",
  ];
  if (mode === "log-markers") lines.push("[file: C:\\Game\\Status.cpp; line: 55;] NO_STATUS_NAMED NotARealStatusXYZ");
  // FAKE_GAME_DEBUG_LINES: extra debug.log messages, "|"-separated (for runner-side `expect log` tests)
  for (const extra of String(process.env.FAKE_GAME_DEBUG_LINES || "").split("|").filter(Boolean)) lines.push(`[file: C:\\Game\\Custom.cpp; line: 1;] ${extra}`);
  writeFileSync(join(process.env.FAKE_GAME_APPDATA_LOGS, "debug.log"), lines.join("\n") + "\n");
}
if (process.env.FAKE_GAME_TOUCH_FILE && mode === "savechange") {
  appendFileSync(process.env.FAKE_GAME_TOUCH_FILE, "\nmutated by fake game\n");
}

// --- result file -------------------------------------------------------------
type Event = Record<string, unknown>;
function writeResult(events: Event[]): void {
  if (!outPath) return;
  writeFileSync(outPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}
const start: Event = { ev: "start", harness: "fake-game", build: "fake", script: scriptPath, out: outPath, pid: process.pid, hide: 1, timeout_ms: 1000, clean: Number(argAfter("-mewtest_clean") || 0), t: 0, frame: 0 };
const end = (code: number, reason: string, pass = 0, fail = 0): Event => ({ ev: "end", code, reason, frames: 3, turns: 0, elapsed_ms: 5, expect_pass: pass, expect_fail: fail, t: 5, frame: 3 });

switch (mode) {
  case "pass":
  case "log-markers":
  case "wrong-suffix":
  case "savechange":
    writeResult([start, { ev: "cmd", line: 1, text: "listcmds", t: 1, frame: 1 }, { ev: "console", text: "listcmds", t: 1, frame: 1 }, { ev: "expect", line: 2, kind: "console", arg: "listcmds", ok: true, detail: "matched console line 0", t: 2, frame: 2 }, end(0, "quit", 1, 0)]);
    process.exit(0);
    break;
  case "signature-failed":
  case "unknown-build":
    // mewtest with an inactive framework: writes start + end{4, framework_inactive} and exits 4
    writeResult([{ ...start, build: "unknown" }, end(4, "framework_inactive")]);
    process.exit(4);
    break;
  case "unknown-build-hang":
    // an older harness: inert, no result file, the game sits at the main menu until the backstop kills it
    setInterval(() => {}, 1000);
    break;
  case "shot":
    // a shot event mid-run: the runner must capture while the game holds (we hold 500 ms, then end)
    if (outPath) writeFileSync(outPath, [start, { ev: "shot", line: 1, label: "menu", hold_ms: 700, t: 1, frame: 1 }].map((e) => JSON.stringify(e)).join("\n") + "\n");
    setTimeout(() => { if (outPath) appendFileSync(outPath, JSON.stringify(end(0, "quit", 0, 0)) + "\n"); process.exit(0); }, 500);
    break;
  case "enter-pass":
    // the harness replayed the dev menu's TacticsTest entry, a turn passed, two units were counted
    writeResult([start, { ev: "enter", line: 3, name: "TacticsTest", ok: true, detail: "scene=0x1 entity=0x2 component=0x3", t: 1, frame: 1 }, { ev: "turn", n: 1, round: 1, t: 2, frame: 2 }, { ev: "wait", line: 4, kind: "turns", n: 1, actual: 1, t: 2, frame: 2 }, { ev: "expect", line: 5, kind: "units", arg: ">= 2", ok: true, detail: "2 units", t: 3, frame: 3 }, end(0, "quit", 1, 0)]);
    process.exit(0);
    break;
  case "enter-fail":
    writeResult([start, { ev: "enter", line: 3, name: "TacticsTest", ok: false, detail: "no MewDirector (the boot-time test director is missing)", t: 1, frame: 1 }, end(1, "enter_failed")]);
    process.exit(1);
    break;
  case "enter-unavailable":
    writeResult([start, { ev: "enter", line: 3, name: "TacticsTest", ok: false, detail: "symbols missing: FW_SYM_AddComponent_TacticsTest", t: 1, frame: 1 }, end(4, "enter_unavailable")]);
    process.exit(4);
    break;
  case "fail":
    writeResult([start, { ev: "cmd", line: 1, text: "bind X", t: 1, frame: 1 }, { ev: "console", text: 'No command named "bind" found', t: 1, frame: 1 }, { ev: "expect", line: 2, kind: "noconsole", arg: "No command named", ok: false, detail: "found in console line 0", t: 2, frame: 2 }, end(1, "quit", 0, 1)]);
    process.exit(1);
    break;
  case "crash":
    writeResult([start, { ev: "cmd", line: 1, text: "crash", t: 1, frame: 1 }, { ev: "crash", code: "0xC0000005", flags: "0x0", addr: "0x1404929c0", module: "Mewgenics.exe", rva: "0x4929c0", tid: 1, t: 2, frame: 1 }, end(3, "crash")]);
    process.exit(3);
    break;
  case "timeout":
    writeResult([start, { ev: "wait", line: 1, kind: "frames", n: 100000, actual: 60, t: 1000, frame: 60 }, end(2, "timeout")]);
    process.exit(2);
    break;
  case "harness-error":
    writeResult([start, { ev: "script_error", line: 2, msg: "unknown directive 'frobnicate'", t: 1, frame: 0 }, end(4, "script_error")]);
    process.exit(4);
    break;
  case "noresult":
    process.exit(0);
    break;
  case "truncated":
    if (outPath) writeFileSync(outPath, JSON.stringify(start) + "\n" + '{"ev":"cmd","line":1,"te');
    process.exit(0);
    break;
  case "hang":
    writeResult([start]);
    setInterval(() => {}, 1000); // never exits; the runner's backstop must kill us
    break;
  case "end-hang":
    // clean mode gone wrong: the full result incl. the end event is on disk, but the game never exits
    writeResult([start, { ev: "cmd", line: 1, text: "listcmds", t: 1, frame: 1 }, { ev: "console", text: "listcmds", t: 1, frame: 1 }, { ev: "expect", line: 2, kind: "console", arg: "listcmds", ok: true, detail: "matched console line 0", t: 2, frame: 2 }, end(0, "quit", 1, 0)]);
    setInterval(() => {}, 1000); // the runner must act on the end record, not wait for the backstop
    break;
  case "abnormal":
    writeResult([start]);
    process.exit(0xc0000005 | 0); // what Windows reports for an unhandled AV with no handler
    break;
  default:
    process.stderr.write(`fake-game: unknown FAKE_GAME_MODE ${mode}\n`);
    process.exit(99);
}
