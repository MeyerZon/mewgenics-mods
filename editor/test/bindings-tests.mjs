// Tests for the bindings library (editor/src/core/bindings/*): the PE reader,
// the signature scanner/generator, the manifest, harvest and port steps.
// T0 tests run on a synthetic PE built by test/fixtures/bindings/fake-pe.mjs
// (no game bytes); T1 tests read the installed Mewgenics.exe in place and
// skip when it is absent. Wired into run-tests.mjs.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { locateGameDir } from "../src/core/ingame/launch.mjs";
import { REPO_ROOT, SafetyError } from "../src/core/repo.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

/** Known build 25143593 identity (docs/engine-map.md). */
const KNOWN_TS = 0x6a9c51e5;
const KNOWN_SIZE = 0x1574000;

/**
 * Import a module, or return an object with __error so the suite can
 * register one failing test instead of crashing the run (readable red).
 * @param {string} rel
 */
async function load(rel) {
  try {
    return await import(rel);
  } catch (e) {
    return { __error: String(e instanceof Error ? e.message : e) };
  }
}

/** @returns {Buffer|null} the installed exe, or null when absent */
function realExe() {
  const p = join(locateGameDir(process.env), "Mewgenics.exe");
  return existsSync(p) ? readFileSync(p) : null;
}

/**
 * @param {(name: string, fn: () => void) => void} test
 * @param {(cond: boolean, msg: string) => void} assert
 * @param {(a: unknown, b: unknown, msg?: string) => void} eq
 */
