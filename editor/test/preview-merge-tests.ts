// Merge preview against an injected base root (T0; TODO target 7's follow-up). The preview must resolve the base
// file under the extracted data root it is given (default EXTRACTED_DATA, i.e. MEWGENICS_EXTRACTED_DATA), never
// under a hard-coded <repo>/.extracted.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { previewMerge } from "../src/core/preview-merge.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

export function runPreviewMergeTests(test: TestFn, assert: AssertFn, eq: EqFn): void {
  /** a synthetic `.extracted/data` tree with one character file */
  const synthetic = (): string => {
    const root = mkdtempSync(join(tmpdir(), "mewged-preview-base-"));
    mkdirSync(join(root, "characters"), { recursive: true });
    writeFileSync(join(root, "characters", "foo.gon"), "Foo {\n\tstats {\n\t\tspeed 5\n\t}\n}\nBar {\n\tx 1\n}\n");
    return root;
  };
  test("previewMerge resolves the base under the injected extracted root: Foo changed, Bar untouched", () => {
    const p = previewMerge("_not-a-mod", "data/characters/foo.gon.merge", {
      overrideText: "Foo {\n\tstats {\n\t\tspeed 9\n\t}\n}\n",
      extractedData: synthetic(),
    });
    assert(p.ok, `preview: ${JSON.stringify(p)}`);
    if (!p.ok || p.kind !== "gon") throw new Error("gon preview expected");
    eq(p.baseFile, "data/characters/foo.gon");
    assert(p.baseExists, "the synthetic base was found");
    eq(p.touched.map((t) => `${t.key}:${t.status}`).join(","), "Foo:changed");
    assert(/speed\s+9\b/.test(p.touched[0]!.effective || ""), p.touched[0]!.effective || "");
    eq(p.baseEntryCount, 2);
    eq(p.effectiveEntryCount, 2);
  });
  test("previewMerge with an empty extracted root reports the base absent (no fallback to <repo>/.extracted)", () => {
    const p = previewMerge("_not-a-mod", "data/characters/enemies.gon.merge", {
      overrideText: "Rat {\n\tx 1\n}\n",
      extractedData: mkdtempSync(join(tmpdir(), "mewged-preview-empty-")),
    });
    assert(p.ok, `preview: ${JSON.stringify(p)}`);
    if (!p.ok || p.kind !== "gon") throw new Error("gon preview expected");
    assert(!p.baseExists, "enemies.gon must not be read from the repo's own .extracted");
    eq(p.touched.map((t) => `${t.key}:${t.status}`).join(","), "Rat:added");
    eq(p.baseEntryCount, 0);
  });
}
