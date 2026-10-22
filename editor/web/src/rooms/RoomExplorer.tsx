// Rooms mode explorer: the mod's levels/**.lvl (Rooms, with + New room) and ONE Palette list with a Tiles | Objects
// switch — only the active kind is in the DOM, and the list fills the rest of the explorer. Palette rows are
// memoised and keyed by id, so choosing a brush repaints the two rows whose selection changed.

import React from "react";
import { useStore, useStoreShallow } from "../store.ts";
import { S } from "../state.ts";
import { sx, Button, SectionHeader, Segmented, SearchBox } from "../components/ui.tsx";
import {
  R,
  pickLevel,
  openNewRoom,
  setPaletteFilter,
  setPaletteKind,
  chooseTileBrush,
  chooseObjectBrush,
  artUrl,
  type PaletteEntry,
  type PaletteKind,
} from "./room-state.ts";
import { ArtImg, artLine, artOf } from "./RoomBits.tsx";
import type { ArtResolution } from "../../../src/core/level/tile-art.ts";

const PALETTE_CAP = 200;

const KINDS: { id: PaletteKind; label: string; title: string }[] = [
  { id: "tile", label: "Tiles", title: "tiles.gon: the floor of each cell" },
  { id: "object", label: "Objects", title: "spawns.gon: enemies, props, the PlayerSpawn cells" },
];

interface RowProps {
  entry: PaletteEntry;
  kind: PaletteKind;
  selected: boolean;
  art: ArtResolution | undefined;
  /** the thumbnail URL when the clip resolves (it changes with the tileset) */
  src: string;
}

const PaletteRow = React.memo(function PaletteRow({ entry: e, kind, selected, art, src }: RowProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={"srow pal" + (selected ? " sel" : "")}
      data-id={e.id}
      title={`${e.cls}${e.category !== null ? ` · category ${e.category}` : ""} · ${e.source === "mod" ? "this mod" : "base"}`}
      onClick={() => (kind === "tile" ? chooseTileBrush(e.id) : chooseObjectBrush(e.id))}
    >
      {art?.ok ? (
        <span className="swatch art" title={artLine(art)}>
          <ArtImg src={src} kind={kind} className="palart" lazy />
        </span>
      ) : (
        <span className={"swatch" + (kind === "object" ? " round" : "")} title={artLine(art)} style={{ background: e.color ?? "var(--panel2)" }}>
          {e.letter}
        </span>
      )}
      <span className="fname" style={sx("flex:1")}>{e.name}</span>
      <span className="count">{e.source === "mod" ? `mod ${e.id}` : e.id}</span>
    </button>
  );
});

function Palette(): React.JSX.Element {
  const kind = useStore(R, (r) => r.paletteKind);
  const { palette, filter, brush, tool, art } = useStoreShallow(R, (r) => ({
    palette: r.palette,
    filter: r.paletteKind === "tile" ? r.tileFilter : r.objectFilter,
    brush: r.paletteKind === "tile" ? r.tileBrush : r.objectBrush,
    tool: r.tool,
    art: r.art,
  }));
  // the thumbnail URLs depend on the tileset (artUrl reads it)
  useStore(R, (r) => r.tileset);
  const all = (kind === "tile" ? palette?.tiles : palette?.objects) ?? [];
  const f = filter.trim().toLowerCase();
  const hits = all.filter((e) => e.id !== 0 && (!f || `${e.id} ${e.name} ${e.cls}`.toLowerCase().includes(f)));
  return (
    <>
      <SectionHeader
        label="Palette"
        action={<Segmented aria-label="Palette kind" size="sm" options={KINDS} value={kind} onChange={setPaletteKind} />}
      />
      <SearchBox
        aria-label={kind === "tile" ? "Filter tiles" : "Filter objects"}
        placeholder={kind === "tile" ? "filter tiles (Water, Mud, 9100…)" : "filter objects (Rat, PlayerSpawn, 5000…)"}
        value={filter}
        clearable
        onChange={(v) => setPaletteFilter(kind, v)}
        style={sx("margin:0 12px 6px")}
      />
      <div className={`exbody tw palette-list palette-${kind}`}>
        {hits.slice(0, PALETTE_CAP).map((e) => {
          const a = artOf(art, kind, e.id);
          return (
            <PaletteRow
              key={e.id}
              entry={e}
              kind={kind}
              selected={tool === kind && typeof brush === "number" && brush === e.id}
              art={a}
              src={a?.ok ? artUrl(kind, e.id) : ""}
            />
          );
        })}
        {hits.length > PALETTE_CAP ? <div className="srow muted">{`${PALETTE_CAP} of ${hits.length} shown — refine the filter`}</div> : null}
        {!all.length ? <div className="srow muted">{`(no palette: extract the base data, or add data/${kind === "tile" ? "tiles" : "spawns"}.gon.append entries)`}</div> : null}
        {all.length && !hits.length ? <div className="srow muted">(nothing matches the filter)</div> : null}
      </div>
    </>
  );
}

const LevelRow = React.memo(function LevelRow({ relPath, ok, bytes, title, selected }: { relPath: string; ok: boolean; bytes: number; title: string; selected: boolean }): React.JSX.Element {
  return (
    <button type="button" className={"srow" + (selected ? " sel" : "")} title={title} onClick={() => void pickLevel(relPath)}>
      <span className="fname" style={sx("flex:1")}>{relPath.replace(/^levels\//, "")}</span>
      <span className="count">{ok ? `${bytes} B` : "bad"}</span>
    </button>
  );
});

export function RoomExplorer(): React.JSX.Element {
  const mod = useStore(S, (s) => s.mod);
  const { levels, path } = useStoreShallow(R, (r) => ({ levels: r.levels, path: r.path }));
  return (
    <div className="explorer rooms-explorer">
      <SectionHeader
        label="Rooms"
        action={
          mod ? (
            <Button variant="ghost" size="sm" style={sx("color:var(--acc-ink)")} onClick={() => openNewRoom()}>
              + New room
            </Button>
          ) : null
        }
      />
      {!mod ? (
        <div className="dashed">
          <div style={sx("font-size:13px")}>Open a mod to author rooms.</div>
        </div>
      ) : (
        <>
          <div className="exbody tw rooms-list">
            {levels.length ? (
              levels.map((l) => (
                <LevelRow
                  key={l.relPath}
                  relPath={l.relPath}
                  ok={l.ok}
                  bytes={l.bytes}
                  title={l.ok ? `${l.objects} object(s), ${l.painted} painted cell(s)` : (l.error ?? "")}
                  selected={path === l.relPath}
                />
              ))
            ) : (
              <div className="srow muted">(no rooms — create one)</div>
            )}
          </div>
          <div className="exdiv" />
          <Palette />
        </>
      )}
    </div>
  );
}
