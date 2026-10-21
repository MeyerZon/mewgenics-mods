// Cat rig (art build-out H): a cat-shaped character drawn by our own SWF with the vanilla slot layout (the named
// instances tail / leg2 / arm2 / body / leg1 / arm1 / head the game's cat animations use). Pinned against the vanilla
// files (T1, names and depths only), authored by the pure cat-rig.ts, checked by the validator, drawn in the game (T2).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exampleScene, validateScene } from "../src/core/art/scene.ts";
import { readSwf } from "../src/core/art/swf-reader.ts";
import * as pc from "../src/core/art/probe-compare.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const VANILLA_DIR = process.env.MEWGENICS_VANILLA_SWF_DIR || resolve(HERE, "../../.extracted/swfs");

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

  // ---- experiment A0 (2026-10-21): an _Append_CatTest frame placing our rig — does the game fill its slots by name? ----
  const MODS = resolve(HERE, "../../mods");
  test("cat append probe: probe.scene.json exports _Append_CatTest -> CatAppendRoot (labels probeIdleF 0 / probeIdleB 1, a `pawing` layer at depth 1 placing CatProbe) and CatProbe carries the checker marker at depth 15", () => {
    const scene = JSON.parse(readFileSync(join(MODS, "_artprobe", "art", "probe.scene.json"), "utf8")) as any;
    eq(scene.exports["_Append_CatTest"], "CatAppendRoot");
    const root = scene.sprites.CatAppendRoot;
    assert(!!root, "sprite CatAppendRoot");
    eq(root.frames, 2);
    eq(root.labels.probeIdleF, 0); eq(root.labels.probeIdleB, 1);
    const pawing = root.layers.find((l: any) => l.name === "pawing");
    assert(!!pawing && pawing.depth === 1, "pawing at depth 1");
    assert(pawing.keys.every((k: any) => k.ref === "CatProbe"), "pawing places CatProbe");
    const marker = scene.sprites.CatProbe.layers.find((l: any) => l.depth === 15);
    assert(!!marker && marker.keys[0].ref === "checker", "CatProbe: checker marker at depth 15");
    assert(!fixture.catanisMain.slots.some((s) => s.depth === 15), "15 is not a slot depth");
    const v = validateScene(scene) as any;
    assert(v.ok, JSON.stringify(v.findings.filter((f: any) => f.severity === "error")));
    const gon = readFileSync(join(MODS, "_artprobe", "data", "characters", "enemies.gon.append"), "utf8");
    assert(/ArtProbeCatReal\s*\{[\s\S]*variant_of TomTom[\s\S]*alt_animations \[\[idle probeIdle\]\]/.test(gon), "enemies.gon.append: ArtProbeCatReal, a TomTom variant with alt_animations [[idle probeIdle]]");
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

  test("OBSERVED 2026-10-21 fixture (artprobe-cat-append-summary.json): the appended CatTest frame — the run passed, the marker was found in every rig shot, and the outcome is pinned", () => {
    const p = join(HERE, "fixtures", "ingame", "artprobe-cat-append-summary.json");
    assert(existsSync(p), "written by npm run test:artprobe -- --cat-append");
    const j = JSON.parse(readFileSync(p, "utf8")) as { verdict: string; outcome: string; vanilla: { near: { other: number } }; rig: { label: string; marker: { found: boolean } | null; slots: Record<string, number>; near: { other: number } }[] };
    eq(j.verdict, "pass");
    eq(j.rig.length, 3);
    assert(j.rig.every((r) => r.marker && r.marker.found), "marker found in every rig shot");
    assert(["filled-by-name", "not-filled", "no-marker"].includes(j.outcome), `outcome ${j.outcome}`);
  });
}
