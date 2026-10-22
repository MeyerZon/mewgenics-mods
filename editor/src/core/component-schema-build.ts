// Building editor/component-schema.json from the RE fragments (.analysis/component-schema-<tag>.json, one per
// Ghidra session) — the pure parts of scripts/build-component-schema.ts: the fragment shape check, the merge, and
// the vanilla cross-check that guarantees vanilla data never trips `unknown-key` / `missing-required-key`
// (a key vanilla writes that RE did not find opens the component; a required key vanilla omits is demoted).

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./gon/parser.ts";
import { toValue } from "./gon/value.ts";
import { CHILDREN, STATUSES, componentSpecErrors, forEachComponentBlock, keySpecErrors, resolveComponent, SCHEMA_VERSION, validateSchemaShape } from "./component-schema.ts";
import type { ChildrenKind, ComponentSchema, ComponentSpec, KeySpec, ScalarSpec, SharedSpec, SchemaCoverage, SpecStatus } from "./component-schema.ts";

export interface Fragment {
  schema: number;
  agent: string;
  first?: string;
  last?: string;
  components: Record<string, ComponentSpec>;
  shared?: Record<string, SharedSpec>;
  /**
   * Follow-up sessions' changes to components another fragment defines (applied after every fragment's components,
   * in fragment order): `keys` adds / replaces a key (`null` deletes it), `includes` are added, `notes` appended,
   * the other fields replace. `open: false` also clears the fragment's `vanillaMissed` — the cross-check re-adds any
   * vanilla key still not accounted for, so a premature close cannot hide one.
   */
  amend?: Record<string, ComponentAmend>;
}

export interface ComponentAmend {
  base?: string | null;
  status?: SpecStatus;
  open?: boolean;
  children?: ChildrenKind | null;
  scalar?: string | ScalarSpec | null;
  keys?: Record<string, KeySpec | null>;
  includes?: string[];
  notes?: string;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** Shape errors of one fragment, each prefixed with `label` (the file name). */
export function validateFragment(f: unknown, label: string): string[] {
  if (!isObj(f)) return [`${label}: not a JSON object`];
  const e: string[] = [];
  if (f.schema !== SCHEMA_VERSION) e.push(`${label}: schema must be ${SCHEMA_VERSION}`);
  if (typeof f.agent !== "string" || !f.agent) e.push(`${label}: agent must be a non-empty string`);
  if (!isObj(f.components)) return [...e, `${label}: components must be an object`];
  for (const [n, c] of Object.entries(f.components)) e.push(...componentSpecErrors(c, `${label}: ${n}`));
  if (f.shared !== undefined) {
    if (!isObj(f.shared)) e.push(`${label}: shared must be an object`);
    else for (const [n, s] of Object.entries(f.shared)) {
      if (!n.startsWith("@")) e.push(`${label}: shared.${n}: names start with @`);
      if (!isObj(s) || !isObj(s.keys)) e.push(`${label}: shared.${n}.keys must be an object`);
    }
  }
  if (f.amend !== undefined) {
    if (!isObj(f.amend)) e.push(`${label}: amend must be an object`);
    else for (const [n, a] of Object.entries(f.amend)) e.push(...amendErrors(a, `${label}: amend.${n}`));
  }
  return e;
}

function amendErrors(a: unknown, where: string): string[] {
  if (!isObj(a)) return [`${where}: not an object`];
  const e: string[] = [];
  const known = new Set(["base", "status", "open", "children", "scalar", "keys", "includes", "notes"]);
  for (const k of Object.keys(a)) if (!known.has(k)) e.push(`${where}.${k}: not an amendable field`);
  if (a.base !== undefined && !(a.base === null || typeof a.base === "string")) e.push(`${where}.base: must be a class name or null`);
  if (a.status !== undefined && !STATUSES.includes(a.status as SpecStatus)) e.push(`${where}.status: ${JSON.stringify(a.status)} is not one of ${STATUSES.join("|")}`);
  if (a.open !== undefined && typeof a.open !== "boolean") e.push(`${where}.open: must be a boolean`);
  if (a.children !== undefined && !(a.children === null || CHILDREN.includes(a.children as ChildrenKind))) e.push(`${where}.children: ${JSON.stringify(a.children)} is not null|${CHILDREN.join("|")}`);
  if (a.scalar !== undefined && !(a.scalar === null || typeof a.scalar === "string" || isObj(a.scalar))) e.push(`${where}.scalar: must be a string, an object or null`);
  if (a.includes !== undefined && !(Array.isArray(a.includes) && a.includes.every((x) => typeof x === "string" && x.startsWith("@")))) e.push(`${where}.includes: must be an array of @names`);
  if (a.notes !== undefined && typeof a.notes !== "string") e.push(`${where}.notes: must be a string`);
  if (a.keys !== undefined) {
    if (!isObj(a.keys)) e.push(`${where}.keys: must be an object`);
    else for (const [k, v] of Object.entries(a.keys)) if (v !== null) e.push(...keySpecErrors(v, `${where}.keys.${k}`));
  }
  return e;
}

/** Per component: how many object-form blocks vanilla has and how often each literal key appears. */
export type VanillaUsage = Record<string, { objUses: number; keys: Record<string, number>; dynamicChildren?: Record<string, number> }>;

/**
 * Survey the vanilla data tree through the same traversal the validator uses (forEachComponentBlock).
 * A child whose name is a component (or `isDynamic`) is a nested block / dynamic child, not a literal key.
 */
export function surveyVanilla(dataRoot: string, isComponent: (n: string) => boolean, isDynamic: (n: string) => boolean = () => false, isMap: (n: string) => boolean = () => false): VanillaUsage {
  const out: VanillaUsage = {};
  if (!existsSync(dataRoot)) return out;
  const files: string[] = [];
  const rec = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) rec(p);
      else if (n.endsWith(".gon")) files.push(p);
    }
  };
  rec(dataRoot);
  for (const f of files) {
    let v;
    try {
      v = toValue(parse(readFileSync(f, "utf8")));
    } catch {
      continue;
    }
    forEachComponentBlock(v, isComponent, (name, value) => {
      if (value.t !== "obj") return;
      const u = (out[name] ??= { objUses: 0, keys: {}, dynamicChildren: {} });
      u.objUses++;
      for (const e of value.entries) {
        if (isComponent(e.key) || isDynamic(e.key)) u.dynamicChildren![e.key] = (u.dynamicChildren![e.key] ?? 0) + 1;
        else u.keys[e.key] = (u.keys[e.key] ?? 0) + 1;
      }
    }, isMap);
  }
  return out;
}

