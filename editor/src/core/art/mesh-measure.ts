// red stub — the green commit implements the mesh probe measurement
import type { RgbaImageLike } from "./glow-measure.ts";
import type { GlowRegion } from "./glow-measure.ts";

export interface MeshProbeLine { frame: number; tile: [number, number]; ndc: [number, number, number]; canvas: [number, number] }
export interface MeshDrawLine { frame: number; fbo: number; errors: number; line: string }
export interface MeshProbeLog { probes: MeshProbeLine[]; draws: MeshDrawLine[]; glReady: boolean; glErrors: string[] }
export type MeshVerdict = "cube" | "misplaced" | "no-cube" | "stale-shots" | "no-probe-lines" | "no-shots";
export interface MeshJudgement { verdict: MeshVerdict; staleChecked: boolean; patch: GlowRegion | null; distancePx: number | null; expectedPx: [number, number][]; shot: number | null }

export function parseMeshProbeLog(_text: string): MeshProbeLog { return { probes: [], draws: [], glReady: false, glErrors: [] }; }
export function ndcToShotPixel(_ndc: [number, number], _w: number, _h: number): [number, number] { return [NaN, NaN]; }
export function judgeMeshShots(_shots: RgbaImageLike[], _probes: MeshProbeLine[]): MeshJudgement { return { verdict: "no-shots", staleChecked: false, patch: null, distancePx: null, expectedPx: [], shot: null }; }
