// VectorCraft (github.com/storytold/vectorcraft, MIT OR Apache-2.0) embedded in Art mode as a same-origin <iframe>
// over the web build that scripts/vendor-vectorcraft.ts vendors into web/public/vectorcraft/ (upstream HOSTING.md:
// the app installs capture-phase pointer / paste listeners on its window and draws every panel into one canvas,
// so an iframe is the supported embedding). Being same-origin, `iframe.contentWindow.vectorcraft` is the app's
// promise API — the same JSON control protocol as its desktop control port and MCP server:
//   request(method, params)   any control method (app.export, document.inspect, ui.inspect, …)
//   execute(command, params)  = request("engine.execute", …): any of the ~1,090 engine commands (shape.rectangle, path.create, …)
//   inspect()                 = request("ui.inspect") → { documents: [{ dirty, title }], tool, … }
//   openFile(name, bytes)     queued like a dropped file (boolean: queued); the document appears asynchronously
//   screenshot()              the canvas as PNG { base64, width, height }
// Verified on the vendored v0.14.0 build (test/fixtures/vectorcraft/README.md): app.export without a path returns
// { dataBase64, format, bytes, warnings } — no browser download, so captureDownloads() is not needed.
// Static drawing only: one shape goes in as the SVG svg-export.ts writes and comes back through svg-import.ts;
// animation stays in the Timeline tab.

export interface VcDocument { dirty: boolean; title: string }
export interface VcInspect { activeDocument?: number; documents?: VcDocument[]; [k: string]: unknown }
export interface VcExport { dataBase64?: string; format?: string; bytes?: number; warnings?: unknown[] }
export interface VcApi {
  request(method: string, params?: unknown): Promise<unknown>;
  execute(command: string, params?: unknown): Promise<unknown>;
  commands(): Promise<unknown[]>;
  inspect(): Promise<VcInspect>;
  screenshot(params?: unknown): Promise<{ base64: string; width: number; height: number }>;
  openFile(name: string, bytes: Uint8Array): boolean;
  captureDownloads(on: boolean): void;
  files(): string[];
  readFile(name: string): Uint8Array;
}

/** Served from the editor's own origin (Vite copies web/public/ into dist/; web/server.ts serves .wasm / .ttf with the right MIME). */
export const VECTORCRAFT_DIR = "./vectorcraft/";
/** The export we ask for: presentation attributes (what svg-import.ts reads) and text as outlines. */
export const VC_EXPORT_SVG = { format: "svg", svg: { styling: "presentation", outlineText: true } } as const;

/** The iframe URL; `?webgl` forces the WebGL2 backend when WebGPU misbehaves (upstream HOSTING.md). */
export function vectorcraftUrl(o: { webgl?: boolean } = {}): string {
  return `${VECTORCRAFT_DIR}index.html${o.webgl ? "?webgl" : ""}`;
}

/** Is the web build vendored (VENDORED.json next to it)? */
export async function isVendored(): Promise<boolean> {
  try {
    const r = await fetch(`${VECTORCRAFT_DIR}VENDORED.json`, { cache: "no-store" });
    if (!r.ok) return false;
    const j = (await r.json()) as { version?: unknown };
    return !!j && typeof j.version === "string";
  } catch {
    return false;
  }
}

/** The app's API on a same-origin iframe, or null while it is still booting (installed after TrunkApplicationStarted). */
export function apiOf(frame: HTMLIFrameElement | null): VcApi | null {
  try {
    const w = frame?.contentWindow as (Window & { vectorcraft?: VcApi }) | null | undefined;
    return w && w.vectorcraft && typeof w.vectorcraft.request === "function" ? w.vectorcraft : null;
  } catch {
    return null;
  }
}

/** Poll until `window.vectorcraft` exists in the iframe (the 74 MB wasm compiles first; allow a minute or more). */
export function waitForApi(frame: HTMLIFrameElement, timeoutMs = 90_000, pollMs = 250): Promise<VcApi> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const api = apiOf(frame);
      if (api) return resolve(api);
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`VectorCraft did not start within ${Math.round(timeoutMs / 1000)} s`));
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

/** Open an SVG string as a document named `name`; resolves once a document with that title is listed (or the wait runs out). */
export async function openSvg(api: VcApi, name: string, svg: string, waitMs = 15_000): Promise<boolean> {
  const queued = api.openFile(name, new TextEncoder().encode(svg));
  if (!queued) return false;
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    try {
      const i = await api.inspect();
      if ((i.documents || []).some((d) => d.title === name)) return true;
    } catch { /* not running yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** The active document as SVG text (app.export with no path hands the bytes back as base64). */
export async function exportSvg(api: VcApi): Promise<string> {
  const r = (await api.request("app.export", VC_EXPORT_SVG)) as VcExport;
  if (!r || typeof r.dataBase64 !== "string") throw new Error(`app.export returned no dataBase64 (${JSON.stringify(r).slice(0, 200)})`);
  const bin = atob(r.dataBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Has any open document unsaved edits? (`ui.inspect` → documents[].dirty; the app has no change events, so hosts poll.) */
export async function isDirty(api: VcApi): Promise<boolean> {
  const i = await api.inspect();
  return (i.documents || []).some((d) => d.dirty === true);
}
