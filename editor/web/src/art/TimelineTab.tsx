// The Timeline tab: author a sprite's animation — a frame ruler with label pills, one row per layer (key marks,
// hold / tween spans), a key inspector, and the timeline-edit.ts operations. Clicking a cell scrubs the preview.
// Edits change the open scene in memory (Save writes it), like every other Art tab.

import React, { useEffect, useState } from "react";
import { useStore } from "../store.ts";
import { toast } from "../state.ts";
import { A, getScene, bump, scheduleValidate, setTarget, ensurePreview, scrubTo } from "./art-state.ts";
import { sx, CommitInput } from "./Bits.tsx";
import { keyAt, setKey, removeKey, setLabel, removeLabel, insertFrames, deleteFrames, moveLayer, type EditResult } from "../../../src/core/art/timeline-edit.ts";
import type { Scene, SceneKey } from "./types.ts";

const NUM_FIELDS: Array<[keyof SceneKey, string]> = [["x", "x"], ["y", "y"], ["sx", "sx"], ["sy", "sy"], ["rot", "rot"], ["alpha", "alpha"]];

const seek = scrubTo;

export function TimelineTab() {
  useStore(A, (a) => a.rev);
  const frame = useStore(A, (a) => a.frame);
  const target = useStore(A, (a) => a.target);
  const [layerSel, setLayerSel] = useState(0);
  const [labelName, setLabelName] = useState("");
  const sc = getScene() as Scene;
  const ids = Object.keys(sc.sprites || {});
  const sid = ids.includes(target) ? target : ids[0];
  useEffect(() => {
    if (sid && target !== sid) setTarget(sid);
  }, [sid, target]);
  if (!sid) return <p className="muted" style={sx("margin-top:14px")}>No sprites yet — add one in the Sprites tab, then animate it here.</p>;
  const sp = sc.sprites[sid]!;
  const f = Math.max(0, Math.min(sp.frames - 1, frame));
  const li = Math.min(layerSel, Math.max(0, sp.layers.length - 1));
  const layer = sp.layers[li];
  const key = layer ? keyAt(sp, li, f) : null;
  const apply = (r: EditResult) => {
    const err = r.findings.find((x) => x.severity === "error");
    if (err) return toast(err.message);
    sc.sprites[sid] = r.sprite;
    for (const w of r.findings) toast(w.message);
    scheduleValidate();
    bump();
    const p = ensurePreview();
    if (A.get().frame >= r.sprite.frames) seek(r.sprite.frames - 1);
    else p.render();
  };
  const order = sp.layers.map((l, i) => ({ l, i })).sort((a, b) => b.l.depth - a.l.depth); // front layer on top
  const labelsAt = new Map<number, string[]>();
  for (const [name, lf] of Object.entries(sp.labels || {})) labelsAt.set(lf, [...(labelsAt.get(lf) || []), name]);
  return (
    <div className="timeline">
      <div className="artsec">
        <span className="sec">{`Timeline of ${sid} — ${sp.frames} frames, ${sp.layers.length} layers`}</span>
        {ids.length > 1 ? (
          <select className="artinput" aria-label="timeline sprite" value={sid} onChange={(e) => setTarget(e.target.value)}>
            {ids.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        ) : null}
      </div>
      <div className="tl-labels">
        {Object.entries(sp.labels || {}).sort((a, b) => a[1] - b[1]).map(([name, lf]) => (
          <span key={name} className="tl-label pill muted chip" title={`frame ${lf}`}>
            <button className="linkbtn" onClick={() => seek(lf)}>{`${name} @${lf}`}</button>
            <button className="linkbtn" aria-label={`Remove label ${name}`} onClick={() => apply(removeLabel(sp, name))}>×</button>
          </span>
        ))}
      </div>
      <div className="tl-grid" style={{ gridTemplateColumns: `120px repeat(${sp.frames}, minmax(14px, 1fr))` }}>
        <span className="tl-name muted">frame</span>
        {Array.from({ length: sp.frames }, (_, fr) => (
          <button key={fr} className={"tl-ruler" + (fr === f ? " sel" : "") + (labelsAt.has(fr) ? " lab" : "")} title={labelsAt.has(fr) ? labelsAt.get(fr)!.join(", ") : `frame ${fr}`} onClick={() => seek(fr)}>{fr % 5 === 0 ? String(fr) : ""}</button>
        ))}
        {order.map(({ l, i: rowLi }) => {
          const name = l.name || `depth ${l.depth}`;
          const ks = l.keys.slice().sort((a, b) => a.frame - b.frame);
          return (
            <div key={rowLi} className={"tl-row" + (rowLi === li ? " on" : "")} style={{ display: "contents" }}>
              <button type="button" className="tl-name mono" title={`select layer ${name}`} onClick={() => setLayerSel(rowLi)}>{name}</button>
              {Array.from({ length: sp.frames }, (_, cf) => {
                const k = ks.find((q) => q.frame === cf);
                const prev = ks.filter((q) => q.frame <= cf).pop();
                const shown = !!prev && prev.ref !== null && prev.ref !== undefined;
                const tween = shown && prev!.tween === "linear" && ks.some((q) => q.frame > prev!.frame);
                const cls = "tl-cell" + (k ? (k.ref === null ? " key empty" : " key") : "") + (shown ? (tween ? " tween" : " hold") : "") + (cf === f && rowLi === li ? " sel" : "");
                return (
                  <button
                    key={cf}
                    className={cls}
                    aria-label={`layer ${name}, frame ${cf}`}
                    title={k ? `key at ${cf}: ${k.ref ?? "(removed)"}` : `${name} frame ${cf}`}
                    onClick={() => {
                      setLayerSel(rowLi);
                      seek(cf);
                    }}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="card plain tl-inspector">
        <div style={sx("display:flex;gap:8px;align-items:center;flex-wrap:wrap")}>
          <span className="mono" style={sx("font-weight:700")}>{layer ? `${layer.name || `depth ${layer.depth}`} @ frame ${f}` : "no layer"}</span>
          <button className="btn ghost sm" disabled={!layer || !!key} onClick={() => apply(setKey(sp, li, f, {}))}>Add key</button>
          <button className="btn ghost sm" disabled={!key} onClick={() => apply(removeKey(sp, li, f))}>Delete key</button>
          <button className="btn ghost sm" onClick={() => apply(insertFrames(sp, f, 1))}>Insert frame</button>
          <button className="btn ghost sm" disabled={sp.frames <= 1} onClick={() => apply(deleteFrames(sp, f, 1))}>Delete frame</button>
          <button className="btn ghost sm" disabled={!layer} onClick={() => apply(moveLayer(sp, li, 1))}>Layer up</button>
          <button className="btn ghost sm" disabled={!layer} onClick={() => apply(moveLayer(sp, li, -1))}>Layer down</button>
        </div>
        {key ? (
          <div style={sx("display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px")} key={`${sid}:${li}:${f}:${A.get().rev}`}>
            <label className="muted" style={sx("font-size:12px;display:inline-flex;gap:4px;align-items:center")}>
              ref
              <select className="artinput" aria-label="key ref" value={key.ref ?? ""} onChange={(e) => apply(setKey(sp, li, f, { ref: e.target.value || null }))}>
                <option value="">(remove)</option>
                {Object.keys(sc.shapes || {}).map((s) => <option key={s} value={s}>{s}</option>)}
                {ids.filter((s) => s !== sid).map((s) => <option key={s} value={s}>{s + " (sprite)"}</option>)}
              </select>
            </label>
            {NUM_FIELDS.map(([field, label]) => (
              <label key={field} className="muted" style={sx("font-size:12px;display:inline-flex;gap:4px;align-items:center")}>
                {label}
                <CommitInput
                  className="artinput num"
                  type="number"
                  step="any"
                  aria-label={`key ${label}`}
                  initial={key[field] === undefined ? "" : String(key[field])}
                  onCommit={(v) => {
                    const n = Number(v);
                    if (v.trim() === "" || !Number.isFinite(n)) return;
                    apply(setKey(sp, li, f, { [field]: n } as Partial<SceneKey>));
                  }}
                />
              </label>
            ))}
            <label className="muted" style={sx("font-size:12px;display:inline-flex;gap:4px;align-items:center")}>
              to next
              <select className="artinput" aria-label="key tween" value={key.tween || "hold"} onChange={(e) => apply(setKey(sp, li, f, { tween: e.target.value as "hold" | "linear" }))}>
                <option value="hold">hold</option>
                <option value="linear">tween</option>
              </select>
            </label>
          </div>
        ) : layer ? <p className="muted" style={sx("font-size:12px;margin:8px 0 0")}>No key here: Add key starts one from the pose shown at this frame.</p> : null}
        <div style={sx("display:flex;gap:8px;align-items:center;margin-top:8px")}>
          <input className="artinput mono" aria-label="label name" placeholder="label (e.g. attack)" value={labelName} onChange={(e) => setLabelName(e.target.value)} />
          <button className="btn ghost sm" disabled={!labelName} onClick={() => { apply(setLabel(sp, labelName, f)); setLabelName(""); }}>Add label</button>
          <span className="muted" style={sx("font-size:11.5px")}>GON plays a character's clip by frame label (idle, attack, …).</span>
        </div>
      </div>
    </div>
  );
}
