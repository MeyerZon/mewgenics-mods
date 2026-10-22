// The phase-0 3D observer's log (native/framework/src/obs3d_engine.c over fw_obs3d_rules.c, MEWFW_OBSERVE3D=N): the
// parser in editor/src/core/ingame/obs3d.ts on synthetic lines in the exact formats the host tests pin
// (native/framework/test/test_obs3d_rules.c), and — when present — the OBSERVED lines of the T2 run
// (editor/test/fixtures/ingame/observe3d-log.txt, mods/dev-sandbox/tests/observe3d.mewtest) with the facts the 3D plan
// relies on (docs/possible_3d_work.md K3/K4/K8/K12/G5).
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";
import * as o3 from "../src/core/ingame/obs3d.ts";

const VP = "[60 0 0 0 0 -60 0 0 0 0 1 0 640 360 0 1]";
const SYNTH = [
  "mewframework 1.0.0 starting; mewjector=yes",
  "obs3d fight tt=000001234",
  "obs3d globals iso=[0.894427 0.447214 0 0 0 1 0 0 -0.894427 0.447214 1 0 0 0 0 1] isoinv=[0.559017 -0.559017 0 0 1.11803 1.11803 0 0 0 0 1 0 0 0 0 1] flags=0x9 cull=0 depthbias=0 stacktop=0 f=1",
  "obs3d app clear=110 antialias=4 samples=4 f=1",
  `obs3d cam f=1 cam=0000AAAA world=0 rtt=1 hdr=0 zoom=60 flip=-1 layers=0x1000000 vp=${VP}`,
  `obs3d cam f=1 cam=0000BBBB world=1 rtt=0 hdr=0 zoom=60 flip=-1 layers=0x40001a1ff8f0 vp=${VP}`,
  "obs3d layers f=1 0x7:m0:n100 0x19:m0:n5",
  "obs3d item f=1 layer=0x19 rnd=0000CCCC pos=(3.5 7.5) screen=[1 0 0 0 0 1 0 0 0 0 1 0 -2.68328 4.91935 0 1]",
  "obs3d item f=1 layer=0x7 rnd=0000DDDD pos=(0 0) screen=[0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0] (not a MaskedRendererIso: no position, no screen matrix)",
  `obs3d cam f=61 cam=0000BBBB world=1 rtt=0 hdr=0 zoom=60 flip=-1 layers=0x40001a1ff8f0 vp=${VP}`,
].join("\n");

