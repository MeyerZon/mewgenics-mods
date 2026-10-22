// Level files (`levels/**/*.lvl`): the encounter layouts a map's `levels { folder … }` pools, a boss/miniboss
// subfolder, the console's `load <path>` and TacticsTest's "blank" read. The format (little-endian), checked
// against all 2361 vanilla files (each re-encodes byte for byte, test/level-tests.ts T1):
//
//   u32 version            2 (four old test levels: 1)
//   u32 width, u32 height  10, 10 in every vanilla level
//   u32 1                  (constant in every vanilla level)
//   u32 objectCount
//   u32 0, u32 0           (constant)
//   u32 width, u32 height  (repeated)
//   str objectPalette      "spawns.gon" — object ids index data/spawns.gon (u32 length + bytes)
//   str tilePalette        "tiles.gon"  — tile ids index data/tiles.gon ("" in the version-1 files)
//   u32 0, u32 0           (constant)
//   width*height cells     row-major (index = y * width + x), each a pick
//   objectCount objects    u16 x, u16 y, then a pick stored as u32 (0xffff = random list)
//   u32 0                  (constant)
//
// A pick is an id, or 0xffff followed by u16 n and n x (u16 id, u16 weight): a weighted random choice made when
// the level is instantiated (id 0 = nothing / empty tile). In the grid a plain id is a u16; for objects a u32.

export type LvlChoice = { id: number; weight: number };
/** A palette id, or a weighted random choice between ids (stored as 0xffff + list). */
export type LvlPick = number | LvlChoice[];
export interface LvlObject {
  x: number;
  y: number;
  id: LvlPick;
}
export interface LvlFile {
  version: number;
  width: number;
  height: number;
  objectPalette: string;
  /** "" in the version-1 files */
  tilePalette: string;
  /** row-major, width * height */
  tiles: LvlPick[];
  objects: LvlObject[];
  /** the header/trailer words that are constant in vanilla; kept so any file re-encodes exactly */
  raw?: { layers: number; a: number; b: number; width2: number; height2: number; pad1: number; pad2: number; trailer: number };
}

export class LvlFormatError extends Error {}

const RANDOM = 0xffff;

class Reader {
  o = 0;
  b: Uint8Array;
  v: DataView;
  constructor(b: Uint8Array) {
    this.b = b;
    this.v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  need(n: number): void {
    if (this.o + n > this.b.length) throw new LvlFormatError(`truncated level file: need ${n} byte(s) at offset ${this.o}, have ${this.b.length - this.o}`);
  }
  u32(): number { this.need(4); const x = this.v.getUint32(this.o, true); this.o += 4; return x; }
  u16(): number { this.need(2); const x = this.v.getUint16(this.o, true); this.o += 2; return x; }
  str(): string {
    const n = this.u32();
    if (n > 4096) throw new LvlFormatError(`implausible string length ${n} at offset ${this.o - 4}`);
    this.need(n);
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.b[this.o + i]!);
    this.o += n;
    return s;
  }
  choices(): LvlChoice[] {
    const n = this.u16();
    const out: LvlChoice[] = [];
    for (let i = 0; i < n; i++) out.push({ id: this.u16(), weight: this.u16() });
    return out;
  }
}

/** Decode a `.lvl` file. Throws LvlFormatError on anything that does not parse exactly to the end. */
export function decodeLvl(bytes: Uint8Array): LvlFile {
  const r = new Reader(bytes);
  const version = r.u32();
  if (version !== 1 && version !== 2) throw new LvlFormatError(`unknown level version ${version} (vanilla: 1 or 2)`);
  const width = r.u32();
  const height = r.u32();
  if (width === 0 || height === 0 || width > 256 || height > 256) throw new LvlFormatError(`implausible grid ${width}x${height}`);
  const layers = r.u32();
  const count = r.u32();
  const a = r.u32();
  const b = r.u32();
  const width2 = r.u32();
  const height2 = r.u32();
  const objectPalette = r.str();
  const tilePalette = r.str();
  const pad1 = r.u32();
  const pad2 = r.u32();
  const tiles: LvlPick[] = [];
  for (let i = 0; i < width * height; i++) {
    const v = r.u16();
    tiles.push(v === RANDOM ? r.choices() : v);
  }
  if (count > 65536) throw new LvlFormatError(`implausible object count ${count}`);
  const objects: LvlObject[] = [];
  for (let i = 0; i < count; i++) {
    const x = r.u16();
    const y = r.u16();
    const v = r.u32();
    objects.push({ x, y, id: v === RANDOM ? r.choices() : v });
  }
  const trailer = r.u32();
  if (r.o !== bytes.length) throw new LvlFormatError(`${bytes.length - r.o} unexpected trailing byte(s) after the level data`);
  const f: LvlFile = { version, width, height, objectPalette, tilePalette, tiles, objects };
  const raw = { layers, a, b, width2, height2, pad1, pad2, trailer };
  if (layers !== 1 || a !== 0 || b !== 0 || width2 !== width || height2 !== height || pad1 !== 0 || pad2 !== 0 || trailer !== 0) f.raw = raw;
  return f;
}

