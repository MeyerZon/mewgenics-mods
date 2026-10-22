// Art-mode center tab "VectorCraft": the vendored VectorCraft web build in a same-origin iframe (vectorcraft-host.ts).
// "Open in VectorCraft" hands one shape over as the SVG svg-export.ts writes; "Apply to shape" exports the
// document back (presentation attributes, text outlined), undoes the artboard re-origin (svg-reorigin.ts) and
// replaces the shape through the same /api/art/import-svg path Replace… uses. Nothing is written to disk until
// the top-bar Save (Ctrl+S). ArtCenter mounts the panel once, outside the per-scene panel, and parks it off-screen while
// another sub-tab (or no scene) shows, so the 74 MB app, its document and its undo history survive tab and scene
// switches (moving the iframe in the DOM would reload it). A document remembers the mod and scene it came from; while
// another scene is open, Apply is off and the status names the scene the drawing belongs to.
// Static drawing only — animation stays in the Timeline tab. VectorCraft is a product name of the ArtCraft Team
// (no logo is shown: the brand files are not open source).

import React, { useEffect, useRef, useState } from "react";
import { useStore } from "../store.ts";
import { S, toast } from "../state.ts";
import { A, getScene, openShapeInVectorcraft, applyVectorcraftSvg, shapeSvgFor, setVcDirty, setVcShape } from "./art-state.ts";
import { sx } from "./Bits.tsx";
import { apiOf, exportSvg, isDirty, isVendored, openSvg, vectorcraftUrl, waitForApi } from "./vectorcraft-host.ts";
import type { VcApi } from "./vectorcraft-host.ts";

type Phase = "checking" | "absent" | "idle" | "loading" | "ready" | "failed";

interface OpenDoc { shapeId: string; name: string; viewBox: number[]; mod: string; scenePath: string }

