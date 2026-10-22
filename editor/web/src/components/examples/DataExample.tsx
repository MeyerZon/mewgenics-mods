// The Data worked example: rebuild Joker's Luck (examples/steps.ts EXAMPLE_STEPS). Illustrative: it explains the
// pipeline and drops the user into the real UI (the New mod / scaffolder dialog, the Launch… popover); it never
// writes to disk on its own.

import React from "react";
import { useS } from "../ui.tsx";
import { S } from "../../state.ts";
import { openTemplate, closeExample, setExampleStep, openLaunchMenu } from "../../actions.ts";
import { ExampleShell, StepContent } from "./Stepper.tsx";
import { EXAMPLE_STEPS, type DataExampleAction } from "./steps.ts";

function run(action: DataExampleAction): void {
  closeExample();
  if (action === "new-mod") openTemplate({ intent: "mod", mod: "" });
  else if (action === "scaffold") {
    openTemplate({ mod: S.get().mod || "jokers-luck-tutorial", kind: "ability", name: "JokersGambit", display: "Joker's Gambit", desc: "A Spin variant that applies JokersLuck", parent: "Spin", status: "JokersLuck" });
  } else openLaunchMenu();
}

export function WorkedExample(): React.JSX.Element {
  const raw = useS((s) => s.exampleStep);
  const step = Math.max(0, Math.min(EXAMPLE_STEPS.length - 1, raw));
  const cur = EXAMPLE_STEPS[step]!;
  const action = cur.action ? (
    <button className="btn primary" onClick={() => run(cur.action!)}>
      {cur.actionLabel}
    </button>
  ) : null;
  return (
    <ExampleShell icon="★" title="Worked example — build Joker's Luck" blurb="A new status that rerolls luck to ±10 every turn." steps={EXAMPLE_STEPS} step={step} onPick={setExampleStep} onClose={closeExample}>
      <StepContent step={step} steps={EXAMPLE_STEPS} action={action} onGo={setExampleStep} onFinish={closeExample} />
    </ExampleShell>
  );
}
