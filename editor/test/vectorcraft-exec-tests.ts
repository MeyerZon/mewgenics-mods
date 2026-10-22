// The agent channel to VectorCraft: MCP vectorcraft_exec drives the vendored web build's window.vectorcraft API in
// headless Chromium (Playwright, a devDependency — the tool refuses when it or the vendored build is absent).
// The command pipeline (src/core/art/vectorcraft-exec.ts runVectorcraftPlan) is browser-agnostic: it talks to a
// small driver interface, so it is tested here over a fake driver with no browser. One integration test runs the
// real thing (vectorcraftExec on a throwaway scene) and skips with a reason when the build is not vendored.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";
import type { VcDriver, VcPlan } from "../src/core/art/vectorcraft-exec.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODS = join(HERE, "..", "..", "mods");

/** A scripted VectorCraft: documents appear a few inspects after openSvg; commands succeed unless named "boom". */
function fakeDriver(o: { appearAfter?: number; exportSvg?: string; failOpen?: boolean } = {}) {
  const calls: string[] = [];
  const docs: { dirty: boolean; title: string }[] = [];
  let pendingOpen: string | null = null;
  let inspects = 0;
  const api: VcDriver = {
    async request(method, params) {
      calls.push(`request:${method}`);
      if (method === "app.export") {
        const p = params as { format?: string; svg?: { styling?: string; outlineText?: boolean } };
        if (p.format !== "svg" || p.svg?.styling !== "presentation" || p.svg?.outlineText !== true) throw new Error(`unexpected export options ${JSON.stringify(params)}`);
        const text = o.exportSvg ?? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0 L10 0 L10 10 Z" fill="#000000"/></svg>';
        return { dataBase64: Buffer.from(text, "utf8").toString("base64"), format: "svg", bytes: text.length, warnings: [] };
      }
      if (method === "document.inspect") return { objects: 1, layers: [] };
      throw new Error(`unknown method ${method}`);
    },
    async execute(command, params) {
      calls.push(`execute:${command}:${JSON.stringify(params ?? null)}`);
      if (command === "boom") throw new Error("unknown command `boom`");
      if (docs[0]) docs[0].dirty = true;
      return { id: calls.length };
    },
    async inspect() {
      calls.push("inspect");
      inspects++;
      if (pendingOpen && inspects >= (o.appearAfter ?? 2)) { docs.push({ dirty: false, title: pendingOpen }); pendingOpen = null; }
      return { activeDocument: 0, documents: docs.slice() };
    },
    async openSvg(name, svg) {
      calls.push(`openSvg:${name}:${svg.length}`);
      if (o.failOpen) return false;
      pendingOpen = name;
      return true;
    },
    async screenshot() {
      calls.push("screenshot");
      return { base64: Buffer.from("\x89PNG\r\n\x1a\nfake").toString("base64"), width: 1, height: 1 };
    },
  };
  return { api, calls, docs };
}
const noSleep = async () => undefined;

