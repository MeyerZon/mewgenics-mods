// The Art worked example: SVG → preview → SWF (examples/steps.ts ART_EXAMPLE_STEPS). Each jump closes the example and
// lands in the live Art UI (artExampleGoto: Art mode, a mod open — else the mod switcher opens with a "pick a mod
// first" toast). It never writes to disk on its own.

import React from "react";
import { useS } from "../ui.tsx";
import { artExampleGoto, closeArtExample, setArtExampleStep, focusWhenShown } from "../../actions.ts";
import { openNewSceneModal, setArtSubtab, setArtRightTab } from "../../art/art-state.ts";
import { tourSelector, TOUR } from "../../tour-anchors.ts";
import { ExampleShell, StepContent } from "./Stepper.tsx";
import { ART_EXAMPLE_STEPS, type ArtExampleAction } from "./steps.ts";

function run(action: ArtExampleAction): void {
  if (action === "art-mode") artExampleGoto(() => {}, false);
  else if (action === "new-scene") artExampleGoto(() => openNewSceneModal());
  else if (action === "import") {
    artExampleGoto(() => {
      setArtSubtab("shapes");
      focusWhenShown(`.import-card ${tourSelector(TOUR.artImport)}`);
    });
  } else if (action === "preview") artExampleGoto(() => setArtRightTab("preview"));
  else artExampleGoto(() => setArtRightTab("build"));
}

export function ArtWorkedExample(): React.JSX.Element {
  const raw = useS((s) => s.artExampleStep);
  const step = Math.max(0, Math.min(ART_EXAMPLE_STEPS.length - 1, raw));
  const cur = ART_EXAMPLE_STEPS[step]!;
  const action = cur.action ? (
    <button className="btn primary" onClick={() => run(cur.action!)}>
      {cur.actionLabel}
    </button>
  ) : null;
  return (
    <ExampleShell
      icon="▲"
      title="Art worked example — SVG → preview → SWF"
      blurb="Author grayscale vector art the engine recolors, and build it into a loadable SWF."
      steps={ART_EXAMPLE_STEPS}
      step={step}
      onPick={setArtExampleStep}
      onClose={closeArtExample}
    >
      <StepContent step={step} steps={ART_EXAMPLE_STEPS} action={action} onGo={setArtExampleStep} onFinish={closeArtExample} />
    </ExampleShell>
  );
}
