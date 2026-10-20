// The template scaffolder modal (+ New overlay / + New mod).

import React from "react";
import { S, tpl, type TemplateForm } from "../state.ts";
import { useStore } from "../store.ts";
import { sx, JsonView } from "./ui.tsx";
import { scaffold } from "../actions.ts";
import type { TemplateKindName } from "../types.ts";

const KINDS: TemplateKindName[] = ["ability", "passive", "item", "status-data"];

function Field({ name }: { name: keyof Omit<TemplateForm, "kind" | "result"> }): React.JSX.Element {
  const value = useStore(tpl, (t) => t[name]);
  return <input value={value} onChange={(e) => tpl.set({ [name]: e.currentTarget.value } as Partial<TemplateForm>)} />;
}

export function TemplateModal(): React.JSX.Element {
  const kind = useStore(tpl, (t) => t.kind);
  const result = useStore(tpl, (t) => t.result);
  const close = () => S.set({ templateOpen: false });
  return (
    <div className="scrim center" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="mhead">
          <span style={sx("font-size:18px")}>＋</span>
          <div className="t">Scaffold an overlay</div>
          <button className="iconbtn" aria-label="Close" onClick={close}>
            ✕
          </button>
        </div>
        <div className="mbody">
          <p className="muted" style={sx("margin:0 0 6px")}>
            {"Generates a GON .append entry plus matching localization rows under mods/<name>/."}
          </p>
          <label className="fld">mod (folder under mods/)</label>
          <Field name="mod" />
          <label className="fld">kind</label>
          <select value={kind} onChange={(e) => tpl.set({ kind: e.currentTarget.value as TemplateKindName })}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <label className="fld">entry name (GON key)</label>
          <Field name="name" />
          <label className="fld">display name</label>
          <Field name="display" />
          <label className="fld">description</label>
          <Field name="desc" />
          {kind === "ability" ? <label className="fld">variant_of (parent)</label> : null}
          {kind === "ability" ? <Field name="parent" /> : null}
          {kind === "ability" ? <label className="fld">status effect (optional)</label> : null}
          {kind === "ability" ? <Field name="status" /> : null}
          {result ? (
            <div className={result.ok ? "finding info" : "finding error"} style={sx("margin-top:12px")}>
              <span className="mark">{result.ok ? "✓" : "✕"}</span>
              <div>
                <JsonView value={result} />
              </div>
            </div>
          ) : null}
        </div>
        <div className="mfoot">
          <div className="grow" />
          <button className="btn ghost" onClick={close}>
            Close
          </button>
          <button className="btn primary" onClick={() => void scaffold()}>
            Scaffold
          </button>
        </div>
      </div>
    </div>
  );
}
