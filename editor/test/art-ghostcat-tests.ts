// Ghost cat (preview only): translucent placeholder silhouettes for the EMPTY slots of a `parts: "game"` cat rig, so an
// author animating a cat pose sees the pose move. Pure core (ghost-cat.ts: slot → part, transforms per frame, the
// built-in fallback silhouettes), the catparts.swf outlines (ghost-cat-swf.ts, T1 when .extracted/ is present), and the
// guarantee that none of it reaches the emitted SWF or the validator (byte identity of the _artprobe / dev-sandbox builds).

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { vanillaSwfDir } from "../src/core/repo.ts";
import { exampleScene, validateScene } from "../src/core/art/scene.ts";
import { normalizePath } from "../src/core/art/geometry.ts";
import { emitSwf } from "../src/core/art/swf-emitter.ts";
import { readArtScene, loadSceneBitmaps } from "../src/core/art/art-io.ts";
import { addCatRig, assignSlot, newCatAnimation, CAT_SLOTS } from "../src/core/art/cat-rig.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

/** sha256 of emitSwf(abc none) for the committed scenes at the commit that added the ghost cat (origin/main 95dcaa5); _artprobe re-pinned in the 2026-10-22 integration
 *  after the wave / back-facing / raster / cat-rig probes grew probe.scene.json (the ghost-free emitter output of that scene).
 *  The ghost cat must not change them; an intentional emitter change updates these. */
const PINNED_BUILDS: Array<{ mod: string; rel: string; bytes: number; sha256: string }> = [
  { mod: "_artprobe", rel: "art/probe.scene.json", bytes: 8368, sha256: "2bd103bf37b8756b2589321a6c2adc2d9fbafa115b11dc7640376e48011d1be8" },
  { mod: "dev-sandbox", rel: "art/my_rat.scene.json", bytes: 791, sha256: "d0483ca5ed51e71d254260378f5c9e76c27719b8e98ebf4354da2511b2e82835" },
];

