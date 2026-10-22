#!/usr/bin/env node
// Build the tracked editor/component-schema.json from the RE sessions' fragments.
//
//   npm run build:component-schema            merge + vanilla cross-check + write
//   npm run build:component-schema -- --check regenerate in memory and fail if the tracked file differs
//
// Inputs (all git-ignored, read-only):
//   $MEWGENICS_ANALYSIS_DIR/component-schema-<tag>.json   one fragment per Ghidra session (shape: docs/data-mods.md
//                                                         "Component keys"; checked by validateFragment)
//   $MEWGENICS_ANALYSIS_DIR/compmap/dispatch-names.json   optional {names:[...]}: effect names the by-name dispatch
//                                                         chains accept that are not glaiel:: classes (HealthGain …)
//   $MEWGENICS_EXTRACTED_DATA                             vanilla data for the cross-check (skipped when absent:
//                                                         then nothing is opened/demoted and the run says so)
// Node built-ins only.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ANALYSIS_DIR, EXTRACTED_DATA } from "../src/core/repo.ts";
import { SCHEMA_PATH, resolveComponent } from "../src/core/component-schema.ts";
import { validateFragment, mergeFragments, surveyVanilla } from "../src/core/component-schema-build.ts";
import type { Fragment } from "../src/core/component-schema-build.ts";
import { componentNameSet } from "../src/core/components.ts";

const args = process.argv.slice(2);
const check = args.includes("--check");
const argVal = (flag: string): string | undefined => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const fragDir = argVal("--fragments") ?? ANALYSIS_DIR;
const out = argVal("--out") ?? SCHEMA_PATH;
const build = argVal("--build") ?? "25143593";

if (!existsSync(fragDir)) {
  console.error(`no fragment dir ${fragDir} (set MEWGENICS_ANALYSIS_DIR or --fragments)`);
  process.exit(2);
}
const files = readdirSync(fragDir).filter((f) => /^component-schema-[A-Za-z0-9_-]+\.json$/.test(f)).sort();
if (files.length === 0) {
  console.error(`no component-schema-<tag>.json fragments in ${fragDir}`);
  process.exit(2);
}
const errors: string[] = [];
const frags: Fragment[] = [];
for (const f of files) {
  let j: unknown;
  try {
    j = JSON.parse(readFileSync(join(fragDir, f), "utf8"));
  } catch (e) {
    errors.push(`${f}: not valid JSON (${String(e instanceof Error ? e.message : e)})`);
    continue;
  }
  const errs = validateFragment(j, f);
  if (errs.length) errors.push(...errs);
  else frags.push(j as Fragment);
}
if (errors.length) {
  console.error(`${errors.length} fragment shape error(s):\n  ${errors.slice(0, 60).join("\n  ")}`);
  process.exit(1);
}

const dispatchFile = join(fragDir, "compmap", "dispatch-names.json");
const effectNames: string[] = existsSync(dispatchFile) ? (JSON.parse(readFileSync(dispatchFile, "utf8")) as { names: string[] }).names : [];
const comps = componentNameSet();
const effect = new Set(effectNames);
const haveVanilla = existsSync(EXTRACTED_DATA) && comps.size > 0;
// a first merge (no vanilla) tells which components take an arbitrary child map (children "any"), so the survey
// skips their map keys exactly as the validator does (a FormChanger form named Rain is not a Rain block)
const pre = mergeFragments(frags, { build });
const isMap = (n: string): boolean => resolveComponent(pre.schema, n)?.children === "any";
const vanilla = haveVanilla ? surveyVanilla(EXTRACTED_DATA, (n) => comps.has(n), (n) => effect.has(n), isMap) : undefined;
if (!haveVanilla) console.log(`(vanilla cross-check skipped: ${existsSync(EXTRACTED_DATA) ? "no component-name cache" : `no ${EXTRACTED_DATA}`})`);

const m = mergeFragments(frags, { build, vanilla, effectNames: effectNames.filter((n) => !comps.has(n)) });
if (m.errors.length) {
  console.error(`${m.errors.length} merge error(s):\n  ${m.errors.slice(0, 60).join("\n  ")}`);
  process.exit(1);
}
const text = JSON.stringify(m.schema, null, 1) + "\n";
const c = m.schema.coverage!;
const uncovered = [...comps].filter((n) => !(n in m.schema.components)).length;
console.log(`fragments: ${files.join(", ")}`);
console.log(`components ${c.components} (of ${comps.size} glaiel:: names; ${uncovered} not in any fragment): mapped ${c.mapped}, no-keys ${c.noKeys}, mechanical ${c.mechanical}, unresolved ${c.unresolved}; open ${c.open}`);
console.log(`keys ${c.keys}: observed ${c.keysObserved}, inferred ${c.keysInferred}; vanilla: ${c.vanillaComponents} components with object blocks, literal keys found ${c.vanillaKeysFound}/${c.vanillaKeys}, unread (vanilla-only, ignored by the game) ${c.vanillaKeysUnread} (+${c.vanillaMapKeys} map keys under children:any components); vanilla object-form components closed ${c.vanillaClosed}, open ${c.vanillaOpen}`);
console.log(`vanilla cross-check adjustments: ${m.adjustments.length}${m.adjustments.length ? `\n  ${m.adjustments.slice(0, 25).join("\n  ")}${m.adjustments.length > 25 ? "\n  …" : ""}` : ""}`);
if (check) {
  const cur = existsSync(out) ? readFileSync(out, "utf8").replace(/\r\n/g, "\n") : "";
  if (cur !== text) {
    console.error(`${out} is stale: run npm run build:component-schema`);
    process.exit(1);
  }
  console.log(`${out} is up to date`);
} else {
  writeFileSync(out, text);
  console.log(`wrote ${out}`);
}
