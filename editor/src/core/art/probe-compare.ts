// Reads in-game screenshots of the _artprobe clip (mods/_artprobe/art/probe.scene.json) and answers how the game
// draws our art. Layout in clip pixels: a checker bitmap at (0,0)-(96,64) — an 8×8 bitmap scaled ×8 over a path 12
// texels wide, with a pure-yellow 1-texel border, so its last third is outside the bitmap — then 60×60 squares
// centred at (150,30) the nested blink sprite (red → green → blue every 30 frames inside a one-frame holder),
// (230,30) a gray:8 control, (310,30) gray:8 with cxform mul [1,0,0,1] and (390,30) a linear gradient gray:0 → #ff2020
// along clip x, a 20 px white walker tweening clip x 600 → 680 over the root clip's own 60 frames, a #600000 square at (550,30) placed with blend add (PlaceObject3), and two 12 px #20ff20 strokes from clip x 440 to 500 (y 10 butt caps, y 50 square caps; DefineShape4).
// The yellow marker gives the screen
// scale and position; whether the magenta/cyan cells sit left or right inside it gives the orientation (enemies
// face left: the clip is mirrored). Pure: works on any RGBA image (decodePng of the shot).

export type Rgb = [number, number, number];
/** the shape png.ts decodePng returns */
export interface RgbaImageLike { width: number; height: number; rgba: Uint8Array }

export interface ProbeShot {
  found: boolean;
  /** screen px per clip px */
  scale: number;
  /** the clip is drawn mirrored horizontally */
  mirrored: boolean;
  /** "nearest" when the checker cells stay pure, "smooth" when blended pixels fill the cell interiors */
  sampling: "nearest" | "smooth" | "unknown";
  /** share of non-palette pixels inside the cell area (the blend measure behind `sampling`) */
  blendedRatio: number;
  /** the part of the path outside the bitmap: "clamp" (the border colour streaks), "repeat" (the cells again) */
  edge: "clamp" | "repeat" | "unknown";
  blink: "red" | "green" | "blue" | "other";
  control: Rgb;
  cx: Rgb;
  /** the gradient square read in clip x: "drawn" (dark → red), "reversed", "flat" (one colour), "unknown" */
  gradient: "drawn" | "reversed" | "flat" | "unknown";
  /** its left / right patches (clip x 370 / 410) */
  gradLeft: Rgb;
  gradRight: Rgb;
  /** LINESTYLE2 caps: "honoured" (butt stops at the endpoint, square reaches past it), "ignored" (both reach past: round) */
  caps: "honoured" | "ignored" | "unknown";
  /** the add-blended square: "honoured" (the background shows through: green > 0), "ignored" (plain #600000) */
  blend: "honoured" | "ignored" | "unknown";
  blendRgb: Rgb;
  /** the walker's centre in clip x (NaN when not found) */
  walkerX: number;
  /** the PROBE DefineEditText (mint #00ffa0, game font Peralta) in the clip box x 220..380, y 70..110 */
  text: "drawn" | "missing";
  textPixels: number;
  /** the marker's screen bbox */
  box: { x0: number; y0: number; x1: number; y1: number } | null;
}

const near = (r: number, g: number, b: number, c: Rgb, tol: number) => Math.abs(r - c[0]) <= tol && Math.abs(g - c[1]) <= tol && Math.abs(b - c[2]) <= tol;
const YELLOW: Rgb = [255, 255, 0], MAGENTA: Rgb = [255, 0, 255], CYAN: Rgb = [0, 255, 255];

function px(img: RgbaImageLike, x: number, y: number): Rgb {
  const i = (y * img.width + x) * 4;
  return [img.rgba[i]!, img.rgba[i + 1]!, img.rgba[i + 2]!];
}

/** mean colour of a (2r+1)² patch, clamped to the image */
function patch(img: RgbaImageLike, cx: number, cy: number, r = 3): Rgb {
  let n = 0, s0 = 0, s1 = 0, s2 = 0;
  for (let y = Math.round(cy) - r; y <= Math.round(cy) + r; y++) for (let x = Math.round(cx) - r; x <= Math.round(cx) + r; x++) {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
    const p = px(img, x, y); s0 += p[0]; s1 += p[1]; s2 += p[2]; n++;
  }
  return n ? [Math.round(s0 / n), Math.round(s1 / n), Math.round(s2 / n)] : [0, 0, 0];
}

