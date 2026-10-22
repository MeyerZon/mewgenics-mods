// Art-mode right panel: Preview | Findings | Build | Ruffle. The preview canvas is one persistent
// element (art-state.previewCanvas()) that PreviewPanel inserts into .pvcanvasbox on mount;
// unmounting the panel detaches it, which is what makes the renderer suspend (and re-mount
// resume) without touching the user's play intent. The View options card (raw gray, background,
// ghost cat) and the transport's loop are per-viewer prefs (prefs.ts) applied on every mount.

import React, { useEffect, useRef, useState } from "react";
import { useStore, useStoreShallow } from "../store.ts";
import { S, toast } from "../state.ts";
import { post } from "../api.ts";
import {
  A,
  build,
  ensurePreview,
  getPreview,
  getScene,
  previewCanvas,
  ghostLayer,
  setGhostCat,
  pushSceneToPreview,
  setTarget,
  setShowGray,
  setRow,
  rampColor,
  setArtRightTab,
  setAbc,
  setLoop,
  togglePlay,
  goFrame,
  stepFrame,
  scrubTo,
  gotoLabel,
  fitPreview,
  openPalette,
  previewBackground,
  setPreviewBackground,
  type PreviewBackground,
} from "./art-state.ts";
import { hasGhostRig } from "../../../src/core/art/ghost-cat.ts";
import { sx, FindingRows } from "./Bits.tsx";
import { Tabs, Checkbox, Select, Summary } from "../components/ui.tsx";
import { usePref } from "../hooks/usePref.ts";
import type { ArtRightTab, PrepareGateResponse } from "./types.ts";
import { RufflePanel } from "./RufflePanel.tsx";
import { TOUR } from "../tour-anchors.ts";

const RIGHT_TABS: { id: ArtRightTab; label: string; tour?: string }[] = [
  { id: "preview", label: "Preview", tour: TOUR.artPreview },
  { id: "findings", label: "Findings" },
  { id: "build", label: "Build", tour: TOUR.artBuild },
  { id: "ruffle", label: "Ruffle" },
];

