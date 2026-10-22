// Vendor VectorCraft's prebuilt web build (github.com/storytold/vectorcraft, MIT OR Apache-2.0) into the
// git-ignored web/public/vectorcraft/, which Vite copies into dist/ and the dev server serves as-is; the Art mode
// VectorCraft tab embeds it as a same-origin <iframe>. Owner decision 2026-10-22: `npm run build` may download the
// ONE pinned release asset below from GitHub Releases — nothing is installed on the machine, and the download is
// verified (exact size, then SHA-256) BEFORE a single byte is extracted. The zip is unpacked with the small reader
// in src/core/zip.ts (Node built-ins only: node:zlib inflateRawSync over the central directory, CRC-32 checked, no
// path escapes, no zip64), and the licence texts (LICENSE-*, NOTICE, OFL-*.txt, licenses/**, fonts/**/OFL.txt)
// travel with the runtime. VENDORED.json records { version, sha256, date, files[{ path, bytes, sha256 }] }.
//
//   node scripts/vendor-vectorcraft.ts            vendor (skips when VENDORED.json already matches the pin, or
//                                                 offline with no cached zip — a plain `npm run build` still works)
//   node scripts/vendor-vectorcraft.ts --check    re-hash the extracted files against VENDORED.json (exit 1 on drift)
//
// The verified zip is cached in editor/data/vendor/ (or $MEWGENICS_EDITOR_DATA/vendor/), so a rebuild never
// downloads twice. Run by `npm run build` / `dev` / `test:e2e` right after vendor-ruffle.ts.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { get as httpsGet } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_CACHE_DIR } from "../src/core/repo.ts";
import { listZip, readZipEntry, safeZipPath } from "../src/core/zip.ts";
import type { ZipEntry } from "../src/core/zip.ts";

export interface VcPin {
  version: string;
  /** exact byte length of the release zip */
  bytes: number;
  /** lower-case hex SHA-256 of the release zip (from the release's SHA256SUMS.txt) */
  sha256: string;
  url: string;
}

/** The one approved build. Bump all four together, from the release's SHA256SUMS.txt + asset size. */
export const VECTORCRAFT_PIN: VcPin = {
  version: "0.14.0",
  bytes: 27_734_185,
  sha256: "6f28a8bcee1c5ad6c37c6a0c44058793a40ea4443085866d5f78afb16aba075e",
  url: "https://github.com/storytold/vectorcraft/releases/download/v0.14.0/vectorcraft-web-0.14.0.zip",
};

export const MANIFEST_NAME = "VENDORED.json";

export interface VendoredFile { path: string; bytes: number; sha256: string }
export interface VendoredManifest { version: string; sha256: string; bytes?: number; url?: string; date: string; files: VendoredFile[] }

// ---- hashing ---------------------------------------------------------------------------------------------------
export function sha256Hex(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}
/** Size first (cheap, and a truncated download is the common failure), then SHA-256. */
export function verifyPinnedZip(buf: Uint8Array, pin: VcPin): { ok: true } | { ok: false; reason: string } {
  if (buf.length !== pin.bytes) return { ok: false, reason: `size ${buf.length} bytes, expected ${pin.bytes}` };
  const h = sha256Hex(buf);
  if (h !== pin.sha256.toLowerCase()) return { ok: false, reason: `SHA-256 ${h} does not match the pinned ${pin.sha256}` };
  return { ok: true };
}

// ---- the zip reader lives in src/core/zip.ts (shared with pack / install); re-exported for this script's callers ----
export { crc32, listZip, readZipEntry, safeZipPath } from "../src/core/zip.ts";
export type { ZipEntry } from "../src/core/zip.ts";

