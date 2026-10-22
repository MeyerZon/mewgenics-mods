// Rooms mode: the small pieces the explorer, the grids and the inspector share — the palette id maps, the art
// resolution lookup, the tooltip / label strings and the thumbnail <img> that hides itself when the server cannot
// render the clip (the tint swatch under it stays).

import React, { useMemo, useState } from "react";
import { useStore } from "../store.ts";
import { R, type PaletteEntry, type ArtKind, type LevelArtInfo } from "./room-state.ts";
import type { ArtResolution } from "../../../src/core/level/tile-art.ts";

export interface PaletteMaps {
  tiles: Map<number, PaletteEntry>;
  objects: Map<number, PaletteEntry>;
}

/** id → palette entry, rebuilt only when the palette changes. */
export function usePaletteMaps(): PaletteMaps {
  const palette = useStore(R, (r) => r.palette);
  return useMemo(
    () => ({
      tiles: new Map((palette?.tiles ?? []).map((t) => [t.id, t])),
      objects: new Map((palette?.objects ?? []).map((o) => [o.id, o])),
    }),
    [palette],
  );
}

/** The art resolution of a palette id in the current tileset (undefined while /api/level-art loads). */
export function artOf(art: LevelArtInfo | null, kind: ArtKind, id: number): ArtResolution | undefined {
  return art ? (kind === "tile" ? art.tiles[id] : art.objects[id]) : undefined;
}

/** A tooltip line: the clip and how it was found, or why the swatch is shown. */
export function artLine(a: ArtResolution | undefined): string {
  if (!a) return "";
  return a.ok ? `art: ${a.clip} (${a.swf})${a.mirrored ? ", mirrored" : ""}` : `swatch: ${a.detail}`;
}

export function entryLabel(e: PaletteEntry | undefined, id: number): string {
  return e ? `${id} · ${e.name}${e.cls && e.cls !== e.name ? ` [${e.cls}]` : ""}` : `${id} · (not in the palette)`;
}

/** A thumbnail from /api/level-tile-art that hides itself if the server cannot render it (the swatch under it stays). */
export function ArtImg({ src, kind, className, lazy }: { src: string; kind: ArtKind; className: string; lazy?: boolean }): React.JSX.Element | null {
  const [broken, setBroken] = useState("");
  if (broken === src) return null;
  return <img className={className} data-kind={kind} alt="" draggable={false} loading={lazy ? "lazy" : undefined} src={src} onError={() => setBroken(src)} />;
}
