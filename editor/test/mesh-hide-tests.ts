// 3D phase M3 — hide_sprite: a unit whose GON model block says `hide_sprite true` has its 2D sprite left out of the
// units layer while its model draws (native/framework/src/fw_mesh_hide.c, host-pinned by test/test_mesh_hide.c). The
// in-game proof (mods/_unithide/tests/unit-hide.mewtest + unit-hide-control.mewtest) is read here: the framework's
// "unit model: <Entry>: hide_sprite: ..." and "mesh hide f=.. units=.. items=.. skipped=.." lines, and the Rat's dark
// outline pixels around its magenta box — none with hide_sprite true, thousands in the control (hide_sprite false).
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";
import * as mm from "../src/core/art/mesh-measure.ts";

/** a w x h mid-grey image, magenta boxes, black (outline) boxes */
function img(w: number, h: number, magenta: Array<[number, number, number, number]>, black: Array<[number, number, number, number]> = []): { width: number; height: number; rgba: Uint8Array } {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = 90; rgba[i * 4 + 1] = 90; rgba[i * 4 + 2] = 90; rgba[i * 4 + 3] = 255; }
  const fill = (bs: Array<[number, number, number, number]>, c: [number, number, number]) => {
    for (const [x0, y0, x1, y1] of bs) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const k = (y * w + x) * 4; rgba[k] = c[0]; rgba[k + 1] = c[1]; rgba[k + 2] = c[2]; }
  };
  fill(black, [10, 10, 10]);
  fill(magenta, [230, 10, 220]);
  return { width: w, height: h, rgba };
}

export function runMeshHideTests(test: TestFn, assert: AssertFn, eq: EqFn, fixture?: (name: string) => string | null): void {
  console.log("\n# hide_sprite (3D phase M3): the log lines, the dark-pixel measure around the model, hide vs control");
  test("measureHideRegion: the box is the magenta patch widened by its width each side, 2x its height above, 1x below; dark = r+g+b < 90 inside it", () => {
    // patch x 90..109 (w 19), y 100..119 (h 19) -> box x 71..128, y 62..138
    const m = mm.measureHideRegion(img(200, 200, [[90, 100, 109, 119]], [[70, 60, 89, 99], [0, 0, 5, 5]]));
    assert(!!m.patch && m.patch.x0 === 90 && m.patch.y1 === 119, JSON.stringify(m.patch));
    eq(JSON.stringify(m.box), JSON.stringify({ x0: 71, y0: 62, x1: 128, y1: 138 }));
    eq(m.dark, 19 * 38);                        // x 71..89, y 62..99 of the black box; the far corner box is outside
    eq(m.total, 58 * 77);
    const none = mm.measureHideRegion(img(50, 50, []));
    eq(none.patch, null); eq(none.box, null); eq(none.dark, 0);
  });
  test("judgeHide: hidden (control has the sprite, the hide shot keeps < 5% of its dark px), not-hidden, control-no-sprite, no-patch", () => {
    const p = { count: 100, x0: 0, y0: 0, x1: 9, y1: 9 }, b = { x0: 0, y0: 0, x1: 9, y1: 9 };
    const m = (dark: number, patch: typeof p | null = p) => ({ patch, box: patch ? b : null, dark, total: 1000 });
    const h = mm.judgeHide(m(0), m(3178));
    eq(h.verdict, "hidden"); eq(h.share, 0);
    eq(mm.judgeHide(m(100), m(3178)).verdict, "hidden");          // 3.1 %
    eq(mm.judgeHide(m(400), m(3178)).verdict, "not-hidden");      // 12.6 %
    eq(mm.judgeHide(m(0), m(mm.HIDE_MIN_CONTROL_DARK - 1)).verdict, "control-no-sprite");
    eq(mm.judgeHide(m(0, null), m(3178)).verdict, "no-patch");    // the model did not draw: nothing proves a replacement
    eq(mm.judgeHide(m(0), m(3178, null)).verdict, "no-patch");
  });
  test("parseMeshHideLog: the hide lines, the units that asked for it, a bad flag", () => {
    const p = mm.parseMeshHideLog([
      "unit model: Rat 000002ef75db7708 -> models/unit-box.gltf (block scale=0.4 yaw=0 offset=(0 0 0))",
      "unit model: Rat: hide_sprite: the 2D sprite is not drawn while the model draws",
      "unit model: Tire: model-flag hide_sprite is not true/false; the sprite is drawn",
      "mesh hide f=1 units=1 items=11 skipped=1",
      "mesh hide f=61 units=2 items=10 skipped=2",
    ].join("\r\n"));
    eq(JSON.stringify(p.hides), JSON.stringify([{ frame: 1, units: 1, items: 11, skipped: 1 }, { frame: 61, units: 2, items: 10, skipped: 2 }]));
    eq(p.hideUnits.join(","), "Rat");
    eq(p.badFlag.join(","), "Tire");
  });
  const fx = fixture?.("hide-sprite-log.txt");
  if (fx) {
    test("hide-sprite-log.txt (T2, 2026-10-22): the Rat asked for hide_sprite, every plan window skipped exactly its one units-layer item, the mesh drew with no GL error", () => {
      const p = mm.parseMeshHideLog(fx);
      eq(p.hideUnits.join(","), "Rat");
      assert(p.hides.length >= 4, `${p.hides.length} mesh hide lines`);
      assert(p.hides.every((h) => h.units === 1 && h.skipped === 1 && h.items >= 10), JSON.stringify(p.hides));
      const probe = mm.parseMeshProbeLog(fx);
      assert(probe.draws.length >= 1 && probe.draws.every((d) => d.errors === 0 && d.fbo === 1), JSON.stringify(probe.draws));
      assert(/before item 5 key=8\.000/.test(fx), "the box still takes the Rat's place in the painter order");
    });
  } else console.log("  (skipped: fixtures/ingame/hide-sprite-log.txt not pinned yet)");
  const cx = fixture?.("hide-sprite-control-log.txt");
  if (cx) {
    test("hide-sprite-control-log.txt (T2): hide_sprite false asks for nothing and skips nothing; same painter place", () => {
      const p = mm.parseMeshHideLog(cx);
      eq(p.hideUnits.length, 0); eq(p.hides.length, 0);
      assert(/before item 5 key=8\.000/.test(cx), "same place as the hide run");
    });
  } else console.log("  (skipped: fixtures/ingame/hide-sprite-control-log.txt not pinned yet)");
  const sm = fixture?.("hide-sprite-summary.json");
  if (sm) {
    test("hide-sprite-summary.json (T2, 2026-10-22): both runs pass with the real save unchanged; the Rat's outline is gone around the box (0 dark px) and present in the control (3178): hidden", () => {
      type Run = { verdict: string; save: string; shot: mm.HideMeasure };
      const s = JSON.parse(sm) as { hide: Run; control: Run };
      for (const r of [s.hide, s.control]) { eq(r.verdict, "pass"); assert(/1 real save file\(s\) unchanged/.test(r.save), r.save); }
      const j = mm.judgeHide(s.hide.shot, s.control.shot);
      eq(j.verdict, "hidden");
      eq(s.hide.shot.dark, 0);
      assert(s.control.shot.dark > 3000, `control dark ${s.control.shot.dark}`);
      assert(s.hide.shot.patch!.count > 2500 && s.control.shot.patch!.count > 2500, "the box drew in both runs");
    });
  } else console.log("  (skipped: fixtures/ingame/hide-sprite-summary.json not pinned yet)");
}
