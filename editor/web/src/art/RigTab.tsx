// The Rig tab: build a cat-shaped character in the vanilla slot layout (tail, leg2, arm2, body, leg1, arm1, head —
// the named instances of the game's cat animations; src/core/art/cat-rig.ts) and point each slot at a shape or sprite.
// Animate it in the Timeline tab; export it in the Exports tab. Edits are in memory until Save.

import React from "react";
import { useStore } from "../store.ts";
import { toast } from "../state.ts";
import { A, getScene, setScene, bump, scheduleValidate, setTarget } from "./art-state.ts";
import { sx } from "./Bits.tsx";
import { CAT_SLOTS, CAT_ANIM_EXPORT, CAT_ANIM_FACINGS, addCatRig, assignSlot, newCatAnimation, catAnimDonor } from "../../../src/core/art/cat-rig.ts";
import type { Scene, Finding } from "./types.ts";

/** The facing pairs a donor sprite's labels form (`<anim>F` / `<anim>B`), in frame order; a lone label shows its partner missing. */
export function catAnimPairs(labels: Record<string, number>): Array<{ name: string; frames: Array<{ label: string; frame: number | null }> }> {
  const names: string[] = [];
  for (const label of Object.keys(labels).sort((a, b) => labels[a]! - labels[b]!)) {
    const facing = CAT_ANIM_FACINGS.find((f) => label.endsWith(f) && label.length > f.length);
    if (!facing) continue;
    const base = label.slice(0, -facing.length);
    if (!names.includes(base)) names.push(base);
  }
  return names.map((name) => ({ name, frames: CAT_ANIM_FACINGS.map((f) => ({ label: `${name}${f}`, frame: labels[`${name}${f}`] ?? null })) }));
}

