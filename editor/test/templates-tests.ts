// new_from_template (editor/src/core/templates.ts): the `glowing-character` template scaffolds a character variant
// that glows from the data layer (a StatusOnSpawnIn FwGlow_<colour> passive, docs/data-mods.md "Asking for a unit glow
// from data") plus the status's keyword tooltip and its 12-column text rows. The colour is checked by the same rule
// the validator's invalid-glow-name uses (the glow pattern entry of editor/registered-names.json).
// All runs here are dry runs (nothing is written under mods/); the T1 check validates the scaffold in a temp folder.
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";
import { newFromTemplate, type TemplateResult } from "../src/core/templates.ts";
import { validateMod } from "../src/core/validate/validator.ts";
import { parseCsv } from "../src/core/overlay/csv.ts";
import { LOC_COLUMNS } from "../src/core/base-data.ts";
import { EXTRACTED_DATA } from "../src/core/repo.ts";

const MOD = "__no_such_mod_templates_test__";

type DryRun = Extract<TemplateResult, { dryRun: true }>;
function dry(r: TemplateResult): DryRun {
  if (!r.ok) throw new Error(`template refused: ${r.error}`);
  if (!("dryRun" in r)) throw new Error("expected a dry run");
  return r;
}

export function runTemplatesTests(test: TestFn, assert: AssertFn, eq: EqFn): void {
  console.log("\n# new_from_template: glowing-character");
  const file = (r: DryRun, rel: string) => {
    const f = r.files.find((x) => x.relPath === rel);
    if (!f) throw new Error(`no ${rel} in ${r.files.map((x) => x.relPath).join(", ")}`);
    return f.content;
  };

  test("glowing-character: a variant of the parent (default Rat) whose passives grant FwGlow_<colour> on spawn, in data/characters/enemies.gon.append", () => {
    const r = dry(newFromTemplate(MOD, "glowing-character", "TealRat", { colour: "00ffcc", dryRun: true }));
    eq(r.kind, "glowing-character");
    const gon = file(r, "data/characters/enemies.gon.append");
    assert(/TealRat \{/.test(gon), gon);
    assert(/variant_of Rat\b/.test(gon), gon);
    assert(/StatusOnSpawnIn \{\s*FwGlow_00ffcc 1\s*\}/.test(gon), gon);
  });
  test("glowing-character: parent, trigger (StatusOnBattleStart) and an 8-digit colour or the full FwGlow_ name are honoured", () => {
    const r = dry(newFromTemplate(MOD, "glowing-character", "RedPooter", { colour: "FwGlow_FF000080", parent: "Pooter", trigger: "StatusOnBattleStart", dryRun: true }));
    const gon = file(r, "data/characters/enemies.gon.append");
    assert(/variant_of Pooter\b/.test(gon), gon);
    assert(/StatusOnBattleStart \{\s*FwGlow_FF000080 1\s*\}/.test(gon), gon);
    assert(!/StatusOnSpawnIn/.test(gon), gon);
  });
  test("glowing-character: the status gets a keyword_tooltips entry (name / tooltip / tooltip_stackless) and 12-column text rows for both keys", () => {
    const r = dry(newFromTemplate(MOD, "glowing-character", "TealRat", { colour: "00ffcc", displayName: "Teal glow", desc: "Outlined in teal.", dryRun: true }));
    const kw = file(r, "data/keyword_tooltips.gon.append");
    assert(/FwGlow_00ffcc \{/.test(kw), kw);
    assert(/name "KEYWORD_FWGLOW_00FFCC_NAME"/.test(kw) && /tooltip "KEYWORD_FWGLOW_00FFCC_DESC"/.test(kw) && /tooltip_stackless "KEYWORD_FWGLOW_00FFCC_DESC"/.test(kw), kw);
    const rows = parseCsv(file(r, "data/text/combined.csv.append")).filter((x) => x.length > 1);
    const name = rows.find((x) => x[0] === "KEYWORD_FWGLOW_00FFCC_NAME"), desc = rows.find((x) => x[0] === "KEYWORD_FWGLOW_00FFCC_DESC");
    assert(!!name && !!desc, JSON.stringify(rows));
    eq(name!.length, LOC_COLUMNS.length); eq(desc!.length, LOC_COLUMNS.length);
    eq(name![1], "Teal glow"); eq(desc![1], "Outlined in teal.");
    eq(JSON.stringify(r.localizationKeys), JSON.stringify(["KEYWORD_FWGLOW_00FFCC_NAME", "KEYWORD_FWGLOW_00FFCC_DESC"]));
  });
  test("glowing-character: a malformed colour is refused by the invalid-glow-name rule (5 or 7 hex digits, non-hex), and a missing colour names the option", () => {
    for (const bad of ["00ffc", "00ffcc0", "zzzzzz", "FwGlow_12345"]) {
      const r = newFromTemplate(MOD, "glowing-character", "BadRat", { colour: bad, dryRun: true });
      assert(!r.ok, `${bad} accepted`);
      if (!r.ok) assert(/invalid-glow-name/.test(r.error) && /rrggbb/.test(r.error), r.error);
    }
    const none = newFromTemplate(MOD, "glowing-character", "BadRat", { dryRun: true });
    assert(!none.ok && /colour/.test(none.error), JSON.stringify(none));
  });
  test("glowing-character: the other kinds are unchanged (an ability scaffold still writes one GON file + the text rows)", () => {
    const r = dry(newFromTemplate(MOD, "ability", "MySpin", { dryRun: true }));
    eq(r.files.length, 2);
    eq(r.files[0]!.relPath, "data/abilities/mod_abilities.gon.append");
  });

  if (!existsSync(join(EXTRACTED_DATA, "characters", "enemies.gon"))) {
    console.log("  (skipped: glowing-character scaffold validates — no .extracted/data)");
    return;
  }
  test("T1: a glowing-character scaffold written to a fresh mod folder validates with no errors against the real base data (FwGlow_ resolves through the glow pattern, the text rows are complete)", () => {
    const r = dry(newFromTemplate(MOD, "glowing-character", "TealRat", { colour: "00ffcc", dryRun: true }));
    const dir = mkdtempSync(join(tmpdir(), "mew-glowtpl-"));
    for (const f of r.files) {
      const abs = join(dir, f.relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.content);
    }
    const rep = validateMod("glowtpl", undefined, { modDir: dir, nativeBuild: null });
    const errors = rep.findings.filter((x) => x.severity === "error");
    eq(errors.length, 0, `errors: ${JSON.stringify(errors)}`);
  });
}
