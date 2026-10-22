// The Shapes / Sprites / Exports / JSON sub-tabs of the Art panel. They edit the scene in
// place and call scheduleValidate() + bump() exactly like art-ui.mjs did.

import React, { useRef, useState } from "react";
import { useStore } from "../store.ts";
import { toast } from "../state.ts";
import { A, getScene, setScene, bump, scheduleValidate, setTarget, setShowGray, rampColor, exportShapeSvgFile, replaceShapeFromSvg, bakeGlowInScene, openShapeInVectorcraft } from "./art-state.ts";
import { sx, Ramp, CommitInput } from "./Bits.tsx";
import { DropZone } from "./DropZone.tsx";
import { shapeGrayUsage, parseFill } from "../../../src/core/art/scene.ts";
import { GAME_FONTS } from "../../../src/core/art/text.ts";
import type { SceneText } from "../../../src/core/art/text.ts";
import { bakeSprite, type BakedSprite } from "../../../src/core/art/timeline.ts";
import type { Scene, SceneSprite } from "./types.ts";

export function ShapesTab() {
  const showGray = useStore(A, (a) => a.showGray);
  const [glowFor, setGlowFor] = useState<string | null>(null);
  const sc = getScene() as Scene;
  const ids = Object.keys(sc.shapes || {});
  return (
    <div>
      <div className="artsec">
        <span className="sec">{`Shapes (${ids.length}) — DefineShape3, one fill style per path`}</span>
        <label className="muted" style={sx("font-size:12px;display:inline-flex;gap:6px;align-items:center")}>
          <input type="checkbox" checked={showGray} onChange={(e) => setShowGray(e.target.checked)} />
          show raw gray
        </label>
      </div>
      {ids.map((id) => {
        const sh = sc.shapes[id]!;
        const use = shapeGrayUsage(sh);
        const np = (sh.paths || []).length;
        return (
          <React.Fragment key={id}>
          <div className="artrow">
            <span className="id">{id}</span>
            <Ramp used={use.levels} />
            <span className="meta">{`${np} path${np === 1 ? "" : "s"}${sh.source ? " · " + sh.source : ""}`}</span>
            {sh.baked ? <span className="pill muted chip" title={`baked ${sh.baked.kind} of ${sh.baked.of}: ${sh.baked.color}, blur ${sh.baked.blur} px`}>{`${sh.baked.kind} of ${sh.baked.of}`}</span> : null}
            {use.passthrough ? <span className="pill warn chip" title="non-gray fills are NOT palette-remapped by the engine">{`${use.passthrough} passthrough`}</span> : null}
            {use.bitmaps ? <span className="pill muted chip">{`${use.bitmaps} bitmap`}</span> : null}
            {use.gradients ? <span className="pill muted chip" title="gradient fills (gray stops are remapped per pixel like any gray)">{`${use.gradients} gradient`}</span> : null}
            <div className="grow" />
            <button className="btn ghost sm" onClick={() => setTarget(id)}>Preview</button>
            <button
              className="btn ghost sm"
              title="Wrap this shape in a new 1-frame sprite"
              onClick={() => {
                let sid = id + "Clip";
                let n = 2;
                while (sc.sprites[sid] || sc.shapes[sid]) sid = `${id}Clip${n++}`;
                sc.sprites[sid] = { frames: 1, labels: {}, layers: [{ name: id, depth: 1, keys: [{ frame: 0, ref: id, x: 0, y: 0 }] }] };
                if (!Object.values(sc.exports).includes(sid)) sc.exports[sid] = sid;
                A.set({ subtab: "sprites" });
                scheduleValidate();
                bump();
              }}
            >
              → Sprite
            </button>
            <button className="btn ghost sm" aria-label={`Open ${id} in VectorCraft`} title="Draw on this shape in the VectorCraft tab (in-editor); Apply there brings it back" onClick={() => openShapeInVectorcraft(id)}>VectorCraft</button>
            <button className="btn ghost sm" aria-label={`Export SVG of ${id}`} title="Write art/<shape>.svg for VectorCraft, Inkscape or any vector editor" onClick={() => void exportShapeSvgFile(id)}>Export SVG</button>
            {sh.baked ? null : (
              <button className="btn ghost sm" aria-label={`Bake glow of ${id}`} title="The game refuses SWF filters; this bakes a halo shape <id>_glow under this shape (bakeGlow)" onClick={() => setGlowFor(glowFor === id ? null : id)}>
                Bake glow…
              </button>
            )}
            <label className="btn ghost sm" title="Bring an edited SVG back over this shape (same coordinates)">
              Replace…
              <input type="file" accept=".svg,image/svg+xml" aria-label={`Replace ${id} from SVG`} style={sx("display:none")} onChange={(e) => { const f = e.target.files && e.target.files[0]; if (f) void replaceShapeFromSvg(id, f); e.target.value = ""; }} />
            </label>
            <button className="btn ghost sm" style={sx("color:var(--err)")} aria-label={`Delete shape ${id}`} onClick={() => { delete sc.shapes[id]; scheduleValidate(); bump(); }}>Delete</button>
          </div>
          {glowFor === id ? <BakeGlowPanel id={id} hasGlow={!!sc.shapes[`${id}_glow`]} onDone={() => setGlowFor(null)} /> : null}
          </React.Fragment>
        );
      })}
      {ids.length ? null : (
        <div className="card plain" style={sx("padding:16px;color:var(--ink2)")}>
          <div style={sx("font-weight:700;color:var(--ink);margin-bottom:4px")}>No shapes yet</div>
          <div style={sx("font-size:12.5px;line-height:1.6")}>Import an SVG below (each SVG becomes one shape). Gray fills become 16-level <span className="mono">gray:0–15</span> the engine recolors through a palette row; non-gray colours pass through and are flagged. Once a shape exists, wrap it in a sprite and Build the SWF.</div>
        </div>
      )}
      <div style={sx("margin-top:12px")}><DropZone text="Drop an SVG to add a shape. Each SVG becomes one shape (many paths)." /></div>
      <TextsSection />
      {ids.length ? <PathEditor /> : null}
    </div>
  );
}

