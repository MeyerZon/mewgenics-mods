// The SVG / PNG drop zone and file picker (the empty hero, the Overview's compact one, the Shapes tab's Import card).
// An SVG imports at once; a PNG waits in the Shapes tab's Import PNG strip for its options (art-state
// importIntoSceneOrNew). Only one zone is on screen at a time, so the one input keeps the id art-svg-file.

import React from "react";
import { useStore } from "../store.ts";
import { A, importIntoSceneOrNew, setDropOver } from "./art-state.ts";
import { sx } from "./Bits.tsx";
import { TOUR, tourAttr } from "../tour-anchors.ts";

export function DropZone({ text, title = "Import SVG or PNG", compact }: { text: string; title?: string; compact?: boolean }) {
  const over = useStore(A, (a) => a.dropOver);
  return (
    <label
      className={"dropzone" + (compact ? " compact" : "") + (over ? " over" : "")}
      htmlFor="art-svg-file"
      {...tourAttr(TOUR.artImport)}
      tabIndex={0}
      onKeyDown={(e: React.KeyboardEvent<HTMLLabelElement>) => {
        // the label is focusable (the Art example lands here): Enter / Space opens the file picker
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.currentTarget.querySelector<HTMLInputElement>("input[type=file]")?.click();
      }}
      onDragOver={(e: React.DragEvent) => {
        e.preventDefault();
        setDropOver(true);
      }}
      onDragLeave={() => setDropOver(false)}
      onDrop={async (e: React.DragEvent) => {
        e.preventDefault();
        setDropOver(false);
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) await importIntoSceneOrNew(f);
      }}
    >
      <div style={sx("font-weight:700;margin-bottom:4px;color:var(--ink)")}>{title}</div>
      <div style={sx("font-size:12.5px")}>{text}</div>
      <input
        type="file"
        accept=".svg,.png,image/svg+xml,image/png"
        id="art-svg-file"
        onChange={async (e: React.ChangeEvent<HTMLInputElement>) => {
          const input = e.target;
          const f = input.files && input.files[0];
          if (f) await importIntoSceneOrNew(f);
          input.value = "";
        }}
      />
    </label>
  );
}
