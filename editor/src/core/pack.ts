// Shipping a mod (docs/data-mods.md "Shipping a mod"):
//   packMod     mods/<name>/ -> editor/data/dist/<name>-<version>.zip: builds the SWFs (build_swf's path), validates
//               (refuses on errors unless force), zips the folder minus tests/, art/ sources and dotfiles, plus the
//               mod's own DLLs (mod.json `native`), README-INSTALL.txt and MANIFEST.sha256 at the zip root.
//   installMod  zip -> mods/<name>/: refuses before writing anything on a path escape, a symlink, a saves/ segment,
//               duplicate names, oversize input, a bad layout, a missing/invalid mod.json, a checksum mismatch or an
//               existing folder; a build mismatch is returned as a verdict with prompt text (the CLI asks, MCP and the
//               web UI return it) and installs only with acceptBuildMismatch. Writes go to a temp sibling first and
//               are renamed into place, so a failed install leaves nothing half-written.
// Node built-ins only (src/core/zip.ts). Never writes outside the chosen mods dir / the dist dir.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { MODS_DIR, DATA_CACHE_DIR, REPO_ROOT, isInside, touchesSaves, resolveModWritePath } from "./repo.ts";
import { writeZip, listZip, readZipEntry, safeZipPath, isSymlinkEntry } from "./zip.ts";
import type { ZipEntry, ZipInputFile } from "./zip.ts";
import { MOD_MANIFEST_FILE, MOD_NAME_RE, readModManifest, parseModManifest, draftModManifest, compareBuild, describeMismatch } from "./mod-manifest.ts";
import type { ModManifest, BuildComparison } from "./mod-manifest.ts";
import { validateMod, installedNativeBuild } from "./validate/validator.ts";
import type { NativeBuild } from "./validate/validator.ts";
import type { Report } from "./validate/result.ts";
import { buildSwf as artBuildSwf } from "./art/art-io.ts";
import { listManifests } from "./bindings/manifest.ts";

export const README_INSTALL = "README-INSTALL.txt";
export const SHA256_MANIFEST = "MANIFEST.sha256";
/** where packed zips go: the git-ignored editor/data/dist/ (or $MEWGENICS_EDITOR_DATA/dist) */
export const DIST_DIR = join(DATA_CACHE_DIR, "dist");
/** the chainloader's scan path in this repo (native/chainloader.ini), where built mod DLLs live */
export const NATIVE_DIST_DIR = join(REPO_ROOT, "native", "dist");
const SCENE_SUFFIX = ".scene.json";

export const DEFAULT_LIMITS = {
  /** the zip file itself */
  maxZipBytes: 64 * 1024 * 1024,
  /** the sum of the declared uncompressed sizes */
  maxTotalBytes: 256 * 1024 * 1024,
  maxEntries: 5000,
};
export type InstallLimits = typeof DEFAULT_LIMITS;

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---- what goes in the zip ----------------------------------------------------------------------------------------
/**
 * Whether a file of the mod folder ships. Out: `tests/` (harness scripts), `art/` (scene sources and their SVG/PNG
 * inputs — the game loads the built swfs/), any dot-file or dot-folder (.gitignore), editor/OS clutter.
 */
export function packIncludes(relPath: string): boolean {
  const segs = relPath.split("/");
  if (segs[0] === "tests" || segs[0] === "art") return false;
  if (segs.some((s) => s.startsWith("."))) return false;
  const leaf = segs[segs.length - 1]!.toLowerCase();
  if (leaf === "thumbs.db" || leaf === "desktop.ini" || leaf.endsWith(".tmp") || leaf.endsWith(".bak") || leaf.endsWith("~")) return false;
  return true;
}

/** Every file under dir as a sorted posix relPath (directories are walked; symlinks / junctions are not followed). */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const rec = (d: string, pre: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) rec(join(d, e.name), `${pre}${e.name}/`);
      else if (e.isFile()) out.push(pre + e.name);
    }
  };
  if (existsSync(dir)) rec(dir, "");
  return out.sort();
}

