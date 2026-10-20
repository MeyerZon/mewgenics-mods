// Port: take the manifest of a known build and find every entry again in a new exe.
//
// Ladder per function (first rung that yields exactly one answer wins):
//   1. the stored (masked) signature matches once: same RVA -> ported-exact, else ported-rescan
//   2. a unique __FUNCSIG__ / literal string anchor, xref'd by rip-relative lea from exactly one
//      .pdata function whose size/call count is within tolerance -> ported-anchor (funcsig-xref)
//   3. an already-ported caller whose k-th call targeted this function -> ported-anchor (caller-ordinal)
//   4. the .pdata function right after an already-ported neighbour (anchors.after) -> ported-anchor
//   5. several candidates -> ambiguous (all listed); none -> failed. `resolve` lets an agent or a
//      human supply the answer (ported-anchor, method "resolved").
// Data: witness rip-ref ordinal inside a ported function -> ported-witness; vtables via RTTI and
// constants via a slot body / table index -> ported-derived; struct offsets via a witness byte
// pattern -> ported-witness when unchanged, PROPOSED (value not applied) when the displacement
// moved. Unanchored entries are carried over and reported as needs-human, never guessed.
// Every ported function gets a fresh signature and fresh anchors on the new image.
// Pure over (old manifest, new pe, new buf); node built-ins only.

import { createHash } from "node:crypto";
import { parsePattern, scanExec } from "./scan.ts";
import { makeSignature } from "./siggen.ts";
import { harvestFunction, harvestManifest, findString, findStringXrefs, findRtti, decodeFunction, constantSources } from "./harvest.ts";
import type { FunctionHarvest, RipRef } from "./harvest.ts";
import { hex, parseValue, entry } from "./manifest.ts";
import type { Manifest, Entry, PortCandidate } from "./manifest.ts";
import type { Pe } from "./pe.ts";

export const PORT_STATUSES = ["ported-exact", "ported-rescan", "ported-anchor", "ported-witness", "ported-derived", "proposed", "ambiguous", "failed", "needs-human"];

export type Candidate = PortCandidate;
export interface PortRow {
  name: string;
  kind: string;
  oldValue: string;
  newValue: string | null;
  status: string;
  method: string;
  detail: string;
  candidates?: Candidate[];
}
export interface PortResult {
  manifest: Manifest;
  rows: PortRow[];
  summary: Record<string, number>;
  needsAgent: PortRow[];
  from: string;
}
export interface PortOptions {
  steamBuildId: string;
  gameVersion?: string;
  name?: string;
  resolve?: Record<string, string>;
}

/** @returns the statically linked SDL version from its source path strings */
export function detectSdlVersion(buf: Buffer): string | null {
  const needle = Buffer.from("release-", "latin1");
  let i = 0;
  while ((i = buf.indexOf(needle, i)) !== -1) {
    const m = /^release-(\d+\.\d+\.\d+)\\src\\/.exec(buf.toString("latin1", i, i + 40));
    if (m) return m[1];
    i += 8;
  }
  return null;
}

interface Pending {
  e: Entry;
  why: string[];
  cands?: Candidate[];
}

