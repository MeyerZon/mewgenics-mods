// The two worked examples: Joker's Luck (data mode) and SVG → preview → SWF (art mode).
// Illustrative: they explain the pipeline and drop the user into the real UI at each step.
// They never write to disk on their own.

import React from "react";
import { S } from "../state.ts";
import { useS, sx, CodeView } from "./ui.tsx";
import { openTemplate, artExampleGoto } from "../actions.ts";
import { openNewSceneModal, setArtSubtab, setArtRightTab } from "../art/art-state.ts";

interface ExampleStep {
  t: string;
  sub: string;
}

const EXAMPLE_STEPS: ExampleStep[] = [
  { t: "Create the mod folder", sub: "mods/jokers-luck" },
  { t: "Add the ability overlay", sub: "JokersGambit, a Spin variant" },
  { t: "Add localization rows", sub: "name + tooltip, 12 languages" },
  { t: "Register the native name", sub: "so JokersLuck validates" },
  { t: "Validate & launch dev", sub: "bind JokersGambit in battle" },
];
const EXAMPLE_GON = `JokersGambit {
    variant_of Spin
    meta { name "ABILITY_JOKERSGAMBIT_NAME"; desc "ABILITY_JOKERSGAMBIT_DESC" }
    cost { infcantrip true; mana 0 }
    damage_instance { damage 0; effects { JokersLuck 1 } }
}`;

const BODY_P = "margin:0 0 20px;font-size:14px;color:var(--ink2);line-height:1.65;max-width:720px";

function ExampleBody({ step }: { step: number }): React.JSX.Element {
  if (step === 2) {
    return (
      <div>
        <div className="sec" style={sx("color:var(--acc-ink);margin-bottom:6px")}>
          Step 2
        </div>
        <h1 style={sx("margin:0 0 10px;font-size:24px")}>Add the ability overlay</h1>
        <p style={sx(BODY_P)}>
          We append a new ability to the fighters' table.{" "}
          <span className="mono" style={sx("color:#79c0ff")}>
            variant_of Spin
          </span>{" "}
          inherits everything from the base Spin attack, then we point its on-hit <span className="mono">effects</span> at our status. Because this is an{" "}
          <span style={sx("color:var(--acc-ink);font-weight:600")}>.append</span>, no existing ability is touched.
        </p>
        <div className="codeblock">
          <div className="cbhead">
            <span className="mono" style={sx("font-size:12px")}>
              mods/jokers-luck/data/abilities/fighter_abilities.gon.append
            </span>
            <div className="grow" />
            <span className="pill append chip">.append</span>
          </div>
          <CodeView text={EXAMPLE_GON} extraClass="cbcode" />
        </div>
        <div style={sx("display:flex;align-items:center;gap:10px;margin-top:16px;max-width:760px;background:var(--okbg);border:1px solid rgba(63,185,80,.3);border-radius:10px;padding:12px 14px")}>
          <span className="dotok" style={sx("font-size:15px")}>
            ✓
          </span>
          <span style={sx("font-size:13px;color:var(--ink2)")}>
            Validates now — except{" "}
            <span className="mono" style={sx("color:#ffa657")}>
              JokersLuck
            </span>{" "}
            is still unknown. You'll register it in step 4.
          </span>
        </div>
        <div style={sx("display:flex;gap:12px;margin-top:26px;flex-wrap:wrap")}>
          <button className="btn ghost" onClick={() => S.set({ exampleStep: Math.max(0, step - 1) })}>
            ← Back
          </button>
          <button
            className="btn primary"
            onClick={() => {
              S.set({ exampleOpen: false });
              openTemplate({ mod: S.get().mod || "jokers-luck-tutorial", kind: "ability", name: "JokersGambit", display: "Joker's Gambit", desc: "A Spin variant that applies JokersLuck", parent: "Spin", status: "JokersLuck" });
            }}
          >
            Insert this overlay (open scaffolder) →
          </button>
          <button className="btn ghost" onClick={() => S.set({ exampleStep: Math.min(EXAMPLE_STEPS.length - 1, step + 1) })}>
            I'll do it myself
          </button>
        </div>
      </div>
    );
  }
  const s = EXAMPLE_STEPS[step]!;
  return (
    <div>
      <div className="sec" style={sx("color:var(--acc-ink);margin-bottom:6px")}>
        {`Step ${step + 1}`}
      </div>
      <h1 style={sx("margin:0 0 10px;font-size:24px")}>{s.t}</h1>
      <p style={sx(BODY_P)}>{s.sub + "."}</p>
      <p style={sx("margin:0 0 20px;font-size:13.5px;color:var(--muted);line-height:1.65;max-width:720px")}>
        {step === 0
          ? "A mod is just a folder under mods/. Creating any overlay (via + New overlay) makes the folder for you — nothing outside mods/<name>/ is ever written."
          : step === 1
            ? "The overlay file carries a .append suffix so it adds a new entry without touching the base table. See step 2's code for the shape."
            : step === 3
              ? "A native mod registers JokersLuck in registered-names.json. The validator reads that list, so the data overlay's reference resolves. (Illustrative — editing registered-names.json is a native-mod task.)"
              : "Re-run Validate, then launch the dev save with -modpaths/-savesuffix outside the editor (Launch dev shows the exact command). Bind JokersGambit in battle to see JokersLuck reroll luck."}
      </p>
      <div style={sx("display:flex;gap:12px;margin-top:10px")}>
        {step > 0 ? (
          <button className="btn ghost" onClick={() => S.set({ exampleStep: step - 1 })}>
            ← Back
          </button>
        ) : null}
        {step < EXAMPLE_STEPS.length - 1 ? (
          <button className="btn primary" onClick={() => S.set({ exampleStep: step + 1 })}>
            Next →
          </button>
        ) : (
          <button className="btn primary" onClick={() => S.set({ exampleOpen: false })}>
            Finish
          </button>
        )}
      </div>
    </div>
  );
}

