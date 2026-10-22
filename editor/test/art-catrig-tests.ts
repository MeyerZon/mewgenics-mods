// Cat rig (art build-out H): a cat-shaped character drawn by our own SWF with the vanilla slot layout (the named
// instances tail / leg2 / arm2 / body / leg1 / arm1 / head the game's cat animations use). Pinned against the vanilla
// files (T1, names and depths only), authored by the pure cat-rig.ts, checked by the validator, drawn in the game (T2).

import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MODS_DIR, vanillaSwfDir } from "../src/core/repo.ts";
import { exampleScene, validateScene } from "../src/core/art/scene.ts";
import { readSwf } from "../src/core/art/swf-reader.ts";
import { emitSwf } from "../src/core/art/swf-emitter.ts";
import * as pc from "../src/core/art/probe-compare.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const VANILLA_DIR = vanillaSwfDir(); // repo.ts: MEWGENICS_VANILLA_SWF_DIR, else <extracted root>/swfs

export async function runArtCatRigTests(test: TestFn, assert: AssertFn, eq: EqFn): Promise<void> {
  console.log("\n# Art: cat rig (vanilla slot layout, cat-rig.ts, validator, in-game)");
  const fixture = JSON.parse(readFileSync(join(HERE, "fixtures", "art", "cat-rig-slots.json"), "utf8")) as { minecartCat: { labels: string[]; slots: { name: string; depth: number }[] }; catanisMain: { frames: number; slots: { name: string; depth: number }[] } };
  let R: Record<string, any> = {};
  let err = "";
  try { R = await import("../src/core/art/cat-rig.ts"); } catch (e) { err = e instanceof Error ? e.message : String(e); }
  const need = () => { if (err) throw new Error(`cat-rig.ts: ${err}`); };

  test("CAT_SLOTS is the main vanilla cat animation's layout (catanis.swf: tail 1, leg2 3, arm2 5, body 7, leg1 9, arm1 11, head 13)", () => {
    need();
    eq(JSON.stringify(R.CAT_SLOTS), JSON.stringify(fixture.catanisMain.slots));
  });

  const named = (sp: any) => { const out: { name: string; depth: number }[] = []; const seen = new Set<string>(); for (const t of sp.tags) { if (t.name === "ShowFrame") break; if (t.place && t.place.name && !seen.has(t.place.name)) { seen.add(t.place.name); out.push({ name: t.place.name, depth: t.place.depth }); } } return out; };
  const mcPath = join(VANILLA_DIR, "minecarts.swf"), caPath = join(VANILLA_DIR, "catanis.swf");
  if (!existsSync(mcPath) || !existsSync(caPath)) console.log(`  (skipped: vanilla minecarts.swf / catanis.swf not extracted at ${VANILLA_DIR})`);
  else test("T1: the fixture matches the installed game (MinecartCat's slots and labels, the longest catanis.swf sprite's slots)", () => {
    const mc = readSwf(new Uint8Array(readFileSync(mcPath))) as any;
    const sc = mc.tags.find((t: any) => t.name === "SymbolClass");
    const id = (sc.entries || sc.symbols).find((s: any) => s.name === "MinecartCat").id;
    const mcat = mc.tags.find((t: any) => t.id === id);
    eq(JSON.stringify(named(mcat)), JSON.stringify(fixture.minecartCat.slots));
    eq(mcat.tags.filter((t: any) => t.name === "FrameLabel").map((t: any) => t.label).join(","), fixture.minecartCat.labels.join(","));
    const ca = readSwf(new Uint8Array(readFileSync(caPath))) as any;
    const big = ca.tags.filter((t: any) => t.name === "DefineSprite").sort((a: any, b: any) => b.frameCount - a.frameCount)[0];
    eq(big.frameCount, fixture.catanisMain.frames);
    eq(JSON.stringify(named(big)), JSON.stringify(fixture.catanisMain.slots));
  });

  test("addCatRig: a rig sprite (rig: cat) with one named layer per slot at the vanilla depths, placeholder shapes, label idle; the scene validates; a taken name is refused", () => {
    need();
    const r = R.addCatRig(exampleScene("rig"), "CatRig");
    assert(!r.findings.some((f: any) => f.severity === "error"), JSON.stringify(r.findings));
    const sp = r.scene.sprites.CatRig;
    eq(sp.rig, "cat");
    eq(sp.layers.map((l: any) => `${l.name}:${l.depth}`).join(","), fixture.catanisMain.slots.map((s) => `${s.name}:${s.depth}`).join(","));
    eq(sp.labels.idle, 0);
    for (const l of sp.layers) assert(!!r.scene.shapes[l.keys[0].ref], `placeholder for ${l.name}`);
    const v = validateScene(r.scene) as any;
    assert(v.ok, JSON.stringify(v.findings.filter((f: any) => f.severity === "error")));
    assert(R.addCatRig(r.scene, "CatRig").findings.some((f: any) => f.severity === "error"), "refused");
  });

  test("addCatRig parts: \"game\": the rig carries parts \"game\" and every slot references an EMPTY 1-frame sprite (no placeholder art); it validates; pointing a slot at a shape is rig-slot-not-empty (error)", () => {
    need();
    const r = R.addCatRig(exampleScene("rig"), "GameRig", { parts: "game" });
    assert(!r.findings.some((f: any) => f.severity === "error"), JSON.stringify(r.findings));
    const sp = r.scene.sprites.GameRig;
    eq(sp.rig, "cat"); eq(sp.parts, "game");
    eq(sp.layers.map((l: any) => `${l.name}:${l.depth}`).join(","), fixture.catanisMain.slots.map((s) => `${s.name}:${s.depth}`).join(","));
    for (const l of sp.layers) {
      const slot = r.scene.sprites[l.keys[0].ref];
      assert(!!slot && slot.frames === 1 && Array.isArray(slot.layers) && slot.layers.length === 0, `${l.name} references an empty 1-frame sprite: ${JSON.stringify(slot)}`);
    }
    assert(!Object.keys(r.scene.shapes).some((id) => id.startsWith("GameRig_")), "no placeholder shapes");
    const v = validateScene(r.scene) as any;
    assert(v.ok && !v.findings.some((f: any) => f.code === "rig-slot-not-empty"), JSON.stringify(v.findings));
    const bad = R.assignSlot(r.scene, "GameRig", "head", "eye").scene;
    const codesBad = (validateScene(bad) as any).findings.map((f: any) => `${f.severity}:${f.code}`);
    assert(codesBad.includes("error:rig-slot-not-empty"), codesBad.join(","));
    const plain = R.addCatRig(exampleScene("rig"), "CatRig").scene;
    assert(!(validateScene(plain) as any).findings.some((f: any) => f.code === "rig-slot-not-empty"), "a preview-only placeholder rig (no parts) is not flagged");
  });

  test("assignSlot points every key of a slot at a shape or sprite; an unknown slot or ref is refused", () => {
    need();
    const r = R.addCatRig(exampleScene("rig"), "CatRig");
    const a = R.assignSlot(r.scene, "CatRig", "head", "eye");
    assert(!a.findings.length, JSON.stringify(a.findings));
    eq(a.scene.sprites.CatRig.layers.find((l: any) => l.name === "head").keys[0].ref, "eye");
    assert(R.assignSlot(r.scene, "CatRig", "wing", "eye").findings.length > 0, "unknown slot");
    assert(R.assignSlot(r.scene, "CatRig", "head", "nope").findings.length > 0, "unknown ref");
  });

  test("validateScene on a rig: a missing slot is rig-slot-missing (warning), a repeated slot rig-slot-dup (error), a head behind the body rig-depth-order (info)", () => {
    need();
    const r = R.addCatRig(exampleScene("rig"), "CatRig");
    const sp = r.scene.sprites.CatRig;
    sp.layers = sp.layers.filter((l: any) => l.name !== "tail");
    sp.layers.find((l: any) => l.name === "head").depth = 2;
    sp.layers.push({ ...sp.layers.find((l: any) => l.name === "body"), depth: 20 });
    const codes = (validateScene(r.scene) as any).findings.map((f: any) => `${f.severity}:${f.code}`);
    assert(codes.includes("warning:rig-slot-missing"), codes.join(","));
    assert(codes.includes("error:rig-slot-dup"), codes.join(","));
    assert(codes.includes("info:rig-depth-order"), codes.join(","));
  });

  test("slotColoursPresent counts the pixels near each slot colour (the in-game rig check)", () => {
    const f = (pc as Record<string, any>).slotColoursPresent;
    assert(typeof f === "function", "probe-compare exports slotColoursPresent");
    const W = 20, H = 10, img = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) img.set(i < 50 ? [32, 160, 255, 255] : [40, 40, 40, 255], i * 4);
    const n = f({ width: W, height: H, rgba: img }, { body: "#20a0ff", head: "#ffa020" });
    eq(n.body, 50); eq(n.head, 0);
    // a uniformly darkened slot still counts; with an anchor only the region around the anchor's largest blob counts
    const W2 = 100, H2 = 10, im2 = new Uint8Array(W2 * H2 * 4);
    for (let i = 0; i < W2 * H2; i++) im2.set([40, 40, 40, 255], i * 4);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) im2.set([27, 109, 217, 255], (y * W2 + x) * 4); // #2080ff × 0.85
    for (let y = 0; y < 10; y++) for (let x = 10; x < 14; x++) im2.set([217, 177, 136, 255], (y * W2 + x) * 4); // #ffd0a0 × 0.85 next to it
    for (let y = 0; y < 10; y++) for (let x = 90; x < 100; x++) im2.set([255, 208, 160, 255], (y * W2 + x) * 4); // UI peach far away
    const n2 = f({ width: W2, height: H2, rgba: im2 }, { body: "#2080ff", head: "#ffd0a0" }, { anchor: "body", radius: 20 });
    eq(n2.body, 100); eq(n2.head, 40);
  });

  test("OBSERVED 2026-10-20 fixture (artprobe-cat-summary.json): every slot of a cat rig drawn by our SWF shows up in the game", () => {
    const p = join(HERE, "fixtures", "ingame", "artprobe-cat-summary.json");
    assert(existsSync(p), "written by npm run test:artprobe -- --cat");
    const j = JSON.parse(readFileSync(p, "utf8")) as { slots: Record<string, number> };
    for (const s of fixture.catanisMain.slots) assert((j.slots[s.name] || 0) > 50, `${s.name}: ${j.slots[s.name]}`);
  });

  test("largestChangedRegion / changedPixelsNear (probe-compare): the biggest 8-connected blob of pixels that differ from a reference shot; the changed pixels within a radius split into the excluded (slot / marker) colours and the rest", () => {
    const f = (pc as Record<string, any>).largestChangedRegion, g = (pc as Record<string, any>).changedPixelsNear;
    assert(typeof f === "function" && typeof g === "function", "probe-compare exports largestChangedRegion and changedPixelsNear");
    const W = 40, H = 20, ref = new Uint8Array(W * H * 4), img = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) { ref.set([90, 90, 90, 255], i * 4); img.set([92, 88, 90, 255], i * 4); } // a 6-level wobble is not a change
    for (let y = 4; y <= 9; y++) for (let x = 10; x <= 15; x++) img.set([32, 128, 255, 255], (y * W + x) * 4); // a 6x6 #2080ff blob
    for (let y = 4; y <= 5; y++) for (let x = 14; x <= 15; x++) img.set([255, 255, 255, 255], (y * W + x) * 4); // 4 white px in its corner
    for (let y = 2; y <= 3; y++) for (let x = 30; x <= 31; x++) img.set([255, 255, 255, 255], (y * W + x) * 4); // a far 2x2 white blob
    const A = { width: W, height: H, rgba: img }, R = { width: W, height: H, rgba: ref };
    const reg = f(A, R);
    eq(JSON.stringify(reg), JSON.stringify({ n: 36, x0: 10, y0: 4, x1: 15, y1: 9, cx: 12.5, cy: 6.5 }));
    eq(f(R, R), null);
    eq(JSON.stringify(g(A, R, { x: 12.5, y: 6.5 }, 100, { exclude: { body: "#2080ff" } })), JSON.stringify({ changed: 40, excluded: 32, other: 8 }));
    eq(JSON.stringify(g(A, R, { x: 12.5, y: 6.5 }, 10, { exclude: { body: "#2080ff" } })), JSON.stringify({ changed: 36, excluded: 32, other: 4 }));
    eq(g(A, R, { x: 12.5, y: 6.5 }, 10, {}).other, 36);
  });

  test("slotColoursPresent with a `centre` + radius window counts only around that point (the marker's centre when the slots may be gone)", () => {
    const W = 100, H = 10, im = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) im.set([40, 40, 40, 255], i * 4);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) im.set([32, 128, 255, 255], (y * W + x) * 4);
    for (let y = 0; y < 10; y++) for (let x = 90; x < 100; x++) im.set([32, 128, 255, 255], (y * W + x) * 4);
    const n = pc.slotColoursPresent({ width: W, height: H, rgba: im }, { body: "#2080ff" }, { centre: { x: 5, y: 5 }, radius: 20 } as any);
    eq(n.body, 100);
  });

  // ---- experiment A0 (2026-10-21): an _Append_CatTest frame placing our rig — the game fills its slots by name ----
  // (PR #74 block; the cat-animation authoring tests of PR #76 live in their own block below / after this one.)
  // catB (.analysis/notes-catB.md): CatParts::prerender fills every slot-named instance of whatever clip the renderer
  // plays; on a slot's first prerender the helper 0x741f10 takes the create path (drop the placeholder, insert a
  // ReferenceRenderer that draws the cat's own part) only when the slot sprite is hidden or has no children — so a
  // mod's slots are EMPTY 1-frame sprites (vanilla hides its placeholders with an ActionScript setInvisible()).
  const MODS = resolve(HERE, "../../mods");

  test("addCatRig parts \"game\" (A0): every slot references an empty 1-frame sprite <name>_<slot>, the rig carries parts \"game\" and validates; a parts \"game\" rig whose slot holds a shape or a non-empty sprite is rig-slot-not-empty (error, naming the +0x741f5d crash); a drawn rig keeps its placeholders and gets no such finding", () => {
    need();
    const r = R.addCatRig(exampleScene("rig"), "CatRig", { parts: "game" });
    assert(!r.findings.some((f: any) => f.severity === "error"), JSON.stringify(r.findings));
    const sp = r.scene.sprites.CatRig;
    eq(sp.rig, "cat"); eq(sp.parts, "game");
    for (const s of fixture.catanisMain.slots) {
      const layer = sp.layers.find((l: any) => l.name === s.name);
      assert(!!layer && layer.depth === s.depth, `slot ${s.name} at depth ${s.depth}`);
      const slot = r.scene.sprites[`CatRig_${s.name}`];
      assert(!!slot && slot.frames === 1 && Array.isArray(slot.layers) && slot.layers.length === 0, `CatRig_${s.name} is an empty 1-frame sprite`);
      eq(layer.keys[0].ref, `CatRig_${s.name}`);
      assert(!r.scene.shapes[`CatRig_${s.name}`], "no placeholder shape");
    }
    const v = validateScene(r.scene) as any;
    assert(v.ok, JSON.stringify(v.findings.filter((f: any) => f.severity === "error")));
    assert(!v.findings.some((f: any) => f.code === "rig-slot-not-empty"), "empty slots pass");
    // a shape in a slot of a parts: "game" rig
    const bad = R.assignSlot(r.scene, "CatRig", "head", "eye").scene;
    const f1 = (validateScene(bad) as any).findings.find((f: any) => f.code === "rig-slot-not-empty");
    assert(!!f1 && f1.severity === "error" && /0x741f5d/.test(f1.message) && f1.path === "sprites.CatRig", JSON.stringify(f1));
    // a non-empty sprite in a slot
    bad.sprites.CatRig_head = { frames: 1, labels: {}, layers: [{ depth: 1, keys: [{ frame: 0, ref: "eye", x: 0, y: 0 }] }] };
    const f2 = (validateScene(R.assignSlot(bad, "CatRig", "head", "CatRig_head").scene) as any).findings.find((f: any) => f.code === "rig-slot-not-empty");
    assert(!!f2, "a non-empty slot sprite is rig-slot-not-empty");
    // a drawn rig (placeholders) is not a parts: "game" rig: no finding
    const drawn = R.addCatRig(exampleScene("rig"), "Drawn");
    eq(drawn.scene.sprites.Drawn.parts, undefined);
    assert(!(validateScene(drawn.scene) as any).findings.some((f: any) => f.code === "rig-slot-not-empty"), "drawn rig: no rig-slot-not-empty");
  });

  test("emitter (A0): an empty 1-frame sprite becomes a DefineSprite of one ShowFrame and nothing placed — the shape CatParts' create path needs (child count 0)", () => {
    need();
    const r = R.addCatRig(exampleScene("rig"), "CatRig", { parts: "game" });
    r.scene.exports = { CatRig: "CatRig" };
    const v = validateScene(r.scene) as any;
    assert(v.ok, JSON.stringify(v.findings));
    const out = emitSwf(v.scene) as any;
    assert(!out.findings.some((f: any) => f.severity === "error"), JSON.stringify(out.findings));
    const swf = readSwf(out.bytes) as any;
    const sprites = swf.tags.filter((t: any) => t.name === "DefineSprite");
    const rig = sprites.find((s: any) => s.tags.some((t: any) => t.place && t.place.name === "head"));
    assert(!!rig, "the rig sprite places a `head` instance");
    const headId = rig.tags.find((t: any) => t.place && t.place.name === "head").place.characterId;
    const slot = sprites.find((s: any) => s.id === headId);
    assert(!!slot, "the head slot is a DefineSprite");
    eq(slot.frameCount, 1);
    eq(slot.tags.filter((t: any) => t.name === "ShowFrame").length, 1);
    eq(slot.tags.filter((t: any) => t.place || /^PlaceObject/.test(t.name)).length, 0);
    for (const s of fixture.catanisMain.slots) assert(!!rig.tags.find((t: any) => t.place && t.place.name === s.name && t.place.depth === s.depth), `rig places ${s.name}@${s.depth}`);
  });

  test("changedPixelsNear perColour (A0): the excluded pixels broken down by colour name (which slot colours appeared near the marker; the marker's own)", () => {
    const g = (pc as Record<string, any>).changedPixelsNear;
    const W = 40, H = 20, ref = new Uint8Array(W * H * 4), img = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) { ref.set([90, 90, 90, 255], i * 4); img.set([90, 90, 90, 255], i * 4); }
    for (let y = 4; y <= 9; y++) for (let x = 10; x <= 15; x++) img.set([32, 128, 255, 255], (y * W + x) * 4); // 36 #2080ff
    for (let y = 4; y <= 5; y++) for (let x = 14; x <= 15; x++) img.set([255, 255, 0, 255], (y * W + x) * 4); // 4 marker yellow
    for (let y = 2; y <= 3; y++) for (let x = 30; x <= 31; x++) img.set([255, 255, 255, 255], (y * W + x) * 4); // 4 white (other)
    const n = g({ width: W, height: H, rgba: img }, { width: W, height: H, rgba: ref }, { x: 12.5, y: 6.5 }, 100, { exclude: { body: "#2080ff", markerYellow: "#ffff00" }, perColour: true });
    eq(JSON.stringify(n), JSON.stringify({ changed: 40, excluded: 36, other: 4, colours: { body: 32, markerYellow: 4 } }));
    assert(!("colours" in g({ width: W, height: H, rgba: img }, { width: W, height: H, rgba: ref }, { x: 12.5, y: 6.5 }, 100, { exclude: { body: "#2080ff" } })), "without perColour the shape is unchanged");
  });

  test("darkPixelsNear / largestChangedRegion dark (A0): the near-black pixels within a radius that changed vs the reference shot (a real cat's outline; floor overlays and re-tinted units never add black), and the largest blob of changed near-black pixels (where a real cat stands)", () => {
    const g = (pc as Record<string, any>).darkPixelsNear, f = (pc as Record<string, any>).largestChangedRegion;
    assert(typeof g === "function", "probe-compare exports darkPixelsNear");
    const W = 40, H = 20, ref = new Uint8Array(W * H * 4), img = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) { ref.set([90, 90, 90, 255], i * 4); img.set([130, 110, 80, 255], i * 4); } // the whole floor re-tinted (changed, not dark)
    for (let y = 4; y <= 9; y++) for (let x = 10; x <= 15; x++) img.set([20, 18, 22, 255], (y * W + x) * 4); // a 6x6 outline blob
    for (let y = 2; y <= 3; y++) for (let x = 30; x <= 31; x++) img.set([10, 10, 10, 255], (y * W + x) * 4); // a far 2x2 dark blob
    for (let y = 12; y <= 13; y++) for (let x = 2; x <= 3; x++) { ref.set([10, 10, 10, 255], (y * W + x) * 4); img.set([10, 10, 10, 255], (y * W + x) * 4); } // dark in both: not new
    const A = { width: W, height: H, rgba: img }, R = { width: W, height: H, rgba: ref };
    eq(g(A, R, { x: 12.5, y: 6.5 }, 100), 40);
    eq(g(A, R, { x: 12.5, y: 6.5 }, 10), 36);
    eq(g(A, R, { x: 12.5, y: 6.5 }, 10, { dark: 15 }), 0);
    eq(JSON.stringify(f(A, R, { dark: 40 })), JSON.stringify({ n: 36, x0: 10, y0: 4, x1: 15, y1: 9, cx: 12.5, cy: 6.5 }));
    // `within` limits the search to a window (the arena, away from the HUD: OBSERVED the End Turn button animating)
    eq(JSON.stringify(f(A, R, { dark: 40, within: { x0: 25, y0: 0, x1: 39, y1: 19 } })), JSON.stringify({ n: 4, x0: 30, y0: 2, x1: 31, y1: 3, cx: 30.5, cy: 2.5 }));
    eq(f(A, R, 60).n, W * H - 4); // the number form still means tol: everything but the dark-in-both corner changed
  });

  test("cat append probe scene (A0): probe.scene.json exports _Append_CatTest -> CatAppendRoot (probeIdleF 0 / probeIdleB 1, the layer `ani` at depth 1 placing CatProbe at vanilla idleF's offset); CatProbe is a parts \"game\" rig: every slot an EMPTY 1-frame sprite at the vanilla depth with vanilla idleF's slot matrix, the checker marker at depth 15 (not a slot); CatProbeColours keeps the coloured wrapped slots for the plain-movieclip primer; the scene validates", () => {
    const scene = JSON.parse(readFileSync(join(MODS, "_artprobe", "art", "probe.scene.json"), "utf8")) as any;
    eq(scene.exports["_Append_CatTest"], "CatAppendRoot");
    eq(scene.exports["CatProbeColours"], "CatProbeColours");
    const root = scene.sprites.CatAppendRoot;
    assert(!!root, "sprite CatAppendRoot");
    eq(root.frames, 10, "probeIdleF / probeIdleB, then the wave probe's waveF / waveB (art-wave-glow-tests.ts), the back probe's probeBackF / probeBackB / probeBackShowF / probeBackShowB (art-cat-back-tests.ts), then the raster probe's probeRasterF / B (probe-raster.ts withRasterCatFrame)");
    eq(root.labels.probeIdleF, 0); eq(root.labels.probeIdleB, 1);
    eq(root.layers.length, 1);
    const ani = root.layers[0];
    assert(ani.name === "ani" && ani.depth === 1, "the one layer is `ani` at depth 1 (the child PlayAnimation restarts)");
    assert(ani.keys.filter((k: any) => k.frame <= 1).length === 2 && ani.keys.filter((k: any) => k.frame <= 1).every((k: any) => k.ref === "CatProbe" && k.x === 3.85 && k.y === -47.95), "ani places CatProbe on both frames at vanilla idleF's (77, -959) twips");
    const rig = scene.sprites.CatProbe;
    eq(rig.rig, "cat"); eq(rig.parts, "game");
    for (const s of fixture.catanisMain.slots) {
      const layer = rig.layers.find((l: any) => l.name === s.name);
      assert(!!layer && layer.depth === s.depth, `slot ${s.name} at depth ${s.depth}`);
      eq(layer.keys.length, 1);
      const slot = scene.sprites[layer.keys[0].ref];
      assert(!!slot && slot.frames === 1 && slot.layers.length === 0, `slot ${s.name} -> ${layer.keys[0].ref} is an empty 1-frame sprite`);
      assert(Array.isArray(layer.keys[0].matrix) && layer.keys[0].matrix.length === 6, `slot ${s.name} carries a raw matrix (vanilla idleF's)`);
    }
    const marker = rig.layers.find((l: any) => l.depth === 15);
    assert(!!marker && marker.name === "marker", "the marker layer at depth 15");
    const mw = scene.sprites[marker.keys[0].ref];
    assert(!!mw && mw.frames === 1 && mw.layers.length === 1 && mw.layers[0].keys[0].ref === "checker", "marker wraps the checker shape");
    assert(!fixture.catanisMain.slots.some((s) => s.depth === 15), "15 is not a slot depth");
    const col = scene.sprites.CatProbeColours;
    assert(!!col && col.rig === "cat" && col.parts === undefined, "CatProbeColours: a drawn rig");
    for (const s of fixture.catanisMain.slots) {
      const layer = col.layers.find((l: any) => l.name === s.name);
      const w = layer && scene.sprites[layer.keys[0].ref];
      assert(!!w && w.frames === 1 && w.layers.length === 1 && !!scene.shapes[w.layers[0].keys[0].ref], `CatProbeColours slot ${s.name} wraps a colour shape`);
    }
    const v = validateScene(scene) as any;
    assert(v.ok, JSON.stringify(v.findings.filter((f: any) => f.severity === "error")));
    const gon = readFileSync(join(MODS, "_artprobe", "data", "characters", "enemies.gon.append"), "utf8");
    assert(/ArtProbeCatReal\s*\{[\s\S]*variant_of TomTom[\s\S]*alt_animations \[\[idle probeIdle\]\]/.test(gon), "enemies.gon.append: ArtProbeCatReal, a TomTom variant with alt_animations [[idle probeIdle]]");
    assert(/ArtProbeCat\s*\{[\s\S]*?movieclip CatProbeColours/.test(gon), "enemies.gon.append: ArtProbeCat (the primer) is drawn by CatProbeColours");
  });

  if (!existsSync(caPath)) console.log(`  (skipped: vanilla catanis.swf not extracted at ${VANILLA_DIR})`);
  else test("T1 (A0): CatProbe's slot matrices and the `ani` offset are vanilla CatTest idleF's (frame 0 of the sprite idleF places, catanis.swf), so the game's parts stand like a cat in our frame", () => {
    const scene = JSON.parse(readFileSync(join(MODS, "_artprobe", "art", "probe.scene.json"), "utf8")) as any;
    const ca = readSwf(new Uint8Array(readFileSync(caPath))) as any;
    const sc = ca.tags.find((t: any) => t.name === "SymbolClass");
    const catTest = ca.tags.find((t: any) => t.name === "DefineSprite" && t.id === (sc.entries || sc.symbols).find((s: any) => s.name === "CatTest").id);
    let fr = 0, idle = -1;
    const placed: any[] = [];
    for (const t of catTest.tags) { if (t.name === "FrameLabel" && t.label === "idleF") idle = fr; if (fr === idle && t.place) placed.push(t.place); if (t.name === "ShowFrame") { if (idle >= 0) break; fr++; } }
    assert(placed.length === 1 && placed[0].depth === 1, "idleF places one nested sprite at depth 1");
    eq(JSON.stringify(placed[0].matrix.slice(4)), JSON.stringify([77, -959]));
    const pose = ca.tags.find((t: any) => t.name === "DefineSprite" && t.id === placed[0].characterId);
    const first: any[] = [];
    for (const t of pose.tags) { if (t.name === "ShowFrame") break; if (t.place) first.push(t.place); }
    for (const s of fixture.catanisMain.slots) {
      const van = first.find((p) => p.name === s.name), ours = scene.sprites.CatProbe.layers.find((l: any) => l.name === s.name).keys[0];
      assert(!!van && van.depth === s.depth, `vanilla idleF pose places ${s.name}@${s.depth}`);
      for (let i = 0; i < 4; i++) assert(Math.abs(van.matrix[i] - ours.matrix[i]) < 1e-6, `${s.name} matrix[${i}] ${van.matrix[i]} vs ${ours.matrix[i]}`);
      eq(Math.round(ours.matrix[4] * 20), van.matrix[4]); eq(Math.round(ours.matrix[5] * 20), van.matrix[5]);
      if (van.cxform) { const m = ours.cxform && ours.cxform.mul; assert(!!m && Math.abs(m[0] - van.cxform.mul[0] / 256) < 0.01, `${s.name} keeps vanilla's cxform mul`); }
    }
  });

  test("OBSERVED 2026-10-21 fixture (A0, artprobe-cat-append-summary.json): with EMPTY slot sprites a _CAT unit whose idle is our appended CatTest frame spawns (pass, no crash), our frame is displayed (our marker in at least two rig shots), the game draws real cat parts under it (outline comparable to TomTom's in the vanilla shot); both controls pass; the primer still draws the coloured rig", () => {
    const p = join(HERE, "fixtures", "ingame", "artprobe-cat-append-summary.json");
    assert(existsSync(p), "written by npm run test:artprobe -- --cat-append");
    type Near = { changed: number; excluded: number; other: number; colours: Record<string, number> };
    const j = JSON.parse(readFileSync(p, "utf8")) as { verdict: string; crashRva: string | null; outcome: string; controls: Record<string, { verdict: string; crashRva: string | null }>; shots: string[]; vanilla: { region: { n: number } | null; near: Near | null; outline: number | null }; primer: { marker: { found: boolean } | null; slots: Record<string, number> | null } | null; rig: Array<{ label: string; marker: { found: boolean } | null; ours: boolean; outline: number; slots: Record<string, number>; near: Near | null }> };
    eq(j.verdict, "pass");
    eq(j.crashRva, null);
    eq(j.outcome, "filled-by-name");
    eq(j.shots.join(","), "baseline,vanilla,primer,rig 1,rig 2,rig 3");
    eq(j.controls.crawlingIdle!.verdict, "pass"); eq(j.controls.crawlingIdle!.crashRva, null);
    eq(j.controls.missingLabel!.verdict, "pass"); eq(j.controls.missingLabel!.crashRva, null);
    // TomTom's real parts vs the baseline: the outline (near-black pixels that are new) around the largest new dark blob
    assert(!!j.vanilla.outline && j.vanilla.outline > 1500, `vanilla outline: ${j.vanilla.outline}`);
    const vanillaOutline = j.vanilla.outline!;
    assert(!!j.primer && !!j.primer.marker && j.primer.marker.found, "primer: marker found");
    for (const s of fixture.catanisMain.slots) assert(((j.primer!.slots || {})[s.name] || 0) > 50, `primer slot ${s.name}: ${(j.primer!.slots || {})[s.name]}`);
    eq(j.rig.length, 3);
    // OBSERVED: _autoplay's party killed the rig cat between +160 and +200 frames after the spawn in the first run (it
    // lay in the vanilla death pose, our frame gone), so our marker (a box that is not the primer's) is required in at
    // least two shots; every shot that shows it must show real parts (outline) comparable to TomTom's
    const ours = j.rig.filter((r) => r.ours);
    assert(ours.length >= 2, `our marker in ${ours.length}/3 rig shots`);
    for (const r of ours) {
      assert(!!r.marker && r.marker.found, `${r.label}: marker found`);
      assert(r.outline >= 0.3 * vanillaOutline, `${r.label}: real parts near our marker (outline ${r.outline} vs vanilla ${vanillaOutline})`);
    }
  });
  await runCatAnimationTests(test, assert, eq, need, R);
}

// ---- cat animations: labeled facing frames appended to the vanilla CatTest clip ---------------------------------------

interface AnimFixture {
  append: string;
  layer: string;
  depth: number;
  facing: string[];
  catanis: { export: string; id: number; frames: number; labels: number; firstLabels: string[]; idleLayerName: string; depths: number[]; maxPlacesPerLabeledFrame: number; pawingFrames: number; aniFrames: number; emptyFrames: number; idleF: { frames: number; slots: string[] }; idleB: { frames: number; slots: string[] } };
  catanis2: { export: string; id: number; frames: number; labels: number; labelsAmong: string[] };
}

async function runCatAnimationTests(test: TestFn, assert: AssertFn, eq: EqFn, need: () => void, R: Record<string, any>): Promise<void> {
  console.log("\n# Art: cat animations (labeled F/B frames appended to CatTest, cat-rig.ts newCatAnimation, validator, api, MCP)");
  const fx = JSON.parse(readFileSync(join(HERE, "fixtures", "art", "cat-anim-append.json"), "utf8")) as AnimFixture;
  const errors = (fs: any[]) => fs.filter((f) => f.severity === "error").map((f) => f.code + ": " + f.message).join("; ");
  const codes = (scene: any) => (validateScene(scene) as any).findings.map((f: any) => `${f.severity}:${f.code}`) as string[];

  test("CAT_ANIM_EXPORT / CAT_ANIM_LAYER / CAT_ANIM_DEPTH are the engine's shape (_Append_CatTest, the child instance `ani` PlayAnimation restarts, depth 1; fixture cat-anim-append.json)", () => {
    need();
    eq(R.CAT_ANIM_EXPORT, fx.append);
    eq(R.CAT_ANIM_LAYER, fx.layer);
    eq(R.CAT_ANIM_DEPTH, fx.depth);
  });

  const caPath = join(VANILLA_DIR, "catanis.swf"), ca2Path = join(VANILLA_DIR, "catanis2.swf");
  if (!existsSync(caPath) || !existsSync(ca2Path)) console.log(`  (skipped: vanilla catanis.swf / catanis2.swf not extracted at ${VANILLA_DIR})`);
  else test("T1: the fixture matches the installed game — CatTest (id, frames, labels, every labeled frame places at most one character and always at depth 1, named pawing on 422 frames and ani on 1, idleF/idleB slot layouts) and catanis2's _Append_CatTest", () => {
    const inspect = (path: string, want: string) => {
      const swf = readSwf(new Uint8Array(readFileSync(path))) as any;
      const sc = swf.tags.find((t: any) => t.name === "SymbolClass");
      const id = (sc.entries || sc.symbols).find((s: any) => s.name === want).id;
      const sp = swf.tags.find((t: any) => t.name === "DefineSprite" && t.id === id);
      const labels: string[] = sp.tags.filter((t: any) => t.name === "FrameLabel").map((t: any) => t.label);
      const frames: { labels: string[]; places: any[] }[] = [];
      let pending: string[] = [], places: any[] = [];
      for (const t of sp.tags) {
        if (t.name === "FrameLabel") pending.push(t.label);
        else if (t.place) places.push(t.place);
        else if (t.name === "ShowFrame") { if (pending.length) frames.push({ labels: pending, places }); pending = []; places = []; }
      }
      const slotsOf = (cid: number) => { const n = swf.tags.find((x: any) => x.name === "DefineSprite" && x.id === cid); const out: string[] = []; if (n) for (const u of n.tags) { if (u.name === "ShowFrame") break; if (u.place && u.place.name) out.push(`${u.place.name}@${u.place.depth}`); } return { frames: n ? n.frameCount : 0, slots: out }; };
      return { id, frames: sp.frameCount, labels, labeled: frames, slotsOf };
    };
    const ca = inspect(caPath, fx.catanis.export);
    eq(ca.id, fx.catanis.id); eq(ca.frames, fx.catanis.frames); eq(ca.labels.length, fx.catanis.labels);
    eq(ca.labels.slice(0, fx.catanis.firstLabels.length).join(","), fx.catanis.firstLabels.join(","));
    eq(ca.labeled.length, fx.catanis.labels);
    eq(Math.max(...ca.labeled.map((f) => f.places.length)), fx.catanis.maxPlacesPerLabeledFrame);
    eq([...new Set(ca.labeled.flatMap((f) => f.places.map((p: any) => p.depth)))].join(","), fx.catanis.depths.join(","));
    eq(ca.labeled.filter((f) => f.places.some((p: any) => p.name === fx.catanis.idleLayerName)).length, fx.catanis.pawingFrames);
    eq(ca.labeled.filter((f) => f.places.some((p: any) => p.name === fx.layer)).length, fx.catanis.aniFrames);
    eq(ca.labeled.filter((f) => !f.places.length).length, fx.catanis.emptyFrames);
    eq(ca.labeled[0]!.places[0].name, fx.catanis.idleLayerName); eq(ca.labeled[0]!.places[0].depth, fx.depth);
    const idleF = ca.slotsOf(ca.labeled[0]!.places[0].characterId), idleB = ca.slotsOf(ca.labeled[1]!.places[0].characterId);
    eq(idleF.frames, fx.catanis.idleF.frames); eq(idleF.slots.join(" "), fx.catanis.idleF.slots.join(" "));
    eq(idleB.frames, fx.catanis.idleB.frames); eq(idleB.slots.join(" "), fx.catanis.idleB.slots.join(" "));
    const ca2 = inspect(ca2Path, fx.catanis2.export);
    eq(ca2.id, fx.catanis2.id); eq(ca2.frames, fx.catanis2.frames); eq(ca2.labels.length, fx.catanis2.labels);
    for (const l of fx.catanis2.labelsAmong) assert(ca2.labels.includes(l), `${l} among the appended labels`);
  });

  test("newCatAnimation: a rig <name>Pose (parts \"game\": empty slot sprites the game fills with the cat's own parts), a donor CatAnim_<name> with <name>F at 0 and <name>B at 1 each placing a rig as the layer `ani` at depth 1 (the F frame <name>Pose, the B frame the back rig <name>PoseBack: art-cat-back-tests.ts), exports._Append_CatTest; the scene validates; pure and byte-stable", () => {
    need();
    const base = exampleScene("anim");
    const before = JSON.stringify(base);
    const r = R.newCatAnimation(base, "wave");
    eq(errors(r.findings), "");
    eq(JSON.stringify(base), before);
    eq(r.rig, "wavePose"); eq(r.donor, "CatAnim_wave");
    eq(r.scene.sprites.wavePose.rig, "cat");
    eq(r.scene.sprites.wavePose.parts, "game");
    for (const l of r.scene.sprites.wavePose.layers) { const slot = r.scene.sprites[l.keys[0].ref]; assert(!!slot && slot.frames === 1 && slot.layers.length === 0, `${l.name} slot is an empty sprite`); }
    const d = r.scene.sprites.CatAnim_wave;
    eq(d.frames, 2);
    eq(JSON.stringify(d.labels), JSON.stringify({ waveF: 0, waveB: 1 }));
    eq(d.layers.length, 1);
    eq(d.layers[0].name, fx.layer); eq(d.layers[0].depth, fx.depth);
    eq(d.layers[0].keys.map((k: any) => `${k.frame}:${k.ref}`).join(","), "0:wavePose,1:wavePoseBack");
    eq(r.scene.exports[fx.append], "CatAnim_wave");
    const v = validateScene(r.scene) as any;
    assert(v.ok, errors(v.findings));
    eq(JSON.stringify(R.newCatAnimation(base, "wave").scene), JSON.stringify(r.scene));
  });

  test("newCatAnimation extends an existing donor (next frames, same `ani` layer), reuses a rig with opts.rig, and refuses a bad name, a taken F/B label, a non-rig or non-empty opts.rig, or an _Append_CatTest export that is not a donor sprite", () => {
    need();
    const one = R.newCatAnimation(exampleScene("anim"), "wave").scene;
    const two = R.newCatAnimation(one, "pounce", { rig: "wavePose" });
    eq(errors(two.findings), "");
    const d = two.scene.sprites.CatAnim_wave;
    eq(d.frames, 4);
    eq(JSON.stringify(d.labels), JSON.stringify({ waveF: 0, waveB: 1, pounceF: 2, pounceB: 3 }));
    eq(d.layers.length, 1);
    eq(d.layers[0].keys.map((k: any) => `${k.frame}:${k.ref}`).join(","), "0:wavePose,1:wavePoseBack,2:wavePose,3:pouncePoseBack");
    assert(!two.scene.sprites.pouncePose, "no new front rig when opts.rig is given (the back rig is new: no opts.backRig)");
    eq(two.scene.exports[fx.append], "CatAnim_wave");
    assert((validateScene(two.scene) as any).ok, "validates");
    const three = R.newCatAnimation(two.scene, "sit");
    eq(errors(three.findings), "");
    eq(three.scene.sprites.sitPose.rig, "cat");
    eq(three.scene.sprites.CatAnim_wave.labels.sitB, 5);
    assert(R.newCatAnimation(one, "wave").findings.some((f: any) => f.severity === "error"), "taken label refused");
    assert(R.newCatAnimation(one, "9lives").findings.some((f: any) => f.severity === "error"), "bad name refused");
    assert(R.newCatAnimation(one, "a-b").findings.some((f: any) => f.severity === "error"), "bad name refused");
    assert(R.newCatAnimation(one, "x", { rig: "Starter" }).findings.some((f: any) => f.severity === "error"), "non-rig opts.rig refused");
    const withPlaceholders = R.addCatRig(one, "Drawn").scene;
    const ph = R.newCatAnimation(withPlaceholders, "x", { rig: "Drawn" });
    assert(ph.findings.some((f: any) => f.severity === "error" && /empty/.test(f.message)), `a rig whose slots hold placeholder art is refused: ${JSON.stringify(ph.findings)}`);
    assert(R.newCatAnimation(one, "x", { rig: "nope" }).findings.some((f: any) => f.severity === "error"), "unknown opts.rig refused");
    const shapeExport = { ...exampleScene("anim"), exports: { [fx.append]: "body" } };
    assert(R.newCatAnimation(shapeExport, "x").findings.some((f: any) => f.severity === "error"), "export at a shape refused");
    const rigExport = R.addCatRig(exampleScene("anim"), "Rig").scene;
    rigExport.exports[fx.append] = "Rig";
    assert(R.newCatAnimation(rigExport, "x").findings.some((f: any) => f.severity === "error"), "export at a rig refused");
  });

  test("validateScene on the _Append_CatTest donor: cat-anim-missing-facing (error), cat-anim-layer-not-rig (error), cat-anim-layer-name (error: the engine restarts the child `ani`), cat-anim-slot-not-empty (error: a visible non-empty slot crashes CatParts::prerender), cat-anim-depth (warning), cat-anim-donor (error) and cat-anim-untested (info, always: the game draws its own parts into the empty slots)", () => {
    need();
    const good = R.newCatAnimation(exampleScene("anim"), "wave").scene;
    const c0 = codes(good);
    assert(c0.includes("info:cat-anim-untested"), c0.join(","));
    assert(!c0.some((c) => /^(error|warning):cat-anim/.test(c)), c0.join(","));
    const note = (validateScene(good) as any).findings.find((f: any) => f.code === "cat-anim-untested");
    assert(note.severity === "info" && /draws the cat's own parts/.test(note.message) && /OBSERVED 2026-10-22/.test(note.message) && /animated pose/.test(note.message) && /render-cat-wave/.test(note.message) && !/once its empty-slot run lands/.test(note.message) && /CatTest and the cat animation clips/.test(note.message), note.message);
    const filled = R.assignSlot(good, "wavePose", "head", "body").scene;
    const cf = codes(filled);
    assert(cf.includes("error:cat-anim-slot-not-empty"), cf.join(","));
    const pawing = JSON.parse(JSON.stringify(good)); pawing.sprites.CatAnim_wave.layers[0].name = "pawing";
    assert(codes(pawing).includes("error:cat-anim-layer-name"), codes(pawing).join(","));
    const unnamed = JSON.parse(JSON.stringify(good)); delete unnamed.sprites.CatAnim_wave.layers[0].name;
    assert(codes(unnamed).includes("error:cat-anim-layer-name"), codes(unnamed).join(","));
    const noB = JSON.parse(JSON.stringify(good)); delete noB.sprites.CatAnim_wave.labels.waveB;
    assert(codes(noB).includes("error:cat-anim-missing-facing"), codes(noB).join(","));
    const noF = JSON.parse(JSON.stringify(good)); delete noF.sprites.CatAnim_wave.labels.waveF;
    assert(codes(noF).includes("error:cat-anim-missing-facing"), codes(noF).join(","));
    const shapeLayer = JSON.parse(JSON.stringify(good)); shapeLayer.sprites.CatAnim_wave.layers[0].keys[1].ref = "body";
    assert(codes(shapeLayer).includes("error:cat-anim-layer-not-rig"), codes(shapeLayer).join(","));
    const plainSprite = JSON.parse(JSON.stringify(good)); plainSprite.sprites.CatAnim_wave.layers[0].keys[0].ref = "Starter";
    assert(codes(plainSprite).includes("error:cat-anim-layer-not-rig"), codes(plainSprite).join(","));
    const deep = JSON.parse(JSON.stringify(good)); deep.sprites.CatAnim_wave.layers[0].depth = 3;
    const cd = codes(deep);
    assert(cd.includes("warning:cat-anim-depth") && !cd.some((c) => /^error:cat-anim/.test(c)), cd.join(","));
    const shapeExport = { ...exampleScene("anim"), exports: { [fx.append]: "body" } };
    assert(codes(shapeExport).includes("error:cat-anim-donor"), codes(shapeExport).join(","));
    const plain = exampleScene("anim");
    assert(!codes(plain).some((c) => /cat-anim/.test(c)), "no cat-anim findings without the export");
  });

  test("validateScene: cat-anim-layer-name is reported once per labeled frame per offending layer (no duplicate findings)", () => {
    need();
    const good = R.newCatAnimation(exampleScene("anim"), "wave").scene;
    const pawing = JSON.parse(JSON.stringify(good)); pawing.sprites.CatAnim_wave.layers[0].name = "pawing";
    const hits = (validateScene(pawing) as any).findings.filter((f: any) => f.code === "cat-anim-layer-name");
    const labels = Object.keys(pawing.sprites.CatAnim_wave.labels);
    eq(hits.length, labels.length, `one per labeled frame (${labels.join(",")}): ${JSON.stringify(hits)}`);
    const keys = hits.map((f: any) => `${f.path}|${f.message}`);
    eq(new Set(keys).size, keys.length, `no duplicates: ${keys.join(" ; ")}`);
  });

  test("validateScene refuses an export literally named CatTest (cat-clip-override, error): the engine resolves clips through a global last-loaded-first registry, so it would replace the cat clip for every cat", () => {
    const s = exampleScene("anim");
    s.exports = { CatTest: "Starter" };
    const f = (validateScene(s) as any).findings.find((x: any) => x.code === "cat-clip-override");
    assert(f && f.severity === "error" && /every cat/.test(f.message), JSON.stringify(f));
    assert(!codes(exampleScene("anim")).includes("error:cat-clip-override"), "other exports are fine");
  });

  let api: Record<string, any> = {}, apiErr = "";
  try { api = await import("../src/core/api.ts"); } catch (e) { apiErr = e instanceof Error ? e.message : String(e); }
  test("api.newCatAnimation(scene, name, opts) returns { ok, scene, findings } over the validated scene; api.newArtScene(mod, name, { template: \"cat-animation\", animation }) writes a scene with the animation", () => {
    if (apiErr) throw new Error(apiErr);
    assert(typeof api.newCatAnimation === "function", "api.newCatAnimation");
    const r = api.newCatAnimation(exampleScene("anim"), "wave");
    assert(r.ok, JSON.stringify(r.findings));
    eq(r.scene.exports[fx.append], "CatAnim_wave");
    assert(!api.newCatAnimation(exampleScene("anim"), "9").ok, "bad name refused through the api");
    const tmpMod = "__art_catanim_tmp";
    const tmpDir = join(MODS_DIR, tmpMod);
    rmSync(tmpDir, { recursive: true, force: true });
    try {
      const w = api.newArtScene(tmpMod, "catwave", { template: "cat-animation", animation: "wave" });
      assert(w.ok, w.error || JSON.stringify(w.findings));
      const back = api.readArtScene(tmpMod, "art/catwave.scene.json");
      assert(back.ok, JSON.stringify(back.findings));
      eq(back.scene.exports[fx.append], "CatAnim_wave");
      eq(back.scene.sprites.wavePose.rig, "cat");
      assert(back.findings.some((f: any) => f.code === "cat-anim-untested"), "read reports cat-anim-untested");
      const dflt = api.newArtScene(tmpMod, "pounce", { template: "cat-animation" });
      assert(dflt.ok && dflt.scene.sprites.CatAnim_pounce, "animation defaults to the scene name");
      const bad = api.newArtScene(tmpMod, "my-cat", { template: "cat-animation" });
      assert(!bad.ok, "a scene name that is not an identifier needs `animation`");
    } finally { rmSync(tmpDir, { recursive: true, force: true }); }
  });

  let tools: Record<string, any> = {}, toolsErr = "";
  try { tools = await import("../src/mcp/tools.ts"); } catch (e) { toolsErr = e instanceof Error ? e.message : String(e); }
  let dry: any = null, dryErr = "";
  if (!toolsErr) { try { need(); dry = await tools.callTool("write_art_scene", { mod: "dev-sandbox", path: "art/x.scene.json", scene: R.newCatAnimation(exampleScene("anim"), "wave").scene, dryRun: true }); } catch (e) { dryErr = e instanceof Error ? e.message : String(e); } }
  test("MCP: new_art_scene accepts template: \"cat-animation\" (+ animation); write_art_scene dryRun on a cat animation reports cat-anim-untested", () => {
    if (toolsErr) throw new Error(toolsErr);
    need();
    const schema = tools.TOOL_INPUT.new_art_scene;
    assert(schema.safeParse({ mod: "m", name: "n", template: "cat-animation", animation: "wave" }).success, "template + animation accepted");
    assert(!schema.safeParse({ mod: "m", name: "n", template: "dog" }).success, "unknown template refused");
    assert(!dryErr, dryErr);
    assert(dry && dry.ok && dry.findings.some((f: any) => f.code === "cat-anim-untested"), JSON.stringify(dry).slice(0, 300));
  });
}
