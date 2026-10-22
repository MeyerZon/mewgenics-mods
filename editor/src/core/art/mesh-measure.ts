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
export interface MeshProbeLog { probes: MeshProbeLine[]; draws: MeshDrawLine[]; glReady: boolean; glErrors: string[]; objects: MeshObjectLine[]; textures: string[]; textureMissing: string[] }
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
  const out: MeshProbeLog = { probes: [], draws: [], glReady: false, glErrors: [], objects: [], textures: [], textureMissing: [] };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^.*?(?=mesh[ :])/, "");   // tolerate a timestamp / prefix before the message
    let m = PROBE_RE.exec(line);
    if (m) {
      out.probes.push({ frame: +m[1]!, tile: [+m[2]!, +m[3]!], ndc: [+m[4]!, +m[5]!, +m[6]!], canvas: [+m[7]!, +m[8]!] });
      continue;
    }
    m = DRAW_RE.exec(line);
    if (m) { out.draws.push({ frame: +m[1]!, fbo: +m[2]!, errors: +m[3]!, line }); continue; }
    const obj = parseObject(line);
    if (obj) { out.objects.push(obj); continue; }
    if (/^mesh: texture /.test(line) || /^mesh: palette\.png /.test(line)) out.textures.push(line);
    if (/model-texture-missing/.test(line)) { out.textureMissing.push(line); continue; }
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

// ---- M2/M3: textures, the palette, glTF ----
// mewframework logs each drawn object ("mesh object f=.. handle=.. model=.. tile|unit world=(..) ndc=(x y z) tex=<name|none>
// palette=<row>", native/framework/src/fw_mesh_tex.c fw_mesh_fmt_object; M1 lines stop after world=) and its texture
// work ("mesh: texture <name> for <model>: ...", "mesh: palette.png WxH ...", one "model-texture-missing" line per
// model). A shot proves a textured / palette-mapped / glTF draw when the colours the shader must produce — computed
// here from fw_mesh.shader's light and palette rule — cover enough pixels in a box around an object's projected anchor.
export interface MeshObjectLine { frame: number; handle: number; model: string; anchor: "tile" | "unit"; world: [number, number, number]; ndc: [number, number, number] | null; tex: string | null; palette: number | null }
export interface ColourTarget { name: string; rgb: [number, number, number] }
export interface Box { x0: number; y0: number; x1: number; y1: number }
export type ColourVerdict = "match" | "partial" | "absent" | "stale-shots" | "no-anchor" | "no-shots";
export interface ColourJudgement { verdict: ColourVerdict; staleChecked: boolean; counts: Record<string, number>; shot: number | null; anchorPx: [number, number] | null; box: Box | null }

const OBJECT_RE = new RegExp(`^mesh object f=(\\d+) handle=(\\d+) model=(\\S+) (tile|unit) world=\\(${NUM} ${NUM} ${NUM}\\)(?: ndc=\\(${NUM} ${NUM} ${NUM}\\) tex=(\\S+) palette=(-?\\d+))?`);

function parseObject(line: string): MeshObjectLine | null {
  const m = OBJECT_RE.exec(line);
  if (!m) return null;
  return {
    frame: +m[1]!, handle: +m[2]!, model: m[3]!, anchor: m[4] as "tile" | "unit", world: [+m[5]!, +m[6]!, +m[7]!],
    ndc: m[8] !== undefined ? [+m[8]!, +m[9]!, +m[10]!] : null,
    tex: m[11] === undefined || m[11] === "none" ? null : m[11]!, palette: m[12] !== undefined ? +m[12]! : null,
  };
}

/** mesh_engine.c's light (toward the light, world) and fw_mesh.shader's shade floor */
export const FW_MESH_LIGHT_DIR: [number, number, number] = [-0.4, 1, -0.6];
export const FW_MESH_AMBIENT = 0.45;