function classifyBlink(c: Rgb): ProbeShot["blink"] {
  const [r, g, b] = c;
  if (r > 160 && g < 110 && b < 110) return "red";
  if (g > 160 && r < 110 && b < 110) return "green";
  if (b > 160 && r < 110 && g < 110) return "blue";
  return "other";
}

export function analyzeProbeShot(img: RgbaImageLike): ProbeShot {
  const none: ProbeShot = { found: false, scale: 0, mirrored: false, sampling: "unknown", blendedRatio: 0, edge: "unknown", blink: "other", control: [0, 0, 0], cx: [0, 0, 0], gradient: "unknown", gradLeft: [0, 0, 0], gradRight: [0, 0, 0], caps: "unknown", blend: "unknown", blendRgb: [0, 0, 0], walkerX: NaN, text: "missing", textPixels: 0, box: null };
  // 1. the yellow marker: the largest 8-connected region of near-yellow pixels (stray UI yellow elsewhere is ignored)
  const W = img.width, H = img.height;
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [r, g, b] = px(img, x, y);
    if (near(r, g, b, YELLOW, 50) && b < 90) mask[y * W + x] = 1;
  }
  let x0 = 0, y0 = 0, x1 = -1, y1 = -1, count = 0;
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 1) continue;
    let n = 0, bx0 = Infinity, by0 = Infinity, bx1 = -1, by1 = -1;
    mask[start] = 2;
    stack.push(start);
    while (stack.length) {
      const k = stack.pop()!;
      const x = k % W, y = (k - x) / W;
      n++;
      if (x < bx0) bx0 = x; if (y < by0) by0 = y; if (x > bx1) bx1 = x; if (y > by1) by1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const nk = ny * W + nx;
        if (mask[nk] === 1) { mask[nk] = 2; stack.push(nk); }
      }
    }
    if (n > count) { count = n; x0 = bx0; y0 = by0; x1 = bx1; y1 = by1; }
  }
  if (count < 30) return none;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const scale = w / 96;
  if (Math.abs(h / scale - 64) > 12) return { ...none, box: { x0, y0, x1, y1 } };
  // 2. orientation: where the magenta/cyan cells are inside the marker
  let mcSum = 0, mcN = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const [r, g, b] = px(img, x, y);
    if (near(r, g, b, MAGENTA, 70) || near(r, g, b, CYAN, 70)) { mcSum += (x - x0) / w; mcN++; }
  }
  if (!mcN) return { ...none, box: { x0, y0, x1, y1 } };
  // the cxform square (gray:8 × mul [1,0,0,1] = a dark red) lies on the side the clip extends to: the surest
  // orientation cue; fall back to where the cells sit (the left two thirds when not mirrored)
  const reddish = (c: Rgb) => c[0] > 70 && c[0] > c[1] + 50 && c[0] > c[2] + 50;
  const atRight = patch(img, x0 + 310 * scale, y0 + 30 * scale), atLeft = patch(img, x1 + 1 - 310 * scale, y0 + 30 * scale);
  const mirrored = reddish(atLeft) && !reddish(atRight) ? true : reddish(atRight) && !reddish(atLeft) ? false : mcSum / mcN > 0.5;
  /** clip coordinates -> screen */
  const sx = (cx: number) => (mirrored ? x1 + 1 - cx * scale : x0 + cx * scale);
  const sy = (cy: number) => y0 + cy * scale;
  // 3. sampling: the cell interiors (clip 12..52 × 12..52, away from the border) — pure palette colours or blends?
  let blended = 0, cells = 0;
  for (let cy = 12; cy < 52; cy += 1 / Math.max(scale, 0.5)) for (let cx = 12; cx < 52; cx += 1 / Math.max(scale, 0.5)) {
    const x = Math.round(sx(cx)), y = Math.round(sy(cy));
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
    const [r, g, b] = px(img, x, y);
    cells++;
    if (!near(r, g, b, MAGENTA, 40) && !near(r, g, b, CYAN, 40) && !near(r, g, b, YELLOW, 40)) blended++;
  }
  const blendedRatio = cells ? blended / cells : 0;
  // 4. edge: the last third of the path (clip x 68..92, inside the border band) — yellow streak or cells again?
  let yel = 0, mc = 0, n = 0;
  for (let cy = 12; cy < 52; cy += 2) for (let cx = 72; cx < 92; cx += 2) {
    const x = Math.round(sx(cx)), y = Math.round(sy(cy));
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
    const [r, g, b] = px(img, x, y);
    n++;
    if (near(r, g, b, YELLOW, 60)) yel++;
    else if (near(r, g, b, MAGENTA, 80) || near(r, g, b, CYAN, 80)) mc++;
  }
  const edge: ProbeShot["edge"] = n && yel / n > 0.8 ? "clamp" : n && mc / n > 0.3 ? "repeat" : "unknown";
  // 5. the squares
  const blink = classifyBlink(patch(img, sx(150), sy(30)));
  const gradLeft = patch(img, sx(370), sy(30)), gradRight = patch(img, sx(410), sy(30));
  const dr = gradRight[0] - gradLeft[0];
  const gradient: ProbeShot["gradient"] = dr > 60 ? "drawn" : dr < -60 ? "reversed" : Math.abs(dr) < 25 && gradRight[0] > 40 ? "flat" : "unknown";
  // the two strokes' green lengths in clip px (robust to a few px of placement offset): butt 60, square 72
  const green = (c: Rgb) => c[1] > 160 && c[0] < 120 && c[2] < 120;
  const greenLength = (cy: number): number => {
    let n = 0;
    for (let cx = 410; cx <= 540; cx += 0.5) {
      const x = Math.round(sx(cx)), y = Math.round(sy(cy));
      if (x >= 0 && y >= 0 && x < img.width && y < img.height && green(px(img, x, y))) n++;
    }
    return n / 2;
  };
  const buttLen = greenLength(10), squareLen = greenLength(50);
  const caps: ProbeShot["caps"] = buttLen < 40 || squareLen < 40 ? "unknown" : squareLen - buttLen >= 7 ? "honoured" : Math.abs(squareLen - buttLen) <= 3 ? "ignored" : "unknown";
  const blendRgb = patch(img, sx(550), sy(30));
  const blend: ProbeShot["blend"] = blendRgb[0] > 110 && blendRgb[1] > 25 ? "honoured" : blendRgb[1] < 15 && blendRgb[0] > 60 && blendRgb[0] < 135 ? "ignored" : "unknown";
  // the walker: white columns in the band clip y 24..36, clip x 570..710; a 15..25 px run is the square (a banner is wider)
  const cols: number[] = [];
  for (let cx = 570; cx <= 710; cx += 0.5) {
    let white = 0;
    for (let cy = 24; cy <= 36; cy += 2) {
      const x = Math.round(sx(cx)), y = Math.round(sy(cy));
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const c = px(img, x, y);
      if (c[0] > 225 && c[1] > 225 && c[2] > 225) white++;
    }
    if (white >= 5) cols.push(cx);
  }
  const span = cols.length ? cols[cols.length - 1]! - cols[0]! : 0;
  const walkerX = cols.length && span >= 12 && span <= 26 ? (cols[0]! + cols[cols.length - 1]!) / 2 : NaN;
  let textPixels = 0;
  for (let cy = 70; cy <= 110; cy += 0.5) for (let cx = 220; cx <= 380; cx += 0.5) {
    const x = Math.round(sx(cx)), y = Math.round(sy(cy));
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
    const c = px(img, x, y);
    if (c[1] > 150 && c[0] < 90 && c[2] > 90 && c[2] < 220) textPixels++;
  }
  const text: ProbeShot["text"] = textPixels > 40 ? "drawn" : "missing";
  return {
    gradient, gradLeft, gradRight, caps, blend, blendRgb, walkerX, text, textPixels,
    found: true, scale, mirrored,
    sampling: blendedRatio > 0.1 ? "smooth" : "nearest",
    blendedRatio, edge, blink,
    control: patch(img, sx(230), sy(30)),
    cx: patch(img, sx(310), sy(30)),
    box: { x0, y0, x1, y1 },
  };
}