export interface MergeOptions {
  build: string;
  vanilla?: VanillaUsage;
  effectNames?: string[];
}

export interface MergeResult {
  schema: ComponentSchema;
  errors: string[];
  /** human-readable notes about what the vanilla cross-check changed */
  adjustments: string[];
}

const sortObj = <T>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** Merge fragments into one schema (deterministic order; no timestamps, so `--check` is stable). */
export function mergeFragments(frags: Fragment[], o: MergeOptions): MergeResult {
  const errors: string[] = [];
  const adjustments: string[] = [];
  const components: Record<string, ComponentSpec> = {};
  const owner: Record<string, string> = {};
  const shared: Record<string, SharedSpec> = {};
  const sharedOwner: Record<string, string> = {};
  for (const f of frags) {
    for (const [n, c] of Object.entries(f.components)) {
      if (n in components) {
        errors.push(`duplicate component ${n}: in ${owner[n]} and ${f.agent}`);
        continue;
      }
      owner[n] = f.agent;
      components[n] = {
        ...c, agent: f.agent, keys: sortObj(structuredClone(c.keys)), includes: [...(c.includes ?? [])],
        vanillaMissed: [...(c.vanillaMissed ?? [])], scalar: c.scalar ?? null, notes: c.notes ?? "",
      };
    }
    for (const [n, s] of Object.entries(f.shared ?? {})) {
      if (n in shared) {
        // the same shared parser found by two sessions: union the keys (first writer wins per key)
        shared[n] = { ...shared[n]!, keys: sortObj({ ...s.keys, ...shared[n]!.keys }) };
        adjustments.push(`shared ${n} defined by ${sharedOwner[n]} and ${f.agent}: keys unioned`);
        continue;
      }
      sharedOwner[n] = f.agent;
      shared[n] = { ...structuredClone(s), keys: sortObj(structuredClone(s.keys)) };
    }
  }
  for (const f of frags) {
    for (const [n, a] of Object.entries(f.amend ?? {})) {
      const c = components[n];
      if (!c) {
        errors.push(`${f.agent} amends ${n}, which no fragment defines`);
        continue;
      }
      const keys = { ...c.keys };
      for (const [k, v] of Object.entries(a.keys ?? {})) {
        if (v === null) delete keys[k];
        else keys[k] = structuredClone(v);
      }
      components[n] = {
        ...c,
        ...(a.base !== undefined ? { base: a.base } : {}),
        ...(a.status !== undefined ? { status: a.status } : {}),
        ...(a.children !== undefined ? { children: a.children } : {}),
        ...(a.scalar !== undefined ? { scalar: a.scalar } : {}),
        ...(a.open !== undefined ? { open: a.open } : {}),
        ...(a.open === false ? { vanillaMissed: [] } : {}),
        keys: sortObj(keys),
        includes: [...new Set([...c.includes, ...(a.includes ?? [])])],
        notes: a.notes ? [c.notes, a.notes].filter(Boolean).join(" | ") : c.notes,
        agent: c.agent?.split("+").includes(f.agent) ? c.agent : `${c.agent}+${f.agent}`,
      };
      owner[n] = `${owner[n]}+${f.agent}`;
    }
  }
  for (const [n, c] of Object.entries(components)) {
    for (const inc of c.includes) if (!(inc in shared)) errors.push(`${n} (${owner[n]}) includes ${inc}, which no fragment defines under shared`);
  }
  const schema: ComponentSchema = {
    schemaVersion: SCHEMA_VERSION,
    build: o.build,
    ...(o.effectNames ? { effectNames: [...new Set(o.effectNames)].sort() } : {}),
    components: sortObj(components),
    shared: sortObj(shared),
    sources: [...new Set(frags.map((f) => f.agent))].sort(),
  };

  // ---- vanilla cross-check -----------------------------------------------------------------
  let vanillaKeys = 0;
  let vanillaKeysFound = 0;
  let vanillaKeysUnread = 0;
  let vanillaMapKeys = 0;
  if (o.vanilla) {
    for (const [name, u] of Object.entries(o.vanilla).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const r = resolveComponent(schema, name);
      if (!r) continue;
      const c = schema.components[name]!;
      const top = new Set(Object.keys(r.keys).map((k) => k.split(".")[0]!));
      for (const k of Object.keys(u.keys).sort()) {
        if (r.children === "any" && !top.has(k)) {
          vanillaMapKeys++;
          continue;
        }
        vanillaKeys++;
        if (r.keys[k]?.unread) {
          vanillaKeysUnread++;
          continue;
        }
        if (top.has(k)) {
          vanillaKeysFound++;
          continue;
        }
        if (!c.vanillaMissed.includes(k)) c.vanillaMissed.push(k);
        if (!c.open) adjustments.push(`${name}: opened — vanilla writes "${k}", which RE did not find`);
        c.open = true;
      }
      c.vanillaMissed.sort();
      if (Object.keys(u.dynamicChildren ?? {}).length > 0 && !r.children) {
        c.children = "effects";
        adjustments.push(`${name}: children set to effects — vanilla nests component/effect names (${Object.keys(u.dynamicChildren!).slice(0, 4).join(", ")})`);
      }
      for (const k of r.required) {
        const n = u.keys[k] ?? 0;
        if (n < u.objUses) {
          const holder = r.keys[k]!.from;
          const spec = holder.startsWith("@") ? schema.shared[holder]!.keys[k]! : schema.components[holder]!.keys[k]!;
          if (spec.required) {
            spec.required = false;
            spec.note = [spec.note, `not required: vanilla omits it in ${u.objUses - n} of ${u.objUses} ${name} blocks`].filter(Boolean).join("; ");
            adjustments.push(`${holder}.${k}: required demoted (vanilla ${name} omits it ${u.objUses - n}/${u.objUses})`);
          }
        }
      }
    }
  }
  schema.coverage = coverage(schema, o.vanilla, vanillaKeys, vanillaKeysFound, vanillaKeysUnread, vanillaMapKeys);
  errors.push(...validateSchemaShape(schema));
  return { schema, errors, adjustments };
}

