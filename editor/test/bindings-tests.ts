// Tests for the bindings library (editor/src/core/bindings/*): the PE reader,
// the signature scanner/generator, the manifest, harvest and port steps.
// T0 tests run on a synthetic PE built by test/fixtures/bindings/fake-pe.ts
// (no game bytes); T1 tests read the installed Mewgenics.exe in place and
// skip when it is absent. Wired into run-tests.ts.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { locateGameDir } from "../src/core/ingame/launch.ts";
import { REPO_ROOT, SafetyError, ANALYSIS_DIR } from "../src/core/repo.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";
import type { Entry, EnumExposure, TableExposure, MacroExposure } from "../src/core/bindings/manifest.ts";
import type { PortRow, PortResult } from "../src/core/bindings/port.ts";
import type { CheckEntry } from "../src/core/bindings/check.ts";

/** Known build 25143593 identity (docs/engine-map.md). */
const KNOWN_TS = 0x6a9c51e5;
const KNOWN_SIZE = 0x1574000;

/** A module under test, or the load error so the suite can register one failing test instead of crashing the run (readable red). */
type Loaded<M> = M | { __error: string };

/** Import a module, or return the error so the suite can register one failing test instead of crashing the run. */
async function load<M>(rel: string): Promise<Loaded<M>> {
  try {
    return (await import(rel)) as M;
  } catch (e) {
    return { __error: String(e instanceof Error ? e.message : e) };
  }
}

/** @returns the installed exe, or null when absent */
function realExe(): Buffer|null {
  const p = join(locateGameDir(process.env), "Mewgenics.exe");
  return existsSync(p) ? readFileSync(p) : null;
}

/** One item of a fake function body: a byte, or a placeholder resolved after layout. */
type CodeItem = number | { call: string } | { lea: string } | { mov: string } | { leaRax: string } | { leaRdx: string };
interface LinkSpec {
  textPad?: number;
  rdataPad?: number;
  stamp?: number;
  fns: { name: string; code: CodeItem[] }[];
  strings?: Record<string, string>;
  globs?: string[];
  /** fake vftables with a full x64 RTTI chain (TypeDescriptor in .data, COL + vftable in .rdata); slots name functions */
  vtables?: Record<string, { td: string; slots: string[] }>;
}

