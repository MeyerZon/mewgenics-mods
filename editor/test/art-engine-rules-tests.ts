// The closed SWF display path as editor rules (RE session disp, 2026-10-21; docs/engine-map.md "SWF loader and
// display path"): what the loader FATALs on is a validator error, what it silently ignores is a warning, what the
// renderer does (even-odd per fill style, cxform after the palette remap, pad-only gradients, the 4096 atlas page)
// is what the preview draws. Scene-level codes live in validateScene / emitSwf; SWF-level codes in swf-rules.ts
// (inspect_swf and the build self-check) so hand-made SWFs are covered too.

import { deflateSync } from "node:zlib";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODS_DIR } from "../src/core/repo.ts";
import { BitWriter, TAG, tag } from "../src/core/art/swf-bits.ts";
import { readSwf } from "../src/core/art/swf-reader.ts";
import { emitSwf, minimalGateSwf, encodePlaceObject3, encodeSymbolList } from "../src/core/art/swf-emitter.ts";
import { encodeImportAssets2 } from "../src/core/art/text.ts";
import { exampleScene, validateScene } from "../src/core/art/scene.ts";
import { normalizePath } from "../src/core/art/geometry.ts";
import * as api from "../src/core/api.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** A gate SWF with extra framed tags spliced in right after the header (before FileAttributes). */
function withTags(extra: Uint8Array[]): Uint8Array {
  const base = minimalGateSwf({ withAbc: false, linkage: "RulesProbe", label: "idle" });
  const first = readSwf(base).tags[0]!.offset;
  const add = extra.reduce((n, t) => n + t.length, 0);
  const out = new Uint8Array(base.length + add);
  out.set(base.subarray(0, first), 0);
  let p = first;
  for (const t of extra) {
    out.set(t, p);
    p += t.length;
  }
  out.set(base.subarray(first), p);
  const len = out.length;
  out[4] = len & 0xff; out[5] = (len >>> 8) & 0xff; out[6] = (len >>> 16) & 0xff; out[7] = (len >>> 24) & 0xff;
  return out;
}

/** DefineBitsLossless2 (format 5) of a width×height opaque image. */
function lossless2(id: number, width: number, height: number): Uint8Array {
  const w = new BitWriter(16);
  w.u16(id); w.u8(5); w.u16(width); w.u16(height);
  w.bytes(new Uint8Array(deflateSync(new Uint8Array(width * height * 4).fill(255))));
  return tag(TAG.DefineBitsLossless2, w.finish(), true);
}

/** PlaceObject (tag 4): id 1 at depth 1, identity matrix, with or without a CXFORM. */
function placeObject1(cxform: boolean): Uint8Array {
  const w = new BitWriter(16);
  w.u16(1); w.u16(1);
  w.writeUB(1, 0); w.writeUB(1, 0); w.writeUB(5, 0); w.align(); // MATRIX: no scale, no rotate, 0 translate bits
  if (cxform) { w.writeUB(1, 0); w.writeUB(1, 1); w.writeUB(4, 2); w.writeSB(2, 1); w.writeSB(2, 1); w.writeSB(2, 1); w.align(); }
  return tag(TAG.PlaceObject, w.finish());
}

const u16tag = (code: number, id: number, rest: number[] = []) => tag(code, new Uint8Array([id & 0xff, id >> 8, ...rest]));

