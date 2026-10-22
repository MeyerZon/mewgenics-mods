// The JSON tab: the whole scene as text, applied with Apply. The text is local state: an edit elsewhere (another tab,
// the palette row, a validation) never wipes what is typed. When the scene changes underneath typed text a banner
// offers Reload (take the scene's JSON) or Keep (go on with the typed text; Apply would overwrite the change). Untyped
// text simply follows the scene.

import React, { useEffect, useRef, useState } from "react";
import { useStore } from "../store.ts";
import { A, getScene, applySceneJson } from "./art-state.ts";
import { Button } from "../components/ui.tsx";

function sceneText(): string {
  const sc = getScene();
  return sc ? JSON.stringify(sc, null, 2) : A.get().jsonText;
}

export function JsonTab() {
  const rev = useStore(A, (a) => a.rev);
  const jsonError = useStore(A, (a) => a.jsonError);
  const [text, setText] = useState(sceneText);
  const [stale, setStale] = useState(false);
  /** the scene JSON the text was last taken from (or kept against) */
  const base = useRef(text);
  const typed = useRef(false);
  useEffect(() => {
    const now = sceneText();
    if (now === base.current) return;
    if (typed.current) {
      setStale(true);
      return;
    }
    base.current = now;
    setText(now);
  }, [rev]);
  const reload = () => {
    const now = sceneText();
    base.current = now;
    typed.current = false;
    setText(now);
    setStale(false);
  };
  const keep = () => {
    base.current = sceneText();
    setStale(false);
  };
  return (
    <div>
      <div className="artsec">
        <span className="sec">Scene JSON — the whole source model</span>
        <button
          className="btn primary sm"
          onClick={() => {
            typed.current = false;
            setStale(false);
            if (!applySceneJson(text)) typed.current = true;
          }}
        >
          Apply
        </button>
      </div>
      {stale ? (
        <div className="finding warning json-stale" role="status">
          <span className="mark">!</span>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span>scene changed underneath — Reload / Keep</span>
            <Button size="sm" onClick={reload}>Reload</Button>
            <Button size="sm" variant="ghost" onClick={keep}>Keep</Button>
          </div>
        </div>
      ) : null}
      {jsonError ? (
        <div className="finding error">
          <span className="mark">✕</span>
          <div>{jsonError}</div>
        </div>
      ) : null}
      <textarea
        className="scenejson"
        spellCheck={false}
        aria-label="scene JSON"
        value={text}
        onChange={(e) => {
          typed.current = true;
          setText(e.target.value);
        }}
      />
    </div>
  );
}
