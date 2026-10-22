// Port: take the manifest of a known build and find every entry again in a new exe.
//
// Vtables port first (RTTI needs no function), then the ladder per function; the first rung whose
// candidates, filtered by the cfgLite size/call tolerance, leave exactly one wins:
//   1. the stored (masked) signature matches once: same RVA -> ported-exact, else ported-rescan
//   2. vtable-store: the only code site that lea's a named (RTTI-derived) vftable with the given
//      pattern -> its .pdata function (constructors)
//   3. imm32-witness: an imm32 equal to a constant re-derived on the new image, followed within N
//      instructions by a call to a ported callee (`mov r8d, LuckUp_typeid` before Entity_FindComponentsByTypeId)
//   4. caller-after-lea: the first in-tolerance E8 after `lea rdx,[rip+"literal"]` in a ported caller
//   5. a unique __FUNCSIG__ / literal string anchor, xref'd by rip-relative lea from .pdata functions;
//      several candidates are filtered by the tolerance before anything is called ambiguous (funcsig-xref)
//   6. an already-ported caller whose k-th call targeted this function (caller-ordinal)
//   7. the .pdata function right after / before an already-ported neighbour by table index
//      (anchors.after / anchors.before: pdata-successor / pdata-predecessor)
//   8. shared-data-ref: the other function referencing rip ref #k of a ported function
//   9. several candidates -> ambiguous (all listed); none -> failed. `resolve` lets an agent or a
//      human supply the answer (ported-anchor, method "resolved").
// Data: witness rip-ref ordinal inside a ported function -> ported-witness; constants via a slot
// body / table index -> ported-derived; struct offsets via a witness byte pattern -> ported-witness
// when unchanged, PROPOSED (value not applied) when the displacement moved. Unanchored entries are
// carried over and reported as needs-human, never guessed. Every ported function gets a fresh
// signature and fresh anchors on the new image (caller ordinals and dataRefs re-harvested).
// Pure over (old manifest, new pe, new buf); node built-ins only.

