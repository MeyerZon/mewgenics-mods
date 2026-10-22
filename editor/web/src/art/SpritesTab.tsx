// The Sprites tab: DefineSprite timelines — frame count, labels, layers. Keys are edited in the Timeline tab (Open in
// Timeline). Edits go through art-state's updateSprite / deleteSprite / newSprite, which replace the sprite object, so
// the memoized cards and layer rows re-render only when their sprite changes.

import React from "react";
import { useStore } from "../store.ts";
import { A, getScene, setTarget, newSprite, updateSprite, deleteSprite, openInTimeline } from "./art-state.ts";
import { sx, CommitInput } from "./Bits.tsx";
import { Pill } from "../components/ui.tsx";
import { bakeSprite, type BakedSprite } from "../../../src/core/art/timeline.ts";
import type { Scene, SceneSprite, SceneLayer } from "./types.ts";

export function SpritesTab() {
  useStore(A, (a) => a.rev);
  const sc = getScene() as Scene;
  const ids = Object.keys(sc.sprites || {});
  const shapeIds = Object.keys(sc.shapes || {}).join("\n");
  const spriteIds = ids.join("\n");
  return (
    <div>
      <div className="artsec">
        <span className="sec">{`Sprites (${ids.length}) — DefineSprite timelines`}</span>
        <button className="btn ghost sm" onClick={newSprite}>New sprite</button>
      </div>
      {ids.map((id) => <SpriteCard key={id} id={id} sp={sc.sprites[id]!} shapeIds={shapeIds} spriteIds={spriteIds} />)}
      {ids.length ? null : <p className="muted">No sprites. A sprite is what GON animates (frame labels like idle / attack).</p>}
    </div>
  );
}

/** One sprite: id, frames, labels, Preview / Open in Timeline / Delete, its layers and "+ layer from". */
const SpriteCard = React.memo(function SpriteCard({ id, sp, shapeIds, spriteIds }: { id: string; sp: SceneSprite; shapeIds: string; spriteIds: string }) {
  const baked = safeBake(sp);
  const labels = Object.entries(sp.labels || {}).map(([k, v]) => `${k}:${v}`).join(", ");
  const shapes = shapeIds ? shapeIds.split("\n") : [];
  const others = (spriteIds ? spriteIds.split("\n") : []).filter((s) => s !== id);
  return (
    <div className="card plain">
      <div style={sx("display:flex;align-items:center;gap:10px;flex-wrap:wrap")}>
        <span className="id mono" style={sx("font-weight:700")}>{id}</span>
        <label className="muted" style={sx("font-size:12px;display:inline-flex;gap:6px;align-items:center")}>
          frames
          <CommitInput className="artinput num" type="number" min={1} initial={sp.frames} onCommit={(v) => updateSprite(id, { frames: Math.max(1, Number(v) | 0) })} />
        </label>
        <label className="muted" style={sx("font-size:12px;display:inline-flex;gap:6px;align-items:center;flex:1")}>
          labels
          <CommitInput className="artinput mono" style={sx("flex:1")} initial={labels} placeholder="idle:0, attack:6" onCommit={(v) => updateSprite(id, { labels: parseLabels(v) })} />
        </label>
        <button className="btn ghost sm" onClick={() => setTarget(id)}>Preview</button>
        <button className="btn ghost sm" onClick={() => openInTimeline(id)}>Open in Timeline</button>
        <button className="btn ghost sm" style={sx("color:var(--err)")} aria-label={`Delete sprite ${id}`} onClick={() => deleteSprite(id)}>
          Delete
        </button>
      </div>
      <div style={sx("margin-top:10px")}>
        {(sp.layers || []).map((layer, li) => <LayerRow key={li} spriteId={id} li={li} layer={layer} />)}
        <div style={sx("display:flex;gap:8px;align-items:center;margin-top:6px")}>
          <span className="muted" style={sx("font-size:12px")}>+ layer from</span>
          <select
            className="artinput"
            aria-label={`add a layer to ${id}`}
            value=""
            onChange={(e) => {
              const ref = e.target.value;
              if (!ref) return;
              const depth = Math.max(0, ...(sp.layers || []).map((l) => l.depth)) + 1;
              updateSprite(id, { layers: [...(sp.layers || []), { name: ref, depth, keys: [{ frame: 0, ref, x: 0, y: 0 }] }] });
            }}
          >
            <option value="">shape or sprite…</option>
            {shapes.map((s) => <option key={s} value={s}>{s}</option>)}
            {others.map((s) => <option key={`sprite:${s}`} value={s}>{s + " (sprite)"}</option>)}
          </select>
          <span className="muted" style={sx("font-size:11.5px")}>{baked ? `${baked.frames} frames baked · ${baked.placements.reduce((n, f) => n + f.length, 0)} placements` : "invalid"}</span>
        </div>
      </div>
    </div>
  );
});

/** One layer of a sprite: name, depth, its keys in short, mask, Delete layer N. */
const LayerRow = React.memo(function LayerRow({ spriteId, li, layer }: { spriteId: string; li: number; layer: SceneLayer }) {
  const nk = (layer.keys || []).length;
  return (
    <div className="artrow">
      <span className="id">{layer.name || `(depth ${layer.depth})`}</span>
      <span className="meta mono">{`depth ${layer.depth}`}</span>
      <span className="meta">{`${nk} key${nk === 1 ? "" : "s"}: ${(layer.keys || []).map((k) => `${k.frame}${k.ref ? "→" + k.ref : "→∅"}${k.tween === "linear" ? "~" : ""}`).join("  ")}`}</span>
      {layer.clip ? <Pill kind="muted" chip>{`mask ≤${layer.clipDepth}`}</Pill> : null}
      <div className="grow" />
      <button
        className="btn ghost sm"
        style={sx("color:var(--err)")}
        aria-label={`Delete layer ${li}`}
        onClick={() => {
          const sp = getScene()?.sprites[spriteId];
          if (sp) updateSprite(spriteId, { layers: sp.layers.filter((_, j) => j !== li) });
        }}
      >
        Delete
      </button>
    </div>
  );
});

function safeBake(sp: SceneSprite): BakedSprite | null {
  try {
    return bakeSprite(sp);
  } catch {
    return null;
  }
}

function parseLabels(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of text.split(",")) {
    const m = /^\s*([^:\s]+)\s*:\s*(\d+)\s*$/.exec(part);
    if (m) out[m[1]!] = Number(m[2]);
  }
  return out;
}
