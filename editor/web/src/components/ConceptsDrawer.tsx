// The concepts explainer drawer: Data-mode, Art-mode and Rooms-mode sections, the current mode first (Help ▸ Rooms
// concepts scrolls to the Rooms section).

import React from "react";
import { useS, sx, Drawer, Button } from "./ui.tsx";
import { closeConcepts } from "../actions.ts";

function ConceptCard({ kind, tag, title, body }: { kind: string; tag: string; title: string; body: string }): React.JSX.Element {
  return (
    <div className="card plain">
      <span className={`tag pill ${kind}`}>{tag}</span>
      <div style={sx("font-weight:700;font-size:14px;margin:10px 0 6px;color:var(--ink)")}>{title}</div>
      <div style={sx("font-size:12.5px;color:var(--ink2);line-height:1.6")}>{body}</div>
    </div>
  );
}

function CheckCard({ title, body }: { title: string; body: string }): React.JSX.Element {
  return (
    <div className="card plain" style={sx("display:flex;gap:12px")}>
      <span className="dotok" style={sx("font-size:16px")}>
        ✓
      </span>
      <div>
        <b style={sx("font-size:13.5px")}>{title}</b>
        <div style={sx("font-size:12.5px;color:var(--ink2);line-height:1.6;margin-top:3px")}>{body}</div>
      </div>
    </div>
  );
}

// The data-layer concepts, grouped under a heading so the drawer can also carry the
// Art-mode section below/above it.
function DataConceptsSection(): React.JSX.Element {
  return (
    <div data-section="data" style={sx("margin-bottom:30px")}>
      <div style={sx("font-weight:700;font-size:15px;color:var(--ink);margin:0 0 14px")}>Data mode — GON/CSV overlays</div>
      <div className="sec" style={sx("margin-bottom:12px")}>
        Overlay kinds — how a mod file changes base data
      </div>
      <div className="grid3" style={sx("margin-bottom:26px")}>
        <ConceptCard kind="append" tag=".append" title="Add new entries" body="Children are added at the end. Use it for a brand-new ability, item, or status. Safest — rarely collides." />
        <ConceptCard kind="merge" tag=".merge" title="Change values" body="Deep-merges onto an existing entry — only the fields you name change. Use it to rebalance." />
        <ConceptCard kind="patch" tag=".patch" title="Per-field policy" body="Each field picks .overwrite / .append / .add / .multiply. Use it for precise numeric tweaks." />
      </div>
      <div className="sec" style={sx("margin-bottom:12px")}>
        What the validator checks — before the game ever sees it
      </div>
      <div className="grid2" style={sx("margin-bottom:12px")}>
        <CheckCard title="Reference integrity" body="Every status / ability / component name you mention actually resolves." />
        <CheckCard title="Localization" body="Text keys exist in all 12 language columns." />
        <CheckCard title="Overlay target" body="A .merge/.patch points at a key that exists." />
        <CheckCard title="Merge preview" body="Shows the effective result, base + overlay." />
      </div>
      <p className="muted" style={sx("margin:0 0 26px;font-size:12.5px")}>
        This is the check that would have caught the crash from a status name that didn't resolve.
      </p>
      <div className="sec" style={sx("margin-bottom:12px")}>
        Data ↔ native — where a name becomes real
      </div>
      <div className="card plain" style={sx("padding:20px")}>
        <div className="seam">
          <div className="box">
            <div className="sec" style={sx("color:var(--acc-ink)")}>
              Data layer
            </div>
            <div className="mono" style={sx("font-size:12.5px;margin-top:8px;color:var(--ink)")}>
              {"effects { JokersLuck 1 }"}
            </div>
            <div style={sx("font-size:11.5px;color:var(--muted);margin-top:6px")}>GON overlay references a name</div>
          </div>
          <span className="arrow">→</span>
          <div className="box" style={sx("flex:0 0 150px;background:var(--accbg)")}>
            <div className="mono" style={sx("font-size:12px;color:var(--acc-ink)")}>
              registered-names.json
            </div>
            <div style={sx("font-size:11.5px;color:var(--ink2);margin-top:6px")}>the seam</div>
          </div>
          <span className="arrow">→</span>
          <div className="box">
            <div className="sec" style={sx("color:var(--syn-cls)")}>
              Native layer
            </div>
            <div className="mono" style={sx("font-size:12.5px;margin-top:8px;color:var(--ink)")}>
              {'FW_RegisterStatus("JokersLuck")'}
            </div>
            <div style={sx("font-size:11.5px;color:var(--muted);margin-top:6px")}>DLL supplies the behavior</div>
          </div>
        </div>
        <p style={sx("font-size:12.5px;color:var(--ink2);line-height:1.6;margin:14px 0 0")}>
          A native mod registers a name; the editor reads that list so your data overlay validates against it. That's how new mechanics the data layer can't express still plug into GON by name.
        </p>
      </div>
    </div>
  );
}

