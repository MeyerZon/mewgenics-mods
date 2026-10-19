// T0 for tools/gpak.py: a synthetic archive in the documented format (docs/engine-map.md "gpak contents":
// u32 count; count x { u16 len; path; u32 size }; bodies in index order) is written to a temp dir and the real
// script is driven with `python -I` (isolated mode: no cwd/site imports). Never touches resources.gpak.
// Skips when no Python 3 is on PATH.
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { REPO_ROOT } from "../src/core/repo.ts";

const GPAK_PY = join(REPO_ROOT, "tools", "gpak.py");

/**
 * @param {{ path: string, body: Buffer }[]} entries
 * @returns {{ buf: Buffer, offsets: number[], indexSize: number }}
 */
function buildGpak(entries) {
  /** @type {Buffer[]} */
  const parts = [];
  const head = Buffer.alloc(4);
  head.writeUInt32LE(entries.length, 0);
  parts.push(head);
  let indexSize = 4;
  for (const e of entries) {
    const p = Buffer.from(e.path, "utf8");
    const rec = Buffer.alloc(2 + p.length + 4);
    rec.writeUInt16LE(p.length, 0);
    p.copy(rec, 2);
    rec.writeUInt32LE(e.body.length, 2 + p.length);
    parts.push(rec);
    indexSize += rec.length;
  }
  for (const e of entries) parts.push(e.body);
  /** @type {number[]} */
  const offsets = [];
  let off = indexSize;
  for (const e of entries) { offsets.push(off); off += e.body.length; }
  return { buf: Buffer.concat(parts), offsets, indexSize };
}

