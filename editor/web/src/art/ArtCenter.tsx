// Art-mode center: the scene tab bar, the authoring panel (Overview / Shapes / Sprites / Timeline / Rig / VectorCraft /
// Exports / JSON) or the empty hero, plus the modals it owns (New scene, palette drawer). The VectorCraft panel is
// mounted here once, after (and outside) the per-scene panel, so its iframe survives scene switches; on the
// VectorCraft sub-tab the scene panel shrinks to its header and sub-tabs (.artpanel.vc-on) and the panel fills the rest.

import React, { useId } from "react";
import { useStore } from "../store.ts";
import { S, openArtTour } from "../state.ts";
import { A, getScene, bump, scheduleValidate, build, requestCloseScene, openNewSceneModal, setArtSubtab, setArtRightTab } from "./art-state.ts";
import { SubTabs } from "../components/ui.tsx";
import { sx, CommitInput } from "./Bits.tsx";
import { DropZone } from "./DropZone.tsx";
import { ShapesTab, SpritesTab, ExportsTab, JsonTab } from "./SceneTabs.tsx";
import { TimelineTab } from "./TimelineTab.tsx";
import { RigTab } from "./RigTab.tsx";
import { VectorcraftPanel } from "./VectorcraftPanel.tsx";
import { NewSceneModal } from "./NewSceneModal.tsx";
import { PaletteDrawer } from "./PaletteDrawer.tsx";
import type { ArtSubtab, Scene } from "./types.ts";

export function ArtCenter() {
  const scenePath = useStore(A, (a) => a.scenePath);
  const newSceneOpen = useStore(A, (a) => a.newSceneOpen);
  const palOpen = useStore(A, (a) => a.palOpen);
  const hasScene = useStore(A, (a) => a.hasScene);
  const subtab = useStore(A, (a) => a.subtab);
  return (
    <div className="center">
      {scenePath ? <SceneTabBar /> : null}
      {scenePath ? <ScenePanel key={scenePath} /> : <ArtEmpty />}
      {/* outside the key: one VectorCraft for the editor's life (parked off-screen when not shown) */}
      <VectorcraftPanel active={!!scenePath && hasScene && subtab === "vectorcraft"} />
      {newSceneOpen ? <NewSceneModal /> : null}
      {palOpen ? <PaletteDrawer /> : null}
    </div>
  );
}

function ArtEmpty() {
  const mod = useStore(S, (s) => s.mod);
  return (
    <div className="emptycenter">
      <div style={sx("max-width:680px;width:100%")}>
        <div style={sx("width:56px;height:56px;border-radius:14px;background:var(--accbg);display:flex;align-items:center;justify-content:center;font-size:24px;margin-bottom:18px;color:var(--acc-ink)")}>▲</div>
        <h2 style={sx("font-size:24px;margin:0 0 8px")}>Author art the engine can load</h2>
        <p style={sx("margin:0 0 22px;font-size:14.5px;color:var(--ink2);line-height:1.6")}>
          A scene is a JSON model of shapes (16-level grayscale, palette-remapped in game), sprites (timelines with frame labels) and exports (SymbolClass linkage names). The editor builds it into an uncompressed SWF v17 — the exact subset <span className="mono">glaiel::swf</span> reads — and previews it with the real <span className="mono">palette.png</span> rows.
        </p>
        <div className="grid2">
          <button className="card plain" style={sx("text-align:left;cursor:pointer;color:var(--ink)")} onClick={() => openNewSceneModal()}>
            <div style={sx("font-weight:700;margin-bottom:4px")}>+ New scene</div>
            <div style={sx("font-size:12.5px;color:var(--ink2)")}>Starts from a bobbing gray square with two frame labels.</div>
          </button>
          <DropZone text="Import an SVG (Inkscape, VectorCraft, Illustrator) or a PNG — creates a scene if none is open." />
        </div>
        <div style={sx("display:flex;gap:12px;align-items:center;margin-top:18px;flex-wrap:wrap")}>
          <button className="btn ghost sm" onClick={() => openArtTour()}>▲ Take the Art tour</button>
          {!mod ? <span className="muted" style={sx("font-size:12.5px")}>No mod open — pick one from the top-bar mod switcher first.</span> : null}
        </div>
      </div>
    </div>
  );
}

function SceneTabBar() {
  const scenePath = useStore(A, (a) => a.scenePath);
  const saved = useStore(A, (a) => a.saved);
  const hasScene = useStore(A, (a) => a.hasScene);
  return (
    <div className="edtabbar">
      <div className="filetab">
        <span className="mono" style={sx("font-size:12.5px")}>{scenePath.split("/").pop() || ""}</span>
        <button className="x" aria-label="Close scene" onClick={() => void requestCloseScene()}>✕</button>
      </div>
      <span className="pill append">scene → .swf</span>
      <div className="grow" />
      {saved ? <span className="dotok" style={sx("font-size:12px")}>● Saved</span> : <span className="muted" style={sx("font-size:12px")}>● Unsaved</span>}
      <button className="btn primary sm" onClick={() => build(false)} disabled={!hasScene} title="Emit swfs/<name>.swf and swflist.gon.append">Build SWF</button>
    </div>
  );
}

