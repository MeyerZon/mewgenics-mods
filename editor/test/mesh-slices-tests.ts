// The M3 per-band mesh slices read from shots + the framework log (editor/src/core/art/mesh-slices.ts): the
// "mesh slice ..." lines (native/framework/src/fw_mesh_slice.c fw_mesh_slice_fmt, host-pinned in test_mesh_slice.c:
// one per band of a tile mesh, with its painter key and the screen area its front faces show inside the band) and the
// per-band coverage: pixels of the band's measurement tint (MEWFW_MESH_PROBE_TINT: blue, cyan, magenta repeating)
// inside the band's box / the pixels it shows when nothing covers it. A band behind a unit loses part of it to the
// unit's sprite ("under"); a band in front of a unit keeps all of it ("over").
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";
import * as ms from "../src/core/art/mesh-slices.ts";
import type { RgbaImageLike } from "../src/core/art/glow-measure.ts";

export function runMeshSlicesTests(test: TestFn, assert: AssertFn, eq: EqFn, fixture?: (name: string) => string | null): void {
  console.log("\n# mesh slices (3D phase M3): multi-tile meshes per sort band + the mesh/unit tie, from shots + the framework log");
  const LOG = [
    "[12:00:01.000] mesh: probe model models/slab2x1.obj on tile (0,6) (MEWFW_MESH_PROBE_MODEL @), tinted per band",
    "mesh slice f=1 obj=1 band=0/3 depth=[6.000 7.000) key=6.500 vis=(-0.2500 -0.2500 0.2500 0.2500) area=0.250000 tint=blue",
    "mesh slice f=1 obj=1 band=1/3 depth=[7.000 8.000) key=7.500 vis=(-0.2500 0.2500 0.2500 0.5000) area=0.125000 tint=cyan",
    "mesh slice f=61 obj=1 band=0/3 depth=[6.000 7.000) key=6.500 vis=(-0.2500 -0.2500 0.2500 0.2500) area=0.250000 tint=blue",
    "mesh slice f=61 obj=1 band=1/3 depth=[7.000 8.000) key=7.500 vis=(-0.2500 0.2500 0.2500 0.5000) area=0.125000 tint=cyan",
    "mesh slice f=61 obj=1 band=2/3 depth=[8.000 9.000) key=8.500 vis=(0.5000 0.5000 0.7500 0.7500) area=0.000000 tint=-",
  ].join("\n");
  test("parseMeshSliceLog: frame, object, band i/n, the band, its key, the visible box + area, the tint (- = none)", () => {
    const p = ms.parseMeshSliceLog(LOG);
    eq(p.length, 5);
    eq(JSON.stringify(p[0]), JSON.stringify({ frame: 1, obj: 1, band: 0, bands: 3, depth: [6, 7], key: 6.5, vis: [-0.25, -0.25, 0.25, 0.25], area: 0.25, tint: "blue" }));
    eq(p[4]!.tint, null);
    eq(p[3]!.band, 1); eq(p[3]!.key, 7.5);
  });
  test("tintOf: blue / cyan / magenta by the ratio to blue (shaded and edge-blended pixels too); grey, white, red, orange, green are none", () => {
    eq(ms.tintOf(0, 0, 255), "blue"); eq(ms.tintOf(0, 0, 115), "blue");          // the darkest shade (ambient .45)
    eq(ms.tintOf(0, 255, 255), "cyan"); eq(ms.tintOf(10, 160, 161), "cyan");
    eq(ms.tintOf(255, 0, 255), "magenta"); eq(ms.tintOf(161, 5, 160), "magenta");
    eq(ms.tintOf(0, 100, 255), "blue"); eq(ms.tintOf(0, 140, 255), "cyan");       // a blue/cyan edge pixel: one class, never both
    for (const c of [[128, 128, 128], [255, 255, 255], [255, 0, 0], [230, 150, 60], [0, 200, 0], [20, 20, 40]] as const)
      eq(ms.tintOf(c[0], c[1], c[2]), null, c.join(","));
  });
  const W = 640, H = 360;
  const line: ms.MeshSliceLine = { frame: 61, obj: 1, band: 0, bands: 2, depth: [6, 7], key: 6.5, vis: [-0.25, -0.25, 0.25, 0.25], area: 0.25, tint: "blue" };
  const line1: ms.MeshSliceLine = { ...line, band: 1, depth: [7, 8], key: 7.5, vis: [-0.25, 0.3, 0.25, 0.55], area: 0.125, tint: "cyan" };
  // band 0: x 240..400, y 135..225 (= 0.25 x 320 x 180 = 14400 px), band 1: x 240..400, y 81..126 (7200 px)
  const shot = (cover0: number, cover1: number, seed = 0): RgbaImageLike => {
    const img = new Uint8Array(W * H * 4);
    img[0] = seed;
    for (let y = 135; y < 225; y++) for (let x = 240; x < 400; x++) img.set(x < 240 + cover0 * 160 ? [200, 200, 200, 255] : [0, 0, 200, 255], (y * W + x) * 4);
    for (let y = 81; y < 126; y++) for (let x = 240; x < 400; x++) img.set(x < 240 + cover1 * 160 ? [200, 200, 200, 255] : [0, 180, 180, 255], (y * W + x) * 4);
    return { width: W, height: H, rgba: img };
  };
  test("measureSlice: expected px from the visible area (letterbox-aware), tint px inside the band's box, their ratio", () => {
    const m = ms.measureSlice(shot(0, 0), line);
    eq(Math.round(m.expectedPx), 14400); eq(m.px, 14400); eq(m.coverage, 1);
    eq(ms.measureSlice(shot(0.25, 0), line).coverage, 0.75);
    eq(ms.measureSlice(shot(0, 0.5), line1).coverage, 0.5);
    eq(ms.measureSlice(shot(0, 0), line1).px, 7200, "the cyan band counts cyan only (the blue band beside it is not counted)");
  });
  test("judgeSlices: per band, under passes when a unit hides part of it (<= 0.85), over when nothing does (>= 0.9); the latest frame, the last shot", () => {
    const lines = [{ ...line, frame: 1, vis: [-0.9, -0.9, -0.8, -0.8] as [number, number, number, number] }, line, line1];
    const ok = ms.judgeSlices([shot(0, 0, 1), shot(0, 0.4, 2)], lines, { 0: "over", 1: "under" });
    eq(ok.verdict, "as-expected"); eq(ok.pass, true); eq(ok.shot, 1); eq(ok.frame, 61); eq(ok.obj, 1);
    eq(ok.bands.length, 2);
    eq(ok.bands[1]!.pass, true); eq(Math.round(ok.bands[1]!.coverage * 100), 60);
    const wrong = ms.judgeSlices([shot(0, 0, 1), shot(0, 0, 2)], lines, { 0: "over", 1: "under" });
    eq(wrong.verdict, "wrong"); eq(wrong.bands[1]!.pass, false);
    const free = ms.judgeSlices([shot(0, 0, 1), shot(0.3, 0, 2)], lines, {});
    eq(free.verdict, "as-expected"); eq(free.bands[0]!.pass, null, "no expectation: measured, not judged");
    eq(ms.judgeSlices([shot(0, 1, 1), shot(0, 1, 2)], lines, { 1: "under" }).verdict, "missing-band");
    eq(ms.judgeSlices([shot(0, 0), shot(0, 0)], lines, {}).verdict, "stale-shots");
    eq(ms.judgeSlices([shot(0, 0)], [], {}).verdict, "no-slice-lines");
    eq(ms.judgeSlices([], lines, {}).verdict, "no-shots");
  });
  void fixture;
}
