// DefineShape4 + LINESTYLE2 (art build-out E): stroke caps / joins / miter limit / non-scaling strokes and gradient
// strokes; the emitter picks DefineShape4 only when a shape needs it (plain shapes stay byte-identical DefineShape3);
// EdgeBounds and the shape flags; the SVG importer's stroke attributes; the preview's stroke geometry (pure stroke.ts).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as shapeMod from "../src/core/art/shape.ts";
import { readTags, readSwf } from "../src/core/art/swf-reader.ts";
import { emitSwf, minimalGateSwf } from "../src/core/art/swf-emitter.ts";
import { exampleScene, validateScene } from "../src/core/art/scene.ts";
import { importSvg } from "../src/core/art/svg-import.ts";
import { SWF_GATE_VARIANTS } from "../src/core/art/art-io.ts";
import { vanillaSwfDir } from "../src/core/repo.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const VANILLA_DIR = vanillaSwfDir(); // repo.ts: MEWGENICS_VANILLA_SWF_DIR, else <extracted root>/swfs
const SQ = "M0 0 L40 0 L40 40 L0 40 Z";
const LINE = "M0 0 L10 0";

export async function runArtShape4Tests(test: TestFn, assert: AssertFn, eq: EqFn): Promise<void> {
  console.log("\n# Art: DefineShape4 / LINESTYLE2 (caps, joins, miter, non-scaling and gradient strokes)");
  const S = shapeMod as Record<string, any>;
  let K: Record<string, any> = {};
  let kErr = "";
  try { K = await import("../src/core/art/stroke.ts"); } catch (e) { kErr = e instanceof Error ? e.message : String(e); }

  test("validateScene: strokeCap round|butt|square, strokeJoin round|bevel|miter, miterLimit >= 1, strokeScale normal|none (code stroke-style); a stroke gradient must exist", () => {
    const sc = exampleScene("s4") as any;
    Object.assign(sc.shapes.body.paths[0], { stroke: "gray:2", strokeWidth: 2, strokeCap: "flat", strokeJoin: "pointy", miterLimit: 0.5, strokeScale: "sideways" });
    sc.shapes.eye.paths[0].stroke = "gradient:nope";
    sc.shapes.eye.paths[0].strokeWidth = 1;
    const v = validateScene(sc) as any;
    const codes = v.findings.filter((f: any) => f.severity === "error").map((f: any) => `${f.code}@${f.path}`);
    for (const k of ["strokeCap", "strokeJoin", "miterLimit", "strokeScale"]) assert(codes.includes(`stroke-style@shapes.body.paths[0].${k}`), `${k}: ${codes.join(", ")}`);
    assert(codes.some((c: string) => c.startsWith("gradient-missing@shapes.eye.paths[0].stroke")), codes.join(", "));
    const ok = exampleScene("s4") as any;
    Object.assign(ok.shapes.body.paths[0], { stroke: "gray:2", strokeWidth: 2, strokeCap: "butt", strokeJoin: "miter", miterLimit: 3, strokeScale: "none" });
    assert((validateScene(ok) as any).ok, "valid");
  });

  test("shapeVersion: 3 for plain fills and round strokes; 4 for a butt/square cap, bevel/miter join, non-scaling stroke, gradient stroke, a gradient with more than 8 stops, a focal radial or a reflect/repeat spread", () => {
    assert(typeof S.shapeVersion === "function", "shape.ts exports shapeVersion");
    const v = (paths: any[], gradients: any = {}) => S.shapeVersion({ paths }, gradients);
    eq(v([{ d: SQ, fill: "gray:8" }]), 3);
    eq(v([{ d: SQ, fill: "gray:8", stroke: "gray:1", strokeWidth: 2 }]), 3);
    eq(v([{ d: SQ, stroke: "gray:1", strokeWidth: 2, strokeCap: "round", strokeJoin: "round" }]), 3);
    eq(v([{ d: SQ, stroke: "gray:1", strokeWidth: 2, strokeCap: "butt" }]), 4);
    eq(v([{ d: SQ, stroke: "gray:1", strokeWidth: 2, strokeJoin: "miter" }]), 4);
    eq(v([{ d: SQ, stroke: "gray:1", strokeWidth: 2, strokeScale: "none" }]), 4);
    const g2 = { g: { kind: "linear", x1: 0, y1: 0, x2: 1, y2: 0, stops: [{ offset: 0, color: "gray:0" }, { offset: 1, color: "gray:15" }] } };
    eq(v([{ d: SQ, stroke: "gradient:g", strokeWidth: 2 }], g2), 4);
    const many = { g: { ...g2.g, stops: Array.from({ length: 12 }, (_, i) => ({ offset: i / 11, color: `gray:${i}` })) } };
    eq(v([{ d: SQ, fill: "gradient:g" }], many), 4);
    // SWF defines the focal radial (0x13) and the reflect/repeat spread bits for DefineShape4 only
    eq(v([{ d: SQ, fill: "gradient:f" }], { f: { kind: "radial", cx: 0, cy: 0, r: 10, fx: 5, fy: 0, stops: g2.g.stops } }), 4);
    eq(v([{ d: SQ, fill: "gradient:r" }], { r: { ...g2.g, spread: "reflect" } }), 4);
    eq(v([{ d: SQ, fill: "gradient:g" }], g2), 3);
  });

  test("encodeDefineShape (auto) writes DefineShape4 the reader reads back: EdgeBounds = bounds without the stroke, the non-scaling flag, LINESTYLE2 caps/join/miter, a gradient line fill", () => {
    assert(typeof S.encodeDefineShape === "function", "shape.ts exports encodeDefineShape");
    const gradients = { g: { kind: "linear", x1: 0, y1: 0, x2: 40, y2: 0, stops: [{ offset: 0, color: "gray:0" }, { offset: 1, color: "#ff0000" }] } };
    const shape = { paths: [
      { d: SQ, fill: "gray:8", stroke: "gray:1", strokeWidth: 4, strokeCap: "square", strokeJoin: "miter", miterLimit: 3, strokeScale: "none" },
      { d: "M60 0 L100 0 L100 40 Z", stroke: "gradient:g", strokeWidth: 2, strokeCap: "butt", strokeJoin: "bevel" },
    ] };
    const enc = S.encodeDefineShape(9, shape, { gradients });
    assert(!enc.findings.some((f: any) => f.severity === "error"), JSON.stringify(enc.findings));
    const t = readTags(enc.bytes, 0, enc.bytes.length)[0]! as any;
    eq(t.name, "DefineShape4");
    const sh = t.shape;
    eq(sh.edgeBounds.xmin, 0); eq(sh.edgeBounds.xmax, 2000); eq(sh.edgeBounds.ymax, 800);
    assert(sh.bounds.xmin < 0 && sh.bounds.xmax > 2000, `bounds include the stroke ${JSON.stringify(sh.bounds)}`);
    eq(sh.flags & 0x02, 0x02, "UsesNonScalingStrokes");
    eq(sh.flags & 0x01, 0x01, "UsesScalingStrokes (the second line scales)");
    eq(sh.lineStyles.length, 2);
    const [a, b] = sh.lineStyles;
    eq(a.width, 80);
    eq((a.flags >> 14) & 3, 2, "start cap square"); eq(a.flags & 3, 2, "end cap square");
    eq((a.flags >> 12) & 3, 2, "miter join"); eq(a.miterLimit, 3);
    eq(a.flags & 0x0600, 0x0600, "NoHScale + NoVScale");
    eq(a.color.r, 17);
    eq((b.flags >> 14) & 3, 1, "butt cap"); eq((b.flags >> 12) & 3, 1, "bevel join");
    assert(!!(b.flags & 0x0800) && b.fill && b.fill.type === 0x10, `gradient line fill ${JSON.stringify(b)}`);
  });

  test("plain shapes stay byte-identical DefineShape3 (exampleScene through encodeDefineShape vs encodeDefineShape3); forcing v3 drops LINESTYLE2 features with a stroke-style-dropped warning", () => {
    const sc = exampleScene("s4") as any;
    for (const id of Object.keys(sc.shapes)) {
      const a = S.encodeDefineShape(3, sc.shapes[id], {});
      const b = S.encodeDefineShape3(3, sc.shapes[id], {});
      eq(Buffer.from(a.bytes).toString("hex"), Buffer.from(b.bytes).toString("hex"), id);
    }
    const r = S.encodeDefineShape3(4, { paths: [{ d: LINE, stroke: "gray:1", strokeWidth: 2, strokeCap: "butt" }] }, {});
    eq(readTags(r.bytes, 0, r.bytes.length)[0]!.name, "DefineShape3");
    assert(r.findings.some((f: any) => f.code === "stroke-style-dropped"), JSON.stringify(r.findings));
  });

  test("gradients: up to 15 stops validate and emit through DefineShape4; 16 is gradient-stops", () => {
    const stops = (n: number) => Array.from({ length: n }, (_, i) => ({ offset: i / (n - 1), color: `gray:${i % 16}` }));
    const sc = exampleScene("s4") as any;
    sc.gradients = { g: { kind: "linear", x1: 0, y1: 0, x2: 10, y2: 0, stops: stops(12) } };
    sc.shapes.body.paths[0].fill = "gradient:g";
    assert((validateScene(sc) as any).ok, "12 stops valid");
    const swf = readSwf(emitSwf(sc).bytes) as any;
    const s4 = swf.tags.filter((t: any) => t.name === "DefineShape4");
    eq(s4.length, 1);
    eq(s4[0].shape.fillStyles[0].gradient.length, 12);
    sc.gradients.g.stops = stops(16);
    assert((validateScene(sc) as any).findings.some((f: any) => f.code === "gradient-stops"), "16 refused");
  });

  test("importSvg reads stroke-linecap / stroke-linejoin / stroke-miterlimit / vector-effect (SVG defaults butt / miter / 4 when absent)", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <path d="M0 0 L10 0" stroke="#000" stroke-width="2"/>
      <path d="M0 5 L10 5" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="bevel"/>
      <g style="stroke-linecap:square;stroke-miterlimit:7"><path d="M0 9 L10 9" stroke="#000" vector-effect="non-scaling-stroke"/></g>
    </svg>`;
    const r = importSvg(svg) as any;
    const [a, b, c] = r.paths;
    eq(a.strokeCap, "butt"); eq(a.strokeJoin, "miter"); eq(a.miterLimit, 4);
    eq(b.strokeCap, "round"); eq(b.strokeJoin, "bevel");
    eq(c.strokeCap, "square"); eq(c.miterLimit, 7); eq(c.strokeScale, "none");
  });

  test("stroke.ts (the preview's stroke geometry): butt ends at the endpoints, square extends by half the width, round adds a cap; a miter join reaches the corner, bevel cuts it, past the limit a miter falls back to bevel", () => {
    if (kErr) throw new Error(`stroke.ts: ${kErr}`);
    const bb = (polys: number[][]) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of polys) for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]!); x1 = Math.max(x1, p[i]!); y0 = Math.min(y0, p[i + 1]!); y1 = Math.max(y1, p[i + 1]!); }
      return [x0, y0, x1, y1].map((v) => Math.round(v * 1000) / 1000);
    };
    const seg = [[0, 0, 10, 0]];
    eq(bb(K.strokePolys(seg, [false], 2, { cap: "butt", join: "round" })).join(","), "0,-1,10,1");
    eq(bb(K.strokePolys(seg, [false], 2, { cap: "square", join: "round" })).join(","), "-1,-1,11,1");
    const rnd = bb(K.strokePolys(seg, [false], 2, { cap: "round", join: "round" }));
    assert(rnd[0]! < -0.9 && rnd[2]! > 10.9, `round cap ${rnd}`);
    const corner = [[0, 0, 10, 0, 10, 10]]; // a right angle at (10,0); the outer corner of a width-2 stroke is (11,-1)
    eq(bb(K.strokePolys(corner, [false], 2, { cap: "butt", join: "miter", miterLimit: 4 })).slice(1, 3).join(","), "-1,11");
    const bev = bb(K.strokePolys(corner, [false], 2, { cap: "butt", join: "bevel" }));
    assert(bev[2]! === 11 && bev[1]! === -1, `bevel reaches only the offsets ${bev}`);
    const sharp = [[0, 0, 10, 0, 0, 1]]; // a very sharp turn: the miter would be ~20 widths long
    const sb = bb(K.strokePolys(sharp, [false], 2, { cap: "butt", join: "miter", miterLimit: 4 }));
    assert(sb[2]! < 12, `limit falls back to bevel ${sb}`);
  });

  test("the SWF gate has a shape4 variant (the icon square with a butt-cap miter-join non-scaling stroke → DefineShape4), expected to boot", () => {
    const v = (SWF_GATE_VARIANTS as Record<string, any>).shape4;
    assert(!!v, "variant exists");
    eq(v.expect, "pass");
    const bytes = minimalGateSwf({ withAbc: false, linkage: v.linkage, label: "x", layout: v.layout, fill: v.fill, stroke: v.stroke } as any);
    const tags = (readSwf(bytes) as any).tags;
    assert(tags.some((t: any) => t.name === "DefineShape4"), tags.map((t: any) => t.name).join(","));
  });

  test("preview-gl.ts strokes through stroke.ts with the path's cap / join / miter limit (GL and Canvas2D)", () => {
    const src = readFileSync(join(HERE, "..", "web", "src", "art", "preview-gl.ts"), "utf8");
    assert(/from "..\/..\/..\/src\/core\/art\/stroke\.ts"/.test(src), "imports stroke.ts");
    assert(!/^function strokePolys/m.test(src), "the local copy is gone");
    assert(/c\.lineJoin = path\.stroke(Style\.join|Join)/.test(src) && /c\.lineCap = /.test(src) && /c\.miterLimit = /.test(src), "Canvas2D follows the path");
  });

  const ai = join(VANILLA_DIR, "ability_icons.swf");
  if (!existsSync(ai)) console.log(`  (skipped: vanilla ability_icons.swf not extracted at ${VANILLA_DIR})`);
  else test("T1: vanilla ability_icons.swf DefineShape4 tags read with EdgeBounds inside Bounds and LINESTYLE2 widths (what the game ships)", () => {
    const swf = readSwf(new Uint8Array(readFileSync(ai))) as any;
    const all: any[] = [];
    const walk = (tags: any[]) => { for (const t of tags) { if (t.name === "DefineShape4" && t.shape) all.push(t.shape); if (t.tags) walk(t.tags); } };
    walk(swf.tags);
    assert(all.length > 0, "the game ships DefineShape4");
    for (const s of all) assert(s.edgeBounds.xmin >= s.bounds.xmin && s.edgeBounds.xmax <= s.bounds.xmax && s.edgeBounds.ymin >= s.bounds.ymin && s.edgeBounds.ymax <= s.bounds.ymax, `edge bounds inside ${s.id}`);
  });
}
