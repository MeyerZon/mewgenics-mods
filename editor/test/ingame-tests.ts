// Tests for the in-game test harness runner (editor/src/core/ingame/*).
// Pure modules are tested on fixtures; the runner is tested against a fake
// game (test/fixtures/fake-game.ts) so nothing here needs Mewgenics, Steam
// or the native DLLs. Wired into run-tests.ts; also runnable standalone:
//   node test/ingame-tests.ts

import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MODS_DIR, REPO_ROOT } from "../src/core/repo.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";
import type { ResultSummary } from "../src/core/ingame/results.ts";
import type { VerdictLogs, ExitInfo, VerdictInput, IngameReport } from "../src/core/ingame/runner.ts";

/** Deliberately minimal stand-ins for the verdict table: only the fields each case reads are set. */
type DeepPartial<T> = T extends (infer U)[] ? DeepPartial<U>[] : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;
/** reason-or-error of a report that may be a refusal. */
const why = (r: { reason?: string; error?: string }): string | undefined => r.reason || r.error;

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures", "ingame");
const fixture = (name: string) => readFileSync(join(FIX, name), "utf8");

/** A module under test, or the load error so the caller can register one failing test instead of crashing the run. */
type Loaded<M> = M | { __error: string };

/**
 * Import a module, or return the error so the caller can register one failing test
 * instead of crashing the whole run (keeps the "red" phase readable).
 */
async function load<M>(rel: string): Promise<Loaded<M>> {
  try {
    return (await import(rel)) as M;
  } catch (e) {
    return { __error: String(e instanceof Error ? e.message : e) };
  }
}

/** A child process's captured exit. */
interface CliRun {
  code: number | null;
  out: string;
  err: string;
}

