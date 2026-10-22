// The palette.png row browser (right-side drawer; picking a row sets the preview row). Browsing never marks the scene
// unsaved: the row is written into scene.preview with the next Save.

import React, { useState } from "react";
import { useStore } from "../store.ts";
import { A, setRow, closePalette } from "./art-state.ts";
import { sx } from "./Bits.tsx";
import { Drawer, Pill, SearchBox } from "../components/ui.tsx";

export function PaletteDrawer() {
  const pal = useStore(A, (a) => a.palette);
  const row = useStore(A, (a) => a.row);
  const [filter, setFilter] = useState("");
  const rows = pal ? pal.rows : [];
  const hints = (pal && pal.hints) || {};
  const q = filter.toLowerCase();
  return (
    <Drawer title="palette.png rows" headExtra={<Pill kind="muted">{pal && pal.ok ? pal.source : "identity ramp"}</Pill>} width="min(620px,96vw)" onClose={closePalette} initialFocus=".dbody .search input">
      <SearchBox value={filter} onChange={setFilter} placeholder="filter by row number or hint (Fighter, random cat…)" aria-label="filter palette rows" style={sx("margin:0 0 12px")} />
      <p className="muted" style={sx("margin:0 0 12px;font-size:12.5px")}>One shared table for cats, abilities and UI: rows 0–48 random cats, ~49–145 classes/named cats; ~150 rows are free. Pick a row to preview with.</p>
      <div className="palgrid">
        {rows.flatMap((r, n) => {
          const hint = hints[n] || "";
          if (q && !(String(n).includes(q) || hint.toLowerCase().includes(q))) return [];
          const cur = n === row;
          return [
            <button key={n} className={"rowpick" + (cur ? " cur" : "")} aria-label={`use palette row ${n}`} onClick={() => { setRow(n); closePalette(); }}>
              <span className="r">{String(n)}</span>
              <div className="ramp">{r.map((c, level) => <span key={level} style={{ background: `rgb(${c[0]},${c[1]},${c[2]})` }} />)}</div>
              <span className="hint">{hint}</span>
            </button>,
          ];
        })}
      </div>
    </Drawer>
  );
}