export function runObs3dTests(test: TestFn, assert: AssertFn, eq: EqFn, fixture: (name: string) => string | null): void {
  console.log("\n# 3D observer (phase 0): the obs3d log lines");
  test("parseObs3dLog reads fights, frames, cameras, layers, items, globals and the app line; ignores other lines", () => {
    const r = o3.parseObs3dLog(SYNTH);
    eq(r.fights.length, 1);
    eq(r.frames.map((f) => f.frame).join(","), "1,61");
    const f1 = r.frames[0]!;
    eq(f1.cameras.length, 2);
    const w = f1.cameras.find((c) => c.world)!;
    eq(w.cam, "0000BBBB"); eq(w.rtt, false); eq(w.zoom, 60); eq(w.flip, -1);
    eq(w.layers, 0x40001a1ff8f0n);
    eq(w.vp.length, 16); eq(w.vp[12], 640); eq(w.vp[5], -60);
    eq(f1.layers.map((l) => `${l.layer}:${l.mode}:${l.items}`).join(" "), "7:0:100 25:0:5");
    eq(f1.items.length, 2);
    eq(f1.items[0]!.layer, 0x19); eq(f1.items[0]!.x, 3.5); eq(f1.items[0]!.z, 7.5); eq(f1.items[0]!.screen![13], 4.91935);
    eq(f1.items[1]!.screen, null, "a non-MaskedRendererIso item has no screen matrix");
    eq(f1.globals!.iso[0], 0.894427); eq(f1.globals!.isoinv[4], 1.11803); eq(f1.globals!.flags, 9); eq(f1.globals!.cull, 0);
    eq(JSON.stringify(f1.app), JSON.stringify({ clearColor: true, clearDepth: true, clearStencil: false, antialias: 4, samples: 4 }));
  });
  test("layerList expands a camera bitset; det4 is the column-major determinant (the autoflip sign)", () => {
    eq(o3.layerList(0x2000020n).join(","), "5,25");
    eq(o3.det4([60, 0, 0, 0, 0, -60, 0, 0, 0, 0, 1, 0, 640, 360, 0, 1]), -3600);
    eq(o3.det4([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), 1);
  });
  test("summarizeObs3d: the world camera per frame, its VP determinant sign, the depth-clear bit, the unit item's m14", () => {
    const s = o3.summarizeObs3d(o3.parseObs3dLog(SYNTH));
    eq(s.worldFrames, 2);
    eq(s.worldCamera, "0000BBBB");
    eq(s.worldRtt, false);
    eq(s.vpDetNegative, true);
    eq(s.depthCleared, true);
    eq(s.unitM14, 0);
    eq(s.camerasPerFrame, 2);
  });
  const real = fixture("observe3d-log.txt");
  test("OBSERVED (T2 2026-10-22, observe3d.mewtest with MEWFW_OBSERVE3D=3): three world frames; the world camera (TacticsTest+0x68) is not RTT, flip -1, zoom 78.2624 (not the ctor's 60) with the camera Position's scale 1.15 in the VP (m0 = zoom/1.15 = 68.054), det(VP) < 0; the main RT is cleared COLOR|DEPTH|STENCIL every frame; units on layer 0x19 sit at tile centres with m14 = 0 and m12/m13 = the ISO projection; ISO is the vanilla (2,1)/sqrt5 basis", () => {
    assert(real !== null, "editor/test/fixtures/ingame/observe3d-log.txt exists (the T2 run's obs3d lines)");
    const r = o3.parseObs3dLog(real!);
    const s = o3.summarizeObs3d(r);
    eq(s.worldFrames, 3);
    eq(s.worldRtt, false);
    assert(Math.abs(s.worldZoom - 78.2624) < 1e-3, `world zoom ${s.worldZoom}`);
    const w = r.frames[0]!.cameras.find((c) => c.world)!;
    assert(Math.abs(w.vp[0]! - w.zoom / 1.15) < 1e-3 && w.vp[5] === -w.vp[0], `VP scale = zoom / 1.15: ${w.vp[0]} vs ${w.zoom}`);
    eq(s.depthCleared, true, "FrameBegin clears the main RT's depth every frame (App+0xd99 = 1)");
    const it = r.frames[0]!.items.find((x) => x.layer === 0x19)!;
    assert(it.x % 1 === 0.5 && it.z % 1 === 0.5, `a unit stands on a tile centre: ${it.x} ${it.z}`);
    assert(Math.abs(it.screen![12]! - (0.894427 * it.x - 0.894427 * it.z)) < 1e-4 && Math.abs(it.screen![13]! - 0.447214 * (it.x + it.z)) < 1e-4, `m12/m13 = ISO projection of (x, 0, z): ${it.screen![12]} ${it.screen![13]}`);
    eq(s.worldFlip, -1);
    eq(s.vpDetNegative, true);
    eq(s.unitM14, 0);
    assert(s.worldLayers.includes(0x19) && !s.worldLayers.includes(0x25), `world camera draws 0x19 and no UI layer: ${s.worldLayers.join(",")}`);
    const g = r.frames[0]!.globals!;
    assert(Math.abs(g.iso[0]! - 0.894427) < 1e-5 && Math.abs(g.iso[1]! - 0.447214) < 1e-5 && Math.abs(g.iso[8]! + 0.894427) < 1e-5 && g.iso[5] === 1, `ISO ${g.iso.join(" ")}`);
  });
}
