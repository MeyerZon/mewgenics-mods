// The M1 mesh probe's in-game proof read from shots + the framework log (editor/src/core/art/mesh-measure.ts): the
// "mesh probe ..." lines mewframework writes (native/framework/src/fw_mesh_draw.c fw_mesh_fmt_probe, host-pinned in
// test_mesh_draw.c), the projected tile centre -> shot pixel, the magenta patch near it, and the stale-shot refusal
// (identical shots prove nothing: a frozen capture would pass any colour test).
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";
import * as mm from "../src/core/art/mesh-measure.ts";

export function runMeshProbeTests(test: TestFn, assert: AssertFn, eq: EqFn, fixture?: (name: string) => string | null): void {
  console.log("\n# mesh probe (3D phase M1): reading the probe cube from shots + the framework log");
  const LOG = [
    "hook installed: Camera::RenderOneLayer (observe3d) rva 0x979210 (observe3d: 0 window(s) of 60 world frames; meshes: on)",
    "mesh: probe cube on tile (3,3) (MEWFW_MESH_PROBE)",
    "mesh probe f=1 tile=(3,3) ndc=(-0.0012 -0.234 0.0565) canvas=(639.20 444.24)",
    "mesh probe f=1 top=[0.0015625 0 0 0 0 -0.00277778 0 0 0 0 0.0001 0 -1 1 -0 1] det(top x vp)=-1e-08",
    "mesh: GL objects ready: program 77 (fw_mvp 0, fw_base_color 1), vao 12, cube 24 verts / 36 indices",
    "mesh draw f=1 n=1 fbo=3 viewport=(0 0 1920 1080) depthTest=0 depthFunc=0x201 blend=1 prog=5 vao=9 errors=0",
    "mesh probe f=61 tile=(3,3) ndc=(-0.0012 -0.25 0.0565) canvas=(639.20 450.00)",
  ].join("\n");
  test("parseMeshProbeLog: probe positions (frame, tile, ndc, canvas), draw lines (fbo, errors), GL errors and the ready line", () => {
    const p = mm.parseMeshProbeLog(LOG);
    eq(p.probes.length, 2);
    eq(p.probes[0]!.frame, 1); eq(p.probes[0]!.tile.join(","), "3,3");
    eq(p.probes[0]!.ndc[1], -0.234); eq(p.probes[1]!.canvas[1], 450);
    eq(p.draws.length, 1); eq(p.draws[0]!.fbo, 3); eq(p.draws[0]!.errors, 0);
    eq(p.glReady, true); eq(p.glErrors.length, 0);
    const bad = mm.parseMeshProbeLog("mesh: 1 GL error(s) after the draw, first 0x502 (frame 3)\nmesh: vertex shader compile failed: 0:1 oops");
    eq(bad.glErrors.length, 2); eq(bad.glReady, false);
  });
  test("ndcToShotPixel: NDC (-1,+1) is the top-left pixel, (0,0) the centre; scales with the shot", () => {
    eq(mm.ndcToShotPixel([-1, 1], 1280, 720).join(","), "0,0");
    eq(mm.ndcToShotPixel([0, 0], 1920, 1080).join(","), "960,540");
    // an ultrawide window (OBSERVED 3440x1440, main RT viewport 2560x1440): the game letterboxes 16:9 in the middle
    eq(mm.ndcToShotPixel([-1, 1], 3440, 1440).join(","), "440,0");
    eq(mm.ndcToShotPixel([1, -1], 3440, 1440).join(","), "3000,1440");
    eq(mm.ndcToShotPixel([-1, 1], 1440, 1440).join(","), "0,315", "a tall window: bars top and bottom");
  });
  type Px = [number, number, number];
  const shot = (o: { cube?: { x: number; y: number; r: number; c?: Px }; seed?: number }) => {
    const W = 640, H = 360, img = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) img.set([40 + ((i * (o.seed ?? 1)) % 7), 44, 40, 255], i * 4);
    if (o.cube) for (let y = -o.cube.r; y <= o.cube.r; y++) for (let x = -o.cube.r; x <= o.cube.r; x++) {
      const px = o.cube.x + x, py = o.cube.y + y;
      const c = o.cube.c ?? (y < 0 ? [255, 0, 255] : [158, 0, 158]);   /* lit top, darker side: the probe shader's face shades */
      if (px >= 0 && py >= 0 && px < W && py < H) img.set([c[0], c[1], c[2], 255], (py * W + px) * 4);
    }
    return { width: W, height: H, rgba: img };
  };
  const probes = mm.parseMeshProbeLog(LOG).probes;
  // ndc (-0.0012, -0.234) on a 640x360 shot = (319.6, 222.1)
  test("judgeMeshShots: a magenta patch at the projected tile centre = cube; elsewhere = misplaced; none = no-cube", () => {
    const at = mm.judgeMeshShots([shot({ cube: { x: 320, y: 220, r: 15 } }), shot({ cube: { x: 321, y: 224, r: 15 }, seed: 3 })], probes);
    eq(at.verdict, "cube", JSON.stringify(at));
    assert(at.patch!.count >= 900, `patch ${at.patch!.count}`);
    assert(at.distancePx! < 10, `distance ${at.distancePx}`);
    eq(mm.judgeMeshShots([shot({ cube: { x: 100, y: 60, r: 15 } }), shot({ seed: 3, cube: { x: 100, y: 60, r: 15 } })], probes).verdict, "misplaced");
    eq(mm.judgeMeshShots([shot({}), shot({ seed: 3 })], probes).verdict, "no-cube");
  });
  test("judgeMeshShots refuses a verdict when every shot is byte-identical (stale capture) or there are no probe lines / no shots", () => {
    const s = shot({ cube: { x: 320, y: 220, r: 15 } });
    eq(mm.judgeMeshShots([s, shot({ cube: { x: 320, y: 220, r: 15 } })], probes).verdict, "stale-shots");
    eq(mm.judgeMeshShots([s], probes).verdict, "cube", "one shot cannot be stale-checked: judged, with staleChecked false");
    eq(mm.judgeMeshShots([s], probes).staleChecked, false);
    eq(mm.judgeMeshShots([s, shot({ seed: 5, cube: { x: 320, y: 220, r: 15 } })], []).verdict, "no-probe-lines");
    eq(mm.judgeMeshShots([], probes).verdict, "no-shots");
  });
  test("judgeMeshShots: a few stray magenta pixels (UI) are not a cube", () => {
    eq(mm.judgeMeshShots([shot({ cube: { x: 320, y: 220, r: 2 } }), shot({ seed: 2, cube: { x: 320, y: 220, r: 2 } })], probes).verdict, "no-cube");
  });
  test("OBSERVED (T2 2026-10-22, mesh-probe-log.txt + mesh-probe-summary.json): the probe cube drew on tile (3,3) in a real fight — GL ready, no GL errors, every draw into FBO 1 (the main RT) with the replay's depth test off / GL_LESS / blend on, a 31 097 px magenta patch at the projected centre, two distinct shots", () => {
    const log = fixture ? fixture("mesh-probe-log.txt") : null;
    const sum = fixture ? fixture("mesh-probe-summary.json") : null;
    assert(!!log && !!sum, "fixtures present");
    const p = mm.parseMeshProbeLog(log!);
    eq(p.glReady, true); eq(p.glErrors.length, 0);
    assert(p.probes.length >= 5 && p.probes.every((x) => x.tile.join(",") === "3,3"), "probe lines on tile 3,3");
    assert(p.draws.length >= 1 && p.draws.every((d) => d.fbo === 1 && d.errors === 0 && /depthTest=0 depthFunc=0x201 blend=1/.test(d.line)), "the state the functor found");
    const j = JSON.parse(sum!);
    eq(j.judgement.verdict, "cube"); eq(j.judgement.staleChecked, true);
    assert(j.judgement.patch.count > 20000, "a sizeable patch");
    eq(j.run.verdict, "pass");
    assert(/1 real save file\(s\) unchanged/.test(j.run.save), "save guard");
  });
  test("OBSERVED (T2 2026-10-22, mesh-model-log.txt): MEWFW_MESH_PROBE_MODEL=models/crate.obj with mods/fw-3d on the mod path — the API v6 registry placed the crate on tile (4,3), ResourceManager_GetBinaryResource served mods/fw-3d/models/crate.obj (24 verts / 36 indices, feet on the floor), fw_mesh.shader compiled through the game's dialect, both meshes drew every frame with no GL error", () => {
    const log = fixture ? fixture("mesh-model-log.txt") : null;
    assert(!!log, "fixture present");
    if (!log) return;
    assert(/Place3DObjectOnTile\(4, 3, models\/crate\.obj\): ok handle 1/.test(log), "the API v6 placement");
    assert(/mesh: model models\/crate\.obj loaded: 24 verts, 36 indices, bounds \(-0\.40 0\.00 -0\.40\)-\(0\.40 0\.80 0\.40\)/.test(log), "the model bytes from the mod path, parsed into the game's axes");
    assert(/mesh: program \d+ ready \(mods\/fw-3d\/shaders\/fw_mesh\.shader;/.test(log), "the mod-shipped shader compiled (fw_shader_stage)");
    const p = mm.parseMeshProbeLog(log);
    eq(p.glErrors.length, 0);
    assert(p.draws.length >= 1 && p.draws.every((d) => d.errors === 0 && /meshes=2\/2/.test(d.line)), "both meshes drew");
    assert(/mesh object f=\d+ handle=1 model=models\/crate\.obj tile world=\(4\.50 0\.00 3\.50\)/.test(log), "the tile anchor");
  });
}