export async function runIngameTests(test: TestFn, assert: AssertFn, eq: EqFn): Promise<void> {
  // ---- script.ts ----------------------------------------------------------
  console.log("\n# In-game: .mewtest script parser");
  const script = await load<typeof import("../src/core/ingame/script.ts")>("../src/core/ingame/script.ts");
  if ("__error" in script) {
    test("script.ts loads", () => assert(false, script.__error));
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

    test("header: interactive parsed (true/1/false/0), default false, bad value is a line error", () => {
      eq(parseScript("cmd listcmds\nquit\n", { owningMod: "x" }).interactive, false, "default");
      for (const [v, want] of [["true", true], ["1", true], ["false", false], ["0", false]]) {
        const p = parseScript(`interactive: ${v}\ncmd listcmds\n`, { owningMod: "x" });
        assert(p.ok, `interactive: ${v}: ${JSON.stringify(p.errors)}`);
        eq(p.interactive, want, `interactive: ${v}`);
      }
      const bad = parseScript("interactive: maybe\ncmd listcmds\nquit\n", { owningMod: "x" });
      assert(!bad.ok && bad.errors.some((e: { line: number; message: string }) => e.line === 1 && /interactive must be true or false/.test(e.message)), JSON.stringify(bad.errors));
      const p = parseScript("interactive: true\nwait frames 1\n", { owningMod: "x" });
      assert(p.ok && !p.warnings.some((w: { message: string }) => /no quit directive/.test(w.message)), "an interactive script without quit is not warned about (quit arrives over the pipe)");
    });

    test("header: clean parsed (true/1/false/0), default false, bad value is a line error", () => {
      eq(parseScript("cmd listcmds\nquit\n", { owningMod: "x" }).clean, false, "default");
      for (const [v, want] of [["true", true], ["1", true], ["false", false], ["0", false]]) {
        const p = parseScript(`clean: ${v}\ncmd listcmds\nquit\n`, { owningMod: "x" });
        assert(p.ok, `clean: ${v}: ${JSON.stringify(p.errors)}`);
        eq(p.clean, want, `clean: ${v}`);
      }
      const bad = parseScript("clean: maybe\ncmd listcmds\nquit\n", { owningMod: "x" });
      assert(!bad.ok && bad.errors.some((e: { line: number; message: string }) => e.line === 1 && /clean must be true or false/.test(e.message)), JSON.stringify(bad.errors));
    });

    test("every directive kind parses with its line number", () => {
      const p = parseScript(fixture("scripts/valid.mewtest"), { owningMod: "jokers-luck" });
      const d = p.directives;
      eq(d.length, 19);
      eq(JSON.stringify(d[17]), JSON.stringify({ line: 24, kind: "expect", what: "unit", unit: "Lil' Rat", field: "faction", op: "!=", value: 1 }));
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
      eq(JSON.stringify(d[11]), JSON.stringify({ line: 18, kind: "expect", what: "log", substr: "Save File Suffix: dev" }));
      eq(JSON.stringify(d[12]), JSON.stringify({ line: 19, kind: "enter", scene: "TacticsTest" }));
      eq(JSON.stringify(d[13]), JSON.stringify({ line: 20, kind: "wait", unit: "rounds", n: 1 }));
      eq(JSON.stringify(d[14]), JSON.stringify({ line: 21, kind: "expect", what: "round", op: ">=", n: 2 }));
      eq(JSON.stringify(d[15]), JSON.stringify({ line: 22, kind: "expect", what: "stacks", status: "JokersLuck", unit: "0", op: "==", n: 1 }));
      eq(JSON.stringify(d[16]), JSON.stringify({ line: 23, kind: "expect", what: "stacks", status: "LuckUp", unit: "Mr Whiskers", varied: true }));
      eq(JSON.stringify(d[18]), JSON.stringify({ line: 25, kind: "quit", code: 0 }));
    });

    test("seed directive parses an unsigned 64-bit integer (kept as digits); junk, negatives and extra words are line errors", () => {
      const d = parseDirective("seed 42", 2) as { kind: string; seed: string };
      eq(d.kind, "seed"); eq(d.seed, "42");
      eq((parseDirective("seed 18446744073709551615", 2) as { seed: string }).seed, "18446744073709551615");
      for (const bad of ["seed", "seed -1", "seed 4x", "seed 1 2", "seed 18446744073709551616"]) assert("error" in parseDirective(bad, 1), `${bad} is an error`);
      const p = parseScript("seed 7\nquit\n", { owningMod: "m" });
      assert(p.ok && p.body.startsWith("seed 7\n"), "DLL-side directive");
    });

    test("shot directive parses a quoted label; bare or missing label is a line error; it passes through to the DLL", () => {
      const d = parseDirective('shot "round one"', 4) as { kind: string; label: string };
      eq(d.kind, "shot"); eq(d.label, "round one");
      assert("error" in parseDirective("shot bare", 1), "bare");
      assert("error" in parseDirective("shot", 1), "missing");
      const p = parseScript('shot "x"\nquit\n', { owningMod: "m" });
      assert(p.ok && p.body.startsWith('shot "x"\n'), "DLL-side directive");
    });

    test("combat directives: wait rounds needs N >= 1; expect round needs <op> <N>; expect stacks needs <op> <N> or varied", () => {
      assert("error" in parseDirective("wait rounds 0", 1), "rounds 0");
      assert("error" in parseDirective("expect round 3", 1), "round without op");
      assert("error" in parseDirective("expect stacks LuckUp on 0", 1), "stacks without op/varied");
      assert("error" in parseDirective("expect stacks LuckUp on 0 varied now", 1), "trailing text after varied");
      assert("error" in parseDirective("expect stacks LuckUp 0 == 1", 1), "missing on");
      const ok = parseDirective("expect stacks LuckUp on Lumee != 0", 1) as { what: string; unit: string; op: string; n: number };
      eq(ok.what, "stacks"); eq(ok.unit, "Lumee"); eq(ok.op, "!="); eq(ok.n, 0);
    });

    test("expect unit directive parses (index / bare / quoted unit; string fields name|class with == !=; integer fields faction|move|act|turnkind with every op); bad forms are line errors", () => {
      const a = parseDirective("expect unit 6 faction == 1", 1) as { what: string; unit: string; field: string; op: string; value: number };
      eq(a.what, "unit"); eq(a.unit, "6"); eq(a.field, "faction"); eq(a.op, "=="); eq(a.value, 1);
      const b = parseDirective('expect unit "Lil\' Rat" name == "Lil\' Rat"', 1) as { unit: string; field: string; op: string; value: string };
      eq(b.unit, "Lil' Rat"); eq(b.field, "name"); eq(b.op, "=="); eq(b.value, "Lil' Rat");
      const c = parseDirective("expect unit Pooter turnkind >= 0", 1) as { unit: string; field: string; op: string; value: number };
      eq(c.unit, "Pooter"); eq(c.field, "turnkind"); eq(c.op, ">="); eq(c.value, 0);
      eq((parseDirective('expect unit 0 class != "Mage"', 1) as { value: string }).value, "Mage");
      for (const bad of ["expect unit 6 faction", "expect unit 6 hp == 1", 'expect unit 6 name >= "x"', "expect unit 6 name == bare", "expect unit faction == 1", "expect unit 6 faction == x", "expect unit 6 move == 1 extra"]) {
        assert("error" in parseDirective(bad, 1), `${bad} is an error`);
      }
      const p = parseScript("expect unit 6 faction == 1\nquit\n", { owningMod: "m" });
      assert(p.ok && p.body.startsWith("expect unit 6 faction == 1\n"), "DLL-side directive");
    });

    test("enter directive parses a known scene; unknown or missing scene, or extra words, are line errors", () => {
      const d = parseDirective("enter TacticsTest", 2) as { kind: string; scene: string };
      eq(d.kind, "enter"); eq(d.scene, "TacticsTest");
      assert(Array.isArray(script.KNOWN_SCENES) && script.KNOWN_SCENES.includes("TacticsTest") && script.KNOWN_SCENES.includes("Campaign"), "KNOWN_SCENES lists TacticsTest and Campaign");
      const c = parseScript("enter Campaign\nquit\n", { owningMod: "m" });
      assert(c.ok && c.usesCampaignSlot === true, "a script that enters the campaign is flagged (the runner resets the disposable slot)");
      assert(parseScript("enter TacticsTest\nquit\n", { owningMod: "m" }).usesCampaignSlot === false, "TacticsTest does not use the slot");
      const bad = parseScript("enter Nope\nquit\n", { owningMod: "m" });
      assert(!bad.ok && bad.errors[0].line === 1 && /unknown scene "Nope"/.test(bad.errors[0].message), JSON.stringify(bad.errors));
      assert("error" in parseDirective("enter", 3), "missing scene");
      assert("error" in parseDirective("enter TacticsTest now", 3), "extra words");
    });

    test("expect log parses a quoted substring; within, bare words and an unterminated quote are line errors", () => {
      const d = parseDirective('expect log "NO_STATUS_NAMED"', 3) as { kind: string; what: string; substr: string };
      eq(d.kind, "expect"); eq(d.what, "log"); eq(d.substr, "NO_STATUS_NAMED");
      for (const bad of ['expect log "x" within 5', "expect log bare", 'expect log "unterminated', "expect log"]) {
        const r = parseDirective(bad, 9);
        assert("error" in r, `${bad} should be an error`);
      }
      const p = parseScript("expect log bare\nquit\n", { owningMod: "m" });
      assert(!p.ok && p.errors[0].line === 1, JSON.stringify(p.errors));
    });

    test("expect log is kept out of the DLL body as a comment so body line numbers do not shift", () => {
      const p = parseScript(fixture("scripts/valid.mewtest"), { owningMod: "jokers-luck" });
      const lines = p.body.split("\n");
      eq(lines.length - 1, 19, "one body line per directive (plus the trailing newline)");
      assert(!lines.some((l) => l.startsWith("expect log")), "the DLL never sees expect log");
      assert(lines[11]!.startsWith("# runner: expect log"), `placeholder comment at the directive's position, got ${JSON.stringify(lines[11])}`);
      eq(lines[12], "enter TacticsTest", "enter is a DLL-side directive and passes through");
      eq(lines[13], "wait rounds 1"); eq(lines[16], 'expect stacks LuckUp on "Mr Whiskers" varied');
      eq(lines[17], "expect unit \"Lil' Rat\" faction != 1"); eq(lines[18], "quit 0");
      assert(typeof script.isRunnerSide === "function" && script.isRunnerSide(p.directives[11]!) && !script.isRunnerSide(p.directives[0]!), "isRunnerSide marks only expect log");
    });

    test("all six units ops parse; a bad op is an error with its line", () => {
      for (const op of ["==", "!=", ">=", "<=", ">", "<"]) {
        const d = parseDirective(`expect units ${op} 3`, 4) as { op: string; n: number };
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
      eq((parseDirective("quit", 1) as { code: number | null }).code, null);
      eq((parseDirective("quit 7", 1) as { code: number | null }).code, 7);
      assert("error" in parseDirective("quit 300", 1), "quit 300 must error");
    });

    test("error cases carry line numbers", () => {
            const cases: Array<[string, string]> = [
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
      assert(p.warnings.some((w: { message: string }) => /quit/.test(w.message)), "warning mentions quit");
    });

    test("empty / comment-only script is ok with zero directives and a warning", () => {
      const p = parseScript("# nothing\n\n", { owningMod: "m" });
      assert(p.ok, "ok");
      eq(p.directives.length, 0);
      eq(p.body, "");
    });
  }

  // ---- discover.ts --------------------------------------------------------
  console.log("\n# In-game: test discovery");
  const discover = await load<typeof import("../src/core/ingame/discover.ts")>("../src/core/ingame/discover.ts");
  if ("__error" in discover) {
    test("discover.ts loads", () => assert(false, discover.__error));
  } else if (existsSync(join(MODS_DIR, "jokers-luck", "tests")) && existsSync(join(MODS_DIR, "dev-sandbox", "tests"))) {
    test("listIngameTests finds the committed sample scripts and they parse with zero errors", () => {
      const all = discover.listIngameTests();
      const names = all.tests.map((t: { mod: string; name: string }) => `${t.mod}/${t.name}`);
      assert(names.includes("jokers-luck/smoke"), `missing jokers-luck/smoke in ${names.join(",")}`);
      assert(names.includes("dev-sandbox/console-smoke"), `missing dev-sandbox/console-smoke in ${names.join(",")}`);
      for (const t of all.tests) assert(t.plan.ok, `${t.mod}/${t.name}: ${JSON.stringify(t.plan.errors)}`);
      const one = discover.listIngameTests("jokers-luck");
      assert(one.tests.every((t: { mod: string }) => t.mod === "jokers-luck"), "filter by mod");
      assert(one.tests[0].plan.mods.includes("jokers-luck"), "owning mod is the default -modpaths entry");
    });
  } else {
    test("sample .mewtest scripts present (skipped: mods/*/tests missing)", () => {});
  }

  // ---- results.ts ---------------------------------------------------------
  console.log("\n# In-game: result JSONL parser");
  const results = await load<typeof import("../src/core/ingame/results.ts")>("../src/core/ingame/results.ts");
  if ("__error" in results) {
    test("results.ts loads", () => assert(false, results.__error));
  } else {
    const { parseResults } = results;
    test("pass fixture: start/end, expects, console lines, turns, units", () => {
      const r = parseResults(fixture("result-pass.jsonl"));
      assert(r.present && !r.truncated, "present, not truncated");
      eq(r.parseErrors, 0);
      eq(r.events.length, 12);
      eq(r.start!.build, "1.1.21239 (steam 25143593)");
      eq(r.end!.code, 0);
      eq(r.end!.reason, "quit");
      eq(r.crash, null);
      eq(r.turns, 1);
      eq(r.consoleLines.length, 3);
      eq(r.expects.passed, 2);
      eq(r.expects.failed, 0);
      eq(r.units!.count, 2);
      eq((r.units!.list as { name: string }[])[0]!.name, "Lumee");
      eq(JSON.stringify((r.units!.list as { stacks: number[] }[]).map((u) => u.stacks)), JSON.stringify([[1], []]), "units snapshot: stacks parallel to statuses");
    });
    test("fail fixture lists failures with line, kind, arg, detail", () => {
      const r = parseResults(fixture("result-fail.jsonl"));
      eq(r.end!.code, 1);
      eq(r.expects.failed, 1);
      eq(r.expects.passed, 1);
      eq(JSON.stringify(r.expects.failures[0]), JSON.stringify({ line: 3, kind: "noconsole", arg: "No command named", detail: "found in console line 0" }));
    });
    test("enter event is surfaced as result.enter (line, name, ok, detail); absent -> null", () => {
      const text = [
        '{"ev":"start","harness":"mewtest 0.1.0","t":0,"frame":0}',
        '{"ev":"enter","line":2,"name":"TacticsTest","ok":false,"detail":"no MewDirector","t":40,"frame":3}',
        '{"ev":"end","code":1,"reason":"enter_failed","frames":3,"turns":0,"elapsed_ms":40,"expect_pass":0,"expect_fail":0,"t":40,"frame":3}',
      ].join("\n") + "\n";
      const r = parseResults(text) as unknown as { enter: { line: number; name: string; ok: boolean; detail: string } | null; end: { reason?: string } | null };
      assert(r.enter !== null && r.enter !== undefined, "result.enter present");
      eq(JSON.stringify(r.enter), JSON.stringify({ line: 2, name: "TacticsTest", ok: false, detail: "no MewDirector" }));
      eq(r.end!.reason, "enter_failed");
      eq((parseResults(fixture("result-pass.jsonl")) as unknown as { enter: unknown }).enter, null, "no enter event -> null");
    });
    test("OBSERVED 2026-10-20 fixture: enter TacticsTest -> run commands registered, a turn, 6 units (result-enter-fight.jsonl + console-tacticstest-listcmds.txt)", () => {
      const r = parseResults(fixture("result-enter-fight.jsonl")) as unknown as { enter: { ok: boolean; name: string } | null; turns: number; units: { available: boolean; count: number; round: number; list: { name: string; class: string; faction: number }[] } | null; expects: { passed: number; failed: number }; end: { code: number; reason: string } | null; popups: unknown[] };
      assert(!!r.enter && r.enter.ok && r.enter.name === "TacticsTest", `enter ok: ${JSON.stringify(r.enter)}`);
      eq(r.turns, 1, "TurnControl::NextTurn fired once before the dump");
      assert(!!r.units && r.units.available && r.units.count === 6 && r.units.round === 1, `units: ${JSON.stringify(r.units && { available: r.units.available, count: r.units.count, round: r.units.round })}`);
      eq(r.units!.list[0]!.name, "Antonieta"); eq(r.units!.list[0]!.class, "Thief"); eq(r.units!.list[0]!.faction, 1);
      eq(r.expects.passed, 3); eq(r.expects.failed, 0);
      eq(r.end!.code, 0); eq(r.end!.reason, "quit");
      eq(r.popups.length, 0, "no popup once the party is generated instead of read from a saved winning team");
      const cmds = fixture("console-tacticstest-listcmds.txt").split(/\r?\n/).filter(Boolean);
      eq(cmds.length, 85, "84 commands + the Executed: line");
      for (const c of ["listcmds", "spawn arg0", "spawntile arg0", "load arg0", "bind arg0", "bind_passive arg0", "status arg0", "passive arg0", "win", "killall", "takeover", "noui", "equip arg0", "weather arg0", "tileset arg0", "skip_tutorial", "set_day arg0"]) assert(cmds.includes(c), `TacticsTest/MewDirector command ${c} listed`);
      eq(cmds[cmds.length - 1], "Executed: listcmds");
    });
    test("OBSERVED fixture: golden through dump — the vanilla and _golden-merge dumps of the same seeded fight differ only on the overlaid fields (result-golden-vanilla.jsonl / result-golden-merge.jsonl)", () => {
      type U = { i: number; name: string; class: string; faction: number };
      type R = { units: { count: number; list: U[] } | null; expects: { passed: number; failed: number }; end: { code: number; reason: string } | null };
      const v = parseResults(fixture("result-golden-vanilla.jsonl")) as unknown as R;
      const g = parseResults(fixture("result-golden-merge.jsonl")) as unknown as R;
      assert(!!v.units && !!g.units, "both dumps present");
      eq(v.units!.count, 10, "vanilla (seed 42): 4 cats + 4 coins + Rat + Pooter");
      eq(g.units!.count, 11, "golden: + the appended GoldenRat");
      const rat = v.units!.list[8]!, ratG = g.units!.list[8]!;
      eq(rat.name, "Lil' Rat"); eq(ratG.name, "Golden Rat", ".merge: graphics.name -> the appended loc row");
      eq(rat.faction, 2, "enemies dump as faction 2 (allies 1, coins 0)");
      eq(ratG.faction, 1, ".merge: properties.faction enemies -> allies");
      const poo = v.units!.list[9]!, pooG = g.units!.list[9]!;
      eq(poo.name, "Pooter"); eq(pooG.name, "Pooter");
      assert(poo.faction !== 1 && pooG.faction === 1, `.patch: faction.overwrite allies (${poo.faction} -> ${pooG.faction})`);
      eq(g.units!.list[10]!.name, "Appended Rat", ".append: a new entry, spawnable, with its own loc row");
      eq(g.units!.list[10]!.faction, 2, "the appended entry keeps the vanilla faction");
      for (let i = 0; i < 8; i++) eq(JSON.stringify(v.units!.list[i]), JSON.stringify(g.units!.list[i]), `unit ${i} identical in both runs (seed 42)`);
      eq(v.expects.failed, 0); eq(g.expects.failed, 0);
      eq(v.end!.code, 0); eq(g.end!.code, 0);
    });
    test("OBSERVED 2026-10-20 fixture: enter Campaign -> ok, the harness-owned slot named in the detail, no popup, quit after the shots (result-enter-campaign.jsonl)", () => {
      const r = parseResults(fixture("result-enter-campaign.jsonl")) as unknown as { enter: { ok: boolean; name: string; detail: string } | null; shots: unknown[]; end: { code: number; reason: string } | null; popups: unknown[]; turns: number };
      assert(!!r.enter && r.enter.ok && r.enter.name === "Campaign", `enter ok: ${JSON.stringify(r.enter)}`);
      assert(r.enter!.detail.includes("save=mewtest01.sav"), "the DLL names the slot the editor allows (savecheck.CAMPAIGN_SLOT_FILE)");
      eq(r.shots.length, 3); eq(r.popups.length, 0); eq(r.turns, 0, "no fight: the new game starts in the intro cutscene");
      eq(r.end!.code, 0); eq(r.end!.reason, "quit");
    });
    test("OBSERVED 2026-10-20 fixture: combat-asserts — stacks in the units snapshot, round 2 after wait rounds, spawn adds a unit (result-combat-asserts.jsonl)", () => {
      const r = parseResults(fixture("result-combat-asserts.jsonl")) as unknown as { turns: number; units: { round: number; count: number; list: { name: string; faction: number; statuses: string[]; stacks: number[] }[] } | null; expects: { passed: number; failed: number }; events: { ev: string; kind?: string; actual?: number; detail?: string }[]; end: { code: number } | null };
      eq(r.turns, 6, "turns 2..6 happened on their own (the player cats are Uncontrollable)");
      assert(!!r.units && r.units.round === 2 && r.units.count === 7, `last dump: ${JSON.stringify(r.units && { round: r.units.round, count: r.units.count })}`);
      const withStacks = r.units!.list.filter((u) => u.statuses.length && u.statuses.length === u.stacks.length);
      assert(withStacks.length >= 2 && withStacks.some((u) => u.statuses.includes("CharismaUp") && u.stacks[u.statuses.indexOf("CharismaUp")]! > 0), `stacks parallel to statuses: ${JSON.stringify(withStacks.map((u) => [u.statuses, u.stacks]))}`);
      assert(r.units!.list.some((u) => u.name === "Lil' Rat" && u.faction === 2), "the spawned opponent is in the snapshot");
      const roundsWait = r.events.find((e) => e.ev === "wait" && e.kind === "rounds");
      assert(!!roundsWait && roundsWait.actual === 1, "wait rounds 1 completed");
      assert(r.events.some((e) => e.ev === "expect" && e.kind === "round" && /round 2/.test(e.detail || "")), "expect round >= 2 saw round 2");
      eq(r.expects.failed, 0); eq(r.end!.code, 0);
    });
    test("OBSERVED 2026-10-20 fixture: luck-rerolls — the native JokersLuck status rerolls its stacks every turn (result-luck-rerolls.jsonl)", () => {
      const r = parseResults(fixture("result-luck-rerolls.jsonl")) as unknown as { events: { ev: string; kind?: string; ok?: boolean; detail?: string; list?: { name: string; statuses: string[]; stacks: number[] }[] }[]; expects: { passed: number; failed: number }; end: { code: number } | null };
      const dumps = r.events.filter((e) => e.ev === "units");
      eq(dumps.length, 4);
      const luck = dumps.map((d) => { const u = d.list![0]!; const k = u.statuses.indexOf("JokersLuck"); return k < 0 ? null : u.stacks[k]!; });
      assert(luck.every((v) => v !== null), `JokersLuck on the first cat in every dump: ${JSON.stringify(luck)}`);
      eq(luck[0], 1, "1 stack at battle start (StatusOnBattleStart)");
      assert(new Set(luck).size >= 2, `the stacks change across rounds: ${JSON.stringify(luck)}`);
      const varied = r.events.find((e) => e.ev === "expect" && e.kind === "stacks" && /varied/.test(e.detail || "") || (e.ev === "expect" && e.kind === "stacks" && /distinct/.test(e.detail || "")));
      assert(!!varied && varied.ok === true, `expect stacks varied ok: ${JSON.stringify(varied)}`);
      assert(r.events.some((e) => e.ev === "expect" && e.kind === "noconsole" && e.ok === true), "bind JokersGambit was accepted (no 'No command named')");
      eq(r.expects.failed, 0); eq(r.end!.code, 0);
    });
    test("exec and idle events are kept: result.execs (id, op, text, ok, lines) and result.idle", () => {
      const text = '{"ev":"start","t":0,"frame":0}\n{"ev":"idle","line":2,"t":10,"frame":5}\n{"ev":"exec","id":1,"op":"exec","text":"spawn Rat","ok":true,"lines":["Spawned Rat"],"t":20,"frame":9}\n{"ev":"exec","id":2,"op":"dump","ok":true,"t":21,"frame":10}\n{"ev":"end","code":0,"reason":"quit","t":30,"frame":12}\n';
      const r = parseResults(text) as unknown as { execs: { id: number; op: string; text?: string; ok: boolean; lines?: string[]; frame: number }[]; idle: boolean };
      eq(r.execs.length, 2);
      eq(JSON.stringify(r.execs[0]), JSON.stringify({ id: 1, op: "exec", text: "spawn Rat", ok: true, lines: ["Spawned Rat"], frame: 9 }));
      eq(r.execs[1]!.op, "dump"); eq(r.idle, true);
      eq((parseResults(fixture("result-pass.jsonl")) as unknown as { execs: unknown[]; idle: boolean }).execs.length, 0);
      eq((parseResults(fixture("result-pass.jsonl")) as unknown as { idle: boolean }).idle, false);
    });
    test("seed event is surfaced as result.seed (line, seed, ok, detail); absent -> null", () => {
      const text = '{"ev":"start","t":0,"frame":0}\n{"ev":"seed","line":2,"seed":42,"ok":true,"detail":"state at 0x1: 00… -> 11…","t":10,"frame":5}\n{"ev":"end","code":0,"reason":"quit","t":20,"frame":9}\n';
      const r = parseResults(text) as unknown as { seed: { line: number; seed: string; ok: boolean; detail: string } | null };
      eq(JSON.stringify(r.seed), JSON.stringify({ line: 2, seed: "42", ok: true, detail: "state at 0x1: 00… -> 11…" }));
      eq((parseResults(fixture("result-pass.jsonl")) as unknown as { seed: unknown }).seed, null);
    });
    test("shot events are collected as result.shots (line, label, frame)", () => {
      const text = '{"ev":"start","t":0,"frame":0}\n{"ev":"shot","line":3,"label":"round one","hold_ms":700,"t":10,"frame":5}\n{"ev":"end","code":0,"reason":"quit","t":20,"frame":9}\n';
      const r = parseResults(text) as unknown as { shots: { line: number; label: string; frame: number }[] };
      eq(JSON.stringify(r.shots), JSON.stringify([{ line: 3, label: "round one", frame: 5 }]));
      eq((parseResults(fixture("result-pass.jsonl")) as unknown as { shots: unknown[] }).shots.length, 0);
    });
    test("popup events are collected as result.popups (title, text, frame); none -> empty", () => {
      const text = [
        '{"ev":"start","harness":"mewtest 0.1.0","t":0,"frame":0}',
        '{"ev":"popup","title":"WARNING","text":"no saved winning teams - win at least one run first!","t":3531,"frame":519}',
        '{"ev":"popup","title":"ERROR","text":"More than one mew director","t":4031,"frame":520}',
        '{"ev":"end","code":3,"reason":"crash","frames":520,"turns":0,"elapsed_ms":4100,"expect_pass":0,"expect_fail":0,"t":4100,"frame":520}',
      ].join("\n") + "\n";
      const r = parseResults(text) as unknown as { popups: { title: string; text: string; frame: number }[] };
      eq(JSON.stringify(r.popups), JSON.stringify([{ title: "WARNING", text: "no saved winning teams - win at least one run first!", frame: 519 }, { title: "ERROR", text: "More than one mew director", frame: 520 }]));
      eq((parseResults(fixture("result-pass.jsonl")) as unknown as { popups: unknown[] }).popups.length, 0);
    });
    test("crash fixture exposes the crash event", () => {
      const r = parseResults(fixture("result-crash.jsonl"));
      eq(r.crash!.code, "0xC0000005");
      eq(r.crash!.rva, "0x4929c0");
      eq(r.end!.code, 3);
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
      eq(r.end!.code, 0);
    });
  }

  // ---- logs.ts ------------------------------------------------------------
  console.log("\n# In-game: log scanners");
  const logs = await load<typeof import("../src/core/ingame/logs.ts")>("../src/core/ingame/logs.ts");
  if ("__error" in logs) {
    test("logs.ts loads", () => assert(false, logs.__error));
  } else {
    const { scanDebugLog, checkSaveSuffix, scanFrameworkLog, scanChainloaderLog, readWindow, locateAppdataLogsDir, collectLogs } = logs;
    test("scanDebugLog: every marker found with the [file: ...] prefix stripped and line numbers", () => {
      const r = scanDebugLog(fixture("debug-markers.log"));
      const markers = r.findings.map((f: { marker: string }) => f.marker);
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
    test("checkLogExpects: matches after the [file: ...] prefix is stripped, reports the missing substring and line, and an absent debug.log", () => {
      const check = (logs as unknown as { checkLogExpects?: (text: string | null, e: { line: number; substr: string }[]) => { line: number; substr: string; ok: boolean; detail: string }[] }).checkLogExpects;
      assert(typeof check === "function", "checkLogExpects exported from logs.ts");
      const text = fixture("debug-clean.log");
      const r = check!(text, [{ line: 4, substr: "Save File Suffix: dev" }, { line: 9, substr: "NOT IN THIS LOG" }]);
      eq(r.length, 2);
      assert(r[0]!.ok && /matched debug\.log line \d+/.test(r[0]!.detail), JSON.stringify(r[0]));
      assert(!r[1]!.ok && r[1]!.line === 9 && /not found in debug\.log/.test(r[1]!.detail), JSON.stringify(r[1]));
      assert(!check!(text, [{ line: 1, substr: "[file:" }])[0]!.ok, "the [file: …] prefix is not part of the message");
      const absent = check!(null, [{ line: 2, substr: "x" }]);
      assert(!absent[0]!.ok && /debug\.log absent/.test(absent[0]!.detail), JSON.stringify(absent));
      eq(check!(text, []).length, 0);
    });
    test("checkSaveSuffix: ok / missing / different", () => {
      assert(checkSaveSuffix("dev", "dev").ok, "same");
      const m = checkSaveSuffix(null, "dev");
      assert(!m.ok && /missing|not found/i.test(m.reason ?? ""), "missing");
      const d = checkSaveSuffix("other", "dev");
      assert(!d.ok && /other/.test(d.reason ?? ""), "different");
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
      assert(!!(u.identity && u.identity.timeDateStamp === "0x6b000000" && u.identity.sizeOfImage === "0x01580000"), `identity parsed: ${JSON.stringify(u.identity)}`);
      eq(u.signatureFailures.length, 0);
      const sf = scanFrameworkLog(fixture("mewframework-signature-failed.log"));
      assert(!sf.unknownBuild && !sf.active, "known build, inactive");
      eq(sf.build, "1.1.21239 (steam 25143593)");
      eq(sf.signatureFailures.map((f: { name: string; matches: number }) => `${f.name}=${f.matches}`).join(","), "DebugConsole_Execute=0,ApplicationBase_FrameBegin=2");
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
      assert(cr.crashLines.some((l: string) => /fatal=1/.test(l)), "fatal VEH line");
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

  // ---- launch.ts ----------------------------------------------------------
  console.log("\n# In-game: launch builder + preflight");
  const launch = await load<typeof import("../src/core/ingame/launch.ts")>("../src/core/ingame/launch.ts");
  if ("__error" in launch || "__error" in script) {
    test("launch.ts loads", () => assert(false, "__error" in launch ? launch.__error : "script.ts missing"));
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
            const cases: Array<[string, RegExp]> = [["Mewgenics.exe", /Mewgenics\.exe/], ["version.dll", /version\.dll/], ["chainloader.ini", /chainloader\.ini/], ["mewframework.dll", /mewframework\.dll/], ["mewtest.dll", /mewtest\.dll/], ["jokers-luck", /jokers-luck/]];
      for (const [missing, re] of cases) {
        const r = preflight(plan, { gameDir: "C:\\G", env: {}, exists: (p: string) => !p.toLowerCase().endsWith(missing.toLowerCase()), steamRunning: () => true, modsDir: "C:\\repo\\mods", appdataLogsDir: "C:\\A\\logs" });
        assert(!r.ok, `${missing}: should fail`);
        assert(r.reasons.some((x: string) => re.test(x)), `${missing}: reason ${JSON.stringify(r.reasons)}`);
      }
      const noSteam = preflight(plan, { gameDir: "C:\\G", env: {}, exists: okExists, steamRunning: () => false, modsDir: "C:\\repo\\mods", appdataLogsDir: "C:\\A\\logs" });
      assert(!noSteam.ok && noSteam.reasons.some((x: string) => /steam/i.test(x)), "steam not running");
      const unknownSteam = preflight(plan, { gameDir: "C:\\G", env: {}, exists: okExists, steamRunning: () => null, modsDir: "C:\\repo\\mods", appdataLogsDir: "C:\\A\\logs" });
      assert(unknownSteam.ok, "unknown steam state is not a blocker");
      const noApp = preflight(plan, { gameDir: "C:\\G", env: {}, exists: okExists, steamRunning: () => true, modsDir: "C:\\repo\\mods", appdataLogsDir: null });
      assert(!noApp.ok && noApp.reasons.some((x: string) => /appdata|logs/i.test(x)), "appdata logs dir");
    });
    test("preflight: MEWTEST_SKIP=1 -> skipped; MEWTEST_FAKE_GAME relaxes the game checks", () => {
      const s = preflight(plan, { gameDir: "C:\\G", env: { MEWTEST_SKIP: "1" }, exists: () => false, steamRunning: () => false, modsDir: "C:\\repo\\mods", appdataLogsDir: null });
      assert(s.skipped && !s.ok, "skipped");
      const f = preflight(plan, { gameDir: "C:\\G", env: { MEWTEST_FAKE_GAME: "C:\\fake.mjs" }, exists: (p: string) => p.includes("mods"), steamRunning: () => false, modsDir: "C:\\repo\\mods", appdataLogsDir: "C:\\A\\logs" });
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
    test("buildLaunch is OS-neutral: Windows-shaped paths join with backslashes and POSIX-shaped paths with slashes, on any host", () => {
      // The launched game is always a Windows process, but the suite (and CI) may run on Linux: the joins must follow
      // the shape of the paths given, not the host. Windows half (ctx above) is asserted by the test before this one.
      const posix = { gameDir: "/opt/mew", scriptPath: "/tmp/r1/script.mewtest", outPath: "/tmp/r1/result.jsonl", env: {}, modsDir: "/repo/mods" };
      const l = buildLaunch(plan, posix);
      eq(l.command, "/opt/mew/Mewgenics.exe");
      eq(l.args.slice(l.args.indexOf("-modpaths")).join("|"), "-modpaths|/repo/mods/jokers-luck|/repo/mods/dev-sandbox");
      const w = buildLaunch(plan, ctx);
      eq(w.command, "C:\\Games\\Mew genics\\Mewgenics.exe");
      eq(w.args[w.args.length - 1], "C:\\re po\\mods\\dev-sandbox");
      const throws = (fn: () => void): unknown => { try { fn(); return null; } catch (e) { return e; } };
      assert(throws(() => buildLaunch(plan, { ...posix, modsDir: "/x/saves/mods" })) instanceof LaunchError, "posix saves path refused");
      assert(throws(() => buildLaunch(plan, { ...ctx, modsDir: "C:\\x\\saves\\mods" })) instanceof LaunchError, "windows saves path refused");
      assert(throws(() => buildLaunch(plan, { ...posix, scriptPath: "rel/script.mewtest" })) instanceof LaunchError, "posix relative script refused");
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
            const throws = (fn: () => void): unknown => { try { fn(); return null; } catch (e) { return e; } };
      const bad = script.parseScript("cmd listcmds\nquit\n", { owningMod: "jokers-luck" });
      bad.savesuffix = "has space";
      const e1 = throws(() => buildLaunch(bad, ctx));
      assert(e1 instanceof LaunchError, "bad suffix -> LaunchError");
      const e2 = throws(() => buildLaunch(plan, { ...ctx, modsDir: "C:\\x\\saves\\mods" }));
      assert(e2 instanceof LaunchError && /saves/i.test(String((e2 as Error).message)), "saves path refused");
      const e3 = throws(() => buildLaunch(plan, { ...ctx, scriptPath: "rel\\script.mewtest" }));
      assert(e3 instanceof LaunchError, "relative script path refused");
      const e4 = throws(() => buildLaunch(plan, { ...ctx, modsDir: "C:\\repo\\mods", scriptPath: "C:\\x\\saves\\s.mewtest" }));
      assert(e4 instanceof LaunchError, "saves script path refused");
    });
    test("buildLaunch: MEWTEST_FAKE_GAME -> node + fake script with the same args", () => {
      const l = buildLaunch(plan, { ...ctx, env: { MEWTEST_FAKE_GAME: "C:\\fake\\fake-game.ts" } });
      assert(l.fake, "fake");
      eq(l.command, process.argv[0]);
      eq(l.args[0], "C:\\fake\\fake-game.ts");
      eq(l.args.slice(1, 3).join(" "), "-savesuffix dev");
      eq(l.cwd, "C:\\Games\\Mew genics");
    });
  }

  // ---- savecheck.ts -------------------------------------------------------
  console.log("\n# In-game: real-save read-only hash check");
  const savecheck = await load<typeof import("../src/core/ingame/savecheck.ts")>("../src/core/ingame/savecheck.ts");
  if ("__error" in savecheck) {
    test("savecheck.ts loads", () => assert(false, savecheck.__error));
  } else {
    const { snapshotFile, compareSnapshots, realSavePath, KNOWN_REAL_SAVE_SHA256 } = savecheck;
    test("snapshotFile + compareSnapshots on a fixture (never a real save)", () => {
      const p = join(FIX, "sample-save.bin");
      const a = snapshotFile(p);
      assert(!!(a.present && a.sha256 && a.sha256.length === 64), "sha256 present");
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
      eq(before.files.map((f: { name: string }) => f.name).join(","), "steamcampaign01.sav,steamcampaign02.sav", "sorted, allowed and non-.sav files excluded");
      assert(before.files.every((f: { present: boolean; sha256: string | null }) => f.present && f.sha256 && f.sha256.length === 64), "hashed");
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
    test("devSavePattern: the files a -savesuffix launch may write are the local slots, the test director and the house test; the Steam-cloud slots never", () => {
      const p = savecheck.devSavePattern("dev");
      for (const ok of ["campaign01.sav", "campaign02.sav", "campaign03.sav", "test00.sav", "housetest01.sav", "devcampaign01.sav"]) assert(p.test(ok), `${ok} allowed`);
      for (const no of ["steamcampaign01.sav", "steamcampaign02.sav", "steamcampaign03.sav", "campaign01.savbackup", "other.sav"]) assert(!p.test(no), `${no} protected`);
      assert(savecheck.devSavePattern("a.b").test("a.bcampaign01.sav") && !savecheck.devSavePattern("a.b").test("aXbcampaign01.sav"), "suffix is escaped");
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

  // ---- runner.ts (against the fake game) ----------------------------------
  console.log("\n# In-game: runner against the fake game");
  const runner = await load<typeof import("../src/core/ingame/runner.ts")>("../src/core/ingame/runner.ts");
  if ("__error" in runner || "__error" in script) {
    test("runner.ts loads", () => assert(false, "__error" in runner ? runner.__error : "script.ts missing"));
  } else {
    const { runPlan, acquireLock, runDirName, decideVerdict, LOCK_FILE } = runner;
    const FAKE = join(HERE, "fixtures", "fake-game.ts");
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
        const run = (mode: string, extraEnv: Record<string,string> = {}, extra: Record<string, any> = {}) =>
      runPlan({
        plan,
        test: { mod: "jokers-luck", name: "smoke", scriptPath: null },
        env: { MEWTEST_FAKE_GAME: FAKE, FAKE_GAME_MODE: mode, FAKE_GAME_APPDATA_LOGS: appLogs, PATH: process.env.PATH || "", ...extraEnv },
        gameDir, appdataLogsDir: appLogs, modsDir, runsDir, realSavePath: savePath, backstopGraceMs: 500,
        ...extra,
      });

    test("uniqueRunDir: a second run in the same second gets a distinct dir (-2, -3 …), never a reused result file", () => {
      assert(typeof runner.uniqueRunDir === "function", "uniqueRunDir exported from runner.ts");
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
      if (a.ok) a.release();
      writeFileSync(join(runsDir, LOCK_FILE), "999999999");
      const c = acquireLock(runsDir);
      assert(c.ok, "stale lock reclaimed");
      if (c.ok) c.release();
      assert(!existsSync(join(runsDir, LOCK_FILE)), "release removes the lock file");
    });

    test("decideVerdict precedence table", () => {
      const pre = { ok: true, skipped: false, reasons: [], checks: {} };
      // deliberately minimal stand-ins: decideVerdict only reads the fields each case sets
      const res = (o: DeepPartial<ResultSummary>): ResultSummary => ({ present: true, truncated: false, parseErrors: 0, events: [], start: {}, end: { code: 0 }, crash: null, scriptError: null, turns: 0, consoleLines: [], expects: { passed: 1, failed: 0, failures: [] }, units: null, ...o } as ResultSummary);
      const logs = (o: DeepPartial<VerdictLogs>): VerdictLogs => ({ debugLog: { findings: [] }, frameworkLog: { active: true, present: true }, chainloaderLog: { crashLines: [] }, crashReports: [], ...o } as VerdictLogs);
      const safe = { saveSuffixOk: true, saveCheck: null };
      const exit = (code: number | null, backstop = false): ExitInfo => ({ code, signal: null, backstop });
      const expectV = (label: string, input: VerdictInput, want: string) => eq(decideVerdict(input).verdict, want, label);
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
      // seed: seed_failed (code 1) -> fail naming line and detail; seed_unavailable (code 4) -> harness-error
      const seedFail = decideVerdict({ preflight: pre, exit: exit(1), result: res({ end: { code: 1, reason: "seed_failed" }, expects: { passed: 0, failed: 0, failures: [] }, seed: { line: 2, seed: "42", ok: false, detail: "RNG state not reachable: no TLS block" } } as DeepPartial<ResultSummary>), logs: logs({}), safety: safe });
      eq(seedFail.verdict, "fail"); assert(/seed 42 failed at line 2: RNG state not reachable/.test(seedFail.reason), seedFail.reason);
      const seedUnavail = decideVerdict({ preflight: pre, exit: exit(4), result: res({ end: { code: 4, reason: "seed_unavailable" }, seed: { line: 2, seed: "42", ok: false, detail: "symbol missing" } } as DeepPartial<ResultSummary>), logs: logs({}), safety: safe });
      eq(seedUnavail.verdict, "harness-error"); assert(/seed_unavailable|symbol missing/.test(seedUnavail.reason), seedUnavail.reason);
      // popups the harness dismissed are appended to a non-pass reason (they usually explain it)
      const popups = [{ title: "WARNING", text: "no saved winning teams - win at least one run first!", frame: 519 }];
      const crashWithPopup = decideVerdict({ preflight: pre, exit: exit(3), result: res({ end: { code: 3, reason: "crash" }, popups } as DeepPartial<ResultSummary>), logs: logs({}), safety: safe });
      eq(crashWithPopup.verdict, "crash");
      assert(/popup WARNING: no saved winning teams/.test(crashWithPopup.reason), crashWithPopup.reason);
      const passWithPopup = decideVerdict({ preflight: pre, exit: exit(0), result: res({ popups } as DeepPartial<ResultSummary>), logs: logs({}), safety: safe });
      eq(passWithPopup.verdict, "pass", "a dismissed popup does not fail a run by itself");
      assert(/1 popup/.test(passWithPopup.reason), passWithPopup.reason);
      // enter: end reason enter_failed (code 1) -> fail naming the scene, line and detail; enter_unavailable (code 4) -> harness-error
      const enterFail = decideVerdict({ preflight: pre, exit: exit(1), result: res({ end: { code: 1, reason: "enter_failed" }, expects: { passed: 0, failed: 0, failures: [] }, enter: { line: 2, name: "TacticsTest", ok: false, detail: "no MewDirector" } } as DeepPartial<ResultSummary>), logs: logs({}), safety: safe });
      eq(enterFail.verdict, "fail", "enter_failed -> fail");
      assert(/enter TacticsTest failed at line 2: no MewDirector/.test(enterFail.reason), enterFail.reason);
      const enterUnavail = decideVerdict({ preflight: pre, exit: exit(4), result: res({ end: { code: 4, reason: "enter_unavailable" }, enter: { line: 2, name: "TacticsTest", ok: false, detail: "symbols missing" } } as DeepPartial<ResultSummary>), logs: logs({}), safety: safe });
      eq(enterUnavail.verdict, "harness-error", "enter_unavailable -> harness-error");
      assert(/enter_unavailable|symbols missing/.test(enterUnavail.reason), enterUnavail.reason);
      // runner-side expect log: a miss is a fail naming line and substring; log-errors still wins; all ok -> pass
      const missLog = decideVerdict({ preflight: pre, exit: exit(0), result: res({}), logs: logs({}), safety: safe, logExpects: [{ line: 5, substr: "Luck changed", ok: false, detail: "not found in debug.log" }] });
      eq(missLog.verdict, "fail", "expect log miss -> fail");
      assert(/expect log failed at line 5/.test(missLog.reason) && /Luck changed/.test(missLog.reason), missLog.reason);
      expectV("log-errors beats a missed expect log", { preflight: pre, exit: exit(0), result: res({}), logs: logs({ debugLog: { findings: [{ marker: "NO_STATUS_NAMED", line: 1, text: "x" }] } }), safety: safe, logExpects: [{ line: 5, substr: "x", ok: false, detail: "not found in debug.log" }] }, "log-errors");
      const okLog = decideVerdict({ preflight: pre, exit: exit(0), result: res({}), logs: logs({}), safety: safe, logExpects: [{ line: 5, substr: "x", ok: true, detail: "matched debug.log line 2" }] });
      eq(okLog.verdict, "pass", "expect log ok -> pass");
      assert(/1 log expectation/.test(okLog.reason), okLog.reason);
      // crash beats fail/timeout; safety beats crash
      expectV("crash > fail", { preflight: pre, exit: exit(1), result: res({ crash: { code: "x" }, end: { code: 1 } }), logs: logs({}), safety: safe }, "crash");
      expectV("safety > crash", { preflight: pre, exit: exit(3), result: res({ crash: { code: "x" }, end: { code: 3 } }), logs: logs({}), safety: { saveSuffixOk: false, saveCheck: null } }, "safety-violation");
    });

    // the disposable campaign slot: a script with `enter Campaign` starts from a fresh slot — the runner moves the
    // harness-owned mewtest01.sav aside into the run dir before launching (never deletes, never any other save) and
    // reports it; after the run it says whether the game created a new one
    const campaignPlan = script.parseScript("mods: jokers-luck\ntimeout: 1s\nenter Campaign\nquit\n", { owningMod: "jokers-luck", name: "campaign" });
    const savesDirC = join(ROOT, "saves-campaign");
    mkdirSync(savesDirC, { recursive: true });
    writeFileSync(join(savesDirC, "mewtest01.sav"), "old harness run");
    writeFileSync(join(savesDirC, "campaign02.sav"), "the owner's local slot");
    writeFileSync(join(savesDirC, "steamcampaign01.sav"), fixture("sample-save.bin"));
    const campaignRun = await run("pass", {}, { plan: campaignPlan, realSavesDir: savesDirC, realSavePath: join(savesDirC, "steamcampaign01.sav") });
    test("enter Campaign -> the runner moves only the harness-owned mewtest01.sav into the run dir before the run and says so in safety", () => {
      assert(!existsSync(join(savesDirC, "mewtest01.sav")), "mewtest01.sav moved out of the saves dir");
      assert(existsSync(join(savesDirC, "campaign02.sav")) && existsSync(join(savesDirC, "steamcampaign01.sav")), "other saves untouched");
      const s = campaignRun.safety as unknown as { campaignSlot?: { file: string; reset: boolean; backup: string | null; after: string } };
      assert(!!s.campaignSlot && /mewtest01.sav$/.test(s.campaignSlot.file) && s.campaignSlot.reset === true, `safety.campaignSlot: ${JSON.stringify(s.campaignSlot)}`);
      assert(!!s.campaignSlot!.backup && existsSync(s.campaignSlot!.backup) && readFileSync(s.campaignSlot!.backup, "utf8") === "old harness run", "the previous slot content is kept in the run dir");
      eq(s.campaignSlot!.after, "absent", "the fake game creates no save");
      eq(campaignRun.verdict, "pass", campaignRun.reason);
      const sc = savecheck as typeof import("../src/core/ingame/savecheck.ts");
      eq(sc.CAMPAIGN_SLOT_FILE, "mewtest01.sav");
      assert(sc.devSavePattern("dev").test("mewtest01.sav") && !sc.devSavePattern("dev").test("mewtest.sav"), "the slot family is allowed to change; nothing else new");
    });
    const tacticsRun = await run("pass", {}, { plan: script.parseScript("mods: jokers-luck\ntimeout: 1s\nenter TacticsTest\nquit\n", { owningMod: "jokers-luck", name: "t" }), realSavesDir: savesDirC, realSavePath: join(savesDirC, "steamcampaign01.sav") });
    test("enter TacticsTest (or no enter) leaves the campaign slot alone: safety.campaignSlot is null", () => {
      eq((tacticsRun.safety as unknown as { campaignSlot: unknown }).campaignSlot, null);
    });

    // ---- interactive mode: a named pipe into the running game -------------------------------------------
    const pipeMod = await load<typeof import("../src/core/ingame/pipe.ts")>("../src/core/ingame/pipe.ts") as typeof import("../src/core/ingame/pipe.ts");
    const sessionMod = await load<typeof import("../src/core/ingame/session.ts")>("../src/core/ingame/session.ts") as typeof import("../src/core/ingame/session.ts");
    test("pipePath: win32 -> \\\\.\\pipe\\mewtest-<pid>; elsewhere a socket file in the tmp dir; never under saves/", () => {
      eq(pipeMod.pipePath(123, "win32"), "\\\\.\\pipe\\mewtest-123");
      const p = pipeMod.pipePath(123, "linux");
      assert(p.endsWith("mewtest-123.sock") && p.startsWith(tmpdir()), p);
      assert(!/[\\/]saves[\\/]/.test(pipeMod.pipePath(1, "win32")), "never a saves path");
    });
    test("launch: plan.interactive -> -mewtest_pipe 1 before -modpaths; otherwise 0", () => {
      const bl = (launch as typeof import("../src/core/ingame/launch.ts")).buildLaunch;
      const on = bl({ ...plan, interactive: true }, { gameDir, scriptPath: join(ROOT, "s.mewtest"), outPath: join(ROOT, "s.jsonl"), env: {}, modsDir });
      const i = on.args.indexOf("-mewtest_pipe");
      assert(i >= 0 && on.args[i + 1] === "1" && i < on.args.indexOf("-modpaths"), on.args.join(" "));
      const off = bl(plan, { gameDir, scriptPath: join(ROOT, "s.mewtest"), outPath: join(ROOT, "s.jsonl"), env: {}, modsDir });
      eq(off.args[off.args.indexOf("-mewtest_pipe") + 1], "0");
    });
    test("connectPipe: retries until the server exists and gives up after timeoutMs", async () => {
      const t0 = Date.now();
      let err = "";
      try { await pipeMod.connectPipe(pipeMod.pipePath(999999, process.platform), { retryMs: 20, timeoutMs: 150 }); } catch (e) { err = e instanceof Error ? e.message : String(e); }
      assert(/timed out|not available|ENOENT|ECONNREFUSED/.test(err), `rejects with a reason: ${err}`);
      assert(Date.now() - t0 >= 120, "waited for the timeout");
    });
    const interactivePlan = script.parseScript("mods: jokers-luck\ninteractive: true\ntimeout: 3s\nwait frames 1\n", { owningMod: "jokers-luck", name: "interactive" });
    assert(interactivePlan.ok && interactivePlan.interactive, "interactive plan parses");
    const sessionArgs = {
      plan: interactivePlan,
      test: { mod: "jokers-luck", name: "interactive", scriptPath: null },
      env: { MEWTEST_FAKE_GAME: FAKE, FAKE_GAME_MODE: "interactive", FAKE_GAME_APPDATA_LOGS: appLogs, PATH: process.env.PATH || "" },
      gameDir, appdataLogsDir: appLogs, modsDir, runsDir, realSavePath: savePath, backstopGraceMs: 500,
    };
    type Sess = Awaited<ReturnType<typeof sessionMod.startSession>>;
    let session: Sess | null = null, execReply: Awaited<ReturnType<Sess["exec"]>> | null = null, dumpReply: Awaited<ReturnType<Sess["dump"]>> | null = null, sessionReport: Awaited<ReturnType<Sess["stop"]>> | null = null, sessionErr = "";
    try {
      session = await sessionMod.startSession(sessionArgs);
      await session.waitForIdle(3000);     // the script ran to its end: the DLL idles for requests (OBSERVED: commands sent mid-script were served inside `wait turns`, before the fight)
      if (!session.idle) throw new Error("waitForIdle resolved without the idle event");
      execReply = await session.exec("listcmds");
      dumpReply = await session.dump();
      sessionReport = await session.stop();
    } catch (e) { sessionErr = e instanceof Error ? e.message : String(e); }
    test("session against the interactive fake: start -> exec replies with the exec event -> dump replies with units -> stop returns a pass report carrying the exec events", () => {
      assert(!!(!sessionErr && session && execReply && dumpReply && sessionReport), `session flow: ${sessionErr}`);
      if (!session || !execReply || !dumpReply || !sessionReport) return;
      assert(session.pid > 0 && session.runDir.length > 0 && session.pipe.length > 0, JSON.stringify({ pid: session.pid, pipe: session.pipe }));
      eq(execReply.ev, "exec"); eq(execReply.op, "exec"); eq(execReply.ok, true);
      assert(Array.isArray(execReply.lines) && execReply.lines.includes("Executed: listcmds"), JSON.stringify(execReply));
      eq(dumpReply.ev, "units"); eq((dumpReply as { count?: number }).count, 2);
      eq(sessionReport.verdict, "pass", sessionReport.reason);
      const execs = (sessionReport.result as unknown as { execs: { op: string }[] }).execs;
      assert(execs.length >= 2 && execs[0]!.op === "exec", JSON.stringify(execs));
      assert(session.ended, "ended after stop");
    });
    test("session: exec after the game ended rejects with the verdict", async () => {
      let err = "";
      if (!session) throw new Error("no session");
      try { await session.exec("listcmds"); } catch (e) { err = e instanceof Error ? e.message : String(e); }
      assert(/session ended/.test(err), err);
    });
    const shotPlan = script.parseScript("mods: jokers-luck, dev-sandbox\ntimeout: 2s\nhide: false\nshot \"menu\"\nquit\n", { owningMod: "jokers-luck", name: "shot" });
    const captured: { label: string; dir: string }[] = [];
    const shotRun = await run("shot", {}, { plan: shotPlan, capture: (label: string, dir: string) => { captured.push({ label, dir }); const p = join(dir, `shot-${label}.png`); writeFileSync(p, "png"); return p; } });
    test("fake shot -> the runner captures while the game holds and lists the file in artifacts.shots; hidden runs are flagged", () => {
      eq(shotRun.verdict, "pass", shotRun.reason);
      eq(captured.length, 1, "captured exactly once, during the run");
      eq(captured[0]!.label, "menu");
      const shots = (shotRun.artifacts as unknown as { shots?: { label: string; path: string; line: number; hidden: boolean }[] }).shots;
      assert(Array.isArray(shots) && shots.length === 1 && shots[0]!.label === "menu" && shots[0]!.line === 1 && existsSync(shots[0]!.path) && shots[0]!.hidden === false, `artifacts.shots: ${JSON.stringify(shots)}`);
    });
    // T3a finding 2026-10-20: the game runs full-screen, so a screen-region capture shows whatever is in front (the
    // owner's browser, twice). The capture must read the window itself and, when it cannot, say so instead of
    // guessing; the whole-screen fallback is gone.
    const shotMod = await load<typeof import("../src/core/ingame/shot.ts")>("../src/core/ingame/shot.ts") as typeof import("../src/core/ingame/shot.ts");
    test("CAPTURE_PS1 reads the window with PrintWindow (PW_RENDERFULLCONTENT) and never falls back to the whole screen", () => {
      const ps1 = String((shotMod as { CAPTURE_PS1?: string }).CAPTURE_PS1 || "");
      assert(/PrintWindow\(/.test(ps1), "PrintWindow P/Invoke present");
      assert(!/PrimaryScreen/.test(ps1), "no whole-screen fallback");
      assert(/GetForegroundWindow/.test(ps1) && /occluded/.test(ps1), "a covered window is reported as occluded, not captured from the screen");
    });
    const occludedPlan = script.parseScript("mods: jokers-luck\ntimeout: 2s\nhide: false\nshot \"menu\"\nquit\n", { owningMod: "jokers-luck", name: "shot" });
    const occluded = await run("shot", {}, { plan: occludedPlan, capture: () => ({ path: null, note: "occluded" }) });
    test("capture returns {path: null, note} -> artifacts.shots[].path is null with the note, and the pass reason names it", () => {
      const shots = (occluded.artifacts as unknown as { shots?: { path: string | null; note?: string }[] }).shots;
      assert(Array.isArray(shots) && shots.length === 1 && shots[0]!.path === null && shots[0]!.note === "occluded", JSON.stringify(shots));
      eq(occluded.verdict, "pass", occluded.reason);
      assert(/1 not captured \(occluded\)/.test(occluded.reason), occluded.reason);
    });
    const hiddenShotPlan = script.parseScript("mods: jokers-luck\ntimeout: 2s\nshot \"menu\"\nquit\n", { owningMod: "jokers-luck", name: "shot" });
    const hiddenShot = await run("shot", {}, { plan: hiddenShotPlan, capture: (label: string, dir: string) => { const p = join(dir, `shot-${label}.png`); writeFileSync(p, "png"); return p; } });
    test("fake shot with hide: true -> captured anyway but artifacts.shots[].hidden is true and the pass reason says so", () => {
      const shots = (hiddenShot.artifacts as unknown as { shots?: { hidden: boolean }[] }).shots;
      assert(Array.isArray(shots) && shots.length === 1 && shots[0]!.hidden === true, JSON.stringify(shots));
      assert(/hidden/.test(hiddenShot.reason), hiddenShot.reason);
    });

    const enterPlan = script.parseScript("mods: jokers-luck, dev-sandbox\ntimeout: 1s\nenter TacticsTest\nwait turns 1\nexpect units >= 2\nquit\n", { owningMod: "jokers-luck", name: "enter-fight" });
    assert(enterPlan.ok, `enter plan parses: ${JSON.stringify(enterPlan.errors)}`);
    const enterPass = await run("enter-pass", {}, { plan: enterPlan });
    test("fake enter-pass -> pass; result.enter carries the enter event", () => {
      eq(enterPass.verdict, "pass", enterPass.reason);
      const en = (enterPass.result as unknown as { enter?: { ok: boolean; name: string; line: number } }).enter;
      assert(!!en && en.ok && en.name === "TacticsTest" && en.line === 3, `result.enter: ${JSON.stringify(en)}`);
    });
    const enterFailRun = await run("enter-fail", {}, { plan: enterPlan });
    test("fake enter-fail -> verdict fail naming the scene and the harness's detail", () => {
      eq(enterFailRun.verdict, "fail", enterFailRun.reason);
      assert(/enter TacticsTest failed at line 3/.test(enterFailRun.reason) && /no MewDirector/.test(enterFailRun.reason), enterFailRun.reason);
    });
    const enterUnavailRun = await run("enter-unavailable", {}, { plan: enterPlan });
    test("fake enter-unavailable -> harness-error naming enter_unavailable", () => {
      eq(enterUnavailRun.verdict, "harness-error", enterUnavailRun.reason);
      assert(/enter_unavailable|symbol/.test(enterUnavailRun.reason), enterUnavailRun.reason);
    });

    const logPlan = script.parseScript("mods: jokers-luck, dev-sandbox\ntimeout: 1s\ncmd listcmds\nexpect console \"listcmds\"\nexpect log \"ZZ custom marker\"\nquit\n", { owningMod: "jokers-luck", name: "smoke" });
    const logHit = await run("pass", { FAKE_GAME_DEBUG_LINES: "something else|ZZ custom marker here" }, { plan: logPlan });
    test("fake pass with FAKE_GAME_DEBUG_LINES -> expect log matched -> pass, report.logExpects ok, DLL body has the comment placeholder", () => {
      eq(logHit.verdict, "pass", logHit.reason);
      const le = (logHit as unknown as { logExpects?: { ok: boolean; line: number }[] }).logExpects;
      assert(Array.isArray(le) && le.length === 1 && le[0]!.ok && le[0]!.line === 5, `logExpects: ${JSON.stringify(le)}`);
      eq(logHit.result.expects.passed, 1, "the DLL's own count is untouched");
      assert(/1 log expectation/.test(logHit.reason), logHit.reason);
      const copied = readFileSync(logHit.artifacts.script!, "utf8");
      assert(copied.includes("# runner: expect log") && !copied.split("\n").some((l) => l.startsWith("expect log")), copied);
    });
    const logMiss = await run("pass", {}, { plan: logPlan });
    test("fake pass without the line -> fail naming the expect log line and substring", () => {
      eq(logMiss.verdict, "fail", logMiss.reason);
      assert(/expect log failed at line 5/.test(logMiss.reason) && /ZZ custom marker/.test(logMiss.reason), logMiss.reason);
    });

    const pass = await run("pass");
    test("fake pass -> verdict pass, artifacts written, report.json present, header-stripped script", () => {
      eq(pass.verdict, "pass", pass.reason);
      assert(pass.ok, "ok");
      eq(pass.code, 0);
      assert(!!(pass.launch && pass.launch.fake), "fake launch");
      assert(existsSync(pass.artifacts.runDir!), "run dir");
      assert(existsSync(pass.artifacts.report!), "report.json");
      assert(!!(pass.artifacts.resultFile && existsSync(pass.artifacts.resultFile)), "result file");
      const copied = readFileSync(pass.artifacts.script!, "utf8");
      assert(!copied.includes("mods:"), "header stripped from the run-dir script");
      assert(copied.startsWith("cmd listcmds\n"), "directives only");
      eq(pass.result.expects.passed, 1);
      assert(pass.logFindings!.frameworkLog.active, "framework active from the fake log");
      eq(pass.logFindings!.frameworkLog.symbols, 15);
      eq(pass.safety.observedSuffix, "dev");
      assert(pass.safety.saveSuffixOk, "suffix ok");
      assert(!!(pass.safety.saveCheck && pass.safety.saveCheck.unchanged), "save unchanged");
      eq(pass.safety.modPathsObserved.length, 2);
      assert(pass.durationMs >= 0 && typeof pass.startedAt === "string", "timing");
      assert(!!(pass.artifacts.debugLog && existsSync(pass.artifacts.debugLog)), "debug.log copied into the run dir");
      assert(!existsSync(join(runsDir, LOCK_FILE)), "lock released");
    });

    const pass2 = await run("pass");
    test("framework log window: only the newest session is scanned", () => {
      eq(pass2.verdict, "pass", pass2.reason);
      assert(pass2.logFindings!.frameworkLog.windowOffset > 0, "offset recorded");
      eq(pass2.logFindings!.frameworkLog.symbols, 15);
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
      eq(crash.result.crash!.code, "0xC0000005");
    });

    const herr = await run("harness-error");
    test("fake harness-error -> verdict harness-error naming the script error", () => {
      eq(herr.verdict, "harness-error", herr.reason);
      assert(/frobnicate/.test(herr.reason), herr.reason);
    });

    const sigfail = await run("signature-failed");
    test("fake signature-failed (known build) -> harness-error naming the signature", () => {
      eq(sigfail.verdict, "harness-error", sigfail.reason);
      assert(!sigfail.logFindings!.frameworkLog.active, "inactive");
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
      eq(markers.logFindings!.debugLog.findings[0].marker, "NO_STATUS_NAMED");
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
      assert(!!(mutated.safety.saveCheck && !mutated.safety.saveCheck.unchanged), "hash changed");
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

  // ---- adapters: api.ts, MCP tools, CLI (all against the fake game) --------
  console.log("\n# In-game: api / MCP / CLI adapters");
  {
    const FAKE = join(HERE, "fixtures", "fake-game.ts");
    const ROOT = join(FIX, "__tmp_adapters");
    rmSync(ROOT, { recursive: true, force: true });
    const gameDir = join(ROOT, "game");
    const appdata = join(ROOT, "appdata");
    const appLogs = join(appdata, "Glaiel Games", "Mewgenics", "76561198000000009", "logs");
    const runsDir = join(ROOT, "runs");
    mkdirSync(join(gameDir, "mod_logs"), { recursive: true });
    mkdirSync(appLogs, { recursive: true });
        const fakeEnv = (mode: string) => ({
      ...process.env,
      MEWTEST_FAKE_GAME: FAKE,
      FAKE_GAME_MODE: mode,
      FAKE_GAME_APPDATA_LOGS: appLogs,
      MEWGENICS_DIR: gameDir,
      APPDATA: appdata,
      MEWTEST_RESULTS_DIR: runsDir,
    });
    const hasSamples = existsSync(join(MODS_DIR, "jokers-luck", "tests", "smoke.mewtest"));

    const api = await load<typeof import("../src/core/api.ts")>("../src/core/api.ts");
    if ("__error" in api || typeof api.runIngameTest !== "function" || typeof api.listIngameTests !== "function") {
      test("api.ts exports listIngameTests and runIngameTest", () => assert(false, "__error" in api ? api.__error : "missing exports"));
    } else {
      if (hasSamples) {
        test("api.listIngameTests lists jokers-luck/smoke", () => {
          const names = api.listIngameTests().tests.map((t: { mod: string; name: string }) => `${t.mod}/${t.name}`);
          assert(names.includes("jokers-luck/smoke"), names.join(","));
        });
      }
      // a refusal here would surface as a failed verdict assertion, exactly as before
      const inline = (await api.runIngameTest({ mod: "jokers-luck", script: "cmd listcmds\nexpect console \"listcmds\"\nquit\n", env: fakeEnv("pass") })) as IngameReport;
      test("api.runIngameTest inline script against the fake game -> pass", () => {
        eq(inline.ok, true, why(inline));
        eq(inline.verdict, "pass");
        eq(inline.test.inline, true);
        assert(!("events" in inline.result) || inline.result.events.length === 0, "events omitted unless includeEvents");
      });
      if (hasSamples) {
        const named = (await api.runIngameTest({ mod: "jokers-luck", test: "smoke", env: fakeEnv("pass"), includeEvents: true, timeoutMs: 1000 })) as IngameReport;
        test("api.runIngameTest named test with overrides -> pass, events included, timeout override applied", () => {
          eq(named.verdict, "pass", why(named));
          eq(named.test.name, "smoke");
          assert(named.result.events.length > 0, "events included");
          eq(named.plan.timeoutMs, 1000);
        });
      }
      const refusal = (r: Awaited<ReturnType<typeof api.runIngameTest>>) => r as { ok: false; error: string };
      const neither = refusal(await api.runIngameTest({ mod: "jokers-luck", env: fakeEnv("pass") }));
      const both = refusal(await api.runIngameTest({ mod: "jokers-luck", test: "smoke", script: "quit\n", env: fakeEnv("pass") }));
      const missing = refusal(await api.runIngameTest({ mod: "jokers-luck", test: "does-not-exist", env: fakeEnv("pass") }));
      test("api.runIngameTest rejects neither/both of test|script and an unknown test name", () => {
        assert(neither.ok === false && /test|script/.test(neither.error), JSON.stringify(neither.error));
        assert(both.ok === false && /one of/.test(both.error), JSON.stringify(both.error));
        assert(missing.ok === false && /does-not-exist/.test(missing.error), JSON.stringify(missing.error));
      });
    }

    // MCP server round trip (spawned with the fake-game env)
    const serverPath = join(REPO_ROOT, "editor", "src", "mcp", "server.ts");
    const mcp = await (async () => {
      const { spawn } = await import("node:child_process");
      const child = spawn(process.argv[0], [serverPath], { stdio: ["pipe", "pipe", "pipe"], env: fakeEnv("pass") });
      const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
      let id = 1, buf = "";
      child.stdout.on("data", (chunk: Buffer | string) => {
        buf += chunk.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg: { id?: number; error?: unknown; result?: unknown };
          try { msg = JSON.parse(line) as { id?: number; error?: unknown; result?: unknown }; } catch { continue; }
          const p = msg.id !== undefined ? pending.get(msg.id) : undefined;
          if (p && msg.id !== undefined) { pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
        }
      });
      child.stderr.on("data", () => {});
      const req = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
        const myId = id++;
        pending.set(myId, { resolve, reject });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
        setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error(`timeout: ${method}`)); } }, 20000);
      });
      const out: Record<string, any> = {};
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
    test("MCP tools/list returns the 16 editor tools (9 + list_ingame_tests + run_ingame_test + check_game_build + port_bindings + the 3 session tools)", () => {
      assert(!mcp.error, mcp.error);
      const names = mcp.list.tools.map((t: { name: string }) => t.name);
      eq(names.length, 16, names.join(","));
      assert(names.includes("list_ingame_tests") && names.includes("run_ingame_test"), names.join(","));
    });
    test("MCP list_ingame_tests returns the discovered scripts", () => {
      const payload = JSON.parse(mcp.listTests.content[0].text);
      assert(Array.isArray(payload.tests), "tests array");
      if (hasSamples) assert(payload.tests.some((t: { mod: string; name: string }) => t.mod === "jokers-luck" && t.name === "smoke"), "jokers-luck/smoke listed");
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
    const cliPath = join(REPO_ROOT, "editor", "scripts", "ingame.ts");
    const runCli = async (env: Record<string, string | undefined>, argv: string[] = []): Promise<CliRun> => {
      const { spawn } = await import("node:child_process");
      return new Promise<CliRun>((resolve) => {
        const child = spawn(process.argv[0]!, [cliPath, ...argv], { stdio: ["ignore", "pipe", "pipe"], env });
        let out = "", err = "";
        child.stdout.on("data", (c: Buffer | string) => { out += c.toString("utf8"); });
        child.stderr.on("data", (c: Buffer | string) => { err += c.toString("utf8"); });
        child.on("exit", (code) => resolve({ code, out, err }));
        child.on("error", (e) => resolve({ code: null, out, err: String(e) }));
      });
    };
    const skip = (await runCli({ ...fakeEnv("pass"), MEWTEST_SKIP: "1" }));
    test("CLI with MEWTEST_SKIP=1 exits 0 and prints skipped", () => {
      eq(skip.code, 0, skip.err);
      assert(/skipped/i.test(skip.out), skip.out);
    });
    if (hasSamples) {
      const failRun = (await runCli(fakeEnv("fail"), ["jokers-luck", "smoke"]));
      test("CLI with a failing fake run exits 1 and prints FAIL", () => {
        eq(failRun.code, 1, failRun.err);
        assert(/FAIL/.test(failRun.out), failRun.out);
      });
      const passRun = (await runCli(fakeEnv("pass"), ["jokers-luck", "--json"]));
      test("CLI --json with a passing fake run exits 0 and emits JSON reports", () => {
        eq(passRun.code, 0, passRun.err + passRun.out);
        const parsed = JSON.parse(passRun.out);
        assert(Array.isArray(parsed.reports) && parsed.reports.every((r: { verdict: string }) => r.verdict === "pass"), passRun.out.slice(0, 300));
      });
    }
    const usage = (await runCli(fakeEnv("pass"), ["--bogus-flag"]));
    test("CLI usage error exits 2", () => eq(usage.code, 2, usage.out + usage.err));
    rmSync(ROOT, { recursive: true, force: true });
  }

  void resolve;
}

// Standalone entry point: node test/ingame-tests.ts
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let passed = 0, failed = 0;
    const test = (name: string, fn: () => void) => { try { fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${String(e instanceof Error ? e.message : e)}`); } };
    const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };
    const eq = (a: unknown, b: unknown, m?: string) => { if (a !== b) throw new Error(`${m || "not equal"}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); };
  await runIngameTests(test, assert, eq);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
