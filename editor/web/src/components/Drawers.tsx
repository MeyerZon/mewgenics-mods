// Right-side drawers: the base-entry viewer and the components search (no-mod fallback).

import React from "react";
import { S } from "../state.ts";
import { useS, sx, CodeView } from "./ui.tsx";
import { ComponentSearch } from "./RightPanel.tsx";

export function BaseEntryDrawer(): React.JSX.Element {
  const bv = useS((s) => s.baseView);
  const close = () => S.set({ baseDrawer: false });
  const titleText = bv && bv.ok ? bv.name || "Base entry" : "Base entry";
  return (
    <div className="scrim right" onClick={close}>
      <div className="drawer" style={sx("width:min(640px,96vw)")} onClick={(e) => e.stopPropagation()}>
        <div className="dhead">
          <span style={sx("font-size:18px")}>⌕</span>
          <div className="t">{titleText}</div>
          <span className="pill muted">read-only</span>
          <button className="iconbtn" aria-label="Close" onClick={close}>
            ✕
          </button>
        </div>
        <div className="dbody">
          {!bv ? (
            <p className="muted">Pick a base entry.</p>
          ) : !bv.ok ? (
            <div className="finding error">
              <span className="mark">✕</span>
              <div>{bv.error || "not found"}</div>
            </div>
          ) : (
            <div>
              <p className="muted">{`${bv.category} · ${bv.file}`}</p>
              <CodeView text={bv.gon} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function ComponentsDrawer(): React.JSX.Element {
  const close = () => S.set({ compDrawer: false });
  return (
    <div className="scrim right" onClick={close}>
      <div className="drawer" style={sx("width:min(560px,96vw)")} onClick={(e) => e.stopPropagation()}>
        <div className="dhead">
          <span style={sx("font-size:18px")}>⌕</span>
          <div className="t">Components</div>
          <button className="iconbtn" aria-label="Close" onClick={close}>
            ✕
          </button>
        </div>
        <div className="dbody">
          <ComponentSearch />
        </div>
      </div>
    </div>
  );
}
