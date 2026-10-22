// Ghost cat outlines from the game's own catparts.swf (Node side: swf-reader needs node:zlib). Read-only; the outlines are
// computed per request from the git-ignored extracted copy and never written anywhere (game art is never committed).
//
// OBSERVED 2026-10-22 (read-only parse of catparts.swf): each part export — CatBody #8845, CatHead #7132, CatLeg #9925,
// CatTail #10982 — is a many-frame sprite (one frame per part variant) whose frame 1 places, at depth 1, a single-fill
// mask shape (clipDepth set) that is the part's silhouette, followed by the `tex` / `scars` children and an outline
// shape it masks. The ghost uses that mask shape: one closed run per contour, already in the part's local space.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readSwf, shapeToSubpaths } from "./swf-reader.ts";
import type { Tag } from "./swf-reader.ts";
import { vanillaSwfDir } from "../repo.ts";
import { BUILTIN_GHOST_PARTS, GHOST_PART_NAMES, outlineBounds } from "./ghost-cat.ts";
import type { GhostParts, GhostPartName, GhostOutline } from "./ghost-cat.ts";
import type { Mat } from "./geometry.ts";

const r2 = (v: number) => String(Math.round(v * 100) / 100);

/** The four part silhouettes of a catparts.swf image, or null when any of them cannot be found. */
export function ghostPartsFromSwf(bytes: Uint8Array): GhostParts | null {
  const swf = readSwf(bytes);
  const byId = new Map<number, Tag>();
  for (const t of swf.tags) {
    const id = t.shape ? t.shape.id : t.name === "DefineSprite" ? t.id : undefined;
    if (id !== undefined) byId.set(id, t);
  }
  const sym = swf.tags.find((t) => t.name === "SymbolClass");
  if (!sym || !sym.entries) return null;
  const parts = {} as Record<GhostPartName, GhostOutline>;
  for (const name of GHOST_PART_NAMES) {
    const entry = sym.entries.find((e) => e.name === name);
    const sprite = entry ? byId.get(entry.id) : undefined;
    if (!sprite || !sprite.tags) return null;
    const firstFrame: Tag[] = [];
    for (const t of sprite.tags) {
      if (t.name === "ShowFrame") break;
      if (t.place && t.place.characterId !== undefined) firstFrame.push(t);
    }
    const isShape = (t: Tag) => !!byId.get(t.place!.characterId!)?.shape;
    const pick = firstFrame.find((t) => t.place!.clipDepth !== undefined && isShape(t)) || firstFrame.find(isShape);
    if (!pick) return null;
    const shape = byId.get(pick.place!.characterId!)!.shape!;
    // reader matrices: scale/rotate as numbers, translate in twips; shape coordinates in twips
    const m: Mat = pick.place!.matrix || [1, 0, 0, 1, 0, 0];
    const pt = (x: number, y: number) => `${r2((m[0] * x + m[2] * y + m[4]) / 20)} ${r2((m[1] * x + m[3] * y + m[5]) / 20)}`;
    let d = "";
    for (const run of shapeToSubpaths(shape)) {
      if (!run.fill0 && !run.fill1) continue;
      d += `M${pt(run.points[0]!, run.points[1]!)}`;
      for (const e of run.edges) d += e.t === "L" ? ` L${pt(e.x, e.y)}` : ` Q${pt(e.cx, e.cy)} ${pt(e.x, e.y)}`;
      d += " Z ";
    }
    d = d.trim();
    if (!d) return null;
    parts[name] = { d, bounds: outlineBounds(d), fillRule: "evenodd" };
  }
  return { source: "catparts.swf", parts };
}

const cache = new Map<string, { mtimeMs: number; parts: GhostParts }>();

/**
 * The ghost outlines for the preview: catparts.swf's silhouettes when `swfDir` (default: the extracted vanilla SWFs)
 * has the file, else the built-in shapes with a `note` saying why. Cached per file and modification time.
 */
export function readGhostCatParts(swfDir: string = vanillaSwfDir()): GhostParts {
  const file = join(swfDir, "catparts.swf");
  if (!existsSync(file)) return { ...BUILTIN_GHOST_PARTS, note: `no catparts.swf at ${swfDir} (extract the game files for the real part outlines): built-in silhouettes` };
  try {
    const mtimeMs = statSync(file).mtimeMs;
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit.parts;
    const parts = ghostPartsFromSwf(new Uint8Array(readFileSync(file))) || { ...BUILTIN_GHOST_PARTS, note: `catparts.swf at ${swfDir} has no CatBody/CatHead/CatLeg/CatTail silhouettes this reader understands: built-in silhouettes` };
    cache.set(file, { mtimeMs, parts });
    return parts;
  } catch (e) {
    return { ...BUILTIN_GHOST_PARTS, note: `catparts.swf could not be read (${e instanceof Error ? e.message : String(e)}): built-in silhouettes` };
  }
}