/**
 * The inline "Bake glow…" form of a shape row: colour, blur, glow or drop shadow (with its offset). The game stops on
 * any SWF filter, so the halo is baked as the shape <id>_glow placed under the source (src/core/art/glow.ts).
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

/**
 * Texts: DefineEditText characters in one of the game's own fonts (swfs/fonts.swf classes; text.ts), placed by keys
 * like shapes. The game draws them in its font; the preview uses the font if installed here, else a serif stand-in.
 */
function TextsSection() {
  useStore(A, (a) => a.rev);
  const sc = getScene() as Scene;
  const texts = sc.texts || {};
  const ids = Object.keys(texts);
  const set = (id: string, patch: Partial<SceneText>) => {
    sc.texts = { ...texts, [id]: { ...texts[id]!, ...patch } };
    scheduleValidate();
    bump();
  };
  return (
    <div style={sx("margin-top:16px")}>
      <div className="artsec">
        <span className="sec">{`Texts (${ids.length}) — DefineEditText in a game font`}</span>
        <button
          className="btn ghost sm"
          onClick={() => {
            let id = "text";
            let n = 2;
            while (texts[id] || sc.shapes[id] || sc.sprites[id]) id = `text${n++}`;
            sc.texts = { ...texts, [id]: { text: "Text", font: "Peralta", size: 24, color: "#000000", align: "center", width: 200, height: 40 } };
            scheduleValidate();
            bump();
            toast(`added text "${id}" — place it on a sprite layer like a shape`);
          }}
        >
          New text
        </button>
      </div>
      {ids.map((id) => {
        const t = texts[id]!;
        return (
          <div key={id} className="artrow text-row">
            <span className="id">{id}</span>
            <CommitInput className="artinput" style={sx("flex:1")} aria-label={`words of ${id}`} initial={t.text} onCommit={(v) => set(id, { text: v })} />
            <select className="artinput" aria-label={`font of ${id}`} value={t.font || "Peralta"} onChange={(e) => set(id, { font: e.target.value })}>
              {GAME_FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <CommitInput className="artinput num" type="number" min={1} aria-label={`size of ${id}`} initial={t.size} onCommit={(v) => set(id, { size: Math.max(1, Number(v) || 1) })} />
            <CommitInput className="artinput mono" style={sx("width:90px")} aria-label={`colour of ${id}`} initial={t.color || "#000000"} onCommit={(v) => set(id, { color: v })} />
            <select className="artinput" aria-label={`align of ${id}`} value={t.align || "center"} onChange={(e) => set(id, { align: e.target.value as SceneText["align"] })}>
              <option value="left">left</option>
              <option value="center">center</option>
              <option value="right">right</option>
            </select>
            <button className="btn ghost sm" style={sx("color:var(--err)")} aria-label={`Delete text ${id}`} onClick={() => { const next = { ...texts }; delete next[id]; sc.texts = next; scheduleValidate(); bump(); }}>Delete</button>
          </div>
        );
      })}
    </div>
  );
}

/** Per-path gray level editing for the selected shape (when the preview target is a shape). */
function PathEditor() {
  const id = useStore(A, (a) => a.target);
  useStore(A, (a) => a.row);
  useStore(A, (a) => a.showGray);
  const sc = getScene() as Scene;
  const sh = sc.shapes && sc.shapes[id];
  if (!sh) return <p className="muted" style={sx("margin-top:14px")}>Click Preview on a shape to edit its paths' gray levels here.</p>;
  return (
    <div>
      <div className="artsec"><span className="sec">{`Paths of "${id}" — fill per path`}</span></div>
      {(sh.paths || []).map((pth, i) => {
        const f = parseFill(pth.fill).fill;
        const selValue = f.kind === "gray" ? `gray:${f.level}` : f.kind === "none" ? "none" : f.kind === "gradient" && (sc.gradients || {})[f.id] ? `gradient:${f.id}` : "keep";
        const grads = Object.keys(sc.gradients || {});
        const gradCss = (gid: string): string => {
          const gd = (sc.gradients || {})[gid];
          if (!gd || !Array.isArray(gd.stops)) return "transparent";
          const cols = gd.stops.map((s) => { const sf = parseFill(s.color).fill; return `${sf.kind === "gray" ? rampColor(sf.level) : String(s.color)} ${Math.round(s.offset * 100)}%`; });
          return `${gd.kind === "radial" ? "radial-gradient(circle" : "linear-gradient(90deg"}, ${cols.join(", ")})`;
        };
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
                pth.fill = v === "keep" ? pth.fill : v === "none" ? null : v;
                scheduleValidate();
                bump();
              }}
            >
              {Array.from({ length: 16 }, (_, n) => <option key={n} value={`gray:${n}`}>{`gray:${n}`}</option>)}
              {grads.map((gid) => <option key={`g-${gid}`} value={`gradient:${gid}`}>{`gradient:${gid}`}</option>)}
              <option value="keep">{f.kind === "rgba" ? `${pth.fill} (passthrough)` : f.kind === "bitmap" ? String(pth.fill) : "(custom)"}</option>
              <option value="none">none</option>
            </select>
            <span className="meta mono" style={sx("overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px")}>{d.slice(0, 60) + (d.length > 60 ? "…" : "")}</span>
            {pth.stroke ? <span className="pill muted chip">{`stroke ${pth.strokeWidth}px`}</span> : null}
            <div className="grow" />
            <button className="btn ghost sm" style={sx("color:var(--err)")} aria-label={`Delete path ${i}`} onClick={() => { sh.paths.splice(i, 1); scheduleValidate(); bump(); }}>Delete</button>
          </div>
        );
      })}
    </div>
  );
}

