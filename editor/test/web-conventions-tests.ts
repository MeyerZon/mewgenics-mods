// The web UI's conventions, checked on the source text (docs/editor-ts-react-plan.md "UI primitives and
// conventions"). Each rule counts its violations per file under web/src; a file fails when its count EXCEEDS the
// count in test/fixtures/web-conventions-allow.json, and an allowance above the real count fails too, so the list
// only ever shrinks (later PRs take it to empty). Node built-ins only.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = join(HERE, "..", "web", "src");
const ALLOW_FILE = join(HERE, "fixtures", "web-conventions-allow.json");

export type RuleName = "store-set-in-view" | "window-confirm" | "clickable-span-div" | "uncontrolled-default" | "effect-deps" | "index-key";
export type Counts = Record<string, number>;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const count = (re: RegExp, text: string): number => (text.match(re) || []).length;

/** Skip a quoted string / template / comment starting at i; returns the index after it (or i when none starts). */
function skipLiteral(src: string, i: number): number {
  const c = src[i];
  if (c === "/" && src[i + 1] === "/") {
    const nl = src.indexOf("\n", i);
    return nl < 0 ? src.length : nl;
  }
  if (c === "/" && src[i + 1] === "*") {
    const end = src.indexOf("*/", i + 2);
    return end < 0 ? src.length : end + 2;
  }
  if (c === '"' || c === "'" || c === "`") {
    let j = i + 1;
    while (j < src.length && src[j] !== c) {
      if (src[j] === "\\") j++;
      if (c !== "`" && src[j] === "\n") break; // an apostrophe in JSX text, not a string
      j++;
    }
    return j + 1;
  }
  return i;
}

/** Number of `useEffect(` calls whose argument list does not end in a dependency array `[…]`. */
export function effectsWithoutDeps(src: string): number {
  let missing = 0;
  const re = /\buseEffect\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < src.length && depth > 0) {
      const j = skipLiteral(src, i);
      if (j !== i) { i = j; continue; }
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
      i++;
    }
    const args = src.slice(m.index + m[0].length, i - 1).trimEnd().replace(/,$/, "").trimEnd();
    if (!args.endsWith("]")) missing++;
  }
  return missing;
}

/** Violations per rule per file (paths relative to web/src, forward slashes). */
export function scanConventions(root = WEB_SRC): Record<RuleName, Counts> {
  const res: Record<RuleName, Counts> = {
    "store-set-in-view": {},
    "window-confirm": {},
    "clickable-span-div": {},
    "uncontrolled-default": {},
    "effect-deps": {},
    "index-key": {},
  };
  for (const abs of walk(root)) {
    const rel = relative(root, abs).split(sep).join("/");
    const src = readFileSync(abs, "utf8");
    const put = (rule: RuleName, n: number) => { if (n > 0) res[rule][rel] = n; };
    // (a) views write through actions, not the stores: no S./A./R.set( in components/, art/, rooms/ (*-state.ts are the actions)
    if (/^(components|art|rooms)\//.test(rel) && !/-state\.ts$/.test(rel)) put("store-set-in-view", count(/\b[SAR]\.set\(/g, src));
    // (b) confirmations are actions' business
    if (rel !== "actions.ts") put("window-confirm", count(/\bwindow\.confirm\b/g, src));
    // (c) a clickable span/div is not a button (the scrim click-outside and the stopPropagation shells are exempt)
    put("clickable-span-div", src.split("\n").filter((l) => !/stopPropagation|className="scrim/.test(l)).reduce((n, l) => n + count(/<(span|div)\b[^>]*onClick/g, l), 0));
    // (d) controlled inputs only (Bits.tsx's commit-on-change inputs are the one uncontrolled pattern)
    if (rel !== "art/Bits.tsx") put("uncontrolled-default", count(/\bdefault(Value|Checked)\b/g, src));
    // (e) every effect names its dependencies
    put("effect-deps", effectsWithoutDeps(src));
    // (f) list keys are identities, not positions
    put("index-key", count(/key=\{(i|index|idx)\}/g, src));
  }
  return res;
}

export function runWebConventionsTests(test: TestFn, assert: AssertFn, eq: EqFn): void {
  console.log("\n# web conventions (source-text rules over web/src; allow-list only shrinks)");
  test("effectsWithoutDeps: counts effects with no trailing [deps], skipping parens in strings and comments", () => {
    eq(effectsWithoutDeps('useEffect(() => { f(")"); }, [a]); useEffect(() => { g(); }); useEffect(() => h(), []);'), 1);
    eq(effectsWithoutDeps("useEffect(() => {\n  // a ) in a comment\n  x();\n}, [x, y],\n);"), 0);
  });
  let allow: Record<string, Counts> = {};
  try {
    allow = JSON.parse(readFileSync(ALLOW_FILE, "utf8")) as Record<string, Counts>;
  } catch (e) {
    test("test/fixtures/web-conventions-allow.json parses", () => assert(false, String(e)));
    return;
  }
  const found = scanConventions();
  const totals: string[] = [];
  for (const rule of Object.keys(found) as RuleName[]) {
    const have = found[rule];
    const ok = allow[rule] || {};
    const total = Object.values(have).reduce((a, b) => a + b, 0);
    const allowed = Object.values(ok).reduce((a, b) => a + b, 0);
    totals.push(`${rule}=${total}/${allowed}`);
    test(`web convention ${rule}: no file has more violations than the allow-list`, () => {
      const over = Object.entries(have).filter(([f, n]) => n > (ok[f] || 0)).map(([f, n]) => `${f}: ${n} > ${ok[f] || 0}`);
      assert(over.length === 0, over.join("; "));
    });
    test(`web convention ${rule}: the allow-list is not above the real count (it only shrinks — lower it)`, () => {
      const stale = Object.entries(ok).filter(([f, n]) => n > (have[f] || 0)).map(([f, n]) => `${f}: allowed ${n}, found ${have[f] || 0}`);
      assert(stale.length === 0, stale.join("; "));
    });
  }
  console.log(`  web conventions (found/allowed): ${totals.join(" ")}`);
}

// `node test/web-conventions-tests.ts --print` prints the current counts as an allow-list (used once to seed it).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--print")) {
  console.log(JSON.stringify(scanConventions(), null, 2));
}
