// Right pane in Data mode: Validation | Preview | Components tabs.

import React from "react";
import { TOUR } from "../tour-anchors.ts";
import { useS, sx, CodeView, Tabs, Summary, FindingsList, Pill, SearchBox, Button } from "./ui.tsx";
import { setTab, scheduleComponentSearch, searchComponents } from "../actions.ts";
import type { Tab } from "../state.ts";
import type { ComponentSearchResult, ComponentUsage } from "../types.ts";

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
      <Summary level={level} title={title} detail={`${e} errors · ${w} warnings · ${infos} info`} />
      <div style={sx("margin-top:14px")}>
        <FindingsList
          findings={rep.findings || []}
          empty={
            <p className="dotok" style={sx("margin:2px 0")}>
              No findings — looks good.
            </p>
          }
        />
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
  const baseMark = (
    <Pill kind={pv.baseExists ? "ok" : "muted"} chip>
      {`base ${pv.baseExists ? "found" : "missing"}`}
    </Pill>
  );
  if (pv.kind === "csv") {
    return (
      <div>
        <p className="muted pvmeta">
          <Pill kind={pv.mode} chip>{`CSV ${pv.mode}`}</Pill> {baseMark} {pv.note ? <span>{pv.note}</span> : null}
        </p>
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
      <p className="muted pvmeta">
        <Pill kind={pv.mode} chip>{`GON ${pv.mode}`}</Pill> {baseMark} <span>{`${pv.effectiveEntryCount} effective entries`}</span>
      </p>
      {pv.touched.map((t) => (
        <div key={t.key} className="card">
          <div style={sx("display:flex;align-items:center;gap:8px;margin-bottom:8px")}>
            <span className="mono" style={sx("color:var(--ink)")}>
              {t.key}
            </span>
            <Pill kind={t.status === "added" ? "ok" : t.status === "changed" ? "warn" : "muted"} chip>
              {t.status === "added" ? "+ added" : t.status}
            </Pill>
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

/** The keys a component reads, shown when the search is exactly one class name (click a name to get there). */
function ComponentKeys({ components }: { components: ComponentSearchResult }): React.JSX.Element | null {
  const c = (components.schema || []).find((x) => x.name === components.query);
  if (!c) return null;
  const keys = Object.entries(c.keys);
  return (
    <div className="compkeys" data-testid="component-keys">
      <div className="sec">{`${c.name} reads`}</div>
      {keys.length === 0 ? <small className="muted">no keys of its own (scalar form = stacks)</small> : null}
      {keys.map(([k, v]) => (
        <div key={k} className="ck">
          <code>{k}</code> <small className="muted">{`${v.type}${v.default !== null ? ` = ${String(v.default)}` : ""}${v.required ? " (required)" : ""}${v.unread ? " (vanilla writes it; the game ignores it)" : ""}${v.from !== c.name ? ` · from ${v.from}` : ""}`}</small>
        </div>
      ))}
      {c.children ? <small className="muted">{`also takes ${c.children} names as children`}</small> : null}
      {c.open ? <small className="muted">key list may be incomplete: unknown keys are not flagged</small> : null}
    </div>
  );
}

/** How many where-used files a result lists before "show all". */
const WHERE_USED_SHOWN = 8;
/** The server lists at most this many files per class (api.searchComponents asks components.whereUsed for 20). */
const WHERE_USED_CAP = 20;

/** A matched class: its button (click = search exactly it) and, when known, the base files that use it. */
const ComponentRow = React.memo(function ComponentRow({ name, usedIn }: { name: string; usedIn: ComponentUsage[] | undefined }): React.JSX.Element {
  const [all, setAll] = React.useState(false);
  const button = (
    <button className="ci" onClick={() => void searchComponents(name)}>
      {name}
    </button>
  );
  if (!usedIn) return button;
  const n = usedIn.length;
  const shown = all ? usedIn : usedIn.slice(0, WHERE_USED_SHOWN);
  return (
    <div className="wu">
      {button}
      <small className="muted wucount">{n === 0 ? "not used in the base data" : `used in ${n}${n >= WHERE_USED_CAP ? "+" : ""} file${n === 1 ? "" : "s"}`}</small>
      {n ? (
        <ul className="wufiles">
          {shown.map((u) => (
            <li key={u.file} className="wufile" title={u.sample.join("\n")}>
              <span className="mono">{u.file}</span> <small className="muted">{`×${u.hits}`}</small>
            </li>
          ))}
        </ul>
      ) : null}
      {n > WHERE_USED_SHOWN ? (
        <Button size="sm" variant="ghost" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? "show fewer" : `show all ${n}`}
        </Button>
      ) : null}
    </div>
  );
});

export function ComponentSearch(): React.JSX.Element {
  const components = useS((s) => s.components);
  const [query, setQuery] = React.useState("");
  const usage = React.useMemo(() => new Map((components?.whereUsed || []).map((w) => [w.name, w.usedIn] as const)), [components]);
  return (
    <div>
      <SearchBox
        value={query}
        placeholder="search glaiel:: class names…"
        aria-label="Search C++ component class names"
        style={sx("margin:0 0 10px")}
        onChange={(v) => {
          setQuery(v);
          scheduleComponentSearch(v.trim());
        }}
      />
      {components ? (
        <div>
          <small className="muted">{`${components.count} match`}</small>
          <ComponentKeys components={components} />
          <div className="complist">
            {(components.names || []).map((n) => (
              <ComponentRow key={n} name={n} usedIn={usage.get(n)} />
            ))}
          </div>
        </div>
      ) : (
        <p className="muted">Search the 2,000+ behavior component names the native layer exposes.</p>
      )}
    </div>
  );
}

const TABS: { id: Tab; label: string; tour?: string }[] = [
  { id: "validation", label: "Validation", tour: TOUR.validation },
  { id: "preview", label: "Preview", tour: TOUR.preview },
  { id: "components", label: "Components" },
];

export function RightPanel(): React.JSX.Element {
  const tab = useS((s) => s.tab);
  return (
    <div className="rightpanel">
      <Tabs items={TABS} value={tab} onChange={setTab} aria-label="Data mode panels" />
      <div className="panelbody" role="tabpanel">
        {tab === "preview" ? <PreviewPanel /> : tab === "components" ? <ComponentSearch /> : <ValidationPanel />}
      </div>
    </div>
  );
}