export async function runVectorcraftExecTests(test: TestFn, assert: AssertFn, eq: EqFn): Promise<void> {
  console.log("\n# VectorCraft agent channel: the command pipeline over a fake driver, the MCP tool, one headless run (skips when not vendored)");
  type Exec = typeof import("../src/core/art/vectorcraft-exec.ts");
  type Headless = typeof import("../src/core/art/vectorcraft-headless.ts");
  let ex: Exec | null = null;
  let hl: Headless | null = null;
  let loadErr = "";
  try { ex = await import("../src/core/art/vectorcraft-exec.ts"); hl = await import("../src/core/art/vectorcraft-headless.ts"); } catch (e) { loadErr = e instanceof Error ? e.message : String(e); }
  test("src/core/art/vectorcraft-exec.ts exports runVectorcraftPlan + VC_EXPORT_SVG; vectorcraft-headless.ts exports vectorcraftExec + isVectorcraftVendored", () => {
    assert(!!ex && !!hl, loadErr);
    assert(typeof ex!.runVectorcraftPlan === "function" && ex!.VC_EXPORT_SVG.format === "svg", "exec exports");
    assert(typeof hl!.vectorcraftExec === "function" && typeof hl!.isVectorcraftVendored === "function", "headless exports");
  });
  if (!ex || !hl) return;
  const { runVectorcraftPlan } = ex;

  // ---- the pipeline over a fake driver -------------------------------------------------------------------------
  {
    const f = fakeDriver();
    const plan: VcPlan = { svg: "<svg/>", name: "body.svg", commands: [{ command: "shape.rectangle", params: { x: 0, y: 0, width: 10, height: 10 } }, { command: "path.create", params: { d: "M0 0 L1 1" } }], export: true, screenshot: true };
    const r = await runVectorcraftPlan(f.api, plan, { sleep: noSleep });
    test("runVectorcraftPlan: openSvg, wait for the titled document, run the commands in order, export SVG (presentation + outlineText), screenshot, final inspect", () => {
      eq(r.opened, true, "opened");
      eq(r.results.length, 2);
      assert(r.results.every((x) => x.ok), JSON.stringify(r.results));
      eq(r.results[0]!.command, "shape.rectangle");
      assert(/^<svg/.test(r.svg || ""), `svg text decoded from dataBase64: ${r.svg}`);
      assert(typeof r.screenshotBase64 === "string" && r.screenshotBase64.length > 0, "screenshot");
      eq(r.documents.length, 1); eq(r.documents[0]!.title, "body.svg"); eq(r.documents[0]!.dirty, true);
      const order = f.calls.filter((c) => !c.startsWith("inspect"));
      eq(order[0], "openSvg:body.svg:6");
      assert(order.indexOf("execute:shape.rectangle:{\"x\":0,\"y\":0,\"width\":10,\"height\":10}") < order.indexOf("execute:path.create:{\"d\":\"M0 0 L1 1\"}"), order.join(" | "));
      assert(order.indexOf("execute:path.create:{\"d\":\"M0 0 L1 1\"}") < order.indexOf("request:app.export"), "export after the commands");
      assert(f.calls.indexOf("inspect") < f.calls.indexOf("execute:shape.rectangle:{\"x\":0,\"y\":0,\"width\":10,\"height\":10}"), "the document is awaited before the first command");
    });
  }
  {
    const f = fakeDriver();
    const r = await runVectorcraftPlan(f.api, { svg: "<svg/>", name: "a.svg", commands: [{ command: "shape.rectangle", params: {} }, { command: "boom" }, { command: "path.create", params: { d: "M0 0" } }], export: true }, { sleep: noSleep });
    test("a failing command stops the plan by default: its error is reported, later commands do not run, no export", () => {
      eq(r.ok, false);
      eq(r.results.length, 2);
      eq(r.results[1]!.ok, false);
      assert(/unknown command/.test(r.results[1]!.error || ""), JSON.stringify(r.results[1]));
      assert(!f.calls.some((c) => c.startsWith("execute:path.create")), "stopped");
      assert(!f.calls.includes("request:app.export"), "no export after a failure");
      eq(r.svg, undefined);
    });
  }
  {
    const f = fakeDriver();
    const r = await runVectorcraftPlan(f.api, { svg: "<svg/>", name: "a.svg", commands: [{ command: "boom" }, { command: "path.create", params: { d: "M0 0" } }], export: true, continueOnError: true }, { sleep: noSleep });
    test("continueOnError runs the rest and still exports; ok stays false", () => {
      eq(r.ok, false);
      eq(r.results.length, 2);
      eq(r.results[1]!.ok, true);
      assert(typeof r.svg === "string", "exported");
    });
  }
  {
    const f = fakeDriver({ appearAfter: 1000 });
    const r = await runVectorcraftPlan(f.api, { svg: "<svg/>", name: "slow.svg", commands: [{ command: "shape.rectangle", params: {} }], export: true, openTimeoutMs: 500 }, { sleep: noSleep, now: (() => { let t = 0; return () => (t += 100); })() });
    test("a document that never appears: opened false, the plan stops with an error naming the file, nothing executed", () => {
      eq(r.opened, false);
      eq(r.ok, false);
      assert(/slow\.svg/.test(r.error || ""), r.error || "");
      assert(!f.calls.some((c) => c.startsWith("execute:")), "nothing executed");
    });
  }
  {
    const f = fakeDriver();
    const r = await runVectorcraftPlan(f.api, { commands: [{ command: "file.new", params: { width: 100, height: 100 } }], export: false }, { sleep: noSleep });
    test("no svg: nothing is opened, commands run against whatever is open, no export when export is false", () => {
      eq(r.opened, false);
      eq(r.ok, true);
      eq(r.results.length, 1);
      assert(!f.calls.includes("request:app.export") && !f.calls.includes("screenshot"), f.calls.join(","));
    });
  }

  // ---- the MCP tool -----------------------------------------------------------------------------------------
  const tools = await import("../src/mcp/tools.ts");
  type ToolLike = { name: string };
  let badScene: unknown = null;
  let badErr = "";
  try { badScene = await tools.callTool("vectorcraft_exec", { mod: "dev-sandbox", scene: "art/does-not-exist.scene.json", shapeId: "body", commands: [] }); } catch (e) { badErr = e instanceof Error ? e.message : String(e); }
  let badArgs = "";
  try { await tools.callTool("vectorcraft_exec", { mod: "dev-sandbox", scene: "art/my_rat.scene.json", commands: [{ params: {} }] }); } catch (e) { badArgs = e instanceof Error ? e.message : String(e); }
  test("MCP vectorcraft_exec is listed last with a zod schema; a missing scene is refused before any browser starts; a command without a name is a ToolError", () => {
    const names = (tools.TOOLS as ToolLike[]).map((t) => t.name);
    eq(names[names.length - 1], "vectorcraft_exec", names.join(","));
    assert(!!tools.TOOL_INPUT.vectorcraft_exec, "zod schema");
    assert(!badErr && !!badScene && (badScene as { ok: boolean }).ok === false && /does-not-exist|scene/.test((badScene as { error?: string }).error || ""), `${badErr} ${JSON.stringify(badScene)}`);
    assert(/invalid arguments for vectorcraft_exec/.test(badArgs) && /command/.test(badArgs), badArgs);
  });

  // ---- one real headless run (skips without the vendored build / Chromium) ----------------------------------------
  const vendored = hl.isVectorcraftVendored();
  if (!vendored.ok) {
    console.log(`  (skipped: ${vendored.reason})`);
    return;
  }
  const api = await import("../src/core/api.ts");
  const scenePath = "art/_vc_exec_probe.scene.json";
  const sceneAbs = join(MODS, "dev-sandbox", scenePath);
  rmSync(sceneAbs, { force: true });
  const made = api.newArtScene("dev-sandbox", "_vc_exec_probe", { starter: true });
  let run: Awaited<ReturnType<typeof hl.vectorcraftExec>> | null = null;
  let runErr = "";
  try {
    run = await hl.vectorcraftExec({ mod: "dev-sandbox", scenePath, shapeId: "body", commands: [{ command: "shape.rectangle", params: { x: 0, y: 0, width: 10, height: 10 } }], exportTo: "body", screenshot: true });
  } catch (e) {
    runErr = e instanceof Error ? e.message : String(e);
  }
  const after = existsSync(sceneAbs) ? JSON.parse(readFileSync(sceneAbs, "utf8")) as { shapes: Record<string, { paths: { d: string; transform?: number[] }[] }> } : null;
  rmSync(sceneAbs, { force: true });
  test("vectorcraftExec (real, headless): opens body.svg, shape.rectangle, exports, re-origins and replaces the shape in the scene file; returns a screenshot PNG path", () => {
    assert(made.ok === true, `scene created: ${made.error || ""}`);
    assert(!runErr && !!run, runErr);
    const r = run!;
    if (r.skipped) { console.log(`  (skipped: ${r.reason})`); return; }
    assert(r.ok, JSON.stringify({ error: r.error, results: r.results }).slice(0, 600));
    eq(r.results.length, 1); eq(r.results[0]!.ok, true);
    assert(!!r.applied && r.applied.shapeId === "body" && r.applied.paths === 3, JSON.stringify(r.applied));
    eq(JSON.stringify(r.reorigin), JSON.stringify({ dx: -44, dy: -34 }), "body's viewBox origin undone");
    assert(!!after, "the scene file exists");
    const paths = after!.shapes.body!.paths;
    eq(paths.length, 3);
    eq(paths[0]!.d, "M4 4 L84 4 L84 64 L4 64 Z");
    eq(JSON.stringify(paths[0]!.transform), "[1,0,0,1,-44,-34]");
    eq(paths[2]!.d, "M0 0 L10 0 L10 10 L0 10 Z");
    assert(typeof r.screenshotPath === "string" && existsSync(r.screenshotPath), `screenshot at ${r.screenshotPath}`);
    const png = readFileSync(r.screenshotPath!);
    eq(png.subarray(0, 4).toString("latin1"), "\x89PNG");
    rmSync(r.screenshotPath!, { force: true });
    assert(r.documents.length === 1 && r.documents[0]!.title === "body.svg", JSON.stringify(r.documents));
    assert(typeof r.ms === "number" && r.ms > 0, "timing");
  });
}
