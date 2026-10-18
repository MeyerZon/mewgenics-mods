// Tests for the in-game test harness runner (editor/src/core/ingame/*).
// Pure modules are tested on fixtures; the runner is tested against a fake
// game (test/fixtures/fake-game.mjs) so nothing here needs Mewgenics, Steam
// or the native DLLs. Wired into run-tests.mjs; also runnable standalone:
//   node test/ingame-tests.mjs

import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
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

  void REPO_ROOT;
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
