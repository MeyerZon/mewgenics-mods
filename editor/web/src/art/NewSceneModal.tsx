// "New art scene" dialog (opened from the explorer, the empty hero, or the art worked example).

import React, { useRef } from "react";
import { useStore } from "../store.ts";
import { S } from "../state.ts";
import { A, newScene } from "./art-state.ts";
import { sx } from "./Bits.tsx";

export function NewSceneModal() {
  const mod = useStore(S, (s) => s.mod);
  const name = useRef("");
  const close = () => A.set({ newSceneOpen: false });
  return (
    <div className="scrim center" onClick={close}>
      <div className="modal" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
        <div className="mhead">
          <span style={sx("font-size:18px")}>＋</span>
          <div className="t">New art scene</div>
          <button className="iconbtn" aria-label="Close" onClick={close}>✕</button>
        </div>
        <div className="mbody">
          <p className="muted" style={sx("margin:0 0 6px")}>{`Creates mods/${mod}/art/<name>.scene.json from the starter (a bobbing gray square with idle/blink labels).`}</p>
          <label className="fld" htmlFor="newscene-name">scene name (→ swfs/&lt;name&gt;.swf)</label>
          <input
            id="newscene-name"
            className="mono"
            placeholder="my_rat"
            onInput={(e) => (name.current = (e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.current) newScene(name.current);
            }}
          />
        </div>
        <div className="mfoot">
          <div className="grow" />
          <button className="btn ghost" onClick={close}>Cancel</button>
          <button className="btn primary" onClick={() => name.current && newScene(name.current)}>Create</button>
        </div>
      </div>
    </div>
  );
}