export async function runArtGhostCatTests(test: TestFn, assert: AssertFn, eq: EqFn): Promise<void> {
  console.log("\n# Art: ghost cat (preview-only placeholders for a parts: \"game\" rig's empty slots)");
  let G: Record<string, any> = {};
  let GS: Record<string, any> = {};
  let err = "";
  try { G = await import("../src/core/art/ghost-cat.ts"); GS = await import("../src/core/art/ghost-cat-swf.ts"); } catch (e) { err = e instanceof Error ? e.message : String(e); }
  const need = () => { if (err) throw new Error(`ghost-cat: ${err}`); };
  const wave = () => newCatAnimation(exampleScene("ghost"), "wave").scene;

  test("GHOST_SLOT_PART: every cat slot maps to the catparts.swf part the game draws into it (tail CatTail, arms and legs CatLeg, body CatBody, head CatHead)", () => {
    need();
    eq(JSON.stringify(CAT_SLOTS.map((s) => `${s.name}:${G.GHOST_SLOT_PART[s.name]}`)), JSON.stringify(["tail:CatTail", "leg2:CatLeg", "arm2:CatLeg", "body:CatBody", "leg1:CatLeg", "arm1:CatLeg", "head:CatHead"]));
  });

  test("BUILTIN_GHOST_PARTS: source builtin, a closed path per part that geometry.ts parses, bounds of a cat part's size (10..120 px), none of it game art", () => {
    need();
    const b = G.BUILTIN_GHOST_PARTS;
    eq(b.source, "builtin");
    for (const p of ["CatBody", "CatHead", "CatLeg", "CatTail"]) {
      const part = b.parts[p];
      assert(!!part && typeof part.d === "string" && /Z\s*$/i.test(part.d.trim()), `${p}: closed d`);
      assert(normalizePath(part.d).length >= 1, `${p}: parses`);
      const w = part.bounds.xmax - part.bounds.xmin, h = part.bounds.ymax - part.bounds.ymin;
      assert(w >= 10 && w <= 120 && h >= 10 && h <= 120, `${p}: ${w}x${h}`);
    }
  });

  test("ghostCatFor: a parts: \"game\" rig (New cat animation's wavePose) gets one ghost per empty slot, back to front, labelled with the slot, the slot's own matrix (identity at frame 0), alpha 1, source builtin", () => {
    need();
    const sc = wave();
    const gh = G.ghostCatFor(sc, "wavePose", 0);
    eq(gh.map((g: any) => `${g.slot}@${g.depth}:${g.part}`).join(","), CAT_SLOTS.map((s) => `${s.name}@${s.depth}:${G.GHOST_SLOT_PART[s.name]}`).join(","));
    for (const g of gh) {
      eq(g.label, g.slot); eq(g.rig, "wavePose"); eq(g.source, "builtin"); eq(g.alpha, 1);
      eq(JSON.stringify(g.matrix), JSON.stringify([1, 0, 0, 1, 0, 0]));
      eq(g.d, G.BUILTIN_GHOST_PARTS.parts[g.part].d);
    }
  });

  test("ghostCatFor: no ghosts for a drawn rig (no parts), a plain sprite or an unknown id; a slot that holds art (rig-slot-not-empty) gets none, the others keep theirs", () => {
    need();
    const drawn = addCatRig(exampleScene("ghost"), "CatRig").scene;
    eq(G.ghostCatFor(drawn, "CatRig", 0).length, 0);
    eq(G.ghostCatFor(exampleScene("ghost"), "Starter", 0).length, 0);
    eq(G.ghostCatFor(wave(), "nope", 0).length, 0);
    const held = assignSlot(wave(), "wavePose", "head", "eye").scene;
    eq(G.ghostCatFor(held, "wavePose", 0).map((g: any) => g.slot).join(","), "tail,leg2,arm2,body,leg1,arm1");
  });

  test("ghostCatFor follows the slot's keyframes: a head tween x 0 → 20 over frames 0..10 puts the head ghost at x 10 on frame 5 and x 20 on frame 10; a key alpha carries into the ghost", () => {
    need();
    const sc = wave();
    const head = sc.sprites.wavePose!.layers.find((l) => l.name === "head")!;
    head.keys = [{ frame: 0, ref: "wavePose_head", x: 0, y: 0, tween: "linear" }, { frame: 10, ref: "wavePose_head", x: 20, y: -4, alpha: 0.5 }];
    const at = (f: number) => G.ghostCatFor(sc, "wavePose", f).find((g: any) => g.slot === "head");
    eq(at(5).matrix[4], 10); eq(at(5).matrix[5], -2);
    eq(at(10).matrix[4], 20); eq(at(10).alpha, 0.5);
    eq(JSON.stringify(G.ghostCatFor(sc, "wavePose", 5).find((g: any) => g.slot === "tail").matrix), JSON.stringify([1, 0, 0, 1, 0, 0]));
  });

  test("ghostCatsIn: a donor target (CatAppendRoot in _artprobe) shows the nested rig's ghosts through the `ani` placement — head = translate(3.85, -47.95) × the slot's idleF matrix; hasGhostRig is true there and false for a drawn rig", () => {
    need();
    const r = readArtScene("_artprobe", "art/probe.scene.json");
    const sc = r.scene!;
    const gh = G.ghostCatsIn(sc, "CatAppendRoot", 0);
    eq(gh.length, 7);
    const head = gh.find((g: any) => g.slot === "head");
    eq(head.rig, "CatProbe");
    assert(Math.abs(head.matrix[4] - (3.85 + 10.95)) < 1e-9 && Math.abs(head.matrix[5] - (-47.95 + 2.3)) < 1e-9, JSON.stringify(head.matrix));
    assert(Math.abs(head.matrix[0] - 0.6212615966796875) < 1e-12, "slot scale kept");
    eq(G.hasGhostRig(sc, "CatAppendRoot"), true);
    eq(G.hasGhostRig(sc, "CatProbe"), true);
    eq(G.hasGhostRig(sc, "CatProbeColours"), false);
    eq(G.ghostCatsIn(sc, "CatProbeColours", 0).length, 0);
    const b = G.ghostBounds(gh);
    assert(!!b && b.xmax > b.xmin && b.ymax > b.ymin, `bounds ${JSON.stringify(b)}`);
  });

  test("ghostCatsIn with outlines from catparts.swf: every ghost carries that source and the given outline", () => {
    need();
    const parts = { source: "catparts.swf", parts: Object.fromEntries(["CatBody", "CatHead", "CatLeg", "CatTail"].map((p) => [p, { d: `M0 0 L10 0 L10 10 Z`, bounds: { xmin: 0, ymin: 0, xmax: 10, ymax: 10 } }])) };
    const gh = G.ghostCatsIn(wave(), "wavePose", 0, 0, parts);
    assert(gh.length === 7 && gh.every((g: any) => g.source === "catparts.swf" && g.d === "M0 0 L10 0 L10 10 Z"), JSON.stringify(gh[0]));
  });

  test("readGhostCatParts: without catparts.swf (an empty dir) it falls back to the built-in silhouettes and says why", () => {
    need();
    const dir = mkdtempSync(join(tmpdir(), "ghost-noswf-"));
    try {
      const p = GS.readGhostCatParts(dir);
      eq(p.source, "builtin");
      eq(p.parts.CatHead.d, G.BUILTIN_GHOST_PARTS.parts.CatHead.d);
      assert(/catparts\.swf/.test(p.note || ""), `note: ${p.note}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  const cpPath = join(vanillaSwfDir(), "catparts.swf");
  if (!existsSync(cpPath)) console.log(`  (skipped: T1 ghost outlines — no catparts.swf at ${cpPath})`);
  else test("T1: readGhostCatParts reads the four part silhouettes from the installed catparts.swf (frame 1's mask shape): closed paths of a cat part's size, the built-ins sized like them", () => {
    need();
    const p = GS.readGhostCatParts(vanillaSwfDir());
    eq(p.source, "catparts.swf");
    for (const n of ["CatBody", "CatHead", "CatLeg", "CatTail"]) {
      const v = p.parts[n], b = G.BUILTIN_GHOST_PARTS.parts[n];
      assert(normalizePath(v.d).length >= 1, `${n} parses`);
      const w = v.bounds.xmax - v.bounds.xmin, h = v.bounds.ymax - v.bounds.ymin;
      const bw = b.bounds.xmax - b.bounds.xmin, bh = b.bounds.ymax - b.bounds.ymin;
      assert(w > 5 && h > 5 && Math.abs(w - bw) <= Math.max(6, w * 0.25) && Math.abs(h - bh) <= Math.max(6, h * 0.25), `${n}: vanilla ${w.toFixed(1)}x${h.toFixed(1)} vs builtin ${bw}x${bh}`);
    }
  });

  test("the emitter and validator never see the ghost cat: _artprobe / dev-sandbox builds are byte-identical to the pinned pre-ghost builds, and computing ghosts leaves the scene, its findings and its bytes unchanged", () => {
    need();
    for (const pin of PINNED_BUILDS) {
      const r = readArtScene(pin.mod, pin.rel);
      const sc = r.scene!;
      const bm = loadSceneBitmaps(pin.mod, sc);
      const before = emitSwf(sc, { abc: "none", bitmaps: bm.bitmaps }).bytes;
      eq(before.length, pin.bytes, `${pin.mod} size`);
      eq(createHash("sha256").update(before).digest("hex"), pin.sha256, `${pin.mod} sha256`);
      const json = JSON.stringify(sc);
      const findings = JSON.stringify(validateScene(sc).findings);
      for (const id of Object.keys(sc.sprites)) G.ghostCatsIn(sc, id, 0);
      eq(JSON.stringify(sc), json, `${pin.mod}: scene untouched`);
      eq(JSON.stringify(validateScene(sc).findings), findings, `${pin.mod}: findings unchanged`);
      eq(Buffer.from(emitSwf(sc, { abc: "none", bitmaps: bm.bitmaps }).bytes).equals(Buffer.from(before)), true, `${pin.mod}: bytes unchanged`);
    }
  });
}
