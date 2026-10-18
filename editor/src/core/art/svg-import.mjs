// Tool-agnostic SVG → scene shapes importer. Accepts any SVG document (Inkscape,
// VectorCraft, Illustrator, hand-written) and produces `ScenePath[]` for one scene
// shape. Pure: no DOM (own minimal XML reader), no node imports, so it runs in the
// core and, if ever needed, in the browser.
//
// Supported: <path d>, <rect> (incl. rx/ry), <circle>, <ellipse>, <polygon>,
// <polyline>, <line>, <g> (transform/fill/stroke inheritance), presentation
// attributes and inline `style="fill:...;stroke:..."`, `transform` on every element,
// viewBox (reported, optionally applied as a matrix). Everything else is reported as a
// finding — gradients, filters, text, <use>, masks, clipPaths are never silently dropped.

import { parseSvgTransform, multiply, IDENTITY } from "./geometry.mjs";
import { parseFill } from "./scene.mjs";

/**
 * @typedef {import('./scene.mjs').ScenePath} ScenePath
 * @typedef {import('./scene.mjs').Finding} Finding
 * @typedef {import('./geometry.mjs').Mat} Mat
 */

/** @typedef {{ name: string, attrs: Record<string, string>, children: XNode[], text?: string }} XNode */

// ---- minimal XML reader -------------------------------------------------------

/**
 * Parse XML into a tree. Handles comments, CDATA, processing instructions, DOCTYPE,
 * self-closing tags, entities (&amp; &lt; &gt; &quot; &apos; &#n; &#xh;). Namespaced
 * names keep their prefix (e.g. "inkscape:label") so unknown vendor data is skippable.
 * @param {string} xml
 * @returns {XNode}
 */
export function parseXml(xml) {
  /** @type {XNode} */
  const root = { name: "#document", attrs: {}, children: [] };
  /** @type {XNode[]} */
  const stack = [root];
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) break;
    if (lt > i) {
      const text = xml.slice(i, lt);
      if (text.trim()) stack[stack.length - 1].children.push({ name: "#text", attrs: {}, children: [], text: decodeEntities(text) });
    }
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      const text = xml.slice(lt + 9, end < 0 ? n : end);
      stack[stack.length - 1].children.push({ name: "#text", attrs: {}, children: [], text });
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt) || xml.startsWith("<!", lt)) {
      const end = xml.indexOf(">", lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const gt = findTagEnd(xml, lt);
    const raw = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim();
      // pop to the matching open tag (tolerant of mismatches)
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    const selfClose = raw.endsWith("/");
    const body = selfClose ? raw.slice(0, -1) : raw;
    const m = /^([^\s/>]+)\s*([\s\S]*)$/.exec(body.trim());
    if (!m) continue;
    /** @type {XNode} */
    const node = { name: m[1], attrs: parseAttrs(m[2]), children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

/** @param {string} xml @param {number} lt */
function findTagEnd(xml, lt) {
  let q = "";
  for (let k = lt + 1; k < xml.length; k++) {
    const c = xml[k];
    if (q) {
      if (c === q) q = "";
    } else if (c === '"' || c === "'") q = c;
    else if (c === ">") return k;
  }
  return xml.length;
}

/** @param {string} s */
function parseAttrs(s) {
  /** @type {Record<string, string>} */
  const attrs = {};
  const re = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s))) attrs[m[1]] = decodeEntities(m[2] !== undefined ? m[2] : m[3]);
  return attrs;
}

/** @param {string} s */
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return /** @type {Record<string,string>} */ ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[e];
  });
}

// ---- SVG → paths ---------------------------------------------------------------

/**
 * @typedef {Object} ImportOptions
 * @property {boolean} [applyViewBox]   map viewBox → width/height as a matrix (default true when both present)
 * @property {boolean} [quantizeGray]   snap near-gray fills to gray:N (default true)
 * @property {number} [grayTolerance]   max channel spread treated as gray (default 8)
 * @property {boolean} [dropStrokes]    ignore strokes entirely (default false)
 */

