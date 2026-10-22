// Left pane in Data mode: the mod's overlay files (as a tree) and the read-only base data.

import React from "react";
import { useS, sx, Pill } from "./ui.tsx";
import { buildTree, type TreeNode } from "../tree.ts";
import { openTemplate, openFile, selectCategory, viewBaseEntry, setBaseFilter, openComponents } from "../actions.ts";

function TreeRows({ node, depth, collapsed, toggleDir }: { node: TreeNode; depth: number; collapsed: Record<string, boolean>; toggleDir: (p: string) => void }): React.JSX.Element {
  const file = useS((s) => s.file);
  const rows: React.JSX.Element[] = [];
  for (const [name, child] of node.dirs) {
    const isCollapsed = !!collapsed[child.path];
    rows.push(
      <button key={"d:" + child.path} className="srow dir" style={{ paddingLeft: `${8 + depth * 14}px` }} onClick={() => toggleDir(child.path)}>
        <span className="caret">{isCollapsed ? "▸" : "▾"}</span>
        <span>{name}</span>
      </button>,
    );
    if (!isCollapsed) rows.push(<TreeRows key={"t:" + child.path} node={child} depth={depth + 1} collapsed={collapsed} toggleDir={toggleDir} />);
  }
  for (const f of node.files) {
    rows.push(
      <button
        key={"f:" + f.relPath}
        className={"srow" + (file === f.relPath ? " sel" : "")}
        style={{ paddingLeft: `${8 + depth * 14 + 14}px` }}
        title={`${f.mode} · ${f.fileType}`}
        onClick={() => void openFile(f.relPath)}
      >
        <span className="fname" style={sx("flex:1")}>
          {f.leaf}
        </span>
        {f.mode && f.mode !== "replace" ? <span className={`pill ${f.mode} chip`}>{"." + f.mode}</span> : null}
        {/\.lvl$/i.test(f.relPath) ? (
          <Pill kind="muted" chip title="Opens in Rooms mode">
            room ↗
          </Pill>
        ) : null}
      </button>,
    );
  }
  return <>{rows}</>;
}

function ModFilesSection(): React.JSX.Element {
  const mod = useS((s) => s.mod);
  const files = useS((s) => s.files);
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  const toggleDir = (path: string) => setCollapsed((cur) => ({ ...cur, [path]: !cur[path] }));
  const tree = React.useMemo(() => buildTree(files), [files]);
  return (
    <div>
      <div className="exhead">
        <span className="sec">Mod files</span>
        {mod ? (
          <button className="btn ghost sm" style={sx("color:var(--acc-ink)")} onClick={() => openTemplate({ mod })}>
            + New overlay
          </button>
        ) : null}
      </div>
      {!mod ? (
        <div className="dashed">
          <div style={sx("font-size:13px;margin-bottom:12px")}>No mod open yet.</div>
          <button className="btn primary" style={sx("width:100%")} onClick={() => openTemplate({ mod: "" })}>
            + New mod
          </button>
        </div>
      ) : (
        <div className="exbody tw">
          {files.length ? (
            <TreeRows node={tree} depth={0} collapsed={collapsed} toggleDir={toggleDir} />
          ) : (
            <div className="srow" style={sx("color:var(--muted)")}>
              (no overlay files)
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Entries of the currently-selected base category. Subscribed to baseEntries only, so an
// async category/filter result repaints these rows without touching the category list.
function BaseEntriesList(): React.JSX.Element {
  const entries = useS((s) => s.baseEntries);
  const total = useS((s) => s.baseEntriesTotal);
  if (!entries.length) {
    return (
      <div className="entries">
        <div className="srow" style={sx("color:var(--muted)")}>
          (no entries)
        </div>
      </div>
    );
  }
  return (
    <div className="entries">
      {entries.map((n) => (
        <button key={n} className="srow" style={sx("padding-left:22px")} onClick={() => void viewBaseEntry(n)}>
          <span className="fname">{n}</span>
        </button>
      ))}
      {total > entries.length ? (
        <div className="srow" style={sx("color:var(--muted);padding-left:22px;font-size:11.5px")}>
          {`showing ${entries.length} of ${total.toLocaleString()} — refine the search`}
        </div>
      ) : null}
    </div>
  );
}

function CategoryRow({ category, count }: { category: string; count: number }): React.JSX.Element {
  const selected = useS((s) => s.baseCategory === category);
  return (
    <div className="tw">
      <button className={"srow" + (selected ? " sel" : "")} onClick={() => void selectCategory(category)}>
        <span style={sx("flex:1")}>{category}</span>
        <span className="count">{String(count)}</span>
      </button>
      {selected ? <BaseEntriesList /> : null}
    </div>
  );
}

function ComponentsRow(): React.JSX.Element {
  const compTotal = useS((s) => s.compTotal);
  return (
    <button
      className="srow acc"
      onClick={() => openComponents()}
    >
      <span style={sx("flex:1")}>components</span>
      <span className="count">{compTotal ? compTotal.toLocaleString() : "search"}</span>
    </button>
  );
}

function BaseDataSection(): React.JSX.Element {
  const baseCats = useS((s) => s.baseCats);
  return (
    <div>
      <div className="exhead">
        <span className="sec">Base data</span>
        <small className="muted">· read-only</small>
      </div>
      <div className="search">
        <span aria-hidden="true">⌕</span>
        <input
          placeholder="Search abilities, items, components…"
          aria-label="Filter base-data entries in the selected category"
          onChange={(e) => setBaseFilter(e.currentTarget.value)}
        />
      </div>
      <div className="exbody">
        {/* The category list depends only on baseCats; each category's entries are their own
            component, so selecting a category or filtering repaints only that category's rows. */}
        <div className="tw">
          {baseCats.map((c) => (
            <CategoryRow key={c.category} category={c.category} count={c.count} />
          ))}
          <ComponentsRow />
        </div>
      </div>
    </div>
  );
}

export function Explorer(): React.JSX.Element {
  return (
    <div className="explorer">
      <ModFilesSection />
      <div className="exdiv" />
      <BaseDataSection />
    </div>
  );
}
