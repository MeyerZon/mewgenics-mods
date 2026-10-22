// Component key schema (editor/component-schema.json): the fragment shape check and merge that
// scripts/build-component-schema.ts runs over the RE sessions' .analysis/component-schema-<tag>.json files,
// the inheritance resolution, the block check behind the validator's `unknown-key` / `missing-required-key`,
// the component-block traversal shared by the validator and the vanilla survey, and (T1) the proof that vanilla
// data produces zero findings against the tracked schema. T0 parts use inline synthetic schemas only.

import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parse } from "../src/core/gon/parser.ts";
import { toValue, prettyRoot } from "../src/core/gon/value.ts";
import type { VObject } from "../src/core/gon/types.ts";
import {
  resolveComponent, checkComponentBlock, forEachComponentBlock, loadComponentSchema, validateSchemaShape, SCHEMA_PATH,
} from "../src/core/component-schema.ts";
import type { ComponentSchema, ComponentSpec, KeySpec, KeyType } from "../src/core/component-schema.ts";
import { validateFragment, mergeFragments, surveyVanilla } from "../src/core/component-schema-build.ts";
import type { Fragment } from "../src/core/component-schema-build.ts";
import { validateMod } from "../src/core/validate/validator.ts";
import { componentNameSet } from "../src/core/components.ts";
import { EXTRACTED_DATA } from "../src/core/repo.ts";
import { searchComponents } from "../src/core/api.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const spec = (over: Partial<ComponentSpec>): ComponentSpec => ({
  base: null, status: "mapped", open: false, children: null, scalar: null, keys: {}, includes: [], vanillaMissed: [], notes: "", ...over,
});
const key = (type: KeyType, over: Partial<KeySpec> = {}): KeySpec => ({ type, default: null, required: false, confidence: "observed", evidence: ".analysis/decompiled/x.c", ...over });

/** A small hand-written schema: a Passive base, a child with own keys, an effects-children container, an open one, a shared include. */
export function syntheticSchema(): ComponentSchema {
  return {
    schemaVersion: 1,
    build: "test",
    effectNames: ["HealthGain"],
    components: {
      Passive: spec({ scalar: "stacks", keys: { stacks: key("int", { default: 1 }) } }),
      CatchProjectiles: spec({ base: "Passive", keys: { chance: key("number", { default: 1 }), ally_chance: key("number") } }),
      OnHitEffects: spec({ base: "Passive", children: "effects" }),
      Mystery: spec({ base: "Passive", status: "unresolved", open: true }),
      SpawnThing: spec({ base: "Passive", keys: { object: key("string", { required: true }), number: key("int", { default: 1 }), numbr: key("any", { unread: true, note: "vanilla typo of number" }) } }),
      FormChanger: spec({ base: "Passive", children: "any" }),
      Rain: spec({ base: "Passive" }),
      Revenge: spec({ base: "Passive", includes: ["@DamageInstance"] }),
      LateRevenge: spec({ base: "Revenge", keys: { delay: key("int") } }),
    },
    shared: { "@DamageInstance": { keys: { damage: key("expr"), knockback: key("int") }, evidence: ".analysis/decompiled/y.c", notes: "" } },
  } as ComponentSchema;
}

const obj = (src: string): VObject => {
  const v = toValue(parse(src));
  if (v.t !== "obj") throw new Error("object expected");
  return v;
};
const block = (src: string): VObject => {
  const o = obj(src);
  const e = o.entries[0]!;
  if (e.value.t !== "obj") throw new Error("block expected");
  return e.value;
};

