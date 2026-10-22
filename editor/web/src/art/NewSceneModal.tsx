// "New art scene" dialog (opened from the explorer, the empty hero, or the art worked example).

import React, { useRef } from "react";
import { useStore } from "../store.ts";
import { S } from "../state.ts";
import { newScene, closeNewSceneModal } from "./art-state.ts";
import { sx } from "./Bits.tsx";
import { Modal, Button } from "../components/ui.tsx";

export function NewSceneModal() {
  const mod = useStore(S, (s) => s.mod);
  const name = useRef("");
  const close = () => closeNewSceneModal();
  return (
    <Modal
      title="New art scene"
      icon="＋"
      onClose={close}
      initialFocus="#newscene-name"
      footer={
        <>
          <div className="grow" />
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={() => name.current && newScene(name.current)}>Create</Button>
        </>
      }
    >
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
    </Modal>
  );
}
