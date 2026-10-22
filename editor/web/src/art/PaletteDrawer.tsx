// The palette.png row browser (right-side drawer; picking a row sets the preview row).

import React, { useState } from "react";
import { useStore } from "../store.ts";
import { A, setRow } from "./art-state.ts";
import { sx } from "./Bits.tsx";
import { Drawer, Pill } from "../components/ui.tsx";

export function PaletteDrawer() {
  const pal = useStore(A, (a) => a.palette);
  const row = useStore(A, (a) => a.row);
  const [filter, setFilter] = useState("");
  const close = () => A.set({ palOpen: false });
  const rows = pal ? pal.rows : [];
  const hints = (pal && pal.hints) || {};
  return (
    <Drawer title="palette.png rows" headExtra={<Pill kind="muted">{pal && pal.ok ? pal.source : "identity ramp"}</Pill>} width="min(620px,96vw)" onClose={close} initialFocus=".dbody .search input">
          <div className="search" style={sx("margin:0 0 12px")}>
            <span aria-hidden="true">⌕</span>
            <input placeholder="filter by row number or hint (Fighter, random cat…)" aria-label="filter palette rows" onInput={(e) => setFilter((e.target as HTMLInputElement).value.toLowerCase())} />
          </div>
          <p className="muted" style={sx("margin:0 0 12px;font-size:12.5px")}>One shared table for cats, abilities and UI: rows 0–48 random cats, ~49–145 classes/named cats; ~150 rows are free. Pick a row to preview with.</p>
          <div className="palgrid">
            {rows.flatMap((r, i) => {
              const hint = hints[i] || "";
              if (filter && !(String(i).includes(filter) || hint.toLowerCase().includes(filter))) return [];
              const cur = i === row;
              return [
                <button key={i} className={"rowpick" + (cur ? " cur" : "")} aria-label={`use palette row ${i}`} onClick={() => { setRow(i); close(); }}>
                  <span className="r">{String(i)}</span>
                  <div className="ramp">{r.map((c, j) => <span key={j} style={{ background: `rgb(${c[0]},${c[1]},${c[2]})` }} />)}</div>
                  <span className="hint">{hint}</span>
                </button>,
              ];
            })}
          </div>
    </Drawer>
  );
}