function ScenePanel() {
  const hasScene = useStore(A, (a) => a.hasScene);
  const jsonError = useStore(A, (a) => a.jsonError);
  const subtab = useStore(A, (a) => a.subtab);
  const findings = useStore(A, (a) => a.findings);
  useStore(A, (a) => a.rev); // header counts and the active tab track in-place edits
  const sc = getScene();
  if (!hasScene || !sc) {
    return (
      <div className="artpanel">
        <div>
          <div className="finding error">
            <span className="mark">✕</span>
            <div>{jsonError || "scene could not be parsed"}</div>
          </div>
          <JsonTab />
        </div>
      </div>
    );
  }
  const e = findings.filter((f) => f.severity === "error").length;
  const w = findings.filter((f) => f.severity === "warning").length;
  let tab: React.ReactNode;
  if (subtab === "shapes") tab = <ShapesTab />;
  else if (subtab === "sprites") tab = <SpritesTab />;
  else if (subtab === "timeline") tab = <TimelineTab />;
  else if (subtab === "rig") tab = <RigTab />;
  else if (subtab === "vectorcraft") tab = null; // ArtCenter's one VectorcraftPanel shows itself under this panel
  else if (subtab === "exports") tab = <ExportsTab />;
  else if (subtab === "json") tab = <JsonTab />;
  else tab = <OverviewTab />;
  return (
    <div className={"artpanel" + (subtab === "vectorcraft" ? " vc-on" : "")}>
      <div>
        <div className="arthead">
          <h2>{sc.name}</h2>
          <span className="meta">{`${sc.frameRate || 60} fps · stage ${sc.stage ? sc.stage.width + "×" + sc.stage.height : "?"} · ${Object.keys(sc.shapes || {}).length} shapes · ${Object.keys(sc.sprites || {}).length} sprites · ${Object.keys(sc.exports || {}).length} exports`}</span>
          <div className="grow" />
          <button type="button" className={`pill ${e ? "err" : w ? "warn" : "ok"}`} title="Show the findings" onClick={() => setArtRightTab("findings")}>
            {`● ${e} error${e === 1 ? "" : "s"} · ${w} warning${w === 1 ? "" : "s"}`}
          </button>
        </div>
        <SubTabs items={SUBTABS} value={subtab} onChange={setArtSubtab} aria-label="Scene sections" />
        {tab}
      </div>
    </div>
  );
}

const SUBTABS: { id: ArtSubtab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "shapes", label: "Shapes" },
  { id: "sprites", label: "Sprites" },
  { id: "timeline", label: "Timeline" },
  { id: "rig", label: "Rig" },
  { id: "vectorcraft", label: "VectorCraft" },
  { id: "exports", label: "Exports" },
  { id: "json", label: "JSON" },
];

/** A labelled input that commits on `change` (label text → id). */
export function Field({ label, value, onChange, cls = "artinput" }: { label: string; value: string | number | undefined; onChange: (v: string) => void; cls?: string }) {
  const id = "f-" + label.replace(/\W+/g, "-") + "-" + useId().replace(/\W/g, "");
  return (
    <>
      <label className="k" htmlFor={id}>{label}</label>
      <CommitInput id={id} className={cls} initial={value ?? ""} onCommit={onChange} />
    </>
  );
}

function OverviewTab() {
  const mod = useStore(S, (s) => s.mod);
  const abc = useStore(A, (a) => a.abc);
  const sc = getScene() as Scene;
  const stage = (sc.stage ??= { width: 1280, height: 720 });
  const num = (v: string, d: number) => (Number.isFinite(Number(v)) && v !== "" ? Number(v) : d);
  return (
    <div>
      <div className="card plain">
        <div className="kv">
          <Field label="name (→ swfs/<name>.swf)" value={sc.name} onChange={(v) => { sc.name = v; scheduleValidate(); bump(); }} cls="artinput mono" />
          <Field label="frameRate" value={sc.frameRate ?? 60} onChange={(v) => { sc.frameRate = num(v, 60); scheduleValidate(); }} cls="artinput num" />
          <Field label="stage width" value={stage.width} onChange={(v) => { stage.width = num(v, 1280); scheduleValidate(); }} cls="artinput num" />
          <Field label="stage height" value={stage.height} onChange={(v) => { stage.height = num(v, 720); scheduleValidate(); }} cls="artinput num" />
          <Field label="stage background" value={stage.background ?? "#ffccff"} onChange={(v) => { stage.background = v; scheduleValidate(); }} cls="artinput mono" />
          <Field label="curveResolution (swflist per_file_curve_resolution)" value={sc.curveResolution ?? ""} onChange={(v) => { if (v === "") delete sc.curveResolution; else sc.curveResolution = num(v, 1); scheduleValidate(); }} cls="artinput num" />
        </div>
      </div>
      <div className="artsec"><span className="sec">Import</span></div>
      <DropZone compact text="Drop an SVG (a shape: fills become gray levels, non-gray colours pass through and are flagged) or a PNG (its options open in the Shapes tab)." />
      <div className="artsec"><span className="sec">How it ships</span></div>
      <div className="card plain" style={sx("font-size:12.5px;color:var(--ink2);line-height:1.6")}>
        Build writes <span className="mono">{`mods/${mod}/swfs/${sc.name}.swf`}</span> (FWS v17, DefineShape3 + DefineSprite + PlaceObject2 + SymbolClass<span>{abc === "stub" ? " + a stub DoABC" : ", no DoABC"}</span>) and appends it to <span className="mono">swfs/swflist.gon.append</span>. GON addresses your art by the export names. SymbolClass binds the export names; the DoABC stub is optional. An export named _Append_&lt;Clip&gt; is merged into that vanilla clip at boot.
      </div>
    </div>
  );
}
