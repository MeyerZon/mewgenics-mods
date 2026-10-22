// VectorCraft headless, for agents (MCP vectorcraft_exec): the vendored web build (scripts/vendor-vectorcraft.ts →
// web/public/vectorcraft/) is served from a throwaway loopback static server, opened in Playwright's headless
// Chromium (a devDependency; SwiftShader WebGL2, like the e2e suite), and driven through window.vectorcraft with
// one page.evaluate per call (vectorcraft-exec.ts runs the plan). The shape goes in as the SVG svg-export.ts
// writes and comes back through svg-reorigin.ts + importSvgIntoScene, exactly like the Art-mode tab's Apply.
// Refuses (ok:false, skipped:true, reason) when the build is not vendored, when Playwright or its Chromium is
// absent — never installs anything. Nothing is launched before the scene and shape are checked.

import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import type { Browser, Page } from "@playwright/test";
import { EDITOR_DIR, DATA_CACHE_DIR } from "../repo.ts";
import { readArtScene, importSvgIntoScene } from "./art-io.ts";
import { shapeToSvg } from "./svg-export.ts";
import { parseViewBox, reoriginSvg } from "./svg-reorigin.ts";
import { runVectorcraftPlan } from "./vectorcraft-exec.ts";
import type { VcDriver, VcCommand, VcCommandResult, VcDocument } from "./vectorcraft-exec.ts";
import type { Finding } from "./scene.ts";

export const VENDORED_DIR = join(EDITOR_DIR, "web", "public", "vectorcraft");
/** The same flags playwright.config.ts gives the e2e browser: WebGL through SwiftShader in headless. */
export const HEADLESS_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];

