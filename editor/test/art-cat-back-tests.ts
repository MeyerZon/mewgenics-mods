// The back facing and the four-way quartet of a cat animation (2026-10-22). A vanilla `<anim>B` frame places its own
// pose sprite — the back layout (head_back behind, tail in front; catanis.swf idleB) — not the `<anim>F` pose; a
// four-way character (graphics.four_way_animations true) plays `<anim>LF/RF/LB/RB` instead of F/B. cat-rig.ts authors
// both (addCatRig { facing: "back" }, newCatAnimation's back rig and { fourWay: true }), the validator checks them, and
// mods/_artprobe render-cat-back.mewtest shows a back-facing cat in the game (scripts/art-probe.ts --cat-back).
// Fixture: test/fixtures/art/cat-back-facing.json (T1 re-checked against the installed game when present).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODS_DIR, vanillaSwfDir, EXTRACTED_DATA } from "../src/core/repo.ts";
import { exampleScene, validateScene } from "../src/core/art/scene.ts";
import { readSwf } from "../src/core/art/swf-reader.ts";
import { parseScript } from "../src/core/ingame/script.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const VANILLA_DIR = vanillaSwfDir();

interface BackFixture {
  back: { label: string; slots: string[]; head: string; faceSlotPrefix: string; face: string };
  catanis: { export: string; bLabels: number; headBack: number; head: number; bhead: number };
  catanis2: { export: string; bLabels: number; headBack: number; head: number; bhead: number };
  fourWay: { suffixes: string[]; clips: Record<string, string>; characters: Record<string, string>; catTestFourWayLabels: number };
}

/** The labeled frames of an exported sprite and a reader for a placed pose sprite's direct named children. */
function clipOf(path: string, exportName: string) {
  const swf = readSwf(new Uint8Array(readFileSync(path))) as any;
  const sc = swf.tags.find((t: any) => t.name === "SymbolClass");
  const id = (sc.entries || sc.symbols).find((s: any) => s.name === exportName).id;
  const byId = new Map<number, any>();
  for (const t of swf.tags) if (t.id !== undefined && t.name === "DefineSprite") byId.set(t.id, t);
  const sp = byId.get(id);
  const frames: { labels: string[]; places: any[] }[] = [];
  let pending: string[] = [], places: any[] = [];
  for (const t of sp.tags) {
    if (t.name === "FrameLabel") pending.push(t.label);
    else if (t.place) places.push(t.place);
    else if (t.name === "ShowFrame") { if (pending.length) frames.push({ labels: pending, places }); pending = []; places = []; }
  }
  /** named children over every frame of the sprite (direct children only) */
  const namesOf = (cid: number) => { const n = byId.get(cid); const out = new Set<string>(); if (n) for (const u of n.tags) if (u.place && u.place.name) out.add(u.place.name); return out; };
  /** frame 0's named children as name@depth, back to front */
  const firstOf = (cid: number) => { const n = byId.get(cid); const m = new Map<number, any>(); if (n) for (const u of n.tags) { if (u.name === "ShowFrame") break; if (u.place && u.place.name) m.set(u.place.depth, u.place); } return [...m].sort((a, b) => a[0] - b[0]).map((x) => x[1]); };
  return { frames, labels: frames.flatMap((f) => f.labels), namesOf, firstOf };
}

