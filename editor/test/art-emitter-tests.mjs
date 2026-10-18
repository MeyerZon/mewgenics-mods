// Tests for the SWF emitter modules (src/core/art/*). Wired into run-tests.mjs as
//   import { runArtEmitterTests } from "./art-emitter-tests.mjs"; runArtEmitterTests(test, assert, eq);
// Vanilla-file checks read the game's SWFs from a scratchpad location (never from the repo)
// and skip when the files are absent; set MEWGENICS_VANILLA_SWF_DIR to point elsewhere.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { BitWriter, nbitsForSigned, nbitsForUnsigned, tag, writeMatrix, writeRect, concat } from "../src/core/art/swf-bits.mjs";
import { encodeDefineShape3, assignFillSides } from "../src/core/art/shape.mjs";
import { decodePng, encodePng, crc32 } from "../src/core/art/png.mjs";
import { encodeDefineBitsLossless2 } from "../src/core/art/lossless.mjs";
import { buildLinkageAbc, parseAbc, multinameToString } from "../src/core/art/abc-stub.mjs";
import { emitSwf, minimalGateSwf } from "../src/core/art/swf-emitter.mjs";
import { readSwf, readTags, shapeToSubpaths, flattenTags, BitReader } from "../src/core/art/swf-reader.mjs";
import { exampleScene, validateScene } from "../src/core/art/scene.mjs";
import { normalizePath, signedArea, flattenSubpath } from "../src/core/art/geometry.mjs";
import { bakeSprite, diffFrames } from "../src/core/art/timeline.mjs";

// Set MEWGENICS_VANILLA_SWF_DIR to a folder of extracted vanilla .swf files to enable the byte-diff tests;
// otherwise they skip. e.g. `python -I tools/gpak.py extract .extracted --prefix swfs/` then point this at it.
const VANILLA_DIR = process.env.MEWGENICS_VANILLA_SWF_DIR || "";

/** @param {string} name @returns {Uint8Array | null} */
function vanilla(name) {
  const p = join(VANILLA_DIR, name);
  if (!existsSync(p)) return null;
  return new Uint8Array(readFileSync(p));
}

/** @param {Uint8Array} b */
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");

/**
 * @param {(name: string, fn: () => void) => void} test
 * @param {(cond: boolean, msg: string) => void} assert
 * @param {(a: unknown, b: unknown, msg?: string) => void} eq
 */
