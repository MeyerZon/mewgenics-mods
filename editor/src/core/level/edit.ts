// Pure grid-edit helpers for the Room editor (web UI "Rooms" mode, MCP write_level edits). No Node imports: Vite
// bundles this module into the browser and the core uses it on the server, so a click in the UI and an MCP edit op
// change a level the same way. Every helper returns a new LvlFile and never mutates its input; the header words a
// file carries (`raw`) ride along untouched, so an unedited level re-encodes to its original bytes.
//
// Objects: vanilla has 26 cells with two objects stacked on one cell (out of 2361 levels), so objects are a list,
// not a grid. `placeObject` replaces the FIRST object on a cell (keeping its list position, so the byte layout of
// the rest of the file does not move) or appends; `removeObjects` clears every object on the cell.

import type { LvlChoice, LvlFile, LvlObject, LvlPick } from "./lvl.ts";

export interface Cell {
  x: number;
  y: number;
}

const RANDOM = 0xffff;

function inGrid(l: LvlFile, x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < l.width && y < l.height;
}

/** The tile pick at (x, y) (row-major: index = y * width + x); 0 outside the grid. */
export function cellAt(l: LvlFile, x: number, y: number): LvlPick {
  return inGrid(l, x, y) ? (l.tiles[y * l.width + x] ?? 0) : 0;
}

function clonePick(p: LvlPick): LvlPick {
  return typeof p === "number" ? p : p.map((c) => ({ id: c.id, weight: c.weight }));
}

/** Paint `pick` into every listed cell (cells outside the grid are ignored). */
export function paintTiles(l: LvlFile, cells: Cell[], pick: LvlPick): LvlFile {
  const tiles = l.tiles.slice();
  for (const c of cells) if (inGrid(l, c.x, c.y)) tiles[c.y * l.width + c.x] = clonePick(pick);
  return { ...l, tiles };
}

/** Every object on (x, y), with its index in `objects`. */
export function objectsAt(l: LvlFile, x: number, y: number): Array<{ index: number; obj: LvlObject }> {
  const out: Array<{ index: number; obj: LvlObject }> = [];
  l.objects.forEach((obj, index) => {
    if (obj.x === x && obj.y === y) out.push({ index, obj });
  });
  return out;
}

/** Put `pick` on (x, y): replaces the first object there (same list position) or appends one. Outside the grid: no-op. */
export function placeObject(l: LvlFile, x: number, y: number, pick: LvlPick): LvlFile {
  if (!inGrid(l, x, y)) return l;
  const objects = l.objects.slice();
  const i = objects.findIndex((o) => o.x === x && o.y === y);
  const obj: LvlObject = { x, y, id: clonePick(pick) };
  if (i >= 0) objects[i] = obj;
  else objects.push(obj);
  return { ...l, objects };
}

/** Remove every object on (x, y). */
export function removeObjects(l: LvlFile, x: number, y: number): LvlFile {
  return { ...l, objects: l.objects.filter((o) => !(o.x === x && o.y === y)) };
}

/** Replace the pick of objects[index] (e.g. from the inspector's random-list table). */
export function setObjectPick(l: LvlFile, index: number, pick: LvlPick): LvlFile {
  if (index < 0 || index >= l.objects.length) return l;
  const objects = l.objects.slice();
  objects[index] = { ...objects[index]!, id: clonePick(pick) };
  return { ...l, objects };
}

// ---- weighted random lists (0xffff + n x (id, weight) in the file) ----

/** A pick as a list of choices (a plain id becomes a one-entry list of weight 1). */
export function asChoices(p: LvlPick): LvlChoice[] {
  return typeof p === "number" ? [{ id: p, weight: 1 }] : p.map((c) => ({ id: c.id, weight: c.weight }));
}
export function addChoice(list: LvlChoice[], id: number, weight = 1): LvlChoice[] {
  return [...asChoices(list), { id, weight }];
}
export function updateChoice(list: LvlChoice[], i: number, patch: Partial<LvlChoice>): LvlChoice[] {
  return asChoices(list).map((c, j) => (j === i ? { ...c, ...patch } : c));
}
/** Drop choice i; when none is left the pick becomes id 0 (the reserved empty entry). */
export function removeChoice(list: LvlChoice[], i: number): LvlPick {
  const out = asChoices(list).filter((_c, j) => j !== i);
  return out.length ? out : 0;
}
/** The id a pick shows first (a random list's first choice). */
export function firstId(p: LvlPick): number {
  return typeof p === "number" ? p : (p[0]?.id ?? 0);
}
/** Every id a pick may produce. */
export function pickIds(p: LvlPick): number[] {
  return typeof p === "number" ? [p] : p.map((c) => c.id);
}

