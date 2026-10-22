// 3D phase M3 "pal" — a GON `palette true` model on a cat draws its grey pixels through the cat's own palette.png row
// (Character+0x90 CatParts -> +0x1b4 base / +0x1b8 override, the row of its 2D doll); a non-cat keeps its greys. The
// in-game proof is the framework's "unit palette: ..." lines (native/framework/src/fw_unit_palette.c, host-pinned in
// test_unit_palette.c), the draws' "mesh object ... palette=<row>" and two shots judged by mesh-measure.ts
// judgeUnitPalette (the row's texel around each model, none of the other cats') and spriteRowCounts (the 2D doll's
// paletted fill next to it).
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";
import * as mm from "../src/core/art/mesh-measure.ts";

type Img = { width: number; height: number; rgba: Uint8Array };
function canvas(w: number, h: number, rgb: [number, number, number] = [60, 60, 60]): Img {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = rgb[0]; rgba[i * 4 + 1] = rgb[1]; rgba[i * 4 + 2] = rgb[2]; rgba[i * 4 + 3] = 255; }
  return { width: w, height: h, rgba };
}
function fill(img: Img, x0: number, y0: number, x1: number, y1: number, rgb: readonly number[]): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const k = (y * img.width + x) * 4; img.rgba[k] = rgb[0]!; img.rgba[k + 1] = rgb[1]!; img.rgba[k + 2] = rgb[2]!; }
}
/** a 16 x 4 palette: row r, column c = (10 r + c, 100 + 10 r, 200 - 5 c) — every texel distinct, none grey */
function palette(): Img {
  const p = canvas(16, 4);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 16; c++) { const k = (r * 16 + c) * 4; p.rgba[k] = 10 * r + c; p.rgba[k + 1] = 100 + 10 * r; p.rgba[k + 2] = 200 - 5 * c; }
  return p;
}
/** a mesh object line anchored at the shot pixel (px, py) of a 1600 x 900 shot (16:9: no letterbox) */
function obj(handle: number, px: number, py: number, palette: number): mm.MeshObjectLine {
  return { frame: 61, handle, model: "models/grey-box.gltf", anchor: "unit", world: [0, 0, 0], ndc: [px / 800 - 1, 1 - py / 450, 0.05], tex: null, palette };
}

