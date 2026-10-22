// The raster + font probe (src/core/art/probe-raster.ts): the scene it builds (committed as
// mods/_artprobe/art/raster.scene.json), the small PNGs it commits and the big ones it generates, the probe mods'
// data (_artprobe enemies / custom cat, _bgprobe's combat_background redirect), the scripts, and the measures on
// synthetic shots (the real shots are read by `npm run test:artprobe -- --raster`; the summary is pinned as a fixture).
// Plus the preview's share: bitmap repeat / pixel-snapped sampling and texts in a scene font.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODS_DIR, REPO_ROOT } from "../src/core/repo.ts";
import { validateScene } from "../src/core/art/scene.ts";
import { readSwf, flattenTags } from "../src/core/art/swf-reader.ts";
import { emitSwf } from "../src/core/art/swf-emitter.ts";
import { swfFindings } from "../src/core/art/swf-rules.ts";
import { decodePng } from "../src/core/art/png.ts";
import { parseScript } from "../src/core/ingame/script.ts";
import { validateMod } from "../src/core/validate/validator.ts";
import { EXTRACTED_DATA } from "../src/core/repo.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

type Rgb = [number, number, number];
type Img = { width: number; height: number; rgba: Uint8Array };
function blank(w: number, h: number, c: Rgb = [40, 40, 50]): Img { const rgba = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) { rgba[i * 4] = c[0]; rgba[i * 4 + 1] = c[1]; rgba[i * 4 + 2] = c[2]; rgba[i * 4 + 3] = 255; } return { width: w, height: h, rgba }; }

