// The Art panel's scene sub-tabs. This file holds the Shapes tab (shape rows, their inline Bake glow form, the
// per-path fill editor) and re-exports the other tabs, which live in their own files (SpritesTab, ExportsTab,
// JsonTab; the Shapes tab's Texts section is TextsSection). Edits go through art-state.ts actions, which replace
// the edited object, so the memoized rows below re-render exactly when their shape changes.

import React, { useCallback, useState } from "react";
import { useStore } from "../store.ts";
import { A, getScene, setTarget, rampColor, bakeGlowInScene, updateShape } from "./art-state.ts";
import { sx, Ramp } from "./Bits.tsx";
import { Pill, Button } from "../components/ui.tsx";
import { ShapeRowMenu } from "./ShapeRowMenu.tsx";
import { ImportCard } from "./ImportPng.tsx";
import { TextsSection } from "./TextsSection.tsx";
import { shapeGrayUsage, parseFill } from "../../../src/core/art/scene.ts";
import type { Scene, SceneShape } from "./types.ts";

export { SpritesTab } from "./SpritesTab.tsx";
export { ExportsTab } from "./ExportsTab.tsx";
export { JsonTab } from "./JsonTab.tsx";

export function ShapesTab() {
  useStore(A, (a) => a.rev);
  const [glowFor, setGlowFor] = useState<string | null>(null);
  const toggleGlow = useCallback((id: string) => setGlowFor((cur) => (cur === id ? null : id)), []);
  const closeGlow = useCallback(() => setGlowFor(null), []);
  const sc = getScene() as Scene;
  const ids = Object.keys(sc.shapes || {});
  return (
    <div>
      <div className="artsec">
        <span className="sec">{`Shapes (${ids.length}) — DefineShape3, one fill style per path`}</span>
      </div>
      {ids.map((id) => (
        <ShapeRow key={id} id={id} sh={sc.shapes[id]!} hasGlow={!!sc.shapes[`${id}_glow`]} glowOpen={glowFor === id} onToggleGlow={toggleGlow} onCloseGlow={closeGlow} />
      ))}
      {ids.length ? null : (
        <div className="card plain" style={sx("padding:16px;color:var(--ink2)")}>
          <div style={sx("font-weight:700;color:var(--ink);margin-bottom:4px")}>No shapes yet</div>
          <div style={sx("font-size:12.5px;line-height:1.6")}>Import an SVG or a PNG below (each SVG becomes one shape). Gray fills become 16-level <span className="mono">gray:0–15</span> the engine recolors through a palette row; non-gray colours pass through and are flagged. Once a shape exists, wrap it in a sprite (its … menu) and Build the SWF.</div>
        </div>
      )}
      <ImportCard />
      <TextsSection />
      {ids.length ? <PathEditor /> : null}
    </div>
  );
}

interface ShapeRowProps {
  id: string;
  sh: SceneShape;
  hasGlow: boolean;
  glowOpen: boolean;
  onToggleGlow: (id: string) => void;
  onCloseGlow: () => void;
}

/** One shape: id · chips · gray ramp · meta · Preview · … (the overflow menu); the Bake glow form opens under it. */
const ShapeRow = React.memo(function ShapeRow({ id, sh, hasGlow, glowOpen, onToggleGlow, onCloseGlow }: ShapeRowProps) {
  const use = shapeGrayUsage(sh);
  const np = (sh.paths || []).length;
  return (
    <>
      <div className="artrow shape-row">
        <span className="id">{id}</span>
        {sh.baked ? <Pill kind="muted" chip title={`baked ${sh.baked.kind} of ${sh.baked.of}: ${sh.baked.color}, blur ${sh.baked.blur} px`}>{`${sh.baked.kind} of ${sh.baked.of}`}</Pill> : null}
        {use.passthrough ? <Pill kind="warn" chip title="non-gray fills are NOT palette-remapped by the engine">{`${use.passthrough} passthrough`}</Pill> : null}
        {use.bitmaps ? <Pill kind="muted" chip>{`${use.bitmaps} bitmap`}</Pill> : null}
        {use.gradients ? <Pill kind="muted" chip title="gradient fills (gray stops are remapped per pixel like any gray)">{`${use.gradients} gradient`}</Pill> : null}
        <Ramp used={use.levels} />
        <span className="meta">{`${np} path${np === 1 ? "" : "s"}${sh.source ? " · " + sh.source : ""}`}</span>
        <div className="grow" />
        <Button variant="ghost" size="sm" onClick={() => setTarget(id)}>Preview</Button>
        <ShapeRowMenu id={id} baked={!!sh.baked} onBakeGlow={() => onToggleGlow(id)} />
      </div>
      {glowOpen ? <BakeGlowPanel id={id} hasGlow={hasGlow} onDone={onCloseGlow} /> : null}
    </>
  );
});

/**
 * The inline "Bake glow…" form of a shape row: colour, blur, glow or drop shadow (with its offset). The game stops on
 * any SWF filter, so the halo is baked as the shape <id>_glow placed under the source (src/core/art/glow.ts bakeGlow,
 * through art-state's bakeGlowInScene).
 */