import { createHash } from "node:crypto";
import { parsePattern, scanExec } from "./scan.ts";
import { makeSignature } from "./siggen.ts";
import { harvestFunction, harvestManifest, findString, findStringXrefs, findRtti, decodeFunction, constantSources, constantHasSources, constantValues, readOffsetWitness, findVtableStoreFunctions, findImm32WitnessFunctions, findCallsAfterStringLea, pdataNeighbour, findSharedDataRefFunctions, constantValueOnImage } from "./harvest.ts";
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

  // ---- vtables (RTTI): no function dependency, and the vtable-store / imm32-witness rungs need them ------
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

  // ---- rungs 2-8, iterated: later rungs need already-ported neighbours ---------------
  const cand = (e: Entry, rva: number, via: string): Candidate => ({ rva: hex(rva), ...candidateStats(e, rva), via });
  const ported = (name: string): number | undefined => newRva.get(name);
  const fnAt = (rva: number): boolean => { const f = pe.pdata.find(rva); return !!f && f.begin === rva; };
  /** a rung returns null when it does not apply or its inputs are not ready yet (a neighbour still pending), else its candidates */
  type Rung = { method: string; run: (e: Entry, why: string[]) => Candidate[] | null };
  const rungs: Rung[] = [
    { method: "vtable-store", run: (e) => {
      const a = e.anchors.vtableStore;
      if (!a || !a.vtable) return null;
      const vt = entry(out, a.vtable);
      if (!vt || !vt.port || !vt.port.status.startsWith("ported") || !vt.rva) return [];
      return findVtableStoreFunctions(pe, buf, parseInt(vt.rva, 16), a.pattern, out.sigCap).map((f) => cand(e, f, `vtable store of ${a.vtable}`));
    } },
    { method: "imm32-witness", run: (e, why) => {
      const w = e.anchors.imm32Witness;
      if (!w || !w.equals) return null;
      const c = entry(out, w.equals);
      const callee = ported(w.callee);
      if (!c || callee === undefined) return null;   // callee not ported yet
      const v = constantValueOnImage(out, pe, buf, c);
      if (v.value === null) { why.push(`imm32 witness: ${w.equals} has no value on the new image (${v.via})`); return []; }
      const value = v.value;
      const fnsHit = findImm32WitnessFunctions(pe, buf, w.pattern, w.imm32At, value, callee, w.maxForward ?? 8, out.sigCap);
      if (!fnsHit.length) why.push(`imm32 witness: no ${w.pattern} with imm32 ${hex(value)} (${v.via}) within ${w.maxForward ?? 8} instructions before a call to ${w.callee}`);
      return fnsHit.map((f) => cand(e, f, `imm32 ${hex(value)} (${v.via}) before call to ${w.callee}`));
    } },
    { method: "caller-after-lea", run: (e, why) => {
      const cs = (e.anchors.callers || []).filter((c) => c.afterStringLea);
      if (!cs.length) return null;
      const ready = cs.filter((c) => ported(c.function) !== undefined);
      if (!ready.length) return null;
      const outc: Candidate[] = [];
      for (const c of ready) {
        const sites = findCallsAfterStringLea(pe, buf, ported(c.function) as number, c.afterStringLea as string, c.maxForward ?? 24);
        if (!sites.length) { why.push(`no lea of "${c.afterStringLea}" in ${c.function}`); continue; }
        for (const s of sites) {
          const t = s.targets.find((x) => withinTolerance(e, x));
          if (t !== undefined && !outc.some((x) => x.rva === hex(t))) outc.push(cand(e, t, `first in-tolerance call after lea "${c.afterStringLea}" in ${c.function}`));
        }
      }
      return outc;
    } },
    { method: "funcsig-xref", run: (e, why) => {
      const anchorsStrings = (e.anchors.strings || []).filter((s) => s.unique && (s.role === "funcsig" || s.role === "literal"));
      if (!anchorsStrings.length) return null;
      let cands: Candidate[] | null = null;
      for (const s of anchorsStrings) {
        const fs = findString(pe, buf, s.text);
        if (fs.rva === null || fs.count !== 1) { why.push(`${s.role} string ${fs.count === 0 ? "missing" : "not unique"} on the new build`); continue; }
        const fnsHit = [...new Set(findStringXrefs(pe, buf, fs.rva).map((x) => (x.fn ? x.fn.begin : -1)).filter((x) => x >= 0))];
        const here = fnsHit.map((rva) => cand(e, rva, `${s.role} xref`));
        cands = cands === null ? here : cands.filter((c) => here.some((h) => h.rva === c.rva));
      }
      return cands;
    } },
    { method: "caller-ordinal", run: (e) => {
      const viaCallers: Candidate[] = [];
      let any = false;
      for (const c of fns) {
        if (!Array.isArray(c.anchors.callees) || !c.anchors.callees.some((cal) => cal.name === e.name)) continue;
        any = true;
        if (!newRva.has(c.name)) continue;
        const d = decodeFunction(pe, buf, newRva.get(c.name) as number);
        const calls = d.instrs.filter((x) => x.ins.kind === "call" && x.ins.reloc && x.ins.reloc.why === "E8 rel32" && x.ins.relTarget !== null).map((x) => x.at + x.ins.length + (x.ins.relTarget as number));
        for (const cal of c.anchors.callees) {
          if (cal.name !== e.name) continue;
          const t = calls[cal.ordinal];
          if (t !== undefined && pe.sectionOf(t) && !viaCallers.some((x) => x.rva === hex(t))) viaCallers.push(cand(e, t, `call #${cal.ordinal} of ${c.name}`));
        }
      }
      return any ? viaCallers : null;
    } },
    { method: "pdata-successor", run: (e) => {
      const a = e.anchors.after;
      if (!a || !a.function) return null;
      const nb = ported(a.function);
      if (nb === undefined) return null;
      const t = pdataNeighbour(pe, nb, 1);
      return t === null ? [] : [cand(e, t, `.pdata successor of ${a.function}`)];
    } },
    { method: "pdata-predecessor", run: (e) => {
      const a = e.anchors.before;
      if (!a || !a.function) return null;
      const nb = ported(a.function);
      if (nb === undefined) return null;
      const t = pdataNeighbour(pe, nb, -1);
      return t === null ? [] : [cand(e, t, `.pdata predecessor of ${a.function}`)];
    } },
    { method: "shared-data-ref", run: (e, why) => {
      const a = e.anchors.sharedDataRef;
      if (!a || !a.with) return null;
      const w = ported(a.with);
      if (w === undefined) return null;
      const ref = harvestNew(a.with, w).ripRefs[a.ripRefOrdinal];
      if (!ref) { why.push(`${a.with} has no rip ref #${a.ripRefOrdinal} on the new build`); return []; }
      return findSharedDataRefFunctions(pe, buf, parseInt(ref.target, 16), w).filter(fnAt).map((f) => cand(e, f, `shares ${ref.target} = rip ref #${a.ripRefOrdinal} of ${a.with}`));
    } },
  ];
  let progress = true;
  while (progress && pending.length) {
    progress = false;
    const still: Pending[] = [];
    for (const p of pending) {
      const e = p.e;
      let winner: { c: Candidate; method: string; note: string } | null = null;
      const report: Candidate[] = [];
      for (const rung of rungs) {
        const here = rung.run(e, p.why);
        if (here === null || !here.length) continue;
        const inTol = here.filter((c) => withinTolerance(e, parseInt(c.rva, 16)));
        if (inTol.length === 1) {
          winner = { c: inTol[0], method: rung.method, note: here.length > 1 ? `; ${here.length} candidates, 1 within tolerance` : "" };
          break;
        }
        if (inTol.length === 0) p.why.push(`${rung.method}: ${here.map((c) => `${c.rva} (${c.bytes} bytes, ${c.calls} calls; ${c.via})`).join(", ")} but size/calls differ too much (want ${e.anchors.cfgLite ? `${e.anchors.cfgLite.bytes}/${e.anchors.cfgLite.calls}` : "?"})`);
        for (const c of (inTol.length ? inTol : here)) if (!report.some((x) => x.rva === c.rva)) report.push(c);
      }
      if (winner) {
        const rva = parseInt(winner.c.rva, 16);
        const o = e.anchors.cfgLite;
        const drift = o && o.bytes ? `; size ${signed(winner.c.bytes - o.bytes)} / calls ${signed(winner.c.calls - (o.calls || 0))} vs old` : "";
        portFunction(e, rva, "ported-anchor", winner.method, `${winner.c.via} -> ${winner.c.rva} (${winner.c.bytes} bytes, ${winner.c.calls} calls${drift}${winner.note}; was ${e.rva})`);
        progress = true;
        continue;
      }
      still.push({ ...p, cands: report.length ? report : p.cands });
    }
    pending = still;
  }
  for (const p of pending) {
    const e = p.e;
    if (p.cands && p.cands.length) {
      finish(e, "ambiguous", "candidates", `${p.cands.length} candidate(s): ${p.cands.map((c) => `${c.rva} (${c.bytes} bytes, ${c.calls} calls; ${c.via})`).join(", ")}; ${p.why.join("; ")}`, null, p.cands);
    } else {
      const reasons = p.why.length ? p.why.join("; ") : "no unique funcsig/literal string anchor and no ported caller";
      finish(e, "failed", "none", `${reasons}; no ported caller names it${e.anchors.after || e.anchors.before ? "" : "; no .pdata neighbour anchor"}`, null);
    }
  }

  // ---- constants --------------------------------------------------------------------
  for (const e of out.entries) {
    if (e.kind !== "constant") continue;
    const a = e.anchors;
    if (constantHasSources(a)) {
      // every independent source must agree; a split is a human decision, never a coin toss
      const src = constantSources(out, pe, buf, e);
      const vals = constantValues(src);
      const was = e.value || "";
      if (!vals.length) {
        // a slot search that found no single answer is a human decision (the layout changed), not a failure to port
        if (src.search === null && e.anchors.derive?.slotSearch) { finish(e, "needs-human", "slot-search", `${src.notes.join("; ")}; value ${was} kept`, null); continue; }
        finish(e, "failed", "derive", src.notes.join("; "), null); continue;
      }
      if (vals.some((v) => v !== vals[0])) { finish(e, "needs-human", "derive", `sources disagree: ${src.notes.join("; ")}; value ${was} kept`, null); continue; }
      const v = vals[0];
      e.value = was && parseValue(was) === v ? was : hex(v);   // keep the manifest's spelling (172 stays 172) when the number is unchanged
      const method = [src.slot !== null ? "slot-body" : "", src.arg !== null ? "call-arg" : "", src.extent !== null ? "extent" : "", src.search !== null ? "slot-search" : "", src.disp !== null ? "call-slot" : "", src.rdata !== null ? "rdata" : ""].filter(Boolean).join("+");
      finish(e, "ported-derived", method, `${src.notes.join("; ")}${vals.length > 1 ? " (agree)" : ""}${was && parseValue(was) === v ? " (unchanged)" : ` (was ${was})`}`, e.value, undefined, was);
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
    const rd = readOffsetWitness(pe, buf, frva, { pattern: w.pattern, nth: w.nth, dispAt: w.dispAt, dispSize: w.dispSize, scale: w.scale }, out.sigCap);
    if (!rd.found) { finish(e, "failed", "witness", `pattern ${w.pattern} (#${w.nth || 0}) ${rd.matches ? "matched but gave no value" : "not found"} in ${w.function}`, null); continue; }
    const disp = rd.value!;
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
      // caller ordinals follow the new image (the harvest of the caller names this entry at its new call index)
      for (const c of e.anchors.callers || []) {
        const caller = entry(harvested.manifest, c.function);
        const ords = caller && caller.port && caller.port.status.startsWith("ported") ? (caller.anchors.callees || []).filter((x) => x.name === e.name).map((x) => x.ordinal) : [];
        if (ords.length === 1) c.ordinal = ords[0];
        else if (ords.length > 1 && c.ordinal !== undefined && !ords.includes(c.ordinal)) c.ordinal = ords[0];
      }
      // dataRefs follow by rip-ref ordinal (filled by the harvest on the old build)
      const refs = harvestNew(e.name, newRva.get(e.name) as number).ripRefs;
      for (const d of e.anchors.dataRefs || []) if (d.ripRefOrdinal !== undefined && refs[d.ripRefOrdinal]) d.rva = refs[d.ripRefOrdinal].target;
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
