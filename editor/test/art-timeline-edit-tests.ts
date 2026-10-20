// Animation-clip authoring (art build-out G): the pure timeline edit operations behind the Timeline tab. Every op
// returns { sprite, findings } and never mutates its input; the result still validates.

import { exampleScene, validateScene } from "../src/core/art/scene.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

export async function runArtTimelineEditTests(test: TestFn, assert: AssertFn, eq: EqFn): Promise<void> {
  console.log("\n# Art: timeline edit operations (the Timeline tab's core)");
  let T: Record<string, any> = {};
  let err = "";
  try { T = await import("../src/core/art/timeline-edit.ts"); } catch (e) { err = e instanceof Error ? e.message : String(e); }
  const need = () => { if (err) throw new Error(`timeline-edit.ts: ${err}`); };
  const sprite = () => ({
    frames: 24,
    labels: { idle: 0, blink: 18 },
    layers: [
      { name: "body", depth: 1, keys: [{ frame: 0, ref: "body", x: 0, y: 0, tween: "linear" }, { frame: 12, ref: "body", x: 0, y: -10 }] },
      { name: "eye", depth: 2, keys: [{ frame: 0, ref: "eye", x: 5, y: 5 }, { frame: 18, ref: null }] },
    ],
  });
  const valid = (sp: any) => {
    const sc = exampleScene("t") as any;
    sc.sprites.Starter = sp;
    const v = validateScene(sc) as any;
    assert(v.ok, JSON.stringify(v.findings.filter((f: any) => f.severity === "error")));
  };

  test("keyAt / poseAt: the exact key, and the pose mid-tween (component lerp), held after the last key, the ref at a frame", () => {
    need();
    const sp = sprite();
    eq(T.keyAt(sp, 0, 12).y, -10);
    eq(T.keyAt(sp, 0, 6), null);
    const mid = T.poseAt(sp, 0, 6);
    eq(mid.ref, "body"); eq(mid.y, -5); eq(mid.x, 0);
    eq(T.poseAt(sp, 0, 20).y, -10, "held");
    eq(T.poseAt(sp, 1, 20).ref, null, "removed after its null key");
  });

  test("setKey: a new key starts from the pose at that frame and takes the given fields; an existing key merges; keys stay sorted; the input is not mutated", () => {
    need();
    const sp = sprite();
    const r = T.setKey(sp, 0, 6, { y: 20 });
    eq(sp.layers[0].keys.length, 2, "input untouched");
    const keys = r.sprite.layers[0].keys;
    eq(keys.map((k: any) => k.frame).join(","), "0,6,12");
    eq(keys[1].y, 20); eq(keys[1].x, 0); eq(keys[1].ref, "body");
    eq(keys[1].tween, "linear", "inside a tween span the new key keeps tweening toward the next");
    const m = T.setKey(r.sprite, 0, 6, { x: 3 });
    eq(m.sprite.layers[0].keys[1].x, 3); eq(m.sprite.layers[0].keys[1].y, 20);
    valid(m.sprite);
  });

  test("removeKey refuses the layer's last key; moveKey refuses a taken or out-of-range frame", () => {
    need();
    const sp = sprite();
    const r = T.removeKey(sp, 0, 12);
    eq(r.sprite.layers[0].keys.length, 1);
    const last = T.removeKey(r.sprite, 0, 0);
    eq(last.sprite.layers[0].keys.length, 1);
    assert(last.findings.some((f: any) => f.severity === "error"), "refused");
    const mv = T.moveKey(sp, 0, 12, 14);
    eq(mv.sprite.layers[0].keys[1].frame, 14);
    assert(T.moveKey(sp, 0, 12, 0).findings.length > 0, "taken");
    assert(T.moveKey(sp, 0, 12, 24).findings.length > 0, "out of range");
  });

  test("setLabel / removeLabel: valid names only, frame in range, renames by setting the same name elsewhere", () => {
    need();
    const r = T.setLabel(sprite(), "attack", 6);
    eq(r.sprite.labels.attack, 6);
    assert(T.setLabel(sprite(), "bad name", 6).findings.length > 0, "bad name");
    assert(T.setLabel(sprite(), "late", 30).findings.length > 0, "range");
    eq(T.setLabel(sprite(), "idle", 3).sprite.labels.idle, 3);
    eq(T.removeLabel(sprite(), "blink").sprite.labels.blink, undefined);
  });

  test("insertFrames shifts keys and labels at or after the frame; deleteFrames drops keys and labels in the range, shifts the rest back, and keeps the pose that was holding into the frames after", () => {
    need();
    const ins = T.insertFrames(sprite(), 12, 3);
    eq(ins.sprite.frames, 27);
    eq(ins.sprite.layers[0].keys[1].frame, 15);
    eq(ins.sprite.layers[1].keys[1].frame, 21);
    eq(ins.sprite.labels.blink, 21); eq(ins.sprite.labels.idle, 0);
    valid(ins.sprite);
    const del = T.deleteFrames(sprite(), 10, 4); // frames 10..13: the body key at 12 is inside
    eq(del.sprite.frames, 20);
    const bk = del.sprite.layers[0].keys;
    eq(bk.map((k: any) => k.frame).join(","), "0,10", "the key at 12 moved to the cut point, so frames after keep its pose");
    eq(bk[1].y, -10);
    eq(del.sprite.layers[1].keys[1].frame, 14);
    eq(del.sprite.labels.blink, 14);
    const lab = T.deleteFrames(sprite(), 16, 4);
    eq(lab.sprite.labels.blink, undefined);
    assert(lab.findings.some((f: any) => /blink/.test(f.message)), "a dropped label is reported");
    valid(del.sprite);
  });

  test("moveLayer swaps a layer with its neighbour in depth order (depths stay unique) and refuses past the ends", () => {
    need();
    const r = T.moveLayer(sprite(), 0, 1);
    const byDepth = [...r.sprite.layers].sort((a: any, b: any) => a.depth - b.depth).map((l: any) => l.name);
    eq(byDepth.join(","), "eye,body");
    assert(T.moveLayer(sprite(), 1, 1).findings.length > 0, "already on top");
    valid(r.sprite);
  });
}
