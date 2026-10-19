// The bindings manifest: bindings/<steamBuildId>.json is the single source of
// truth for everything the native layer pins to one game build (code
// signatures, raw hook RVAs, data/vtable addresses, constants, struct
// offsets) together with the anchors that let the port step find each value
// again in a new build. signatures.h / offsets.h are GENERATED from it
// (gen-headers.ts); nothing build-specific is typed by hand elsewhere.
// Schema: bindings/manifest.schema.json. Pure except load/save.

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { REPO_ROOT, isInside, touchesSaves, SafetyError } from "../repo.ts";
import { parsePattern, PatternError } from "./scan.ts";

export const BINDINGS_DIR = join(REPO_ROOT, "bindings");
export const MANIFEST_FORMAT = 1;
export const KINDS = ["function", "data", "vtable", "constant", "offset"];
export const LK_SHAPES = ["A", "B", "C", "D", "E"];
export const SCHEMA_FILE = "manifest.schema.json";

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RVA_RE = /^0x[0-9a-fA-F]+$/;
const VALUE_RE = /^-?(0x[0-9a-fA-F]+|\d+)$/;

/**
 * @typedef {{ enum: string, index: number }} EnumExposure           FwSymbol / FwData enumerator
 * @typedef {{ table: "FW_LK", index: number, shape: string, prototype?: string }} TableExposure
 * @typedef {{ field: string }} FieldExposure                         BuildInfo field
 * @typedef {{ macro: string }} MacroExposure                         offsets.h #define
 * @typedef {EnumExposure|TableExposure|FieldExposure|MacroExposure} Exposure
 * @typedef {{ pattern: string, exactLen: number, offset: number, wildcards: { at: number, len: number, why: string }[] }} Signature
 * @typedef {{
 *   name: string,
 *   kind: "function"|"data"|"vtable"|"constant"|"offset",
 *   rva?: string,
 *   value?: string,
 *   struct?: string,
 *   ctype?: string,
 *   slots?: number,
 *   signature?: Signature|null,
 *   anchors: Record<string, any>,
 *   consumers: string[],
 *   exposure: Exposure[],
 *   evidence: string[],
 *   verify?: Record<string, any>,
 *   note?: string,
 *   port?: { from: string, status: string, method: string, note?: string, candidates?: { rva: string, bytes: number, calls: number, via: string }[] },
 * }} Entry
 * @typedef {{
 *   steamBuildId: string, gameVersion: string, name: string, timeDateStamp: string, sizeOfImage: string,
 *   imageBase: string, exeSha256: string, exeSize: number, sdlVersion: string, linked?: string, note?: string,
 * }} BuildId
 * @typedef {{ format: number, build: BuildId, sigCap: number, entries: Entry[] }} Manifest
 */

export class ManifestError extends Error {
  /** @param {string} message @param {string[]} [problems] */
  constructor(message, problems = []) {
    super(message);
    this.name = "ManifestError";
    this.problems = problems;
  }
}

/** @param {string} s @returns {number} parse "0x5c" / "-0x8" / "172" */
export function parseValue(s) {
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const n = body.startsWith("0x") || body.startsWith("0X") ? parseInt(body.slice(2), 16) : parseInt(body, 10);
  return neg ? -n : n;
}

/** @param {number} n @returns {string} */
export function hex(n) {
  return (n < 0 ? "-0x" : "0x") + Math.abs(n).toString(16);
}