function BakeGlowPanel({ id, hasGlow, onDone }: { id: string; hasGlow: boolean; onDone: () => void }) {
  const [color, setColor] = useState("#ffcc00");
  const [blur, setBlur] = useState(8);
  const [kind, setKind] = useState<"glow" | "dropShadow">("glow");
  const [dx, setDx] = useState(4);
  const [dy, setDy] = useState(4);
  return (
    <div className="artrow" style={sx("gap:8px;flex-wrap:wrap;padding-left:24px")} data-glow-panel={id}>
      <span className="muted" style={sx("font-size:12px")}>{`halo under ${id}:`}</span>
      <select aria-label={`glow kind of ${id}`} value={kind} onChange={(e) => setKind(e.target.value as "glow" | "dropShadow")}>
        <option value="glow">glow</option>
        <option value="dropShadow">drop shadow</option>
      </select>
      <input aria-label={`glow colour of ${id}`} value={color} size={9} title="#rrggbb[aa] or gray:N (the alpha is the halo's ceiling)" onChange={(e) => setColor(e.target.value)} />
      <label className="muted" style={sx("font-size:12px;display:inline-flex;gap:4px;align-items:center")}>
        blur
        <input aria-label={`glow blur of ${id}`} type="number" min={0.5} max={255} step={1} value={blur} style={sx("width:56px")} onChange={(e) => setBlur(Number(e.target.value))} />
        px
      </label>
      {kind === "dropShadow" ? (
        <label className="muted" style={sx("font-size:12px;display:inline-flex;gap:4px;align-items:center")}>
          offset
          <input aria-label={`shadow dx of ${id}`} type="number" value={dx} style={sx("width:48px")} onChange={(e) => setDx(Number(e.target.value))} />
          <input aria-label={`shadow dy of ${id}`} type="number" value={dy} style={sx("width:48px")} onChange={(e) => setDy(Number(e.target.value))} />
        </label>
      ) : null}
      <button
        className="btn sm"
        aria-label={`Bake glow now for ${id}`}
        onClick={() => {
          bakeGlowInScene(id, { color, blur, kind, dx, dy, replace: hasGlow });
          onDone();
        }}
      >
        {hasGlow ? "Re-bake" : "Bake"}
      </button>
      <button className="btn ghost sm" onClick={onDone}>Cancel</button>
    </div>
  );
}

/** Per-path gray level editing for the selected shape (when the preview target is a shape). */
function PathEditor() {
  const id = useStore(A, (a) => a.target);
  useStore(A, (a) => a.row);
  useStore(A, (a) => a.showGray);
  useStore(A, (a) => a.rev);
  const sc = getScene() as Scene;
  const sh = sc.shapes && sc.shapes[id];
  if (!sh) return <p className="muted" style={sx("margin-top:14px")}>Click Preview on a shape to edit its paths' gray levels here.</p>;
  const grads = Object.keys(sc.gradients || {});
  const gradCss = (gid: string): string => {
    const gd = (sc.gradients || {})[gid];
    if (!gd || !Array.isArray(gd.stops)) return "transparent";
    const cols = gd.stops.map((s) => { const sf = parseFill(s.color).fill; return `${sf.kind === "gray" ? rampColor(sf.level) : String(s.color)} ${Math.round(s.offset * 100)}%`; });
    return `${gd.kind === "radial" ? "radial-gradient(circle" : "linear-gradient(90deg"}, ${cols.join(", ")})`;
  };
  return (
    <div>
      <div className="artsec"><span className="sec">{`Paths of "${id}" — fill per path`}</span></div>
      {(sh.paths || []).map((pth, i) => {
        const f = parseFill(pth.fill).fill;
        const selValue = f.kind === "gray" ? `gray:${f.level}` : f.kind === "none" ? "none" : f.kind === "gradient" && (sc.gradients || {})[f.id] ? `gradient:${f.id}` : "keep";
        const d = String(pth.d);
        return (
          <div key={i} className="artrow">
            <span className="id">{`#${i}`}</span>
            <span style={{ width: "18px", height: "18px", borderRadius: "4px", background: f.kind === "gray" ? rampColor(f.level) : f.kind === "rgba" ? String(pth.fill) : f.kind === "gradient" ? gradCss(f.id) : "transparent", border: "1px solid var(--line2)" }} />
            <select
              className="artinput mono"
              aria-label={`fill of path ${i}`}
              value={selValue}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "keep") return;
                updateShape(id, { ...sh, paths: sh.paths.map((p, j) => (j === i ? { ...p, fill: v === "none" ? null : v } : p)) });
              }}
            >
              {Array.from({ length: 16 }, (_, n) => <option key={n} value={`gray:${n}`}>{`gray:${n}`}</option>)}
              {grads.map((gid) => <option key={`g-${gid}`} value={`gradient:${gid}`}>{`gradient:${gid}`}</option>)}
              <option value="keep">{f.kind === "rgba" ? `${pth.fill} (passthrough)` : f.kind === "bitmap" ? String(pth.fill) : "(custom)"}</option>
              <option value="none">none</option>
            </select>
            <span className="meta mono" style={sx("overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px")}>{d.slice(0, 60) + (d.length > 60 ? "…" : "")}</span>
            {pth.stroke ? <Pill kind="muted" chip>{`stroke ${pth.strokeWidth}px`}</Pill> : null}
            <div className="grow" />
            <button className="btn ghost sm" style={sx("color:var(--err)")} aria-label={`Delete path ${i}`} onClick={() => updateShape(id, { ...sh, paths: sh.paths.filter((_, j) => j !== i) })}>Delete</button>
          </div>
        );
      })}
    </div>
  );
}