/**
 * @typedef {Object} ImportResult
 * @property {boolean} ok
 * @property {ScenePath[]} paths
 * @property {Finding[]} findings
 * @property {{ width: number|null, height: number|null, viewBox: number[]|null, elements: number, skipped: Record<string, number> }} info
 */

/**
 * Import an SVG document's drawable elements as scene paths (in SVG user units ≡ px).
 * @param {string} svgText
 * @param {ImportOptions} [opts]
 * @returns {ImportResult}
 */
export function importSvg(svgText, opts = {}) {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {ScenePath[]} */
  const paths = [];
  /** @type {Record<string, number>} */
  const skipped = {};
  const info = { width: /** @type {number|null} */ (null), height: /** @type {number|null} */ (null), viewBox: /** @type {number[]|null} */ (null), elements: 0, skipped };
  let doc;
  try {
    doc = parseXml(svgText);
  } catch (e) {
    findings.push({ severity: "error", code: "svg-parse", message: `could not parse XML: ${String(e instanceof Error ? e.message : e)}` });
    return { ok: false, paths, findings, info };
  }
  const svg = doc.children.find((c) => localName(c.name) === "svg");
  if (!svg) {
    findings.push({ severity: "error", code: "svg-root", message: "no <svg> root element" });
    return { ok: false, paths, findings, info };
  }
  info.width = lengthPx(svg.attrs.width);
  info.height = lengthPx(svg.attrs.height);
  if (svg.attrs.viewBox) {
    const vb = svg.attrs.viewBox.trim().split(/[\s,]+/).map(Number);
    if (vb.length === 4 && vb.every((v) => Number.isFinite(v))) info.viewBox = vb;
    else findings.push({ severity: "warning", code: "svg-viewbox", message: `unreadable viewBox "${svg.attrs.viewBox}"` });
  }
  /** @type {Mat} */
  let rootMatrix = IDENTITY;
  const applyVb = opts.applyViewBox ?? (info.viewBox !== null && info.width !== null && info.height !== null);
  if (applyVb && info.viewBox && info.width !== null && info.height !== null) {
    const [vx, vy, vw, vh] = info.viewBox;
    if (vw > 0 && vh > 0) {
      const sx = info.width / vw;
      const sy = info.height / vh;
      rootMatrix = [sx, 0, 0, sy, -vx * sx, -vy * sy];
      if (Math.abs(sx - sy) > 1e-6) findings.push({ severity: "info", code: "svg-viewbox-aspect", message: `viewBox scale is non-uniform (${sx.toFixed(3)}, ${sy.toFixed(3)}); applied as-is` });
    }
  } else if (info.viewBox && (info.width === null || info.height === null)) {
    const [vx, vy] = info.viewBox;
    if (vx || vy) rootMatrix = [1, 0, 0, 1, -vx, -vy];
  }

  const defsIds = new Set();
  collectIds(svg, defsIds);

  /** @type {{ fill?: string, stroke?: string, strokeWidth?: string, fillRule?: string, opacity?: string, fillOpacity?: string, display?: string }} */
  const rootStyle = {};
  walk(svg, rootMatrix, rootStyle, true);

  /**
   * @param {XNode} node @param {Mat} parentM @param {typeof rootStyle} parentStyle @param {boolean} isRoot
   */
  function walk(node, parentM, parentStyle, isRoot) {
    for (const child of node.children) {
      if (child.name === "#text") continue;
      const tag = localName(child.name);
      const style = inherit(parentStyle, child.attrs);
      if (style.display === "none") {
        skip("display:none");
        continue;
      }
      const m = multiply(parentM, parseSvgTransform(child.attrs.transform));
      if (child.attrs.transform && /[a-zA-Z]+\s*\(/.test(child.attrs.transform) && !/^(\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\([^)]*\)\s*,?)+$/.test(child.attrs.transform)) {
        findings.push({ severity: "warning", code: "svg-transform", message: `unsupported transform function in "${child.attrs.transform}" (${tag}#${child.attrs.id || "?"})` });
      }
      switch (tag) {
        case "g":
        case "svg":
        case "a":
        case "switch":
          walk(child, m, style, false);
          break;
        case "defs":
        case "metadata":
        case "title":
        case "desc":
        case "style":
        case "namedview":
        case "sodipodi:namedview":
          break; // non-drawing
        case "symbol":
        case "marker":
        case "pattern":
        case "lineargradient":
        case "radialgradient":
        case "clippath":
        case "mask":
        case "filter":
          break; // referenced-only containers; usage is reported where referenced
        case "path":
          emit(child, child.attrs.d || "", m, style);
          break;
        case "rect":
          emit(child, rectPath(child.attrs), m, style);
          break;
        case "circle":
          emit(child, ellipsePath(num(child.attrs.cx), num(child.attrs.cy), num(child.attrs.r), num(child.attrs.r)), m, style);
          break;
        case "ellipse":
          emit(child, ellipsePath(num(child.attrs.cx), num(child.attrs.cy), num(child.attrs.rx), num(child.attrs.ry)), m, style);
          break;
        case "polygon":
          emit(child, pointsPath(child.attrs.points || "", true), m, style);
          break;
        case "polyline":
          emit(child, pointsPath(child.attrs.points || "", false), m, { ...style, fill: style.fill === undefined ? "none" : style.fill });
          break;
        case "line":
          emit(child, `M${num(child.attrs.x1)} ${num(child.attrs.y1)} L${num(child.attrs.x2)} ${num(child.attrs.y2)}`, m, { ...style, fill: "none" });
          break;
        case "text":
        case "tspan":
        case "image":
        case "use":
        case "foreignobject":
          skip(tag);
          findings.push({ severity: "warning", code: "svg-unsupported", message: `<${tag}> is not importable (convert text to paths / expand <use> in your editor)${child.attrs.id ? ` — #${child.attrs.id}` : ""}` });
          break;
        default:
          if (!child.name.includes(":")) {
            skip(tag);
            findings.push({ severity: "info", code: "svg-skipped", message: `<${child.name}> skipped` });
          }
      }
    }
    void isRoot;
  }

  /** @param {string} what */
  function skip(what) {
    skipped[what] = (skipped[what] || 0) + 1;
  }

  /**
   * @param {XNode} el @param {string} d @param {Mat} m @param {typeof rootStyle} style
   */
  function emit(el, d, m, style) {
    if (!d.trim()) {
      findings.push({ severity: "warning", code: "svg-empty", message: `<${localName(el.name)}#${el.attrs.id || "?"}> has no geometry` });
      return;
    }
    info.elements++;
    const where = `${localName(el.name)}#${el.attrs.id || info.elements}`;
    let fill = resolvePaint(style.fill === undefined ? "#000000" : style.fill, style.fillOpacity, style.opacity, where, "fill");
    const strokeRaw = style.stroke;
    let stroke = opts.dropStrokes || !strokeRaw ? null : resolvePaint(strokeRaw, undefined, style.opacity, where, "stroke");
    const strokeWidth = stroke ? lengthPx(style.strokeWidth) ?? 1 : 0;
    /** @type {ScenePath} */
    const p = { d, fill, fillRule: style.fillRule === "evenodd" ? "evenodd" : "nonzero" };
    if (stroke && strokeWidth > 0) {
      p.stroke = stroke;
      p.strokeWidth = strokeWidth;
    }
    if (m !== IDENTITY && !(m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0)) p.transform = /** @type {Mat} */ (m.map((v) => Math.round(v * 1e6) / 1e6));
    if (fill === null && !p.stroke) {
      findings.push({ severity: "info", code: "svg-invisible", message: `${where} has neither fill nor stroke; skipped` });
      return;
    }
    paths.push(p);
  }

  /**
   * Resolve an SVG paint to a scene fill string. Gray-ish colours become gray:N.
   * @param {string} paint @param {string|undefined} paintOpacity @param {string|undefined} opacity @param {string} where @param {'fill'|'stroke'} role
   * @returns {string|null}
   */
  function resolvePaint(paint, paintOpacity, opacity, where, role) {
    const s = paint.trim();
    if (!s || s === "none") return null;
    if (s.startsWith("url(")) {
      const id = s.slice(4, -1).replace(/^["']?#/, "").replace(/["']$/, "");
      findings.push({ severity: "warning", code: "svg-paint-server", message: `${where} ${role} uses ${defsIds.has(id) ? "gradient/pattern" : "unknown paint server"} #${id}; replaced with gray:8 — flatten it or pick a level` });
      return role === "fill" ? "gray:8" : null;
    }
    if (s === "currentColor" || s === "inherit") return role === "fill" ? "gray:0" : null;
    const parsed = parseFill(s);
    if (parsed.error) {
      findings.push({ severity: "warning", code: "svg-color", message: `${where}: unreadable ${role} colour "${s}"; replaced with gray:8` });
      return "gray:8";
    }
    const f = parsed.fill;
    const alpha = clamp01(numOr(paintOpacity, 1) * numOr(opacity, 1));
    if (f.kind === "gray") {
      if (alpha < 1) findings.push({ severity: "warning", code: "svg-gray-alpha", message: `${where}: ${role} opacity ${alpha.toFixed(2)} on a gray level — the engine remaps opaque gray only; alpha dropped (use a cxform on the key instead)` });
      return `gray:${f.level}`;
    }
    if (f.kind === "rgba") {
      const spread = Math.max(f.r, f.g, f.b) - Math.min(f.r, f.g, f.b);
      const tol = opts.grayTolerance ?? 8;
      if ((opts.quantizeGray ?? true) && spread <= tol && f.a === 255) {
        const avg = Math.round((f.r + f.g + f.b) / 3);
        const level = Math.max(0, Math.min(15, Math.floor((avg / 255) * 15 + 0.5)));
        findings.push({ severity: "info", code: "svg-gray-snapped", message: `${where}: near-gray ${s} snapped to gray:${level}` });
        return `gray:${level}`;
      }
      const a = Math.round(f.a * alpha);
      const hex = (/** @type {number} */ v) => v.toString(16).padStart(2, "0");
      return `#${hex(f.r)}${hex(f.g)}${hex(f.b)}${a < 255 ? hex(a) : ""}`;
    }
    return null;
  }

  return { ok: !findings.some((f) => f.severity === "error"), paths, findings, info };
}

/** @param {XNode} node @param {Set<string>} ids */
function collectIds(node, ids) {
  for (const c of node.children) {
    if (c.attrs && c.attrs.id) ids.add(c.attrs.id);
    collectIds(c, ids);
  }
}

/** @param {string} name */
function localName(name) {
  const i = name.indexOf(":");
  return (i >= 0 ? name.slice(i + 1) : name).toLowerCase();
}

/**
 * Merge presentation attributes + inline style onto the inherited style.
 * @param {{ fill?: string, stroke?: string, strokeWidth?: string, fillRule?: string, opacity?: string, fillOpacity?: string, display?: string }} parent
 * @param {Record<string,string>} attrs
 */
function inherit(parent, attrs) {
  /** @type {{ fill?: string, stroke?: string, strokeWidth?: string, fillRule?: string, opacity?: string, fillOpacity?: string, display?: string }} */
  const out = { ...parent };
  delete out.opacity; // opacity/display do not inherit as values (opacity composes, see below)
  delete out.display;
  const set = (/** @type {string} */ k, /** @type {string|undefined} */ v) => {
    if (v === undefined || v === null || v === "") return;
    if (k === "fill") out.fill = v;
    else if (k === "stroke") out.stroke = v;
    else if (k === "stroke-width") out.strokeWidth = v;
    else if (k === "fill-rule") out.fillRule = v;
    else if (k === "opacity") out.opacity = v;
    else if (k === "fill-opacity") out.fillOpacity = v;
    else if (k === "display") out.display = v;
  };
  for (const k of ["fill", "stroke", "stroke-width", "fill-rule", "opacity", "fill-opacity", "display"]) set(k, attrs[k]);
  if (attrs.style) {
    for (const decl of attrs.style.split(";")) {
      const i = decl.indexOf(":");
      if (i < 0) continue;
      set(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
    }
  }
  if (parent.opacity !== undefined) out.opacity = String(numOr(parent.opacity, 1) * numOr(out.opacity, 1));
  return out;
}

/** @param {string|undefined} s @returns {number|null} px for unitless/px/pt/mm/cm/in, null otherwise */
function lengthPx(s) {
  if (s === undefined || s === null || s === "") return null;
  const m = /^\s*([-+]?[\d.]+(?:e[-+]?\d+)?)\s*(px|pt|mm|cm|in|%)?\s*$/i.exec(s);
  if (!m) return null;
  const v = Number(m[1]);
  switch ((m[2] || "").toLowerCase()) {
    case "pt":
      return (v * 96) / 72;
    case "mm":
      return (v * 96) / 25.4;
    case "cm":
      return (v * 96) / 2.54;
    case "in":
      return v * 96;
    case "%":
      return null;
    default:
      return v;
  }
}
/** @param {string|undefined} s */
function num(s) {
  const v = lengthPx(s);
  return v === null ? 0 : v;
}
/** @param {string|undefined} s @param {number} d */
function numOr(s, d) {
  if (s === undefined) return d;
  const v = Number(s);
  return Number.isFinite(v) ? v : d;
}
/** @param {number} v */
function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

/** @param {Record<string,string>} a */
function rectPath(a) {
  const x = num(a.x);
  const y = num(a.y);
  const w = num(a.width);
  const h = num(a.height);
  let rx = a.rx !== undefined ? num(a.rx) : a.ry !== undefined ? num(a.ry) : 0;
  let ry = a.ry !== undefined ? num(a.ry) : rx;
  if (w <= 0 || h <= 0) return "";
  rx = Math.min(rx, w / 2);
  ry = Math.min(ry, h / 2);
  if (rx <= 0 || ry <= 0) return `M${x} ${y} H${x + w} V${y + h} H${x} Z`;
  return (
    `M${x + rx} ${y} H${x + w - rx} A${rx} ${ry} 0 0 1 ${x + w} ${y + ry} V${y + h - ry} A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h} ` +
    `H${x + rx} A${rx} ${ry} 0 0 1 ${x} ${y + h - ry} V${y + ry} A${rx} ${ry} 0 0 1 ${x + rx} ${y} Z`
  );
}
/** @param {number} cx @param {number} cy @param {number} rx @param {number} ry */
function ellipsePath(cx, cy, rx, ry) {
  if (rx <= 0 || ry <= 0) return "";
  return `M${cx + rx} ${cy} A${rx} ${ry} 0 1 1 ${cx - rx} ${cy} A${rx} ${ry} 0 1 1 ${cx + rx} ${cy} Z`;
}
/** @param {string} pts @param {boolean} close */
function pointsPath(pts, close) {
  const nums = pts
    .trim()
    .split(/[\s,]+/)
    .filter((s) => s.length)
    .map(Number);
  if (nums.length < 4) return "";
  let d = `M${nums[0]} ${nums[1]}`;
  for (let i = 2; i + 1 < nums.length; i += 2) d += ` L${nums[i]} ${nums[i + 1]}`;
  return close ? d + " Z" : d;
}