/** fw_mesh.shader: clamp(ambient + (1 - ambient) * max(n . normalize(light), 0), 0, 1) for a unit world normal */
export function lambertShade(n: [number, number, number]): number {
  const l = FW_MESH_LIGHT_DIR, len = Math.hypot(l[0], l[1], l[2]);
  const d = Math.max((n[0] * l[0] + n[1] * l[1] + n[2] * l[2]) / len, 0);
  return Math.min(Math.max(FW_MESH_AMBIENT + (1 - FW_MESH_AMBIENT) * d, 0), 1);
}

/** an 8-bit colour x shade, as the framebuffer stores it */
export function shadeColour(rgb: readonly number[], shade: number): [number, number, number] {
  return [0, 1, 2].map((k) => Math.round(Math.min(Math.max((rgb[k]! / 255) * shade, 0), 1) * 255)) as [number, number, number];
}

/** the paletted_full rule as fw_mesh.shader applies it: column = int(clamp(grey * shade) * 15 + .5) */
export function paletteColumn(grey: number, shade: number): number {
  return Math.trunc(Math.min(Math.max((grey / 255) * shade, 0), 1) * 15 + 0.5);
}

function near(img: RgbaImageLike, i: number, rgb: readonly number[], tol: number): boolean {
  return Math.abs(img.rgba[i]! - rgb[0]!) <= tol && Math.abs(img.rgba[i + 1]! - rgb[1]!) <= tol && Math.abs(img.rgba[i + 2]! - rgb[2]!) <= tol;
}

/** pixels within tol (per channel) of each target inside box (clipped to the image; x1 / y1 exclusive) */
export function countColours(img: RgbaImageLike, box: Box, targets: ColourTarget[], tol: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of targets) out[t.name] = 0;
  const x0 = Math.max(0, Math.floor(box.x0)), y0 = Math.max(0, Math.floor(box.y0));
  const x1 = Math.min(img.width, Math.ceil(box.x1)), y1 = Math.min(img.height, Math.ceil(box.y1));
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * img.width + x) * 4;
    for (const t of targets) if (near(img, i, t.rgb, tol)) out[t.name]!++;
  }
  return out;
}

/** Counts each target colour in a square box (side = 2 x boxShare x shot width) around every logged anchor of the object
 * (ndc -> letterboxed shot pixel), keeps the best shot: "match" when every target has >= minEach pixels, "partial" when
 * some do, "absent" when none; byte-identical shots give no verdict ("stale-shots"). */