export function VectorcraftPanel({ active }: { active: boolean }) {
  const vcShape = useStore(A, (a) => a.vcShape);
  const vcRequest = useStore(A, (a) => a.vcRequest);
  const scenePath = useStore(A, (a) => a.scenePath);
  const mod = useStore(S, (s) => s.mod);
  useStore(A, (a) => a.rev);
  const sc = getScene();
  const ids = Object.keys(sc?.shapes || {});
  const [phase, setPhase] = useState<Phase>("checking");
  const [src, setSrc] = useState("");
  const [webgl, setWebgl] = useState(false);
  const [doc, setDoc] = useState<OpenDoc | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const frame = useRef<HTMLIFrameElement | null>(null);
  const api = useRef<VcApi | null>(null);
  const handled = useRef(0);

  // is the web build vendored? (VENDORED.json next to index.html)
  useEffect(() => {
    let live = true;
    void isVendored().then((v) => { if (live) setPhase(v ? "idle" : "absent"); });
    return () => { live = false; };
  }, []);

  // first activation starts the (74 MB) load; later activations find it running
  useEffect(() => {
    if (active && phase === "idle" && !src) {
      setSrc(vectorcraftUrl({ webgl }));
      setPhase("loading");
    }
  }, [active, phase, src, webgl]);

  // wait for window.vectorcraft in the iframe
  useEffect(() => {
    if (!src || phase !== "loading") return;
    let live = true;
    const el = frame.current;
    if (!el) return;
    waitForApi(el).then((a) => { if (!live) return; api.current = a; setError(""); setPhase("ready"); }).catch((e) => { if (!live) return; setError(e instanceof Error ? e.message : String(e)); setPhase("failed"); });
    return () => { live = false; };
  }, [src, phase]);

  // an "Open in VectorCraft" request (from a Shapes row or the Open button) once the app runs
  useEffect(() => {
    if (phase !== "ready" || !api.current || vcRequest === handled.current || !vcShape) return;
    handled.current = vcRequest;
    const a = api.current;
    const r = shapeSvgFor(vcShape);
    if (!r) { toast(`no shape "${vcShape}"`); return; }
    setBusy(`opening ${vcShape}.svg…`);
    void openSvg(a, `${vcShape}.svg`, r.svg).then((ok) => {
      setBusy("");
      if (!ok) { toast(`VectorCraft did not open ${vcShape}.svg`); return; }
      setDoc({ shapeId: vcShape, name: `${vcShape}.svg`, viewBox: r.viewBox, mod: S.get().mod, scenePath: A.get().scenePath });
      setDirty(false);
    });
  }, [phase, vcRequest, vcShape]);

  // the open document belongs to the scene it was opened from
  const ours = !!doc && doc.mod === mod && doc.scenePath === scenePath;
  // the shell's unsaved-work guard (dirty.ts "vc") sees an edited document of the open scene (another scene's drawing
  // already went through the guard when that scene was left)
  useEffect(() => { setVcDirty(ours && dirty); }, [ours, dirty]);
  useEffect(() => () => setVcDirty(false), []);

  // the app has no change events: poll the dirty flag while the tab is visible
  useEffect(() => {
    if (phase !== "ready" || !active || !doc) return;
    const a = apiOf(frame.current);
    if (!a) return;
    const t = setInterval(() => { void isDirty(a).then(setDirty).catch(() => undefined); }, 1000);
    return () => clearInterval(t);
  }, [phase, active, doc]);

  async function apply() {
    const a = api.current;
    if (!a || !doc || !ours) return;
    setBusy("exporting…");
    try {
      const svg = await exportSvg(a);
      await applyVectorcraftSvg(doc.shapeId, svg, doc.viewBox);
    } catch (e) {
      toast(`apply failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy("");
    }
  }

  function retryWebgl() {
    api.current = null;
    setDoc(null);
    setWebgl(true);
    setSrc("");
    setPhase("idle");
  }

  const status =
    phase === "checking" ? "checking for the vendored build…"
    : phase === "absent" ? "VectorCraft is not vendored — run `npm run build` in editor/ once while online (scripts/vendor-vectorcraft.ts downloads the pinned web build, 27 MB) and reload."
    : phase === "idle" ? "ready to load"
    : phase === "loading" ? "loading VectorCraft… (a 74 MB wasm; the first start takes a while)"
    : phase === "failed" ? `${error} — the renderer may be unavailable; retry with WebGL2 forced.`
    : busy ? busy
    : doc && !ours ? `${doc.name} belongs to the scene ${doc.scenePath}${doc.mod !== mod ? ` of ${doc.mod}` : ""} — open that scene to apply it, or Open a shape of this one`
    : doc ? `${doc.name} open (viewBox ${doc.viewBox.join(" ")})${dirty ? " — edited" : ""}`
    : "running — pick a shape and press Open";

  const vb = (sc?.shapes && vcShape && sc.shapes[vcShape]) ? vcShape : (ids[0] || "");
  return (
    <div className="vcpanel" style={active ? undefined : sx("position:absolute;left:-20000px;top:0;width:1000px;height:700px;visibility:hidden")}>
      <p className="muted vc-caption">VectorCraft (github.com/storytold/vectorcraft, MIT OR Apache-2.0, the pinned web build) — static drawing of one shape at a time. Open hands the shape over as SVG; Apply brings the drawing back over the same shape at its own coordinates (the artboard re-origin is undone). Animation stays in the Timeline tab.</p>
      <div style={sx("display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px")}>
        <select className="vc-shape" value={vb} onChange={(e) => setVcShape(e.target.value)} disabled={!ids.length}>
          {ids.length ? ids.map((id) => <option key={id} value={id}>{id}</option>) : <option value="">— no shapes —</option>}
        </select>
        <button className="btn sm vc-open" disabled={!vb || phase === "absent" || phase === "failed" || !!busy} onClick={() => openShapeInVectorcraft(vb)} title="Export the shape as SVG and open it in VectorCraft">Open in VectorCraft</button>
        <button className="btn primary sm vc-apply" disabled={!ours || !dirty || !!busy || phase !== "ready"} onClick={() => void apply()} title="Export the VectorCraft document as SVG and replace the shape with it (in memory; Save in the top bar writes it)">Apply to shape</button>
        {phase === "failed" ? <button className="btn ghost sm vc-retry" onClick={retryWebgl}>Retry with WebGL2</button> : null}
      </div>
      <div className="vc-status muted">{status}</div>
      {src ? <iframe key={src} ref={frame} className="vc-frame" src={src} title="VectorCraft vector illustration app" allow="clipboard-read; clipboard-write" /> : null}
    </div>
  );
}
