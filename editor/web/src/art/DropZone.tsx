// The SVG drop zone / file picker (shared by the empty hero, the Overview and the Shapes tab).

import React from "react";
import { useStore } from "../store.ts";
import { A, importIntoSceneOrNew } from "./art-state.ts";
import { sx } from "./Bits.tsx";

export function DropZone({ text }: { text: string }) {
  const over = useStore(A, (a) => a.dropOver);
  return (
    <label
      className={"dropzone" + (over ? " over" : "")}
      htmlFor="art-svg-file"
      onDragOver={(e: React.DragEvent) => {
        e.preventDefault();
        A.set({ dropOver: true });
      }}
      onDragLeave={() => A.set({ dropOver: false })}
      onDrop={async (e: React.DragEvent) => {
        e.preventDefault();
        A.set({ dropOver: false });
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) await importIntoSceneOrNew(f);
      }}
    >
      <div style={sx("font-weight:700;margin-bottom:4px;color:var(--ink)")}>Import SVG</div>
      <div style={sx("font-size:12.5px")}>{text}</div>
      <input
        type="file"
        accept=".svg,image/svg+xml,.png,image/png"
        id="art-svg-file"
        onChange={async (e: React.ChangeEvent<HTMLInputElement>) => {
          const f = e.target.files;
          if (f && f[0]) await importIntoSceneOrNew(f[0]);
        }}
      />
    </label>
  );
}
