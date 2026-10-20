// CI policy: "a change under editor/src, native/*/src or mods/ comes with a test change"
// (docs/tdd-procedure.md "Enforcement"; TODO target 11). The classifier is a pure function
// over the changed paths + the PR/commit text; the CLI wraps it over `git diff --name-only`.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "scripts", "check-test-change.ts");

export async function runCiTests(test: TestFn, assert: AssertFn, eq: EqFn): Promise<void> {
  let mod: typeof import("../scripts/check-test-change.ts") | null = null;
  try { mod = await import("../scripts/check-test-change.ts"); } catch (e) { test("check-test-change.ts loads", () => assert(false, String(e instanceof Error ? e.message : e))); }
  if (!mod) return;
  const { classifyChange, NO_TEST_MARKER } = mod;

  test("check-test-change: editor/src change without a test path fails and names the file", () => {
    const r = classifyChange(["editor/src/core/api.ts", "docs/x.md"], "");
    assert(!r.ok, "not ok");
    eq(r.needsTest.join(","), "editor/src/core/api.ts");
    eq(r.testsTouched.length, 0);
    assert(/editor\/src\/core\/api\.ts/.test(r.reason) && r.reason.includes(NO_TEST_MARKER), r.reason);
  });
  test("check-test-change: editor/src + editor/test, editor/tests/e2e or a fixture under editor/test/fixtures passes", () => {
    for (const t of ["editor/test/web-tests.ts", "editor/tests/e2e/data-mode.spec.ts", "editor/test/fixtures/validator/mods/x/data/a.gon.append"]) {
      const r = classifyChange(["editor/src/core/api.ts", t], "");
      assert(r.ok, `${t}: ${r.reason}`);
      eq(r.testsTouched.join(","), t);
    }
  });
  test("check-test-change: native/framework/src and native/mods/x/src are source; native/**/test satisfies", () => {
    const bad = classifyChange(["native/framework/src/framework.c", "native/mods/test-harness/src/mewtest.c"], "");
    eq(bad.needsTest.join(","), "native/framework/src/framework.c,native/mods/test-harness/src/mewtest.c");
    assert(!bad.ok, "not ok");
    assert(classifyChange(["native/framework/src/framework.c", "native/framework/test/test_build.c"], "").ok, "framework test");
    assert(classifyChange(["native/mods/test-harness/src/mt_runner.c", "native/mods/test-harness/test/test_mewtest.c"], "").ok, "harness test");
  });
  test("check-test-change: mods/<m>/data is source; mods/<m>/tests/*.mewtest or an editor validator fixture satisfies", () => {
    const bad = classifyChange(["mods/jokers-luck/data/abilities/fighter_abilities.gon.append"], "");
    assert(!bad.ok && bad.needsTest.length === 1, bad.reason);
    assert(classifyChange(["mods/jokers-luck/data/x.gon.append", "mods/jokers-luck/tests/smoke.mewtest"], "").ok, "mewtest");
    assert(classifyChange(["mods/jokers-luck/data/x.gon.append", "editor/test/fixtures/validator/mods/clean/data/z.gon.append"], "").ok, "fixture");
    const onlyTests = classifyChange(["mods/jokers-luck/tests/smoke.mewtest"], "");
    assert(onlyTests.ok && onlyTests.needsTest.length === 0, "a test-only change under mods/ needs nothing");
  });
  test("check-test-change: docs-only, bindings-only and tools-only changes pass vacuously", () => {
    for (const paths of [["docs/engine-map.md", "TODO.md", "CLAUDE.md"], ["bindings/25143593.json"], ["tools/bindings/harvest.ts", "tools/gpak.py"], [] as string[]]) {
      const r = classifyChange(paths, "");
      assert(r.ok && r.needsTest.length === 0, `${paths.join(",") || "(none)"}: ${r.reason}`);
    }
  });
  test("check-test-change: [no-test-change: reason] in the body or a commit message opts out; an empty reason does not", () => {
    const src = ["editor/src/core/api.ts"];
    const a = classifyChange(src, "Fix typo.\n\n[no-test-change: comment-only edit]\n");
    assert(a.ok, a.reason);
    eq(a.optOut, "comment-only edit");
    const b = classifyChange(src, "[NO-TEST-CHANGE: Case Insensitive]");
    assert(b.ok && b.optOut === "Case Insensitive", b.reason);
    const c = classifyChange(src, "[no-test-change: ]");
    assert(!c.ok && c.optOut === null, "empty reason is not an opt-out");
    const d = classifyChange(src, "[no-test-change]");
    assert(!d.ok, "marker without a reason is not an opt-out");
  });
  test("check-test-change: paths are normalised (backslashes, leading ./)", () => {
    const r = classifyChange(["editor\\src\\core\\api.ts", "./editor/test/x.ts"], "");
    assert(r.ok, r.reason);
    eq(r.needsTest.join(","), "editor/src/core/api.ts");
    eq(r.testsTouched.join(","), "editor/test/x.ts");
  });
  test("check-test-change CLI: --paths file + PR_BODY -> exit 1 with the file list; exit 0 once a test path is added or the marker is given", () => {
    const dir = mkdtempSync(join(tmpdir(), "mewged-ci-"));
    const list = join(dir, "paths.txt");
    writeFileSync(list, "editor/src/core/api.ts\ndocs/x.md\n");
    const run = (body: string) => spawnSync(process.argv[0]!, [SCRIPT, "--paths", list], { encoding: "utf8", env: { ...process.env, PR_BODY: body, GITHUB_ACTIONS: "" } });
    const bad = run("");
    eq(bad.status, 1, `exit: ${bad.stdout}${bad.stderr}`);
    assert(/editor\/src\/core\/api\.ts/.test(bad.stdout + bad.stderr) && /no-test-change/.test(bad.stdout + bad.stderr), bad.stdout + bad.stderr);
    const opt = run("[no-test-change: fixture-only]");
    eq(opt.status, 0, `opt-out exit: ${opt.stdout}${opt.stderr}`);
    writeFileSync(list, "editor/src/core/api.ts\neditor/test/ci-tests.ts\n");
    const good = run("");
    eq(good.status, 0, `exit: ${good.stdout}${good.stderr}`);
  });
}