export async function runBindingsTests(test: TestFn, assert: AssertFn, eq: EqFn): Promise<void> {
  console.log("\n# Bindings: PE reader (fake PE + real exe)");
  const fake = await load<typeof import("./fixtures/bindings/fake-pe.ts")>("./fixtures/bindings/fake-pe.ts");
  const pe = await load<typeof import("../src/core/bindings/pe.ts")>("../src/core/bindings/pe.ts");
  if ("__error" in fake) test("fake-pe.ts loads", () => assert(false, fake.__error));
  if ("__error" in pe) test("pe.ts loads", () => assert(false, pe.__error));
  if ("__error" in fake || "__error" in pe) return;
  const { buildFakePe } = fake;
  const { parsePe } = pe;

  /** A two-function .text, a .rdata with one string, and a .pdata covering both functions. */
  const text = new Uint8Array(0x100);
  text.set([0x48, 0x8b, 0xc4, 0x55, 0xc3], 0x10); // fn A at +0x10
  text.set([0x40, 0x53, 0x48, 0x83, 0xec, 0x20, 0xc3], 0x40); // fn B at +0x40
  const rdata = new Uint8Array(0x40);
  rdata.set(Buffer.from("LuckUp\0", "latin1"), 0x08);
  const spec = {
    timeDateStamp: 0x12345678,
    sections: [
      { name: ".text", bytes: text, exec: true },
      { name: ".rdata", bytes: rdata },
    ],
    pdata: [
      { section: ".text", begin: 0x10, end: 0x40 },
      { section: ".text", begin: 0x40, end: 0x80 },
    ],
  };

  test("fake PE: parsePe reads identity and the section table in order", () => {
    const f = buildFakePe(spec);
    const p = parsePe(f.buf);
    eq(p.timeDateStamp, 0x12345678);
    eq(p.imageBase, 0x140000000);
    eq(p.sections.map((s: { name: string }) => s.name).join(","), ".text,.rdata,.pdata");
    eq(p.sections[0].va, 0x1000, ".text starts at the first page");
    assert(p.sections[0].exec, ".text is executable");
    assert(!p.sections[1].exec, ".rdata is not executable");
    eq(p.execSections.length, 1);
    assert(p.sizeOfImage >= p.sections[2].va + p.sections[2].vsize, "SizeOfImage covers the last section");
    eq(p.sizeOfImage % 0x1000, 0, "SizeOfImage is page aligned");
  });

  test("fake PE: rvaToOff / offToRva round-trip; unmapped -> -1", () => {
    const f = buildFakePe(spec);
    const p = parsePe(f.buf);
    const rva = f.rva(".rdata", 0x08);
    const off = p.rvaToOff(rva);
    assert(off > 0, "mapped");
    eq(f.buf.toString("latin1", off, off + 6), "LuckUp");
    eq(p.offToRva(off), rva);
    eq(p.rvaToOff(0x10), -1, "header region is not a section");
    eq(p.rvaToOff(0x7fff0000), -1, "beyond the image");
    eq(p.offToRva(0x10), -1, "file header offset has no section RVA");
    eq(p.sectionOf(rva)!.name, ".rdata");
    eq(p.sectionOf(0x7fff0000), null);
  });

  test("fake PE: pdata.find returns the containing RUNTIME_FUNCTION; gaps -> null", () => {
    const f = buildFakePe(spec);
    const p = parsePe(f.buf);
    eq(p.pdata.count, 2);
    const a = p.pdata.find(f.rva(".text", 0x12))!;
    assert(a !== null, "inside fn A");
    eq(a.begin, f.rva(".text", 0x10));
    eq(a.end, f.rva(".text", 0x40));
    const b = p.pdata.find(f.rva(".text", 0x40));
    assert(b !== null && b.begin === f.rva(".text", 0x40), "begin is inclusive");
    eq(p.pdata.find(f.rva(".text", 0x80)), null, "end is exclusive");
    eq(p.pdata.find(f.rva(".text", 0x00)), null, "before the first function");
    eq(p.pdata.get(1).begin, f.rva(".text", 0x40));
  });

  test("fake PE: a PE without .pdata has pdata.count 0 and find -> null", () => {
    const f = buildFakePe({ sections: [{ name: ".text", bytes: text, exec: true }] });
    const p = parsePe(f.buf);
    eq(p.pdata.count, 0);
    eq(p.pdata.find(0x1010), null);
  });

  const exe = realExe();
  if (!exe) {
    console.log("  (skipped: Mewgenics.exe not found; set MEWGENICS_DIR for the T1 bindings tests)");
  } else {
    test("T1 real exe: identity is build 25143593 (TimeDateStamp 0x6a9c51e5, SizeOfImage 0x1574000)", () => {
      const p = parsePe(exe);
      eq(p.timeDateStamp, KNOWN_TS);
      eq(p.sizeOfImage, KNOWN_SIZE);
      eq(p.imageBase, 0x140000000);
    });
    test("T1 real exe: .text is the only executable section; .pdata has > 50,000 functions", () => {
      const p = parsePe(exe);
      eq(p.execSections.map((s: { name: string }) => s.name).join(","), ".text");
      assert(p.pdata.count > 50000, `pdata count ${p.pdata.count}`);
      const f = p.pdata.find(0x8e3c60); // TurnControl::NextTurn
      assert(f !== null && f.begin === 0x8e3c60, `NextTurn should start a RUNTIME_FUNCTION, got ${JSON.stringify(f)}`);
      eq(p.rvaToOff(0x1000), 0x400, ".text raw offset");
    });
  }

  // ---- scan.ts: the DLL's scanner semantics (fw_sig.c) in node ----------------
  console.log("\n# Bindings: signature scanner (parity with native/framework/test/test_sig.c)");
  const scan = await load<typeof import("../src/core/bindings/scan.ts")>("../src/core/bindings/scan.ts");
  if ("__error" in scan) {
    test("scan.ts loads", () => assert(false, scan.__error));
    return;
  }
  const { parsePattern, scanBuffer, scanExec, scanSection, patternToString, PatternError, FW_SIG_MAX_BYTES } = scan;
    const throwsPattern = (fn: () => void) => {
    try { fn(); } catch (e) { return e instanceof PatternError; }
    return false;
  };

  test("parsePattern: plain bytes -> bytes + all-set mask; cap defaults to FW_SIG_MAX_BYTES 128", () => {
    eq(FW_SIG_MAX_BYTES, 128);
    const p = parsePattern("48 8B C4 55");
    eq(p.length, 4);
    eq(Array.from(p.bytes).join(","), "72,139,196,85");
    eq(Array.from(p.mask).join(","), "1,1,1,1");
  });
  test("parsePattern: wildcards (?, ??) and odd spacing; lowercase hex", () => {
    const p = parsePattern("  48 ?? 8B  ? C4 ");
    eq(p.length, 5);
    eq(Array.from(p.mask).join(","), "1,0,1,0,1");
    eq(p.bytes[2], 0x8b);
    eq(p.bytes[1], 0);
    const l = parsePattern("ff 0a");
    eq(l.bytes[0], 0xff);
    eq(l.bytes[1], 0x0a);
  });
  test("parsePattern: bad hex, junk after a token, and overflow throw PatternError; empty -> length 0", () => {
    assert(throwsPattern(() => parsePattern("48 ZZ")), "bad hex");
    assert(throwsPattern(() => parsePattern("4")), "half byte");
    assert(throwsPattern(() => parsePattern("48x 8B")), "junk after token");
    assert(throwsPattern(() => parsePattern("01 02 03 04 05", 4)), "overflow");
    eq(parsePattern("01 02 03 04", 4).length, 4);
    eq(parsePattern("").length, 0);
    eq(parsePattern("   ").length, 0);
  });
  test("patternToString round-trips, uppercase hex and ?? for wildcards", () => {
    eq(patternToString(parsePattern("48 ?? 8b ? c4")), "48 ?? 8B ?? C4");
  });

  const HAY = Buffer.from([0x00, 0x48, 0x8b, 0xc4, 0x55, 0x90, 0x48, 0x8b, 0xc5, 0x55, 0x00]);
  test("scanBuffer: unique hit returns its offset and counts 1", () => {
    const st = { matches: 0 };
    eq(scanBuffer(HAY, parsePattern("48 8B C4 55"), st), 1);
    eq(st.matches, 1);
  });
  test("scanBuffer: wildcard matches both, returns the FIRST, reports 2", () => {
    const st = { matches: 0 };
    eq(scanBuffer(HAY, parsePattern("48 8B ?? 55"), st), 1);
    eq(st.matches, 2);
  });
  test("scanBuffer: no match -> -1 and 0; pattern longer than buffer -> -1; zero-length -> -1", () => {
    const st = { matches: 0 };
    eq(scanBuffer(HAY, parsePattern("DE AD BE EF"), st), -1);
    eq(st.matches, 0);
    eq(scanBuffer(HAY, parsePattern("00 48 8B C4 55 90 48 8B C5 55 00 11"), st), -1);
    eq(scanBuffer(HAY, parsePattern(""), st), -1);
    eq(st.matches, 0);
  });
  test("scanBuffer: a leading wildcard still matches (no first-byte prefilter bug)", () => {
    const st = { matches: 0 };
    eq(scanBuffer(HAY, parsePattern("?? 8B C4 55"), st), 1);
    eq(st.matches, 1);
  });
  test("scanBuffer: matches accumulate across buffers and stop counting at two", () => {
    const st = { matches: 0 };
    const pat = parsePattern("48 8B C4 55");
    eq(scanBuffer(HAY, pat, st), 1);
    eq(scanBuffer(HAY, pat, st), 1);
    eq(st.matches, 2);
    const rep = Buffer.alloc(64, 0x90);
    const st2 = { matches: 0 };
    scanBuffer(rep, parsePattern("90 90"), st2);
    eq(st2.matches, 2);
  });

  test("scanExec: scans executable sections only, as the loader sees them, with RVA hits", () => {
    const text2 = new Uint8Array(0x30);
    text2.set([0x40, 0x53, 0x48, 0x83, 0xec, 0x20, 0xc3], 0x08); // same prologue as fn B of .text
    const rdata2 = new Uint8Array(0x20);
    rdata2.set([0x48, 0x8b, 0xc4, 0x55, 0xc3], 0x04); // fn A's bytes in a data section: must not count
    const f = buildFakePe({
      sections: [
        { name: ".text", bytes: text, exec: true },
        { name: ".rdata", bytes: rdata2 },
        { name: ".text2", bytes: text2, exec: true },
      ],
    });
    const p = parsePe(f.buf);
    const a = scanExec(p, f.buf, parsePattern("48 8B C4 55 C3"));
    eq(a.count, 1);
    eq(a.hits[0], f.rva(".text", 0x10));
    const b = scanExec(p, f.buf, parsePattern("40 53 48 83 EC 20 C3"));
    eq(b.count, 2, "one hit per exec section");
    eq(b.hits.join(","), [f.rva(".text", 0x40), f.rva(".text2", 0x08)].join(","));
    const none = scanExec(p, f.buf, parsePattern("DE AD BE EF"));
    eq(none.count, 0);
    eq(none.hits.length, 0);
    // a data section can be scanned explicitly (strings later)
    const st = { matches: 0 };
    const hits = scanSection(f.buf, p.sections[1], parsePattern("48 8B C4 55"), st);
    eq(hits[0], f.rva(".rdata", 0x04));
  });
  test("scanExec: a pattern that only appears in a section's zero padding beyond the raw size still counts (loader view)", () => {
    // VirtualSize > raw bytes is modelled by a trailing run of zeros in .text; the needle crosses into it.
    const f = buildFakePe({ sections: [{ name: ".text", bytes: [0xc3, 0xc3, 0xc3, 0xaa], exec: true }] });
    const p = parsePe(f.buf);
    eq(scanExec(p, f.buf, parsePattern("C3 AA")).count, 1);
  });

  // ---- manifest.ts: bindings/<build>.json, the single source of truth ------------
  console.log("\n# Bindings: manifest (bindings/<steamBuildId>.json)");
  const man = await load<typeof import("../src/core/bindings/manifest.ts")>("../src/core/bindings/manifest.ts");
  if ("__error" in man) {
    test("manifest.ts loads", () => assert(false, man.__error));
    return;
  }
  const { parseManifest, validateManifest, loadManifest, saveManifest, symbolTable, dataTable, lkTable, entry, hex, BINDINGS_DIR, ManifestError } = man;

    /** @returns a minimal valid manifest object */
  const mini = (overrides: any = {}): any => ({
    format: 1,
    build: { steamBuildId: "1", gameVersion: "0.0.1", name: "0.0.1 (steam 1)", timeDateStamp: "0x11111111", sizeOfImage: "0x4000", imageBase: "0x140000000", exeSha256: "a".repeat(64), exeSize: 1, sdlVersion: "3.2.12" },
    sigCap: 128,
    entries: [
      { name: "FnA", kind: "function", rva: "0x1010", signature: { pattern: "48 8B C4 55", exactLen: 4, offset: 0, wildcards: [] }, anchors: {}, consumers: [], exposure: [{ enum: "FW_SYM_FnA", index: 0 }], evidence: [] },
      { name: "FnB", kind: "function", rva: "0x1040", signature: null, anchors: { callees: [{ name: "FnA", ordinal: 0 }] }, consumers: [], exposure: [{ table: "FW_LK", index: 0, shape: "A" }], evidence: [] },
      { name: "Glob", kind: "data", rva: "0x2000", anchors: { witness: { function: "FnA", ripRefOrdinal: 0 } }, consumers: [], exposure: [{ enum: "FW_DATA_Glob", index: 0 }], evidence: [] },
      { name: "Foo_vftable", kind: "vtable", rva: "0x3000", slots: 4, anchors: { rtti: { typeDescriptorName: ".?AVFoo@glaiel@@" } }, consumers: [], exposure: [{ field: "rva_Foo_vftable" }], evidence: [] },
      { name: "Foo_typeid", kind: "constant", value: "0x4d6", anchors: { derive: { vtable: "Foo_vftable", slot: 1, bodyPattern: "B8 ?? ?? ?? ?? C3", imm32At: 1 } }, consumers: [], exposure: [{ field: "fooTypeId" }], evidence: [] },
      { name: "Foo_stacks", kind: "offset", struct: "Foo", value: "0x5c", ctype: "int32", anchors: { witness: { function: "FnA", pattern: "01 ?? 5C", dispAt: 2, dispSize: 1, nth: 0 } }, consumers: [], exposure: [{ macro: "OFF_FOO_STACKS" }], evidence: [] },
    ],
    ...overrides,
  });
    const problems = (m: any): string[] => validateManifest(m).problems;
    const rejects = (m: any, re: RegExp, what: string) => {
    const ps = problems(m);
    assert(ps.some((x) => re.test(x)), `${what}: expected a problem matching ${re}, got ${JSON.stringify(ps)}`);
  };

  test("validateManifest: the minimal manifest is ok; parseManifest accepts text and objects", () => {
    eq(problems(mini()).length, 0, JSON.stringify(problems(mini())));
    const m = parseManifest(JSON.stringify(mini()));
    eq(m.build.steamBuildId, "1");
    eq(parseManifest(mini()).entries.length, 6);
  });
  test("validateManifest: rejects duplicate names, bad hex, unknown kind, bad format", () => {
    const d = mini(); d.entries.push({ ...d.entries[0] });
    rejects(d, /duplicate entry name FnA/, "dup");
    const h = mini(); h.entries[0].rva = "0xZZ";
    rejects(h, /FnA.*rva.*hex/, "bad hex");
    const k = mini(); k.entries[0].kind = "symbol";
    rejects(k, /FnA.*kind/, "kind");
    const f = mini({ format: 2 });
    rejects(f, /format/, "format");
    const b = mini(); b.build.exeSha256 = "nope";
    rejects(b, /exeSha256/, "sha");
  });
  test("validateManifest: enum/table indices must be contiguous from 0 (append-only tables)", () => {
    const g = mini(); g.entries[0].exposure = [{ enum: "FW_SYM_FnA", index: 1 }];
    rejects(g, /FW_SYM.*index.*0/, "gap");
    const t = mini(); t.entries[1].exposure = [{ table: "FW_LK", index: 2, shape: "A" }];
    rejects(t, /FW_LK.*index/, "table gap");
  });
  test("validateManifest: signatures must parse under sigCap and must not end in a wildcard", () => {
    const long = mini({ sigCap: 4 }); long.entries[0].signature = { pattern: "48 8B C4 55 90", exactLen: 5, offset: 0, wildcards: [] };
    rejects(long, /FnA.*sigCap|FnA.*longer/, "cap");
    const tail = mini(); tail.entries[0].signature = { pattern: "48 8B C4 ??", exactLen: 4, offset: 0, wildcards: [{ at: 3, len: 1, why: "test" }] };
    rejects(tail, /FnA.*wildcard/, "trailing wildcard");
    const bad = mini(); bad.entries[0].signature = { pattern: "48 ZZ", exactLen: 2, offset: 0, wildcards: [] };
    rejects(bad, /FnA.*pattern/, "bad pattern");
  });
  test("validateManifest: offsets need a struct and a witness (or an explicit unanchored flag); references must resolve", () => {
    const o = mini(); o.entries[5].anchors = {};
    rejects(o, /Foo_stacks.*witness|Foo_stacks.*unanchored/, "no witness");
    const u = mini(); u.entries[5].anchors = { unanchored: true };
    eq(problems(u).length, 0, "unanchored is allowed (reported, never silently ported)");
    const w = mini(); w.entries[5].anchors.witness!.function = "Nope";
    rejects(w, /Foo_stacks.*Nope/, "unknown witness");
    const c = mini(); c.entries[1].anchors = { callees: [{ name: "Ghost", ordinal: 0 }] };
    rejects(c, /FnB.*Ghost/, "unknown callee");
    const dv = mini(); dv.entries[4].anchors.derive!.vtable = "Nope_vftable";
    rejects(dv, /Foo_typeid.*Nope_vftable/, "unknown vtable");
    const dw = mini(); dw.entries[4].anchors.witness = { function: "FnA", callee: "Nope_fn", pattern: "41 B8 ?? ?? ?? ??", imm32At: 2, maxBack: 6 };
    rejects(dw, /Foo_typeid.*Nope_fn/, "unknown witness callee");
    const ns = mini(); delete ns.entries[5].struct;
    rejects(ns, /Foo_stacks.*struct/, "no struct");
  });
  test("parseManifest throws ManifestError listing every problem", () => {
    const d = mini(); d.entries.push({ ...d.entries[0] }); d.format = 9;
    try { parseManifest(d); assert(false, "should throw"); }
    catch (e) { assert(e instanceof ManifestError, String(e)); assert(/duplicate/.test(String(e)) && /format/.test(String(e)), String(e)); }
  });
  test("symbolTable / dataTable / lkTable return entries sorted by index", () => {
    const m = parseManifest(mini());
    eq(symbolTable(m).map((e) => e.name).join(","), "FnA");
    eq(dataTable(m).map((e) => e.name).join(","), "Glob");
    eq(lkTable(m).map((e) => e.name).join(","), "FnB");
    eq(entry(m, "Foo_typeid")!.kind, "constant");
    eq(entry(m, "Missing"), null);
  });
  test("saveManifest writes only under bindings/ (SafetyError elsewhere) and round-trips", () => {
    const m = parseManifest(mini());
    const tmp = mkdtempSync(join(tmpdir(), "bindings-"));
    try {
      let threw = false;
      try { saveManifest(join(tmp, "x.json"), m); } catch (e) { threw = e instanceof SafetyError; }
      assert(threw, "outside bindings/ must throw SafetyError");
      const text = saveManifest(join(BINDINGS_DIR, "__test__.json"), m, { dryRun: true });
      assert(text.endsWith("\n") && text.includes("\"steamBuildId\": \"1\""), "pretty JSON text");
      eq(parseManifest(text).entries.length, 6);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  // ---- the real manifest for build 25143593 ---------------------------------------
  console.log("\n# Bindings: bindings/25143593.json content");
  const realPath = join(BINDINGS_DIR, "25143593.json");
  const apiH = readFileSync(join(REPO_ROOT, "native", "framework", "src", "framework_api.h"), "utf8");
    const enumerators = (prefix: string) => (apiH.match(new RegExp(`^\\s*(${prefix}[A-Za-z0-9_]+)\\s*,`, "gm")) || []).map((l) => l.trim().replace(/,$/, "")).filter((n) => !n.endsWith("_COUNT_"));
  test("25143593.json loads and identifies the build", () => {
    assert(existsSync(realPath), `${realPath} missing`);
    const m = loadManifest(realPath);
    eq(m.build.steamBuildId, "25143593");
    eq(m.build.gameVersion, "1.1.21239");
    eq(m.build.timeDateStamp, "0x6a9c51e5");
    eq(m.build.sizeOfImage, "0x1574000");
    eq(m.build.imageBase, "0x140000000");
    eq(m.build.exeSha256, "4127cd6a792ae528bca6f65a8873dd61789591937d87656c2b586a5e30eb77ea");
    eq(m.build.sdlVersion, "3.2.12");
    eq(m.sigCap, 128);
  });
  test("25143593.json: FwSymbol table == framework_api.h FW_SYM_* order (40, incl. the v4 run-entry symbols, the 7 glow symbols, Character_Face, the 4 campaign-walk symbols and the 2 glow-v2 screen-matrix symbols); each has a signature except the three with no relocation-free unique window", () => {
    const m = loadManifest(realPath);
    const want = enumerators("FW_SYM_");
    eq(want.length, 42);
    eq(entry(m, "AddComponent_MewDirector_test")!.rva, "0x758650");
    eq(entry(m, "Entity_DestroyOwnerOf")!.rva, "0x94eba0");
    eq(entry(m, "AddComponent_MewDirector_named")!.rva, "0x1be1a0");
    eq(entry(m, "MewDirector_start")!.rva, "0x3aefd0");
    eq(entry(m, "SaveProps_GetOrCreate")!.rva, "0x61ea0");
    eq(entry(m, "Rng_SeedState")!.rva, "0x94ee40");
    eq(entry(m, "Rng_Reseed")!.rva, "0x94f0a0");
    for (const n of ["FW_SYM_SceneManager_CreateScene", "FW_SYM_Scene_CreateEntity", "FW_SYM_AddComponent_TacticsTest", "FW_SYM_Component_GetGame", "FW_SYM_TacticsTest_init"]) assert(want.includes(n), `${n} in framework_api.h`);
    eq(entry(m, "AddComponent_TacticsTest")!.rva, "0x31c3e0");
    eq(entry(m, "SceneManager_CreateScene")!.rva, "0x9d4950");
    eq(entry(m, "Scene_CreateEntity")!.rva, "0x96b3e0");
    eq(entry(m, "TacticsTest_init")!.rva, "0x833390");
    eq(entry(m, "Component_GetGame")!.rva, "0x908e0");
    const got = symbolTable(m);
    eq(got.map((e) => (e.exposure.find((x) => "enum" in x) as EnumExposure).enum).join("\n"), want.join("\n"));
    // 2026-10-21 (notes-bind): LuckUp_ctor is a byte-twin of two sibling ctors modulo relocations, Status_GetCategory and
    // Status_ApplyLuckUp are unique only through a __LINE__ immediate / the type id -> null + anchors, raw RVA in the DLL
    const NULL_SIGNED = ["LuckUp_ctor", "Status_GetCategory", "Status_ApplyLuckUp"];
    for (const e of got) if (!NULL_SIGNED.includes(e.name)) assert(!!(e.signature && e.signature.pattern), `${e.name} needs a signature`);
    for (const n of NULL_SIGNED) eq(entry(m, n)!.signature, null, `${n}: no relocation-free unique window on this build`);
    eq(entry(m, "TurnControl_NextTurn")!.rva, "0x8e3c60");
    const sp = entry(m, "SaveProps_GetOrCreate")!.signature!;
    assert(sp.offset < 0 && sp.wildcards.length >= 5, `SaveProps_GetOrCreate regenerated on an instruction boundary with its relocations masked: ${JSON.stringify(sp)}`);
  });
  test("25143593.json: FwData table == framework_api.h FW_DATA_* order (11, incl. the MewDirector and ShaderManager globals); App_global first", () => {
    const m = loadManifest(realPath);
    const want = enumerators("FW_DATA_");
    eq(want.length, 11);
    eq(entry(m, "MewDirector_global")!.rva, "0x13dac30");
    const got = dataTable(m);
    eq(got.map((e) => (e.exposure.find((x) => "enum" in x) as EnumExposure).enum).join("\n"), want.join("\n"));
    eq(got[0].name, "App_global");
    eq(got[0].rva, "0x13c4a30");
    eq(entry(m, "SDL_HideWindow_slot")!.rva, "0x12e82a0");
    const t = entry(m, "SDL_DYNAPI_table");
    assert(!!(t && t.rva === "0x12e7000"), "the DYNAPI jump_table struct is its own entry (exported slots start at +0x78)");
    assert(!!(t && t.anchors.witness && t.anchors.witness.function === "SDL_InitDynamicAPI"), "anchored by the function that fills it");
    for (const e of got.slice(1)) {
      if (/_slot$/.test(e.name)) assert(!!(e.anchors.derive && e.anchors.derive.table === "SDL_DYNAPI_table"), `${e.name} derives from the table`);
      else assert(!!(e.anchors.witness && e.anchors.witness.function), `${e.name} is a global anchored by a witness function`);
    }
    const md = entry(m, "MewDirector_global")!;
    eq(md.anchors.witness!.function, "MewDirector_init", "the director global is witnessed by the function that sets it");
  });
  test("25143593.json: FW_LK table is the 13 status lookups in status_engine.c g_lk_rva order, shapes A-E", () => {
    const m = loadManifest(realPath);
    const lk = lkTable(m);
    const rvas = ["0x4929c0", "0x492c20", "0x492e80", "0x492f20", "0x493190", "0x5028e0", "0x493690", "0x493910", "0x493b80", "0x493e00", "0x4933e0", "0x494080", "0x502b40"];
    eq(lk.map((e) => e.rva).join(","), rvas.join(","));
    eq(lk.map((e) => (e.exposure.find((x) => "table" in x) as TableExposure).shape).join(""), "AAAAAABBBBCDE");
    eq(lk[0].name, "Status_GetCategory", "index 0 is also FW_SYM_Status_GetCategory");
    eq(lk[4].name, "Status_GetFlags");
    assert(lk.filter((e) => e.anchors.strings && e.anchors.strings!.some((s) => s.role === "funcsig")).length >= 11, "funcsig anchors recorded for the lookups that have one");
  });
  test("25143593.json: vtables, type id, vtable slot constants and >= 30 struct offsets with macros", () => {
    const m = loadManifest(realPath);
    eq(entry(m, "LuckUp_vftable")!.rva, "0xf57ab8");
    eq(entry(m, "LuckUp_vftable")!.anchors.rtti!.typeDescriptorName, ".?AVLuckUp@glaiel@@");
    eq(entry(m, "Status_vftable")!.rva, "0xed1960");
    eq(entry(m, "LuckUp_typeid")!.value, "0x4d6");
    eq(entry(m, "DefaultStatusSource")!.rva, "0x13c4d30");
    eq(entry(m, "LuckUp_vtableSlots")!.value, "172");
    eq(entry(m, "VT_OnStacksChanged")!.value, "170");
    const offs = m.entries.filter((e) => e.kind === "offset");
    assert(offs.length >= 30, `offsets: ${offs.length}`);
    eq(entry(m, "Status_stacks")!.value, "0x5c");
    eq((entry(m, "Status_stacks")!.exposure[0] as MacroExposure).macro, "OFF_STATUS_STACKS");
    eq(entry(m, "X_charArray")!.value, "0x1f90");
    eq(entry(m, "Character_touchedPassives")!.value, "0xe50");
    for (const e of offs) assert(!!(e.struct && e.exposure.some((x) => "macro" in x)), `${e.name} has struct + macro`);
  });
  test("25143593.json: GON at runtime (2026-10-22) — HP / shield / stats / base health / the unit's GON entry and name key on Character, the GonObject node layout, every one witnessed in a function that has a .pdata body", () => {
    const m = loadManifest(realPath);
    const macro = (n: string) => (entry(m, n)!.exposure[0] as MacroExposure).macro;
    const witness = (n: string) => entry(m, n)!.anchors.witness!;
    // Character: current HP is the one field a console lambda writes (1hp); the rest are Character::init stores
    eq(entry(m, "Character_hp")!.value, "0x4b0"); eq(macro("Character_hp"), "OFF_CH_HP"); eq(witness("Character_hp").function, "TacticsTest_1hp_DoCall");
    eq(entry(m, "Character_shield")!.value, "0x4b4"); eq(macro("Character_shield"), "OFF_CH_SHIELD"); eq(witness("Character_shield").function, "TacticsTest_1hp_DoCall");
    eq(entry(m, "Character_divineShield")!.value, "0x4b8"); eq(macro("Character_divineShield"), "OFF_CH_DIVINE_SHIELD");
    eq(entry(m, "Character_stats")!.value, "0x5a0"); eq(macro("Character_stats"), "OFF_CH_STATS"); eq(entry(m, "Character_stats")!.ctype, "int32[7]"); eq(witness("Character_stats").function, "Character_init");
    eq(entry(m, "Character_baseHealth")!.value, "0x5e8"); eq(macro("Character_baseHealth"), "OFF_CH_BASE_HEALTH");
    eq(entry(m, "Character_gonEntry")!.value, "0x240"); eq(macro("Character_gonEntry"), "OFF_CH_GON_ENTRY"); eq(entry(m, "Character_gonEntry")!.ctype, "const GonObject*");
    eq(entry(m, "Character_nameKey")!.value, "0x248"); eq(macro("Character_nameKey"), "OFF_CH_NAME_KEY");
    // GonObject (0xb0 bytes): what the harness's walker reads instead of calling the game's getters
    const node: [string, string, string][] = [
      ["GonObject_children", "0x38", "OFF_GON_CHILDREN"], ["GonObject_childrenEnd", "0x40", "OFF_GON_CHILDREN_END"], ["GonObject_int", "0x50", "OFF_GON_INT"],
      ["GonObject_double", "0x58", "OFF_GON_DOUBLE"], ["GonObject_bool", "0x60", "OFF_GON_BOOL"], ["GonObject_text", "0x68", "OFF_GON_TEXT"],
      ["GonObject_name", "0x88", "OFF_GON_NAME"], ["GonObject_type", "0xa8", "OFF_GON_TYPE"],
    ];
    for (const [n, v, mac] of node) { eq(entry(m, n)!.kind, "offset", n); eq(entry(m, n)!.value, v, n); eq(entry(m, n)!.struct, "GonObject", n); eq(macro(n), mac); }
    const size = entry(m, "GonObject_size")!;
    eq(size.kind, "constant"); eq(size.value, "0xb0"); eq(macro("GonObject_size"), "GON_NODE_SIZE");
    assert(!!(size.anchors.witness && size.anchors.witness.pattern && Number.isInteger(size.anchors.witness.dispAt)), "the stride is a displacement witness (add rbx,0xb0 in child_by_name)");
    // the witnesses are function entries with .pdata bodies (the leaf getters IntOr/NumberOr/BoolOr/Exists have none and are not entries)
    for (const fn of ["Character_init", "TacticsTest_1hp_DoCall", "GonObject_child_by_name", "GonObject_Int", "GonObject_Number", "GonObject_Bool", "GonObject_StringRef"]) {
      const f = entry(m, fn);
      assert(!!(f && f.kind === "function" && f.signature && f.signature.pattern), `${fn} is a signed function entry`);
    }
    eq(entry(m, "Character_init")!.rva, "0xf70f0"); eq(entry(m, "TacticsTest_1hp_DoCall")!.rva, "0x895160"); eq(entry(m, "GonObject_child_by_name")!.rva, "0x942b50");
    for (const n of ["GonObject_children", "GonObject_childrenEnd", "GonObject_name", "GonObject_type", "GonObject_size"]) eq(witness(n).function, "GonObject_child_by_name", n);
    const offs = m.entries.filter((e) => e.kind === "offset");
    eq(offs.length, 96, "40 + 7 Character + 8 GonObject + 17 per-unit glow (#86) + 10 facing (Character::Face) + 8 campaign walk + 6 glow v2 (per-unit screen rects)");
  });
  if (exe) {
    const m = loadManifest(realPath);
    const p = parsePe(exe);
    test("T1 real exe: every manifest function signature matches exactly once at its rva", () => {
            const bad: string[] = [];
      for (const e of m.entries) {
        if (e.kind !== "function" || !e.signature) continue;
        const r = scanExec(p, exe, parsePattern(e.signature!.pattern, m.sigCap));
        if (r.count !== 1 || r.hits[0] + e.signature!.offset !== parseInt(e.rva!, 16)) bad.push(`${e.name}: ${r.count} hits, first 0x${(r.hits[0] ?? -1).toString(16)} + offset ${e.signature!.offset}`);
      }
      assert(bad.length === 0, bad.join("; "));
      assert(m.entries.filter((e) => e.kind === "function" && e.signature).length >= 34, "all TSV code rows carried over (incl. Status_ApplyLuckUp, now unique at 76 bytes)");
    });
    test("T1 real exe: every function entry (signed or raw) begins a .pdata RUNTIME_FUNCTION; vtables have file bytes; data globals sit inside a section", () => {
            const bad: string[] = [];
      for (const e of m.entries) {
        if (e.kind === "function") {
          const rva = parseInt(e.rva!, 16);
          const f = p.pdata.find(rva);
          if (!f || f.begin !== rva) bad.push(`${e.name} 0x${rva.toString(16)} is not a function start (${f ? "inside 0x" + f.begin.toString(16) : "no pdata"})`);
        } else if (e.kind === "vtable") {
          if (p.rvaToOff(parseInt(e.rva!, 16)) < 0) bad.push(`${e.name} has no file byte`);
        } else if (e.kind === "data") {
          // globals may live in .data's zero-filled tail (no file byte), but must be inside a section
          if (!p.sectionOf(parseInt(e.rva!, 16))) bad.push(`${e.name} is outside every section`);
        }
      }
      assert(bad.length === 0, bad.join("; "));
    });
  }
  // ---- gen-headers.ts: signatures.h / offsets.h generated from the manifests -------------
  console.log("\n# Bindings: header generator (signatures.h / offsets.h from bindings/*.json)");
  const gen = await load<typeof import("../src/core/bindings/gen-headers.ts")>("../src/core/bindings/gen-headers.ts");
  if ("__error" in gen) {
    test("gen-headers.ts loads", () => assert(false, gen.__error));
    return;
  }
  const { genSignaturesH, genOffsetsH, generateHeaders, GenError, HEADER_PATHS } = gen;
  const m25 = loadManifest(realPath);
    /** @returns a second build that only differs in identity */
  const cloneBuild = (): any => {
    const c = JSON.parse(JSON.stringify(m25));
    c.build = { ...c.build, steamBuildId: "99", name: "9.9.9 (steam 99)", timeDateStamp: "0x22222222", sizeOfImage: "0x1580000", exeSha256: "b".repeat(64) };
    return c;
  };
    const nl = (t: string) => t.replace(/\r\n/g, "\n");

  test("genSignaturesH: one SymbolSig table per build in FwSymbol order, FW_LK rva table, FW_BUILDS row with pointers", () => {
    const h = genSignaturesH([m25]);
    assert(h.includes("GENERATED"), "banner");
    assert(h.includes("static const SymbolSig FW_SYMBOLS_25143593[FW_SYMBOL_COUNT_]"), "symbol table");
    const first = h.indexOf("\"TurnControl_NextTurn\"");
    const second = h.indexOf("\"Character_BeginTurn\"");
    const last = h.indexOf("\"string_Allocate\"");
    assert(first > 0 && second > first && last > second, "FwSymbol order");
    const nt = entry(m25, "TurnControl_NextTurn")!;
    assert(h.includes(`"TurnControl_NextTurn", "${nt.signature!.pattern}", ${nt.signature!.offset}, 0x8e3c60u`), "pattern, offset, expectedRva from the manifest");
    const sp = entry(m25, "SaveProps_GetOrCreate")!;
    assert(h.includes(`"SaveProps_GetOrCreate", "${sp.signature!.pattern}", ${sp.signature!.offset}, 0x61ea0u`) && sp.signature!.offset < 0, "negative SymbolSig.offset carried through");
    assert(h.includes(`{ "LuckUp_ctor", NULL, 0, 0x711c90u },`), "a null-signature FwSymbol ships as NULL + raw RVA");
    assert(h.includes("#define FW_LK_COUNT 13"), "lk count");
    assert(h.includes("static const uint32_t FW_LK_RVAS_25143593[FW_LK_COUNT]"), "lk table");
    assert(/FW_LK_RVAS_25143593\[FW_LK_COUNT\] = \{\s*0x4929c0u,[^\n]*\n\s*0x492c20u,[\s\S]*0x502b40u,[^\n]*\n\s*\}/.test(h), "lk order");
    assert(h.includes("0x6a9c51e5u, 0x01574000u"), "identity");
    assert(h.includes("0x00f57ab8u") && h.includes("0x00ed1960u") && h.includes("0x013c4d30u") && h.includes("0x4d6u"), "vtables, default source, type id");
    assert(/0x013c4a30u,\s*\/\* FW_DATA_App \*\//.test(h), "rva_data in FwData order with enumerator comments");
    assert(h.includes("FW_SYMBOLS_25143593, FW_LK_RVAS_25143593"), "BuildInfo points at its own tables");
    assert(h.includes("#define FW_BUILD_COUNT"), "count macro");
    assert(!h.includes("FW_SYMBOLS["), "no global FW_SYMBOLS table any more");
  });
  test("genSignaturesH: two manifests -> two BuildInfo rows and two symbol tables", () => {
    const h = genSignaturesH([m25, cloneBuild()]);
    assert(h.includes("FW_SYMBOLS_25143593[") && h.includes("FW_SYMBOLS_99["), "both tables");
    assert(h.includes("0x22222222u, 0x01580000u"), "second identity");
    eq((h.match(/\{ "1\.1\.21239 \(steam 25143593\)"|\{ "9\.9\.9 \(steam 99\)"/g) || []).length, 2);
  });
  test("genOffsetsH: every offset/constant macro once, negative offsets parenthesised", () => {
    const h = genOffsetsH([m25]);
    assert(/^#define OFF_STATUS_STACKS\s+0x5c/m.test(h), "stacks");
    assert(/^#define VT_SLOTS\s+172/m.test(h), "slots");
    assert(/^#define OFF_APPLIER_OWNER\s+\(-0x8\)/m.test(h), "negative");
    assert(/^#define OFF_X_CHARARRAY\s+0x1f90/m.test(h), "mewtest offset");
    assert(/^#define VT_ONSTACKSCHANGED\s+170/m.test(h), "vtable slot");
    const macros = m25.entries.flatMap((e) => e.exposure.filter((x): x is MacroExposure => "macro" in x).map((x) => x.macro));
    for (const mac of macros) eq((h.match(new RegExp(`^#define ${mac} `, "gm")) || []).length, 1, mac);
    assert(/\/\* Status \+0x5c int32 .*status_stacks/.test(h) || h.includes("Status_stacks"), "comment names the struct/entry");
  });
  test("genOffsetsH: manifests that disagree on a macro throw GenError naming the entry and builds", () => {
    const other = cloneBuild();
    const st = other.entries.find((e: Entry) => e.name === "Status_stacks")!;
    st.value = "0x60";
    let err = null;
    try { genOffsetsH([m25, other]); } catch (e) { err = e; }
    assert(err instanceof GenError, `expected GenError, got ${String(err)}`);
    assert(/Status_stacks/.test(String(err)) && /25143593/.test(String(err)) && /99/.test(String(err)), String(err));
    eq(typeof genOffsetsH([m25, cloneBuild()]), "string", "agreeing manifests are fine");
  });
  test("genSignaturesH: an FwSymbol entry with signature: null is emitted with a NULL pattern and its raw RVA (the DLL falls back to expectedRva on the identified build)", () => {
    // 2026-10-21: LuckUp_ctor has no relocation-free unique window (notes-bind §1.2), so a null signature must be a
    // first-class state for a symbol the DLL resolves, not a GenError.
    const m = cloneBuild();
    const nt = entry(m, "TurnControl_NextTurn")!;
    nt.signature = null;
    const h = genSignaturesH([m]);
    assert(h.includes(`{ "TurnControl_NextTurn", NULL, 0, 0x8e3c60u },  /* FW_SYM_TurnControl_NextTurn (raw RVA: no signature on this build) */`), h.split("\n").filter((l) => l.includes("TurnControl_NextTurn")).join("\n"));
    const cb = entry(m, "Character_BeginTurn")!;
    assert(h.includes(`{ "Character_BeginTurn", "${cb.signature!.pattern}", 0, 0x`), "signed entries unchanged");
  });
  test("generateHeaders returns both files keyed by repo-relative path", () => {
    const out = generateHeaders([m25]);
    eq(Object.keys(out).sort().join(","), [HEADER_PATHS.offsets, HEADER_PATHS.signatures].sort().join(","));
    eq(HEADER_PATHS.signatures, "native/framework/src/signatures.h");
    eq(HEADER_PATHS.offsets, "native/framework/src/offsets.h");
  });
  test("golden: committed signatures.h and offsets.h equal the generated text (else run `npm run bindings:gen`)", () => {
    const { listManifests } = man;
    const out = generateHeaders(listManifests().map((x: ReturnType<typeof listManifests>[number]) => x.manifest));
    for (const [rel, text] of Object.entries(out)) {
      const p = join(REPO_ROOT, rel);
      assert(existsSync(p), `${rel} missing`);
      eq(nl(readFileSync(p, "utf8")), nl((text as string)), `${rel} is stale`);
    }
  });
  // ---- siggen.ts: unique signatures with relocation bytes wildcarded ---------------
  console.log("\n# Bindings: signature generator (wildcards rel32 / rip-relative disp32)");
  const sg = await load<typeof import("../src/core/bindings/siggen.ts")>("../src/core/bindings/siggen.ts");
  if ("__error" in sg) {
    test("siggen.ts loads", () => assert(false, sg.__error));
    return;
  }
  const { decodeRelocs, makeSignature } = sg;
    const u8 = (xs: number[]) => Uint8Array.from(xs);

  test("decodeRelocs: E8/E9 rel32, Jcc rel32, FF 15 and rip-relative ModRM disp32, movabs imm64", () => {
    const code = u8([
      0x40, 0x53,                                     // push rbx
      0x48, 0x83, 0xec, 0x20,                         // sub rsp,0x20
      0xe8, 0x11, 0x22, 0x33, 0x44,                   // call rel32          -> [7..10]
      0x48, 0x8d, 0x0d, 0xaa, 0xbb, 0xcc, 0xdd,       // lea rcx,[rip+disp32] -> [14..17]
      0x0f, 0x84, 0x01, 0x02, 0x03, 0x04,             // je rel32            -> [20..23]
      0xff, 0x15, 0x05, 0x06, 0x07, 0x08,             // call [rip+disp32]   -> [26..29]
      0x48, 0xb8, 1, 2, 3, 4, 5, 6, 7, 8,             // movabs rax, imm64   -> [32..39]
      0x48, 0x8b, 0x05, 0x09, 0x0a, 0x0b, 0x0c,       // mov rax,[rip+disp32] -> [43..46]
      0xe9, 0x10, 0x20, 0x30, 0x40,                   // jmp rel32           -> [48..51]
      0xc3,
    ]);
    const r = decodeRelocs(code);
    eq(r.map((x: { at: number; len: number }) => `${x.at}+${x.len}`).join(" "), "7+4 14+4 20+4 26+4 32+8 43+4 48+4");
    assert(r.every((x: { why: string }) => typeof x.why === "string" && x.why.length > 0), "why strings");
  });
  test("decodeRelocs: frame sizes, imm32 constants and non-rip memory operands stay exact; unknown opcodes stop decoding", () => {
    const code = u8([
      0x48, 0x81, 0xec, 0xd0, 0x00, 0x00, 0x00,       // sub rsp, imm32 (frame size: keep)
      0xb8, 0xd8, 0x11, 0x00, 0x00,                   // mov eax, imm32 (keep)
      0x48, 0x89, 0x5c, 0x24, 0x08,                   // mov [rsp+8], rbx (SIB + disp8: keep)
      0x48, 0x8b, 0x81, 0x10, 0x0e, 0x00, 0x00,       // mov rax,[rcx+0xe10] (disp32, not rip: keep)
      0xc7, 0x05, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, // mov dword [rip+disp32], imm32 -> wildcard disp only [26..29]
      0x0f, 0x0b,                                     // ud2: unknown-ish -> allowed; then
      0xd6,                                           // invalid opcode: decoding stops
      0xe8, 0x11, 0x22, 0x33, 0x44,                   // would be a call, but after the stop it stays exact
    ]);
    const r = decodeRelocs(code);
    eq(r.map((x: { at: number; len: number }) => `${x.at}+${x.len}`).join(" "), "26+4");
  });

  /** Two functions sharing a prologue, differing in a call target and in one byte after the call. */
  const fnA = [0x40, 0x53, 0x48, 0x83, 0xec, 0x20, 0xe8, 0x10, 0x00, 0x00, 0x00, 0x48, 0x8b, 0xd8, 0x48, 0x83, 0xc4, 0x20, 0x5b, 0xc3];
  const fnB = [0x40, 0x53, 0x48, 0x83, 0xec, 0x20, 0xe8, 0x20, 0x00, 0x00, 0x00, 0x48, 0x8b, 0xf8, 0x48, 0x83, 0xc4, 0x20, 0x5b, 0xc3];
    const twoFns = (a: number[], b: number[]) => {
    const text = new Uint8Array(0x200);
    text.set(a, 0x10);
    text.set(b, 0x80);
    return buildFakePe({ sections: [{ name: ".text", bytes: text, exec: true }], pdata: [{ section: ".text", begin: 0x10, end: 0x10 + a.length }, { section: ".text", begin: 0x80, end: 0x80 + b.length }] });
  };

  test("makeSignature: the rel32 is wildcarded and the pattern is still unique (distinguished by a fixed byte)", () => {
    const f = twoFns(fnA, fnB);
    const p = parsePe(f.buf);
    const r = makeSignature(p, f.buf, f.rva(".text", 0x10), { minLen: 12 });
    assert(r.ok, r.ok ? "" : r.reason);
    if (!r.ok) return;
    eq(r.signature!.pattern, "40 53 48 83 EC 20 E8 ?? ?? ?? ?? 48 8B D8");
    eq(r.signature!.offset, 0);
    eq(r.signature!.exactLen, 14);
    eq(r.signature!.wildcards.length, 1);
    eq(r.signature!.wildcards[0].at, 7);
    eq(r.signature!.wildcards[0].len, 4);
    eq(scanExec(p, f.buf, parsePattern(r.signature!.pattern)).count, 1);
  });
  test("makeSignature: a relinked copy (different rel32) still matches the wildcarded pattern once", () => {
    const f1 = twoFns(fnA, fnB);
    const p1 = parsePe(f1.buf);
    const r = makeSignature(p1, f1.buf, f1.rva(".text", 0x10), { minLen: 12 });
    assert(r.ok, "ok");
    if (!r.ok) return;
    const fnA2 = fnA.slice(); fnA2[7] = 0x77; fnA2[8] = 0x66;
    const f2 = twoFns(fnA2, fnB);
    const p2 = parsePe(f2.buf);
    const hit = scanExec(p2, f2.buf, parsePattern(r.signature!.pattern));
    eq(hit.count, 1);
    eq(hit.hits[0], f2.rva(".text", 0x10));
  });
  test("makeSignature: never ends inside a wildcard run (extends to the next fixed byte)", () => {
    // unique already at the first rel32 byte, but the pattern must run through the rel32 to a fixed byte
    const a = [0x40, 0x53, 0x48, 0x83, 0xec, 0x20, 0x48, 0x8b, 0xd9, 0xe8, 0x10, 0x00, 0x00, 0x00, 0xc3];
    const b = [0x40, 0x53, 0x48, 0x83, 0xec, 0x20, 0x48, 0x8b, 0xd9, 0xe8, 0x20, 0x00, 0x00, 0x00, 0xcc];
    const f = twoFns(a, b);
    const p = parsePe(f.buf);
    const r = makeSignature(p, f.buf, f.rva(".text", 0x10), { minLen: 8 });
    assert(r.ok, r.ok ? "" : r.reason);
    if (!r.ok) return;
    eq(r.signature!.pattern, "40 53 48 83 EC 20 48 8B D9 E8 ?? ?? ?? ?? C3");
    assert(!r.signature!.pattern.endsWith("??"), "fixed tail");
  });
  test("makeSignature: honours the cap (ok:false with a reason) when no unique prefix exists", () => {
    const shared = Array.from({ length: 40 }, (_, i) => [0x48, 0x8b, 0xc1, 0x90][i % 4]); // 40 identical, reloc-free bytes
    const a = [...shared, 0x48, 0x8b, 0xd8, 0xc3];
    const b = [...shared, 0x48, 0x8b, 0xf8, 0xc3];
    const f = twoFns(a, b);
    const p = parsePe(f.buf);
    const r = makeSignature(p, f.buf, f.rva(".text", 0x10), { minLen: 12, cap: 32, maxOffset: 0 });
    assert(!r.ok, "must fail");
    if (r.ok) return;
    assert(/32/.test(r.reason), r.reason);
  });
  test("makeSignature: falls back to a later start with a negative offset when the prologue is shared", () => {
    const shared = Array.from({ length: 40 }, (_, i) => [0x48, 0x8b, 0xc1, 0x90][i % 4]);
    const a = [...shared, 0x48, 0x8b, 0xd8, 0x90, 0x90, 0x90, 0x90, 0x90, 0x90, 0x90, 0x90, 0x90, 0xc3];
    const b = [...shared, 0x48, 0x8b, 0xf8, 0x90, 0x90, 0x90, 0x90, 0x90, 0x90, 0x90, 0x90, 0x90, 0xc3];
    const f = twoFns(a, b);
    const p = parsePe(f.buf);
    const r = makeSignature(p, f.buf, f.rva(".text", 0x10), { minLen: 12, cap: 32, maxOffset: 64 });
    assert(r.ok, r.ok ? "" : r.reason);
    if (!r.ok) return;
    assert(r.signature!.offset < 0, `offset ${r.signature!.offset}`);
    const hit = scanExec(p, f.buf, parsePattern(r.signature!.pattern));
    eq(hit.count, 1);
    eq(hit.hits[0] + r.signature!.offset, f.rva(".text", 0x10), "hit + offset == function start");
  });
  test("decodeRelocs: a relocation that straddles the window end is clamped, never dropped (the first bytes of a cut disp32 are not exact bytes)", () => {
    // 2026-10-21 (notes-bind §2.1): LuckUp_ctor's committed pattern ended in `48 8D 05 95 5D` and Status_GetCategory's in
    // `48 8D 0D 6F` because a reloc whose 4 bytes ran past the window was discarded, so the window's last bytes stayed exact.
    const cut = u8([
      0x40, 0x53,                                     // push rbx
      0x48, 0x83, 0xec, 0x20,                         // sub rsp,0x20
      0x48, 0x8d, 0x05, 0x95, 0x5d,                   // lea rax,[rip+disp32] cut after 2 of its 4 disp bytes -> [9..10]
    ]);
    eq(decodeRelocs(cut).map((x: { at: number; len: number }) => `${x.at}+${x.len}`).join(" "), "9+2");
    const callCut = u8([0x40, 0x53, 0xe8, 0x11]);    // call rel32 cut after 1 byte -> [3..3]
    eq(decodeRelocs(callCut).map((x: { at: number; len: number }) => `${x.at}+${x.len}`).join(" "), "3+1");
    const opcodeOnly = u8([0x40, 0x53, 0x48, 0x8d]); // the lea's ModRM is outside the window: nothing to clamp
    eq(decodeRelocs(opcodeOnly).length, 0);
  });
  test("decodeRelocs: the 66 operand-size prefix shrinks imm32 to imm16 (mov word [reg+disp32], imm16 must not swallow the next instruction)", () => {
    // LuckUp_ctor +131: `66 C7 83 E8 00 00 00 01 00` (mov word [rbx+0xe8],1) is followed by the vftable lea; decoding the
    // immediate as 4 bytes desynced the decoder and the lea's disp32 was never masked (found 2026-10-21 by the clamp test)
    const code = u8([
      0x66, 0xc7, 0x83, 0xe8, 0x00, 0x00, 0x00, 0x01, 0x00,   // mov word [rbx+0xe8], 1   (9 bytes)
      0x48, 0x8d, 0x05, 0x11, 0x22, 0x33, 0x44,               // lea rax,[rip+disp32]     -> [12..15]
      0x66, 0x81, 0x7b, 0x0c, 0x02, 0x00,                     // cmp word [rbx+0xc], 2    (6 bytes)
      0x66, 0xb8, 0x01, 0x00,                                 // mov ax, 1                (4 bytes)
      0x66, 0x3d, 0x02, 0x00,                                 // cmp ax, 2                (4 bytes)
      0xe8, 0x01, 0x02, 0x03, 0x04,                           // call rel32               -> [31..34]
      0xc3,
    ]);
    eq(decodeRelocs(code).map((x: { at: number; len: number }) => `${x.at}+${x.len}`).join(" "), "12+4 31+4");
  });
  test("makeSignature: a clamped tail reloc is masked, so the window must extend to the next fixed byte (or move on)", () => {
    // two functions identical up to a lea whose disp32 differs, then one differing byte; a 24-byte cap cuts the first
    // window inside the disp32: the old generator returned those two disp bytes as exact (unique only through a relocation)
    const head = [0x40, 0x53, 0x48, 0x83, 0xec, 0x20, 0x48, 0x8b, 0xd9, 0x48, 0x8b, 0xfa, 0x48, 0x8b, 0xf1, 0x90, 0x90, 0x90, 0x90];
    const a = [...head, 0x48, 0x8d, 0x05, 0x11, 0x22, 0x33, 0x44, 0x48, 0x8b, 0xd8, 0xc3];
    const b = [...head, 0x48, 0x8d, 0x05, 0x55, 0x66, 0x77, 0x88, 0x48, 0x8b, 0xf8, 0xc3];
    const f = twoFns(a, b);
    const p = parsePe(f.buf);
    const r = makeSignature(p, f.buf, f.rva(".text", 0x10), { minLen: 12, cap: 24, maxOffset: 0 });
    assert(!r.ok, `a 24-byte window ends inside the disp32 and the bytes before it are shared: must fail, got ${r.ok ? r.signature.pattern : ""}`);
    const r2 = makeSignature(p, f.buf, f.rva(".text", 0x10), { minLen: 12, cap: 32, maxOffset: 0 });
    assert(r2.ok, r2.ok ? "" : r2.reason);
    if (!r2.ok) return;
    eq(r2.signature.pattern, "40 53 48 83 EC 20 48 8B D9 48 8B FA 48 8B F1 90 90 90 90 48 8D 05 ?? ?? ?? ?? 48 8B D8");
  });
  test("makeSignature: every tried window starts on an instruction boundary of the function (never inside an instruction)", () => {
    // Status_ApplyLuckUp's committed signature started at +40, inside `49 8B F1` (+38): the lite decoder stopped at once and
    // nothing in the 35-byte pattern was masked (a raw jmp rel32 and two disp32 bytes). Starts are instruction boundaries now.
    const shared = Array.from({ length: 36 }, (_, i) => [0x48, 0x8b, 0xc1][i % 3]);   // 36 bytes: 12 x mov rax,rcx (3-byte instructions)
    const a = [...shared, 0x90, 0x90, 0x48, 0x8d, 0x05, 0x11, 0x22, 0x33, 0x44, 0x48, 0x8b, 0xd8, 0xc3];
    const b = [...shared, 0x90, 0x90, 0x48, 0x8d, 0x05, 0x55, 0x66, 0x77, 0x88, 0x48, 0x8b, 0xf8, 0xc3];
    const f = twoFns(a, b);
    const p = parsePe(f.buf);
    const r = makeSignature(p, f.buf, f.rva(".text", 0x10), { minLen: 12, cap: 32, maxOffset: 64 });
    assert(r.ok, r.ok ? "" : r.reason);
    if (!r.ok) return;
    const start = -r.signature.offset;
    assert(start % 3 === 0 && start <= 36, `window start +${start} is inside a 3-byte mov (the step-8 generator picked +16)`);
    assert(r.signature.pattern.includes("48 8D 05 ?? ?? ?? ??"), `the lea's disp32 is masked: ${r.signature.pattern}`);
    const hit = scanExec(p, f.buf, parsePattern(r.signature.pattern));
    eq(hit.count, 1);
    eq(hit.hits[0] + r.signature.offset, f.rva(".text", 0x10));
  });
  if (exe) {
    test("T1 real exe: every manifest function signature regenerates unique at its rva; >= 5 carry wildcards; Status_GetCategory fits the cap or is reported", () => {
      const m = loadManifest(realPath);
      const p = parsePe(exe);
      const bad: string[] = [];
      let wild = 0;
      let n = 0;
      let cat = "";
      // Twins whose only distinguishing bytes are RIP-relative displacements: the hardened generator (2026-10-22)
      // masks those and finds no window, but their manifest patterns (made before the hardening) still scan unique
      // at their RVAs on this build; a new build needs a hand-made seed (docs/binding-port.md "Known limits").
      const LEGACY_WINDOWS = new Set(["GonObject_Int", "GonObject_Number"]);
      let legacy = 0;
      for (const e of m.entries) {
        if (e.kind !== "function" || !e.signature) continue;
        n++;
        const rva = parseInt(e.rva!, 16);
        const r = makeSignature(p, exe, rva, { minLen: 12, cap: m.sigCap });
        if (!r.ok) {
          if (e.name === "Status_GetCategory") cat = r.reason;
          else if (LEGACY_WINDOWS.has(e.name)) {
            const own = scanExec(p, exe, parsePattern(e.signature.pattern, m.sigCap));
            if (own.count !== 1 || own.hits[0] + e.signature.offset !== rva) bad.push(`${e.name}: legacy pattern ${own.count} hits`);
            else legacy++;
          } else bad.push(`${e.name}: ${r.reason}`);
          continue;
        }
        if (r.signature!.wildcards.length) wild++;
        const hit = scanExec(p, exe, parsePattern(r.signature!.pattern, m.sigCap));
        if (hit.count !== 1 || hit.hits[0] + r.signature!.offset !== rva) bad.push(`${e.name}: ${hit.count} hits`);
        if (r.signature!.pattern.endsWith("??")) bad.push(`${e.name}: ends in a wildcard`);
        if (e.name === "Status_GetCategory") cat = `ok ${r.signature!.exactLen} bytes, offset ${r.signature!.offset}`;
      }
      assert(bad.length === 0, bad.join("; "));
      assert(n >= 34, `functions with signatures: ${n}`);
      assert(wild >= 5, `only ${wild} of ${n} signatures needed wildcards (6 on build 25143593)`);
      eq(legacy, LEGACY_WINDOWS.size, "both legacy windows still scan unique at their RVAs");
      console.log(`      Status_GetCategory: ${cat}; ${wild}/${n} signatures carry wildcards; ${legacy} legacy windows verified`);
    });
  }
  // ---- check.ts: is the installed exe a known build, and do the signatures still hold? ----
  console.log("\n# Bindings: check-build (identity + per-signature scan)");
  const ck = await load<typeof import("../src/core/bindings/check.ts")>("../src/core/bindings/check.ts");
  if ("__error" in ck) {
    test("check.ts loads", () => assert(false, ck.__error));
    return;
  }
  const { checkBuild, checkInstalledBuild } = ck;
  const apiLoaded = await load<typeof import("../src/core/api.ts")>("../src/core/api.ts");
  const apiErr = "__error" in apiLoaded ? apiLoaded.__error : "";
  const apiMod = "__error" in apiLoaded ? null : apiLoaded;

  /** A fake build with two signed functions, as a manifest + PE pair. */
  const fakeKnownPe = twoFns(fnA, fnB);
  const fakeKnownParsed = parsePe(fakeKnownPe.buf);
  const sigA = makeSignature(fakeKnownParsed, fakeKnownPe.buf, fakeKnownPe.rva(".text", 0x10), { minLen: 12 });
  const sigB = makeSignature(fakeKnownParsed, fakeKnownPe.buf, fakeKnownPe.rva(".text", 0x80), { minLen: 12 });
  assert(sigA.ok && sigB.ok, "fake signatures");
    const fakeManifest = parseManifest({
    format: 1,
    build: { steamBuildId: "777", gameVersion: "7.7.7", name: "7.7.7 (steam 777)", timeDateStamp: "0x11111111", sizeOfImage: "0x" + fakeKnownParsed.sizeOfImage.toString(16), imageBase: "0x140000000", exeSha256: "c".repeat(64), exeSize: fakeKnownPe.buf.length, sdlVersion: "3.2.12" },
    sigCap: 128,
    entries: [
      { name: "FnA", kind: "function", rva: "0x" + fakeKnownPe.rva(".text", 0x10).toString(16), signature: sigA.ok ? sigA.signature : null, anchors: {}, consumers: [], exposure: [{ enum: "FW_SYM_FnA", index: 0 }], evidence: [] },
      { name: "FnB", kind: "function", rva: "0x" + fakeKnownPe.rva(".text", 0x80).toString(16), signature: sigB.ok ? sigB.signature : null, anchors: {}, consumers: [], exposure: [{ enum: "FW_SYM_FnB", index: 1 }], evidence: [] },
      { name: "FnRaw", kind: "function", rva: "0x" + fakeKnownPe.rva(".text", 0x80).toString(16), signature: null, anchors: {}, consumers: [], exposure: [{ table: "FW_LK", index: 0, shape: "A" }], evidence: [] },
      { name: "Glob", kind: "data", rva: "0x" + fakeKnownPe.rva(".text", 0x100).toString(16), anchors: { unanchored: true }, consumers: [], exposure: [{ enum: "FW_DATA_Glob", index: 0 }], evidence: [] },
    ],
  });

  test("checkBuild: a known build -> known:true, matched manifest, every signature ok", () => {
    const r = checkBuild(fakeKnownPe.buf, [fakeManifest]);
    eq(r.known, true);
    eq(r.build.matched && r.build.matched.steamBuildId, "777");
    eq(r.build.timeDateStamp, "0x11111111");
    eq(r.entries.map((e) => `${e.name}:${e.status}`).join(","), "FnA:ok,FnB:ok");
    eq(r.summary.ok, 2);
    eq(r.summary.unscanned, 2, "raw-RVA function + data entry are not scannable");
    eq(r.summary.total, 4);
  });
  test("checkBuild: a relinked build -> known:false, signatures reported as moved / missing / ok", () => {
    // fnA moves 0x20 bytes later; fnB stays; the stamp changes
    const text = new Uint8Array(0x200);
    text.set(fnA, 0x30);
    text.set(fnB, 0x80);
    const shifted = buildFakePe({ timeDateStamp: 0x22222222, sections: [{ name: ".text", bytes: text, exec: true }], pdata: [{ section: ".text", begin: 0x30, end: 0x30 + fnA.length }, { section: ".text", begin: 0x80, end: 0x80 + fnB.length }] });
    const r = checkBuild(shifted.buf, [fakeManifest]);
    eq(r.known, false);
    eq(r.build.matched, null);
    eq(r.build.timeDateStamp, "0x22222222");
    eq(r.build.scannedWith, "777", "falls back to the newest manifest to show how many signatures survive");
    const by: Record<string, CheckEntry> = Object.fromEntries(r.entries.map((e) => [e.name, e]));
    eq(by.FnA.status, "moved");
    eq(by.FnA.hit, "0x" + shifted.rva(".text", 0x30).toString(16));
    eq(by.FnB.status, "ok");
    // a build where fnA is gone entirely
    const gone = buildFakePe({ timeDateStamp: 0x33333333, sections: [{ name: ".text", bytes: (() => { const t = new Uint8Array(0x200); t.set(fnB, 0x80); return t; })(), exec: true }] });
    const g = checkBuild(gone.buf, [fakeManifest]);
    eq(g.entries.find((e) => e.name === "FnA")!.status, "missing");
    eq(g.summary.missing, 1);
  });
  test("checkInstalledBuild: reads <gameDir>/Mewgenics.exe (MEWGENICS_DIR); absent -> ok:false, skipped", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mewcheck-"));
    try {
      const empty = checkInstalledBuild({ env: { MEWGENICS_DIR: tmp }, manifests: [fakeManifest] });
      assert(!empty.ok && empty.skipped, JSON.stringify(empty));
      assert(!empty.ok && /Mewgenics\.exe/.test(empty.reason), !empty.ok ? empty.reason : "ok");
      writeFileSync(join(tmp, "Mewgenics.exe"), fakeKnownPe.buf);
      const r = checkInstalledBuild({ env: { MEWGENICS_DIR: tmp }, manifests: [fakeManifest] });
      assert(r.ok, JSON.stringify(r));
      if (!r.ok) return;
      eq(r.known, true);
      eq(r.exePath, join(tmp, "Mewgenics.exe"));
      eq(typeof r.sha256, "string");
      eq(r.sha256.length, 64);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
  test("make-signature.ts --manifest: a signature-less entry is listed as `skipped (null)` instead of vanishing from the report", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mewsig-"));
    try {
      writeFileSync(join(tmp, "fake.exe"), fakeKnownPe.buf);
      writeFileSync(join(tmp, "m.json"), JSON.stringify(fakeManifest));
      const r = spawnSync(process.execPath, [join(REPO_ROOT, "tools", "bindings", "make-signature.ts"), join(tmp, "fake.exe"), "--manifest", join(tmp, "m.json")], { encoding: "utf8" });
      const out = (r.stdout || "") + (r.stderr || "");
      eq(r.status, 0, out.slice(-400));
      assert(/skipped \(null\)\s+FnRaw/.test(out), `expected a "skipped (null)  FnRaw" line, got:\n${out}`);
      assert(/unchanged\s+FnA/.test(out) && /unchanged\s+FnB/.test(out), out);
      assert(/0 changed, 2 unchanged, 0 failed, 1 skipped \(null\)/.test(out), `summary counts the skipped entries: ${out.split("\n").slice(-3).join(" | ")}`);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
  test("api.checkGameBuild forwards env/manifests and never throws on a missing exe", () => {
    assert(apiMod !== null, apiErr);
    const tmp = mkdtempSync(join(tmpdir(), "mewcheck-"));
    try {
      const r = apiMod!.checkGameBuild({ env: { MEWGENICS_DIR: tmp }, manifests: [fakeManifest] });
      assert(!r.ok && r.skipped, JSON.stringify(r));
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
  if (exe) {
    test("T1 real exe: checkInstalledBuild against bindings/*.json -> known build 25143593, every signature ok", () => {
      const r = checkInstalledBuild({ env: process.env });
      assert(r.ok, JSON.stringify(r));
      if (!r.ok) return;
      eq(r.known, true);
      eq(r.build.matched && r.build.matched.steamBuildId, "25143593");
      eq(r.summary.ok, r.entries.length, r.entries.filter((e) => e.status !== "ok").map((e) => `${e.name}:${e.status}`).join(","));
      assert(r.summary.ok >= 34, `ok ${r.summary.ok}`);
    });
  }
  // ---- harvest.ts: anchors that survive a recompile ------------------------------------
  console.log("\n# Bindings: harvest (strings, callees, rip refs, RTTI, vtable slots, witnesses)");
  const hv = await load<typeof import("../src/core/bindings/harvest.ts")>("../src/core/bindings/harvest.ts");
  if ("__error" in hv) {
    test("harvest.ts loads", () => assert(false, hv.__error));
    return;
  }
  const { findString, findStringXrefs, harvestFunction, findRtti, vtableSlotTarget, deriveFromVtableSlot, harvestManifest } = hv;
  test("rdataWitnessValue: f32 reads the float as an integer constant, f32-recip its rounded reciprocal (1/1280 -> 1280, the float 1/720 -> 720), anything not integral within 1e-3 is null", () => {
    const bits = (f: number) => { const b = Buffer.alloc(4); b.writeFloatLE(f, 0); return b.readUInt32LE(0); };
    eq(hv.rdataWitnessValue(0x3a4ccccd, "f32-recip"), 1280);
    eq(hv.rdataWitnessValue(0x3ab60b61, "f32-recip"), 720);
    eq(hv.rdataWitnessValue(bits(640), "f32"), 640);
    eq(hv.rdataWitnessValue(bits(0.3), "f32-recip"), null);
    eq(hv.rdataWitnessValue(bits(2.5), "f32"), null);
    eq(hv.rdataWitnessValue(0, "f32-recip"), null);
    eq(hv.rdataWitnessValue(bits(640), "other"), null);
    assert(hv.constantHasSources({ witness: { function: "F", pattern: "F3 0F 59 0D", ripAt: 4, rdata: "f32-recip" } } as never), "an rdata witness is a source");
  });

  /**
   * A fake image: .text at 0x1000, .hvRdata at 0x2000, .hvData at 0x3000 (builder layout, each section < 1 page).
   *   hvFnA 0x1010: lea rcx,[rip->funcsig]; call fnB; mov rax,[rip->Glob]; ret
   *   fnB 0x1040: mov eax,0x4d6; ret            (vtable slot 1 body)
   *   fnC 0x1060: push rbx; ...; ret            (vtable slot 0 body)
   *   .hvRdata: funcsig string @+0x10, "Dup" twice, COL @+0x40, vftable @+0x80 (COL pointer @+0x78)
   *   .hvData:  TypeDescriptor @+0x20 (name @+0x30), Glob @+0x100
   */
  const FUNCSIG = "int __cdecl glaiel::foo(void)";
  const TEXT = 0x1000, RDATA = 0x2000, DATA = 0x3000, BASE = 0x140000000;
  const le32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  const hvText = new Uint8Array(0x100);
  const hvFnA = [
    0x48, 0x8d, 0x0d, ...le32((RDATA + 0x10) - (TEXT + 0x17)),   // lea rcx,[rip+disp] -> funcsig
    0xe8, ...le32((TEXT + 0x40) - (TEXT + 0x1c)),                 // call fnB
    0x48, 0x8b, 0x05, ...le32((DATA + 0x100) - (TEXT + 0x23)),   // mov rax,[rip+disp] -> Glob
    0xc3,
  ];
  hvText.set(hvFnA, 0x10);
  hvText.set([0xb8, 0xd6, 0x04, 0x00, 0x00, 0xc3], 0x40);
  hvText.set([0x40, 0x53, 0x48, 0x83, 0xec, 0x20, 0x48, 0x8b, 0xd9, 0x48, 0x83, 0xc4, 0x20, 0x5b, 0xc3], 0x60);
  //   hvFnD 0x1080: mov r8d,0x4d6; call fnB; ret   (passes the type id as an argument: the call-arg witness)
  hvText.set([0x41, 0xb8, 0xd6, 0x04, 0x00, 0x00, 0xe8, ...le32((TEXT + 0x40) - (TEXT + 0x8b)), 0xc3], 0x80);
  //   hvFnE 0x1090: mov eax,[rcx+0x5c]; mov eax,[rcx+0xf8] (= -8); call [rax+0x550]; mov edx,[rcx+0x12345678]; ret
  //   (a displacement witness host: byte disps, a vtable-slot call whose disp/8 is a slot index, a disp32)
  hvText.set([0x8b, 0x41, 0x5c, 0x8b, 0x41, 0xf8, 0xff, 0x90, 0x50, 0x05, 0x00, 0x00, 0x8b, 0x91, 0x78, 0x56, 0x34, 0x12, 0xc3], 0x90);
  const hvPdata = [{ section: ".text", begin: 0x10, end: 0x30 }, { section: ".text", begin: 0x40, end: 0x46 }, { section: ".text", begin: 0x60, end: 0x80 }, { section: ".text", begin: 0x80, end: 0x8c }, { section: ".text", begin: 0x90, end: 0xa3 }];
  const hvRdata = Buffer.alloc(0x100);
  hvRdata.write(FUNCSIG + "\0", 0x10, "latin1");
  hvRdata.write("Dup\0", 0x30, "latin1");
  hvRdata.write("Dup\0", 0x36, "latin1");
  hvRdata.writeUInt32LE(1, 0x40);            // COL.signature (x64)
  hvRdata.writeUInt32LE(0, 0x44);            // COL.offset
  hvRdata.writeUInt32LE(0, 0x48);            // COL.cdOffset
  hvRdata.writeUInt32LE(DATA + 0x20, 0x4c);  // COL.pTypeDescriptor (image-relative)
  hvRdata.writeUInt32LE(0, 0x50);            // COL.pClassDescriptor
  hvRdata.writeUInt32LE(RDATA + 0x40, 0x54); // COL.pSelf
  hvRdata.writeBigUInt64LE(BigInt(BASE + RDATA + 0x40), 0x78); // vftable[-1] = &COL
  hvRdata.writeBigUInt64LE(BigInt(BASE + TEXT + 0x60), 0x80);  // slot 0 -> fnC
  hvRdata.writeBigUInt64LE(BigInt(BASE + TEXT + 0x40), 0x88);  // slot 1 -> fnB
  const hvData = Buffer.alloc(0x120);
  hvData.writeBigUInt64LE(BigInt(BASE + RDATA + 0xf0), 0x20);  // TypeDescriptor.pVFTable (any)
  hvData.write(".?AVFoo@glaiel@@\0", 0x30, "latin1");
  const hvPe = buildFakePe({
    timeDateStamp: 0x44444444,
    sections: [{ name: ".text", bytes: hvText, exec: true }, { name: ".hvRdata", bytes: hvRdata }, { name: ".data", bytes: hvData, write: true }],
    pdata: hvPdata,
  });
  const hp = parsePe(hvPe.buf);
  eq(hvPe.rva(".hvRdata", 0), RDATA, "fake layout assumption");
  eq(hvPe.rva(".data", 0), DATA, "fake layout assumption");

  test("readOffsetWitness: nth match of a byte pattern in the function body, signed byte / 4-byte displacement at dispAt, optional scale, not-found", () => {
    const r = hv.readOffsetWitness;
    assert(typeof r === "function", "exported");
    const fnE = TEXT + 0x90;
    const a = r(hp, hvPe.buf, fnE, { pattern: "8B 41 ??", dispAt: 2 });
    assert(a.found && a.value === 0x5c && a.raw === 0x5c && a.matches === 2 && a.at === 0, JSON.stringify(a));
    const b = r(hp, hvPe.buf, fnE, { pattern: "8B 41 ??", dispAt: 2, nth: 1, dispSize: 1 });
    assert(b.found && b.value === -8, `signed byte: ${JSON.stringify(b)}`);
    const c = r(hp, hvPe.buf, fnE, { pattern: "FF 90 ?? ?? ?? ??", dispAt: 2, dispSize: 4, scale: 8 });
    assert(c.found && c.raw === 0x550 && c.value === 170, `scaled slot index: ${JSON.stringify(c)}`);
    const d = r(hp, hvPe.buf, fnE, { pattern: "8B 91 ?? ?? ?? ??", dispAt: 2, dispSize: 4 });
    assert(d.found && d.value === 0x12345678, `disp32: ${JSON.stringify(d)}`);
    const e = r(hp, hvPe.buf, fnE, { pattern: "8B 41 ??", dispAt: 2, nth: 2 });
    assert(!e.found && e.value === null && e.matches === 2, `nth beyond the count: ${JSON.stringify(e)}`);
    const f = r(hp, hvPe.buf, fnE, { pattern: "90 90 90", dispAt: 0 });
    assert(!f.found && f.matches === 0, `absent: ${JSON.stringify(f)}`);
    const g = r(hp, hvPe.buf, fnE, { pattern: "FF 90 ?? ?? ?? ??", dispAt: 2, dispSize: 4, scale: 7 });
    assert(!g.found, `a non-integral quotient is not a value: ${JSON.stringify(g)}`);
  });

  test("harvestManifest: an offset witness is verified against the manifest value (mismatch names both values; unresolved when the pattern or the function is missing); a constant may carry a scaled displacement witness", () => {
    const base = (offValue: string, extra: Record<string, unknown> = {}) => parseManifest({
      format: 1,
      build: { steamBuildId: "444", gameVersion: "4.4.4", name: "4.4.4 (steam 444)", timeDateStamp: "0x44444444", sizeOfImage: "0x" + hp.sizeOfImage.toString(16), imageBase: "0x140000000", exeSha256: "d".repeat(64), exeSize: hvPe.buf.length, sdlVersion: "3.2.12" },
      sigCap: 128,
      entries: [
        { name: "FnE", kind: "function", rva: "0x1090", signature: null, anchors: {}, consumers: [], exposure: [], evidence: [] },
        { name: "Foo_stacks", kind: "offset", struct: "Foo", value: offValue, ctype: "int32", anchors: { witness: { function: "FnE", pattern: "8B 41 ??", dispAt: 2, dispSize: 1, nth: 0 } }, consumers: [], exposure: [{ macro: "OFF_FOO_STACKS" }], evidence: [] },
        { name: "Foo_owner", kind: "offset", struct: "Foo", value: "-0x8", ctype: "void*", anchors: { witness: { function: "FnE", pattern: "8B 41 ??", dispAt: 2, nth: 1 } }, consumers: [], exposure: [{ macro: "OFF_FOO_OWNER" }], evidence: [] },
        { name: "Foo_gone", kind: "offset", struct: "Foo", value: "0x10", ctype: "int32", anchors: { witness: { function: "FnE", pattern: "90 90 90", dispAt: 0 } }, consumers: [], exposure: [{ macro: "OFF_FOO_GONE" }], evidence: [] },
        { name: "VT_OnThing", kind: "constant", value: "170", anchors: { witness: { function: "FnE", pattern: "FF 90 ?? ?? ?? ??", dispAt: 2, dispSize: 4, scale: 8 } }, consumers: [], exposure: [{ macro: "VT_ONTHING" }], evidence: [] },
        ...(extra.entries as unknown[] || []),
      ],
    });
    const ok = harvestManifest(hp, hvPe.buf, base("0x5c")).report;
    const byName = (name: string) => { const x = ok.find((r) => r.name === name); if (!x) throw new Error(`no row ${name}`); return x; };
    eq(byName("Foo_stacks").status, "verified", byName("Foo_stacks").detail);
    eq(byName("Foo_owner").status, "verified", byName("Foo_owner").detail);
    eq(byName("Foo_gone").status, "unresolved", byName("Foo_gone").detail);
    eq(byName("VT_OnThing").status, "verified", byName("VT_OnThing").detail);
    assert(/0x550/.test(byName("VT_OnThing").detail) && /170/.test(byName("VT_OnThing").detail), byName("VT_OnThing").detail);
    const bad = harvestManifest(hp, hvPe.buf, base("0x60")).report.find((r) => r.name === "Foo_stacks")!;
    eq(bad.status, "mismatch", bad.detail);
    assert(/0x5c/.test(bad.detail) && /0x60/.test(bad.detail), `names both values: ${bad.detail}`);
  });

  test("validateManifest: witness.scale must be a positive integer; an offset witness with a pattern needs dispAt", () => {
    const mk = (witness: Record<string, unknown>, kind = "offset") => validateManifest({
      format: 1,
      build: { steamBuildId: "1", gameVersion: "1", name: "1", timeDateStamp: "0x1", sizeOfImage: "0x1000", imageBase: "0x140000000", exeSha256: "a".repeat(64), exeSize: 1, sdlVersion: "3.2.12" },
      sigCap: 128,
      entries: [
        { name: "FnE", kind: "function", rva: "0x1090", signature: null, anchors: {}, consumers: [], exposure: [], evidence: [] },
        kind === "offset"
          ? { name: "X", kind: "offset", struct: "S", value: "0x8", ctype: "int32", anchors: { witness }, consumers: [], exposure: [{ macro: "OFF_X" }], evidence: [] }
          : { name: "X", kind: "constant", value: "1", anchors: { witness }, consumers: [], exposure: [{ macro: "X" }], evidence: [] },
      ],
    });
    assert(mk({ function: "FnE", pattern: "8B 41 ??", dispAt: 2 }).ok, "a plain offset witness is fine");
    assert(!mk({ function: "FnE", pattern: "8B 41 ??" }).ok, "pattern without dispAt is rejected");
    assert(!mk({ function: "FnE", pattern: "8B 41 ??", dispAt: 2, scale: 0 }).ok, "scale 0 rejected");
    assert(!mk({ function: "FnE", pattern: "8B 41 ??", dispAt: 2, scale: 1.5 }).ok, "fractional scale rejected");
    assert(mk({ function: "FnE", pattern: "FF 90 ?? ?? ?? ??", dispAt: 2, dispSize: 4, scale: 8 }, "constant").ok, "a scaled constant witness is fine");
  });

  test("findString: NUL-terminated string -> rva + occurrence count (data sections only)", () => {
    const s = findString(hp, hvPe.buf, FUNCSIG);
    eq(s.rva, RDATA + 0x10);
    eq(s.count, 1);
    eq(findString(hp, hvPe.buf, "Dup").count, 2);
    eq(findString(hp, hvPe.buf, "Nope").count, 0);
    eq(findString(hp, hvPe.buf, "Nope").rva, null);
  });
  test("findStringXrefs: rip-relative lea sites that point at the string, with their containing function", () => {
    const x = findStringXrefs(hp, hvPe.buf, RDATA + 0x10);
    eq(x.length, 1);
    eq(x[0].at, TEXT + 0x10);
    eq(x[0].fn && x[0].fn.begin, TEXT + 0x10);
    eq(findStringXrefs(hp, hvPe.buf, RDATA + 0x30).length, 0);
  });
  test("harvestFunction: funcsig string anchor, callees by ordinal, rip refs by ordinal, cfgLite and prologue", () => {
    const h = harvestFunction(hp, hvPe.buf, TEXT + 0x10, { names: new Map([[TEXT + 0x40, "FnB"]]) });
    eq(h.strings.length, 1);
    eq(h.strings[0].text, FUNCSIG);
    eq(h.strings[0].role, "funcsig");
    eq(h.strings[0].unique, true);
    eq(h.callees.map((c: { ordinal: number; name: string; target: string }) => `${c.ordinal}:${c.name}:${c.target}`).join(","), "0:FnB:0x1040");
    eq(h.ripRefs.map((r: { ordinal: number; opcode: string; target: string }) => `${r.ordinal}:${r.opcode}:${r.target}`).join(","), "0:lea:0x2010,1:mov:0x3100");
    eq(h.cfgLite.bytes, 0x20);
    eq(h.cfgLite.calls, 1);
    eq(h.cfgLite.ripRefs, 2);
    eq(h.prologue, "48 8D 0D ?? ?? ?? ?? E8 ?? ?? ?? ??");
    const b = harvestFunction(hp, hvPe.buf, TEXT + 0x40, { names: new Map() });
    eq(b.strings.length, 0);
    eq(b.callees.length, 0);
    eq(b.cfgLite.bytes, 6);
  });
  test("findRtti: TypeDescriptor name -> COL -> vftable (x64 image-relative RTTI)", () => {
    const r = findRtti(hp, hvPe.buf, ".?AVFoo@glaiel@@");
    assert(r !== null, "found");
    if (!r) return;
    eq(r.typeDescriptor, DATA + 0x20);
    eq(r.col, RDATA + 0x40);
    eq(r.vftable, RDATA + 0x80);
    eq(findRtti(hp, hvPe.buf, ".?AVBar@glaiel@@"), null);
  });
  test("vtableSlotTarget / deriveFromVtableSlot: slot pointers resolve to RVAs; imm32 read from the slot body", () => {
    eq(vtableSlotTarget(hp, hvPe.buf, RDATA + 0x80, 0), TEXT + 0x60);
    eq(vtableSlotTarget(hp, hvPe.buf, RDATA + 0x80, 1), TEXT + 0x40);
    eq(deriveFromVtableSlot(hp, hvPe.buf, RDATA + 0x80, 1, "B8 ?? ?? ?? ?? C3", 1), 0x4d6);
    eq(deriveFromVtableSlot(hp, hvPe.buf, RDATA + 0x80, 0, "B8 ?? ?? ?? ?? C3", 1), null, "body does not match");
  });
  test("harvestManifest: fills function anchors, resolves witness ordinals, verifies rtti/derive, reports mismatches", () => {
        const m = parseManifest({
      format: 1,
      build: { steamBuildId: "444", gameVersion: "4.4.4", name: "4.4.4 (steam 444)", timeDateStamp: "0x44444444", sizeOfImage: "0x" + hp.sizeOfImage.toString(16), imageBase: "0x140000000", exeSha256: "d".repeat(64), exeSize: hvPe.buf.length, sdlVersion: "3.2.12" },
      sigCap: 128,
      entries: [
        { name: "FnA", kind: "function", rva: "0x1010", signature: null, anchors: {}, consumers: [], exposure: [{ table: "FW_LK", index: 0, shape: "A" }], evidence: [] },
        { name: "FnB", kind: "function", rva: "0x1040", signature: null, anchors: {}, consumers: [], exposure: [], evidence: [] },
        { name: "Glob", kind: "data", rva: "0x3100", anchors: { witness: { function: "FnA", kind: "rip-mov", ripRefOrdinal: null, needsHarvest: true } }, consumers: [], exposure: [{ enum: "FW_DATA_Glob", index: 0 }], evidence: [] },
        { name: "Foo_vftable", kind: "vtable", rva: "0x2080", slots: 2, anchors: { rtti: { typeDescriptorName: ".?AVFoo@glaiel@@" } }, consumers: [], exposure: [{ field: "rva_Foo_vftable" }], evidence: [] },
        { name: "Foo_typeid", kind: "constant", value: "0x4d6", anchors: { derive: { vtable: "Foo_vftable", slot: 1, bodyPattern: "B8 ?? ?? ?? ?? C3", imm32At: 1 } }, consumers: [], exposure: [{ field: "fooTypeId" }], evidence: [] },
        { name: "Wrong_vftable", kind: "vtable", rva: "0x2090", slots: 2, anchors: { rtti: { typeDescriptorName: ".?AVFoo@glaiel@@" } }, consumers: [], exposure: [], evidence: [] },
        { name: "Tbl", kind: "data", rva: "0x2000", anchors: {}, consumers: [], exposure: [], evidence: [] },
        { name: "Tbl_slot3", kind: "data", rva: "0x2018", anchors: { derive: { table: "Tbl", index: 3 } }, consumers: [], exposure: [], evidence: [] },
      ],
    });
    const { manifest: out, report } = harvestManifest(hp, hvPe.buf, m);
    const a = entry(out, "FnA")!;
    eq(a.anchors.strings![0].text, FUNCSIG);
    eq(a.anchors.callees![0]!.name, "FnB");
    eq(a.anchors.cfgLite!.bytes, 0x20);
    const g = entry(out, "Glob")!;
    eq(g.anchors.witness!.ripRefOrdinal, 1);
    eq(g.anchors.witness!.needsHarvest, false);
    eq(report.find((r) => r.name === "Foo_vftable")!.status, "verified");
    eq(report.find((r) => r.name === "Foo_typeid")!.status, "verified");
    eq(report.find((r) => r.name === "Tbl_slot3")!.status, "verified");
    const w = report.find((r) => r.name === "Wrong_vftable")!;
    eq(w.status, "mismatch");
    assert(/0x2080/.test(w.detail), w.detail);
    eq(entry(out, "Wrong_vftable")!.rva, "0x2090", "a mismatch never rewrites the value");
    eq(validateManifest(out).ok, true, "output validates");
    eq(report.filter((r) => r.status === "mismatch").length, 1);
  });
  test("deriveFromCallArg: the imm32 of the matching instruction within maxBack instructions before the call to callee", () => {
    assert(typeof hv.deriveFromCallArg === "function", "deriveFromCallArg exported");
    eq(hv.deriveFromCallArg(hp, hvPe.buf, TEXT + 0x80, TEXT + 0x40, "41 B8 ?? ?? ?? ??", 2, 6), 0x4d6);
    eq(hv.deriveFromCallArg(hp, hvPe.buf, TEXT + 0x80, TEXT + 0x60, "41 B8 ?? ?? ?? ??", 2, 6), null, "no call to that callee");
    eq(hv.deriveFromCallArg(hp, hvPe.buf, TEXT + 0x80, TEXT + 0x40, "BA ?? ?? ?? ??", 1, 6), null, "pattern not before the call");
    eq(hv.deriveFromCallArg(hp, hvPe.buf, TEXT + 0x10, TEXT + 0x40, "41 B8 ?? ?? ?? ??", 2, 6), null, "FnA calls fnB without the mov");
  });
  test("harvestManifest: a constant with a slot-body derivation AND a call-arg witness is verified by both; a value neither gives is a mismatch naming both", () => {
    const base = {
      format: 1,
      build: { steamBuildId: "444", gameVersion: "4.4.4", name: "4.4.4 (steam 444)", timeDateStamp: "0x44444444", sizeOfImage: "0x" + hp.sizeOfImage.toString(16), imageBase: "0x140000000", exeSha256: "d".repeat(64), exeSize: hvPe.buf.length, sdlVersion: "3.2.12" },
      sigCap: 128,
    };
    const typeid = (value: string) => ({ name: "Foo_typeid", kind: "constant", value, anchors: { derive: { vtable: "Foo_vftable", slot: 1, bodyPattern: "B8 ?? ?? ?? ?? C3", imm32At: 1 }, witness: { function: "FnD", callee: "FnB", pattern: "41 B8 ?? ?? ?? ??", imm32At: 2, maxBack: 6 } }, consumers: [], exposure: [{ field: "fooTypeId" }], evidence: [] });
    const entries = (value: string) => [
      { name: "FnB", kind: "function", rva: "0x1040", signature: null, anchors: {}, consumers: [], exposure: [], evidence: [] },
      { name: "FnD", kind: "function", rva: "0x1080", signature: null, anchors: {}, consumers: [], exposure: [], evidence: [] },
      { name: "Foo_vftable", kind: "vtable", rva: "0x2080", slots: 2, anchors: { rtti: { typeDescriptorName: ".?AVFoo@glaiel@@" } }, consumers: [], exposure: [{ field: "rva_Foo_vftable" }], evidence: [] },
      typeid(value),
    ];
    const ok = harvestManifest(hp, hvPe.buf, parseManifest({ ...base, entries: entries("0x4d6") }));
    const r1 = ok.report.find((r) => r.name === "Foo_typeid")!;
    eq(r1.status, "verified", r1.detail);
    assert(/slot body gives 0x4d6/.test(r1.detail) && /call-arg witness .*0x4d6/.test(r1.detail), r1.detail);
    const bad = harvestManifest(hp, hvPe.buf, parseManifest({ ...base, entries: entries("0x4d7") }));
    const r2 = bad.report.find((r) => r.name === "Foo_typeid")!;
    eq(r2.status, "mismatch", r2.detail);
    assert(/0x4d6/.test(r2.detail) && /0x4d7/.test(r2.detail), r2.detail);
    eq(entry(bad.manifest, "Foo_typeid")!.value, "0x4d7", "never rewritten");
  });
  if (exe) {
    const m = loadManifest(realPath);
    const p = parsePe(exe);
    test("T1 real exe: 12 of the 13 FW_LK lookups are found by a unique __FUNCSIG__ string xref'd from exactly their function; Status_NameExists has none", () => {
            const bad: string[] = [];
      let found = 0;
      for (const e of lkTable(m)) {
        const h = harvestFunction(p, exe, parseInt(e.rva!, 16), { names: new Map() });
        const sig = h.strings.find((s: { role: string; unique: boolean }) => s.role === "funcsig" && s.unique);
        if (e.name === "Status_NameExists") { if (sig) bad.push("Status_NameExists unexpectedly has a funcsig"); continue; }
        if (!sig) { bad.push(`${e.name}: no unique funcsig`); continue; }
        const x = findStringXrefs(p, exe, findString(p, exe, sig.text).rva!);
        const fns = [...new Set<number>(x.map((r: { fn: { begin: number } | null }) => (r.fn ? r.fn.begin : -1)))];
        if (fns.length !== 1 || fns[0] !== parseInt(e.rva!, 16)) bad.push(`${e.name}: xrefs from ${fns.map((f) => "0x" + f.toString(16)).join(",")}`);
        else found++;
      }
      assert(bad.length === 0, bad.join("; "));
      eq(found, 12);
    });
    test("T1 real exe: RTTI chain gives both vftables; LuckUp type id derives from slot 1; SDL slots derive from the table", () => {
      const l = findRtti(p, exe, ".?AVLuckUp@glaiel@@");
      eq(l && hex(l.vftable), "0xf57ab8");
      const s = findRtti(p, exe, ".?AVStatus@glaiel@@");
      eq(s && hex(s.vftable), "0xed1960");
      eq(deriveFromVtableSlot(p, exe, 0xf57ab8, 1, "B8 ?? ?? ?? ?? C3", 1), 0x4d6);
      const t = entry(m, "SDL_DYNAPI_table")!;
      for (const e of m.entries) {
        if ((e.kind as string) === "hvData" && e.anchors.derive && e.anchors.derive!.table === "SDL_DYNAPI_table") eq(parseInt(e.rva!, 16), parseInt(t.rva!, 16) + 8 * e.anchors.derive!.index!, e.name);
      }
    });
    test("T1 real exe: harvestManifest resolves App_global / DefaultStatusSource witnesses, verifies every rtti/derive, and the committed manifest is already harvested", () => {
      const { manifest: out, report } = harvestManifest(p, exe, m);
      const mism = report.filter((r) => r.status === "mismatch");
      assert(mism.length === 0, mism.map((r) => `${r.name}: ${r.detail}`).join("; "));
      const app = entry(out, "App_global")!;
      assert(Number.isInteger(app.anchors.witness!.ripRefOrdinal) && app.anchors.witness!.needsHarvest === false, `App_global witness ${JSON.stringify(app.anchors.witness)}`);
      const dss = entry(out, "DefaultStatusSource")!;
      assert(Number.isInteger(dss.anchors.witness!.ripRefOrdinal) && dss.anchors.witness!.needsHarvest === false, `DefaultStatusSource witness ${JSON.stringify(dss.anchors.witness)}`);
      const withSig = out.entries.filter((e) => e.kind === "function" && e.anchors.strings && e.anchors.strings!.some((s) => s.role === "funcsig")).length;
      assert(withSig >= 20, `funcsig anchors: ${withSig}`);
      assert(JSON.stringify(out) === JSON.stringify(m), "committed anchors are stale: run node tools/bindings/harvest.ts <exe> --manifest bindings/25143593.json --write");
    });
  }
  // ---- port.ts: the resolution ladder, old manifest -> new exe ----------------------------
  console.log("\n# Bindings: port ladder (rescan -> anchor -> caller ordinal; witnesses; report)");
  const pt = await load<typeof import("../src/core/bindings/port.ts")>("../src/core/bindings/port.ts");
  if ("__error" in pt) {
    test("port.ts loads", () => assert(false, pt.__error));
    return;
  }
  const { portManifest, renderPortReport, PORT_STATUSES } = pt;

    /** Mini linker for fake builds. Items in `code` are bytes or placeholders resolved after layout: { call: "Fn" } -> E8 rel32, { lea: "str:NAME" } -> 48 8D 0D disp32 (lea rcx), { leaRdx: "str:NAME" } -> 48 8D 15 disp32, { leaRax: "vt:NAME" } -> 48 8D 05 disp32 (lea rax, vftable), { mov: "glob:NAME" } -> 48 8B 05 disp32 */
  const link = (spec: LinkSpec) => {
    const TEXT = 0x1000, RDATA = 0x2000, DATA = 0x3000;
    const size = (it: CodeItem) => (typeof it === "number" ? 1 : "call" in it ? 5 : 7);
    const fnAt: Record<string, number> = {};
    let pc = TEXT + (spec.textPad || 0x10);
    for (const f of spec.fns) { pc = (pc + 15) & ~15; fnAt[f.name] = pc; pc += f.code.reduce((n: number, it) => n + size(it), 0); }
    const strAt: Record<string, number> = {};
    let sp = RDATA + 0x10 + (spec.rdataPad || 0);
    for (const [k, v] of Object.entries(spec.strings || {})) { strAt[k] = sp; sp += v.length + 1; sp = (sp + 3) & ~3; }
    const globAt: Record<string, number> = {};
    let gp = DATA + 0x10;
    for (const g of spec.globs || []) { globAt[g] = gp; gp += 8; }
    // vtables: COL (24 B) then [&COL][slot0][slot1]... in .rdata after the strings; TypeDescriptor (16 B header + name) in .data from +0x80
    const vtAt: Record<string, number> = {};
    const colAt: Record<string, number> = {};
    const tdAt: Record<string, number> = {};
    let vp = (sp + 7) & ~7;
    let tp = DATA + 0x80;
    for (const [k, v] of Object.entries(spec.vtables || {})) { colAt[k] = vp; vp += 24; vtAt[k] = vp + 8; vp += 8 + 8 * v.slots.length; vp = (vp + 7) & ~7; tdAt[k] = tp; tp += 16 + v.td.length + 1; tp = (tp + 7) & ~7; }
    const textBytes = new Uint8Array(0x400);
    const pdata: { section: string; begin: number; end: number }[] = [];
    for (const f of spec.fns) {
      let at = fnAt[f.name]!;
      const begin = at;
      for (const it of f.code) {
        if (typeof it === "number") { textBytes[at - TEXT] = it; at += 1; continue; }
        let bytes: number[];
        if ("call" in it) { const next = at + 5; bytes = [0xe8, ...le32(fnAt[it.call]! - next)]; }
        else if ("lea" in it) { const next = at + 7; bytes = [0x48, 0x8d, 0x0d, ...le32(strAt[it.lea.slice(4)]! - next)]; }
        else if ("leaRdx" in it) { const next = at + 7; bytes = [0x48, 0x8d, 0x15, ...le32(strAt[it.leaRdx.slice(4)]! - next)]; }
        else if ("leaRax" in it) { const next = at + 7; bytes = [0x48, 0x8d, 0x05, ...le32(vtAt[it.leaRax.slice(3)]! - next)]; }
        else { const next = at + 7; bytes = [0x48, 0x8b, 0x05, ...le32(globAt[it.mov.slice(5)]! - next)]; }
        textBytes.set(bytes, at - TEXT);
        at += bytes.length;
      }
      pdata.push({ section: ".text", begin: begin - TEXT, end: at - TEXT });
    }
    const rdataBytes = Buffer.alloc(0x400);
    for (const [k, v] of Object.entries(spec.strings || {})) rdataBytes.write(v + "\0", strAt[k]! - RDATA, "latin1");
    const dataBytes = Buffer.alloc(0x200);
    for (const [k, v] of Object.entries(spec.vtables || {})) {
      const col = colAt[k]! - RDATA;
      rdataBytes.writeUInt32LE(1, col); rdataBytes.writeUInt32LE(0, col + 4); rdataBytes.writeUInt32LE(0, col + 8);
      rdataBytes.writeUInt32LE(tdAt[k]!, col + 12); rdataBytes.writeUInt32LE(0, col + 16); rdataBytes.writeUInt32LE(colAt[k]!, col + 20);
      rdataBytes.writeBigUInt64LE(BigInt(0x140000000 + colAt[k]!), vtAt[k]! - 8 - RDATA);
      v.slots.forEach((fn, i) => rdataBytes.writeBigUInt64LE(BigInt(0x140000000 + fnAt[fn]!), vtAt[k]! + 8 * i - RDATA));
      dataBytes.writeBigUInt64LE(BigInt(0x140000000 + RDATA), tdAt[k]! - DATA);
      dataBytes.write(v.td + "\0", tdAt[k]! + 16 - DATA, "latin1");
    }
    const img = buildFakePe({ timeDateStamp: spec.stamp ?? 0x51515151, sections: [{ name: ".text", bytes: textBytes, exec: true }, { name: ".rdata", bytes: rdataBytes }, { name: ".data", bytes: dataBytes, write: true }], pdata });
    return { img, pe: parsePe(img.buf), fnAt, strAt, globAt, vtAt };
  };
  const SIG_A = "int __cdecl glaiel::alpha(void)";
  const SIG_B = "int __cdecl glaiel::beta(int)";
  const PRO = [0x40, 0x53, 0x48, 0x83, 0xec, 0x20];           // push rbx; sub rsp,0x20
  const EPI = [0x48, 0x83, 0xc4, 0x20, 0x5b, 0xc3];           // add rsp,0x20; pop rbx; ret
  const PRO2 = [0x40, 0x53, 0x48, 0x83, 0xec, 0x30];          // a recompiled prologue (frame 0x30): breaks the v1 signature
  const bodyA = (extra: number[] = [], pro = PRO) => [...pro, { lea: "str:A" }, { call: "FnB" }, { mov: "glob:G" }, 0x48, 0x8b, 0xd8, ...extra, ...EPI];
  const bodyB = (extra: number[] = []) => [...PRO, { lea: "str:B" }, 0x48, 0x8b, 0xf8, ...extra, ...EPI];
  const bodyC = (disp: number = 0x5c) => [...PRO, 0x8b, 0x41, disp, 0x48, 0x8b, 0xc8, 0x48, 0x8b, 0xd0, ...EPI]; // mov eax,[rcx+disp]
  const v1 = link({ fns: [{ name: "FnA", code: bodyA() }, { name: "FnB", code: bodyB() }, { name: "FnC", code: bodyC() }], strings: { A: SIG_A, B: SIG_B }, globs: ["G"] });
  /** the v1 manifest: signatures generated and anchors harvested on v1 */
  const mkOld = () => {
    const sig = (rva: number) => { const r = makeSignature(v1.pe, v1.img.buf, rva, { minLen: 8 }); return r.ok ? r.signature : null; };
      const m = parseManifest({
      format: 1,
      build: { steamBuildId: "100", gameVersion: "1.0.0", name: "1.0.0 (steam 100)", timeDateStamp: "0x51515151", sizeOfImage: "0x" + v1.pe.sizeOfImage.toString(16), imageBase: "0x140000000", exeSha256: "e".repeat(64), exeSize: v1.img.buf.length, sdlVersion: "3.2.12" },
      sigCap: 128,
      entries: [
        { name: "FnA", kind: "function", rva: hex(v1.fnAt.FnA), signature: sig(v1.fnAt.FnA), anchors: {}, consumers: [], exposure: [{ enum: "FW_SYM_FnA", index: 0 }], evidence: [] },
        { name: "FnB", kind: "function", rva: hex(v1.fnAt.FnB), signature: sig(v1.fnAt.FnB), anchors: {}, consumers: [], exposure: [{ enum: "FW_SYM_FnB", index: 1 }], evidence: [] },
        { name: "FnC", kind: "function", rva: hex(v1.fnAt.FnC), signature: sig(v1.fnAt.FnC), anchors: {}, consumers: [], exposure: [{ table: "FW_LK", index: 0, shape: "A" }], evidence: [] },
        { name: "G", kind: "data", rva: hex(v1.globAt.G), anchors: { witness: { function: "FnA", kind: "rip-mov", ripRefOrdinal: null, needsHarvest: true } }, consumers: [], exposure: [{ enum: "FW_DATA_G", index: 0 }], evidence: [] },
        { name: "Foo_stacks", kind: "offset", struct: "Foo", value: "0x5c", ctype: "int32", anchors: { witness: { function: "FnC", pattern: "8B 41 ??", dispAt: 2, dispSize: 1, nth: 0 } }, consumers: [], exposure: [{ macro: "OFF_FOO_STACKS" }], evidence: [] },
        { name: "Mystery", kind: "offset", struct: "Foo", value: "0x10", ctype: "int32", anchors: { unanchored: true }, consumers: [], exposure: [{ macro: "OFF_FOO_MYSTERY" }], evidence: [] },
      ],
    });
    return harvestManifest(v1.pe, v1.img.buf, m).manifest;
  };
  const old = mkOld();
    const port = (v2: ReturnType<typeof link>, opts: Record<string, any> = {}) => portManifest(old, v2.pe, v2.img.buf, { steamBuildId: "200", gameVersion: "2.0.0", ...opts });
    /** A port-report row by name (a missing row fails the assertion that asked for it). */
    const row = (r: PortResult, name: string): PortRow => {
      const x = r.rows.find((x) => x.name === name);
      if (!x) throw new Error(`no report row named ${name}`);
      return x;
    };

  test("PORT_STATUSES is the closed set the report and the manifest schema use", () => {
    eq(PORT_STATUSES.join(","), "ported-exact,ported-rescan,ported-anchor,ported-witness,ported-derived,proposed,ambiguous,failed,needs-human");
  });
  test("self-port (same image) -> every anchored entry ported-exact with the same value; unanchored offsets needs-human", () => {
    const r = port(v1, { steamBuildId: "100", gameVersion: "1.0.0" });
    eq(row(r, "FnA").status, "ported-exact");
    eq(row(r, "FnB").status, "ported-exact");
    eq(row(r, "FnC").status, "ported-exact");
    eq(row(r, "G").status, "ported-witness");
    eq(row(r, "Foo_stacks").status, "ported-witness");
    eq(row(r, "Mystery").status, "needs-human");
    eq(entry(r.manifest, "FnA")!.rva, hex(v1.fnAt.FnA));
    eq(entry(r.manifest, "Mystery")!.value, "0x10", "value carried over, flagged");
    eq(validateManifest(r.manifest).ok, true, JSON.stringify(validateManifest(r.manifest).problems));
    eq(r.manifest.build.steamBuildId, "100");
    assert(r.manifest.entries.every((e) => e.port && e.port.from === "100" && PORT_STATUSES.includes(e.port.status)), "every entry carries a port block");
  });
  test("relink (code and strings shifted, bytes unchanged) -> ported-rescan with the new RVAs; witnesses follow", () => {
    const v2 = link({ fns: [{ name: "FnA", code: bodyA() }, { name: "FnB", code: bodyB() }, { name: "FnC", code: bodyC() }], strings: { A: SIG_A, B: SIG_B }, globs: ["G"], textPad: 0x50, rdataPad: 0x20, stamp: 0x52525252 });
    const r = port(v2);
    for (const n of ["FnA", "FnB", "FnC"]) { eq(row(r, n).status, "ported-rescan", n); eq(entry(r.manifest, n)!.rva, hex(v2.fnAt[n]!), n); }
    eq(row(r, "G").status, "ported-witness");
    eq(entry(r.manifest, "G")!.rva, hex(v2.globAt.G));
    eq(row(r, "Foo_stacks").status, "ported-witness");
    eq(r.manifest.build.timeDateStamp, "0x52525252");
    eq(r.manifest.build.steamBuildId, "200");
    assert(!!(entry(r.manifest, "FnA")!.signature && entry(r.manifest, "FnA")!.signature!.pattern), "signature regenerated on the new image");
    eq(r.summary["ported-rescan"], 3);
    // the report's "old" column must keep the pre-port value (found by the 2026-10-19 cross-build run)
    eq(row(r, "FnA").oldValue, hex(v1.fnAt.FnA), "function row: old = the v1 RVA, not the ported one");
    eq(row(r, "FnA").newValue, hex(v2.fnAt.FnA), "function row: new = the v2 RVA");
    assert(renderPortReport(r).includes(`| FnA | function | ${hex(v1.fnAt.FnA)} | ${hex(v2.fnAt.FnA)} |`), "report table row shows old -> new");
  });
  test("a moved global -> the witness row's old column keeps the v1 address", () => {
    const v2 = link({ fns: [{ name: "FnA", code: bodyA() }, { name: "FnB", code: bodyB() }, { name: "FnC", code: bodyC() }], strings: { A: SIG_A, B: SIG_B }, globs: ["H", "G"], stamp: 0x5a5a5a5a });
    const r = port(v2);
    eq(row(r, "G").status, "ported-witness");
    eq(entry(r.manifest, "G")!.rva, hex(v2.globAt.G));
    assert(v2.globAt.G !== v1.globAt.G, "fixture: G moved");
    eq(row(r, "G").oldValue, hex(v1.globAt.G), "witness row: old = the v1 address");
    eq(row(r, "G").newValue, hex(v2.globAt.G));
  });
  test("body changed beyond the mask -> found by its unique funcsig xref (ported-anchor); its callee recovered by caller ordinal", () => {
    // FnA is recompiled (new frame size + two nops: signature breaks); FnB loses its funcsig AND changes -> only reachable as FnA's call #0
    const v2 = link({ fns: [{ name: "FnA", code: bodyA([0x90, 0x90], PRO2) }, { name: "FnB", code: [...PRO, 0x48, 0x8b, 0xf8, 0x90, 0x90, 0x90, ...EPI] }, { name: "FnC", code: bodyC() }], strings: { A: SIG_A }, globs: ["G"], stamp: 0x53535353 });
    const r = port(v2);
    eq(row(r, "FnA").status, "ported-anchor", row(r, "FnA").detail);
    eq(row(r, "FnA").method, "funcsig-xref");
    eq(entry(r.manifest, "FnA")!.rva, hex(v2.fnAt.FnA));
    eq(row(r, "FnB").status, "ported-anchor", row(r, "FnB").detail);
    eq(row(r, "FnB").method, "caller-ordinal");
    eq(entry(r.manifest, "FnB")!.rva, hex(v2.fnAt.FnB));
    eq(row(r, "G").status, "ported-witness");
    // anchor-ported rows record how far the candidate drifted from the old cfgLite (size/calls), so a cross-build
    // report shows whether the tolerances were exercised at all
    assert(/size [+-]\d+ \/ calls [+-]\d+ vs old/.test(row(r, "FnA").detail ?? ""), `FnA detail: ${row(r, "FnA").detail}`);
    assert(/size [+-]\d+ \/ calls [+-]\d+ vs old/.test(row(r, "FnB").detail ?? ""), `FnB detail: ${row(r, "FnB").detail}`);
  });
  test("a clone referencing the same funcsig -> ambiguous with both candidates listed for the agent", () => {
    const v2 = link({ fns: [{ name: "FnA", code: bodyA([0x90, 0x90], PRO2) }, { name: "FnA2", code: bodyA([0x90, 0x90, 0x90], PRO2) }, { name: "FnB", code: bodyB() }, { name: "FnC", code: bodyC() }], strings: { A: SIG_A, B: SIG_B }, globs: ["G"], stamp: 0x54545454 });
    const r = port(v2);
    const a = row(r, "FnA");
    eq(a.status, "ambiguous", a.detail);
    eq(a.candidates!.length, 2);
    eq(a.candidates!.map((c: { rva: string }) => c.rva).sort().join(","), [hex(v2.fnAt.FnA!), hex(v2.fnAt.FnA2!)].sort().join(","));
    assert(a.candidates!.every((c: { bytes: number; calls: number }) => Number.isInteger(c.bytes) && Number.isInteger(c.calls)), "candidate stats");
    assert(r.needsAgent.some((x: { name: string }) => x.name === "FnA"), "listed for the agent");
    eq(entry(r.manifest, "FnA")!.rva, hex(v1.fnAt.FnA), "old value kept until resolved");
    eq(row(r, "G").status, "failed", "witness function unresolved -> the global cannot be ported");
  });
  test("string gone and bytes changed -> failed with the reason; --resolve supplies the answer and re-anchors", () => {
    const v2 = link({ fns: [{ name: "FnA", code: [...PRO, { call: "FnB" }, { mov: "glob:G" }, 0x48, 0x8b, 0xd8, 0x90, 0x90, ...EPI] }, { name: "FnB", code: bodyB() }, { name: "FnC", code: bodyC() }], strings: { B: SIG_B }, globs: ["G"], stamp: 0x55555555 });
    const r = port(v2);
    eq(row(r, "FnA").status, "failed", row(r, "FnA").detail);
    assert(/funcsig|string/.test(row(r, "FnA").detail ?? ""), row(r, "FnA").detail ?? "");
    const fixed = port(v2, { resolve: { FnA: hex(v2.fnAt.FnA) } });
    eq(row(fixed, "FnA").status, "ported-anchor");
    eq(row(fixed, "FnA").method, "resolved");
    eq(entry(fixed.manifest, "FnA")!.rva, hex(v2.fnAt.FnA));
    eq(row(fixed, "G").status, "ported-witness", "the witness now resolves through the supplied function");
    assert(entry(fixed.manifest, "FnA")!.anchors.cfgLite!.bytes > 0, "anchors re-harvested on the new image");
  });
  test("struct offset witness: same displacement -> ported-witness; changed -> proposed (value NOT applied)", () => {
    const same = port(link({ fns: [{ name: "FnA", code: bodyA() }, { name: "FnB", code: bodyB() }, { name: "FnC", code: bodyC(0x5c) }], strings: { A: SIG_A, B: SIG_B }, globs: ["G"], stamp: 0x56565656 }));
    eq(row(same, "Foo_stacks").status, "ported-witness");
    const moved = port(link({ fns: [{ name: "FnA", code: bodyA() }, { name: "FnB", code: bodyB() }, { name: "FnC", code: bodyC(0x60) }], strings: { A: SIG_A, B: SIG_B }, globs: ["G"], stamp: 0x57575757 }));
    const o = row(moved, "Foo_stacks");
    eq(o.status, "proposed", o.detail);
    assert(/0x5c/.test(o.detail ?? "") && /0x60/.test(o.detail ?? ""), o.detail ?? "");
    eq(entry(moved.manifest, "Foo_stacks")!.value, "0x5c", "proposed values are never applied without a green T2");
    eq(!!(entry(moved.manifest, "Foo_stacks")!.port!.note && /0x60/.test(entry(moved.manifest, "Foo_stacks")!.port!.note!)), true, "the proposal is recorded in the port block");
  });
  test("port: a constant with a scaled displacement witness -> ported-derived (method call-slot); a disagreeing slot-body source -> needs-human", () => {
    const base = {
      format: 1,
      build: { steamBuildId: "444", gameVersion: "4.4.4", name: "4.4.4 (steam 444)", timeDateStamp: "0x44444444", sizeOfImage: "0x" + hp.sizeOfImage.toString(16), imageBase: "0x140000000", exeSha256: "d".repeat(64), exeSize: hvPe.buf.length, sdlVersion: "3.2.12" },
      sigCap: 128,
      entries: [
        { name: "FnB", kind: "function", rva: "0x1040", signature: null, anchors: {}, consumers: [], exposure: [], evidence: [] },
        { name: "FnE", kind: "function", rva: "0x1090", signature: null, anchors: {}, consumers: [], exposure: [], evidence: [] },
        { name: "Foo_vftable", kind: "vtable", rva: "0x2080", slots: 2, anchors: { rtti: { typeDescriptorName: ".?AVFoo@glaiel@@" } }, consumers: [], exposure: [{ field: "rva_Foo_vftable" }], evidence: [] },
        { name: "VT_OnThing", kind: "constant", value: "170", anchors: { witness: { function: "FnE", pattern: "FF 90 ?? ?? ?? ??", dispAt: 2, dispSize: 4, scale: 8 } }, consumers: [], exposure: [{ macro: "VT_ONTHING" }], evidence: [] },
        { name: "Foo_typeid", kind: "constant", value: "0x4d6", anchors: { derive: { vtable: "Foo_vftable", slot: 1, bodyPattern: "B8 ?? ?? ?? ?? C3", imm32At: 1 }, witness: { function: "FnE", pattern: "8B 91 ?? ?? ?? ??", dispAt: 2, dispSize: 4 } }, consumers: [], exposure: [{ field: "fooTypeId" }], evidence: [] },
      ],
    };
    const old = harvestManifest(hp, hvPe.buf, parseManifest(base)).manifest;
    const resolve = { FnB: "0x1040", FnE: "0x1090" };
    const r = portManifest(old, hp, hvPe.buf, { steamBuildId: "445", gameVersion: "4.4.5", resolve });
    const a = row(r, "VT_OnThing");
    eq(a.status, "ported-derived", a.detail);
    eq(a.method, "call-slot");
    const b = row(r, "Foo_typeid");
    eq(b.status, "needs-human", b.detail);   // slot body says 0x4d6, the displacement witness says 0x12345678
    assert(/0x4d6/.test(b.detail ?? "") && /0x12345678/.test(b.detail ?? ""), b.detail ?? "");
  });
  // ---- vtable-slot constants: the slot count (extent) and slot indices found by body shape or by a string reference ----
  /*
   * .text 0x1000: slot0 0x1000 lea rcx,[rip->"Foo"]; xor eax,eax; ret (.pdata) | slot1 0x1010 mov eax,0x2a; ret (no .pdata)
   *               slot2 0x1020 push rbx; lea rdx,[rip->"Foo"]; pop rbx; ret (.pdata) | slot3 0x1030 lea rax,[rip->0x2080]; ret
   *               slot4 0x1040 xor eax,eax; ret — immediately followed at 0x1043 by a lea to "Foo" (a 256-byte fallback would bleed into it)
   * .rdata 0x2000: "Foo" @0x2010 (unique), vftable @0x2040 = 5 slots, then @0x2068 a pointer into .rdata (the next COL): extent 5
   */
  const VT_TEXT = 0x1000, VT_RDATA = 0x2000;
  const vtText = new Uint8Array(0x60);
  const rel = (from: number, to: number) => le32(to - from);
  vtText.set([0x48, 0x8d, 0x0d, ...rel(VT_TEXT + 0x07, VT_RDATA + 0x10), 0x31, 0xc0, 0xc3], 0x00);
  vtText.set([0xb8, 0x2a, 0x00, 0x00, 0x00, 0xc3], 0x10);
  vtText.set([0x53, 0x48, 0x8d, 0x15, ...rel(VT_TEXT + 0x28, VT_RDATA + 0x10), 0x5b, 0xc3], 0x20);
  vtText.set([0x48, 0x8d, 0x05, ...rel(VT_TEXT + 0x37, VT_RDATA + 0x80), 0xc3], 0x30);
  vtText.set([0x31, 0xc0, 0xc3, 0x48, 0x8d, 0x0d, ...rel(VT_TEXT + 0x4a, VT_RDATA + 0x10), 0xc3], 0x40);
  const vtRdata = Buffer.alloc(0x100);
  vtRdata.write("Foo\0", 0x10, "latin1");
  for (const [i, t] of [0x00, 0x10, 0x20, 0x30, 0x40].entries()) vtRdata.writeBigUInt64LE(BigInt(BASE + VT_TEXT + t), 0x40 + 8 * i);
  vtRdata.writeBigUInt64LE(BigInt(BASE + VT_RDATA + 0xc0), 0x68);
  const vtPe = buildFakePe({ timeDateStamp: 0x47474747, sections: [{ name: ".text", bytes: vtText, exec: true }, { name: ".rdata", bytes: vtRdata }], pdata: [{ section: ".text", begin: 0x00, end: 0x0a }, { section: ".text", begin: 0x20, end: 0x2a }] });
  const vp = parsePe(vtPe.buf);
  eq(vtPe.rva(".rdata", 0), VT_RDATA, "fake layout assumption");
  test("vtableExtent / slotBody / findVtableSlot: slot count up to the first non-code pointer; bodies bounded by .pdata or the first ret; a slot found by body prefix or by a unique string reference, with an expected candidate count", () => {
    eq(hv.vtableExtent(vp, vtPe.buf, VT_RDATA + 0x40), 5);
    eq(hv.slotBody(vp, vtPe.buf, VT_TEXT + 0x40).length, 3, "slot4 ends at its own ret, not 256 bytes later");
    eq(hv.slotBody(vp, vtPe.buf, VT_TEXT + 0x20).length, 10, "a .pdata body is the .pdata range");
    eq(hv.findVtableSlot(vp, vtPe.buf, VT_RDATA + 0x40, { bodyPattern: "B8 ?? ?? ?? ?? C3" }), 1);
    eq(hv.findVtableSlot(vp, vtPe.buf, VT_RDATA + 0x40, { bodyPattern: "48 8D 05 ?? ?? ?? ?? C3" }), 3);
    eq(hv.findVtableSlot(vp, vtPe.buf, VT_RDATA + 0x40, { stringRef: "Foo", nth: 0, expect: 2 }), 0);
    eq(hv.findVtableSlot(vp, vtPe.buf, VT_RDATA + 0x40, { stringRef: "Foo", nth: 1, expect: 2 }), 2);
    eq(hv.findVtableSlot(vp, vtPe.buf, VT_RDATA + 0x40, { stringRef: "Foo", nth: 0, expect: 3 }), null, "a candidate count other than expected is no answer");
    eq(hv.findVtableSlot(vp, vtPe.buf, VT_RDATA + 0x40, { bodyPattern: "90 90" }), null);
    // contains: a byte pattern anywhere in the bounded body (e.g. a name built from imm32 stores instead of a string reference)
    eq(hv.findVtableSlot(vp, vtPe.buf, VT_RDATA + 0x40, { contains: "31 C0 C3", nth: 1, expect: 2 }), 4, "slot0 ends with xor eax,eax; ret too");
    eq(hv.findVtableSlot(vp, vtPe.buf, VT_RDATA + 0x40, { contains: "B8 2A 00 00 00" }), 1);
  });
  test("harvest + port: extent and slotSearch constants verify / port as ported-derived (methods extent, slot-search); a broken expectation is needs-human, never a guess", () => {
    const base = (vals: Record<string, string>) => parseManifest({
      format: 1,
      build: { steamBuildId: "471", gameVersion: "4.7.1", name: "4.7.1 (steam 471)", timeDateStamp: "0x47474747", sizeOfImage: "0x" + vp.sizeOfImage.toString(16), imageBase: "0x140000000", exeSha256: "c".repeat(64), exeSize: vtPe.buf.length, sdlVersion: "3.2.12" },
      sigCap: 128,
      entries: [
        { name: "Foo_vftable", kind: "vtable", rva: hex(VT_RDATA + 0x40), slots: 5, anchors: {}, consumers: [], exposure: [{ field: "rva_Foo_vftable" }], evidence: [] },
        { name: "Foo_slots", kind: "constant", value: vals.slots ?? "5", anchors: { derive: { vtable: "Foo_vftable", extent: true } }, consumers: [], exposure: [{ macro: "VT_FOO_SLOTS" }], evidence: [] },
        { name: "VT_Id", kind: "constant", value: vals.id ?? "1", anchors: { derive: { vtable: "Foo_vftable", slotSearch: { bodyPattern: "B8 ?? ?? ?? ?? C3" } } }, consumers: [], exposure: [{ macro: "VT_ID" }], evidence: [] },
        { name: "VT_IsA", kind: "constant", value: vals.isa ?? "2", anchors: { derive: { vtable: "Foo_vftable", slotSearch: { stringRef: "Foo", nth: 1, expect: vals.expect ? Number(vals.expect) : 2 } } }, consumers: [], exposure: [{ macro: "VT_ISA" }], evidence: [] },
      ],
    });
    const rep = harvestManifest(vp, vtPe.buf, base({})).report;
    for (const n of ["Foo_slots", "VT_Id", "VT_IsA"]) eq(rep.find((r) => r.name === n)!.status, "verified", rep.find((r) => r.name === n)!.detail);
    eq(harvestManifest(vp, vtPe.buf, base({ slots: "6" })).report.find((r) => r.name === "Foo_slots")!.status, "mismatch");
    // the port re-derives through a vftable that itself ports (RTTI): the hv fixture's Foo vftable (slot 0 -> fnC, slot 1 -> fnB "mov eax,0x4d6; ret"; 2 code slots)
    const pm = (search: Record<string, unknown>) => parseManifest({
      format: 1,
      build: { steamBuildId: "444", gameVersion: "4.4.4", name: "4.4.4 (steam 444)", timeDateStamp: "0x44444444", sizeOfImage: "0x" + hp.sizeOfImage.toString(16), imageBase: "0x140000000", exeSha256: "d".repeat(64), exeSize: hvPe.buf.length, sdlVersion: "3.2.12" },
      sigCap: 128,
      entries: [
        { name: "Foo_vftable", kind: "vtable", rva: "0x2080", slots: 2, anchors: { rtti: { typeDescriptorName: ".?AVFoo@glaiel@@" } }, consumers: [], exposure: [{ field: "rva_Foo_vftable" }], evidence: [] },
        { name: "Foo_slots", kind: "constant", value: "2", anchors: { derive: { vtable: "Foo_vftable", extent: true } }, consumers: [], exposure: [{ macro: "VT_FOO_SLOTS" }], evidence: [] },
        { name: "VT_Id", kind: "constant", value: "1", anchors: { derive: { vtable: "Foo_vftable", slotSearch: search } }, consumers: [], exposure: [{ macro: "VT_ID" }], evidence: [] },
      ],
    });
    const r = portManifest(harvestManifest(hp, hvPe.buf, pm({ bodyPattern: "B8 ?? ?? ?? ?? C3" })).manifest, hp, hvPe.buf, { steamBuildId: "445", gameVersion: "4.4.5" });
    eq(row(r, "Foo_slots").status, "ported-derived", row(r, "Foo_slots").detail); eq(row(r, "Foo_slots").method, "extent");
    eq(row(r, "VT_Id").status, "ported-derived", row(r, "VT_Id").detail); eq(row(r, "VT_Id").method, "slot-search");
    const bad = portManifest(harvestManifest(hp, hvPe.buf, pm({ bodyPattern: "90 90 90" })).manifest, hp, hvPe.buf, { steamBuildId: "446", gameVersion: "4.4.6" });
    eq(row(bad, "VT_Id").status, "needs-human", row(bad, "VT_Id").detail);
    eq(entry(bad.manifest, "VT_Id")!.value, "1", "kept until a human decides");
  });
  test("renderPortReport: summary line, one row per entry, needs-attention sections with candidates and next steps", () => {
    const v2 = link({ fns: [{ name: "FnA", code: bodyA([0x90, 0x90], PRO2) }, { name: "FnA2", code: bodyA([0x90, 0x90, 0x90], PRO2) }, { name: "FnB", code: bodyB() }, { name: "FnC", code: bodyC(0x60) }], strings: { A: SIG_A, B: SIG_B }, globs: ["G"], stamp: 0x58585858 });
    const r = port(v2);
    const md = renderPortReport(r);
    assert(md.startsWith("# Port report 100 -> 200"), md.split("\n")[0]);
    assert(/^Summary: 6 entries/m.test(md), "summary");
    assert(/\| FnA \| function \|/.test(md) && /\| Mystery \| offset \|/.test(md), "rows");
    assert(/## Needs attention/.test(md) && /### FnA \(function, old 0x[0-9a-f]+\) -- ambiguous/.test(md), "attention section");
    assert(/candidates:/.test(md) && /next:/.test(md), "candidates + next step");
    assert(/### Foo_stacks \(offset\) -- proposed 0x5c -> 0x60/.test(md), "proposal");
    assert(/## Next steps/.test(md) && /npm run bindings:gen/.test(md), "next steps");
  });
  test("port: a constant with two derivations -> ported-derived when slot body and call-arg witness agree; needs-human with both values when they disagree", () => {
    const base = {
      format: 1,
      build: { steamBuildId: "444", gameVersion: "4.4.4", name: "4.4.4 (steam 444)", timeDateStamp: "0x44444444", sizeOfImage: "0x" + hp.sizeOfImage.toString(16), imageBase: "0x140000000", exeSha256: "d".repeat(64), exeSize: hvPe.buf.length, sdlVersion: "3.2.12" },
      sigCap: 128,
      entries: [
        { name: "FnB", kind: "function", rva: "0x1040", signature: null, anchors: {}, consumers: [], exposure: [], evidence: [] },
        { name: "FnD", kind: "function", rva: "0x1080", signature: null, anchors: {}, consumers: [], exposure: [], evidence: [] },
        { name: "Foo_vftable", kind: "vtable", rva: "0x2080", slots: 2, anchors: { rtti: { typeDescriptorName: ".?AVFoo@glaiel@@" } }, consumers: [], exposure: [{ field: "rva_Foo_vftable" }], evidence: [] },
        { name: "Foo_typeid", kind: "constant", value: "0x4d6", anchors: { derive: { vtable: "Foo_vftable", slot: 1, bodyPattern: "B8 ?? ?? ?? ?? C3", imm32At: 1 }, witness: { function: "FnD", callee: "FnB", pattern: "41 B8 ?? ?? ?? ??", imm32At: 2, maxBack: 6 } }, consumers: [], exposure: [{ field: "fooTypeId" }], evidence: [] },
      ],
    };
    const old = harvestManifest(hp, hvPe.buf, parseManifest(base)).manifest;
    // the two tiny functions carry no signature in this fixture: resolve them explicitly (the ladder is tested elsewhere)
    const resolve = { FnB: "0x1040", FnD: "0x1080" };
    const same = portManifest(old, hp, hvPe.buf, { steamBuildId: "445", gameVersion: "4.4.5", resolve });
    const r1 = row(same, "Foo_typeid");
    eq(r1.status, "ported-derived", r1.detail);
    assert(/agree/.test(r1.detail ?? "") && /0x4d6/.test(r1.detail ?? ""), r1.detail ?? "");
    // a build where the slot body says 0x4d7 but the call site still passes 0x4d6: nobody may pick blindly
    const patched = new Uint8Array(hvText);
    patched[0x41] = 0xd7;
    const img2 = buildFakePe({ timeDateStamp: 0x44444445, sections: [{ name: ".text", bytes: patched, exec: true }, { name: ".hvRdata", bytes: hvRdata }, { name: ".data", bytes: hvData, write: true }], pdata: hvPdata });
    const split = portManifest(old, parsePe(img2.buf), img2.buf, { steamBuildId: "446", gameVersion: "4.4.6", resolve });
    const r2 = row(split, "Foo_typeid");
    eq(r2.status, "needs-human", r2.detail);
    assert(/0x4d6/.test(r2.detail ?? "") && /0x4d7/.test(r2.detail ?? ""), r2.detail ?? "");
    eq(entry(split.manifest, "Foo_typeid")!.value, "0x4d6", "old value kept until a human decides");
  });
  // ---- the 2026-10-21 rungs: vtable-store, imm32 witness, caller-after-lea, tolerance-filtered string xrefs, .pdata neighbours, shared data ref ----
  console.log("\n# Bindings: port rungs (vtable-store, imm32-witness, caller-after-lea, pdata-predecessor, shared-data-ref) + harvest verification");
  /*
   * A fake build modelled on notes-bind: Target = Status_ApplyLuckUp (lea rdx,"LuckUp"; call Cmp; mov r8d,typeid; call FindBy; call Ctor),
   * Caller = apply_status (lea rdx,"LuckUp"; call Cmp; test al,al; jz; call Target), Ctor/Ctor2 = byte-twin ctors storing Foo/Bar vftables,
   * NE/NE2 = NameExists twins referencing MAP/MAP2, GV = GetValue (funcsig + MAP), Helper/HelperB = string-less .pdata neighbours of FindBy
   * with byte-twins elsewhere, Decoy (v2 only) = a third function lea'ing "LuckUp" far outside Target's size tolerance.
   */
  const nops = (n: number) => Array.from({ length: n }, () => 0x90);
  const LIT = "LuckUp";
  const SIG_GV = "double __cdecl glaiel::get_status_value(void)";
  const SIG_CALLER = "class glaiel::Status *__cdecl glaiel::apply_status(void)";
  const rungFns = (pro: number[], withDecoy: boolean) => [
    { name: "HelperBTwin", code: [...PRO, 0x48, 0x8b, 0xc1, 0x48, 0x8b, 0xd1, ...EPI] },
    { name: "HelperB", code: [...PRO, 0x48, 0x8b, 0xc1, 0x48, 0x8b, 0xd1, ...EPI] },
    { name: "FindBy", code: [...PRO, 0x48, 0x8b, 0xc1, 0x48, 0x8b, 0xd1, 0x48, 0x8b, 0xd9, ...EPI] },
    { name: "Helper", code: [...PRO, 0x48, 0x8b, 0xc1, 0x48, 0x8b, 0xf1, ...EPI] },
    { name: "HelperTwin", code: [...PRO, 0x48, 0x8b, 0xc1, 0x48, 0x8b, 0xf1, ...EPI] },
    { name: "Cmp", code: [...PRO, 0x31, 0xc0, ...EPI] },
    { name: "SlotFoo", code: [0xb8, 0xd6, 0x04, 0x00, 0x00, 0xc3] },
    { name: "SlotBar", code: [0xb8, 0xd7, 0x04, 0x00, 0x00, 0xc3] },
    { name: "GV", code: [...pro, { mov: "glob:MAP" }, { lea: "str:GV" }, 0x48, 0x8b, 0xd0, ...EPI] },
    { name: "Caller", code: [...pro, { lea: "str:CALLER" }, { leaRdx: "str:LIT" }, { call: "Cmp" }, 0x84, 0xc0, 0x74, 0x05, { call: "Target" }, ...nops(60), ...EPI] },
    { name: "Target", code: [...pro, { leaRdx: "str:LIT" }, { call: "Cmp" }, 0x84, 0xc0, 0x74, 0x10, 0x41, 0xb8, 0xd6, 0x04, 0x00, 0x00, 0x48, 0x8b, 0xcb, { call: "FindBy" }, { call: "Ctor" }, 0x48, 0x8b, 0xd8, ...EPI] },
    ...(withDecoy ? [{ name: "Decoy", code: [...pro, { leaRdx: "str:LIT" }, ...nops(60), ...EPI] as CodeItem[] }] : []),
    { name: "Ctor", code: [...pro, { leaRax: "vt:Foo" }, 0x48, 0x89, 0x03, { mov: "glob:POOL" }, ...EPI] },
    { name: "Ctor2", code: [...pro, { leaRax: "vt:Bar" }, 0x48, 0x89, 0x03, { mov: "glob:POOL2" }, ...EPI] },
    { name: "NE", code: [...pro, { mov: "glob:MAP" }, 0x48, 0x8b, 0xc8, ...EPI] },
    { name: "NE2", code: [...pro, { mov: "glob:MAP2" }, 0x48, 0x8b, 0xc8, ...EPI] },
  ];
  const rungSpec = (pro: number[], withDecoy: boolean, extra: Partial<LinkSpec> = {}): LinkSpec => ({
    fns: rungFns(pro, withDecoy), strings: { LIT, GV: SIG_GV, CALLER: SIG_CALLER }, globs: ["MAP", "MAP2", "POOL", "POOL2"],
    vtables: { Foo: { td: ".?AVFoo@glaiel@@", slots: ["SlotFoo"] }, Bar: { td: ".?AVBar@glaiel@@", slots: ["SlotBar"] } }, ...extra,
  });
  const rv1 = link(rungSpec(PRO, false, { stamp: 0x61616161 }));
  const rungManifest = (anchors: Record<string, Record<string, unknown>> = {}) => {
    // prologue-anchored signatures only (maxOffset 0), so v2's recompiled prologues break every one of them
    const sig = (rva: number) => { const r = makeSignature(rv1.pe, rv1.img.buf, rva, { minLen: 12, maxOffset: 0 }); return r.ok ? r.signature : null; };
    const fn = (name: string, a: Record<string, unknown> = {}) => ({ name, kind: "function", rva: hex(rv1.fnAt[name]!), signature: sig(rv1.fnAt[name]!), anchors: { ...a, ...(anchors[name] || {}) }, consumers: [], exposure: [], evidence: [] });
    const m = parseManifest({
      format: 1,
      build: { steamBuildId: "600", gameVersion: "6.0.0", name: "6.0.0 (steam 600)", timeDateStamp: "0x61616161", sizeOfImage: "0x" + rv1.pe.sizeOfImage.toString(16), imageBase: "0x140000000", exeSha256: "f".repeat(64), exeSize: rv1.img.buf.length, sdlVersion: "3.2.12" },
      sigCap: 128,
      entries: [
        fn("FindBy"), fn("Cmp"), fn("GV"), fn("Caller"),
        fn("Target", { strings: [{ text: LIT, role: "literal", unique: true }], imm32Witness: { pattern: "41 B8 ?? ?? ?? ??", imm32At: 2, equals: "Foo_typeid", callee: "FindBy", maxForward: 4 }, callers: [{ function: "Caller", ordinal: 1, afterStringLea: LIT }] }),
        fn("Ctor", { vtableStore: { vtable: "Foo_vftable", pattern: "48 8D 05 ?? ?? ?? ?? 48 89 03" }, dataRefs: [{ rva: hex(rv1.globAt.POOL!), role: "pool" }] }),
        fn("Ctor2", { vtableStore: { vtable: "Bar_vftable", pattern: "48 8D 05 ?? ?? ?? ?? 48 89 03" } }),
        fn("Helper", { after: { function: "FindBy" } }),
        fn("HelperB", { before: { function: "FindBy" } }),
        fn("NE", { sharedDataRef: { with: "GV", ripRefOrdinal: 0 } }),
        fn("NE2"),
        { name: "Foo_vftable", kind: "vtable", rva: hex(rv1.vtAt.Foo!), slots: 1, anchors: { rtti: { typeDescriptorName: ".?AVFoo@glaiel@@" } }, consumers: [], exposure: [{ field: "rva_Foo_vftable" }], evidence: [] },
        { name: "Bar_vftable", kind: "vtable", rva: hex(rv1.vtAt.Bar!), slots: 1, anchors: { rtti: { typeDescriptorName: ".?AVBar@glaiel@@" } }, consumers: [], exposure: [], evidence: [] },
        { name: "Foo_typeid", kind: "constant", value: "0x4d6", anchors: { derive: { vtable: "Foo_vftable", slot: 0, bodyPattern: "B8 ?? ?? ?? ?? C3", imm32At: 1 } }, consumers: [], exposure: [{ field: "fooTypeId" }], evidence: [] },
      ],
    });
    return m;
  };
  const rungOld = () => harvestManifest(rv1.pe, rv1.img.buf, rungManifest()).manifest;
  /** v2: every prologue recompiled (signatures of the anchored functions break), layout shifted, Decoy added */
  const rv2 = link(rungSpec(PRO2, true, { stamp: 0x62626262, textPad: 0x40, rdataPad: 0x18 }));
  const stripAnchors = (m: ReturnType<typeof rungOld>, name: string, keys: string[]) => { const c = JSON.parse(JSON.stringify(m)) as typeof m; const e = entry(c, name)!; for (const k of keys) delete e.anchors[k]; return c; };
  const portRung = (m: ReturnType<typeof rungOld>, v = rv2) => portManifest(m, v.pe, v.img.buf, { steamBuildId: "601", gameVersion: "6.0.1" });

  test("validateManifest: the new anchors must reference existing entries of the right kind (vtableStore.vtable, imm32Witness.equals/.callee, callers[].function, after/before.function, sharedDataRef.with)", () => {
    const base = () => { const m = mini(); m.entries[1].anchors = {}; return m; };
    const bad = (anchors: Record<string, unknown>, re: RegExp, what: string) => { const m = base(); m.entries[1].anchors = anchors; rejects(m, re, what); };
    const good = (anchors: Record<string, unknown>, what: string) => { const m = base(); m.entries[1].anchors = anchors; eq(problems(m).length, 0, `${what}: ${JSON.stringify(problems(m))}`); };
    good({ vtableStore: { vtable: "Foo_vftable", pattern: "48 8D 05 ?? ?? ?? ?? 48 89 03" } }, "vtableStore");
    bad({ vtableStore: { vtable: "Nope", pattern: "48 8D 05 ?? ?? ?? ?? 48 89 03" } }, /FnB.*vtableStore.*Nope/, "unknown vtable");
    bad({ vtableStore: { vtable: "FnA", pattern: "48 8D 05 ?? ?? ?? ?? 48 89 03" } }, /FnB.*vtableStore.*FnA.*vtable/, "not a vtable entry");
    bad({ vtableStore: { vtable: "Foo_vftable", pattern: "48 ZZ" } }, /FnB.*vtableStore.*pattern/, "bad pattern");
    good({ imm32Witness: { pattern: "41 B8 ?? ?? ?? ??", imm32At: 2, equals: "Foo_typeid", callee: "FnA", maxForward: 4 } }, "imm32Witness");
    bad({ imm32Witness: { pattern: "41 B8 ?? ?? ?? ??", imm32At: 2, equals: "Glob", callee: "FnA" } }, /FnB.*imm32Witness\.equals.*Glob.*constant/, "equals must be a constant");
    bad({ imm32Witness: { pattern: "41 B8 ?? ?? ?? ??", imm32At: 2, equals: "Foo_typeid", callee: "Nope" } }, /FnB.*imm32Witness\.callee.*Nope/, "unknown callee");
    bad({ imm32Witness: { pattern: "41 B8 ?? ?? ?? ??", equals: "Foo_typeid", callee: "FnA" } }, /FnB.*imm32Witness.*imm32At/, "imm32At required");
    good({ callers: [{ function: "FnA", ordinal: 3, afterStringLea: "LuckUp" }] }, "callers");
    bad({ callers: [{ function: "Nope", ordinal: 3 }] }, /FnB.*callers.*Nope/, "unknown caller");
    bad({ callers: [{ function: "Glob", ordinal: 3 }] }, /FnB.*callers.*Glob.*function/, "caller must be a function");
    good({ after: { function: "FnA" }, before: { function: "FnA" } }, "after/before");
    bad({ before: { function: "Nope" } }, /FnB.*before.*Nope/, "unknown before");
    bad({ after: { function: "Glob" } }, /FnB.*after.*Glob.*function/, "after must be a function");
    good({ sharedDataRef: { with: "FnA", ripRefOrdinal: 0 } }, "sharedDataRef");
    bad({ sharedDataRef: { with: "Nope", ripRefOrdinal: 0 } }, /FnB.*sharedDataRef.*Nope/, "unknown with");
    bad({ sharedDataRef: { with: "FnA" } }, /FnB.*sharedDataRef.*ripRefOrdinal/, "ripRefOrdinal required");
  });
  test("harvestManifest verifies the new function anchors on the current exe: verified when each resolves to the entry itself, mismatch when one points elsewhere; a caller ordinal and a dataRef ordinal are (re)harvested", () => {
    const { manifest: out, report } = harvestManifest(rv1.pe, rv1.img.buf, rungManifest({ Target: { callers: [{ function: "Caller", ordinal: 0, afterStringLea: LIT }] } }));
    const r = (n: string) => { const x = report.find((x) => x.name === n); if (!x) throw new Error(`no row ${n}`); return x; };
    for (const n of ["Ctor", "Ctor2", "Helper", "HelperB", "NE"]) eq(r(n).status, "verified", `${n}: ${r(n).detail}`);
    assert(/vtable-store/.test(r("Ctor").detail) && /dataRefs/.test(r("Ctor").detail), r("Ctor").detail);
    assert(/pdata-successor/.test(r("Helper").detail) && /pdata-predecessor/.test(r("HelperB").detail) && /shared-data-ref/.test(r("NE").detail), `${r("Helper").detail} | ${r("HelperB").detail} | ${r("NE").detail}`);
    eq(r("Target").status, "harvested", r("Target").detail);
    assert(/imm32-witness/.test(r("Target").detail) && /caller-after-lea/.test(r("Target").detail), r("Target").detail);
    eq(entry(out, "Target")!.anchors.callers![0].ordinal, 1, "the stale caller ordinal is re-harvested (call #1 of Caller)");
    eq(entry(out, "Ctor")!.anchors.dataRefs![0].ripRefOrdinal, 1, "the dataRef is located by rip-ref ordinal (#0 is the vftable lea)");
    eq(r("FindBy").status, "harvested", "an entry without such anchors stays harvested");
    const wrong = harvestManifest(rv1.pe, rv1.img.buf, rungManifest({ Ctor: { vtableStore: { vtable: "Bar_vftable", pattern: "48 8D 05 ?? ?? ?? ?? 48 89 03" } }, Helper: { after: { function: "Cmp" } } })).report;
    const w = (n: string) => wrong.find((x) => x.name === n)!;
    eq(w("Ctor").status, "mismatch", w("Ctor").detail);
    assert(/Ctor2|0x[0-9a-f]+/.test(w("Ctor").detail), `names where the anchor leads: ${w("Ctor").detail}`);
    eq(w("Helper").status, "mismatch", w("Helper").detail);
  });
  test("port: vtable-store rung — a byte-twin constructor is found as the only code site that lea's its RTTI-derived vftable (vtables port before the function ladder); its dataRef follows by rip-ref ordinal", () => {
    const r = portRung(rungOld());
    for (const n of ["Ctor", "Ctor2"]) { eq(row(r, n).status, "ported-anchor", `${n}: ${row(r, n).detail}`); eq(row(r, n).method, "vtable-store", n); eq(entry(r.manifest, n)!.rva, hex(rv2.fnAt[n]!), n); }
    assert(/vtable store of Foo_vftable/.test(row(r, "Ctor").detail), row(r, "Ctor").detail);
    eq(entry(r.manifest, "Ctor")!.anchors.dataRefs![0].rva, hex(rv2.globAt.POOL!), "dataRef rva refreshed on the new image");
    eq(row(r, "Foo_vftable").status, "ported-derived");
  });
  test("port: imm32-witness rung — the function whose `mov r8d, <typeid>` precedes a call to a ported callee within maxForward instructions (the type id is re-derived from the vftable slot, never read from the old manifest)", () => {
    const r = portRung(rungOld());
    eq(row(r, "Target").status, "ported-anchor", row(r, "Target").detail);
    eq(row(r, "Target").method, "imm32-witness");
    eq(entry(r.manifest, "Target")!.rva, hex(rv2.fnAt.Target!));
    assert(/imm32 0x4d6 .*FindBy/.test(row(r, "Target").detail), row(r, "Target").detail);
    // a build whose slot body says 0x4d7 while the call site still passes 0x4d6: the witness must not find it
    const patched = link(rungSpec(PRO2, true, { stamp: 0x63636363, textPad: 0x40, rdataPad: 0x18 }));
    patched.img.buf[patched.pe.rvaToOff(patched.fnAt.SlotFoo!) + 1] = 0xd7;
    const r2 = portManifest(stripAnchors(rungOld(), "Target", ["callers", "strings"]), parsePe(patched.img.buf), patched.img.buf, { steamBuildId: "602", gameVersion: "6.0.2" });
    assert(row(r2, "Target").status !== "ported-anchor" || row(r2, "Target").method !== "imm32-witness", `must not port by a stale immediate: ${row(r2, "Target").detail}`);
    eq(row(r2, "Target").method, "caller-ordinal", `the next rung (the caller's call #1) takes over: ${row(r2, "Target").detail}`);
    eq(entry(r2.manifest, "Target")!.rva, hex(patched.fnAt.Target!));
  });
  test("port: caller-after-lea rung — the first in-tolerance E8 after `lea rdx,[rip+\"LuckUp\"]` inside a ported caller (the compare call before it is skipped by the size tolerance); the caller ordinal is refreshed", () => {
    const r = portRung(stripAnchors(rungOld(), "Target", ["imm32Witness"]));
    eq(row(r, "Caller").method, "funcsig-xref", row(r, "Caller").detail);
    eq(row(r, "Target").status, "ported-anchor", row(r, "Target").detail);
    eq(row(r, "Target").method, "caller-after-lea");
    eq(entry(r.manifest, "Target")!.rva, hex(rv2.fnAt.Target!));
    assert(/after lea "LuckUp" in Caller/.test(row(r, "Target").detail), row(r, "Target").detail);
    eq(entry(r.manifest, "Target")!.anchors.callers![0].ordinal, 1, "ordinal re-harvested on the new image");
  });
  test("port: several string-xref candidates are filtered by the cfgLite tolerance before anything is called ambiguous (Decoy and Caller lea the same literal but are far too big)", () => {
    const r = portRung(stripAnchors(rungOld(), "Target", ["imm32Witness", "callers"]));
    eq(row(r, "Target").status, "ported-anchor", row(r, "Target").detail);
    eq(row(r, "Target").method, "funcsig-xref");
    eq(entry(r.manifest, "Target")!.rva, hex(rv2.fnAt.Target!));
    assert(/literal xref/.test(row(r, "Target").detail) && /3 candidates?, 1 within tolerance|2 of 3 .*tolerance/.test(row(r, "Target").detail), row(r, "Target").detail);
  });
  test("port: .pdata neighbours by index — `after` ports the successor, `before` the predecessor of a ported entry (string-less byte-twins)", () => {
    const r = portRung(rungOld());
    eq(row(r, "FindBy").status, "ported-rescan", row(r, "FindBy").detail);
    eq(row(r, "Helper").status, "ported-anchor", row(r, "Helper").detail); eq(row(r, "Helper").method, "pdata-successor");
    eq(entry(r.manifest, "Helper")!.rva, hex(rv2.fnAt.Helper!));
    eq(row(r, "HelperB").status, "ported-anchor", row(r, "HelperB").detail); eq(row(r, "HelperB").method, "pdata-predecessor");
    eq(entry(r.manifest, "HelperB")!.rva, hex(rv2.fnAt.HelperB!));
    assert(/\.pdata predecessor of FindBy/.test(row(r, "HelperB").detail), row(r, "HelperB").detail);
  });
  test("port: shared-data-ref rung — the other .pdata function referencing rip ref #k of a ported function (NameExists shares GetValue's map); its twin on another map stays failed", () => {
    const r = portRung(rungOld());
    eq(row(r, "GV").method, "funcsig-xref", row(r, "GV").detail);
    eq(row(r, "NE").status, "ported-anchor", row(r, "NE").detail); eq(row(r, "NE").method, "shared-data-ref");
    eq(entry(r.manifest, "NE")!.rva, hex(rv2.fnAt.NE!));
    assert(/rip ref #0 of GV/.test(row(r, "NE").detail), row(r, "NE").detail);
    eq(row(r, "NE2").status, "failed", row(r, "NE2").detail);
    eq(validateManifest(r.manifest).ok, true, JSON.stringify(validateManifest(r.manifest).problems));
  });
  test("the committed manifest carries the notes-bind anchors: Status_ApplyLuckUp (literals, imm32 witness, callers after lea, null signature), LuckUp_ctor (vtable store, pool dataRef), the 11 lookups' .pdata chain, NameExists before/shared map, FrameBegin/FrameEnd neighbours", () => {
    const m = loadManifest(realPath);
    const a = entry(m, "Status_ApplyLuckUp")!;
    eq(a.signature, null);
    eq((a.anchors.strings || []).filter((s) => s.role === "literal" && s.unique).map((s) => s.text).sort().join(","), "LuckUp,None");
    eq(JSON.stringify({ ...a.anchors.imm32Witness, note: undefined }), JSON.stringify({ pattern: "41 B8 ?? ?? ?? ??", imm32At: 2, equals: "LuckUp_typeid", callee: "Entity_FindComponentsByTypeId", maxForward: 4 }));
    eq((a.anchors.callers || []).map((c) => `${c.function}#${c.ordinal}@${c.afterStringLea}`).join(","), "Status_ApplyByName#1261@LuckUp,Status_AttachPassive#3439@LuckUp");
    const c = entry(m, "LuckUp_ctor")!;
    eq(c.signature, null);
    eq(JSON.stringify({ ...c.anchors.vtableStore, note: undefined }), JSON.stringify({ vtable: "LuckUp_vftable", pattern: "48 8D 05 ?? ?? ?? ?? 48 89 03" }));
    eq((c.anchors.dataRefs || []).map((d) => `${d.rva}:${d.role}`).join(","), "0x1414e40:pool");
    eq((c.anchors.callers || []).map((x) => `${x.function}#${x.ordinal}`).join(","), "Status_ApplyLuckUp#6");
    const chain: [string, string][] = [["Status_GetCategory", "Status_ApplyByName"], ["Status_GetStackMode", "Status_GetCategory"], ["Status_NameExists", "Status_GetStackMode"], ["Status_GetValue", "Status_NameExists"], ["Status_GetFlags", "Status_GetValue"], ["Status_GetIcon", "Status_GetFlags"], ["Status_OnAppliedToDamageInstance", "Status_GetIcon"], ["Status_OnAppliedToTile", "Status_OnAppliedToDamageInstance"], ["Status_OnKilledCharacter", "Status_OnAppliedToTile"], ["Status_OnDamageReport", "Status_OnKilledCharacter"], ["Status_AttachPassive", "Status_OnDamageReport"], ["Status_SpawnTile", "Status_IsHitEffect"], ["ApplicationBase_FrameEnd", "ApplicationBase_FrameBegin"]];
    for (const [n, prev] of chain) eq(entry(m, n)!.anchors.after?.function, prev, `${n}.after`);
    eq(entry(m, "Status_NameExists")!.anchors.before?.function, "Status_GetValue");
    eq(JSON.stringify({ ...entry(m, "Status_NameExists")!.anchors.sharedDataRef, note: undefined }), JSON.stringify({ with: "Status_GetValue", ripRefOrdinal: 0 }));
    eq(entry(m, "ApplicationBase_FrameBegin")!.anchors.before?.function, "ApplicationBase_FrameEnd");
    for (const n of ["Status_GetStackMode", "Status_IsHitEffect", "Status_OnKilledCharacter"]) eq(entry(m, n)!.signature, null, `${n}: a __LINE__-anchored body signature would port a twin silently when the line shifts; stays null`);
  });
  if (exe) {
    test("T1 real exe: every new anchor in the committed manifest verifies on the installed exe (harvest reports no mismatch, and the vtable-store / imm32 / caller-after-lea / neighbour / shared-ref anchors resolve to their own entries)", () => {
      const m = loadManifest(realPath);
      const rep = harvestManifest(parsePe(exe), exe, m).report;
      const byName = (n: string) => rep.find((r) => r.name === n)!;
      for (const n of ["Status_ApplyLuckUp", "LuckUp_ctor", "Status_NameExists", "Status_GetCategory", "Status_SpawnTile", "ApplicationBase_FrameBegin", "ApplicationBase_FrameEnd"]) eq(byName(n).status, "verified", `${n}: ${byName(n).detail}`);
      assert(/vtable-store ok/.test(byName("LuckUp_ctor").detail), byName("LuckUp_ctor").detail);
      assert(/imm32-witness 0x4d6 ok/.test(byName("Status_ApplyLuckUp").detail) && /caller-after-lea ok \(Status_ApplyByName\)/.test(byName("Status_ApplyLuckUp").detail) && /caller-after-lea ok \(Status_AttachPassive\)/.test(byName("Status_ApplyLuckUp").detail), byName("Status_ApplyLuckUp").detail);
      assert(/shared-data-ref ok/.test(byName("Status_NameExists").detail) && /pdata-predecessor of Status_GetValue ok/.test(byName("Status_NameExists").detail), byName("Status_NameExists").detail);
      eq(rep.filter((r) => r.status === "mismatch").map((r) => `${r.name}: ${r.detail}`).join("; "), "");
    });
    test("T1 real exe: with the signature rung disabled, the three null-signature functions port by their new anchors onto the installed exe (vtable-store, imm32-witness, funcsig-xref) with their known RVAs", () => {
      const m = loadManifest(realPath);
      const p = parsePe(exe);
      const r = portManifest(m, p, exe, { steamBuildId: "25143593", gameVersion: "1.1.21239" });
      const want: [string, string][] = [["LuckUp_ctor", "vtable-store"], ["Status_ApplyLuckUp", "imm32-witness"], ["Status_GetCategory", "funcsig-xref"], ["Status_NameExists", "pdata-successor"]];
      for (const [n, method] of want) { eq(row(r, n).status, "ported-anchor", `${n}: ${row(r, n).detail}`); eq(row(r, n).method, method, `${n}: ${row(r, n).detail}`); eq(entry(r.manifest, n)!.rva, entry(m, n)!.rva, n); }
      // the callers rung agrees with the ordinal rung when forced (imm32 witness removed)
      const c = JSON.parse(JSON.stringify(m)) as typeof m;
      delete entry(c, "Status_ApplyLuckUp")!.anchors.imm32Witness;
      const r2 = portManifest(c, p, exe, { steamBuildId: "25143593", gameVersion: "1.1.21239" });
      eq(row(r2, "Status_ApplyLuckUp").method, "caller-after-lea", row(r2, "Status_ApplyLuckUp").detail);
      eq(entry(r2.manifest, "Status_ApplyLuckUp")!.rva, "0x5f9760");
    });
  }
  // ---- evidence truth: every manifest evidence path is a doc section or a file that exists under .analysis/ ----
  test("every manifest evidence string is a doc section or an .analysis/ path (optionally :line)", () => {
    const m = loadManifest(realPath);
    const bad = m.entries.flatMap((e) => (e.evidence || []).filter((ev) => !/^(docs\/[\w./-]+\.md(#[\w-]+)?|\.analysis\/[\w./-]+(:\d+)?)$/.test(ev)).map((ev) => `${e.name}: ${ev}`));
    assert(bad.length === 0, bad.join("; "));
  });
  {
    // .analysis/ resolves through ANALYSIS_DIR (MEWGENICS_ANALYSIS_DIR), so a worktree checks against the main
    // checkout's decompile store.
    const ANALYSIS = ANALYSIS_DIR;
    if (existsSync(join(ANALYSIS, "decompiled"))) {
      test("every .analysis/ evidence path in the committed manifest exists on disk (the decompile store is rebuilt; .analysis/ is git-ignored, so this runs only where it exists)", () => {
        const m = loadManifest(realPath);
        const missing = m.entries.flatMap((e) => (e.evidence || []).filter((ev) => ev.startsWith(".analysis/")).map((ev) => ev.replace(/:\d+$/, "")).filter((ev) => !existsSync(join(ANALYSIS, ev.slice(".analysis/".length)))).map((ev) => `${e.name}: ${ev}`));
        assert(missing.length === 0, missing.join("; "));
      });
    } else console.log("  (skipped: .analysis/decompiled absent — the evidence-on-disk check runs where the decompile store exists)");
  }
  /** offsets that carry a witness in the committed manifest (batch 1: the harness's unit walk, console, app and scene offsets) */
  const WITNESSED_OFFSETS_BATCH1 = [
    "App_running", "App_window", "DebugConsole_outBegin", "DebugConsole_outEnd", "TurnControl_scene", "Scene_entityManager",
    "EntityManager_x", "X_charArray", "RefArray_count", "RefArray_data", "TurnControl_round", "Component_sceneManager",
    "Scene_destroyed", "SceneManager_mainScene", "Scene_destroyNext", "MewDirector_devFightFlag", "MewDirector_devFightMode",
    "MewDirector_handoffFlag", "Tls_rngState",
  ];
  /** batch 2: the status_engine offsets (Character, Entity, Status, the apply context) */
  const WITNESSED_OFFSETS_BATCH2 = [
    "Character_entity", "Character_catData", "CatData_class", "Character_name", "Character_faction", "Character_move", "Character_act",
    "Character_turnKind", "Entity_componentCount", "Entity_components", "Status_removing", "Status_stacks", "Status_character",
    "Status_temporary", "Status_applier", "Status_applierOwner", "ApplyCtx_scene", "ApplyCtx_entity", "ApplyP6_applier",
    "Applier_owner", "Character_touchedPassives",
  ];
  test("the committed manifest has no unanchored entry: the six vtable-slot constants derive from the LuckUp vftable (extent, slot search) or a call-slot witness", () => {
    const m = loadManifest(realPath);
    eq(m.entries.filter((e) => e.anchors.unanchored).map((e) => e.name).join(","), "", "nothing unanchored");
    eq(JSON.stringify(entry(m, "LuckUp_vtableSlots")!.anchors.derive), JSON.stringify({ vtable: "LuckUp_vftable", extent: true }));
    for (const n of ["VT_GetTypeName", "VT_GetTypeId", "VT_IsA", "VT_GetTypeHierarchy"]) assert(!!entry(m, n)!.anchors.derive?.slotSearch, `${n}: slotSearch`);
    assert(entry(m, "VT_OnStacksChanged")!.anchors.witness?.scale === 8, "VT_OnStacksChanged: a scaled call-slot witness");
  });
  if (exe) {
    test("T1 real exe: the six vtable-slot constants verify on the installed exe (harvest)", () => {
      const m = loadManifest(realPath);
      const rep = harvestManifest(parsePe(exe), exe, m).report;
      for (const n of ["LuckUp_vtableSlots", "VT_GetTypeName", "VT_GetTypeId", "VT_IsA", "VT_GetTypeHierarchy", "VT_OnStacksChanged"]) {
        const x = rep.find((r) => r.name === n)!;
        eq(x.status, "verified", `${n}: ${x.detail}`);
      }
    });
  }
  test("the committed manifest anchors the batch-2 offsets (status_engine): every offset now carries a witness; exactly the six vtable-slot constants are still unanchored", () => {
    const m = loadManifest(realPath);
    for (const name of WITNESSED_OFFSETS_BATCH2) {
      const e = entry(m, name);
      assert(!!e && e.kind === "offset", `${name} is an offset entry`);
      const w = e!.anchors.witness;
      assert(!!w && typeof w.function === "string" && typeof w.pattern === "string" && Number.isInteger(w.dispAt), `${name}: witness {function, pattern, dispAt}: ${JSON.stringify(w)}`);
      assert(e!.anchors.unanchored !== true, `${name}: no longer unanchored`);
    }
    eq(m.entries.filter((e) => e.kind === "offset" && !(e.anchors.witness && e.anchors.witness.pattern)).map((e) => e.name).join(","), "", "no offset without a witness");
    assert(m.entries.filter((e) => e.anchors.unanchored).every((e) => e.kind === "constant"), "whatever is still unanchored is a constant");
  });
  test("the committed manifest anchors the batch-1 offsets: each carries anchors.witness {function, pattern, dispAt} and no unanchored flag; the dev-menu lambda is a function entry", () => {
    const m = loadManifest(realPath);
    for (const name of WITNESSED_OFFSETS_BATCH1) {
      const e = entry(m, name);
      assert(!!e && e.kind === "offset", `${name} is an offset entry`);
      const w = e!.anchors.witness;
      assert(!!w && typeof w.function === "string" && typeof w.pattern === "string" && Number.isInteger(w.dispAt), `${name}: witness {function, pattern, dispAt}: ${JSON.stringify(w)}`);
      assert(e!.anchors.unanchored !== true, `${name}: no longer unanchored`);
      const f = entry(m, w!.function);
      assert(!!f && f.kind === "function", `${name}: witness function ${w!.function} is a function entry`);
    }
    const lambda = entry(m, "DevMenu_TacticsTest_lambda");
    assert(!!lambda && lambda.kind === "function" && lambda.rva === "0x32fc00" && !!lambda.signature, "DevMenu_TacticsTest_lambda 0x32fc00 with a signature");
    const left = m.entries.filter((e) => e.anchors.unanchored).length;
    assert(left <= 46 - WITNESSED_OFFSETS_BATCH1.length, `unanchored count dropped by at least the batch: ${left}`);
  });
  // ---- facing bindings (2026-10-22): Character::Face, the harness's `face` directive and the units event's facing fields ----
  const FACING_SYMBOLS: [string, string, number][] = [["Character_Face", "0x10ce50", 35]];
  /** struct offsets Character::Face reads or writes: name, macro, value (every witness lives in Character_Face) */
  const FACING_OFFSETS: [string, string, string][] = [
    ["Character_animSM", "OFF_CH_ANIMSM", "0x58"], ["AnimSM_facing", "OFF_ANIMSM_FACING", "0xb8"], ["AnimSM_flip", "OFF_ANIMSM_FLIP", "0x14c"],
    ["Character_orientation", "OFF_CH_ORIENTATION", "0x388"], ["Character_lockOrientation", "OFF_CH_LOCK_ORIENTATION", "0x3ac"],
    ["Character_faceSign", "OFF_CH_FACE_SIGN", "0x3a4"], ["Character_artFlip", "OFF_CH_ART_FLIP", "0x3a0"], ["Character_noHFlip", "OFF_CH_NO_HFLIP", "0x3a8"],
    ["Character_alwaysFront", "OFF_CH_ALWAYS_FRONT", "0x3b4"], ["Character_fourWay", "OFF_CH_FOUR_WAY", "0x4cd"],
  ];
  const FACING_NAMES = new Set([...FACING_SYMBOLS.map((x) => x[0]), ...FACING_OFFSETS.map((x) => x[0])]);
  test("the committed manifest carries the facing bindings (2026-10-22) as one contiguous block: Character_Face (FW_SYM 35, signed) and 10 offsets witnessed inside it; the generated headers expose them", () => {
    const m = loadManifest(realPath);
    for (const [name, rva, index] of FACING_SYMBOLS) {
      const e = entry(m, name);
      assert(!!e && e.kind === "function" && e.rva === rva && !!e.signature, `${name} is a signed function at ${rva}`);
      eq(JSON.stringify(e!.exposure), JSON.stringify([{ enum: `FW_SYM_${name}`, index }]), `${name} enumerator`);
      assert(e!.consumers.some((c) => c.includes("mewtest.c")), `${name}: the harness consumes it`);
    }
    for (const [name, macro, value] of FACING_OFFSETS) {
      const e = entry(m, name);
      assert(!!e && e.kind === "offset", `${name} is an offset entry`);
      eq(e!.value, value, `${name} value`);
      eq(JSON.stringify(e!.exposure), JSON.stringify([{ macro }]), `${name} macro`);
      const w = e!.anchors.witness;
      assert(!!w && w.function === "Character_Face" && typeof w.pattern === "string" && Number.isInteger(w.dispAt), `${name}: witness in Character_Face: ${JSON.stringify(w)}`);
    }
    const names = m.entries.map((e) => e.name);
    const idx = names.map((n, i) => (FACING_NAMES.has(n) ? i : -1)).filter((i) => i >= 0);
    eq(idx.length, FACING_NAMES.size, "every facing entry is present");
    eq(idx[idx.length - 1]! - idx[0]! + 1, FACING_NAMES.size, "the facing entries are one contiguous block");
    const oh = genOffsetsH([m]);
    for (const [, macro, value] of FACING_OFFSETS) assert(new RegExp(`^#define ${macro}\\s+${value}\\s`, "m").test(oh), `${macro} ${value} in offsets.h`);
    const sh = genSignaturesH([m]);
    assert(sh.includes('"Character_Face", "') && sh.includes("0x10ce50u },  /* FW_SYM_Character_Face */"), "the Character_Face signature row");
  });
  if (exe) {
    test("T1 real exe: the facing block verifies on the installed exe (harvest): Character_Face's signature and every facing offset witness", () => {
      const m = loadManifest(realPath);
      const rep = harvestManifest(parsePe(exe), exe, m).report;
      for (const n of [...FACING_SYMBOLS.map((x) => x[0]), ...FACING_OFFSETS.map((x) => x[0])]) {
        const x = rep.find((r) => r.name === n);
        eq(x?.status, "verified", `${n}: ${x?.detail}`);
      }
    });
  }
  // ---- campaign walk (2026-10-22): run start / run travel / run fight (docs/engine-map.md "Campaign walk") ----
  /** FwSymbol functions the harness calls or hooks: name, rva, enumerator index (appended after Character_Face = 35) */
  const WALK_SYMBOLS: [string, string, number][] = [
    ["MewDirector_GoOnAnAdventure", "0x3b01c0", 36], ["MapScreen_init", "0x38d150", 37], ["MapScreen_EnterNode", "0x391c20", 38], ["MewDirector_StartMapBattle", "0x3b6d10", 39],
  ];
  /** reference-only functions (witness carriers): name, rva */
  const WALK_REFERENCE: [string, string][] = [["MapScreen_onArriveNode", "0x39b180"], ["MapScreen_nemesisCheck", "0x392ed0"], ["MapScreen_generate_map", "0x21ca60"]];
  /** struct offsets: name, macro, value, the function whose bytes witness it */
  const WALK_OFFSETS: [string, string, string, string][] = [
    ["MapScreen_nodeCount", "OFF_MAPSCREEN_NODE_COUNT", "0x7c", "MapScreen_init"],
    ["MapScreen_nodes", "OFF_MAPSCREEN_NODES", "0x80", "MapScreen_init"],
    ["MapScreen_marker", "OFF_MAPSCREEN_MARKER", "0xa0", "MapScreen_init"],
    ["MapMarker_node", "OFF_MAPMARKER_NODE", "0x50", "MapScreen_nemesisCheck"],
    ["MapNode_type", "OFF_MAPNODE_TYPE", "0x138", "MapScreen_EnterNode"],
    ["MapNode_nextCount", "OFF_MAPNODE_NEXT_COUNT", "0x144", "MapScreen_generate_map"],
    ["MapNode_nextData", "OFF_MAPNODE_NEXT_DATA", "0x148", "MapScreen_generate_map"],
    ["MapNode_done", "OFF_MAPNODE_DONE", "0x168", "MapScreen_onArriveNode"],
  ];
  const WALK_NAMES = new Set([...WALK_SYMBOLS.map((x) => x[0]), ...WALK_REFERENCE.map((x) => x[0]), ...WALK_OFFSETS.map((x) => x[0])]);
  test("the committed manifest carries the campaign-walk bindings (2026-10-22) as one contiguous block at its end: 4 FwSymbol functions (GoOnAnAdventure, MapScreen::init, MapScreen::EnterNode, StartMapBattle), 3 reference functions, 8 witnessed offsets; the generated headers expose them", () => {
    const m = loadManifest(realPath);
    eq(enumerators("FW_SYM_").length, 42);
    for (const [name, rva, index] of WALK_SYMBOLS) {
      const e = entry(m, name);
      assert(!!e && e.kind === "function" && e.rva === rva && !!e.signature, `${name} is a signed function at ${rva}`);
      eq(JSON.stringify(e!.exposure), JSON.stringify([{ enum: `FW_SYM_${name}`, index }]), `${name} enumerator`);
      eq(enumerators("FW_SYM_")[index], `FW_SYM_${name}`, `${name} sits at index ${index} of framework_api.h`);
    }
    for (const [name, rva] of WALK_REFERENCE) {
      const e = entry(m, name);
      assert(!!e && e.kind === "function" && e.rva === rva && !!e.signature, `${name} is a signed function at ${rva}`);
      eq(e!.exposure.length, 0, `${name} is reference only`);
    }
    for (const [name, macro, value, fn] of WALK_OFFSETS) {
      const e = entry(m, name);
      assert(!!e && e.kind === "offset", `${name} is an offset entry`);
      eq(e!.value, value, `${name} value`);
      eq(JSON.stringify(e!.exposure), JSON.stringify([{ macro }]), `${name} macro`);
      const w = e!.anchors.witness;
      assert(!!w && w.function === fn && typeof w.pattern === "string" && Number.isInteger(w.dispAt), `${name}: witness {function ${fn}, pattern, dispAt}: ${JSON.stringify(w)}`);
    }
    const names = m.entries.map((e) => e.name);
    const idx = names.map((n, i) => (WALK_NAMES.has(n) ? i : -1)).filter((i) => i >= 0);
    eq(idx.length, WALK_NAMES.size, "every walk entry is present");
    eq(idx[0], names.length - WALK_NAMES.size, "the walk block is the manifest's tail (eases the 3-way merge by entry name)");
    const oh = genOffsetsH([m]);
    for (const [, macro, value] of WALK_OFFSETS) assert(new RegExp(`^#define ${macro}\\s+\\(?${value}\\)?\\s`, "m").test(oh), `${macro} ${value} in offsets.h`);
    const sh = genSignaturesH([m]);
    for (const [name, rva] of WALK_SYMBOLS) assert(sh.includes(`0x${rva.slice(2)}u },  /* FW_SYM_${name} */`), `the ${name} row in signatures.h`);
  });
  // ---- per-unit glow bindings (2026-10-22): the combat outline mask mewframework's glow engine rides ----
  /** FwSymbol functions the glow engine calls or hooks: name, rva, enumerator index (appended after SaveProps_GetOrCreate = 27) */
  const GLOW_SYMBOLS: [string, string, number][] = [
    ["TacticsTest_LateRender", "0x88d780", 28], ["vec_u32_AddUnique", "0x72cd0", 29], ["ShaderManager_GetOrCreateMaterial", "0x9bb5d0", 30],
    ["Material_SetUniformVec4", "0x9bde70", 31], ["Material_SetUniformFloat", "0x9bddc0", 32], ["Material_SetTexture", "0x9bdcd0", 33],
    ["Camera_AddPostProcessPass", "0x979880", 34],
  ];
  /** reference-only functions (witness carriers, never called): name, rva */
  const GLOW_REFERENCE: [string, string][] = [["Scene_SubmitDraw", "0x989be0"], ["MaskedRendererIso_Submit", "0x78d4c0"], ["StatusMenu_update", "0x81aee0"], ["Camera_SetRenderToTexture", "0x979d50"]];
  /** struct offsets: name, macro, value, the function whose bytes witness it */
  const GLOW_OFFSETS: [string, string, string, string][] = [
    ["TacticsTest_maskCamera", "OFF_TT_MASK_CAMERA", "0x58", "TacticsTest_LateRender"],
    ["TacticsTest_mainCamera", "OFF_TT_MAIN_CAMERA", "0x68", "TacticsTest_LateRender"],
    ["TacticsTest_blurPass", "OFF_TT_BLUR_PASS", "0x90", "TacticsTest_init"],
    ["TacticsTest_compositePass", "OFF_TT_COMPOSITE_PASS", "0x98", "TacticsTest_init"],
    ["Camera_rttTexture", "OFF_CAM_RTT_TEXTURE", "0x50", "Camera_SetRenderToTexture"],
    ["Camera_passes", "OFF_CAM_PASSES", "0xb0", "Camera_AddPostProcessPass"],
    ["Character_renderer", "OFF_CH_RENDERER", "0x40", "StatusMenu_update"],
    ["Character_generation", "OFF_CH_GENERATION", "-0x8", "StatusMenu_update"],
    ["Renderer_extraLayers", "OFF_RND_EXTRA_LAYERS", "0x68", "StatusMenu_update"],
    ["Renderer_extraCount", "OFF_RND_EXTRA_COUNT", "0x6c", "MaskedRendererIso_Submit"],
    ["Renderer_extraData", "OFF_RND_EXTRA_DATA", "0x70", "MaskedRendererIso_Submit"],
    ["Pass_materialCount", "OFF_PASS_MAT_COUNT", "0x4", "Camera_AddPostProcessPass"],
    ["Pass_materials", "OFF_PASS_MATERIALS", "0x8", "Camera_AddPostProcessPass"],
    ["Pass_enabled", "OFF_PASS_ENABLED", "0x10", "Camera_AddPostProcessPass"],
    ["Pass_rectA", "OFF_PASS_RECT_A", "0x18", "Camera_AddPostProcessPass"],
    ["Pass_rectB", "OFF_PASS_RECT_B", "0x38", "Camera_AddPostProcessPass"],
    ["Pass_flags", "OFF_PASS_FLAGS", "0x58", "Camera_AddPostProcessPass"],
  ];
  /** layer / slot constants: name, macro, value */
  const GLOW_CONSTANTS: [string, string, string][] = [["MaskLayer", "CONST_MASK_LAYER", "0x18"], ["CompositeLayer", "CONST_COMPOSITE_LAYER", "0x1a"], ["GlowFramebufSlot", "CONST_GLOW_FRAMEBUF_SLOT", "6"], ["VT_TacticsTest_LateRender", "VT_TT_LATERENDER", "19"]];
  // ---- glow v2 (2026-10-22): per-unit colours scissor one composite pass per unit to the unit's screen rect, computed exactly
  // as TacticsTest::LateRender computes the hovered unit's (0x88e24e..0x88e4a0): clip bounds (slot 16) -> clip matrix
  // (+0x60) -> Renderer_GetScreenMatrix -> inverse(Position_GetViewMatrix(maskCamera+0x38, interp)) x zoom -> 1280x720.
  const GLOW2_SYMBOLS: [string, string, number][] = [["Renderer_GetScreenMatrix", "0x78d600", 40], ["Position_GetViewMatrix", "0x9b4c90", 41]];
  const GLOW2_OFFSETS: [string, string, string, string][] = [
    ["Renderer_clip", "OFF_RND_CLIP", "0x80", "TacticsTest_LateRender"],
    ["MovieClip_matrix", "OFF_CLIP_MATRIX", "0x60", "TacticsTest_LateRender"],
    ["Camera_position", "OFF_CAM_POSITION", "0x38", "TacticsTest_LateRender"],
    ["SceneManager_interp", "OFF_SCENEMANAGER_INTERP", "0x30", "TacticsTest_LateRender"],
    ["Camera_zoom", "OFF_CAM_ZOOM", "0x168", "TacticsTest_LateRender"],
    ["Camera_zoomY", "OFF_CAM_ZOOM_Y", "0x170", "TacticsTest_LateRender"],
  ];
  const GLOW2_CONSTANTS: [string, string, string][] = [["VT_Clip_Bounds", "VT_CLIP_BOUNDS", "16"], ["ClipKind_A", "CONST_CLIP_KIND_A", "1"], ["ClipKind_B", "CONST_CLIP_KIND_B", "2"],
    // the 1280x720 virtual canvas: LateRender multiplies by the .rdata floats 1/1280 (0x14113f47c) and 1/720 (0x14113f488);
    // an rdata witness (rip-relative operand -> float -> reciprocal) reads them back from the exe
    ["GlowCanvasWidth", "CONST_GLOW_CANVAS_W", "1280"], ["GlowCanvasHeight", "CONST_GLOW_CANVAS_H", "720"]];
  const GLOW2_NAMES = new Set([...GLOW2_SYMBOLS.map((x) => x[0]), ...GLOW2_OFFSETS.map((x) => x[0]), ...GLOW2_CONSTANTS.map((x) => x[0])]);
  const GLOW_NAMES = new Set([...GLOW_SYMBOLS.map((x) => x[0]), ...GLOW_REFERENCE.map((x) => x[0]), "ShaderManager_global", "TacticsTest_vftable", ...GLOW_OFFSETS.map((x) => x[0]), ...GLOW_CONSTANTS.map((x) => x[0])]);
  test("glow v3 (the data seam): VT_ApplyStatModifiers is LuckUp vtable slot 82, derived by a slot search for the luck adder's body (add [character+luck], stacks; je Status_Remove), exposed as VT_APPLYSTATMODIFIERS for the FwGlow_ status's no-luck override", () => {
    const m = loadManifest(realPath);
    const e = entry(m, "VT_ApplyStatModifiers");
    assert(!!e && e.kind === "constant" && e.value === "82", "a constant 82");
    eq(e!.anchors.derive?.vtable, "LuckUp_vftable");
    assert((e!.anchors.derive?.slotSearch?.bodyPattern ?? "").startsWith("48 8B 51 ?? 8B 41 ?? 01 82 "), "the slot-search body pattern");
    eq(JSON.stringify(e!.exposure), JSON.stringify([{ macro: "VT_APPLYSTATMODIFIERS" }]));
    const oh = readFileSync(join(REPO_ROOT, "native", "framework", "src", "offsets.h"), "utf8");
    assert(/^#define VT_APPLYSTATMODIFIERS\s+82\s/m.test(oh), "offsets.h exposes it");
  });
  test("the committed manifest carries the per-unit glow bindings (2026-10-22) as one contiguous block after DevMenu_TacticsTest_lambda: 7 FwSymbol functions, 4 reference functions, the ShaderManager global, the TacticsTest vftable (RTTI), 17 witnessed offsets, 4 witnessed/derived constants; the generated headers expose them", () => {
    const m = loadManifest(realPath);
    eq(m.entries.length, 121 + 25 + GLOW_NAMES.size + GLOW2_NAMES.size + 1 + FACING_NAMES.size + WALK_NAMES.size, "121 pre-existing entries + 25 (bindings hardening #82, GON at runtime #85) + the glow block + the glow v2 block + VT_ApplyStatModifiers (glow v3, the data seam) + the facing block + the campaign-walk block");
    for (const [name, rva, index] of GLOW_SYMBOLS) {
      const e = entry(m, name);
      assert(!!e && e.kind === "function" && e.rva === rva && !!e.signature, `${name} is a signed function at ${rva}`);
      eq(JSON.stringify(e!.exposure), JSON.stringify([{ enum: `FW_SYM_${name}`, index }]), `${name} enumerator`);
    }
    for (const [name, rva] of GLOW_REFERENCE) {
      const e = entry(m, name);
      assert(!!e && e.kind === "function" && e.rva === rva && !!e.signature, `${name} is a signed function at ${rva}`);
      eq(e!.exposure.length, 0, `${name} is reference only`);
    }
    const vt = entry(m, "TacticsTest_vftable");
    assert(!!vt && vt.kind === "vtable" && vt.rva === "0xf0f4b8", "TacticsTest_vftable 0xf0f4b8");
    eq(vt!.anchors.rtti?.typeDescriptorName, ".?AVTacticsTest@glaiel@@");
    eq(vt!.slots, 28, "28 consecutive code pointers (slot 28 is the COL, 29 another class's slot 0)");
    eq(JSON.stringify(vt!.exposure), JSON.stringify([{ field: "rva_TacticsTest_vftable" }]));
    const sm = entry(m, "ShaderManager_global");
    assert(!!sm && sm.kind === "data" && sm.rva === "0x13c4a30", "the ShaderManager is the App global itself (material map at +0x278)");
    eq(JSON.stringify(sm!.exposure), JSON.stringify([{ enum: "FW_DATA_ShaderManager", index: 10 }]));
    eq(sm!.anchors.witness?.function, "TacticsTest_init", "witnessed by the material creation sites of TacticsTest::init");
    assert(Number.isInteger(sm!.anchors.witness?.ripRefOrdinal) && sm!.anchors.witness?.needsHarvest === false, "harvested rip-ref ordinal");
    for (const [name, macro, value, fn] of GLOW_OFFSETS) {
      const e = entry(m, name);
      assert(!!e && e.kind === "offset", `${name} is an offset entry`);
      eq(e!.value, value, `${name} value`);
      eq(JSON.stringify(e!.exposure), JSON.stringify([{ macro }]), `${name} macro`);
      const w = e!.anchors.witness;
      assert(!!w && w.function === fn && typeof w.pattern === "string" && Number.isInteger(w.dispAt), `${name}: witness {function ${fn}, pattern, dispAt}: ${JSON.stringify(w)}`);
    }
    for (const [name, macro, value] of GLOW_CONSTANTS) {
      const e = entry(m, name);
      assert(!!e && e.kind === "constant", `${name} is a constant entry`);
      eq(e!.value, value, `${name} value`);
      eq(JSON.stringify(e!.exposure), JSON.stringify([{ macro }]), `${name} macro`);
      assert(hv.constantHasSources(e!.anchors) || !!e!.anchors.derive?.slotSearch, `${name} carries a witness or a slot search the harvest can verify`);
    }
    const names = m.entries.map((e) => e.name);
    const start = names.indexOf("DevMenu_TacticsTest_lambda") + 1;
    // #85 (GON at runtime) appends its own entries after that block too, so the check is: the glow entries are one
    // contiguous block after the pre-existing ones (that is what eases the 3-way merges by entry name)
    const glowIdx = names.map((n, i) => (GLOW_NAMES.has(n) ? i : -1)).filter((i) => i >= 0);
    eq(glowIdx.length, GLOW_NAMES.size, "every glow entry is present");
    assert(glowIdx[0]! >= start, "the glow block comes after DevMenu_TacticsTest_lambda");
    eq(glowIdx[glowIdx.length - 1]! - glowIdx[0]! + 1, GLOW_NAMES.size, "the glow entries are one contiguous block (eases the 3-way merge by entry name)");
    eq(names.slice(start).filter((n) => GLOW_NAMES.has(n)).length, GLOW_NAMES.size, "every glow entry sits after the pre-existing block");
    const oh = genOffsetsH([m]);
    for (const [, macro, value] of [...GLOW_OFFSETS, ...GLOW_CONSTANTS]) assert(new RegExp(`^#define ${macro}\\s+\\(?${value.replace(/[-]/g, "\\-")}\\)?\\s`, "m").test(oh), `${macro} ${value} in offsets.h`);
    const sh = genSignaturesH([m]);
    assert(sh.includes("uint32_t rva_TacticsTest_vftable;") && sh.includes("0x00f0f4b8u"), "BuildInfo.rva_TacticsTest_vftable in signatures.h");
    assert(/0x013c4a30u(?: \},)?,?\s*\/\* FW_DATA_ShaderManager \*\//.test(sh), "rva_data[FW_DATA_ShaderManager] (the last FwData row closes the array)");
    assert(sh.includes('"TacticsTest_LateRender", "') && sh.includes("0x88d780u },  /* FW_SYM_TacticsTest_LateRender */"), "the hook symbol's signature row");
  });
  test("the committed manifest carries the glow v2 bindings (per-unit screen rects) as one contiguous block right after the glow block: 2 FwSymbol functions, 6 offsets and 3 constants witnessed in TacticsTest_LateRender; the generated headers expose them", () => {
    const m = loadManifest(realPath);
    for (const [name, rva, index] of GLOW2_SYMBOLS) {
      const e = entry(m, name);
      assert(!!e && e.kind === "function" && e.rva === rva && !!e.signature, `${name} is a signed function at ${rva}`);
      eq(JSON.stringify(e!.exposure), JSON.stringify([{ enum: `FW_SYM_${name}`, index }]), `${name} enumerator`);
    }
    for (const [name, macro, value, fn] of GLOW2_OFFSETS) {
      const e = entry(m, name);
      assert(!!e && e.kind === "offset", `${name} is an offset entry`);
      eq(e!.value, value, `${name} value`);
      eq(JSON.stringify(e!.exposure), JSON.stringify([{ macro }]), `${name} macro`);
      const w = e!.anchors.witness;
      assert(!!w && w.function === fn && typeof w.pattern === "string" && Number.isInteger(w.dispAt), `${name}: witness {function ${fn}, pattern, dispAt}: ${JSON.stringify(w)}`);
    }
    for (const [name, macro, value] of GLOW2_CONSTANTS) {
      const e = entry(m, name);
      assert(!!e && e.kind === "constant", `${name} is a constant entry`);
      eq(e!.value, value, `${name} value`);
      eq(JSON.stringify(e!.exposure), JSON.stringify([{ macro }]), `${name} macro`);
      assert(hv.constantHasSources(e!.anchors), `${name} carries a witness the harvest can verify`);
    }
    const names = m.entries.map((e) => e.name);
    const idx = names.map((n, i) => (GLOW2_NAMES.has(n) ? i : -1)).filter((i) => i >= 0);
    eq(idx.length, GLOW2_NAMES.size, "every glow v2 entry is present");
    eq(idx[idx.length - 1]! - idx[0]! + 1, GLOW2_NAMES.size, "the glow v2 entries are one contiguous block");
    const lastGlow = Math.max(...names.map((n, i) => (GLOW_NAMES.has(n) ? i : -1)));
    assert(idx[0]! > lastGlow, "the glow v2 block comes after the glow block");
    const oh = genOffsetsH([m]);
    for (const [, macro, value] of [...GLOW2_OFFSETS, ...GLOW2_CONSTANTS]) assert(new RegExp(`^#define ${macro}\\s+${value}\\s`, "m").test(oh), `${macro} ${value} in offsets.h`);
    const sh = genSignaturesH([m]);
    for (const [name, rva] of GLOW2_SYMBOLS) assert(sh.includes(`${rva}u },  /* FW_SYM_${name} */`), `the ${name} signature row`);
  });
  if (exe) {
    test("T1 real exe: the glow v2 block verifies on the installed exe (harvest): every offset and constant witness reads its value in TacticsTest_LateRender", () => {
      const m = loadManifest(realPath);
      const rep = harvestManifest(parsePe(exe), exe, m).report;
      for (const n of [...GLOW2_OFFSETS.map((x) => x[0]), ...GLOW2_CONSTANTS.map((x) => x[0])]) {
        const x = rep.find((r) => r.name === n);
        eq(x?.status, "verified", `${n}: ${x?.detail}`);
      }
    });
  }
  if (exe) {
    test("T1 real exe: the glow block verifies on the installed exe (harvest): the TacticsTest vftable by RTTI, the three constants by their witnesses, the ShaderManager global by its rip ref; every glow offset witness reads its value", () => {
      const m = loadManifest(realPath);
      const rep = harvestManifest(parsePe(exe), exe, m).report;
      for (const n of ["TacticsTest_vftable", "ShaderManager_global", ...GLOW_CONSTANTS.map((x) => x[0]), ...GLOW_OFFSETS.map((x) => x[0])]) {
        const x = rep.find((r) => r.name === n);
        eq(x?.status, "verified", `${n}: ${x?.detail}`);
      }
    });
  }
  if (exe) {
    test("T1 real exe: every offset witness in the committed manifest is verified by the harvest (its pattern reads the manifest value)", () => {
      const m = loadManifest(realPath);
      const p = parsePe(exe);
      const rep = harvestManifest(p, exe, m).report;
      const witnessed = m.entries.filter((e) => e.kind === "offset" && e.anchors.witness && e.anchors.witness.pattern);
      assert(witnessed.length >= WITNESSED_OFFSETS_BATCH1.length, `${witnessed.length} witnessed offsets`);
      const bad = witnessed.map((e) => rep.find((r) => r.name === e.name)!).filter((r) => r.status !== "verified").map((r) => `${r.name}: ${r.status} (${r.detail})`);
      assert(bad.length === 0, bad.join("; "));
    });
    test("T1 real exe: LuckUp type id 0x4d6 is also the imm32 passed to Entity_FindComponentsByTypeId inside Status_ApplyLuckUp (second witness)", () => {
      const m = loadManifest(realPath);
      const p = parsePe(exe);
      const fn = entry(m, "Status_ApplyLuckUp"), callee = entry(m, "Entity_FindComponentsByTypeId")!;
      eq(hv.deriveFromCallArg(p, exe, parseInt(fn!.rva!, 16), parseInt(callee!.rva!, 16), "41 B8 ?? ?? ?? ??", 2, 8), 0x4d6);
      const w = entry(m, "LuckUp_typeid")!.anchors.witness;
      assert(!!(w && w.function === "Status_ApplyLuckUp" && w.callee === "Entity_FindComponentsByTypeId"), "the committed manifest carries the second witness");
      const rep = harvestManifest(p, exe, m).report.find((r) => r.name === "LuckUp_typeid")!;
      eq(rep.status, "verified", rep.detail);
      assert(/call-arg witness/.test(rep.detail), rep.detail);
    });
  }
  const cbaLoaded = await load<typeof import("../../tools/bindings/cross-build-args.ts")>("../../tools/bindings/cross-build-args.ts");
  const cbaErr = "__error" in cbaLoaded ? cbaLoaded.__error : "";
  const cba = "__error" in cbaLoaded ? null : cbaLoaded;
  test("cross-build.ts args: --old/--new required, --build defaults to 999999999, --gameVersion passed through", () => {
    assert(cba !== null, cbaErr);
    const p = cba!.parseCrossBuildArgs(["--old", "a.exe", "--new", "b.exe", "--build", "123", "--gameVersion", "1.1.9"]);
    eq(p.error, null);
    eq(p.oldPath, "a.exe"); eq(p.newPath, "b.exe"); eq(p.build, "123"); eq(p.gameVersion, "1.1.9");
    const d = cba!.parseCrossBuildArgs(["--old", "a.exe", "--new", "b.exe"]);
    eq(d.error, null); eq(d.build, "999999999"); eq(d.gameVersion, undefined);
    assert(/usage/.test(cba!.parseCrossBuildArgs(["--old", "a.exe"]).error || ""), "missing --new -> usage error");
    assert(/usage/.test(cba!.parseCrossBuildArgs(["--old", "a.exe", "--new", "b.exe", "--gameVersion"]).error || ""), "dangling flag -> usage error");
  });
  if (exe) {
    test("T1 real exe: self-port of bindings/25143593.json onto the installed exe -> every anchored entry ported with identical values; nothing ambiguous or failed", () => {
      const m = loadManifest(realPath);
      const p = parsePe(exe);
      const r = portManifest(m, p, exe, { steamBuildId: "25143593", gameVersion: "1.1.21239" });
      const bad: string[] = [];
      for (const rw of r.rows) {
        if (rw.status === "ambiguous" || rw.status === "failed") bad.push(`${rw.name}: ${rw.status} (${rw.detail})`);
        const o = entry(m, rw.name);
        const n = entry(r.manifest, rw.name);
        if (o && n && (o.rva !== n.rva || o.value !== n.value)) bad.push(`${rw.name}: value changed ${o.rva || o.value} -> ${n.rva || n.value}`);
      }
      assert(bad.length === 0, bad.join("; "));
      eq(r.summary["ported-exact"], m.entries.filter((e) => e.kind === "function" && e.signature).length, "every signed function ported-exact");
      assert((r.summary["ported-witness"] || 0) >= 2 && (r.summary["ported-derived"] || 0) >= 11, JSON.stringify(r.summary));
      eq(r.summary["needs-human"] || 0, m.entries.filter((e) => e.anchors.unanchored).length, "exactly the unanchored entries need a human");
      eq(validateManifest(r.manifest).ok, true);
    });
  }
  // ---- seed.ts: REA_GHIDRA_SEED_FILE from a manifest (Windows Ghidra is read-only) -------
  console.log("\n# Bindings: REA seed file (address<TAB>kind<TAB>name)");
  const sd = await load<typeof import("../src/core/bindings/seed.ts")>("../src/core/bindings/seed.ts");
  if ("__error" in sd) {
    test("seed.ts loads", () => assert(false, sd.__error));
    return;
  }
  const { seedFromManifest, parseSeed } = sd;

  test("seedFromManifest: functions as `function`, data/vtables as `label`, absolute addresses, highest first, comments, trailing newline", () => {
    const m = parseManifest(mini());
    const text = seedFromManifest(m);
    assert(text.endsWith("\n"), "trailing newline");
    const lines = text.split("\n").filter(Boolean);
    assert(lines[0].startsWith("# "), "header comment");
    assert(lines.some((l: string) => /^# .*steam 1\b/.test(l) || /steamBuildId 1\b/.test(l)), "names the build");
    const rows = lines.filter((l: string) => !l.startsWith("#"));
    eq(rows.join("|"), ["0x140003000\tlabel\tFoo_vftable", "0x140002000\tlabel\tGlob", "0x140001040\tfunction\tFnB", "0x140001010\tfunction\tFnA"].join("|"));
    assert(!text.includes("Foo_typeid") && !text.includes("Foo_stacks"), "constants and offsets are not addresses");
    const parsed = parseSeed(text);
    eq(parsed.length, 4);
    eq(parsed[3].address, 0x140001010);
    eq(parsed[3].kind, "function");
    eq(parsed[3].name, "FnA");
  });
  test("seedFromManifest on a ported manifest: ambiguous entries become one `function` seed per candidate, named Name__cand_<rva>", () => {
        const m = parseManifest(mini());
    const a = entry(m, "FnA")!;
    a.port = { from: "1", status: "ambiguous", method: "candidates", note: "2 candidates", candidates: [{ rva: "0x1200", bytes: 40, calls: 1, via: "funcsig xref" }, { rva: "0x1300", bytes: 44, calls: 1, via: "funcsig xref" }] };
    const b = entry(m, "FnB")!;
    b.port = { from: "1", status: "ported-rescan", method: "signature", note: "" };
    const text = seedFromManifest(m);
    assert(text.includes("0x140001300\tfunction\tFnA__cand_0x1300") && text.includes("0x140001200\tfunction\tFnA__cand_0x1200"), text);
    assert(!/\tFnA\n/.test(text), "no seed at the stale FnA address");
    assert(text.includes("0x140001040\tfunction\tFnB"), "ported entries keep their names");
    const failed = parseManifest(mini());
    entry(failed, "FnA")!.port = { from: "1", status: "failed", method: "none", note: "no anchor" };
    assert(!seedFromManifest(failed).includes("\tFnA"), "a failed entry has no trustworthy address");
  });
  test("parseSeed: ignores comments and blank lines, rejects a bad line with the line number", () => {
    const p = parseSeed("# c\n\n0x140001000\tfunction\tA\n0x140002000\tcode\n0x140003000\tlabel\tL\n");
    eq(p.map((x: { kind: string; name?: string }) => `${x.kind}:${x.name || ""}`).join(","), "function:A,code:,label:L");
    let err = "";
    try { parseSeed("0x1\tfunction\tA\nnope\n"); } catch (e) { err = String(e); }
    assert(/line 2/.test(err), err);
  });
  if (exe) {
    test("T1: the real manifest seeds every function and vtable/data address (>= 46 functions), e.g. TurnControl_NextTurn and LuckUp_vftable", () => {
      const text = seedFromManifest(loadManifest(realPath));
      const rows = parseSeed(text);
      assert(rows.filter((x: { kind: string }) => x.kind === "function").length >= 46, `functions: ${rows.filter((x: { kind: string }) => x.kind === "function").length}`);
      assert(text.includes("0x1408e3c60\tfunction\tTurnControl_NextTurn"), "NextTurn");
      assert(text.includes("0x140f57ab8\tlabel\tLuckUp_vftable"), "LuckUp vftable");
      assert(text.includes("0x1413c4a30\tlabel\tApp_global"), "App global");
    });
  }
  // ---- api.portBindings + MCP port_bindings ---------------------------------------------
  console.log("\n# Bindings: api.portBindings (dry run / apply under bindings/ only)");
  test("api.portBindings: dry run on a fake exe + manifest file returns rows, summary, needsAgent and the markdown report; writes nothing", () => {
    assert(apiMod !== null && typeof apiMod.portBindings === "function", "api.portBindings exists");
    const tmp = mkdtempSync(join(tmpdir(), "mewport-"));
    try {
      const v2 = link({ fns: [{ name: "FnA", code: bodyA() }, { name: "FnB", code: bodyB() }, { name: "FnC", code: bodyC() }], strings: { A: SIG_A, B: SIG_B }, globs: ["G"], textPad: 0x50, stamp: 0x59595959 });
      writeFileSync(join(tmp, "new.exe"), v2.img.buf);
      writeFileSync(join(tmp, "old.json"), JSON.stringify(old));
      const r = apiMod!.portBindings({ from: join(tmp, "old.json"), exe: join(tmp, "new.exe"), build: "200", version: "2.0.0", dryRun: true });
      assert(r.ok, JSON.stringify(r).slice(0, 300));
      if (!r.ok) return;
      eq(r.dryRun, true);
      eq(r.build, "200");
      eq(r.summary["ported-rescan"], 3);
      assert(Array.isArray(r.rows) && r.rows.length === 6 && Array.isArray(r.needsAgent), "rows + needsAgent");
      assert(typeof r.report === "string" && r.report.startsWith("# Port report 100 -> 200"), "markdown report");
      assert(!r.written, "dry run writes nothing");
      assert(!existsSync(join(BINDINGS_DIR, "200.json")), "no file under bindings/");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
  test("api.portBindings: apply writes bindings/<build>.json + .port-report.md and refuses any other location", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mewport-"));
    const outJson = join(BINDINGS_DIR, "999.json");
    const outMd = join(BINDINGS_DIR, "999.port-report.md");
    try {
      const v2 = link({ fns: [{ name: "FnA", code: bodyA() }, { name: "FnB", code: bodyB() }, { name: "FnC", code: bodyC() }], strings: { A: SIG_A, B: SIG_B }, globs: ["G"], stamp: 0x60606060 });
      writeFileSync(join(tmp, "new.exe"), v2.img.buf);
      writeFileSync(join(tmp, "old.json"), JSON.stringify(old));
      let threw = false;
      try { apiMod!.portBindings({ from: join(tmp, "old.json"), exe: join(tmp, "new.exe"), build: "999", dryRun: false, out: join(tmp, "999.json") }); } catch (e) { threw = e instanceof SafetyError; }
      assert(threw, "out outside bindings/ must throw SafetyError");
      assert(!existsSync(join(tmp, "999.json")), "nothing written outside");
      const r = apiMod!.portBindings({ from: join(tmp, "old.json"), exe: join(tmp, "new.exe"), build: "999", dryRun: false });
      assert(!!(r.ok && r.written && r.written.manifest === outJson && r.written.report === outMd), JSON.stringify((r as { written?: unknown }).written));
      assert(existsSync(outJson) && existsSync(outMd), "files written under bindings/");
      eq(loadManifest(outJson).build.steamBuildId, "999");
      assert(readFileSync(outMd, "utf8").startsWith("# Port report 100 -> 999"), "report content");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(outJson, { force: true });
      rmSync(outMd, { force: true });
    }
  });
  test("api.portBindings: missing exe -> ok:false skipped; bad build id -> ok:false error", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mewport-"));
    try {
      writeFileSync(join(tmp, "old.json"), JSON.stringify(old));
      const r = apiMod!.portBindings({ from: join(tmp, "old.json"), exe: join(tmp, "missing.exe"), build: "200" });
      assert(!r.ok && r.skipped && /missing\.exe/.test(r.reason), JSON.stringify(r));
      const b = apiMod!.portBindings({ from: join(tmp, "old.json"), exe: join(tmp, "old.json"), build: "abc" });
      assert(!b.ok && !b.skipped && /build/.test(b.reason), JSON.stringify(b));
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
  // ---- check.ts identifyExe: identity from the PE header only (fast path for the validator) ---
  console.log("\n# Bindings: identifyExe (header-only, memoized)");
  test("identifyExe: reads only the headers, reports known/unknown + identity; memoized per path+mtime; absent -> null", () => {
    assert(typeof ck.identifyExe === "function", "check.ts exports identifyExe");
    const tmp = mkdtempSync(join(tmpdir(), "mewid-"));
    try {
      writeFileSync(join(tmp, "Mewgenics.exe"), fakeKnownPe.buf);
      const r = ck.identifyExe(join(tmp, "Mewgenics.exe"), [fakeManifest])!;
      assert(!!(r && r.known === true && r.matched && r.matched.steamBuildId === "777"), JSON.stringify(r));
      eq(r.identity.timeDateStamp, "0x11111111");
      const again = ck.identifyExe(join(tmp, "Mewgenics.exe"), [fakeManifest]);
      assert(again === r, "memoized object identity for the same path + mtime");
      const u = ck.identifyExe(join(tmp, "Mewgenics.exe"), []);
      assert(!!(u && u.known === false && u.matched === null), "no manifests -> unknown");
      eq(ck.identifyExe(join(tmp, "nope.exe"), [fakeManifest]), null);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
  // ---- opt-in T1: a real cross-build port (needs two genuine builds) ----------------------
  console.log("\n# Bindings: cross-build port (opt-in: BINDINGS_OLD_EXE / BINDINGS_NEW_EXE)");
  {
    const oldExe = process.env.BINDINGS_OLD_EXE || (exe ? join(locateGameDir(process.env), "Mewgenics.exe") : "");
    const newExe = process.env.BINDINGS_NEW_EXE || "";
    if (!newExe || !existsSync(newExe) || !oldExe || !existsSync(oldExe)) {
      console.log("  (skipped: set BINDINGS_NEW_EXE (and BINDINGS_OLD_EXE unless the installed exe is the old build) to a second genuine Mewgenics.exe; see docs/binding-port.md \"T1 cross-build\")");
    } else {
      test("T1 cross-build: the manifest harvested on the old exe ports onto the new exe with nothing ambiguous or failed among functions, data, vtables and constants", () => {
        const oldBuf = readFileSync(oldExe);
        const newBuf = readFileSync(newExe);
        const oldPe = parsePe(oldBuf);
        const newPe = parsePe(newBuf);
        const m = loadManifest(realPath);
        assert(parseInt(m.build.timeDateStamp, 16) === oldPe.timeDateStamp && parseInt(m.build.sizeOfImage, 16) === oldPe.sizeOfImage, `BINDINGS_OLD_EXE is not build ${m.build.steamBuildId}`);
        assert(newPe.timeDateStamp !== oldPe.timeDateStamp || newPe.sizeOfImage !== oldPe.sizeOfImage, "BINDINGS_NEW_EXE must be a different build");
        const r = portManifest(m, newPe, newBuf, { steamBuildId: process.env.BINDINGS_NEW_BUILD || "999999999" });
        const bad = r.rows.filter((x) => (x.status === "ambiguous" || x.status === "failed") && x.kind !== "offset");
        const proposed = r.rows.filter((x) => x.status === "proposed");
        console.log(`      ${Object.entries(r.summary).map(([k, v]) => `${k} ${v}`).join(", ")}${proposed.length ? `; proposed: ${proposed.map((x) => x.name).join(",")}` : ""}`);
        assert(bad.length === 0, bad.map((x) => `${x.name}: ${x.status} (${(x.detail ?? "").slice(0, 160)})`).join("; "));
        eq(validateManifest(r.manifest).ok, true);
      });
    }
  }
}
