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
import { readFileSync } from "node:fs";
import { loadRegisteredNames, registeredNameSet, registeredPatterns } from "../src/core/names.ts";
import type { RegisteredName } from "../src/core/names.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures", "validator");
const BASE = join(FIX, "base");
const MODS = join(FIX, "mods");

/** The synthetic component list the fixtures resolve against (the real one is the git-ignored editor/data cache). */
const COMPONENTS = ["PlayerBrain", "Uncontrollable", "Metal"];
const REGISTERED = ["JokersLuck"];
/** the glow pattern entry as editor/registered-names.json holds it (the real file is cross-checked below) */
const GLOW_PATTERNS: RegisteredName[] = [{ name: "FwGlow_<rrggbb[aa]>", kind: "glow", mod: "fw-glow", prefix: "FwGlow_", pattern: "^FwGlow_(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$" }];

export function runValidatorTests(test: TestFn, assert: AssertFn, eq: EqFn): void {
  const v = (code: string, opts: ValidateOptions = {}): Report =>
    validateMod(code, undefined, {
      modDir: join(MODS, code),
      extractedData: BASE,
      components: COMPONENTS,
      registeredNames: REGISTERED,
      nativeBuild: null,
      componentSchema: null, // the component key checks have their own suite (component-schema-tests.ts)
      ...opts,
    });
  const codes = (r: Report): string => r.findings.map((f) => f.code).join(",") || "(none)";
  const only = (r: Report, code: string): Finding[] => r.findings.filter((f) => f.code === code);
  /** exactly `n` findings with `code`; returns the first */
  const expectCode = (r: Report, code: string, severity: "error" | "warning" | "info", n = 1): Finding => {
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
  test("validator fixture: files the game never loads are not overlays: tests/*.mewtest (harness scripts), art/ sources other than scenes (art/*.scene.json is validated as a scene) and dotfiles get no finding at all", () => {
    const r = v("whole-file-replace");
    const stray = r.findings.filter((f) => /\/(tests|art)\/|\/\.gitignore$/.test(f.location?.file ?? "") || /^(tests|art)\/|\.gitignore/.test(f.message));
    eq(stray.map((f) => `${f.code} ${f.location?.file ?? ""}`).join(", "), "", "nothing reported for tests/smoke.mewtest, art/probe.svg, .gitignore");
  });
  test("validator fixture: text-loc-key-html warns for an HTML scene text that is a base key or a key the mod's combined.csv.append adds; not for html: false, a plain word or a wrapper of several words", () => {
    const r = v("text-loc-key-html");
    const hits = only(r, "text-loc-key-html");
    eq(hits.map((f) => f.location?.path).sort().join("|"), "texts.htmlKey|texts.htmlModKey", `all: ${codes(r)}`);
    for (const h of hits) {
      eq(h.severity, "warning");
      eq(h.location?.file, "mods/text-loc-key-html/art/loc.scene.json");
    }
    const mod = hits.find((f) => f.location?.path === "texts.htmlModKey")!;
    assert(/combined\.csv\.append/.test(mod.message), mod.message);
    const base = hits.find((f) => f.location?.path === "texts.htmlKey")!;
    assert(/base combined\.csv/.test(base.message), base.message);
    assert(r.ok, "warnings only");
  });
  test("validator fixture: a scene file (art/*.scene.json) is validated as a scene, not warned as a whole-file replace", () => {
    const r = v("text-loc-key-html");
    eq(only(r, "whole-file-replace").length, 0, `all: ${codes(r)}`);
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
  // The data-level glow seam (glow v3): a status named FwGlow_<rrggbb> / FwGlow_<rrggbbaa> is recognised by the
  // framework by its NAME, so registered-names.json carries a pattern entry (kind "glow") instead of a name.
  test("validator fixture: glow-status — FwGlow_<rrggbb[aa]> names resolve through the registered glow pattern, not as unknown-status; without the pattern they are unknown", () => {
    const r = v("glow-status", { registeredPatterns: GLOW_PATTERNS });
    assert(r.ok && r.findings.length === 0, `expected no findings, got ${codes(r)}`);
    eq(only(v("glow-status", { registeredPatterns: [] }), "unknown-status").length, 2, "no pattern: both names are unknown statuses");
  });
  test("validator fixture: glow-status — native-build-unknown warns for a glow name when the exe build is unknown (the framework does the drawing)", () => {
    const unknown = { known: false, identity: { timeDateStamp: "0x6b000000", sizeOfImage: "0x01580000" }, matched: null };
    const r = v("glow-status", { registeredPatterns: GLOW_PATTERNS, nativeBuild: unknown });
    const hits = only(r, "native-build-unknown");
    eq(hits.length, 2, `one per name (all: ${codes(r)})`);
    eq(hits[0]!.location?.path, "Foo.damage_instance.effects.FwGlow_ff00ff");
  });
  test("validator fixture: invalid-glow-name is an error naming the expected shape (FwGlow_ + 6 or 8 hex digits)", () => {
    const r = v("invalid-glow-name", { registeredPatterns: GLOW_PATTERNS });
    const f = expectCode(r, "invalid-glow-name", "error");
    eq(f.location?.path, "Foo.damage_instance.effects.FwGlow_ff00f");
    assert(/FwGlow_/.test(f.message) && /6 or 8 hex/.test(f.message), f.message);
    eq(only(r, "unknown-status").length, 0, "reported once, as the specific code");
    assert(!r.ok, "error");
  });
  test("registered-names.json: the glow pattern entry's prefix is native fw_glow_rules.h FW_GLOW_STATUS_PREFIX and it accepts exactly the names the native parser accepts", () => {
    const entries = loadRegisteredNames();
    const glow = entries.filter((e) => e.kind === "glow");
    eq(glow.length, 1, "one glow pattern entry");
    const g = glow[0]!;
    const header = readFileSync(join(HERE, "..", "..", "native", "framework", "src", "fw_glow_rules.h"), "utf8");
    const m = /#define FW_GLOW_STATUS_PREFIX\s+"([^"]+)"/.exec(header);
    assert(!!m, "FW_GLOW_STATUS_PREFIX in fw_glow_rules.h");
    eq(g.prefix, m![1]);
    assert(!registeredNameSet().has(g.name), "a pattern entry is not a literal name");
    const p = registeredPatterns(entries);
    eq(p.length, 1);
    // the native host test's lists (test_glow_rules.c data_parse_status_name_*)
    for (const ok of ["FwGlow_ff00ff", "FwGlow_00FFFF80", "FwGlow_336699", "FwGlow_ffffffff"]) assert(p[0]!.re.test(ok), `accepts ${ok}`);
    for (const bad of ["FwGlow_", "FwGlow_ff00f", "FwGlow_ff00ff0", "FwGlow_ff00ff00f", "FwGlow_gg00ff", "FwGlow_ff 0ff", "fwglow_ff00ff", "FwGlowff00ff", "XFwGlow_ff00ff", "FwGlow_-f00ff", "FwGlow_0xff00", "LuckUp", ""]) assert(!p[0]!.re.test(bad), `refuses ${JSON.stringify(bad)}`);
  });
  // The cat rig redirect (framework API v7): a SWF export _CatRig_<Entry> replaces the cat clip of that one character
  // entry, so <Entry> must be a character the base game or the mod defines.
  test("validator fixture: cat-rig-target-unknown is an error per _CatRig_<Entry> export whose entry is no character in the base or the mod (base PlayerCat and the mod's own ModCat resolve)", () => {
    const r = v("cat-rig-target-unknown");
    const f = expectCode(r, "cat-rig-target-unknown", "error");
    eq(f.location?.file, "mods/cat-rig-target-unknown/art/rig.scene.json");
    eq(f.location?.path, "exports._CatRig_NoSuchCat");
    assert(/NoSuchCat/.test(f.message) && /characters/.test(f.message), f.message);
    assert(!r.ok, "error");
  });
  test("registered-names.json: the catrig entry (kind catrig, prefix = native FW_CATRIG_EXPORT_PREFIX) is neither a literal name nor a status pattern", () => {
    const entries = loadRegisteredNames();
    const rig = entries.filter((e) => e.kind === "catrig");
    eq(rig.length, 1, "one catrig entry");
    const header = readFileSync(join(HERE, "..", "..", "native", "framework", "src", "fw_catrig_rules.h"), "utf8");
    const m = /#define FW_CATRIG_EXPORT_PREFIX\s+"([^"]+)"/.exec(header);
    assert(!!m, "FW_CATRIG_EXPORT_PREFIX in fw_catrig_rules.h");
    eq(rig[0]!.prefix, m![1]);
    assert(!registeredNameSet().has(rig[0]!.name), "not a literal (status/ability) name");
    assert(!registeredPatterns(entries).some((p) => p.kind === "catrig"), "not a status-name pattern");
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
  // ---- mod.json (docs/data-mods.md "Shipping a mod") ----
  test("validator fixture: clean has a valid mod.json, and mod.json is not read as an overlay (no whole-file-replace for it)", () => {
    const r = v("clean");
    eq(only(r, "whole-file-replace").length, 0, codes(r));
    eq(only(r, "manifest-missing").length, 0, codes(r));
  });
  test("validator fixture: manifest-missing is an info (a mod without mod.json still loads; it just cannot be packed)", () => {
    const r = v("manifest-missing");
    const f = expectCode(r, "manifest-missing", "info");
    assert(r.ok && /mod.json/.test(f.message), f.message);
    eq(f.location?.file, "mods/manifest-missing/mod.json");
  });
  test("validator fixture: manifest-invalid is an error naming each bad field (name vs folder, version, gameBuild)", () => {
    const r = v("manifest-invalid");
    const f = expectCode(r, "manifest-invalid", "error");
    assert(!r.ok, "error");
    assert(/name/.test(f.message) && /version/.test(f.message) && /gameBuild/.test(f.message), f.message);
  });
  test("validator fixture: manifest-build-mismatch warns when the installed build is another known build or unknown; never on a match or without an exe", () => {
    const other = expectCode(v("manifest-build-mismatch", { nativeBuild: { known: true, matched: { steamBuildId: "25200000" } } }), "manifest-build-mismatch", "warning");
    assert(/25143593/.test(other.message) && /25200000/.test(other.message), other.message);
    eq(other.location?.file, "mods/manifest-build-mismatch/mod.json");
    expectCode(v("manifest-build-mismatch", { nativeBuild: { known: false, identity: { timeDateStamp: "0x6b000000", sizeOfImage: "0x01580000" }, matched: null } }), "manifest-build-mismatch", "warning");
    eq(only(v("manifest-build-mismatch", { nativeBuild: { known: true, matched: { steamBuildId: "25143593" } } }), "manifest-build-mismatch").length, 0, "match");
    eq(only(v("manifest-build-mismatch", { nativeBuild: null }), "manifest-build-mismatch").length, 0, "no exe");
  });
  test("validator fixture: include-missing is an error at the #include line for a name that exists in neither the mod nor the base (the game stops: Could not locate include file)", () => {
    const r = v("include-missing");
    const f = expectCode(r, "include-missing", "error");
    eq(f.location?.file, "mods/include-missing/data/maps/town.gon.append");
    eq(`${f.location?.line}:${f.location?.col}`, "4:2");
    assert(f.message.includes("nope_nodes.gon") && f.message.includes("data/maps/nope_nodes.gon"), f.message);
    assert(/error message box/.test(f.message) && /exits/.test(f.message), `says what the game does: ${f.message}`);
    assert(!r.ok, "an error makes the mod invalid");
  });
  test("validator fixture: an #include that resolves in the base (data/maps/std_nodes.gon) is not reported", () => {
    const r = v("include-missing");
    eq(only(r, "include-missing").length, 1, "only nope_nodes.gon");
  });
  test("validator fixture: a file the mod ships only to be #included (not in the base) is an include fragment — no whole-file-replace, no include-missing", () => {
    const r = v("include-mod-file");
    eq(codes(r), "(none)");
  });
  test("validator fixture: #define macros are expanded like the game (no gon-define-unmodelled; the append sees morestuff.shop1)", () => {
    const r = v("gon-define");
    eq(only(r, "gon-define-unmodelled").length, 0, `no unmodelled warning (all: ${codes(r)})`);
    assert(r.ok, `valid: ${codes(r)}`);
  });
  test("validator fixture: gon-macro-runaway warns when a macro still expands after the game's 256 passes", () => {
    const f = expectCode(v("gon-macro-runaway"), "gon-macro-runaway", "warning");
    assert(/256/.test(f.message), f.message);
  });
  test("validator fixture: include-path-unsafe is an error at the #include for `..` / `./` / absolute / drive / backslash names (and not include-missing)", () => {
    const r = v("include-path-unsafe");
    const hits = only(r, "include-path-unsafe");
    eq(hits.length, 3, `three unsafe names (all: ${codes(r)})`);
    for (const h of hits) eq(h.severity, "error");
    eq(`${hits[0]!.location?.line}:${hits[0]!.location?.col}`, "3:2");
    assert(/\.\.\/maps\/std_nodes\.gon/.test(hits[0]!.message) && /pack/.test(hits[0]!.message), hits[0]!.message);
    eq(only(r, "include-missing").length, 0, "not reported as missing");
    assert(!r.ok, "an error makes the mod invalid");
  });
  test("validator fixture: comment-unclosed warns at the /* line (the game silently drops everything after it)", () => {
    const f = expectCode(v("comment-unclosed"), "comment-unclosed", "warning");
    eq(f.location?.file, "mods/comment-unclosed/data/maps/town.gon.append");
    eq(`${f.location?.line}:${f.location?.col}`, "5:1");
    assert(/drops everything after it/.test(f.message), f.message);
  });
}