function coverage(s: ComponentSchema, vanilla: VanillaUsage | undefined, vanillaKeys: number, vanillaKeysFound: number, vanillaKeysUnread: number, vanillaMapKeys: number): SchemaCoverage {
  const cs = Object.values(s.components);
  const vanillaObj = vanilla ? Object.keys(vanilla).filter((n) => n in s.components && vanilla[n]!.objUses > 0) : [];
  const vanillaOpen = vanillaObj.filter((n) => resolveComponent(s, n)!.open).length;
  const allKeys = [...cs.flatMap((c) => Object.values(c.keys)), ...Object.values(s.shared).flatMap((x) => Object.values(x.keys))];
  return {
    components: cs.length,
    mapped: cs.filter((c) => c.status === "mapped").length,
    noKeys: cs.filter((c) => c.status === "no-keys").length,
    mechanical: cs.filter((c) => c.status === "mechanical").length,
    unresolved: cs.filter((c) => c.status === "unresolved").length,
    open: cs.filter((c) => c.open).length,
    keys: allKeys.length,
    keysObserved: allKeys.filter((k) => k.confidence === "observed").length,
    keysInferred: allKeys.filter((k) => k.confidence === "inferred").length,
    vanillaComponents: vanilla ? Object.keys(vanilla).filter((n) => n in s.components).length : 0,
    vanillaKeys,
    vanillaKeysFound,
    vanillaKeysUnread,
    vanillaOpen,
    vanillaClosed: vanillaObj.length - vanillaOpen,
    vanillaMapKeys,
  };
}
