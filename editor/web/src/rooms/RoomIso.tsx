// Rooms mode iso view: 2:1 diamonds, feet-registered sprites, painter's order by x + y (edit.ts isoCellCenter /
// isoDrawOrder). The diamonds are memoised role=gridcell buttons (one per cell, in role=row groups) and take the same
// pointer + keyboard input as the flat grid; the art images sit after them, tiles first, then objects.

import React, { useEffect, useRef } from "react";
import { useStoreShallow } from "../store.ts";
import { sx } from "../components/ui.tsx";
import { R, artUrl, ensureArtMeta, type ArtKind } from "./room-state.ts";
import { usePaletteMaps, artOf, artLine, entryLabel } from "./RoomBits.tsx";
import { cellPointerDown, cellPointerEnter, gridKeyDown, useRovingFocus, isTabStop } from "./grid-input.ts";
import { firstId, objectsAt, cellAt, isoCellCenter, isoDrawOrder } from "../../../src/core/level/edit.ts";

const ISO_W = 64; // diamond width in screen px
const CLIP_DIAMOND_W = 140; // a tile diamond in clip px (MetalTile's polygon, OBSERVED)
const ISO_HEADROOM = 110; // room above the back corner for tall sprites

interface IsoCellProps {
  x: number;
  y: number;
  tile: string;
  objects: string;
  artState: string;
  title: string;
  left: number;
  top: number;
  /** the tint swatch when the tile has no clip ("" = none) */
  swatch: string;
  letter: string;
  /** the round object swatch when no object on the cell has art ("" = none) */
  objColor: string;
  objLabel: string;
  selected: boolean;
  random: boolean;
  tabStop: boolean;
}

const IsoCell = React.memo(function IsoCell(p: IsoCellProps): React.JSX.Element {
  const { x, y } = p;
  return (
    <button
      type="button"
      role="gridcell"
      aria-selected={p.selected}
      tabIndex={p.tabStop ? 0 : -1}
      className={"icell" + ((x + y) % 2 ? " alt" : "") + (p.selected ? " sel" : "") + (p.random ? " rnd" : "")}
      data-x={x}
      data-y={y}
      data-tile={p.tile}
      data-objects={p.objects}
      data-art={p.artState}
      title={p.title}
      style={{ left: p.left, top: p.top, width: ISO_W - 2, height: ISO_W / 2 - 1, background: p.swatch || undefined }}
      onPointerDown={(e) => cellPointerDown(e, x, y)}
      onPointerEnter={() => cellPointerEnter(x, y)}
    >
      {p.swatch ? <span className="tl">{p.letter}</span> : null}
      {p.objColor ? (
        <span className="obj" style={{ background: p.objColor }}>
          {p.objLabel}
        </span>
      ) : null}
    </button>
  );
});

