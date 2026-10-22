// The per-unit glow's in-game proof read from shots (editor/src/core/art/glow-measure.ts): how many pixels of the
// glow colour a shot holds and the largest connected patch of them, on synthetic shots here; the OBSERVED fixture
// (editor/test/fixtures/ingame/unit-glow-summary.json, written by `npm run test:unitglow` from
// mods/dev-sandbox/tests/unit-glow.mewtest) pins what the real game drew.
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";
import * as gm from "../src/core/art/glow-measure.ts";

export function runGlowMeasureTests(test: TestFn, assert: AssertFn, eq: EqFn, fixture: (name: string) => string): void {
  console.log("\n# per-unit glow: reading in-game shots of a glowing unit");
  type Px = [number, number, number];
  /** a synthetic shot: a dark arena, a gray unit blob at (cx, cy), optionally a ring of `ring` colour around it */
  const shot = (o: { ring?: Px; ringWidth?: number; stray?: number; dim?: number }) => {
    const W = 640, H = 360, img = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) img.set([40, 44, 40, 255], i * 4);
    const put = (x: number, y: number, c: Px) => { if (x >= 0 && y >= 0 && x < W && y < H) img.set([c[0], c[1], c[2], 255], (y * W + x) * 4); };
    const cx = 320, cy = 200, r = 30;
    for (let y = -r - 20; y <= r + 20; y++) for (let x = -r - 20; x <= r + 20; x++) {
      const d = Math.sqrt(x * x + y * y);
      if (d <= r) put(cx + x, cy + y, [136, 136, 136]);
      else if (o.ring && d <= r + (o.ringWidth ?? 6)) {
        const k = o.dim ?? 1;
        put(cx + x, cy + y, [Math.round(o.ring[0] * k), Math.round(o.ring[1] * k), Math.round(o.ring[2] * k)]);
      }
    }
    for (let i = 0; i < (o.stray ?? 0); i++) put(10 + i * 3, 10, o.ring ?? [255, 0, 255]);   /* scattered UI pixels of the same colour */
    return { width: W, height: H, rgba: img };
  };
  test("measureGlow: counts pixels of the glow colour (uniform dimming allowed) and finds the largest connected patch with its bbox; a plain unit has none", () => {
    const none = gm.measureGlow(shot({}));
    eq(none.pixels, 0); eq(none.region, null);
    const ring = gm.measureGlow(shot({ ring: [255, 0, 255] }));
    assert(ring.pixels > 800 && ring.pixels < 1600, `ring pixels ${ring.pixels}`);
    assert(!!ring.region && ring.region.count === ring.pixels, "one connected ring");
    assert(!!ring.region && Math.abs(ring.region.x0 - 284) <= 2 && Math.abs(ring.region.x1 - 356) <= 2 && Math.abs(ring.region.y0 - 164) <= 2 && Math.abs(ring.region.y1 - 236) <= 2, `bbox ${JSON.stringify(ring.region)}`);
    const dim = gm.measureGlow(shot({ ring: [255, 0, 255], dim: 0.8 }));
    assert(dim.pixels > 800, `a darkened rim still counts: ${dim.pixels}`);
    const other = gm.measureGlow(shot({ ring: [255, 0, 0] }));
    eq(other.pixels, 0, "a red rim is not magenta");
    const red = gm.measureGlow(shot({ ring: [255, 0, 0] }), [255, 0, 0]);
    assert(red.pixels > 800, "the colour is a parameter");
    const strays = gm.measureGlow(shot({ ring: [255, 0, 255], stray: 40 }));
    assert(!!strays.region && strays.region.count < strays.pixels && strays.region.count > 800, "stray pixels count but the largest patch is the ring");
  });
  test("compareGlowShots: the glow shot must add at least 200 colour pixels over the no-glow shot and hold a patch of at least 100", () => {
    const g = gm.measureGlow(shot({ ring: [255, 0, 255] })), n = gm.measureGlow(shot({}));
    const c = gm.compareGlowShots(g, n);
    eq(c.verdict, "glow"); eq(c.delta, g.pixels - n.pixels); eq(c.glowPixels, g.pixels); eq(c.noglowPixels, 0);
    eq(gm.compareGlowShots(n, n).verdict, "none");
    eq(gm.compareGlowShots(gm.measureGlow(shot({ stray: 300 })), n).verdict, "none", "scattered pixels without a patch are not a rim");
    eq(gm.compareGlowShots(g, g).verdict, "none", "the same rim in both shots is not ours");
  });
  /** glow v2: two units, each optionally ringed in its own colour */
  const twoUnits = (rings: [Px | null, Px | null]) => {
    const W = 640, H = 360, img = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) img.set([40, 44, 40, 255], i * 4);
    const put = (x: number, y: number, c: Px) => { if (x >= 0 && y >= 0 && x < W && y < H) img.set([c[0], c[1], c[2], 255], (y * W + x) * 4); };
    const centres: [number, number][] = [[200, 200], [440, 200]];
    centres.forEach(([cx, cy], k) => {
      for (let y = -40; y <= 40; y++) for (let x = -40; x <= 40; x++) {
        const d = Math.sqrt(x * x + y * y), ring = rings[k];
        if (d <= 30) put(cx + x, cy + y, [136, 136, 136]);
        else if (ring && d <= 36) put(cx + x, cy + y, ring);
      }
    });
    return { width: W, height: H, rgba: img };
  };
  test("glow v2: GLOW_PROBE_COLOUR_B is cyan (no arena/UI hue either) and reads apart from magenta", () => {
    eq(JSON.stringify(gm.GLOW_PROBE_COLOUR_B), JSON.stringify([0, 255, 255]));
    const s = twoUnits([[255, 0, 255], [0, 255, 255]]);
    const m = gm.measureGlow(s, gm.GLOW_PROBE_COLOUR), c = gm.measureGlow(s, gm.GLOW_PROBE_COLOUR_B);
    assert(m.pixels > 800 && c.pixels > 800, `magenta ${m.pixels}, cyan ${c.pixels}`);
    assert(!!m.region && !!c.region && m.region.x1 < 320 && c.region.x0 > 320, `magenta left, cyan right: ${JSON.stringify([m.region, c.region])}`);
  });
  test("glow v2: compareTwoColourShot — each colour must add its own rim over the no-glow shot and the two rims must lie apart (per-unit colours, not one shared colour or one rim painted over both)", () => {
    const base = twoUnits([null, null]);
    const mb = gm.measureGlow(base, gm.GLOW_PROBE_COLOUR), cb = gm.measureGlow(base, gm.GLOW_PROBE_COLOUR_B);
    const read = (s: ReturnType<typeof twoUnits>) => gm.compareTwoColourShot({ a: gm.measureGlow(s, gm.GLOW_PROBE_COLOUR), b: gm.measureGlow(s, gm.GLOW_PROBE_COLOUR_B) }, { a: mb, b: cb });
    const ok = read(twoUnits([[255, 0, 255], [0, 255, 255]]));
    eq(ok.verdict, "two-colour"); eq(ok.apart, true); eq(ok.a.verdict, "glow"); eq(ok.b.verdict, "glow");
    const shared = read(twoUnits([[255, 0, 255], [255, 0, 255]]));   /* v1: the first unit's colour on both */
    eq(shared.verdict, "none"); eq(shared.b.verdict, "none");
    const one = read(twoUnits([[255, 0, 255], null]));
    eq(one.verdict, "none");
    const stacked = gm.compareTwoColourShot({ a: gm.measureGlow(twoUnits([[255, 0, 255], null]), gm.GLOW_PROBE_COLOUR), b: gm.measureGlow(twoUnits([[0, 255, 255], null]), gm.GLOW_PROBE_COLOUR_B) }, { a: mb, b: cb });
    eq(stacked.a.verdict, "glow"); eq(stacked.b.verdict, "glow");
    eq(stacked.apart, false); eq(stacked.verdict, "none", "both colours around the same unit is not per-unit");
  });
  test("OBSERVED 2026-10-22 fixture (unit-glow-summary.json): FW_SetUnitGlow drew a magenta rim around the spawned Rat (glow shot) that the no-glow shot lacks: verdict glow, delta >= 200, a patch >= 100 px, the real save untouched", () => {
    const j = JSON.parse(fixture("unit-glow-summary.json")) as { summary: { verdict: string; delta: number; glowPixels: number; noglowPixels: number; glowRegion: { count: number } | null; verdictRun: string; saveUnchanged: boolean } };
    eq(j.summary.verdict, "glow");
    assert(j.summary.delta >= 200, `delta ${j.summary.delta}`);
    assert(!!j.summary.glowRegion && j.summary.glowRegion.count >= 100, `patch ${JSON.stringify(j.summary.glowRegion)}`);
    eq(j.summary.verdictRun, "pass");
    eq(j.summary.saveUnchanged, true);
  });
}