// Art-mode concepts: grayscale→palette recolor, the SWF subset, the faithful preview, and how the export names bind
// (docs/art-preview-plan.md §2–3, §7).
function ArtConceptsSection(): React.JSX.Element {
  return (
    <div data-section="art" style={sx("margin-bottom:30px")}>
      <div style={sx("font-weight:700;font-size:15px;color:var(--ink);margin:0 0 14px")}>Art mode — vector scenes the engine recolors</div>
      <div className="sec" style={sx("margin-bottom:12px")}>
        Grayscale art, recolored at runtime
      </div>
      <div className="card plain" style={sx("padding:18px;margin-bottom:22px")}>
        <p style={sx("font-size:12.5px;color:var(--ink2);line-height:1.6;margin:0 0 12px")}>
          You author in 16 levels of gray (
          <span className="mono" style={sx("color:var(--acc-ink)")}>
            gray:0–15
          </span>
          ). The engine remaps each level through one row of the shared <span className="mono">textures/palette.png</span> (16×256) — so the same art reskins per cat / class / UI just by changing the row. Non-gray colours pass through
          unremapped and are flagged <span className="mono">passthrough-fill</span>.
        </p>
        <div className="ramp big" role="img" aria-label="a 16-step gray ramp becomes a 16-colour palette row" style={sx("margin-bottom:6px")}>
          {Array.from({ length: 16 }, (_, i) => (
            <span key={`gray-${i}`} style={{ background: `rgb(${i * 17},${i * 17},${i * 17})` }} />
          ))}
        </div>
        <div style={sx("font-size:11.5px;color:var(--muted)")}>authored gray:0 → gray:15 — the Preview shows the real palette row in these 16 slots</div>
      </div>
      <div className="grid2" style={sx("margin-bottom:22px")}>
        <ConceptCard
          kind="append"
          tag="scene.json"
          title="The source model"
          body="Shapes (DefineShape3 paths), sprites (DefineSprite timelines with frame labels), and exports (SymbolClass linkage names GON addresses). Hand-editable and diff-friendly."
        />
        <ConceptCard
          kind="append"
          tag=".swf v17"
          title="The minimal subset"
          body="Build emits an uncompressed FWS v17 with exactly what glaiel::swf reads — DefineShape3 + DefineSprite + PlaceObject2 + SymbolClass, with gradient fills, text and PNG bitmaps — plus a swflist.gon.append. SymbolClass binds the export names; the DoABC stub is optional."
        />
      </div>
      <div className="sec" style={sx("margin-bottom:12px")}>
        The in-game-faithful preview
      </div>
      <div className="grid2" style={sx("margin-bottom:22px")}>
        <CheckCard
          title="Same code as the emitter"
          body="The preview bakes frames and normalizes paths with the same pure modules the SWF emitter uses, then runs a literal port of paletted_full.shader — so what you see is what the engine draws."
        />
        <CheckCard title="Scrub, recolor, inspect" body="Timeline scrubber with frame-label ticks, Browse rows… for the palette row, and the View options: show raw gray (the authored levels before the remap), the background and a ghost cat." />
      </div>
    </div>
  );
}

