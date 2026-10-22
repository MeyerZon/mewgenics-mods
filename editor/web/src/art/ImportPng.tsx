// The Shapes tab's Import card: one drop zone for an SVG or a PNG ("Import SVG or PNG"). An SVG imports at once; a
// PNG — picked or dropped, here or on any other Art drop zone — waits in the "Import PNG" strip below for its options,
// then Import adds it as raster art (raster.ts addBitmapToScene, the same op as MCP import_bitmap). Sprite = a 1-frame
// clip exported for graphics.movieclip (origin at the feet); Background = the same from the top-left corner (a tileset
// combat_background plate, like vanilla's 2000×1500 backgrounds); Fill = only the bitmap-filled shape. Pixel art turns
// smoothing off (bitmap smooth: false → fill types 0x42 / 0x43); Tile repeats the bitmap (0x40).

import React, { useState } from "react";
import { useStore } from "../store.ts";
import { A, importPendingPng, clearPendingPng } from "./art-state.ts";
import type { RasterMode } from "../../../src/core/art/raster.ts";
import { sx } from "./Bits.tsx";
import { DropZone } from "./DropZone.tsx";
import { Button, Checkbox, Select } from "../components/ui.tsx";

const MODES: { value: RasterMode; label: string }[] = [
  { value: "sprite", label: "sprite (a character clip, origin at the feet)" },
  { value: "background", label: "background plate (origin top-left)" },
  { value: "fill", label: "bitmap fill (a shape only)" },
];

export function ImportCard() {
  return (
    <div className="import-card" style={sx("margin-top:12px")}>
      <DropZone title="Import SVG or PNG" text="Drop an SVG or a PNG here, or click to pick one. Each SVG becomes one shape (many paths); a PNG becomes raster art with the options that appear below." />
      <ImportPngStrip />
    </div>
  );
}

/** The PNG options of the waiting file, with Import / Cancel; nothing while no PNG waits. */
export function ImportPngStrip() {
  const file = useStore(A, (a) => a.pendingPng);
  const [mode, setMode] = useState<RasterMode>("sprite");
  const [scale, setScale] = useState("1");
  const [pixel, setPixel] = useState(false);
  const [tile, setTile] = useState(false);
  if (!file) return null;
  return (
    <div className="card plain import-png" style={sx("padding:10px 12px;margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap")}>
      <span className="sec" style={sx("flex-basis:100%")}>{`Import PNG — ${file.name}`}</span>
      <label style={sx("font-size:12.5px")}>
        as <Select aria-label="PNG import mode" value={mode} onChange={setMode} options={MODES} />
      </label>
      <label style={sx("font-size:12.5px")} title="clip px per texel; above 1 the game magnifies it softly">
        scale <input aria-label="PNG import scale" type="number" min={0.01} step="any" className="artinput num" value={scale} onChange={(e) => setScale(e.target.value)} />
      </label>
      <Checkbox aria-label="Pixel art" checked={pixel} onChange={setPixel} title="pixel-snapped sampling (fill type 0x43), no smoothing">
        pixel art
      </Checkbox>
      <Checkbox aria-label="Tile" checked={tile} onChange={setTile} title="repeat the bitmap outside its rectangle (fill type 0x40)">
        tile
      </Checkbox>
      <div className="grow" />
      <Button variant="primary" size="sm" onClick={() => void importPendingPng({ mode, scale: Number(scale) || 1, smooth: !pixel, repeat: tile })}>
        Import
      </Button>
      <Button variant="ghost" size="sm" onClick={clearPendingPng}>
        Cancel
      </Button>
      <span className="muted" style={sx("font-size:12px;flex-basis:100%")}>8-bit PNG, under 4096 px a side (the game's atlas page).</span>
    </div>
  );
}
