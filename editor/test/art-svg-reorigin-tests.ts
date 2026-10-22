// svg-reorigin.ts: undo VectorCraft's artboard re-origin so an SVG it exports lands back on the shape's own
// coordinates. Captured fact (test/fixtures/vectorcraft/README.md, v0.14.0 web build in headless Chromium): opening
// our exporter's SVG makes its viewBox the artboard (same size at 0,0) and translates every coordinate by
// (-viewBox.x, -viewBox.y); app.export always writes viewBox "0 0 w h", art outside the artboard keeps its
// document coordinates. reoriginSvg(svg, originalViewBox) therefore wraps the returned document in
// translate(+viewBox.x, +viewBox.y) — a pure string → string helper the panel and the MCP tool share.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";
import { importSvg } from "../src/core/art/svg-import.ts";
import { normalizePath, subpathBounds, unionBounds } from "../src/core/art/geometry.ts";
import type { ScenePath } from "../src/core/art/scene.ts";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "vectorcraft");
const fx = (n: string) => readFileSync(join(FIX, n), "utf8");

/** The visual bounds of imported paths (d under its transform), rounded. */
function bounds(paths: ScenePath[]): string {
  let b = null as ReturnType<typeof subpathBounds>;
  for (const p of paths) b = unionBounds(b, subpathBounds(normalizePath(p.d, { matrix: p.transform })));
  return b ? [b.xmin, b.ymin, b.xmax, b.ymax].map((v) => Math.round(v * 1000) / 1000).join(",") : "none";
}

