// The template scaffolder modal (+ New overlay / + New mod).

import React from "react";
import { S, tpl, type TemplateForm } from "../state.ts";
import { useStore } from "../store.ts";
import { sx, JsonView, Modal, Field, Button } from "./ui.tsx";
import { scaffold } from "../actions.ts";
import type { TemplateKindName } from "../types.ts";

const KINDS: TemplateKindName[] = ["ability", "passive", "item", "status-data", "particle", "vfx-ability"];

type TextKey = keyof Omit<TemplateForm, "kind" | "result">;

function TplInput({ name, id }: { name: TextKey; id?: string }): React.JSX.Element {
  const value = useStore(tpl, (t) => t[name]);
  return <input id={id} value={value} onChange={(e) => tpl.set({ [name]: e.currentTarget.value } as Partial<TemplateForm>)} />;
}

export function TemplateModal(): React.JSX.Element {
  const kind = useStore(tpl, (t) => t.kind);
  const result = useStore(tpl, (t) => t.result);
  const close = () => S.set({ templateOpen: false });
  return (
    <Modal
      title="Scaffold an overlay"
      icon="＋"
      onClose={close}
      footer={
        <>
          <div className="grow" />
          <Button variant="ghost" onClick={close}>
            Close
          </Button>
          <Button variant="primary" onClick={() => void scaffold()}>
            Scaffold
          </Button>
        </>
      }
    >
      <p className="muted" style={sx("margin:0 0 6px")}>
        {"Generates a GON .append entry plus matching localization rows under mods/<name>/."}
      </p>
      <Field label="mod (folder under mods/)">
        <TplInput name="mod" />
      </Field>
      <Field label="kind">
        <select value={kind} onChange={(e) => tpl.set({ kind: e.currentTarget.value as TemplateKindName })}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </Field>
      <Field label="entry name (GON key)">
        <TplInput name="name" />
      </Field>
      <Field label="display name">
        <TplInput name="display" />
      </Field>
      <Field label="description">
        <TplInput name="desc" />
      </Field>
      {kind === "ability" ? (
        <Field label="variant_of (parent)">
          <TplInput name="parent" />
        </Field>
      ) : null}
      {kind === "ability" ? (
        <Field label="status effect (optional)">
          <TplInput name="status" />
        </Field>
      ) : null}
      {result ? (
        <div className={result.ok ? "finding info" : "finding error"} style={sx("margin-top:12px")}>
          <span className="mark">{result.ok ? "✓" : "✕"}</span>
          <div>
            <JsonView value={result} />
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
