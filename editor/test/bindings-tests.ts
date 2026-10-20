// Tests for the bindings library (editor/src/core/bindings/*): the PE reader,
// the signature scanner/generator, the manifest, harvest and port steps.
// T0 tests run on a synthetic PE built by test/fixtures/bindings/fake-pe.ts
// (no game bytes); T1 tests read the installed Mewgenics.exe in place and
// skip when it is absent. Wired into run-tests.ts.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { locateGameDir } from "../src/core/ingame/launch.ts";
import { REPO_ROOT, SafetyError } from "../src/core/repo.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
type CodeItem = number | { call: string } | { lea: string } | { mov: string };
interface LinkSpec {
  textPad?: number;
  rdataPad?: number;
  stamp?: number;
  fns: { name: string; code: CodeItem[] }[];
  strings?: Record<string, string>;
  globs?: string[];
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
  test("25143593.json: FwSymbol table == framework_api.h FW_SYM_* order (22, incl. the v4 run-entry symbols), each with a signature", () => {
    const m = loadManifest(realPath);
    const want = enumerators("FW_SYM_");
    eq(want.length, 27);
    eq(entry(m, "AddComponent_MewDirector_test")!.rva, "0x758650");
    eq(entry(m, "Entity_DestroyOwnerOf")!.rva, "0x94eba0");
    eq(entry(m, "AddComponent_MewDirector_named")!.rva, "0x1be1a0");
    eq(entry(m, "MewDirector_start")!.rva, "0x3aefd0");
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
    for (const e of got) assert(!!(e.signature && e.signature.pattern), `${e.name} needs a signature`);
    eq(entry(m, "TurnControl_NextTurn")!.rva, "0x8e3c60");
    eq(entry(m, "Status_GetCategory")!.signature!.exactLen, 126);
  });
  test("25143593.json: FwData table == framework_api.h FW_DATA_* order (10, incl. the MewDirector global); App_global first", () => {
    const m = loadManifest(realPath);
    const want = enumerators("FW_DATA_");
    eq(want.length, 10);
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
    const lc = entry(m25, "LuckUp_ctor")!;
    assert(h.includes(`"LuckUp_ctor", "${lc.signature!.pattern}", ${lc.signature!.offset}, 0x711c90u`) && lc.signature!.offset < 0, "negative SymbolSig.offset carried through");
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
  if (exe) {
    test("T1 real exe: every manifest function signature regenerates unique at its rva; >= 5 carry wildcards; Status_GetCategory fits the cap or is reported", () => {
      const m = loadManifest(realPath);
      const p = parsePe(exe);
      const bad: string[] = [];
      let wild = 0;
      let n = 0;
      let cat = "";
      for (const e of m.entries) {
        if (e.kind !== "function" || !e.signature) continue;
        n++;
        const rva = parseInt(e.rva!, 16);
        const r = makeSignature(p, exe, rva, { minLen: 12, cap: m.sigCap });
        if (!r.ok) { if (e.name === "Status_GetCategory") cat = r.reason; else bad.push(`${e.name}: ${r.reason}`); continue; }
        if (r.signature!.wildcards.length) wild++;
        const hit = scanExec(p, exe, parsePattern(r.signature!.pattern, m.sigCap));
        if (hit.count !== 1 || hit.hits[0] + r.signature!.offset !== rva) bad.push(`${e.name}: ${hit.count} hits`);
        if (r.signature!.pattern.endsWith("??")) bad.push(`${e.name}: ends in a wildcard`);
        if (e.name === "Status_GetCategory") cat = `ok ${r.signature!.exactLen} bytes, offset ${r.signature!.offset}`;
      }
      assert(bad.length === 0, bad.join("; "));
      assert(n >= 34, `functions with signatures: ${n}`);
      assert(wild >= 5, `only ${wild} of ${n} signatures needed wildcards (6 on build 25143593)`);
      console.log(`      Status_GetCategory: ${cat}; ${wild}/${n} signatures carry wildcards`);
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

    /** Mini linker for fake builds. Items in `code` are bytes or placeholders resolved after layout: { call: "Fn" } -> E8 rel32, { lea: "str:NAME" } -> 48 8D 0D disp32, { mov: "glob:NAME" } -> 48 8B 05 disp32 */
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
        else { const next = at + 7; bytes = [0x48, 0x8b, 0x05, ...le32(globAt[it.mov.slice(5)]! - next)]; }
        textBytes.set(bytes, at - TEXT);
        at += bytes.length;
      }
      pdata.push({ section: ".text", begin: begin - TEXT, end: at - TEXT });
    }
    const rdataBytes = Buffer.alloc(0x400);
    for (const [k, v] of Object.entries(spec.strings || {})) rdataBytes.write(v + "\0", strAt[k]! - RDATA, "latin1");
    const dataBytes = Buffer.alloc(0x100);
    const img = buildFakePe({ timeDateStamp: spec.stamp ?? 0x51515151, sections: [{ name: ".text", bytes: textBytes, exec: true }, { name: ".rdata", bytes: rdataBytes }, { name: ".data", bytes: dataBytes, write: true }], pdata });
    return { img, pe: parsePe(img.buf), fnAt, strAt, globAt };
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
    "Status_temporary", "Status_applier", "Status_applierOwner", "ApplyCtx_character", "ApplyCtx_entity", "ApplyP6_applier",
    "Applier_owner", "Character_touchedPassives",
  ];
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
    eq(m.entries.filter((e) => e.anchors.unanchored).map((e) => e.name).sort().join(","), ["LuckUp_vtableSlots", "VT_GetTypeHierarchy", "VT_GetTypeId", "VT_GetTypeName", "VT_IsA", "VT_OnStacksChanged"].sort().join(","), "only the six constants remain");
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
      eq(r.summary["needs-human"], m.entries.filter((e) => e.anchors.unanchored).length, "exactly the unanchored entries need a human");
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
