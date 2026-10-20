// PlaceObject3 (art build-out F): key blend modes and filters (blur / glow / dropShadow). A placement becomes a
// PlaceObject3 only when it carries a blend mode or filters (everything else stays PlaceObject2, byte-identical);
// the reader decodes it; the preview approximates the blends it can and reports the rest.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as emitter from "../src/core/art/swf-emitter.ts";
import { readTags, readSwf, flattenTags } from "../src/core/art/swf-reader.ts";
import { exampleScene, validateScene } from "../src/core/art/scene.ts";
import { bakeSprite, diffFrames } from "../src/core/art/timeline.ts";
import { SWF_GATE_VARIANTS } from "../src/core/art/art-io.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) <= eps;

export function runArtPo3Tests(test: TestFn, assert: AssertFn, eq: EqFn): void {
  console.log("\n# Art: PlaceObject3 (blend modes, filters)");
  const E = emitter as Record<string, any>;
  const glow = { type: "glow", color: "#ff2020", blurX: 16, blurY: 16, strength: 2 };

  test("validateScene: key blend must be a SWF blend mode (code blend), filters known types with sane numbers (code filter); blends/filters the preview cannot draw are info findings", () => {
    const sc = exampleScene("p3") as any;
    const k = sc.sprites.Starter.layers[0].keys[0];
    k.blend = "sparkle";
    k.filters = [{ type: "bevel" }, { type: "blur", blurX: -1, blurY: 4 }];
    const v = validateScene(sc) as any;
    const errs = v.findings.filter((f: any) => f.severity === "error").map((f: any) => f.code);
    assert(errs.includes("blend"), errs.join(","));
    eq(errs.filter((c: string) => c === "filter").length, 2, errs.join(","));
    const ok = exampleScene("p3") as any;
    Object.assign(ok.sprites.Starter.layers[0].keys[0], { blend: "difference", filters: [glow, { type: "blur", blurX: 4, blurY: 4 }, { type: "dropShadow", color: "#000000", angle: 45, distance: 4, blurX: 4, blurY: 4, strength: 1 }] });
    const v2 = validateScene(ok) as any;
    assert(v2.ok, JSON.stringify(v2.findings));
    const info = v2.findings.filter((f: any) => f.severity === "info").map((f: any) => f.code);
    assert(info.includes("filter-not-previewed"), info.join(","));
  });

  test("bakeSprite carries blend / filters on placements (held from their key, never tweened); diffFrames moves a placement whose blend or filters changed", () => {
    const sp = { frames: 3, labels: {}, layers: [{ depth: 1, keys: [
      { frame: 0, ref: "body", x: 0, tween: "linear" },
      { frame: 1, ref: "body", x: 10, blend: "add", filters: [glow] },
    ] }] } as any;
    const b = bakeSprite(sp) as any;
    eq(b.placements[0][0].blend ?? null, null);
    eq(b.placements[1][0].blend, "add");
    eq(b.placements[2][0].filters.length, 1);
    const ops = diffFrames(b.placements[0], b.placements[1]) as any[];
    eq(ops.length, 1); eq(ops[0].op, "move");
    assert(ops[0].changedEffects === true, JSON.stringify(ops[0]));
  });

  test("encodePlaceObject3 round-trips through the reader: flags, character, matrix, name, blend code, blur / glow / dropShadow filters", () => {
    assert(typeof E.encodePlaceObject3 === "function", "swf-emitter exports encodePlaceObject3");
    const bytes = E.encodePlaceObject3({ move: false, depth: 3, characterId: 7, matrix: [1, 0, 0, 1, 10, 20], name: "fx", blend: "add", filters: [
      { type: "blur", blurX: 4, blurY: 6, quality: 2 },
      glow,
      { type: "dropShadow", color: "#00000080", angle: 45, distance: 5, blurX: 3, blurY: 3, strength: 1.5, inner: true },
    ] });
    const t = readTags(bytes, 0, bytes.length)[0] as any;
    eq(t.name, "PlaceObject3");
    const p = t.place;
    eq(p.depth, 3); eq(p.characterId, 7); eq(p.name, "fx"); eq(p.blendMode, 8, "add = 8");
    eq(p.filters.length, 3);
    const [bl, gl, ds] = p.filters;
    eq(bl.type, "blur"); assert(near(bl.blurX, 4) && near(bl.blurY, 6), JSON.stringify(bl)); eq(bl.passes, 2);
    eq(gl.type, "glow"); eq(gl.color.r, 255); eq(gl.color.g, 32); assert(near(gl.strength, 2), JSON.stringify(gl));
    eq(ds.type, "dropShadow"); assert(near(ds.angle, Math.PI / 4) && near(ds.distance, 5) && ds.inner === true, JSON.stringify(ds));
    eq(ds.color.a, 128);
  });

  test("emitSwf: a scene without blend/filters writes only PlaceObject2; a key with blend add writes a PlaceObject3 the reader reads back", () => {
    const plain = readSwf(emitter.emitSwf(exampleScene("p3")).bytes) as any;
    const names = flattenTags(plain.tags).map((t: any) => t.name);
    assert(!names.includes("PlaceObject3") && names.includes("PlaceObject2"), names.join(","));
    const sc = exampleScene("p3") as any;
    sc.sprites.Starter.layers[0].keys[0].blend = "add";
    const r = emitter.emitSwf(sc);
    assert(!r.findings.some((f) => f.severity === "error"), JSON.stringify(r.findings));
    const po3 = flattenTags((readSwf(r.bytes) as any).tags).filter((t: any) => t.name === "PlaceObject3");
    assert(po3.length >= 1 && (po3[0] as any).place.blendMode === 8, JSON.stringify(po3.map((t: any) => t.place)));
  });

  test("the SWF gate has a blend variant (the icon square placed with blend add + a glow → PlaceObject3), expected to boot", () => {
    const v = (SWF_GATE_VARIANTS as Record<string, any>).blend;
    assert(!!v, "variant exists");
    eq(v.expect, "pass");
    const bytes = emitter.minimalGateSwf({ withAbc: false, linkage: v.linkage, label: "x", layout: v.layout, effects: v.effects } as any);
    const tags = flattenTags((readSwf(bytes) as any).tags).map((t: any) => t.name);
    assert(tags.includes("PlaceObject3"), tags.join(","));
  });

  test("preview-gl.ts approximates add / multiply / screen in GL (blendFunc) and maps blends to globalCompositeOperation in Canvas2D", () => {
    const src = readFileSync(join(HERE, "..", "web", "src", "art", "preview-gl.ts"), "utf8");
    assert(/blendModeFunc|applyBlend/.test(src), "a blend helper");
    assert(/"add"/.test(src) && /"multiply"/.test(src) && /"screen"/.test(src), "the three GL blends");
    assert(/globalCompositeOperation/.test(src), "Canvas2D blend");
  });
}