/** `<sha256>  <path>` per entry (sha256sum's format, so `sha256sum -c MANIFEST.sha256` works after unzipping). */
export function renderSha256Manifest(files: { name: string; data: Uint8Array }[]): string {
  return files.map((f) => `${sha256(f.data)}  ${f.name}\n`).join("");
}
/** Parse a MANIFEST.sha256 into path -> hash; null on a malformed line. */
export function parseSha256Manifest(text: string): Map<string, string> | null {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line);
    if (!m) return null;
    out.set(m[2]!, m[1]!.toLowerCase());
  }
  return out;
}

// ---- README-INSTALL.txt ---------------------------------------------------------------------------------------------
export interface ReadmeOptions {
  /** the DLLs actually in the zip (under <name>/native/) */
  nativeDlls: string[];
}

/** The install instructions shipped at the zip root (CRLF, so Notepad shows it right). */
export function renderInstallReadme(m: ModManifest, o: ReadmeOptions): string {
  const L: string[] = [];
  const title = `${m.name} ${m.version}${m.author ? ` by ${m.author}` : ""}`;
  L.push(title, "=".repeat(title.length), "");
  if (m.description) L.push(m.description, "");
  L.push(`Tested on Mewgenics Steam build ${m.gameBuild}.`);
  L.push(`License: ${m.license && m.license.trim() ? m.license : "not stated (ask the author before redistributing)"}`);
  if (m.attribution) L.push(m.attribution);
  L.push("");
  L.push("WHAT IS IN THIS ZIP");
  L.push(`  ${m.name}/            the mod folder (this is what the game loads)`);
  if (o.nativeDlls.length) L.push(`  ${m.name}/native/     the mod's native DLL(s): ${o.nativeDlls.join(", ")}`);
  L.push(`  ${README_INSTALL}  this file`);
  L.push(`  ${SHA256_MANIFEST}     SHA-256 of every file (check with: sha256sum -c ${SHA256_MANIFEST})`);
  L.push("");
  L.push("1. UNZIP");
  L.push(`   Unzip anywhere and put the "${m.name}" folder in a mods folder of your choice, e.g.`);
  L.push(`     C:\\Mewgenics-mods\\${m.name}`);
  L.push("   Keep it OUT of the game's own folder and out of the saves folder.");
  L.push(`   (mewgenics-mods editor users: npm run pack -- --install ${m.name}-${m.version}.zip puts it in mods/.)`);
  L.push("");
  L.push("2. LAUNCH WITH THE MOD");
  L.push("   Mods load through the game's own -modpaths option. With Steam running, start the game from its folder:");
  L.push("     cd /d \"C:\\Program Files (x86)\\Steam\\steamapps\\common\\Mewgenics\"");
  L.push(`     set SteamAppId=686060`);
  L.push(`     Mewgenics.exe -savesuffix modded -modpaths "C:\\Mewgenics-mods\\${m.name}"`);
  L.push("   Several mods: list every folder after one -modpaths, separated by spaces; later folders override earlier ones.");
  L.push("   A mod manager that takes a mod folder (e.g. Mewtator) works too. Do NOT put these options in Steam's launch");
  L.push("   options if you also want plain, unmodded launches.");
  L.push("");
  L.push("3. YOUR SAVES");
  L.push("   Back up your saves folder before playing modded:");
  L.push("     %APPDATA%\\Glaiel Games\\Mewgenics\\<your steam id>\\saves\\");
  L.push("   Pass -savesuffix (as above) on every modded launch, but do not rely on it alone: on the builds examined so far");
  L.push("   the suffix is not part of the save file names, so a modded session can write the same save slots as a");
  L.push("   normal one. Start a fresh save slot for modded play and keep the backup.");
  L.push("");
  if (o.nativeDlls.length) {
    L.push("4. NATIVE PART (this mod has one)");
    L.push(`   ${o.nativeDlls.join(", ")} run inside the game through a DLL chainloader:`);
    L.push("   a. Install Mewjector (version.dll) and its chainloader.ini next to Mewgenics.exe.");
    L.push("   b. Put mewframework.dll (the mewgenics-mods native framework, API " + String(m.frameworkApi ?? "?") + " or newer) and");
    L.push(`      ${o.nativeDlls.join(", ")} (from ${m.name}/native/) in the folder chainloader.ini's ScanPath names, and list`);
    L.push("      mewframework.dll first in its [LoadOrder] (Mod10=mewframework.dll).");
    L.push("   c. The framework only runs when the game is started with -savesuffix, and only on a game build it knows;");
    L.push(`      on another build it disables itself (the data part still loads). This mod was built for build ${m.gameBuild}.`);
    L.push("");
  }
  L.push("Uninstall: remove the folder from -modpaths (or delete it). Nothing in the game folder is changed by the data part.");
  return L.join("\r\n") + "\r\n";
}

