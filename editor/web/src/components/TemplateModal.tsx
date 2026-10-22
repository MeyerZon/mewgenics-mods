// The template scaffolder modal: "New mod" (the mod menu) or "Scaffold an overlay" (+ New overlay). The kind
// list is the core's (src/core/template-kinds.ts); after a scaffold the form gives way to the written files.

import React from "react";
import { tpl, type TemplateForm } from "../state.ts";
import { useStore } from "../store.ts";
import { sx, JsonView, Modal, Field, Button, Summary } from "./ui.tsx";
import { scaffold, closeTemplate, setTemplateKind, openScaffolded } from "../actions.ts";
import { TEMPLATE_KINDS } from "../../../src/core/template-kinds.ts";
import type { TemplateKindName, TemplateResult } from "../types.ts";

type TextKey = keyof Omit<TemplateForm, "kind" | "result" | "intent">;

function TplInput({ name, id, placeholder }: { name: TextKey; id?: string; placeholder?: string }): React.JSX.Element {
  const value = useStore(tpl, (t) => t[name]);
  return <input id={id} value={value} placeholder={placeholder} onChange={(e) => tpl.set({ [name]: e.currentTarget.value } as Partial<TemplateForm>)} />;
}

const FORM_ID = "tplform";

function TemplateFields(): React.JSX.Element {
  const kind = useStore(tpl, (t) => t.kind);
  const result = useStore(tpl, (t) => t.result);
  return (
    <form
      id={FORM_ID}
      className="tplform"
      onSubmit={(e) => {
        e.preventDefault();
        void scaffold();
      }}
    >
      <p className="muted" style={sx("margin:0 0 6px")}>
        {"Generates a GON .append entry plus matching localization rows under mods/<name>/."}
      </p>
      <Field label="mod (folder under mods/)">
        <TplInput name="mod" />
      </Field>
      <Field label="kind">
        <select value={kind} onChange={(e) => setTemplateKind(e.currentTarget.value as TemplateKindName)}>
          {TEMPLATE_KINDS.map((k) => (
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
      {kind === "tileset-variant" ? (
        <Field label="copy of tileset (parent)">
          <TplInput name="parent" />
        </Field>
      ) : null}
      {kind === "glowing-character" ? (
        <Field label="glow colour (rrggbb or rrggbbaa)">
          <TplInput name="colour" placeholder="ff00ff" />
        </Field>
      ) : null}
      {result && !result.ok ? (
        <div className="finding error" style={sx("margin-top:12px")}>
          <span className="mark">✕</span>
          <div>
            <div>{result.error}</div>
            {result.partial && result.partial.length ? <small className="muted">{`written before the error: ${result.partial.join(", ")}`}</small> : null}
          </div>
        </div>
      ) : null}
      {/* Enter in any field submits (the footer's Scaffold is this form's submit button) */}
    </form>
  );
}

type Written = Extract<TemplateResult, { ok: true }>;

function ScaffoldResult({ result, mod }: { result: Written; mod: string }): React.JSX.Element {
  const written = result.written || [];
  return (
    <div className="tplresult">
      <Summary level="ok" title={`Created ${written.length} file${written.length === 1 ? "" : "s"} in mods/${mod}`} detail={result.hint || (result.localizationKeys && result.localizationKeys.length ? `localization keys: ${result.localizationKeys.join(", ")}` : undefined)} />
      <ul className="tplfiles">
        {written.map((p) => (
          <li key={p} className="tplfile">
            <span className="path mono">{p}</span>
            <Button size="sm" variant="ghost" onClick={() => void openScaffolded(p)}>
              Open
            </Button>
          </li>
        ))}
      </ul>
      <details className="tplraw">
        <summary>raw response</summary>
        <JsonView value={result} />
      </details>
    </div>
  );
}

export function TemplateModal(): React.JSX.Element {
  const intent = useStore(tpl, (t) => t.intent);
  const mod = useStore(tpl, (t) => t.mod);
  const result = useStore(tpl, (t) => t.result);
  const done = result && result.ok ? result : null;
  const first = done && done.written && done.written.length ? done.written[0]! : "";
  return (
    <Modal
      title={intent === "mod" ? "New mod" : "Scaffold an overlay"}
      icon="＋"
      onClose={closeTemplate}
      footer={
        done ? (
          <>
            <div className="grow" />
            <Button variant="ghost" onClick={closeTemplate}>
              Done
            </Button>
            {first ? (
              <Button variant="primary" onClick={() => void openScaffolded(first, { validate: true })}>
                Open first file &amp; validate
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <div className="grow" />
            <Button variant="ghost" onClick={closeTemplate}>
              Close
            </Button>
            <Button variant="primary" type="submit" form={FORM_ID}>
              Scaffold
            </Button>
          </>
        )
      }
    >
      {done ? <ScaffoldResult result={done} mod={mod} /> : <TemplateFields />}
    </Modal>
  );
}