export interface ProbeSummary {
  shots: number;
  found: number;
  /** the nested sprite under a one-frame parent: "free-running" (its own clock: the colour changes), "held" (never changes) */
  childFraming: "free-running" | "held" | "unknown";
  sampling: ProbeShot["sampling"];
  edge: ProbeShot["edge"];
  /** the cxform square vs the control: mul [1,0,0,1] keeps red, drops green/blue */
  cxform: "applied" | "ignored" | "unknown";
  mirrored: boolean;
  blinks: ProbeShot["blink"][];
  /** the linear gradient square across shots */
  gradient: ProbeShot["gradient"];
  /** LINESTYLE2 caps across shots */
  caps: ProbeShot["caps"];
  /** PlaceObject3 blend add across shots */
  blend: ProbeShot["blend"];
  /**
   * the root clip's own timeline: "plays" (the walker ranges over its 600..680 path between shots), "held" (it never
   * moves), "game-driven" (it moves but stays near the start: the game keeps restarting the character's root clip)
   */
  rootTimeline: "plays" | "held" | "game-driven" | "unknown";
  /** the PROBE text across shots */
  text: ProbeShot["text"];
  walkerXs: number[];
}

const parseColours = (colours: Record<string, string>) => Object.entries(colours).map(([k, hex]) => [k, [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)] as Rgb] as const);

