// Right-side drawers: the base-entry viewer and the components search (no-mod fallback).

import React from "react";
import { S } from "../state.ts";
import { useS, CodeView, Drawer, Pill } from "./ui.tsx";
import { ComponentSearch } from "./RightPanel.tsx";

export function BaseEntryDrawer(): React.JSX.Element {
  const bv = useS((s) => s.baseView);
  const close = () => S.set({ baseDrawer: false });
  const titleText = bv && bv.ok ? bv.name || "Base entry" : "Base entry";
  return (
    <Drawer title={titleText} icon="⌕" headExtra={<Pill kind="muted">read-only</Pill>} width="min(640px,96vw)" onClose={close}>
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
    </Drawer>
  );
}

export function ComponentsDrawer(): React.JSX.Element {
  const close = () => S.set({ compDrawer: false });
  return (
    <Drawer title="Components" icon="⌕" width="min(560px,96vw)" onClose={close} initialFocus=".dbody input">
      <ComponentSearch />
    </Drawer>
  );
}