// ---- checks before encoding (the codec writes whatever it is given) ----

/** What would make the file unreadable or wrong for the game: grid size, cell count, positions, id and weight ranges. */
export function structuralErrors(l: LvlFile): string[] {
  const errs: string[] = [];
  if (!Number.isInteger(l.width) || !Number.isInteger(l.height) || l.width < 1 || l.height < 1 || l.width > 256 || l.height > 256) {
    errs.push(`grid ${l.width}x${l.height} is not 1..256 x 1..256 (every vanilla level is 10x10)`);
    return errs;
  }
  if (l.tiles.length !== l.width * l.height) errs.push(`tiles has ${l.tiles.length} cells, the ${l.width}x${l.height} grid needs ${l.width * l.height}`);
  const pick = (p: LvlPick, what: string): void => {
    if (typeof p !== "number" && p.length === 0) { errs.push(`${what}: an empty random list`); return; }
    if (typeof p !== "number" && p.length > 0xffff) errs.push(`${what}: ${p.length} choices (at most 65535)`);
    for (const id of pickIds(p)) {
      if (!Number.isInteger(id) || id < 0 || id >= RANDOM) errs.push(`${what}: id ${id} must be an integer 0..65534 (0xffff / 65535 marks a random list)`);
    }
    if (typeof p !== "number") for (const c of p) if (!Number.isInteger(c.weight) || c.weight < 0 || c.weight > 0xffff) errs.push(`${what}: weight ${c.weight} must be an integer 0..65535`);
  };
  l.tiles.forEach((t, i) => pick(t, `tile (${i % l.width},${Math.floor(i / l.width)})`));
  for (const o of l.objects) {
    if (!inGrid(l, o.x, o.y)) errs.push(`object at (${o.x},${o.y}) is outside the ${l.width}x${l.height} grid`);
    pick(o.id, `object (${o.x},${o.y})`);
  }
  return errs;
}

/** A path the game reads as a level: `levels/<folder>/…/<name>.lvl`, plain name segments, no `..`. */
export function isLevelPath(relPath: string): boolean {
  return /^levels\/(?:[A-Za-z0-9_][A-Za-z0-9_-]*\/)*[A-Za-z0-9_][A-Za-z0-9_-]*\.lvl$/.test(relPath);
}

// ---- palette swatches (the dev editor's `editor { image_tint … name … }` block of tiles.gon / spawns.gon) ----

const TINTS: Record<string, string> = {
  red: "#d0413c",
  orange: "#e08a2c",
  yellow: "#e3c63a",
  green: "#3f9b45",
  cyan: "#36c3cf",
  blue: "#3b6fd8",
  purple: "#8a4fc6",
  pink: "#e27fb6",
  brown: "#8a5a2b",
  black: "#222222",
  grey: "#8c8c8c",
  gray: "#8c8c8c",
  white: "#f2f2f2",
};

/**
 * A CSS colour for an `image_tint` value: a colour name, an `[r g b]` triple of 0..1 floats, or a list of those (one
 * per image layer; the first non-`none` layer wins). null when nothing usable is there.
 */
export function swatchColor(tint: unknown): string | null {
  const one = (t: unknown): string | null => {
    if (typeof t === "string") return TINTS[t.toLowerCase()] ?? null;
    if (Array.isArray(t) && t.length >= 3 && t.slice(0, 3).every((v) => typeof v === "number")) {
      const [r, g, b] = (t as number[]).map((v) => Math.max(0, Math.min(255, Math.round(v * 255))));
      return `rgb(${r}, ${g}, ${b})`;
    }
    return null;
  };
  if (Array.isArray(tint) && tint.length && !(tint.length >= 3 && tint.slice(0, 3).every((v) => typeof v === "number"))) {
    for (const t of tint) {
      if (t === "none") continue;
      const c = one(t);
      if (c) return c;
    }
    return null;
  }
  return one(tint);
}

/** One or two letters for a grid cell: the initials of the entry's name. */
export function paletteLetter(name: string): string {
  const words = name.replace(/[^A-Za-z0-9 ]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return words.slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
}
