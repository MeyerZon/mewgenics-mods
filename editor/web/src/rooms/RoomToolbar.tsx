// Rooms mode toolbar: the room's path (+ an unsaved dot), the tool and view switches, the brush, the tileset the art
// is drawn in, and Close. Save is the top bar's (and Ctrl+S).

import React from "react";
import { useStoreShallow } from "../store.ts";
import { Segmented, IconButton } from "../components/ui.tsx";
import { R, isDirty, requestCloseLevel, setTool, setView, brushLabel, chooseTileset, firstId, type RoomTool, type RoomView } from "./room-state.ts";
import { usePaletteMaps, entryLabel } from "./RoomBits.tsx";

const TOOLS: { id: RoomTool; label: string; title: string }[] = [
  { id: "select", label: "Select", title: "click a cell to inspect it without changing it" },
  { id: "tile", label: "Tile", title: "click or drag to paint the tile brush" },
  { id: "object", label: "Object", title: "click to put the object brush on a cell (replaces the first object there)" },
  { id: "erase", label: "Erase", title: "click or drag: removes a cell's objects, else clears its tile to 0" },
];

const VIEWS: { id: RoomView; label: string; title: string }[] = [
  { id: "flat", label: "Flat", title: "the 10x10 grid, row 0 on top" },
  { id: "iso", label: "Iso", title: "2:1 diamonds as the game draws the board; sprites stand on their cell" },
];

export function RoomToolbar(): React.JSX.Element {
  const { path, tool, tileBrush, objectBrush, dirty, view, art, tileset } = useStoreShallow(R, (r) => ({
    path: r.path,
    tool: r.tool,
    tileBrush: r.tileBrush,
    objectBrush: r.objectBrush,
    dirty: isDirty(r),
    view: r.view,
    art: r.art,
    tileset: r.tileset,
  }));
  const maps = usePaletteMaps();
  const brush = tool === "tile" ? tileBrush : tool === "object" ? objectBrush : null;
  const brushEntry = brush === null ? undefined : (tool === "tile" ? maps.tiles : maps.objects).get(firstId(brush));
  return (
    <div className="roomtools">
      <span className="roompathwrap">
        <span className="mono roompath">{path}</span>
        {dirty ? <span className="dot unsaved" title="unsaved changes" aria-label="unsaved changes" /> : null}
      </span>
      <Segmented aria-label="Room tool" size="sm" options={TOOLS} value={tool} onChange={setTool} />
      {brush !== null ? (
        <span className="muted roombrush" title={brushLabel(brush)}>
          brush: <span className="mono">{entryLabel(brushEntry, firstId(brush))}</span>
        </span>
      ) : null}
      <div className="grow" />
      <Segmented aria-label="Room view" size="sm" options={VIEWS} value={view} onChange={setView} />
      <select
        className="artinput"
        aria-label="Tileset"
        value={tileset}
        title={art ? `tileset ${art.tileset} (${art.tilesetSource})${art.hasSwfs ? "" : " — no SWFs extracted: tint swatches only"}` : "tileset"}
        onChange={(e) => void chooseTileset(e.target.value)}
      >
        {!art ? <option value={tileset}>{tileset || "tileset…"}</option> : null}
        {(art?.tilesets ?? []).map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <IconButton aria-label="Close room" title="Close the room (Save is in the top bar, Ctrl+S)" onClick={() => void requestCloseLevel()}>
        ✕
      </IconButton>
    </div>
  );
}
