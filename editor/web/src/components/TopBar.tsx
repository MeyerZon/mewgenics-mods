// Top bar: brand, Data | Art switch, mod switcher, live status pill, Validate / Save /
// Launch dev, and the Help (?) menu.

import React from "react";
import { S, openArtTour } from "../state.ts";
import { useS, sx } from "./ui.tsx";
import {
  enterArtMode,
  leaveArtMode,
  toggleMenu,
  selectMod,
  openTemplate,
  runLive,
  save,
  flash,
  openTour,
  openExample,
  openArtExample,
  openConcepts,
} from "../actions.ts";

function StatusPill(): React.JSX.Element {
  const rep = useS((s) => s.report);
  if (!rep || !rep.counts) return <span className="pill muted">idle</span>;
  const e = rep.counts.errors | 0;
  const w = rep.counts.warnings | 0;
  const cls = e > 0 ? "err" : w > 0 ? "warn" : "ok";
  return <span className={`pill ${cls}`}>{`● ${e} error${e === 1 ? "" : "s"} · ${w} warning${w === 1 ? "" : "s"}`}</span>;
}

function ModMenu(): React.JSX.Element {
  const mods = useS((s) => s.mods);
  const mod = useS((s) => s.mod);
  return (
    <div className="menu" onClick={(e) => e.stopPropagation()}>
      <div className="label">Switch mod</div>
      {mods.length ? (
        mods.map((m) => (
          <button
            key={m}
            className={"item" + (m === mod ? " sel" : "")}
            onClick={() => {
              S.set({ openMenu: "" });
              void selectMod(m);
            }}
          >
            {m}
          </button>
        ))
      ) : (
        <div className="item" style={sx("color:var(--muted)")}>
          (no mods yet)
        </div>
      )}
      <div className="sep" />
      <button className="item" onClick={() => openTemplate({ mod: "" })}>
        ＋ New mod…
      </button>
    </div>
  );
}

function HelpMenu(): React.JSX.Element {
  return (
    <div className="menu right" onClick={(e) => e.stopPropagation()}>
      <div className="label">Data mode</div>
      <button className="item" onClick={() => openTour()}>
        ✦ Guided tour
      </button>
      <button className="item" onClick={() => openExample()}>
        ★ Worked example — Joker's Luck
      </button>
      <div className="sep" />
      <div className="label">Art mode</div>
      <button className="item" onClick={() => openArtTour()}>
        ▲ Art mode tour
      </button>
      <button className="item" onClick={() => openArtExample()}>
        ★ Art worked example
      </button>
      <div className="sep" />
      <button className="item" onClick={() => openConcepts()}>
        ✦ Concepts explainer
      </button>
    </div>
  );
}

export function TopBar(): React.JSX.Element {
  const artMode = useS((s) => s.artMode);
  const mod = useS((s) => s.mod);
  const file = useS((s) => s.file);
  const openMenu = useS((s) => s.openMenu);
  return (
    <div className="topbar">
      <div className="brand">
        <div className="logo" />
        <span className="title">Mewgenics Mod Editor</span>
      </div>
      <div className="vdiv" />
      {/* Data (GON overlays) | Art (scenes → SWF + in-game-faithful preview) */}
      <div className="modeswitch" role="group" aria-label="Editor mode">
        <button className={"btn sm" + (artMode ? "" : " on")} aria-pressed={String(!artMode) as "true" | "false"} onClick={() => leaveArtMode()}>
          Data
        </button>
        <button className={"btn sm" + (artMode ? " on" : "")} aria-pressed={String(artMode) as "true" | "false"} onClick={() => enterArtMode()}>
          Art
        </button>
      </div>
      <div className="vdiv" />
      {/* mod switcher */}
      <div className="dropdown">
        <button
          className="btn ghost"
          style={sx("color:var(--ink2)")}
          aria-haspopup="menu"
          onClick={(e) => {
            e.stopPropagation();
            toggleMenu("mod");
          }}
        >
          {mod || "No mod open"}
          <span style={sx("color:var(--muted)")}> ▾</span>
        </button>
        {openMenu === "mod" ? <ModMenu /> : null}
      </div>
      <div className="grow" />
      <StatusPill />
      <button className="btn ghost" onClick={() => void runLive()} disabled={!file}>
        Validate
      </button>
      <button className="btn primary" onClick={() => void save()} disabled={!file}>
        Save
      </button>
      <button
        className="btn ghost"
        onClick={() =>
          flash(
            "Launch dev is illustrative here — run launch-dev.bat (Mewgenics -modpaths mods/" + (mod || "<mod>") + " -savesuffix dev) outside the editor.",
            6000,
          )
        }
      >
        Launch dev ▸
      </button>
      <div className="vdiv" />
      {/* help menu */}
      <div className="dropdown">
        <button
          className="btn ghost"
          aria-label="Help and onboarding"
          onClick={(e) => {
            e.stopPropagation();
            toggleMenu("help");
          }}
        >
          ?
        </button>
        {openMenu === "help" ? <HelpMenu /> : null}
      </div>
    </div>
  );
}