export function judgeColourPatch(shots: RgbaImageLike[], objects: MeshObjectLine[], targets: ColourTarget[], opts: { minEach?: number; tol?: number; boxShare?: number } = {}): ColourJudgement {
  const minEach = opts.minEach ?? 200, tol = opts.tol ?? 4, boxShare = opts.boxShare ?? 0.05;
  const base: ColourJudgement = { verdict: "no-shots", staleChecked: false, counts: {}, shot: null, anchorPx: null, box: null };
  if (!shots.length) return base;
  const anchors = objects.filter((o) => o.ndc);
  if (!anchors.length) return { ...base, verdict: "no-anchor" };
  const staleChecked = shots.length >= 2;
  if (staleChecked && shots.every((s) => sameBytes(s, shots[0]!))) return { ...base, verdict: "stale-shots", staleChecked };
  const rank = (v: ColourVerdict) => (v === "match" ? 2 : v === "partial" ? 1 : 0);
  const seen = new Set<string>();
  let best: ColourJudgement | null = null;
  shots.forEach((img, si) => {
    for (const o of anchors) {
      const key = `${si}:${o.ndc![0]},${o.ndc![1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const p = ndcToShotPixel([o.ndc![0], o.ndc![1]], img.width, img.height);
      const r = boxShare * img.width;
      const box = { x0: p[0] - r, y0: p[1] - r, x1: p[0] + r, y1: p[1] + r };
      const counts = countColours(img, box, targets, tol);
      const hit = targets.filter((t) => counts[t.name]! >= minEach).length;
      const verdict: ColourVerdict = hit === targets.length ? "match" : hit ? "partial" : "absent";
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      const j: ColourJudgement = { verdict, staleChecked, counts, shot: si, anchorPx: p, box };
      if (!best || rank(verdict) > rank(best.verdict) || (rank(verdict) === rank(best.verdict) && total > Object.values(best.counts).reduce((a, b) => a + b, 0))) best = j;
    }
  });
  return best!;
}

// ---- 3D phase M2 item 4: per-unit models (a unit's GON graphics.model drawn on it, following it) ----------------
// The framework logs "unit model: <entry> <Character*> -> <file>[ (block ...)]" once per unit it registers and
// "unit model at: <entry> handle=<h> world=(x z) screen=(m12 m13)|(none) facing=±1 m0=<g> ms=<epoch ms>" whenever that
// unit's raw world position changes (native/framework/src/fw_unit_model.c, pinned by test_unit_model.c). A shot's file
// time picks the position it shows (positionAt); two shots prove the model follows when its patch moves the way the iso
// projection of the unit's world move says (judgeUnitModelFollows). The camera is not followed: a camera pan between
// the shots shows up as a wrong direction, never as a pass.
export interface UnitModelLine { entry: string; character: string; file: string; block: string | null }
export interface UnitModelAt { entry: string; handle: number; world: [number, number]; screen: [number, number] | null; facing: number; m0: number; ms: number }
export interface UnitMeshObjectLine { frame: number; handle: number; model: string; kind: "unit" | "tile"; world: [number, number, number] }
export interface UnitModelLog { units: UnitModelLine[]; positions: UnitModelAt[]; objects: UnitMeshObjectLine[] }

const UNIT_RE = /^unit model: (\S+) (\S+) -> (\S+)(?: \(block (.*)\))?$/;
const AT_RE = new RegExp(String.raw`^unit model at: (\S+) handle=(\d+) world=\(${NUM} ${NUM}\) screen=(?:\(${NUM} ${NUM}\)|\(none\)) facing=([-+]1) m0=${NUM} ms=(\d+)`);
const OBJ_RE = new RegExp(String.raw`^mesh object f=(\d+) handle=(\d+) model=(\S+) (unit|tile) world=\(${NUM} ${NUM} ${NUM}\)`);

export function parseUnitModelLog(text: string): UnitModelLog {
  const out: UnitModelLog = { units: [], positions: [], objects: [] };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^.*?(?=(?:unit model|mesh object)[ :])/, "");
    let m = AT_RE.exec(line);
    if (m) {
      out.positions.push({ entry: m[1]!, handle: +m[2]!, world: [+m[3]!, +m[4]!], screen: m[5] !== undefined ? [+m[5]!, +m[6]!] : null, facing: +m[7]!, m0: +m[8]!, ms: +m[9]! });
      continue;
    }
    m = UNIT_RE.exec(line);
    if (m) { out.units.push({ entry: m[1]!, character: m[2]!, file: m[3]!, block: m[4] ?? null }); continue; }
    m = OBJ_RE.exec(line);
    if (m) out.objects.push({ frame: +m[1]!, handle: +m[2]!, model: m[3]!, kind: m[4] as "unit" | "tile", world: [+m[5]!, +m[6]!, +m[7]!] });
  }
  return out;
}

/** the last position of `entry` logged at or before `ms`; null before the first */
export function positionAt(positions: UnitModelAt[], entry: string, ms: number): UnitModelAt | null {
  let best: UnitModelAt | null = null;
  for (const p of positions) if (p.entry === entry && p.ms <= ms && (!best || p.ms >= best.ms)) best = p;
  return best;
}

/** a world move (dx, dz) on screen, y up, in tile units: the observer's ISO columns x -> (0.894, 0.447), z -> (-0.894, 0.447)
 * (editor/test/fixtures/ingame/observe3d-log.txt) */
export function isoScreenDelta(dx: number, dz: number): [number, number] {
  return [0.894 * dx - 0.894 * dz, 0.447 * dx + 0.447 * dz];
}

export type FollowVerdict = "follows" | "wrong-direction" | "not-following" | "unit-not-moved" | "no-patch" | "stale-shots";
export interface FollowJudgement { verdict: FollowVerdict; patchA: GlowRegion | null; patchB: GlowRegion | null; deltaPx: [number, number] | null; predicted: [number, number] | null; angleDeg: number | null }
/** the unit must move at least this far (tiles) for the shots to say anything */
export const FOLLOW_MIN_UNIT_MOVE = 0.5;
/** the patch must move at least this far (pixels) */
export const FOLLOW_MIN_PATCH_MOVE = 10;
/** the patch's move may point this far (degrees) from the projected move */
export const FOLLOW_MAX_ANGLE = 25;

const centre = (r: GlowRegion): [number, number] => [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2];

/** shots A (unit at worldA) and B (at worldB), each holding the model as a patch of `colour` */
export function judgeUnitModelFollows(a: RgbaImageLike, b: RgbaImageLike, worldA: [number, number], worldB: [number, number], colour = MESH_PROBE_COLOUR): FollowJudgement {
  const out: FollowJudgement = { verdict: "no-patch", patchA: null, patchB: null, deltaPx: null, predicted: null, angleDeg: null };
  if (sameBytes(a, b)) return { ...out, verdict: "stale-shots" };
  const ma = measureGlow(a, colour), mb = measureGlow(b, colour);
  out.patchA = ma.region; out.patchB = mb.region;
  const big = (r: GlowRegion | null, img: RgbaImageLike) => !!r && r.count >= Math.max(50, MESH_MIN_SHARE * img.width * img.height * 0.1);
  if (!big(ma.region, a) || !big(mb.region, b)) return out;
  const dxw = worldB[0] - worldA[0], dzw = worldB[1] - worldA[1];
  const [px, py] = isoScreenDelta(dxw, dzw);
  out.predicted = [px, -py];                                   // image rows grow downward
  const ca = centre(ma.region!), cb = centre(mb.region!);
  out.deltaPx = [cb[0] - ca[0], cb[1] - ca[1]];
  if (Math.hypot(dxw, dzw) < FOLLOW_MIN_UNIT_MOVE) return { ...out, verdict: "unit-not-moved" };
  const len = Math.hypot(out.deltaPx[0], out.deltaPx[1]);
  if (len < FOLLOW_MIN_PATCH_MOVE) return { ...out, verdict: "not-following" };
  const dot = out.deltaPx[0] * out.predicted[0] + out.deltaPx[1] * out.predicted[1];
  const cos = dot / (len * Math.hypot(out.predicted[0], out.predicted[1]));
  out.angleDeg = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  return { ...out, verdict: out.angleDeg <= FOLLOW_MAX_ANGLE ? "follows" : "wrong-direction" };
}
// ---- M2: sprite/mesh occlusion ----
// mewframework interleaves the mesh draws into the units layer's painter order (native/framework/src/fw_mesh_order.c)
// and, for the probe cube, logs its projected silhouette: "mesh occ f=.. tile=(c,r) key=K hull=(x0 y0 x1 y1) area=A"
// (NDC bbox + convex-hull area). An unoccluded flat cube covers about area x (cw/2) x (ch/2) shot pixels (cw x ch = the
// letterboxed 16:9 area); the magenta pixels inside the hull's box divided by that is the coverage. A cube behind a
// unit loses part of its silhouette to the unit's sprite (coverage clearly below 1); a cube in front keeps all of it.
export interface MeshOccLine { frame: number; tile: [number, number]; key: number; hull: [number, number, number, number]; area: number }
export interface MeshOrderPlacement { draw: number; key: number; item: number | null; itemKey: number | null }
export interface MeshOrderLine { frame: number; items: number; meshes: number; groups: number; unsorted: number; placements: MeshOrderPlacement[]; line: string }
export interface MeshOrderItem { frame: number; index: number; key: number; at: [number, number] }
export interface MeshOrderLog { occ: MeshOccLine[]; orders: MeshOrderLine[]; items: MeshOrderItem[]; filterPrev: string | null; interleaving: boolean }
export interface OcclusionMeasure { expectedPx: number; magentaPx: number; coverage: number; box: [number, number, number, number] }
export type OcclusionVerdict = "behind-occluded" | "front-unoccluded" | "not-occluded" | "occluded-in-front" | "no-cube" | "stale-shots" | "no-occ-lines" | "no-shots";
export interface OcclusionJudgement { verdict: OcclusionVerdict; pass: boolean; coverage: number | null; expectedPx: number | null; magentaPx: number | null; shot: number | null; occ: MeshOccLine | null }

/** behind: the cube must have lost at least this share of its silhouette (a cat's sprite over its lower part) */
export const OCC_BEHIND_MAX = 0.85;
/** front: the cube must keep at least this share (MSAA edges + the shader's darkest face still count as magenta) */
export const OCC_FRONT_MIN = 0.9;
/** below this the cube is not there at all */
export const OCC_PRESENT_MIN = 0.05;

const OCC_RE = new RegExp(String.raw`^mesh occ f=(\d+) tile=\((\d+),(\d+)\) key=${NUM} hull=\(${NUM} ${NUM} ${NUM} ${NUM}\) area=${NUM}`);
const ORDER_RE = /^mesh order f=(\d+) items=(\d+) meshes=(\d+) groups=(\d+) unsorted=(\d+)(.*)$/;
const ITEM_RE = new RegExp(String.raw`^mesh order item f=(\d+) i=(\d+) key=${NUM} at=\(${NUM} ${NUM}\)`);
const FILTER_RE = /^mesh order: world camera filter before ours = (\S+) \((.*)\)/;

export function parseMeshOrderLog(text: string): MeshOrderLog {
  const out: MeshOrderLog = { occ: [], orders: [], items: [], filterPrev: null, interleaving: false };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^.*?(?=mesh[ :])/, "");
    let m = OCC_RE.exec(line);
    if (m) { out.occ.push({ frame: +m[1]!, tile: [+m[2]!, +m[3]!], key: +m[4]!, hull: [+m[5]!, +m[6]!, +m[7]!, +m[8]!], area: +m[9]! }); continue; }
    m = ORDER_RE.exec(line);
    if (m) {
      const placements: MeshOrderPlacement[] = [];
      for (const part of m[6]!.split(" | ").slice(1)) {
        const b = /^d(\d+) key=(-?[0-9.]+) before item (\d+) key=(-?[0-9.]+)/.exec(part.trim());
        const a = /^d(\d+) key=(-?[0-9.]+) (after the layer|not drawn)/.exec(part.trim());
        if (b) placements.push({ draw: +b[1]!, key: +b[2]!, item: +b[3]!, itemKey: +b[4]! });
        else if (a) placements.push({ draw: +a[1]!, key: +a[2]!, item: null, itemKey: null });
      }
      out.orders.push({ frame: +m[1]!, items: +m[2]!, meshes: +m[3]!, groups: +m[4]!, unsorted: +m[5]!, placements, line });
      continue;
    }
    m = ITEM_RE.exec(line);
    if (m) { out.items.push({ frame: +m[1]!, index: +m[2]!, key: +m[3]!, at: [+m[4]!, +m[5]!] }); continue; }
    m = FILTER_RE.exec(line);
    if (m) { out.filterPrev = m[1]!; out.interleaving = /interleaving/.test(m[2]!); }
  }
  return out;
}

/** a magenta pixel (the probe colour's chroma: red and blue both exceed green by >= 50, glow-measure's rule) */
function isProbe(r: number, g: number, b: number): boolean { return Math.min(r, b) - g >= 50; }

export function measureOcclusion(img: RgbaImageLike, occ: MeshOccLine): OcclusionMeasure {
  const W = img.width, H = img.height, aspect = 16 / 9;
  const cw = W / H > aspect ? H * aspect : W, ch = W / H > aspect ? H : W / aspect;
  const expectedPx = occ.area * (cw / 2) * (ch / 2);
  const a = ndcToShotPixel([occ.hull[0], occ.hull[3]], W, H), b = ndcToShotPixel([occ.hull[2], occ.hull[1]], W, H);
  const x0 = Math.max(0, Math.floor(a[0]) - 2), y0 = Math.max(0, Math.floor(a[1]) - 2);
  const x1 = Math.min(W - 1, Math.ceil(b[0]) + 2), y1 = Math.min(H - 1, Math.ceil(b[1]) + 2);
  let magentaPx = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = (y * W + x) * 4;
    if (isProbe(img.rgba[i]!, img.rgba[i + 1]!, img.rgba[i + 2]!)) magentaPx++;
  }
  return { expectedPx, magentaPx, coverage: expectedPx > 0 ? magentaPx / expectedPx : 0, box: [x0, y0, x1, y1] };
}

export function judgeOcclusion(shots: RgbaImageLike[], occ: MeshOccLine[], expect: "behind" | "front"): OcclusionJudgement {
  const base: OcclusionJudgement = { verdict: "no-shots", pass: false, coverage: null, expectedPx: null, magentaPx: null, shot: null, occ: null };
  if (!shots.length) return base;
  if (!occ.length) return { ...base, verdict: "no-occ-lines" };
  if (shots.length >= 2 && shots.every((s) => sameBytes(s, shots[0]!))) return { ...base, verdict: "stale-shots" };
  const line = occ.reduce((p, c) => (c.frame >= p.frame ? c : p));
  const shot = shots.length - 1;
  const m = measureOcclusion(shots[shot]!, line);
  const verdict: OcclusionVerdict = m.coverage < OCC_PRESENT_MIN ? "no-cube"
    : expect === "behind" ? (m.coverage <= OCC_BEHIND_MAX ? "behind-occluded" : "not-occluded")
    : (m.coverage >= OCC_FRONT_MIN ? "front-unoccluded" : "occluded-in-front");
  return { verdict, pass: verdict === "behind-occluded" || verdict === "front-unoccluded", coverage: m.coverage, expectedPx: m.expectedPx, magentaPx: m.magentaPx, shot, occ: line };
}
// ---- M3: hide_sprite ---- (RED stubs; the green commit fills them in)
export interface HideMeasure { patch: GlowRegion | null; box: Box | null; dark: number; total: number }
export type HideVerdict = "hidden" | "not-hidden" | "no-patch" | "control-no-sprite";
export interface HideJudgement { verdict: HideVerdict; share: number | null }
export interface MeshHideLine { frame: number; units: number; items: number; skipped: number }
export interface MeshHideLog { hides: MeshHideLine[]; hideUnits: string[]; badFlag: string[] }
export const HIDE_DARK_SUM = 90;
export const HIDE_MIN_CONTROL_DARK = 200;
export const HIDE_MAX_SHARE = 0.05;
export function measureHideRegion(_img: RgbaImageLike, _colour = MESH_PROBE_COLOUR): HideMeasure { return { patch: null, box: null, dark: 0, total: 0 }; }
export function judgeHide(_hide: HideMeasure, _control: HideMeasure): HideJudgement { return { verdict: "no-patch", share: null }; }
export function parseMeshHideLog(_text: string): MeshHideLog { return { hides: [], hideUnits: [], badFlag: [] }; }