export function SpritesTab() {
  const sc = getScene() as Scene;
  const ids = Object.keys(sc.sprites || {});
  const shapeIds = Object.keys(sc.shapes || {});
  return (
    <div>
      <div className="artsec">
        <span className="sec">{`Sprites (${ids.length}) — DefineSprite timelines`}</span>
        <button
          className="btn ghost sm"
          onClick={() => {
            let sid = "Sprite";
            let n = 2;
            while (sc.sprites[sid] || sc.shapes[sid]) sid = `Sprite${n++}`;
            sc.sprites[sid] = { frames: 12, labels: { idle: 0 }, layers: [] };
            scheduleValidate();
            bump();
          }}
        >
          + New sprite
        </button>
      </div>
      {ids.map((id) => {
        const sp = sc.sprites[id]!;
        const baked = safeBake(sp);
        const labels = Object.entries(sp.labels || {}).map(([k, v]) => `${k}:${v}`).join(", ");
        return (
          <div key={id} className="card plain">
            <div style={sx("display:flex;align-items:center;gap:10px;flex-wrap:wrap")}>
              <span className="id mono" style={sx("font-weight:700")}>{id}</span>
              <label className="muted" style={sx("font-size:12px;display:inline-flex;gap:6px;align-items:center")}>
                frames
                <CommitInput className="artinput num" type="number" min={1} initial={sp.frames} onCommit={(v) => { sp.frames = Math.max(1, Number(v) | 0); scheduleValidate(); bump(); }} />
              </label>
              <label className="muted" style={sx("font-size:12px;display:inline-flex;gap:6px;align-items:center;flex:1")}>
                labels
                <CommitInput className="artinput mono" style={sx("flex:1")} initial={labels} placeholder="idle:0, attack:6" onCommit={(v) => { sp.labels = parseLabels(v); scheduleValidate(); bump(); }} />
              </label>
              <button className="btn ghost sm" onClick={() => setTarget(id)}>Preview</button>
              <button
                className="btn ghost sm"
                style={sx("color:var(--err)")}
                aria-label={`Delete sprite ${id}`}
                onClick={() => {
                  delete sc.sprites[id];
                  for (const k of Object.keys(sc.exports)) if (sc.exports[k] === id) delete sc.exports[k];
                  scheduleValidate();
                  bump();
                }}
              >
                Delete
              </button>
            </div>
            <div style={sx("margin-top:10px")}>
              {(sp.layers || []).map((layer, li) => {
                const nk = (layer.keys || []).length;
                return (
                  <div key={li} className="artrow">
                    <span className="id">{layer.name || `(depth ${layer.depth})`}</span>
                    <span className="meta mono">{`depth ${layer.depth}`}</span>
                    <span className="meta">{`${nk} key${nk === 1 ? "" : "s"}: ${(layer.keys || []).map((k) => `${k.frame}${k.ref ? "→" + k.ref : "→∅"}${k.tween === "linear" ? "~" : ""}`).join("  ")}`}</span>
                    {layer.clip ? <span className="pill muted chip">{`mask ≤${layer.clipDepth}`}</span> : null}
                    <div className="grow" />
                    <button className="btn ghost sm" style={sx("color:var(--err)")} aria-label={`Delete layer ${li}`} onClick={() => { sp.layers.splice(li, 1); scheduleValidate(); bump(); }}>Delete</button>
                  </div>
                );
              })}
              <div style={sx("display:flex;gap:8px;align-items:center;margin-top:6px")}>
                <span className="muted" style={sx("font-size:12px")}>+ layer from</span>
                <select
                  className="artinput"
                  aria-label={`add a layer to ${id}`}
                  value=""
                  onChange={(e) => {
                    const ref = e.target.value;
                    if (!ref) return;
                    const depth = Math.max(0, ...(sp.layers || []).map((l) => l.depth)) + 1;
                    sp.layers.push({ name: ref, depth, keys: [{ frame: 0, ref, x: 0, y: 0 }] });
                    scheduleValidate();
                    bump();
                  }}
                >
                  <option value="">shape or sprite…</option>
                  {shapeIds.map((s) => <option key={s} value={s}>{s}</option>)}
                  {ids.filter((s) => s !== id).map((s) => <option key={s} value={s}>{s + " (sprite)"}</option>)}
                </select>
                <span className="muted" style={sx("font-size:11.5px")}>{baked ? `${baked.frames} frames baked · ${baked.placements.reduce((n, f) => n + f.length, 0)} placements` : "invalid"}</span>
                <span className="muted" style={sx("font-size:11.5px")}>— keys are edited in the JSON tab (x y sx sy rot alpha tween)</span>
              </div>
            </div>
          </div>
        );
      })}
      {ids.length ? null : <p className="muted">No sprites. A sprite is what GON animates (frame labels like idle / attack).</p>}
    </div>
  );
}