/**
 * Structural + referential validation. Never throws; returns every problem found.
 * @param {any} m
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function validateManifest(m) {
  /** @type {string[]} */
  const problems = [];
  const bad = (/** @type {string} */ s) => problems.push(s);
  if (!m || typeof m !== "object") return { ok: false, problems: ["manifest is not an object"] };
  if (m.format !== MANIFEST_FORMAT) bad(`format must be ${MANIFEST_FORMAT}, got ${JSON.stringify(m.format)}`);

  const b = m.build;
  if (!b || typeof b !== "object") bad("build block missing");
  else {
    for (const k of ["steamBuildId", "gameVersion", "name", "sdlVersion"]) if (typeof b[k] !== "string" || !b[k]) bad(`build.${k} must be a non-empty string`);
    if (typeof b.steamBuildId === "string" && !/^\d+$/.test(b.steamBuildId)) bad("build.steamBuildId must be decimal digits");
    for (const k of ["timeDateStamp", "sizeOfImage", "imageBase"]) if (typeof b[k] !== "string" || !RVA_RE.test(b[k])) bad(`build.${k} must be a 0x hex string`);
    if (typeof b.exeSha256 !== "string" || !/^[0-9a-f]{64}$/.test(b.exeSha256)) bad("build.exeSha256 must be 64 lowercase hex digits");
    if (!Number.isInteger(b.exeSize) || b.exeSize < 0) bad("build.exeSize must be a non-negative integer");
  }
  if (!Number.isInteger(m.sigCap) || m.sigCap <= 0) bad("sigCap must be a positive integer");
  const sigCap = Number.isInteger(m.sigCap) && m.sigCap > 0 ? m.sigCap : 128;

  if (!Array.isArray(m.entries)) {
    bad("entries must be an array");
    return { ok: false, problems };
  }
  /** @type {Map<string, any>} */
  const byName = new Map();
  for (const e of m.entries) {
    if (!e || typeof e !== "object" || typeof e.name !== "string") { bad("entry without a name"); continue; }
    if (byName.has(e.name)) bad(`duplicate entry name ${e.name}`);
    byName.set(e.name, e);
  }
  /** @type {Record<string, number[]>} */
  const indices = { FW_SYM_: [], FW_DATA_: [], FW_LK: [] };

  for (const e of m.entries) {
    if (!e || typeof e !== "object" || typeof e.name !== "string") continue;
    const n = e.name;
    if (!NAME_RE.test(n)) bad(`${n}: name must be a C identifier`);
    if (!KINDS.includes(e.kind)) bad(`${n}: kind must be one of ${KINDS.join("|")}, got ${JSON.stringify(e.kind)}`);
    const addr = e.kind === "function" || e.kind === "data" || e.kind === "vtable";
    if (addr && (typeof e.rva !== "string" || !RVA_RE.test(e.rva))) bad(`${n}: rva must be a 0x hex string`);
    if (!addr && (typeof e.value !== "string" || !VALUE_RE.test(e.value))) bad(`${n}: value must be a hex or decimal string`);
    if (e.kind === "offset" && (typeof e.struct !== "string" || !e.struct)) bad(`${n}: offset needs a struct name`);
    if (e.kind === "vtable" && !(Number.isInteger(e.slots) && e.slots > 0)) bad(`${n}: vtable needs a positive slots count`);
    if (e.kind !== "function" && e.signature) bad(`${n}: only functions carry a signature`);
    if (e.kind === "function" && e.signature !== null && e.signature !== undefined) {
      const s = e.signature;
      if (typeof s !== "object" || typeof s.pattern !== "string") bad(`${n}: signature must be null or { pattern, exactLen, offset, wildcards }`);
      else {
        try {
          const pat = parsePattern(s.pattern, sigCap);
          if (pat.length === 0) bad(`${n}: signature pattern is empty`);
          else if (!pat.mask[pat.length - 1]) bad(`${n}: signature ends in a wildcard`);
          if (Number.isInteger(s.exactLen) && s.exactLen !== pat.length) bad(`${n}: signature exactLen ${s.exactLen} != pattern length ${pat.length}`);
        } catch (err) {
          if (err instanceof PatternError) bad(`${n}: signature pattern invalid (${err.message}; sigCap ${sigCap})`);
          else throw err;
        }
        if (!Number.isInteger(s.offset)) bad(`${n}: signature.offset must be an integer`);
        if (!Array.isArray(s.wildcards)) bad(`${n}: signature.wildcards must be an array`);
      }
    }
    const anchors = e.anchors && typeof e.anchors === "object" ? e.anchors : null;
    if (!anchors) bad(`${n}: anchors must be an object`);
    if (e.kind === "offset" && anchors && !anchors.witness && anchors.unanchored !== true) bad(`${n}: offset needs anchors.witness or anchors.unanchored: true`);
    if (anchors) {
      const ref = (/** @type {string} */ what, /** @type {any} */ target, /** @type {string|null} */ kind) => {
        if (typeof target !== "string") { bad(`${n}: ${what} must name an entry`); return; }
        const t = byName.get(target);
        if (!t) bad(`${n}: ${what} refers to unknown entry ${target}`);
        else if (kind && t.kind !== kind) bad(`${n}: ${what} ${target} must be a ${kind} entry`);
      };
      if (anchors.witness) ref("witness.function", anchors.witness.function, "function");
      if (anchors.witness && anchors.witness.callee !== undefined) ref("witness.callee", anchors.witness.callee, "function");
      if (Array.isArray(anchors.callees)) for (const c of anchors.callees) ref("callee", c && c.name, "function");
      if (anchors.derive) {
        if (anchors.derive.vtable !== undefined) ref("derive.vtable", anchors.derive.vtable, "vtable");
        if (anchors.derive.table !== undefined) ref("derive.table", anchors.derive.table, "data");
      }
    }
    if (!Array.isArray(e.consumers)) bad(`${n}: consumers must be an array`);
    if (!Array.isArray(e.evidence)) bad(`${n}: evidence must be an array`);
    if (!Array.isArray(e.exposure)) bad(`${n}: exposure must be an array`);
    else {
      for (const x of e.exposure) {
        if (!x || typeof x !== "object") { bad(`${n}: exposure item must be an object`); continue; }
        const keys = ["enum", "table", "field", "macro"].filter((k) => x[k] !== undefined);
        if (keys.length !== 1) { bad(`${n}: exposure item needs exactly one of enum|table|field|macro`); continue; }
        if (x.enum !== undefined) {
          const fam = x.enum.startsWith("FW_SYM_") ? "FW_SYM_" : x.enum.startsWith("FW_DATA_") ? "FW_DATA_" : null;
          if (!fam) bad(`${n}: enum exposure must start with FW_SYM_ or FW_DATA_`);
          else if (fam === "FW_SYM_" && e.kind !== "function") bad(`${n}: FW_SYM_ exposure needs a function entry`);
          else if (fam === "FW_DATA_" && e.kind !== "data") bad(`${n}: FW_DATA_ exposure needs a data entry`);
          if (!Number.isInteger(x.index) || x.index < 0) bad(`${n}: enum exposure index must be a non-negative integer`);
          else if (fam) indices[fam].push(x.index);
        } else if (x.table !== undefined) {
          if (x.table !== "FW_LK") bad(`${n}: unknown table ${x.table}`);
          if (e.kind !== "function") bad(`${n}: FW_LK exposure needs a function entry`);
          if (!LK_SHAPES.includes(x.shape)) bad(`${n}: FW_LK shape must be one of ${LK_SHAPES.join("")}`);
          if (!Number.isInteger(x.index) || x.index < 0) bad(`${n}: table exposure index must be a non-negative integer`);
          else indices.FW_LK.push(x.index);
        } else if (x.field !== undefined && typeof x.field !== "string") bad(`${n}: field exposure must be a string`);
        else if (x.macro !== undefined && (typeof x.macro !== "string" || !NAME_RE.test(x.macro))) bad(`${n}: macro exposure must be a C identifier`);
      }
    }
  }
  for (const fam of /** @type {const} */ (["FW_SYM_", "FW_DATA_", "FW_LK"])) {
    const sorted = [...indices[fam]].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i] !== i) {
        bad(sorted[i] > i ? `${fam}: index ${i} missing (indices must be contiguous from 0)` : `${fam}: index ${sorted[i]} used twice`);
        break;
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Parse JSON text or an object into a validated Manifest. Throws ManifestError listing every problem.
 * @param {string|object} input
 * @returns {Manifest}
 */
export function parseManifest(input) {
  /** @type {any} */
  let obj = input;
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input);
    } catch (e) {
      throw new ManifestError(`manifest is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const v = validateManifest(obj);
  if (!v.ok) throw new ManifestError(`invalid manifest:\n  ${v.problems.join("\n  ")}`, v.problems);
  const m = /** @type {Manifest} */ (obj);
  for (const e of m.entries) {
    if (e.kind === "function" && e.signature === undefined) e.signature = null;
  }
  return m;
}

/** @param {string} path @returns {Manifest} */
export function loadManifest(path) {
  return parseManifest(readFileSync(path, "utf8"));
}

/**
 * Every bindings/<build>.json, sorted by Steam build id.
 * @param {string} [dir]
 * @returns {{ path: string, manifest: Manifest }[]}
 */
export function listManifests(dir = BINDINGS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== SCHEMA_FILE && /^\d+\.json$/.test(f))
    .map((f) => ({ path: join(dir, f), manifest: loadManifest(join(dir, f)) }))
    .sort((a, b) => Number(a.manifest.build.steamBuildId) - Number(b.manifest.build.steamBuildId));
}

/**
 * Serialize (and validate) a manifest. Writes only under bindings/; never a saves path.
 * @param {string} path
 * @param {Manifest} m
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {string} the JSON text
 */
export function saveManifest(path, m, opts = {}) {
  const abs = resolve(path);
  if (!isInside(BINDINGS_DIR, abs)) throw new SafetyError(`refusing to write a manifest outside bindings/: ${abs}`);
  if (touchesSaves(abs)) throw new SafetyError(`refusing to write a saves path: ${abs}`);
  if (!abs.toLowerCase().endsWith(".json") || basename(abs) === SCHEMA_FILE) throw new SafetyError(`manifest path must be bindings/<build>.json: ${abs}`);
  const v = validateManifest(m);
  if (!v.ok) throw new ManifestError(`refusing to save an invalid manifest:\n  ${v.problems.join("\n  ")}`, v.problems);
  const text = JSON.stringify(m, null, 2) + "\n";
  if (!opts.dryRun) writeFileSync(abs, text);
  return text;
}

/** @param {Manifest} m @param {string} name @returns {Entry|null} */
export function entry(m, name) {
  return m.entries.find((e) => e.name === name) || null;
}

/**
 * @param {Manifest} m
 * @param {(x: any) => boolean} pick
 * @returns {Entry[]} entries with a matching exposure, sorted by that exposure's index
 */
function table(m, pick) {
  /** @type {{ e: Entry, i: number }[]} */
  const rows = [];
  for (const e of m.entries) {
    const x = /** @type {any} */ (e.exposure.find(pick));
    if (x) rows.push({ e, i: x.index });
  }
  return rows.sort((a, b) => a.i - b.i).map((r) => r.e);
}

/** FwSymbol order. @param {Manifest} m */
export function symbolTable(m) {
  return table(m, (x) => typeof x.enum === "string" && x.enum.startsWith("FW_SYM_"));
}
/** FwData order. @param {Manifest} m */
export function dataTable(m) {
  return table(m, (x) => typeof x.enum === "string" && x.enum.startsWith("FW_DATA_"));
}
/** status_engine's name-lookup hook table order. @param {Manifest} m */
export function lkTable(m) {
  return table(m, (x) => x.table === "FW_LK");
}