/** Unpack every file of `buf` under `dst` (release folder stripped). Refuses the whole archive before writing anything when an entry is unsafe. */
export function extractZip(buf: Uint8Array, dst: string, opts: { strip?: string } = {}): { files: VendoredFile[] } {
  const strip = opts.strip ?? "";
  const plan: { e: ZipEntry; rel: string }[] = [];
  for (const e of listZip(buf)) {
    if (e.isDir) continue;
    const rel = safeZipPath(e.name, strip);
    if (rel === null) throw new Error(`refused zip entry "${e.name}" (path escape, or outside ${JSON.stringify(strip || "/")})`);
    plan.push({ e, rel });
  }
  const files: VendoredFile[] = [];
  mkdirSync(dst, { recursive: true });
  for (const { e, rel } of plan) {
    const bytes = readZipEntry(buf, e);
    const abs = join(dst, ...rel.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
    files.push({ path: rel, bytes: bytes.length, sha256: sha256Hex(bytes) });
  }
  return { files };
}

// ---- download (node:https, follows GitHub's redirect to the objects host) ---------------------------------------
export function downloadBuffer(url: string, opts: { maxBytes?: number; maxRedirects?: number; timeoutMs?: number } = {}): Promise<Buffer> {
  const maxBytes = opts.maxBytes ?? 256 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 5;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return new Promise((resolve, reject) => {
    const go = (u: string, hops: number) => {
      const req = httpsGet(u, { headers: { "User-Agent": "mewgenics-mod-editor vendor-vectorcraft", Accept: "application/octet-stream" } }, (res) => {
        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume();
          if (hops >= maxRedirects) return reject(new Error(`too many redirects fetching ${url}`));
          return go(new URL(res.headers.location, u).toString(), hops + 1);
        }
        if (status !== 200) { res.resume(); return reject(new Error(`HTTP ${status} fetching ${u}`)); }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total > maxBytes) { req.destroy(new Error(`response exceeds ${maxBytes} bytes`)); return; }
          chunks.push(c);
        });
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs} ms fetching ${u}`)));
      req.on("error", reject);
    };
    go(url, 0);
  });
}

// ---- the vendor flow -------------------------------------------------------------------------------------------
export interface VendorOptions {
  pin?: VcPin;
  /** web/public/vectorcraft */
  dst: string;
  /** where the verified zip is kept between builds (optional) */
  cacheDir?: string;
  download?: (url: string) => Promise<Buffer>;
  log?: (line: string) => void;
}
export interface VendorResult {
  status: "vendored" | "already" | "skipped";
  dst: string;
  version: string;
  source?: "download" | "cache";
  files?: number;
  reason?: string;
}

export function readVendoredManifest(dst: string): VendoredManifest | null {
  const p = join(dst, MANIFEST_NAME);
  if (!existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, "utf8")) as VendoredManifest;
    if (!m || typeof m.version !== "string" || typeof m.sha256 !== "string" || !Array.isArray(m.files)) return null;
    return m;
  } catch {
    return null;
  }
}

export async function vendorVectorcraft(o: VendorOptions): Promise<VendorResult> {
  const pin = o.pin ?? VECTORCRAFT_PIN;
  const log = o.log ?? ((s: string) => console.log(s));
  const download = o.download ?? ((u: string) => downloadBuffer(u, { maxBytes: pin.bytes + 1 }));
  const skip = (reason: string): VendorResult => {
    log(`(skipped: VectorCraft not vendored — ${reason}; the Art mode VectorCraft tab shows a hint until \`npm run build\` succeeds online)`);
    return { status: "skipped", dst: o.dst, version: pin.version, reason };
  };
  const have = readVendoredManifest(o.dst);
  if (have && have.version === pin.version && have.sha256 === pin.sha256 && have.files.every((f) => existsSync(join(o.dst, ...f.path.split("/"))))) {
    log(`VectorCraft ${pin.version} already vendored (${have.files.length} files in ${o.dst})`);
    return { status: "already", dst: o.dst, version: pin.version, files: have.files.length };
  }
  const cachePath = o.cacheDir ? join(o.cacheDir, `vectorcraft-web-${pin.version}.zip`) : null;
  let buf: Buffer | null = null;
  let source: "download" | "cache" = "download";
  if (cachePath && existsSync(cachePath)) {
    const b = readFileSync(cachePath);
    if (verifyPinnedZip(b, pin).ok) { buf = b; source = "cache"; }
    else { log(`cached ${cachePath} does not match the pin; discarding it`); rmSync(cachePath, { force: true }); }
  }
  if (!buf) {
    log(`downloading VectorCraft ${pin.version} web build (${pin.bytes} bytes) from ${pin.url}`);
    let b: Buffer;
    try { b = await download(pin.url); } catch (e) { return skip(`download failed: ${e instanceof Error ? e.message : String(e)}`); }
    const v = verifyPinnedZip(b, pin);
    if (!v.ok) return skip(`downloaded zip rejected before extraction: ${v.reason}`);
    buf = b;
    if (cachePath) {
      try { mkdirSync(dirname(cachePath), { recursive: true }); writeFileSync(cachePath, b); } catch (e) { log(`could not cache the zip: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }
  // unpack next to the destination, then swap, so a failed extraction never leaves a half-vendored folder
  const tmp = o.dst + ".tmp";
  rmSync(tmp, { recursive: true, force: true });
  let files: VendoredFile[];
  try {
    files = extractZip(buf, tmp, { strip: `vectorcraft-web-${pin.version}/` }).files;
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    return skip(`extraction failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const manifest: VendoredManifest = { version: pin.version, sha256: pin.sha256, bytes: pin.bytes, url: pin.url, date: new Date().toISOString(), files };
  writeFileSync(join(tmp, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n");
  rmSync(o.dst, { recursive: true, force: true });
  mkdirSync(dirname(o.dst), { recursive: true });
  renameSync(tmp, o.dst);
  const total = files.reduce((s, f) => s + f.bytes, 0);
  log(`vendored VectorCraft ${pin.version}: ${files.length} file(s), ${total} bytes into ${o.dst} (${source})`);
  return { status: "vendored", dst: o.dst, version: pin.version, source, files: files.length };
}

/** `--check`: every file in VENDORED.json is present with its recorded SHA-256. */
export function checkVendored(dst: string): { ok: boolean; reason?: string; missing: string[]; mismatched: string[]; manifest: VendoredManifest | null } {
  const manifest = readVendoredManifest(dst);
  if (!manifest) return { ok: false, reason: `not vendored (no ${MANIFEST_NAME} in ${dst}; run npm run build)`, missing: [], mismatched: [], manifest: null };
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const f of manifest.files) {
    const abs = join(dst, ...f.path.split("/"));
    if (!existsSync(abs)) { missing.push(f.path); continue; }
    if (sha256Hex(readFileSync(abs)) !== f.sha256) mismatched.push(f.path);
  }
  const ok = missing.length === 0 && mismatched.length === 0;
  return { ok, reason: ok ? undefined : `${missing.length} missing, ${mismatched.length} changed`, missing, mismatched, manifest };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const editor = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dst = join(editor, "web", "public", "vectorcraft");
  const dataDir = DATA_CACHE_DIR; // repo.ts: $MEWGENICS_EDITOR_DATA, else editor/data
  if (process.argv.includes("--check")) {
    const r = checkVendored(dst);
    if (r.ok) console.log(`VectorCraft ${r.manifest!.version}: ${r.manifest!.files.length} vendored file(s) verified`);
    else console.log(`VectorCraft vendoring check failed: ${r.reason}${r.missing.length ? `\n  missing: ${r.missing.join(", ")}` : ""}${r.mismatched.length ? `\n  changed: ${r.mismatched.join(", ")}` : ""}`);
    process.exit(r.ok ? 0 : 1);
  }
  await vendorVectorcraft({ dst, cacheDir: join(dataDir, "vendor") });
}
