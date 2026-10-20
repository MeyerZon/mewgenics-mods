// Gradient fills (art build-out C): scene.gradients + `gradient:<id>` fills, the pure gradient module, the
// DefineShape3 gradient fill styles (0x10 linear, 0x12 radial, 0x13 focal radial) read back through the verification
// reader, the SVG importer's <linearGradient>/<radialGradient>, and the preview's use of the same math.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeDefineShape3 } from "../src/core/art/shape.ts";
import { readTags, readSwf } from "../src/core/art/swf-reader.ts";
import { emitSwf, minimalGateSwf } from "../src/core/art/swf-emitter.ts";
import { exampleScene, validateScene, parseFill } from "../src/core/art/scene.ts";
import { importSvg } from "../src/core/art/svg-import.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
const ap = (M: number[], x: number, y: number) => [M[0]! * x + M[2]! * y + M[4]!, M[1]! * x + M[3]! * y + M[5]!];

export async function runArtGradientTests(test: TestFn, assert: AssertFn, eq: EqFn): Promise<void> {
  console.log("\n# Art: gradient fills (scene model, emitter, reader, SVG import, preview math)");
  let G: Record<string, any> = {};
  let gErr = "";
  try { G = await import("../src/core/art/gradient.ts"); } catch (e) { gErr = e instanceof Error ? e.message : String(e); }
  const need = () => { if (gErr) throw new Error(`gradient.ts: ${gErr}`); };

  const linear = { kind: "linear", x1: 0, y1: 0, x2: 100, y2: 0, stops: [{ offset: 0, color: "gray:2" }, { offset: 1, color: "#ff000080" }] };
  const radial = { kind: "radial", cx: 10, cy: 20, r: 50, stops: [{ offset: 0, color: "gray:14" }, { offset: 0.5, color: "gray:8" }, { offset: 1, color: "gray:0" }], spread: "reflect" };
  const focal = { kind: "radial", cx: 0, cy: 0, r: 40, fx: 0, fy: 20, stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#000000" }] };

  test("parseFill reads gradient:<id>", () => {
    const f = parseFill("gradient:sky");
    eq(JSON.stringify(f.fill), JSON.stringify({ kind: "gradient", id: "sky" }));
    assert(!f.error, String(f.error));
  });

  test("validateScene: gradient-missing for an unknown id, gradient-stops for <2 / >8 / unordered / bad colour stops, gradient-geometry for a zero-length linear or r<=0 radial, dup-id across gradients", () => {
    const sc = exampleScene("g") as any;
    sc.shapes.body.paths[0].fill = "gradient:nope";
    let v = validateScene(sc) as any;
    assert(v.findings.some((f: any) => f.code === "gradient-missing" && f.severity === "error"), JSON.stringify(v.findings.map((f: any) => f.code)));
    const sc2 = exampleScene("g") as any;
    sc2.gradients = {
      one: { kind: "linear", x1: 0, y1: 0, x2: 10, y2: 0, stops: [{ offset: 0, color: "gray:1" }] },
      many: { kind: "linear", x1: 0, y1: 0, x2: 10, y2: 0, stops: Array.from({ length: 9 }, (_, i) => ({ offset: i / 8, color: "gray:1" })) },
      order: { kind: "linear", x1: 0, y1: 0, x2: 10, y2: 0, stops: [{ offset: 0.6, color: "gray:1" }, { offset: 0.2, color: "gray:2" }] },
      colour: { kind: "linear", x1: 0, y1: 0, x2: 10, y2: 0, stops: [{ offset: 0, color: "bitmap:x" }, { offset: 1, color: "zzz" }] },
      flat: { kind: "linear", x1: 5, y1: 5, x2: 5, y2: 5, stops: linear.stops },
      dot: { kind: "radial", cx: 0, cy: 0, r: 0, stops: linear.stops },
      body: linear,
    };
    sc2.shapes.body.paths[0].fill = "gradient:one";
    v = validateScene(sc2);
    const codes = v.findings.filter((f: any) => f.severity === "error").map((f: any) => `${f.code}@${(f.path || [])[0] || ""}`);
    for (const id of ["one", "many", "order", "colour"]) assert(codes.includes(`gradient-stops@gradients.${id}`), `stops ${id}: ${codes.join(", ")}`);
    for (const id of ["flat", "dot"]) assert(codes.includes(`gradient-geometry@gradients.${id}`), `geometry ${id}: ${codes.join(", ")}`);
    assert(codes.some((c: string) => c.startsWith("dup-id@gradients.body")), `dup id: ${codes.join(", ")}`);
    const ok = exampleScene("g") as any;
    ok.gradients = { sky: linear };
    ok.shapes.body.paths[0].fill = "gradient:sky";
    v = validateScene(ok);
    assert(v.ok, JSON.stringify(v.findings));
  });

  test("gradientUnitMatrix: linear maps unit x=-1/+1 onto the endpoints and keeps the perpendicular at the same scale; radial scales by r about the centre; focal radial rotates so the focus lies on +x", () => {
    need();
    const m = G.gradientUnitMatrix(linear);
    let p = ap(m, -1, 0); assert(near(p[0]!, 0) && near(p[1]!, 0), `start ${p}`);
    p = ap(m, 1, 0); assert(near(p[0]!, 100) && near(p[1]!, 0), `end ${p}`);
    p = ap(m, 0, 1); assert(near(p[0]!, 50) && near(Math.abs(p[1]!), 50), `perp ${p}`);
    const r = G.gradientUnitMatrix(radial);
    p = ap(r, 1, 0); assert(near(p[0]!, 60) && near(p[1]!, 20), `radial edge ${p}`);
    p = ap(r, 0, 0); assert(near(p[0]!, 10) && near(p[1]!, 20), `radial centre ${p}`);
    const f = G.gradientUnitMatrix(focal);
    p = ap(f, 1, 0); assert(near(p[0]!, 0, 1e-9) && near(p[1]!, 40), `focal axis points at the focus: ${p}`);
    assert(near(G.gradientFocal(focal), 0.5), `focal ratio ${G.gradientFocal(focal)}`);
    eq(G.gradientFocal(radial), 0);
    const t = G.gradientUnitMatrix({ ...linear, transform: [2, 0, 0, 1, 5, 0] });
    p = ap(t, 1, 0); assert(near(p[0]!, 205) && near(p[1]!, 0), `gradient transform applies after the geometry: ${p}`);
  });

  test("gradientMatrix: the SWF fill matrix maps the ±16384-twip gradient square to shape twips (linear part ×20/16384, translate in px for writeMatrix), after the path transform", () => {
    need();
    const m = G.gradientMatrix(linear, [1, 0, 0, 1, 0, 0]);
    assert(near(m[0], 50 * 20 / 16384) && near(m[3], 50 * 20 / 16384) && near(m[1], 0) && near(m[2], 0), `scale ${m}`);
    assert(near(m[4], 50) && near(m[5], 0), `translate px ${m}`);
    const t = G.gradientMatrix(linear, [1, 0, 0, 1, 7, 3]);
    assert(near(t[4], 57) && near(t[5], 3), `path transform moves it ${t}`);
  });

  test("swfSpread pad/reflect/repeat → 0/1/2; resolveStops: ratios 0..255, colours from gray:N/#hex; rasterizeStops: exact endpoints, linear blend in between, pad outside", () => {
    need();
    eq(G.swfSpread(undefined), 0); eq(G.swfSpread("pad"), 0); eq(G.swfSpread("reflect"), 1); eq(G.swfSpread("repeat"), 2);
    const rs = G.resolveStops(linear.stops);
    eq(rs.length, 2);
    eq(rs[0].ratio, 0); eq(rs[1].ratio, 255);
    eq(JSON.stringify(rs[0].color), JSON.stringify({ r: 34, g: 34, b: 34, a: 255 }));
    eq(JSON.stringify(rs[1].color), JSON.stringify({ r: 255, g: 0, b: 0, a: 128 }));
    const px = G.rasterizeStops([{ ratio: 64, color: { r: 0, g: 0, b: 0, a: 255 } }, { ratio: 192, color: { r: 255, g: 255, b: 255, a: 255 } }], 256);
    eq(px.length, 256 * 4);
    eq(px[0], 0); eq(px[4 * 64], 0); eq(px[4 * 192], 255); eq(px[4 * 255], 255);
    assert(Math.abs(px[4 * 128] - 128) <= 1, `midpoint ${px[4 * 128]}`);
  });

  test("gradientT (shared with the shader): linear t=(u+1)/2; radial t=|uv|; focal radial t=0 at the focus and 1 on the circle; spreads pad/reflect/repeat", () => {
    need();
    assert(near(G.gradientT("linear", 0, -1, 0), 0) && near(G.gradientT("linear", 0, 1, 5), 1), "linear");
    assert(near(G.gradientT("radial", 0, 0.6, 0.8), 1), "radial");
    assert(near(G.gradientT("radial", 0.5, 0.5, 0), 0), "focus");
    assert(near(G.gradientT("radial", 0.5, -1, 0), 1) && near(G.gradientT("radial", 0.5, 0, 1), 1, 1e-9), "circle");
    assert(near(G.applySpread(1.25, "pad"), 1) && near(G.applySpread(1.25, "reflect"), 0.75) && near(G.applySpread(1.25, "repeat"), 0.25) && near(G.applySpread(-0.25, "repeat"), 0.75), "spreads");
  });

  test("encodeDefineShape3 writes gradient fills the reader reads back: 0x10 linear, 0x12 radial (spread bits), 0x13 focal; ratios, colours and the matrix round-trip", () => {
    need();
    const shape = { paths: [
      { d: "M0 0 L100 0 L100 50 L0 50 Z", fill: "gradient:lin" },
      { d: "M0 60 L100 60 L100 110 L0 110 Z", fill: "gradient:rad" },
      { d: "M0 120 L80 120 L80 200 L0 200 Z", fill: "gradient:foc" },
    ] };
    const enc = encodeDefineShape3(5, shape as any, { gradients: { lin: linear, rad: radial, foc: focal } } as any);
    assert(!enc.findings.some((f: any) => f.severity === "error"), JSON.stringify(enc.findings));
    const sh = readTags(enc.bytes, 0, enc.bytes.length)[0]!.shape as any;
    eq(sh.fillStyles.length, 3);
    const [a, b, c] = sh.fillStyles;
    eq(a.type, 0x10); eq(b.type, 0x12); eq(c.type, 0x13);
    eq(a.gradient.map((s: any) => s.ratio).join(","), "0,255");
    eq(a.gradient[1].color.a, 128);
    eq(b.gradient.map((s: any) => s.ratio).join(","), "0,128,255");
    eq(b.spread, 1, "reflect spread bits");
    assert(near(c.focalPoint, 0.5, 1 / 256), `focal ${c.focalPoint}`);
    // reader matrices are raw SWF: translate in twips
    assert(Math.abs(a.matrix[0] - 50 * 20 / 16384) < 1e-4 && Math.abs(a.matrix[4] - 1000) <= 1, `linear matrix ${a.matrix}`);
    assert(Math.abs(b.matrix[0] - 50 * 20 / 16384) < 1e-4 && Math.abs(b.matrix[4] - 200) <= 1 && Math.abs(b.matrix[5] - 400) <= 1, `radial matrix ${b.matrix}`);
  });

  test("emitSwf builds a scene with gradients and its reader self-check passes; minimalGateSwf({ fill: \"gradient\" }) parses with one gradient fill", () => {
    need();
    const sc = exampleScene("grad") as any;
    sc.gradients = { sky: linear };
    sc.shapes.body.paths[0].fill = "gradient:sky";
    const r = emitSwf(sc) as any;
    assert(r.ok, JSON.stringify(r.findings));
    const parsed = readSwf(r.bytes) as any;
    const fills = parsed.tags.filter((t: any) => t.shape).flatMap((t: any) => t.shape.fillStyles);
    assert(fills.some((f: any) => f.type === 0x10), "a linear fill in the file");
    const gate = minimalGateSwf({ withAbc: false, linkage: "_Append_AbilityIcon", label: "gradient", layout: "flat", fill: "gradient" } as any);
    const gf = (readSwf(gate) as any).tags.filter((t: any) => t.shape).flatMap((t: any) => t.shape.fillStyles);
    eq(gf.length, 1); eq(gf[0].type, 0x10);
  });

  test("importSvg keeps <linearGradient>/<radialGradient> (stops, spreadMethod, gradientTransform, href chaining, objectBoundingBox) as scene gradients instead of gray:8", () => {
    const svg = readFileSync(join(HERE, "fixtures", "art", "gradients.svg"), "utf8");
    const res = importSvg(svg, {}) as any;
    assert(res.ok, JSON.stringify(res.findings));
    assert(!res.findings.some((f: any) => f.code === "svg-paint-server"), JSON.stringify(res.findings));
    const gs = res.gradients || {};
    const fills = res.paths.map((p: any) => p.fill);
    eq(fills[0], "gradient:sky");
    const sky = gs.sky;
    assert(sky && sky.kind === "linear" && sky.x1 === 0 && sky.x2 === 200 && sky.stops.length === 2, JSON.stringify(sky));
    eq(sky.stops[0].color, "gray:15");
    eq(sky.stops[1].color, "#3060c0");
    // radial via href: stops inherited from "base", own spread + centre
    assert(/^gradient:glow/.test(fills[1]), fills[1]);
    const glow = gs[fills[1].slice(9)];
    assert(glow && glow.kind === "radial" && glow.spread === "reflect" && glow.r === 30 && glow.stops.length === 3, JSON.stringify(glow));
    eq(glow.stops[1].color, "#ff000080", "stop-opacity becomes alpha");
    // objectBoundingBox: a per-path copy whose transform maps the unit box onto the path's box
    const bb = gs[fills[2].slice(9)];
    assert(bb && Array.isArray(bb.transform), JSON.stringify(bb));
    assert(near(bb.transform[0], 50) && near(bb.transform[3], 20) && near(bb.transform[4], 300) && near(bb.transform[5], 10), `bbox ${bb.transform}`);
    // gradientTransform kept
    const tr = gs[fills[3].slice(9)];
    assert(tr && Array.isArray(tr.transform) && near(tr.transform[0], 2), JSON.stringify(tr));
  });

  test("preview-gl.ts draws gradient fills through gradient.ts (unit matrix, focal, spread, a stop texture), never as the missing-fill magenta", () => {
    const src = readFileSync(join(HERE, "..", "web", "src", "art", "preview-gl.ts"), "utf8");
    assert(/from "..\/..\/..\/src\/core\/art\/gradient\.ts"/.test(src), "imports gradient.ts");
    assert(/path\.fill\.kind === "gradient"/.test(src), "handles gradient fills");
    assert(/rasterizeStops\(/.test(src) && /gradientUnitMatrix\(/.test(src), "stop texture + unit matrix");
    assert(/u_focal/.test(src) && /u_spread/.test(src), "shader uniforms");
    assert(/createLinearGradient|createRadialGradient/.test(src), "Canvas2D fallback");
  });
}
