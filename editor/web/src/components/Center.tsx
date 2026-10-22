// Center pane in Data mode: file tab bar + the persistent editor + status line, or the empty
// states (no mod / no file).

import React from "react";
import { useS, sx, Button, EmptyState, Pill } from "./ui.tsx";
import { Editor } from "./Editor.tsx";
import { TOUR, tourAttr } from "../tour-anchors.ts";
import { currentFile, modeChipLabel, fileTypeLabel, closeFile, openTemplate, openTour, openExample, openConcepts, browseBaseData } from "../actions.ts";

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
        <button className="x" aria-label="Close file" onClick={() => void closeFile()}>
          ✕
        </button>
      </div>
      <Pill kind={mode || "replace"}>{modeChipLabel(mode || "replace")}</Pill>
      <div className="grow" />
      <span className="breadcrumb">{crumb}</span>
    </div>
  );
}

/** The live check's state for the status line: off with no mod open, validating… while pending, validated after. */
export function liveLabel(s: { mod: string; file: string; validating: boolean; hasReport: boolean }): "validation off" | "validating…" | "validated" {
  if (!s.mod || !s.file) return "validation off";
  if (s.validating) return "validating…";
  return s.hasReport ? "validated" : "validation off";
}

function EditorStatusBar(): React.JSX.Element {
  const mod = useS((s) => s.mod);
  const file = useS((s) => s.file);
  const files = useS((s) => s.files);
  const saved = useS((s) => s.saved);
  const docBytes = useS((s) => s.docBytes);
  const validating = useS((s) => s.validating);
  const hasReport = useS((s) => s.report !== null);
  const f = currentFile(file, files);
  const ft = f ? f.fileType : "other";
  const live = liveLabel({ mod, file, validating, hasReport });
  return (
    <div className="edstatus">
      {saved ? <span className="dotok">● Saved</span> : <span className="muted">● Unsaved</span>}
      <span className="mono">{`${docBytes} bytes`}</span>
      <span className="mono">{fileTypeLabel(ft)}</span>
      <div className="grow" />
      <span className={"live" + (live === "validating…" ? " pending" : "")} aria-live="polite">
        {live}
      </span>
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
  // "Don't show again" on the tour also retires its nudge here
  const tourDontShow = useS((s) => s.tourDontShow);
  return (
    <div className="emptycenter">
      <EmptyState
        className="hero"
        icon="◆"
        title={<h1 style={sx("margin:0;font-size:26px;font-weight:700")}>Start a mod, or study the base game</h1>}
        body={
          <p style={sx("margin:0 0 14px;font-size:15px;color:var(--ink2);line-height:1.6;max-width:600px")}>
            This editor authors the GON/CSV overlays Mewgenics loads through <span className="mono" style={sx("color:var(--acc-ink)")}>-modpaths</span>. Everything you write lands in{" "}
            <span className="mono">{"mods/<name>/"}</span> — your saves are never touched.
          </p>
        }
        actions={
          <>
            <div className="grid2">
              <HeroCard icon="＋" title="Create your first overlay" body="Scaffold an ability, item, passive, or status from a template — localization rows included." onClick={() => openTemplate({ mod: "" })} />
              <HeroCard icon="⌕" title="Browse base data" body="Read the base-game data files and components to see what you can recombine or override." onClick={() => void browseBaseData()} />
              {!tourDontShow ? <HeroCard icon="✦" title="Take the guided tour" body="A 5-step walkthrough of browse → edit → validate → preview → launch." onClick={() => openTour()} link="Start tour →" /> : null}
              <HeroCard icon="★" title="Rebuild Joker's Luck" body="Follow the worked example end to end." onClick={() => openExample()} link="Open example →" />
            </div>
            <div style={sx("margin-top:22px;font-size:13px;color:var(--muted)")}>
              New to GON overlays?{" "}
              <button type="button" className="linkbtn" onClick={() => openConcepts()}>
                Read the concepts explainer →
              </button>
            </div>
          </>
        }
      />
    </div>
  );
}

function FileEmpty(): React.JSX.Element {
  return (
    <div className="emptycenter">
      <EmptyState
        icon="◆"
        title="No overlay file open"
        body="Pick an overlay from the tree on the left, or scaffold a new one."
        actions={
          <>
            <Button variant="primary" onClick={() => openTemplate()}>
              + New overlay
            </Button>
            <Button variant="ghost" onClick={() => openConcepts()}>
              How overlays work
            </Button>
          </>
        }
      />
    </div>
  );
}

export function Center(): React.JSX.Element {
  const mod = useS((s) => s.mod);
  const file = useS((s) => s.file);
  return (
    <div className="center" {...tourAttr(TOUR.editor)}>
      {file ? <FileTabBar /> : null}
      <div style={sx("flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden")}>
        <Editor />
        {!file ? mod ? <FileEmpty /> : <HeroEmpty /> : null}
      </div>
      {file ? <EditorStatusBar /> : null}
    </div>
  );
}
