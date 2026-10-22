// M3 per-band mesh slices (docs/possible_3d_work.md items 6 + 7; native/framework/src/fw_mesh_slice.c): a tile mesh is
// cut along world x + z into one slice per sort band [n, n + 1), each drawn at its own place in the units layer's
// painter order (key n + 0.5) with a clip, so a multi-tile mesh occludes and is occluded per row, and only the part of a
// mesh in front of a unit's feet is drawn over that unit. mewframework logs one line per slice of the probe model
// ("mesh slice f=.. obj=.. band=i/n depth=[lo hi) key=K vis=(x0 y0 x1 y1) area=A tint=T": the NDC box and area of the
// band's front faces, what a flat slice shows when nothing covers it) and, with MEWFW_MESH_PROBE_TINT=1, draws each band
// in a measurement tint (blue, cyan, magenta repeating). The coverage of a band = its tint's pixels inside its box /
// the pixels it shows unoccluded: below 1 when a unit's sprite is drawn over it ("under"), ~1 when it is drawn over the
// unit ("over"). Pure: works on decodePng'd shots + the log text.
import type { RgbaImageLike } from "./glow-measure.ts";
import { ndcToShotPixel, OCC_BEHIND_MAX, OCC_FRONT_MIN, OCC_PRESENT_MIN } from "./mesh-measure.ts";

export type SliceTint = "blue" | "cyan" | "magenta";
export interface MeshSliceLine { frame: number; obj: number; band: number; bands: number; depth: [number, number]; key: number; vis: [number, number, number, number]; area: number; tint: SliceTint | null }
export interface SliceMeasure { expectedPx: number; px: number; coverage: number; box: [number, number, number, number] }
export type SliceExpect = "under" | "over";
export interface SliceBandJudgement { band: number; key: number; tint: SliceTint | null; expect: SliceExpect | null; coverage: number; expectedPx: number; px: number; pass: boolean | null }
export type SlicesVerdict = "as-expected" | "wrong" | "no-slice-lines" | "stale-shots" | "no-shots" | "missing-band";
export interface SlicesJudgement { verdict: SlicesVerdict; pass: boolean; obj: number | null; frame: number | null; shot: number | null; bands: SliceBandJudgement[] }

const NUM = "(-?[0-9.]+(?:e[-+]?[0-9]+)?)";
const SLICE_RE = new RegExp(String.raw`mesh slice f=(\d+) obj=(\d+) band=(\d+)/(\d+) depth=\[${NUM} ${NUM}\) key=${NUM} vis=\(${NUM} ${NUM} ${NUM} ${NUM}\) area=${NUM} tint=(\S+)`);

export function parseMeshSliceLog(text: string): MeshSliceLine[] {
  const out: MeshSliceLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = SLICE_RE.exec(line);
    if (!m) continue;
    const t = m[13]!;
    out.push({ frame: +m[1]!, obj: +m[2]!, band: +m[3]!, bands: +m[4]!, depth: [+m[5]!, +m[6]!], key: +m[7]!, vis: [+m[8]!, +m[9]!, +m[10]!, +m[11]!], area: +m[12]!,
      tint: t === "blue" || t === "cyan" || t === "magenta" ? t : null });
  }
  return out;
}

/** the tint class of a pixel: blue dominant (>= 60) and saturated, red and green as shares of blue (lighting scales all
 * three alike; an anti-aliased edge between two tints lands in exactly one class) */
export function tintOf(r: number, g: number, b: number): SliceTint | null {
  if (b < 60 || b - Math.min(r, g) < 50) return null;
  const rn = r / b, gn = g / b;
  if (rn > 1.15 || gn > 1.15) return null;
  if (rn < 0.5 && gn < 0.5) return "blue";
  if (rn < 0.5) return "cyan";
  if (gn < 0.5) return "magenta";
  return null;
}

export function measureSlice(img: RgbaImageLike, line: MeshSliceLine): SliceMeasure {
  const W = img.width, H = img.height, aspect = 16 / 9;
  const cw = W / H > aspect ? H * aspect : W, ch = W / H > aspect ? H : W / aspect;
  const expectedPx = line.area * (cw / 2) * (ch / 2);
  const a = ndcToShotPixel([line.vis[0], line.vis[3]], W, H), b = ndcToShotPixel([line.vis[2], line.vis[1]], W, H);
  const x0 = Math.max(0, Math.floor(a[0]) - 2), y0 = Math.max(0, Math.floor(a[1]) - 2);
  const x1 = Math.min(W - 1, Math.ceil(b[0]) + 2), y1 = Math.min(H - 1, Math.ceil(b[1]) + 2);
  let px = 0;
  if (line.tint) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = (y * W + x) * 4;
    if (tintOf(img.rgba[i]!, img.rgba[i + 1]!, img.rgba[i + 2]!) === line.tint) px++;
  }
  return { expectedPx, px, coverage: expectedPx > 0 ? px / expectedPx : 0, box: [x0, y0, x1, y1] };
}

function sameBytes(a: RgbaImageLike, b: RgbaImageLike): boolean {
  if (a.width !== b.width || a.height !== b.height || a.rgba.length !== b.rgba.length) return false;
  for (let i = 0; i < a.rgba.length; i++) if (a.rgba[i] !== b.rgba[i]) return false;
  return true;
}

/** the latest frame's slices of the last-logged object, measured on the LAST shot (the camera eases in first) */
export function judgeSlices(shots: RgbaImageLike[], lines: MeshSliceLine[], expect: Record<number, SliceExpect>): SlicesJudgement {
  const base: SlicesJudgement = { verdict: "no-shots", pass: false, obj: null, frame: null, shot: null, bands: [] };
  if (!shots.length) return base;
  if (!lines.length) return { ...base, verdict: "no-slice-lines" };
  if (shots.length >= 2 && shots.every((s) => sameBytes(s, shots[0]!))) return { ...base, verdict: "stale-shots" };
  const obj = lines[lines.length - 1]!.obj;
  const mine = lines.filter((l) => l.obj === obj);
  const frame = Math.max(...mine.map((l) => l.frame));
  const shot = shots.length - 1;
  const bands: SliceBandJudgement[] = mine.filter((l) => l.frame === frame && l.area > 0).sort((p, q) => p.band - q.band).map((l) => {
    const m = measureSlice(shots[shot]!, l);
    const e = expect[l.band] ?? null;
    const pass = e === null ? null : e === "under" ? m.coverage >= OCC_PRESENT_MIN && m.coverage <= OCC_BEHIND_MAX : m.coverage >= OCC_FRONT_MIN;
    return { band: l.band, key: l.key, tint: l.tint, expect: e, coverage: m.coverage, expectedPx: m.expectedPx, px: m.px, pass };
  });
  const judged = bands.filter((b) => b.expect !== null);
  const missing = judged.some((b) => b.coverage < OCC_PRESENT_MIN) || Object.keys(expect).some((k) => !bands.some((b) => b.band === +k));
  const verdict: SlicesVerdict = missing ? "missing-band" : judged.every((b) => b.pass) ? "as-expected" : "wrong";
  return { verdict, pass: verdict === "as-expected", obj, frame, shot, bands };
}
