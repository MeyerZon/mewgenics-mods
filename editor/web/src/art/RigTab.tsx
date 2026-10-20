// The Rig tab: build a cat-shaped character in the vanilla slot layout (tail, leg2, arm2, body, leg1, arm1, head —
// the named instances of the game's cat animations; src/core/art/cat-rig.ts) and point each slot at a shape or sprite.
// Animate it in the Timeline tab; export it in the Exports tab. Edits are in memory until Save.

import React from "react";
import { useStore } from "../store.ts";
import { toast } from "../state.ts";
import { A, getScene, setScene, bump, scheduleValidate, setTarget } from "./art-state.ts";
import { sx } from "./Bits.tsx";
import { CAT_SLOTS, addCatRig, assignSlot } from "../../../src/core/art/cat-rig.ts";
import type { Scene, Finding } from "./types.ts";

export function RigTab() {
  useStore(A, (a) => a.rev);
  const findings = useStore(A, (a) => a.findings);
  const sc = getScene() as Scene;
  const rigs = Object.keys(sc.sprites || {}).filter((id) => sc.sprites[id]!.rig === "cat");
  const apply = (r: { scene: Scene; findings: Finding[] }, then?: () => void) => {
    const e = r.findings.find((f) => f.severity === "error");
    if (e) return toast(e.message);
    setScene(r.scene);
    scheduleValidate();
    bump();
    if (then) then();
  };
  const refs = [...Object.keys(sc.shapes || {}), ...Object.keys(sc.sprites || {}).map((s) => `${s}`)];
  return (
    <div>
      <div className="artsec">
        <span className="sec">{`Cat rigs (${rigs.length}) — the vanilla cat slot layout`}</span>
        <button
          className="btn ghost sm"
          onClick={() => {
            let name = "CatRig";
            let n = 2;
            while (sc.sprites[name] || sc.shapes[name]) name = `CatRig${n++}`;
            apply(addCatRig(sc, name), () => {
              setTarget(name);
              toast(`added cat rig "${name}" with placeholder parts — assign your shapes to its slots`);
            });
          }}
        >
          New cat rig
        </button>
      </div>
      <p className="muted" style={sx("font-size:12.5px;line-height:1.6;margin:4px 0 10px")}>
        One named instance per body part, at the depths the game's main cat animation uses. Point each slot at a shape or
        a sprite (a sprite runs on its own clock — the game drives a character's root timeline, so free animation lives in
        nested sprites). Animate poses in the Timeline tab; export the rig in the Exports tab and give a character
        <span className="mono"> graphics.movieclip</span> its name.
      </p>
      {rigs.map((id) => {
        const sp = sc.sprites[id]!;
        const rf = findings.filter((f) => f.path === `sprites.${id}` && /^rig-/.test(f.code));
        return (
          <div key={id} className="card plain">
            <div style={sx("display:flex;align-items:center;gap:10px")}>
              <span className="mono" style={sx("font-weight:700")}>{id}</span>
              <span className="meta">{`${sp.frames} frames · labels ${Object.keys(sp.labels || {}).join(", ") || "-"}`}</span>
              <div className="grow" />
              <button className="btn ghost sm" onClick={() => setTarget(id)}>Preview</button>
              <button className="btn ghost sm" onClick={() => { A.set({ subtab: "timeline" }); setTarget(id); }}>Animate</button>
            </div>
            {rf.map((f, i) => <div key={i} className={`pill chip ${f.severity === "error" ? "err" : f.severity === "warning" ? "warn" : "muted"}`} style={sx("margin-top:6px")}>{f.message}</div>)}
            <div style={sx("margin-top:8px")}>
              {CAT_SLOTS.map((slot) => {
                const layer = sp.layers.find((l) => l.name === slot.name);
                const ref = layer ? (layer.keys.find((k) => k.ref) || layer.keys[0] || { ref: null }).ref : null;
                return (
                  <div key={slot.name} className="artrow rig-slot">
                    <span className="id mono">{slot.name}</span>
                    <span className="meta mono">{layer ? `depth ${layer.depth}${layer.depth !== slot.depth ? ` (vanilla ${slot.depth})` : ""}` : "missing"}</span>
                    <div className="grow" />
                    <select
                      className="artinput"
                      aria-label={`slot ${slot.name}`}
                      value={ref || ""}
                      disabled={!layer}
                      onChange={(e) => e.target.value && apply(assignSlot(sc, id, slot.name, e.target.value))}
                    >
                      <option value="">{ref ? "" : "(none)"}</option>
                      {refs.filter((r) => r !== id).map((r) => <option key={r} value={r}>{sc.sprites[r] ? `${r} (sprite)` : r}</option>)}
                    </select>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      {rigs.length ? null : <p className="muted">No cat rig yet. New cat rig adds a sprite with the seven slots and placeholder parts.</p>}
    </div>
  );
}
