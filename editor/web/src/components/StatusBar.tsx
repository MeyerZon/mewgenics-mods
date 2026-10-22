// Bottom status bar and the transient toast queue.

import React from "react";
import { useS } from "./ui.tsx";
import { dismissToast } from "../state.ts";
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

/** The toast queue (S.messages): a polite live region; click a toast to dismiss it. */
export function Toast(): React.JSX.Element {
  const messages = useS((s) => s.messages);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {messages.map((m) => (
        <button key={m.id} type="button" className={`toast ${m.kind}`} title="Dismiss" onClick={() => dismissToast(m.id)}>
          {m.text}
        </button>
      ))}
    </div>
  );
}