/** @returns {string[]|null} the interpreter argv prefix, or null when no Python 3 answers */
function findPython() {
  /** @type {string[][]} */
  const probes = [["python"], ["python3"], ["py", "-3"]];
  for (const p of probes) {
    const r = spawnSync(p[0], [...p.slice(1), "-I", "-c", "import sys; print(sys.version_info[0])"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "3") return p;
  }
  return null;
}

/**
 * @param {string[]} py @param {string} gpak @param {string[]} args
 * @returns {{ status: number|null, stdout: Buffer, stderr: string }}
 */
function gpak(py, gpak, args) {
  const r = spawnSync(py[0], [...py.slice(1), "-I", GPAK_PY, "--gpak", gpak, ...args], { encoding: "buffer", timeout: 60000 });
  return { status: r.status, stdout: r.stdout || Buffer.alloc(0), stderr: (r.stderr || Buffer.alloc(0)).toString("utf8") };
}

/**
 * @param {(name: string, fn: () => void) => void} test
 * @param {(cond: boolean, msg: string) => void} assert
 * @param {(a: unknown, b: unknown, msg?: string) => void} eq
 */
export async function runGpakTests(test, assert, eq) {
  console.log("\n# tools/gpak.py (synthetic archive, read-only; python -I)");
  const py = findPython();
  if (!py) {
    console.log("  (skipped: no Python 3 on PATH; tools/gpak.py tests need one)");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "mewged-gpak-"));
  const allBytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const entries = [
    { path: "data/abilities/a.gon", body: Buffer.from("A { x 1 }\n", "utf8") },
    { path: "data/text/combined.csv", body: Buffer.from("k,v\r\n", "utf8") },
    { path: "swfs/icons.swf", body: allBytes },
  ];
  const g = buildGpak(entries);
  const fixture = join(dir, "fixture.gpak");
  writeFileSync(fixture, g.buf);

  test("gpak.py list prints offset<TAB>size<TAB>path per entry; offsets = index size + preceding bodies", () => {
    const r = gpak(py, fixture, ["list"]);
    eq(r.status, 0, r.stderr);
    const lines = r.stdout.toString("utf8").trim().split(/\r?\n/);
    eq(lines.length, 3);
    entries.forEach((e, i) => eq(lines[i], `${g.offsets[i]}\t${e.body.length}\t${e.path}`, e.path));
    eq(g.offsets[0], g.indexSize, "first body starts right after the index");
  });
  test("gpak.py list --prefix/--ext filter by path prefix and extension", () => {
    const r = gpak(py, fixture, ["list", "--prefix", "data/", "--ext", ".gon"]);
    eq(r.status, 0, r.stderr);
    eq(r.stdout.toString("utf8").trim(), `${g.offsets[0]}\t${entries[0].body.length}\tdata/abilities/a.gon`);
  });
  test("gpak.py cat writes the exact bytes (binary-safe: all 256 byte values)", () => {
    const r = gpak(py, fixture, ["cat", "swfs/icons.swf"]);
    eq(r.status, 0, r.stderr);
    assert(r.stdout.toString("hex") === allBytes.toString("hex"), `got ${r.stdout.length} bytes: ${r.stdout.toString("hex").slice(0, 40)}…`);
  });
  test("gpak.py cat of an unknown path exits 1 with 'not found:' on stderr and nothing on stdout", () => {
    const r = gpak(py, fixture, ["cat", "nope.gon"]);
    eq(r.status, 1);
    assert(/not found: nope\.gon/.test(r.stderr), r.stderr);
    eq(r.stdout.length, 0);
  });
  test("gpak.py extract --prefix lands only matching entries under out_dir, byte-exact, and prints the summary line", () => {
    const out = join(dir, "out");
    const r = gpak(py, fixture, ["extract", out, "--prefix", "data/"]);
    eq(r.status, 0, r.stderr);
    eq(r.stdout.toString("utf8").trim(), `extracted 2 entries, ${entries[0].body.length + entries[1].body.length} bytes, to ${out}`);
    eq(readFileSync(join(out, "data", "abilities", "a.gon"), "utf8"), "A { x 1 }\n");
    eq(readFileSync(join(out, "data", "text", "combined.csv"), "utf8"), "k,v\r\n");
    assert(!existsSync(join(out, "swfs")), "non-matching entry must not be extracted");
  });
  test("gpak.py stats counts entries, top dirs and extensions", () => {
    const r = gpak(py, fixture, ["stats"]);
    eq(r.status, 0, r.stderr);
    const s = r.stdout.toString("utf8");
    assert(/^entries: 3/m.test(s), s);
    assert(/'data': 2/.test(s) && /'swfs': 1/.test(s), s);
    assert(/'\.gon': 1/.test(s) && /'\.csv': 1/.test(s) && /'\.swf': 1/.test(s), s);
  });
  test("gpak.py refuses an archive whose index + bodies != file size (exit 2, offsets not trusted, nothing listed)", () => {
    const bad = join(dir, "truncated.gpak");
    writeFileSync(bad, g.buf.subarray(0, g.buf.length - 1));
    const r = gpak(py, bad, ["list"]);
    eq(r.status, 2);
    assert(/format assumption violated/.test(r.stderr), r.stderr);
    eq(r.stdout.length, 0);
  });
  test("gpak.py extract refuses entry paths that escape out_dir ('..' segment, absolute, drive letter, backslash climb on Windows) and writes nothing outside", () => {
    const evils = ["../evil.txt", "/abs.txt", "C:/x.txt", "data/../../evil2.txt"];
    if (process.platform === "win32") evils.push("..\\..\\evil3.txt");
    for (const evil of evils) {
      const e = buildGpak([{ path: evil, body: Buffer.from("x") }]);
      const p = join(dir, "evil.gpak");
      writeFileSync(p, e.buf);
      const out = join(dir, "evil-out");
      const r = gpak(py, p, ["extract", out]);
      assert(r.status !== 0, `${evil}: expected a non-zero exit, got ${r.status}`);
      assert(/unsafe entry path|escapes output root/.test(r.stderr), `${evil}: ${r.stderr.slice(-240)}`);
    }
    for (const f of ["evil.txt", "abs.txt", "x.txt", "evil2.txt", "evil3.txt"]) {
      assert(!existsSync(join(dir, f)) && !existsSync(join(dir, "..", f)), `${f} must not exist outside out_dir`);
    }
  });
}
