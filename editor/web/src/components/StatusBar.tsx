// Bottom status bar (what is open per mode, the overlay mode, the installed game build and what is extracted /
// built from GET /api/status, the server dot, the save suffix) and the transient toast queue.

import React from "react";
import { useS } from "./ui.tsx";
import { useStore } from "../store.ts";
import { dismissToast } from "../state.ts";
import { currentFile, modeNote } from "../actions.ts";
import { A } from "../art/art-state.ts";
import { R } from "../rooms/room-state.ts";
import type { EditorStatus } from "../types.ts";

const tick = (b: boolean | undefined) => (b ? "✓" : "–");

function buildChip(st: EditorStatus | null): { text: string; warn: boolean; title: string } {
  if (!st) return { text: "build …", warn: false, title: "asking the editor server…" };
  const lines = [
    `game folder: ${st.gameDir}${st.exeFound ? "" : " (no Mewgenics.exe found)"}`,
    `known builds (bindings/*.json): ${st.knownBuilds.join(", ") || "none"}`,
    `mewframework.dll in native/dist: ${st.frameworkDll ? "yes" : "no"}`,
    `mewtest.dll in native/dist: ${st.mewtestDll ? "yes" : "no"}`,
    `Mewjector (version.dll) in the game folder: ${st.mewjector ? "yes" : "no"}`,
    `extracted base data: ${st.extracted ? "yes" : "no"} · extracted SWFs: ${st.extractedSwfs ? "yes" : "no"}`,
  ];
  if (st.mod?.compare) lines.push(`mods/${st.mod.name} was tested on build ${st.mod.compare.modBuild}: ${st.mod.compare.status}`);
  const title = lines.join("\n");
  if (!st.exeFound) return { text: "build unknown", warn: true, title };
  if (!st.known) return { text: `build unknown (${st.timeDateStamp ?? "?"})`, warn: true, title: `${title}\nnative mods stay disabled on an unknown build (port the bindings)` };
  return { text: `build ${st.gameBuild}`, warn: false, title };
}

export function StatusBar(): React.JSX.Element {
  const mod = useS((s) => s.mod);
  const file = useS((s) => s.file);
  const files = useS((s) => s.files);
  const artMode = useS((s) => s.artMode);
  const roomMode = useS((s) => s.roomMode);
  const status = useS((s) => s.status);
  const serverOk = useS((s) => s.serverOk);
  const scenePath = useStore(A, (a) => a.scenePath);
  const roomPath = useStore(R, (r) => r.path);
  const open = roomMode ? roomPath : artMode ? scenePath : file;
  const f = !artMode && !roomMode ? currentFile(file, files) : null;
  const b = buildChip(status);
  return (
    <div className="statusbar">
      <span className="mono">{mod && open ? `${mod}/${open}` : mod ? mod : "Ready"}</span>
      <div className="grow" />
      {f ? <span className="mono">{modeNote(f.mode)}</span> : null}
      {f ? <span className="sep">|</span> : null}
      <span className={"mono" + (b.warn ? " warn" : "")} title={b.title}>
        {b.text}
      </span>
      <span className="mono" title={status ? `base data${status.extracted ? "" : " not"} extracted (.extracted/); SWFs${status.extractedSwfs ? "" : " not"} extracted` : ""}>
        {`extracted ${tick(status?.extracted)}`}
      </span>
      <span className="mono" title={status ? `native/dist/mewframework.dll${status.frameworkDll ? "" : " missing (build native/framework)"}` : ""}>
        {`framework ${tick(status?.frameworkDll)}`}
      </span>
      <span className={serverOk ? "dotok" : "doterr"} title={serverOk ? "Connected to the local editor server" : "The local editor server did not answer"}>
        ● local server
      </span>
      <span className="mono" title="modded play writes isolated *dev* saves (launch-dev.bat)">{`save: ${status?.saveSuffix ?? "dev"}`}</span>
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