export function RoomIso(): React.JSX.Element | null {
  const { level, sel, tileset, artMeta, art } = useStoreShallow(R, (r) => ({ level: r.level, sel: r.sel, tileset: r.tileset, artMeta: r.artMeta, art: r.art }));
  const maps = usePaletteMaps();
  const ref = useRef<HTMLDivElement | null>(null);
  useRovingFocus(ref, sel);
  // fetch the metadata (size + registration point) of every clip the room shows
  useEffect(() => {
    if (!level) return;
    const want = new Set<string>();
    level.tiles.forEach((t) => {
      const id = firstId(t);
      if (id && artOf(art, "tile", id)?.ok) want.add(`tile:${id}`);
    });
    level.objects.forEach((o) => {
      const id = firstId(o.id);
      if (artOf(art, "object", id)?.ok) want.add(`object:${id}`);
    });
    for (const key of want) {
      const [kind, id] = key.split(":");
      ensureArtMeta(kind as ArtKind, Number(id));
    }
  }, [level, art, tileset]);
  if (!level) return null;
  const { width: w, height: h } = level;
  const ox = (h * ISO_W) / 2;
  const oy = ISO_HEADROOM + ISO_W / 4;
  const k = ISO_W / CLIP_DIAMOND_W; // screen px per clip px
  const rows: React.JSX.Element[][] = Array.from({ length: h }, () => []);
  const tileImgs: React.JSX.Element[] = [];
  const objImgs: React.JSX.Element[] = [];
  const place = (kind: ArtKind, id: number, x: number, y: number, key: string, into: React.JSX.Element[]) => {
    const m = artMeta[`${tileset}:${kind}:${id}`];
    if (!m) return;
    const c = isoCellCenter(x, y, ISO_W);
    const f = k / m.scale;
    into.push(
      <img
        key={key}
        className="isoart"
        data-kind={kind}
        data-x={x}
        data-y={y}
        alt=""
        draggable={false}
        src={artUrl(kind, id)}
        style={{ left: ox + c.x - m.originX * f, top: oy + c.y - m.originY * f, width: m.width * f, height: m.height * f }}
      />,
    );
  };
  const hasObjArt = (id: number) => !!artOf(art, "object", id)?.ok && !!artMeta[`${tileset}:object:${id}`];
  for (const { x, y } of isoDrawOrder(w, h)) {
    const t = cellAt(level, x, y);
    const tid = firstId(t);
    const te = maps.tiles.get(tid);
    const ta = tid !== 0 ? artOf(art, "tile", tid) : undefined;
    const objs = objectsAt(level, x, y);
    const c = isoCellCenter(x, y, ISO_W);
    const swatch = tid !== 0 && !ta?.ok;
    const first = objs[0]?.obj;
    const showObj = !!first && !objs.some((q) => hasObjArt(firstId(q.obj.id)));
    const lines = [`(${x},${y}) tile ${entryLabel(te, tid)}`, artLine(ta), ...objs.map((q) => `${entryLabel(maps.objects.get(firstId(q.obj.id)), firstId(q.obj.id))} · ${artLine(artOf(art, "object", firstId(q.obj.id)))}`)];
    rows[y]!.push(
      <IsoCell
        key={`d${x},${y}`}
        x={x}
        y={y}
        tile={typeof t === "number" ? String(t) : "random"}
        objects={objs.map((q) => (typeof q.obj.id === "number" ? q.obj.id : "random")).join(",")}
        artState={tid === 0 ? "none" : ta?.ok ? "clip" : "swatch"}
        title={lines.filter(Boolean).join("\n")}
        left={ox + c.x - ISO_W / 2 + 1}
        top={oy + c.y - ISO_W / 4 + 0.5}
        swatch={swatch ? (te?.color ?? "var(--panel2)") : ""}
        letter={te?.letter ?? String(tid)}
        objColor={showObj && first ? (maps.objects.get(firstId(first.id))?.color ?? "var(--acc)") : ""}
        objLabel={showObj && first ? (typeof first.id !== "number" ? "?" : (maps.objects.get(first.id)?.letter ?? String(first.id))) : ""}
        selected={!!sel && sel.x === x && sel.y === y}
        random={typeof t !== "number"}
        tabStop={isTabStop(sel, x, y)}
      />,
    );
    if (ta?.ok) place("tile", tid, x, y, `t${x},${y}`, tileImgs);
    objs.forEach((q) => {
      const id = firstId(q.obj.id);
      if (artOf(art, "object", id)?.ok) place("object", id, x, y, `o${x},${y}#${q.index}`, objImgs);
    });
  }
  return (
    <div className="roomgridwrap">
      <div
        ref={ref}
        className="roomiso"
        role="grid"
        aria-label={`Room grid (iso), ${w} by ${h}: arrows move, Enter or Space applies the tool`}
        style={{ width: ((w + h) * ISO_W) / 2, height: oy + ((w + h) * ISO_W) / 4 + 8 }}
        onKeyDown={gridKeyDown}
      >
        {rows.map((cells, y) => (
          <div key={`row${y}`} role="row" className="rrow">
            {cells}
          </div>
        ))}
        {tileImgs}
        {objImgs}
      </div>
      <div className="muted roomstatus" style={sx("font-size:12px;margin-top:10px")}>
        {`${w}×${h} · tileset ${tileset || "…"}. Iso view: 2:1 diamonds as the game projects the board (grid x runs down-right, y down-left); sprites stand on their cell's centre and nearer cells (larger x + y) draw last. Which corner row 0 is in a real fight is not pinned.`}
      </div>
    </div>
  );
}
