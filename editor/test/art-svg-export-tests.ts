// SVG round trip (art build-out J): a scene shape → a standalone SVG for any vector editor (VectorCraft, Inkscape,
// Illustrator) → back into the same shape. VectorCraft is a static vector editor without animation, so the editor
// owns the timeline and the external tool only ever sees one shape as SVG.

import { rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { exampleScene } from "../src/core/art/scene.ts";
import { importSvg } from "../src/core/art/svg-import.ts";
import * as api from "../src/core/api.ts";
import { MODS_DIR } from "../src/core/repo.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

export async function runArtSvgExportTests(test: TestFn, assert: AssertFn, eq: EqFn): Promise<void> {
  console.log("\n# Art: SVG round trip (export a shape for an external vector editor, re-import it)");
  let X: Record<string, any> = {};
  let err = "";
  try { X = await import("../src/core/art/svg-export.ts"); } catch (e) { err = e instanceof Error ? e.message : String(e); }
  const need = () => { if (err) throw new Error(`svg-export.ts: ${err}`); };
  const same = (a: any[], b: any[]) => JSON.stringify(a.map((p) => ({ d: p.d, fill: p.fill ?? null, fillRule: p.fillRule || "nonzero", transform: p.transform || null, stroke: p.stroke || null, strokeWidth: p.strokeWidth || 0 }))) === JSON.stringify(b.map((p) => ({ d: p.d, fill: p.fill ?? null, fillRule: p.fillRule || "nonzero", transform: p.transform || null, stroke: p.stroke || null, strokeWidth: p.strokeWidth || 0 })));

  test("shapeToSvg → importSvg (applyViewBox: false) gives back the example shapes' paths (d, gray/colour fills, fill rule, transforms)", () => {
    need();
    const sc = exampleScene("rt") as any;
    for (const id of Object.keys(sc.shapes)) {
      const r = X.shapeToSvg(sc.shapes[id], sc.gradients || {});
      assert(/^<svg[^>]*viewBox="/.test(r.svg), r.svg.slice(0, 120));
      const back = importSvg(r.svg, { applyViewBox: false }) as any;
      assert(back.ok, JSON.stringify(back.findings));
      assert(same(back.paths, sc.shapes[id].paths), `${id}:\n${JSON.stringify(back.paths)}\nvs\n${JSON.stringify(sc.shapes[id].paths)}`);
    }
  });

  test("gradients and stroke styles survive the round trip; a bitmap fill cannot (svg-export-bitmap finding, a magenta stand-in)", () => {
    need();
    const g = { kind: "linear", x1: 0, y1: 0, x2: 40, y2: 0, stops: [{ offset: 0, color: "gray:2" }, { offset: 1, color: "#ff2020" }], spread: "reflect" };
    const shape = { paths: [
      { d: "M0 0 L40 0 L40 20 L0 20 Z", fill: "gradient:sky" },
      { d: "M0 30 L40 30", stroke: "gray:1", strokeWidth: 3, strokeCap: "butt", strokeJoin: "miter", miterLimit: 3 },
    ] };
    const r = X.shapeToSvg(shape, { sky: g });
    const back = importSvg(r.svg, { applyViewBox: false }) as any;
    eq(back.paths[0].fill, "gradient:sky");
    eq(JSON.stringify(back.gradients.sky), JSON.stringify(g));
    eq(back.paths[1].strokeCap, "butt"); eq(back.paths[1].strokeJoin, "miter"); eq(back.paths[1].miterLimit, 3);
    const bm = X.shapeToSvg({ paths: [{ d: "M0 0 L1 0 L1 1 Z", fill: "bitmap:pic" }] }, {});
    assert(bm.findings.some((f: any) => f.code === "svg-export-bitmap"), JSON.stringify(bm.findings));
  });

  const tmpMod = "__svg_rt_tmp";
  rmSync(join(MODS_DIR, tmpMod), { recursive: true, force: true });
  test("api.exportShapeSvg writes art/<shape>.svg inside the mod (refuses an unknown shape and paths outside the mod); importSvgIntoScene with replace + applyViewBox false restores it", () => {
    const a = api as unknown as Record<string, any>;
    assert(typeof a.exportShapeSvg === "function", "api.exportShapeSvg exported");
    assert(api.newArtScene(tmpMod, "rt").ok, "scene");
    const r = a.exportShapeSvg(tmpMod, "art/rt.scene.json", "body");
    assert(r.ok && r.relPath === "art/body.svg", JSON.stringify(r));
    assert(existsSync(join(MODS_DIR, tmpMod, "art", "body.svg")), "file written");
    assert(!a.exportShapeSvg(tmpMod, "art/rt.scene.json", "nope").ok, "unknown shape");
    assert(!a.exportShapeSvg(tmpMod, "../x.scene.json", "body").ok, "path guard");
    const before = api.readArtScene(tmpMod, "art/rt.scene.json").scene!.shapes.body;
    const back = api.importSvgIntoScene({ mod: tmpMod, scenePath: "art/rt.scene.json", shapeId: "body", svgText: readFileSync(join(MODS_DIR, tmpMod, "art", "body.svg"), "utf8"), replace: true, options: { applyViewBox: false } });
    assert(back.ok, JSON.stringify(back));
    const after = api.readArtScene(tmpMod, "art/rt.scene.json").scene!.shapes.body;
    assert(same(after.paths, before.paths), "round trip through the mod file");
  });
  rmSync(join(MODS_DIR, tmpMod), { recursive: true, force: true });
}
