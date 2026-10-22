// 3D phase M3 `face` — a unit model turns with Character::Face. The in-game proof is read from the framework log
// ("unit model face: <entry> handle=<h> dir=(dx dy) yaw=<deg> src=dir|flip ms=<t>", native/framework/src/fw_unit_face.c
// fw_face_fmt, host-pinned in native/framework/test/test_unit_face.c) and the shots of mods/_unitface's probe box (cyan
// FRONT face, yellow BACK face, magenta sides; editor/src/core/art/face-measure.ts): at each facing the predicted face
// shows, on the predicted side of the box.
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";
import * as fm from "../src/core/art/face-measure.ts";

type Box = [number, number, number, number, [number, number, number]];
/** a w x h grey image with coloured boxes */
function img(w: number, h: number, boxes: Box[]): { width: number; height: number; rgba: Uint8Array } {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = 90; rgba[i * 4 + 1] = 90; rgba[i * 4 + 2] = 90; rgba[i * 4 + 3] = 255; }
  for (const [x0, y0, x1, y1, c] of boxes)
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const k = (y * w + x) * 4; rgba[k] = c[0]; rgba[k + 1] = c[1]; rgba[k + 2] = c[2]; }
  return { width: w, height: h, rgba };
}
const MAG: [number, number, number] = [200, 20, 190], CYAN: [number, number, number] = [10, 170, 180], YEL: [number, number, number] = [190, 180, 15];

