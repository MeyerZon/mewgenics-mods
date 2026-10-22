// The M2 sprite/mesh occlusion proof read from shots + the framework log (editor/src/core/art/mesh-measure.ts): the
// "mesh occ ..." line (the probe cube's projected silhouette: NDC bbox + convex-hull area, native/framework/src/
// fw_mesh_order.c fw_mesh_order_fmt_occ, host-pinned in test_mesh_order.c), the "mesh order ..." plan lines (where each
// mesh was inserted into the units layer's painter order) and the coverage measure: magenta pixels inside the
// silhouette's box / the pixels an unoccluded flat cube covers. A cube behind a unit loses part of its silhouette to
// the unit's sprite; a cube in front keeps all of it.
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";
import * as mm from "../src/core/art/mesh-measure.ts";

export function runMeshOcclusionTests(test: TestFn, assert: AssertFn, eq: EqFn, fixture?: (name: string) => string | null): void {
  console.log("\n# mesh occlusion (3D phase M2): sprite/mesh painter order from shots + the framework log");
  const LOG = [
    "mesh: probe cube on tile (2,6) (MEWFW_MESH_PROBE)",
    "mesh order: world camera filter before ours = 0000000000000000 (units layer sorted=1 mode=0: interleaving)",
    "mesh occ f=1 tile=(2,6) key=9.000 hull=(-0.5000 -0.2500 0.1250 0.5000) area=0.031250",
    "mesh order f=1 items=5 meshes=1 groups=1 unsorted=0 | d0 key=9.000 before item 2 key=8.000",
    "mesh order keys f=1 11.000 10.000 8.000 7.000 6.000",
    "mesh order item f=1 i=2 key=8.000 at=(2.50 5.50)",
    "mesh occ f=61 tile=(2,6) key=9.000 hull=(-0.5000 -0.2000 0.1250 0.5500) area=0.031250",
    "mesh order f=61 items=5 meshes=2 groups=2 unsorted=0 | d0 key=9.000 before item 2 key=8.000 | d1 key=1.000 after the layer",
  ].join("\n");
  test("parseMeshOrderLog: occ lines (tile, key, hull, area), order lines (placements before an item / after the layer), item positions and the filter line", () => {
    const p = mm.parseMeshOrderLog(LOG);
    eq(p.occ.length, 2);
    eq(p.occ[0]!.tile.join(","), "2,6"); eq(p.occ[0]!.key, 9); eq(p.occ[0]!.hull.join(","), "-0.5,-0.25,0.125,0.5"); eq(p.occ[0]!.area, 0.03125);
    eq(p.orders.length, 2);
    eq(p.orders[0]!.items, 5); eq(p.orders[0]!.groups, 1); eq(p.orders[0]!.unsorted, 0);
    eq(JSON.stringify(p.orders[1]!.placements), JSON.stringify([{ draw: 0, key: 9, item: 2, itemKey: 8 }, { draw: 1, key: 1, item: null, itemKey: null }]));
    eq(p.items.length, 1); eq(p.items[0]!.at.join(","), "2.5,5.5"); eq(p.items[0]!.key, 8);
    eq(p.filterPrev, "0000000000000000");
    eq(p.interleaving, true);
  });

  // a 640x360 shot (16:9, no letterbox): background, a magenta box where the hull says, optionally a grey "sprite" over part
  const W = 640, H = 360;
  const occ: mm.MeshOccLine = { frame: 61, tile: [2, 6], key: 9, hull: [-0.25, -0.25, 0.25, 0.25], area: 0.25 };   // a 160x90 px box = 14400 px
  const shot = (cover: number, seed = 1) => {
    const img = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) img.set([40 + ((i * seed) % 7), 44, 40, 255], i * 4);
    for (let y = 135; y < 225; y++) for (let x = 240; x < 400; x++) {
      const grey = x < 240 + cover * 160;   // the sprite covers the left `cover` share of the cube
      img.set(grey ? [200, 200, 200, 255] : [230, 20, 230, 255], (y * W + x) * 4);
    }
    return { width: W, height: H, rgba: img };
  };
  test("measureOcclusion: expected px from the hull area (letterbox-aware), magenta px inside the hull's box, their ratio", () => {
    const m = mm.measureOcclusion(shot(0), occ);
    eq(Math.round(m.expectedPx), 14400);
    eq(m.magentaPx, 14400);
    eq(m.coverage, 1);
    const h = mm.measureOcclusion(shot(0.5), occ);
    eq(h.magentaPx, 7200);
    eq(h.coverage, 0.5);
    // the same NDC hull on an ultrawide 3440x1440 shot: the 16:9 area is 2560x1440 -> 0.25 * 1280 * 720 px
    const wide = { width: 3440, height: 1440, rgba: new Uint8Array(3440 * 1440 * 4) };
    eq(Math.round(mm.measureOcclusion(wide, occ).expectedPx), 230400);
  });
  test("judgeOcclusion: behind passes only when the unit hides part of the cube; front passes only when nothing hides it", () => {
    const behind = mm.judgeOcclusion([shot(0.4, 1), shot(0.4, 3)], [occ], "behind");
    eq(behind.verdict, "behind-occluded"); eq(behind.pass, true);
    assert(behind.coverage! > 0.55 && behind.coverage! < 0.65, `coverage ${behind.coverage}`);
    const notHidden = mm.judgeOcclusion([shot(0, 1), shot(0, 3)], [occ], "behind");
    eq(notHidden.verdict, "not-occluded"); eq(notHidden.pass, false);
    const front = mm.judgeOcclusion([shot(0, 1), shot(0, 3)], [occ], "front");
    eq(front.verdict, "front-unoccluded"); eq(front.pass, true);
    const hiddenFront = mm.judgeOcclusion([shot(0.4, 1), shot(0.4, 3)], [occ], "front");
    eq(hiddenFront.verdict, "occluded-in-front"); eq(hiddenFront.pass, false);
    eq(mm.judgeOcclusion([shot(1, 1), shot(1, 3)], [occ], "behind").verdict, "no-cube");
    eq(mm.judgeOcclusion([shot(0.4), shot(0.4)], [occ], "behind").verdict, "stale-shots");
    eq(mm.judgeOcclusion([shot(0.4, 1)], [], "behind").verdict, "no-occ-lines");
    eq(mm.judgeOcclusion([], [occ], "behind").verdict, "no-shots");
  });
  test("judgeOcclusion uses the LAST shot with the latest occ line (the camera eases in during the first seconds)", () => {
    const early: mm.MeshOccLine = { ...occ, frame: 1, hull: [-0.9, -0.9, -0.8, -0.8] };
    const j = mm.judgeOcclusion([shot(0, 1), shot(0.4, 3)], [early, occ], "behind");
    eq(j.shot, 1); eq(j.verdict, "behind-occluded");
  });
  void fixture;
}