export function portManifest(old: Manifest, pe: Pe, buf: Buffer, opts: PortOptions): PortResult {
  const out: Manifest = JSON.parse(JSON.stringify(old));
  const from = old.build.steamBuildId;
  const gameVersion = opts.gameVersion || old.build.gameVersion;
  const sdl = detectSdlVersion(buf);
  out.build = {
    ...old.build,
    steamBuildId: opts.steamBuildId,
    gameVersion,
    name: opts.name || `${gameVersion} (steam ${opts.steamBuildId})`,
    timeDateStamp: hex(pe.timeDateStamp),
    sizeOfImage: hex(pe.sizeOfImage),
    imageBase: hex(pe.imageBase),
    exeSha256: createHash("sha256").update(buf).digest("hex"),
    exeSize: buf.length,
    sdlVersion: sdl || old.build.sdlVersion,
    note: `ported from build ${from} by tools/bindings/port.ts${opts.resolve && Object.keys(opts.resolve).length ? ` with ${Object.keys(opts.resolve).length} resolved entr${Object.keys(opts.resolve).length === 1 ? "y" : "ies"}` : ""}`,
  };
  delete out.build.linked;
  const resolve = opts.resolve || {};

  const rows: PortRow[] = [];
  /** name -> new rva (functions that ported) */
  const newRva = new Map<string, number>();
  const hcache = new Map<string, FunctionHarvest>();
  const harvestNew = (name: string, rva: number): FunctionHarvest => {
    const k = `${name}@${rva}`;
    let h = hcache.get(k);
    if (!h) { h = harvestFunction(pe, buf, rva, {}); hcache.set(k, h); }
    return h;
  };
  const candidateStats = (e: Entry, rva: number): { bytes: number; calls: number } => {
    const h = harvestNew(e.name, rva);
    return { bytes: h.cfgLite.bytes, calls: h.cfgLite.calls };
  };
  /** size/call-count tolerance against the old cfgLite (a recompile changes both a little) */
  const withinTolerance = (e: Entry, rva: number): boolean => {
    const old = e.anchors.cfgLite;
    if (!old || !old.bytes) return true;
    const s = candidateStats(e, rva);
    const bytesOk = Math.abs(s.bytes - old.bytes) <= Math.max(16, 0.35 * old.bytes);
    const callsOk = Math.abs(s.calls - (old.calls || 0)) <= Math.max(2, 0.25 * (old.calls || 0));
    return bytesOk && callsOk;
  };
  const signed = (n: number): string => (n >= 0 ? "+" : "") + n;
  /**
   * Record the row and the entry's port block. `oldValue` is the value before this port; a branch that overwrites
   * `e.rva`/`e.value` before calling finish must pass what it saw, or the report's "old" column shows the new value.
   */
  const finish = (e: Entry, status: string, method: string, detail: string, newValue: string | null, candidates?: Candidate[], oldValue: string = e.rva || e.value || ""): PortRow => {
    const row: PortRow = { name: e.name, kind: e.kind, oldValue, newValue, status, method, detail, candidates };
    rows.push(row);
    e.port = { from, status, method, note: detail };
    if (candidates && candidates.length) e.port.candidates = candidates; // lets seed.ts name the new side
    return row;
  };
  const portFunction = (e: Entry, rva: number, status: string, method: string, detail: string): void => {
    const was = e.rva || "";
    e.rva = hex(rva);
    newRva.set(e.name, rva);
    const sig = makeSignature(pe, buf, rva, { minLen: 12, cap: out.sigCap });
    if (sig.ok) e.signature = sig.signature;
    else { e.signature = null; detail += `; no unique signature on the new build (${sig.reason})`; }
    finish(e, status, method, detail, hex(rva), undefined, was);
  };

  // ---- functions: rung 1 (signature) + resolve ---------------------------------------
  const fns = out.entries.filter((e) => e.kind === "function");
  let pending: Pending[] = [];
  for (const e of fns) {
    const oldRva = parseInt(e.rva || "0", 16);
    if (resolve[e.name]) { portFunction(e, parseInt(resolve[e.name], 16), "ported-anchor", "resolved", `supplied: ${resolve[e.name]}`); continue; }
    const why: string[] = [];
    if (e.signature) {
      const r = scanExec(pe, buf, parsePattern(e.signature.pattern, out.sigCap));
      if (r.count === 1) {
        const rva = r.hits[0] + e.signature.offset;
        portFunction(e, rva, rva === oldRva ? "ported-exact" : "ported-rescan", "signature", `signature matched once at ${hex(rva)}${rva === oldRva ? " (unchanged)" : ` (was ${e.rva})`}`);
        continue;
      }
      why.push(`signature: ${r.count} matches`);
    } else why.push("no signature");
    pending.push({ e, why });
  }

  // ---- rungs 2-4, iterated: later rungs need already-ported neighbours ---------------
  let progress = true;
  while (progress && pending.length) {
    progress = false;
    const still: Pending[] = [];
    for (const p of pending) {
      const e = p.e;
      let cands: Candidate[] | null = null;
      // rung 2: unique string anchors
      const anchorsStrings = (e.anchors.strings || []).filter((s) => s.unique && (s.role === "funcsig" || s.role === "literal"));
      for (const s of anchorsStrings) {
        const fs = findString(pe, buf, s.text);
        if (fs.rva === null || fs.count !== 1) { p.why.push(`${s.role} string ${fs.count === 0 ? "missing" : "not unique"} on the new build`); continue; }
        const fnsHit = [...new Set(findStringXrefs(pe, buf, fs.rva).map((x) => (x.fn ? x.fn.begin : -1)).filter((x) => x >= 0))];
        const here: Candidate[] = fnsHit.map((rva) => ({ rva: hex(rva), ...candidateStats(e, rva), via: `${s.role} xref` }));
        cands = cands === null ? here : cands.filter((c) => here.some((h) => h.rva === c.rva));
      }
      let method = "funcsig-xref";
      // rung 3: caller ordinal
      if (!cands || cands.length === 0) {
        const viaCallers: Candidate[] = [];
        for (const c of fns) {
          if (!newRva.has(c.name) || !Array.isArray(c.anchors.callees)) continue;
          for (const cal of c.anchors.callees) {
            if (cal.name !== e.name) continue;
            const d = decodeFunction(pe, buf, newRva.get(c.name) as number);
            const calls = d.instrs.filter((x) => x.ins.kind === "call" && x.ins.reloc && x.ins.reloc.why === "E8 rel32" && x.ins.relTarget !== null).map((x) => x.at + x.ins.length + (x.ins.relTarget as number));
            const t = calls[cal.ordinal];
            if (t !== undefined && pe.sectionOf(t)) viaCallers.push({ rva: hex(t), ...candidateStats(e, t), via: `call #${cal.ordinal} of ${c.name}` });
          }
        }
        if (viaCallers.length) { cands = viaCallers.filter((c, i, a) => a.findIndex((x) => x.rva === c.rva) === i); method = "caller-ordinal"; }
      }
      // rung 4: successor of a ported neighbour in .pdata
      if ((!cands || cands.length === 0) && e.anchors.after && e.anchors.after.function && newRva.has(e.anchors.after.function)) {
        const nb = pe.pdata.find(newRva.get(e.anchors.after.function) as number);
        if (nb) {
          let lo = 0, hi = pe.pdata.count - 1, idx = -1;
          while (lo <= hi) { const mid = (lo + hi) >> 1; if (pe.pdata.get(mid).begin >= nb.end) { idx = mid; hi = mid - 1; } else lo = mid + 1; }
          if (idx >= 0) { const t = pe.pdata.get(idx).begin; cands = [{ rva: hex(t), ...candidateStats(e, t), via: `.pdata successor of ${e.anchors.after.function}` }]; method = "pdata-successor"; }
        }
      }
      if (cands && cands.length === 1) {
        const rva = parseInt(cands[0].rva, 16);
        if (withinTolerance(e, rva)) {
          const o = e.anchors.cfgLite;
          const drift = o && o.bytes ? `; size ${signed(cands[0].bytes - o.bytes)} / calls ${signed(cands[0].calls - (o.calls || 0))} vs old` : "";
          portFunction(e, rva, "ported-anchor", method, `${cands[0].via} -> ${cands[0].rva} (${cands[0].bytes} bytes, ${cands[0].calls} calls${drift}; was ${e.rva})`);
          progress = true;
          continue;
        }
        p.why.push(`${cands[0].via} gives ${cands[0].rva} but size/calls differ too much (${cands[0].bytes} bytes, ${cands[0].calls} calls vs ${e.anchors.cfgLite ? `${e.anchors.cfgLite.bytes}/${e.anchors.cfgLite.calls}` : "?"})`);
        still.push({ ...p, cands });
        continue;
      }
      if (cands && cands.length > 1) { still.push({ ...p, cands }); continue; }
      still.push(p);
    }
    pending = still;
  }
  for (const p of pending) {
    const e = p.e;
    if (p.cands && p.cands.length) {
      finish(e, "ambiguous", "candidates", `${p.cands.length} candidate(s): ${p.cands.map((c) => `${c.rva} (${c.bytes} bytes, ${c.calls} calls; ${c.via})`).join(", ")}; ${p.why.join("; ")}`, null, p.cands);
    } else {
      const reasons = p.why.length ? p.why.join("; ") : "no unique funcsig/literal string anchor and no ported caller";
      finish(e, "failed", "none", `${reasons}; no ported caller names it${e.anchors.after ? "" : "; no .pdata neighbour anchor"}`, null);
    }
  }

  // ---- vtables (RTTI) ---------------------------------------------------------------
  for (const e of out.entries) {
    if (e.kind !== "vtable") continue;
    const td = e.anchors.rtti && e.anchors.rtti.typeDescriptorName;
    if (!td) { finish(e, "needs-human", "none", "no RTTI anchor", null); continue; }
    const r = findRtti(pe, buf, td);
    if (!r) { finish(e, "failed", "rtti", `RTTI chain for ${td} not found`, null); continue; }
    const was = e.rva || "";
    const same = hex(r.vftable) === was;
    e.rva = hex(r.vftable);
    finish(e, "ported-derived", "rtti", `${td} -> vftable ${hex(r.vftable)} (col ${hex(r.col)})${same ? " (unchanged)" : ` (was ${was})`}`, e.rva, undefined, was);
  }
  // ---- constants --------------------------------------------------------------------
  for (const e of out.entries) {
    if (e.kind !== "constant") continue;
    const a = e.anchors;
    if ((a.derive && a.derive.vtable) || (a.witness && a.witness.callee)) {
      // every independent source must agree; a split is a human decision, never a coin toss
      const src = constantSources(out, pe, buf, e);
      const vals = [src.slot, src.arg].filter((v): v is number => v !== null);
      const was = e.value || "";
      if (!vals.length) { finish(e, "failed", "derive", src.notes.join("; "), null); continue; }
      if (vals.some((v) => v !== vals[0])) { finish(e, "needs-human", "derive", `sources disagree: ${src.notes.join("; ")}; value ${was} kept`, null); continue; }
      const v = vals[0];
      e.value = hex(v);
      const method = src.slot !== null && src.arg !== null ? "slot-body+call-arg" : src.slot !== null ? "slot-body" : "call-arg";
      finish(e, "ported-derived", method, `${src.notes.join("; ")}${vals.length > 1 ? " (agree)" : ""}${was === hex(v) ? " (unchanged)" : ` (was ${was})`}`, e.value, undefined, was);
      continue;
    }
    finish(e, "needs-human", "none", e.anchors.unanchored ? "unanchored constant carried over unchanged; verify by hand" : "no derivation anchor", e.value || null);
  }
  // ---- data: witnesses first, then table derivations -----------------------------------
  const sdlChanged = sdl !== null && old.build.sdlVersion && sdl !== old.build.sdlVersion;
  for (const e of out.entries) {
    if (e.kind !== "data" || !(e.anchors.witness && e.anchors.witness.function)) continue;
    const w = e.anchors.witness;
    const f = entry(out, w.function);
    const frva = f ? newRva.get(f.name) : undefined;
    if (!f || frva === undefined) { finish(e, "failed", "witness", `witness function ${w.function} did not port`, null); continue; }
    const h = harvestNew(f.name, frva);
    const wantOp = typeof w.kind === "string" && w.kind.startsWith("rip-") ? w.kind.slice(4) : null;
    let ref: RipRef | undefined = typeof w.ripRefOrdinal === "number" && Number.isInteger(w.ripRefOrdinal) ? h.ripRefs[w.ripRefOrdinal] : undefined;
    let note = `rip ref #${w.ripRefOrdinal} in ${w.function}`;
    if (!ref || (wantOp && ref.opcode !== wantOp)) {
      const same = wantOp ? h.ripRefs.filter((r) => r.opcode === wantOp) : [];
      if (same.length === 1) { ref = same[0]; w.ripRefOrdinal = ref.ordinal; note = `the only rip-${wantOp} ref (#${ref.ordinal}) in ${w.function}; ordinal shifted`; }
      else { finish(e, "failed", "witness", `${w.function} has no rip ref #${w.ripRefOrdinal}${wantOp ? ` of kind ${wantOp} (${same.length} such refs)` : ""}`, null); continue; }
    }
    const was = e.rva;
    e.rva = ref.target;
    finish(e, "ported-witness", "witness", `${note} -> ${ref.target}${was === ref.target ? " (unchanged)" : ` (was ${was})`}`, e.rva, undefined, was || "");
  }
  for (const e of out.entries) {
    if (e.kind !== "data" || e.port) continue;
    const d = e.anchors.derive;
    if (d && d.table) {
      const t = entry(out, d.table);
      if (!t || !t.port || !t.port.status.startsWith("ported")) { finish(e, "failed", "table", `${d.table} did not port`, null); continue; }
      if (sdlChanged) { finish(e, "needs-human", "table", `SDL changed ${old.build.sdlVersion} -> ${sdl}: the DYNAPI slot order must be re-verified before trusting index ${d.index}`, null); continue; }
      const v = parseInt(t.rva || "0", 16) + 8 * d.index!;
      const was = e.rva;
      e.rva = hex(v);
      finish(e, "ported-derived", "table", `${d.table} + 8*${d.index} = ${hex(v)}${was === hex(v) ? " (unchanged)" : ` (was ${was})`}`, e.rva, undefined, was || "");
      continue;
    }
    finish(e, "needs-human", "none", e.anchors.unanchored ? "unanchored data carried over unchanged" : "no witness/derivation anchor", e.rva || null);
  }
  // ---- struct offsets ---------------------------------------------------------------
  for (const e of out.entries) {
    if (e.kind !== "offset") continue;
    const w = e.anchors.witness;
    if (!w || !w.function || !w.pattern) { finish(e, "needs-human", "none", "unanchored offset carried over unchanged; verify by hand (or add a witness pattern)", e.value || null); continue; }
    const frva = newRva.get(w.function);
    if (frva === undefined) { finish(e, "failed", "witness", `witness function ${w.function} did not port`, null); continue; }
    const d = decodeFunction(pe, buf, frva);
    const pat = parsePattern(w.pattern, out.sigCap);
    let seen = 0, at = -1;
    for (let i = 0; i + pat.length <= d.bytes.length; i++) {
      let k = 0;
      for (; k < pat.length; k++) if (pat.mask[k] && d.bytes[i + k] !== pat.bytes[k]) break;
      if (k === pat.length && seen++ === (w.nth || 0)) { at = i; break; }
    }
    if (at < 0) { finish(e, "failed", "witness", `pattern ${w.pattern} (#${w.nth || 0}) not found in ${w.function}`, null); continue; }
    const size = w.dispSize || 1;
    const off = at + (w.dispAt || 0);
    let disp: number;
    if (size === 1) { disp = d.bytes[off]; if (disp > 127) disp -= 256; }
    else { const v = (d.bytes[off] | (d.bytes[off + 1] << 8) | (d.bytes[off + 2] << 16) | (d.bytes[off + 3] << 24)) | 0; disp = v; }
    const oldV = parseValue(e.value || "0");
    if (disp === oldV) finish(e, "ported-witness", "witness", `${w.function}: ${w.pattern} #${w.nth || 0} still reads ${hex(disp)}`, e.value || null);
    else finish(e, "proposed", "witness", `proposed ${hex(oldV)} -> ${hex(disp)} (${w.function}: ${w.pattern} #${w.nth || 0}); NOT applied, needs a green T2`, hex(disp));
  }

  // ---- refresh anchors on the new image (functions that ported) ----------------------
  const harvested = harvestManifest(pe, buf, out);
  for (const e of out.entries) {
    const h = entry(harvested.manifest, e.name);
    if (!h) continue;
    if (e.kind === "function" && e.port && e.port.status.startsWith("ported")) {
      const manual = (e.anchors.strings || []).filter((s) => s.role === "literal");
      e.anchors = { ...e.anchors, ...h.anchors, strings: [...manual.map((s) => ({ ...s, unique: findString(pe, buf, s.text).count === 1 })), ...(h.anchors.strings || []).filter((s) => s.role !== "literal")] };
    }
  }

  const summary: Record<string, number> = { total: rows.length };
  for (const r of rows) summary[r.status] = (summary[r.status] || 0) + 1;
  const needsAgent = rows.filter((r) => r.status === "ambiguous" || r.status === "failed");
  return { manifest: out, rows, summary, needsAgent, from };
}