export function runUnitPaletteTests(test: TestFn, assert: AssertFn, eq: EqFn, fixture?: (name: string) => string | null): void {
  console.log("\n# per-unit palette rows (3D phase M3 pal): a cat's row on its `palette true` model, none on a non-cat");
  const LOG = [
    "unit palette: TomTom handle=1 row=9 base=9 override=-1",
    "[12:00:01] unit palette: Jester handle=4 row=137 base=200 override=137",
    "unit palette: Rat handle=3 row=-1 (no CatParts: not a cat, colours as authored)",
    "unit palette: Ghost handle=5 row=-1 (CatParts unreadable)",
    "unit model: Rat 000001 -> models/grey-box.gltf",
  ].join("\n");
  test("parseUnitPaletteLog: cat lines (row, base, override), non-cat lines (row -1 and the reason), prefixes tolerated, other lines ignored", () => {
    const p = mm.parseUnitPaletteLog(LOG);
    eq(p.length, 4);
    eq(JSON.stringify(p[0]), JSON.stringify({ entry: "TomTom", handle: 1, row: 9, base: 9, override: -1, note: null }));
    eq(p[1]!.row, 137); eq(p[1]!.base, 200); eq(p[1]!.override, 137);
    eq(p[2]!.row, -1); eq(p[2]!.base, null); eq(p[2]!.note, "no CatParts: not a cat, colours as authored");
    eq(p[3]!.note, "CatParts unreadable");
  });

  const pal = palette();
  const GREY = 153, TOP = mm.lambertShade([0, 1, 0]);
  const col = mm.paletteColumn(GREY, TOP);
  // built lazily: a missing export must fail these tests, not the whole run
  const unitsOf = () => mm.parseUnitPaletteLog("unit palette: A handle=1 row=1 base=1 override=-1\nunit palette: B handle=2 row=2 base=2 override=-1\nunit palette: R handle=3 row=-1 (no CatParts: not a cat, colours as authored)");
  const objs = [obj(1, 400, 450, 1), obj(2, 1200, 450, 2), obj(3, 800, 200, -1)];
  function shot(aRow: number, bRow: number, ratRgb: readonly number[] = [92, 92, 92]): Img {
    const img = canvas(1600, 900);
    fill(img, 380, 430, 420, 470, mm.paletteTexel(pal, col, aRow));
    fill(img, 1180, 430, 1220, 470, mm.paletteTexel(pal, col, bRow));
    fill(img, 780, 180, 820, 220, ratRgb);
    return img;
  }
  test("judgeUnitPalette: each cat's box holds its row's texel at the top-face column and no other cat's, the non-cat holds no cat row -> distinct-rows (pass)", () => {
    const a = shot(1, 2), b = shot(1, 2); b.rgba[0] = 1;
    const j = mm.judgeUnitPalette([a, b], objs, unitsOf(), pal, GREY, TOP);
    eq(j.verdict, "distinct-rows"); eq(j.pass, true); eq(j.column, col);
    eq(j.units.map((u) => `${u.entry}:${u.row}:${u.ok}`).join(","), "A:1:true,B:2:true,R:-1:true");
    eq(j.units[0]!.counts["row1"], 41 * 41); eq(j.units[0]!.counts["row2"], 0);
    eq(JSON.stringify(j.units[0]!.target), JSON.stringify(mm.paletteTexel(pal, col, 1)));
    eq(j.units[2]!.target, null);
  });
  test("judgeUnitPalette: swapped rows, a non-cat drawn in a cat's row, a draw logging another row -> wrong-colours; two cats on one row -> same-row; no units / stale / no shots", () => {
    const b = shot(1, 2); b.rgba[0] = 1;
    eq(mm.judgeUnitPalette([shot(2, 1), b], objs, unitsOf(), pal, GREY, TOP).verdict, "wrong-colours");
    const r = mm.judgeUnitPalette([shot(1, 2, mm.paletteTexel(pal, col, 1)), b], objs, unitsOf(), pal, GREY, TOP);
    eq(r.verdict, "wrong-colours"); eq(r.units[2]!.ok, false);
    eq(mm.judgeUnitPalette([shot(1, 2), b], [obj(1, 400, 450, 3), objs[1]!, objs[2]!], unitsOf(), pal, GREY, TOP).units[0]!.ok, false);
    const same = mm.parseUnitPaletteLog("unit palette: A handle=1 row=1 base=1 override=-1\nunit palette: B handle=2 row=1 base=1 override=-1");
    eq(mm.judgeUnitPalette([shot(1, 1), b], [objs[0]!, obj(2, 1200, 450, 1)], same, pal, GREY, TOP).verdict, "same-row");
    eq(mm.judgeUnitPalette([shot(1, 2), b], objs, [], pal, GREY, TOP).verdict, "no-units");
    eq(mm.judgeUnitPalette([shot(1, 2), shot(1, 2)], objs, unitsOf(), pal, GREY, TOP).verdict, "stale-shots");
    eq(mm.judgeUnitPalette([], objs, unitsOf(), pal, GREY, TOP).verdict, "no-shots");
  });
  test("modelPaletteColumns / spriteRowCounts: the columns a grey model can produce are left out, pure-grey texels too; the doll's other columns count per row", () => {
    eq(mm.modelPaletteColumns(GREY).join(","), "4,9");
    const img = canvas(100, 100);
    fill(img, 0, 0, 9, 9, mm.paletteTexel(pal, 2, 1));      // row 1, column 2: the doll's fill (100 px)
    fill(img, 10, 0, 19, 9, mm.paletteTexel(pal, 12, 2));   // row 2, column 12 (100 px)
    fill(img, 20, 0, 29, 9, mm.paletteTexel(pal, 6, 1));    // row 1, column 6: a model column, not counted
    const c = mm.spriteRowCounts(img, { x0: 0, y0: 0, x1: 100, y1: 100 }, pal, [1, 2], GREY, 0);
    eq(c["row1"], 100); eq(c["row2"], 100);
    const g = canvas(16, 1); for (let k = 0; k < 16; k++) { g.rgba[k * 4] = 90; g.rgba[k * 4 + 1] = 90; g.rgba[k * 4 + 2] = 90; }
    eq(mm.spriteRowCounts(canvas(10, 10, [90, 90, 90]), { x0: 0, y0: 0, x1: 10, y1: 10 }, g, [0], GREY)["row0"], 0);
  });

  const log = fixture?.("unit-palette-log.txt") ?? null;
  const sumText = fixture?.("unit-palette-summary.json") ?? null;
  if (log && sumText) {
    test("OBSERVED (T2 2026-10-22, unit-palette-log.txt): TomTom reads CatParts row 9 and Mangy row 16 (their custom_cats palettes, no override), the Rat has no CatParts (row -1); every draw of each model logged its unit's row", () => {
      const units = mm.parseUnitPaletteLog(log);
      eq(units.map((u) => `${u.entry}:${u.row}:${u.base}:${u.override}`).join(","), "TomTom:9:9:-1,Mangy:16:16:-1,Rat:-1:null:null");
      eq(units[2]!.note, "no CatParts: not a cat, colours as authored");
      const objs = mm.parseMeshProbeLog(log).objects;
      for (const u of units) {
        const rows = new Set(objs.filter((o) => o.handle === u.handle).map((o) => o.palette));
        eq([...rows].join(","), String(u.row), `${u.entry}'s draws`);
      }
      assert(/mesh: palette\.png 16x256/.test(log), "palette.png loaded (16 x 256)");
    });
    test("OBSERVED (T2 2026-10-22, unit-palette-summary.json): judgeUnitPalette on the two shots -> distinct-rows: TomTom's box holds row 9's texel (255 249 233, column 8) and none of row 16's, Mangy's row 16's (223 223 223) and none of row 9's, the Rat's neither; next to each model its 2D doll shows more of its own row than of the other cat's; the run passed with the real save unchanged", () => {
      const s = JSON.parse(sumText);
      eq(s.judgement.verdict, "distinct-rows"); eq(s.judgement.pass, true); eq(s.judgement.column, 8);
      const by = (e: string) => s.judgement.units.find((u: { entry: string }) => u.entry === e);
      eq(by("TomTom").target.join(" "), "255 249 233"); eq(by("Mangy").target.join(" "), "223 223 223");
      eq(by("TomTom").target.join(" "), s.palette.rows["9"][8].join(" ")); eq(by("Mangy").target.join(" "), s.palette.rows["16"][8].join(" "));
      assert(by("TomTom").counts.row9 >= 5000 && by("TomTom").counts.row16 === 0, JSON.stringify(by("TomTom").counts));
      assert(by("Mangy").counts.row16 >= 5000 && by("Mangy").counts.row9 === 0, JSON.stringify(by("Mangy").counts));
      eq(by("Rat").counts.row9, 0); eq(by("Rat").counts.row16, 0); eq(by("Rat").target, null);
      for (const sp of s.sprite.filter((x: { row: number }) => x.row >= 0)) {
        const own = sp.counts[`row${sp.row}`], other = Object.entries(sp.counts).filter(([k]) => k !== `row${sp.row}`).map(([, v]) => v as number);
        assert(own > 0 && other.every((v) => own > v), `${sp.entry}'s doll: ${JSON.stringify(sp.counts)}`);
      }
      eq(s.run.verdict, "pass");
      assert(/^1 real save file\(s\) unchanged/.test(s.run.save), s.run.save);
      eq(s.run.glErrors.length, 0);
    });
  } else test("unit palette fixtures present (unit-palette-log.txt / unit-palette-summary.json)", () => assert(false, "missing fixture"));
}
