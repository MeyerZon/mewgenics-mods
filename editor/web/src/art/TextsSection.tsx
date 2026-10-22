// The Shapes tab's Texts section: DefineEditText characters in one of the game's own fonts (swfs/fonts.swf classes;
// text.ts), placed by keys like shapes. The game draws them in its font; the preview uses the font if installed here,
// else a serif stand-in.

import React from "react";
import { useStore } from "../store.ts";
import { toast } from "../state.ts";
import { A, getScene, setTexts } from "./art-state.ts";
import { sx, CommitInput } from "./Bits.tsx";
import { GAME_FONTS } from "../../../src/core/art/text.ts";
import type { SceneText } from "../../../src/core/art/text.ts";
import type { Scene } from "./types.ts";

export function TextsSection() {
  useStore(A, (a) => a.rev);
  const sc = getScene() as Scene;
  const texts = sc.texts || {};
  const ids = Object.keys(texts);
  const set = (id: string, patch: Partial<SceneText>) => setTexts({ ...texts, [id]: { ...texts[id]!, ...patch } });
  const add = () => {
    let id = "text";
    let n = 2;
    while (texts[id] || sc.shapes[id] || sc.sprites[id]) id = `text${n++}`;
    setTexts({ ...texts, [id]: { text: "Text", font: "Peralta", size: 24, color: "#000000", align: "center", width: 200, height: 40 } });
    toast(`added text "${id}" — place it on a sprite layer like a shape`);
  };
  const remove = (id: string) => {
    const next = { ...texts };
    delete next[id];
    setTexts(next);
  };
  return (
    <div style={sx("margin-top:16px")}>
      <div className="artsec">
        <span className="sec">{`Texts (${ids.length}) — DefineEditText in a game font`}</span>
        <button className="btn ghost sm" onClick={add}>New text</button>
      </div>
      {ids.map((id) => {
        const t = texts[id]!;
        return (
          <div key={id} className="artrow text-row">
            <span className="id">{id}</span>
            <CommitInput className="artinput" style={sx("flex:1")} aria-label={`words of ${id}`} initial={t.text} onCommit={(v) => set(id, { text: v })} />
            <select className="artinput" aria-label={`font of ${id}`} value={t.font || "Peralta"} onChange={(e) => set(id, { font: e.target.value })}>
              {GAME_FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <CommitInput className="artinput num" type="number" min={1} aria-label={`size of ${id}`} initial={t.size} onCommit={(v) => set(id, { size: Math.max(1, Number(v) || 1) })} />
            <CommitInput className="artinput mono" style={sx("width:90px")} aria-label={`colour of ${id}`} initial={t.color || "#000000"} onCommit={(v) => set(id, { color: v })} />
            <select className="artinput" aria-label={`align of ${id}`} value={t.align || "center"} onChange={(e) => set(id, { align: e.target.value as SceneText["align"] })}>
              <option value="left">left</option>
              <option value="center">center</option>
              <option value="right">right</option>
            </select>
            <label className="muted" title="no HTML flag: the game substitutes a localization key only in a plain text (text-loc-key-html)">
              <input type="checkbox" aria-label={`plain (localized) of ${id}`} checked={t.html === false} onChange={(e) => set(id, { html: e.target.checked ? false : undefined })} />
              {" plain (localized)"}
            </label>
            <button className="btn ghost sm" style={sx("color:var(--err)")} aria-label={`Delete text ${id}`} onClick={() => remove(id)}>Delete</button>
          </div>
        );
      })}
    </div>
  );
}
