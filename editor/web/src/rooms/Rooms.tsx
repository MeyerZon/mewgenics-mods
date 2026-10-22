// Rooms mode: the explorer (the mod's levels + the tile / object palettes), the grid painter (center), the cell
// inspector with the weighted-random-list tables and the live lvl-* findings (right), and the New room dialog.

import React, { useEffect, useMemo, useState } from "react";
import { useStore } from "../store.ts";
import { S } from "../state.ts";
import { sx, Modal, Button } from "../components/ui.tsx";
import {
  R,
  isDirty,
  pickLevel,
  requestCloseLevel,
  newRoom,
  setRoomTool,
  setRoomView,
  setPaletteFilter,
  openNewRoom,
  closeNewRoom,
  strokeStart,
  strokeEnter,
  strokeEnd,
  setCellTile,
  setObject,
  removeObjectAt,
  addObjectAt,
  chooseTileBrush,
  chooseObjectBrush,
  brushLabel,
  chooseTileset,
  artUrl,
  ensureArtMeta,
  type PaletteEntry,
  type RoomTool,
  type ArtKind,
} from "./room-state.ts";
import { asChoices, addChoice, updateChoice, removeChoice, firstId, objectsAt, cellAt, isoCellCenter, isoDrawOrder } from "../../../src/core/level/edit.ts";
import type { LvlPick } from "../../../src/core/level/lvl.ts";
import type { ArtResolution } from "../../../src/core/level/tile-art.ts";

const PALETTE_CAP = 200;

function usePaletteMaps(): { tiles: Map<number, PaletteEntry>; objects: Map<number, PaletteEntry> } {
  const palette = useStore(R, (r) => r.palette);
  return useMemo(() => ({
    tiles: new Map((palette?.tiles ?? []).map((t) => [t.id, t])),
    objects: new Map((palette?.objects ?? []).map((o) => [o.id, o])),
  }), [palette]);
}

/** The art resolution of a palette id in the current tileset (undefined while /api/level-art loads). */
function useArtOf(): (kind: ArtKind, id: number) => ArtResolution | undefined {
  const art = useStore(R, (r) => r.art);
  return (kind, id) => (art ? (kind === "tile" ? art.tiles[id] : art.objects[id]) : undefined);
}

/** A tooltip line: the clip and how it was found, or why the swatch is shown. */
function artLine(a: ArtResolution | undefined): string {
  if (!a) return "";
  return a.ok ? `art: ${a.clip} (${a.swf})${a.mirrored ? ", mirrored" : ""}` : `swatch: ${a.detail}`;
}

/** A thumbnail that hides itself if the server cannot render it (the swatch under it stays). */
function ArtImg({ kind, id, className, lazy }: { kind: ArtKind; id: number; className: string; lazy?: boolean }): React.JSX.Element {
  const tileset = useStore(R, (r) => r.tileset);
  const [broken, setBroken] = useState("");
  const src = artUrl(kind, id);
  if (broken === src) return <></>;
  return <img className={className} data-kind={kind} alt="" draggable={false} loading={lazy ? "lazy" : undefined} src={src} key={tileset} onError={() => setBroken(src)} />;
}

function entryLabel(e: PaletteEntry | undefined, id: number): string {
  return e ? `${id} · ${e.name}${e.cls && e.cls !== e.name ? ` [${e.cls}]` : ""}` : `${id} · (not in the palette)`;
}

