// 3D phase M2/M3 textures, palette and glTF in a fight: the generated mods/fw-3d assets (crate.png, pillar.glb) stay
// byte-for-byte what editor/src/core/art/fw3d-assets.ts makes; the expected on-screen colours (fw_mesh.shader's Lambert
// shade, the paletted_full rule) and the shot measurement around a logged object anchor
// (editor/src/core/art/mesh-measure.ts; "mesh object ... ndc=(..) tex=.. palette=.." from fw_mesh_tex.c
// fw_mesh_fmt_object, host-pinned in native/framework/test/test_mesh_tex.c); the OBSERVED T2 runs pinned as fixtures.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";
import * as mm from "../src/core/art/mesh-measure.ts";
import { decodePng } from "../src/core/art/png.ts";
import { CRATE_TEXTURE, PILLAR, crateTexturePixels, crateTexturePng, pillarGlb, pillarGeometry } from "../src/core/art/fw3d-assets.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FW3D = join(HERE, "..", "..", "mods", "fw-3d");

export function runMeshTexTests(test: TestFn, assert: AssertFn, eq: EqFn, fixture?: (name: string) => string | null): void {
  console.log("\n# mesh textures + palette + glTF (3D phase M2/M3)");

  // ---- the generated assets ----
  test("mods/fw-3d/textures/models/crate.png is the generator's 16x16 8-bit RGBA 2-colour checker (decoded pixels equal)", () => {
    const path = join(FW3D, "textures", "models", "crate.png");
    assert(existsSync(path), "crate.png committed");
    const bytes = readFileSync(path);
    eq(bytes[24], 8, "bit depth 8"); eq(bytes[25], 6, "colour type 6 (RGBA): never a grey PNG (GL_LUMINANCE in a core context)");
    assert(bytes.length < 1024, `small (${bytes.length} B)`);
    const img = decodePng(bytes);
    eq(`${img.width}x${img.height}`, "16x16");
    eq(Buffer.compare(Buffer.from(img.rgba), Buffer.from(crateTexturePixels())), 0, "pixels = crateTexturePixels()");
    eq(Buffer.compare(Buffer.from(decodePng(crateTexturePng()).rgba), Buffer.from(crateTexturePixels())), 0, "the encoder round-trips");
    const colours = new Set<string>();
    for (let i = 0; i < img.rgba.length; i += 4) colours.add(`${img.rgba[i]},${img.rgba[i + 1]},${img.rgba[i + 2]},${img.rgba[i + 3]}`);
    eq([...colours].sort().join(" "), `${CRATE_TEXTURE.orange.join(",")},255 ${CRATE_TEXTURE.grey.join(",")},255`);
  });
  test("mods/fw-3d/models/pillar.glb equals pillarGlb() byte for byte (the generator is the source) and is a valid GLB 2.0 with NORMAL + TEXCOORD_0", () => {
    const path = join(FW3D, "models", "pillar.glb");
    assert(existsSync(path), "pillar.glb committed");
    const bytes = readFileSync(path);
    eq(Buffer.compare(bytes, Buffer.from(pillarGlb())), 0, "committed == generated (run node scripts/make-fw3d-assets.ts)");
    assert(bytes.length < 4096, `a few KB (${bytes.length} B)`);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    eq(dv.getUint32(0, true), 0x46546c67); eq(dv.getUint32(4, true), 2); eq(dv.getUint32(8, true), bytes.length);
    const jlen = dv.getUint32(12, true);
    eq(jlen % 4, 0);
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jlen)));
    eq(JSON.stringify(Object.keys(json.meshes[0].primitives[0].attributes)), '["POSITION","NORMAL","TEXCOORD_0"]');
    eq(JSON.stringify(json.materials[0].pbrMetallicRoughness.baseColorFactor), JSON.stringify(PILLAR.baseColor));
    eq(json.accessors[0].count, 24); eq(json.accessors[3].count, 36);
    eq(dv.getUint32(20 + jlen + 4, true), 0x004e4942, "BIN chunk");
    const g = pillarGeometry();
    eq(Math.max(...g.positions.filter((_, i) => i % 3 === 1)), PILLAR.height);
    eq(Math.min(...g.positions.filter((_, i) => i % 3 === 1)), 0, "feet on the floor");
  });

  // ---- the expected colours ----
  test("lambertShade = fw_mesh.shader's ambient 0.45 + 0.55 * max(n . normalize(-0.4, 1, -0.6), 0) (mesh_engine.c's light)", () => {
    eq(mm.lambertShade([0, 1, 0]).toFixed(5), "0.89611");
    eq(mm.lambertShade([-1, 0, 0]).toFixed(5), "0.62844");
    eq(mm.lambertShade([0, 0, -1]).toFixed(5), "0.71766");
    eq(mm.lambertShade([1, 0, 0]).toFixed(5), "0.45000");
    eq(mm.shadeColour([96, 96, 96], mm.lambertShade([0, 1, 0])).join(","), "86,86,86");
    eq(mm.shadeColour([230, 120, 20], mm.lambertShade([0, 1, 0])).join(","), "206,108,18");
  });
  test("paletteColumn = int(clamp(grey * shade) * 15 + 0.5) (the paletted_full rule: lighting moves along the row)", () => {
    eq(mm.paletteColumn(96, mm.lambertShade([0, 1, 0])), 5);
    eq(mm.paletteColumn(96, mm.lambertShade([-1, 0, 0])), 4);
    eq(mm.paletteColumn(96, mm.lambertShade([1, 0, 0])), 3);
    eq(mm.paletteColumn(255, 1), 15);
    eq(mm.paletteColumn(0, 1), 0);
  });

  // ---- reading the object line + counting colours around its anchor ----
  const LOG = [
    "mesh: texture models/crate.png for models/crate.obj: loaded 16x16 (Texture2D 000001A2B3C4D5E0)",
    "mesh: palette.png 16x256 (Texture2D 000001A2B3C4D600)",
    "mesh: model models/pillar.glb: model-texture-missing models/missing.png (textures/models/missing.png not on the mod path or in the gpak): base colour only",
    "mesh object f=61 handle=1 model=models/crate.obj tile world=(4.50 0.00 3.50) ndc=(0.25 -0.1 0.04) tex=models/crate.png palette=63",
    "mesh object f=1 handle=2 model=models/pillar.glb unit world=(2.50 0.00 5.50) ndc=(-0.5 0.2 0.03) tex=none palette=-1",
    "mesh object f=1 handle=3 model=models/old.obj tile world=(1.50 0.00 1.50)",
  ].join("\n");
  test("parseMeshProbeLog: object lines (model, anchor, ndc, tex, palette; an M1 line without them), texture lines and model-texture-missing", () => {
    const p = mm.parseMeshProbeLog(LOG);
    eq(p.objects.length, 3);
    eq(p.objects[0]!.model, "models/crate.obj"); eq(p.objects[0]!.anchor, "tile"); eq(p.objects[0]!.ndc!.join(","), "0.25,-0.1,0.04");
    eq(p.objects[0]!.tex, "models/crate.png"); eq(p.objects[0]!.palette, 63);
    eq(p.objects[1]!.anchor, "unit"); eq(p.objects[1]!.tex, null); eq(p.objects[1]!.palette, -1);
    eq(p.objects[2]!.ndc, null); eq(p.objects[2]!.palette, null);
    eq(p.textures.length, 2);
    eq(p.textureMissing.length, 1);
    assert(/models\/missing\.png/.test(p.textureMissing[0]!), "the missing line");
  });
  type Px = [number, number, number];
  const W = 640, H = 360;
  const scene = (patches: { x: number; y: number; w: number; h: number; c: Px }[], seed = 1) => {
    const img = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) img.set([40 + ((i * seed) % 7), 44, 40, 255], i * 4);
    for (const p of patches) for (let y = p.y; y < p.y + p.h; y++) for (let x = p.x; x < p.x + p.w; x++) img.set([p.c[0], p.c[1], p.c[2], 255], (y * W + x) * 4);
    return { width: W, height: H, rgba: img };
  };
  const targets: mm.ColourTarget[] = [{ name: "orange", rgb: [206, 108, 18] }, { name: "grey", rgb: [86, 86, 86] }];
  // ndc (0.25, -0.1) on 640x360 = (400, 198)
  const crate = [{ x: 380, y: 180, w: 20, h: 20, c: [206, 107, 19] as Px }, { x: 400, y: 180, w: 20, h: 20, c: [86, 86, 86] as Px }];
  test("countColours: pixels within the tolerance of each target inside a box", () => {
    const img = scene(crate);
    const c = mm.countColours(img, { x0: 370, y0: 170, x1: 430, y1: 230 }, targets, 3);
    eq(c.orange, 400); eq(c.grey, 400);
    eq(mm.countColours(img, { x0: 0, y0: 0, x1: 100, y1: 100 }, targets, 3).orange, 0);
  });
  test("judgeColourPatch: every target near the object's projected anchor = match; some = partial; none = absent; stale / no anchor / no shots refuse", () => {
    const obj = mm.parseMeshProbeLog(LOG).objects.filter((o) => o.model === "models/crate.obj");
    const opts = { minEach: 100 };
    const j = mm.judgeColourPatch([scene(crate), scene(crate, 3)], obj, targets, opts);
    eq(j.verdict, "match", JSON.stringify(j));
    eq(j.counts.orange, 400); eq(j.staleChecked, true);
    eq(mm.judgeColourPatch([scene([crate[0]!]), scene([crate[0]!], 3)], obj, targets, opts).verdict, "partial");
    eq(mm.judgeColourPatch([scene([]), scene([], 3)], obj, targets, opts).verdict, "absent");
    const far = crate.map((p) => ({ ...p, x: p.x - 300 }));
    eq(mm.judgeColourPatch([scene(far), scene(far, 3)], obj, targets, opts).verdict, "absent", "colours elsewhere in the shot do not count");
    eq(mm.judgeColourPatch([scene(crate), scene(crate)], obj, targets, opts).verdict, "stale-shots");
    eq(mm.judgeColourPatch([scene(crate)], [], targets, opts).verdict, "no-anchor");
    eq(mm.judgeColourPatch([], obj, targets, opts).verdict, "no-shots");
  });

}
