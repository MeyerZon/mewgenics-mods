// Raster art for mods (2026-10-22, the owner's "a way to use not only vector files"): a PNG as a bitmap-filled shape,
// as a whole raster sprite (a character clip) and as a background plate, with the bitmap fill's repeat / smoothing
// flags (FillStyle_read 0xb6ebc0 keeps 0x40 repeat / 0x41 clipped / 0x42 / 0x43 pixel-snapped apart), the atlas limit
// (fit_texture 0xa24540, bitmap-too-large) and the formats the decoder knows (DefineBitsLossless_init 0xb7a4e0:
// formats 3 / 4 / 5 → bitmap-unsupported-format otherwise). T1 pins vanilla's own raster use (backgrounds.swf combat
// plates are 2000×1500 bitmaps, every vanilla bitmap is lossless format 5, the fill types in use). The in-game
// measures are in art-probes-raster (src/core/art/probe-raster.ts).

import { deflateSync } from "node:zlib";
import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODS_DIR } from "../src/core/repo.ts";
import { vanillaSwfDir } from "../src/core/repo.ts";
import { BitWriter, TAG, tag } from "../src/core/art/swf-bits.ts";
import { readSwf, flattenTags } from "../src/core/art/swf-reader.ts";
import { emitSwf, minimalGateSwf } from "../src/core/art/swf-emitter.ts";
import { encodePng, decodePng } from "../src/core/art/png.ts";
import { newScene, validateScene } from "../src/core/art/scene.ts";
import * as api from "../src/core/api.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** a w×h RGBA image filled by f(x, y) */
function img(w: number, h: number, f: (x: number, y: number) => [number, number, number, number]) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set(f(x, y), (y * w + x) * 4);
  return { width: w, height: h, rgba };
}

/** A gate SWF with extra framed tags spliced in right after the header. */
function withTags(extra: Uint8Array[]): Uint8Array {
  const base = minimalGateSwf({ withAbc: false, linkage: "RasterProbe", label: "idle" });
  const first = readSwf(base).tags[0]!.offset;
  const add = extra.reduce((n, t) => n + t.length, 0);
  const out = new Uint8Array(base.length + add);
  out.set(base.subarray(0, first), 0);
  let p = first;
  for (const t of extra) { out.set(t, p); p += t.length; }
  out.set(base.subarray(first), p);
  const len = out.length;
  out[4] = len & 0xff; out[5] = (len >>> 8) & 0xff; out[6] = (len >>> 16) & 0xff; out[7] = (len >>> 24) & 0xff;
  return out;
}

/** DefineBitsLossless2 with an arbitrary format byte. */
function lossless2(id: number, format: number, width: number, height: number): Uint8Array {
  const w = new BitWriter(16);
  w.u16(id); w.u8(format); w.u16(width); w.u16(height);
  w.bytes(new Uint8Array(deflateSync(new Uint8Array(width * height * 4).fill(255))));
  return tag(TAG.DefineBitsLossless2, w.finish(), true);
}

