// Tests for the in-game test harness runner (editor/src/core/ingame/*).
// Pure modules are tested on fixtures; the runner is tested against a fake
// game (test/fixtures/fake-game.mjs) so nothing here needs Mewgenics, Steam
// or the native DLLs. Wired into run-tests.mjs; also runnable standalone:
//   node test/ingame-tests.mjs

import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MODS_DIR, REPO_ROOT } from "../src/core/repo.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures", "ingame");
/** @param {string} name */
const fixture = (name) => readFileSync(join(FIX, name), "utf8");

/**
 * Import a module, or return null so the caller can register one failing test
 * instead of crashing the whole run (keeps the "red" phase readable).
 * @param {string} rel
 */
async function load(rel) {
  try {
    return await import(rel);
  } catch (e) {
    return { __error: String(e instanceof Error ? e.message : e) };
  }
}

/**
 * @param {(name: string, fn: () => void) => void} test
 * @param {(cond: boolean, msg: string) => void} assert
 * @param {(a: unknown, b: unknown, msg?: string) => void} eq
 */
export async function runIngameTests(test, assert, eq) {
  // ---- script.mjs ----------------------------------------------------------
  console.log("\n# In-game: .mewtest script parser");
  const script = await load("../src/core/ingame/script.mjs");
  if (script.__error) {
    test("script.mjs loads", () => assert(false, script.__error));
  } else {
    const { parseScript, parseDirective, parseTimeout, DEFAULT_SAVESUFFIX, DEFAULT_TIMEOUT_MS } = script;

    test("defaults: savesuffix dev, timeout 120000 ms, hide true, mods = owning mod", () => {
      eq(DEFAULT_SAVESUFFIX, "dev");
      eq(DEFAULT_TIMEOUT_MS, 120000);
      const p = parseScript("cmd listcmds\nquit\n", { owningMod: "dev-sandbox", name: "x" });
      assert(p.ok, JSON.stringify(p.errors));
      eq(p.savesuffix, "dev");
      eq(p.timeoutMs, 120000);
      eq(p.hide, true);
      eq(p.mods.join(","), "dev-sandbox");
      eq(p.name, "x");
    });

    test("header: mods / savesuffix / timeout / hide parsed; body excludes header and comments", () => {
      const p = parseScript(fixture("scripts/valid.mewtest"), { owningMod: "jokers-luck" });
      assert(p.ok, JSON.stringify(p.errors));
      eq(p.mods.join(","), "jokers-luck,dev-sandbox");
      eq(p.savesuffix, "dev");
      eq(p.timeoutMs, 90000);
      eq(p.hide, false);
      assert(!p.body.includes("mods:"), "body must not contain header");
      assert(!p.body.includes("# a comment"), "body must not contain comments");
      assert(p.body.startsWith("wait frames 120\n"), `body starts with first directive, got ${JSON.stringify(p.body.slice(0, 30))}`);
      assert(p.body.endsWith("quit 0\n"), "body ends with trailing newline");
    });

    test("header: clean parsed (true/1/false/0), default false, bad value is a line error", () => {
      eq(parseScript("cmd listcmds\nquit\n", { owningMod: "x" }).clean, false, "default");
      for (const [v, want] of [["true", true], ["1", true], ["false", false], ["0", false]]) {
        const p = parseScript(`clean: ${v}\ncmd listcmds\nquit\n`, { owningMod: "x" });
        assert(p.ok, `clean: ${v}: ${JSON.stringify(p.errors)}`);
        eq(p.clean, want, `clean: ${v}`);
      }
      const bad = parseScript("clean: maybe\ncmd listcmds\nquit\n", { owningMod: "x" });
      assert(!bad.ok && bad.errors.some((/** @type {any} */ e) => e.line === 1 && /clean must be true or false/.test(e.message)), JSON.stringify(bad.errors));
    });

    test("every directive kind parses with its line number", () => {
      const p = parseScript(fixture("scripts/valid.mewtest"), { owningMod: "jokers-luck" });
      const d = p.directives;
      eq(d.length, 12);
      eq(JSON.stringify(d[0]), JSON.stringify({ line: 7, kind: "wait", unit: "frames", n: 120 }));
      eq(JSON.stringify(d[1]), JSON.stringify({ line: 8, kind: "cmd", text: "bind JokersGambit # not a comment, part of the command" }));
      eq(JSON.stringify(d[2]), JSON.stringify({ line: 9, kind: "expect", what: "console", substr: 'No command named "bind" found', within: 5 }));
      eq(JSON.stringify(d[3]), JSON.stringify({ line: 10, kind: "expect", what: "noconsole", substr: "NO_ABILITY_NAMED" }));
      eq(JSON.stringify(d[4]), JSON.stringify({ line: 11, kind: "expect", what: "status", status: "JokersLuck", unit: "Mr Whiskers" }));
      eq(JSON.stringify(d[5]), JSON.stringify({ line: 12, kind: "expect", what: "status", status: "LuckUp", unit: "0" }));
      eq(JSON.stringify(d[6]), JSON.stringify({ line: 13, kind: "expect", what: "units", op: ">=", n: 2 }));
      eq(JSON.stringify(d[7]), JSON.stringify({ line: 14, kind: "dump" }));
      eq(JSON.stringify(d[8]), JSON.stringify({ line: 15, kind: "log", text: 'hello "world"' }));
      eq(JSON.stringify(d[9]), JSON.stringify({ line: 16, kind: "wait", unit: "turns", n: 2 }));
      eq(JSON.stringify(d[10]), JSON.stringify({ line: 17, kind: "wait", unit: "ms", n: 500 }));
      eq(JSON.stringify(d[11]), JSON.stringify({ line: 18, kind: "quit", code: 0 }));
    });

    test("all six units ops parse; a bad op is an error with its line", () => {
      for (const op of ["==", "!=", ">=", "<=", ">", "<"]) {
        const d = /** @type {any} */ (parseDirective(`expect units ${op} 3`, 4));
        eq(d.op, op, `op ${op}`);
        eq(d.n, 3);
      }
      const p = parseScript("expect units ~= 3\nquit\n", { owningMod: "m" });
      assert(!p.ok, "bad op should fail");
      eq(p.errors[0].line, 1);
    });

    test("parseTimeout: ms, s, m, junk", () => {
      eq(parseTimeout("5000"), 5000);
      eq(parseTimeout("90s"), 90000);
      eq(parseTimeout("2m"), 120000);
      eq(parseTimeout("abc"), null);
      eq(parseTimeout("0"), null);
    });

    test("quit without code, quit N, quit 300 rejected", () => {
      eq(/** @type {any} */ (parseDirective("quit", 1)).code, null);
      eq(/** @type {any} */ (parseDirective("quit 7", 1)).code, 7);
      assert("error" in /** @type {any} */ (parseDirective("quit 300", 1)), "quit 300 must error");
    });

    test("error cases carry line numbers", () => {
      /** @type {Array<[string, string]>} */
      const cases = [
        ["frobnicate now", "unknown directive"],
        ["wait seconds 3", "bad wait unit"],
        ["wait frames 0", "N must be >= 1"],
        ['expect console "unterminated', "unterminated quote"],
        ["expect console", "missing argument"],
        ["cmd", "empty cmd"],
        ["expect status X", "missing 'on'"],
      ];
      for (const [line, label] of cases) {
        const p = parseScript(`cmd listcmds\n${line}\nquit\n`, { owningMod: "m" });
        assert(!p.ok, `${label}: should fail`);
        eq(p.errors[0].line, 2, `${label}: line`);
      }
      const hdr = parseScript("savesuffix: has space\nquit\n", { owningMod: "m" });
      assert(!hdr.ok && hdr.errors[0].line === 1, "bad savesuffix");
      const to = parseScript("timeout: soon\nquit\n", { owningMod: "m" });
      assert(!to.ok && to.errors[0].line === 1, "bad timeout");
      const key = parseScript("colour: red\nquit\n", { owningMod: "m" });
      assert(!key.ok && key.errors[0].line === 1, "unknown header key");
      const late = parseScript(fixture("scripts/bad-header-late.mewtest"), { owningMod: "m" });
      assert(!late.ok && late.errors[0].line === 2, "header after a directive");
      const bad = parseScript(fixture("scripts/bad-directive.mewtest"), { owningMod: "m" });
      assert(!bad.ok && bad.errors[0].line === 2, "bad-directive fixture");
    });

    test("no quit -> warning, still ok", () => {
      const p = parseScript("cmd listcmds\n", { owningMod: "m" });
      assert(p.ok, "ok");
      assert(p.warnings.some((/** @type {any} */ w) => /quit/.test(w.message)), "warning mentions quit");
    });

    test("empty / comment-only script is ok with zero directives and a warning", () => {
      const p = parseScript("# nothing\n\n", { owningMod: "m" });
      assert(p.ok, "ok");
      eq(p.directives.length, 0);
      eq(p.body, "");
    });
  }

  // ---- discover.mjs --------------------------------------------------------
  console.log("\n# In-game: test discovery");
  const discover = await load("../src/core/ingame/discover.mjs");
  if (discover.__error) {
    test("discover.mjs loads", () => assert(false, discover.__error));
  } else if (existsSync(join(MODS_DIR, "jokers-luck", "tests")) && existsSync(join(MODS_DIR, "dev-sandbox", "tests"))) {
    test("listIngameTests finds the committed sample scripts and they parse with zero errors", () => {
      const all = discover.listIngameTests();
      const names = all.tests.map((/** @type {any} */ t) => `${t.mod}/${t.name}`);
      assert(names.includes("jokers-luck/smoke"), `missing jokers-luck/smoke in ${names.join(",")}`);
      assert(names.includes("dev-sandbox/console-smoke"), `missing dev-sandbox/console-smoke in ${names.join(",")}`);
      for (const t of all.tests) assert(t.plan.ok, `${t.mod}/${t.name}: ${JSON.stringify(t.plan.errors)}`);
      const one = discover.listIngameTests("jokers-luck");
      assert(one.tests.every((/** @type {any} */ t) => t.mod === "jokers-luck"), "filter by mod");
      assert(one.tests[0].plan.mods.includes("jokers-luck"), "owning mod is the default -modpaths entry");
    });
  } else {
    test("sample .mewtest scripts present (skipped: mods/*/tests missing)", () => {});
  }

  // ---- results.mjs ---------------------------------------------------------
  console.log("\n# In-game: result JSONL parser");
  const results = await load("../src/core/ingame/results.mjs");
  if (results.__error) {
    test("results.mjs loads", () => assert(false, results.__error));
  } else {
    const { parseResults } = results;
    test("pass fixture: start/end, expects, console lines, turns, units", () => {
      const r = parseResults(fixture("result-pass.jsonl"));
      assert(r.present && !r.truncated, "present, not truncated");
      eq(r.parseErrors, 0);
      eq(r.events.length, 12);
      eq(r.start.build, "1.1.21239 (steam 25143593)");
      eq(r.end.code, 0);
      eq(r.end.reason, "quit");
      eq(r.crash, null);
      eq(r.turns, 1);
      eq(r.consoleLines.length, 3);
      eq(r.expects.passed, 2);
      eq(r.expects.failed, 0);
      eq(r.units.count, 2);
      eq(r.units.list[0].name, "Lumee");
    });
    test("fail fixture lists failures with line, kind, arg, detail", () => {
      const r = parseResults(fixture("result-fail.jsonl"));
      eq(r.end.code, 1);
      eq(r.expects.failed, 1);
      eq(r.expects.passed, 1);
      eq(JSON.stringify(r.expects.failures[0]), JSON.stringify({ line: 3, kind: "noconsole", arg: "No command named", detail: "found in console line 0" }));
    });
    test("crash fixture exposes the crash event", () => {
      const r = parseResults(fixture("result-crash.jsonl"));
      eq(r.crash.code, "0xC0000005");
      eq(r.crash.rva, "0x4929c0");
      eq(r.end.code, 3);
    });
    test("truncated trailing line is tolerated and flagged; no end", () => {
      const r = parseResults(fixture("result-truncated.jsonl"));
      assert(r.present, "present");
      assert(r.truncated, "truncated");
      eq(r.events.length, 1);
      eq(r.end, null);
    });
    test("null text -> present:false", () => {
      const r = parseResults(null);
      assert(!r.present, "not present");
      eq(r.events.length, 0);
      eq(r.end, null);
    });
    test("unknown ev kinds are kept; non-JSON lines count as parse errors", () => {
      const r = parseResults('{"ev":"start","t":0,"frame":0}\n{"ev":"mystery","x":1,"t":1,"frame":1}\nnot json\n{"ev":"end","code":0,"t":2,"frame":2}\n');
      eq(r.events.length, 3);
      eq(r.parseErrors, 1);
      assert(!r.truncated, "a complete non-JSON line is not truncation");
      eq(r.end.code, 0);
    });
  }

  // ---- logs.mjs ------------------------------------------------------------
  console.log("\n# In-game: log scanners");
  const logs = await load("../src/core/ingame/logs.mjs");
  if (logs.__error) {
    test("logs.mjs loads", () => assert(false, logs.__error));
  } else {
    const { scanDebugLog, checkSaveSuffix, scanFrameworkLog, scanChainloaderLog, readWindow, locateAppdataLogsDir, collectLogs } = logs;
    test("scanDebugLog: every marker found with the [file: ...] prefix stripped and line numbers", () => {
      const r = scanDebugLog(fixture("debug-markers.log"));
      const markers = r.findings.map((/** @type {any} */ f) => f.marker);
      for (const m of ["GON_ERROR", "NO_STATUS_NAMED", "NO_BRAIN_NAMED", "NO_ABILITY_NAMED", "NO_PASSIVE_NAMED", "No level named", "No enemy named"]) {
        assert(markers.includes(m), `missing marker ${m} in ${markers.join(",")}`);
      }
      eq(r.findings.length, 7);
      eq(r.findings[0].line, 3);
      eq(r.findings[0].text, 'GON_ERROR: Field "effects" does not exist');
    });
    test("scanDebugLog: clean log has no findings; suffix and mod paths extracted", () => {
      const r = scanDebugLog(fixture("debug-clean.log"));
      eq(r.findings.length, 0);
      eq(r.saveSuffix, "dev");
      eq(r.modPaths.join("|"), "C:\\repo\\mods\\dev-sandbox|C:\\repo\\mods\\jokers-luck");
    });
    test("checkSaveSuffix: ok / missing / different", () => {
      assert(checkSaveSuffix("dev", "dev").ok, "same");
      const m = checkSaveSuffix(null, "dev");
      assert(!m.ok && /missing|not found/i.test(m.reason), "missing");
      const d = checkSaveSuffix("other", "dev");
      assert(!d.ok && /other/.test(d.reason), "different");
    });
    test("scanFrameworkLog: windowed text yields active + symbol count + hooks; unknown build detected", () => {
      const all = fixture("mewframework-two-sessions.log");
      const offset = all.indexOf("mewframework 0.3.0 starting");
      const r = scanFrameworkLog(all.slice(offset));
      assert(r.active, "active");
      eq(r.symbols, 15);
      eq(r.sessions, 1);
      eq(r.hooks.length, 2);
      assert(!r.unknownBuild, "known build");
      const u = scanFrameworkLog(fixture("mewframework-unknown-build.log"));
      assert(u.unknownBuild && !u.active, "unknown build -> inactive");
      assert(u.identity && u.identity.timeDateStamp === "0x6b000000" && u.identity.sizeOfImage === "0x01580000", `identity parsed: ${JSON.stringify(u.identity)}`);
      eq(u.signatureFailures.length, 0);
      const sf = scanFrameworkLog(fixture("mewframework-signature-failed.log"));
      assert(!sf.unknownBuild && !sf.active, "known build, inactive");
      eq(sf.build, "1.1.21239 (steam 25143593)");
      eq(sf.signatureFailures.map((/** @type {any} */ f) => `${f.name}=${f.matches}`).join(","), "DebugConsole_Execute=0,ApplicationBase_FrameBegin=2");
      eq(r.signatureFailures.length, 0, "active session has none");
      eq(r.identity, null, "identity only reported for an unknown build");
      const both = scanFrameworkLog(all);
      eq(both.sessions, 2);
      eq(both.symbols, 15, "last session wins when not windowed");
    });
    test("scanChainloaderLog: mods loaded and crash lines", () => {
      const ok = scanChainloaderLog(fixture("chainloader-ok.log"));
      eq(ok.modsLoaded.join(","), "mewframework.dll,jokers_luck.dll,mewtest.dll");
      eq(ok.crashLines.length, 0);
      const cr = scanChainloaderLog(fixture("chainloader-crash.log"));
      assert(cr.crashLines.length >= 2, `expected crash lines, got ${cr.crashLines.length}`);
      assert(cr.crashLines.some((/** @type {string} */ l) => /fatal=1/.test(l)), "fatal VEH line");
    });
    test("readWindow returns only bytes after the offset", () => {
      const dir = join(FIX, "__tmp_window");
      mkdirSync(dir, { recursive: true });
      const p = join(dir, "w.log");
      writeFileSync(p, "first\nsecond\n");
      eq(readWindow(p, "first\n".length), "second\n");
      eq(readWindow(p, 0), "first\nsecond\n");
      eq(readWindow(join(dir, "missing.log"), 0), null);
      rmSync(dir, { recursive: true, force: true });
    });
    test("locateAppdataLogsDir: single steamid dir -> its logs; zero or many -> null; never a saves path", () => {
      const root = join(FIX, "__tmp_appdata");
      rmSync(root, { recursive: true, force: true });
      const base = join(root, "Glaiel Games", "Mewgenics");
      mkdirSync(join(base, "76561198000000001", "logs"), { recursive: true });
      const one = locateAppdataLogsDir({ APPDATA: root });
      eq(one, join(base, "76561198000000001", "logs"));
      mkdirSync(join(base, "76561198000000002", "logs"), { recursive: true });
      eq(locateAppdataLogsDir({ APPDATA: root }), null);
      eq(locateAppdataLogsDir({ APPDATA: join(root, "nope") }), null);
      eq(locateAppdataLogsDir({}), null);
      rmSync(root, { recursive: true, force: true });
    });
    test("collectLogs: fresh vs stale, findings, crash reports newer than launch", () => {
      const root = join(FIX, "__tmp_collect");
      rmSync(root, { recursive: true, force: true });
      const gameDir = join(root, "game");
      const appLogs = join(root, "applogs");
      mkdirSync(join(gameDir, "mod_logs", "crashes"), { recursive: true });
      mkdirSync(appLogs, { recursive: true });
      const launchedAt = Date.now() - 10_000;
      writeFileSync(join(appLogs, "debug.log"), fixture("debug-markers.log"));
      writeFileSync(join(gameDir, "mod_logs", "mewframework.log"), fixture("mewframework-two-sessions.log"));
      writeFileSync(join(gameDir, "mod_logs", "chainloader.log"), fixture("chainloader-ok.log"));
      writeFileSync(join(gameDir, "mod_logs", "crashes", "1-new.txt"), "x");
      writeFileSync(join(appLogs, "crash_2026-10-18-16-19-58.txt"), "x");
      const old = join(gameDir, "mod_logs", "crashes", "0-old.txt");
      writeFileSync(old, "x");
      const t = new Date(launchedAt - 60_000);
      utimesSync(old, t, t);
      const r = collectLogs({ gameDir, appdataLogsDir: appLogs, frameworkLogOffset: 0, launchedAtMs: launchedAt, expectedSuffix: "dev" });
      assert(r.debugLog.present && r.debugLog.fresh, "debug log fresh");
      eq(r.debugLog.findings.length, 7);
      eq(r.debugLog.saveSuffix, "dev");
      assert(r.frameworkLog.active, "framework active");
      eq(r.frameworkLog.symbols, 15);
      eq(r.chainloaderLog.modsLoaded.length, 3);
      eq(r.crashReports.length, 2, `crash reports: ${JSON.stringify(r.crashReports)}`);
      // stale: everything older than the launch
      const stale = collectLogs({ gameDir, appdataLogsDir: appLogs, frameworkLogOffset: 0, launchedAtMs: Date.now() + 60_000, expectedSuffix: "dev" });
      assert(!stale.debugLog.fresh, "stale debug log");
      eq(stale.crashReports.length, 0);
      // missing appdata dir
      const none = collectLogs({ gameDir, appdataLogsDir: null, frameworkLogOffset: 0, launchedAtMs: launchedAt, expectedSuffix: "dev" });
      assert(!none.debugLog.present, "no debug log");
      rmSync(root, { recursive: true, force: true });
    });
  }

  // ---- launch.mjs ----------------------------------------------------------
  console.log("\n# In-game: launch builder + preflight");
  const launch = await load("../src/core/ingame/launch.mjs");
  if (launch.__error || script.__error) {
    test("launch.mjs loads", () => assert(false, launch.__error || "script.mjs missing"));
  } else {
    const { locateGameDir, preflight, buildLaunch, LaunchError, DEFAULT_GAME_DIR, STEAM_APP_ID } = launch;
    const plan = script.parseScript("mods: jokers-luck, dev-sandbox\ntimeout: 30s\ncmd listcmds\nquit\n", { owningMod: "jokers-luck", name: "t" });
    const okExists = () => true;
    test("locateGameDir: MEWGENICS_DIR beats the Steam default", () => {
      eq(locateGameDir({ MEWGENICS_DIR: "D:\\Games\\Mew" }), "D:\\Games\\Mew");
      eq(locateGameDir({}), DEFAULT_GAME_DIR);
      assert(/Mewgenics$/.test(DEFAULT_GAME_DIR), "default ends with Mewgenics");
      eq(STEAM_APP_ID, "686060");
    });
    test("preflight: everything present -> ok with named checks", () => {
      const r = preflight(plan, { gameDir: "C:\\G", env: {}, exists: okExists, steamRunning: () => true, modsDir: "C:\\repo\\mods", appdataLogsDir: "C:\\A\\logs" });
      assert(r.ok && !r.skipped, JSON.stringify(r.reasons));
      for (const k of ["exe", "versionDll", "chainloaderIni", "frameworkDll", "mewtestDll", "appdata", "steam", "modDirs"]) assert(r.checks[k] && r.checks[k].ok, `check ${k}`);
    });
    test("preflight: each missing item yields its own reason", () => {
      /** @type {Array<[string, RegExp]>} */
      const cases = [["Mewgenics.exe", /Mewgenics\.exe/], ["version.dll", /version\.dll/], ["chainloader.ini", /chainloader\.ini/], ["mewframework.dll", /mewframework\.dll/], ["mewtest.dll", /mewtest\.dll/], ["jokers-luck", /jokers-luck/]];
      for (const [missing, re] of cases) {
        const r = preflight(plan, { gameDir: "C:\\G", env: {}, exists: (/** @type {string} */ p) => !p.toLowerCase().endsWith(missing.toLowerCase()), steamRunning: () => true, modsDir: "C:\\repo\\mods", appdataLogsDir: "C:\\A\\logs" });
        assert(!r.ok, `${missing}: should fail`);
        assert(r.reasons.some((/** @type {string} */ x) => re.test(x)), `${missing}: reason ${JSON.stringify(r.reasons)}`);
      }
      const noSteam = preflight(plan, { gameDir: "C:\\G", env: {}, exists: okExists, steamRunning: () => false, modsDir: "C:\\repo\\mods", appdataLogsDir: "C:\\A\\logs" });
      assert(!noSteam.ok && noSteam.reasons.some((/** @type {string} */ x) => /steam/i.test(x)), "steam not running");
      const unknownSteam = preflight(plan, { gameDir: "C:\\G", env: {}, exists: okExists, steamRunning: () => null, modsDir: "C:\\repo\\mods", appdataLogsDir: "C:\\A\\logs" });
      assert(unknownSteam.ok, "unknown steam state is not a blocker");
      const noApp = preflight(plan, { gameDir: "C:\\G", env: {}, exists: okExists, steamRunning: () => true, modsDir: "C:\\repo\\mods", appdataLogsDir: null });
      assert(!noApp.ok && noApp.reasons.some((/** @type {string} */ x) => /appdata|logs/i.test(x)), "appdata logs dir");
    });
    test("preflight: MEWTEST_SKIP=1 -> skipped; MEWTEST_FAKE_GAME relaxes the game checks", () => {
      const s = preflight(plan, { gameDir: "C:\\G", env: { MEWTEST_SKIP: "1" }, exists: () => false, steamRunning: () => false, modsDir: "C:\\repo\\mods", appdataLogsDir: null });
      assert(s.skipped && !s.ok, "skipped");
      const f = preflight(plan, { gameDir: "C:\\G", env: { MEWTEST_FAKE_GAME: "C:\\fake.mjs" }, exists: (/** @type {string} */ p) => p.includes("mods"), steamRunning: () => false, modsDir: "C:\\repo\\mods", appdataLogsDir: "C:\\A\\logs" });
      assert(f.ok, `fake mode ok: ${JSON.stringify(f.reasons)}`);
    });
    const ctx = { gameDir: "C:\\Games\\Mew genics", scriptPath: "C:\\repo\\editor\\data\\ingame-runs\\r1\\script.mewtest", outPath: "C:\\repo\\editor\\data\\ingame-runs\\r1\\result.jsonl", env: { PATH: "x" }, modsDir: "C:\\re po\\mods" };
    test("buildLaunch: argv order, -mewtest* before -modpaths, -modpaths last, mod dirs absolute in header order", () => {
      const l = buildLaunch(plan, ctx);
      eq(l.command, "C:\\Games\\Mew genics\\Mewgenics.exe");
      eq(l.cwd, "C:\\Games\\Mew genics");
      const a = l.args;
      eq(a.slice(0, 6).join(" "), "-savesuffix dev -enable_debugconsole true -dev_mode true");
      const iMew = a.indexOf("-mewtest"), iMod = a.indexOf("-modpaths");
      assert(iMew > 0 && iMod > iMew, "-mewtest before -modpaths");
      eq(a[iMew + 1], ctx.scriptPath);
      eq(a[a.indexOf("-mewtest_out") + 1], ctx.outPath);
      eq(a[a.indexOf("-mewtest_hide") + 1], "1");
      eq(a[a.indexOf("-mewtest_timeout") + 1], "30000");
      eq(a[a.indexOf("-mewtest_clean") + 1], "0", "-mewtest_clean 0 by default");
      assert(a.indexOf("-mewtest_clean") > a.indexOf("-mewtest_timeout") && a.indexOf("-mewtest_clean") < iMod, "-mewtest_clean after -mewtest_timeout and before -modpaths");
      eq(a.slice(iMod).join("|"), "-modpaths|C:\\re po\\mods\\jokers-luck|C:\\re po\\mods\\dev-sandbox");
      assert(!l.fake, "not fake");
    });
    test("buildLaunch: env adds both Steam ids and keeps the caller's env; hide false -> 0", () => {
      const l = buildLaunch(plan, ctx);
      eq(l.env.SteamAppId, "686060");
      eq(l.env.SteamGameId, "686060");
      eq(l.env.PATH, "x");
      const p2 = script.parseScript("hide: false\ncmd listcmds\nquit\n", { owningMod: "jokers-luck" });
      eq(buildLaunch(p2, ctx).args[buildLaunch(p2, ctx).args.indexOf("-mewtest_hide") + 1], "0");
      const p3 = script.parseScript("clean: true\ncmd listcmds\nquit\n", { owningMod: "jokers-luck" });
      eq(buildLaunch(p3, ctx).args[buildLaunch(p3, ctx).args.indexOf("-mewtest_clean") + 1], "1", "clean: true -> -mewtest_clean 1");
    });
    test("buildLaunch refuses: bad suffix, saves path in a mod dir, relative script path", () => {
      /** @param {() => void} fn */
      const throws = (fn) => { try { fn(); return null; } catch (e) { return /** @type {any} */ (e); } };
      const bad = script.parseScript("cmd listcmds\nquit\n", { owningMod: "jokers-luck" });
      bad.savesuffix = "has space";
      const e1 = throws(() => buildLaunch(bad, ctx));
      assert(e1 instanceof LaunchError, "bad suffix -> LaunchError");
      const e2 = throws(() => buildLaunch(plan, { ...ctx, modsDir: "C:\\x\\saves\\mods" }));
      assert(e2 instanceof LaunchError && /saves/i.test(String(e2.message)), "saves path refused");
      const e3 = throws(() => buildLaunch(plan, { ...ctx, scriptPath: "rel\\script.mewtest" }));
      assert(e3 instanceof LaunchError, "relative script path refused");
      const e4 = throws(() => buildLaunch(plan, { ...ctx, modsDir: "C:\\repo\\mods", scriptPath: "C:\\x\\saves\\s.mewtest" }));
      assert(e4 instanceof LaunchError, "saves script path refused");
    });
    test("buildLaunch: MEWTEST_FAKE_GAME -> node + fake script with the same args", () => {
      const l = buildLaunch(plan, { ...ctx, env: { MEWTEST_FAKE_GAME: "C:\\fake\\fake-game.mjs" } });
      assert(l.fake, "fake");
      eq(l.command, process.argv[0]);
      eq(l.args[0], "C:\\fake\\fake-game.mjs");
      eq(l.args.slice(1, 3).join(" "), "-savesuffix dev");
      eq(l.cwd, "C:\\Games\\Mew genics");
    });
  }

  // ---- savecheck.mjs -------------------------------------------------------
  console.log("\n# In-game: real-save read-only hash check");
  const savecheck = await load("../src/core/ingame/savecheck.mjs");
  if (savecheck.__error) {
    test("savecheck.mjs loads", () => assert(false, savecheck.__error));
  } else {
    const { snapshotFile, compareSnapshots, realSavePath, KNOWN_REAL_SAVE_SHA256 } = savecheck;
    test("snapshotFile + compareSnapshots on a fixture (never a real save)", () => {
      const p = join(FIX, "sample-save.bin");
      const a = snapshotFile(p);
      assert(a.present && a.sha256 && a.sha256.length === 64, "sha256 present");
      assert(a.bytes > 0, "bytes");
      const b = snapshotFile(p);
      const same = compareSnapshots(a, b);
      assert(same.unchanged, "unchanged");
      assert(!same.matchesKnownBaseline, "fixture is not the known baseline");
      const c = { ...b, sha256: "0".repeat(64) };
      assert(!compareSnapshots(a, c).unchanged, "changed detected");
      const missing = snapshotFile(join(FIX, "nope.bin"));
      assert(!missing.present && missing.sha256 === null, "missing file");
      assert(compareSnapshots(missing, missing).unchanged, "missing before and after is unchanged");
      eq(KNOWN_REAL_SAVE_SHA256.length, 64);
    });
    test("snapshotSaves: every *.sav in the dir except the suffixed launch's own files; compareSaveSets flags changed, added and removed", () => {
      assert(typeof savecheck.snapshotSaves === "function" && typeof savecheck.compareSaveSets === "function" && typeof savecheck.devSavePattern === "function", "snapshotSaves / compareSaveSets / devSavePattern exported");
      const dir = mkdtempSync(join(tmpdir(), "mewged-saves-"));
      writeFileSync(join(dir, "steamcampaign01.sav"), "real one");
      writeFileSync(join(dir, "steamcampaign02.sav"), "real two");
      writeFileSync(join(dir, "campaign02.sav"), "dev slot");
      writeFileSync(join(dir, "steam_autocloud.vdf"), "not a save");
      const allow = /^campaign0\d\.sav$/i; // stands in for devSavePattern("dev") until the mapping is decoded
      const before = savecheck.snapshotSaves(dir, { allow });
      eq(before.files.map((/** @type {any} */ f) => f.name).join(","), "steamcampaign01.sav,steamcampaign02.sav", "sorted, allowed and non-.sav files excluded");
      assert(before.files.every((/** @type {any} */ f) => f.present && f.sha256 && f.sha256.length === 64), "hashed");
      eq(before.skipped.join(","), "campaign02.sav", "the allowed (dev) file is listed as skipped, not hashed");
      // nothing changed
      const same = savecheck.compareSaveSets(before, savecheck.snapshotSaves(dir, { allow }));
      assert(same.unchanged && same.changed.length === 0, same.detail);
      // the dev file may change freely
      writeFileSync(join(dir, "campaign02.sav"), "dev slot progressed");
      assert(savecheck.compareSaveSets(before, savecheck.snapshotSaves(dir, { allow })).unchanged, "dev file changes are allowed");
      // a real file changed
      writeFileSync(join(dir, "steamcampaign02.sav"), "real two MUTATED");
      const changed = savecheck.compareSaveSets(before, savecheck.snapshotSaves(dir, { allow }));
      assert(!changed.unchanged && changed.changed.join(",") === "steamcampaign02.sav", changed.detail);
      assert(/steamcampaign02\.sav/.test(changed.detail), changed.detail);
      writeFileSync(join(dir, "steamcampaign02.sav"), "real two");
      // a new non-dev save appeared / a real save vanished
      writeFileSync(join(dir, "steamcampaign03.sav"), "new real");
      const added = savecheck.compareSaveSets(before, savecheck.snapshotSaves(dir, { allow }));
      assert(!added.unchanged && added.changed.join(",") === "steamcampaign03.sav", added.detail);
      rmSync(join(dir, "steamcampaign03.sav"));
      rmSync(join(dir, "steamcampaign01.sav"));
      const removed = savecheck.compareSaveSets(before, savecheck.snapshotSaves(dir, { allow }));
      assert(!removed.unchanged && removed.changed.join(",") === "steamcampaign01.sav", removed.detail);
    });
    test("realSavesDir: the saves dir of the single steamid; null otherwise", () => {
      assert(typeof savecheck.realSavesDir === "function", "realSavesDir exported");
      const app = mkdtempSync(join(tmpdir(), "mewged-appdata-"));
      eq(savecheck.realSavesDir({ APPDATA: app }), null, "no Mewgenics dir");
      mkdirSync(join(app, "Glaiel Games", "Mewgenics", "76561198000000000", "saves"), { recursive: true });
      eq(savecheck.realSavesDir({ APPDATA: app }), join(app, "Glaiel Games", "Mewgenics", "76561198000000000", "saves"));
      mkdirSync(join(app, "Glaiel Games", "Mewgenics", "76561198000000001"), { recursive: true });
      eq(savecheck.realSavesDir({ APPDATA: app }), null, "two ids -> null (never guess)");
    });
    test("realSavePath: derived from the single steamid dir; null otherwise", () => {
      const root = join(FIX, "__tmp_save");
      rmSync(root, { recursive: true, force: true });
      const base = join(root, "Glaiel Games", "Mewgenics");
      mkdirSync(join(base, "76561198000000001", "saves"), { recursive: true });
      eq(realSavePath({ APPDATA: root }), join(base, "76561198000000001", "saves", "steamcampaign01.sav"));
      eq(realSavePath({}), null);
      rmSync(root, { recursive: true, force: true });
    });
  }

  // ---- runner.mjs (against the fake game) ----------------------------------
  console.log("\n# In-game: runner against the fake game");
  const runner = await load("../src/core/ingame/runner.mjs");
  if (runner.__error || script.__error) {
    test("runner.mjs loads", () => assert(false, runner.__error || "script.mjs missing"));
  } else {
    const { runPlan, acquireLock, runDirName, decideVerdict, LOCK_FILE } = runner;
    const FAKE = join(HERE, "fixtures", "fake-game.mjs");
    const ROOT = join(FIX, "__tmp_runner");
    rmSync(ROOT, { recursive: true, force: true });
    const gameDir = join(ROOT, "game");
    const appLogs = join(ROOT, "applogs");
    const modsDir = join(ROOT, "mods");
    const runsDir = join(ROOT, "runs");
    const savePath = join(ROOT, "fake-save.sav");
    mkdirSync(join(gameDir, "mod_logs"), { recursive: true });
    mkdirSync(join(modsDir, "jokers-luck"), { recursive: true });
    mkdirSync(join(modsDir, "dev-sandbox"), { recursive: true });
    writeFileSync(savePath, fixture("sample-save.bin"));
    const plan = script.parseScript("mods: jokers-luck, dev-sandbox\ntimeout: 1s\ncmd listcmds\nexpect console \"listcmds\"\nquit\n", { owningMod: "jokers-luck", name: "smoke" });
    /** @param {string} mode @param {Record<string,string>} [extraEnv] @param {Record<string, any>} [extra] */
    const run = (mode, extraEnv = {}, extra = {}) =>
      runPlan({
        plan,
        test: { mod: "jokers-luck", name: "smoke", scriptPath: null },
        env: { MEWTEST_FAKE_GAME: FAKE, FAKE_GAME_MODE: mode, FAKE_GAME_APPDATA_LOGS: appLogs, PATH: process.env.PATH || "", ...extraEnv },
        gameDir, appdataLogsDir: appLogs, modsDir, runsDir, realSavePath: savePath, backstopGraceMs: 500,
        ...extra,
      });

    test("uniqueRunDir: a second run in the same second gets a distinct dir (-2, -3 …), never a reused result file", () => {
      assert(typeof runner.uniqueRunDir === "function", "uniqueRunDir exported from runner.mjs");
      const base = join(runsDir, "unique-" + process.pid);
      mkdirSync(base, { recursive: true });
      const t = Date.UTC(2026, 9, 19, 20, 0, 0);
      const first = runner.uniqueRunDir(base, "jokers-luck", "smoke", t);
      eq(first, join(base, runDirName("jokers-luck", "smoke", t)), "free name used as is");
      mkdirSync(first, { recursive: true });
      const second = runner.uniqueRunDir(base, "jokers-luck", "smoke", t);
      eq(second, first + "-2", "taken -> -2");
      mkdirSync(second, { recursive: true });
      eq(runner.uniqueRunDir(base, "jokers-luck", "smoke", t), first + "-3", "taken twice -> -3");
    });
    test("runDirName is sortable and names the test", () => {
      const n = runDirName("jokers-luck", "smoke", Date.UTC(2026, 9, 18, 16, 5, 9));
      assert(/^\d{8}-\d{6}-jokers-luck-smoke$/.test(n), n);
    });

    test("acquireLock: second acquire fails with the holder pid; stale pid is reclaimed", () => {
      mkdirSync(runsDir, { recursive: true });
      const a = acquireLock(runsDir);
      assert(a.ok, "first lock");
      const b = acquireLock(runsDir);
      assert(!b.ok && b.pid === process.pid, `second lock should fail with pid ${process.pid}: ${JSON.stringify(b)}`);
      a.release();
      writeFileSync(join(runsDir, LOCK_FILE), "999999999");
      const c = acquireLock(runsDir);
      assert(c.ok, "stale lock reclaimed");
      c.release();
      assert(!existsSync(join(runsDir, LOCK_FILE)), "release removes the lock file");
    });

    test("decideVerdict precedence table", () => {
      const pre = { ok: true, skipped: false, reasons: [], checks: {} };
      const res = (/** @type {any} */ o) => ({ present: true, truncated: false, parseErrors: 0, events: [], start: {}, end: { code: 0 }, crash: null, scriptError: null, turns: 0, consoleLines: [], expects: { passed: 1, failed: 0, failures: [] }, units: null, ...o });
      const logs = (/** @type {any} */ o) => ({ debugLog: { findings: [] }, frameworkLog: { active: true, present: true }, chainloaderLog: { crashLines: [] }, crashReports: [], ...o });
      const safe = { saveSuffixOk: true, saveCheck: null };
      const exit = (/** @type {number|null} */ code, backstop = false) => ({ code, signal: null, backstop });
      /** @param {string} label @param {any} input @param {string} want */
      const expectV = (label, input, want) => eq(decideVerdict(input).verdict, want, label);
      expectV("skipped", { preflight: { ...pre, ok: false, skipped: true, reasons: ["MEWTEST_SKIP=1"] }, exit: exit(null), result: res({ present: false, end: null }), logs: null, safety: safe }, "skipped");
      expectV("cannot-run", { preflight: { ...pre, ok: false, reasons: ["no exe"] }, exit: exit(null), result: res({ present: false, end: null }), logs: null, safety: safe }, "cannot-run");
      expectV("launch-error", { preflight: pre, launchError: "bad suffix", exit: exit(null), result: res({ present: false, end: null }), logs: null, safety: safe }, "launch-error");
      expectV("backstop", { preflight: pre, exit: exit(null, true), result: res({ end: null }), logs: logs({}), safety: safe }, "backstop-timeout");
      const unknownFw = { active: false, present: true, unknownBuild: true, identity: { timeDateStamp: "0x6b000000", sizeOfImage: "0x01580000" }, signatureFailures: [] };
      expectV("unknown build beats backstop (real DLL hangs at the menu)", { preflight: pre, exit: exit(null, true), result: res({ present: false, end: null }), logs: logs({ frameworkLog: unknownFw }), safety: safe }, "unknown-build");
      expectV("unknown build with exit 4", { preflight: pre, exit: exit(4), result: res({ end: { code: 4, reason: "framework_inactive" } }), logs: logs({ frameworkLog: unknownFw }), safety: safe }, "unknown-build");
      assert(/0x6b000000/.test(decideVerdict({ preflight: pre, exit: exit(4), result: res({ end: { code: 4, reason: "framework_inactive" } }), logs: logs({ frameworkLog: unknownFw }), safety: safe }).reason), "reason names the identity");
      const sigFw = { active: false, present: true, unknownBuild: false, identity: null, signatureFailures: [{ name: "DebugConsole_Execute", matches: 0 }] };
      const sigV = decideVerdict({ preflight: pre, exit: exit(4), result: res({ end: { code: 4, reason: "framework_inactive" } }), logs: logs({ frameworkLog: sigFw }), safety: safe });
      eq(sigV.verdict, "harness-error", "known build + signature failure");
      assert(/DebugConsole_Execute/.test(sigV.reason), sigV.reason);
      expectV("safety suffix", { preflight: pre, exit: exit(0), result: res({}), logs: logs({}), safety: { saveSuffixOk: false, saveCheck: null } }, "safety-violation");
      expectV("safety hash", { preflight: pre, exit: exit(0), result: res({}), logs: logs({}), safety: { saveSuffixOk: true, saveCheck: { unchanged: false } } }, "safety-violation");
      expectV("crash code", { preflight: pre, exit: exit(3), result: res({ crash: { code: "0xC0000005" }, end: { code: 3 } }), logs: logs({}), safety: safe }, "crash");
      expectV("crash report only", { preflight: pre, exit: exit(0), result: res({}), logs: logs({ crashReports: ["x.dmp"] }), safety: safe }, "crash");
      expectV("abnormal exit", { preflight: pre, exit: exit(-1073741819), result: res({ end: null }), logs: logs({}), safety: safe }, "crash");
      expectV("harness-error", { preflight: pre, exit: exit(4), result: res({ scriptError: { line: 2 }, end: { code: 4 } }), logs: logs({}), safety: safe }, "harness-error");
      expectV("timeout", { preflight: pre, exit: exit(2), result: res({ end: { code: 2, reason: "timeout" } }), logs: logs({}), safety: safe }, "timeout");
      expectV("fail", { preflight: pre, exit: exit(1), result: res({ end: { code: 1 }, expects: { passed: 0, failed: 1, failures: [{ line: 2, kind: "console", arg: "x", detail: "d" }] } }), logs: logs({}), safety: safe }, "fail");
      expectV("quit 7 with a null exit code (clean mode: the game's own exit, or killed after end) is a fail", { preflight: pre, exit: exit(null), result: res({ end: { code: 7, reason: "quit" } }), logs: logs({}), safety: safe }, "fail");
      expectV("quit 7 with exit code 0 (clean mode: the game exited 0 on its own) is a fail", { preflight: pre, exit: exit(0), result: res({ end: { code: 7, reason: "quit" } }), logs: logs({}), safety: safe }, "fail");
      expectV("end code 0 with a null exit code (clean mode, killed after end) is a pass", { preflight: pre, exit: exit(null), result: res({}), logs: logs({}), safety: safe }, "pass");
      expectV("no-result missing file", { preflight: pre, exit: exit(0), result: res({ present: false, end: null }), logs: logs({}), safety: safe }, "no-result");
      expectV("no-result no end", { preflight: pre, exit: exit(0), result: res({ end: null }), logs: logs({}), safety: safe }, "no-result");
      expectV("log-errors", { preflight: pre, exit: exit(0), result: res({}), logs: logs({ debugLog: { findings: [{ marker: "NO_STATUS_NAMED", line: 1, text: "x" }] } }), safety: safe }, "log-errors");
      expectV("pass", { preflight: pre, exit: exit(0), result: res({}), logs: logs({}), safety: safe }, "pass");
      // crash beats fail/timeout; safety beats crash
      expectV("crash > fail", { preflight: pre, exit: exit(1), result: res({ crash: { code: "x" }, end: { code: 1 } }), logs: logs({}), safety: safe }, "crash");
      expectV("safety > crash", { preflight: pre, exit: exit(3), result: res({ crash: { code: "x" }, end: { code: 3 } }), logs: logs({}), safety: { saveSuffixOk: false, saveCheck: null } }, "safety-violation");
    });

    const pass = await run("pass");
    test("fake pass -> verdict pass, artifacts written, report.json present, header-stripped script", () => {
      eq(pass.verdict, "pass", pass.reason);
      assert(pass.ok, "ok");
      eq(pass.code, 0);
      assert(pass.launch && pass.launch.fake, "fake launch");
      assert(existsSync(pass.artifacts.runDir), "run dir");
      assert(existsSync(pass.artifacts.report), "report.json");
      assert(pass.artifacts.resultFile && existsSync(pass.artifacts.resultFile), "result file");
      const copied = readFileSync(pass.artifacts.script, "utf8");
      assert(!copied.includes("mods:"), "header stripped from the run-dir script");
      assert(copied.startsWith("cmd listcmds\n"), "directives only");
      eq(pass.result.expects.passed, 1);
      assert(pass.logFindings.frameworkLog.active, "framework active from the fake log");
      eq(pass.logFindings.frameworkLog.symbols, 15);
      eq(pass.safety.observedSuffix, "dev");
      assert(pass.safety.saveSuffixOk, "suffix ok");
      assert(pass.safety.saveCheck && pass.safety.saveCheck.unchanged, "save unchanged");
      eq(pass.safety.modPathsObserved.length, 2);
      assert(pass.durationMs >= 0 && typeof pass.startedAt === "string", "timing");
      assert(pass.artifacts.debugLog && existsSync(pass.artifacts.debugLog), "debug.log copied into the run dir");
      assert(!existsSync(join(runsDir, LOCK_FILE)), "lock released");
    });

    const pass2 = await run("pass");
    test("framework log window: only the newest session is scanned", () => {
      eq(pass2.verdict, "pass", pass2.reason);
      assert(pass2.logFindings.frameworkLog.windowOffset > 0, "offset recorded");
      eq(pass2.logFindings.frameworkLog.symbols, 15);
    });

    const fail = await run("fail");
    test("fake fail -> verdict fail with the expectation failure", () => {
      eq(fail.verdict, "fail", fail.reason);
      eq(fail.code, 1);
      eq(fail.result.expects.failures[0].line, 2);
      assert(/line 2/.test(fail.reason), `reason mentions the line: ${fail.reason}`);
    });

    const crash = await run("crash");
    test("fake crash -> verdict crash with the crash event", () => {
      eq(crash.verdict, "crash", crash.reason);
      eq(crash.result.crash.code, "0xC0000005");
    });

    const herr = await run("harness-error");
    test("fake harness-error -> verdict harness-error naming the script error", () => {
      eq(herr.verdict, "harness-error", herr.reason);
      assert(/frobnicate/.test(herr.reason), herr.reason);
    });

    const sigfail = await run("signature-failed");
    test("fake signature-failed (known build) -> harness-error naming the signature", () => {
      eq(sigfail.verdict, "harness-error", sigfail.reason);
      assert(!sigfail.logFindings.frameworkLog.active, "inactive");
      assert(/DebugConsole_Execute/.test(sigfail.reason), sigfail.reason);
    });
    const unknown = await run("unknown-build");
    test("fake unknown-build (harness writes end code 4 framework_inactive, exits 4) -> verdict unknown-build", () => {
      eq(unknown.verdict, "unknown-build", unknown.reason);
      assert(/0x6b000000/.test(unknown.reason), unknown.reason);
      eq(unknown.code, 4);
      assert(!unknown.ok, "not ok");
    });
    const unknownHang = await run("unknown-build-hang");
    test("fake unknown-build-hang (older DLL: no result, sits at the menu) -> still unknown-build via the backstop", () => {
      eq(unknownHang.verdict, "unknown-build", unknownHang.reason);
      assert(unknownHang.durationMs < 10_000, `backstop fired in time (${unknownHang.durationMs} ms)`);
    });

    const to = await run("timeout");
    test("fake timeout -> verdict timeout", () => eq(to.verdict, "timeout", to.reason));

    const hang = await run("hang");
    test("fake hang -> killed by the backstop, verdict backstop-timeout", () => {
      eq(hang.verdict, "backstop-timeout", hang.reason);
      assert(hang.durationMs < 10_000, `backstop fired in time (${hang.durationMs} ms)`);
    });

    const endHang = await run("end-hang", {}, { endGraceMs: 500, backstopGraceMs: 3000 });
    test("fake end-hang (end written, process lingers) -> JSONL verdict pass within the end grace, killedAfterEnd, not backstop-timeout", () => {
      eq(endHang.verdict, "pass", endHang.reason);
      assert(endHang.killedAfterEnd === true, "killedAfterEnd flagged on the report");
      assert(endHang.durationMs < 3000, `ended by the end grace (${endHang.durationMs} ms), not by the 1 s timeout + 3 s backstop`);
    });

    const nores = await run("noresult");
    test("fake noresult -> verdict no-result", () => eq(nores.verdict, "no-result", nores.reason));
    const trunc = await run("truncated");
    test("fake truncated -> no-result and result.truncated", () => {
      eq(trunc.verdict, "no-result", trunc.reason);
      assert(trunc.result.truncated, "truncated flagged");
    });

    const markers = await run("log-markers");
    test("fake log-markers -> code 0 but verdict log-errors", () => {
      eq(markers.verdict, "log-errors", markers.reason);
      eq(markers.logFindings.debugLog.findings[0].marker, "NO_STATUS_NAMED");
    });

    const wrong = await run("wrong-suffix", { FAKE_GAME_SUFFIX_OVERRIDE: "other" });
    test("fake wrong-suffix -> safety-violation", () => {
      eq(wrong.verdict, "safety-violation", wrong.reason);
      eq(wrong.safety.observedSuffix, "other");
    });

    const savesDir = join(ROOT, "saves-dir");
    mkdirSync(savesDir, { recursive: true });
    writeFileSync(join(savesDir, "steamcampaign01.sav"), fixture("sample-save.bin"));
    writeFileSync(join(savesDir, "steamcampaign02.sav"), "second real slot");
    const otherReal = await run("savechange", { FAKE_GAME_TOUCH_FILE: join(savesDir, "steamcampaign02.sav") }, { realSavesDir: savesDir });
    test("fake savechange on another real save in the saves dir -> safety-violation naming the file (whole-dir check)", () => {
      eq(otherReal.verdict, "safety-violation", otherReal.reason);
      assert(/steamcampaign02.sav/.test(otherReal.reason), otherReal.reason);
    });
    const mutated = await run("savechange", { FAKE_GAME_TOUCH_FILE: savePath });
    test("fake savechange -> safety-violation from the real-save hash", () => {
      eq(mutated.verdict, "safety-violation", mutated.reason);
      assert(mutated.safety.saveCheck && !mutated.safety.saveCheck.unchanged, "hash changed");
    });
    writeFileSync(savePath, fixture("sample-save.bin"));

    const nocheck = await run("pass", {}, { saveCheck: false });
    test("saveCheck:false -> safety.saveCheck is null", () => {
      eq(nocheck.verdict, "pass", nocheck.reason);
      eq(nocheck.safety.saveCheck, null);
    });
    const envoff = await run("pass", { MEWTEST_SAVECHECK: "0" });
    test("MEWTEST_SAVECHECK=0 -> safety.saveCheck is null", () => eq(envoff.safety.saveCheck, null));

    const skipped = await run("pass", { MEWTEST_SKIP: "1" });
    test("MEWTEST_SKIP=1 -> verdict skipped, nothing spawned", () => {
      eq(skipped.verdict, "skipped");
      eq(skipped.launch, null);
    });

    const cannot = await run("pass", {}, { modsDir: join(ROOT, "nope") });
    test("missing mod folder -> cannot-run with the reason", () => {
      eq(cannot.verdict, "cannot-run");
      assert(cannot.reason.includes("jokers-luck"), cannot.reason);
    });

    const badPlan = script.parseScript("frobnicate\n", { owningMod: "jokers-luck", name: "bad" });
    const perr = await run("pass", {}, { plan: badPlan });
    test("plan with errors -> launch-error listing them", () => {
      eq(perr.verdict, "launch-error");
      assert(/frobnicate/.test(perr.reason), perr.reason);
    });

    mkdirSync(runsDir, { recursive: true });
    const held = acquireLock(runsDir);
    const locked = await run("pass");
    test("lock held by another run -> cannot-run naming the pid", () => {
      eq(locked.verdict, "cannot-run");
      assert(locked.reason.includes(String(process.pid)), locked.reason);
    });
    if (held.ok) held.release();

    rmSync(ROOT, { recursive: true, force: true });
  }

  // ---- adapters: api.mjs, MCP tools, CLI (all against the fake game) --------
  console.log("\n# In-game: api / MCP / CLI adapters");
  {
    const FAKE = join(HERE, "fixtures", "fake-game.mjs");
    const ROOT = join(FIX, "__tmp_adapters");
    rmSync(ROOT, { recursive: true, force: true });
    const gameDir = join(ROOT, "game");
    const appdata = join(ROOT, "appdata");
    const appLogs = join(appdata, "Glaiel Games", "Mewgenics", "76561198000000009", "logs");
    const runsDir = join(ROOT, "runs");
    mkdirSync(join(gameDir, "mod_logs"), { recursive: true });
    mkdirSync(appLogs, { recursive: true });
    /** @param {string} mode */
    const fakeEnv = (mode) => ({
      ...process.env,
      MEWTEST_FAKE_GAME: FAKE,
      FAKE_GAME_MODE: mode,
      FAKE_GAME_APPDATA_LOGS: appLogs,
      MEWGENICS_DIR: gameDir,
      APPDATA: appdata,
      MEWTEST_RESULTS_DIR: runsDir,
    });
    const hasSamples = existsSync(join(MODS_DIR, "jokers-luck", "tests", "smoke.mewtest"));

    const api = await load("../src/core/api.mjs");
    if (api.__error || typeof api.runIngameTest !== "function" || typeof api.listIngameTests !== "function") {
      test("api.mjs exports listIngameTests and runIngameTest", () => assert(false, api.__error || "missing exports"));
    } else {
      if (hasSamples) {
        test("api.listIngameTests lists jokers-luck/smoke", () => {
          const names = api.listIngameTests().tests.map((/** @type {any} */ t) => `${t.mod}/${t.name}`);
          assert(names.includes("jokers-luck/smoke"), names.join(","));
        });
      }
      const inline = await api.runIngameTest({ mod: "jokers-luck", script: "cmd listcmds\nexpect console \"listcmds\"\nquit\n", env: fakeEnv("pass") });
      test("api.runIngameTest inline script against the fake game -> pass", () => {
        eq(inline.ok, true, inline.reason || inline.error);
        eq(inline.verdict, "pass");
        eq(inline.test.inline, true);
        assert(!("events" in inline.result) || inline.result.events.length === 0, "events omitted unless includeEvents");
      });
      if (hasSamples) {
        const named = await api.runIngameTest({ mod: "jokers-luck", test: "smoke", env: fakeEnv("pass"), includeEvents: true, timeoutMs: 1000 });
        test("api.runIngameTest named test with overrides -> pass, events included, timeout override applied", () => {
          eq(named.verdict, "pass", named.reason || named.error);
          eq(named.test.name, "smoke");
          assert(named.result.events.length > 0, "events included");
          eq(named.plan.timeoutMs, 1000);
        });
      }
      const neither = await api.runIngameTest({ mod: "jokers-luck", env: fakeEnv("pass") });
      const both = await api.runIngameTest({ mod: "jokers-luck", test: "smoke", script: "quit\n", env: fakeEnv("pass") });
      const missing = await api.runIngameTest({ mod: "jokers-luck", test: "does-not-exist", env: fakeEnv("pass") });
      test("api.runIngameTest rejects neither/both of test|script and an unknown test name", () => {
        assert(neither.ok === false && /test|script/.test(neither.error), JSON.stringify(neither.error));
        assert(both.ok === false && /one of/.test(both.error), JSON.stringify(both.error));
        assert(missing.ok === false && /does-not-exist/.test(missing.error), JSON.stringify(missing.error));
      });
    }

    // MCP server round trip (spawned with the fake-game env)
    const serverPath = join(REPO_ROOT, "editor", "src", "mcp", "server.mjs");
    const mcp = await (async () => {
      const { spawn } = await import("node:child_process");
      const child = spawn(process.argv[0], [serverPath], { stdio: ["pipe", "pipe", "pipe"], env: fakeEnv("pass") });
      /** @type {Map<number, {resolve:(v:any)=>void, reject:(e:any)=>void}>} */
      const pending = new Map();
      let id = 1, buf = "";
      child.stdout.on("data", (/** @type {any} */ chunk) => {
        buf += chunk.toString("utf8");
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          const p = msg.id !== undefined ? pending.get(msg.id) : undefined;
          if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
        }
      });
      child.stderr.on("data", () => {});
      /** @param {string} method @param {any} params */
      const req = (method, params) => new Promise((resolve, reject) => {
        const myId = id++;
        pending.set(myId, { resolve, reject });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
        setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error(`timeout: ${method}`)); } }, 20000);
      });
      /** @type {any} */
      const out = {};
      try {
        await req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
        out.list = await req("tools/list", {});
        out.listTests = await req("tools/call", { name: "list_ingame_tests", arguments: {} });
        out.run = await req("tools/call", { name: "run_ingame_test", arguments: { mod: "jokers-luck", script: "cmd listcmds\nquit\n" } });
        out.neither = await req("tools/call", { name: "run_ingame_test", arguments: { mod: "jokers-luck" } });
      } catch (e) {
        out.error = String(e);
      } finally {
        child.stdin.end();
        setTimeout(() => child.kill(), 500);
      }
      return out;
    })();
    test("MCP tools/list returns the 13 editor tools (9 + list_ingame_tests + run_ingame_test + check_game_build + port_bindings)", () => {
      assert(!mcp.error, mcp.error);
      const names = mcp.list.tools.map((/** @type {any} */ t) => t.name);
      eq(names.length, 13, names.join(","));
      assert(names.includes("list_ingame_tests") && names.includes("run_ingame_test"), names.join(","));
    });
    test("MCP list_ingame_tests returns the discovered scripts", () => {
      const payload = JSON.parse(mcp.listTests.content[0].text);
      assert(Array.isArray(payload.tests), "tests array");
      if (hasSamples) assert(payload.tests.some((/** @type {any} */ t) => t.mod === "jokers-luck" && t.name === "smoke"), "jokers-luck/smoke listed");
    });
    test("MCP run_ingame_test (inline, fake game) returns the awaited report with verdict pass", () => {
      const payload = JSON.parse(mcp.run.content[0].text);
      eq(payload.verdict, "pass", payload.reason || mcp.run.content[0].text.slice(0, 200));
      eq(mcp.run.isError, false);
    });
    test("MCP run_ingame_test without test|script is an error", () => {
      eq(mcp.neither.isError, true);
      assert(/test|script/.test(mcp.neither.content[0].text), mcp.neither.content[0].text);
    });

    // CLI
    const cliPath = join(REPO_ROOT, "editor", "scripts", "ingame.mjs");
    /** @param {Record<string,string|undefined>} env @param {string[]} [argv] */
    const runCli = async (env, argv = []) => {
      const { spawn } = await import("node:child_process");
      return new Promise((resolve) => {
        const child = spawn(process.argv[0], [cliPath, ...argv], { stdio: ["ignore", "pipe", "pipe"], env });
        let out = "", err = "";
        child.stdout.on("data", (/** @type {any} */ c) => { out += c.toString("utf8"); });
        child.stderr.on("data", (/** @type {any} */ c) => { err += c.toString("utf8"); });
        child.on("exit", (/** @type {any} */ code) => resolve({ code, out, err }));
        child.on("error", (/** @type {any} */ e) => resolve({ code: null, out, err: String(e) }));
      });
    };
    const skip = /** @type {any} */ (await runCli({ ...fakeEnv("pass"), MEWTEST_SKIP: "1" }));
    test("CLI with MEWTEST_SKIP=1 exits 0 and prints skipped", () => {
      eq(skip.code, 0, skip.err);
      assert(/skipped/i.test(skip.out), skip.out);
    });
    if (hasSamples) {
      const failRun = /** @type {any} */ (await runCli(fakeEnv("fail"), ["jokers-luck", "smoke"]));
      test("CLI with a failing fake run exits 1 and prints FAIL", () => {
        eq(failRun.code, 1, failRun.err);
        assert(/FAIL/.test(failRun.out), failRun.out);
      });
      const passRun = /** @type {any} */ (await runCli(fakeEnv("pass"), ["jokers-luck", "--json"]));
      test("CLI --json with a passing fake run exits 0 and emits JSON reports", () => {
        eq(passRun.code, 0, passRun.err + passRun.out);
        const parsed = JSON.parse(passRun.out);
        assert(Array.isArray(parsed.reports) && parsed.reports.every((/** @type {any} */ r) => r.verdict === "pass"), passRun.out.slice(0, 300));
      });
    }
    const usage = /** @type {any} */ (await runCli(fakeEnv("pass"), ["--bogus-flag"]));
    test("CLI usage error exits 2", () => eq(usage.code, 2, usage.out + usage.err));
    rmSync(ROOT, { recursive: true, force: true });
  }

  void resolve;
}

// Standalone entry point: node test/ingame-tests.mjs
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let passed = 0, failed = 0;
  /** @param {string} name @param {() => void} fn */
  const test = (name, fn) => { try { fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${String(e instanceof Error ? e.message : e)}`); } };
  /** @param {boolean} c @param {string} m */
  const assert = (c, m) => { if (!c) throw new Error(m); };
  /** @param {unknown} a @param {unknown} b @param {string} [m] */
  const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || "not equal"}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); };
  await runIngameTests(test, assert, eq);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
