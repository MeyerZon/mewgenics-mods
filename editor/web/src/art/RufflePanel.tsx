// Art-mode right panel, Ruffle tab: play a built mod SWF or an extracted vanilla SWF in Ruffle, the WASM Flash
// player, as a reference. Not the game's renderer: no palette remap, no _Append_ merging.

import React, { useEffect, useRef, useState } from "react";
import { useStore } from "../store.ts";
import { S } from "../state.ts";
import { getJson, url } from "../api.ts";
import { A } from "./art-state.ts";
import { playSwfBytes, metadataOf } from "./ruffle-host.ts";
import type { RuffleMetadata } from "./ruffle-host.ts";

interface VanillaList {
  ok: boolean;
  files: { name: string; present: boolean; bytes?: number }[];
  hint: string;
}

export function RufflePanel() {
  const mod = useStore(S, (s) => s.mod);
  const swfs = useStore(A, (a) => a.swfs);
  const [vanilla, setVanilla] = useState<VanillaList | null>(null);
  const [source, setSource] = useState("");
  const [status, setStatus] = useState("pick a SWF and press Load");
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    getJson<VanillaList>("/api/art/vanilla-swfs").then((v) => { if (live) setVanilla(v); }).catch(() => { if (live) setVanilla(null); });
    return () => { live = false; };
  }, []);

  const options: { value: string; label: string; disabled: boolean }[] = [
    ...swfs.map((s) => ({ value: `mod:${s.relPath}`, label: `mod: ${s.relPath.replace(/^swfs\//, "")}`, disabled: false })),
    ...(vanilla?.files || []).map((f) => ({ value: `vanilla:${f.name}`, label: `vanilla: ${f.name}${f.present ? "" : " (not extracted)"}`, disabled: !f.present })),
  ];

  async function load() {
    if (!source || !box.current) return;
    setStatus("loading…");
    try {
      const [kind, name] = [source.slice(0, source.indexOf(":")), source.slice(source.indexOf(":") + 1)];
      const href = kind === "mod" ? url("/api/art/asset", { mod, path: name }) : url("/api/art/vanilla-swf", { name });
      const r = await fetch(href);
      if (!r.ok) { setStatus(`cannot read ${name}: ${(await r.text()).slice(0, 200)}`); return; }
      const bytes = await r.arrayBuffer();
      const player = await playSwfBytes(box.current, bytes);
      // the header is parsed asynchronously: poll briefly for the metadata
      let m: RuffleMetadata | null = null;
      for (let i = 0; i < 50 && !m; i++) { m = metadataOf(player); if (!m) await new Promise((res) => setTimeout(res, 100)); }
      setStatus(m ? `${name}: ${m.numFrames ?? "?"} frames, ${m.frameRate ?? "?"} fps, ${m.width ?? "?"}×${m.height ?? "?"}, SWF v${m.swfVersion ?? "?"} (${bytes.byteLength} bytes)` : `${name}: playing (${bytes.byteLength} bytes; no metadata yet)`);
    } catch (e) {
      setStatus(`Ruffle failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div className="rufflepanel">
      <p className="muted ruffle-caption">Ruffle: a Flash player, not glaiel::swf — no palette remap, no _Append_ merging. A reference for what a SWF contains and how it animates.</p>
      <div className="row">
        <select className="ruffle-source" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">— choose a SWF —</option>
          {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
        </select>
        <button className="btn sm ruffle-load" disabled={!source} onClick={load}>Load</button>
      </div>
      <div className="ruffle-status muted">{status}</div>
      {vanilla && !vanilla.files.some((f) => f.present) && <p className="muted">{vanilla.hint}</p>}
      <div className="ruffle-box" ref={box} style={{ width: "100%", height: 320, background: "#1a212b" }} />
    </div>
  );
}
