// Validator fixtures: one hand-written mod per finding code on a synthetic base
// (test/fixtures/validator/). T0 — nothing here reads .extracted/, editor/data/ or the
// installed exe: every input the validator resolves against is injected through
// ValidateOptions, so the same checks run on a machine without the game.

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateMod } from "../src/core/validate/validator.ts";
import type { ValidateOptions } from "../src/core/validate/validator.ts";
import type { Finding, Report } from "../src/core/validate/result.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures", "validator");
const BASE = join(FIX, "base");
const MODS = join(FIX, "mods");

/** The synthetic component list the fixtures resolve against (the real one is the git-ignored editor/data cache). */
const COMPONENTS = ["PlayerBrain", "Uncontrollable", "Metal"];
const REGISTERED = ["JokersLuck"];

export function runValidatorTests(test: TestFn, assert: AssertFn, eq: EqFn): void {
  const v = (code: string, opts: ValidateOptions = {}): Report =>
    validateMod(code, undefined, {
      modDir: join(MODS, code),
      extractedData: BASE,
      components: COMPONENTS,
      registeredNames: REGISTERED,
      nativeBuild: null,
      ...opts,
    });
  const codes = (r: Report): string => r.findings.map((f) => f.code).join(",") || "(none)";
  const only = (r: Report, code: string): Finding[] => r.findings.filter((f) => f.code === code);
  /** exactly `n` findings with `code`; returns the first */
  const expectCode = (r: Report, code: string, severity: "error" | "warning", n = 1): Finding => {
    const hits = only(r, code);
    assert(hits.length === n, `expected ${n} x ${code}, got ${hits.length} (all: ${codes(r)})`);
    for (const h of hits) eq(h.severity, severity, `${code} severity`);
    return hits[0]!;
  };

  test("validator fixture: clean mod on the synthetic base has zero findings (ok)", () => {
    const r = v("clean");
    assert(r.ok && r.findings.length === 0, `expected no findings, got ${codes(r)}`);
  });
  test("validator fixture: mod-missing is an error with no location", () => {
    const r = v("does-not-exist");
    const f = expectCode(r, "mod-missing", "error");
    assert(!r.ok && f.location === undefined, "no location");
    eq(r.findings.length, 1, "nothing else is reported for a missing mod");
  });
  test("validator fixture: mod-empty is a warning (description.json alone is not an overlay)", () => {
    const r = v("mod-empty");
    expectCode(r, "mod-empty", "warning");
    assert(r.ok, "a warning keeps the mod valid");
  });
  test("validator fixture: whole-file-replace warns for a suffix-less .gon, combined.csv and a loose .txt", () => {
    const r = v("whole-file-replace");
    const hits = only(r, "whole-file-replace");
    const files = hits.map((f) => f.location?.file).sort();
    eq(files.join("|"), ["mods/whole-file-replace/data/difficulties.gon", "mods/whole-file-replace/data/notes.txt", "mods/whole-file-replace/data/text/combined.csv"].join("|"), "one warning per replaced file");
    for (const h of hits) eq(h.severity, "warning");
    assert(r.ok, "warnings only");
  });
  test("validator fixture: gon-parse-error is an error carrying line and col", () => {
    const r = v("gon-parse-error");
    const f = expectCode(r, "gon-parse-error", "error");
    eq(f.location?.file, "mods/gon-parse-error/data/abilities/x.gon.append");
    assert(typeof f.location?.line === "number" && typeof f.location?.col === "number", `line/col present: ${JSON.stringify(f.location)}`);
    assert(!r.ok, "a parse error is fatal");
  });
  test("validator fixture: unknown-component warns at PlayerCat.passives.NotAComponent and at PlayerCat.ai.brain", () => {
    const r = v("unknown-component");
    const hits = only(r, "unknown-component");
    eq(hits.map((f) => f.location?.path).sort().join("|"), "PlayerCat.ai.brain|PlayerCat.passives.NotAComponent");
    for (const h of hits) eq(h.severity, "warning");
  });
  test("validator fixture: component-list-missing is one info naming the cache and build:index when no component names are known; nothing is then unknown-component", () => {
    const r = v("component-list-missing", { components: [] });
    const f = r.findings.filter((x) => x.code === "component-list-missing");
    eq(f.length, 1, `one finding, got ${codes(r)}`);
    eq(f[0]!.severity, "info");
    assert(/component-names\.json/.test(f[0]!.message) && /build:index/.test(f[0]!.message) && /MEWGENICS_EDITOR_DATA/.test(f[0]!.message), f[0]!.message);
    eq(only(r, "unknown-component").length, 0, "a known component is not flagged for want of a list");
    assert(r.ok, "an info keeps the mod valid");
  });
  test("validator fixture: unknown-parent is an error at Foo.variant_of", () => {
    const r = v("unknown-parent");
    const f = expectCode(r, "unknown-parent", "error");
    eq(f.location?.path, "Foo.variant_of");
    assert(/Nope/.test(f.message) && /ability/.test(f.message), f.message);
    assert(!r.ok, "error");
  });
  test("validator fixture: unknown-template warns at Foo.template", () => {
    const f = expectCode(v("unknown-template"), "unknown-template", "warning");
    eq(f.location?.path, "Foo.template");
  });
  test("validator fixture: unknown-class warns at Foo.meta.class", () => {
    const f = expectCode(v("unknown-class"), "unknown-class", "warning");
    eq(f.location?.path, "Foo.meta.class");
  });
  test("validator fixture: native-build-unknown warns once for a registered name when the exe build is unknown, never when known or absent", () => {
    const unknown = { known: false, identity: { timeDateStamp: "0x6b000000", sizeOfImage: "0x01580000" }, matched: null };
    const f = expectCode(v("native-build-unknown", { nativeBuild: unknown }), "native-build-unknown", "warning");
    eq(f.location?.path, "Foo.damage_instance.effects.JokersLuck");
    assert(/JokersLuck/.test(f.message) && /0x6b000000/.test(f.message), f.message);
    eq(only(v("native-build-unknown", { nativeBuild: { known: true, matched: { steamBuildId: "25143593" } } }), "native-build-unknown").length, 0, "known build");
    eq(only(v("native-build-unknown", { nativeBuild: null }), "native-build-unknown").length, 0, "no exe");
    eq(only(v("native-build-unknown", { nativeBuild: unknown }), "unknown-status").length, 0, "a registered name is a valid status");
  });
  test("validator fixture: unknown-status is an error at Foo.damage_instance.effects.NotAStatus", () => {
    const r = v("unknown-status");
    const f = expectCode(r, "unknown-status", "error");
    eq(f.location?.path, "Foo.damage_instance.effects.NotAStatus");
    assert(!r.ok, "error");
  });
  test("validator fixture: missing-loc-key is an error at Foo.meta.name", () => {
    const r = v("missing-loc-key");
    const f = expectCode(r, "missing-loc-key", "error");
    eq(f.location?.path, "Foo.meta.name");
    assert(/ABILITY_NOPE_KEY/.test(f.message), f.message);
  });
  test("validator fixture: incomplete-loc-row warns with the column count", () => {
    const f = expectCode(v("incomplete-loc-row"), "incomplete-loc-row", "warning");
    assert(/has 5 columns \(expected 12\)/.test(f.message), f.message);
    eq(f.location?.path, "Foo.meta.name");
  });
  test("validator fixture: missing-translation warns listing sp..zh-cn", () => {
    const f = expectCode(v("missing-translation"), "missing-translation", "warning");
    assert(/sp, fr, de, it, pt-br, ru, ko, ja, zh-cn/.test(f.message), f.message);
  });
  test("validator fixture: base-missing warns for a .merge whose base is absent from the injected root", () => {
    const f = expectCode(v("base-missing"), "base-missing", "warning");
    eq(f.location?.file, "mods/base-missing/data/abilities/nothere.gon.merge");
    assert(/data\/abilities\/nothere\.gon/.test(f.message), f.message);
  });
  test("validator fixture: append-collision warns at Spin (base resolved from the injected root, not .extracted/)", () => {
    const f = expectCode(v("append-collision"), "append-collision", "warning");
    eq(f.location?.path, "Spin");
  });
  test("validator fixture: no base-missing when the injected root has the base file (clean/difficulties.gon.merge)", () => {
    const r = v("clean");
    eq(only(r, "base-missing").length, 0, codes(r));
  });
  test("validator fixture: merge-target-missing warns at 999", () => {
    const f = expectCode(v("merge-target-missing"), "merge-target-missing", "warning");
    eq(f.location?.path, "999");
  });
  // A `.merge` file goes through Gon_DeepMerge_plain 0x945c30 with the constant policy 2 (Gon_DefaultMergeMode
  // 0x9451c0): no key suffix is ever read, so `brain.overwrite` is a literal child name — almost always a mistake.
  test("validator fixture: merge-suffix-literal warns for every suffixed key in a .merge file, at any depth", () => {
    const r = v("merge-suffix-literal");
    const hits = only(r, "merge-suffix-literal");
    eq(hits.map((f) => f.location?.path).sort().join(","), "NewCat.overwrite,PlayerCat.ai.brain.overwrite", codes(r));
    for (const h of hits) eq(h.severity, "warning", "merge-suffix-literal severity");
    assert(/\.patch/.test(hits[0]!.message), `message points at .patch: ${hits[0]!.message}`);
  });
  test("validator fixture: merge-suffix-literal — the mod-local name is the literal key (NewCat.overwrite), so variant_of NewCat is unknown-parent", () => {
    const r = v("merge-suffix-literal");
    const f = expectCode(r, "unknown-parent", "error");
    eq(f.location?.file, "mods/merge-suffix-literal/data/characters/player_cat.gon.append");
  });
  test("validator fixture: patch-target-missing warns at 0.nope", () => {
    const f = expectCode(v("patch-target-missing"), "patch-target-missing", "warning");
    eq(f.location?.path, "0.nope");
    assert(/\.add/.test(f.message), f.message);
  });
  test("validator fixture: patch-nonnumeric warns at 0.wallet_size", () => {
    const f = expectCode(v("patch-nonnumeric"), "patch-nonnumeric", "warning");
    eq(f.location?.path, "0.wallet_size");
  });
  test("validator fixture: patch-quoted-number — wallet_size.add \"5\" is a number to the game (quotes are dropped before typing), so no patch-nonnumeric", () => {
    const r = v("patch-quoted-number");
    eq(only(r, "patch-nonnumeric").length, 0, `no patch-nonnumeric (all: ${codes(r)})`);
  });
  test("validator fixture: csv-positional-merge-fragile warns for combined.csv.merge", () => {
    const f = expectCode(v("csv-positional-merge-fragile"), "csv-positional-merge-fragile", "warning");
    eq(f.location?.file, "mods/csv-positional-merge-fragile/data/text/combined.csv.merge");
  });
  test("validator fixture: csv-column-count warns with the row number and key", () => {
    const f = expectCode(v("csv-column-count"), "csv-column-count", "warning");
    eq(f.location?.line, 1);
    assert(/KEY_X.*has 3 columns; expected 12/.test(f.message), f.message);
  });
}
