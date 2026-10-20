#!/usr/bin/env node
// The SWF gate (tier T2): write one gate variant into mods/swf-gate/swfs/ and boot the game
// once through the mewtest harness (mods/swf-gate/tests/boot.mewtest). The verdict answers
// "does an _Append_AbilityIcon donor of this shape survive the post-load merge?"
// (docs/swf-emitter-fix-spec.md §8).
//
//   npm run test:swfgate -- <flat|nested|legacy|probe|missing|control> [--prepare-only] [--no-hide] [--json]
//
// Exit codes: 0 the variant's expected verdict (or skipped), 1 any other verdict, 2 usage error. Only mods/swf-gate/ is
// written; the runner hashes the real save before and after, like every in-game test.

import * as api from "../src/core/api.ts";

function usage(msg: string): never {
  process.stderr.write(`${msg}\nusage: node scripts/swf-gate.ts <${[...Object.keys(api.SWF_GATE_VARIANTS), "control"].join("|")}> [--prepare-only] [--no-hide] [--json]\n`);
  process.exit(2);
}

type GateVariant = "flat" | "nested" | "legacy" | "probe" | "missing" | "control";

interface Opts {
  variant?: string;
  prepareOnly: boolean;
  hide?: boolean;
  json: boolean;
}

/** What prepareSwfGate returns (src/core/art/art-io: a failure, or the written/removed files + the expected verdict). */
interface PreparedGate {
  ok: boolean;
  error?: string;
  note?: string;
  written: string[];
  removed: string[];
  linkage?: string;
  label?: string;
  layout?: string;
  expect: string;
}

const opts: Opts = { prepareOnly: false, json: false };
for (const a of process.argv.slice(2)) {
  if (a === "--json") opts.json = true;
  else if (a === "--prepare-only") opts.prepareOnly = true;
  else if (a === "--no-hide") opts.hide = false;
  else if (a === "--hide") opts.hide = true;
  else if (a.startsWith("-")) usage(`unknown option ${a}`);
  else if (opts.variant) usage("one variant at a time");
  else opts.variant = a;
}
if (!opts.variant) usage("a variant is required");
const variant = opts.variant as GateVariant;

const prep = api.prepareSwfGate({ variant }) as PreparedGate;
if (!prep.ok) {
  process.stderr.write(`failed: ${prep.error}\n`);
  process.exit(2);
}
if (!opts.json) {
  process.stdout.write(`gate variant ${variant}: ${prep.note}\n`);
  for (const w of prep.written) process.stdout.write(`  wrote   ${w}\n`);
  for (const r of prep.removed) process.stdout.write(`  removed ${r}\n`);
  if (prep.linkage) process.stdout.write(`  linkage ${prep.linkage}, label ${prep.label}, layout ${prep.layout}\n`);
  process.stdout.write(`  expected harness verdict: ${prep.expect}\n`);
}
if (opts.prepareOnly) {
  if (opts.json) process.stdout.write(JSON.stringify({ prepared: prep }, null, 2) + "\n");
  process.exit(0);
}

const r = await api.runIngameTest({ mod: api.SWF_GATE_MOD, test: "boot", hide: opts.hide });
if (!("verdict" in r)) {
  process.stderr.write(`launch failed: ${r.error}\n`);
  process.exit(1);
}
const crashReports = r.logFindings && Array.isArray(r.logFindings.crashReports) ? r.logFindings.crashReports : [];
if (opts.json) {
  process.stdout.write(JSON.stringify({ prepared: prep, report: r }, null, 2) + "\n");
} else {
  const skipped = r.verdict === "skipped" || r.verdict === "cannot-run";
  const asExpected = r.verdict === prep.expect;
  const tag = asExpected ? "  ok" : skipped ? "skip" : "FAIL";
  process.stdout.write(`${tag}  swf-gate/boot [${variant}]  ${r.verdict}: ${r.reason}${r.durationMs ? ` (${r.durationMs} ms)` : ""}${asExpected ? "" : ` — expected ${prep.expect}`}\n`);
  if (crashReports.length) process.stdout.write(`      crash reports: ${crashReports.join(", ")}\n`);
  if (r.artifacts && r.artifacts.runDir) process.stdout.write(`      artifacts: ${r.artifacts.runDir}\n`);
}
process.exit(r.verdict === prep.expect || r.verdict === "skipped" || r.verdict === "cannot-run" ? 0 : 1);