export async function runBindingsTests(test, assert, eq) {
  console.log("\n# Bindings: PE reader (fake PE + real exe)");
  const fake = await load("./fixtures/bindings/fake-pe.mjs");
  const pe = await load("../src/core/bindings/pe.mjs");
  if (fake.__error) test("fake-pe.mjs loads", () => assert(false, fake.__error));
  if (pe.__error) test("pe.mjs loads", () => assert(false, pe.__error));
  if (fake.__error || pe.__error) return;
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
    eq(p.sections.map((/** @type {any} */ s) => s.name).join(","), ".text,.rdata,.pdata");
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
    eq(p.sectionOf(rva).name, ".rdata");
    eq(p.sectionOf(0x7fff0000), null);
  });

  test("fake PE: pdata.find returns the containing RUNTIME_FUNCTION; gaps -> null", () => {
    const f = buildFakePe(spec);
    const p = parsePe(f.buf);
    eq(p.pdata.count, 2);
    const a = p.pdata.find(f.rva(".text", 0x12));
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
      eq(p.execSections.map((/** @type {any} */ s) => s.name).join(","), ".text");
      assert(p.pdata.count > 50000, `pdata count ${p.pdata.count}`);
      const f = p.pdata.find(0x8e3c60); // TurnControl::NextTurn
      assert(f !== null && f.begin === 0x8e3c60, `NextTurn should start a RUNTIME_FUNCTION, got ${JSON.stringify(f)}`);
      eq(p.rvaToOff(0x1000), 0x400, ".text raw offset");
    });
  }

  // ---- scan.mjs: the DLL's scanner semantics (fw_sig.c) in node ----------------
  console.log("\n# Bindings: signature scanner (parity with native/framework/test/test_sig.c)");
  const scan = await load("../src/core/bindings/scan.mjs");
  if (scan.__error) {
    test("scan.mjs loads", () => assert(false, scan.__error));
    return;
  }
  const { parsePattern, scanBuffer, scanExec, scanSection, patternToString, PatternError, FW_SIG_MAX_BYTES } = scan;
  /** @param {() => void} fn */
  const throwsPattern = (fn) => {
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

  if (!exe) {
    console.log("  (skipped: Mewgenics.exe not found; TSV regression test needs the game)");
  } else {
    const tsv = readFileSync(join(REPO_ROOT, "bindings", "25143593.sig.tsv"), "utf8");
    const rows = tsv.split(/\r?\n/).filter(Boolean).map((line) => {
      const [name, rva, len, rest] = line.split("\t");
      return { name, rva: parseInt(rva, 16), len, rest: rest || "" };
    });
    const code = rows.filter((r) => /^\d+$/.test(r.len));
    const p = parsePe(exe);
    test(`T1 real exe: each of the ${code.length} TSV code signatures matches exactly once, at its RVA (TODO #4)`, () => {
      assert(code.length >= 33, `expected >= 33 code rows, got ${code.length}`);
      /** @type {string[]} */
      const bad = [];
      for (const r of code) {
        const pat = parsePattern(r.rest);
        eq(pat.length, Number(r.len), `${r.name}: hex length matches the len column`);
        const res = scanExec(p, exe, pat);
        if (res.count !== 1 || res.hits[0] !== r.rva) bad.push(`${r.name}: ${res.count} matches, first 0x${(res.hits[0] ?? -1).toString(16)} (want 0x${r.rva.toString(16)})`);
      }
      assert(bad.length === 0, bad.join("; "));
    });
    test("T1 real exe: the NOT-UNIQUE row's 64-byte prefix indeed matches more than once", () => {
      const r = rows.find((x) => x.len.startsWith("NOT-UNIQUE"));
      assert(r !== undefined, "row present");
      if (!r) return;
      eq(scanExec(p, exe, parsePattern(r.rest)).count, 2);
    });
  }
  // ---- manifest.mjs: bindings/<build>.json, the single source of truth ------------
  console.log("\n# Bindings: manifest (bindings/<steamBuildId>.json)");
  const man = await load("../src/core/bindings/manifest.mjs");
  if (man.__error) {
    test("manifest.mjs loads", () => assert(false, man.__error));
    return;
  }
  const { parseManifest, validateManifest, loadManifest, saveManifest, symbolTable, dataTable, lkTable, entry, BINDINGS_DIR, ManifestError } = man;

  /** @param {any} overrides @returns {any} a minimal valid manifest object */
  const mini = (overrides = {}) => ({
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
  /** @param {any} m @returns {string[]} */
  const problems = (m) => validateManifest(m).problems;
  /** @param {any} m @param {RegExp} re @param {string} what */
  const rejects = (m, re, what) => {
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
    const w = mini(); w.entries[5].anchors.witness.function = "Nope";
    rejects(w, /Foo_stacks.*Nope/, "unknown witness");
    const c = mini(); c.entries[1].anchors = { callees: [{ name: "Ghost", ordinal: 0 }] };
    rejects(c, /FnB.*Ghost/, "unknown callee");
    const dv = mini(); dv.entries[4].anchors.derive.vtable = "Nope_vftable";
    rejects(dv, /Foo_typeid.*Nope_vftable/, "unknown vtable");
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
    eq(symbolTable(m).map((/** @type {any} */ e) => e.name).join(","), "FnA");
    eq(dataTable(m).map((/** @type {any} */ e) => e.name).join(","), "Glob");
    eq(lkTable(m).map((/** @type {any} */ e) => e.name).join(","), "FnB");
    eq(entry(m, "Foo_typeid").kind, "constant");
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
  /** @param {string} prefix */
  const enumerators = (prefix) => (apiH.match(new RegExp(`^\\s*(${prefix}[A-Za-z0-9_]+)\\s*,`, "gm")) || []).map((l) => l.trim().replace(/,$/, "")).filter((n) => !n.endsWith("_COUNT_"));
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
  test("25143593.json: FwSymbol table == framework_api.h FW_SYM_* order (15), each with a signature", () => {
    const m = loadManifest(realPath);
    const want = enumerators("FW_SYM_");
    eq(want.length, 15);
    const got = symbolTable(m);
    eq(got.map((/** @type {any} */ e) => e.exposure.find((/** @type {any} */ x) => x.enum).enum).join("\n"), want.join("\n"));
    for (const e of got) assert(e.signature && e.signature.pattern, `${e.name} needs a signature`);
    eq(entry(m, "TurnControl_NextTurn").rva, "0x8e3c60");
    eq(entry(m, "Status_GetCategory").signature.exactLen, 126);
  });
  test("25143593.json: FwData table == framework_api.h FW_DATA_* order (9); App_global first", () => {
    const m = loadManifest(realPath);
    const want = enumerators("FW_DATA_");
    eq(want.length, 9);
    const got = dataTable(m);
    eq(got.map((/** @type {any} */ e) => e.exposure.find((/** @type {any} */ x) => x.enum).enum).join("\n"), want.join("\n"));
    eq(got[0].name, "App_global");
    eq(got[0].rva, "0x13c4a30");
    eq(entry(m, "SDL_HideWindow_slot").rva, "0x12e82a0");
    const t = entry(m, "SDL_DYNAPI_table");
    assert(t && t.rva === "0x12e7078", "the DYNAPI jump table is its own entry");
    for (const e of got.slice(1)) assert(e.anchors.derive && e.anchors.derive.table === "SDL_DYNAPI_table", `${e.name} derives from the table`);
  });
  test("25143593.json: FW_LK table is the 13 status lookups in status_engine.c g_lk_rva order, shapes A-E", () => {
    const m = loadManifest(realPath);
    const lk = lkTable(m);
    const rvas = ["0x4929c0", "0x492c20", "0x492e80", "0x492f20", "0x493190", "0x5028e0", "0x493690", "0x493910", "0x493b80", "0x493e00", "0x4933e0", "0x494080", "0x502b40"];
    eq(lk.map((/** @type {any} */ e) => e.rva).join(","), rvas.join(","));
    eq(lk.map((/** @type {any} */ e) => e.exposure.find((/** @type {any} */ x) => x.table).shape).join(""), "AAAAAABBBBCDE");
    eq(lk[0].name, "Status_GetCategory", "index 0 is also FW_SYM_Status_GetCategory");
    eq(lk[4].name, "Status_GetFlags");
    assert(lk.filter((/** @type {any} */ e) => e.anchors.strings && e.anchors.strings.some((/** @type {any} */ s) => s.role === "funcsig")).length >= 11, "funcsig anchors recorded for the lookups that have one");
  });
  test("25143593.json: vtables, type id, vtable slot constants and >= 30 struct offsets with macros", () => {
    const m = loadManifest(realPath);
    eq(entry(m, "LuckUp_vftable").rva, "0xf57ab8");
    eq(entry(m, "LuckUp_vftable").anchors.rtti.typeDescriptorName, ".?AVLuckUp@glaiel@@");
    eq(entry(m, "Status_vftable").rva, "0xed1960");
    eq(entry(m, "LuckUp_typeid").value, "0x4d6");
    eq(entry(m, "DefaultStatusSource").rva, "0x13c4d30");
    eq(entry(m, "LuckUp_vtableSlots").value, "172");
    eq(entry(m, "VT_OnStacksChanged").value, "170");
    const offs = m.entries.filter((/** @type {any} */ e) => e.kind === "offset");
    assert(offs.length >= 30, `offsets: ${offs.length}`);
    eq(entry(m, "Status_stacks").value, "0x5c");
    eq(entry(m, "Status_stacks").exposure[0].macro, "OFF_STATUS_STACKS");
    eq(entry(m, "X_charArray").value, "0x1f90");
    eq(entry(m, "Character_touchedPassives").value, "0xe50");
    for (const e of offs) assert(e.struct && e.exposure.some((/** @type {any} */ x) => x.macro), `${e.name} has struct + macro`);
  });
  if (exe) {
    const m = loadManifest(realPath);
    const p = parsePe(exe);
    test("T1 real exe: every manifest function signature matches exactly once at its rva", () => {
      /** @type {string[]} */
      const bad = [];
      for (const e of m.entries) {
        if (e.kind !== "function" || !e.signature) continue;
        const r = scanExec(p, exe, parsePattern(e.signature.pattern, m.sigCap));
        if (r.count !== 1 || r.hits[0] !== parseInt(e.rva, 16)) bad.push(`${e.name}: ${r.count} hits, first 0x${(r.hits[0] ?? -1).toString(16)}`);
      }
      assert(bad.length === 0, bad.join("; "));
      assert(m.entries.filter((/** @type {any} */ e) => e.kind === "function" && e.signature).length >= 34, "all TSV code rows carried over (incl. Status_ApplyLuckUp, now unique at 76 bytes)");
    });
    test("T1 real exe: every function entry (signed or raw) begins a .pdata RUNTIME_FUNCTION; vtables have file bytes; data globals sit inside a section", () => {
      /** @type {string[]} */
      const bad = [];
      for (const e of m.entries) {
        if (e.kind === "function") {
          const rva = parseInt(e.rva, 16);
          const f = p.pdata.find(rva);
          if (!f || f.begin !== rva) bad.push(`${e.name} 0x${rva.toString(16)} is not a function start (${f ? "inside 0x" + f.begin.toString(16) : "no pdata"})`);
        } else if (e.kind === "vtable") {
          if (p.rvaToOff(parseInt(e.rva, 16)) < 0) bad.push(`${e.name} has no file byte`);
        } else if (e.kind === "data") {
          // globals may live in .data's zero-filled tail (no file byte), but must be inside a section
          if (!p.sectionOf(parseInt(e.rva, 16))) bad.push(`${e.name} is outside every section`);
        }
      }
      assert(bad.length === 0, bad.join("; "));
    });
  }
}
