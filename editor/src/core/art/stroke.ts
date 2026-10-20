// Stroke geometry for the preview: polylines → polygons covering the stroke (one quad per segment, joins, caps),
// all oriented the same way so one nonzero stencil pass covers their union exactly once. Pure; the GL preview
// fills these, and the tests pin caps / joins / the miter limit (SVG semantics: miter length / stroke width).

export type StrokeCap = "round" | "butt" | "square";
export type StrokeJoin = "round" | "bevel" | "miter";
export interface StrokeStyle {
  cap?: StrokeCap;
  join?: StrokeJoin;
  /** max miter length / stroke width before a miter becomes a bevel (default 4) */
  miterLimit?: number;
}

function area(poly: number[]): number {
  let a = 0;
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += poly[2 * i]! * poly[2 * j + 1]! - poly[2 * j]! * poly[2 * i + 1]!;
  }
  return a / 2;
}

function orientNegative(poly: number[]): number[] {
  if (area(poly) <= 0) return poly;
  const n = poly.length / 2;
  const rev: number[] = new Array(poly.length);
  for (let i = 0; i < n; i++) {
    rev[2 * i] = poly[2 * (n - 1 - i)]!;
    rev[2 * i + 1] = poly[2 * (n - 1 - i) + 1]!;
  }
  return rev;
}

function disc(cx: number, cy: number, h: number): number[] {
  const out: number[] = [];
  for (let s = 0; s < 16; s++) {
    const a = (s / 16) * Math.PI * 2;
    out.push(cx + Math.cos(a) * h, cy + Math.sin(a) * h);
  }
  return out;
}

/**
 * @param polys polylines [x0,y0,x1,y1,…] in stage px @param closed per polyline @param width stage px
 * @param style caps/joins (default round/round: Flash's default line style)
 */
export function strokePolys(polys: number[][], closed: boolean[], width: number, style: StrokeStyle = {}): number[][] {
  const cap = style.cap || "round";
  const join = style.join || "round";
  const limit = style.miterLimit && style.miterLimit >= 1 ? style.miterLimit : 4;
  const out: number[][] = [];
  const h = width / 2;
  for (let k = 0; k < polys.length; k++) {
    const raw = polys[k]!;
    // drop repeated points (zero-length segments have no direction)
    const pts: number[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      const x = raw[i]!, y = raw[i + 1]!;
      if (pts.length && Math.abs(pts[pts.length - 2]! - x) < 1e-9 && Math.abs(pts[pts.length - 1]! - y) < 1e-9) continue;
      pts.push(x, y);
    }
    const isClosed = !!closed[k];
    let n = pts.length / 2;
    if (isClosed && n > 2 && Math.abs(pts[0]! - pts[2 * n - 2]!) < 1e-9 && Math.abs(pts[1]! - pts[2 * n - 1]!) < 1e-9) {
      pts.length -= 2;
      n--;
    }
    if (n < 2) {
      if (n === 1 && cap !== "butt") out.push(orientNegative(cap === "round" ? disc(pts[0]!, pts[1]!, h) : [pts[0]! - h, pts[1]! - h, pts[0]! + h, pts[1]! - h, pts[0]! + h, pts[1]! + h, pts[0]! - h, pts[1]! + h]));
      continue;
    }
    const segs = isClosed ? n : n - 1;
    const dir: [number, number][] = [];
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      const dx = pts[2 * j]! - pts[2 * i]!;
      const dy = pts[2 * j + 1]! - pts[2 * i + 1]!;
      const len = Math.hypot(dx, dy);
      dir.push([dx / len, dy / len]);
    }
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      let x0 = pts[2 * i]!, y0 = pts[2 * i + 1]!, x1 = pts[2 * j]!, y1 = pts[2 * j + 1]!;
      const [ux, uy] = dir[i]!;
      if (!isClosed && cap === "square") {
        if (i === 0) { x0 -= ux * h; y0 -= uy * h; }
        if (i === segs - 1) { x1 += ux * h; y1 += uy * h; }
      }
      const nx = -uy * h, ny = ux * h;
      out.push(orientNegative([x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny]));
    }
    if (!isClosed && cap === "round") {
      out.push(orientNegative(disc(pts[0]!, pts[1]!, h)));
      out.push(orientNegative(disc(pts[2 * n - 2]!, pts[2 * n - 1]!, h)));
    }
    // joins: every vertex of a closed polyline, the interior ones of an open one
    for (let v = isClosed ? 0 : 1; v < (isClosed ? n : n - 1); v++) {
      const vx = pts[2 * v]!, vy = pts[2 * v + 1]!;
      if (join === "round") {
        out.push(orientNegative(disc(vx, vy, h)));
        continue;
      }
      const d1 = dir[(v - 1 + segs) % segs]!;
      const d2 = dir[v % segs]!;
      const n1x = -d1[1] * h, n1y = d1[0] * h, n2x = -d2[1] * h, n2y = d2[0] * h;
      for (const s of [1, -1]) {
        const ax = vx + s * n1x, ay = vy + s * n1y, bx = vx + s * n2x, by = vy + s * n2y;
        let poly = [vx, vy, ax, ay, bx, by];
        if (join === "miter") {
          const mx = n1x + n2x, my = n1y + n2y;
          const ml = Math.hypot(mx, my);
          if (ml > 1e-9) {
            const cosHalf = ((n1x * mx + n1y * my) / (h * ml));
            if (cosHalf > 1e-9 && 1 / cosHalf <= limit) {
              const dist = h / cosHalf;
              poly = [vx, vy, ax, ay, vx + (s * mx * dist) / ml, vy + (s * my * dist) / ml, bx, by];
            }
          }
        }
        if (Math.abs(area(poly)) > 1e-12) out.push(orientNegative(poly));
      }
    }
  }
  return out;
}
