// The editor shell: top bar, the three panes (Data or Art mode), status bar, toast, and the
// overlays (modals, drawers, tours, worked examples) in the same order app.mjs mounted them.

import React from "react";
import { useS } from "./components/ui.tsx";
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
import { startup, closeMenu } from "./actions.ts";

function Shell(): React.JSX.Element {
  const mod = useS((s) => s.mod);
  const artMode = useS((s) => s.artMode);
  const columns = mod ? (artMode ? "282px 1fr 420px" : "302px 1fr 384px") : "302px 1fr";
  return (
    <div className="shell">
      <TopBar />
      <div className="body" style={{ gridTemplateColumns: columns }}>
        {artMode ? <ArtExplorer /> : <Explorer />}
        {artMode ? <ArtCenter /> : <Center />}
        {mod ? artMode ? <ArtRightPanel /> : <RightPanel /> : null}
      </div>
      <StatusBar />
    </div>
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
      {templateOpen ? <TemplateModal /> : null}
      {conceptsOpen ? <ConceptsDrawer /> : null}
      {baseDrawer ? <BaseEntryDrawer /> : null}
      {compDrawer ? <ComponentsDrawer /> : null}
      {tourOpen ? <TourModal /> : null}
      {exampleOpen ? <WorkedExample /> : null}
      {artTourOpen ? <ArtTourModal /> : null}
      {artExampleOpen ? <ArtWorkedExample /> : null}
    </>
  );
}

export function App(): React.JSX.Element {
  React.useEffect(() => {
    // any click outside a menu closes it (menus stopPropagation on their own clicks)
    window.addEventListener("click", closeMenu);
    initArtUi();
    startup();
    return () => window.removeEventListener("click", closeMenu);
  }, []);
  return (
    <>
      <Shell />
      <Overlays />
    </>
  );
}
