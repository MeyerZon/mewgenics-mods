#!/usr/bin/env node
// CLI for the in-game test harness (tier T2): runs mods/<mod>/tests/*.mewtest
// scripts one game instance at a time and prints a summary.
//
//   npm run test:ingame -- [<mod> [<test>]] [--timeout <ms>] [--no-hide] [--clean] [--no-savecheck] [--json]
//
// Exit codes: 0 all passed (or all skipped), 1 any failure, 2 usage error.
// Skips (exit 0) with one message when the game, Steam or the harness DLL is
// absent or MEWTEST_SKIP=1. See docs/ingame-testing.md.

import * as api from "../src/core/api.mjs";

/** @param {string} msg */
function usage(msg) {
  process.stderr.write(`${msg}\nusage: node scripts/ingame.mjs [<mod> [<test>]] [--timeout <ms>] [--no-hide] [--clean] [--no-savecheck] [--json]\n`);
  process.exit(2);
}

/** @type {{ mod?: string, test?: string, timeoutMs?: number, hide?: boolean, clean?: boolean, saveCheck?: boolean, json: boolean }} */
const opts = { json: false };
/** @type {string[]} */
const positional = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--json") opts.json = true;
  else if (a === "--no-hide") opts.hide = false;
  else if (a === "--hide") opts.hide = true;
  else if (a === "--clean") opts.clean = true;
  else if (a === "--no-savecheck") opts.saveCheck = false;
  else if (a === "--timeout") {
    const v = Number(argv[++i]);
    if (!Number.isFinite(v) || v <= 0) usage("--timeout needs a positive number of milliseconds");
    opts.timeoutMs = v;
  } else if (a.startsWith("-")) usage(`unknown option ${a}`);
  else positional.push(a);
}
if (positional.length > 2) usage("too many positional arguments");
opts.mod = positional[0];
opts.test = positional[1];

const listing = api.listIngameTests(opts.mod);
let tests = listing.tests;
if (opts.test) tests = tests.filter((t) => t.name === opts.test);
if (tests.length === 0) {
  if (opts.json) process.stdout.write(JSON.stringify({ reports: [], summary: { total: 0, passed: 0, failed: 0, skipped: 0 } }) + "\n");
  else process.stdout.write(`no in-game tests found${opts.mod ? ` for ${opts.mod}${opts.test ? "/" + opts.test : ""}` : ""} (mods/<mod>/tests/*.mewtest)\n`);
  process.exit(opts.test ? 2 : 0);
}

/** @type {any[]} */
const reports = [];
let passed = 0, failed = 0, skipped = 0;
for (const t of tests) {
  const label = `${t.mod}/${t.name}`;
  if (!t.plan.ok) {
    failed++;
    reports.push({ test: { mod: t.mod, name: t.name }, verdict: "launch-error", reason: t.plan.errors.map((e) => `line ${e.line}: ${e.message}`).join("; ") });
    if (!opts.json) process.stdout.write(`FAIL  ${label}  (script errors: ${t.plan.errors.map((e) => `line ${e.line}: ${e.message}`).join("; ")})\n`);
    continue;
  }
  const r = await api.runIngameTest({ mod: t.mod, test: t.name, timeoutMs: opts.timeoutMs, hide: opts.hide, clean: opts.clean, saveCheck: opts.saveCheck });
  if (!("verdict" in r)) {
    failed++;
    reports.push({ test: { mod: t.mod, name: t.name }, verdict: "launch-error", reason: r.error });
    if (!opts.json) process.stdout.write(`FAIL  ${label}  ${r.error}\n`);
    continue;
  }
  const report = r;
  reports.push(report);
  if (report.verdict === "pass") {
    passed++;
    if (!opts.json) process.stdout.write(`  ok  ${label}  (${report.durationMs} ms)\n`);
  } else if (report.verdict === "skipped" || report.verdict === "cannot-run") {
    skipped++;
    if (!opts.json) process.stdout.write(`      ${label}  (skipped: ${report.reason})\n`);
    // a machine-level reason applies to every test: say it once and stop
    if (report.verdict === "skipped" || /not found|Steam|in progress/.test(report.reason)) {
      if (!opts.json) process.stdout.write(`skipping the remaining ${tests.length - reports.length} test(s) for the same reason\n`);
      skipped += tests.length - reports.length;
      break;
    }
  } else {
    failed++;
    if (!opts.json) process.stdout.write(`FAIL  ${label}  [${report.verdict}] ${report.reason}\n      artifacts: ${report.artifacts.runDir || "-"}\n`);
  }
}

const summary = { total: tests.length, passed, failed, skipped };
if (opts.json) process.stdout.write(JSON.stringify({ reports, summary }, null, 2) + "\n");
else process.stdout.write(`\nin-game: ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
process.exit(failed > 0 ? 1 : 0);
