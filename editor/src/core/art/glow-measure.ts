// Reads in-game shots of a unit the native glow engine (mewframework FW_SetUnitGlow) was asked to outline: how many
// pixels of the glow colour a shot holds and the largest connected patch of them. The rim the engine draws is the
// game's own composite (composite_glow.shader: glow_color wherever the blurred mask is set and the unblurred mask is
// not), so it appears as a band of the pure colour around the unit; the proof compares a "glow" shot against a
// "noglow" shot of the same still scene (mods/dev-sandbox/tests/unit-glow.mewtest, scripts/unit-glow-probe.ts).
// Pure: works on any RGBA image (decodePng of the shot).

export type Rgb = [number, number, number];
/** the shape png.ts decodePng returns */
export interface RgbaImageLike { width: number; height: number; rgba: Uint8Array }

/** the colour the in-game proof asks for: magenta, which neither the arena nor the UI uses (reds they do) */
export const GLOW_PROBE_COLOUR: Rgb = [255, 0, 255];

export interface GlowRegion { count: number; x0: number; y0: number; x1: number; y1: number }
export interface GlowMeasure {
  /** pixels of the colour anywhere in the shot */
  pixels: number;
  /** the largest 4-connected patch of them, null when there is none */
  region: GlowRegion | null;
}

/** a pixel is the colour when it carries the colour's chroma: every channel the colour has (>= 128) exceeds every
 * channel it lacks by at least 50 (the rim is blended over the scene with a varying alpha, so brightness and the
 * low channels drift; the hue family stays). A gray/white/black target falls back to a closeness test. */
function matches(r: number, g: number, b: number, c: Rgb): boolean {
  const p = [r, g, b];
  const hi = [0, 1, 2].filter((i) => c[i] >= 128), lo = [0, 1, 2].filter((i) => c[i] < 128);
  if (!hi.length || !lo.length) return Math.abs(r - c[0]) <= 40 && Math.abs(g - c[1]) <= 40 && Math.abs(b - c[2]) <= 40;
  return Math.min(...hi.map((i) => p[i]!)) - Math.max(...lo.map((i) => p[i]!)) >= 50;
}

export function measureGlow(img: RgbaImageLike, colour: Rgb = GLOW_PROBE_COLOUR): GlowMeasure {
  const W = img.width, H = img.height;
  const mask = new Uint8Array(W * H);
  let pixels = 0;
  for (let i = 0; i < W * H; i++) {
    if (matches(img.rgba[i * 4]!, img.rgba[i * 4 + 1]!, img.rgba[i * 4 + 2]!, colour)) { mask[i] = 1; pixels++; }
  }
  let best: GlowRegion | null = null;
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 1) continue;
    const reg: GlowRegion = { count: 0, x0: W, y0: H, x1: 0, y1: 0 };
    mask[start] = 2;
    stack.push(start);
    while (stack.length) {
      const k = stack.pop()!;
      const x = k % W, y = (k - x) / W;
      reg.count++;
      if (x < reg.x0) reg.x0 = x; if (y < reg.y0) reg.y0 = y; if (x > reg.x1) reg.x1 = x; if (y > reg.y1) reg.y1 = y;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const nk = ny * W + nx;
        if (mask[nk] === 1) { mask[nk] = 2; stack.push(nk); }
      }
    }
    if (!best || reg.count > best.count) best = reg;
  }
  return { pixels, region: best };
}

/** the glow shot must add at least this many colour pixels over the no-glow shot … */
export const GLOW_MIN_DELTA = 200;
/** … and hold a connected patch at least this big (scattered pixels are not a rim) */
export const GLOW_MIN_PATCH = 100;

export interface GlowComparison {
  verdict: "glow" | "none";
  delta: number;
  glowPixels: number;
  noglowPixels: number;
  glowRegion: GlowRegion | null;
  noglowRegion: GlowRegion | null;
}

export function compareGlowShots(glow: GlowMeasure, noglow: GlowMeasure): GlowComparison {
  const delta = glow.pixels - noglow.pixels;
  const patch = glow.region ? glow.region.count : 0;
  const patchBefore = noglow.region ? noglow.region.count : 0;
  const verdict: GlowComparison["verdict"] = delta >= GLOW_MIN_DELTA && patch >= GLOW_MIN_PATCH && patch - patchBefore >= GLOW_MIN_PATCH ? "glow" : "none";
  return { verdict, delta, glowPixels: glow.pixels, noglowPixels: noglow.pixels, glowRegion: glow.region, noglowRegion: noglow.region };
}