// ---- pack -------------------------------------------------------------------------------------------------------
export interface PackOptions {
  /** the mods dir holding <name>/ (default the repo's mods/) */
  modsDir?: string;
  /** where the zip is written (default editor/data/dist/) */
  outDir?: string;
  /** pack despite validation errors, failed SWF builds or missing DLLs */
  force?: boolean;
  /** write a draft mod.json first when the mod has none */
  init?: boolean;
  /** the gameBuild for an `init` draft (default: the installed build when known, else the newest bindings manifest) */
  gameBuild?: string;
  /** default: the editor's validator on the mod folder */
  validate?: (modName: string, modDir: string) => Report;
  /** default: build_swf (art-io); only available for the repo's mods/ */
  buildSwf?: (modName: string, sceneRelPath: string) => { ok: boolean; error?: string };
  /** where the mod's DLLs are looked up (default native/dist/) */
  nativeDistDir?: string;
  /** the timestamp written into the zip (default the DOS epoch: reproducible bytes) */
  date?: Date;
}

export interface PackRefusal {
  code: "mod-missing" | "manifest-missing" | "manifest-invalid" | "swf-build-failed" | "validation-errors" | "native-dll-missing" | "out-dir-unsafe";
  message: string;
}

export interface PackResult {
  ok: boolean;
  mod: string;
  refused?: PackRefusal;
  manifest?: ModManifest;
  /** true when `init` wrote mod.json */
  initialized?: boolean;
  builds?: { scene: string; ok: boolean; error?: string }[];
  report?: Report;
  /** packed although something would have refused it */
  forced?: boolean;
  warnings?: string[];
  zipPath?: string;
  zipName?: string;
  bytes?: number;
  sha256?: string;
  entries?: string[];
}

/** The build an `init` draft says it was tested on: the installed known build, else the newest bindings manifest. */
export function defaultGameBuild(): string {
  const nb = installedNativeBuild();
  if (nb && nb.known && nb.matched) return nb.matched.steamBuildId;
  const all = listManifests();
  return all.length ? all[all.length - 1]!.manifest.build.steamBuildId : "0";
}

/**
 * A mod's native half in this repo, by convention native/mods/<mod>/ (Joker's Luck): the DLL its build.bat writes
 * (`-o "...\<x>.dll"`) and the framework's FW_API_VERSION (native/framework/src/framework_api.h). null when absent.
 */