export async function runArtRasterTests(test: TestFn, assert: AssertFn, eq: EqFn): Promise<void> {
  console.log("\n# Art: raster (PNG as a bitmap fill, a raster sprite, a background plate; fill flags; limits)");
  let R: Record<string, any> = {};
  let RU: Record<string, any> = {};
  const errs: string[] = [];
  try { R = await import("../src/core/art/raster.ts"); } catch (e) { errs.push(`raster.ts: ${e instanceof Error ? e.message : String(e)}`); }
  let RC: Record<string, any> = {};
  try { RC = await import("../src/core/art/raster-census.ts"); } catch (e) { errs.push(`raster-census.ts: ${e instanceof Error ? e.message : String(e)}`); }
  try { RU = await import("../src/core/art/swf-rules.ts"); } catch (e) { errs.push(`swf-rules.ts: ${e instanceof Error ? e.message : String(e)}`); }
  const need = () => { if (errs.length) throw new Error(errs.join("; ")); };
  const A = api as Record<string, any>;
  const codes = (fs: Array<{ code: string; severity: string }>, sev?: string) => fs.filter((f) => !sev || f.severity === sev).map((f) => f.code);

  // ---- the fill flags ------------------------------------------------------------------------------------------
  test("bitmapFillType: clipped+smooth 0x41 (default), repeat 0x40, clipped pixel-snapped 0x43, repeat pixel-snapped 0x42 (FillStyle_read 0xb6ebc0)", () => {
    need();
    eq(R.bitmapFillType({ file: "a.png" }), 0x41);
    eq(R.bitmapFillType({ file: "a.png", repeat: true }), 0x40);
    eq(R.bitmapFillType({ file: "a.png", smooth: false }), 0x43);
    eq(R.bitmapFillType({ file: "a.png", repeat: true, smooth: false }), 0x42);
  });

  const sceneWith = (bm: Record<string, unknown>) => {
    const sc = newScene("rastertest") as any;
    sc.bitmaps = { tile: { file: "art/tile.png", ...bm } };
    sc.shapes = { s: { paths: [{ d: "M0 0 L32 0 L32 32 L0 32 Z", fill: "bitmap:tile", transform: [2, 0, 0, 2, 0, 0] }] } };
    sc.sprites = { Clip: { frames: 1, layers: [{ depth: 1, keys: [{ frame: 0, ref: "s" }] }] } };
    sc.exports = { RasterClip: "Clip" };
    return sc;
  };
  const tile = img(8, 8, (x, y) => ((x + y) % 2 ? [255, 0, 0, 255] : [0, 0, 255, 255]));

  test("emitSwf writes the scene bitmap's fill type: repeat → 0x40, smooth:false → 0x43, both → 0x42, default 0x41 (read back by swf-reader)", () => {
    need();
    for (const [opt, want] of [[{}, 0x41], [{ repeat: true }, 0x40], [{ smooth: false }, 0x43], [{ repeat: true, smooth: false }, 0x42]] as const) {
      const v = validateScene(sceneWith(opt)) as any;
      assert(v.ok, JSON.stringify(v.findings));
      const out = emitSwf(v.scene, { bitmaps: new Map([["tile", tile]]) });
      const shape = (readSwf(out.bytes).tags as any[]).find((t) => t.shape)!.shape;
      eq(shape.fillStyles[0].type, want, JSON.stringify(opt));
    }
  });

  test("validateScene: bitmap repeat / smooth must be booleans (bitmap-option error)", () => {
    const v = validateScene(sceneWith({ repeat: "yes", smooth: 0 })) as any;
    assert(!v.ok, "should fail");
    eq(codes(v.findings, "error").filter((c: string) => c === "bitmap-option").length, 2);
  });

  // ---- addBitmapToScene ----------------------------------------------------------------------------------------
  test("addBitmapToScene mode sprite: a bitmap <id>Bmp, a rect shape <id> in texel units scaled to clip px with its origin at the feet (bottom-centre), a 1-frame sprite <id>Clip exported under the name; the scene validates", () => {
    need();
    const r = R.addBitmapToScene(newScene("x"), { id: "Photo", file: "art/Photo.png", width: 200, height: 100, mode: "sprite", scale: 0.5, exportName: "PhotoEnemy" });
    assert(r.ok, JSON.stringify(r.findings));
    eq(r.bitmapId, "PhotoBmp"); eq(r.shapeId, "Photo"); eq(r.spriteId, "PhotoClip"); eq(r.exportName, "PhotoEnemy");
    eq(r.scene.bitmaps.PhotoBmp.file, "art/Photo.png");
    const p = r.scene.shapes.Photo.paths[0];
    eq(p.d, "M0 0 L200 0 L200 100 L0 100 Z"); eq(p.fill, "bitmap:PhotoBmp");
    eq(JSON.stringify(p.transform), JSON.stringify([0.5, 0, 0, 0.5, -50, -50]));
    eq(r.scene.sprites.PhotoClip.frames, 1);
    eq(r.scene.sprites.PhotoClip.layers[0].keys[0].ref, "Photo");
    eq(r.scene.exports.PhotoEnemy, "PhotoClip");
    assert((validateScene(r.scene) as any).ok, JSON.stringify((validateScene(r.scene) as any).findings));
  });

  test("addBitmapToScene mode background: origin top-left (vanilla AlleyBGTest: a 2000×1500 bitmap scaled 0.7667 from (0,0)), exported; mode fill: bitmap + shape only (no sprite, no export), repeat tiles the area", () => {
    need();
    const bg = R.addBitmapToScene(newScene("x"), { id: "Plate", file: "art/Plate.png", width: 2000, height: 1500, mode: "background", scale: 0.7667 });
    assert(bg.ok, JSON.stringify(bg.findings));
    eq(JSON.stringify(bg.scene.shapes.Plate.paths[0].transform), JSON.stringify([0.7667, 0, 0, 0.7667, 0, 0]));
    eq(bg.scene.exports.Plate, "PlateClip");
    const f = R.addBitmapToScene(newScene("x"), { id: "Bricks", file: "art/b.png", width: 16, height: 16, mode: "fill", repeat: true, area: { width: 160, height: 48 } });
    assert(f.ok, JSON.stringify(f.findings));
    eq(f.spriteId, undefined); eq(Object.keys(f.scene.exports).length, 0);
    eq(f.scene.bitmaps.BricksBmp.repeat, true);
    eq(f.scene.shapes.Bricks.paths[0].d, "M0 0 L160 0 L160 48 L0 48 Z");
    eq(JSON.stringify(f.scene.shapes.Bricks.paths[0].transform), JSON.stringify([1, 0, 0, 1, 0, 0]));
  });

  test("addBitmapToScene findings: bitmap-too-large (error, >= texture_atlas_size 4096 in either dimension), bitmap-upscaled (info: shown above 1 clip px per texel), id taken without replace (error), bad mode / origin (error)", () => {
    need();
    const big = R.addBitmapToScene(newScene("x"), { id: "Big", file: "art/Big.png", width: 4096, height: 10 });
    assert(!big.ok); assert(codes(big.findings, "error").includes("bitmap-too-large"), JSON.stringify(big.findings));
    const up = R.addBitmapToScene(newScene("x"), { id: "Up", file: "art/Up.png", width: 32, height: 32, scale: 4 });
    assert(up.ok); assert(codes(up.findings, "info").includes("bitmap-upscaled"), JSON.stringify(up.findings));
    const sc = newScene("x") as any; sc.shapes.Taken = { paths: [] };
    const taken = R.addBitmapToScene(sc, { id: "Taken", file: "art/T.png", width: 4, height: 4 });
    assert(!taken.ok); assert(codes(taken.findings, "error").includes("id-taken"), JSON.stringify(taken.findings));
    const again = R.addBitmapToScene(sc, { id: "Taken", file: "art/T.png", width: 4, height: 4, replace: true });
    assert(again.ok, JSON.stringify(again.findings));
    assert(!R.addBitmapToScene(newScene("x"), { id: "M", file: "art/M.png", width: 4, height: 4, mode: "photo" }).ok);
    assert(!R.addBitmapToScene(newScene("x"), { id: "M", file: "art/M.png", width: 4, height: 4, origin: "middle" }).ok);
  });

  test("pngProblems: a decodable 8-bit PNG is fine; 16-bit / interlaced / not-a-PNG are bitmap-unsupported-format with the decoder's reason", () => {
    need();
    eq(R.pngProblems(encodePng(2, 2, new Uint8Array(16).fill(200))).length, 0);
    const p16 = encodePng(2, 2, new Uint8Array(16));
    const bad16 = new Uint8Array(p16); bad16[24] = 16; // IHDR bit depth
    const f = R.pngProblems(bad16);
    eq(f[0].code, "bitmap-unsupported-format"); assert(/bit depth 16/.test(f[0].message), f[0].message);
    eq(R.pngProblems(new Uint8Array([1, 2, 3]))[0].code, "bitmap-unsupported-format");
  });

  // ---- the SWF rules --------------------------------------------------------------------------------------------
  test("swfFindings: a DefineBitsLossless2 of format 5 is clean; format 2 (no branch in DefineBitsLossless_init 0xb7a4e0) is bitmap-unsupported-format", () => {
    need();
    const fine = RU.swfFindings(readSwf(withTags([lossless2(40, 5, 4, 4)])).tags) as any[];
    assert(!codes(fine).includes("bitmap-unsupported-format"), JSON.stringify(fine));
    const bad = RU.swfFindings(readSwf(withTags([lossless2(40, 2, 4, 4)])).tags) as any[];
    assert(codes(bad, "error").includes("bitmap-unsupported-format"), JSON.stringify(bad));
    assert(!!RU.SWF_RULE_CODES["bitmap-unsupported-format"], "listed in SWF_RULE_CODES");
  });

  // ---- the API (+ MCP import_bitmap) -----------------------------------------------------------------------------
  const MOD = "_raster_test_tmp";
  const modDir = join(MODS_DIR, MOD);
  const cleanup = () => { if (existsSync(modDir)) rmSync(modDir, { recursive: true, force: true }); };
  test("api.importBitmap { mod, base64, scenePath, mode: sprite }: writes art/<id>.png, adds the bitmap/shape/sprite/export to the scene file, and buildSwf then draws it (DefineBitsLossless2 of the PNG's size)", () => {
    cleanup();
    mkdirSync(modDir, { recursive: true });
    try {
      const ns = A.newArtScene(MOD, "rasterscene", { starter: false });
      assert(ns.ok, JSON.stringify(ns));
      const png = encodePng(6, 4, img(6, 4, (x) => [x * 40, 100, 200, 255]).rgba);
      const r = A.importBitmap({ mod: MOD, scenePath: ns.relPath, base64: Buffer.from(png).toString("base64"), id: "Pic", mode: "sprite", exportName: "PicEnemy" });
      assert(r.ok, JSON.stringify(r));
      eq(r.width, 6); eq(r.height, 4); eq(r.relPath, "art/Pic.png");
      assert(existsSync(join(modDir, "art", "Pic.png")), "png written");
      const rd = A.readArtScene(MOD, ns.relPath);
      eq(rd.scene.exports.PicEnemy, "PicClip");
      const b = A.buildSwf(MOD, ns.relPath, { writeSwflist: false });
      assert(b.ok, JSON.stringify(b.findings));
      const parsed = readSwf(new Uint8Array(readFileSync(join(modDir, "swfs", "rasterscene.swf"))));
      const bm = (flattenTags(parsed.tags) as any[]).find((t) => t.bitmap);
      eq(`${bm.bitmap.width}x${bm.bitmap.height}`, "6x4");
    } finally { cleanup(); }
  });

  test("api.importBitmap without scenePath only checks the PNG (dims + findings, nothing written); a bad PNG is ok:false with bitmap-unsupported-format", () => {
    cleanup();
    const png = encodePng(3, 5, new Uint8Array(60).fill(128));
    const r = A.importBitmap({ base64: Buffer.from(png).toString("base64") });
    assert(r.ok, JSON.stringify(r)); eq(r.width, 3); eq(r.height, 5);
    assert(!existsSync(modDir), "nothing written");
    const bad = A.importBitmap({ base64: Buffer.from([1, 2, 3]).toString("base64") });
    assert(!bad.ok); eq(bad.findings[0].code, "bitmap-unsupported-format");
  });

  test("api.importBitmap { mod, file } reads an existing PNG inside the mod (mods/_artprobe/art/checker.png: 8×8) without copying it", () => {
    const r = A.importBitmap({ mod: "_artprobe", file: "art/checker.png" });
    assert(r.ok, JSON.stringify(r)); eq(`${r.width}x${r.height}`, "8x8"); eq(r.relPath, "art/checker.png");
  });

  test("MCP tools.ts registers import_bitmap (schema + handler over api.importBitmap)", () => {
    const src = readFileSync(join(HERE, "..", "src", "mcp", "tools.ts"), "utf8");
    assert(/"import_bitmap"/.test(src) && /api\.importBitmap\(/.test(src), "import_bitmap missing from src/mcp/tools.ts");
  });

  test("web: POST /api/art/import-bitmap has a body schema and a route; Art mode has an Import PNG… control", () => {
    const schemas = readFileSync(join(HERE, "..", "src", "core", "api-schemas.ts"), "utf8");
    const server = readFileSync(join(HERE, "..", "web", "server.ts"), "utf8");
    assert(/"\/api\/art\/import-bitmap"/.test(schemas), "schema");
    assert(/\/api\/art\/import-bitmap/.test(server), "route");
    const ui = readdirSync(join(HERE, "..", "web", "src", "art")).map((f) => readFileSync(join(HERE, "..", "web", "src", "art", f), "utf8")).join("\n");
    assert(/Import PNG/.test(ui), "no Import PNG… control in web/src/art");
  });

  // ---- T1: what vanilla does with raster ------------------------------------------------------------------------
  const vdir = vanillaSwfDir();
  const fxPath = join(HERE, "fixtures", "art", "vanilla-raster.json");
  const fx = (existsSync(fxPath) ? JSON.parse(readFileSync(fxPath, "utf8")) : { files: {}, formats: [], jpeg: -1, alleyBackground: {} }) as { files: Record<string, { bitmaps: number; maxWidth: number; maxHeight: number; fillTypes: string[] }>; formats: number[]; jpeg: number; alleyBackground: { file: string; export: string; frames: number; bitmap: string; scale: number } };
  test("fixture vanilla-raster.json: every vanilla bitmap is lossless format 5, none is JPEG, all fit the 4096 atlas page, fill types in use are 0x40 / 0x41 / 0x43", () => {
    eq(fx.formats.join(","), "5"); eq(fx.jpeg, 0);
    for (const [f, v] of Object.entries(fx.files)) { assert(v.maxWidth < 4096 && v.maxHeight < 4096, f); for (const t of v.fillTypes) assert(["0x40", "0x41", "0x43"].includes(t), `${f} ${t}`); }
    eq(fx.alleyBackground.bitmap, "2000x1500");
  });
  if (!existsSync(join(vdir, "backgrounds.swf"))) console.log(`  (skipped: vanilla SWFs not extracted at ${vdir})`);
  else test("T1: the fixture matches the installed game (bitmap census per file; AlleyBGTest = one 2000×1500 plate per frame scaled 0.7667, origin (0,0))", () => {
    if (!RC.vanillaRasterCensus) throw new Error(errs.join("; ") || "raster-census.ts missing");
    const census = RC.vanillaRasterCensus(vdir) as typeof fx;
    eq(JSON.stringify(census.files), JSON.stringify(fx.files));
    eq(census.formats.join(","), fx.formats.join(",")); eq(census.jpeg, fx.jpeg);
    eq(JSON.stringify(census.alleyBackground), JSON.stringify(fx.alleyBackground));
  });
  void decodePng;
}