export function RigTab() {
  useStore(A, (a) => a.rev);
  const findings = useStore(A, (a) => a.findings);
  const [animName, setAnimName] = React.useState("");
  const sc = getScene() as Scene;
  const rigs = Object.keys(sc.sprites || {}).filter((id) => sc.sprites[id]!.rig === "cat");
  const donor = catAnimDonor(sc);
  const donorRef = (sc.exports || {})[CAT_ANIM_EXPORT];
  const animFindings = findings.filter((f) => /^cat-anim/.test(f.code));
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
        One named instance per body part, at the depths the game's main cat animation uses. A drawn rig (New cat rig)
        points each slot at a shape or a sprite (a sprite runs on its own clock — the game drives a character's root
        timeline, so free animation lives in nested sprites); its placeholder art is preview-only on a cat. A
        <span className="mono"> parts: game</span> rig (what New cat animation makes) keeps every slot an empty sprite: on a cat the game draws the
        cat's own part — palette, texture, face — into it, and a visible non-empty slot crashes the game. Animate poses in the
        Timeline tab; export a drawn rig in the Exports tab and give a character <span className="mono">graphics.movieclip</span> its name.
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
                    <span className="meta mono">{layer ? `depth ${layer.depth}${layer.depth !== slot.depth ? ` (vanilla ${slot.depth})` : ""}${sp.parts === "game" ? " · empty: the game draws the cat's own part" : ""}` : "missing"}</span>
                    <div className="grow" />
                    <select
                      className="artinput"
                      aria-label={`slot ${slot.name}`}
                      value={ref || ""}
                      disabled={!layer || sp.parts === "game"}
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

      <div className="artsec">
        <span className="sec">{`Cat animations — frames appended to the game's CatTest clip${donor ? ` (${donor})` : ""}`}</span>
        <input
          className="artinput mono"
          aria-label="new cat animation name"
          placeholder="animation name, e.g. wave"
          value={animName}
          onChange={(e) => setAnimName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") addAnimation(); }}
          style={sx("width:180px")}
        />
        <button className="btn ghost sm" disabled={!animName.trim()} onClick={addAnimation}>
          New cat animation
        </button>
      </div>
      <p className="muted" style={sx("font-size:12.5px;line-height:1.6;margin:4px 0 10px")}>
        A cat animation is a facing pair of labeled frames, <span className="mono">{"<name>F"}</span> / <span className="mono">{"<name>B"}</span>,
        on a donor sprite exported as <span className="mono">{CAT_ANIM_EXPORT}</span>; each frame places a cat rig (<span className="mono">{"<name>Pose"}</span>)
        as the layer <span className="mono">ani</span> at depth 1 — the shape of every vanilla CatTest frame; the engine restarts the child
        <span className="mono"> ani</span> on every play. The pose's seven slots stay empty — the game draws the cat's own parts into them
        (OBSERVED in the game, a still pose and an animated one alike). Pose the slots in the Timeline tab, build the SWF, then refer to it bare from GON:
        <span className="mono"> alt_animations [[idle {animName.trim() || "<name>"}]]</span> on a character or
        <span className="mono"> animation {animName.trim() || "<name>"}</span> on an ability (a missing F or B label is a silent no-op in-game).
      </p>
      {donorRef !== undefined && !donor ? (
        <div className="pill chip err" style={sx("margin-bottom:8px")}>{`${CAT_ANIM_EXPORT} points at "${String(donorRef)}", which is not a donor sprite — fix the export before adding animations`}</div>
      ) : null}
      {donor ? (
        <div className="card plain">
          <div style={sx("display:flex;align-items:center;gap:10px")}>
            <span className="mono" style={sx("font-weight:700")}>{donor}</span>
            <span className="meta">{`${sc.sprites[donor]!.frames} frames · exported as ${CAT_ANIM_EXPORT}`}</span>
            <div className="grow" />
            <button className="btn ghost sm" onClick={() => setTarget(donor)}>Preview</button>
            <button className="btn ghost sm" onClick={() => { A.set({ subtab: "timeline" }); setTarget(donor); }}>Timeline</button>
          </div>
          {animFindings.map((f, i) => <div key={i} className={`pill chip cat-anim-finding ${f.severity === "error" ? "err" : f.severity === "warning" ? "warn" : "muted"}`} style={sx("margin-top:6px")}>{f.message}</div>)}
          <div style={sx("margin-top:8px")}>
            {catAnimPairs(sc.sprites[donor]!.labels || {}).map((pair) => {
              const placed = pair.frames.map((fr) => (fr.frame === null ? null : placedRef(sc, donor, fr.frame)));
              const rig = placed.find((r) => r && sc.sprites[r] && sc.sprites[r]!.rig === "cat") || null;
              return (
                <div key={pair.name} className="artrow cat-anim">
                  <span className="id mono">{pair.name}</span>
                  <span className="meta">
                    {pair.frames.map((fr) => <span key={fr.label} className={`pill chip cat-anim-label ${fr.frame === null ? "err" : ""}`} style={sx("margin-right:6px")} title={fr.frame === null ? "missing facing" : `frame ${fr.frame}`}>{fr.label}</span>)}
                  </span>
                  <span className="meta mono">{placed.map((r, i) => `${CAT_ANIM_FACINGS[i]}: ${r || "(nothing)"}`).join(" · ")}</span>
                  <div className="grow" />
                  {rig ? <button className="btn ghost sm" onClick={() => { A.set({ subtab: "timeline" }); setTarget(rig); }}>Animate pose</button> : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );

  function addAnimation() {
    const name = animName.trim();
    if (!name) return;
    apply(newCatAnimation(sc, name), () => {
      setAnimName("");
      toast(`added cat animation "${name}": frames ${name}F / ${name}B placing the rig "${name}Pose"`);
    });
  }
}

/** What the donor's layers place at `frame` (the first layer with something there, in depth order). */
function placedRef(sc: Scene, spriteId: string, frame: number): string | null {
  const sp = sc.sprites[spriteId];
  if (!sp) return null;
  for (const layer of sp.layers.slice().sort((a, b) => a.depth - b.depth)) {
    let ref: string | null = null;
    let best = -1;
    for (const k of layer.keys || []) if (k.frame <= frame && k.frame > best) { best = k.frame; ref = k.ref ?? null; }
    if (ref) return ref;
  }
  return null;
}
