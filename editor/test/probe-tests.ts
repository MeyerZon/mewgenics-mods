// The in-game art probe's analysis (editor/src/core/art/probe-compare.ts) on synthetic shots: the _artprobe clip
// drawn at a known scale/orientation with knobs for sampling, edge mode and colours.
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";
import * as pc from "../src/core/art/probe-compare.ts";

export function runProbeTests(test: TestFn, assert: AssertFn, eq: EqFn): void {
  console.log("\n# art probe: reading in-game shots of the _artprobe clip");
  // ---- probe-compare: reading an in-game shot of the _artprobe clip (synthetic shots here) ----
  {
    type Px = [number, number, number];
    const Y: Px = [255, 255, 0], M: Px = [255, 0, 255], C: Px = [0, 255, 255];
    /** a synthetic shot: background, the probe clip drawn at scale s from (ox, oy), optionally mirrored, with knobs */
    const shot = (o: { s: number; mirrored?: boolean; edge?: "clamp" | "repeat"; smooth?: boolean; blink?: Px; control?: Px; cx?: Px; grad?: "drawn" | "flat"; caps?: "honoured" | "round"; blend?: "honoured" | "ignored" }) => {
      const W = 1400, H = 400, img = new Uint8Array(W * H * 4);
      for (let i = 0; i < W * H; i++) img.set([40, 44, 40, 255], i * 4);
      const s = o.s, ox = o.mirrored ? 1150 : 200, oy = 100;
      const put = (cx: number, cy: number, c: Px) => { // clip px -> screen px
        const x = Math.round(o.mirrored ? ox - cx * s : ox + cx * s), y = Math.round(oy + cy * s);
        if (x >= 0 && y >= 0 && x < W && y < H) img.set([c[0], c[1], c[2], 255], (y * W + x) * 4);
      };
      const texel = (tx: number, ty: number): Px => {
        if (tx >= 8) tx = o.edge === "repeat" ? tx - 8 : 7;
        const border = tx === 0 || ty === 0 || tx === 7 || ty === 7;
        return border ? Y : (tx < 4) === (ty < 4) ? M : C;
      };
      const step = 1 / s;
      for (let cy = 0; cy < 64; cy += step) for (let cx = 0; cx < 96; cx += step) {
        const fx = cx / 8, fy = cy / 8;
        let c = texel(Math.floor(fx), Math.floor(fy));
        if (o.smooth) { // a bilinear blend toward the right/bottom neighbour
          const a = fx - Math.floor(fx), b = fy - Math.floor(fy);
          const r = texel(Math.min(11, Math.floor(fx) + 1), Math.floor(fy)), d = texel(Math.floor(fx), Math.min(7, Math.floor(fy) + 1));
          c = [0, 1, 2].map((k) => Math.round(c[k]! * (1 - a / 2 - b / 2) + r[k]! * (a / 2) + d[k]! * (b / 2))) as Px;
        }
        put(cx, cy, c);
      }
      const square = (x0: number, y0: number, c: Px) => { for (let cy = y0 - 30; cy < y0 + 30; cy += step) for (let cx = x0 - 30; cx < x0 + 30; cx += step) put(cx, cy, c); };
      square(150, 30, o.blink ?? [255, 32, 32]);
      square(230, 30, o.control ?? [136, 136, 136]);
      square(310, 30, o.cx ?? [136, 0, 0]);
      // (390,30): a linear gradient black → #ff2020 along clip x ("flat": the game fills it with one colour)
      for (let cy = 0; cy < 60; cy += step) for (let cx = 360; cx < 420; cx += step) {
        const t = o.grad === "flat" ? 0.5 : (cx - 360) / 60;
        put(cx, cy, [Math.round(255 * t), Math.round(32 * t), Math.round(32 * t)]);
      }
      // two 12 px green strokes from clip x 440 to 500: y 10 butt caps, y 50 square caps (a game that ignores
      // LINESTYLE2 draws both with round caps: both reach x 434)
      const line = (y: number, ext: number) => { for (let cy = y - 6; cy < y + 6; cy += step) for (let cx = 440 - ext; cx < 500 + ext; cx += step) put(cx, cy, [32, 255, 32]); };
      line(10, o.caps === "round" ? 6 : 0);
      line(50, 6);
      // (550,30): #600000 placed with blend add — over the 40,44,40 background add gives 136,44,40, normal 96,0,0
      square(550, 30, o.blend === "ignored" ? [96, 0, 0] : [136, 44, 40]);
      return { width: W, height: H, rgba: img };
    };
    test("analyzeProbeShot: finds the checker marker, its scale and orientation; reads sampling, edge mode, the blink colour, the control and the cxform square", () => {
      const a = pc.analyzeProbeShot(shot({ s: 2, edge: "clamp", blink: [32, 255, 32] }));
      assert(a.found, JSON.stringify(a));
      assert(Math.abs(a.scale - 2) < 0.1, `scale ${a.scale}`);
      eq(a.mirrored, false); eq(a.sampling, "nearest"); eq(a.edge, "clamp"); eq(a.blink, "green");
      assert(Math.abs(a.control[0] - 136) < 8 && Math.abs(a.control[1] - 136) < 8, JSON.stringify(a.control));
      assert(a.cx[0] > 100 && a.cx[1] < 30 && a.cx[2] < 30, JSON.stringify(a.cx));
      const m = pc.analyzeProbeShot(shot({ s: 1.5, mirrored: true, edge: "repeat", smooth: true, blink: [32, 32, 255] }));
      assert(m.found && m.mirrored, JSON.stringify(m));
      eq(m.sampling, "smooth"); eq(m.edge, "repeat"); eq(m.blink, "blue");
      // stray yellow elsewhere on screen (UI) must not stretch the marker: the largest connected yellow region wins
      const noisy = shot({ s: 2, edge: "clamp", blink: [32, 255, 32] });
      for (let y = 5; y < 9; y++) for (let x = 880; x < 884; x++) noisy.rgba.set([255, 255, 0, 255], (y * noisy.width + x) * 4);
      const nz = pc.analyzeProbeShot(noisy);
      assert(nz.found && Math.abs(nz.scale - 2) < 0.1 && nz.blink === "green", `stray yellow ignored: ${JSON.stringify(nz)}`);
      eq(a.gradient, "drawn", "black → red in clip x");
      eq(a.caps, "honoured", "butt ends at the endpoint, square reaches past it");
      eq(a.blend, "honoured", "add lets the background through");
      eq(pc.analyzeProbeShot(shot({ s: 2, edge: "clamp", blend: "ignored" })).blend, "ignored");
      eq(m.caps, "honoured", "mirrored too");
      eq(pc.analyzeProbeShot(shot({ s: 2, edge: "clamp", caps: "round" })).caps, "ignored");
      eq(m.gradient, "drawn", "read in clip x when mirrored too");
      eq(pc.analyzeProbeShot(shot({ s: 2, edge: "clamp", grad: "flat" })).gradient, "flat");
      const none = pc.analyzeProbeShot({ width: 10, height: 10, rgba: new Uint8Array(400) });
      eq(none.found, false);
    });
    test("summarizeProbe: across shots — child framing (free-running when the blink colour changes), sampling, edge, cxform applied, orientation", () => {
      const shots = ([[255, 32, 32], [32, 255, 32], [32, 32, 255]] as Px[]).map((b) => pc.analyzeProbeShot(shot({ s: 2, mirrored: true, edge: "clamp", smooth: true, blink: b })));
      const s = pc.summarizeProbe(shots);
      eq(s.gradient, "drawn");
      eq(s.caps, "honoured");
      eq(s.blend, "honoured");
      eq(s.childFraming, "free-running"); eq(s.sampling, "smooth"); eq(s.edge, "clamp"); eq(s.cxform, "applied"); eq(s.mirrored, true);
      const held = pc.summarizeProbe([0, 1, 2].map(() => pc.analyzeProbeShot(shot({ s: 2, blink: [255, 32, 32] }))));
      eq(held.childFraming, "held");
      assert(/\| shot \|/.test(pc.renderProbeReport(shots, s)), "a markdown table");
    });
  }
}

