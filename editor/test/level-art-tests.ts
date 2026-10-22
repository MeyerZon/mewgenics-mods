// Tileset art for the Room editor: tile id → tiles.gon tile class → clip name (aliases, the tileset's water_alt_tile)
// → the SWF that exports it; object id → spawns.gon object → characters/*.gon graphics.movieclip (variant_of, the
// tileset's clip remap) → the SWF; frame 1 rasterised to a PNG thumbnail (src/core/art/swf-raster.ts), served by
// /api/level-tile-art and cached under editor/data/ (git-ignored). Unresolvable art is a named reason, and the UI falls
// back to the tint swatches.
//
// T0 runs on synthetic data: a SWF built by the editor's own emitter in a temp dir, a synthetic tiles/spawns/
// tilesets/characters base — never game bytes. T1 reads .extracted/: every vanilla tile id in the `alley` tileset
// resolves to a clip or a named reason, and every resolved clip rasterises to a non-empty PNG.

import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { newScene, validateScene } from "../src/core/art/scene.ts";
import { emitSwf } from "../src/core/art/swf-emitter.ts";
import { decodePng } from "../src/core/art/png.ts";
import { MODS_DIR, EXTRACTED_DATA, vanillaSwfDir } from "../src/core/repo.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

async function load(rel: string): Promise<Record<string, any> & { __error?: string }> {
  try {
    return (await import(rel)) as Record<string, any>;
  } catch (e) {
    return { __error: String(e instanceof Error ? e.message : e) };
  }
}
function need(m: Record<string, any> & { __error?: string }, what: string): void {
  if (m.__error) throw new Error(`${what} did not load: ${m.__error}`);
}

/** A SWF exporting `WaterTile` (a red 40x20 diamond-ish box centred on 0,0), `ToxTile` (green), `Rat` (blue, feet at 0,0, all above). */
function syntheticSwf(): Uint8Array {
  const s = newScene("synthetic");
  s.shapes.red = { paths: [{ d: "M-20 -10 L20 -10 L20 10 L-20 10 Z", fill: "#ff0000" }] };
  s.shapes.green = { paths: [{ d: "M-20 -10 L20 -10 L20 10 L-20 10 Z", fill: "#00ff00" }] };
  // asymmetric: x 0..10, y -30..0 (feet at the origin, the body to the right)
  s.shapes.blue = { paths: [{ d: "M0 -30 L10 -30 L10 0 L0 0 Z", fill: "#0000ff" }] };
  const one = (ref: string) => ({ frames: 1, layers: [{ name: "a", depth: 1, keys: [{ frame: 0, ref, x: 0, y: 0 }] }] });
  s.sprites.WaterTile = one("red");
  s.sprites.ToxTile = one("green");
  s.sprites.Rat = one("blue");
  s.exports = { WaterTile: "WaterTile", ToxTile: "ToxTile", Rat: "Rat" };
  const v = validateScene(s);
  return emitSwf(v.scene, { abc: "none" }).bytes;
}

const TILES_GON = `0 { editor { name "Empty" } }
1 { editor { image_tint [blue blue] name "Water" } tile WaterTile }
2 { editor { image_tint [green green] name "Grass" } tile { GrassTile 80 TallGrassTile 15 BlankTile 5 } }
11 { editor { name "Toxic Sludge" } tile ToxicTile }
12 { editor { name "Shadow" } tile BlankTile }
13 { editor { name "Mud" } tile MudTile }
`;
const SPAWNS_GON = `0 { editor { name "Empty" } }
1 { editor { category 1 name "Player Cat Spawn" } utility PlayerSpawn }
11 { editor { category 3 name "Rat" } object Rat }
12 { editor { category 107 name "Rubble" } object Static1x1A }
13 { editor { category 2 name "TomTom" } object TomTom }
14 { editor { category 3 name "Ghost" } object NoSuchCharacter }
`;
const TILESETS_GON = `default_tileset alley
alley { combat_background AlleyBG static_1x1_a Rubble }
meatworld { water_alt_tile BloodTile static_1x1_a Rubble }
`;
const CHARACTERS_GON = `Rat { graphics { movieclip Rat } properties { faction enemies } }
static_object_template { graphics { movieclip Rock } properties { faction none } }
Static1x1A { variant_of static_object_template graphics { movieclip static_1x1_a } }
TomTom { graphics { movieclip _CAT scale 1.1 } properties { faction enemies } }
`;
const MAPS_GON = `tileset sewers\nlevels { folder sewers easy [easy] }\n`;

