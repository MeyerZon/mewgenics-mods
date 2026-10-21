// Cat rig (art build-out H): a cat-shaped character drawn by our own SWF with the vanilla slot layout (the named
// instances tail / leg2 / arm2 / body / leg1 / arm1 / head the game's cat animations use). Pinned against the vanilla
// files (T1, names and depths only), authored by the pure cat-rig.ts, checked by the validator, drawn in the game (T2).

import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MODS_DIR } from "../src/core/repo.ts";
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

  await runCatAnimationTests(test, assert, eq, need, R);
}

// ---- cat animations: labeled facing frames appended to the vanilla CatTest clip ---------------------------------------

interface AnimFixture {
  append: string;
  layer: string;
  depth: number;
  facing: string[];
  catanis: { export: string; id: number; frames: number; labels: number; firstLabels: string[]; depths: number[]; maxPlacesPerLabeledFrame: number; pawingFrames: number; emptyFrames: number; idleF: { frames: number; slots: string[] }; idleB: { frames: number; slots: string[] } };
  catanis2: { export: string; id: number; frames: number; labels: number; labelsAmong: string[] };
}

async function runCatAnimationTests(test: TestFn, assert: AssertFn, eq: EqFn, need: () => void, R: Record<string, any>): Promise<void> {
  console.log("\n# Art: cat animations (labeled F/B frames appended to CatTest, cat-rig.ts newCatAnimation, validator, api, MCP)");
  const fx = JSON.parse(readFileSync(join(HERE, "fixtures", "art", "cat-anim-append.json"), "utf8")) as AnimFixture;
  const errors = (fs: any[]) => fs.filter((f) => f.severity === "error").map((f) => f.code + ": " + f.message).join("; ");
  const codes = (scene: any) => (validateScene(scene) as any).findings.map((f: any) => `${f.severity}:${f.code}`) as string[];

  test("CAT_ANIM_EXPORT / CAT_ANIM_LAYER / CAT_ANIM_DEPTH are the vanilla shape (_Append_CatTest, pawing, depth 1; fixture cat-anim-append.json)", () => {
    need();
    eq(R.CAT_ANIM_EXPORT, fx.append);
    eq(R.CAT_ANIM_LAYER, fx.layer);
    eq(R.CAT_ANIM_DEPTH, fx.depth);
  });

  const caPath = join(VANILLA_DIR, "catanis.swf"), ca2Path = join(VANILLA_DIR, "catanis2.swf");
  if (!existsSync(caPath) || !existsSync(ca2Path)) console.log(`  (skipped: vanilla catanis.swf / catanis2.swf not extracted at ${VANILLA_DIR})`);
  else test("T1: the fixture matches the installed game — CatTest (id, frames, labels, every labeled frame places at most one character and always at depth 1, pawing on 422 frames, idleF/idleB slot layouts) and catanis2's _Append_CatTest", () => {
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
    eq(ca.labeled.filter((f) => f.places.some((p: any) => p.name === fx.layer)).length, fx.catanis.pawingFrames);
    eq(ca.labeled.filter((f) => !f.places.length).length, fx.catanis.emptyFrames);
    eq(ca.labeled[0]!.places[0].name, fx.layer); eq(ca.labeled[0]!.places[0].depth, fx.depth);
    const idleF = ca.slotsOf(ca.labeled[0]!.places[0].characterId), idleB = ca.slotsOf(ca.labeled[1]!.places[0].characterId);
    eq(idleF.frames, fx.catanis.idleF.frames); eq(idleF.slots.join(" "), fx.catanis.idleF.slots.join(" "));
    eq(idleB.frames, fx.catanis.idleB.frames); eq(idleB.slots.join(" "), fx.catanis.idleB.slots.join(" "));
    const ca2 = inspect(ca2Path, fx.catanis2.export);
    eq(ca2.id, fx.catanis2.id); eq(ca2.frames, fx.catanis2.frames); eq(ca2.labels.length, fx.catanis2.labels);
    for (const l of fx.catanis2.labelsAmong) assert(ca2.labels.includes(l), `${l} among the appended labels`);
  });

  test("newCatAnimation: a rig <name>Pose, a donor CatAnim_<name> with <name>F at 0 and <name>B at 1 each placing the rig as layer pawing at depth 1, exports._Append_CatTest; the scene validates; pure and byte-stable", () => {
    need();
    const base = exampleScene("anim");
    const before = JSON.stringify(base);
    const r = R.newCatAnimation(base, "wave");
    eq(errors(r.findings), "");
    eq(JSON.stringify(base), before);
    eq(r.rig, "wavePose"); eq(r.donor, "CatAnim_wave");
    eq(r.scene.sprites.wavePose.rig, "cat");
    const d = r.scene.sprites.CatAnim_wave;
    eq(d.frames, 2);
    eq(JSON.stringify(d.labels), JSON.stringify({ waveF: 0, waveB: 1 }));
    eq(d.layers.length, 1);
    eq(d.layers[0].name, fx.layer); eq(d.layers[0].depth, fx.depth);
    eq(d.layers[0].keys.map((k: any) => `${k.frame}:${k.ref}`).join(","), "0:wavePose,1:wavePose");
    eq(r.scene.exports[fx.append], "CatAnim_wave");
    const v = validateScene(r.scene) as any;
    assert(v.ok, errors(v.findings));
    eq(JSON.stringify(R.newCatAnimation(base, "wave").scene), JSON.stringify(r.scene));
  });

  test("newCatAnimation extends an existing donor (next frames, same pawing layer), reuses a rig with opts.rig, and refuses a bad name, a taken F/B label, a non-rig opts.rig, or an _Append_CatTest export that is not a donor sprite", () => {
    need();
    const one = R.newCatAnimation(exampleScene("anim"), "wave").scene;
    const two = R.newCatAnimation(one, "pounce", { rig: "wavePose" });
    eq(errors(two.findings), "");
    const d = two.scene.sprites.CatAnim_wave;
    eq(d.frames, 4);
    eq(JSON.stringify(d.labels), JSON.stringify({ waveF: 0, waveB: 1, pounceF: 2, pounceB: 3 }));
    eq(d.layers.length, 1);
    eq(d.layers[0].keys.map((k: any) => `${k.frame}:${k.ref}`).join(","), "0:wavePose,1:wavePose,2:wavePose,3:wavePose");
    assert(!two.scene.sprites.pouncePose, "no new rig when opts.rig is given");
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
    assert(R.newCatAnimation(one, "x", { rig: "nope" }).findings.some((f: any) => f.severity === "error"), "unknown opts.rig refused");
    const shapeExport = { ...exampleScene("anim"), exports: { [fx.append]: "body" } };
    assert(R.newCatAnimation(shapeExport, "x").findings.some((f: any) => f.severity === "error"), "export at a shape refused");
    const rigExport = R.addCatRig(exampleScene("anim"), "Rig").scene;
    rigExport.exports[fx.append] = "Rig";
    assert(R.newCatAnimation(rigExport, "x").findings.some((f: any) => f.severity === "error"), "export at a rig refused");
  });

  test("validateScene on the _Append_CatTest donor: cat-anim-missing-facing (error), cat-anim-layer-not-rig (error), cat-anim-depth (warning), cat-anim-donor (error) and cat-anim-untested (info, always)", () => {
    need();
    const good = R.newCatAnimation(exampleScene("anim"), "wave").scene;
    const c0 = codes(good);
    assert(c0.includes("info:cat-anim-untested"), c0.join(","));
    assert(!c0.some((c) => /^(error|warning):cat-anim/.test(c)), c0.join(","));
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
  test("MCP: new_art_scene accepts template: \"cat-animation\" (+ animation); write_art_scene dryRun on a cat animation reports cat-anim-untested", async () => {
    if (toolsErr) throw new Error(toolsErr);
    const schema = tools.TOOL_INPUT.new_art_scene;
    assert(schema.safeParse({ mod: "m", name: "n", template: "cat-animation", animation: "wave" }).success, "template + animation accepted");
    assert(!schema.safeParse({ mod: "m", name: "n", template: "dog" }).success, "unknown template refused");
    const scene = R.newCatAnimation(exampleScene("anim"), "wave").scene;
    const r = (await tools.callTool("write_art_scene", { mod: "dev-sandbox", path: "art/x.scene.json", scene, dryRun: true })) as any;
    assert(r.ok && r.findings.some((f: any) => f.code === "cat-anim-untested"), JSON.stringify(r).slice(0, 300));
  });
}