export function runUnitFaceTests(test: TestFn, assert: AssertFn, eq: EqFn, fixture?: (name: string) => string | null): void {
  console.log("\n# unit model facing (3D phase M3 face): face lines, the predicted face per yaw, the probe box's colours");
  test("parseUnitFaceLog: entry, handle, dir, yaw, src, ms (log prefixes ignored)", () => {
    const p = fm.parseUnitFaceLog([
      "[12:00:01.000] unit model face: Rat handle=3 dir=(0 -1) yaw=0 src=dir ms=1000",
      "unit model at: Rat handle=3 world=(1.000 2.000) screen=(none) facing=+1 m0=0 ms=5",
      "unit model face: Rat handle=3 dir=(1 0) yaw=270 src=dir ms=2000",
      "unit model face: Pooter handle=4 dir=(0 0) yaw=90 src=flip ms=2500",
    ].join("\n"));
    eq(p.length, 3);
    eq(p[0]!.dir.join(","), "0,-1"); eq(p[0]!.yaw, 0); eq(p[0]!.src, "dir"); eq(p[0]!.ms, 1000);
    eq(p[1]!.yaw, 270); eq(p[2]!.entry, "Pooter"); eq(p[2]!.src, "flip");
    eq(fm.faceAt(p, "Rat", 1500)!.yaw, 0); eq(fm.faceAt(p, "Rat", 2000)!.yaw, 270); eq(fm.faceAt(p, "Rat", 999), null);
  });
  test("faceYawOf = fw_face_yaw_deg: (0,-1) 0, (-1,0) 90, (0,1) 180, (1,0) 270, diagonals 45 apart, (0,0) null", () => {
    eq(fm.faceYawOf(0, -1), 0); eq(fm.faceYawOf(-1, 0), 90); eq(fm.faceYawOf(0, 1), 180); eq(fm.faceYawOf(1, 0), 270);
    eq(fm.faceYawOf(-1, -1), 45); eq(fm.faceYawOf(1, -1), 315); eq(fm.faceYawOf(0, 0), null);
  });
  test("predictFace: the two front directions show the cyan front (right for (0,-1), left for (-1,0)); the two back directions the yellow back (left for (1,0), right for (0,1))", () => {
    eq(JSON.stringify(fm.predictFace(0)), JSON.stringify({ visible: "front", side: "right" }));
    eq(JSON.stringify(fm.predictFace(90)), JSON.stringify({ visible: "front", side: "left" }));
    eq(JSON.stringify(fm.predictFace(270)), JSON.stringify({ visible: "back", side: "left" }));
    eq(JSON.stringify(fm.predictFace(180)), JSON.stringify({ visible: "back", side: "right" }));
    eq(JSON.stringify(fm.predictFace(45)), JSON.stringify({ visible: "front", side: "centre" }));   // straight at the camera
    eq(fm.predictFace(135).visible, null);                                                            // edge-on: neither
  });
  test("faceColourClass: magenta / cyan / yellow under shading, grey and the rat's browns are none", () => {
    eq(fm.faceColourClass(200, 20, 190), "side"); eq(fm.faceColourClass(110, 30, 100), "side");
    eq(fm.faceColourClass(10, 170, 180), "front"); eq(fm.faceColourClass(190, 180, 15), "back");
    eq(fm.faceColourClass(90, 90, 90), null); eq(fm.faceColourClass(140, 100, 70), null); eq(fm.faceColourClass(40, 10, 40), null);
  });
  test("judgeFace on synthetic shots: the cyan face right of the box at yaw 0 is turned; the same shot at yaw 270 is the wrong face; cyan on the left at yaw 0 is the wrong side; no magenta = no-box", () => {
    const front = img(200, 150, [[80, 60, 110, 100, MAG], [111, 60, 125, 100, CYAN]]);
    const j = fm.judgeFace(front, 0);
    eq(j.verdict, "turned"); assert(j.pass, "pass");
    assert(j.measured.frontPx > 500 && j.measured.backPx === 0, JSON.stringify(j.measured));
    eq(fm.judgeFace(front, 270).verdict, "wrong-face");
    const left = img(200, 150, [[80, 60, 110, 100, MAG], [65, 60, 79, 100, CYAN]]);
    eq(fm.judgeFace(left, 0).verdict, "wrong-side"); eq(fm.judgeFace(left, 90).verdict, "turned");
    const back = img(200, 150, [[80, 60, 110, 100, MAG], [65, 60, 79, 100, YEL]]);
    eq(fm.judgeFace(back, 270).verdict, "turned"); eq(fm.judgeFace(back, 0).verdict, "wrong-face");
    eq(fm.judgeFace(img(200, 150, []), 0).verdict, "no-box");
    eq(fm.judgeFace(img(200, 150, [[80, 60, 110, 100, MAG]]), 0).verdict, "no-face");
    // a cyan patch far from the box (outside the window) does not count
    eq(fm.judgeFace(img(400, 150, [[20, 60, 50, 100, MAG], [300, 60, 330, 100, CYAN]]), 0).verdict, "no-face");
  });
  // ---- the T2 run (2026-10-22, run 20261022-160300-_unitface-unit-face): mods/_unitface/tests/unit-face.mewtest ----
  const log = fixture ? fixture("unit-face-log.txt") : null;
  test("T2 fixture unit-face-log.txt: the Rat's model registers, its face yaw follows every `face` (90 at spawn, then 0, 90, 270, 180, 0), each yaw = atan2(-dx, -dy) of the logged dir, src=dir; the harness's face events and the end line (9 expectations, 0 failed)", () => {
    assert(log !== null, "fixture unit-face-log.txt");
    if (!log) return;
    assert(/^unit model: Rat \S+ -> models\/face-box\.obj \(block scale=1 yaw=0 offset=\(0 0 0\)\)$/m.test(log), "the discovery line");
    const lines = fm.parseUnitFaceLog(log);
    eq(lines.map((l) => l.yaw).join(","), "90,0,90,270,180,0");
    eq(lines.map((l) => l.dir.join(" ")).join(","), "-1 0,0 -1,-1 0,1 0,0 1,0 -1");
    for (const l of lines) { eq(l.src, "dir"); eq(l.yaw, fm.faceYawOf(l.dir[0], l.dir[1])); eq(l.handle, 1); }
    for (let i = 1; i < lines.length; i++) assert(lines[i]!.ms > lines[i - 1]!.ms, "face lines in time order");
    const events = log.split(/\r?\n/).filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as { ev: string; dir?: [number, number]; ok?: boolean; expect_fail?: number; expect_pass?: number; facing?: string });
    const faces = events.filter((e) => e.ev === "face");
    eq(faces.length, 5);
    for (const e of faces) eq(e.ok, true);
    eq(faces.map((e) => e.facing).join(""), "FFBBF");
    // every Character::Face the harness made shows up as the next face line, in order (the spawn line comes first)
    eq(faces.map((e) => e.dir!.join(" ")).join(","), lines.slice(1).map((l) => l.dir.join(" ")).join(","));
    const end = events.find((e) => e.ev === "end")!;
    eq(end.expect_fail, 0); eq(end.expect_pass, 9);
  });
  const sumText = fixture ? fixture("unit-face-summary.json") : null;
  test("T2 fixture unit-face-summary.json: every shot shows the predicted face on the predicted side (front: cyan right; front mirrored: cyan left; back: yellow left; back mirrored: yellow right; front again: cyan right), thousands of pixels each, the hidden face 0; the run passed and the real save is unchanged", () => {
    assert(sumText !== null, "fixture unit-face-summary.json");
    if (!sumText) return;
    const s = JSON.parse(sumText) as { run: { verdict: string; save: string }; shots: Array<{ label: string; dir: [number, number]; yaw: number; measure: fm.FaceColourMeasure; verdict: string }> };
    eq(s.run.verdict, "pass");
    assert(/^1 real save file\(s\) unchanged/.test(s.run.save), s.run.save);
    eq(s.shots.map((x) => x.label).join(","), "front,front mirrored,back,back mirrored,front again");
    const want = [["front", "right"], ["front", "left"], ["back", "left"], ["back", "right"], ["front", "right"]];
    s.shots.forEach((x, i) => {
      eq(x.yaw, fm.faceYawOf(x.dir[0], x.dir[1]), x.label);
      const j = fm.judgeFaceMeasure(x.measure, x.yaw);
      eq(j.verdict, "turned", `${x.label}: ${JSON.stringify(j.measured)}`);
      eq(x.verdict, "turned", x.label);
      eq(`${j.measured.visible} ${j.measured.side}`, want[i]!.join(" "), x.label);
      const shown = x.measure[j.measured.visible!], hidden = x.measure[j.measured.visible === "front" ? "back" : "front"];
      assert(shown.count > 3000 && hidden.count === 0, `${x.label}: shown ${shown.count}, hidden ${hidden.count}`);
      assert(Math.abs(j.measured.offsetPx!) > 40, `${x.label}: the face sits well off the box centre (${j.measured.offsetPx})`);
    });
    // M2 mirrored the model with the sprite (x <-> z when m0 < 0): facing (1,0) draws the sprite unmirrored, so M2 would
    // have shown the cyan FRONT to the lower right there; the yellow back on the left is the turn, not a mirror
    eq(JSON.stringify(fm.predictFace(0)), JSON.stringify({ visible: "front", side: "right" }));
    eq(fm.judgeFaceMeasure(s.shots[2]!.measure, 0).verdict, "wrong-face");
  });
}
