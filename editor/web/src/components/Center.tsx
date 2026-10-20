// Center pane in Data mode: file tab bar + the persistent editor + status line, or the empty
// states (no mod / no file).

import React from "react";
import { S } from "../state.ts";
import { useS, sx } from "./ui.tsx";
import { Editor } from "./Editor.tsx";
import { currentFile, modeChipLabel, fileTypeLabel, closeFile, openTemplate, openTour, selectCategory } from "../actions.ts";

function FileTabBar(): React.JSX.Element {
  const mod = useS((s) => s.mod);
  const file = useS((s) => s.file);
  const files = useS((s) => s.files);
  const f = currentFile(file, files);
  const mode = f ? f.mode : "replace";
  const dirs = file.split("/");
  dirs.pop();
  const crumb = [mod, ...dirs].filter(Boolean).join(" › ");
  return (
    <div className="edtabbar">
      <div className="filetab">
        <span className="mono" style={sx("font-size:12.5px")}>
          {file.split("/").pop() || file}
        </span>
        <button className="x" aria-label="Close file" onClick={() => closeFile()}>
          ✕
        </button>
      </div>
      {mode && mode !== "replace" ? <span className={`pill ${mode}`}>{modeChipLabel(mode)}</span> : <span className="pill replace">{modeChipLabel(mode)}</span>}
      <div className="grow" />
      <span className="breadcrumb">{crumb}</span>
    </div>
  );
}

function EditorStatusBar(): React.JSX.Element {
  const file = useS((s) => s.file);
  const files = useS((s) => s.files);
  const saved = useS((s) => s.saved);
  const docBytes = useS((s) => s.docBytes);
  const f = currentFile(file, files);
  const ft = f ? f.fileType : "other";
  return (
    <div className="edstatus">
      {saved ? <span className="dotok">● Saved</span> : <span className="muted">● Unsaved</span>}
      <span className="mono">{`${docBytes} bytes`}</span>
      <span className="mono">UTF-8</span>
      <span className="mono">{fileTypeLabel(ft)}</span>
      <div className="grow" />
      <span>Live validation on</span>
    </div>
  );
}

function HeroCard({ icon, title, body, onClick, link }: { icon: string; title: string; body: string; onClick: () => void; link?: string }): React.JSX.Element {
  return (
    <button className="card plain" style={sx("text-align:left;cursor:pointer;border-color:var(--line)")} onClick={onClick}>
      <div style={sx("font-size:20px;margin-bottom:10px")}>{icon}</div>
      <div style={sx("font-weight:700;font-size:15px;margin-bottom:6px;color:var(--ink)")}>{title}</div>
      <div style={sx("font-size:13px;color:var(--ink2);line-height:1.6")}>
        {body}
        {link ? <span style={sx("color:var(--acc-ink)")}>{" " + link}</span> : null}
      </div>
    </button>
  );
}

function HeroEmpty(): React.JSX.Element {
  return (
    <div className="emptycenter">
      <div style={sx("max-width:720px;width:100%")}>
        <div style={sx("width:56px;height:56px;border-radius:14px;background:var(--accbg);display:flex;align-items:center;justify-content:center;font-size:26px;margin-bottom:18px")}>◆</div>
        <h1 style={sx("margin:0 0 8px;font-size:26px;font-weight:700")}>Start a mod, or study the base game</h1>
        <p style={sx("margin:0 0 26px;font-size:15px;color:var(--ink2);line-height:1.6;max-width:600px")}>
          This editor authors the GON/CSV overlays Mewgenics loads through <span className="mono" style={sx("color:var(--acc-ink)")}>-modpaths</span>. Everything you write lands in{" "}
          <span className="mono">{"mods/<name>/"}</span> — your saves are never touched.
        </p>
        <div className="grid2">
          <HeroCard icon="＋" title="Create your first overlay" body="Scaffold an ability, item, passive, or status from a template — localization rows included." onClick={() => openTemplate({ mod: "" })} />
          <HeroCard
            icon="⌕"
            title="Browse base data"
            body="Read the base-game data files and components to see what you can recombine or override."
            onClick={() => {
              const { baseCategory, baseCats } = S.get();
              if (!baseCategory && baseCats.length) void selectCategory(baseCats[0]!.category);
            }}
          />
          <HeroCard icon="✦" title="Take the guided tour" body="A 5-step walkthrough of browse → edit → validate → preview." onClick={() => openTour()} link="Start tour →" />
          <HeroCard icon="★" title="Rebuild Joker's Luck" body="Follow the worked example end to end." onClick={() => S.set({ exampleStep: 2, exampleOpen: true })} link="Open example →" />
        </div>
        <div style={sx("margin-top:22px;font-size:13px;color:var(--muted)")}>
          New to GON overlays? <a onClick={() => S.set({ conceptsOpen: true })}>Read the concepts explainer →</a>
        </div>
      </div>
    </div>
  );
}

function FileEmpty(): React.JSX.Element {
  return (
    <div className="emptycenter">
      <div style={sx("text-align:center;max-width:420px")}>
        <div style={sx("width:52px;height:52px;border-radius:14px;background:var(--accbg);display:flex;align-items:center;justify-content:center;font-size:24px;margin:0 auto 16px")}>◆</div>
        <h2 style={sx("margin:0 0 8px;font-size:18px;color:var(--ink)")}>No overlay file open</h2>
        <p style={sx("margin:0 0 18px;color:var(--ink2);line-height:1.6")}>Pick an overlay from the tree on the left, or scaffold a new one.</p>
        <div className="row" style={sx("display:flex;gap:10px;justify-content:center")}>
          <button className="btn primary" onClick={() => openTemplate({ mod: S.get().mod })}>
            + New overlay
          </button>
          <button className="btn ghost" onClick={() => S.set({ conceptsOpen: true })}>
            How overlays work
          </button>
        </div>
      </div>
    </div>
  );
}

export function Center(): React.JSX.Element {
  const mod = useS((s) => s.mod);
  const file = useS((s) => s.file);
  return (
    <div className="center">
      {file ? <FileTabBar /> : null}
      <div style={sx("flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden")}>
        <Editor />
        {!file ? mod ? <FileEmpty /> : <HeroEmpty /> : null}
      </div>
      {file ? <EditorStatusBar /> : null}
    </div>
  );
}