// ---- glow v2 (per-unit colours): two units, two colours, one shot ----

/** the second colour of the v2 proof: cyan, which the arena and the UI do not use either */
export const GLOW_PROBE_COLOUR_B: Rgb = [0, 255, 255];

export interface TwoColourComparison {
  /** "two-colour" when each colour adds its own rim over the no-glow shot and the two rims lie apart */
  verdict: "two-colour" | "none";
  /** colour A (magenta) against the no-glow shot */
  a: GlowComparison;
  /** colour B (cyan) against the no-glow shot */
  b: GlowComparison;
  /** the two largest patches' bounding boxes do not overlap: each rim sits around its own unit */
  apart: boolean;
}

const overlaps = (p: GlowRegion, q: GlowRegion) => p.x0 <= q.x1 && q.x0 <= p.x1 && p.y0 <= q.y1 && q.y0 <= p.y1;

/** the v2 shot ("two": unit 1 in colour A, unit 2 in colour B) against the no-glow shot, both measured in both colours.
 * v1 (one shared colour) gives no colour-B rim; a rim painted over every unit in both colours gives overlapping
 * patches: both are "none". */
export function compareTwoColourShot(two: { a: GlowMeasure; b: GlowMeasure }, noglow: { a: GlowMeasure; b: GlowMeasure }): TwoColourComparison {
  const a = compareGlowShots(two.a, noglow.a), b = compareGlowShots(two.b, noglow.b);
  const apart = !!(a.glowRegion && b.glowRegion) && !overlaps(a.glowRegion!, b.glowRegion!);
  return { verdict: a.verdict === "glow" && b.verdict === "glow" && apart ? "two-colour" : "none", a, b, apart };
}

// ---- glow v3, the removal half: a Temporary FwGlow_ status expires and takes the rim with it ----

/** one unit's status as a units event (the harness `dump`) shows it */
export interface StatusInDump { found: boolean; carries: boolean }

/** does the units event list the unit (by name) and does it carry the status? A missing event or unit: found false. */
export function statusInDump(ev: { [k: string]: unknown } | null | undefined, unit: string, status: string): StatusInDump {
  const list = ev && Array.isArray(ev.list) ? (ev.list as { name?: unknown; statuses?: unknown }[]) : [];
  const u = list.find((x) => x && x.name === unit);
  if (!u) return { found: false, carries: false };
  return { found: true, carries: Array.isArray(u.statuses) && u.statuses.includes(status) };
}

export interface ExpiryComparison {
  /** expired: rim + status first, then neither on the still-living unit. stuck: the rim outlived the status.
   * status-kept: the status had not gone yet (inconclusive). unit-gone: the unit died / left (inconclusive).
   * no-glow: no rim or no status at the first check (the grant itself failed). */
  verdict: "expired" | "stuck" | "status-kept" | "unit-gone" | "no-glow";
  /** the "glow" shot (status live) against the pre-spawn shot */
  glow: GlowComparison;
  /** the "expired" shot (after the Temporary ran out) against the pre-spawn shot */
  expired: GlowComparison;
  status: { atGlow: StatusInDump; atExpired: StatusInDump };
}

export function compareExpiry(shots: { glow: GlowMeasure; expired: GlowMeasure; noglow: GlowMeasure }, status: { atGlow: StatusInDump; atExpired: StatusInDump }): ExpiryComparison {
  const glow = compareGlowShots(shots.glow, shots.noglow), expired = compareGlowShots(shots.expired, shots.noglow);
  let verdict: ExpiryComparison["verdict"];
  if (glow.verdict !== "glow" || !status.atGlow.carries) verdict = "no-glow";
  else if (!status.atExpired.found) verdict = "unit-gone";
  else if (status.atExpired.carries) verdict = "status-kept";
  else verdict = expired.verdict === "glow" ? "stuck" : "expired";
  return { verdict, glow, expired, status };
}
