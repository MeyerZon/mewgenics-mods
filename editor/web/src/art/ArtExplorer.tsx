// Art-mode explorer: scenes, built SWFs, assets.

import React from "react";
import { useStore } from "../store.ts";
import { S } from "../state.ts";
import { A, pickScene, inspectSwf, openNewSceneModal } from "./art-state.ts";
import { sx } from "./Bits.tsx";
import { TOUR, tourAttr } from "../tour-anchors.ts";

export function ArtExplorer() {
  const mod = useStore(S, (s) => s.mod);
  const scenes = useStore(A, (a) => a.scenes);
  const swfs = useStore(A, (a) => a.swfs);
  const assets = useStore(A, (a) => a.assets);
  const scenePath = useStore(A, (a) => a.scenePath);
  return (
    <div className="explorer">
      <div {...tourAttr(TOUR.artScenes)}>
        <div className="exhead">
          <span className="sec">Art scenes</span>
          {mod ? (
            <button className="btn ghost sm" style={sx("color:var(--acc-ink)")} onClick={() => openNewSceneModal()}>
              + New scene
            </button>
          ) : null}
        </div>
        {!mod ? (
          <div className="dashed">
            <div style={sx("font-size:13px")}>Open a mod to author art.</div>
          </div>
        ) : (
          <div className="exbody tw">
            {scenes.length ? (
              scenes.map((s) => (
                <button key={s.relPath} className={"srow" + (scenePath === s.relPath ? " sel" : "")} title={s.relPath} onClick={() => void pickScene(s.relPath)}>
                  <span className="fname" style={sx("flex:1")}>{s.name}</span>
                  <span className="count">{`${s.bytes} B`}</span>
                </button>
              ))
            ) : (
              <div className="srow" style={sx("color:var(--muted)")}>(no scenes — create one)</div>
            )}
          </div>
        )}
      </div>
      <div className="exdiv" />
      <div className="exhead">
        <span className="sec">Built SWFs</span>
        <small className="muted">· swfs/</small>
      </div>
      <div className="exbody tw">
        {swfs.length ? (
          swfs.map((s) => (
            <button key={s.relPath} className="srow" title="inspect with the verification reader" onClick={() => inspectSwf(s.relPath)}>
              <span className="fname" style={sx("flex:1")}>{s.relPath.replace(/^swfs\//, "")}</span>
              <span className="count">{`${(s.bytes / 1024).toFixed(1)} KB`}</span>
            </button>
          ))
        ) : (
          <div className="srow" style={sx("color:var(--muted)")}>{scenePath ? "(nothing built — use Build SWF)" : "(nothing built yet)"}</div>
        )}
        {assets.swflistAppend ? (
          <div className="srow" style={sx("color:var(--muted)")}>
            <span className="fname">swflist.gon.append</span>
            <span className="pill append chip">.append</span>
          </div>
        ) : null}
      </div>
      <div className="exdiv" />
      <div className="exhead">
        <span className="sec">Assets</span>
        <small className="muted">· art/</small>
      </div>
      <div className="exbody tw">
        {assets.svgs.map((s) => (
          <div key={s} className="srow" style={sx("color:var(--ink2)")}>
            <span className="fname">{s}</span>
          </div>
        ))}
        {assets.pngs.map((s) => (
          <div key={s} className="srow" style={sx("color:var(--ink2)")}>
            <span className="fname">{s}</span>
          </div>
        ))}
        {!assets.svgs.length && !assets.pngs.length ? <div className="srow" style={sx("color:var(--muted)")}>(drop an SVG onto the Art panel)</div> : null}
      </div>
    </div>
  );
}
