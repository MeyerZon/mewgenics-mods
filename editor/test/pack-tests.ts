// Shipping a mod (docs/data-mods.md "Shipping a mod"): the zip writer + reader (src/core/zip.ts), the mod manifest
// mods/<name>/mod.json (src/core/mod-manifest.ts), `pack` (mod folder -> editor/data/dist/<name>-<version>.zip) and
// `install` (zip -> mods/<name>/, refusing traversal, oversize, missing manifest, tampering, a build mismatch unless
// accepted). T0: every mod, zip and output dir is a temp dir; the validator, the SWF builder and the installed build
// are injected, so nothing here reads .extracted/, the game or the repo's mods/.

import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";
import type { Report } from "../src/core/validate/result.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const EDITOR = join(HERE, "..");

type ZipMod = typeof import("../src/core/zip.ts");
type ManifestMod = typeof import("../src/core/mod-manifest.ts");
type PackMod = typeof import("../src/core/pack.ts");

async function load<T>(spec: string): Promise<{ m: T | null; err: string }> {
  try { return { m: (await import(spec)) as T, err: "" }; } catch (e) { return { m: null, err: e instanceof Error ? e.message : String(e) }; }
}

const OK_REPORT: Report = { ok: true, findings: [], counts: { errors: 0, warnings: 0, infos: 0 } };
const ERR_REPORT: Report = { ok: false, findings: [{ severity: "error", code: "unknown-status", message: "unknown status Nope" }], counts: { errors: 1, warnings: 0, infos: 0 } };
const enc = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
/** every file under dir, as sorted posix relPaths */
function walk(dir: string): string[] {
  const out: string[] = [];
  const rec = (d: string, pre: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) rec(join(d, e.name), pre + e.name + "/");
      else out.push(pre + e.name);
    }
  };
  rec(dir, "");
  return out.sort();
}

const MANIFEST = {
  name: "cool-mod",
  version: "1.2.0",
  author: "Tester",
  description: "A test mod.",
  gameBuild: "25143593",
  license: "MIT",
  attribution: "Made with mewgenics-mods (https://github.com/MeyerZon/mewgenics-mods).",
};

/** A temp mods/ dir with one mod: overlays, a built SWF, art sources, tests, a dotfile. */
function makeModsDir(manifest: Record<string, unknown> | null = MANIFEST, name = "cool-mod"): { mods: string; dir: string } {
  const mods = mkdtempSync(join(tmpdir(), "pack-mods-"));
  const dir = join(mods, name);
  const put = (rel: string, text: string) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  if (manifest) put("mod.json", JSON.stringify(manifest, null, 2) + "\n");
  put("description.json", JSON.stringify({ title: "Cool Mod", author: "Tester", version: "1.2.0", description: "A test mod.", requirements: [] }));
  put("data/difficulties.gon.merge", "0 {\n\twallet_size 5\n}\n");
  put("data/text/combined.csv.append", "COOL_KEY,Cool,,,,,,,,,,\n");
  put("swfs/cool.swf", "FWS-fake");
  put("swfs/swflist.gon.append", "game [\n    cool.swf\n]\n");
  put("art/cool.scene.json", "{}");
  put("art/cool.png", "png");
  put("tests/smoke.mewtest", "wait frames 1\n");
  put(".gitignore", "swfs/\n");
  return { mods, dir };
}

