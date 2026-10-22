// Top bar: brand, the Data | Art | Rooms switch (a dot marks a mode with unsaved work), the mod switcher, the
// mode-aware status pill, the one command bar (Validate / Save act on what the current mode has open; Ctrl+S is
// Save), the Launch… popover and the Help (?) menu.

import React from "react";
import { openArtTour, openRoomTour } from "../state.ts";
import { TOUR } from "../tour-anchors.ts";
import { useStore } from "../store.ts";
import { useS, sx, Menu, Segmented, Button } from "./ui.tsx";
import { A } from "../art/art-state.ts";
import { R, isDirty as roomDirty } from "../rooms/room-state.ts";
import {
  enterArtMode,
  leaveArtMode,
  enterRoomMode,
  toggleMenu,
  closeMenu,
  pickMod,
  openTemplate,
  openTour,
  openExample,
  openArtExample,
  openConcepts,
  exportMod,
  importModFile,
  validateCurrent,
  saveCurrent,
  openFindings,
  launchCommand,
  copyLaunchCommand,
  type Mode,
} from "../actions.ts";
import type { Finding } from "../types.ts";

/** Which modes hold unsaved work (reactive; mirrors the dirty.ts providers). */
function useModeDirty(): Record<Mode, boolean> {
  const data = useS((s) => !s.saved && !!s.file);
  const art = useStore(A, (a) => !!a.scenePath && (!a.saved || a.vcDirty));
  const rooms = useStore(R, (r) => roomDirty(r));
  return { data, art, rooms };
}

function useMode(): Mode {
  const artMode = useS((s) => s.artMode);
  const roomMode = useS((s) => s.roomMode);
  return roomMode ? "rooms" : artMode ? "art" : "data";
}

function countFindings(findings: readonly Pick<Finding, "severity">[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const f of findings) {
    if (f.severity === "error") errors++;
    else if (f.severity === "warning") warnings++;
  }
  return { errors, warnings };
}

/** The current mode's findings: Data → the overlay's report, Art → the scene's findings, Rooms → the room's report. */
function StatusPill({ mode }: { mode: Mode }): React.JSX.Element {
  const rep = useS((s) => s.report);
  const artFindings = useStore(A, (a) => (a.scenePath ? a.findings : null));
  const roomReport = useStore(R, (r) => (r.level ? r.report : null));
  let counts: { errors: number; warnings: number } | null = null;
  if (mode === "data") counts = rep && rep.counts ? rep.counts : null;
  else if (mode === "art") counts = artFindings ? countFindings(artFindings) : null;
  else counts = roomReport && roomReport.counts ? roomReport.counts : null;
  if (!counts) return <span className="pill muted">idle</span>;
  const e = counts.errors | 0;
  const w = counts.warnings | 0;
  const cls = e > 0 ? "err" : w > 0 ? "warn" : "ok";
  return (
    <button type="button" className={`pill ${cls}`} title={mode === "rooms" ? "The room's findings (right panel)" : "Show the findings"} onClick={() => openFindings()}>
      {`● ${e} error${e === 1 ? "" : "s"} · ${w} warning${w === 1 ? "" : "s"}`}
    </button>
  );
}

function ModMenuItems(): React.JSX.Element {
  const mods = useS((s) => s.mods);
  const mod = useS((s) => s.mod);
  return (
    <>
      <div className="label">Switch mod</div>
      {mods.length ? (
        mods.map((m) => (
          <button key={m} className={"item" + (m === mod ? " sel" : "")} onClick={() => void pickMod(m)}>
            {m}
          </button>
        ))
      ) : (
        <div className="item" style={sx("color:var(--muted)")}>
          (no mods yet)
        </div>
      )}
      <div className="sep" />
      <button className="item" onClick={() => openTemplate({ intent: "mod", mod: "" })}>
        ＋ New mod…
      </button>
      <div className="sep" />
      <button className="item" disabled={!mod} title="Pack this mod into editor/data/dist/<name>-<version>.zip (builds SWFs, validates)" onClick={() => void exportMod()}>
        ⇩ Export…
      </button>
      <label className="item" title="Install a mod zip into mods/<name>/ (checked first; never overwrites)">
        ⇧ Import mod…
        <input
          type="file"
          accept=".zip,application/zip"
          style={sx("display:none")}
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (f) void importModFile(f);
          }}
        />
      </label>
    </>
  );
}

