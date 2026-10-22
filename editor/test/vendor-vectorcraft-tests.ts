// VectorCraft vendoring (scripts/vendor-vectorcraft.ts): the pinned release zip is downloaded at build time,
// verified by size + SHA-256 BEFORE anything is extracted, and unpacked with a small zip reader over Node's
// zlib into the git-ignored web/public/vectorcraft/. Owner decision 2026-10-22: a build-time download of the
// pinned asset is allowed; nothing is installed on the machine. These tests never touch the network: the
// download is a stub and the archive is a synthetic zip built here.

import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const EDITOR = join(HERE, "..");

// ---- an independent synthetic zip writer (local headers + central directory + EOCD) -------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
interface ZipSpec { name: string; data?: string; deflate?: boolean; dir?: boolean }
/** Build a zip: stored or deflated entries, directory entries, any name (also unsafe ones, for the refusal tests). */
function makeZip(specs: ZipSpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const s of specs) {
    const name = Buffer.from(s.name, "utf8");
    const raw = Buffer.from(s.dir ? "" : s.data ?? "", "utf8");
    const method = s.deflate && !s.dir ? 8 : 0;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); lfh.writeUInt16LE(20, 4); lfh.writeUInt16LE(0, 6); lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10); lfh.writeUInt16LE(0x21, 12); lfh.writeUInt32LE(crc, 14); lfh.writeUInt32LE(body.length, 18);
    lfh.writeUInt32LE(raw.length, 22); lfh.writeUInt16LE(name.length, 26); lfh.writeUInt16LE(0, 28);
    const local = Buffer.concat([lfh, name, body]);
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); cdh.writeUInt16LE(20, 4); cdh.writeUInt16LE(20, 6); cdh.writeUInt16LE(0, 8); cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(0, 12); cdh.writeUInt16LE(0x21, 14); cdh.writeUInt32LE(crc, 16); cdh.writeUInt32LE(body.length, 20); cdh.writeUInt32LE(raw.length, 24);
    cdh.writeUInt16LE(name.length, 28); cdh.writeUInt16LE(0, 30); cdh.writeUInt16LE(0, 32); cdh.writeUInt16LE(0, 34); cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(s.dir ? 0x10 : 0, 38); cdh.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([cdh, name]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6); eocd.writeUInt16LE(specs.length, 8);
  eocd.writeUInt16LE(specs.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** The release layout in miniature: a top folder, the glue, the wasm, licences, a font with its OFL. */
const release = (v: string): ZipSpec[] => [
  { name: `vectorcraft-web-${v}/`, dir: true },
  { name: `vectorcraft-web-${v}/index.html`, data: "<canvas id=\"vectorcraft_canvas\"></canvas>", deflate: true },
  { name: `vectorcraft-web-${v}/vectorcraft-web-abc.js`, data: "export default function init(){}", deflate: true },
  { name: `vectorcraft-web-${v}/vectorcraft-web-abc_bg.wasm`, data: "\0asm\x01\0\0\0", deflate: true },
  { name: `vectorcraft-web-${v}/LICENSE-MIT`, data: "MIT" },
  { name: `vectorcraft-web-${v}/NOTICE`, data: `Copyright ArtCraft Team (${v})` },
  { name: `vectorcraft-web-${v}/fonts/`, dir: true },
  { name: `vectorcraft-web-${v}/fonts/abc/`, dir: true },
  { name: `vectorcraft-web-${v}/fonts/abc/Noto.ttf`, data: "ttf-bytes", deflate: true },
  { name: `vectorcraft-web-${v}/fonts/abc/OFL.txt`, data: "OFL 1.1" },
];
const RELEASE = release("9.9.9");
const EXPECTED_FILES = ["LICENSE-MIT", "NOTICE", "fonts/abc/Noto.ttf", "fonts/abc/OFL.txt", "index.html", "vectorcraft-web-abc.js", "vectorcraft-web-abc_bg.wasm"];

export async function runVendorVectorcraftTests(test: TestFn, assert: AssertFn, eq: EqFn): Promise<void> {
  console.log("\n# VectorCraft vendoring: zip reader, pinned hash, skip logic, --check (no network)");
  type Mod = typeof import("../scripts/vendor-vectorcraft.ts");
  let m: Mod | null = null;
  let loadErr = "";
  try { m = await import("../scripts/vendor-vectorcraft.ts"); } catch (e) { loadErr = e instanceof Error ? e.message : String(e); }
  test("scripts/vendor-vectorcraft.ts loads and exports the pin, the zip reader, the vendor and check functions", () => {
    assert(!!m, loadErr);
    for (const k of ["VECTORCRAFT_PIN", "listZip", "readZipEntry", "safeZipPath", "extractZip", "verifyPinnedZip", "vendorVectorcraft", "checkVendored", "readVendoredManifest"]) assert(typeof (m as unknown as Record<string, unknown>)[k] !== "undefined", `exports ${k}`);
  });
  if (!m) return;
  const mod = m;

  test("VECTORCRAFT_PIN is the owner-approved v0.14.0 web build: size 27,734,185, SHA-256 6f28a8bc…ba075e, the GitHub Releases URL", () => {
    eq(mod.VECTORCRAFT_PIN.version, "0.14.0");
    eq(mod.VECTORCRAFT_PIN.bytes, 27734185);
    eq(mod.VECTORCRAFT_PIN.sha256, "6f28a8bcee1c5ad6c37c6a0c44058793a40ea4443085866d5f78afb16aba075e");
    eq(mod.VECTORCRAFT_PIN.url, "https://github.com/storytold/vectorcraft/releases/download/v0.14.0/vectorcraft-web-0.14.0.zip");
  });

  const zip = makeZip(RELEASE);
  test("listZip reads the central directory: stored and deflated entries, directories, nested paths, sizes and CRCs", () => {
    const es = mod.listZip(zip);
    eq(es.length, RELEASE.length, "entry count");
    const idx = es.find((e) => e.name === "vectorcraft-web-9.9.9/index.html")!;
    assert(!!idx && idx.method === 8 && idx.size === RELEASE[1]!.data!.length && !idx.isDir, JSON.stringify(idx));
    const lic = es.find((e) => e.name === "vectorcraft-web-9.9.9/LICENSE-MIT")!;
    assert(!!lic && lic.method === 0 && lic.size === 3 && lic.compressedSize === 3, JSON.stringify(lic));
    assert(es.find((e) => e.name === "vectorcraft-web-9.9.9/fonts/")!.isDir, "directory entry flagged");
    eq(lic.crc32, crc32(Buffer.from("MIT")), "crc from the central directory");
  });
  test("readZipEntry inflates a deflated entry and copies a stored one; the CRC is checked", () => {
    const es = mod.listZip(zip);
    eq(Buffer.from(mod.readZipEntry(zip, es.find((e) => e.name.endsWith("/index.html"))!)).toString("utf8"), RELEASE[1]!.data);
    eq(Buffer.from(mod.readZipEntry(zip, es.find((e) => e.name.endsWith("/NOTICE"))!)).toString("utf8"), "Copyright ArtCraft Team (9.9.9)");
    const bad = Buffer.from(zip);
    const lic = es.find((e) => e.name.endsWith("/LICENSE-MIT"))!;
    bad[lic.dataOffset] = "X".charCodeAt(0); // "XIT": stored bytes changed, CRC in the directory unchanged
    let err = "";
    try { mod.readZipEntry(bad, lic); } catch (e) { err = String(e instanceof Error ? e.message : e); }
    assert(/crc/i.test(err), `CRC mismatch is an error: ${err}`);
  });
  test("listZip refuses what is not a zip (no end-of-central-directory record)", () => {
    let err = "";
    try { mod.listZip(Buffer.from("<html>not a zip</html>")); } catch (e) { err = String(e instanceof Error ? e.message : e); }
    assert(/zip/i.test(err), err);
  });
  test("safeZipPath strips the release folder and refuses path escapes: .., absolute, drive letters, backslashes", () => {
    eq(mod.safeZipPath("vectorcraft-web-9.9.9/fonts/abc/OFL.txt", "vectorcraft-web-9.9.9/"), "fonts/abc/OFL.txt");
    eq(mod.safeZipPath("vectorcraft-web-9.9.9/index.html", "vectorcraft-web-9.9.9/"), "index.html");
    eq(mod.safeZipPath("other/index.html", "vectorcraft-web-9.9.9/"), null, "outside the release folder");
    for (const bad of ["vectorcraft-web-9.9.9/../evil", "vectorcraft-web-9.9.9/a/../../evil", "/etc/passwd", "C:/x", "C:\\x", "vectorcraft-web-9.9.9/a\\b", "vectorcraft-web-9.9.9/./x", "vectorcraft-web-9.9.9/"]) eq(mod.safeZipPath(bad, "vectorcraft-web-9.9.9/"), null, `refused: ${bad}`);
  });
  test("extractZip writes every file under dst with the release folder stripped and returns per-file sha256 + bytes", () => {
    const dst = join(mkdtempSync(join(tmpdir(), "vc-x-")), "vectorcraft");
    const r = mod.extractZip(zip, dst, { strip: "vectorcraft-web-9.9.9/" });
    eq(r.files.map((f) => f.path).sort().join(","), EXPECTED_FILES.join(","));
    eq(readFileSync(join(dst, "fonts", "abc", "Noto.ttf"), "utf8"), "ttf-bytes");
    const idx = r.files.find((f) => f.path === "index.html")!;
    eq(idx.sha256, sha(Buffer.from(RELEASE[1]!.data!)));
    eq(idx.bytes, RELEASE[1]!.data!.length);
    rmSync(dirname(dst), { recursive: true, force: true });
  });
  test("extractZip refuses a zip with a path-escape entry before writing anything", () => {
    const evil = makeZip([{ name: "vectorcraft-web-9.9.9/", dir: true }, { name: "vectorcraft-web-9.9.9/ok.txt", data: "ok" }, { name: "vectorcraft-web-9.9.9/../evil.txt", data: "evil" }]);
    const root = mkdtempSync(join(tmpdir(), "vc-evil-"));
    const dst = join(root, "inner", "vectorcraft");
    let err = "";
    try { mod.extractZip(evil, dst, { strip: "vectorcraft-web-9.9.9/" }); } catch (e) { err = String(e instanceof Error ? e.message : e); }
    assert(/evil\.txt/.test(err), `named the entry: ${err}`);
    assert(!existsSync(join(root, "inner", "evil.txt")) && !existsSync(join(dst, "ok.txt")), "nothing written");
    rmSync(root, { recursive: true, force: true });
  });

  const pin = { version: "9.9.9", bytes: zip.length, sha256: sha(zip), url: "https://example.invalid/vectorcraft-web-9.9.9.zip" };
  test("verifyPinnedZip accepts the exact buffer and rejects a wrong size or a tampered byte (same size)", () => {
    eq(mod.verifyPinnedZip(zip, pin).ok, true);
    const short = mod.verifyPinnedZip(zip.subarray(0, zip.length - 1), pin);
    assert(!short.ok && /size|bytes/i.test(short.reason || ""), JSON.stringify(short));
    const tampered = Buffer.from(zip);
    tampered[40] ^= 0x01;
    const t = mod.verifyPinnedZip(tampered, pin);
    assert(!t.ok && /sha-?256/i.test(t.reason || ""), JSON.stringify(t));
  });

  // ---- the vendor flow with a stubbed download ---------------------------------------------------------------
  const root = mkdtempSync(join(tmpdir(), "vc-vendor-"));
  const dst = join(root, "public", "vectorcraft");
  const cacheDir = join(root, "cache");
  const logs: string[] = [];
  let downloads = 0;
  const good = async () => { downloads++; return Buffer.from(zip); };
  const r1 = await mod.vendorVectorcraft({ pin, dst, cacheDir, download: good, log: (s) => logs.push(s) });
  test("vendorVectorcraft downloads the pinned zip, verifies it, extracts it and writes VENDORED.json { version, sha256, date, files }", () => {
    eq(r1.status, "vendored", JSON.stringify(r1));
    eq(downloads, 1);
    const man = JSON.parse(readFileSync(join(dst, "VENDORED.json"), "utf8")) as { version: string; sha256: string; date: string; files: { path: string; bytes: number; sha256: string }[] };
    eq(man.version, "9.9.9");
    eq(man.sha256, pin.sha256);
    assert(/^\d{4}-\d{2}-\d{2}/.test(man.date), `date: ${man.date}`);
    eq(man.files.map((f) => f.path).sort().join(","), EXPECTED_FILES.join(","));
    for (const f of EXPECTED_FILES) assert(existsSync(join(dst, f)), `${f} on disk`);
    assert(readdirSync(dst).includes("LICENSE-MIT") && readdirSync(dst).includes("NOTICE"), "licence texts travel with the runtime");
    assert(existsSync(join(cacheDir, "vectorcraft-web-9.9.9.zip")), "the verified zip is cached for the next build");
  });
  const failing = async () => { downloads++; throw new Error("getaddrinfo ENOTFOUND github.com"); };
  const r2 = await mod.vendorVectorcraft({ pin, dst, cacheDir, download: failing, log: (s) => logs.push(s) });
  test("a second run with a matching VENDORED.json skips without downloading (status already)", () => {
    eq(r2.status, "already", JSON.stringify(r2));
    eq(downloads, 1, "no download attempted");
  });
  const dst2 = join(root, "public2", "vectorcraft");
  const r3 = await mod.vendorVectorcraft({ pin, dst: dst2, cacheDir, download: failing, log: (s) => logs.push(s) });
  test("a fresh destination is served from the cached zip when it still matches the pin (no download)", () => {
    eq(r3.status, "vendored", JSON.stringify(r3));
    eq(r3.source, "cache");
    eq(downloads, 1);
    assert(existsSync(join(dst2, "index.html")), "extracted from the cache");
  });
  const dst3 = join(root, "public3", "vectorcraft");
  const r4 = await mod.vendorVectorcraft({ pin, dst: dst3, cacheDir: join(root, "nocache"), download: failing, log: (s) => logs.push(s) });
  test("offline with no cache: status skipped with the reason, no throw, nothing written (npm run build goes on)", () => {
    eq(r4.status, "skipped", JSON.stringify(r4));
    assert(/ENOTFOUND/.test(r4.reason || ""), r4.reason || "");
    assert(!existsSync(join(dst3, "VENDORED.json")), "no manifest");
    assert(logs.some((l) => /\(skipped: VectorCraft not vendored/.test(l)), logs.join(" / "));
  });
  const tamperedZip = Buffer.from(zip);
  tamperedZip[40] ^= 0x01;
  const dst4 = join(root, "public4", "vectorcraft");
  const r5 = await mod.vendorVectorcraft({ pin, dst: dst4, cacheDir: join(root, "nocache2"), download: async () => tamperedZip, log: (s) => logs.push(s) });
  test("a download whose hash does not match the pin is refused before extraction: skipped, nothing on disk, not cached", () => {
    eq(r5.status, "skipped", JSON.stringify(r5));
    assert(/sha-?256/i.test(r5.reason || ""), r5.reason || "");
    assert(!existsSync(dst4) || readdirSync(dst4).length === 0, "nothing extracted");
    assert(!existsSync(join(root, "nocache2", "vectorcraft-web-9.9.9.zip")), "a bad zip is never cached");
  });
  const zip2 = makeZip(release("9.9.10"));
  const pin2 = { version: "9.9.10", bytes: zip2.length, sha256: sha(zip2), url: "https://example.invalid/vectorcraft-web-9.9.10.zip" };
  const r6 = await mod.vendorVectorcraft({ pin: pin2, dst, cacheDir, download: async () => Buffer.from(zip2), log: (s) => logs.push(s) });
  test("a different pin replaces the vendored copy (stale files of the previous version are removed)", () => {
    eq(r6.status, "vendored", JSON.stringify(r6));
    eq(mod.readVendoredManifest(dst)?.version, "9.9.10");
    eq(readFileSync(join(dst, "NOTICE"), "utf8"), "Copyright ArtCraft Team (9.9.10)", "the new build's files");
  });
  test("checkVendored (--check) re-hashes the extracted files: ok after vendoring, names a tampered or missing file", () => {
    const ok = mod.checkVendored(dst);
    assert(ok.ok && ok.mismatched.length === 0 && ok.missing.length === 0, JSON.stringify(ok));
    writeFileSync(join(dst, "index.html"), "<p>tampered</p>");
    rmSync(join(dst, "NOTICE"));
    const bad = mod.checkVendored(dst);
    assert(!bad.ok, "not ok");
    eq(bad.mismatched.join(","), "index.html");
    eq(bad.missing.join(","), "NOTICE");
    const none = mod.checkVendored(join(root, "never"));
    assert(!none.ok && /not vendored/i.test(none.reason || ""), JSON.stringify(none));
  });
  rmSync(root, { recursive: true, force: true });

  test("npm run build / dev / test:e2e vendor VectorCraft after Ruffle; web/public/vectorcraft/ is git-ignored; the server serves .ttf as font/ttf and .wasm as application/wasm", () => {
    const scripts = (JSON.parse(readFileSync(join(EDITOR, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    for (const k of ["build", "dev", "test:e2e"]) assert(/vendor-ruffle\.ts && node scripts\/vendor-vectorcraft\.ts && /.test(scripts[k] || ""), `${k}: ${scripts[k]}`);
    assert(/^node scripts\/vendor-vectorcraft\.ts$/.test(scripts["vendor:vectorcraft"] || ""), `vendor:vectorcraft: ${scripts["vendor:vectorcraft"]}`);
    const ignore = readFileSync(join(EDITOR, "..", ".gitignore"), "utf8");
    assert(/^editor\/web\/public\/vectorcraft\/?$/m.test(ignore), "gitignore line");
    const server = readFileSync(join(EDITOR, "web", "server.ts"), "utf8");
    assert(/"\.ttf":\s*"font\/ttf"/.test(server), "MIME .ttf");
    assert(/"\.wasm":\s*"application\/wasm"/.test(server), "MIME .wasm");
  });
}
