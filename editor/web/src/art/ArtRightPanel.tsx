// Art-mode right panel: Preview | Findings | Build. The preview canvas is one persistent
// element (art-state.previewCanvas()) that PreviewPanel inserts into .pvcanvasbox on mount;
// unmounting the panel detaches it, which is what makes the renderer suspend (and re-mount
// resume) without touching the user's play intent.

import React, { useEffect, useRef } from "react";
import { useStore } from "../store.ts";
import { S, toast } from "../state.ts";
import { post } from "../api.ts";
import { A, getScene, bump, build, ensurePreview, getPreview, previewCanvas, pushSceneToPreview, setTarget, setShowGray, setRow, rampColor } from "./art-state.ts";
import { sx, FindingRow } from "./Bits.tsx";
import type { ArtRightTab, PrepareGateResponse } from "./types.ts";

export function ArtRightPanel() {
  const rightTab = useStore(A, (a) => a.rightTab);
  const mk = (id: ArtRightTab, text: string) => (
    <button className={"tab" + (rightTab === id ? " active" : "")} onClick={() => A.set({ rightTab: id })}>{text}</button>
  );
  let body: React.ReactNode;
  if (rightTab === "findings") body = <FindingsPanel />;
  else if (rightTab === "build") body = <BuildPanel />;
  else body = <PreviewPanel />;
  return (
    <div className="rightpanel">
      <div className="tabs">{mk("preview", "Preview")}{mk("findings", "Findings")}{mk("build", "Build")}</div>
      <div className="panelbody">{body}</div>
    </div>
  );
}

function FindingsPanel() {
  const list = useStore(A, (a) => a.findings);
  const hasScene = useStore(A, (a) => a.hasScene);
  if (!hasScene) return <div><p className="muted">Open a scene to see findings.</p></div>;
  const e = list.filter((f) => f.severity === "error").length;
  const w = list.filter((f) => f.severity === "warning").length;
  const level = e ? "err" : w ? "warn" : "ok";
  return (
    <div>
      <div>
        <div className={`summary ${level}`}>
          <div className="badge">{level === "ok" ? "✓" : "!"}</div>
          <div>
            <div className="t">{e ? `${e} error${e === 1 ? "" : "s"}` : w ? `${w} warning${w === 1 ? "" : "s"}` : "Scene is buildable"}</div>
            <div className="d">{`${e} errors · ${w} warnings · ${list.length - e - w} info`}</div>
          </div>
        </div>
        <div style={sx("margin-top:14px")}>{list.length ? list.map((f, i) => <FindingRow key={i} f={f} />) : <p className="dotok">No findings.</p>}</div>
      </div>
    </div>
  );
}

function histogramText(tags: { name: string }[]): string {
  const h: Record<string, number> = {};
  for (const t of tags) h[t.name] = (h[t.name] || 0) + 1;
  return Object.entries(h).map(([k, v]) => `${k}×${v}`).join(" ");
}

