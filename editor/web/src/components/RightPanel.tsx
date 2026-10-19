// Right pane in Data mode: Validation | Preview | Components tabs.

import React from "react";
import { useS, sx, CodeView } from "./ui.tsx";
import { setTab, scheduleComponentSearch, searchComponents } from "../actions.ts";
import type { Tab } from "../state.ts";

function ValidationPanel(): React.JSX.Element {
  const rep = useS((s) => s.report);
  if (!rep || !rep.counts) return <p className="muted">Edit a file to see validation.</p>;
  const e = rep.counts.errors | 0;
  const w = rep.counts.warnings | 0;
  const infos = rep.counts.infos | 0;
  const level = e > 0 ? "err" : w > 0 ? "warn" : "ok";
  const title = e > 0 ? `${e} error${e === 1 ? "" : "s"}` : w > 0 ? `${w} warning${w === 1 ? "" : "s"}` : "Valid overlay";
  return (
    <div>
      <div className={`summary ${level}`}>
        <div className="badge">{level === "ok" ? "✓" : "!"}</div>
        <div>
          <div className="t">{title}</div>
          <div className="d">{`${e} errors · ${w} warnings · ${infos} info`}</div>
        </div>
      </div>
      <div style={sx("margin-top:14px")}>
        {rep.findings && rep.findings.length ? (
          rep.findings.map((f, i) => (
            <div key={i} className={`finding ${f.severity}`}>
              <span className="mark">{f.severity === "error" ? "✕" : f.severity === "warning" ? "!" : "i"}</span>
              <div>
                <div>
                  <span className="code">{f.code}</span>
                  {f.location && f.location.path ? <span className="muted">{`  @ ${f.location.path}`}</span> : null}
                  {f.location && f.location.line ? <span className="muted">{`  line ${f.location.line}`}</span> : null}
                </div>
                <div>{f.message}</div>
              </div>
            </div>
          ))
        ) : (
          <p className="dotok" style={sx("margin:2px 0")}>
            No findings — looks good.
          </p>
        )}
      </div>
    </div>
  );
}

function PreviewPanel(): React.JSX.Element {
  const pv = useS((s) => s.preview);
  if (!pv) return <p className="muted">Edit a file to see the merge preview.</p>;
  if (!pv.ok) {
    return (
      <div className="finding error">
        <span className="mark">✕</span>
        <div>{pv.error || "preview failed"}</div>
      </div>
    );
  }
  if (pv.kind === "csv") {
    return (
      <div>
        <p className="muted">{`CSV ${pv.mode} · base ${pv.baseExists ? "found" : "missing"} · ${pv.note || ""}`}</p>
        {pv.addedRows ? <CodeView text={pv.addedRows.map((r) => r.join(",")).join("\n")} /> : null}
        {pv.changedRows ? <CodeView text={pv.changedRows.map((c) => `row ${c.rowIndex}:\n  - ${c.before.join(",")}\n  + ${c.after.join(",")}`).join("\n")} /> : null}
      </div>
    );
  }
  return (
    <div>
      <div className="sec" style={sx("margin-bottom:8px")}>
        Merge preview
      </div>
      <p className="muted">{`GON ${pv.mode} · base ${pv.baseExists ? "found" : "missing"} · ${pv.effectiveEntryCount} effective entries`}</p>
      {pv.touched.map((t) => (
        <div key={t.key} className="card">
          <div style={sx("display:flex;align-items:center;gap:8px;margin-bottom:8px")}>
            <span className="mono" style={sx("color:var(--ink)")}>
              {t.key}
            </span>
            <span className={`pill ${t.status === "added" ? "ok" : t.status === "changed" ? "warn" : "muted"} chip`}>{t.status === "added" ? "+ added" : t.status}</span>
          </div>
          <div className="cols">
            <div>
              <div className="sec" style={sx("margin-bottom:4px")}>
                base
              </div>
              <CodeView text={t.base || "(absent)"} />
            </div>
            <div>
              <div className="sec" style={sx("margin-bottom:4px")}>
                effective
              </div>
              <CodeView text={t.effective || "(removed)"} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function ComponentSearch(): React.JSX.Element {
  const components = useS((s) => s.components);
  return (
    <div>
      <div className="search" style={sx("margin:0 0 10px")}>
        <span aria-hidden="true">⌕</span>
        <input placeholder="search glaiel:: class names…" aria-label="Search C++ component class names" onChange={(e) => scheduleComponentSearch(e.currentTarget.value.trim())} />
      </div>
      {components ? (
        <div>
          <small className="muted">{`${components.count} match`}</small>
          <div className="complist">
            {(components.names || []).map((n) => (
              <button key={n} className="ci" onClick={() => void searchComponents(n)}>
                {n}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <p className="muted">Search the 2,000+ behavior component names the native layer exposes.</p>
      )}
    </div>
  );
}

export function RightPanel(): React.JSX.Element {
  const tab = useS((s) => s.tab);
  const mk = (id: Tab, labelText: string) => (
    <button className={"tab" + (tab === id ? " active" : "")} onClick={() => setTab(id)}>
      {labelText}
    </button>
  );
  return (
    <div className="rightpanel">
      <div className="tabs">
        {mk("validation", "Validation")}
        {mk("preview", "Preview")}
        {mk("components", "Components")}
      </div>
      <div className="panelbody">{tab === "preview" ? <PreviewPanel /> : tab === "components" ? <ComponentSearch /> : <ValidationPanel />}</div>
    </div>
  );
}