// ---- explorer ----
function PaletteList({ kind }: { kind: "tile" | "object" }): React.JSX.Element {
  const palette = useStore(R, (r) => r.palette);
  const filter = useStore(R, (r) => (kind === "tile" ? r.tileFilter : r.objectFilter));
  const brush = useStore(R, (r) => (kind === "tile" ? r.tileBrush : r.objectBrush));
  const tool = useStore(R, (r) => r.tool);
  const artOf = useArtOf();
  const all = (kind === "tile" ? palette?.tiles : palette?.objects) ?? [];
  const f = filter.trim().toLowerCase();
  const hits = all.filter((e) => e.id !== 0 && (!f || `${e.id} ${e.name} ${e.cls}`.toLowerCase().includes(f)));
  return (
    <>
      <div className="search" style={sx("margin:0 12px 6px")}>
        <input
          aria-label={kind === "tile" ? "Filter tiles" : "Filter objects"}
          placeholder={kind === "tile" ? "filter tiles…" : "filter objects (Rat, PlayerSpawn, 5000…)"}
          value={filter}
          onChange={(e) => setPaletteFilter(kind, e.target.value)}
        />
      </div>
      <div className={`exbody tw palette-${kind}`}>
        {hits.slice(0, PALETTE_CAP).map((e) => (
          <button
            key={e.id}
            className={"srow pal" + (tool === kind && typeof brush === "number" && brush === e.id ? " sel" : "")}
            data-id={e.id}
            title={`${e.cls}${e.category !== null ? ` · category ${e.category}` : ""} · ${e.source === "mod" ? "this mod" : "base"}`}
            onClick={() => (kind === "tile" ? chooseTileBrush(e.id) : chooseObjectBrush(e.id))}
          >
            {artOf(kind, e.id)?.ok ? (
              <span className="swatch art" title={artLine(artOf(kind, e.id))}><ArtImg kind={kind} id={e.id} className="palart" lazy /></span>
            ) : (
              <span className={"swatch" + (kind === "object" ? " round" : "")} title={artLine(artOf(kind, e.id))} style={{ background: e.color ?? "var(--panel2)" }}>{e.letter}</span>
            )}
            <span className="fname" style={sx("flex:1")}>{e.name}</span>
            <span className="count">{e.source === "mod" ? `mod ${e.id}` : e.id}</span>
          </button>
        ))}
        {hits.length > PALETTE_CAP ? <div className="srow muted">{`${PALETTE_CAP} of ${hits.length} shown — refine the filter`}</div> : null}
        {!all.length ? <div className="srow muted">(no palette: extract the base data, or add data/{kind === "tile" ? "tiles" : "spawns"}.gon.append entries)</div> : null}
      </div>
    </>
  );
}