function BuildPanel() {
  const mod = useStore(S, (s) => s.mod);
  const r = useStore(A, (a) => a.buildResult);
  const ins = useStore(A, (a) => a.inspect);
  const abc = useStore(A, (a) => a.abc);
  const hasScene = useStore(A, (a) => a.hasScene);
  useStore(A, (a) => a.rev);
  const sc = getScene();
  return (
    <div>
      <div>
        <div className="sec" style={sx("margin-bottom:8px")}>Emit</div>
        <div className="card plain">
          <div style={sx("font-size:12.5px;color:var(--ink2);line-height:1.6;margin-bottom:8px")}>Every vanilla file carries a Flash-generated DoABC, but SymbolClass alone binds the names: build with none. The SWF gate (fix spec §8) checks an _Append_AbilityIcon donor boots the game: write a variant here, then run `npm run test:swfgate -- &lt;variant&gt;` from editor/.</div>
          <div className="pvrow">
            <label><input type="radio" name="abcmode" checked={abc === "none"} onChange={() => A.set({ abc: "none" })} />no DoABC</label>
            <label><input type="radio" name="abcmode" checked={abc === "stub"} onChange={() => A.set({ abc: "stub" })} />stub DoABC (Flash-faithful linkage classes)</label>
          </div>
          <div style={sx("display:flex;gap:8px;margin-top:10px;flex-wrap:wrap")}>
            <button className="btn primary sm" disabled={!hasScene} onClick={() => build(false)}>Build SWF</button>
            <button className="btn sm" disabled={!hasScene} onClick={() => build(true)}>Dry run</button>
            <button
              className="btn ghost sm"
              title="Writes mods/swf-gate/swfs/gate.swf + swflist.gon.append (flat variant); run it with npm run test:swfgate -- flat"
              onClick={async () => {
                const g = await post<"/api/art/prepare-swf-gate", PrepareGateResponse>("/api/art/prepare-swf-gate", { variant: "flat" });
                toast(g.ok ? `gate files written: ${(g.written || []).join(", ")} — next: ${g.next}` : `failed: ${g.error}`);
              }}
            >
              Prepare SWF gate
            </button>
          </div>
        </div>
        {!r && !ins ? (
          <div className="card plain" style={sx("color:var(--ink2);font-size:12.5px;line-height:1.6")}>
            <span className="muted">Nothing built yet. </span>
            {sc ? "Click Build SWF to emit mods/" + mod + "/swfs/" + (sc.name || "<name>") + ".swf (self-checked with the verification reader) and append it to swflist.gon.append." : "Open a scene, then build it."}
          </div>
        ) : null}
        {r ? (
          <div>
            <div className="sec" style={sx("margin:14px 0 8px")}>{r.ok ? (r.dryRun ? "Dry run" : "Built") : "Build failed"}</div>
            <div className={`summary ${r.ok ? "ok" : "err"}`}>
              <div className="badge">{r.ok ? "✓" : "✕"}</div>
              <div>
                <div className="t">{r.ok ? `${r.bytes} bytes · DoABC ${r.abc}` : r.error || "error"}</div>
                <div className="d">{r.swfPath || ""}</div>
              </div>
            </div>
            {r.report ? (
              <div className="card" style={sx("margin-top:10px")}>
                <div className="kv">
                  <span className="k">frames</span><span>{String(r.report.frameCount)}</span>
                  <span className="k">characters</span><span>{String((r.report.characters || []).length)}</span>
                  <span className="k">exports</span><span>{(r.report.exports || []).map((e) => `${e.name}→#${e.id}`).join(", ") || "(none)"}</span>
                  <span className="k">tags</span><span>{histogramText(r.report.tags || [])}</span>
                </div>
              </div>
            ) : null}
            {r.swflist && r.swflist.ok ? (
              <div className="card" style={sx("margin-top:10px")}>
                <div className="sec" style={sx("margin-bottom:6px")}>{r.swflist.path}</div>
                <pre className="mergecode">{r.swflist.text}</pre>
              </div>
            ) : null}
            {(r.findings || []).length ? <div style={sx("margin-top:10px")}>{(r.findings || []).map((f, i) => <FindingRow key={i} f={f} />)}</div> : null}
          </div>
        ) : null}
        {ins ? (
          <div>
            <div className="sec" style={sx("margin:14px 0 8px")}>{`Inspect · ${ins.relPath}`}</div>
            {ins.ok && ins.header ? (
              <div className="card">
                <div className="kv">
                  <span className="k">header</span><span className="mono" style={sx("font-size:12px")}>{`${ins.header.signature} v${ins.header.version} · ${ins.bytes} B · ${ins.header.frameRate} fps · ${ins.header.frameCount} frames`}</span>
                  <span className="k">DoABC</span><span>{String(ins.doAbc)}</span>
                  <span className="k">exports</span><span>{(ins.exports || []).map((e) => `${e.name}→#${e.id}`).join(", ") || "(none)"}</span>
                  <span className="k">labels</span><span>{(ins.labels || []).join(", ") || "(none)"}</span>
                  <span className="k">tags</span><span>{Object.entries(ins.histogram || {}).map(([k, v]) => `${k}×${v}`).join(" ")}</span>
                </div>
              </div>
            ) : (
              <div className="finding error"><span className="mark">✕</span><div>{ins.error}</div></div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PreviewPanel() {
  const hasScene = useStore(A, (a) => a.hasScene);
  const target = useStore(A, (a) => a.target);
  const backend = useStore(A, (a) => a.backend);
  const pvStatus = useStore(A, (a) => a.pvStatus);
  useStore(A, (a) => a.frames); // the target list (frame counts) tracks the pushed scene
  useStore(A, (a) => a.rev);
  const box = useRef<HTMLDivElement>(null);
  // mount: the canvas element is persistent; the renderer is created once
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const canvas = previewCanvas();
    el.insertBefore(canvas, el.firstChild);
    const p = ensurePreview();
    p.resize();
    pushSceneToPreview();
    p.render();
    return () => {
      if (canvas.parentNode === el) el.removeChild(canvas);
    };
  }, []);
  const pv = getPreview();
  const targets = pv && hasScene ? pv.getTargets() : [];
  return (
    <div className="pvwrap">
      {!hasScene ? (
        <p className="muted" style={sx("margin:0")}>Open a scene to preview it as the engine draws it: 16-level gray → palette.png row.</p>
      ) : (
        <div className="pvrow">
          <label htmlFor="pv-target">target</label>
          <select id="pv-target" className="artinput" value={target} onChange={(e) => setTarget(e.target.value)}>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>{`${t.id}${t.kind === "sprite" ? ` (${t.frames}f)` : t.kind === "stage" ? " (main timeline)" : ""}`}</option>
            ))}
          </select>
          <div className="grow" />
          <button className="btn ghost sm" onClick={() => { const p = getPreview(); if (p) { p.setZoom("fit"); p.render(); } }}>Fit</button>
        </div>
      )}
      <div className="pvcanvasbox" ref={box}>
        <span className="pvstatus">{`${backend || "…"}${pvStatus ? " · " + pvStatus : ""}`}</span>
      </div>
      <Transport />
      <Scrubber />
      <LabelChips />
      <PaletteRow />
    </div>
  );
}

function Transport() {
  const playing = useStore(A, (a) => a.playing);
  const frame = useStore(A, (a) => a.frame);
  const frames = useStore(A, (a) => a.frames);
  const loop = useStore(A, (a) => a.loop);
  const play = () => {
    const p = ensurePreview();
    if (p.isPlaying()) {
      p.pause();
      A.set({ playing: false });
    } else {
      p.play();
      A.set({ playing: true });
    }
  };
  return (
    <div className="transport">
      <button className="btn ghost sm" aria-label="First frame" onClick={() => { const p = ensurePreview(); p.setFrame(0); A.set({ frame: 0 }); p.render(); }}>|◀</button>
      <button className="btn ghost sm" aria-label="Previous frame" onClick={() => { const p = ensurePreview(); p.step(-1); A.set({ frame: p.getFrame() }); p.render(); }}>◀</button>
      <button className="btn primary sm" aria-label={playing ? "Pause" : "Play"} style={sx("min-width:64px;justify-content:center")} onClick={play}>{playing ? "Pause" : "Play"}</button>
      <button className="btn ghost sm" aria-label="Next frame" onClick={() => { const p = ensurePreview(); p.step(1); A.set({ frame: p.getFrame() }); p.render(); }}>▶</button>
      <span className="frame">{`${frame + 1} / ${frames}`}</span>
      <div className="grow" />
      <label style={sx("display:inline-flex;gap:6px;align-items:center;font-size:12px;color:var(--ink2)")}>
        <input type="checkbox" checked={loop} onChange={(e) => { A.set({ loop: e.target.checked }); ensurePreview().setLoop(e.target.checked); }} />
        loop
      </label>
    </div>
  );
}

function Scrubber() {
  const frame = useStore(A, (a) => a.frame);
  const frames = useStore(A, (a) => a.frames);
  const hasScene = useStore(A, (a) => a.hasScene);
  const range = useRef<HTMLInputElement>(null);
  // The range is driven imperatively (value/max) and listened to natively, so a scripted
  // `r.value = n; dispatchEvent(new Event("input"))` works exactly as it did with VanJS.
  useEffect(() => {
    const el = range.current;
    if (!el) return;
    const h = () => {
      const f = Number(el.value);
      const p = ensurePreview();
      p.pause();
      A.set({ playing: false });
      p.setFrame(f);
      A.set({ frame: f });
      p.render();
    };
    el.addEventListener("input", h);
    return () => el.removeEventListener("input", h);
  }, []);
  useEffect(() => {
    const el = range.current;
    if (!el) return;
    el.max = String(Math.max(0, frames - 1));
    el.value = String(frame);
  }, [frame, frames]);
  const n = Math.max(1, frames);
  const pv = getPreview();
  const labels = pv && hasScene ? pv.getLabels() : [];
  return (
    <div className="scrub">
      <input ref={range} type="range" min={0} step={1} defaultValue={0} aria-label="Frame scrubber" />
      <div className="ticks">
        {labels.map((l, i) => <span key={i} title={`${l.label} @ ${l.frame}`} style={{ left: `${n > 1 ? (l.frame / (n - 1)) * 100 : 0}%` }} />)}
      </div>
    </div>
  );
}

function LabelChips() {
  const hasScene = useStore(A, (a) => a.hasScene);
  useStore(A, (a) => a.frames);
  useStore(A, (a) => a.rev);
  const pv = getPreview();
  const labels = pv && hasScene ? pv.getLabels() : [];
  if (!labels.length) return null;
  return (
    <div className="labelchips">
      {labels.map((l, i) => (
        <button key={i} className="btn ghost sm" title={`go to frame ${l.frame}`} onClick={() => { const p = ensurePreview(); p.gotoLabel(l.label); A.set({ frame: p.getFrame() }); p.render(); }}>{`${l.label} · ${l.frame}`}</button>
      ))}
    </div>
  );
}

function PaletteRow() {
  const pal = useStore(A, (a) => a.palette);
  const row = useStore(A, (a) => a.row);
  const showGray = useStore(A, (a) => a.showGray);
  useStore(A, (a) => a.rev);
  const rowInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = rowInput.current;
    if (!el) return;
    const h = () => setRow(Number(el.value));
    el.addEventListener("change", h);
    return () => el.removeEventListener("change", h);
  }, []);
  useEffect(() => {
    if (rowInput.current) rowInput.current.value = String(row);
  }, [row]);
  return (
    <div className="card plain" style={sx("margin:0")}>
      <div style={sx("display:flex;align-items:center;gap:8px;margin-bottom:8px")}>
        <span className="sec" style={sx("flex:1")}>Palette row</span>
        <label htmlFor="pv-row" className="muted" style={sx("font-size:12px")}>palette N</label>
        <input ref={rowInput} id="pv-row" className="artinput num" type="number" min={0} max={255} defaultValue={row} />
        <button className="btn ghost sm" onClick={() => A.set({ palOpen: true })}>Browse rows…</button>
      </div>
      <div className="ramp big" role="list" aria-label="16-colour ramp of the selected palette row">
        {Array.from({ length: 16 }, (_, i) => <span key={i} role="listitem" title={`gray:${i}`} style={{ background: rampColor(i) }} />)}
      </div>
      <div style={sx("display:flex;gap:10px;align-items:center;margin-top:8px;font-size:12px;color:var(--muted);flex-wrap:wrap")}>
        {pal && pal.ok ? (
          <span>{`${pal.source} · ${pal.rows.length} rows${pal.hints && pal.hints[row] ? " · " + pal.hints[row] : ""}`}</span>
        ) : (
          <span className="warn">{pal ? `${pal.error || "palette unavailable"} — identity ramp shown. ${pal.hint || ""}` : "loading palette…"}</span>
        )}
        <label style={sx("display:inline-flex;gap:6px;align-items:center")}>
          <input type="checkbox" checked={showGray} onChange={(e) => { ensurePreview(); setShowGray(e.target.checked); }} />
          show raw gray
        </label>
        <label style={sx("display:inline-flex;gap:6px;align-items:center")}>
          background
          <select
            className="artinput"
            aria-label="preview background"
            defaultValue="checker"
            onChange={(e) => {
              const v = e.target.value;
              const p = ensurePreview();
              const sc = getScene();
              p.setBackground(v === "stage" ? (sc && sc.stage && sc.stage.background) || "#ffccff" : v === "none" ? null : v);
              p.render();
            }}
          >
            <option value="checker">checker</option>
            <option value="stage">stage colour</option>
            <option value="#000000">black</option>
            <option value="#ffffff">white</option>
          </select>
        </label>
      </div>
    </div>
  );
}

void bump;
