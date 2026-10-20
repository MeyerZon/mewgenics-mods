// Bottom status bar and the transient toast.

import React from "react";
import { useS, sx } from "./ui.tsx";
import { currentFile, modeNote } from "../actions.ts";

export function StatusBar(): React.JSX.Element {
  const mod = useS((s) => s.mod);
  const file = useS((s) => s.file);
  const files = useS((s) => s.files);
  const f = currentFile(file, files);
  return (
    <div className="statusbar">
      <span className="mono">{mod && file ? `${mod}/${file}` : mod ? mod : "Ready"}</span>
      <div className="grow" />
      {f ? <span className="mono">{modeNote(f.mode)}</span> : null}
      {file ? <span className="sep">|</span> : null}
      <span className="mono">build dev</span>
      <span className="dotok" title="Connected to the local editor server">
        ● local server
      </span>
      <span className="mono">save: dev</span>
    </div>
  );
}

export function Toast(): React.JSX.Element | null {
  const message = useS((s) => s.message);
  if (!message) return null;
  return (
    <div
      style={sx(
        "position:fixed;left:50%;bottom:44px;transform:translateX(-50%);z-index:120;background:var(--elev);border:1px solid var(--line2);border-radius:10px;padding:10px 16px;box-shadow:0 18px 50px rgba(0,0,0,.5);font-size:13px;max-width:min(620px,92vw);color:var(--ink)",
      )}
    >
      {message}
    </div>
  );
}
