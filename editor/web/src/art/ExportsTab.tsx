// The Exports tab: the SymbolClass linkage names GON can address, and the New export form (controlled; the name
// clears once added).

import React, { useState } from "react";
import { useStore } from "../store.ts";
import { A, getScene, addExport, removeExport } from "./art-state.ts";
import { sx } from "./Bits.tsx";
import type { Scene } from "./types.ts";

export function ExportsTab() {
  useStore(A, (a) => a.rev);
  const sc = getScene() as Scene;
  const targets = [...Object.keys(sc.sprites || {}), ...Object.keys(sc.shapes || {})];
  const [name, setName] = useState("");
  const [picked, setPicked] = useState("");
  const ref = targets.includes(picked) ? picked : targets[0] || "";
  return (
    <div>
      <div className="artsec"><span className="sec">Exports — SymbolClass linkage names GON can address</span></div>
      <p className="muted" style={sx("margin:0 0 10px;font-size:12.5px;line-height:1.6")}>
        Vanilla GON refers to symbols by these strings (e.g. <span className="mono">"rat.png"</span> → <span className="mono">Rat</span>). To extend a vanilla clip use the <span className="mono">_Append_&lt;Clip&gt;</span> convention (community-documented). You may export one sprite under several names.
      </p>
      {Object.entries(sc.exports || {}).map(([exportName, target]) => (
        <div key={exportName} className="artrow">
          <span className="id">{exportName}</span>
          <span className="meta">→</span>
          <span className="mono" style={sx("font-size:12.5px")}>{String(target)}</span>
          <div className="grow" />
          <button className="btn ghost sm" style={sx("color:var(--err)")} aria-label={`Remove export ${exportName}`} onClick={() => removeExport(exportName)}>Remove</button>
        </div>
      ))}
      <form
        style={sx("display:flex;gap:8px;align-items:center;margin-top:8px")}
        onSubmit={(e) => {
          e.preventDefault();
          const n = name.trim();
          if (!n || !ref) return;
          addExport(n, ref);
          setName("");
        }}
      >
        <input className="artinput mono" placeholder="linkage name (e.g. MyRat or myrat.png)" aria-label="new export linkage name" value={name} onChange={(e) => setName(e.target.value)} />
        <select className="artinput" aria-label="export target" value={ref} onChange={(e) => setPicked(e.target.value)}>
          {targets.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <button type="submit" className="btn sm" disabled={!name.trim() || !ref}>New export</button>
      </form>
    </div>
  );
}