// Rooms-mode concepts: the .lvl grid, where tiles and objects come from, random lists, the checks, where it saves
// (docs/data-mods.md "Maps, rooms and encounters").
function RoomsConceptsSection(): React.JSX.Element {
  return (
    <div data-section="rooms" style={sx("margin-bottom:8px")}>
      <div style={sx("font-weight:700;font-size:15px;color:var(--ink);margin:0 0 14px")}>Rooms mode — 10×10 .lvl grids</div>
      <div className="grid2" style={sx("margin-bottom:22px")}>
        <ConceptCard kind="append" tag="tiles.gon" title="Tiles" body="Each cell holds a tile id from data/tiles.gon (ground, water, mud…): the base game's tiles plus any your mod adds with a tiles.gon.append." />
        <ConceptCard kind="append" tag="spawns.gon" title="Objects" body="Enemies, props and the PlayerSpawn cells are spawns.gon ids placed on cells; base and mod overlays both show in the Palette." />
        <ConceptCard kind="merge" tag="random" title="Weighted random lists" body="Any tile or object id can instead be a weighted list; the game picks one each time the room loads. The Inspector edits the weights." />
        <ConceptCard kind="patch" tag=".lvl" title="The binary file" body="A room is levels/<folder>/<name>.lvl. Saves only ever land under mods/<mod>/levels/; play one in a test fight with the console command load <folder>/<name>." />
      </div>
      <div className="sec" style={sx("margin-bottom:12px")}>
        What the room checks catch
      </div>
      <div className="grid2">
        <CheckCard title="lvl-no-player-spawn" body="A room the cats cannot enter: no PlayerSpawn cell." />
        <CheckCard title="lvl-unknown-tile-id / lvl-unknown-spawn-id" body="An id neither the base data nor your mod defines." />
        <CheckCard title="lvl-bad-format" body="A file that does not decode as a 10×10 level." />
        <CheckCard title="lvl-outside-levels" body="A .lvl that is not under levels/, where the game never looks." />
      </div>
    </div>
  );
}

const ORDER: Record<"data" | "art" | "rooms", ("data" | "art" | "rooms")[]> = {
  data: ["data", "art", "rooms"],
  art: ["art", "data", "rooms"],
  rooms: ["rooms", "data", "art"],
};
const SECTION = { data: DataConceptsSection, art: ArtConceptsSection, rooms: RoomsConceptsSection };
const DOCS = { data: "docs/data-mods.md", art: "docs/art-preview-plan.md", rooms: "docs/data-mods.md" };

export function ConceptsDrawer(): React.JSX.Element {
  const artMode = useS((s) => s.artMode);
  const roomMode = useS((s) => s.roomMode);
  const mode = roomMode ? "rooms" : artMode ? "art" : "data";
  const ref = React.useRef<HTMLDivElement | null>(null);
  // Help ▸ Rooms concepts opens the drawer on the Rooms section
  const section = useS((s) => s.conceptsSection);
  React.useEffect(() => {
    if (!section) return;
    const el = ref.current?.closest(".drawer")?.querySelector<HTMLElement>(`[data-section="${section}"]`);
    el?.scrollIntoView({ block: "start" });
  }, [section]);
  return (
    <Drawer
      title="How modding works here"
      icon={<span style={sx("font-size:20px")}>✦</span>}
      onClose={closeConcepts}
      footer={
        <>
          <span ref={ref} className="muted" style={sx("flex:1;font-size:12.5px")}>
            More in <span className="mono">{DOCS[mode]}</span>
          </span>
          <Button variant="primary" onClick={closeConcepts}>
            Got it
          </Button>
        </>
      }
    >
      {/* All three modes are explained; the current one is shown first. */}
      {ORDER[mode].map((m) => {
        const Section = SECTION[m];
        return <Section key={m} />;
      })}
    </Drawer>
  );
}
