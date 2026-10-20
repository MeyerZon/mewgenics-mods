// A scene shape as a standalone SVG, for editing in any vector editor (VectorCraft, Inkscape, Illustrator) and
// importing back (importSvg with applyViewBox: false restores the same paths). Pure.
//
// VectorCraft (github.com/storytold/vectorcraft) is a static vector illustration app — no timeline, no player — so the
// round trip carries one shape; animation stays in the editor's Timeline tab and the SWF it builds.

import { normalizePath, subpathBounds, unionBounds } from "./geometry.ts";
import { parseFill, fillToRgba, grayLevelToByte } from "./scene.ts";
import type { SceneShape, SceneGradient, Finding } from "./scene.ts";

const hex2 = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const num = (v: number) => String(Math.round(v * 1e6) / 1e6);

/** A scene colour as SVG paint + opacity (gray:N → its exact byte, so the importer maps it back to gray:N). */
function paint(color: string | null | undefined): { fill: string; opacity: number | null } | null {
  const f = parseFill(color).fill;
  if (f.kind === "gray") {
    const v = hex2(grayLevelToByte(f.level));
    return { fill: `#${v}${v}${v}`, opacity: null };
  }
  const c = fillToRgba(f);
  if (!c) return null;
  return { fill: `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${c.a < 255 ? hex2(c.a) : ""}`, opacity: null };
}

export interface SvgExport {
  svg: string;
  findings: Finding[];
}

export function shapeToSvg(shape: SceneShape, gradients: Record<string, SceneGradient> = {}, opts: { pad?: number } = {}): SvgExport {
  const findings: Finding[] = [];
  const used = new Set<string>();
  const body: string[] = [];
  let bounds = null as ReturnType<typeof subpathBounds>;
  (shape.paths || []).forEach((p, i) => {
    try { bounds = unionBounds(bounds, subpathBounds(normalizePath(p.d, { matrix: p.transform }))); } catch { /* validation reports bad d */ }
    const a: string[] = [`d="${attr(p.d)}"`];
    const f = parseFill(p.fill).fill;
    if (f.kind === "none") a.push(`fill="none"`);
    else if (f.kind === "gradient") { a.push(`fill="url(#${f.id})"`); used.add(f.id); }
    else if (f.kind === "bitmap") {
      a.push(`fill="#ff00ff"`);
      findings.push({ severity: "warning", code: "svg-export-bitmap", message: `path ${i} has a bitmap fill (${f.id}); exported as magenta — a re-import loses the bitmap`, path: `paths[${i}].fill` });
    } else {
      const pt = paint(p.fill);
      if (pt) a.push(`fill="${pt.fill}"`);
    }
    if (p.fillRule === "evenodd") a.push(`fill-rule="evenodd"`);
    if (p.stroke && (p.strokeWidth ?? 0) > 0) {
      const sf = parseFill(p.stroke).fill;
      if (sf.kind === "gradient") { a.push(`stroke="url(#${sf.id})"`); used.add(sf.id); }
      else { const pt = paint(p.stroke); if (pt) a.push(`stroke="${pt.fill}"`); }
      a.push(`stroke-width="${num(p.strokeWidth as number)}"`);
      a.push(`stroke-linecap="${p.strokeCap || "round"}"`, `stroke-linejoin="${p.strokeJoin || "round"}"`);
      if ((p.strokeJoin || "round") === "miter") a.push(`stroke-miterlimit="${num(p.miterLimit ?? 4)}"`);
      if (p.strokeScale === "none") a.push(`vector-effect="non-scaling-stroke"`);
    }
    if (p.transform && p.transform.length === 6) a.push(`transform="matrix(${p.transform.map(num).join(" ")})"`);
    body.push(`  <path ${a.join(" ")}/>`);
  });
  const defs: string[] = [];
  for (const id of used) {
    const g = gradients[id];
    if (!g) {
      findings.push({ severity: "warning", code: "svg-export-gradient", message: `gradient "${id}" is not in the scene; the fill stays a dangling url(#${id})` });
      continue;
    }
    const geo = g.kind === "radial"
      ? [`cx="${num(g.cx ?? 0)}"`, `cy="${num(g.cy ?? 0)}"`, `r="${num(g.r ?? 0)}"`, ...(g.fx !== undefined && g.fy !== undefined ? [`fx="${num(g.fx)}"`, `fy="${num(g.fy)}"`] : [])]
      : [`x1="${num(g.x1 ?? 0)}"`, `y1="${num(g.y1 ?? 0)}"`, `x2="${num(g.x2 ?? 0)}"`, `y2="${num(g.y2 ?? 0)}"`];
    const extra = [g.spread && g.spread !== "pad" ? `spreadMethod="${g.spread}"` : "", g.transform ? `gradientTransform="matrix(${g.transform.map(num).join(" ")})"` : ""].filter(Boolean);
    const stops = (g.stops || []).map((s) => {
      const c = fillToRgba(parseFill(s.color).fill) || { r: 0, g: 0, b: 0, a: 255 };
      return `      <stop offset="${num(s.offset)}" stop-color="#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}"${c.a < 255 ? ` stop-opacity="${num(c.a / 255)}"` : ""}/>`;
    });
    const tagName = g.kind === "radial" ? "radialGradient" : "linearGradient";
    defs.push(`    <${tagName} id="${attr(id)}" gradientUnits="userSpaceOnUse" ${[...geo, ...extra].join(" ")}>`, ...stops, `    </${tagName}>`);
  }
  const pad = opts.pad ?? 4;
  const b = bounds || { xmin: 0, ymin: 0, xmax: 100, ymax: 100 };
  const vx = Math.floor(b.xmin - pad), vy = Math.floor(b.ymin - pad);
  const vw = Math.ceil(b.xmax + pad) - vx, vh = Math.ceil(b.ymax + pad) - vy;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}" width="${vw}" height="${vh}">`,
    `  <!-- exported by the Mewgenics mod editor: edit and save as plain SVG, then import it back over the same shape -->`,
    ...(defs.length ? ["  <defs>", ...defs, "  </defs>"] : []),
    ...body,
    `</svg>`,
    "",
  ].join("\n");
  return { svg, findings };
}
