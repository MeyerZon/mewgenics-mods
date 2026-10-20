// Third-party dependency gate, as tests (owner rule: nothing is added without a reviewed, exact pin).
// Ruffle (@ruffle-rs/ruffle, the WASM Flash player) is browser-only: the editor vendors its .js/.wasm into the
// git-ignored web/public/ruffle/ at build time and the page loads it from the same origin with networking off.

import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const EDITOR = join(HERE, "..");

export async function runDepsTests(test: TestFn, assert: AssertFn, eq: EqFn): Promise<void> {
  console.log("\n# dependency gate: exact pins, lock integrity, no install scripts; Ruffle vendoring");
  const pkg = JSON.parse(readFileSync(join(EDITOR, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  const lock = JSON.parse(readFileSync(join(EDITOR, "package-lock.json"), "utf8")) as { packages: Record<string, { version?: string; integrity?: string; hasInstallScript?: boolean }> };

  test("@ruffle-rs/ruffle is a runtime dependency pinned to an exact version (no ^ or ~)", () => {
    const v = pkg.dependencies?.["@ruffle-rs/ruffle"];
    assert(typeof v === "string" && /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v), `pinned exactly: ${v}`);
  });
  test("the lock carries @ruffle-rs/ruffle with an sha512 integrity, the pinned version and no install script", () => {
    const e = lock.packages["node_modules/@ruffle-rs/ruffle"];
    assert(!!e, "in the lock");
    eq(e!.version, pkg.dependencies?.["@ruffle-rs/ruffle"]);
    assert(/^sha512-/.test(e!.integrity || ""), `integrity: ${e!.integrity}`);
    assert(e!.hasInstallScript !== true, "no install script");
  });

  let vendor: { vendorRuffle?: (src: string, dst: string) => { copied: string[] } } = {};
  let loadErr = "";
  try { vendor = await import("../scripts/vendor-ruffle.ts"); } catch (e) { loadErr = e instanceof Error ? e.message : String(e); }
  test("vendorRuffle(src, dst) copies only the runtime files (*.js, *.wasm, LICENSE*) — no source maps, README or package.json", () => {
    assert(typeof vendor.vendorRuffle === "function", `scripts/vendor-ruffle.ts exports vendorRuffle: ${loadErr}`);
    const src = mkdtempSync(join(tmpdir(), "ruffle-src-"));
    const dst = join(mkdtempSync(join(tmpdir(), "ruffle-dst-")), "ruffle");
    for (const f of ["ruffle.js", "ruffle.js.map", "core.ruffle.abc.js", "core.ruffle.abc.js.map", "x1.wasm", "LICENSE_MIT", "LICENSE_APACHE", "README.md", "package.json"]) writeFileSync(join(src, f), f);
    const r = vendor.vendorRuffle!(src, dst);
    eq(r.copied.slice().sort().join(","), ["LICENSE_APACHE", "LICENSE_MIT", "core.ruffle.abc.js", "ruffle.js", "x1.wasm"].sort().join(","));
    eq(readdirSync(dst).sort().join(","), r.copied.slice().sort().join(","));
    eq(readFileSync(join(dst, "x1.wasm"), "utf8"), "x1.wasm");
    rmSync(src, { recursive: true, force: true });
    rmSync(dirname(dst), { recursive: true, force: true });
  });
  test("vendorRuffle replaces a previous vendored copy (stale files of an older version are removed)", () => {
    assert(typeof vendor.vendorRuffle === "function", "exported");
    const src = mkdtempSync(join(tmpdir(), "ruffle-src-"));
    const dst = join(mkdtempSync(join(tmpdir(), "ruffle-dst-")), "ruffle");
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(dst, "old.wasm"), "old");
    writeFileSync(join(src, "ruffle.js"), "new");
    vendor.vendorRuffle!(src, dst);
    assert(!existsSync(join(dst, "old.wasm")) && existsSync(join(dst, "ruffle.js")), readdirSync(dst).join(","));
    rmSync(src, { recursive: true, force: true });
    rmSync(dirname(dst), { recursive: true, force: true });
  });
  test("npm run build vendors Ruffle before Vite; web/public/ruffle/ is git-ignored; the server serves .wasm as application/wasm", () => {
    const scripts = (JSON.parse(readFileSync(join(EDITOR, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    assert(/vendor-ruffle\.ts.*vite build/.test(scripts.build || ""), `build: ${scripts.build}`);
    const ignore = readFileSync(join(EDITOR, "..", ".gitignore"), "utf8");
    assert(/^editor\/web\/public\/ruffle\/?$/m.test(ignore), "gitignore line");
    assert(/"\.wasm":\s*"application\/wasm"/.test(readFileSync(join(EDITOR, "web", "server.ts"), "utf8")), "MIME .wasm");
  });
}