/** pixel i of img is colour c up to a uniform tint factor 0.55..1.15 (units are tinted by where they stand) and ±24 per channel */
function matchTinted(img: RgbaImageLike, i: number, c: Rgb): boolean {
  const r = img.rgba[i * 4]!, g = img.rgba[i * 4 + 1]!, b = img.rgba[i * 4 + 2]!;
  const cc = c[0] * c[0] + c[1] * c[1] + c[2] * c[2];
  if (!cc) return r < 24 && g < 24 && b < 24;
  const k = (r * c[0] + g * c[1] + b * c[2]) / cc;
  if (k < 0.55 || k > 1.15) return false;
  return Math.abs(r - k * c[0]) <= 24 && Math.abs(g - k * c[1]) <= 24 && Math.abs(b - k * c[2]) <= 24;
}

/** pixel i differs between two same-sized images by more than tol (|dr| + |dg| + |db|) */
function changedAt(img: RgbaImageLike, ref: RgbaImageLike, i: number, tol: number): boolean {
  const j = i * 4;
  return Math.abs(img.rgba[j]! - ref.rgba[j]!) + Math.abs(img.rgba[j + 1]! - ref.rgba[j + 1]!) + Math.abs(img.rgba[j + 2]! - ref.rgba[j + 2]!) > tol;
}

export interface ChangedRegion { n: number; x0: number; y0: number; x1: number; y1: number; cx: number; cy: number }

/** pixel i of img is near-black: every channel below `dark` */
function darkAt(img: RgbaImageLike, i: number, dark: number): boolean {
  const j = i * 4;
  return img.rgba[j]! < dark && img.rgba[j + 1]! < dark && img.rgba[j + 2]! < dark;
}

/**
 * The largest 8-connected region of pixels that differ from `ref` (a shot of the same scene taken before something
 * was spawned) by more than `tol`; its bbox centre is where the new thing is. null when nothing changed. Crude by
 * design: idle bobbing of other units and UI changes also differ, but the spawned unit is the biggest blob — unless
 * the floor overlay toggles (OBSERVED: the move-range highlight), when the whole arena is the blob; with `dark`
 * only near-black pixels count, which the overlay never adds and a real cat's outline is made of.
 */