export async function runArtRasterProbeTests(test: TestFn, assert: AssertFn, eq: EqFn): Promise<void> {
  console.log("\n# Art: the raster + font probe (scene, images, probe mods, measures) and the preview's raster / font support");
  let P: Record<string, any> = {};
  let err = "";
  try { P = await import("../src/core/art/probe-raster.ts"); } catch (e) { err = e instanceof Error ? e.message : String(e); }
  const need = () => { if (err) throw new Error(`probe-raster.ts: ${err}`); };
  const art = join(MODS_DIR, "_artprobe", "art");
  const catSlotKeys = () => {
    const probe = JSON.parse(readFileSync(join(art, "probe.scene.json"), "utf8")) as any;
    return Object.fromEntries(probe.sprites.CatProbe.layers.filter((l: any) => l.name !== "marker").map((l: any) => [l.name, l.keys[0]]));
  };

  test("rasterProbeScene validates (no errors) and is what mods/_artprobe/art/raster.scene.json holds (regenerate from probe-raster.ts)", () => {
    need();
    const sc = P.rasterProbeScene(catSlotKeys());
    const v = validateScene(JSON.parse(JSON.stringify(sc))) as any;
    assert(v.ok, JSON.stringify(v.findings.filter((f: any) => f.severity === "error")));
    const file = join(art, "raster.scene.json");
    assert(existsSync(file), "raster.scene.json committed");
    eq(JSON.stringify(JSON.parse(readFileSync(file, "utf8"))), JSON.stringify(v.scene));
  });

  test("the committed small PNGs (art/raster-*.png) are rasterProbeImages().small, each under 1 KB; the big ones are generated into the git-ignored art/generated/", () => {
    need();
    const imgs = P.rasterProbeImages();
    for (const [name, im] of Object.entries(imgs.small) as Array<[string, Img]>) {
      const f = join(art, `raster-${name}.png`);
      assert(existsSync(f), f);
      const bytes = readFileSync(f);
      assert(bytes.length < 1024, `${f} is ${bytes.length} bytes`);
      const d = decodePng(new Uint8Array(bytes));
      eq(`${d.width}x${d.height}`, `${im.width}x${im.height}`);
      eq(Buffer.from(d.rgba).equals(Buffer.from(im.rgba)), true, name);
    }
    const gi = readFileSync(join(REPO_ROOT, ".gitignore"), "utf8");
    assert(/mods\/\*\/art\/generated\//.test(gi), ".gitignore covers mods/*/art/generated/");
    eq(`${imgs.generated.rasterbig.width}x${imgs.generated.rasterbig.height}`, "1024x768");
    eq(`${imgs.generated.backdrop.width}x${imgs.generated.backdrop.height}`, "2000x1500");
  });

  test("the emitted raster.swf: fill types 0x41 / 0x43 (stripes) / 0x40 (tile), the DefineFont3 ProbeBlocks exported, the four exports; the loader rules are clean; patchMissingFontClass renames exactly one class and then font-class-unknown fires", () => {
    need();
    const v = validateScene(JSON.parse(JSON.stringify(P.rasterProbeScene(catSlotKeys())))) as any;
    const imgs = P.rasterProbeImages();
    const bitmaps = new Map<string, Img>([["checkerbmp", decodePng(new Uint8Array(readFileSync(join(art, "checker.png"))))], ["quadbmp", imgs.small.quad], ["stripebmp", imgs.small.stripe], ["stripesnapbmp", imgs.small.stripe], ["tilebmp", imgs.small.tile], ["gray16bmp", imgs.small.gray16], ["bigbmp", imgs.generated.rasterbig], ["backdropbmp", imgs.generated.backdrop]]);
    const out = emitSwf(v.scene, { bitmaps });
    assert(!out.findings.some((f: any) => f.severity === "error"), JSON.stringify(out.findings));
    const tags = readSwf(out.bytes).tags as any[];
    const types = new Set(flattenTags(tags).flatMap((t: any) => (t.shape ? t.shape.fillStyles.map((f: any) => f.type) : [])));
    for (const t of [0x40, 0x41, 0x43]) assert(types.has(t), `fill type 0x${t.toString(16)}`);
    const font = tags.find((t) => t.code === 75);
    eq(font.font.codes, " HI");
    const names = tags.find((t) => t.code === 76).entries.map((e: any) => e.name).sort().join(",");
    eq(names, "ArtProbeBackdrop,ArtProbeFontMissing,ArtProbeRaster,ProbeBlocks,_Append_CatTest");
    const errs = swfFindings(tags).filter((f) => f.severity !== "info");
    eq(errs.length, 0, JSON.stringify(errs));
    const p = P.patchMissingFontClass(out.bytes);
    eq(p.patched, 1);
    assert(swfFindings(readSwf(p.bytes).tags).some((f) => f.code === "font-class-unknown"), "font-class-unknown after the patch");
  });

  test("probe mod data: _artprobe enemies ArtProbeRaster / ArtProbeFontMissing (Rat variants) and ArtProbeRasterCat (a _CAT whose idle is probeRaster, custom cat ArtProbeRasterCat with palette 54); _bgprobe points alley's combat_background at ArtProbeBackdrop", () => {
    const en = readFileSync(join(MODS_DIR, "_artprobe", "data", "characters", "enemies.gon.append"), "utf8");
    for (const n of ["ArtProbeRaster", "ArtProbeFontMissing", "ArtProbeRasterCat"]) assert(new RegExp(`^${n} \\{`, "m").test(en), n);
    assert(/alt_animations \[\[idle probeRaster\]\]/.test(en) && /custom_cat_data ArtProbeRasterCat/.test(en), "ArtProbeRasterCat idle + custom cat");
    const cc = readFileSync(join(MODS_DIR, "_artprobe", "data", "custom_cats.gon.append"), "utf8");
    assert(/ArtProbeRasterCat \{[^}]*palette 54/s.test(cc), cc);
    const ts = readFileSync(join(MODS_DIR, "_bgprobe", "data", "tilesets.gon.merge"), "utf8");
    assert(/alley \{\s*combat_background ArtProbeBackdrop\s*\}/.test(ts.replace(/\/\/[^\n]*/g, "")), ts);
  });

  test("probe scripts parse and spawn the probe units: render-raster (ArtProbeRaster), render-raster-cat (ArtProbeRasterCat), render-font-missing (ArtProbeFontMissing), _bgprobe/render-backdrop (no spawn, mods _artprobe + _bgprobe)", () => {
    const read = (mod: string, n: string) => parseScript(readFileSync(join(MODS_DIR, mod, "tests", `${n}.mewtest`), "utf8"), { owningMod: mod, name: n }) as any;
    for (const [mod, n, unit] of [["_artprobe", "render-raster", "ArtProbeRaster"], ["_artprobe", "render-raster-cat", "ArtProbeRasterCat"], ["_artprobe", "render-font-missing", "ArtProbeFontMissing"], ["_bgprobe", "render-backdrop", null]] as const) {
      const s = read(mod, n);
      assert(!s.errors || !s.errors.length, `${n}: ${JSON.stringify(s.errors)}`);
      const text = readFileSync(join(MODS_DIR, mod, "tests", `${n}.mewtest`), "utf8");
      if (unit) assert(new RegExp(`cmd spawn ${unit}\\b`).test(text), `${n} spawns ${unit}`);
      assert(/shot "/.test(text) && /hide: false/.test(text), `${n} takes shots`);
      if (mod === "_bgprobe") assert(/mods: _artprobe, _bgprobe/.test(text), "loads both mods");
    }
  });

  if (!existsSync(join(EXTRACTED_DATA, "tilesets.gon"))) console.log("  (skipped: base data absent — _bgprobe / _artprobe T1 validation)");
  else test("T1: _bgprobe and _artprobe validate with zero errors (tilesets.gon / custom_cats.gon overlay targets exist)", () => {
    for (const m of ["_bgprobe", "_artprobe"]) { const r = validateMod(m); assert(r.ok, `${m}: ${JSON.stringify(r.findings.filter((f) => f.severity === "error"))}`); }
  });

  // ---- measures on synthetic shots -----------------------------------------------------------------------------
  const geo = (mirrored: boolean) => ({ box: { x0: 1000, y0: 600, x1: 1000 + Math.round(96 * 1.5) - 1, y1: 600 + 96 - 1 }, scale: 1.5, mirrored });
  /** paint a clip-space rect (offsets from the marker) with f(u, v) where u, v in [0, 1) across it */
  const paintClip = (img: Img, g: any, x: number, y: number, w: number, h: number, f: (u: number, v: number) => Rgb) => {
    for (let j = 0; j < h * g.scale; j++) for (let i = 0; i < w * g.scale; i++) {
      const cx = x + i / g.scale, cy = y + j / g.scale;
      const [sx, sy] = P.clipToScreen(g, cx, cy);
      const X = Math.round(sx), Y = Math.round(sy);
      if (X < 0 || Y < 0 || X >= img.width || Y >= img.height) continue;
      const c = f((cx - x) / w, (cy - y) / h);
      const k = (Y * img.width + X) * 4;
      img.rgba[k] = c[0]; img.rgba[k + 1] = c[1]; img.rgba[k + 2] = c[2];
    }
  };
  const synthRaster = (mirrored: boolean, opts: { smoothBoth?: boolean; clamp?: boolean; aliased?: boolean; font?: "blocks" | "letters" | "none" }) => {
    need();
    const R = P.RASTER_PROBE;
    const g = geo(mirrored);
    const img = blank(2000, 1200);
    const tint = 0.8;
    const T = (c: Rgb): Rgb => [Math.round(c[0] * tint), Math.round(c[1] * tint), Math.round(c[2] * tint)];
    const q = R.quadColours;
    paintClip(img, g, R.quad.x, R.quad.y, R.quad.size, R.quad.size, (u, v) => T(v < 0.5 ? (u < 0.5 ? q.tl : q.tr) : u < 0.5 ? q.bl : q.br));
    const smooth = (u: number): Rgb => { const t = u * 4 - 0.5; const k = Math.floor(t); const fr = t - k; const a = ((k % 2) + 2) % 2 ? [0, 0, 255] : [255, 0, 0]; const b = ((k + 1) % 2 + 2) % 2 ? [0, 0, 255] : [255, 0, 0]; return T([0, 1, 2].map((i) => Math.round(a[i]! * (1 - fr) + b[i]! * fr)) as Rgb); };
    const hard = (u: number): Rgb => T(Math.floor(u * 4) % 2 ? [0, 0, 255] : [255, 0, 0]);
    paintClip(img, g, R.stripeSmooth.x, R.stripeSmooth.y, R.stripeSmooth.w, R.stripeSmooth.h, (u) => smooth(u));
    paintClip(img, g, R.stripeSnapped.x, R.stripeSnapped.y, R.stripeSnapped.w, R.stripeSnapped.h, (u) => (opts.smoothBoth ? smooth(u) : hard(u)));
    paintClip(img, g, R.tile.x, R.tile.y, R.tile.w, R.tile.h, (u, v) => { const tx = Math.floor((u * R.tile.w) / (R.tile.period / 2)), ty = Math.floor((v * R.tile.h) / (R.tile.period / 2)); if (opts.clamp) return T(u * R.tile.w < R.tile.period / 2 ? [255, 0, 0] : [0, 0, 255]); return T((tx + ty) % 2 ? [0, 0, 255] : [255, 0, 0]); });
    const b = R.bigColours;
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    paintClip(img, g, R.big.x, R.big.y, R.big.w, R.big.h, (u, v) => (u >= 0.5 && v >= 0.5 ? (opts.aliased ? (rnd() < 0.5 ? [0, 0, 0] : [230, 230, 230]) : [110, 110, 110]) : T(v >= 0.5 ? b.bl : u >= 0.5 ? b.tr : b.tl)));
    const orange: Rgb = T([255, 96, 0]);
    const s = R.text.size / 1024;
    const drawBlocks = (box: any, text: string) => { let x = box.x - box.w / 2 + 2; const top = box.y - box.h / 2 + 2 + 800 * s; for (const ch of text) { if (ch === "H") paintClip(img, g, x, top - 700 * s, 700 * s, 700 * s, () => orange); if (ch === "I") paintClip(img, g, x + 300 * s, top - 700 * s, 100 * s, 700 * s, () => orange); x += (ch === "H" ? 800 : ch === "I" ? 700 : 0) * s; } };
    if (opts.font === "blocks") { drawBlocks(R.text, R.text.text); drawBlocks(R.textMissing, "HH"); }
    if (opts.font === "letters") { for (let k = 0; k < 4; k++) paintClip(img, g, R.text.x - 100 + k * 30, R.text.y - 12, 3, 24, () => orange); }
    return { img, g };
  };

  test("measureRasterShot (synthetic, tinted ×0.8, as authored and mirrored): quad colours ok; smooth vs snapped stripes; the tile repeats; the checker block mipmapped; the block text is the embedded font; the missing glyph leaves two blobs", () => {
    for (const mirrored of [false, true]) {
      const { img, g } = synthRaster(mirrored, { font: "blocks" });
      const m = P.measureRasterShot(img, g);
      assert(m.quad.ok, JSON.stringify(m.quad));
      eq(m.stripes.verdict, "smooth-vs-snapped", JSON.stringify(m.stripes));
      eq(m.tile.verdict, "repeats", JSON.stringify(m.tile));
      eq(m.big.verdict, "mipmapped", JSON.stringify(m.big));
      eq(m.font.verdict, "embedded-font", JSON.stringify(m.font));
      eq(m.fontMissingGlyph.blobs.length, 2, JSON.stringify(m.fontMissingGlyph));
    }
  });

  test("measureRasterShot (synthetic): both stripes smooth → both-smooth; a streaked edge → clamped; a noisy checker → aliased; thin letter strokes → other-font; no ink → nothing", () => {
    const a = P.measureRasterShot(...Object.values(synthRaster(false, { smoothBoth: true, clamp: true, aliased: true, font: "letters" })) as [Img, any]);
    eq(a.stripes.verdict, "both-smooth"); eq(a.tile.verdict, "clamped"); eq(a.big.verdict, "aliased"); eq(a.font.verdict, "other-font");
    const b = P.measureRasterShot(...Object.values(synthRaster(false, { font: "none" })) as [Img, any]);
    eq(b.font.verdict, "nothing");
  });

  test("measureCatRamp (synthetic): vector cells in palette row colours and bitmap cells gray → vector remapped, bitmap gray; both in palette colours → both remapped", () => {
    need();
    const C = P.RASTER_PROBE.cat;
    const pal: Rgb[] = Array.from({ length: 16 }, (_, n) => (n === 0 ? [0, 0, 0] : n === 15 ? [255, 255, 255] : [177, 115 - n, 115 - n] as Rgb));
    for (const bitmapRemapped of [false, true]) {
      const g = geo(true);
      const img = blank(2000, 1200);
      const mx = C.marker.x, my = C.marker.y;
      paintClip(img, g, C.vectorRamp.x - mx, C.vectorRamp.y - my, C.vectorRamp.w, C.vectorRamp.h, (u) => { const n = Math.floor(u * 16); return pal[n]!.map((v) => Math.round(v * 0.7)) as Rgb; });
      paintClip(img, g, C.bitmapRamp.x - mx, C.bitmapRamp.y - my, C.bitmapRamp.w, C.bitmapRamp.h, (u) => { const n = Math.floor(u * 16); return bitmapRemapped ? pal[n]! : [n * 17, n * 17, n * 17]; });
      const m = P.measureCatRamp(img, g, pal);
      eq(m.vector, "remapped", JSON.stringify(m.levels.slice(0, 3)));
      eq(m.bitmap, bitmapRemapped ? "remapped" : "gray", JSON.stringify(m.levels.slice(0, 3)));
    }
  });

  test("backdropShare (synthetic): a shot half purple, half teal (tinted) reads ~0.5 / ~0.5; a brown shot reads 0 / 0", () => {
    need();
    const B = P.RASTER_PROBE.backdrop;
    const img = blank(400, 200);
    for (let y = 0; y < 200; y++) for (let x = 0; x < 400; x++) { const c = (x < 200 ? B.left : B.right).map((v: number) => Math.round(v * 0.9)); const k = (y * 400 + x) * 4; img.rgba[k] = c[0]; img.rgba[k + 1] = c[1]; img.rgba[k + 2] = c[2]; }
    const s = P.backdropShare(img);
    assert(s.left > 0.45 && s.right > 0.45, JSON.stringify(s));
    const z = P.backdropShare(blank(400, 200, [120, 90, 60]));
    eq(z.left + z.right, 0);
  });

  // ---- the preview -----------------------------------------------------------------------------------------------
  test("preview-gl draws the fill type per bitmap (bitmapFillType: repeat → fract(uv), pixel-snapped → texel centre, both in the shader) and lays a scene-font text out with layoutTextPaths", () => {
    const src = readFileSync(join(HERE, "..", "web", "src", "art", "preview-gl.ts"), "utf8");
    assert(/bitmapFillType/.test(src), "uses raster.ts bitmapFillType");
    assert(/fract\(/.test(src) && /u_bmMode/.test(src) && /u_bmSize/.test(src), "shader repeat + nearest");
    assert(/layoutTextPaths/.test(src), "scene-font texts drawn from glyph paths");
  });

  test("art-probe.ts has a --raster mode (builds raster.scene.json after writing the generated PNGs, patches probefm.swf, runs the four scripts, writes raster-summary.json)", () => {
    const src = readFileSync(join(HERE, "..", "scripts", "art-probe.ts"), "utf8");
    assert(/--raster/.test(src) && /raster-summary\.json/.test(src) && /patchMissingFontClass/.test(src) && /render-backdrop/.test(src), "art-probe --raster");
  });
}