export function isVectorcraftVendored(dir = VENDORED_DIR): { ok: boolean; reason?: string; dir: string; version?: string } {
  const manifest = join(dir, "VENDORED.json");
  if (!existsSync(manifest) || !existsSync(join(dir, "index.html"))) {
    return { ok: false, dir, reason: `VectorCraft is not vendored (${manifest} missing): cd editor && npm run build once while online (scripts/vendor-vectorcraft.ts downloads the pinned web build)` };
  }
  try {
    const m = JSON.parse(readFileSync(manifest, "utf8")) as { version?: string };
    return { ok: true, dir, version: typeof m.version === "string" ? m.version : undefined };
  } catch (e) {
    return { ok: false, dir, reason: `VENDORED.json unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".ttf": "font/ttf",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

/** Serve `dir` under /vectorcraft/ on a free loopback port (the app's URLs are relative, so the prefix is kept). */
function serveVendored(dir: string): Promise<{ port: number; close: () => Promise<void> }> {
  const root = normalize(dir);
  const server = createServer((req, res) => {
    const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    if (!pathname.startsWith("/vectorcraft/")) { res.writeHead(404); res.end("not found"); return; }
    const abs = normalize(join(root, pathname.slice("/vectorcraft/".length)));
    if (!abs.startsWith(root) || !existsSync(abs) || !statSync(abs).isFile()) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[extname(abs).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(readFileSync(abs));
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      resolve({ port, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

/** window.vectorcraft as a driver: one page.evaluate per call; an in-page rejection becomes a rejected promise here. */
function pageDriver(page: Page): VcDriver {
  type W = Window & { vectorcraft: { request(m: string, p: unknown): Promise<unknown>; execute(c: string, p: unknown): Promise<unknown>; inspect(): Promise<unknown>; openFile(n: string, b: Uint8Array): boolean; screenshot(): Promise<{ base64: string; width?: number; height?: number }> } };
  return {
    request: (method, params) => page.evaluate(([m, p]) => (window as unknown as W).vectorcraft.request(m as string, p), [method, params ?? {}] as const),
    execute: (command, params) => page.evaluate(([c, p]) => (window as unknown as W).vectorcraft.execute(c as string, p), [command, params ?? {}] as const),
    inspect: () => page.evaluate(() => (window as unknown as W).vectorcraft.inspect()) as Promise<{ documents?: VcDocument[] }>,
    openSvg: (name, svg) => page.evaluate(([n, s]) => (window as unknown as W).vectorcraft.openFile(n as string, new TextEncoder().encode(s as string)), [name, svg] as const),
    // the app's own ui.screenshot on the web build answers { width, height } without image data (observed on v0.14.0),
    // so the PNG is Playwright's capture of the page — the canvas is the whole page
    screenshot: async () => {
      const png = await page.screenshot({ type: "png" });
      const vp = page.viewportSize();
      return { base64: png.toString("base64"), width: vp?.width, height: vp?.height };
    },
  };
}

export interface HeadlessOptions {
  /** how long to wait for window.vectorcraft after the page loads (default 120000) */
  timeoutMs?: number;
  /** force the WebGL2 backend (default true: WebGPU is absent in headless anyway) */
  webgl?: boolean;
  dir?: string;
}

export type HeadlessOutcome<T> = { ok: true; value: T; version?: string } | { ok: false; skipped: true; reason: string };

/** Boot the vendored app headlessly, hand `fn` a driver, tear everything down. */
export async function withHeadlessVectorcraft<T>(fn: (api: VcDriver, page: Page) => Promise<T>, o: HeadlessOptions = {}): Promise<HeadlessOutcome<T>> {
  const vendored = isVectorcraftVendored(o.dir);
  if (!vendored.ok) return { ok: false, skipped: true, reason: vendored.reason! };
  let chromium: typeof import("@playwright/test")["chromium"];
  try {
    chromium = (await import("@playwright/test")).chromium;
  } catch (e) {
    return { ok: false, skipped: true, reason: `Playwright is not installed (a devDependency: npm install in editor/): ${e instanceof Error ? e.message : String(e)}` };
  }
  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: true, args: HEADLESS_ARGS });
  } catch (e) {
    return { ok: false, skipped: true, reason: `Playwright's Chromium could not start (npx playwright install chromium, once, by the owner): ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}` };
  }
  const server = await serveVendored(vendored.dir);
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${server.port}/vectorcraft/index.html${(o.webgl ?? true) ? "?webgl" : ""}`, { waitUntil: "load" });
    await page.waitForFunction(() => !!(window as unknown as { vectorcraft?: unknown }).vectorcraft, null, { timeout: o.timeoutMs ?? 120_000, polling: 250 });
    const value = await fn(pageDriver(page), page);
    return { ok: true, value, version: vendored.version };
  } finally {
    await browser.close().catch(() => undefined);
    await server.close();
  }
}

export interface VectorcraftExecArgs {
  mod: string;
  /** scene file inside the mod */
  scenePath: string;
  /** the shape to open first; omit to start from a blank artboard of the stage size */
  shapeId?: string;
  commands: VcCommand[];
  /** the shape the exported drawing replaces (default shapeId); omit together with shapeId to only get the SVG back */
  exportTo?: string;
  screenshot?: boolean;
  continueOnError?: boolean;
  timeoutMs?: number;
  webgl?: boolean;
}

export interface VectorcraftExecResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
  opened: boolean;
  results: VcCommandResult[];
  documents: VcDocument[];
  /** what was opened: the shape's SVG viewBox the re-origin undoes */
  viewBox?: number[];
  reorigin?: { dx: number; dy: number };
  applied?: { shapeId: string; paths: number; findings: Finding[] };
  /** the exported SVG text when nothing was applied (no target shape) */
  svg?: string;
  svgBytes?: number;
  screenshotPath?: string;
  version?: string;
  ms: number;
}

/** MCP vectorcraft_exec: open a shape (or a blank artboard), run commands, export, re-origin, replace the shape. */
export async function vectorcraftExec(a: VectorcraftExecArgs): Promise<VectorcraftExecResult> {
  const t0 = Date.now();
  const fail = (error: string): VectorcraftExecResult => ({ ok: false, error, opened: false, results: [], documents: [], ms: Date.now() - t0 });
  const rd = readArtScene(a.mod, a.scenePath);
  if (!rd.ok || !rd.scene) return fail(rd.error || `scene ${a.scenePath} does not validate`);
  const scene = rd.scene;
  const target = a.exportTo ?? a.shapeId;
  if (target !== undefined && !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(target)) return fail(`bad shape id ${JSON.stringify(target)}`);
  let svg: string | undefined;
  let viewBox: number[] | undefined;
  let name: string | undefined;
  if (a.shapeId !== undefined) {
    const shape = scene.shapes[a.shapeId];
    if (!shape) return fail(`no shape "${a.shapeId}" in ${a.scenePath} (shapes: ${Object.keys(scene.shapes).join(", ") || "none"})`);
    const out = shapeToSvg(shape, scene.gradients || {});
    svg = out.svg;
    viewBox = parseViewBox(out.svg) || undefined;
    name = `${a.shapeId}.svg`;
  } else if (target !== undefined) {
    const w = scene.stage?.width || 1280;
    const h = scene.stage?.height || 720;
    svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"></svg>\n`;
    viewBox = [0, 0, w, h];
    name = `${target}.svg`;
  }
  const run = await withHeadlessVectorcraft((api) => runVectorcraftPlan(api, { svg, name, commands: a.commands, export: true, screenshot: !!a.screenshot, continueOnError: !!a.continueOnError }), { timeoutMs: a.timeoutMs, webgl: a.webgl });
  if (!run.ok) return { ok: false, skipped: true, reason: run.reason, opened: false, results: [], documents: [], ms: Date.now() - t0 };
  const plan = run.value;
  const res: VectorcraftExecResult = { ok: plan.ok, error: plan.error, opened: plan.opened, results: plan.results, documents: plan.documents, viewBox, version: run.version, ms: 0 };
  if (plan.svg !== undefined) {
    res.svgBytes = plan.svg.length;
    if (target !== undefined && viewBox) {
      const re = reoriginSvg(plan.svg, viewBox);
      res.reorigin = { dx: re.dx, dy: re.dy };
      const imp = importSvgIntoScene({ mod: a.mod, scenePath: a.scenePath, shapeId: target, svgText: re.svg, options: { applyViewBox: false }, replace: true });
      if (!imp.ok) { res.ok = false; res.error = `apply to shape "${target}" failed: ${imp.error}`; }
      res.applied = { shapeId: target, paths: imp.paths ?? 0, findings: imp.findings };
    } else {
      res.svg = plan.svg;
    }
  }
  if (plan.screenshotBase64) {
    const dir = join(DATA_CACHE_DIR, "vectorcraft");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const p = join(dir, `${stamp}-${(target || "document").replace(/[^A-Za-z0-9_.-]/g, "_")}.png`);
    writeFileSync(p, Buffer.from(plan.screenshotBase64, "base64"));
    res.screenshotPath = p;
  }
  res.ms = Date.now() - t0;
  return res;
}
