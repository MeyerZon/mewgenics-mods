// Baked glows (art build-out, 2026-10-21): the game's SWF player stops on any PlaceObject3 filter list (OBSERVED,
// PlaceObject::decode3 0xb78210, "ERROR: FILTERS NOT SUPPORTED"), so a glow / drop shadow is baked as an ordinary
// halo shape behind the source: N concentric bands of the source outline, offset outward, with decreasing alpha
// (src/core/art/glow.ts). The validator reports baked halos (glow-baked) and points filter-unsupported at the bake.

import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exampleScene, validateScene } from "../src/core/art/scene.ts";
import { normalizePath, flattenSubpath, subpathBounds, unionBounds } from "../src/core/art/geometry.ts";
import { windingNumber } from "../src/core/art/shape.ts";
import { emitSwf } from "../src/core/art/swf-emitter.ts";
import { readSwf, flattenTags } from "../src/core/art/swf-reader.ts";
import * as api from "../src/core/api.ts";
import { MODS_DIR } from "../src/core/repo.ts";
import type { Bounds } from "../src/core/art/geometry.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const near = (a: number, b: number, eps = 0.6) => Math.abs(a - b) <= eps;

/** Bounds of every path of a shape (transforms applied). */
function shapeBounds(shape: { paths: Array<{ d: string; transform?: number[] }> }): Bounds {
  let b: Bounds | null = null;
  for (const p of shape.paths) b = unionBounds(b, subpathBounds(normalizePath(p.d, { matrix: p.transform as never })));
  return b!;
}

/** Software stand-in for the preview: how many integer px of a window a shape covers (nonzero / evenodd per path). */
function coveredPixels(shape: { paths: Array<{ d: string; fill?: string | null; fillRule?: string; transform?: number[] }> }, win: Bounds): number {
  const polys = shape.paths.filter((p) => p.fill && p.fill !== "none").map((p) => ({ evenodd: p.fillRule === "evenodd", rings: normalizePath(p.d, { matrix: p.transform as never }).map((s) => flattenSubpath(s, 0.25)) }));
  let n = 0;
  for (let y = Math.floor(win.ymin); y <= Math.ceil(win.ymax); y++) {
    for (let x = Math.floor(win.xmin); x <= Math.ceil(win.xmax); x++) {
      const px = x + 0.5, py = y + 0.5;
      if (polys.some((p) => { let w = 0; for (const r of p.rings) w += windingNumber(px, py, r); return p.evenodd ? (w & 1) !== 0 : w !== 0; })) n++;
    }
  }
  return n;
}

