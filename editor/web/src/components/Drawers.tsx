// Right-side drawers (the Drawer primitive: .drawer / .dbody, ✕ "Close"): the base-entry viewer and the
// components search (no-mod fallback).

import React from "react";
import { useS, CodeView, Drawer, Pill } from "./ui.tsx";
import { ComponentSearch } from "./RightPanel.tsx";
import { closeBaseDrawer, closeComponentsDrawer } from "../actions.ts";

export function BaseEntryDrawer(): React.JSX.Element {
  const bv = useS((s) => s.baseView);
  const titleText = bv && bv.ok ? bv.name || "Base entry" : "Base entry";
  return (
    <Drawer title={titleText} icon="⌕" headExtra={<Pill kind="muted">read-only</Pill>} width="min(640px,96vw)" onClose={closeBaseDrawer}>
      {!bv ? (
        <p className="muted">Pick a base entry.</p>
      ) : !bv.ok ? (
        <div className="finding error">
          <span className="mark">✕</span>
          <div>{bv.error || "not found"}</div>
        </div>
      ) : (
        <div>
          <p className="muted">
            <Pill kind="muted" chip>
              {bv.category}
            </Pill>{" "}
            <span className="mono">{bv.file}</span>
          </p>
          <CodeView text={bv.gon} />
        </div>
      )}
    </Drawer>
  );
}

export function ComponentsDrawer(): React.JSX.Element {
  return (
    <Drawer title="Components" icon="⌕" width="min(560px,96vw)" onClose={closeComponentsDrawer} initialFocus=".dbody input">
      <ComponentSearch />
    </Drawer>
  );
}
