// The editor shell: top bar, the three panes (Data or Art mode), status bar, toast, and the
// overlays (modals, drawers, tours, worked examples) in the same order app.mjs mounted them.
// Each pane and each overlay sits in its own PaneBoundary, so a render error blanks only that
// part; the one keyboard listener (shortcuts.ts) is installed here, with Ctrl+S wired to the mode-aware
// saveCurrent. The unsaved-work dialog (dirty.ts guard → S.confirm) renders here too, and a reload or close
// with unsaved work raises the browser's own beforeunload prompt.

import React from "react";
import { useS, PaneBoundary, Modal, Button } from "./components/ui.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { Explorer } from "./components/Explorer.tsx";
import { Center } from "./components/Center.tsx";
import { RightPanel } from "./components/RightPanel.tsx";
import { StatusBar, Toast } from "./components/StatusBar.tsx";
import { TemplateModal } from "./components/TemplateModal.tsx";
import { ConceptsDrawer } from "./components/ConceptsDrawer.tsx";
import { BaseEntryDrawer, ComponentsDrawer } from "./components/Drawers.tsx";
import { TourModal, ArtTourModal } from "./components/Tours.tsx";
import { WorkedExample, ArtWorkedExample } from "./components/WorkedExamples.tsx";
import { ArtExplorer } from "./art/ArtExplorer.tsx";
import { ArtCenter } from "./art/ArtCenter.tsx";
import { ArtRightPanel } from "./art/ArtRightPanel.tsx";
import { initArtUi } from "./art/art-state.ts";
import { RoomExplorer, RoomCenter, RoomRightPanel } from "./rooms/Rooms.tsx";
import { startup, closeMenu, saveCurrent, loadStatus } from "./actions.ts";
import { initShortcuts, setSaveHandler } from "./shortcuts.ts";
import { isDirty, resolveConfirm } from "./dirty.ts";

let artUiReady = false;

function Shell(): React.JSX.Element {
  const mod = useS((s) => s.mod);
  const artMode = useS((s) => s.artMode);
  const roomMode = useS((s) => s.roomMode);
  const columns = mod ? (roomMode ? "292px 1fr 380px" : artMode ? "282px 1fr 420px" : "302px 1fr 384px") : "302px 1fr";
  return (
    <div className="shell">
      <TopBar />
      <div className="body" style={{ gridTemplateColumns: columns }}>
        <PaneBoundary name="Explorer">{roomMode ? <RoomExplorer /> : artMode ? <ArtExplorer /> : <Explorer />}</PaneBoundary>
        <PaneBoundary name="Editor">{roomMode ? <RoomCenter /> : artMode ? <ArtCenter /> : <Center />}</PaneBoundary>
        {mod ? <PaneBoundary name="Right panel">{roomMode ? <RoomRightPanel /> : artMode ? <ArtRightPanel /> : <RightPanel />}</PaneBoundary> : null}
      </div>
      <StatusBar />
    </div>
  );
}

/** The unsaved-work dialog: Cancel (focused; Esc and the scrim too), Discard, and Save and continue when every dirty part can save. */
function ConfirmModal(): React.JSX.Element | null {
  const c = useS((s) => s.confirm);
  if (!c) return null;
  return (
    <Modal
      title={c.title}
      icon="●"
      className="confirm"
      onClose={() => resolveConfirm("cancel")}
      initialFocus=".confirm-cancel"
      footer={
        <>
          <Button variant="ghost" className="confirm-cancel" onClick={() => resolveConfirm("cancel")}>
            Cancel
          </Button>
          <Button variant="danger" className="confirm-discard" onClick={() => resolveConfirm("discard")}>
            Discard
          </Button>
          {c.canSave ? (
            <Button variant="primary" className="confirm-save" onClick={() => resolveConfirm("save")}>
              Save and continue
            </Button>
          ) : null}
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.6 }}>{c.body}</p>
    </Modal>
  );
}

function Overlays(): React.JSX.Element {
  const templateOpen = useS((s) => s.templateOpen);
  const conceptsOpen = useS((s) => s.conceptsOpen);
  const baseDrawer = useS((s) => s.baseDrawer);
  const compDrawer = useS((s) => s.compDrawer);
  const tourOpen = useS((s) => s.tourOpen);
  const exampleOpen = useS((s) => s.exampleOpen);
  const artTourOpen = useS((s) => s.artTourOpen);
  const artExampleOpen = useS((s) => s.artExampleOpen);
  return (
    <>
      <Toast />
      {templateOpen ? <PaneBoundary name="Template dialog" overlay><TemplateModal /></PaneBoundary> : null}
      {conceptsOpen ? <PaneBoundary name="Concepts" overlay><ConceptsDrawer /></PaneBoundary> : null}
      {baseDrawer ? <PaneBoundary name="Base entry" overlay><BaseEntryDrawer /></PaneBoundary> : null}
      {compDrawer ? <PaneBoundary name="Components" overlay><ComponentsDrawer /></PaneBoundary> : null}
      {tourOpen ? <PaneBoundary name="Guided tour" overlay><TourModal /></PaneBoundary> : null}
      {exampleOpen ? <PaneBoundary name="Worked example" overlay><WorkedExample /></PaneBoundary> : null}
      {artTourOpen ? <PaneBoundary name="Art tour" overlay><ArtTourModal /></PaneBoundary> : null}
      {artExampleOpen ? <PaneBoundary name="Art worked example" overlay><ArtWorkedExample /></PaneBoundary> : null}
      <PaneBoundary name="Unsaved changes" overlay><ConfirmModal /></PaneBoundary>
    </>
  );
}

export function App(): React.JSX.Element {
  React.useEffect(() => {
    // any click outside a menu closes it (menus stopPropagation on their own clicks)
    window.addEventListener("click", closeMenu);
    const offKeys = initShortcuts();
    setSaveHandler(async () => {
      await saveCurrent();
    });
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirty()) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    const onFocus = () => void loadStatus();
    window.addEventListener("focus", onFocus);
    if (!artUiReady) {
      artUiReady = true;
      initArtUi();
    }
    startup();
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("focus", onFocus);
      offKeys();
    };
  }, []);
  return (
    <>
      <Shell />
      <Overlays />
    </>
  );
}