export function largestChangedRegion(img: RgbaImageLike, ref: RgbaImageLike, opts: number | { tol?: number; dark?: number; within?: { x0: number; y0: number; x1: number; y1: number } } = 60): ChangedRegion | null {
  const tol = typeof opts === "number" ? opts : opts.tol ?? 60;
  const dark = typeof opts === "number" ? undefined : opts.dark;
  const W = img.width, H = img.height;
  if (ref.width !== W || ref.height !== H) return null;
  const win = typeof opts === "number" || !opts.within ? { x0: 0, y0: 0, x1: W - 1, y1: H - 1 } : opts.within;
  const mask = new Uint8Array(W * H);
  for (let y = Math.max(0, win.y0); y <= Math.min(H - 1, win.y1); y++) for (let x = Math.max(0, win.x0); x <= Math.min(W - 1, win.x1); x++) {
    const i = y * W + x;
    if (changedAt(img, ref, i, tol) && (dark === undefined || darkAt(img, i, dark))) mask[i] = 1;
  }
  let best: ChangedRegion | null = null;
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 1) continue;
    const reg = { n: 0, x0: W, y0: H, x1: -1, y1: -1 };
    mask[start] = 2;
    stack.push(start);
    while (stack.length) {
      const k = stack.pop()!;
      const x = k % W, y = (k - x) / W;
      reg.n++;
      if (x < reg.x0) reg.x0 = x; if (y < reg.y0) reg.y0 = y; if (x > reg.x1) reg.x1 = x; if (y > reg.y1) reg.y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const nk = ny * W + nx;
        if (mask[nk] === 1) { mask[nk] = 2; stack.push(nk); }
      }
    }
    if (!best || reg.n > best.n) best = { ...reg, cx: (reg.x0 + reg.x1) / 2, cy: (reg.y0 + reg.y1) / 2 };
  }
  return best;
}

export interface ChangedNear {
  /** pixels within the radius that differ from the reference shot */
  changed: number;
  /** of those, the ones in an `exclude` colour (the rig's slot colours, the marker's) */
  excluded: number;
  /** the rest: what was drawn here that is neither our slot colours nor our marker — real cat parts, or nothing */
  other: number;
  /** with `perColour`: the excluded pixels by colour name (which slot colours appeared here; the marker's own) */
  colours?: Record<string, number>;
}

/**
 * The pixels within `radius` of `centre` (Euclidean, screen px) that differ from `ref` by more than `tol`, split into
 * the `exclude` colours (matched like slotColoursPresent, tint-tolerant) and the rest. The "cat parts near the
 * marker" measure of the cat append probe: run on the rig shot against the shot before the rig cat spawned, centred
 * on the marker, excluding the seven slot colours and the marker's own yellow / magenta / cyan.
 */
export function changedPixelsNear(img: RgbaImageLike, ref: RgbaImageLike, centre: { x: number; y: number }, radius: number, opts: { tol?: number; exclude?: Record<string, string>; perColour?: boolean } = {}): ChangedNear {
  const out: ChangedNear = { changed: 0, excluded: 0, other: 0 };
  const W = img.width, H = img.height;
  if (ref.width !== W || ref.height !== H) return out;
  const tol = opts.tol ?? 60;
  const excl = parseColours(opts.exclude || {});
  const colours: Record<string, number> | null = opts.perColour ? Object.fromEntries(excl.map(([k]) => [k, 0])) : null;
  if (colours) out.colours = colours;
  const x0 = Math.max(0, Math.floor(centre.x - radius)), x1 = Math.min(W - 1, Math.ceil(centre.x + radius));
  const y0 = Math.max(0, Math.floor(centre.y - radius)), y1 = Math.min(H - 1, Math.ceil(centre.y + radius));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if ((x - centre.x) ** 2 + (y - centre.y) ** 2 > radius * radius) continue;
    const i = y * W + x;
    if (!changedAt(img, ref, i, tol)) continue;
    out.changed++;
    const hit = excl.find(([, c]) => matchTinted(img, i, c));
    if (hit) { out.excluded++; if (colours) colours[hit[0]]!++; } else out.other++;
  }
  return out;
}

/**
 * The near-black pixels within `radius` of `centre` that are new vs `ref` (changed by more than `tol`): a real cat's
 * outline. The "real parts" measure of the cat append probe — the floor overlay (re-lighting, the move-range
 * highlight) and the re-tinted units it touches never add black, and neither our rig nor the marker has any.
 */
export function darkPixelsNear(img: RgbaImageLike, ref: RgbaImageLike, centre: { x: number; y: number }, radius: number, opts: { tol?: number; dark?: number } = {}): number {
  const W = img.width, H = img.height;
  if (ref.width !== W || ref.height !== H) return 0;
  const tol = opts.tol ?? 60, dark = opts.dark ?? 40;
  let n = 0;
  const x0 = Math.max(0, Math.floor(centre.x - radius)), x1 = Math.min(W - 1, Math.ceil(centre.x + radius));
  const y0 = Math.max(0, Math.floor(centre.y - radius)), y1 = Math.min(H - 1, Math.ceil(centre.y + radius));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if ((x - centre.x) ** 2 + (y - centre.y) ** 2 > radius * radius) continue;
    const i = y * W + x;
    if (darkAt(img, i, dark) && changedAt(img, ref, i, tol)) n++;
  }
  return n;
}