function Stepper({ steps, step, onPick, blurb }: { steps: ExampleStep[]; step: number; onPick: (i: number) => void; blurb: string }): React.JSX.Element {
  const pct = Math.round(((step + 1) / steps.length) * 100);
  return (
    <div className="stepper">
      <div style={sx("display:flex;align-items:center;gap:10px;margin-bottom:6px")}>
        <div className="progress">
          <div style={{ width: `${pct}%` }} />
        </div>
        <span style={sx("font-size:12px;color:var(--muted)")}>{`Step ${step + 1} / ${steps.length}`}</span>
      </div>
      <p style={sx("font-size:12.5px;color:var(--muted);margin:0 0 18px")}>{blurb}</p>
      <div style={sx("display:flex;flex-direction:column;gap:6px")}>
        {steps.map((s, i) => (
          <button
            key={i}
            className={"exstep" + (i === step ? " cur" : "")}
            style={sx("border:0;background:" + (i === step ? "var(--accbg)" : "transparent") + ";text-align:left;cursor:pointer")}
            onClick={() => onPick(i)}
          >
            <span className={"stepnum " + (i < step ? "done" : i === step ? "on" : "off")}>{i < step ? "✓" : String(i + 1)}</span>
            <div>
              <div style={sx("font-weight:" + (i === step ? "700" : "600") + ";font-size:13.5px;color:" + (i <= step ? "var(--ink)" : "var(--muted)"))}>{s.t}</div>
              <div style={sx("font-size:12px;color:var(--muted)")}>{s.sub}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

export function WorkedExample(): React.JSX.Element {
  const step = useS((s) => s.exampleStep);
  return (
    <div className="example">
      <div className="exhdr">
        <span style={sx("font-size:18px")}>★</span>
        <div style={sx("font-weight:700;font-size:15px")}>Worked example — build Joker's Luck</div>
        <span className="pill append chip">tutorial</span>
        <div className="grow" />
        <button className="btn ghost" onClick={() => S.set({ exampleOpen: false })}>
          Exit example
        </button>
      </div>
      <div className="exgrid">
        <Stepper steps={EXAMPLE_STEPS} step={step} onPick={(i) => S.set({ exampleStep: i })} blurb="A new status that rerolls luck to ±10 every turn." />
        <div className="stepcontent">
          <ExampleBody step={step} />
        </div>
      </div>
    </div>
  );
}

// ---- art worked example (import an SVG → preview → build) ------------------------------
const ART_EXAMPLE_STEPS: ExampleStep[] = [
  { t: "Switch to Art mode", sub: "Data | Art top-bar switch" },
  { t: "Create a scene", sub: "art/<name>.scene.json" },
  { t: "Import an SVG", sub: "becomes a grayscale shape" },
  { t: "Preview it faithfully", sub: "palette row + scrubber" },
  { t: "Build the SWF", sub: "swfs/<name>.swf" },
];
const ART_SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect x="8" y="8" width="48" height="48" rx="10" fill="#888888"/>
  <circle cx="24" cy="28" r="5" fill="#222222"/>
  <circle cx="40" cy="28" r="5" fill="#222222"/>
  <path d="M20 42 Q32 52 44 42" fill="none" stroke="#dddddd" stroke-width="3"/>
</svg>`;

const ART_P = "margin:0 0 18px;font-size:13.5px;color:var(--ink2);line-height:1.65;max-width:720px";

function ArtExampleBody({ step }: { step: number }): React.JSX.Element {
  const s = ART_EXAMPLE_STEPS[step]!;
  let detail: React.JSX.Element;
  let action: React.JSX.Element;
  if (step === 0) {
    detail = (
      <p style={sx(ART_P)}>
        The top-bar <span className="mono">Data | Art</span> switch flips the whole editor. Art mode authors vector scenes and builds them into the SWF subset the engine loads — all writes still land only under{" "}
        <span className="mono">{"mods/<name>/"}</span>, so your saves are never touched.
      </p>
    );
    action = (
      <button className="btn primary" onClick={() => artExampleGoto(() => {})}>
        Enter Art mode →
      </button>
    );
  } else if (step === 1) {
    detail = (
      <p style={sx(ART_P)}>
        A scene is an <span className="mono">{"art/<name>.scene.json"}</span> file — the hand-editable source model of shapes, sprites and exports. Open a mod first (top-bar mod switcher), then create one. The starter is a bobbing gray square
        with idle/blink labels.
      </p>
    );
    action = (
      <button className="btn primary" onClick={() => artExampleGoto(() => openNewSceneModal())}>
        Open the New scene dialog →
      </button>
    );
  } else if (step === 2) {
    detail = (
      <>
        <p style={sx("margin:0 0 16px;font-size:13.5px;color:var(--ink2);line-height:1.65;max-width:720px")}>
          Drop an SVG onto the Art panel (or use the file picker). Each SVG becomes one shape. Fills that are gray become <span className="mono">gray:0–15</span> levels the engine recolors; non-gray colours pass through and are flagged. Here's a
          tiny sample — the <span className="mono">#888888</span>/<span className="mono">#222222</span>/<span className="mono">#dddddd</span> fills land on gray levels 8, 2 and 13:
        </p>
        <pre className="mergecode" style={sx("max-width:620px")}>
          {ART_SAMPLE_SVG}
        </pre>
      </>
    );
    action = (
      <button className="btn primary" onClick={() => artExampleGoto(() => setArtSubtab("shapes"))}>
        Go to the Shapes panel to import →
      </button>
    );
  } else if (step === 3) {
    detail = (
      <p style={sx(ART_P)}>
        The Preview draws the scene exactly as the engine does: the 16-level gray is remapped through a <span className="mono">palette.png</span> row you pick, with timeline playback, a frame-label scrubber, and a{" "}
        <span className="mono">show raw grayscale</span> toggle to see the authored levels before the remap.
      </p>
    );
    action = (
      <button className="btn primary" onClick={() => artExampleGoto(() => setArtRightTab("preview"))}>
        Open the Preview →
      </button>
    );
  } else {
    detail = (
      <p style={sx(ART_P)}>
        Build emits <span className="mono">{"mods/<mod>/swfs/<name>.swf"}</span> plus a <span className="mono">swflist.gon.append</span>. Build with no DoABC or a stub DoABC — which one the engine needs is the one open gate test (run the dev-save
        procedure from the Build tab). GON then addresses your art by its export names.
      </p>
    );
    action = (
      <button className="btn primary" onClick={() => artExampleGoto(() => setArtRightTab("build"))}>
        Open the Build tab →
      </button>
    );
  }
  return (
    <div>
      <div className="sec" style={sx("color:var(--acc-ink);margin-bottom:6px")}>
        {`Step ${step + 1}`}
      </div>
      <h1 style={sx("margin:0 0 10px;font-size:24px")}>{s.t}</h1>
      {detail}
      <div style={sx("display:flex;gap:12px;margin-top:24px;flex-wrap:wrap;align-items:center")}>
        {step > 0 ? (
          <button className="btn ghost" onClick={() => S.set({ artExampleStep: step - 1 })}>
            ← Back
          </button>
        ) : null}
        {action}
        <div className="grow" />
        {step < ART_EXAMPLE_STEPS.length - 1 ? (
          <button className="btn ghost" onClick={() => S.set({ artExampleStep: step + 1 })}>
            Next →
          </button>
        ) : (
          <button className="btn ghost" onClick={() => S.set({ artExampleOpen: false })}>
            Finish
          </button>
        )}
      </div>
    </div>
  );
}

export function ArtWorkedExample(): React.JSX.Element {
  const step = useS((s) => s.artExampleStep);
  return (
    <div className="example">
      <div className="exhdr">
        <span style={sx("font-size:18px")}>▲</span>
        <div style={sx("font-weight:700;font-size:15px")}>Art worked example — SVG → preview → SWF</div>
        <span className="pill append chip">tutorial</span>
        <div className="grow" />
        <button className="btn ghost" onClick={() => S.set({ artExampleOpen: false })}>
          Exit example
        </button>
      </div>
      <div className="exgrid">
        <Stepper steps={ART_EXAMPLE_STEPS} step={step} onPick={(i) => S.set({ artExampleStep: i })} blurb="Author grayscale vector art the engine recolors, and build it into a loadable SWF." />
        <div className="stepcontent">
          <ArtExampleBody step={step} />
        </div>
      </div>
    </div>
  );
}