function safeBake(sp: SceneSprite): BakedSprite | null {
  try {
    return bakeSprite(sp);
  } catch {
    return null;
  }
}

function parseLabels(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of text.split(",")) {
    const m = /^\s*([^:\s]+)\s*:\s*(\d+)\s*$/.exec(part);
    if (m) out[m[1]!] = Number(m[2]);
  }
  return out;
}

export function ExportsTab() {
  const sc = getScene() as Scene;
  const targets = [...Object.keys(sc.sprites || {}), ...Object.keys(sc.shapes || {})];
  const newName = useRef("");
  const newRef = useRef(targets[0] || "");
  return (
    <div>
      <div className="artsec"><span className="sec">Exports — SymbolClass linkage names GON can address</span></div>
      <p className="muted" style={sx("margin:0 0 10px;font-size:12.5px;line-height:1.6")}>
        Vanilla GON refers to symbols by these strings (e.g. <span className="mono">"rat.png"</span> → <span className="mono">Rat</span>). To extend a vanilla clip use the <span className="mono">_Append_&lt;Clip&gt;</span> convention (community-documented). You may export one sprite under several names.
      </p>
      {Object.entries(sc.exports || {}).map(([name, ref]) => (
        <div key={name} className="artrow">
          <span className="id">{name}</span>
          <span className="meta">→</span>
          <span className="mono" style={sx("font-size:12.5px")}>{String(ref)}</span>
          <div className="grow" />
          <button className="btn ghost sm" style={sx("color:var(--err)")} aria-label={`Remove export ${name}`} onClick={() => { delete sc.exports[name]; scheduleValidate(); bump(); }}>Remove</button>
        </div>
      ))}
      <div style={sx("display:flex;gap:8px;align-items:center;margin-top:8px")}>
        <input className="artinput mono" placeholder="linkage name (e.g. MyRat or myrat.png)" aria-label="new export linkage name" onInput={(e) => (newName.current = (e.target as HTMLInputElement).value)} />
        <select className="artinput" aria-label="export target" defaultValue={newRef.current} onChange={(e) => (newRef.current = e.target.value)}>
          {targets.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <button className="btn sm" onClick={() => { if (!newName.current || !newRef.current) return; sc.exports[newName.current] = newRef.current; scheduleValidate(); bump(); }}>+ Add export</button>
      </div>
    </div>
  );
}

export function JsonTab() {
  const rev = useStore(A, (a) => a.rev);
  const jsonText = useStore(A, (a) => a.jsonText);
  const jsonError = useStore(A, (a) => a.jsonError);
  const ta = useRef<HTMLTextAreaElement>(null);
  const sc = getScene();
  const text = sc ? JSON.stringify(sc, null, 2) : jsonText;
  return (
    <div>
      <div className="artsec">
        <span className="sec">Scene JSON — the whole source model (docs/art-preview-plan.md §2)</span>
        <button
          className="btn primary sm"
          onClick={() => {
            try {
              const obj = JSON.parse(ta.current ? ta.current.value : text) as Scene;
              setScene(obj);
              A.set({ jsonError: "" });
              scheduleValidate();
              bump();
              toast("JSON applied — validating");
            } catch (e) {
              A.set({ jsonError: String(e instanceof Error ? e.message : e) });
              bump();
            }
          }}
        >
          Apply
        </button>
      </div>
      {jsonError ? (
        <div className="finding error">
          <span className="mark">✕</span>
          <div>{jsonError}</div>
        </div>
      ) : null}
      <textarea key={rev} ref={ta} className="scenejson" spellCheck={false} aria-label="scene JSON" defaultValue={text} />
    </div>
  );
}