export function ArtRightPanel() {
  const rightTab = useStore(A, (a) => a.rightTab);
  let body: React.ReactNode;
  if (rightTab === "findings") body = <FindingsPanel />;
  else if (rightTab === "build") body = <BuildPanel />;
  else if (rightTab === "ruffle") body = <RufflePanel />;
  else body = <PreviewPanel />;
  return (
    <div className="rightpanel">
      <Tabs items={RIGHT_TABS} value={rightTab} onChange={setArtRightTab} aria-label="Art right panel" />
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
      <Summary
        level={level}
        title={e ? `${e} error${e === 1 ? "" : "s"}` : w ? `${w} warning${w === 1 ? "" : "s"}` : "Scene is buildable"}
        detail={`${e} errors · ${w} warnings · ${list.length - e - w} info`}
      />
      <div style={sx("margin-top:14px")}>{list.length ? <FindingRows list={list} /> : <p className="dotok">No findings.</p>}</div>
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
  const { r, ins, abc, hasScene, name } = useStoreShallow(A, (a) => ({ r: a.buildResult, ins: a.inspect, abc: a.abc, hasScene: a.hasScene, name: a.sceneName }));
  return (
    <div>
      <div className="sec" style={sx("margin-bottom:8px")}>Emit</div>
      <div className="card plain">
        <div style={sx("font-size:12.5px;color:var(--ink2);line-height:1.6;margin-bottom:8px")}>SymbolClass binds the export names; the DoABC stub is optional.</div>
        <div className="pvrow">
          <label><input type="radio" name="abcmode" checked={abc === "none"} onChange={() => setAbc("none")} />no DoABC</label>
          <label><input type="radio" name="abcmode" checked={abc === "stub"} onChange={() => setAbc("stub")} />stub DoABC (Flash-faithful linkage classes)</label>
        </div>
        <div style={sx("display:flex;gap:8px;margin-top:10px;flex-wrap:wrap")}>
          <button className="btn primary sm" disabled={!hasScene} onClick={() => void build(false)}>Build SWF</button>
          <button className="btn sm" disabled={!hasScene} onClick={() => void build(true)}>Dry run</button>
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
          {hasScene ? `Click Build SWF to emit mods/${mod}/swfs/${name || "<name>"}.swf (self-checked with the verification reader) and append it to swflist.gon.append.` : "Open a scene, then build it."}
        </div>
      ) : null}
      {r ? (
        <div>
          <div className="sec" style={sx("margin:14px 0 8px")}>{r.ok ? (r.dryRun ? "Dry run" : "Built") : "Build failed"}</div>
          <Summary level={r.ok ? "ok" : "err"} badge={r.ok ? "✓" : "✕"} title={r.ok ? `${r.bytes} bytes · DoABC ${r.abc}` : r.error || "error"} detail={r.swfPath || ""} />
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
          {(r.findings || []).length ? <div style={sx("margin-top:10px")}><FindingRows list={r.findings || []} /></div> : null}
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
              {(ins.findings || []).length ? <div style={sx("margin-top:10px")}><FindingRows list={ins.findings || []} /></div> : <p className="dotok" style={sx("margin:8px 0 0")}>The game's loader accepts every tag.</p>}
            </div>
          ) : (
            <div className="finding error"><span className="mark">✕</span><div>{ins.error}</div></div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function PreviewPanel() {
  const { hasScene, target, backend, pvStatus } = useStoreShallow(A, (a) => ({ hasScene: a.hasScene, target: a.target, backend: a.backend, pvStatus: a.pvStatus }));
  useStore(A, (a) => a.pvScene); // the target list tracks the pushed scene
  const box = useRef<HTMLDivElement>(null);
  // mount: the canvas element is persistent; the renderer is created once
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const canvas = previewCanvas();
    el.insertBefore(canvas, el.firstChild);
    const ghosts = ghostLayer();
    el.insertBefore(ghosts, canvas.nextSibling);
    const p = ensurePreview();
    p.resize();
    pushSceneToPreview();
    p.render();
    return () => {
      if (canvas.parentNode === el) el.removeChild(canvas);
      if (ghosts.parentNode === el) el.removeChild(ghosts);
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
          <button className="btn ghost sm" onClick={fitPreview}>Fit</button>
        </div>
      )}
      <div className="pvcanvasbox" ref={box}>
        <span className="pvstatus">{`${backend || "…"}${pvStatus ? " · " + pvStatus : ""}`}</span>
      </div>
      <Transport />
      <Scrubber />
      <LabelChips />
      <ViewOptions />
      <PaletteRow />
    </div>
  );
}

const BACKGROUNDS: { value: PreviewBackground; label: string }[] = [
  { value: "checker", label: "checker" },
  { value: "stage", label: "stage colour" },
  { value: "#000000", label: "black" },
  { value: "#ffffff", label: "white" },
];

/** One card of per-viewer view options (prefs.ts): raw gray, the canvas background, the ghost cat on a parts: game rig. */
function ViewOptions() {
  const { showGray, ghostCat, ghostSource, hasScene, target } = useStoreShallow(A, (a) => ({ showGray: a.showGray, ghostCat: a.ghostCat, ghostSource: a.ghostSource, hasScene: a.hasScene, target: a.target }));
  useStore(A, (a) => a.pvScene);
  usePref<string>("art.background", "checker"); // re-render when the pick changes
  const background = previewBackground();
  const sc = getScene();
  const ghostable = !!sc && hasScene && hasGhostRig(sc, target);
  return (
    <div className="card plain view-options" style={sx("margin:0")}>
      <div className="sec" style={sx("margin-bottom:8px")}>View options</div>
      <div className="pvrow">
        <Checkbox checked={showGray} onChange={(v) => { ensurePreview(); setShowGray(v); }} title="Show the authored 16-level gray instead of the palette row's colours">
          show raw gray
        </Checkbox>
        <label>
          background
          <Select aria-label="preview background" value={background} onChange={setPreviewBackground} options={BACKGROUNDS} />
        </label>
        {ghostable ? (
          <Checkbox
            aria-label="ghost cat"
            checked={ghostCat}
            onChange={setGhostCat}
            title={`Preview only: grey placeholders (${ghostSource === "catparts.swf" ? "outlines from the game's catparts.swf" : "built-in silhouettes; extract the game files for the real outlines"}) where the game draws the cat's own parts into the empty slots. Never in the SWF.`}
          >
            ghost cat
          </Checkbox>
        ) : null}
      </div>
    </div>
  );
}

function Transport() {
  const { playing, frame, frames, loop } = useStoreShallow(A, (a) => ({ playing: a.playing, frame: a.frame, frames: a.frames, loop: a.loop }));
  return (
    <div className="transport">
      <button className="btn ghost sm" aria-label="First frame" onClick={() => goFrame(0)}>|◀</button>
      <button className="btn ghost sm" aria-label="Previous frame" onClick={() => stepFrame(-1)}>◀</button>
      <button className="btn primary sm" aria-label={playing ? "Pause" : "Play"} style={sx("min-width:64px;justify-content:center")} onClick={togglePlay}>{playing ? "Pause" : "Play"}</button>
      <button className="btn ghost sm" aria-label="Next frame" onClick={() => stepFrame(1)}>▶</button>
      <span className="frame">{`${frame + 1} / ${frames}`}</span>
      <div className="grow" />
      <Checkbox checked={loop} onChange={setLoop} className="loop" title="Loop playback (remembered in this browser)">
        loop
      </Checkbox>
    </div>
  );
}

function Scrubber() {
  const { frame, frames, hasScene } = useStoreShallow(A, (a) => ({ frame: a.frame, frames: a.frames, hasScene: a.hasScene }));
  useStore(A, (a) => a.pvScene);
  const range = useRef<HTMLInputElement>(null);
  // The range is driven imperatively (value/max) and listened to natively, so a scripted
  // `r.value = n; dispatchEvent(new Event("input"))` works exactly as it did with VanJS.
  useEffect(() => {
    const el = range.current;
    if (!el) return;
    const h = () => scrubTo(Number(el.value));
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
      <input ref={range} type="range" min={0} step={1} aria-label="Frame scrubber" />
      <div className="ticks">
        {labels.map((l) => <span key={`${l.label}@${l.frame}`} title={`${l.label} @ ${l.frame}`} style={{ left: `${n > 1 ? (l.frame / (n - 1)) * 100 : 0}%` }} />)}
      </div>
    </div>
  );
}

function LabelChips() {
  const hasScene = useStore(A, (a) => a.hasScene);
  useStore(A, (a) => a.pvScene);
  useStore(A, (a) => a.target);
  const pv = getPreview();
  const labels = pv && hasScene ? pv.getLabels() : [];
  if (!labels.length) return null;
  return (
    <div className="labelchips">
      {labels.map((l) => (
        <button key={`${l.label}@${l.frame}`} className="btn ghost sm" title={`go to frame ${l.frame}`} onClick={() => gotoLabel(l.label)}>{`${l.label} · ${l.frame}`}</button>
      ))}
    </div>
  );
}

function PaletteRow() {
  const { pal, row } = useStoreShallow(A, (a) => ({ pal: a.palette, row: a.row }));
  useStore(A, (a) => a.showGray); // the ramp swatches follow the raw-gray toggle
  // the number box shows A.row; a half-typed value lives here until it parses (blur / Enter drop it)
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (v: string) => {
    const n = Number(v);
    if (v.trim() !== "" && Number.isFinite(n)) setRow(n);
  };
  return (
    <div className="card plain" style={sx("margin:0")}>
      <div style={sx("display:flex;align-items:center;gap:8px;margin-bottom:8px")}>
        <span className="sec" style={sx("flex:1")}>Palette row</span>
        <label htmlFor="pv-row" className="muted" style={sx("font-size:12px")}>palette N</label>
        <input
          id="pv-row"
          className="artinput num"
          type="number"
          min={0}
          max={255}
          value={draft ?? String(row)}
          onChange={(e) => { setDraft(e.target.value); commit(e.target.value); }}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => { if (e.key === "Enter") setDraft(null); }}
        />
        <button className="btn ghost sm" onClick={openPalette}>Browse rows…</button>
      </div>
      <div className="ramp big" role="list" aria-label="16-colour ramp of the selected palette row">
        {Array.from({ length: 16 }, (_, level) => <span key={level} role="listitem" title={`gray:${level}`} style={{ background: rampColor(level) }} />)}
      </div>
      <div style={sx("display:flex;gap:10px;align-items:center;margin-top:8px;font-size:12px;color:var(--muted);flex-wrap:wrap")}>
        {pal && pal.ok ? (
          <span>{`${pal.source} · ${pal.rows.length} rows${pal.hints && pal.hints[row] ? " · " + pal.hints[row] : ""}`}</span>
        ) : (
          <span className="warn">{pal ? `${pal.error || "palette unavailable"} — identity ramp shown. ${pal.hint || ""}` : "loading palette…"}</span>
        )}
      </div>
      <p className="muted" style={sx("margin:6px 0 0;font-size:11.5px")}>Browsing rows never marks the scene unsaved; the row is written on the next Save.</p>
    </div>
  );
}