function HelpMenuItems(): React.JSX.Element {
  return (
    <>
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
      <div className="label">Rooms mode</div>
      <button className="item" onClick={() => openRoomTour()}>
        ▦ Rooms mode tour
      </button>
      <button className="item" onClick={() => openConcepts("rooms")}>
        ▦ Rooms concepts
      </button>
      <div className="sep" />
      <button className="item" onClick={() => openConcepts()}>
        ✦ Concepts explainer
      </button>
    </>
  );
}

/** Launch… : the command to run (the editor never starts the game itself) and a Copy button. */
function LaunchPopover(): React.JSX.Element {
  const mod = useS((s) => s.mod);
  const input = React.useRef<HTMLInputElement | null>(null);
  const cmd = launchCommand(mod);
  return (
    <div className="launchpop">
      <div className="label">Launch the game with this mod</div>
      <div className="launchrow">
        <input ref={input} className="mono" readOnly value={cmd} aria-label="Launch command" onFocus={(e) => e.currentTarget.select()} />
        <Button size="sm" variant="primary" onClick={() => void copyLaunchCommand(cmd, input.current)}>
          Copy
        </Button>
      </div>
      <p className="launchnote">Run it from the repo root with Steam open. It adds -savesuffix dev, so your real saves are never touched. The editor never starts the game itself.</p>
    </div>
  );
}

const SAVE_TITLE: Record<Mode, string> = {
  data: "Save overlay (Ctrl+S)",
  art: "Save scene (Ctrl+S)",
  rooms: "Save room (Ctrl+S)",
};
const VALIDATE_TITLE: Record<Mode, string> = {
  data: "Validate the open overlay now",
  art: "Validate the open scene now",
  rooms: "Validate the open room now",
};

export function TopBar(): React.JSX.Element {
  const mode = useMode();
  const dirty = useModeDirty();
  const mod = useS((s) => s.mod);
  const file = useS((s) => s.file);
  const hasScene = useStore(A, (a) => a.hasScene);
  const hasRoom = useStore(R, (r) => !!r.level);
  const openMenu = useS((s) => s.openMenu);
  const target = mode === "art" ? hasScene : mode === "rooms" ? hasRoom : !!file;
  const label = (text: string, m: Mode) => (
    <>
      {text}
      {dirty[m] ? <span className="dot unsaved" title="unsaved changes" /> : null}
    </>
  );
  return (
    <div className="topbar">
      <div className="brand">
        <div className="logo" />
        <span className="title">Mewgenics Mod Editor</span>
      </div>
      <div className="vdiv" />
      {/* Data (GON overlays) | Art (scenes → SWF + in-game-faithful preview) | Rooms (levels/**.lvl) */}
      <Segmented<Mode>
        aria-label="Editor mode"
        size="sm"
        value={mode}
        options={[
          { id: "data", label: label("Data", "data") },
          { id: "art", label: label("Art", "art"), tour: TOUR.artSwitch },
          { id: "rooms", label: label("Rooms", "rooms"), tour: TOUR.roomsSwitch },
        ]}
        onChange={(m) => (m === "art" ? enterArtMode() : m === "rooms" ? enterRoomMode() : leaveArtMode())}
      />
      <div className="vdiv" />
      {/* mod switcher */}
      <Menu
        label={
          <>
            {mod || "No mod open"}
            <span style={sx("color:var(--muted)")}> ▾</span>
          </>
        }
        triggerStyle={sx("color:var(--ink2)")}
        open={openMenu === "mod"}
        onToggle={() => toggleMenu("mod")}
        onClose={closeMenu}
      >
        <ModMenuItems />
      </Menu>
      <div className="grow" />
      {/* the status pill stays the last .pill in the top bar (data-mode.spec reads .topbar .pill last) */}
      <StatusPill mode={mode} />
      <Button variant="ghost" className="topbar-validate" title={VALIDATE_TITLE[mode]} onClick={() => void validateCurrent()} disabled={!target}>
        Validate
      </Button>
      <Button variant="primary" className="topbar-save" title={SAVE_TITLE[mode]} onClick={() => void saveCurrent()} disabled={!target}>
        Save
        {target && dirty[mode] ? <span className="dot unsaved" /> : null}
      </Button>
      <Menu label="Launch…" triggerTour={TOUR.launch} open={openMenu === "launch"} onToggle={() => toggleMenu("launch")} onClose={closeMenu} right>
        <LaunchPopover />
      </Menu>
      <div className="vdiv" />
      {/* help menu */}
      <Menu label="?" aria-label="Help and onboarding" right open={openMenu === "help"} onToggle={() => toggleMenu("help")} onClose={closeMenu}>
        <HelpMenuItems />
      </Menu>
    </div>
  );
}
