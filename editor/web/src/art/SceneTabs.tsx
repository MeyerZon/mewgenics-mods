// The Shapes / Sprites / Exports / JSON sub-tabs of the Art panel. They edit the scene in
// place and call scheduleValidate() + bump() exactly like art-ui.mjs did.

import React, { useRef } from "react";
import { useStore } from "../store.ts";
import { toast } from "../state.ts";
import { A, getScene, setScene, bump, scheduleValidate, setTarget, setShowGray, rampColor } from "./art-state.ts";
import { sx, Ramp, CommitInput } from "./Bits.tsx";
import { DropZone } from "./DropZone.tsx";
import { shapeGrayUsage, parseFill } from "../../../src/core/art/scene.mjs";
import { bakeSprite, type BakedSprite } from "../../../src/core/art/timeline.mjs";
import type { Scene, SceneSprite } from "./types.ts";

export function ShapesTab() {
  const showGray = useStore(A, (a) => a.showGray);
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
          <div key={id} className="artrow">
            <span className="id">{id}</span>
            <Ramp used={use.levels} />
            <span className="meta">{`${np} path${np === 1 ? "" : "s"}${sh.source ? " · " + sh.source : ""}`}</span>
            {use.passthrough ? <span className="pill warn chip" title="non-gray fills are NOT palette-remapped by the engine">{`${use.passthrough} passthrough`}</span> : null}
            {use.bitmaps ? <span className="pill muted chip">{`${use.bitmaps} bitmap`}</span> : null}
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
            <button className="btn ghost sm" style={sx("color:var(--err)")} aria-label={`Delete shape ${id}`} onClick={() => { delete sc.shapes[id]; scheduleValidate(); bump(); }}>Delete</button>
          </div>
        );
      })}
      {ids.length ? null : (
        <div className="card plain" style={sx("padding:16px;color:var(--ink2)")}>
          <div style={sx("font-weight:700;color:var(--ink);margin-bottom:4px")}>No shapes yet</div>
          <div style={sx("font-size:12.5px;line-height:1.6")}>Import an SVG below (each SVG becomes one shape). Gray fills become 16-level <span className="mono">gray:0–15</span> the engine recolors through a palette row; non-gray colours pass through and are flagged. Once a shape exists, wrap it in a sprite and Build the SWF.</div>
        </div>
      )}
      <div style={sx("margin-top:12px")}><DropZone text="Drop an SVG to add a shape. Each SVG becomes one shape (many paths)." /></div>
      {ids.length ? <PathEditor /> : null}
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
        const selValue = f.kind === "gray" ? `gray:${f.level}` : f.kind === "none" ? "none" : "keep";
        const d = String(pth.d);
        return (
          <div key={i} className="artrow">
            <span className="id">{`#${i}`}</span>
            <span style={{ width: "18px", height: "18px", borderRadius: "4px", background: f.kind === "gray" ? rampColor(f.level) : f.kind === "rgba" ? String(pth.fill) : "transparent", border: "1px solid var(--line2)" }} />
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
