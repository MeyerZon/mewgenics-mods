// Reads the in-game proof of the 3D phase-M3 unit facing (native/framework/src/fw_unit_face.c): a unit model turns with
// Character::Face. mewframework logs "unit model face: <entry> handle=<h> dir=(<dx> <dy>) yaw=<deg> src=dir|flip
// ms=<epoch ms>" each time a unit model's face yaw changes. The probe model (mods/_unitface/models/face-box.obj) is a
// box with a cyan FRONT face, a yellow BACK face and magenta sides, so a shot tells which face looks at the camera and
// on which side of the box it sits. Pure: works on decodePng'd shots + the log text.
import type { RgbaImageLike } from "./glow-measure.ts";

export interface UnitFaceLine { entry: string; handle: number; dir: [number, number]; yaw: number; src: "dir" | "flip"; ms: number }

const FACE_RE = /unit model face: (\S+) handle=(\d+) dir=\((-?\d+) (-?\d+)\) yaw=(-?[0-9.]+(?:e[-+]?[0-9]+)?) src=(dir|flip) ms=(\d+)/;

export function parseUnitFaceLog(text: string): UnitFaceLine[] {
  const out: UnitFaceLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = FACE_RE.exec(raw);
    if (m) out.push({ entry: m[1]!, handle: +m[2]!, dir: [+m[3]!, +m[4]!], yaw: +m[5]!, src: m[6] as "dir" | "flip", ms: +m[7]! });
  }
  return out;
}

/** the yaw (fw_face_yaw_deg) of a grid direction: atan2(-dx, -dy) in degrees, [0, 360); null for (0,0) */
export function faceYawOf(dx: number, dy: number): number | null {
  if (dx === 0 && dy === 0) return null;
  let y = (Math.atan2(-dx, -dy) * 180) / Math.PI;
  if (y < 0) y += 360;
  return y >= 360 || Object.is(y, -0) ? 0 : y;
}

export type FaceName = "front" | "back";
export interface FacePrediction { visible: FaceName | null; side: "left" | "right" | "centre" }
/**
 * Which coloured face of the probe box the vanilla camera sees at face yaw `yawDeg` and on which side of the box.
 * The model's front points along world (x, z) = (-sin a, -cos a) (yaw 0 = world -z = dir (0,-1)); a vertical face
 * looks at the camera when its normal n has -nx - nz > 0 (the view runs toward +x +z); on screen it sits toward
 * 0.894 * (nx - nz) (the ISO x column, image x grows to the right).
 */
export function predictFace(yawDeg: number): FacePrediction {
  const a = (yawDeg * Math.PI) / 180;
  const n: [number, number] = [-Math.sin(a), -Math.cos(a)];
  const toward = (v: [number, number]) => -v[0] - v[1];
  const sx = (v: [number, number]) => 0.894 * (v[0] - v[1]);
  const eps = 1e-6;
  const f = toward(n), b = toward([-n[0], -n[1]]);
  const visible: FaceName | null = f > eps ? "front" : b > eps ? "back" : null;
  if (!visible) return { visible, side: "centre" };
  const x = sx(visible === "front" ? n : [-n[0], -n[1]]);
  return { visible, side: x > eps ? "right" : x < -eps ? "left" : "centre" };
}

export interface ColourBlob { count: number; cx: number; cy: number }
export interface FaceColourMeasure { side: ColourBlob; front: ColourBlob; back: ColourBlob; window: [number, number, number, number] | null }

/** colour classes of the probe box under the mesh shader's Lambert shade (any brightness above the dark floor) */
export function faceColourClass(r: number, g: number, b: number): "side" | "front" | "back" | null {
  const hi = 90, lo = 0.45;   // the dominant channels must be bright, the absent one well below them
  if (r > hi && b > hi && g < lo * Math.min(r, b)) return "side";       // magenta
  if (g > hi && b > hi && r < lo * Math.min(g, b)) return "front";      // cyan
  if (r > hi && g > hi && b < lo * Math.min(r, g)) return "back";       // yellow
  return null;
}

const blob = (): ColourBlob => ({ count: 0, cx: 0, cy: 0 });