export function RoomExplorer(): React.JSX.Element {
  const mod = useStore(S, (s) => s.mod);
  const levels = useStore(R, (r) => r.levels);
  const path = useStore(R, (r) => r.path);
  return (
    <div className="explorer">
      <div className="exhead">
        <span className="sec">Rooms</span>
        <small className="muted">· levels/</small>
        <div className="grow" />
        {mod ? (
          <button className="btn ghost sm" style={sx("color:var(--acc-ink)")} onClick={() => openNewRoom()}>
            + New room
          </button>
        ) : null}
      </div>
      {!mod ? (
        <div className="dashed">
          <div style={sx("font-size:13px")}>Open a mod to author rooms.</div>
        </div>
      ) : (
        <div className="exbody tw rooms-list">
          {levels.length ? (
            levels.map((l) => (
              <button key={l.relPath} className={"srow" + (path === l.relPath ? " sel" : "")} title={l.ok ? `${l.objects} object(s), ${l.painted} painted cell(s)` : l.error} onClick={() => void pickLevel(l.relPath)}>
                <span className="fname" style={sx("flex:1")}>{l.relPath.replace(/^levels\//, "")}</span>
                <span className="count">{l.ok ? `${l.bytes} B` : "bad"}</span>
              </button>
            ))
          ) : (
            <div className="srow muted">(no rooms — create one)</div>
          )}
        </div>
      )}
      {mod ? (
        <>
          <div className="exdiv" />
          <div className="exhead"><span className="sec">Tiles</span><small className="muted">· tiles.gon</small></div>
          <PaletteList kind="tile" />
          <div className="exdiv" />
          <div className="exhead"><span className="sec">Objects</span><small className="muted">· spawns.gon</small></div>
          <PaletteList kind="object" />
        </>
      ) : null}
    </div>
  );
}

// ---- center: toolbar + grid ----
function Toolbar(): React.JSX.Element {
  const path = useStore(R, (r) => r.path);
  const tool = useStore(R, (r) => r.tool);
  const tileBrush = useStore(R, (r) => r.tileBrush);
  const objectBrush = useStore(R, (r) => r.objectBrush);
  const dirty = useStore(R, (r) => isDirty(r));
  const view = useStore(R, (r) => r.view);
  const art = useStore(R, (r) => r.art);
  const tileset = useStore(R, (r) => r.tileset);
  const maps = usePaletteMaps();
  const tools: Array<[RoomTool, string, string]> = [
    ["select", "Select", "click a cell to inspect it without changing it"],
    ["tile", "Tile", "click or drag to paint the tile brush"],
    ["object", "Object", "click to put the object brush on a cell (replaces the first object there)"],
    ["erase", "Erase", "click or drag: removes a cell's objects, else clears its tile to 0"],
  ];
  const brush = tool === "tile" ? tileBrush : tool === "object" ? objectBrush : null;
  const brushEntry = brush === null ? undefined : (tool === "tile" ? maps.tiles : maps.objects).get(firstId(brush));
  return (
    <div className="roomtools">
      <span className="mono roompath">{path}{dirty ? " •" : ""}</span>
      <div className="modeswitch" role="group" aria-label="Room tool">
        {tools.map(([t, label, title]) => (
          <button key={t} className={"btn sm" + (tool === t ? " on" : "")} aria-pressed={tool === t} title={title} onClick={() => setRoomTool(t)}>
            {label}
          </button>
        ))}
      </div>
      {brush !== null ? (
        <span className="muted roombrush" title={brushLabel(brush)}>
          brush: <span className="mono">{entryLabel(brushEntry, firstId(brush))}</span>
        </span>
      ) : null}
      <div className="grow" />
      <div className="modeswitch" role="group" aria-label="Room view">
        {(["flat", "iso"] as const).map((v) => (
          <button key={v} className={"btn sm" + (view === v ? " on" : "")} aria-pressed={view === v} title={v === "flat" ? "the 10x10 grid, row 0 on top" : "2:1 diamonds as the game draws the board; sprites stand on their cell"} onClick={() => setRoomView(v)}>
            {v === "flat" ? "Flat" : "Iso"}
          </button>
        ))}
      </div>
      <select
        className="artinput"
        aria-label="Tileset"
        value={tileset}
        title={art ? `tileset ${art.tileset} (${art.tilesetSource})${art.hasSwfs ? "" : " — no SWFs extracted: tint swatches only"}` : "tileset"}
        onChange={(e) => void chooseTileset(e.target.value)}
      >
        {!art ? <option value={tileset}>{tileset || "tileset…"}</option> : null}
        {(art?.tilesets ?? []).map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <button className="btn ghost sm" onClick={() => void requestCloseLevel()} title="Close the room (Save is in the top bar, Ctrl+S)">Close</button>
    </div>
  );
}

function Grid(): React.JSX.Element {
  const level = useStore(R, (r) => r.level);
  const sel = useStore(R, (r) => r.sel);
  const maps = usePaletteMaps();
  const artOf = useArtOf();
  useEffect(() => {
    const up = () => strokeEnd();
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);
  if (!level) return <div />;
  const cells: React.JSX.Element[] = [];
  for (let y = 0; y < level.height; y++) {
    for (let x = 0; x < level.width; x++) {
      const t = cellAt(level, x, y);
      const te = maps.tiles.get(firstId(t));
      const objs = objectsAt(level, x, y);
      const o = objs[0]?.obj;
      const oe = o ? maps.objects.get(firstId(o.id)) : undefined;
      const ta = firstId(t) !== 0 ? artOf("tile", firstId(t)) : undefined;
      const oa = o ? artOf("object", firstId(o.id)) : undefined;
      const title0 = `(${x},${y}) tile ${typeof t === "number" ? entryLabel(te, t) : `random ${brushLabel(t)}`}${objs.length ? ` · ${objs.map((q) => (typeof q.obj.id === "number" ? entryLabel(maps.objects.get(q.obj.id), q.obj.id) : `random ${brushLabel(q.obj.id)}`)).join(" + ")}` : ""}`;
      const title = [title0, artLine(ta), oa ? artLine(oa) : ""].filter(Boolean).join("\n");
      cells.push(
        <button
          key={`${x},${y}`}
          className={"rcell" + (sel && sel.x === x && sel.y === y ? " sel" : "") + (typeof t !== "number" ? " rnd" : "")}
          data-x={x}
          data-y={y}
          data-tile={typeof t === "number" ? t : "random"}
          data-objects={objs.map((q) => (typeof q.obj.id === "number" ? q.obj.id : "random")).join(",")}
          data-art={firstId(t) === 0 ? "none" : ta?.ok ? "clip" : "swatch"}
          title={title}
          style={{ background: firstId(t) === 0 ? undefined : (te?.color ?? "var(--panel2)") }}
          onMouseDown={(e) => { e.preventDefault(); strokeStart(x, y); }}
          onMouseEnter={() => strokeEnter(x, y)}
        >
          {ta?.ok ? <ArtImg kind="tile" id={firstId(t)} className="cellart tileart" /> : null}
          {firstId(t) !== 0 ? <span className="tl">{te?.letter ?? firstId(t)}</span> : null}
          {o && oa?.ok ? <ArtImg kind="object" id={firstId(o.id)} className="cellart objart" /> : o ? (
            <span className={"obj" + (typeof o.id !== "number" ? " rnd" : "")} style={{ background: oe?.color ?? "var(--acc)" }}>
              {typeof o.id !== "number" ? "?" : oe?.letter ?? o.id}
            </span>
          ) : null}
          {objs.length > 1 ? <span className="stack">{objs.length}</span> : null}
        </button>,
      );
    }
  }
  return (
    <div className="roomgridwrap">
      <div className="roomgrid" style={{ gridTemplateColumns: `repeat(${level.width}, 1fr)` }}>
        {cells}
      </div>
      <div className="muted" style={sx("font-size:12px;margin-top:10px")}>
        {`${level.width}x${level.height} · ${level.objects.length} object(s) · palettes ${level.objectPalette} / ${level.tilePalette || "(none, v1)"} · v${level.version}. Row 0 is the top row (index = y * width + x).`}
      </div>
    </div>
  );
}

// ---- iso view: 2:1 diamonds, feet-registered sprites, painter's order by x + y (edit.ts isoCellCenter / isoDrawOrder) ----
const ISO_W = 64; // diamond width in screen px
const CLIP_DIAMOND_W = 140; // a tile diamond in clip px (MetalTile's polygon, OBSERVED)
const ISO_HEADROOM = 110; // room above the back corner for tall sprites

function IsoGrid(): React.JSX.Element {
  const level = useStore(R, (r) => r.level);
  const sel = useStore(R, (r) => r.sel);
  const tileset = useStore(R, (r) => r.tileset);
  const artMeta = useStore(R, (r) => r.artMeta);
  const maps = usePaletteMaps();
  const artOf = useArtOf();
  useEffect(() => {
    const up = () => strokeEnd();
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);
  // fetch the metadata (size + registration point) of every clip the room shows
  useEffect(() => {
    if (!level) return;
    const want = new Set<string>();
    level.tiles.forEach((t) => { const id = firstId(t); if (id && artOf("tile", id)?.ok) want.add(`tile:${id}`); });
    level.objects.forEach((o) => { const id = firstId(o.id); if (artOf("object", id)?.ok) want.add(`object:${id}`); });
    for (const key of want) { const [kind, id] = key.split(":"); ensureArtMeta(kind as ArtKind, Number(id)); }
  });
  if (!level) return <div />;
  const { width: w, height: h } = level;
  const ox = (h * ISO_W) / 2;
  const oy = ISO_HEADROOM + ISO_W / 4;
  const k = ISO_W / CLIP_DIAMOND_W; // screen px per clip px
  const order = isoDrawOrder(w, h);
  const diamonds: React.JSX.Element[] = [];
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
  const hasObjArt = (id: number) => !!artOf("object", id)?.ok && !!artMeta[`${tileset}:object:${id}`];
  for (const { x, y } of order) {
    const t = cellAt(level, x, y);
    const tid = firstId(t);
    const te = maps.tiles.get(tid);
    const ta = tid !== 0 ? artOf("tile", tid) : undefined;
    const objs = objectsAt(level, x, y);
    const c = isoCellCenter(x, y, ISO_W);
    const swatch = tid !== 0 && !ta?.ok;
    const first = objs[0]?.obj;
    const lines = [`(${x},${y}) tile ${entryLabel(te, tid)}`, artLine(ta), ...objs.map((q) => `${entryLabel(maps.objects.get(firstId(q.obj.id)), firstId(q.obj.id))} · ${artLine(artOf("object", firstId(q.obj.id)))}`)];
    diamonds.push(
      <button
        key={`d${x},${y}`}
        className={"icell" + ((x + y) % 2 ? " alt" : "") + (sel && sel.x === x && sel.y === y ? " sel" : "") + (typeof t !== "number" ? " rnd" : "")}
        data-x={x}
        data-y={y}
        data-tile={typeof t === "number" ? t : "random"}
        data-objects={objs.map((q) => (typeof q.obj.id === "number" ? q.obj.id : "random")).join(",")}
        data-art={tid === 0 ? "none" : ta?.ok ? "clip" : "swatch"}
        title={lines.filter(Boolean).join("\n")}
        style={{ left: ox + c.x - ISO_W / 2 + 1, top: oy + c.y - ISO_W / 4 + 0.5, width: ISO_W - 2, height: ISO_W / 2 - 1, background: swatch ? (te?.color ?? "var(--panel2)") : undefined }}
        onMouseDown={(e) => { e.preventDefault(); strokeStart(x, y); }}
        onMouseEnter={() => strokeEnter(x, y)}
      >
        {swatch ? <span className="tl">{te?.letter ?? tid}</span> : null}
        {first && !objs.some((q) => hasObjArt(firstId(q.obj.id))) ? (
          <span className="obj" style={{ background: maps.objects.get(firstId(first.id))?.color ?? "var(--acc)" }}>{typeof first.id !== "number" ? "?" : (maps.objects.get(first.id)?.letter ?? first.id)}</span>
        ) : null}
      </button>,
    );
    if (ta?.ok) place("tile", tid, x, y, `t${x},${y}`, tileImgs);
    objs.forEach((q, i) => { const id = firstId(q.obj.id); if (artOf("object", id)?.ok) place("object", id, x, y, `o${x},${y},${i}`, objImgs); });
  }
  return (
    <div className="roomgridwrap">
      <div className="roomiso" style={{ width: ((w + h) * ISO_W) / 2, height: oy + ((w + h) * ISO_W) / 4 + 8 }}>
        {diamonds}
        {tileImgs}
        {objImgs}
      </div>
      <div className="muted" style={sx("font-size:12px;margin-top:10px")}>
        {"Iso view: 2:1 diamonds as the game projects the board (grid x runs down-right, y down-left); sprites stand on their cell's centre and nearer cells (larger x + y) draw last. Which corner row 0 is in a real fight is not pinned."}
      </div>
    </div>
  );
}

function RoomsEmpty(): React.JSX.Element {
  const mod = useStore(S, (s) => s.mod);
  return (
    <div className="emptycenter">
      <div style={sx("max-width:640px;width:100%")}>
        <h2 style={sx("font-size:24px;margin:0 0 8px")}>Paint a room the game can load</h2>
        <p style={sx("margin:0 0 18px;font-size:14.5px;color:var(--ink2);line-height:1.6")}>
          A room is a binary <span className="mono">levels/&lt;folder&gt;/&lt;name&gt;.lvl</span>: a 10x10 grid of <span className="mono">tiles.gon</span> ids and objects placed by <span className="mono">spawns.gon</span> id (enemies, props, the <span className="mono">PlayerSpawn</span> cells). Any id can instead be a weighted random list. Play one in a test fight with the console command <span className="mono">load &lt;folder&gt;/&lt;name&gt;</span>.
        </p>
        <div style={sx("display:flex;gap:12px;align-items:center;flex-wrap:wrap")}>
          {mod ? <button className="btn primary" onClick={() => openNewRoom()}>+ New room</button> : <span className="muted">No mod open — pick one from the top-bar mod switcher first.</span>}
          <span className="muted" style={sx("font-size:12.5px")}>docs/data-mods.md "Maps, rooms and encounters"</span>
        </div>
      </div>
    </div>
  );
}

function NewRoomModal(): React.JSX.Element {
  const mod = useStore(S, (s) => s.mod);
  const [folder, setFolder] = useState(mod.replace(/[^A-Za-z0-9_-]/g, "_") || "custom");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const close = () => closeNewRoom();
  const create = async () => {
    if (!name) { setErr("enter a room name"); return; }
    const e = await newRoom(folder, name);
    if (e) setErr(e);
  };
  return (
    <Modal
      title="New room"
      icon="＋"
      onClose={close}
      initialFocus="#newroom-name"
      footer={
        <>
          <div className="grow" />
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={() => void create()}>Create</Button>
        </>
      }
    >
          <p className="muted" style={sx("margin:0 0 6px")}>{`Writes mods/${mod}/levels/<folder>/<name>.lvl from the room template: 4 player spawns on the top row and 2 Rats near the bottom.`}</p>
          <label className="fld" htmlFor="newroom-folder">folder (under levels/)</label>
          <input id="newroom-folder" className="mono" value={folder} onChange={(e) => setFolder(e.target.value)} />
          <label className="fld" htmlFor="newroom-name">room name</label>
          <input id="newroom-name" className="mono" placeholder="my_room" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void create(); }} />
          {err ? <div className="finding error"><span className="mark">✕</span><div>{err}</div></div> : null}
    </Modal>
  );
}

export function RoomCenter(): React.JSX.Element {
  const level = useStore(R, (r) => r.level);
  const newOpen = useStore(R, (r) => r.newOpen);
  const view = useStore(R, (r) => r.view);
  return (
    <div className="center">
      {level ? <Toolbar /> : null}
      {level ? (view === "iso" ? <IsoGrid /> : <Grid />) : <RoomsEmpty />}
      {newOpen ? <NewRoomModal /> : null}
    </div>
  );
}

// ---- right: inspector + findings ----
function IdSelect({ value, entries, onChange, label }: { value: number; entries: PaletteEntry[]; onChange: (id: number) => void; label: string }): React.JSX.Element {
  const known = entries.some((e) => e.id === value);
  return (
    <select className="artinput" aria-label={label} value={value} onChange={(e) => onChange(Number(e.target.value))} style={sx("max-width:100%;flex:1;min-width:0")}>
      {!known ? <option value={value}>{`${value} · (not in the palette)`}</option> : null}
      {entries.map((e) => (
        <option key={e.id} value={e.id}>{entryLabel(e, e.id)}</option>
      ))}
    </select>
  );
}

/** One pick: an id, or (Random on) a table of id + weight rows. */
function PickEditor({ pick, entries, onChange, label }: { pick: LvlPick; entries: PaletteEntry[]; onChange: (p: LvlPick) => void; label: string }): React.JSX.Element {
  const random = typeof pick !== "number";
  return (
    <div className="pickedit">
      <label className="rndtoggle">
        <input type="checkbox" aria-label={`${label}: weighted random list`} checked={random} onChange={(e) => onChange(e.target.checked ? asChoices(pick) : firstId(pick))} />
        random
      </label>
      {!random ? (
        <IdSelect value={pick} entries={entries} onChange={onChange} label={label} />
      ) : (
        <table className="rndtable">
          <thead><tr><th>id</th><th>weight</th><th /></tr></thead>
          <tbody>
            {pick.map((c, i) => (
              <tr key={i}>
                <td><IdSelect value={c.id} entries={entries} onChange={(id) => onChange(updateChoice(pick, i, { id }))} label={`${label} choice ${i + 1}`} /></td>
                <td><input className="artinput num" type="number" min={0} max={65535} aria-label={`${label} weight ${i + 1}`} value={c.weight} onChange={(e) => onChange(updateChoice(pick, i, { weight: Math.max(0, Math.min(65535, Math.round(Number(e.target.value) || 0))) }))} /></td>
                <td><button className="iconbtn" aria-label={`remove choice ${i + 1}`} onClick={() => onChange(removeChoice(pick, i))}>✕</button></td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan={3}><button className="btn ghost sm" onClick={() => onChange(addChoice(pick, 0))}>+ choice</button></td></tr></tfoot>
        </table>
      )}
    </div>
  );
}

function Inspector(): React.JSX.Element {
  const level = useStore(R, (r) => r.level);
  const sel = useStore(R, (r) => r.sel);
  const palette = useStore(R, (r) => r.palette);
  const objectBrush = useStore(R, (r) => r.objectBrush);
  if (!level || !sel) return <p className="muted">Click a cell to inspect it: its tile, its objects and their random lists.</p>;
  const tiles = palette?.tiles ?? [];
  const objects = palette?.objects ?? [];
  const objs = objectsAt(level, sel.x, sel.y);
  return (
    <div className="inspector">
      <div className="sec" style={sx("margin-bottom:8px")}>{`Cell (${sel.x}, ${sel.y})`}</div>
      <div className="card">
        <div className="sec" style={sx("margin-bottom:6px")}>Tile</div>
        <PickEditor pick={cellAt(level, sel.x, sel.y)} entries={tiles} label="tile" onChange={(p) => setCellTile(sel.x, sel.y, p)} />
      </div>
      <div className="card">
        <div className="sec" style={sx("margin-bottom:6px")}>{`Objects (${objs.length})`}</div>
        {objs.map(({ index, obj }) => (
          <div key={index} className="objrow">
            <PickEditor pick={obj.id} entries={objects} label={`object ${index}`} onChange={(p) => setObject(index, p)} />
            <button className="btn ghost sm" onClick={() => removeObjectAt(index)}>Remove</button>
          </div>
        ))}
        <button className="btn ghost sm" onClick={() => addObjectAt(sel.x, sel.y)}>{`+ add ${typeof objectBrush === "number" ? (objects.find((o) => o.id === objectBrush)?.name ?? objectBrush) : "random list"} here`}</button>
      </div>
    </div>
  );
}

function Findings(): React.JSX.Element {
  const rep = useStore(R, (r) => r.report);
  const level = useStore(R, (r) => r.level);
  if (!level) return <p className="muted">Open a room to see its findings.</p>;
  if (!rep) return <p className="muted">validating…</p>;
  return (
    <div className="roomfindings">
      {rep.findings.length ? (
        rep.findings.map((f, i) => (
          <div key={i} className={`finding ${f.severity}`}>
            <span className="mark">{f.severity === "error" ? "✕" : f.severity === "warning" ? "!" : "i"}</span>
            <div>
              <div><span className="code">{f.code}</span></div>
              <div>{f.message}</div>
            </div>
          </div>
        ))
      ) : (
        <p className="dotok" style={sx("margin:2px 0")}>No findings — every id resolves and the party has a spawn.</p>
      )}
    </div>
  );
}

export function RoomRightPanel(): React.JSX.Element {
  const rep = useStore(R, (r) => r.report);
  const n = rep ? rep.findings.length : 0;
  return (
    <div className="rightpanel">
      <div className="tabs"><span className="tab active">Cell</span></div>
      <div className="panelbody"><Inspector /></div>
      <div className="tabs"><span className="tab active">{`Findings${n ? ` (${n})` : ""}`}</span></div>
      <div className="panelbody"><Findings /></div>
    </div>
  );
}
