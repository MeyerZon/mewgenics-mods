// M3 per-band mesh slices (native/framework/src/fw_mesh_slice.c): a tile mesh is cut along world x + z into one slice
// per sort band, each drawn at its own place in the units layer's painter order. RED STUB.
import type { RgbaImageLike } from "./glow-measure.ts";

export type SliceTint = "blue" | "cyan" | "magenta";
export interface MeshSliceLine { frame: number; obj: number; band: number; bands: number; depth: [number, number]; key: number; vis: [number, number, number, number]; area: number; tint: SliceTint | null }
export interface SliceMeasure { expectedPx: number; px: number; coverage: number; box: [number, number, number, number] }
export type SliceExpect = "under" | "over";
export interface SliceBandJudgement { band: number; key: number; tint: SliceTint | null; expect: SliceExpect | null; coverage: number; expectedPx: number; px: number; pass: boolean | null }
export type SlicesVerdict = "as-expected" | "wrong" | "no-slice-lines" | "stale-shots" | "no-shots" | "missing-band";
export interface SlicesJudgement { verdict: SlicesVerdict; pass: boolean; obj: number | null; frame: number | null; shot: number | null; bands: SliceBandJudgement[] }

export function parseMeshSliceLog(_text: string): MeshSliceLine[] { return []; }
export function tintOf(_r: number, _g: number, _b: number): SliceTint | null { return null; }
export function measureSlice(_img: RgbaImageLike, _line: MeshSliceLine): SliceMeasure { return { expectedPx: 0, px: 0, coverage: 0, box: [0, 0, 0, 0] }; }
export function judgeSlices(_shots: RgbaImageLike[], _lines: MeshSliceLine[], _expect: Record<number, SliceExpect>): SlicesJudgement {
  return { verdict: "no-shots", pass: false, obj: null, frame: null, shot: null, bands: [] };
}
