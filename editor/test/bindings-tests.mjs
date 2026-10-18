// Tests for the bindings library (editor/src/core/bindings/*): the PE reader,
// the signature scanner/generator, the manifest, harvest and port steps.
// T0 tests run on a synthetic PE built by test/fixtures/bindings/fake-pe.mjs
// (no game bytes); T1 tests read the installed Mewgenics.exe in place and
// skip when it is absent. Wired into run-tests.mjs.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { locateGameDir } from "../src/core/ingame/launch.mjs";
import { REPO_ROOT } from "../src/core/repo.mjs";

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
      assert(code.length >= 34, `expected >= 34 code rows, got ${code.length}`);
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
}
