// The guided tours (Data, Art, Rooms) rendered through one shared card. A step with a `target` is an anchored
// coachmark: a spotlight over the element carrying that `data-tour` id (tour-anchors.ts) and the card beside it,
// re-measured on resize and when the target resizes. With no target on screen (or `?tour=center`) the card sits
// centred, as before. Esc and Skip close (= seen); a click on the dimmed page does nothing.

import React from "react";
import { onboarding, type TourKind, type AppState } from "../state.ts";
import { useS, sx } from "./ui.tsx";
import { closeTour, closeArtTour, closeRoomTour, setTourStep, setTourDontShow, ensureMode } from "../actions.ts";
import { useDialog } from "../hooks/useDialog.ts";
import { TOUR, tourSelector, isOnScreen, placeCard, type Rect, type CardPlacement } from "../tour-anchors.ts";

export interface TourStep {
  /** stable identity (the React key) */
  id: string;
  t: string;
  b: string;
  /** the anchor(s) to spotlight: the first one present in the DOM wins */
  target?: string | readonly string[];
  /** runs when the step becomes current (e.g. switch to the mode its target lives in) */
  onEnter?: () => void;
}

const toData = () => ensureMode("data");
const toArt = () => ensureMode("art");
const toRooms = () => ensureMode("rooms");

export const DATA_TOUR: TourStep[] = [
  {
    id: "browse",
    t: "Browse the base game",
    b: "Every ability, item, passive, and the behavior components live in the left panel, read-only. Open one to see the exact shape your overlay will extend or override.",
    target: TOUR.explorerBase,
    onEnter: toData,
  },
  {
    id: "create",
    t: "Create an overlay",
    b: "Scaffold a new ability, item, passive, or status from a template, or add an overlay file. .append adds new entries, .merge changes values, .patch sets per-field policy.",
    target: [TOUR.newOverlay, TOUR.explorerFiles],
    onEnter: toData,
  },
  {
    id: "edit",
    t: "Edit with live validation",
    b: "Type in the GON editor. Every keystroke is re-checked — reference integrity, localization, overlay target, and GON syntax — before the game ever sees it; the Validation tab lists what it found.",
    target: TOUR.editor,
    onEnter: toData,
  },
  {
    id: "preview",
    t: "Read the merge preview",
    b: "The Preview tab shows the effective entry: base data plus your overlay, so you can see exactly what the game will load.",
    target: [TOUR.preview, TOUR.validation],
    onEnter: toData,
  },
  {
    id: "launch",
    t: "Launch on the dev save",
    b: "Launch… in the top bar shows the command for your mod with a Copy button. Run it from the repo root with Steam open: it adds -savesuffix dev, so your real saves are never touched. The editor never starts the game itself.",
    target: TOUR.launch,
    onEnter: toData,
  },
];

// Opened the first time the user enters Art mode, and from Help / the Art empty state.
export const ART_TOUR: TourStep[] = [
  {
    id: "switch",
    t: "Switch to Art",
    b: "The top-bar Data | Art | Rooms switch flips the whole editor. Data edits GON/CSV overlays, Art authors vector scenes and builds them into the SWF subset the engine loads, Rooms paints levels. All of them only ever write under mods/<name>/ — your saves are never touched.",
    target: TOUR.artSwitch,
  },
  {
    id: "scenes",
    t: "Scenes & shapes explorer",
    b: "The left panel lists your art/*.scene.json scenes, the swfs/ you've built, and imported assets. A scene holds shapes (vector paths), sprites (timelines with frame labels), and exports (the SymbolClass names GON addresses).",
    target: TOUR.artScenes,
    onEnter: toArt,
  },
  {
    id: "import",
    t: "Import an SVG or PNG",
    b: "Drop an SVG (Inkscape, Illustrator, VectorCraft…) or a PNG on the Import card, or click it to pick one. Each SVG becomes one shape; gradients and text are supported. A PNG becomes a sprite, a background plate or a bitmap fill. Anything the engine can't draw is reported as a finding, never dropped silently.",
    target: TOUR.artImport,
    onEnter: toArt,
  },
  {
    id: "gray",
    t: "Grayscale → palette",
    b: "The engine stores art as 16-level grayscale and recolors it at runtime through one shared textures/palette.png row. Author fills as gray:0–15; non-gray colours pass through unremapped and are flagged. Each shape's gray ramp in the Shapes tab shows the levels it uses.",
    target: [TOUR.artShapes, TOUR.artImport],
    onEnter: toArt,
  },
  {
    id: "preview",
    t: "In-game-faithful preview",
    b: "The Preview tab draws the scene exactly as the engine does — the same grayscale→palette-row remap, timeline playback and a frame-label scrubber. Browse rows… picks the palette row; the View options card has show raw gray (the authored levels), the canvas background and a ghost cat on a parts: game rig.",
    target: TOUR.artPreview,
    onEnter: toArt,
  },
  {
    id: "build",
    t: "Build the SWF",
    b: "Build emits mods/<mod>/swfs/<name>.swf (uncompressed v17) plus a swflist.gon.append. SymbolClass binds the export names; the DoABC stub is optional. Play the result in the Ruffle tab, or Inspect a built SWF from the explorer.",
    target: TOUR.artBuild,
    onEnter: toArt,
  },
  {
    id: "more",
    t: "Timeline, Rig, VectorCraft",
    b: "The scene's sub-tabs go further: Timeline keys a sprite's layers frame by frame, Rig binds parts to the game's cat rig, and VectorCraft opens a shape in a full vector editor right here. Exports and JSON show what ships.",
    target: TOUR.artSubtabs,
    onEnter: toArt,
  },
];