/** @returns markdown */
export function renderPortReport(r: PortResult, opts: { generatedAt?: string } = {}): string {
  const m = r.manifest;
  const s = r.summary;
  const order = PORT_STATUSES.filter((k) => s[k]);
  const out: string[] = [];
  out.push(`# Port report ${r.from} -> ${m.build.steamBuildId}`);
  out.push(`generated ${opts.generatedAt || "(unset)"}; new exe sha256 ${m.build.exeSha256}, TimeDateStamp ${m.build.timeDateStamp}, SizeOfImage ${m.build.sizeOfImage}, SDL ${m.build.sdlVersion}`);
  out.push("");
  out.push(`Summary: ${s.total} entries · ${order.map((k) => `${k} ${s[k]}`).join(" · ")}`);
  out.push("");
  out.push("| name | kind | old | new | status | method | detail |");
  out.push("|---|---|---|---|---|---|---|");
  for (const row of r.rows) out.push(`| ${row.name} | ${row.kind} | ${row.oldValue} | ${row.newValue ?? "-"} | ${row.status} | ${row.method} | ${row.detail.replace(/\|/g, "/")} |`);
  const attention = r.rows.filter((row) => row.status === "ambiguous" || row.status === "failed" || row.status === "proposed");
  if (attention.length) {
    out.push("");
    out.push("## Needs attention");
    for (const row of attention) {
      if (row.status === "proposed") { out.push(`### ${row.name} (${row.kind}) -- proposed ${row.oldValue} -> ${row.newValue}`); out.push(`- ${row.detail}`); out.push(`- next: apply with --resolve ${row.name}=${row.newValue} only after a green T2 run`); continue; }
      out.push(`### ${row.name} (${row.kind}, old ${row.oldValue}) -- ${row.status}`);
      out.push(`- ${row.detail}`);
      if (row.candidates && row.candidates.length) out.push(`- candidates: ${row.candidates.map((c) => `${c.rva} {bytes ${c.bytes}, calls ${c.calls}; ${c.via}}`).join(" / ")}`);
      out.push(`- next: compare the old function (seed the old exe with tools/bindings/seed-file.ts, REA compare_functions on cfg + strings_names) with the candidate(s), or read .analysis/decompiled/; then rerun with --resolve ${row.name}=0x...`);
    }
  }
  const human = r.rows.filter((row) => row.status === "needs-human");
  if (human.length) {
    out.push("");
    out.push("## Not auto-portable (human decision)");
    out.push(`${human.length} entries carried over unchanged and must be verified by hand: ${human.map((row) => row.name).join(", ")}`);
  }
  out.push("");
  out.push("## Next steps");
  out.push("1. resolve every item under \"Needs attention\" (`--resolve name=0x...`), re-run the port");
  out.push("2. `cd editor && npm run bindings:gen` (regenerates signatures.h / offsets.h for every manifest)");
  out.push("3. rebuild native/framework, native/mods/test-harness, native/mods/jokers-luck; copy the DLLs to native/dist/");
  out.push("4. `npm test` (T1 against the new exe) then `npm run test:ingame` (T2; the verdict must not be unknown-build)");
  out.push("");
  return out.join("\n");
}