export async function runLevelArtTests(test: TestFn, assert: AssertFn, eq: EqFn): Promise<void> {
  console.log("\n# Room editor tileset art (tile/object → clip resolver, SWF rasteriser, /api/level-tile-art)");
  const same = (a: unknown, b: unknown, msg?: string): void => eq(JSON.stringify(a), JSON.stringify(b), msg);
  const ta = await load("../src/core/level/tile-art.ts");
  const ras = await load("../src/core/art/swf-raster.ts");
  const lib = await load("../src/core/art/swf-library.ts");
  const la = await load("../src/core/level/level-art.ts");
  const ed = await load("../src/core/level/edit.ts");

  const exportsMap = new Map<string, string>([["WaterTile", "tiles.swf"], ["ToxTile", "tiles.swf"], ["BloodTile", "tiles.swf"], ["Rat", "enemies.swf"], ["Rubble", "static_objects.swf"], ["ArtProbe", "mod:probe.swf"]]);
  const tilesets = { alley: { combat_background: "AlleyBG", static_1x1_a: "Rubble" }, meatworld: { water_alt_tile: "BloodTile", static_1x1_a: "Rubble" } };
  const characters = new Map<string, Record<string, unknown>>([
    ["Rat", { graphics: { movieclip: "Rat" }, properties: { faction: "enemies" } }],
    ["static_object_template", { graphics: { movieclip: "Rock" }, properties: { faction: "none" } }],
    ["Static1x1A", { variant_of: "static_object_template", graphics: { movieclip: "static_1x1_a" } }],
    ["TomTom", { graphics: { movieclip: "_CAT", scale: 1.1 }, properties: { faction: "enemies" } }],
    ["Plain", { properties: { faction: "enemies" } }],
  ]);
  const ctx = (tileset = "alley", ex: Map<string, string> | null = exportsMap) => ({ tileset, tilesets, exports: ex, characters });
  const tile = (id: number, classes: Array<[string, number]>) => ({ id, classes: classes.map(([name, weight]) => ({ name, weight })) });
  const obj = (id: number, kind: string, name: string) => ({ id, kind, classes: [{ name, weight: 1 }] });

  // ---- the pure resolver ----
  test("tile art: a tile id resolves through its tile class to the clip of the same name and the SWF that exports it", () => {
    need(ta, "src/core/level/tile-art.ts");
    const r = ta.resolveTileArt(tile(1, [["WaterTile", 1]]), 1, ctx());
    same([r.ok, r.clip, r.swf, r.tileClass, r.mirrored], [true, "WaterTile", "tiles.swf", "WaterTile", false]);
  });

  test("tile art: a weighted class list uses its heaviest class; class → clip aliases (ToxicTile → ToxTile) apply", () => {
    need(ta, "src/core/level/tile-art.ts");
    same(ta.mainTileClass([{ name: "GrassTile", weight: 80 }, { name: "TallGrassTile", weight: 15 }, { name: "BlankTile", weight: 5 }]), "GrassTile");
    same(ta.mainTileClass([{ name: "GrassTile", weight: 15 }, { name: "TallGrassTile", weight: 80 }]), "TallGrassTile");
    same(ta.TILE_CLIP_ALIASES.ToxicTile, "ToxTile");
    same(ta.TILE_CLIP_ALIASES.TallGrassTile, "TallGrassBack");
    const r = ta.resolveTileArt(tile(11, [["ToxicTile", 1]]), 11, ctx());
    same([r.ok, r.clip, r.tileClass], [true, "ToxTile", "ToxicTile"]);
    assert(r.steps.some((s: string) => /alias/.test(s)), `the steps name the alias: ${r.steps}`);
  });

  test("tile art: a tileset's water_alt_tile replaces the water clip (meatworld: WaterTile → BloodTile), other tilesets keep WaterTile", () => {
    need(ta, "src/core/level/tile-art.ts");
    const a = ta.resolveTileArt(tile(1, [["WaterTile", 1]]), 1, ctx("meatworld"));
    same([a.ok, a.clip], [true, "BloodTile"]);
    assert(a.steps.some((s: string) => /water_alt_tile/.test(s)), `steps: ${a.steps}`);
    same(ta.resolveTileArt(tile(1, [["WaterTile", 1]]), 1, ctx("alley")).clip, "WaterTile");
  });

  test("tile art: every unresolvable tile is a named reason (empty, not-in-palette, blank-tile, no-clip, no-swfs)", () => {
    need(ta, "src/core/level/tile-art.ts");
    same(ta.resolveTileArt(tile(0, []), 0, ctx()).reason, "empty");
    same(ta.resolveTileArt(undefined, 77, ctx()).reason, "not-in-palette");
    same(ta.resolveTileArt(tile(12, [["BlankTile", 1]]), 12, ctx()).reason, "blank-tile");
    const mud = ta.resolveTileArt(tile(13, [["MudTile", 1]]), 13, ctx());
    same([mud.ok, mud.reason, mud.clip], [false, "no-clip", "MudTile"]);
    same(ta.resolveTileArt(tile(1, [["WaterTile", 1]]), 1, ctx("alley", null)).reason, "no-swfs", "no SWF directory: named, so the UI shows the swatch");
    for (const r of [mud]) assert(typeof r.detail === "string" && r.detail.length > 10, "a reason carries a sentence");
    for (const reason of ["empty", "not-in-palette", "blank-tile", "no-clip", "no-swfs", "utility", "no-character", "cat-rig"]) assert(ta.ART_REASONS.includes(reason), `ART_REASONS lists ${reason}`);
  });

  test("object art: object → character → graphics.movieclip; enemies are mirrored, statics resolve through variant_of + the tileset's clip slot", () => {
    need(ta, "src/core/level/tile-art.ts");
    const rat = ta.resolveObjectArt(obj(11, "object", "Rat"), 11, ctx());
    same([rat.ok, rat.clip, rat.swf, rat.character, rat.mirrored, rat.scale], [true, "Rat", "enemies.swf", "Rat", true, 1]);
    const rub = ta.resolveObjectArt(obj(12, "object", "Static1x1A"), 12, ctx());
    same([rub.ok, rub.clip, rub.swf, rub.mirrored], [true, "Rubble", "static_objects.swf", false]);
    assert(rub.steps.some((s: string) => /static_1x1_a/.test(s) && /alley/.test(s)), `steps name the tileset remap: ${rub.steps}`);
    // a mod's tilesets.gon.merge redirect (alley { Rat ArtProbe }) is the same remap
    const red = ta.resolveObjectArt(obj(11, "object", "Rat"), 11, { ...ctx(), tilesets: { alley: { Rat: "ArtProbe" } } });
    same([red.clip, red.swf], ["ArtProbe", "mod:probe.swf"]);
  });

  test("object art: cats (_CAT, or no movieclip = the _CAT default), utilities and unknown characters are named reasons", () => {
    need(ta, "src/core/level/tile-art.ts");
    same(ta.resolveObjectArt(obj(13, "object", "TomTom"), 13, ctx()).reason, "cat-rig");
    same(ta.resolveObjectArt(obj(15, "object", "Plain"), 15, ctx()).reason, "cat-rig");
    same(ta.resolveObjectArt(obj(1, "utility", "PlayerSpawn"), 1, ctx()).reason, "utility");
    same(ta.resolveObjectArt(obj(14, "object", "NoSuchCharacter"), 14, ctx()).reason, "no-character");
    same(ta.resolveObjectArt(undefined, 999, ctx()).reason, "not-in-palette");
    same(ta.resolveObjectArt(obj(11, "object", "Rat"), 11, ctx("alley", null)).reason, "no-swfs");
  });

  test("tile art: the default tileset is the one of the map whose levels.folder holds the room, else default_tileset", () => {
    need(ta, "src/core/level/tile-art.ts");
    const maps = [{ name: "alley", folder: "alley", tileset: "alley" }, { name: "sewers", folder: "sewers", tileset: "sewers" }];
    same(ta.defaultTilesetFor("levels/sewers/easy/a1.lvl", maps, "alley"), { tileset: "sewers", source: "map sewers" });
    same(ta.defaultTilesetFor("levels/myroom/x.lvl", maps, "alley"), { tileset: "alley", source: "default_tileset" });
    same(ta.defaultTilesetFor("", maps, null), { tileset: "alley", source: "fallback alley" });
  });

  // ---- iso layout helpers (pure, bundled into the browser) ----
  test("iso view: 2:1 diamonds (cell (x,y) → ((x-y)·w/2, (x+y)·w/4)) and the draw order sorts by x+y (back first)", () => {
    need(ed, "src/core/level/edit.ts");
    same(ed.isoCellCenter(0, 0, 64), { x: 0, y: 0 });
    same(ed.isoCellCenter(1, 0, 64), { x: 32, y: 16 });
    same(ed.isoCellCenter(0, 1, 64), { x: -32, y: 16 });
    same(ed.isoCellCenter(3, 2, 64), { x: 32, y: 80 });
    const order = ed.isoDrawOrder(3, 2) as Array<{ x: number; y: number }>;
    same(order.length, 6);
    same(order[0], { x: 0, y: 0 });
    same(order[order.length - 1], { x: 2, y: 1 });
    for (let i = 1; i < order.length; i++) assert(order[i - 1]!.x + order[i - 1]!.y <= order[i]!.x + order[i]!.y, "non-decreasing x+y");
  });

  // ---- the rasteriser (pure) on a SWF built by the editor's emitter ----
  const swfBytes = syntheticSwf();
  test("swf raster: frame 1 of an exported clip rasterises with its registration point as the PNG origin", () => {
    need(ras, "src/core/art/swf-raster.ts");
    need(lib, "src/core/art/swf-library.ts");
    const src = lib.swfSourceFromBytes(swfBytes);
    const id = src.exports.get("WaterTile");
    assert(typeof id === "number", "WaterTile is exported");
    const r = ras.rasterizeCharacter(src, id, { scale: 1, pad: 1 });
    assert(r.width >= 40 && r.width <= 44 && r.height >= 20 && r.height <= 24, `40x20 box (+pad): ${r.width}x${r.height}`);
    assert(Math.abs(r.originX - r.width / 2) <= 1 && Math.abs(r.originY - r.height / 2) <= 1, `origin at the centre: ${r.originX},${r.originY}`);
    const at = (x: number, y: number) => Array.from(r.rgba.slice((y * r.width + x) * 4, (y * r.width + x) * 4 + 4));
    same(at(Math.round(r.originX), Math.round(r.originY)), [255, 0, 0, 255], "red, opaque at the origin");
    same(at(0, 0)[3], 0, "transparent corner (pad)");
  });

  test("swf raster: mirror flips about the registration point (feet stay at the origin); scale multiplies the size", () => {
    need(ras, "src/core/art/swf-raster.ts");
    need(lib, "src/core/art/swf-library.ts");
    const src = lib.swfSourceFromBytes(swfBytes);
    const id = src.exports.get("Rat");
    const a = ras.rasterizeCharacter(src, id, { scale: 1, pad: 0 });
    assert(Math.abs(a.originX) <= 1 && Math.abs(a.originY - a.height) <= 1, `unmirrored: origin at the bottom-left: ${a.originX},${a.originY} of ${a.width}x${a.height}`);
    const b = ras.rasterizeCharacter(src, id, { scale: 1, pad: 0, mirror: true });
    assert(Math.abs(b.originX - b.width) <= 1, `mirrored: origin at the bottom-right: ${b.originX} of ${b.width}`);
    const c = ras.rasterizeCharacter(src, id, { scale: 2, pad: 0 });
    assert(Math.abs(c.width - 2 * a.width) <= 2 && Math.abs(c.height - 2 * a.height) <= 2, `scale 2: ${c.width}x${c.height} vs ${a.width}x${a.height}`);
  });

  // ---- level art on disk: synthetic base + SWF dir + cache dir ----
  const root = mkdtempSync(join(tmpdir(), "mewged-levelart-"));
  const base = join(root, "data");
  const swfDir = join(root, "swfs");
  const cacheDir = join(root, "cache");
  mkdirSync(join(base, "characters"), { recursive: true });
  mkdirSync(join(base, "maps"), { recursive: true });
  mkdirSync(swfDir, { recursive: true });
  writeFileSync(join(base, "tiles.gon"), TILES_GON);
  writeFileSync(join(base, "spawns.gon"), SPAWNS_GON);
  writeFileSync(join(base, "tilesets.gon"), TILESETS_GON);
  writeFileSync(join(base, "characters", "enemies.gon"), CHARACTERS_GON);
  writeFileSync(join(base, "maps", "sewers.gon"), MAPS_GON);
  writeFileSync(join(swfDir, "tiles.swf"), swfBytes);
  const MOD = "_levelart_t0";
  const modDir = join(MODS_DIR, MOD);
  rmSync(modDir, { recursive: true, force: true });
  mkdirSync(join(modDir, "data"), { recursive: true });
  writeFileSync(join(modDir, "description.json"), JSON.stringify({ name: MOD }));
  writeFileSync(join(modDir, "data", "tilesets.gon.append"), "modyard { static_1x1_a Rubble }\n");
  const opts = { extractedData: base, swfDir, cacheDir };
  try {
    test("level art: info lists the tilesets (base + the mod's .append), the default from the room's map, and per-id resolutions", () => {
      need(la, "src/core/level/level-art.ts");
      const info = la.levelArtInfo(MOD, { path: "levels/sewers/x.lvl" }, opts);
      same([info.ok, info.tileset, info.tilesetSource, info.hasSwfs], [true, "sewers", "map sewers", true]);
      assert(info.tilesets.includes("alley") && info.tilesets.includes("meatworld") && info.tilesets.includes("modyard"), `tilesets: ${info.tilesets}`);
      same([info.tiles["1"].ok, info.tiles["1"].clip], [true, "WaterTile"]);
      same([info.tiles["11"].ok, info.tiles["11"].clip], [true, "ToxTile"]);
      same(info.tiles["13"].reason, "no-clip");
      same([info.objects["11"].ok, info.objects["11"].clip, info.objects["11"].mirrored], [true, "Rat", true]);
      same(info.objects["1"].reason, "utility");
      same(la.levelArtInfo(MOD, { tileset: "meatworld" }, opts).tiles["1"].reason, "no-clip", "BloodTile is not in the synthetic SWF: a named reason");
    });

    test("level art: the PNG route renders a tile and an object, caches them under the cache dir, and serves the cache next time", () => {
      need(la, "src/core/level/level-art.ts");
      const a = la.levelArtImage(MOD, { tileset: "alley", tile: 1 }, opts);
      assert(a.ok, `tile 1: ${a.reason} ${a.detail}`);
      same(a.meta.cached, false);
      const img = decodePng(a.png);
      same([img.width, img.height], [a.meta.width, a.meta.height]);
      const ox = Math.round(a.meta.originX), oy = Math.round(a.meta.originY);
      same(Array.from(img.rgba.slice((oy * img.width + ox) * 4, (oy * img.width + ox) * 4 + 4)), [255, 0, 0, 255], "the red clip at the origin");
      const files = readdirSync(join(cacheDir, "level-art"));
      assert(files.some((f) => f.endsWith(".png")) && files.some((f) => f.endsWith(".json")), `cache files: ${files}`);
      const b = la.levelArtImage(MOD, { tileset: "alley", tile: 1 }, opts);
      same([b.ok, b.meta.cached], [true, true]);
      const r = la.levelArtImage(MOD, { tileset: "alley", object: 11 }, opts);
      assert(r.ok && r.meta.mirrored === true, `the Rat renders mirrored: ${r.reason ?? ""}`);
      const bad = la.levelArtImage(MOD, { tileset: "alley", tile: 13 }, opts);
      same([bad.ok, bad.reason], [false, "no-clip"]);
    });

    test("level art: without .extracted/ (no SWF dir, no base data) every id is a named reason and nothing is rendered", () => {
      need(la, "src/core/level/level-art.ts");
      const empty = join(root, "empty");
      mkdirSync(join(empty, "data"), { recursive: true });
      const o = { extractedData: join(empty, "data"), swfDir: join(empty, "swfs"), cacheDir };
      const info = la.levelArtInfo(MOD, {}, o);
      same([info.ok, info.hasSwfs, info.tileset], [true, false, "alley"]);
      same(Object.keys(info.tiles).length, 0, "no base tiles.gon: no tile entries");
      const img = la.levelArtImage(MOD, { tileset: "alley", tile: 1 }, o);
      same(img.ok, false);
      assert(["not-in-palette", "no-swfs"].includes(img.reason), `named reason: ${img.reason}`);
    });
  } finally {
    rmSync(modDir, { recursive: true, force: true });
  }

  // ---- T1: the real alley tileset ----
  const realSwfs = vanillaSwfDir();
  const t1 = existsSync(join(EXTRACTED_DATA, "tiles.gon")) && existsSync(join(realSwfs, "tiles.swf"));
  if (!t1) {
    console.log("  (skipped: level art T1 — no .extracted/data/tiles.gon or swfs/tiles.swf)");
    return;
  }
  test("level art (T1): every vanilla tile id of `alley` resolves to a clip or a named reason, and every clip rasterises to a non-empty PNG", () => {
    need(la, "src/core/level/level-art.ts");
    need(ta, "src/core/level/tile-art.ts");
    const o = { cacheDir: join(root, "cache-t1") };
    const info = la.levelArtInfo("", { tileset: "alley" }, o);
    const ids = Object.keys(info.tiles);
    assert(ids.length >= 26, `vanilla tiles.gon has 26+ ids, got ${ids.length}`);
    const resolved: string[] = [];
    const reasons: string[] = [];
    for (const id of ids) {
      const r = info.tiles[id];
      if (!r.ok) {
        assert(ta.ART_REASONS.includes(r.reason) && typeof r.detail === "string", `tile ${id}: unnamed failure ${JSON.stringify(r)}`);
        reasons.push(`${id}:${r.reason}`);
        continue;
      }
      const img = la.levelArtImage("", { tileset: "alley", tile: Number(id) }, o);
      assert(img.ok, `tile ${id} (${r.clip}) resolves but does not render: ${img.reason} ${img.detail}`);
      const px = decodePng(img.png);
      let opaque = 0;
      for (let i = 3; i < px.rgba.length; i += 4) if (px.rgba[i]! > 0) opaque++;
      assert(opaque > 0, `tile ${id} (${r.clip}) rendered fully transparent`);
      resolved.push(`${id}:${r.clip}`);
    }
    for (const want of ["1:WaterTile", "4:FireTile", "5:IceTile", "7:MetalTile", "11:ToxTile"]) assert(resolved.includes(want), `${want} in ${resolved.join(" ")}`);
    console.log(`    alley: ${resolved.length} tile ids with art, ${reasons.length} named reasons (${reasons.join(" ")})`);
  });

  test("level art (T1): the Rat spawn draws enemies.swf's Rat mirrored; a 1x1 static draws the alley's static_1x1_a slot (Rubble)", () => {
    need(la, "src/core/level/level-art.ts");
    const info = la.levelArtInfo("", { tileset: "alley" }, { cacheDir: join(root, "cache-t1") });
    const rat = Object.values(info.objects).find((r: any) => r.character === "Rat") as any;
    assert(rat && rat.ok && rat.clip === "Rat" && /enemies/.test(rat.swf) && rat.mirrored === true, `Rat: ${JSON.stringify(rat)}`);
    const st = Object.values(info.objects).find((r: any) => r.character === "Static1x1A") as any;
    assert(st && st.ok && st.clip === "Rubble", `Static1x1A: ${JSON.stringify(st)}`);
    const img = la.levelArtImage("", { tileset: "alley", object: rat.id }, { cacheDir: join(root, "cache-t1") });
    assert(img.ok && img.meta.width > 10 && img.meta.height > 10, `Rat PNG: ${img.reason ?? ""} ${img.meta?.width}x${img.meta?.height}`);
  });
  rmSync(root, { recursive: true, force: true });
}