/** OBSERVED in the game (npm run test:artprobe, 2026-10-20): the facts the art preview must follow */
export function runProbeFixtureTests(test: TestFn, assert: AssertFn, eq: EqFn, fixture: (name: string) => string): void {
  test("OBSERVED 2026-10-20 fixture: the game honours a PlaceObject3 blend mode (the add square lets the background through)", () => {
    const j = JSON.parse(fixture("artprobe-summary.json")) as { summary: { blend?: string } };
    eq(j.summary.blend, "honoured");
  });
  test("OBSERVED 2026-10-20 fixture: the game honours LINESTYLE2 caps (DefineShape4): a butt stroke ends at its endpoint, a square one reaches past it", () => {
    const j = JSON.parse(fixture("artprobe-summary.json")) as { summary: { caps?: string } };
    eq(j.summary.caps, "honoured");
  });
  test("OBSERVED 2026-10-20 fixture: the game draws a linear gradient fill as a gradient, along the authored axis (the (390,30) square runs black → red in clip x)", () => {
    const j = JSON.parse(fixture("artprobe-summary.json")) as { summary: { gradient?: string } };
    eq(j.summary.gradient, "drawn");
  });
  test("OBSERVED 2026-10-20 fixture (artprobe-summary.json): enemy clips are mirrored; a nested sprite runs on its own clock under a one-frame parent; bitmap fills are sampled smoothly and clamped; PlaceObject cxform applies", () => {
    const j = JSON.parse(fixture("artprobe-summary.json")) as { summary: { childFraming: string; sampling: string; edge: string; cxform: string; mirrored: boolean; found: number; shots: number; blinks: string[] } };
    const s = j.summary;
    eq(s.found, s.shots, "the marker in every shot");
    eq(s.childFraming, "free-running"); eq(s.sampling, "smooth"); eq(s.edge, "clamp"); eq(s.cxform, "applied"); eq(s.mirrored, true);
    assert(new Set(s.blinks.filter((b) => b !== "other")).size === 3, `all three blink colours seen: ${s.blinks.join(",")}`);
  });
}