export async function runArtGlowTests(test: TestFn, assert: AssertFn, eq: EqFn): Promise<void> {
  console.log("\n# Art: baked glows / drop shadows (halo shapes, since the game refuses SWF filters)");
  let G: Record<string, any> = {};
  let gErr = "";
  try { G = await import("../src/core/art/glow.ts"); } catch (e) { gErr = e instanceof Error ? e.message : String(e); }
  const need = () => { if (gErr) throw new Error(`glow.ts: ${gErr}`); };
  const bake = (scene: unknown, id: string, o: Record<string, unknown>) => { need(); return G.bakeGlow(scene, id, o); };

  test("bakeGlow adds <id>_glow (N bands, default 4, same colour with decreasing alpha, nonzero) tagged `baked`; the source shape and the input scene are untouched", () => {
    const sc = exampleScene("g") as any;
    const before = JSON.stringify(sc);
    const r = bake(sc, "body", { color: "#ff8000", blur: 8 });
    assert(r.ok, JSON.stringify(r.findings));
    eq(JSON.stringify(sc), before, "input scene not mutated");
    eq(r.glowId, "body_glow");
    const halo = r.scene.shapes.body_glow;
    assert(halo, "halo shape exists");
    eq(halo.paths.length, 4);
    const alphas = halo.paths.map((p: any) => parseInt(String(p.fill).slice(7, 9), 16));
    assert(halo.paths.every((p: any) => /^#ff8000[0-9a-f]{2}$/.test(p.fill) && (p.fillRule || "nonzero") === "nonzero"), JSON.stringify(halo.paths.map((p: any) => p.fill)));
    // outermost band first (faintest), innermost last (strongest): 64, 128, 191, 255
    assert(alphas.every((a: number, i: number) => i === 0 || a > alphas[i - 1]), alphas.join(","));
    eq(alphas[alphas.length - 1], 255);
    eq(JSON.stringify(r.scene.shapes.body), JSON.stringify(sc.shapes.body), "source shape unchanged");
    eq(halo.baked.kind, "glow"); eq(halo.baked.of, "body"); eq(halo.baked.blur, 8); eq(halo.baked.color, "#ff8000");
    assert(halo.paths.every((p: any) => !p.transform && !p.stroke), "halo paths are plain filled polygons");
  });

  test("geometry: each band is the source outline pushed out by blur·k/N (the example rectangle -40..40 × -30..30 grows by 2, 4, 6, 8 px per side); numbers have at most 2 decimals and no -0", () => {
    const sc = exampleScene("g") as any;
    const r = bake(sc, "body", { color: "gray:15", blur: 8 });
    assert(r.ok, JSON.stringify(r.findings));
    const halo = r.scene.shapes.body_glow;
    const srcB = shapeBounds(sc.shapes.body);
    halo.paths.forEach((p: any, i: number) => {
      const b = subpathBounds(normalizePath(p.d))!;
      const d = 8 * (4 - i) / 4;
      assert(near(b.xmin, srcB.xmin - d) && near(b.xmax, srcB.xmax + d) && near(b.ymin, srcB.ymin - d) && near(b.ymax, srcB.ymax + d), `band ${i}: ${JSON.stringify(b)} vs ${JSON.stringify(srcB)} ± ${d}`);
      assert(!/-0(?![.\d])/.test(p.d) && !/\d\.\d{3,}/.test(p.d), p.d.slice(0, 80));
    });
    // the halo as a whole grows the bounds by exactly blur
    const hb = shapeBounds(halo);
    assert(near(hb.xmin, srcB.xmin - 8) && near(hb.ymax, srcB.ymax + 8), JSON.stringify(hb));
  });

  test("byte-stable: the same input bakes to the same JSON twice; the paths carry no transform", () => {
    const a = bake(exampleScene("g"), "body", { color: "#ffffff80", blur: 6, strength: 1.5 });
    const b = bake(exampleScene("g"), "body", { color: "#ffffff80", blur: 6, strength: 1.5 });
    eq(JSON.stringify(a.scene), JSON.stringify(b.scene));
  });

  test("the bands do not overlap (annuli): a point in band 2 is covered by exactly one path; the innermost band is a full disc that also covers the source's own area", () => {
    const sc = exampleScene("g") as any;
    const r = bake(sc, "body", { color: "#ffffff", blur: 8 });
    const halo = r.scene.shapes.body_glow;
    const cover = (px: number, py: number) => halo.paths.filter((p: any) => normalizePath(p.d).map((s) => flattenSubpath(s, 0.25)).reduce((w: number, ring: number[]) => w + windingNumber(px, py, ring), 0) !== 0).length;
    eq(cover(40 + 5, 0), 1, "5 px outside the right edge: one band (band 3 of 4 covers 4..6)");
    eq(cover(40 + 1, 0), 1, "1 px outside: the innermost band only");
    eq(cover(0, 0), 1, "inside the source: the innermost disc only");
    eq(cover(40 + 9, 0), 0, "beyond blur: nothing");
  });

  test("holes stay holes: a ring source (evenodd) bakes to a halo whose innermost band leaves the centre of the hole uncovered but covers just inside the inner edge", () => {
    const sc = exampleScene("g") as any;
    sc.shapes.ring = { paths: [{ d: "M-40 -40 L40 -40 L40 40 L-40 40 Z M-20 -20 L20 -20 L20 20 L-20 20 Z", fill: "gray:8", fillRule: "evenodd" }] };
    const r = bake(sc, "ring", { color: "#ffffff", blur: 4, steps: 2 });
    assert(r.ok, JSON.stringify(r.findings));
    const halo = r.scene.shapes.ring_glow;
    eq(halo.paths.length, 2);
    const inner = halo.paths[halo.paths.length - 1];
    const rings = normalizePath(inner.d).map((s) => flattenSubpath(s, 0.25));
    const wn = (px: number, py: number) => rings.reduce((w, ring) => w + windingNumber(px, py, ring), 0);
    eq(wn(0, 0), 0, "hole centre stays empty");
    assert(wn(19, 0) !== 0, "1 px inside the hole edge is halo");
    assert(wn(41, 0) !== 0, "1 px outside the outer edge is halo");
    assert(wn(-45, 0) === 0, "5 px outside is beyond the 2-px innermost band");
  });

  test("z-order: every sprite that places the source gets a layer with <id>_glow immediately below it, keys mirrored (frame, x, y, tween); depths stay unique and the scene validates", () => {
    const sc = exampleScene("g") as any;
    const r = bake(sc, "eye", { color: "#ff2020", blur: 4 });
    assert(r.ok, JSON.stringify(r.findings));
    eq(JSON.stringify(r.layersAdded), JSON.stringify([{ sprite: "Starter", depth: 2 }]));
    const sp = r.scene.sprites.Starter;
    const order = sp.layers.slice().sort((a: any, b: any) => a.depth - b.depth).map((l: any) => l.keys[0].ref);
    eq(order.join(">"), "body>eye_glow>eye");
    const glowLayer = sp.layers.find((l: any) => l.keys[0].ref === "eye_glow");
    const eyeLayer = sp.layers.find((l: any) => l.keys[0].ref === "eye");
    eq(glowLayer.keys.length, eyeLayer.keys.length);
    glowLayer.keys.forEach((k: any, i: number) => {
      const e = eyeLayer.keys[i];
      eq(k.frame, e.frame); eq(k.x, e.x); eq(k.y, e.y); eq(k.sy ?? 1, e.sy ?? 1); eq(k.tween ?? "hold", e.tween ?? "hold"); eq(k.ref, "eye_glow");
    });
    assert(glowLayer.name === undefined, "the halo layer has no instance name");
    const depths = sp.layers.map((l: any) => l.depth);
    eq(new Set(depths).size, depths.length);
    const v = validateScene(r.scene);
    assert(v.ok, JSON.stringify(v.findings.filter((f) => f.severity === "error")));
    assert(v.findings.some((f) => f.code === "glow-baked" && f.severity === "info" && /eye_glow/.test(f.message) && /eye/.test(f.message)), JSON.stringify(v.findings));
  });

  test("a layer that swaps refs keeps the halo only on the source's keys (ref: null elsewhere); a source placed by no sprite gets an info finding glow-unplaced and no layer", () => {
    const sc = exampleScene("g") as any;
    sc.sprites.Swap = { frames: 4, layers: [{ depth: 1, keys: [{ frame: 0, ref: "body", x: 1 }, { frame: 2, ref: "eye", x: 2 }] }] };
    const r = bake(sc, "body", { color: "#ffffff", blur: 2 });
    const gl = r.scene.sprites.Swap.layers.find((l: any) => l.keys[0].ref === "body_glow");
    assert(gl, "halo layer in Swap");
    eq(gl.keys[1].ref, null);
    const lone = exampleScene("g") as any;
    lone.shapes.loose = { paths: [{ d: "M0 0 L10 0 L10 10 Z", fill: "gray:3" }] };
    const r2 = bake(lone, "loose", { color: "#ffffff", blur: 2 });
    assert(r2.ok && r2.scene.shapes.loose_glow, "halo baked");
    eq(r2.layersAdded.length, 0);
    assert(r2.findings.some((f: any) => f.code === "glow-unplaced"), JSON.stringify(r2.findings));
  });

  test("refusals: unknown shape (glow-shape), bad colour (glow-color), blur outside 0.5..255 (glow-blur), steps outside 1..8 (glow-steps), an existing <id>_glow without replace (glow-exists); replace re-bakes without duplicating the layer", () => {
    const sc = exampleScene("g") as any;
    const codes = (r: any) => r.findings.map((f: any) => f.code).join(",");
    let r = bake(sc, "nope", { color: "#fff", blur: 4 });
    assert(!r.ok && /glow-shape/.test(codes(r)), codes(r));
    r = bake(sc, "body", { color: "sparkle", blur: 4 });
    assert(!r.ok && /glow-color/.test(codes(r)), codes(r));
    r = bake(sc, "body", { color: "#fff", blur: 0 });
    assert(!r.ok && /glow-blur/.test(codes(r)), codes(r));
    r = bake(sc, "body", { color: "#fff", blur: 4, steps: 0 });
    assert(!r.ok && /glow-steps/.test(codes(r)), codes(r));
    const once = bake(sc, "body", { color: "#fff", blur: 4 });
    r = bake(once.scene, "body", { color: "#fff", blur: 4 });
    assert(!r.ok && /glow-exists/.test(codes(r)), codes(r));
    r = bake(once.scene, "body", { color: "#00ff00", blur: 6, replace: true });
    assert(r.ok, codes(r));
    eq(r.scene.sprites.Starter.layers.filter((l: any) => l.keys[0].ref === "body_glow").length, 1, "no duplicate halo layer");
    eq(r.scene.sprites.Starter.layers.length, 3);
    assert(r.scene.shapes.body_glow.paths[0].fill.startsWith("#00ff00"), r.scene.shapes.body_glow.paths[0].fill);
    // the source shape is never touched, whatever the options
    eq(JSON.stringify(r.scene.shapes.body), JSON.stringify(sc.shapes.body));
  });

  test("strength scales the band alphas (0.5 halves them, 2 saturates the inner bands); the colour's own alpha is the ceiling", () => {
    const half = bake(exampleScene("g"), "body", { color: "#ffffff", blur: 8, strength: 0.5 }).scene.shapes.body_glow.paths.map((p: any) => parseInt(p.fill.slice(7, 9), 16));
    eq(half[half.length - 1], 128);
    const two = bake(exampleScene("g"), "body", { color: "#ffffff", blur: 8, strength: 2 }).scene.shapes.body_glow.paths.map((p: any) => parseInt(p.fill.slice(7, 9), 16));
    eq(two[two.length - 1], 255); eq(two[two.length - 2], 255); eq(two[0], 128);
    const ceil = bake(exampleScene("g"), "body", { color: "#ffffff80", blur: 8 }).scene.shapes.body_glow.paths.map((p: any) => parseInt(p.fill.slice(7, 9), 16));
    eq(ceil[ceil.length - 1], 128);
  });

  test("bakeDropShadow = bakeGlow with kind dropShadow: the halo is shifted by dx, dy (in the shape's local px) and tagged kind dropShadow", () => {
    need();
    const sc = exampleScene("g") as any;
    const glow = bake(sc, "body", { color: "#00000080", blur: 4 });
    const shadow = G.bakeDropShadow(sc, "body", { color: "#00000080", blur: 4, dx: 5, dy: 7 });
    assert(shadow.ok, JSON.stringify(shadow.findings));
    const gb = shapeBounds(glow.scene.shapes.body_glow);
    const sb = shapeBounds(shadow.scene.shapes.body_glow);
    assert(near(sb.xmin, gb.xmin + 5) && near(sb.xmax, gb.xmax + 5) && near(sb.ymin, gb.ymin + 7) && near(sb.ymax, gb.ymax + 7), JSON.stringify([gb, sb]));
    eq(shadow.scene.shapes.body_glow.baked.kind, "dropShadow");
    eq(shadow.scene.shapes.body_glow.baked.dx, 5);
  });

  test("validator: filter-unsupported points at bakeGlow / bake_glow and the engine's own knobs (CharacterLightSource, AdvancedTint); a baked halo whose source is gone is a warning glow-orphan", () => {
    const sc = exampleScene("g") as any;
    sc.sprites.Starter.layers[0].keys[0].filters = [{ type: "glow", color: "#ff2020", blurX: 8, blurY: 8 }];
    const v = validateScene(sc);
    const f = v.findings.find((x) => x.code === "filter-unsupported");
    assert(!!f && /bake_glow|bakeGlow/.test(f.message) && /CharacterLightSource/.test(f.message) && /AdvancedTint/.test(f.message), JSON.stringify(f));
    const sc2 = bake(exampleScene("g"), "body", { color: "#fff", blur: 4 }).scene;
    delete sc2.shapes.body;
    for (const l of sc2.sprites.Starter.layers) l.keys = l.keys.map((k: any) => (k.ref === "body" ? { ...k, ref: "eye" } : k));
    sc2.exports = { Starter: "Starter" };
    const v2 = validateScene(sc2);
    assert(v2.findings.some((x) => x.code === "glow-orphan" && x.severity === "warning"), JSON.stringify(v2.findings));
  });

  test("preview: the halo is ordinary shapes, so the rendered footprint grows — source + halo cover more px than the source alone and the bbox grows by blur", () => {
    const sc = exampleScene("g") as any;
    const r = bake(sc, "body", { color: "#ffcc00", blur: 8 });
    const win = { xmin: -60, ymin: -50, xmax: 60, ymax: 50 };
    const alone = coveredPixels(sc.shapes.body, win);
    const halo = coveredPixels(r.scene.shapes.body_glow, win);
    assert(halo > alone, `${halo} > ${alone}`);
    // the rectangle 80×60 → 96×76: about 1 - 80·60/(96·76) = 34% more
    assert(halo >= alone * 1.3 && halo <= alone * 1.6, `${halo} / ${alone}`);
    const hb = shapeBounds(r.scene.shapes.body_glow);
    const sb = shapeBounds(sc.shapes.body);
    assert(near(hb.xmax - hb.xmin, sb.xmax - sb.xmin + 16) && near(hb.ymax - hb.ymin, sb.ymax - sb.ymin + 16), JSON.stringify([sb, hb]));
  });

  test("emitSwf builds a scene with a baked halo: one more DefineShape3, no PlaceObject3, the halo placed under the source in the sprite", () => {
    const sc = exampleScene("g") as any;
    const plain = emitSwf(sc);
    const r = bake(sc, "body", { color: "#ffcc00", blur: 8 });
    const out = emitSwf(r.scene);
    assert(!out.findings.some((f) => f.severity === "error"), JSON.stringify(out.findings));
    const count = (bytes: Uint8Array, name: string) => flattenTags((readSwf(bytes) as any).tags).filter((t: any) => t.name === name).length;
    eq(count(out.bytes, "DefineShape3"), count(plain.bytes, "DefineShape3") + 1);
    eq(count(out.bytes, "PlaceObject3"), 0);
  });

  const tmpMod = "__glow_tmp";
  rmSync(join(MODS_DIR, tmpMod), { recursive: true, force: true });
  const tools = await import("../src/mcp/tools.ts");
  test("api.bakeGlowIntoScene reads the scene, bakes, writes it back (refuses an unknown scene / shape); the MCP tool bake_glow exists with that schema", () => {
    const a = api as unknown as Record<string, any>;
    assert(typeof a.bakeGlowIntoScene === "function", "api.bakeGlowIntoScene exported");
    assert(api.newArtScene(tmpMod, "gl").ok, "scene");
    const r = a.bakeGlowIntoScene({ mod: tmpMod, scenePath: "art/gl.scene.json", shapeId: "body", color: "#ff8000", blur: 6 });
    assert(r.ok && r.glowId === "body_glow", JSON.stringify(r));
    const back = api.readArtScene(tmpMod, "art/gl.scene.json").scene!;
    assert(back.shapes.body_glow && back.shapes.body_glow.paths.length === 4, "halo saved");
    assert(!a.bakeGlowIntoScene({ mod: tmpMod, scenePath: "art/gl.scene.json", shapeId: "nope", color: "#fff", blur: 6 }).ok, "unknown shape");
    assert(!a.bakeGlowIntoScene({ mod: tmpMod, scenePath: "art/missing.scene.json", shapeId: "body", color: "#fff", blur: 6 }).ok, "unknown scene");
    const t = (tools.TOOLS as Array<{ name: string; inputSchema: unknown }>).find((x) => x.name === "bake_glow");
    assert(!!t, "bake_glow tool");
    const props = Object.keys((t!.inputSchema as any).properties || {});
    for (const k of ["mod", "path", "shapeId", "color", "blur", "strength", "kind", "dx", "dy", "steps", "replace"]) assert(props.includes(k), `schema has ${k}: ${props.join(",")}`);
  });
  rmSync(join(MODS_DIR, tmpMod), { recursive: true, force: true });

  test("the Art mode shape row has a Bake glow control (SceneTabs.tsx calls bakeGlow from the core)", () => {
    const src = readFileSync(join(HERE, "..", "web", "src", "art", "SceneTabs.tsx"), "utf8");
    assert(/Bake glow/.test(src), "a Bake glow button");
    assert(/bakeGlow/.test(src) && /core\/art\/glow\.ts/.test(src), "wired to src/core/art/glow.ts");
  });
}
