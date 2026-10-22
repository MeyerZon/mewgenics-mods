// "Import PNG…": a PNG as raster art (raster.ts addBitmapToScene, the same op as MCP import_bitmap). Sprite = a 1-frame
// clip exported for graphics.movieclip (origin at the feet); Background = the same from the top-left corner (a tileset
// combat_background plate, like vanilla's 2000×1500 backgrounds); Fill = only the bitmap-filled shape. Pixel art turns
// smoothing off (fill types 0x42 / 0x43); Tile repeats the bitmap (0x40).

import React from "react";
import { importPngFile } from "./art-state.ts";
import type { RasterMode } from "../../../src/core/art/raster.ts";
import { sx } from "./Bits.tsx";

export function ImportPngRow() {
  const [mode, setMode] = React.useState<RasterMode>("sprite");
  const [scale, setScale] = React.useState("1");
  const [pixel, setPixel] = React.useState(false);
  const [tile, setTile] = React.useState(false);
  return (
    <div className="card plain import-png" style={sx("padding:10px 12px;margin-top:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap")}>
      <label className="btn sm" title="Add a PNG as raster art: a bitmap (DefineBitsLossless2 at build) and a shape filled with it">
        Import PNG…
        <input
          type="file"
          accept=".png,image/png"
          aria-label="Import PNG"
          style={sx("display:none")}
          onChange={(e) => {
            const f = e.target.files && e.target.files[0];
            if (f) void importPngFile(f, { mode, scale: Number(scale) || 1, smooth: !pixel, repeat: tile });
            e.target.value = "";
          }}
        />
      </label>
      <label style={sx("font-size:12.5px")}>
        as{" "}
        <select aria-label="PNG import mode" value={mode} onChange={(e) => setMode(e.target.value as RasterMode)}>
          <option value="sprite">sprite (a character clip, origin at the feet)</option>
          <option value="background">background plate (origin top-left)</option>
          <option value="fill">bitmap fill (a shape only)</option>
        </select>
      </label>
      <label style={sx("font-size:12.5px")} title="clip px per texel; above 1 the game magnifies it softly">
        scale <input aria-label="PNG import scale" style={sx("width:56px")} value={scale} onChange={(e) => setScale(e.target.value)} />
      </label>
      <label style={sx("font-size:12.5px")} title="pixel-snapped sampling (fill type 0x43), no smoothing">
        <input type="checkbox" aria-label="Pixel art" checked={pixel} onChange={(e) => setPixel(e.target.checked)} /> pixel art
      </label>
      <label style={sx("font-size:12.5px")} title="repeat the bitmap outside its rectangle (fill type 0x40)">
        <input type="checkbox" aria-label="Tile" checked={tile} onChange={(e) => setTile(e.target.checked)} /> tile
      </label>
      <span className="muted" style={sx("font-size:12px")}>8-bit PNG, under 4096 px a side (the game's atlas page).</span>
    </div>
  );
}