/** The marker's yellow border and magenta / cyan cells (probe.scene.json `checker`), as exclude colours. */
export const MARKER_COLOURS: Record<string, string> = { markerYellow: "#ffff00", markerMagenta: "#ff00ff", markerCyan: "#00ffff" };

/**
 * Pixels of each named #rrggbb colour, allowing a uniform darkening / brightening (the game tints units by where they
 * stand: OBSERVED 2026-10-20 the cat rig's colours came back at ~0.8–0.86). With `anchor`, only pixels within
 * `radius` px of the anchor colour's largest connected region count (UI elsewhere on screen is ignored); with
 * `centre`, the window is `radius` around that point instead (the marker's centre when the slots may be gone).
 */
export function slotColoursPresent(img: RgbaImageLike, colours: Record<string, string>, opts: { anchor?: string; radius?: number; centre?: { x: number; y: number } } = {}): Record<string, number> {
  const want = parseColours(colours);
  const match = (i: number, c: Rgb): boolean => matchTinted(img, i, c);
  const W = img.width, H = img.height;
  let win = { x0: 0, y0: 0, x1: W - 1, y1: H - 1 };
  if (opts.centre) {
    const r = opts.radius ?? 400;
    win = { x0: Math.max(0, Math.round(opts.centre.x - r)), y0: Math.max(0, Math.round(opts.centre.y - r)), x1: Math.min(W - 1, Math.round(opts.centre.x + r)), y1: Math.min(H - 1, Math.round(opts.centre.y + r)) };
  } else if (opts.anchor && colours[opts.anchor]) {
    const c = want.find(([k]) => k === opts.anchor)![1];
    const seen = new Uint8Array(W * H);
    let best: { n: number; x0: number; y0: number; x1: number; y1: number } | null = null;
    for (let i = 0; i < W * H; i++) {
      if (seen[i] || !match(i, c)) continue;
      const stack = [i];
      seen[i] = 1;
      const reg = { n: 0, x0: W, y0: H, x1: 0, y1: 0 };
      while (stack.length) {
        const j = stack.pop()!;
        const x = j % W, y = (j / W) | 0;
        reg.n++; reg.x0 = Math.min(reg.x0, x); reg.x1 = Math.max(reg.x1, x); reg.y0 = Math.min(reg.y0, y); reg.y1 = Math.max(reg.y1, y);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const q = ny * W + nx;
          if (!seen[q] && match(q, c)) { seen[q] = 1; stack.push(q); }
        }
      }
      if (!best || reg.n > best.n) best = reg;
    }
    if (!best) return Object.fromEntries(want.map(([k]) => [k, 0]));
    const r = opts.radius ?? 400;
    win = { x0: Math.max(0, best.x0 - r), y0: Math.max(0, best.y0 - r), x1: Math.min(W - 1, best.x1 + r), y1: Math.min(H - 1, best.y1 + r) };
  }
  const out: Record<string, number> = Object.fromEntries(want.map(([k]) => [k, 0]));
  for (let y = win.y0; y <= win.y1; y++) for (let x = win.x0; x <= win.x1; x++) {
    const i = y * W + x;
    for (const [k, c] of want) if (match(i, c)) { out[k]!++; break; }
  }
  return out;
}

function walkerVerdict(xs: number[]): ProbeSummary["rootTimeline"] {
  const v = xs.filter((x) => Number.isFinite(x));
  if (v.length < 2) return "unknown";
  const range = Math.max(...v) - Math.min(...v);
  if (range <= 3) return "held";
  // shots are ~40 game frames apart while the nested blink advances ~30+ frames per shot: a free-running 60-frame root
  // would spread the walker over most of its 80 px path
  if (range >= 30) return "plays";
  return Math.max(...v) < 625 ? "game-driven" : "unknown";
}