/**
 * The probe box in a shot: the magenta (side) pixels locate it (their centroid); cyan (front) and yellow (back) are
 * counted only inside a window of `radius` pixels around that centroid, so the arena's own colours far away do not
 * count. All blobs empty when no magenta is found.
 */
export function measureFaceColours(img: RgbaImageLike, radius = 90): FaceColourMeasure {
  const out: FaceColourMeasure = { side: blob(), front: blob(), back: blob(), window: null };
  const { width: w, height: h, rgba: data } = img;
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (faceColourClass(data[i]!, data[i + 1]!, data[i + 2]!) === "side") { sx += x; sy += y; n++; }
  }
  if (!n) return out;
  const cx = sx / n, cy = sy / n;
  const x0 = Math.max(0, Math.floor(cx - radius)), x1 = Math.min(w - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius)), y1 = Math.min(h - 1, Math.ceil(cy + radius));
  out.window = [x0, y0, x1, y1];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = (y * w + x) * 4;
    const c = faceColourClass(data[i]!, data[i + 1]!, data[i + 2]!);
    if (!c) continue;
    const b = out[c];
    b.cx += x; b.cy += y; b.count++;
  }
  for (const k of ["side", "front", "back"] as const) { const b = out[k]; if (b.count) { b.cx /= b.count; b.cy /= b.count; } }
  return out;
}

/** a visible face must show at least this many pixels; the hidden one at most HIDDEN_MAX_SHARE of that face's count */
export const FACE_MIN_PX = 40;
export const FACE_HIDDEN_MAX_SHARE = 0.1;
/** a face counts as left/right of the box when its centroid is this many pixels off the magenta centroid */
export const FACE_SIDE_MIN_PX = 3;

export type FaceVerdict = "turned" | "wrong-face" | "wrong-side" | "no-box" | "no-face";
export interface FaceJudgement { verdict: FaceVerdict; pass: boolean; expected: FacePrediction; measured: { visible: FaceName | null; side: "left" | "right" | "centre"; frontPx: number; backPx: number; sidePx: number; offsetPx: number | null } }

/** one shot of the probe box at face yaw `yawDeg`: the predicted face is the one showing, on the predicted side */
export function judgeFace(img: RgbaImageLike, yawDeg: number): FaceJudgement {
  return judgeFaceMeasure(measureFaceColours(img), yawDeg);
}

/** judgeFace on an already measured shot (what the T2 summary fixtures keep: the colour blobs, not the shot) */
export function judgeFaceMeasure(m: FaceColourMeasure, yawDeg: number): FaceJudgement {
  const expected = predictFace(yawDeg);
  const vis: FaceName | null = m.front.count >= FACE_MIN_PX && m.back.count <= FACE_HIDDEN_MAX_SHARE * m.front.count ? "front"
    : m.back.count >= FACE_MIN_PX && m.front.count <= FACE_HIDDEN_MAX_SHARE * m.back.count ? "back" : null;
  const blobV = vis ? m[vis] : null;
  const offset = blobV ? blobV.cx - m.side.cx : null;
  const side = offset === null ? "centre" : offset > FACE_SIDE_MIN_PX ? "right" : offset < -FACE_SIDE_MIN_PX ? "left" : "centre";
  const measured = { visible: vis, side: side as "left" | "right" | "centre", frontPx: m.front.count, backPx: m.back.count, sidePx: m.side.count, offsetPx: offset };
  const verdict: FaceVerdict = m.side.count === 0 ? "no-box" : !vis ? "no-face" : vis !== expected.visible ? "wrong-face" : side !== expected.side ? "wrong-side" : "turned";
  return { verdict, pass: verdict === "turned", expected, measured };
}

/** the face line in force at `ms` for `entry` (the last logged at or before it); null before the first */
export function faceAt(lines: UnitFaceLine[], entry: string, ms: number): UnitFaceLine | null {
  let best: UnitFaceLine | null = null;
  for (const l of lines) if (l.entry === entry && l.ms <= ms && (!best || l.ms >= best.ms)) best = l;
  return best;
}
