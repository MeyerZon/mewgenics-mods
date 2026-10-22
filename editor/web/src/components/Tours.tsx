// The first-run guided tours (data mode and art mode) rendered through one shared card.

import React from "react";
import { S } from "../state.ts";
import { useS, sx } from "./ui.tsx";
import { closeTour, closeArtTour } from "../actions.ts";
import { useDialog } from "../hooks/useDialog.ts";

interface TourStep {
  t: string;
  b: string;
}

const TOUR: TourStep[] = [
  { t: "Browse the base game", b: "Every ability, item, passive, and the behavior components live in the left panel, read-only. Open one to see the exact shape your overlay will extend or override." },
  { t: "Create an overlay", b: "Scaffold a new ability, item, passive, or status from a template, or add an overlay file. .append adds new entries, .merge changes values, .patch sets per-field policy." },
  { t: "Edit with live validation", b: "Type in the GON editor. Every keystroke is re-checked — reference integrity, localization, overlay target, and GON syntax — before the game ever sees it." },
  { t: "Read the merge preview", b: "The Preview tab shows the effective entry: base data plus your overlay, so you can see exactly what the game will load." },
  { t: "Launch the dev save", b: "Launch Mewgenics with -modpaths pointing at your mod and a -savesuffix dev, so your real saves are never touched." },
];
// Art-mode first-run tour. Triggered the first time the user enters Art mode (and
// re-openable from Help), persisted under the same onboarding key family as the data tour.
const ART_TOUR: TourStep[] = [
  {
    t: "Switch Data → Art",
    b: "The top-bar Data | Art switch flips the whole editor. Data mode edits GON/CSV overlays; Art mode authors vector scenes and builds them into the SWF subset the engine loads. Both only ever write under mods/<name>/ — your saves are never touched.",
  },
  {
    t: "Scenes & shapes explorer",
    b: "The left panel lists your art/*.scene.json scenes, the swfs/ you've built, and imported assets. A scene holds shapes (vector paths), sprites (timelines with frame labels), and exports (the SymbolClass names GON addresses).",
  },
  {
    t: "Import an SVG",
    b: "Drop an SVG (Inkscape, Illustrator, VectorCraft…) onto the Art panel, or use the picker. Each SVG becomes one shape; unsupported features (gradients, filters, text) are reported as findings, never dropped silently.",
  },
  {
    t: "Grayscale → palette",
    b: "The engine stores art as 16-level grayscale and recolors it at runtime through one shared textures/palette.png row. Author fills as gray:0–15; non-gray colours pass through unremapped and are flagged. Each shape's gray ramp shows the levels it uses.",
  },
  {
    t: "In-game-faithful preview",
    b: "The Preview panel draws the scene exactly as the engine does — the same grayscale→palette-row remap, timeline playback with the frame-label scrubber, a palette-row picker, and a 'show raw grayscale' toggle to see the authored levels.",
  },
  {
    t: "Build the SWF",
    b: "Build emits mods/<mod>/swfs/<name>.swf (uncompressed v17) plus a swflist.gon.append. Build with no DoABC or a stub DoABC — which the engine requires is the one open gate test; run the dev-save procedure from the Build tab. Nothing launches the game for you.",
  },
];

interface GuidedTourProps {
  steps: TourStep[];
  step: number;
  setStep: (n: number) => void;
  dontShow: boolean;
  setDontShow: (v: boolean) => void;
  title: string;
  onClose: () => void;
}

/**
 * Shared guided-tour card. Both the data and art tours render through this so they stay
 * identical in look and behavior; only the steps/state/title/onClose differ.
 */
function GuidedTour({ steps, step, setStep, dontShow, setDontShow, title, onClose }: GuidedTourProps): React.JSX.Element {
  const last = step >= steps.length - 1;
  const cur = steps[step]!;
  const ref = useDialog<HTMLDivElement>(true, { onClose, kind: "tour", initialFocus: ".btn.primary" });
  return (
    <div className="scrim center">
      <div ref={ref} className="tourcard" aria-label={title}>
        <div style={sx("display:flex;align-items:center;gap:8px;margin-bottom:10px")}>
          <span className="chip" style={sx("color:var(--acc-ink);background:var(--accbg)")}>
            {`STEP ${step + 1} OF ${steps.length}`}
          </span>
          <span className="sec">{title}</span>
        </div>
        <h2 style={sx("margin:0 0 8px;font-size:18px")}>{cur.t}</h2>
        <p style={sx("margin:0 0 18px;font-size:13.5px;color:var(--ink2);line-height:1.6")}>{cur.b}</p>
        <div className="steplist" style={sx("margin-bottom:18px")}>
          {steps.map((s, i) => (
            <div key={i} style={sx("display:flex;gap:10px;align-items:center;font-size:13px;color:" + (i === step ? "var(--ink)" : "var(--muted)"))}>
              <span className={"stepnum " + (i < step ? "done" : i === step ? "on" : "off")}>{i < step ? "✓" : String(i + 1)}</span>
              {s.t}
            </div>
          ))}
        </div>
        <div style={sx("display:flex;align-items:center;gap:14px")}>
          <div className="dots" style={sx("flex:1")}>
            {steps.map((_s, i) => (
              <span key={i} className={"dot" + (i === step ? " on" : "")} />
            ))}
          </div>
          <label style={sx("display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);cursor:pointer")}>
            <input type="checkbox" checked={dontShow} onChange={(e) => setDontShow(e.currentTarget.checked)} />
            Don't show again
          </label>
        </div>
        <div style={sx("display:flex;gap:10px;margin-top:16px")}>
          {step > 0 ? (
            <button className="btn ghost" onClick={() => setStep(step - 1)}>
              ← Back
            </button>
          ) : null}
          <div className="grow" />
          <button className="btn ghost" onClick={onClose}>
            Skip
          </button>
          {last ? (
            <button className="btn primary" onClick={onClose}>
              Done
            </button>
          ) : (
            <button className="btn primary" onClick={() => setStep(step + 1)}>
              Next →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function TourModal(): React.JSX.Element {
  const step = useS((s) => s.tourStep);
  const dontShow = useS((s) => s.tourDontShow);
  return <GuidedTour steps={TOUR} step={step} setStep={(n) => S.set({ tourStep: n })} dontShow={dontShow} setDontShow={(v) => S.set({ tourDontShow: v })} title="Guided tour" onClose={closeTour} />;
}

export function ArtTourModal(): React.JSX.Element {
  const step = useS((s) => s.artTourStep);
  const dontShow = useS((s) => s.artTourDontShow);
  return (
    <GuidedTour steps={ART_TOUR} step={step} setStep={(n) => S.set({ artTourStep: n })} dontShow={dontShow} setDontShow={(v) => S.set({ artTourDontShow: v })} title="Art mode tour" onClose={closeArtTour} />
  );
}