const fragA = (): Fragment => ({
  schema: 1, agent: "compA", first: "A", last: "C",
  components: {
    CatchProjectiles: { base: "Passive", status: "mapped", open: false, children: null, scalar: null, keys: { chance: key("number", { default: 1, accessor: "NumberOr" }) }, includes: [], vanillaMissed: [], notes: "" },
    Revenge: { base: "Passive", status: "mapped", open: false, children: null, scalar: null, keys: {}, includes: ["@DamageInstance"], vanillaMissed: [], notes: "" },
  },
  shared: { "@DamageInstance": { keys: { damage: key("expr"), knockback: key("int") }, evidence: ".analysis/decompiled/y.c", notes: "" } },
} as unknown as Fragment);
const fragB = (): Fragment => ({
  schema: 1, agent: "compB", first: "P", last: "S",
  components: {
    Passive: { base: null, status: "mapped", open: false, children: null, scalar: "stacks", keys: { stacks: key("int", { default: 1 }) }, includes: [], vanillaMissed: [], notes: "" },
    SpawnThing: { base: "Passive", status: "mapped", open: false, children: null, scalar: null, keys: { object: key("string", { required: true }) }, includes: [], vanillaMissed: [], notes: "" },
  },
  shared: {},
} as unknown as Fragment);

