// Level files (levels/**/*.lvl): stub for the red commit.
export type LvlChoice = { id: number; weight: number };
export type LvlPick = number | LvlChoice[];
export interface LvlObject { x: number; y: number; id: LvlPick }
export interface LvlFile { version: number; width: number; height: number; objectPalette: string; tilePalette: string | null; tiles: LvlPick[]; objects: LvlObject[] }
export class LvlFormatError extends Error {}
export function decodeLvl(_b: Uint8Array): LvlFile { throw new Error("not implemented"); }
export function encodeLvl(_f: LvlFile): Uint8Array { throw new Error("not implemented"); }
export function buildRoom(_s: { width?: number; height?: number; objects: Array<{ x: number; y: number; id: LvlPick }>; tiles?: Array<{ x: number; y: number; id: LvlPick }> }): LvlFile { throw new Error("not implemented"); }
export function lvlIds(_f: LvlFile): { objects: number[]; tiles: number[] } { throw new Error("not implemented"); }
