// Left pane in Data mode: the mod's overlay files (as a tree) and the read-only base data.

import React from "react";
import { useS, sx, Pill, SearchBox, SectionHeader, Button, type PillKind } from "./ui.tsx";
import { BASE_PAGE } from "../state.ts";
import { buildTree, type TreeNode } from "../tree.ts";
import { openTemplate, openFile, selectCategory, viewBaseEntry, setBaseFilter, openComponents, showMoreBase } from "../actions.ts";

function TreeRows({ node, depth, collapsed, toggleDir }: { node: TreeNode; depth: number; collapsed: Record<string, boolean>; toggleDir: (p: string) => void }): React.JSX.Element {
  const file = useS((s) => s.file);
  const rows: React.JSX.Element[] = [];
  for (const [name, child] of node.dirs) {
    const isCollapsed = !!collapsed[child.path];
    rows.push(
      <button key={"d:" + child.path} className="srow dir" aria-expanded={!isCollapsed} style={{ paddingLeft: `${8 + depth * 14}px` }} onClick={() => toggleDir(child.path)}>
        <span className="caret" aria-hidden="true">
          {isCollapsed ? "▸" : "▾"}
        </span>
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
        {f.mode && f.mode !== "replace" ? (
          <Pill kind={f.mode as PillKind} chip>
            {"." + f.mode}
          </Pill>
        ) : null}
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
      <SectionHeader
        label="Mod files"
        action={
          mod ? (
            <Button variant="ghost" size="sm" style={sx("color:var(--acc-ink)")} onClick={() => openTemplate({ mod })}>
              + New overlay
            </Button>
          ) : undefined
        }
      />
      {!mod ? (
        <div className="dashed">
          <div style={sx("font-size:13px;margin-bottom:12px")}>No mod open yet.</div>
          <Button variant="primary" style={sx("width:100%")} onClick={() => openTemplate({ intent: "mod", mod: "" })}>
            + New mod
          </Button>
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

/** One base entry; memoized on its name, so appending a page does not repaint the rows already shown. */
const BaseEntryRow = React.memo(function BaseEntryRow({ name }: { name: string }): React.JSX.Element {
  return (
    <button className="srow" style={sx("padding-left:22px")} onClick={() => void viewBaseEntry(name)}>
      <span className="fname">{name}</span>
    </button>
  );
});

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
  const next = Math.min(BASE_PAGE, total - entries.length);
  return (
    <div className="entries">
      {entries.map((n) => (
        <BaseEntryRow key={n} name={n} />
      ))}
      {total > entries.length ? (
        <div className="srow more" style={sx("color:var(--muted);padding-left:22px;font-size:11.5px;gap:8px")}>
          <span style={sx("flex:1")}>{`showing ${entries.length.toLocaleString()} of ${total.toLocaleString()}`}</span>
          <Button variant="ghost" size="sm" onClick={() => void showMoreBase()}>
            {`Show ${next} more`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function CategoryRow({ category, count }: { category: string; count: number }): React.JSX.Element {
  const selected = useS((s) => s.baseCategory === category);
  return (
    <div className="tw">
      <button className={"srow" + (selected ? " sel" : "")} aria-expanded={selected} onClick={() => void selectCategory(category)}>
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
    <button className="srow acc" onClick={() => openComponents()}>
      <span style={sx("flex:1")}>components</span>
      <span className="count">{compTotal ? compTotal.toLocaleString() : "search"}</span>
    </button>
  );
}

/** The filter box: its placeholder names the category it filters (it never searches the others). */
function BaseFilter(): React.JSX.Element {
  const category = useS((s) => s.baseCategory);
  const [value, setValue] = React.useState("");
  return (
    <SearchBox
      value={value}
      clearable
      placeholder={category ? `Filter entries in ${category}…` : "Pick a category to filter its entries…"}
      aria-label="Filter base-data entries in the selected category"
      onChange={(v) => {
        setValue(v);
        setBaseFilter(v);
      }}
    />
  );
}

function BaseDataSection(): React.JSX.Element {
  const baseCats = useS((s) => s.baseCats);
  return (
    <div>
      <SectionHeader label="Base data" action={<small className="muted">· read-only</small>} />
      <BaseFilter />
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
