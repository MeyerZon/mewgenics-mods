// T3 looks gallery (editor/src/core/t3-gallery.ts + scripts/t3-gallery.ts, `npm run t3`): the curated list
// editor/t3-looks.json → a self-contained editor/data/t3-gallery/index.html the owner clicks through. Pure helpers
// only — no game, no browser: the list's shape, shot resolution (newest run dir for a `*` segment), the copied
// file names, HTML escaping, the missing-shot card, the summary bar and the exported answers JSON.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";
import { parseLooks, resolveShot, copiedName, renderGallery, buildAnswersExport, summarize, type T3Item, type ResolvedItem } from "../src/core/t3-gallery.ts";

const EDITOR = join(dirname(fileURLToPath(import.meta.url)), "..");

const item = (over: Partial<T3Item> = {}): T3Item => ({
  id: "pr74-tomtom", pr: 74, question: "Does the cat look like TomTom?", shots: ["ingame-runs/*-_artprobe-render-cat-append/shot-rig-1.png"],
  regenerate: "cd editor && npm run test:artprobe -- --cat-append", status: "open", ...over,
});

export function runT3GalleryTests(test: TestFn, assert: AssertFn, eq: EqFn): void {
  console.log("\n# T3 looks gallery (t3-looks.json → editor/data/t3-gallery/index.html)");

  test("parseLooks: a well-formed list parses with no errors", () => {
    const r = parseLooks(JSON.stringify([item(), item({ id: "pr59-ruffle", pr: 59, shots: [] })]));
    eq(r.errors, []);
    eq(r.items.length, 2);
  });

  test("parseLooks: duplicate ids, a missing question, a non-open/done status and an escaping shot path are errors", () => {
    const r = parseLooks(JSON.stringify([item(), item(), item({ id: "b", question: "" }), item({ id: "c", status: "maybe" as "open" }), item({ id: "d", shots: ["../secret.png"] }), item({ id: "e", shots: ["C:/x.png"] })]));
    assert(r.errors.some((e) => /duplicate id "pr74-tomtom"/.test(e)), r.errors.join(" | "));
    assert(r.errors.some((e) => /"b".*question/.test(e)), r.errors.join(" | "));
    assert(r.errors.some((e) => /"c".*status/.test(e)), r.errors.join(" | "));
    assert(r.errors.some((e) => /"d".*shot/.test(e)), r.errors.join(" | "));
    assert(r.errors.some((e) => /"e".*shot/.test(e)), r.errors.join(" | "));
  });

  test("parseLooks: not an array is one error, not a throw", () => {
    const r = parseLooks("{}");
    eq(r.items, []);
    eq(r.errors.length, 1);
  });

  test("resolveShot: an exact path that exists resolves to itself; one that does not is null", () => {
    const fs = { exists: (p: string) => p === "glow-shots/after.png", list: (_d: string) => [] as string[] };
    eq(resolveShot("glow-shots/after.png", fs), "glow-shots/after.png");
    eq(resolveShot("glow-shots/before.png", fs), null);
  });

  test("resolveShot: a `*` segment picks the newest (lexicographically last) run dir that holds the file", () => {
    const have = new Set(["ingame-runs/20261020-1-_artprobe-render-probe/shot-probe-1.png", "ingame-runs/20261021-1-_artprobe-render-probe/shot-probe-1.png"]);
    const fs = {
      exists: (p: string) => have.has(p),
      list: (d: string) => d === "ingame-runs" ? ["20261020-1-_artprobe-render-probe", "20261021-1-_artprobe-render-probe", "20261022-1-_artprobe-render-probe", "20261023-1-_artprobe-render-cat"] : [],
    };
    // 20261022 matches the pattern but has no shot (a crashed run) → the newest one that has it
    eq(resolveShot("ingame-runs/*-_artprobe-render-probe/shot-probe-1.png", fs), "ingame-runs/20261021-1-_artprobe-render-probe/shot-probe-1.png");
    eq(resolveShot("ingame-runs/*-dev-sandbox-unit-glow/shot-glow.png", fs), null);
  });

  test("copiedName: flattens the data-relative path into one file name under shots/ (run stamp kept, no separators)", () => {
    eq(copiedName("ingame-runs/20261022-063637-_artprobe-render-cat-append/shot-rig-1.png"), "20261022-063637-_artprobe-render-cat-append__shot-rig-1.png");
    eq(copiedName("glow-shots/after.png"), "glow-shots__after.png");
  });

  const resolved: ResolvedItem[] = [
    { ...item({ id: "a<b", question: `Is <script>alert("x")</script> & "this" escaped?` }), found: [{ pattern: "glow-shots/after.png", file: "glow-shots__after.png" }], missing: [] },
    { ...item({ id: "pr86-glow", pr: 86, question: "Magenta band?", shots: ["ingame-runs/*-dev-sandbox-unit-glow/shot-glow.png"], regenerate: "cd editor && npm run test:unitglow" }), found: [], missing: ["ingame-runs/*-dev-sandbox-unit-glow/shot-glow.png"] },
    { ...item({ id: "pr59-ruffle", pr: 59, question: "Ruffle useful?", shots: [], regenerate: "cd editor && npm run web — Art mode → Ruffle" }), found: [], missing: [] },
  ];
  const html = renderGallery(resolved, { generatedAt: "2026-10-22T12:00:00Z", repoUrl: "https://github.com/MeyerZon/mewgenics-mods" });

  test("renderGallery: question text and ids are HTML-escaped (no raw <script> from data)", () => {
    assert(html.includes("Is &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &quot;this&quot; escaped?"), "escaped question");
    assert(!html.includes(`<script>alert("x")`), "raw script from data must not appear");
    // the embedded items JSON must not be able to close the page's <script>
    eq((html.match(/<\/script>/g) || []).length, (html.match(/<script[ >]/g) || []).length, "every </script> closes one of the page's own scripts");
    assert(!html.includes(`"a<b"`), "ids inside the embedded JSON have < escaped");
  });

  test("renderGallery: a found shot is an <img> with a relative src under shots/ and the PR is a link", () => {
    assert(html.includes(`src="shots/glow-shots__after.png"`), "img src");
    assert(html.includes(`href="https://github.com/MeyerZon/mewgenics-mods/pull/86"`), "PR link");
  });

  test("renderGallery: a missing shot renders a 'needs re-run: <command>' card", () => {
    assert(html.includes("needs re-run: cd editor &amp;&amp; npm run test:unitglow"), "needs re-run line");
    assert(/data-state="rerun"/.test(html), "the card is marked as a re-run card");
  });

  test("renderGallery: an item with no shots is a hands-on card naming how to check it", () => {
    assert(/data-state="hands-on"/.test(html), "hands-on card");
    assert(html.includes("cd editor &amp;&amp; npm run web — Art mode → Ruffle"), "hands-on how-to shown");
  });

  test("renderGallery: each card has Yes / No / Not sure controls, an export button, a summary bar and localStorage", () => {
    for (const v of ["yes", "no", "unsure"]) assert(html.includes(`data-answer="${v}"`), `answer ${v}`);
    assert(html.includes("Not sure"), "Not sure label");
    assert(html.includes(`id="export"`), "export button");
    assert(html.includes(`id="summary"`), "summary bar");
    assert(html.includes("localStorage"), "persists in localStorage");
    assert(/<title>T3 Looks<\/title>/.test(html), "title");
  });

  test("summarize: counts items with shots / needing a re-run / hands-on", () => {
    eq(summarize(resolved), { total: 3, withShots: 1, needsRerun: 1, handsOn: 1 });
  });

  const exp = buildAnswersExport([{ id: "a", pr: 1, question: "Q1?" }, { id: "b", pr: 2, question: "Q2?" }, { id: "c", pr: 3, question: "Q3?" }], { a: "yes", b: "unsure", zz: "no" }, "2026-10-22T12:00:00Z");

  test("buildAnswersExport: the answers JSON shape (kind, version, exportedAt, counts, one row per item; unknown ids dropped)", () => {
    eq(exp, {
      kind: "mewgenics-t3-answers", version: 1, exportedAt: "2026-10-22T12:00:00Z",
      counts: { yes: 1, no: 0, unsure: 1, unanswered: 1 },
      answers: [{ id: "a", pr: 1, question: "Q1?", answer: "yes" }, { id: "b", pr: 2, question: "Q2?", answer: "unsure" }, { id: "c", pr: 3, question: "Q3?", answer: null }],
    });
  });

  test("renderGallery: the page's export runs the same buildAnswersExport (its source is embedded, not re-written)", () => {
    const m = /function buildAnswersExport\([^]*?\n\}/.exec(html);
    assert(!!m, "buildAnswersExport embedded in the page script");
    const fn = new Function(`${m![0]}; return buildAnswersExport;`)() as typeof buildAnswersExport;
    eq(fn([{ id: "a", pr: 1, question: "Q1?" }, { id: "b", pr: 2, question: "Q2?" }, { id: "c", pr: 3, question: "Q3?" }], { a: "yes", b: "unsure", zz: "no" }, "2026-10-22T12:00:00Z"), exp);
  });

  test("editor/t3-looks.json (tracked) parses with no errors, every item open or done, and `npm run t3` is wired", () => {
    const p = join(EDITOR, "t3-looks.json");
    assert(existsSync(p), "editor/t3-looks.json exists");
    const r = parseLooks(readFileSync(p, "utf8"));
    eq(r.errors, []);
    assert(r.items.length >= 10, `expected the collected T3 items, got ${r.items.length}`);
    const pkg = JSON.parse(readFileSync(join(EDITOR, "package.json"), "utf8"));
    eq(pkg.scripts.t3, "node scripts/t3-gallery.ts");
    assert(existsSync(join(EDITOR, "scripts", "t3-gallery.ts")), "scripts/t3-gallery.ts exists");
  });
}