export function runComponentSchemaTests(test: TestFn, assert: AssertFn, eq: EqFn): void {
  // ---- resolution -------------------------------------------------------------
  test("component schema: resolveComponent walks base + includes (child keys over base keys)", () => {
    const s = syntheticSchema();
    const r = resolveComponent(s, "LateRevenge");
    assert(r !== null, "resolved");
    eq(r!.chain.join(">"), "LateRevenge>Revenge>Passive", "chain");
    eq(Object.keys(r!.keys).sort().join(","), "damage,delay,knockback,stacks", "effective keys");
    eq(r!.keys.damage!.from, "@DamageInstance", "provenance of an included key");
    eq(r!.open, false, "closed when every link is closed");
    eq(resolveComponent(s, "NotInSchema"), null, "unknown class -> null (no check)");
  });
  test("component schema: an open link opens the resolved component; children are inherited", () => {
    const s = syntheticSchema();
    s.components.Child = spec({ base: "Mystery" });
    s.components.Kid = spec({ base: "OnHitEffects" });
    eq(resolveComponent(s, "Child")!.open, true, "open propagates down");
    eq(resolveComponent(s, "Kid")!.children, "effects", "children propagate down");
    eq(resolveComponent(s, "SpawnThing")!.required.join(","), "object", "required keys listed");
  });

  // ---- block check ---------------------------------------------------------------
  const dyn = (n: string) => ["Bleed", "Conditional_Enemy", "HealthGain"].includes(n);
  test("component schema: checkComponentBlock reports a key the component never reads", () => {
    const s = syntheticSchema();
    const r = checkComponentBlock(resolveComponent(s, "CatchProjectiles")!, block("CatchProjectiles { chance 0.5 chanse 1 stacks 2 }"), { patch: false, requireComplete: false, isDynamicChild: dyn });
    eq(r.unknown.join(","), "chanse", "only the typo");
    eq(r.missing.length, 0, "nothing required");
  });
  test("component schema: open components and effect-children containers accept their children", () => {
    const s = syntheticSchema();
    const o = { patch: false, requireComplete: false, isDynamicChild: dyn };
    eq(checkComponentBlock(resolveComponent(s, "Mystery")!, block("Mystery { anything 1 }"), o).unknown.length, 0, "open: never flagged");
    const r = checkComponentBlock(resolveComponent(s, "OnHitEffects")!, block("OnHitEffects { Bleed 1 HealthGain 2 Conditional_Enemy { Bleed 1 } chance 3 }"), o);
    eq(r.unknown.join(","), "chance", "effect names accepted, a non-effect literal is not");
    s.components.FormMap = spec({ base: "Passive", children: "any" });
    eq(checkComponentBlock(resolveComponent(s, "FormMap")!, block("FormMap { 0 { form A } 1 { form B } }"), o).unknown.length, 0, "children any: an arbitrary map, every key accepted");
    const closed = checkComponentBlock(resolveComponent(s, "CatchProjectiles")!, block("CatchProjectiles { Bleed 1 }"), o);
    eq(closed.unknown.join(","), "Bleed", "a component without children does not take effect names");
  });
  test("component schema: .patch keys are read without their policy suffix; required only for complete blocks", () => {
    const s = syntheticSchema();
    const sp = resolveComponent(s, "SpawnThing")!;
    eq(checkComponentBlock(sp, block("SpawnThing { number.multiply 2 }"), { patch: true, requireComplete: false, isDynamicChild: dyn }).unknown.length, 0, "suffix stripped in .patch");
    eq(checkComponentBlock(sp, block("SpawnThing { number.multiply 2 }"), { patch: false, requireComplete: false, isDynamicChild: dyn }).unknown.join(","), "number.multiply", ".merge/.append keep the literal key");
    eq(checkComponentBlock(sp, block("SpawnThing { number 2 }"), { patch: false, requireComplete: true, isDynamicChild: dyn }).missing.join(","), "object", "missing required in a complete block");
    eq(checkComponentBlock(sp, block("SpawnThing { number 2 }"), { patch: false, requireComplete: false, isDynamicChild: dyn }).missing.length, 0, "partial overlay: not checked");
  });

  test("component schema: an unread key (vanilla writes it, no code reads it) is reported as ignored, never unknown or required", () => {
    const s = syntheticSchema();
    const r = resolveComponent(s, "SpawnThing")!;
    eq(r.required.join(","), "object", "unread keys are never required");
    const c = checkComponentBlock(r, block("SpawnThing { object Rat numbr 2 nmber 3 }"), { patch: false, requireComplete: true, isDynamicChild: dyn });
    eq(c.unknown.join(","), "nmber", "an unread key is not unknown");
    eq(c.ignored.join(","), "numbr", "it is listed as ignored");
    eq(validateSchemaShape(s).join("; "), "", "unread keys pass the shape check");
    const bad = syntheticSchema();
    bad.components.SpawnThing!.keys.numbr = key("any", { unread: true, required: true });
    assert(validateSchemaShape(bad).some((e) => /numbr.*unread/.test(e)), `an unread key cannot be required: ${validateSchemaShape(bad).join(" | ")}`);
  });

  // ---- traversal -----------------------------------------------------------------
  test("component schema: forEachComponentBlock does not treat the map keys of a children:any component as blocks", () => {
    const comps = new Set(["FormChanger", "Rain", "CatchProjectiles"]);
    const seen: string[] = [];
    forEachComponentBlock(obj(`
      Boss { passives { FormChanger { Rain { ai { brain x } passives { CatchProjectiles { chance 1 } } } } Rain { x 1 } } }
    `), (n) => comps.has(n), (name, _v, path) => seen.push(`${name}@${path.join(".")}`), (n) => n === "FormChanger");
    eq(seen.join(" | "), "FormChanger@Boss.passives.FormChanger | CatchProjectiles@Boss.passives.FormChanger.Rain.passives.CatchProjectiles | Rain@Boss.passives.Rain",
      "a form named Rain is a map key (its passives are still walked); a real Rain block is still a block");
  });
  test("component schema: forEachComponentBlock finds passives / bonus_passives / effects blocks and nested ones", () => {
    const comps = new Set(["CatchProjectiles", "OnHitEffects", "Bleed", "Minions"]);
    const seen: string[] = [];
    forEachComponentBlock(obj(`
      Thing { 1 { passives { CatchProjectiles { chance 1 } OnHitEffects { Bleed { stacks 2 } } NotAComponent { x 1 } } } }
      Item { bonus_passives { Minions { passives { CatchProjectiles 2 } } } }
      Ab { damage_instance { effects { Bleed 3 } } }
      Top { CatchProjectiles { chance 1 } }
    `), (n) => comps.has(n), (name, value, path) => seen.push(`${name}:${value.t}@${path.join(".")}`));
    eq(seen.join(" | "), [
      "CatchProjectiles:obj@Thing.1.passives.CatchProjectiles",
      "OnHitEffects:obj@Thing.1.passives.OnHitEffects",
      "Bleed:obj@Thing.1.passives.OnHitEffects.Bleed",
      "Minions:obj@Item.bonus_passives.Minions",
      "CatchProjectiles:str@Item.bonus_passives.Minions.passives.CatchProjectiles",
      "Bleed:str@Ab.damage_instance.effects.Bleed",
    ].join(" | "), "blocks in document order; a top-level entry named like a class is not a block");
  });

  // ---- fragments + merge ----------------------------------------------------------
  test("component schema build: a well-formed fragment has no shape errors", () => {
    eq(validateFragment(fragA(), "a").join("; "), "", "fragment A");
    eq(validateFragment(fragB(), "b").join("; "), "", "fragment B");
  });
  test("component schema build: shape errors name the fragment, component and field", () => {
    const bad = fragA() as unknown as { components: Record<string, Record<string, unknown>> };
    bad.components.CatchProjectiles!.open = "no";
    (bad.components.CatchProjectiles!.keys as Record<string, Record<string, unknown>>).chance!.type = "float";
    bad.components.Revenge!.children = "statuses";
    ((bad.components.Revenge as Record<string, unknown>).keys as Record<string, unknown>).k = { type: "int", default: null, required: false, confidence: "observed" };
    const errs = validateFragment(bad, "bad.json");
    assert(errs.some((e) => /bad\.json: CatchProjectiles\.open/.test(e)), `open: ${errs.join(" | ")}`);
    assert(errs.some((e) => /CatchProjectiles\.keys\.chance\.type/.test(e)), `type: ${errs.join(" | ")}`);
    assert(errs.some((e) => /Revenge\.children/.test(e)), `children: ${errs.join(" | ")}`);
    assert(errs.some((e) => /Revenge\.keys\.k\.evidence/.test(e)), `observed needs evidence: ${errs.join(" | ")}`);
    assert(validateFragment({ schema: 2 }, "x").length > 0, "wrong schema version");
  });
  test("component schema build: merge unions fragments, rejects duplicates and dangling includes", () => {
    const m = mergeFragments([fragA(), fragB()], { build: "test" });
    eq(m.errors.join("; "), "", "no errors");
    eq(Object.keys(m.schema.components).sort().join(","), "CatchProjectiles,Passive,Revenge,SpawnThing", "components");
    eq(Object.keys(m.schema.shared).join(","), "@DamageInstance", "shared");
    const dup = mergeFragments([fragA(), fragA()], { build: "test" });
    assert(dup.errors.some((e) => /CatchProjectiles.*compA.*compA|duplicate/i.test(e)), dup.errors.join(" | "));
    const dangling = fragB() as unknown as { components: Record<string, { includes: string[] }> };
    dangling.components.SpawnThing!.includes = ["@Nope"];
    assert(mergeFragments([dangling as unknown as Fragment], { build: "test" }).errors.some((e) => /@Nope/.test(e)), "dangling include");
    eq(validateSchemaShape(m.schema).join("; "), "", "merged schema passes the tracked-file shape check");
  });
  test("component schema build: the vanilla cross-check opens a component vanilla feeds unknown keys and demotes required", () => {
    const vanilla = {
      CatchProjectiles: { objUses: 2, keys: { chance: 2, ally_chance: 1 } },
      SpawnThing: { objUses: 3, keys: { object: 2 } },
    };
    const m = mergeFragments([fragA(), fragB()], { build: "test", vanilla });
    const cp = m.schema.components.CatchProjectiles!;
    eq(cp.open, true, "ally_chance not mapped -> open");
    eq(cp.vanillaMissed.join(","), "ally_chance", "recorded");
    eq(m.schema.components.SpawnThing!.keys.object!.required, false, "vanilla omits object once -> not required");
    eq(m.schema.coverage!.vanillaKeys, 3, "vanilla literal keys counted");
    eq(m.schema.coverage!.vanillaKeysFound, 2, "found ones counted");
  });
  test("component schema build: an amend fragment adds / replaces / deletes keys and reshapes an existing component", () => {
    const amend = {
      schema: 1, agent: "compclose", components: {},
      amend: {
        CatchProjectiles: { keys: { ally_chance: key("number", { default: 0, accessor: "NumberOr" }), chance: null }, open: false, notes: "ally_chance in a lambda" },
        SpawnThing: { children: "effects", includes: ["@DamageInstance"] },
      },
    } as unknown as Fragment;
    eq(validateFragment(amend, "c").join("; "), "", "amend fragment shape");
    const m = mergeFragments([fragA(), fragB(), amend], { build: "test" });
    eq(m.errors.join("; "), "", "no errors");
    const cp = m.schema.components.CatchProjectiles!;
    eq(Object.keys(cp.keys).join(","), "ally_chance", "added one key, deleted one");
    assert(/compA/.test(cp.agent ?? "") && /compclose/.test(cp.agent ?? ""), `agent records both: ${cp.agent}`);
    assert(cp.notes.endsWith("ally_chance in a lambda"), `notes appended: ${cp.notes}`);
    eq(m.schema.components.SpawnThing!.children, "effects", "children set");
    eq(m.schema.components.SpawnThing!.includes.join(","), "@DamageInstance", "include added");
    const missing = mergeFragments([fragA(), { ...amend, amend: { Nope: { open: false } } } as unknown as Fragment], { build: "test" });
    assert(missing.errors.some((e) => /amend.*Nope/.test(e)), `amending an unknown component is an error: ${missing.errors.join(" | ")}`);
    const badShape = { ...amend, amend: { CatchProjectiles: { keys: { x: { type: "float" } } } } };
    assert(validateFragment(badShape, "c").some((e) => /amend.*CatchProjectiles.*keys\.x/.test(e)), "amend keys are shape-checked");
  });
  test("component schema build: amending a component closed clears its fragment vanillaMissed; the cross-check reopens it only for keys still missing", () => {
    const vanilla = { CatchProjectiles: { objUses: 2, keys: { chance: 2, ally_chance: 1, chanse: 1 } } };
    const a = fragA() as unknown as { components: Record<string, { open: boolean; vanillaMissed: string[] }> };
    a.components.CatchProjectiles!.open = true;
    a.components.CatchProjectiles!.vanillaMissed = ["ally_chance", "chanse"];
    const close = (keys: Record<string, unknown>) => ({ schema: 1, agent: "compclose", components: {}, amend: { CatchProjectiles: { open: false, keys } } }) as unknown as Fragment;
    const half = mergeFragments([a as unknown as Fragment, fragB(), close({ ally_chance: key("number") })], { build: "test", vanilla });
    eq(half.schema.components.CatchProjectiles!.vanillaMissed.join(","), "chanse", "only the key still missing");
    eq(half.schema.components.CatchProjectiles!.open, true, "still open");
    const full = mergeFragments([a as unknown as Fragment, fragB(), close({ ally_chance: key("number"), chanse: key("any", { unread: true }) })], { build: "test", vanilla });
    eq(full.schema.components.CatchProjectiles!.open, false, "every vanilla key accounted for -> closed");
    eq(full.schema.coverage!.vanillaKeysFound, 2, "read keys found");
    eq(full.schema.coverage!.vanillaKeysUnread, 1, "the unread one counted apart");
    eq(full.schema.coverage!.vanillaOpen, 0, "no vanilla component open");
    eq(full.schema.coverage!.vanillaClosed, 1, "one vanilla component closed");
  });
  test("component schema build: surveyVanilla skips the map keys of children:any components", () => {
    const root = mkdtempSync(join(tmpdir(), "mewged-compsurvey-map-"));
    mkdirSync(join(root, "characters"));
    writeFileSync(join(root, "characters", "c.gon"), "Boss { passives { FormChanger { Rain { ai { brain x } passives { CatchProjectiles { chance 1 } } } } } }\n");
    const u = surveyVanilla(root, (n) => ["FormChanger", "Rain", "CatchProjectiles"].includes(n), () => false, (n) => n === "FormChanger");
    eq(u.Rain, undefined, "the form named Rain is not a Rain block");
    eq(u.CatchProjectiles!.objUses, 1, "the passives inside the form are still surveyed");
  });
  test("component schema build: surveyVanilla counts object uses and literal keys per component (synthetic tree)", () => {
    const root = mkdtempSync(join(tmpdir(), "mewged-compsurvey-"));
    mkdirSync(join(root, "passives"));
    writeFileSync(join(root, "passives", "p.gon"), "A { 1 { passives { CatchProjectiles { chance 1 } CatchProjectiles { chance 1 ally_chance 2 } OnHitEffects { Bleed 1 } } } }\n");
    const u = surveyVanilla(root, (n) => ["CatchProjectiles", "OnHitEffects", "Bleed"].includes(n));
    eq(u.CatchProjectiles!.objUses, 2, "two object uses");
    eq(u.CatchProjectiles!.keys.ally_chance, 1, "ally_chance once");
    eq(Object.keys(u.OnHitEffects!.keys).length, 0, "component-named children are not literal keys");
  });

  // ---- validator integration (synthetic base) ----------------------------------------
  const FIX = join(HERE, "fixtures", "validator");
  const COMPONENTS = ["PlayerBrain", "Uncontrollable", "Metal", "CatchProjectiles", "OnHitEffects", "Mystery", "SpawnThing", "Passive", "Bleed", "Conditional_Enemy", "FormChanger", "Rain"];
  const run = (mod: string) => validateMod(mod, undefined, {
    modDir: join(FIX, "mods", mod), extractedData: join(FIX, "base"), components: COMPONENTS, registeredNames: ["JokersLuck"], nativeBuild: null, componentSchema: syntheticSchema(),
  });
  test("validator fixture: unknown-key warns for keys a component never reads (and only those)", () => {
    const r = run("unknown-key");
    const hits = r.findings.filter((f) => f.code === "unknown-key");
    eq(hits.map((h) => h.location?.path).join(" | "), "Zap.1.passives.CatchProjectiles.chanse | Zap.1.passives.OnHitEffects.chance", "paths");
    assert(hits.every((h) => h.severity === "warning"), "warnings");
    assert(/CatchProjectiles/.test(hits[0]!.message) && /chance/.test(hits[0]!.message), `message names the component and its keys: ${hits[0]!.message}`);
    eq(r.findings.filter((f) => f.code !== "unknown-key").map((f) => f.code).join(","), "", "nothing else");
  });
  test("validator fixture: missing-required-key is an error in a new (.append) block", () => {
    const r = run("missing-required-key");
    const hits = r.findings.filter((f) => f.code === "missing-required-key");
    eq(hits.length, 1, `one finding (all: ${r.findings.map((f) => f.code).join(",")})`);
    eq(hits[0]!.severity, "error", "error");
    eq(hits[0]!.location?.path, "Zop.1.passives.SpawnThing", "path");
    assert(!r.ok, "an error fails the mod");
  });
  test("validator fixture: an unread key is an ignored-key info (not unknown-key); a map key named like a class is not a block", () => {
    const r = run("ignored-key");
    eq(r.findings.map((f) => `${f.code}:${f.severity}:${f.location?.path}`).join(" | "), "ignored-key:info:Zip.1.passives.SpawnThing.numbr", "one info, no unknown-key for the form named Rain");
    assert(/never reads/.test(r.findings[0]?.message ?? "") && /vanilla typo of number/.test(r.findings[0]?.message ?? ""), `message carries the note: ${r.findings[0]?.message}`);
  });
  test("validator fixture: the clean mod stays clean with a schema loaded", () => {
    const r = run("clean");
    eq(r.findings.map((f) => f.code).join(","), "", "no findings");
  });

  // ---- the tracked file -------------------------------------------------------------------
  test("component schema: the tracked editor/component-schema.json passes the shape check", () => {
    assert(existsSync(SCHEMA_PATH), `missing ${SCHEMA_PATH} (npm run build:component-schema)`);
    const s = loadComponentSchema(SCHEMA_PATH);
    assert(s !== null, "loads");
    eq(validateSchemaShape(s!).join("; "), "", "shape");
    assert(Object.keys(s!.components).length > 1000, `covers the component classes (${Object.keys(s!.components).length})`);
  });

  // ---- T1: vanilla must produce zero findings ------------------------------------------------
  const names = componentNameSet();
  if (!existsSync(join(EXTRACTED_DATA, "passives")) || names.size === 0 || !existsSync(SCHEMA_PATH)) {
    console.log("  (skipped: T1 vanilla component-key check needs .extracted/data, the editor/data component cache and editor/component-schema.json)");
    return;
  }
  const schema = loadComponentSchema(SCHEMA_PATH)!;
  const effect = new Set(schema.effectNames ?? []);
  test("component schema T1: every vanilla component block passes (0 unknown-key, 0 missing-required-key)", () => {
    const files: string[] = [];
    const rec = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) rec(p); else if (n.endsWith(".gon")) files.push(p); } };
    rec(EXTRACTED_DATA);
    let blocks = 0, checked = 0; const bad: string[] = [];
    for (const f of files) {
      const v = toValue(parse(readFileSync(f, "utf8")));
      forEachComponentBlock(v, (n) => names.has(n), (name, value, path) => {
        blocks++;
        if (value.t !== "obj") return;
        const r = resolveComponent(schema, name); if (!r) return;
        checked++;
        const c = checkComponentBlock(r, value, { patch: false, requireComplete: true, isDynamicChild: (n) => names.has(n) || effect.has(n) });
        for (const k of c.unknown) bad.push(`unknown-key ${relative(EXTRACTED_DATA, f)} ${path.join(".")}.${k}`);
        for (const k of c.missing) bad.push(`missing-required-key ${relative(EXTRACTED_DATA, f)} ${path.join(".")} ${k}`);
      });
    }
    console.log(`      vanilla: ${files.length} files, ${blocks} component blocks, ${checked} object blocks checked, ${bad.length} findings`);
    eq(bad.length, 0, `vanilla findings: ${bad.slice(0, 8).join(" | ")}`);
  });
  test("api.searchComponents (MCP search_components) returns the keys of the top matches", () => {
    const r = searchComponents("CatchProjectiles", { limit: 5 });
    assert(r.names.includes("CatchProjectiles"), `names: ${r.names.join(",")}`);
    const c = (r.schema ?? []).find((x) => x.name === "CatchProjectiles");
    assert(!!c, `schema entry for CatchProjectiles: ${JSON.stringify(r.schema ?? null).slice(0, 300)}`);
    assert(Array.isArray(c!.chain) && c!.chain[0] === "CatchProjectiles", "chain starts at the class");
    assert(c!.keys !== null && typeof c!.keys === "object", "keys object");
    eq((searchComponents("ZzNoSuchComponentZz").schema ?? []).length, 0, "no match, no schema rows");
  });
  test("component schema T1: vanilla-derived fixture mods (renamed .append copies) give 0 unknown-key / missing-required-key", () => {
    const src = ["passives/butcher_passives.gon", "items/head_items.gon", "characters/enemies.gon", "abilities/fighter_abilities.gon"].filter((p) => existsSync(join(EXTRACTED_DATA, p)));
    assert(src.length > 0, "vanilla files present");
    const modDir = mkdtempSync(join(tmpdir(), "mewged-vanilla-derived-"));
    let total = 0;
    for (const p of src) {
      const v = toValue(parse(readFileSync(join(EXTRACTED_DATA, p), "utf8")));
      if (v.t !== "obj") continue;
      // fresh names so the .append adds rather than collides; the bodies are vanilla verbatim
      const text = prettyRoot({ t: "obj", entries: v.entries.map((e) => ({ key: `Zz${e.key}`, value: e.value })) });
      mkdirSync(join(modDir, "data", dirname(p)), { recursive: true });
      writeFileSync(join(modDir, "data", `${p}.append`), text);
    }
    const r = validateMod("vanilla-derived", undefined, { modDir, nativeBuild: null, componentSchema: schema });
    total = r.findings.filter((f) => f.code === "unknown-key" || f.code === "missing-required-key").length;
    console.log(`      vanilla-derived fixtures: ${src.join(", ")} -> ${total} unknown-key/missing-required-key findings (${r.findings.length} findings in all)`);
    eq(total, 0, r.findings.filter((f) => f.code === "unknown-key" || f.code === "missing-required-key").slice(0, 6).map((f) => `${f.code} ${f.location?.path}`).join(" | "));
  });
}

