// Test-name filter for run-tests.ts (TDD target 10): `npm test -- --only <substring>` or `TEST_ONLY=<substring>`
// runs only the tests whose name contains the substring (case-insensitive); everything else is counted as skipped.
// Pure, so the runner can test it.

export interface TestFilter {
  only: string | null;
  matches: (name: string) => boolean;
}

/**
 * @param argv  process.argv.slice(2)
 * @param env   process.env (reads TEST_ONLY)
 */
export function makeTestFilter(argv: string[], env: Record<string, string | undefined>): TestFilter {
  let only: string | null = null;
  const i = argv.indexOf("--only");
  if (i >= 0) {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error("--only needs a substring: npm test -- --only <text>");
    only = v;
  } else if (env.TEST_ONLY) {
    only = env.TEST_ONLY;
  }
  const needle = only === null ? null : only.toLowerCase();
  return {
    only,
    matches: (name) => needle === null || name.toLowerCase().includes(needle),
  };
}