/** the preview renderer follows what the probe observed (engine-behaviour.ts is the single place those facts live) */
export async function runPreviewAgreementTests(test: TestFn, assert: AssertFn, eq: EqFn, fixture: (name: string) => string, previewSource: string): Promise<void> {
  let eb: Record<string, any> = {};
  let err = "";
  try { eb = await import("../src/core/art/engine-behaviour.ts"); } catch (e) { err = e instanceof Error ? e.message : String(e); }
  test("engine-behaviour.ts agrees with the observed probe fixture (own-clock nested sprites, linear + clamped bitmap sampling, mirrored enemy clips)", () => {
    assert(!err && !!eb.ENGINE_DRAWING, `engine-behaviour.ts loads: ${err}`);
    const s = (JSON.parse(fixture("artprobe-summary.json")) as { summary: { childFraming: string; sampling: string; edge: string; mirrored: boolean } }).summary;
    eq(eb.ENGINE_DRAWING.nestedSprites, s.childFraming === "free-running" ? "own-clock" : "parent-frame");
    eq(eb.ENGINE_DRAWING.bitmapSampling, s.sampling === "smooth" ? "linear" : "nearest");
    eq(eb.ENGINE_DRAWING.bitmapEdge, s.edge);
    eq(eb.ENGINE_DRAWING.enemyClipsMirrored, s.mirrored);
  });
  test("nestedFrame(clock, frames): a nested sprite's frame comes from the clock, not from its parent's frame (a one-frame holder does not freeze its child)", () => {
    assert(typeof eb.nestedFrame === "function", "exported");
    eq(eb.nestedFrame(0, 90), 0); eq(eb.nestedFrame(45, 90), 45); eq(eb.nestedFrame(95, 90), 5); eq(eb.nestedFrame(-1, 90), 89);
  });
  test("preview-gl.ts uses the observed behaviour: nested frames from nestedFrame(clock, …), LINEAR + CLAMP_TO_EDGE for bitmap textures, smoothing on in the Canvas2D fallback", () => {
    assert(/import \{[^}]*nestedFrame[^}]*\} from "..\/..\/..\/src\/core\/art\/engine-behaviour\.ts"/.test(previewSource), "imports nestedFrame");
    assert(/nestedFrame\(clk, b\.frames\)/.test(previewSource), "nested frames use the clock");
    const up = previewSource.slice(previewSource.indexOf("function uploadBitmap"), previewSource.indexOf("function uploadBitmap") + 1500);
    assert(/TEXTURE_MAG_FILTER, g\.LINEAR/.test(up) && /TEXTURE_MIN_FILTER, g\.LINEAR/.test(up) && /CLAMP_TO_EDGE/.test(up), "bitmap textures: LINEAR + clamp");
    assert(/imageSmoothingEnabled = true/.test(previewSource) && !/imageSmoothingEnabled = false/.test(previewSource), "Canvas2D smoothing on");
  });
}
