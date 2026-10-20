#!/usr/bin/env node
// CI policy (docs/tdd-procedure.md "Enforcement"): a change under editor/src/, native/*/src/ or mods/ (outside its
// tests/) must come with a test change, or carry an explicit opt-out marker in the PR body / a commit message:
//
//     [no-test-change: <reason>]
//
// Pure classifier + a thin git CLI; Node built-ins only.
//
//   node scripts/check-test-change.ts --base <sha|ref> --head <sha|ref>   # git diff --name-only base...head
//   node scripts/check-test-change.ts --paths <file>                      # one changed path per line (tests)
//   PR_BODY=<text>                                                         # the PR body (never inlined into a shell)
//
// Exit 0 when the policy holds, 1 when it does not (the message names the files and the marker), 2 on usage errors.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export const NO_TEST_MARKER = "[no-test-change: <reason>]";
const MARKER_RE = /\[no-test-change:\s*([^\]]*?)\s*\]/i;

/** path prefixes that are "source" (need a test change) and "test" (satisfy it) */
const SOURCE_PREFIXES = ["editor/src/", "mods/"];
const SOURCE_RES = [/^native\/[^/]+\/src\//, /^native\/mods\/[^/]+\/src\//];
const TEST_PREFIXES = ["editor/test/", "editor/tests/"];
const TEST_RES = [/^native\/.*\/test\//, /^mods\/[^/]+\/tests\//];

export interface Classification {
  ok: boolean;
  /** source files that need a test change */
  needsTest: string[];
  /** test files in the change */
  testsTouched: string[];
  /** the opt-out reason when the marker was found, else null */
  optOut: string | null;
  reason: string;
}

export function normalizePath(p: string): string {
  let s = p.trim().replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  return s;
}

export function isTestPath(p: string): boolean {
  return TEST_PREFIXES.some((x) => p.startsWith(x)) || TEST_RES.some((re) => re.test(p));
}

export function isSourcePath(p: string): boolean {
  if (isTestPath(p)) return false;
  return SOURCE_PREFIXES.some((x) => p.startsWith(x)) || SOURCE_RES.some((re) => re.test(p));
}

/** Find `[no-test-change: reason]` (case-insensitive) with a non-empty reason. */
export function findOptOut(text: string): string | null {
  const m = MARKER_RE.exec(text || "");
  if (!m) return null;
  const reason = (m[1] || "").trim();
  return reason ? reason : null;
}

/**
 * The policy over a list of changed paths and the PR/commit text.
 * @param paths changed file paths (any separator, optional leading ./)
 * @param text the PR body plus the commit messages, searched for the opt-out marker
 */
export function classifyChange(paths: string[], text: string): Classification {
  const norm = paths.map(normalizePath).filter(Boolean);
  const needsTest = norm.filter(isSourcePath);
  const testsTouched = norm.filter(isTestPath);
  const optOut = findOptOut(text);
  if (needsTest.length === 0) return { ok: true, needsTest, testsTouched, optOut, reason: "no source change under editor/src, native/*/src or mods/" };
  if (testsTouched.length > 0) return { ok: true, needsTest, testsTouched, optOut, reason: `${testsTouched.length} test file(s) changed alongside ${needsTest.length} source file(s)` };
  if (optOut) return { ok: true, needsTest, testsTouched, optOut, reason: `opted out: ${optOut}` };
  return {
    ok: false,
    needsTest,
    testsTouched,
    optOut: null,
    reason:
      `source changed without a test change (docs/tdd-procedure.md):\n` +
      needsTest.map((p) => `  - ${p}`).join("\n") +
      `\nAdd a test under editor/test/, editor/tests/, native/**/test/ or mods/<mod>/tests/, or put ${NO_TEST_MARKER} in the PR body or a commit message.`,
  };
}

function git(args: string[]): string {
  const r = spawnSync("git", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || "").trim()}`);
  return r.stdout;
}

function main(argv: string[]): number {
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const pathsFile = opt("--paths");
  const base = opt("--base");
  const head = opt("--head");
  let paths: string[];
  let text = process.env.PR_BODY || "";
  if (pathsFile) {
    paths = readFileSync(pathsFile, "utf8").split(/\r?\n/);
  } else if (base && head) {
    paths = git(["diff", "--name-only", `${base}...${head}`]).split(/\r?\n/);
    text += "\n" + git(["log", "--format=%B", `${base}..${head}`]);
  } else {
    console.error("usage: check-test-change.ts (--base <ref> --head <ref> | --paths <file>)   [PR_BODY=<text>]");
    return 2;
  }
  const r = classifyChange(paths, text);
  const line = r.ok ? `check-test-change: ok (${r.reason})` : `check-test-change: FAILED — ${r.reason}`;
  console.log(line);
  if (!r.ok && process.env.GITHUB_ACTIONS) console.log(`::error::${r.reason.split("\n")[0]} — ${r.needsTest.join(", ")}`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && /check-test-change\.ts$/.test(process.argv[1].replace(/\\/g, "/"))) {
  process.exitCode = main(process.argv.slice(2));
}