export function detectNativeHalf(modName: string, repoRoot: string = REPO_ROOT): { native: string[]; frameworkApi?: number } | null {
  const bat = join(repoRoot, "native", "mods", modName, "build.bat");
  if (!MOD_NAME_RE.test(modName) || !existsSync(bat)) return null;
  const dlls = [...readFileSync(bat, "utf8").matchAll(/-o\s+"?[^"\r\n]*?([A-Za-z0-9_.-]+\.[dD][lL][lL])"?/g)].map((m) => m[1]!);
  if (!dlls.length) return null;
  const out: { native: string[]; frameworkApi?: number } = { native: [...new Set(dlls)] };
  const hdr = join(repoRoot, "native", "framework", "src", "framework_api.h");
  const v = existsSync(hdr) ? /#define\s+FW_API_VERSION\s+(\d+)/.exec(readFileSync(hdr, "utf8")) : null;
  if (v) out.frameworkApi = Number(v[1]);
  return out;
}

/** Write a draft mods/<name>/mod.json (refuses when one exists); a native half found by detectNativeHalf is listed. */
export function initModManifest(modName: string, opts: { modsDir?: string; gameBuild?: string; repoRoot?: string } = {}): { ok: true; manifest: ModManifest; path: string } | { ok: false; error: string } {
  const modsDir = resolve(opts.modsDir ?? MODS_DIR);
  if (!MOD_NAME_RE.test(modName)) return { ok: false, error: `invalid mod name: ${JSON.stringify(modName)}` };
  const modDir = join(modsDir, modName);
  if (!existsSync(modDir)) return { ok: false, error: `mod not found: ${modDir}` };
  const target = modsDir === resolve(MODS_DIR) ? resolveModWritePath(modName, MOD_MANIFEST_FILE) : join(modDir, MOD_MANIFEST_FILE);
  if (touchesSaves(target)) return { ok: false, error: `refusing to write a saves path: ${target}` };
  if (existsSync(target)) return { ok: false, error: `${MOD_MANIFEST_FILE} already exists: ${target}` };
  const nat = detectNativeHalf(modName, opts.repoRoot ?? REPO_ROOT);
  const manifest = draftModManifest({ modDir, modName, gameBuild: opts.gameBuild ?? defaultGameBuild(), native: nat?.native, frameworkApi: nat?.frameworkApi });
  writeFileSync(target, JSON.stringify(manifest, null, 2) + "\n");
  return { ok: true, manifest, path: target };
}

/** Pack mods/<name>/ into <outDir>/<name>-<version>.zip. Never throws for an expected refusal; see PackResult. */
export function packMod(modName: string, opts: PackOptions = {}): PackResult {
  const modsDir = resolve(opts.modsDir ?? MODS_DIR);
  const outDir = resolve(opts.outDir ?? DIST_DIR);
  const isRepoMods = modsDir === resolve(MODS_DIR);
  const refuse = (code: PackRefusal["code"], message: string, extra: Partial<PackResult> = {}): PackResult => ({ ok: false, mod: modName, refused: { code, message }, ...extra });
  if (!MOD_NAME_RE.test(modName)) return refuse("mod-missing", `invalid mod name: ${JSON.stringify(modName)}`);
  const modDir = join(modsDir, modName);
  if (!existsSync(modDir)) return refuse("mod-missing", `mod folder not found: ${modDir}`);
  if (touchesSaves(outDir) || touchesSaves(modDir)) return refuse("out-dir-unsafe", `refusing a saves path: ${touchesSaves(outDir) ? outDir : modDir}`);
  if (isInside(modDir, outDir)) return refuse("out-dir-unsafe", `the output dir must not be inside the mod: ${outDir}`);

  let initialized = false;
  let man = readModManifest(modDir, modName);
  if (!man.present && opts.init) {
    const r = initModManifest(modName, { modsDir, gameBuild: opts.gameBuild });
    if (!r.ok) return refuse("manifest-invalid", r.error);
    initialized = true;
    man = readModManifest(modDir, modName);
  }
  if (!man.present) return refuse("manifest-missing", `mods/${modName}/${MOD_MANIFEST_FILE} is required to pack (name, version, author, description, gameBuild); pass init (--init) to draft one from description.json`);
  if (!man.ok) return refuse("manifest-invalid", `${MOD_MANIFEST_FILE}: ${man.errors.join("; ")}`);
  const manifest = man.manifest;
  const force = !!opts.force;
  const warnings: string[] = [];
  let forced = false;

  // 1. SWFs: every art/**/*.scene.json is rebuilt so swfs/ matches the sources
  const scenes = listFiles(join(modDir, "art")).filter((r) => r.endsWith(SCENE_SUFFIX)).map((r) => `art/${r}`);
  const builder = opts.buildSwf ?? (isRepoMods ? (m: string, rel: string) => { const b = artBuildSwf(m, rel); return { ok: b.ok, error: b.error }; } : null);
  const builds: NonNullable<PackResult["builds"]> = [];
  for (const scene of scenes) {
    if (!builder) { builds.push({ scene, ok: false, error: "no SWF builder for a mods dir outside the repo" }); continue; }
    let b: { ok: boolean; error?: string };
    try { b = builder(modName, scene); } catch (e) { b = { ok: false, error: errText(e) }; }
    builds.push({ scene, ok: b.ok, ...(b.error ? { error: b.error } : {}) });
  }
  const failed = builds.filter((b) => !b.ok);
  if (failed.length) {
    const msg = `SWF build failed: ${failed.map((b) => `${b.scene} (${b.error || "error"})`).join(", ")}`;
    if (!force) return refuse("swf-build-failed", msg, { manifest, builds, initialized });
    forced = true;
    warnings.push(msg);
  }

  // 2. validate
  const report = (opts.validate ?? ((m: string, d: string) => validateMod(m, undefined, { modDir: d })))(modName, modDir);
  if (report.counts.errors > 0) {
    const msg = `validate_mod reports ${report.counts.errors} error(s): ${report.findings.filter((f) => f.severity === "error").slice(0, 5).map((f) => f.code).join(", ")}`;
    if (!force) return refuse("validation-errors", msg, { manifest, builds, report, initialized });
    forced = true;
    warnings.push(msg);
  }

  // 3. native DLLs
  const nativeDir = resolve(opts.nativeDistDir ?? NATIVE_DIST_DIR);
  const nativeDlls: string[] = [];
  const dllFiles: ZipInputFile[] = [];
  for (const dll of manifest.native ?? []) {
    const p = join(nativeDir, dll);
    if (!existsSync(p)) {
      const msg = `native DLL ${dll} not found in ${nativeDir} (build it, e.g. native/mods/<mod>/build.bat, and copy it there)`;
      if (!force) return refuse("native-dll-missing", msg, { manifest, builds, report, initialized });
      forced = true;
      warnings.push(msg);
      continue;
    }
    nativeDlls.push(dll);
    dllFiles.push({ name: `${modName}/native/${dll}`, data: new Uint8Array(readFileSync(p)) });
  }

  // 4. the zip: <name>/..., then README-INSTALL.txt, then MANIFEST.sha256 (covers every entry before it)
  const files: ZipInputFile[] = listFiles(modDir).filter(packIncludes).map((rel) => ({ name: `${modName}/${rel}`, data: new Uint8Array(readFileSync(join(modDir, ...rel.split("/")))) }));
  files.push(...dllFiles.filter((d) => !files.some((f) => f.name === d.name)));
  files.push({ name: README_INSTALL, data: new Uint8Array(Buffer.from(renderInstallReadme(manifest, { nativeDlls }), "utf8")) });
  files.push({ name: SHA256_MANIFEST, data: new Uint8Array(Buffer.from(renderSha256Manifest(files), "utf8")) });
  const zip = writeZip(files, { date: opts.date });
  const zipName = `${modName}-${manifest.version}.zip`;
  mkdirSync(outDir, { recursive: true });
  const zipPath = join(outDir, zipName);
  writeFileSync(zipPath, zip);
  return {
    ok: true, mod: modName, manifest, initialized, builds, report, ...(forced ? { forced } : {}), ...(warnings.length ? { warnings } : {}),
    zipPath, zipName, bytes: zip.length, sha256: sha256(zip), entries: files.map((f) => f.name),
  };
}

// ---- install ----------------------------------------------------------------------------------------------------
export interface InstallOptions {
  /** the mods dir to install into (default the repo's mods/); the mod lands in <into>/<name>/ and nowhere else */
  into?: string;
  /** install although the mod's gameBuild differs from the installed game */
  acceptBuildMismatch?: boolean;
  /** the installed exe's identity (tests); undefined = look it up, null = no exe */
  installedBuild?: NativeBuild | null;
  limits?: Partial<InstallLimits>;
  /** false: skip; a function: run instead of the editor's validator on the installed folder */
  validate?: false | ((modName: string, modDir: string) => Report);
}

export type InstallRefusalCode =
  | "zip-too-large" | "not-a-zip" | "too-many-entries" | "too-large-uncompressed" | "unsafe-path" | "symlink" | "duplicate-path"
  | "layout" | "manifest-missing" | "manifest-invalid" | "checksum-mismatch" | "corrupt-entry" | "exists" | "into-unsafe" | "write-failed";

export type InstallResult =
  | { ok: true; verdict: "installed"; name: string; version: string; dir: string; files: string[]; build: BuildComparison; manifest: ModManifest; notes: string[]; report?: Report }
  | { ok: false; verdict: "refused"; code: InstallRefusalCode; reason: string; name?: string }
  | { ok: false; verdict: "build-mismatch"; name: string; version: string; build: BuildComparison; manifest: ModManifest; prompt: string };

/** Install a mod zip (bytes, or a path to read) into <into>/<name>/. */
export function installMod(zip: Uint8Array | string, opts: InstallOptions = {}): InstallResult {
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
  const refuse = (code: InstallRefusalCode, reason: string, name?: string): InstallResult => ({ ok: false, verdict: "refused", code, reason, ...(name ? { name } : {}) });
  const into = resolve(opts.into ?? MODS_DIR);
  if (touchesSaves(into)) return refuse("into-unsafe", `refusing to install under a saves path: ${into}`);
  for (const p of ["Mewgenics.exe", "resources.gpak"]) if (existsSync(join(into, p))) return refuse("into-unsafe", `refusing to install into the game folder: ${into}`);

  let buf: Uint8Array;
  if (typeof zip === "string") {
    const p = resolve(zip);
    if (touchesSaves(p)) return refuse("into-unsafe", `refusing to read a saves path: ${p}`);
    if (!existsSync(p)) return refuse("not-a-zip", `zip not found: ${p}`);
    buf = new Uint8Array(readFileSync(p));
  } else buf = zip;
  if (buf.length > limits.maxZipBytes) return refuse("zip-too-large", `zip is ${buf.length} bytes; the cap is ${limits.maxZipBytes}`);
  let entries: ZipEntry[];
  try { entries = listZip(buf); } catch (e) { return refuse("not-a-zip", errText(e)); }
  if (entries.length > limits.maxEntries) return refuse("too-many-entries", `${entries.length} entries; the cap is ${limits.maxEntries}`);
  const total = entries.reduce((s, e) => s + e.size, 0);
  if (total > limits.maxTotalBytes) return refuse("too-large-uncompressed", `${total} bytes uncompressed; the cap is ${limits.maxTotalBytes}`);

  // names: every entry (directories included) must be a safe relative path; no symlinks, no saves/, no case-twins
  const fileEntries: { e: ZipEntry; rel: string }[] = [];
  const seen = new Map<string, string>();
  for (const e of entries) {
    const check = e.isDir ? e.name.replace(/\/+$/, "") : e.name;
    const rel = safeZipPath(check);
    if (rel === null) return refuse("unsafe-path", `unsafe entry name ${JSON.stringify(e.name)} (absolute, drive letter, backslash or ..)`);
    if (rel.split("/").some((s) => s.toLowerCase() === "saves")) return refuse("unsafe-path", `entry ${JSON.stringify(e.name)} has a saves/ segment`);
    if (isSymlinkEntry(e)) return refuse("symlink", `entry ${JSON.stringify(e.name)} is a symbolic link`);
    if (e.isDir) continue;
    const key = rel.toLowerCase();
    if (seen.has(key)) return refuse("duplicate-path", `entries ${JSON.stringify(seen.get(key))} and ${JSON.stringify(rel)} name the same file on Windows`);
    seen.set(key, rel);
    fileEntries.push({ e, rel });
  }

  // layout: exactly one top folder <name>/ + optionally README-INSTALL.txt and MANIFEST.sha256 at the root
  const tops = new Set<string>();
  for (const { rel } of fileEntries) {
    const segs = rel.split("/");
    if (segs.length === 1) {
      if (rel !== README_INSTALL && rel !== SHA256_MANIFEST) return refuse("layout", `unexpected file at the zip root: ${rel} (only ${README_INSTALL} and ${SHA256_MANIFEST} may sit next to the mod folder)`);
    } else tops.add(segs[0]!);
  }
  if (tops.size !== 1) return refuse("layout", tops.size ? `the zip holds ${tops.size} top folders (${[...tops].join(", ")}); a mod zip holds exactly one, <name>/` : "the zip holds no mod folder");
  const name = [...tops][0]!;

  // read every file (CRC + bomb guard)
  const data = new Map<string, Uint8Array>();
  for (const { e, rel } of fileEntries) {
    try { data.set(rel, readZipEntry(buf, e)); } catch (err) { return refuse("corrupt-entry", errText(err), name); }
  }

  const manText = data.get(`${name}/${MOD_MANIFEST_FILE}`);
  if (!manText) return refuse("manifest-missing", `${name}/${MOD_MANIFEST_FILE} is missing: not a packed mod`, name);
  const parsed = parseModManifest(Buffer.from(manText).toString("utf8"), name);
  if (!parsed.ok) return refuse("manifest-invalid", `${MOD_MANIFEST_FILE}: ${parsed.errors.join("; ")}`, name);
  const manifest = parsed.manifest;

  const notes: string[] = [];
  const sums = data.get(SHA256_MANIFEST);
  if (sums) {
    const listed = parseSha256Manifest(Buffer.from(sums).toString("utf8"));
    if (!listed) return refuse("checksum-mismatch", `${SHA256_MANIFEST} is malformed`, name);
    for (const [rel, bytes] of data) {
      if (rel === SHA256_MANIFEST) continue;
      const want = listed.get(rel);
      if (!want) return refuse("checksum-mismatch", `${rel} is not listed in ${SHA256_MANIFEST}`, name);
      if (sha256(bytes) !== want) return refuse("checksum-mismatch", `${rel} does not match its SHA-256 in ${SHA256_MANIFEST}`, name);
    }
    for (const rel of listed.keys()) if (!data.has(rel)) return refuse("checksum-mismatch", `${SHA256_MANIFEST} lists ${rel}, which is not in the zip`, name);
  } else notes.push(`no ${SHA256_MANIFEST} in the zip: contents not checksum-verified`);

  // the game build
  const installed = opts.installedBuild !== undefined ? opts.installedBuild : installedNativeBuild();
  const build = compareBuild(manifest.gameBuild, installed);
  if (build.status === "unknown") notes.push("no installed Mewgenics.exe found: the game build was not compared");
  if (build.status === "mismatch" && !opts.acceptBuildMismatch) {
    const prompt = `${manifest.name} ${manifest.version}: ${describeMismatch(build)}. ` +
      (manifest.native?.length ? "Its native part will stay disabled on a build the framework does not know; the data part may still load. " : "Data mods usually survive game updates, but entries the update renamed or removed will not resolve. ") +
      "Install anyway?";
    return { ok: false, verdict: "build-mismatch", name, version: manifest.version, build, manifest, prompt };
  }
  if (build.status === "mismatch") notes.push(`installed despite a build mismatch: ${describeMismatch(build)}`);

  // write: a temp sibling, then one rename
  const dest = join(into, name);
  if (!isInside(into, dest) || dest === into) return refuse("unsafe-path", `bad mod folder name: ${name}`, name);
  if (existsSync(dest)) return refuse("exists", `${dest} already exists; remove or rename it first (install never overwrites a mod folder)`, name);
  const tmp = join(into, `.${name}.installing-${randomBytes(4).toString("hex")}`);
  const prefix = `${name}/`;
  const written: string[] = [];
  try {
    mkdirSync(tmp, { recursive: true });
    for (const [rel, bytes] of data) {
      if (!rel.startsWith(prefix)) continue; // README-INSTALL.txt / MANIFEST.sha256 stay out of the mod
      const inner = rel.slice(prefix.length);
      const abs = join(tmp, ...inner.split("/"));
      if (!isInside(tmp, abs) || touchesSaves(abs)) throw new Error(`refusing to write ${abs}`);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, bytes);
      written.push(inner);
    }
    renameSync(tmp, dest);
  } catch (e) {
    // only ever the temp folder this call created (plain files, no junctions)
    if (existsSync(tmp) && isInside(into, tmp)) rmSync(tmp, { recursive: true, force: true });
    return refuse("write-failed", errText(e), name);
  }
  const result: InstallResult = { ok: true, verdict: "installed", name, version: manifest.version, dir: dest, files: written.sort(), build, manifest, notes };
  if (opts.validate !== false) {
    const v = opts.validate ?? ((m: string, d: string) => validateMod(m, undefined, { modDir: d }));
    try { result.report = v(name, dest); } catch (e) { notes.push(`validation after install failed: ${errText(e)}`); }
  }
  return result;
}