// Opened the first time the user enters Rooms mode, and from Help / the Rooms empty state.
export const ROOM_TOUR: TourStep[] = [
  {
    id: "rooms",
    t: "Switch to Rooms, open or create a room",
    b: "The top-bar Data | Art | Rooms switch opens the Room editor. The left panel lists the mod's levels/**.lvl rooms; + New room makes a 10×10 one under mods/<mod>/levels/.",
    target: [TOUR.roomsList, TOUR.roomsSwitch],
  },
  {
    id: "brush",
    t: "Pick a brush",
    b: "The Palette lists tiles (tiles.gon) and objects (spawns.gon): the base game's plus your mod's overlays. Switch Tiles | Objects, filter by name or id, and click one to make it the brush.",
    target: TOUR.roomsPalette,
    onEnter: toRooms,
  },
  {
    id: "paint",
    t: "Paint the grid",
    b: "Click or drag to paint. The toolbar picks the tool (Select, Tile, Object, Erase) and the view: Flat, or Iso as the game draws the board. Keyboard: Tab into the grid, the arrows move the selection, Enter or Space applies the brush.",
    target: TOUR.roomsGrid,
    onEnter: toRooms,
  },
  {
    id: "inspect",
    t: "Inspect a cell",
    b: "The Inspector shows the selected cell's tile and objects. Any id can become a weighted random list, so the game picks one each time the room loads.",
    target: TOUR.roomsInspector,
    onEnter: toRooms,
  },
  {
    id: "ship",
    t: "Findings, save, test it in a fight",
    b: "The Findings tab lists the room's lvl-* checks (no PlayerSpawn, an unknown tile or spawn id…). Save with Ctrl+S — rooms are only written under mods/<mod>/levels/. Then Launch… and, in a test fight, load <folder>/<name> from the console.",
    target: [TOUR.roomsFindings, TOUR.launch],
    onEnter: toRooms,
  },
];

const targetsOf = (t: TourStep["target"]): readonly string[] => (t === undefined ? [] : typeof t === "string" ? [t] : t);

function findTarget(ids: readonly string[]): HTMLElement | null {
  for (const id of ids) {
    const el = document.querySelector<HTMLElement>(tourSelector(id));
    if (el) return el;
  }
  return null;
}

interface Layout {
  spot: Rect;
  place: CardPlacement;
}
const SPOT_PAD = 4;
const sameLayout = (a: Layout | null, b: Layout | null): boolean =>
  a === b ||
  (!!a &&
    !!b &&
    a.place.side === b.place.side &&
    Math.abs(a.place.left - b.place.left) < 0.5 &&
    Math.abs(a.place.top - b.place.top) < 0.5 &&
    Math.abs(a.place.arrow - b.place.arrow) < 0.5 &&
    Math.abs(a.spot.left - b.spot.left) < 0.5 &&
    Math.abs(a.spot.top - b.spot.top) < 0.5 &&
    Math.abs(a.spot.width - b.spot.width) < 0.5 &&
    Math.abs(a.spot.height - b.spot.height) < 0.5);

/**
 * Where the spotlight and the card go for the current step, or null for the centred card. Re-measured on resize,
 * when the target or the card resizes, and every 300 ms (a target that renders late: a lazy pane, a mode switch).
 */
