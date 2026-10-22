// Undo VectorCraft's artboard re-origin. Pure (string → string), shared by the Art-mode VectorCraft panel and the
// MCP tool.
//
// Captured fact (test/fixtures/vectorcraft/README.md; v0.14.0 web build driven headlessly on 2026-10-22): when
// VectorCraft opens the SVG our exporter writes (a padded `viewBox="x y w h"` around the shape, coordinates as in
// the scene), the viewBox becomes "Artboard 1" — the same w × h at 0,0 — and every coordinate is translated by
// (-x, -y). `app.export` then always writes `viewBox="0 0 w h"`; art the user draws outside the artboard keeps its
// (negative or larger) document coordinates. So the way back is one translation, (+x, +y), applied to everything
// VectorCraft returns: this wraps the returned root's children in `<g transform="translate(x y)">` and restores
// the root viewBox origin. The importer (svg-import.ts) folds that group matrix into each path's `transform`
// while gradient geometry stays path-local, exactly like a `<g transform>` from Inkscape — so a scene shape
// round-trips to the same place (art-svg-reorigin-tests.ts checks the bounds against the captured fixtures).

const num = (v: number) => String(Math.round(v * 1e6) / 1e6);

interface RootTag { start: number; end: number; tag: string }

/** The root `<svg …>` opening tag of a document (after any prolog, comments or DOCTYPE). */
function rootTag(svg: string): RootTag | null {
  const re = /<svg(?=[\s>])/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) {
    const end = svg.indexOf(">", m.index);
    if (end < 0) return null;
    return { start: m.index, end: end + 1, tag: svg.slice(m.index, end + 1) };
  }
  return null;
}

/** The root viewBox as [x, y, w, h] (spaces or commas), or null when absent / malformed. */
export function parseViewBox(svg: string): number[] | null {
  const root = rootTag(svg);
  if (!root) return null;
  const m = /\sviewBox\s*=\s*["']([^"']*)["']/i.exec(root.tag);
  if (!m) return null;
  const parts = m[1]!.trim().split(/[\s,]+/).map(Number);
  return parts.length === 4 && parts.every((v) => Number.isFinite(v)) ? parts : null;
}

export interface ReoriginResult {
  svg: string;
  /** the translation applied (original viewBox origin minus the returned one) */
  dx: number;
  dy: number;
}

/**
 * Move an SVG exported by VectorCraft back onto the coordinates of the SVG it was opened from.
 * @param svg what `app.export { format: "svg" }` returned
 * @param originalViewBox the `viewBox` of the SVG that was opened (what svg-export.ts wrote: [x, y, w, h])
 */
export function reoriginSvg(svg: string, originalViewBox: number[]): ReoriginResult {
  if (!Array.isArray(originalViewBox) || originalViewBox.length !== 4 || !originalViewBox.every((v) => typeof v === "number" && Number.isFinite(v))) {
    throw new Error("originalViewBox must be the opened SVG's viewBox as [x, y, w, h]");
  }
  const root = rootTag(svg);
  if (!root) throw new Error("no <svg> root element in the exported document");
  const closeAt = svg.lastIndexOf("</svg");
  if (closeAt < root.end) throw new Error("the <svg> root element is not closed");
  const returned = parseViewBox(svg) ?? [0, 0, originalViewBox[2]!, originalViewBox[3]!];
  const dx = originalViewBox[0]! - returned[0]!;
  const dy = originalViewBox[1]! - returned[1]!;
  if (dx === 0 && dy === 0) return { svg, dx: 0, dy: 0 };
  const viewBox = `viewBox="${num(originalViewBox[0]!)} ${num(originalViewBox[1]!)} ${num(returned[2]!)} ${num(returned[3]!)}"`;
  const tag = /\sviewBox\s*=\s*["'][^"']*["']/i.test(root.tag)
    ? root.tag.replace(/\sviewBox\s*=\s*["'][^"']*["']/i, ` ${viewBox}`)
    : root.tag.replace(/\s*\/?>$/, (m) => ` ${viewBox}${m}`);
  const inner = svg.slice(root.end, closeAt);
  const out = `${svg.slice(0, root.start)}${tag}<g transform="translate(${num(dx)} ${num(dy)})">${inner}</g>${svg.slice(closeAt)}`;
  return { svg: out, dx, dy };
}
