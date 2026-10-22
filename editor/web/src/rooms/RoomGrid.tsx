// Rooms mode flat grid: the 10x10 painter, row 0 on top. Each cell is a memoised <button role="gridcell"> whose
// props are only what it draws (tile id, objects summary, art src, selected, random), so painting one cell
// re-renders that cell alone. Pointer + keyboard input: grid-input.ts.

import React, { useRef } from "react";
import { useStoreShallow } from "../store.ts";
import { sx } from "../components/ui.tsx";
import { TOUR, tourAttr } from "../tour-anchors.ts";
import { R, artUrl, brushLabel } from "./room-state.ts";
import { usePaletteMaps, artOf, artLine, entryLabel, ArtImg } from "./RoomBits.tsx";
import { cellPointerDown, cellPointerEnter, gridKeyDown, useRovingFocus, isTabStop } from "./grid-input.ts";
import { firstId, objectsAt, cellAt } from "../../../src/core/level/edit.ts";

interface CellProps {
  x: number;
  y: number;
  /** data-tile: the id, or "random" */
  tile: string;
  /** data-objects: the ids on the cell ("random" for a list), comma-joined */
  objects: string;
  /** data-art: none | clip | swatch */
  artState: string;
  title: string;
  /** the tile's swatch colour ("" for none) */
  color: string;
  /** the swatch letter ("" for an empty tile) */
  letter: string;
  /** the tile thumbnail ("" = none) */
  tileSrc: string;
  /** the first object's thumbnail ("" = none) */
  objSrc: string;
  /** the first object's round swatch: "" for none */
  objColor: string;
  objLabel: string;
  objRandom: boolean;
  stack: number;
  selected: boolean;
  random: boolean;
  tabStop: boolean;
}

const Cell = React.memo(function Cell(p: CellProps): React.JSX.Element {
  const { x, y } = p;
  return (
    <button
      type="button"
      role="gridcell"
      aria-selected={p.selected}
      tabIndex={p.tabStop ? 0 : -1}
      className={"rcell" + (p.selected ? " sel" : "") + (p.random ? " rnd" : "")}
      data-x={x}
      data-y={y}
      data-tile={p.tile}
      data-objects={p.objects}
      data-art={p.artState}
      title={p.title}
      style={{ background: p.color || undefined }}
      onPointerDown={(e) => cellPointerDown(e, x, y)}
      onPointerEnter={() => cellPointerEnter(x, y)}
    >
      {p.tileSrc ? <ArtImg src={p.tileSrc} kind="tile" className="cellart tileart" /> : null}
      {p.letter ? <span className="tl">{p.letter}</span> : null}
      {p.objSrc ? (
        <ArtImg src={p.objSrc} kind="object" className="cellart objart" />
      ) : p.objColor ? (
        <span className={"obj" + (p.objRandom ? " rnd" : "")} style={{ background: p.objColor }}>
          {p.objLabel}
        </span>
      ) : null}
      {p.stack > 1 ? <span className="stack">{p.stack}</span> : null}
    </button>
  );
});

export function RoomGrid(): React.JSX.Element | null {
  const { level, sel, art, tileset } = useStoreShallow(R, (r) => ({ level: r.level, sel: r.sel, art: r.art, tileset: r.tileset }));
  const maps = usePaletteMaps();
  const ref = useRef<HTMLDivElement | null>(null);
  useRovingFocus(ref, sel);
  if (!level) return null;
  const rows: React.JSX.Element[] = [];
  for (let y = 0; y < level.height; y++) {
    const cells: React.JSX.Element[] = [];
    for (let x = 0; x < level.width; x++) {
      const t = cellAt(level, x, y);
      const tid = firstId(t);
      const te = maps.tiles.get(tid);
      const objs = objectsAt(level, x, y);
      const o = objs[0]?.obj;
      const oid = o ? firstId(o.id) : 0;
      const oe = o ? maps.objects.get(oid) : undefined;
      const ta = tid !== 0 ? artOf(art, "tile", tid) : undefined;
      const oa = o ? artOf(art, "object", oid) : undefined;
      const title0 = `(${x},${y}) tile ${typeof t === "number" ? entryLabel(te, t) : `random ${brushLabel(t)}`}${objs.length ? ` · ${objs.map((q) => (typeof q.obj.id === "number" ? entryLabel(maps.objects.get(q.obj.id), q.obj.id) : `random ${brushLabel(q.obj.id)}`)).join(" + ")}` : ""}`;
      cells.push(
        <Cell
          key={`${x},${y}`}
          x={x}
          y={y}
          tile={typeof t === "number" ? String(t) : "random"}
          objects={objs.map((q) => (typeof q.obj.id === "number" ? q.obj.id : "random")).join(",")}
          artState={tid === 0 ? "none" : ta?.ok ? "clip" : "swatch"}
          title={[title0, artLine(ta), oa ? artLine(oa) : ""].filter(Boolean).join("\n")}
          color={tid === 0 ? "" : (te?.color ?? "var(--panel2)")}
          letter={tid !== 0 ? (te?.letter ?? String(tid)) : ""}
          tileSrc={ta?.ok ? artUrl("tile", tid) : ""}
          objSrc={o && oa?.ok ? artUrl("object", oid) : ""}
          objColor={o ? (oe?.color ?? "var(--acc)") : ""}
          objLabel={o ? (typeof o.id !== "number" ? "?" : (oe?.letter ?? String(o.id))) : ""}
          objRandom={!!o && typeof o.id !== "number"}
          stack={objs.length}
          selected={!!sel && sel.x === x && sel.y === y}
          random={typeof t !== "number"}
          tabStop={isTabStop(sel, x, y)}
        />,
      );
    }
    rows.push(
      <div key={`row${y}`} role="row" className="rrow">
        {cells}
      </div>,
    );
  }
  return (
    <div className="roomgridwrap" {...tourAttr(TOUR.roomsGrid)}>
      <div
        ref={ref}
        className="roomgrid"
        role="grid"
        aria-label={`Room grid, ${level.width} by ${level.height}: arrows move, Enter or Space applies the tool`}
        style={{ gridTemplateColumns: `repeat(${level.width}, 1fr)` }}
        onKeyDown={gridKeyDown}
      >
        {rows}
      </div>
      <div className="muted roomstatus" style={sx("font-size:12px;margin-top:10px")}>
        {`${level.width}×${level.height} · tileset ${tileset || "…"} · ${level.objects.length} object(s) · palettes ${level.objectPalette} / ${level.tilePalette || "(none, v1)"} · v${level.version}. Row 0 is the top row (index = y * width + x).`}
      </div>
    </div>
  );
}