function useAnchorLayout(ids: readonly string[], cardRef: React.RefObject<HTMLElement | null>, centered: boolean): Layout | null {
  const [layout, setLayout] = React.useState<Layout | null>(null);
  const key = ids.join(" ");
  React.useLayoutEffect(() => {
    if (centered || !ids.length) {
      setLayout(null);
      return;
    }
    let scrolled = false;
    let observed: HTMLElement | null = null;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => measure()) : null;
    function measure(): void {
      const el = findTarget(ids);
      const card = cardRef.current;
      if (el !== observed && ro) {
        if (observed) ro.unobserve(observed);
        if (el) ro.observe(el);
        observed = el;
      }
      if (!el || !card) {
        setLayout((prev) => (prev === null ? prev : null));
        return;
      }
      const vp = { width: window.innerWidth, height: window.innerHeight };
      let r = el.getBoundingClientRect();
      if (!scrolled && (r.top < 0 || r.bottom > vp.height || r.left < 0 || r.right > vp.width)) {
        scrolled = true; // bring it into view once per step (a section below the fold of a scrolling explorer)
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
        r = el.getBoundingClientRect();
      }
      if (!isOnScreen(r, vp)) {
        setLayout((prev) => (prev === null ? prev : null));
        return;
      }
      const spot = { left: r.left - SPOT_PAD, top: r.top - SPOT_PAD, width: r.width + 2 * SPOT_PAD, height: r.height + 2 * SPOT_PAD };
      const place = placeCard(spot, vp, { width: card.offsetWidth, height: card.offsetHeight });
      const next = { spot, place };
      setLayout((prev) => (sameLayout(prev, next) ? prev : next));
    }
    measure();
    if (ro && cardRef.current) ro.observe(cardRef.current);
    const timer = setInterval(measure, 300);
    window.addEventListener("resize", measure);
    return () => {
      clearInterval(timer);
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
    // `key` stands for `ids` (a fresh array per render)
  }, [key, centered, cardRef]);
  return layout;
}

const StepRow = React.memo(function StepRow({ n, title, state }: { n: number; title: string; state: "done" | "on" | "off" }): React.JSX.Element {
  return (
    <div style={sx("display:flex;gap:10px;align-items:center;font-size:13px;color:" + (state === "on" ? "var(--ink)" : "var(--muted)"))}>
      <span className={"stepnum " + state}>{state === "done" ? "✓" : String(n)}</span>
      {title}
    </div>
  );
});

interface GuidedTourProps {
  kind: TourKind;
  steps: TourStep[];
  title: string;
  onClose: () => void;
}

const STEP_OF: Record<TourKind, (s: AppState) => number> = { data: (s) => s.tourStep, art: (s) => s.artTourStep, rooms: (s) => s.roomTourStep };
const DONT_OF: Record<TourKind, (s: AppState) => boolean> = { data: (s) => s.tourDontShow, art: (s) => s.artTourDontShow, rooms: (s) => s.roomTourDontShow };

/** The shared tour card: every tour renders through this, so they stay identical in look and behaviour. */
export function GuidedTour({ kind, steps, title, onClose }: GuidedTourProps): React.JSX.Element {
  const rawStep = useS(STEP_OF[kind]);
  const dontShow = useS(DONT_OF[kind]);
  const step = Math.max(0, Math.min(steps.length - 1, rawStep));
  const last = step >= steps.length - 1;
  const cur = steps[step]!;
  const ref = useDialog<HTMLDivElement>(true, { onClose, kind: "tour", initialFocus: ".btn.primary" });
  React.useEffect(() => {
    cur.onEnter?.();
  }, [cur]);
  const layout = useAnchorLayout(targetsOf(cur.target), ref, onboarding.tourCentered);
  const place = layout?.place;
  const go = (n: number) => setTourStep(kind, n);
  return (
    <div className={"scrim " + (layout ? "tour-anchored" : "center")}>
      {layout ? <div className="tour-spot" aria-hidden="true" style={{ left: layout.spot.left, top: layout.spot.top, width: layout.spot.width, height: layout.spot.height }} /> : null}
      <div ref={ref} className={"tourcard" + (place ? ` anchored side-${place.side}` : "")} aria-label={title} style={place ? { left: place.left, top: place.top } : undefined}>
        {place && place.side !== "over" ? (
          <span className="tour-arrow" aria-hidden="true" style={place.side === "left" || place.side === "right" ? { top: place.arrow - 7 } : { left: place.arrow - 7 }} />
        ) : null}
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
            <StepRow key={s.id} n={i + 1} title={s.t} state={i < step ? "done" : i === step ? "on" : "off"} />
          ))}
        </div>
        <div style={sx("display:flex;align-items:center;gap:14px")}>
          <div className="dots" style={sx("flex:1")}>
            {steps.map((s, i) => (
              <span key={s.id} className={"dot" + (i === step ? " on" : "")} />
            ))}
          </div>
          <label style={sx("display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);cursor:pointer")}>
            <input type="checkbox" checked={dontShow} onChange={(e) => setTourDontShow(kind, e.currentTarget.checked)} />
            Don't show again
          </label>
        </div>
        <div style={sx("display:flex;gap:10px;margin-top:16px")}>
          {step > 0 ? (
            <button className="btn ghost" onClick={() => go(step - 1)}>
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
            <button className="btn primary" onClick={() => go(step + 1)}>
              Next →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function TourModal(): React.JSX.Element {
  return <GuidedTour kind="data" steps={DATA_TOUR} title="Guided tour" onClose={closeTour} />;
}

export function ArtTourModal(): React.JSX.Element {
  return <GuidedTour kind="art" steps={ART_TOUR} title="Art mode tour" onClose={closeArtTour} />;
}

export function RoomTourModal(): React.JSX.Element {
  return <GuidedTour kind="rooms" steps={ROOM_TOUR} title="Rooms mode tour" onClose={closeRoomTour} />;
}