export async function runArtEngineRulesTests(test: TestFn, assert: AssertFn, eq: EqFn): Promise<void> {
  console.log("\n# Art: engine rules from the closed display path (validator codes, SWF inspection, preview fidelity)");
  let EB: Record<string, any> = {};
  let R: Record<string, any> = {};
  let S: Record<string, any> = {};
  let P: Record<string, any> = {};
  const errs: string[] = [];
  try { EB = await import("../src/core/art/engine-behaviour.ts"); } catch (e) { errs.push(`engine-behaviour.ts: ${e instanceof Error ? e.message : String(e)}`); }
  try { R = await import("../src/core/art/swf-rules.ts"); } catch (e) { errs.push(`swf-rules.ts: ${e instanceof Error ? e.message : String(e)}`); }
  try { S = await import("../src/core/art/shape.ts"); } catch (e) { errs.push(`shape.ts: ${e instanceof Error ? e.message : String(e)}`); }
  try { P = await import("../web/src/art/preview-gl.ts"); } catch (e) { errs.push(`preview-gl.ts: ${e instanceof Error ? e.message : String(e)}`); }
  const codesOf = (fs: Array<{ code: string; severity: string }>, sev?: string) => fs.filter((f) => !sev || f.severity === sev).map((f) => f.code);
  const findings = (bytes: Uint8Array) => R.swfFindings(readSwf(bytes).tags) as Array<{ code: string; severity: string; message: string; path?: string }>;

  // ---- the facts, in one place ------------------------------------------------------------------------------
  test("engine-behaviour.ts: fill rule even-odd (libtess2 TESS_WINDING_ODD at 0xa73bb0), cxform after the palette remap, gradients pad only, the emitter's bitmap fill type 0x41; TEXTURE_ATLAS_SIZE 4096 named after the texture_atlas_size setting", () => {
    assert(!errs.some((e) => e.startsWith("engine-behaviour")), errs.join("; "));
    eq(EB.ENGINE_DRAWING.fillRule, "evenodd");
    eq(EB.ENGINE_DRAWING.cxformOrder, "after-remap");
    eq(EB.ENGINE_DRAWING.gradientSpread, "pad");
    eq(EB.ENGINE_DRAWING.bitmapFillType, 0x41);
    eq(EB.TEXTURE_ATLAS_SIZE, 4096);
    eq(EB.TEXTURE_ATLAS_SETTING, "texture_atlas_size");
    assert(EB.bitmapFitsAtlas(4095, 4095) === true && EB.bitmapFitsAtlas(4096, 1) === false && EB.bitmapFitsAtlas(1, 4096) === false, "a bitmap must be strictly smaller than the page in both dimensions (fit_texture 0xa24540)");
  });

  // ---- SWF-level rules (swf-rules.ts): one fixture per code ------------------------------------------------------
  test("swfFindings: a plain emitted gate SWF has no findings", () => {
    assert(!errs.some((e) => e.startsWith("swf-rules")), errs.join("; "));
    eq(findings(withTags([])).length, 0);
  });
  test("font-tag-unsupported (error): DefineFont (10) and DefineFont2 (48) are FATAL in-game, only DefineFont3 decodes", () => {
    const fs = findings(withTags([u16tag(10, 7, [0, 0]), u16tag(48, 8, [0, 0, 0])]));
    eq(codesOf(fs, "error").filter((c) => c === "font-tag-unsupported").length, 2);
    assert(/DefineFont version unsupported/.test(fs[0]!.message) && /DefineFont3/.test(fs[0]!.message), fs[0]!.message);
    eq(findings(withTags([u16tag(TAG.DefineFont3, 9, [0, 0, 0, 0])])).filter((f) => f.code === "font-tag-unsupported").length, 0, "DefineFont3 is accepted");
  });
  test("abc-count (error): more than one DoABC is FATAL ('Multiple DoABC tags in one SWF'); one is fine", () => {
    const abc = tag(TAG.DoABC, new Uint8Array([1, 0, 0, 0, 0, 0x10, 0, 0x2e, 0]));
    eq(codesOf(findings(withTags([abc])), "error").filter((c) => c === "abc-count").length, 0);
    const fs = findings(withTags([abc, abc]));
    eq(codesOf(fs, "error").filter((c) => c === "abc-count").length, 1);
    assert(/Multiple DoABC/.test(fs.find((f) => f.code === "abc-count")!.message), "quotes the game's assert");
  });
  test("bitmap-too-large (error): a DefineBitsLossless/2 with width or height >= TEXTURE_ATLAS_SIZE cannot fit the atlas page; the message names the setting", () => {
    const fs = findings(withTags([lossless2(5, 4096, 1), lossless2(6, 1, 4096), lossless2(7, 4095, 2)]));
    const big = fs.filter((f) => f.code === "bitmap-too-large");
    eq(big.length, 2);
    assert(big.every((f) => f.severity === "error" && /texture_atlas_size/.test(f.message) && /4096/.test(f.message) && /could not fit into atlas/.test(f.message)), JSON.stringify(big));
  });
  test("filter-unsupported (error): a PlaceObject3 filter list is FATAL ('ERROR: FILTERS NOT SUPPORTED'), also when the SWF was not built here", () => {
    const po3 = encodePlaceObject3({ move: false, depth: 1, characterId: 1, filters: [{ type: "blur", blurX: 2, blurY: 2 }] });
    eq(codesOf(findings(withTags([po3])), "error").filter((c) => c === "filter-unsupported").length, 1);
    const blendOnly = encodePlaceObject3({ move: false, depth: 1, characterId: 1, blend: "add" });
    eq(findings(withTags([blendOnly])).filter((f) => f.code === "filter-unsupported").length, 0);
  });
  test("import-unsupported (error): ImportAssets (57) / ImportAssets2 (71) entries are never linked (placing one crashes); the zero-asset fonts.swf declaration is fine", () => {
    const im2 = encodeImportAssets2("catparts.swf", [{ id: 9, name: "CatTail" }]);
    const w = new BitWriter(32); w.string("catparts.swf"); w.u16(1); w.u16(9); w.string("CatTail");
    const im1 = tag(57, w.finish());
    const fs = findings(withTags([im1, im2]));
    eq(codesOf(fs, "error").filter((c) => c === "import-unsupported").length, 2);
    eq(findings(withTags([encodeImportAssets2("fonts.swf", [])])).filter((f) => f.code === "import-unsupported").length, 0);
  });
  test("scaling-grid-ignored (warning): DefineScalingGrid (78) is not in the loader's switch, so there is no 9-slice", () => {
    const fs = findings(withTags([u16tag(TAG.DefineScalingGrid, 3, [0])]));
    eq(codesOf(fs, "warning").filter((c) => c === "scaling-grid-ignored").length, 1);
  });
  test("gradient-spread-ignored (warning): a gradient fill with spread reflect/repeat draws padded (no reflect/repeat in the rasterizer or the shader)", () => {
    const sc = exampleScene("sp") as any;
    sc.gradients = { g: { kind: "linear", x1: 0, y1: 0, x2: 40, y2: 0, spread: "repeat", stops: [{ offset: 0, color: "gray:2" }, { offset: 1, color: "gray:12" }] } };
    sc.shapes.body.paths[0].fill = "gradient:g";
    const out = emitSwf(validateScene(sc).scene);
    const fs = findings(out.bytes);
    eq(codesOf(fs, "warning").filter((c) => c === "gradient-spread-ignored").length, 1);
    sc.gradients.g.spread = "pad";
    eq(findings(emitSwf(validateScene(sc).scene).bytes).filter((f) => f.code === "gradient-spread-ignored").length, 0);
  });
  test("morph-shape-skipped (warning): DefineMorphShape (46) / DefineMorphShape2 (84) log 'SHAPE TWEEN NOT SUPPORTED' and are skipped", () => {
    const fs = findings(withTags([u16tag(46, 4, [0, 0, 0]), u16tag(84, 5, [0, 0, 0])]));
    eq(codesOf(fs, "warning").filter((c) => c === "morph-shape-skipped").length, 2);
  });
  test("place-cxform-ignored (warning): PlaceObject (tag 4) with a CXFORM draws with an identity cxform ('color transform not supported on PlaceObject1'); without one, nothing to say", () => {
    eq(codesOf(findings(withTags([placeObject1(true)])), "warning").filter((c) => c === "place-cxform-ignored").length, 1);
    eq(findings(withTags([placeObject1(false)])).filter((f) => f.code === "place-cxform-ignored").length, 0);
  });
  test("fill-rule-ignored (warning): a DefineShape4 with UsesFillWindingRule set — the engine never reads the flag and fills even-odd", () => {
    const shape4 = tag(TAG.DefineShape4, new Uint8Array([1, 0, 0, 0, 0x04, 0, 0, 0, 0]));
    eq(codesOf(findings(withTags([shape4])), "warning").filter((c) => c === "fill-rule-ignored").length, 1);
    const plain = tag(TAG.DefineShape4, new Uint8Array([1, 0, 0, 0, 0x01, 0, 0, 0, 0]));
    eq(findings(withTags([plain])).filter((f) => f.code === "fill-rule-ignored").length, 0);
  });
  test("export-shadows-vanilla (info): a SymbolClass / ExportAssets name that a vanilla SWF exports replaces it for every by-name lookup (last-loaded file first) — INFERRED, says so", () => {
    const fs = findings(withTags([tag(TAG.SymbolClass, encodeSymbolList([{ id: 1, name: "CatTail" }])), tag(TAG.ExportAssets, encodeSymbolList([{ id: 1, name: "CatBody" }]))]));
    const sh = fs.filter((f) => f.code === "export-shadows-vanilla");
    eq(sh.length, 2);
    assert(sh.every((f) => f.severity === "info" && /catparts\.swf/.test(f.message) && /last[- ]loaded/i.test(f.message) && /INFERRED/.test(f.message)), JSON.stringify(sh));
  });
  test("jpeg-bitmap (info): DefineBits / DefineBitsJPEG2/3/4 decode but the game logs 'TEXTURE ENCODED AS JPG INSTEAD OF PNG'", () => {
    const fs = findings(withTags([u16tag(21, 2, [0xff, 0xd8]), u16tag(6, 3, [0xff, 0xd8])]));
    eq(codesOf(fs, "info").filter((c) => c === "jpeg-bitmap").length, 2);
  });
  test("tag-ignored (info): a tag outside the loader's switch is skipped silently (DefineBinaryData 87); the metadata tags every file carries are not reported", () => {
    const fs = findings(withTags([tag(87, new Uint8Array([1, 0, 0, 0, 0, 0]))]));
    eq(codesOf(fs, "info").filter((c) => c === "tag-ignored").length, 1);
    assert(/87/.test(fs.find((f) => f.code === "tag-ignored")!.message), "names the tag code");
  });
  test("swfFindings walks DefineSprite children and reports the tag path", () => {
    const inner = Buffer.concat([placeObject1(true), tag(TAG.ShowFrame, new Uint8Array(0)), tag(TAG.End, new Uint8Array(0))]);
    const w = new BitWriter(8 + inner.length); w.u16(40); w.u16(1); w.bytes(new Uint8Array(inner));
    const fs = findings(withTags([tag(TAG.DefineSprite, w.finish(), true)]));
    const f = fs.find((x) => x.code === "place-cxform-ignored");
    assert(!!f && /^tags\[\d+\]\.tags\[0\]$/.test(f.path || ""), JSON.stringify(fs));
  });
  test("SWF_RULE_CODES lists every code with its severity and where it applies (scene / swf), for the docs and the skill", () => {
    const codes = R.SWF_RULE_CODES as Record<string, { severity: string; where: string[] }>;
    for (const c of ["font-tag-unsupported", "abc-count", "bitmap-too-large", "filter-unsupported", "import-unsupported", "scaling-grid-ignored", "gradient-spread-ignored", "morph-shape-skipped", "place-cxform-ignored", "fill-rule-ignored", "export-shadows-vanilla", "jpeg-bitmap", "tag-ignored"]) assert(!!codes[c], `${c} listed`);
    eq(codes["bitmap-too-large"]!.where.join("+"), "scene+swf");
    eq(codes["morph-shape-skipped"]!.where.join("+"), "swf");
  });

  // ---- scene-level rules ------------------------------------------------------------------------------------------
  test("validateScene: gradient-spread-ignored (warning) for spread reflect/repeat, at gradients.<id>.spread; pad is silent", () => {
    const sc = exampleScene("sp") as any;
    sc.gradients = { g: { kind: "radial", cx: 0, cy: 0, r: 10, spread: "reflect", stops: [{ offset: 0, color: "gray:2" }, { offset: 1, color: "gray:12" }] } };
    const v = validateScene(sc) as any;
    const f = v.findings.find((x: any) => x.code === "gradient-spread-ignored");
    assert(!!f && f.severity === "warning" && f.path === "gradients.g.spread" && /pad/.test(f.message), JSON.stringify(v.findings));
    sc.gradients.g.spread = "pad";
    eq((validateScene(sc) as any).findings.filter((x: any) => x.code === "gradient-spread-ignored").length, 0);
  });
  test("validateScene: export-shadows-vanilla (info) when an export name equals a pinned vanilla export; says the mod's clip wins (last-loaded first) and that it is INFERRED", () => {
    const sc = exampleScene("sh") as any;
    sc.exports = { CatTail: "Starter", Starter: "Starter" };
    const v = validateScene(sc) as any;
    const f = v.findings.filter((x: any) => x.code === "export-shadows-vanilla");
    eq(f.length, 1);
    assert(f[0].severity === "info" && f[0].path === "exports.CatTail" && /catparts\.swf/.test(f[0].message) && /last[- ]loaded/i.test(f[0].message) && /INFERRED/.test(f[0].message), JSON.stringify(f));
    assert(v.ok, "an info does not fail validation");
  });
  test("validateScene: fill-rule-ignored (warning) only where nonzero and the engine's even-odd differ: partially overlapping sub-paths or a self-overlapping sub-path; a ring (outer + hole) and evenodd paths are silent", () => {
    const sq = (x: number, y: number, s: number) => `M${x} ${y} L${x + s} ${y} L${x + s} ${y + s} L${x} ${y + s} Z`;
    const scene = (d: string, fillRule: "nonzero" | "evenodd") => { const sc = exampleScene("fr") as any; sc.shapes.body.paths = [{ d, fill: "gray:8", fillRule }]; return validateScene(sc) as any; };
    const codes = (v: any) => v.findings.filter((x: any) => x.code === "fill-rule-ignored").map((x: any) => `${x.severity}@${x.path}`);
    eq(codes(scene(sq(0, 0, 40) + " " + sq(20, 20, 40), "nonzero")).join(","), "warning@shapes.body.paths[0].fillRule", "two overlapping squares: a hole in-game");
    eq(codes(scene(sq(0, 0, 40) + " " + sq(20, 20, 40), "evenodd")).length, 0, "authored even-odd: the hole is intended");
    eq(codes(scene(sq(0, 0, 40) + " " + sq(10, 10, 20), "nonzero")).length, 0, "nested same-winding squares: the emitter drops the inner one, the engine draws a disc");
    eq(codes(scene(sq(0, 0, 40) + " M10 10 L10 30 L30 30 L30 10 Z", "nonzero")).length, 0, "a ring (opposite winding): fine under both rules");
    eq(codes(scene("M0 0 L60 0 L60 40 L20 40 L20 20 L40 20 L40 60 L0 60 Z", "nonzero")).length, 1, "a self-overlapping sub-path: the doubly covered part is a hole in-game");
    eq(codes(scene(sq(0, 0, 40) + " " + sq(50, 0, 40), "nonzero")).length, 0, "disjoint sub-paths");
    const v = scene(sq(0, 0, 40) + " " + sq(20, 20, 40), "nonzero");
    assert(/even-odd/.test(v.findings.find((x: any) => x.code === "fill-rule-ignored").message), "explains the engine rule");
  });
  test("emitSwf: bitmap-too-large (error) for a decoded bitmap >= TEXTURE_ATLAS_SIZE in either dimension; the message names texture_atlas_size", () => {
    const sc = exampleScene("bm") as any;
    sc.bitmaps = { tex: { file: "art/tex.png" } };
    sc.shapes.body.paths[0].fill = "bitmap:tex";
    const scene = validateScene(sc).scene;
    const img = (width: number, height: number) => ({ width, height, rgba: new Uint8Array(width * height * 4) });
    const big = emitSwf(scene, { bitmaps: new Map([["tex", img(4096, 1)]]) });
    const f = big.findings.find((x) => x.code === "bitmap-too-large");
    assert(!!f && f.severity === "error" && f.path === "bitmaps.tex" && /texture_atlas_size/.test(f.message) && /4096/.test(f.message), JSON.stringify(big.findings));
    const ok = emitSwf(scene, { bitmaps: new Map([["tex", img(4095, 2)]]) });
    eq(ok.findings.filter((x) => x.code === "bitmap-too-large").length, 0);
  });

  // ---- the inspect / build surfaces -------------------------------------------------------------------------------
  {
    const tmpMod = "__art_rules_tmp";
    const tmpDir = join(MODS_DIR, tmpMod);
    rmSync(tmpDir, { recursive: true, force: true });
    try {
      test("inspectSwf returns findings from the SWF rules (a hand-made SWF with a DefineFont2 → font-tag-unsupported)", () => {
        mkdirSync(join(tmpDir, "swfs"), { recursive: true });
        writeFileSync(join(tmpDir, "swfs", "hand.swf"), withTags([u16tag(48, 8, [0, 0, 0])]));
        const ins = api.inspectSwf(tmpMod, "swfs/hand.swf") as unknown as { ok: boolean; findings?: Array<{ code: string; severity: string }> };
        assert(ins.ok && Array.isArray(ins.findings), JSON.stringify(ins));
        eq(ins.findings!.filter((f) => f.code === "font-tag-unsupported" && f.severity === "error").length, 1);
      });
      test("buildSwf re-reads its output through the SWF rules and merges them without duplicating a code the scene already reported (export-shadows-vanilla once)", () => {
        const sc = exampleScene("shadow") as any;
        sc.exports = { CatTail: "Starter" };
        const r = api.buildSwf(tmpMod, "art/shadow.scene.json", { dryRun: true, overrideScene: sc });
        assert(r.ok, r.error || "");
        eq(r.findings.filter((f) => f.code === "export-shadows-vanilla").length, 1);
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // ---- preview fidelity ---------------------------------------------------------------------------------------------
  test("shape.ts fillSubpathMask(subs, fillRule): the sub-paths that carry the fill in the SWF (the emitter's side assignment); the engine fills them even-odd", () => {
    assert(typeof S.fillSubpathMask === "function", "exported");
    const ring = normalizePath("M0 0 L40 0 L40 40 L0 40 Z M10 10 L10 30 L30 30 L30 10 Z");
    eq(JSON.stringify(S.fillSubpathMask(ring, "nonzero")), "[true,true]");
    const nested = normalizePath("M0 0 L40 0 L40 40 L0 40 Z M10 10 L30 10 L30 30 L10 30 Z");
    eq(JSON.stringify(S.fillSubpathMask(nested, "nonzero")), "[true,false]", "nonzero: the inner same-winding square is dropped (solid disc in-game)");
    eq(JSON.stringify(S.fillSubpathMask(nested, "evenodd")), "[true,true]", "evenodd: both kept (a ring in-game)");
    eq(JSON.stringify(S.fillSubpathMask(nested, undefined)), "[true,false]", "default rule is nonzero");
  });
  test("preview-gl.ts fills shapes even-odd over fillSubpathMask's sub-paths (ENGINE_DRAWING.fillRule), pads every gradient (ENGINE_DRAWING.gradientSpread), and strokes every sub-path", () => {
    const src = readFileSync(join(HERE, "..", "web", "src", "art", "preview-gl.ts"), "utf8");
    assert(/import \{[^}]*ENGINE_DRAWING[^}]*\} from "..\/..\/..\/src\/core\/art\/engine-behaviour\.ts"/.test(src), "imports ENGINE_DRAWING");
    assert(/import \{[^}]*fillSubpathMask[^}]*\} from "..\/..\/..\/src\/core\/art\/shape\.ts"/.test(src), "imports fillSubpathMask");
    assert(/fillSubpathMask\(subs, p\.fillRule\)/.test(src), "prepareShape asks shape.ts which sub-paths carry the fill");
    assert(/ENGINE_DRAWING\.fillRule/.test(src), "the fill rule comes from engine-behaviour.ts");
    assert(!/glFill\(polys, path\.fillRule/.test(src) && !/c\.(fill|clip)\(p2, path\.fillRule\)/.test(src), "no fill or clip uses the authored rule directly");
    assert(/ENGINE_DRAWING\.gradientSpread/.test(src), "gradient spread follows engine-behaviour.ts");
    assert(!/spread: swfSpread\(gd\.spread\)/.test(src), "the GL gradient uniform no longer carries the authored spread");
  });
  test("preview-gl.ts remapColor: the cxform applies after the palette remap (OBSERVED in paletted_full.shader), on both renderers' colour path", () => {
    assert(!errs.some((e) => e.startsWith("preview-gl")), errs.join("; "));
    const rows: Array<Array<[number, number, number]>> = [];
    rows[3] = Array.from({ length: 16 }, (_, i) => (i === 8 ? [10, 20, 30] : [i * 17, i * 17, i * 17]) as [number, number, number]);
    const pal = P.paletteBytes(rows) as Uint8Array;
    const out = P.remapColor({ r: 136, g: 136, b: 136, a: 255 }, { mul: [2, 2, 2, 1], add: [0, 0, 0, 0] }, pal, 3, false) as number[];
    eq(out.slice(0, 3).join(","), "20,40,60", "remap gray:8 → (10,20,30), then × 2; a remap after the cxform would read column 15 or pass through");
  });
}
