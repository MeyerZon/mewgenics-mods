// Reads the in-game proof of the 3D phase-M1 probe cube (docs/possible_3d_work.md): mewframework, launched with
// MEWFW_MESH_PROBE, draws a flat magenta unit cube on one tile and logs where the tile centre projects
// ("mesh probe f=<frame> tile=(c,r) ndc=(x y z) canvas=(x y)", native/framework/src/fw_mesh_draw.c fw_mesh_fmt_probe)
// and what GL state its draw functor found ("mesh draw ..."). A shot proves the draw when it holds a sizeable magenta
// patch at (or around) the projected point. The camera eases in during a fight's first seconds, so the point moves
// between probe lines; any logged position within the tolerance counts. Shots that are all byte-identical prove nothing
// (a stale capture would pass any colour test) and give no verdict. Pure: works on decodePng'd shots + the log text.
import { measureGlow, GLOW_PROBE_COLOUR, type RgbaImageLike, type GlowRegion } from "./glow-measure.ts";

export interface MeshProbeLine { frame: number; tile: [number, number]; ndc: [number, number, number]; canvas: [number, number] }
export interface MeshDrawLine { frame: number; fbo: number; errors: number; line: string }
export interface MeshProbeLog { probes: MeshProbeLine[]; draws: MeshDrawLine[]; glReady: boolean; glErrors: string[] }
export type MeshVerdict = "cube" | "misplaced" | "no-cube" | "stale-shots" | "no-probe-lines" | "no-shots";
export interface MeshJudgement { verdict: MeshVerdict; staleChecked: boolean; patch: GlowRegion | null; distancePx: number | null; expectedPx: [number, number][]; shot: number | null }

/** the probe colour (fw_mesh_draw.h FW_MESH_PROBE_R/G/B): magenta, the glow probe's colour */
export const MESH_PROBE_COLOUR = GLOW_PROBE_COLOUR;
/** a cube patch must cover at least this share of the shot (a 0.8-tile cube at the fight zoom is ~1 %) */
export const MESH_MIN_SHARE = 0.001;
/** how far (share of the shot width) the patch may sit from a logged projected centre */
export const MESH_TOLERANCE_SHARE = 0.05;

const NUM = "(-?[0-9.]+(?:e[-+]?[0-9]+)?)";
const PROBE_RE = new RegExp(`^mesh probe f=(\\d+) tile=\\((\\d+),(\\d+)\\) ndc=\\(${NUM} ${NUM} ${NUM}\\) canvas=\\(${NUM} ${NUM}\\)`);
const DRAW_RE = /^mesh draw f=(\d+) n=\d+ fbo=(-?\d+) .* errors=(\d+)/;

export function parseMeshProbeLog(text: string): MeshProbeLog {
  const out: MeshProbeLog = { probes: [], draws: [], glReady: false, glErrors: [] };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^.*?(?=mesh[ :])/, "");   // tolerate a timestamp / prefix before the message
    let m = PROBE_RE.exec(line);
    if (m) {
      out.probes.push({ frame: +m[1]!, tile: [+m[2]!, +m[3]!], ndc: [+m[4]!, +m[5]!, +m[6]!], canvas: [+m[7]!, +m[8]!] });
      continue;
    }
    m = DRAW_RE.exec(line);
    if (m) { out.draws.push({ frame: +m[1]!, fbo: +m[2]!, errors: +m[3]!, line }); continue; }
    if (/^mesh: GL objects ready/.test(line)) out.glReady = true;
    else if (/^mesh: .*(GL error|compile failed|link failed|not found|disabled)/.test(line)) out.glErrors.push(line);
  }
  return out;
}

/** NDC -> a pixel of a w x h shot whose row 0 is the top (fw_m4_ndc_to_pixel). The game keeps its 16:9 canvas and
 * letterboxes the rest (OBSERVED: a 3440x1440 window, main RT viewport 2560x1440, bars left and right), so NDC maps into
 * the centred 16:9 area of the shot. */
export function ndcToShotPixel(ndc: [number, number], w: number, h: number): [number, number] {
  const aspect = 16 / 9;
  const cw = w / h > aspect ? h * aspect : w, ch = w / h > aspect ? h : w / aspect;
  const ox = (w - cw) / 2, oy = (h - ch) / 2;
  return [ox + ((ndc[0] + 1) / 2) * cw, oy + ((1 - ndc[1]) / 2) * ch];
}

function sameBytes(a: RgbaImageLike, b: RgbaImageLike): boolean {
  if (a.width !== b.width || a.height !== b.height || a.rgba.length !== b.rgba.length) return false;
  for (let i = 0; i < a.rgba.length; i++) if (a.rgba[i] !== b.rgba[i]) return false;
  return true;
}

/** distance from a point to a box (0 inside) */
function boxDistance(r: GlowRegion, p: [number, number]): number {
  const dx = p[0] < r.x0 ? r.x0 - p[0] : p[0] > r.x1 ? p[0] - r.x1 : 0;
  const dy = p[1] < r.y0 ? r.y0 - p[1] : p[1] > r.y1 ? p[1] - r.y1 : 0;
  return Math.sqrt(dx * dx + dy * dy);
}

export function judgeMeshShots(shots: RgbaImageLike[], probes: MeshProbeLine[]): MeshJudgement {
  const base: MeshJudgement = { verdict: "no-shots", staleChecked: false, patch: null, distancePx: null, expectedPx: [], shot: null };
  if (!shots.length) return base;
  if (!probes.length) return { ...base, verdict: "no-probe-lines" };
  const staleChecked = shots.length >= 2;
  if (staleChecked && shots.every((s) => sameBytes(s, shots[0]!))) return { ...base, verdict: "stale-shots", staleChecked };
  let best: MeshJudgement | null = null;
  shots.forEach((img, i) => {
    const expectedPx = probes.map((p) => ndcToShotPixel([p.ndc[0], p.ndc[1]], img.width, img.height));
    const m = measureGlow(img, MESH_PROBE_COLOUR);
    const big = !!m.region && m.region.count >= MESH_MIN_SHARE * img.width * img.height;
    const dist = m.region ? Math.min(...expectedPx.map((p) => boxDistance(m.region!, p))) : null;
    const verdict: MeshVerdict = !big ? "no-cube" : dist! <= MESH_TOLERANCE_SHARE * img.width ? "cube" : "misplaced";
    const j: MeshJudgement = { verdict, staleChecked, patch: m.region, distancePx: dist, expectedPx, shot: i };
    const rank = (v: MeshVerdict) => (v === "cube" ? 2 : v === "misplaced" ? 1 : 0);
    if (!best || rank(j.verdict) > rank(best.verdict) || (rank(j.verdict) === rank(best.verdict) && (j.patch?.count ?? 0) > (best.patch?.count ?? 0))) best = j;
  });
  return best!;
}