/** Encode a level; `encodeLvl(decodeLvl(b))` equals `b` for every vanilla file. */
export function encodeLvl(f: LvlFile): Uint8Array {
  const out: number[] = [];
  const u32 = (v: number): void => { out.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255); };
  const u16 = (v: number): void => { out.push(v & 255, (v >>> 8) & 255); };
  const str = (s: string): void => { u32(s.length); for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 255); };
  const choices = (c: LvlChoice[]): void => { u16(c.length); for (const x of c) { u16(x.id); u16(x.weight); } };
  const raw = f.raw ?? { layers: 1, a: 0, b: 0, width2: f.width, height2: f.height, pad1: 0, pad2: 0, trailer: 0 };
  if (f.tiles.length !== f.width * f.height) throw new LvlFormatError(`tiles has ${f.tiles.length} cells, grid is ${f.width}x${f.height}`);
  u32(f.version); u32(f.width); u32(f.height); u32(raw.layers); u32(f.objects.length); u32(raw.a); u32(raw.b); u32(raw.width2); u32(raw.height2);
  str(f.objectPalette);
  str(f.tilePalette);
  u32(raw.pad1); u32(raw.pad2);
  for (const t of f.tiles) { if (typeof t === "number") u16(t); else { u16(RANDOM); choices(t); } }
  for (const o of f.objects) {
    u16(o.x); u16(o.y);
    if (typeof o.id === "number") u32(o.id); else { u32(RANDOM); choices(o.id); }
  }
  u32(raw.trailer);
  return Uint8Array.from(out);
}

export interface RoomSpec {
  width?: number;
  height?: number;
  objects: Array<{ x: number; y: number; id: LvlPick }>;
  tiles?: Array<{ x: number; y: number; id: LvlPick }>;
}

/** Build a version-2 level (the vanilla shape) from placed objects and tiles; every other cell is tile 0. */
export function buildRoom(spec: RoomSpec): LvlFile {
  const width = spec.width ?? 10;
  const height = spec.height ?? 10;
  const checkPick = (p: LvlPick, what: string): void => {
    const ids = typeof p === "number" ? [p] : p.map((c) => c.id);
    for (const id of ids) {
      if (!Number.isInteger(id) || id < 0 || id >= RANDOM) throw new Error(`${what}: id ${id} must be an integer 0..65534 (0xffff marks a random list)`);
    }
    if (typeof p !== "number") {
      if (p.length === 0) throw new Error(`${what}: an empty random list`);
      for (const c of p) if (!Number.isInteger(c.weight) || c.weight < 0 || c.weight > 0xffff) throw new Error(`${what}: weight ${c.weight} must be 0..65535`);
    }
  };
  const checkPos = (x: number, y: number, what: string): void => {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) {
      throw new Error(`${what} at (${x},${y}) is outside the ${width}x${height} grid`);
    }
  };
  const tiles: LvlPick[] = new Array<LvlPick>(width * height).fill(0);
  for (const t of spec.tiles ?? []) {
    checkPos(t.x, t.y, "tile");
    checkPick(t.id, `tile (${t.x},${t.y})`);
    tiles[t.y * width + t.x] = t.id;
  }
  const objects: LvlObject[] = spec.objects.map((o) => {
    checkPos(o.x, o.y, "object");
    checkPick(o.id, `object (${o.x},${o.y})`);
    return { x: o.x, y: o.y, id: o.id };
  });
  return { version: 2, width, height, objectPalette: "spawns.gon", tilePalette: "tiles.gon", tiles, objects };
}

/** The distinct palette ids a level uses (random lists expanded), sorted. */
export function lvlIds(f: LvlFile): { objects: number[]; tiles: number[] } {
  const ids = (picks: LvlPick[]): number[] => {
    const s = new Set<number>();
    for (const p of picks) for (const id of typeof p === "number" ? [p] : p.map((c) => c.id)) s.add(id);
    return [...s].sort((a, b) => a - b);
  };
  return { objects: ids(f.objects.map((o) => o.id)), tiles: ids(f.tiles) };
}
