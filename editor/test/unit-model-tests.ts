// 3D phase M2 item 4 — per-unit models: a unit's GON graphics.model drawn on the unit and following it. The in-game
// proof is read from the framework log and two shots (editor/src/core/art/mesh-measure.ts): the "unit model: ..."
// discovery line and the "unit model at: ..." position lines (native/framework/src/fw_unit_model.c fw_unit_fmt_model /
// fw_unit_fmt_at, host-pinned in native/framework/test/test_unit_model.c), the position each shot was taken at (by the
// shot file's time against the lines' wall clock), and the model's patch moving the way the iso projection of the
// unit's world move says.
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";
import * as mm from "../src/core/art/mesh-measure.ts";

/** a w x h grey image with magenta boxes */
function img(w: number, h: number, boxes: Array<[number, number, number, number]>): { width: number; height: number; rgba: Uint8Array } {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = 90; rgba[i * 4 + 1] = 90; rgba[i * 4 + 2] = 90; rgba[i * 4 + 3] = 255; }
  for (const [x0, y0, x1, y1] of boxes)
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const k = (y * w + x) * 4; rgba[k] = 230; rgba[k + 1] = 10; rgba[k + 2] = 220; }
  return { width: w, height: h, rgba };
}

export function runUnitModelTests(test: TestFn, assert: AssertFn, eq: EqFn, fixture?: (name: string) => string | null): void {
  console.log("\n# per-unit models (3D phase M2 item 4): discovery lines, positions, the patch following the unit");
  const LOG = [
    "unit model: Crate 000001A2B3C4D5E0 -> models/crate.obj",
    "Register3DObject(000001A2B3C4D5E0, models/crate.obj): ok handle 2 (2 object(s))",
    "unit model: Rat 000001A2B3C4F000 -> models/unit-box.gltf (block scale=0.6 yaw=45 offset=(0 0 0))",
    "unit model at: Rat handle=3 world=(7.500 2.500) screen=(812.000 -401.500) facing=-1 m0=-1 ms=1000",
    "mesh object f=61 handle=3 model=models/unit-box.gltf unit world=(7.50 0.00 2.50)",
    "unit model at: Rat handle=3 world=(6.500 2.500) screen=(780.000 -417.500) facing=-1 m0=-1 ms=5000",
    "mesh object f=601 handle=3 model=models/unit-box.gltf unit world=(6.50 0.00 2.50)",
  ].join("\n");
  test("parseUnitModelLog: discovery lines (entry, character, file, block text), positions (world, screen, facing, ms) and mesh object lines", () => {
    const p = mm.parseUnitModelLog(LOG);
    eq(p.units.length, 2);
    eq(p.units[0]!.entry, "Crate"); eq(p.units[0]!.file, "models/crate.obj"); eq(p.units[0]!.block, null);
    eq(p.units[1]!.entry, "Rat"); eq(p.units[1]!.block, "scale=0.6 yaw=45 offset=(0 0 0)");
    eq(p.positions.length, 2);
    eq(p.positions[0]!.handle, 3); eq(p.positions[0]!.world.join(","), "7.5,2.5"); eq(p.positions[0]!.facing, -1);
    eq(p.positions[1]!.ms, 5000); eq(p.positions[1]!.screen!.join(","), "780,-417.5");
    eq(p.objects.length, 2); eq(p.objects[1]!.kind, "unit"); eq(p.objects[1]!.world.join(","), "6.5,0,2.5");
    eq(mm.parseUnitModelLog("unit model at: Rat handle=3 world=(1.000 2.000) screen=(none) facing=+1 m0=0 ms=5").positions[0]!.screen, null);
  });
  test("positionAt: the last logged position at or before a time; null before the first", () => {
    const p = mm.parseUnitModelLog(LOG).positions;
    eq(mm.positionAt(p, "Rat", 999), null);
    eq(mm.positionAt(p, "Rat", 1000)!.world.join(","), "7.5,2.5");
    eq(mm.positionAt(p, "Rat", 4999)!.world.join(","), "7.5,2.5");
    eq(mm.positionAt(p, "Rat", 9000)!.world.join(","), "6.5,2.5");
    eq(mm.positionAt(p, "Crate", 9000), null);
  });
  test("isoScreenDelta: the observer's ISO columns, screen y up (x -> right/up, z -> left/up)", () => {
    const [ax, ay] = mm.isoScreenDelta(1, 0);
    assert(Math.abs(ax - 0.894) < 1e-3 && Math.abs(ay - 0.447) < 1e-3, `${ax},${ay}`);
    const [bx, by] = mm.isoScreenDelta(0, 1);
    assert(Math.abs(bx + 0.894) < 1e-3 && Math.abs(by - 0.447) < 1e-3, `${bx},${by}`);
  });
  // world x -1 -> screen (-0.894, -0.447) y-up = left and DOWN in image rows: the patch moves left 89 px, down 45 px
  const A = img(400, 300, [[200, 100, 239, 139]]);
  const B = img(400, 300, [[111, 145, 150, 184]]);
  const at0 = { world: [7.5, 2.5] as [number, number] }, at1 = { world: [6.5, 2.5] as [number, number] };
  test("judgeUnitModelFollows: the patch moves the way the iso projection of the unit's world move says -> follows", () => {
    const j = mm.judgeUnitModelFollows(A, B, at0.world, at1.world);
    eq(j.verdict, "follows", JSON.stringify(j));
    assert(j.angleDeg !== null && j.angleDeg < 5, `angle ${j.angleDeg}`);
    eq(j.deltaPx!.join(","), "-89,45");
  });
  test("judgeUnitModelFollows: a patch moving the other way is wrong-direction; a still patch with a moved unit is not-following", () => {
    eq(mm.judgeUnitModelFollows(B, A, at0.world, at1.world).verdict, "wrong-direction");
    const A2 = img(400, 300, [[200, 100, 239, 139]]);
    A2.rgba[0] = 91;                                                       // one pixel off: not a stale capture
    eq(mm.judgeUnitModelFollows(A, A2, at0.world, at1.world).verdict, "not-following");
  });
  test("judgeUnitModelFollows: refusals — identical shots (stale), the unit did not move, no patch", () => {
    eq(mm.judgeUnitModelFollows(A, A, at0.world, at1.world).verdict, "stale-shots");
    eq(mm.judgeUnitModelFollows(A, B, at0.world, at0.world).verdict, "unit-not-moved");
    eq(mm.judgeUnitModelFollows(img(400, 300, []), B, at0.world, at1.world).verdict, "no-patch");
  });
  const fx = fixture?.("unit-model-log.txt");
  if (fx) {
    test("unit-model-log.txt (T2, 2026-10-22): the Rat's and the Crate's discovery lines and the Rat at two different positions", () => {
      const p = mm.parseUnitModelLog(fx);
      const rat = p.units.find((u) => u.entry === "Rat");
      assert(!!rat && rat.file === "models/unit-box.gltf" && rat.block !== null, JSON.stringify(p.units));
      assert(p.units.some((u) => u.entry === "Crate" && u.file === "models/crate.obj"), "the vanilla Crate's crate.obj");
      const ratAt = p.positions.filter((q) => q.entry === "Rat");
      const distinct = new Set(ratAt.map((q) => q.world.join(",")));
      assert(distinct.size >= 2, `the Rat at ${[...distinct].join(" | ")}`);
      assert(p.objects.some((o) => o.kind === "unit"), "a mesh object line for a unit object");
    });
  } else console.log("  (skipped: fixtures/ingame/unit-model-log.txt not pinned yet)");
}
