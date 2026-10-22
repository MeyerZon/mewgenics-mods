// Rooms mode right panel: Inspector | Findings tabs. The Inspector edits the selected cell — its tile and its
// objects, each an id or a weighted random list (the table keeps the `<label> choice N` / `<label> weight N` /
// `remove choice N` aria-labels). Findings is the live lvl-* report: a Summary card and the FindingsList.

import React, { useMemo } from "react";
import { useStore, useStoreShallow } from "../store.ts";
import { sx, Tabs, Summary, FindingsList, Button, IconButton, Checkbox } from "../components/ui.tsx";
import { R, setCellTile, setObject, removeObjectAt, addObjectAt, setRightTab, findingsLevel, type PaletteEntry, type RoomRightTab } from "./room-state.ts";
import { entryLabel } from "./RoomBits.tsx";
import { asChoices, addChoice, updateChoice, removeChoice, firstId, objectsAt, cellAt } from "../../../src/core/level/edit.ts";
import type { LvlPick } from "../../../src/core/level/lvl.ts";

function IdSelect({ value, entries, onChange, label }: { value: number; entries: PaletteEntry[]; onChange: (id: number) => void; label: string }): React.JSX.Element {
  const known = entries.some((e) => e.id === value);
  return (
    <select className="artinput" aria-label={label} value={value} onChange={(e) => onChange(Number(e.target.value))} style={sx("max-width:100%;flex:1;min-width:0")}>
      {!known ? <option value={value}>{`${value} · (not in the palette)`}</option> : null}
      {entries.map((e) => (
        <option key={e.id} value={e.id}>
          {entryLabel(e, e.id)}
        </option>
      ))}
    </select>
  );
}

/** Row keys for a weighted list: the choice's id plus its occurrence (a list may repeat an id). */
function choiceKeys(choices: ReadonlyArray<{ id: number }>): string[] {
  const seen = new Map<number, number>();
  return choices.map((c) => {
    const n = (seen.get(c.id) ?? 0) + 1;
    seen.set(c.id, n);
    return `${c.id}#${n}`;
  });
}

/** One pick: an id, or (random on) a table of id + weight rows. */
function PickEditor({ pick, entries, onChange, label }: { pick: LvlPick; entries: PaletteEntry[]; onChange: (p: LvlPick) => void; label: string }): React.JSX.Element {
  const random = typeof pick !== "number";
  const keys = useMemo(() => (typeof pick === "number" ? [] : choiceKeys(pick)), [pick]);
  return (
    <div className="pickedit">
      <Checkbox className="rndtoggle" aria-label={`${label}: weighted random list`} checked={random} onChange={(on) => onChange(on ? asChoices(pick) : firstId(pick))}>
        random
      </Checkbox>
      {!random ? (
        <IdSelect value={pick} entries={entries} onChange={onChange} label={label} />
      ) : (
        <table className="rndtable">
          <thead>
            <tr>
              <th>id</th>
              <th>weight</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {pick.map((c, n) => (
              <tr key={keys[n]}>
                <td>
                  <IdSelect value={c.id} entries={entries} onChange={(id) => onChange(updateChoice(pick, n, { id }))} label={`${label} choice ${n + 1}`} />
                </td>
                <td>
                  <input
                    className="artinput num"
                    type="number"
                    min={0}
                    max={65535}
                    aria-label={`${label} weight ${n + 1}`}
                    value={c.weight}
                    onChange={(e) => onChange(updateChoice(pick, n, { weight: Math.max(0, Math.min(65535, Math.round(Number(e.target.value) || 0))) }))}
                  />
                </td>
                <td>
                  <IconButton aria-label={`remove choice ${n + 1}`} onClick={() => onChange(removeChoice(pick, n))}>
                    ✕
                  </IconButton>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3}>
                <Button variant="ghost" size="sm" onClick={() => onChange(addChoice(pick, 0))}>
                  + choice
                </Button>
              </td>
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}

function Inspector(): React.JSX.Element {
  const { level, sel, palette, objectBrush } = useStoreShallow(R, (r) => ({ level: r.level, sel: r.sel, palette: r.palette, objectBrush: r.objectBrush }));
  if (!level) return <p className="muted">Open a room to inspect its cells.</p>;
  if (!sel) return <p className="muted">Click a cell (or Tab into the grid and use the arrows) to inspect it: its tile, its objects and their random lists.</p>;
  const tiles = palette?.tiles ?? [];
  const objects = palette?.objects ?? [];
  const objs = objectsAt(level, sel.x, sel.y);
  const brushName = typeof objectBrush === "number" ? (objects.find((o) => o.id === objectBrush)?.name ?? String(objectBrush)) : "random list";
  return (
    <div className="inspector">
      <div className="sec" style={sx("margin-bottom:8px")}>{`Cell (${sel.x}, ${sel.y})`}</div>
      <div className="card">
        <div className="sec" style={sx("margin-bottom:6px")}>Tile</div>
        <PickEditor pick={cellAt(level, sel.x, sel.y)} entries={tiles} label="tile" onChange={(p) => setCellTile(sel.x, sel.y, p)} />
      </div>
      <div className="card">
        <div className="sec" style={sx("margin-bottom:6px")}>{`Objects (${objs.length})`}</div>
        {objs.map(({ index, obj }) => (
          // `index` is the object's position in the file's object list: its identity while the cell is inspected
          <div key={`object-${index}`} className="objrow">
            <PickEditor pick={obj.id} entries={objects} label={`object ${index}`} onChange={(p) => setObject(index, p)} />
            <Button variant="ghost" size="sm" onClick={() => removeObjectAt(index)}>
              Remove
            </Button>
          </div>
        ))}
        <Button variant="ghost" size="sm" onClick={() => addObjectAt(sel.x, sel.y)}>{`+ add ${brushName} here`}</Button>
      </div>
    </div>
  );
}

function Findings(): React.JSX.Element {
  const { rep, hasLevel } = useStoreShallow(R, (r) => ({ rep: r.report, hasLevel: !!r.level }));
  if (!hasLevel) return <p className="muted">Open a room to see its findings.</p>;
  if (!rep) return <p className="muted">validating…</p>;
  const c = rep.counts ?? { errors: 0, warnings: 0, infos: 0 };
  const level = findingsLevel(c);
  const title = c.errors > 0 ? `${c.errors} error${c.errors === 1 ? "" : "s"}` : c.warnings > 0 ? `${c.warnings} warning${c.warnings === 1 ? "" : "s"}` : "The room checks out";
  return (
    <div className="roomfindings">
      <Summary level={level} title={title} detail={`${c.errors} errors · ${c.warnings} warnings · ${c.infos} info`} />
      <div style={sx("margin-top:14px")}>
        <FindingsList
          findings={rep.findings}
          empty={
            <p className="dotok" style={sx("margin:2px 0")}>
              No findings — every id resolves and the party has a spawn.
            </p>
          }
        />
      </div>
    </div>
  );
}

export function RoomRightPanel(): React.JSX.Element {
  const tab = useStore(R, (r) => r.rightTab);
  const n = useStore(R, (r) => (r.level && r.report ? r.report.findings.length : 0));
  const items: { id: RoomRightTab; label: string }[] = [
    { id: "inspector", label: "Inspector" },
    { id: "findings", label: n ? `Findings · ${n}` : "Findings" },
  ];
  return (
    <div className="rightpanel">
      <Tabs aria-label="Room panel" items={items} value={tab} onChange={setRightTab} />
      <div className="panelbody">{tab === "findings" ? <Findings /> : <Inspector />}</div>
    </div>
  );
}
