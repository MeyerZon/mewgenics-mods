// The VectorCraft command pipeline, browser-agnostic: open an SVG as a document, run engine commands through the
// app's control API, export the document as SVG, optionally screenshot. Talks to a small driver interface so it
// runs the same over window.vectorcraft inside a page (vectorcraft-headless.ts wraps page.evaluate per call)
// and over a fake in tests. No Node imports: base64 is decoded with atob + TextDecoder.
//
// The API it drives (apps/vectorcraft-web/src/api.rs of github.com/storytold/vectorcraft): request(method,
// params) is any control-protocol method (app.export, document.inspect, ui.inspect, …), execute(command, params)
// = request("engine.execute") over the ~1,090 engine commands (shape.rectangle { x, y, width, height },
// path.create { d }, object.move { dx, dy }, …; `commands()` lists them with their params), openFile(name,
// bytes) queues the file like a drop — the document appears asynchronously, which is why the plan polls
// ui.inspect for a document with that title before the first command.

export interface VcDocument { dirty: boolean; title: string }
export interface VcInspect { activeDocument?: number; documents?: VcDocument[]; [k: string]: unknown }

/** What the pipeline needs from VectorCraft (a page driver or a fake). */
export interface VcDriver {
  request(method: string, params?: unknown): Promise<unknown>;
  execute(command: string, params?: unknown): Promise<unknown>;
  inspect(): Promise<VcInspect>;
  /** openFile(name, utf-8 bytes of svg); true when queued */
  openSvg(name: string, svg: string): Promise<boolean>;
  screenshot(): Promise<{ base64: string; width?: number; height?: number }>;
}

/** The export we ask for: presentation attributes (what svg-import.ts reads) and text as outlines. */
export const VC_EXPORT_SVG = { format: "svg", svg: { styling: "presentation", outlineText: true } } as const;

export interface VcCommand { command: string; params?: Record<string, unknown> }

export interface VcPlan {
  /** open this SVG first (as `name`, default "shape.svg"); without it the commands run against whatever is open */
  svg?: string;
  name?: string;
  commands: VcCommand[];
  /** export the document as SVG at the end (default true) */
  export?: boolean;
  /** also take a screenshot of the canvas (default false) */
  screenshot?: boolean;
  /** keep running after a failed command (default false: stop, no export) */
  continueOnError?: boolean;
  /** how long to wait for the opened document to be listed (default 15000) */
  openTimeoutMs?: number;
}

export interface VcCommandResult { command: string; ok: boolean; result?: unknown; error?: string }

export interface VcPlanResult {
  /** every command ran and succeeded (and the open, when asked for, happened) */
  ok: boolean;
  opened: boolean;
  results: VcCommandResult[];
  /** the exported SVG text (when export was asked for and reached) */
  svg?: string;
  screenshotBase64?: string;
  /** ui.inspect's documents at the end */
  documents: VcDocument[];
  error?: string;
}

export interface VcPlanHooks {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Run a plan against a driver. Never throws for app-side failures: they land in `results` / `error`. */
export async function runVectorcraftPlan(api: VcDriver, plan: VcPlan, hooks: VcPlanHooks = {}): Promise<VcPlanResult> {
  const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = hooks.now ?? (() => Date.now());
  const out: VcPlanResult = { ok: true, opened: false, results: [], documents: [] };
  const listDocs = async (): Promise<VcDocument[]> => {
    try { return ((await api.inspect()).documents || []).slice(); } catch { return []; }
  };
  if (plan.svg !== undefined) {
    const name = plan.name || "shape.svg";
    let queued = false;
    try { queued = await api.openSvg(name, plan.svg); } catch (e) { out.error = `openFile(${name}) failed: ${e instanceof Error ? e.message : String(e)}`; }
    if (!queued) {
      out.ok = false;
      out.error = out.error || `VectorCraft did not queue ${name} (openFile returned false)`;
      out.documents = await listDocs();
      return out;
    }
    const t0 = now();
    const limit = plan.openTimeoutMs ?? 15_000;
    while (!out.opened) {
      const docs = await listDocs();
      if (docs.some((d) => d.title === name)) { out.opened = true; break; }
      if (now() - t0 > limit) break;
      await sleep(200);
    }
    if (!out.opened) {
      out.ok = false;
      out.error = `VectorCraft did not open ${name} within ${limit} ms (no document with that title)`;
      out.documents = await listDocs();
      return out;
    }
  }
  for (const c of plan.commands) {
    try {
      const result = await api.execute(c.command, c.params ?? {});
      out.results.push({ command: c.command, ok: true, result });
    } catch (e) {
      out.results.push({ command: c.command, ok: false, error: e instanceof Error ? e.message : String(e) });
      out.ok = false;
      if (!plan.continueOnError) {
        out.error = `command ${out.results.length} (${c.command}) failed; the rest did not run`;
        out.documents = await listDocs();
        return out;
      }
    }
  }
  if (plan.export ?? true) {
    try {
      const r = (await api.request("app.export", VC_EXPORT_SVG)) as { dataBase64?: unknown };
      if (!r || typeof r.dataBase64 !== "string") throw new Error(`app.export returned no dataBase64 (${JSON.stringify(r).slice(0, 200)})`);
      out.svg = decodeBase64Utf8(r.dataBase64);
    } catch (e) {
      out.ok = false;
      out.error = `export failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  if (plan.screenshot) {
    try { out.screenshotBase64 = (await api.screenshot()).base64; } catch (e) { out.error = out.error || `screenshot failed: ${e instanceof Error ? e.message : String(e)}`; }
  }
  out.documents = await listDocs();
  return out;
}