export async function runPackTests(test: TestFn, assert: AssertFn, eq: EqFn): Promise<void> {
  console.log("\n# shipping a mod: zip writer/reader, mod.json, pack, install");
  const { m: Z, err: zErr } = await load<ZipMod>("../src/core/zip.ts");
  const { m: M, err: mErr } = await load<ManifestMod>("../src/core/mod-manifest.ts");
  const { m: P, err: pErr } = await load<PackMod>("../src/core/pack.ts");
  const need = <T>(x: T | null, err: string, what: string): T => { if (!x) throw new Error(`${what} does not load: ${err}`); return x; };

  // ---- zip.ts ----------------------------------------------------------------------------------------------
  test("zip: writeZip -> listZip/readZipEntry round-trips text, binary, empty and UTF-8-named files byte for byte", () => {
    const z = need(Z, zErr, "src/core/zip.ts");
    const rnd = new Uint8Array(randomBytes(3000));
    const files = [
      { name: "a/readme.txt", data: enc("hello ".repeat(500)) },
      { name: "a/b/random.bin", data: rnd },
      { name: "empty.txt", data: new Uint8Array(0) },
      { name: "a/ü-ñame.gon", data: enc("X { y 1 }") },
    ];
    const buf = z.writeZip(files);
    const entries = z.listZip(buf);
    eq(entries.map((e) => e.name).join(","), files.map((f) => f.name).join(","), "names in order");
    for (const f of files) {
      const e = entries.find((x) => x.name === f.name)!;
      eq(sha(z.readZipEntry(buf, e)), sha(f.data), `${f.name} bytes`);
    }
    eq(entries.find((e) => e.name === "a/readme.txt")!.method, 8, "compressible text is deflated");
    eq(entries.find((e) => e.name === "a/b/random.bin")!.method, 0, "incompressible bytes are stored");
  });
  test("zip: method 'store' writes every entry stored and still round-trips; output is deterministic", () => {
    const z = need(Z, zErr, "src/core/zip.ts");
    const files = [{ name: "x.txt", data: enc("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") }];
    const a = z.writeZip(files, { method: "store" });
    const b = z.writeZip(files, { method: "store" });
    eq(sha(a), sha(b), "same input, same bytes");
    const e = z.listZip(a)[0]!;
    eq(e.method, 0);
    eq(Buffer.from(z.readZipEntry(a, e)).toString(), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });
  test("zip: a corrupted stored byte fails the CRC-32 check", () => {
    const z = need(Z, zErr, "src/core/zip.ts");
    const buf = new Uint8Array(z.writeZip([{ name: "x.txt", data: enc("abcdef") }], { method: "store" }));
    const e = z.listZip(buf)[0]!;
    buf[e.dataOffset] ^= 0xff;
    let msg = "";
    try { z.readZipEntry(buf, e); } catch (err) { msg = String(err); }
    assert(/CRC/i.test(msg), `CRC error: ${msg}`);
  });
  test("zip: an entry that inflates past its declared size is refused (bomb guard), not inflated in full", () => {
    const z = need(Z, zErr, "src/core/zip.ts");
    const buf = new Uint8Array(z.writeZip([{ name: "x.txt", data: enc("hi") }], { method: "store" }));
    const e = z.listZip(buf)[0]!;
    // forge: an entry whose deflate stream inflates to 1 MiB while the directory says 2 bytes
    const bomb = deflateRawSync(Buffer.alloc(1 << 20));
    let msg = "";
    try { z.readZipEntry(new Uint8Array(Buffer.concat([Buffer.alloc(e.dataOffset), bomb])), { ...e, method: 8, compressedSize: bomb.length, size: 2 }); } catch (err) { msg = String(err); }
    assert(msg.length > 0 && !/CRC/i.test(msg), `refused before the CRC check: ${msg}`);
  });
  test("zip: listZip exposes the unix mode from the external attributes (a symlink entry is recognisable)", () => {
    const z = need(Z, zErr, "src/core/zip.ts");
    const buf = z.writeZip([{ name: "f.txt", data: enc("x") }, { name: "link", data: enc("/etc/passwd"), unixMode: 0o120777 }]);
    const [f, l] = z.listZip(buf);
    eq(((f!.externalAttrs >>> 16) & 0o170000).toString(8), "100000", "regular file");
    eq(((l!.externalAttrs >>> 16) & 0o170000).toString(8), "120000", "symlink");
  });
  test("zip: safeZipPath refuses absolute, drive-letter, backslash and dot-dot names", () => {
    const z = need(Z, zErr, "src/core/zip.ts");
    for (const bad of ["/etc/x", "C:/x", "c:x", "a\\..\\b", "a/../../b", "a/./b", "a//b", "..", ""]) eq(z.safeZipPath(bad), null, bad);
    eq(z.safeZipPath("mod/data/x.gon"), "mod/data/x.gon");
  });
  {
    // interop: a stock unzip (Linux CI) or bsdtar (Windows 10+) must read what we write
    let note = "";
    let ok = false;
    if (Z) {
      const d = mkdtempSync(join(tmpdir(), "pack-interop-"));
      const p = join(d, "t.zip");
      writeFileSync(p, Z.writeZip([{ name: "m/a.txt", data: enc("hello ".repeat(100)) }, { name: "m/b.bin", data: new Uint8Array(randomBytes(64)) }]));
      const u = spawnSync("unzip", ["-tq", p], { encoding: "utf8" });
      if (!u.error) { ok = u.status === 0; note = `unzip -tq: ${(u.stdout || "") + (u.stderr || "")}`.trim(); }
      else {
        const t = spawnSync("tar", ["-tf", p], { encoding: "utf8" });
        if (!t.error && t.status === 0 && /m\/a\.txt/.test(t.stdout)) { ok = true; note = "tar -tf listed it"; }
        else note = "";
      }
    }
    if (Z && !note) console.log("  (skipped: neither unzip nor a zip-reading tar on PATH for the interop check)");
    else test("zip: a stock unzip / bsdtar reads the archive writeZip produces", () => { need(Z, zErr, "src/core/zip.ts"); assert(ok, note); });
  }

  // ---- mod-manifest.ts -------------------------------------------------------------------------------------
  test("mod.json: a complete manifest parses; the file name is mod.json; the attribution line is the ATTRIBUTION.md one", () => {
    const m = need(M, mErr, "src/core/mod-manifest.ts");
    eq(m.MOD_MANIFEST_FILE, "mod.json");
    const r = m.parseModManifest(JSON.stringify(MANIFEST), "cool-mod");
    assert(r.ok, JSON.stringify(r));
    if (r.ok) eq(r.manifest.gameBuild, "25143593");
    assert(readFileSync(join(EDITOR, "..", "ATTRIBUTION.md"), "utf8").includes(m.ATTRIBUTION_LINE), `ATTRIBUTION.md carries ${m.ATTRIBUTION_LINE}`);
  });
  test("mod.json: each broken field is named (version not semver, gameBuild not digits, name != folder, native without frameworkApi, bad JSON)", () => {
    const m = need(M, mErr, "src/core/mod-manifest.ts");
    const errs = (o: unknown, folder = "cool-mod") => { const r = m.parseModManifest(typeof o === "string" ? o : JSON.stringify(o), folder); return r.ok ? "" : r.errors.join(" | "); };
    assert(/version/.test(errs({ ...MANIFEST, version: "one" })), "version");
    assert(/gameBuild/.test(errs({ ...MANIFEST, gameBuild: "1.1.21239" })), "gameBuild");
    assert(/name/.test(errs(MANIFEST, "other-folder")), "name vs folder");
    assert(/frameworkApi/.test(errs({ ...MANIFEST, native: ["cool.dll"] })), "native needs frameworkApi");
    assert(/native/.test(errs({ ...MANIFEST, native: ["../evil.dll"], frameworkApi: 4 })), "native entries are bare .dll names");
    assert(/author/.test(errs({ ...MANIFEST, author: "" })), "author");
    assert(/JSON/i.test(errs("{ nope")), "bad JSON");
    eq(errs({ ...MANIFEST, native: ["cool.dll"], frameworkApi: 4 }), "", "native + frameworkApi is fine");
    const { license: _l, attribution: _a, ...bare } = MANIFEST;
    eq(errs(bare), "", "license and attribution are optional");
  });
  test("mod.json: draftModManifest fills name/version/author/description from description.json, the given build, the attribution line", () => {
    const m = need(M, mErr, "src/core/mod-manifest.ts");
    const { dir } = makeModsDir(null);
    const d = m.draftModManifest({ modDir: dir, modName: "cool-mod", gameBuild: "25143593" });
    eq(d.name, "cool-mod");
    eq(d.version, "1.2.0");
    eq(d.author, "Tester");
    eq(d.description, "A test mod.");
    eq(d.gameBuild, "25143593");
    eq(d.attribution, m.ATTRIBUTION_LINE);
    assert(m.parseModManifest(JSON.stringify(d), "cool-mod").ok, "the draft is valid");
    const bare = mkdtempSync(join(tmpdir(), "pack-bare-"));
    const d2 = m.draftModManifest({ modDir: bare, modName: "bare", gameBuild: "1" });
    eq(d2.version, "0.1.0", "default version");
    assert(m.parseModManifest(JSON.stringify(d2), "bare").ok, "a draft without description.json is valid too");
  });
  test("mod.json: compareBuild -> match / mismatch (other known build, or an unknown exe) / unknown (no exe)", () => {
    const m = need(M, mErr, "src/core/mod-manifest.ts");
    eq(m.compareBuild("25143593", { known: true, matched: { steamBuildId: "25143593" } }).status, "match");
    const mm = m.compareBuild("25143593", { known: true, matched: { steamBuildId: "25200000" } });
    eq(mm.status, "mismatch");
    eq(mm.installedBuild, "25200000");
    eq(m.compareBuild("25143593", { known: false, identity: { timeDateStamp: "0x1", sizeOfImage: "0x2" }, matched: null }).status, "mismatch");
    eq(m.compareBuild("25143593", null).status, "unknown");
  });

  // ---- pack ------------------------------------------------------------------------------------------------
  const outDir = () => mkdtempSync(join(tmpdir(), "pack-out-"));
  const packOpts = (mods: string, extra: Record<string, unknown> = {}) => ({ modsDir: mods, outDir: outDir(), validate: () => OK_REPORT, buildSwf: () => ({ ok: true }), nativeDistDir: mkdtempSync(join(tmpdir(), "pack-nd-")), ...extra });

  test("pack: writes <out>/<name>-<version>.zip with the mod folder minus tests/, art/ sources and dotfiles, plus README-INSTALL.txt and MANIFEST.sha256", () => {
    const p = need(P, pErr, "src/core/pack.ts");
    const z = need(Z, zErr, "src/core/zip.ts");
    const { mods } = makeModsDir();
    const o = packOpts(mods);
    const r = p.packMod("cool-mod", o);
    assert(r.ok, JSON.stringify(r.refused));
    eq(r.zipPath, join(o.outDir, "cool-mod-1.2.0.zip"));
    const buf = new Uint8Array(readFileSync(r.zipPath!));
    const names = z.listZip(buf).map((e) => e.name).sort();
    eq(names.join(","), [
      "MANIFEST.sha256", "README-INSTALL.txt",
      "cool-mod/data/difficulties.gon.merge", "cool-mod/data/text/combined.csv.append", "cool-mod/description.json", "cool-mod/mod.json",
      "cool-mod/swfs/cool.swf", "cool-mod/swfs/swflist.gon.append",
    ].join(","));
  });
  test("pack: MANIFEST.sha256 lists every other entry as `<sha256>  <path>` and each hash matches", () => {
    const p = need(P, pErr, "src/core/pack.ts");
    const z = need(Z, zErr, "src/core/zip.ts");
    const { mods } = makeModsDir();
    const r = p.packMod("cool-mod", packOpts(mods));
    const buf = new Uint8Array(readFileSync(r.zipPath!));
    const entries = z.listZip(buf);
    const text = Buffer.from(z.readZipEntry(buf, entries.find((e) => e.name === "MANIFEST.sha256")!)).toString("utf8");
    const lines = text.trim().split("\n");
    eq(lines.length, entries.length - 1, "one line per other entry");
    for (const line of lines) {
      const mm = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
      assert(!!mm, `line shape: ${line}`);
      const e = entries.find((x) => x.name === mm![2]);
      assert(!!e, `listed entry exists: ${mm![2]}`);
      eq(sha(z.readZipEntry(buf, e!)), mm![1], mm![2]);
    }
  });
  test("pack: README-INSTALL.txt names the mod, version, build, the -modpaths launch line and the save advice; no native step for a data mod", () => {
    const p = need(P, pErr, "src/core/pack.ts");
    const t = p.renderInstallReadme(MANIFEST, { nativeDlls: [] });
    for (const s of ["cool-mod", "1.2.0", "Tester", "25143593", "-modpaths", "-savesuffix", "MIT", "Made with mewgenics-mods"]) assert(t.includes(s), `mentions ${s}`);
    assert(/back up/i.test(t) && /saves/.test(t), "tells the player to back up the saves folder");
    assert(!/Mewjector/.test(t), "no native step");
    const n = p.renderInstallReadme({ ...MANIFEST, native: ["cool.dll"], frameworkApi: 4 }, { nativeDlls: ["cool.dll"] });
    for (const s of ["Mewjector", "version.dll", "mewframework.dll", "cool.dll", "API 4", "chainloader.ini"]) assert(n.includes(s), `native step mentions ${s}`);
    assert(/\r\n/.test(t), "CRLF line endings (Notepad-friendly)");
  });
  test("pack: refused without a mod.json (manifest-missing) or with an invalid one (manifest-invalid); nothing written", () => {
    const p = need(P, pErr, "src/core/pack.ts");
    const a = makeModsDir(null);
    const oa = packOpts(a.mods);
    const ra = p.packMod("cool-mod", oa);
    assert(!ra.ok && ra.refused?.code === "manifest-missing", JSON.stringify(ra.refused));
    eq(readdirSync(oa.outDir).length, 0, "no zip");
    const b = makeModsDir({ ...MANIFEST, version: "x" });
    const rb = p.packMod("cool-mod", packOpts(b.mods));
    assert(!rb.ok && rb.refused?.code === "manifest-invalid" && /version/.test(rb.refused.message), JSON.stringify(rb.refused));
  });
  test("pack: init writes a draft mod.json first when it is missing, then packs", () => {
    const p = need(P, pErr, "src/core/pack.ts");
    const { mods, dir } = makeModsDir(null);
    const r = p.packMod("cool-mod", packOpts(mods, { init: true, gameBuild: "25143593" }));
    assert(r.ok, JSON.stringify(r.refused));
    assert(existsSync(join(dir, "mod.json")), "mod.json written");
    eq(r.manifest?.version, "1.2.0");
    assert(r.initialized === true, "reports it initialised the manifest");
  });
  test("pack: detectNativeHalf finds native/mods/<mod>/build.bat's output DLL and the framework's FW_API_VERSION (init drafts native + frameworkApi)", () => {
    const p = need(P, pErr, "src/core/pack.ts");
    const root = mkdtempSync(join(tmpdir(), "pack-repo-"));
    mkdirSync(join(root, "native", "mods", "cool-mod"), { recursive: true });
    mkdirSync(join(root, "native", "framework", "src"), { recursive: true });
    writeFileSync(join(root, "native", "mods", "cool-mod", "build.bat"), '@echo off\r\n"%GCC%" -shared ^\r\n  "%HERE%src\\cool.c" ^\r\n  -o "%OUT%\\cool_mod.dll"\r\n');
    writeFileSync(join(root, "native", "framework", "src", "framework_api.h"), "#define FW_API_VERSION 4   /* bumped */\n");
    const d = p.detectNativeHalf("cool-mod", root);
    eq(JSON.stringify(d), JSON.stringify({ native: ["cool_mod.dll"], frameworkApi: 4 }));
    eq(p.detectNativeHalf("data-only", root), null, "no native/mods/<mod>/ -> null");
    const { mods, dir } = makeModsDir(null);
    const r = p.initModManifest("cool-mod", { modsDir: mods, gameBuild: "25143593", repoRoot: root });
    assert(r.ok, JSON.stringify(r));
    const written = JSON.parse(readFileSync(join(dir, "mod.json"), "utf8")) as { native?: string[]; frameworkApi?: number };
    eq(JSON.stringify([written.native, written.frameworkApi]), JSON.stringify([["cool_mod.dll"], 4]));
  });
  test("pack: validation errors refuse (validation-errors, report returned) unless force; force packs and says so", () => {
    const p = need(P, pErr, "src/core/pack.ts");
    const { mods } = makeModsDir();
    const o = packOpts(mods, { validate: () => ERR_REPORT });
    const r = p.packMod("cool-mod", o);
    assert(!r.ok && r.refused?.code === "validation-errors" && r.report?.counts.errors === 1, JSON.stringify(r.refused));
    eq(readdirSync(o.outDir).length, 0, "no zip");
    const f = p.packMod("cool-mod", { ...o, force: true });
    assert(f.ok && f.forced === true && existsSync(f.zipPath!), JSON.stringify(f.refused));
  });
  test("pack: builds every art/*.scene.json first (build_swf path); a failed build refuses unless force", () => {
    const p = need(P, pErr, "src/core/pack.ts");
    const { mods } = makeModsDir();
    const seen: string[] = [];
    const r = p.packMod("cool-mod", packOpts(mods, { buildSwf: (mod: string, rel: string) => { seen.push(`${mod}:${rel}`); return { ok: true }; } }));
    assert(r.ok, JSON.stringify(r.refused));
    eq(seen.join(","), "cool-mod:art/cool.scene.json");
    eq(r.builds?.length, 1);
    const bad = p.packMod("cool-mod", packOpts(mods, { buildSwf: () => ({ ok: false, error: "emitter reported errors" }) }));
    assert(!bad.ok && bad.refused?.code === "swf-build-failed" && /cool\.scene\.json/.test(bad.refused.message), JSON.stringify(bad.refused));
  });
  test("pack: a native mod ships its DLL from the native dist dir as <name>/native/<dll>; a missing DLL refuses (native-dll-missing)", () => {
    const p = need(P, pErr, "src/core/pack.ts");
    const z = need(Z, zErr, "src/core/zip.ts");
    const { mods } = makeModsDir({ ...MANIFEST, native: ["cool.dll"], frameworkApi: 4 });
    const o = packOpts(mods);
    const miss = p.packMod("cool-mod", o);
    assert(!miss.ok && miss.refused?.code === "native-dll-missing" && /cool\.dll/.test(miss.refused.message), JSON.stringify(miss.refused));
    writeFileSync(join(o.nativeDistDir, "cool.dll"), "MZ-fake");
    const r = p.packMod("cool-mod", o);
    assert(r.ok, JSON.stringify(r.refused));
    const names = z.listZip(new Uint8Array(readFileSync(r.zipPath!))).map((e) => e.name);
    assert(names.includes("cool-mod/native/cool.dll"), names.join(","));
  });
  test("pack: the same mod packs to the same bytes twice (reproducible zip)", () => {
    const p = need(P, pErr, "src/core/pack.ts");
    const { mods } = makeModsDir();
    const a = p.packMod("cool-mod", packOpts(mods));
    const b = p.packMod("cool-mod", packOpts(mods));
    eq(sha(new Uint8Array(readFileSync(a.zipPath!))), sha(new Uint8Array(readFileSync(b.zipPath!))));
  });
  test("pack: an output dir under a saves/ path is refused", () => {
    const p = need(P, pErr, "src/core/pack.ts");
    const { mods } = makeModsDir();
    const r = p.packMod("cool-mod", packOpts(mods, { outDir: join(mkdtempSync(join(tmpdir(), "pack-sv-")), "saves", "x") }));
    assert(!r.ok && r.refused?.code === "out-dir-unsafe", JSON.stringify(r.refused));
  });

  // ---- install ---------------------------------------------------------------------------------------------
  const MATCH = { known: true, matched: { steamBuildId: "25143593" } };
  const packed = (): Uint8Array => {
    const p = need(P, pErr, "src/core/pack.ts");
    const { mods } = makeModsDir();
    const r = p.packMod("cool-mod", packOpts(mods));
    if (!r.ok) throw new Error(JSON.stringify(r.refused));
    return new Uint8Array(readFileSync(r.zipPath!));
  };
  const into = () => mkdtempSync(join(tmpdir(), "pack-into-"));
  const inst = (zip: Uint8Array, dir: string, extra: Record<string, unknown> = {}) => need(P, pErr, "src/core/pack.ts").installMod(zip, { into: dir, installedBuild: MATCH, validate: false, ...extra });
  /** a zip from raw entries (no manifest of hashes unless given) */
  const rawZip = (files: { name: string; data: Uint8Array; unixMode?: number }[]) => need(Z, zErr, "src/core/zip.ts").writeZip(files);
  const modJson = (o: Record<string, unknown> = MANIFEST) => enc(JSON.stringify(o));

  test("install: a packed zip unpacks into <into>/<name>/ byte for byte; README-INSTALL.txt / MANIFEST.sha256 stay out of the mod", () => {
    const { mods, dir } = makeModsDir();
    const p = need(P, pErr, "src/core/pack.ts");
    const r = p.packMod("cool-mod", packOpts(mods));
    const d = into();
    const res = inst(new Uint8Array(readFileSync(r.zipPath!)), d);
    assert(res.ok && res.verdict === "installed", JSON.stringify(res));
    eq(walk(d).join(","), ["cool-mod/data/difficulties.gon.merge", "cool-mod/data/text/combined.csv.append", "cool-mod/description.json", "cool-mod/mod.json", "cool-mod/swfs/cool.swf", "cool-mod/swfs/swflist.gon.append"].join(","));
    for (const rel of ["mod.json", "data/difficulties.gon.merge", "swfs/cool.swf"]) eq(sha(readFileSync(join(d, "cool-mod", rel))), sha(readFileSync(join(dir, rel))), rel);
    if (res.ok) { eq(res.name, "cool-mod"); eq(res.version, "1.2.0"); eq(res.build.status, "match"); }
  });
  test("install: path traversal / absolute / backslash names refuse the whole archive (unsafe-path) and write nothing", () => {
    for (const evil of ["cool-mod/../../evil.txt", "/abs/evil.txt", "C:/evil.txt", "cool-mod\\..\\evil.txt"]) {
      const d = into();
      const res = inst(rawZip([{ name: "cool-mod/mod.json", data: modJson() }, { name: evil, data: enc("x") }]), d);
      assert(!res.ok && res.verdict === "refused" && res.code === "unsafe-path", `${evil}: ${JSON.stringify(res)}`);
      eq(walk(d).length, 0, `${evil}: nothing written`);
    }
  });
  test("install: a symlink entry, a saves/ segment and case-only duplicate names are refused", () => {
    const d = into();
    const sl = inst(rawZip([{ name: "cool-mod/mod.json", data: modJson() }, { name: "cool-mod/link", data: enc("/etc"), unixMode: 0o120777 }]), d);
    assert(!sl.ok && sl.verdict === "refused" && sl.code === "symlink", JSON.stringify(sl));
    const sv = inst(rawZip([{ name: "cool-mod/mod.json", data: modJson() }, { name: "cool-mod/Saves/x.sav", data: enc("x") }]), d);
    assert(!sv.ok && sv.verdict === "refused" && sv.code === "unsafe-path", JSON.stringify(sv));
    const dup = inst(rawZip([{ name: "cool-mod/mod.json", data: modJson() }, { name: "cool-mod/a.txt", data: enc("1") }, { name: "cool-mod/A.txt", data: enc("2") }]), d);
    assert(!dup.ok && dup.verdict === "refused" && dup.code === "duplicate-path", JSON.stringify(dup));
    eq(walk(d).length, 0, "nothing written");
  });
  test("install: size caps (zip bytes, declared uncompressed total, entry count) refuse before unpacking", () => {
    const zip = packed();
    const a = inst(zip, into(), { limits: { maxZipBytes: 100 } });
    assert(!a.ok && a.verdict === "refused" && a.code === "zip-too-large", JSON.stringify(a));
    const b = inst(zip, into(), { limits: { maxTotalBytes: 10 } });
    assert(!b.ok && b.verdict === "refused" && b.code === "too-large-uncompressed", JSON.stringify(b));
    const c = inst(zip, into(), { limits: { maxEntries: 2 } });
    assert(!c.ok && c.verdict === "refused" && c.code === "too-many-entries", JSON.stringify(c));
    const nz = inst(enc("not a zip at all, just text"), into());
    assert(!nz.ok && nz.verdict === "refused" && nz.code === "not-a-zip", JSON.stringify(nz));
  });
  test("install: layout is checked — mod.json required, its name must be the one top folder, no stray root files", () => {
    const noMan = inst(rawZip([{ name: "cool-mod/data/x.gon.append", data: enc("X {}") }]), into());
    assert(!noMan.ok && noMan.verdict === "refused" && noMan.code === "manifest-missing", JSON.stringify(noMan));
    const badMan = inst(rawZip([{ name: "cool-mod/mod.json", data: modJson({ ...MANIFEST, gameBuild: "abc" }) }]), into());
    assert(!badMan.ok && badMan.verdict === "refused" && badMan.code === "manifest-invalid", JSON.stringify(badMan));
    const wrongName = inst(rawZip([{ name: "other/mod.json", data: modJson() }]), into());
    assert(!wrongName.ok && wrongName.verdict === "refused" && wrongName.code === "manifest-invalid", JSON.stringify(wrongName));
    const two = inst(rawZip([{ name: "cool-mod/mod.json", data: modJson() }, { name: "second/x.txt", data: enc("x") }]), into());
    assert(!two.ok && two.verdict === "refused" && two.code === "layout", JSON.stringify(two));
    const stray = inst(rawZip([{ name: "cool-mod/mod.json", data: modJson() }, { name: "virus.exe", data: enc("x") }]), into());
    assert(!stray.ok && stray.verdict === "refused" && stray.code === "layout", JSON.stringify(stray));
  });
  test("install: a MANIFEST.sha256 that does not match the files (tampered zip) is refused (checksum-mismatch)", () => {
    const sums = `${"0".repeat(64)}  cool-mod/mod.json\n`;
    const res = inst(rawZip([{ name: "cool-mod/mod.json", data: modJson() }, { name: "MANIFEST.sha256", data: enc(sums) }]), into());
    assert(!res.ok && res.verdict === "refused" && res.code === "checksum-mismatch", JSON.stringify(res));
    const unlisted = `${sha(modJson())}  cool-mod/mod.json\n`;
    const res2 = inst(rawZip([{ name: "cool-mod/mod.json", data: modJson() }, { name: "cool-mod/extra.txt", data: enc("x") }, { name: "MANIFEST.sha256", data: enc(unlisted) }]), into());
    assert(!res2.ok && res2.verdict === "refused" && res2.code === "checksum-mismatch" && /extra\.txt/.test(res2.reason), JSON.stringify(res2));
  });
  test("install: a build mismatch returns verdict build-mismatch with prompt text and writes nothing; acceptBuildMismatch installs", () => {
    const zip = packed();
    const d = into();
    const other = { known: true, matched: { steamBuildId: "25200000" } };
    const res = inst(zip, d, { installedBuild: other });
    assert(!res.ok && res.verdict === "build-mismatch", JSON.stringify(res));
    if (!res.ok && res.verdict === "build-mismatch") assert(res.prompt.includes("25143593") && res.prompt.includes("25200000"), res.prompt);
    eq(walk(d).length, 0, "nothing written");
    const ok = inst(zip, d, { installedBuild: other, acceptBuildMismatch: true });
    assert(ok.ok && ok.build.status === "mismatch", JSON.stringify(ok));
    const unk = inst(zip, into(), { installedBuild: null });
    assert(unk.ok && unk.build.status === "unknown", JSON.stringify(unk));
  });
  test("install: an existing mods/<name>/ is never overwritten (exists); an `into` under saves/ is refused", () => {
    const zip = packed();
    const d = into();
    mkdirSync(join(d, "cool-mod"));
    writeFileSync(join(d, "cool-mod", "mine.txt"), "keep");
    const res = inst(zip, d);
    assert(!res.ok && res.verdict === "refused" && res.code === "exists", JSON.stringify(res));
    eq(walk(d).join(","), "cool-mod/mine.txt", "existing folder untouched");
    const sv = inst(zip, join(into(), "saves"));
    assert(!sv.ok && sv.verdict === "refused" && sv.code === "into-unsafe", JSON.stringify(sv));
  });
  test("install: validate (default on) runs the validator on the installed folder and returns its report", () => {
    const zip = packed();
    const seen: string[] = [];
    const res = inst(zip, into(), { validate: (name: string, dir: string) => { seen.push(`${name}@${dir.endsWith("cool-mod")}`); return OK_REPORT; } });
    assert(res.ok && res.report?.ok === true, JSON.stringify(res));
    eq(seen.join(","), "cool-mod@true");
  });

  // ---- adapters: CLI, MCP, web --------------------------------------------------------------------------------
  test("package.json has `npm run pack` -> scripts/pack.ts", () => {
    const pkg = JSON.parse(readFileSync(join(EDITOR, "package.json"), "utf8")) as { scripts: Record<string, string> };
    assert(/scripts\/pack\.ts/.test(pkg.scripts.pack || ""), `pack: ${pkg.scripts.pack}`);
  });
  {
    let out = "", status: number | null = -1;
    const zip = P && Z ? (() => { try { return packed(); } catch { return null; } })() : null;
    const d = into();
    if (zip) {
      const zp = join(mkdtempSync(join(tmpdir(), "pack-cli-")), "cool-mod-1.2.0.zip");
      writeFileSync(zp, zip);
      const r = spawnSync(process.argv[0]!, [join(EDITOR, "scripts", "pack.ts"), "--install", zp, "--into", d, "--yes"], { encoding: "utf8", timeout: 60000 });
      out = (r.stdout || "") + (r.stderr || "");
      status = r.status;
    }
    test("CLI: `pack.ts --install <zip> --into <dir> --yes` installs and exits 0", () => {
      assert(!!zip, "packMod works");
      assert(status === 0 && existsSync(join(d, "cool-mod", "mod.json")), `exit ${status}: ${out.slice(-400)}`);
    });
  }
  {
    const r = spawnSync(process.argv[0]!, [join(EDITOR, "scripts", "pack.ts"), "--help"], { encoding: "utf8", timeout: 60000 });
    test("CLI: `pack.ts --help` prints the usage (pack <mod> / --install <zip>) and exits 0", () => {
      const o = (r.stdout || "") + (r.stderr || "");
      assert(r.status === 0 && /--install/.test(o) && /--force/.test(o), `exit ${r.status}: ${o.slice(-300)}`);
    });
  }
  const { m: T, err: tErr } = await load<typeof import("../src/mcp/tools.ts")>("../src/mcp/tools.ts");
  test("MCP: pack_mod { mod, force?, init? } and install_mod { zip, acceptBuildMismatch? } are listed", () => {
    const t = need(T, tErr, "src/mcp/tools.ts");
    const names = t.TOOLS.map((x) => x.name);
    assert(names.includes("pack_mod" as never) && names.includes("install_mod" as never), names.join(","));
    const im = t.TOOLS.find((x) => x.name === ("install_mod" as never))!;
    assert(!("into" in ((im.inputSchema as { properties?: Record<string, unknown> }).properties || {})), "install_mod has no `into`: MCP installs only into mods/");
  });
  const { m: S, err: sErr } = await load<typeof import("../src/core/api-schemas.ts")>("../src/core/api-schemas.ts");
  test("web: /api/mod/pack { mod, force?, init? } and /api/mod/install { base64, acceptBuildMismatch? } bodies", () => {
    const s = need(S, sErr, "src/core/api-schemas.ts");
    const body = s.API_BODY as Record<string, { safeParse: (x: unknown) => { success: boolean } }>;
    assert(!!body["/api/mod/pack"] && !!body["/api/mod/install"], Object.keys(body).join(","));
    assert(body["/api/mod/pack"]!.safeParse({ mod: "m", force: true }).success, "pack ok");
    assert(!body["/api/mod/pack"]!.safeParse({}).success, "pack needs mod");
    assert(body["/api/mod/install"]!.safeParse({ base64: "AA==" }).success, "install ok");
    assert(!body["/api/mod/install"]!.safeParse({ base64: "AA==", into: "C:/x" }).success, "install takes no into");
  });
}