export async function runArtSvgReoriginTests(test: TestFn, assert: AssertFn, eq: EqFn): Promise<void> {
  console.log("\n# svg-reorigin: undoing VectorCraft's artboard re-origin (captured fixtures)");
  type Mod = typeof import("../src/core/art/svg-reorigin.ts");
  let m: Mod | null = null;
  let loadErr = "";
  try { m = await import("../src/core/art/svg-reorigin.ts"); } catch (e) { loadErr = e instanceof Error ? e.message : String(e); }
  test("src/core/art/svg-reorigin.ts exports reoriginSvg and parseViewBox", () => {
    assert(!!m, loadErr);
    assert(typeof m!.reoriginSvg === "function" && typeof m!.parseViewBox === "function", "exports");
  });
  if (!m) return;
  const { reoriginSvg, parseViewBox } = m;

  test("parseViewBox reads the root <svg> viewBox (spaces or commas), null when absent or malformed", () => {
    eq(JSON.stringify(parseViewBox(fx("offset-input.svg"))), "[96,196,108,108]");
    eq(JSON.stringify(parseViewBox('<svg viewBox="-1.5,2, 3 4"/>')), "[-1.5,2,3,4]");
    eq(parseViewBox('<svg width="10" height="10"/>'), null);
    eq(parseViewBox('<svg viewBox="a b c d"/>'), null);
  });

  test("the captured offset round trip: viewBox 96 196 → VectorCraft's 0 0; reorigin restores the exact bounds and coordinates", () => {
    const original = importSvg(fx("offset-input.svg"), { applyViewBox: false });
    const raw = importSvg(fx("offset-reexport.svg"), { applyViewBox: false });
    eq(bounds(raw.paths.slice(0, 2)), "4,4,104,104", "without the helper the art sits at the artboard origin (shifted by -96,-196)");
    const r = reoriginSvg(fx("offset-reexport.svg"), [96, 196, 108, 108]);
    eq(r.dx, 96); eq(r.dy, 196);
    const back = importSvg(r.svg, { applyViewBox: false });
    assert(back.ok && back.findings.length === 0, JSON.stringify(back.findings));
    eq(back.paths.length, 4, "the two original paths + the two rectangles drawn in VectorCraft");
    eq(bounds(back.paths.slice(0, 2)), bounds(original.paths), "same visual bounds as our export");
    eq(back.paths[0]!.d, "M4 4 L104 4 L104 104 L4 104 Z", "VectorCraft's d is kept verbatim…");
    eq(JSON.stringify(back.paths[0]!.transform), "[1,0,0,1,96,196]", "…and the undo rides on the path transform");
    eq(back.paths[1]!.fill, original.paths[1]!.fill); eq(back.paths[1]!.stroke, original.paths[1]!.stroke); eq(back.paths[1]!.strokeWidth, 2);
    eq(bounds([back.paths[2]!]), "46,146,66,166", "a rectangle drawn at (-50,-50) in VectorCraft lands at (46,146) in scene space");
    eq(JSON.stringify(parseViewBox(r.svg)), "[96,196,108,108]", "the root viewBox is the original origin with VectorCraft's artboard size");
  });

  test("the captured negative-origin round trip (body: viewBox -44 -34 88 68) comes back onto -40,-30…40,30", () => {
    const r = reoriginSvg(fx("body-reexport.svg"), parseViewBox(fx("body-input.svg"))!);
    eq(r.dx, -44); eq(r.dy, -34);
    const back = importSvg(r.svg, { applyViewBox: false });
    eq(bounds(back.paths), "-40,-30,40,30");
    eq(back.paths[1]!.fill, "gray:12");
  });

  test("no-op when the returned viewBox already has the original origin (dx = dy = 0: the svg is returned unchanged)", () => {
    const svg = fx("offset-input.svg");
    const r = reoriginSvg(svg, [96, 196, 108, 108]);
    eq(r.dx, 0); eq(r.dy, 0);
    eq(r.svg, svg);
  });

  test("a userSpaceOnUse gradient inside <defs> moves with the paths (gradient geometry stays path-local, the offset rides on the path transform)", () => {
    const re = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">',
      "  <title>x.svg</title>",
      "  <defs>",
      '    <linearGradient id="ramp" gradientUnits="userSpaceOnUse" x1="4" y1="4" x2="16" y2="4"><stop offset="0" stop-color="#000000"/><stop offset="1" stop-color="#ffffff"/></linearGradient>',
      "  </defs>",
      '  <g id="Layer_1" data-name="Layer 1"><path d="M4 4 L16 4 L16 16 L4 16 Z" fill="url(#ramp)"/></g>',
      "</svg>",
      "",
    ].join("\n");
    const r = reoriginSvg(re, [100, 50, 20, 20]);
    const back = importSvg(r.svg, { applyViewBox: false });
    assert(back.ok && back.findings.length === 0, JSON.stringify(back.findings));
    eq(back.paths[0]!.fill, "gradient:ramp");
    eq(JSON.stringify(back.paths[0]!.transform), "[1,0,0,1,100,50]");
    const g = back.gradients.ramp!;
    eq(`${g.x1},${g.y1},${g.x2},${g.y2}`, "4,4,16,4", "gradient geometry untouched (path-local like d)");
    assert(g.transform === undefined, "no gradient transform injected");
    eq(bounds(back.paths), "104,54,116,66");
    assert(r.svg.startsWith('<?xml version="1.0"'), "the XML prolog is kept");
    assert(r.svg.includes("<title>x.svg</title>"), "non-drawing children are kept");
  });

  test("a returned svg without a viewBox is treated as origin 0 0", () => {
    const r = reoriginSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path d="M0 0 L10 0 L10 10 Z" fill="#000"/></svg>', [5, 6, 10, 10]);
    eq(r.dx, 5); eq(r.dy, 6);
    eq(bounds(importSvg(r.svg, { applyViewBox: false }).paths), "5,6,15,16");
  });

  test("a malformed original viewBox or a document without an <svg> root is an error, not a silent shift", () => {
    let e1 = "";
    try { reoriginSvg(fx("offset-reexport.svg"), [1, 2] as unknown as number[]); } catch (e) { e1 = String(e instanceof Error ? e.message : e); }
    assert(/viewBox/.test(e1), e1);
    let e2 = "";
    try { reoriginSvg("<html></html>", [0, 0, 1, 1]); } catch (e) { e2 = String(e instanceof Error ? e.message : e); }
    assert(/<svg>/.test(e2), e2);
  });
}