export function runArtEmitterTests(test, assert, eq) {
  console.log("\n# Art: bit writer");
  test("writeUB packs MSB-first across byte boundaries", () => {
    const w = new BitWriter();
    w.writeUB(3, 0b101);
    w.writeUB(7, 0b1100110);
    w.writeUB(6, 0b111111);
    // 101 1100110 111111 → 1011 1001 1011 1111
    eq(hex(w.finish()), "b9 bf");
  });
  test("writeSB two's complement edge cases", () => {
    const w = new BitWriter();
    w.writeSB(1, -1);
    w.writeSB(2, -2);
    w.writeSB(3, 3);
    w.writeSB(4, -8);
    w.writeSB(5, 15);
    // 1 10 011 1000 01111 → 1100 1110 0001 111(0)
    eq(hex(w.finish()), "ce 1e");
    let threw = false;
    try {
      new BitWriter().writeSB(3, 4);
    } catch {
      threw = true;
    }
    assert(threw, "SB overflow must throw");
  });
  test("writeFB(1.0) in 18 bits is 0x00010000", () => {
    const w = new BitWriter();
    w.writeFB(18, 1.0);
    w.align();
    // 00 0100 0000 0000 0000 00 → 0100 0000 0000 0000 00(00 0000)
    eq(hex(w.finish()), "40 00 00");
    eq(nbitsForSigned([65536]), 18);
  });
  test("writeUB(32) handles the full unsigned range", () => {
    const w = new BitWriter();
    w.writeUB(32, 0xffffffff);
    w.writeUB(32, 0x80000001);
    eq(hex(w.finish()), "ff ff ff ff 80 00 00 01");
  });
  test("nbits helpers", () => {
    eq(nbitsForSigned([0]), 0);
    eq(nbitsForSigned([1]), 2);
    eq(nbitsForSigned([-1]), 1);
    eq(nbitsForSigned([-4]), 3);
    eq(nbitsForSigned([4]), 4);
    eq(nbitsForSigned([25600, 14400]), 16, "vanilla stage RECT uses 16 bits");
    eq(nbitsForUnsigned(0), 0);
    eq(nbitsForUnsigned(1), 1);
    eq(nbitsForUnsigned([2, 3]), 2);
    eq(nbitsForUnsigned(255), 8);
  });
  test("EncodedU32 and strings", () => {
    const w = new BitWriter();
    w.encodedU32(0);
    w.encodedU32(127);
    w.encodedU32(128);
    w.encodedU32(300);
    w.string("Scene 1");
    eq(hex(w.finish()), "00 7f 80 01 ac 02 53 63 65 6e 65 20 31 00");
    const r = new BitReader(w.finish());
    eq(r.encodedU32(), 0);
    eq(r.encodedU32(), 127);
    eq(r.encodedU32(), 128);
    eq(r.encodedU32(), 300);
    eq(r.string(), "Scene 1");
  });
  test("tag framing: short header under 63 bytes, long otherwise or when forced", () => {
    const short = tag(1, new Uint8Array(0));
    eq(hex(short), "40 00");
    const body62 = new Uint8Array(62);
    const t62 = tag(26, body62);
    eq(t62.length, 64);
    eq(t62[0] | (t62[1] << 8), (26 << 6) | 62);
    const body63 = new Uint8Array(63);
    const t63 = tag(26, body63);
    eq(t63.length, 69);
    eq(t63[0] | (t63[1] << 8), (26 << 6) | 0x3f);
    eq(t63[2] | (t63[3] << 8), 63);
    const forced = tag(39, new Uint8Array(4), true);
    eq(forced.length, 10);
    eq(forced[2], 4);
    const parsed = readTags(concat([short, t62, t63, forced]), 0, 2 + 64 + 69 + 10);
    eq(parsed.map((t) => t.length).join(","), "0,62,63,4");
  });
  test("RECT / MATRIX round-trip through the reader", () => {
    const w = new BitWriter();
    writeRect(w, { xmin: 0, ymin: 0, xmax: 25600, ymax: 14400 });
    eq(w.length, 9, "16-bit RECT is 9 bytes like vanilla");
    writeMatrix(w, [1, 0, 0, 1, 10, -20]);
    writeMatrix(w, [0.5, 0.25, -0.25, 2, 0, 0]);
    const r = new BitReader(w.finish());
    const rect = r.rect();
    eq(rect.xmax, 25600);
    eq(rect.ymax, 14400);
    const m1 = r.matrix();
    eq(m1.join(","), "1,0,0,1,200,-400", "translate ×20, no scale/rotate flags");
    const m2 = r.matrix();
    eq(m2.join(","), "0.5,0.25,-0.25,2,0,0");
  });

  console.log("\n# Art: DefineShape3");
  const scene = validateScene(exampleScene()).scene;
  test("exampleScene body encodes and reads back: bounds, 2 fills, edge count", () => {
    const enc = encodeDefineShape3(7, scene.shapes.body, { shapeName: "body" });
    eq(enc.fillCount, 2);
    eq(enc.lineCount, 0);
    const expectedEdges = scene.shapes.body.paths.reduce((n, p) => {
      for (const s of normalizePath(p.d, { matrix: p.transform })) {
        const last = s.edges[s.edges.length - 1];
        n += s.edges.length + (last.x !== s.start[0] || last.y !== s.start[1] ? 1 : 0);
      }
      return n;
    }, 0);
    eq(enc.edgeCount, expectedEdges, "edge records = normalized edges + closing edges");
    const tags = readTags(enc.bytes, 0, enc.bytes.length);
    eq(tags.length, 1);
    eq(tags[0].name, "DefineShape3");
    const sh = tags[0].shape;
    assert(!!sh, "parsed shape");
    if (!sh) return;
    eq(sh.id, 7);
    for (const k of /** @type {const} */ (["xmin", "ymin", "xmax", "ymax"])) assert(Math.abs(sh.bounds[k] - enc.bounds[k]) <= 1, `bounds.${k} ${sh.bounds[k]} vs ${enc.bounds[k]}`);
    eq(sh.bounds.xmin, -800);
    eq(sh.bounds.xmax, 800);
    eq(sh.bounds.ymin, -600);
    eq(sh.bounds.ymax, 600);
    eq(sh.fillStyles.length, 2);
    eq(sh.fillStyles[0].color && sh.fillStyles[0].color.r, 136, "gray:8 → 136");
    eq(sh.fillStyles[1].color && sh.fillStyles[1].color.r, 204, "gray:12 → 204");
    const edges = sh.records.filter((r) => r.type !== "style").length;
    eq(edges, expectedEdges);
    const subs = shapeToSubpaths(sh);
    eq(subs.length, 2);
    for (const s of subs) {
      assert(signedArea(s.points) > 0, "example rects are clockwise");
      assert(s.fill1 > 0 && s.fill0 === 0, "clockwise sub-path → FillStyle1");
    }
  });
  test("eye (cubics) reads back as 16 curved edges with an rgba passthrough fill", () => {
    const enc = encodeDefineShape3(2, scene.shapes.eye, {});
    const sh = readTags(enc.bytes, 0, enc.bytes.length)[0].shape;
    assert(!!sh, "parsed");
    if (!sh) return;
    eq(sh.records.filter((r) => r.type === "curve").length, 16);
    eq(sh.fillStyles[0].color && sh.fillStyles[0].color.g, 0x20);
    eq(sh.fillStyles[0].color && sh.fillStyles[0].color.a, 255);
  });
  test("fill side assignment: ring (outer CW + hole CCW) puts paint on the right of both", () => {
    const subs = normalizePath("M0 0 L100 0 L100 100 L0 100 Z M25 25 L25 75 L75 75 L75 25 Z");
    eq(assignFillSides(subs, false).join(","), "right,right");
    eq(assignFillSides(subs, true).join(","), "right,right");
    // same-direction inner square: nonzero → interior seam dropped; evenodd → hole on the left
    const same = normalizePath("M0 0 L100 0 L100 100 L0 100 Z M25 25 L75 25 L75 75 L25 75 Z");
    eq(assignFillSides(same, false).join(","), "right,none");
    eq(assignFillSides(same, true).join(","), "right,left");
    // counter-clockwise lone shape → FillStyle0
    const ccw = normalizePath("M0 0 L0 100 L100 100 L100 0 Z");
    eq(assignFillSides(ccw, false).join(","), "left");
    assert(signedArea(flattenSubpath(ccw[0])) < 0, "ccw has negative area");
  });
  test("stroke adds a line style and widens bounds; stroke without width is dropped as a finding", () => {
    const enc = encodeDefineShape3(3, { paths: [{ d: "M0 0 L10 0 L10 10 Z", fill: "gray:4", stroke: "#000000", strokeWidth: 2 }] }, {});
    eq(enc.lineCount, 1);
    eq(enc.bounds.xmin, -20);
    eq(enc.bounds.xmax, 220);
    const sh = readTags(enc.bytes, 0, enc.bytes.length)[0].shape;
    eq(sh && sh.lineStyles[0].width, 40);
    const dropped = encodeDefineShape3(4, { paths: [{ d: "M0 0 L10 0 L10 10 Z", fill: "gray:4", stroke: "#000000", strokeWidth: 0 }] }, {});
    assert(dropped.findings.some((f) => f.code === "stroke-dropped"), "stroke-dropped finding");
  });
  test("bitmap fill without a bitmap id is an error finding; with one it is a clipped-bitmap style", () => {
    const shape = { paths: [{ d: "M0 0 L32 0 L32 32 L0 32 Z", fill: "bitmap:tex", transform: /** @type {[number,number,number,number,number,number]} */ ([1, 0, 0, 1, 5, 0]) }] };
    const missing = encodeDefineShape3(5, shape, {});
    assert(missing.findings.some((f) => f.code === "bitmap-missing"), "bitmap-missing finding");
    eq(missing.fillCount, 0);
    const ok = encodeDefineShape3(5, shape, { bitmapIds: new Map([["tex", 9]]) });
    const sh = readTags(ok.bytes, 0, ok.bytes.length)[0].shape;
    assert(!!sh, "parsed");
    if (!sh) return;
    eq(sh.fillStyles[0].type, 0x41);
    eq(sh.fillStyles[0].bitmapId, 9);
    eq(sh.fillStyles[0].matrix && sh.fillStyles[0].matrix.join(","), "20,0,0,20,100,0", "bitmap px → twips, translate 5px = 100 twips");
  });
  test("vanilla fill-side convention: clockwise (positive area, y-down) sub-paths use FillStyle1", () => {
    const bytes = vanilla("minecarts.swf");
    if (!bytes) {
      console.log("      (skipped: minecarts.swf not present)");
      return;
    }
    const swf = readSwf(bytes);
    let cwFill1 = 0;
    let cwFill0 = 0;
    for (const t of flattenTags(swf.tags)) {
      if (!t.shape) continue;
      for (const s of shapeToSubpaths(t.shape)) {
        if ((s.fill0 && s.fill1) || (!s.fill0 && !s.fill1)) continue; // seams / stroke-only
        if (signedArea(s.points) > 0) {
          if (s.fill1) cwFill1++;
          else cwFill0++;
        }
      }
    }
    const simple = flattenTags(swf.tags).find((t) => t.shape && t.shape.id === 13);
    assert(!!simple && !!simple.shape, "shape 13 present");
    if (simple && simple.shape) {
      const subs = shapeToSubpaths(simple.shape);
      eq(subs.length, 1);
      assert(signedArea(subs[0].points) > 0, "shape 13 is clockwise");
      eq(subs[0].fill1, 1, "shape 13 uses FillStyle1");
    }
    assert(cwFill1 > 0 && cwFill0 === 0, `clockwise sub-paths: fill1=${cwFill1} fill0=${cwFill0}`);
  });

  console.log("\n# Art: PNG");
  test("encodePng → decodePng round-trips a 3×2 RGBA image with transparent pixels", () => {
    const rgba = Uint8Array.from([
      255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, //
      10, 20, 30, 40, 0, 0, 0, 0, 255, 255, 255, 255,
    ]);
    const png = encodePng(3, 2, rgba);
    eq(hex(png.subarray(0, 8)), "89 50 4e 47 0d 0a 1a 0a");
    const img = decodePng(png);
    eq(img.width, 3);
    eq(img.height, 2);
    eq(hex(img.rgba), hex(rgba));
  });
  test("decodePng: palette + tRNS, gray, and filter types 1-4 (hand-built)", () => {
    // minimal chunk builder (mirrors png.mjs, kept local to make the fixture explicit)
    /** @param {string} type @param {Uint8Array} data */
    const chunk = (type, data) => {
      const out = new Uint8Array(12 + data.length);
      const be = (/** @type {number} */ p, /** @type {number} */ v) => {
        out[p] = v >>> 24;
        out[p + 1] = (v >>> 16) & 255;
        out[p + 2] = (v >>> 8) & 255;
        out[p + 3] = v & 255;
      };
      be(0, data.length);
      for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
      out.set(data, 8);
      be(8 + data.length, crc32(out, 4, 8 + data.length));
      return out;
    };
    const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    /** @param {number} w @param {number} h @param {number} ct */
    const ihdr = (w, h, ct) => Uint8Array.from([0, 0, 0, w, 0, 0, 0, h, 8, ct, 0, 0, 0]);
    const zlib = (/** @type {Uint8Array} */ raw) => new Uint8Array(deflateSync(raw));
    // palette 2×1: index 0 = red opaque, index 1 = blue with alpha 7
    const pal = decodePng(concat([sig, chunk("IHDR", ihdr(2, 1, 3)), chunk("PLTE", Uint8Array.from([255, 0, 0, 0, 0, 255])), chunk("tRNS", Uint8Array.from([255, 7])), chunk("IDAT", zlib(Uint8Array.from([0, 0, 1]))), chunk("IEND", new Uint8Array(0))]));
    eq(hex(pal.rgba), "ff 00 00 ff 00 00 ff 07");
    // gray 2×2 with filter 1 (Sub) on row 0 and filter 2 (Up) on row 1
    const gray = decodePng(concat([sig, chunk("IHDR", ihdr(2, 2, 0)), chunk("IDAT", zlib(Uint8Array.from([1, 10, 5, 2, 1, 2]))), chunk("IEND", new Uint8Array(0))]));
    eq([...gray.rgba].filter((_, i) => i % 4 === 0).join(","), "10,15,11,17");
    assert(gray.rgba[3] === 255 && gray.rgba[15] === 255, "opaque gray");
    // rgb 2×2 with filter 3 (Average) and 4 (Paeth)
    const rgb = decodePng(concat([sig, chunk("IHDR", ihdr(2, 2, 2)), chunk("IDAT", zlib(Uint8Array.from([3, 10, 20, 30, 10, 10, 10, 4, 1, 1, 1, 0, 0, 0]))), chunk("IEND", new Uint8Array(0))]));
    // row0 (Average): p0 = 10,20,30 ; p1 = 10+floor(10/2)=15, 10+floor(20/2)=20, 10+floor(30/2)=25
    // row1 (Paeth): p0 (a=0, b=row0 p0, c=0) → pred=b → 11,21,31 ;
    //   p1: a=(11,21,31) b=(15,20,25) c=(10,20,30) → pa=|b-c|=5,0,5 pb=|a-c|=1,1,1 pc=|a+b-2c|=6,1,4
    //   → channel0 pred=b=15, channel1 pred=a=21, channel2 pred=b=25 (+0 each)
    eq(hex(rgb.rgba), "0a 14 1e ff 0f 14 19 ff 0b 15 1f ff 0f 15 19 ff");
    let threw = "";
    try {
      decodePng(concat([sig, chunk("IHDR", Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 1, 16, 6, 0, 0, 0])), chunk("IEND", new Uint8Array(0))]));
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    assert(/bit depth 16/.test(threw), `16-bit error: ${threw}`);
  });

  console.log("\n# Art: DefineBitsLossless2");
  test("tag decodes to format 5 with premultiplied ARGB", () => {
    const rgba = Uint8Array.from([255, 0, 0, 255, 200, 100, 50, 128, 0, 0, 0, 0, 255, 255, 255, 255]);
    const bytes = encodeDefineBitsLossless2(12, { width: 2, height: 2, rgba });
    eq(bytes[0] & 0x3f, 0x3f, "long header (low 6 bits of the LE header word)");
    const t = readTags(bytes, 0, bytes.length)[0];
    eq(t.name, "DefineBitsLossless2");
    assert(!!t.bitmap, "parsed bitmap");
    if (!t.bitmap) return;
    eq(t.bitmap.id, 12);
    eq(t.bitmap.format, 5);
    eq(t.bitmap.width, 2);
    eq(t.bitmap.height, 2);
    eq(t.bitmap.pixels.length, 16);
    eq(hex(t.bitmap.pixels.subarray(0, 4)), "ff ff 00 00", "opaque red → A R G B");
    eq(hex(t.bitmap.pixels.subarray(4, 8)), "80 64 32 19", "half alpha: 200*128/255=100, 100→50, 50→25");
    eq(hex(t.bitmap.pixels.subarray(8, 12)), "00 00 00 00");
  });

  console.log("\n# Art: linkage ABC");
  test('buildLinkageAbc(["Foo","pkg.Bar"]) parses: 2 MovieClip subclasses, Flash-shaped bodies', () => {
    const abc = buildLinkageAbc(["Foo", "pkg.Bar"]);
    const p = parseAbc(abc);
    eq(p.consumed, abc.length, "parse consumes all bytes");
    eq(p.minor, 16);
    eq(p.major, 46);
    eq(p.ints.length, 1);
    eq(p.uints.length, 1);
    eq(p.doubles.length, 1);
    eq(p.strings[1], "", "explicit empty string at index 1 like Flash");
    eq(p.strings.slice(1).join("|"), "|Foo|flash.display|MovieClip|pkg|Bar|pkg:Bar|Object|flash.events|EventDispatcher|DisplayObject|InteractiveObject|DisplayObjectContainer|Sprite");
    eq(p.instances.length, 2);
    eq(p.classes.length, 2);
    eq(p.scripts.length, 2);
    eq(p.methods.length, 6);
    eq(p.bodies.length, 6);
    eq(p.metadataCount, 0);
    eq(p.nsSets.length, 1);
    eq(multinameToString(p, p.instances[0].name), ":Foo");
    eq(multinameToString(p, p.instances[1].name), "pkg:Bar");
    for (const inst of p.instances) {
      eq(multinameToString(p, inst.superName), "flash.display:MovieClip");
      eq(inst.flags, 8);
      eq(inst.traits.length, 0);
      const pns = inst.protectedNs !== undefined ? p.namespaces[inst.protectedNs] : null;
      eq(pns && pns.kind, 0x18);
    }
    eq(p.strings[/** @type {any} */ (p.namespaces[p.instances[1].protectedNs || 0]).name], "pkg:Bar");
    for (const m of p.methods) assert(m.paramCount === 0 && m.returnType === 0 && m.name === 0 && m.flags === 0, "bare method_info");
    p.scripts.forEach((s, i) => {
      eq(s.init, i * 3 + 2);
      eq(s.traits.length, 1);
      eq(s.traits[0].kind, 4);
      eq(s.traits[0].slotId, 1);
      eq(s.traits[0].classIndex, i);
      eq(s.traits[0].name, p.instances[i].name);
    });
    p.instances.forEach((inst, i) => {
      eq(inst.iinit, i * 3 + 1);
      eq(p.classes[i].cinit, i * 3);
      const cinit = p.bodies[i * 3];
      eq(hex(cinit.code), "d0 30 47");
      eq([cinit.maxStack, cinit.localCount, cinit.initScopeDepth, cinit.maxScopeDepth].join(","), "1,1,9,10");
      const iinit = p.bodies[i * 3 + 1];
      eq(hex(iinit.code), "d0 30 d0 49 00 47");
      eq([iinit.maxStack, iinit.localCount, iinit.initScopeDepth, iinit.maxScopeDepth].join(","), "1,1,10,11");
      const sinit = p.bodies[i * 3 + 2];
      eq([sinit.maxStack, sinit.localCount, sinit.initScopeDepth, sinit.maxScopeDepth].join(","), "2,1,1,9");
      eq(sinit.method, i * 3 + 2);
      eq(sinit.exceptionCount, 0);
      eq(sinit.traits.length, 0);
    });
    // script init of class 0 (all multiname indices < 128 → one byte each)
    const mn = (/** @type {string} */ s) => p.multinames.findIndex((m, i) => i > 0 && multinameToString(p, i) === s).toString(16).padStart(2, "0");
    const expected = `d0 30 65 00 60 ${mn(":Object")} 30 60 ${mn("flash.events:EventDispatcher")} 30 60 ${mn("flash.display:DisplayObject")} 30 60 ${mn("flash.display:InteractiveObject")} 30 60 ${mn("flash.display:DisplayObjectContainer")} 30 60 ${mn("flash.display:Sprite")} 30 60 ${mn("flash.display:MovieClip")} 30 60 ${mn("flash.display:MovieClip")} 58 00 1d 1d 1d 1d 1d 1d 1d 68 ${mn(":Foo")} 47`;
    eq(hex(p.bodies[2].code), expected);
    // multinames: 1 :Foo, 2 flash.display:MovieClip, 3 pkg:Bar, then the chain 4..9
    eq(hex(p.bodies[2].code), "d0 30 65 00 60 04 30 60 05 30 60 06 30 60 07 30 60 08 30 60 09 30 60 02 30 60 02 58 00 1d 1d 1d 1d 1d 1d 1d 68 01 47");
    eq(hex(p.bodies[5].code), "d0 30 65 00 60 04 30 60 05 30 60 06 30 60 07 30 60 08 30 60 09 30 60 02 30 60 02 58 01 1d 1d 1d 1d 1d 1d 1d 68 03 47");
  });
  test("vanilla minecarts DoABC parses fully and matches the stub's class shape", () => {
    const bytes = vanilla("minecarts.swf");
    if (!bytes) {
      console.log("      (skipped: minecarts.swf not present)");
      return;
    }
    const swf = readSwf(bytes);
    const doabc = swf.tags.find((t) => t.name === "DoABC");
    assert(!!doabc && !!doabc.abcBytes, "DoABC present");
    if (!doabc || !doabc.abcBytes) return;
    eq(doabc.flags, 1);
    eq(doabc.abcName, "");
    const p = parseAbc(doabc.abcBytes);
    eq(p.consumed, doabc.abcBytes.length, "parse consumes exactly all bytes");
    eq(p.minor, 16);
    eq(p.major, 46);
    eq(p.strings[1], "");
    const ns1 = p.namespaces[1];
    assert(!!ns1 && ns1.kind === 0x16 && ns1.name === 1, "ns 1 is PackageNamespace(\"\") naming string index 1");
    // MinecartTrack: a plain class with no children → identical structure to our stub
    const i = p.instances.findIndex((inst) => multinameToString(p, inst.name) === ":MinecartTrack");
    assert(i >= 0, "MinecartTrack instance");
    const inst = p.instances[i];
    eq(multinameToString(p, inst.superName), "flash.display:MovieClip");
    eq(inst.flags, 8);
    eq(inst.traits.length, 0);
    eq(hex(p.bodies[p.classes[i].cinit].code), "d0 30 47");
    eq(hex(p.bodies[inst.iinit].code), "d0 30 d0 49 00 47");
    const script = p.scripts.find((s) => s.traits.some((t) => t.classIndex === i));
    assert(!!script, "script for MinecartTrack");
    if (!script) return;
    const sinit = p.bodies[script.init];
    eq([sinit.maxStack, sinit.localCount, sinit.initScopeDepth, sinit.maxScopeDepth].join(","), "2,1,1,9");
    assert(hex(sinit.code).startsWith("d0 30 65 00 60 ") && hex(sinit.code).endsWith(` 58 0${i} 1d 1d 1d 1d 1d 1d 1d 68 ${inst.name.toString(16).padStart(2, "0")} 47`), `script init shape: ${hex(sinit.code)}`);
  });

  console.log("\n# Art: emitter");
  test("emitSwf(exampleScene) header and tag order match vanilla layout", () => {
    const { bytes, report, findings } = emitSwf(scene, { abc: "none" });
    eq(String.fromCharCode(bytes[0], bytes[1], bytes[2]), "FWS");
    eq(bytes[3], 17);
    const swf = readSwf(bytes);
    eq(swf.header.fileLength, bytes.length);
    eq(report.fileLength, bytes.length);
    eq(swf.header.frameRate, 60);
    eq(hex(bytes.subarray(bytes.length - report.tags.slice(-2).reduce((n, t) => n + t.length + 2, 0))), "40 00 00 00", "ShowFrame, End");
    eq(swf.header.rect.xmax, 25600);
    eq(swf.header.rect.ymax, 14400);
    eq(swf.header.frameCount, 1);
    eq(swf.tags.slice(0, 3).map((t) => t.name).join(","), "FileAttributes,SetBackgroundColor,DefineSceneAndFrameLabelData");
    eq(swf.tags[0].flags, 8);
    eq(JSON.stringify(swf.tags[1].rgb), JSON.stringify({ r: 255, g: 204, b: 255 }));
    eq(JSON.stringify(swf.tags[2].scenes), JSON.stringify([{ offset: 0, name: "Scene 1" }]));
    eq(swf.tags.slice(-3).map((t) => t.name).join(","), "SymbolClass,ShowFrame,End");
    eq(swf.tags.filter((t) => t.name === "DoABC").length, 0);
    eq(swf.tags.filter((t) => t.name === "SymbolClass").length, 1);
    eq(report.abc, "none");
    eq(report.characters.map((c) => `${c.id}:${c.kind}:${c.name}`).join(","), "1:shape:body,2:shape:eye,3:sprite:Starter");
    const sym = swf.tags.find((t) => t.name === "SymbolClass");
    assert(!!sym && !!sym.entries, "SymbolClass");
    if (!sym || !sym.entries) return;
    eq(sym.entries.length, 2);
    assert(sym.entries.every((e) => e.id === 3), "both exports point at the sprite");
    eq(sym.entries.map((e) => e.name).join(","), "Starter,starter.png");
    assert(!findings.some((f) => f.severity === "error"), `no error findings: ${JSON.stringify(findings)}`);
    // main-timeline placement of the stage instance
    const place = swf.tags.find((t) => t.name === "PlaceObject2");
    assert(!!place && !!place.place, "stage PlaceObject2");
    if (place && place.place) {
      eq(place.place.characterId, 3);
      eq(place.place.matrix && place.place.matrix.slice(4).join(","), "12800,7200");
    }
  });
  test("Starter sprite: 24 frames, labels idle@0 blink@12, PlaceObject2 count = non-remove diff ops", () => {
    const { bytes } = emitSwf(scene);
    const swf = readSwf(bytes);
    const sprite = swf.tags.find((t) => t.name === "DefineSprite");
    assert(!!sprite && !!sprite.tags, "DefineSprite");
    if (!sprite || !sprite.tags) return;
    eq(sprite.id, 3);
    eq(sprite.frameCount, 24);
    eq(sprite.tags.filter((t) => t.name === "ShowFrame").length, 24);
    eq(sprite.tags[sprite.tags.length - 1].name, "End");
    const labels = [];
    let frame = 0;
    for (const t of sprite.tags) {
      if (t.name === "FrameLabel") labels.push(`${t.label}@${frame}`);
      if (t.name === "ShowFrame") frame++;
    }
    eq(labels.join(","), "idle@0,blink@12");
    const baked = bakeSprite(scene.sprites.Starter);
    let expected = 0;
    let prev = /** @type {import('../src/core/art/timeline.mjs').Placement[]} */ ([]);
    for (let f = 0; f < baked.frames; f++) {
      expected += diffFrames(prev, baked.placements[f]).filter((op) => op.op !== "remove").length;
      prev = baked.placements[f];
    }
    eq(sprite.tags.filter((t) => t.name === "PlaceObject2").length, expected);
    const first = sprite.tags.find((t) => t.name === "PlaceObject2");
    assert(!!first && !!first.place, "first place");
    if (first && first.place) {
      eq(first.place.flags, 0x26, "HasCharacter|HasMatrix|HasName like vanilla rig slots");
      eq(first.place.name, "body");
      eq(first.place.characterId, 1);
    }
    const moves = sprite.tags.filter((t) => t.place && t.place.move);
    assert(moves.length > 0 && moves.every((t) => t.place && t.place.flags === 0x05), "tween frames are Move|HasMatrix (0x05)");
  });
  test("abc: 'stub' adds exactly one DoABC before SymbolClass; blob passes through", () => {
    const { bytes, report } = emitSwf(scene, { abc: "stub" });
    const swf = readSwf(bytes);
    const names = swf.tags.map((t) => t.name);
    eq(names.filter((n) => n === "DoABC").length, 1);
    eq(names.indexOf("DoABC"), names.indexOf("SymbolClass") - 1);
    eq(report.abc, "stub");
    const doabc = swf.tags.find((t) => t.name === "DoABC");
    assert(!!doabc && !!doabc.abcBytes, "DoABC parsed");
    if (!doabc || !doabc.abcBytes) return;
    eq(doabc.flags, 1);
    eq(doabc.abcName, "");
    const p = parseAbc(doabc.abcBytes);
    eq(p.consumed, doabc.abcBytes.length);
    // Flash's last-dot rule: a ".png"-style linkage becomes class `png` in package `starter`
    eq(p.instances.map((i) => multinameToString(p, i.name)).join(","), ":Starter,starter:png");
    const blob = Uint8Array.from([1, 2, 3]);
    const r2 = emitSwf(scene, { abc: blob });
    eq(r2.report.abc, "blob");
    const d2 = readSwf(r2.bytes).tags.find((t) => t.name === "DoABC");
    eq(d2 && d2.abcBytes && hex(d2.abcBytes), "01 02 03");
  });
  test("deterministic output (two calls are byte-equal) and exportAssets option", () => {
    const a = emitSwf(scene, { abc: "stub" }).bytes;
    const b = emitSwf(scene, { abc: "stub" }).bytes;
    eq(hex(a), hex(b));
    const c = readSwf(emitSwf(scene, { exportAssets: true }).bytes);
    const ea = c.tags.find((t) => t.name === "ExportAssets");
    assert(!!ea && !!ea.entries && ea.entries.length === 2, "ExportAssets with 2 entries");
  });
  test("findings: empty exports warning, missing bitmap error, unresolved export error", () => {
    const s = validateScene({ ...exampleScene(), exports: {} }).scene;
    const r = emitSwf(s);
    assert(r.findings.some((f) => f.code === "exports-empty"), "exports-empty");
    const bm = validateScene({ ...exampleScene(), bitmaps: { tex: { file: "art/tex.png" } }, shapes: { ...exampleScene().shapes, pic: { paths: [{ d: "M0 0 L8 0 L8 8 Z", fill: "bitmap:tex" }] } } }).scene;
    const r2 = emitSwf(bm);
    assert(r2.findings.some((f) => f.code === "bitmap-missing" && f.path === "bitmaps.tex"), "bitmap-missing for the definition");
    assert(r2.findings.some((f) => f.code === "bitmap-missing" && f.path && f.path.startsWith("shapes.pic")), "bitmap-missing for the fill");
    const r3 = emitSwf(bm, { bitmaps: new Map([["tex", { width: 1, height: 1, rgba: Uint8Array.from([0, 0, 0, 255]) }]]) });
    assert(!r3.findings.some((f) => f.severity === "error"), "no errors once the bitmap is supplied");
    eq(r3.report.characters[0].kind, "bitmap");
    const swf = readSwf(r3.bytes);
    eq(swf.tags.filter((t) => t.name === "DefineBitsLossless2").length, 1);
    const pic = swf.tags.find((t) => t.shape && t.shape.fillStyles.some((f) => f.type === 0x41));
    assert(!!pic && !!pic.shape && pic.shape.fillStyles[0].bitmapId === 1, "shape fill references bitmap char 1");
  });
  test("minimalGateSwf parses and binds the linkage name; stub variant carries a DoABC", () => {
    const none = readSwf(minimalGateSwf({ withAbc: false, linkage: "_Append_AbilityIcon", label: "JokersGambit" }));
    eq(none.tags.filter((t) => t.name === "DoABC").length, 0);
    const sym = none.tags.find((t) => t.name === "SymbolClass");
    assert(!!sym && !!sym.entries, "SymbolClass");
    if (sym && sym.entries) {
      eq(sym.entries.length, 1);
      eq(sym.entries[0].name, "_Append_AbilityIcon");
      const sprite = none.tags.find((t) => t.name === "DefineSprite");
      assert(!!sprite && sprite.id === sym.entries[0].id, "linkage → sprite id");
      const label = sprite && sprite.tags && sprite.tags.find((t) => t.name === "FrameLabel");
      eq(label && label.label, "JokersGambit");
      eq(sprite && sprite.frameCount, 1);
    }
    const shape = none.tags.find((t) => t.shape);
    assert(!!shape && !!shape.shape, "shape");
    if (shape && shape.shape) {
      eq(JSON.stringify(shape.shape.bounds), JSON.stringify({ xmin: 0, xmax: 1280, ymin: 0, ymax: 1280 }));
      eq(shape.shape.fillStyles[0].color && shape.shape.fillStyles[0].color.r, 136);
    }
    const stub = readSwf(minimalGateSwf({ withAbc: true, linkage: "_Append_AbilityIcon", label: "JokersGambit" }));
    const doabc = stub.tags.find((t) => t.name === "DoABC");
    assert(!!doabc && !!doabc.abcBytes, "DoABC in stub variant");
    if (doabc && doabc.abcBytes) {
      const p = parseAbc(doabc.abcBytes);
      eq(multinameToString(p, p.instances[0].name), ":_Append_AbilityIcon");
    }
  });

  console.log("\n# Art: reader on vanilla files (skipped when absent)");
  for (const name of ["minecarts.swf", "testing_stuff.swf", "ability_icons.swf"]) {
    test(`readSwf(${name}) walks every tag without errors`, () => {
      const bytes = vanilla(name);
      if (!bytes) {
        console.log(`      (skipped: ${name} not present)`);
        return;
      }
      const swf = readSwf(bytes);
      eq(swf.header.signature, "FWS");
      eq(swf.header.version, 17);
      eq(swf.header.fileLength, bytes.length);
      eq(swf.header.frameRate, 60);
      const all = flattenTags(swf.tags);
      const errors = all.filter((t) => t.error);
      eq(errors.length, 0, `tag errors: ${errors.slice(0, 3).map((e) => `${e.name}@${e.offset}: ${e.error}`).join("; ")}`);
      eq(swf.tags[swf.tags.length - 1].name, "End");
      eq(swf.tags.filter((t) => t.name === "DoABC").length, 1);
      assert(swf.tags.filter((t) => t.name === "SymbolClass").length >= 1, "SymbolClass present");
    });
  }
}
