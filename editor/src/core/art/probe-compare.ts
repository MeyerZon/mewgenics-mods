// Reads in-game screenshots of the _artprobe clip (mods/_artprobe/art/probe.scene.json) and answers how the game
// draws our art. Layout in clip pixels: a checker bitmap at (0,0)-(96,64) — an 8×8 bitmap scaled ×8 over a path 12
// texels wide, with a pure-yellow 1-texel border, so its last third is outside the bitmap — then 60×60 squares
// centred at (150,30) the nested blink sprite (red → green → blue every 30 frames inside a one-frame holder),
// (230,30) a gray:8 control, (310,30) gray:8 with cxform mul [1,0,0,1] and (390,30) a linear gradient gray:0 → #ff2020
// along clip x, and two 12 px #20ff20 strokes from clip x 440 to 500 (y 10 butt caps, y 50 square caps; DefineShape4).
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
  const none: ProbeShot = { found: false, scale: 0, mirrored: false, sampling: "unknown", blendedRatio: 0, edge: "unknown", blink: "other", control: [0, 0, 0], cx: [0, 0, 0], gradient: "unknown", gradLeft: [0, 0, 0], gradRight: [0, 0, 0], caps: "unknown", box: null };
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
  return {
    gradient, gradLeft, gradRight, caps,
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
    `- LINESTYLE2 caps (DefineShape4; butt vs square stroke length): **${s.caps}**`,
    `- linear gradient fill (gray:0 → #ff2020 along clip x): **${s.gradient}** (left/right rgb per shot: ${shots.map((p) => `${p.gradLeft.join(",")} / ${p.gradRight.join(",")}`).join("; ") || "-"})`,
    `- marker found in ${s.found} of ${s.shots} shot(s)`,
    "",
  ].join("\n");
}