function majority<T extends string>(xs: T[], fallback: T): T {
  const c = new Map<T, number>();
  for (const x of xs) c.set(x, (c.get(x) || 0) + 1);
  let best = fallback, n = 0;
  for (const [k, v] of c) if (v > n) { best = k; n = v; }
  return best;
}

export function summarizeProbe(shots: ProbeShot[]): ProbeSummary {
  const ok = shots.filter((s) => s.found);
  const blinks = ok.map((s) => s.blink);
  const distinct = new Set(blinks.filter((b) => b !== "other"));
  const cxApplied = ok.filter((s) => Math.abs(s.cx[0] - s.control[0]) < 40 && s.cx[1] < 50 && s.cx[2] < 50).length;
  const cxIgnored = ok.filter((s) => Math.abs(s.cx[1] - s.control[1]) < 25 && Math.abs(s.cx[2] - s.control[2]) < 25).length;
  return {
    shots: shots.length,
    found: ok.length,
    childFraming: ok.length < 2 ? "unknown" : distinct.size >= 2 ? "free-running" : "held",
    sampling: majority(ok.map((s) => s.sampling), "unknown"),
    edge: majority(ok.map((s) => s.edge), "unknown"),
    cxform: !ok.length ? "unknown" : cxApplied > ok.length / 2 ? "applied" : cxIgnored > ok.length / 2 ? "ignored" : "unknown",
    mirrored: ok.length ? majority(ok.map((s) => (s.mirrored ? "y" : "n")), "n") === "y" : false,
    blinks,
    gradient: majority(ok.map((s) => s.gradient), "unknown"),
    caps: majority(ok.map((s) => s.caps), "unknown"),
    blend: majority(ok.map((s) => s.blend), "unknown"),
    rootTimeline: walkerVerdict(ok.map((s) => s.walkerX)),
    text: majority(ok.map((s) => s.text), "missing"),
    walkerXs: ok.map((s) => (Number.isFinite(s.walkerX) ? Math.round(s.walkerX) : -1)),
  };
}

export function renderProbeReport(shots: ProbeShot[], s: ProbeSummary, labels: string[] = []): string {
  const rows = shots.map((p, i) => `| ${labels[i] || i + 1} | ${p.found ? "yes" : "no"} | ${p.found ? p.scale.toFixed(2) : "-"} | ${p.mirrored ? "yes" : "no"} | ${p.sampling} (${(p.blendedRatio * 100).toFixed(0)} % blended) | ${p.edge} | ${p.blink} | ${p.control.join(",")} | ${p.cx.join(",")} |`);
  return [
    "# Art probe — how the game draws the _artprobe clip",
    "",
    "| shot | marker | scale | mirrored | sampling | edge | blink | control rgb | cxform rgb |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
    `- nested sprite under a one-frame parent: **${s.childFraming}** (blink colours: ${s.blinks.join(" → ") || "-"})`,
    `- bitmap sampling: **${s.sampling}**; outside the bitmap: **${s.edge}**`,
    `- PlaceObject cxform mul [1,0,0,1]: **${s.cxform}**`,
    `- orientation: ${s.mirrored ? "**mirrored** (the enemy faces left)" : "as authored"}`,
    `- DefineEditText in the game font (PROBE, mint): **${s.text}** (text pixels per shot: ${shots.map((p) => p.textPixels).join(", ") || "-"})`,
    `- root clip timeline (walker on 60 frames): **${s.rootTimeline}** (walker clip x per shot: ${s.walkerXs.join(", ") || "-"})`,
    `- PlaceObject3 blend add (#600000 over the arena): **${s.blend}** (rgb per shot: ${shots.map((p) => p.blendRgb.join(",")).join("; ") || "-"})`,
    `- LINESTYLE2 caps (DefineShape4; butt vs square stroke length): **${s.caps}**`,
    `- linear gradient fill (gray:0 → #ff2020 along clip x): **${s.gradient}** (left/right rgb per shot: ${shots.map((p) => `${p.gradLeft.join(",")} / ${p.gradRight.join(",")}`).join("; ") || "-"})`,
    `- marker found in ${s.found} of ${s.shots} shot(s)`,
    "",
  ].join("\n");
}