export async function runArtCatBackTests(test: TestFn, assert: AssertFn, eq: EqFn): Promise<void> {
  console.log("\n# Art: cat back facing and the four-way quartet (cat-rig.ts, validator, _artprobe render-cat-back)");
  const fx = JSON.parse(readFileSync(join(HERE, "fixtures", "art", "cat-back-facing.json"), "utf8")) as BackFixture;
  let R: Record<string, any> = {}, P: Record<string, any> = {};
  let err = "";
  try { R = await import("../src/core/art/cat-rig.ts"); P = await import("../src/core/art/probe-outcomes.ts"); } catch (e) { err = e instanceof Error ? e.message : String(e); }
  const need = (...names: string[]) => { if (err) throw new Error(err); for (const n of names) if (R[n] === undefined && P[n] === undefined) throw new Error(`cat-rig.ts / probe-outcomes.ts export no ${n}`); };
  const errors = (fs: any[]) => fs.filter((f) => f.severity === "error").map((f) => f.code + ": " + f.message).join("; ");
  const codes = (scene: any) => (validateScene(scene) as any).findings.map((f: any) => `${f.severity}:${f.code}`) as string[];
  const slotStr = (slots: ReadonlyArray<{ name: string; depth: number }>) => slots.map((s) => `${s.name}@${s.depth}`);

  // ---- the vanilla facts ----
  test("CAT_BACK_SLOTS is vanilla idleB's layout (head_back@1 arm2@3 leg2@5 body@7 arm1@9 leg1@11 tail@13: the head behind, the tail in front); CAT_BACK_HEAD is head_back; CAT_ANIM_FOUR_WAY is LF/RF/LB/RB", () => {
    need("CAT_BACK_SLOTS", "CAT_BACK_HEAD", "CAT_ANIM_FOUR_WAY");
    eq(slotStr(R.CAT_BACK_SLOTS).join(" "), fx.back.slots.join(" "));
    eq(R.CAT_BACK_HEAD, fx.back.head);
    eq(`${fx.back.faceSlotPrefix}${fx.back.face}`, fx.back.head);
    eq(R.CAT_ANIM_FOUR_WAY.join(","), fx.fourWay.suffixes.join(","));
    eq(JSON.stringify([...R.CAT_BACK_SLOTS].map((s: any) => s.name).sort()), JSON.stringify([...R.CAT_SLOTS].map((s: any) => (s.name === "head" ? "head_back" : s.name)).sort()), "the same seven parts, head as head_back");
  });

  const caPath = join(VANILLA_DIR, "catanis.swf"), ca2Path = join(VANILLA_DIR, "catanis2.swf");
  if (!existsSync(caPath) || !existsSync(ca2Path)) console.log(`  (skipped: vanilla catanis.swf / catanis2.swf not extracted at ${VANILLA_DIR})`);
  else test("T1: vanilla back frames — idleB places its own pose (not idleF's) with the fixture's layout; across CatTest and catanis2's _Append_CatTest the B frames' poses carry head_back (356/362, 88/91), a plain head rarely, `bhead` never; no CatTest label is four-way", () => {
    for (const [path, want] of [[caPath, fx.catanis], [ca2Path, fx.catanis2]] as const) {
      const c = clipOf(path, want.export);
      let bLabels = 0, headBack = 0, head = 0, bhead = 0;
      for (const f of c.frames) for (const l of f.labels) {
        if (!l.endsWith("B") || !f.places[0] || f.places[0].characterId === undefined) continue;
        const names = c.namesOf(f.places[0].characterId);
        if (!names.has("body")) continue;
        bLabels++;
        if (names.has("head_back")) headBack++;
        if (names.has("head")) head++;
        if (names.has("bhead")) bhead++;
      }
      eq(`${bLabels} ${headBack} ${head} ${bhead}`, `${want.bLabels} ${want.headBack} ${want.head} ${want.bhead}`, want.export);
      if (want === fx.catanis) {
        const fi = c.frames.find((f) => f.labels.includes("idleF"))!, bi = c.frames.find((f) => f.labels.includes(fx.back.label))!;
        assert(fi.places[0].characterId !== bi.places[0].characterId, "idleB places a different pose sprite than idleF");
        eq(c.firstOf(bi.places[0].characterId).map((p: any) => `${p.name}@${p.depth}`).join(" "), fx.back.slots.join(" "));
        eq(c.labels.filter((l) => /(LF|RF|LB|RB)$/.test(l)).length, fx.fourWay.catTestFourWayLabels);
      }
    }
  });

  const catgen = join(EXTRACTED_DATA, "catgen.gon");
  if (!existsSync(catgen)) console.log(`  (skipped: catgen.gon not extracted at ${EXTRACTED_DATA})`);
  else test("T1: head_back is the head slot with the catgen.gon face `back` (faces { back { back true } }): CatParts::load_faces 0x73a990 names a slot \"head_\" + <face> for every face", () => {
    const text = readFileSync(catgen, "utf8");
    assert(/faces\s*\{\s*back\s*\{\s*back true\s*\}/.test(text), "catgen.gon faces.back { back true } is the first face");
  });

  const fwClips = Object.entries(fx.fourWay.clips).map(([n, f]) => [n, join(VANILLA_DIR, f)] as const);
  if (fwClips.some(([, p]) => !existsSync(p)) || !existsSync(join(EXTRACTED_DATA, "characters", "enemies.gon"))) console.log(`  (skipped: the four-way enemy clips / characters not extracted)`);
  else test("T1: four-way vanilla — the characters with graphics.four_way_animations true (MegaFetus, Thump, TracyFetus, ManglersMonster) have clips whose labels are complete <anim>LF/RF/LB/RB quartets and nothing else", () => {
    for (const [name, file] of Object.entries(fx.fourWay.characters)) {
      const t = readFileSync(join(EXTRACTED_DATA, file), "utf8");
      const at = t.search(new RegExp(`\\n${name}\\s*\\{`));
      assert(at >= 0, `${name} in ${file}`);
      assert(/four_way_animations true/.test(t.slice(at + 1, at + 6000).split(/\n\S/)[0]!), `${name}: four_way_animations true`);
    }
    for (const [clip, path] of fwClips) {
      const labels = clipOf(path, clip).labels;
      assert(labels.length > 0 && labels.every((l) => /(LF|RF|LB|RB)$/.test(l)), `${clip}: every label four-way`);
      const bases = new Set(labels.map((l) => l.slice(0, -2)));
      for (const b of bases) for (const s of fx.fourWay.suffixes) assert(labels.includes(b + s), `${clip}: ${b}${s}`);
    }
  });

  // ---- authoring: the back rig ----
  test("addCatRig { facing: \"back\" }: a rig with facing \"back\" and the back layout (head_back@1 … tail@13); parts \"game\" keeps every slot an empty sprite; assignSlot takes head_back on it (and refuses head); the scene validates with no rig warning", () => {
    need("CAT_BACK_SLOTS");
    const r = R.addCatRig(exampleScene("b"), "Back", { facing: "back", parts: "game" });
    eq(errors(r.findings), "");
    const sp = r.scene.sprites.Back;
    eq(sp.rig, "cat"); eq(sp.facing, "back"); eq(sp.parts, "game");
    eq(sp.layers.map((l: any) => `${l.name}@${l.depth}`).join(" "), fx.back.slots.join(" "));
    for (const l of sp.layers) assert(R.isEmptySprite(r.scene, l.keys[0].ref), `${l.name} empty`);
    const c = codes(r.scene);
    assert(!c.some((x) => /^(error|warning):rig-/.test(x)) && !c.includes("info:rig-depth-order"), c.join(","));
    const drawn = R.addCatRig(exampleScene("b"), "BackDrawn", { facing: "back" });
    eq(errors(drawn.findings), "");
    assert(!!drawn.scene.shapes.BackDrawn_head_back, "a drawn back rig has a head_back placeholder");
    const a = R.assignSlot(drawn.scene, "BackDrawn", "head_back", "body");
    eq(errors(a.findings), "");
    assert(R.assignSlot(drawn.scene, "BackDrawn", "head", "body").findings.some((f: any) => f.severity === "error"), "head is not a slot of a back rig");
    eq(JSON.stringify(R.catSlotsFor(sp)), JSON.stringify(R.CAT_BACK_SLOTS));
    eq(JSON.stringify(R.catSlotsFor({ rig: "cat" })), JSON.stringify(R.CAT_SLOTS));
  });

  test("validator on a back rig: rig-back-head (warning) for a `head` slot where head_back belongs (the game would draw the face on the back of the cat), rig-slot-missing names head_back, rig-depth-order compares with the back stacking; sprite-facing (error) for a facing other than \"back\" or on a non-rig sprite", () => {
    need("CAT_BACK_SLOTS");
    const good = R.addCatRig(exampleScene("b"), "Back", { facing: "back", parts: "game" }).scene;
    const headed = JSON.parse(JSON.stringify(good)); headed.sprites.Back.layers.find((l: any) => l.name === "head_back").name = "head";
    const ch = codes(headed);
    assert(ch.includes("warning:rig-back-head"), ch.join(","));
    const f = (validateScene(headed) as any).findings.find((x: any) => x.code === "rig-slot-missing");
    assert(f && /head_back/.test(f.message), JSON.stringify(f));
    const swapped = JSON.parse(JSON.stringify(good)); const L = swapped.sprites.Back.layers; L.find((l: any) => l.name === "tail").depth = 2; L.find((l: any) => l.name === "head_back").depth = 13;
    assert(codes(swapped).includes("info:rig-depth-order"), codes(swapped).join(","));
    const bad = JSON.parse(JSON.stringify(good)); bad.sprites.Back.facing = "side";
    assert(codes(bad).includes("error:sprite-facing"), codes(bad).join(","));
    const plain = exampleScene("b") as any; plain.sprites.Starter.facing = "back";
    assert(codes(plain).includes("error:sprite-facing"), codes(plain).join(","));
    // a front rig keeps the front checks: head_back is not expected there
    const front = R.addCatRig(exampleScene("b"), "Front", { parts: "game" }).scene;
    assert(!codes(front).some((x) => /rig-back-head|rig-slot-missing/.test(x)), codes(front).join(","));
  });

  // ---- authoring: newCatAnimation's two rigs ----
  test("newCatAnimation: <name>F places the front rig <name>Pose, <name>B the back rig <name>PoseBack (facing back, parts game, empty slots); the result names both; the scene validates with no cat-anim / rig warning", () => {
    need("CAT_BACK_SLOTS");
    const r = R.newCatAnimation(exampleScene("anim"), "wave");
    eq(errors(r.findings), "");
    eq(r.rig, "wavePose"); eq(r.backRig, "wavePoseBack");
    const back = r.scene.sprites.wavePoseBack;
    eq(back.rig, "cat"); eq(back.parts, "game"); eq(back.facing, "back");
    eq(back.layers.map((l: any) => `${l.name}@${l.depth}`).join(" "), fx.back.slots.join(" "));
    eq(r.scene.sprites.wavePose.facing, undefined);
    const d = r.scene.sprites.CatAnim_wave;
    eq(d.layers[0].keys.map((k: any) => `${k.frame}:${k.ref}`).join(","), "0:wavePose,1:wavePoseBack");
    const c = codes(r.scene);
    assert(!c.some((x) => /^(error|warning):(cat-anim|rig)/.test(x)), c.join(","));
    // opts.rig / opts.backRig reuse existing rigs; a back rig as opts.rig (or a front one as opts.backRig) is refused
    const two = R.newCatAnimation(r.scene, "pounce", { rig: "wavePose", backRig: "wavePoseBack" });
    eq(errors(two.findings), "");
    assert(!two.scene.sprites.pouncePose && !two.scene.sprites.pouncePoseBack, "no new rigs");
    eq(two.scene.sprites.CatAnim_wave.layers[0].keys.map((k: any) => `${k.frame}:${k.ref}`).join(","), "0:wavePose,1:wavePoseBack,2:wavePose,3:wavePoseBack");
    assert(R.newCatAnimation(r.scene, "x", { rig: "wavePoseBack" }).findings.some((f: any) => f.severity === "error"), "a back rig as the front rig is refused");
    assert(R.newCatAnimation(r.scene, "x", { backRig: "wavePose" }).findings.some((f: any) => f.severity === "error"), "a front rig as the back rig is refused");
    const onlyFront = R.newCatAnimation(r.scene, "sit", { rig: "wavePose" });
    eq(errors(onlyFront.findings), "");
    eq(onlyFront.backRig, "sitPoseBack", "opts.rig alone still gets a new back rig");
  });

  test("newCatAnimation { fourWay: true }: labels <name>LF / RF / LB / RB (frames 0..3); the F pair places the front rig, the B pair the back rig; the L frames place it mirrored (sx -1: a four-way character is never flipped by the engine), the R frames as authored; the scene validates and reports cat-anim-four-way (info: the character needs four_way_animations true, and vanilla CatTest has no four-way label)", () => {
    need("CAT_ANIM_FOUR_WAY");
    const r = R.newCatAnimation(exampleScene("anim"), "creep", { fourWay: true });
    eq(errors(r.findings), "");
    const d = r.scene.sprites.CatAnim_creep;
    eq(JSON.stringify(d.labels), JSON.stringify({ creepLF: 0, creepRF: 1, creepLB: 2, creepRB: 3 }));
    eq(d.frames, 4);
    eq(d.layers[0].keys.map((k: any) => `${k.frame}:${k.ref}:${k.sx ?? 1}`).join(","), "0:creepPose:-1,1:creepPose:1,2:creepPoseBack:-1,3:creepPoseBack:1");
    const v = validateScene(r.scene) as any;
    assert(v.ok, errors(v.findings));
    const c = codes(r.scene);
    assert(!c.some((x) => /^(error|warning):cat-anim/.test(x)), c.join(","));
    const note = v.findings.find((f: any) => f.code === "cat-anim-four-way");
    assert(note && note.severity === "info" && /four_way_animations true/.test(note.message) && /creep/.test(note.message) && /CatTest/.test(note.message), JSON.stringify(note));
    assert(!codes(R.newCatAnimation(exampleScene("anim"), "wave").scene).includes("info:cat-anim-four-way"), "no four-way note on a two-way animation");
    // a taken quartet label is refused; a two-way animation whose name ends in L/R is not mistaken for four-way
    assert(R.newCatAnimation(r.scene, "creep", { fourWay: true }).findings.some((f: any) => f.severity === "error"), "taken label refused");
    const lone = R.newCatAnimation(exampleScene("anim"), "fooL").scene;
    assert(!codes(lone).some((x) => /four-way/.test(x)), codes(lone).join(","));
  });

  test("validateScene on the donor: cat-anim-back-facing (warning) when a B / LB / RB frame places a front rig or an F / LF / RF frame a back rig; cat-anim-four-way-incomplete (error) for a quartet with a member missing — reported once, not also as a missing F/B partner", () => {
    need("CAT_ANIM_FOUR_WAY");
    const good = R.newCatAnimation(exampleScene("anim"), "wave").scene;
    const bFront = JSON.parse(JSON.stringify(good)); bFront.sprites.CatAnim_wave.layers[0].keys[1].ref = "wavePose";
    const cb = codes(bFront);
    assert(cb.includes("warning:cat-anim-back-facing") && !cb.some((x) => /^error:cat-anim/.test(x)), cb.join(","));
    const fBack = JSON.parse(JSON.stringify(good)); fBack.sprites.CatAnim_wave.layers[0].keys[0].ref = "wavePoseBack";
    assert(codes(fBack).includes("warning:cat-anim-back-facing"), codes(fBack).join(","));
    const msg = (validateScene(bFront) as any).findings.find((f: any) => f.code === "cat-anim-back-facing").message;
    assert(/waveB/.test(msg) && /head_back/.test(msg), msg);
    const quad = R.newCatAnimation(exampleScene("anim"), "creep", { fourWay: true }).scene;
    const q3 = JSON.parse(JSON.stringify(quad)); delete q3.sprites.CatAnim_creep.labels.creepRB;
    const cq = (validateScene(q3) as any).findings.filter((f: any) => /^cat-anim-(four-way-incomplete|missing-facing)$/.test(f.code));
    eq(cq.map((f: any) => `${f.severity}:${f.code}`).join(","), "error:cat-anim-four-way-incomplete");
    assert(/creepRB/.test(cq[0].message), cq[0].message);
    const qb = JSON.parse(JSON.stringify(quad)); qb.sprites.CatAnim_creep.layers[0].keys[3].ref = "creepPose";
    assert(codes(qb).includes("warning:cat-anim-back-facing"), codes(qb).join(","));
  });

  let api: any = null, tools: any = null, apiErr = "";
  try { api = await import("../src/core/api.ts"); tools = await import("../src/mcp/tools.ts"); } catch (e) { apiErr = e instanceof Error ? e.message : String(e); }
  test("api.newCatAnimation { fourWay: true } and the MCP new_art_scene schema accept fourWay", () => {
    if (apiErr) throw new Error(apiErr);
    const r = api.newCatAnimation(exampleScene("anim"), "creep", { fourWay: true } as any);
    assert(r.ok && !!r.scene.sprites.CatAnim_creep?.labels?.creepRB, JSON.stringify(r.findings));
    assert((tools.TOOL_INPUT as any).new_art_scene.safeParse({ mod: "m", name: "n", template: "cat-animation", animation: "creep", fourWay: true }).success, "fourWay accepted");
  });

  // ---- the in-game probe: a cat facing away ----
  // 2026-10-22 (facing): those lock runs had the keys under `graphics`; Character::init reads lock_orientation /
  // start_orientation from `properties` (engine-map "Facing: Character::Face"), so they were inert. The probe now turns
  // ArtProbeCatFacing with the harness's `face 9 back` and gives ArtProbeCatBack properties.lock_orientation [1 0].
  // OBSERVED 2026-10-22 (runs 20261022-113746 with lock_orientation [1 0], 20261022-113911 with [0 -1]): a spawned
  // TomTom variant with lock_orientation still shows its face in TacticsTest (only the mirror changes) — the probe keeps
  // one turn attempt and adds ArtProbeCatBackShown, whose probeBackShowF / probeBackShowB BOTH place the back rig, so
  // the back pose is drawn whatever the facing. OBSERVED 2026-10-22 (run 20261022-114440): the shown cat is drawn from
  // behind with TomTom's own parts but the checker marker at depth 15 of the back rig is NOT drawn (it is in the front
  // rigs of the A0 / wave probes); run 20261022-114637 placed the back rig at 1.5x and the shown cat came out 1.5x — our
  // frame, not vanilla idleB. So the probe tells our B frames apart by SIZE: probeBackB / probeBackShowF / probeBackShowB
  // place the back rig at sx = sy = 1.5, probeBackF the front rig at 1.
  const scene = JSON.parse(readFileSync(join(MODS_DIR, "_artprobe", "art", "probe.scene.json"), "utf8"));
  const gon = readFileSync(join(MODS_DIR, "_artprobe", "data", "characters", "enemies.gon.append"), "utf8");
  test("probe.scene.json: the donor carries probeBackF / probeBackB (probeBackPose: a front parts game rig, NO marker / probeBackPoseBack: facing back, parts game, empty slots at the back depths, the checker marker on the non-slot depth 15) and probeBackShowF / probeBackShowB (both the back rig: the back pose shown at any facing), all at vanilla idleB's `ani` offset; the only back-facing warning is probeBackShowF's (by design)", () => {
    const donorId = scene.exports._Append_CatTest;
    const d = scene.sprites[donorId];
    const want: Record<string, string> = { probeBackF: "probeBackPose", probeBackB: "probeBackPoseBack", probeBackShowF: "probeBackPoseBack", probeBackShowB: "probeBackPoseBack" };
    const ani = d.layers.find((l: any) => l.name === "ani");
    const keyAt = (l: string) => ani.keys.find((k: any) => k.frame === d.labels[l]);
    for (const [l, ref] of Object.entries(want)) {
      assert(Number.isInteger(d.labels[l]), `label ${l}`);
      eq(keyAt(l).ref, ref, l);
      assert(keyAt(l).x === 3.85 && keyAt(l).y === -47.95, `${l}: ${JSON.stringify(keyAt(l))}`);
      const big = ref === "probeBackPoseBack" ? 1.5 : 1;
      assert((keyAt(l).sx ?? 1) === big && (keyAt(l).sy ?? 1) === big, `${l}: scale ${big}`);
    }
    const front = scene.sprites.probeBackPose, back = scene.sprites.probeBackPoseBack;
    eq(front.rig, "cat"); eq(front.parts, "game"); eq(front.facing, undefined);
    assert(!front.layers.some((l: any) => l.keys.some((k: any) => k.ref === "CatProbeMc_marker")), "the front pose has no marker");
    eq(back.rig, "cat"); eq(back.parts, "game"); eq(back.facing, "back");
    for (const s of fx.back.slots) {
      const [name, depth] = s.split("@");
      const l = back.layers.find((x: any) => x.name === name);
      assert(!!l && l.depth === Number(depth) && l.keys.every((k: any) => R.isEmptySprite(scene, k.ref)), `back slot ${s}`);
    }
    const m = back.layers.find((l: any) => l.keys.some((k: any) => k.ref === "CatProbeMc_marker"));
    assert(!!m && m.depth === 15, "marker at depth 15");
    const v = validateScene(scene) as any;
    assert(v.ok, errors(v.findings));
    const bad = R.catAnimFindings(scene).filter((f: any) => f.severity !== "info" && /probeBack/.test(f.message));
    eq(bad.map((f: any) => f.code + " " + (/"(\w+)"/.exec(f.message) || [])[1]).join(","), "cat-anim-back-facing probeBackShowF");
  });

  // OBSERVED 2026-10-22 (backmarker; engine-map "The back facing and the four-way quartet"): the back rig's depth-15
  // marker IS drawn. The slot visitor 0x742bd0 returns 0 for a non-slot name and never writes that child, and run
  // 20261022-124301's shot-shown-2 holds the checker's lower two thirds at the window's top edge (gone in
  // shot-turned-back once unit 9 faces front). It was out of frame: (−48, −330) in a rig placed at 1.5x lands 1.5x as far
  // above the feet.
  test("probe.scene.json: every rig marker's top edge lands at the same height in the donor (ani y + sy·marker y = the 1x front rigs' −377.95), so the 1.5x back rig's marker stays in frame like the front rigs'", () => {
    const d = scene.sprites[scene.exports._Append_CatTest];
    const ani = d.layers.find((l: any) => l.name === "ani");
    const tops: Record<string, number> = {};
    for (const [label, frame] of Object.entries(d.labels as Record<string, number>)) {
      const k = ani.keys.find((x: any) => x.frame === frame);
      const rig = scene.sprites[k.ref];
      const m = rig && rig.layers.find((l: any) => l.keys.some((x: any) => x.ref === "CatProbeMc_marker"));
      if (!m) continue;
      tops[label] = Math.round((k.y + (k.sy ?? 1) * m.keys[0].y) * 100) / 100;
    }
    assert(tops.probeIdleF !== undefined && tops.probeBackB !== undefined && tops.probeBackShowF !== undefined, JSON.stringify(tops));
    for (const [label, top] of Object.entries(tops)) eq(top, -377.95, label);
  });

  if (!existsSync(caPath)) console.log(`  (skipped: vanilla catanis.swf not extracted at ${VANILLA_DIR})`);
  else test("T1: probeBackPoseBack's slot matrices (and cxforms) are vanilla idleB's frame 0, probeBackPose's are idleF's, and the `ani` offset is idleB's (77, -959) twips", () => {
    const c = clipOf(caPath, "CatTest");
    for (const [label, rig] of [["idleB", "probeBackPoseBack"], ["idleF", "probeBackPose"]] as const) {
      const f = c.frames.find((x) => x.labels.includes(label))!;
      eq(JSON.stringify(f.places[0].matrix.slice(4)), JSON.stringify([77, -959]));
      for (const van of c.firstOf(f.places[0].characterId)) {
        const ours = scene.sprites[rig].layers.find((l: any) => l.name === van.name).keys[0];
        for (let i = 0; i < 4; i++) assert(Math.abs(van.matrix[i] - ours.matrix[i]) < 1e-6, `${rig} ${van.name} matrix[${i}]`);
        eq(Math.round(ours.matrix[4] * 20), van.matrix[4], `${rig} ${van.name} tx`); eq(Math.round(ours.matrix[5] * 20), van.matrix[5], `${rig} ${van.name} ty`);
        if (van.cxform) assert(!!ours.cxform && Math.abs(ours.cxform.mul[0] - van.cxform.mul[0] / 256) < 0.01, `${rig} ${van.name} cxform`);
      }
    }
  });

  test("_artprobe: ArtProbeCatFacing = TomTom + alt_animations [[idle probeBack]] (the control, no orientation key); ArtProbeCatBack = the same with properties.lock_orientation [1 0] (faces away from data); ArtProbeCatBackShown = TomTom + alt_animations [[idle probeBackShow]]; render-cat-back.mewtest: baseline, TomTom, the control (front), then `face 9 back` turns it away (back 1..3, expect unit 9 facing == \"B\"), the data-locked cat is B and `face 10 front` leaves it B (locked 1..2), the shown back pose (shown 1..2), no _autoplay", () => {
    const entry = (n: string) => { const m = new RegExp(`\\n${n}\\s*\\{[\\s\\S]*?\\n\\}`).exec(gon); return m ? m[0] : ""; };
    const tom = (e: string) => /variant_of TomTom/.test(e) && /movieclip _CAT/.test(e) && /custom_cat_data TomTom/.test(e);
    const ctl = entry("ArtProbeCatFacing"), back = entry("ArtProbeCatBack"), shown = entry("ArtProbeCatBackShown");
    assert(tom(ctl) && /alt_animations \[\[idle probeBack\]\]/.test(ctl) && !/orientation/.test(ctl), "ArtProbeCatFacing");
    assert(tom(back) && /alt_animations \[\[idle probeBack\]\]/.test(back) && /properties \{\s*lock_orientation \[1 0\]\s*\}/.test(back) && !/orientation \[0 -1\]/.test(back), "ArtProbeCatBack");
    assert(tom(shown) && /alt_animations \[\[idle probeBackShow\]\]/.test(shown), "ArtProbeCatBackShown");
    const plan = parseScript(readFileSync(join(MODS_DIR, "_artprobe", "tests", "render-cat-back.mewtest"), "utf8"), { owningMod: "_artprobe", name: "render-cat-back" });
    assert(plan.ok, JSON.stringify(plan.errors));
    assert(!plan.mods.includes("_autoplay"), plan.mods.join(","));
    const b = plan.body;
    const at = (s: string) => b.indexOf(s);
    const order = ["enter TacticsTest", 'shot "baseline"', "cmd spawn TomTom", 'shot "vanilla"', "cmd spawn ArtProbeCatFacing", 'expect gon 9 graphics.alt_animations.0.1 == "probeBack"', 'expect unit 9 facing == "F"', 'shot "front"', "face 9 back", 'expect unit 9 facing == "B"', 'shot "back 1"', "cmd spawn ArtProbeCatBack\n", 'expect gon 10 properties.lock_orientation.0 == 1', 'expect unit 10 facing == "B"', 'shot "locked 1"', "face 10 front", 'shot "locked 2"', "cmd spawn ArtProbeCatBackShown", 'shot "shown 1"'];
    for (let i = 1; i < order.length; i++) assert(at(order[i - 1]!) >= 0 && at(order[i]!) > at(order[i - 1]!), `${order[i - 1]} before ${order[i]}`);
    assert(/expect console "Spawned ArtProbeCatBackShown"/.test(b), b);
    eq((b.match(/shot "back \d"/g) || []).length, 3);
    eq((b.match(/shot "shown \d"/g) || []).length, 2);
  });

  test("catBackOutcome (size ratios: each new cat's dark-blob height over TomTom's): back-facing when >= 2 back shots of the turn attempt are big (>= CAT_BACK_BIG, the 1.5x back rig plays); else back-pose-drawn when >= 2 shown shots are; front-big when the control is already big; not-drawn otherwise; a failed run gives its verdict", () => {
    need("catBackOutcome", "CAT_BACK_BIG");
    eq(P.CAT_BACK_BIG, 1.3);
    const none = { verdict: "pass", front: 1.0, back: [1.0, 1.02, 0.98], shown: [1.0, 1.0] };
    eq(P.catBackOutcome({ ...none, back: [1.5, 1.48, 1.52], shown: [1.5, 1.5] }), "back-facing");
    eq(P.catBackOutcome({ ...none, shown: [1.49, 1.51] }), "back-pose-drawn");
    eq(P.catBackOutcome({ ...none, back: [1.5, 1, 1], shown: [1.5, 1.5] }), "back-pose-drawn");
    eq(P.catBackOutcome({ ...none, front: 1.5, shown: [1.5, 1.5] }), "front-big");
    eq(P.catBackOutcome({ ...none, shown: [1.5, null] }), "not-drawn");
    eq(P.catBackOutcome(none), "not-drawn");
    eq(P.catBackOutcome({ ...none, verdict: "crash" }), "crash");
    // 2026-10-22 (facing): the turn pair — `face 9 front` swaps unit 9's back rig for its front rig in place; the
    // vanished B pose at >= CAT_BACK_BIG times the F pose's height is the back rig on a back-facing unit, even when
    // the earlier shots are unusable (a desktop capture instead of the window)
    eq(P.catBackOutcome({ ...none, back: [null, null, null], shown: [null, null], turn: 1.52 }), "back-facing");
    eq(P.catBackOutcome({ ...none, back: [null, null, null], shown: [null, null], turn: 1.0 }), "not-drawn");
    eq(P.catBackOutcome({ ...none, turn: null }), "not-drawn");
  });

  test("OBSERVED fixture (artprobe-cat-back-summary.json, npm run test:artprobe -- --cat-back): the run passed with the real save unchanged; outcome back-facing: face 9 back draws the 1.5x B frame (the turn pair), the face events and every harness expect agree, the data lock keeps unit 10 on B", () => {
    const p = join(HERE, "fixtures", "ingame", "artprobe-cat-back-summary.json");
    assert(existsSync(p), "written by npm run test:artprobe -- --cat-back");
    const j = JSON.parse(readFileSync(p, "utf8")) as any;
    eq(j.verdict, "pass");
    assert(/real save file\(s\) unchanged/.test(j.save), String(j.save));
    // 2026-10-22 (facing): `face 9 back` turns ArtProbeCatFacing away and it draws our 1.5x back rig; ArtProbeCatBack
    // faces away from data (properties.lock_orientation [1 0]) and `face 10 front` cannot turn it (the lock wins)
    eq(j.outcome, "back-facing", "the genuinely back-facing unit draws the 1.5x back rig");
    const windowShot = (l: string) => (j.capture as string[]).some((c) => c.startsWith(l + ": window"));
    if (windowShot("front") && windowShot("vanilla")) assert(j.front.ratio !== null && j.front.ratio < 1.3, `control ratio ${j.front.ratio}`);
    assert(j.turnPair.ratio !== null && j.turnPair.ratio >= 1.3 && j.turnPair.ratio <= 1.8, `turn pair ${JSON.stringify(j.turnPair)}`);
    const f9 = (j.faces as any[]).find((f) => f.unit === 9 && f.arg === "9 back");
    assert(!!f9 && f9.ok && f9.facing === "B" && f9.expect === "B" && JSON.stringify(f9.dir) === "[1,0]", JSON.stringify(j.faces));
    const f10 = (j.faces as any[]).find((f) => f.unit === 10);
    assert(!!f10 && f10.ok && f10.arg === "10 front" && f10.facing === "B" && JSON.stringify(f10.effective) === "[1,0]", `the lock keeps unit 10 on B: ${JSON.stringify(f10)}`);
    assert((j.facing["10"] as any[]).every((u) => u.facing === "B" && JSON.stringify(u.lock) === "[1,0]"), JSON.stringify(j.facing));
    assert((j.expects as string[]).length >= 16 && (j.expects as string[]).every((e) => e.startsWith("ok")), (j.expects as string[]).join("; "));
    assert(/face 9 back/.test(j.turn), j.turn);
    // 2026-10-22 (backmarker): with the back rig's marker at clip y -220 it is in frame. Window captures only: the
    // checker is found above unit 9 in every back shot at 1.5x the front rigs' ~1.9 px per clip px, and in neither the
    // control (front: the F rig has no marker) nor "turned back" (unit 9 on F again), so it is the B pose's own child.
    assert(Array.isArray(j.markers), "per-shot markers (scale / clipped)");
    const mk = (l: string) => (j.markers as any[]).find((m) => m.label === l);
    for (const l of ["back 1", "back 2", "back 3"]) if (windowShot(l)) {
      const m = mk(l);
      assert(!!m && m.found && m.scale >= 1.5 * 1.8 && m.scale <= 1.5 * 2.0, `${l}: ${JSON.stringify(m)}`);
    }
    for (const l of ["front", "turned back"]) if (windowShot(l)) assert(!!mk(l) && !mk(l).found, `${l}: no marker (${JSON.stringify(mk(l))})`);
    assert(["back 1", "back 2", "back 3"].filter(windowShot).length >= 2, `window captures: ${(j.capture as string[]).join("; ")}`);
  });
}
