// The worked examples' shared parts: the full-page overlay shell (header + Exit example, the step list on the left,
// the step content on the right; useDialog for focus, Tab trap and Esc), the memoized step rows and the renderer of a
// step's body blocks (examples/steps.ts).

import React from "react";
import { sx, CodeView } from "../ui.tsx";
import { useDialog } from "../../hooks/useDialog.ts";
import type { ExampleBlock, ExampleStep } from "./steps.ts";

const h = React.createElement;

/** Text with `backtick` marks → text and mono spans (static content, so the parts need no keys). */
export function Inline({ text }: { text: string }): React.JSX.Element {
  const parts = text.split("`").map((t, i) => (i % 2 ? h("span", { className: "mono", style: sx("color:var(--acc-ink)") }, t) : t));
  return h(React.Fragment, null, ...parts);
}

const P = "margin:0 0 18px;font-size:14px;color:var(--ink2);line-height:1.65;max-width:720px";
const MUTED = "margin:0 0 18px;font-size:13.5px;color:var(--muted);line-height:1.65;max-width:720px";

function Block({ b }: { b: ExampleBlock }): React.JSX.Element {
  if (b.kind === "p") return <p style={sx(P)}><Inline text={b.text} /></p>;
  if (b.kind === "muted") return <p style={sx(MUTED)}><Inline text={b.text} /></p>;
  if (b.kind === "ok") {
    return (
      <div style={sx("display:flex;align-items:center;gap:10px;margin:0 0 18px;max-width:760px;background:var(--okbg);border:1px solid rgba(63,185,80,.3);border-radius:10px;padding:12px 14px")}>
        <span className="dotok" style={sx("font-size:15px")}>✓</span>
        <span style={sx("font-size:13px;color:var(--ink2)")}><Inline text={b.text} /></span>
      </div>
    );
  }
  if (!b.path) return <pre className="mergecode" style={sx("max-width:620px;margin:0 0 18px")}>{b.text}</pre>;
  return (
    <div className="codeblock" style={sx("margin:0 0 18px")}>
      <div className="cbhead">
        <span className="mono" style={sx("font-size:12px")}>{b.path}</span>
        <div className="grow" />
        {b.chip ? <span className="pill append chip">{b.chip}</span> : null}
      </div>
      {b.gon ? <CodeView text={b.text} extraClass="cbcode" /> : <pre className="cbcode">{b.text}</pre>}
    </div>
  );
}

/** A step's body: its blocks in order (static per step, so they render without keys). */
export function StepBody({ blocks }: { blocks: readonly ExampleBlock[] }): React.JSX.Element {
  return h(React.Fragment, null, ...blocks.map((b) => h(Block, { b })));
}

const StepRow = React.memo(function StepRow({ n, title, sub, state, onPick }: { n: number; title: string; sub: string; state: "done" | "on" | "off"; onPick: (n: number) => void }): React.JSX.Element {
  const on = state === "on";
  return (
    <button
      type="button"
      className={"exstep" + (on ? " cur" : "")}
      aria-current={on ? "step" : undefined}
      style={sx("border:0;background:" + (on ? "var(--accbg)" : "transparent") + ";text-align:left;cursor:pointer")}
      onClick={() => onPick(n - 1)}
    >
      <span className={"stepnum " + state}>{state === "done" ? "✓" : String(n)}</span>
      <div>
        <div style={sx("font-weight:" + (on ? "700" : "600") + ";font-size:13.5px;color:" + (state === "off" ? "var(--muted)" : "var(--ink)"))}>{title}</div>
        <div style={sx("font-size:12px;color:var(--muted)")}>{sub}</div>
      </div>
    </button>
  );
});

export interface ExampleShellProps {
  icon: string;
  title: string;
  blurb: string;
  steps: readonly ExampleStep[];
  step: number;
  onPick: (n: number) => void;
  onClose: () => void;
  children: React.ReactNode;
}

/** The full-page example overlay (`.example`): header, step list, content. */
export function ExampleShell({ icon, title, blurb, steps, step, onPick, onClose, children }: ExampleShellProps): React.JSX.Element {
  const ref = useDialog<HTMLDivElement>(true, { onClose });
  const pct = Math.round(((step + 1) / steps.length) * 100);
  return (
    <div ref={ref} className="example" aria-label={title}>
      <div className="exhdr">
        <span style={sx("font-size:18px")}>{icon}</span>
        <div style={sx("font-weight:700;font-size:15px")}>{title}</div>
        <span className="pill append chip">tutorial</span>
        <div className="grow" />
        <button className="btn ghost" onClick={onClose}>
          Exit example
        </button>
      </div>
      <div className="exgrid">
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
              <StepRow key={s.id} n={i + 1} title={s.title} sub={s.sub} state={i < step ? "done" : i === step ? "on" : "off"} onPick={onPick} />
            ))}
          </div>
        </div>
        <div className="stepcontent">{children}</div>
      </div>
    </div>
  );
}

/** The step content frame: "Step n", the title, the body, then Back · the jump action · Next / Finish. */
export function StepContent({ step, steps, action, onGo, onFinish }: { step: number; steps: readonly ExampleStep[]; action: React.ReactNode; onGo: (n: number) => void; onFinish: () => void }): React.JSX.Element {
  const s = steps[step]!;
  const last = step >= steps.length - 1;
  return (
    <div>
      <div className="sec" style={sx("color:var(--acc-ink);margin-bottom:6px")}>{`Step ${step + 1}`}</div>
      <h1 style={sx("margin:0 0 10px;font-size:24px")}>{s.title}</h1>
      <StepBody blocks={s.body} />
      <div style={sx("display:flex;gap:12px;margin-top:24px;flex-wrap:wrap;align-items:center")}>
        {step > 0 ? (
          <button className="btn ghost" onClick={() => onGo(step - 1)}>
            ← Back
          </button>
        ) : null}
        {action}
        <div className="grow" />
        {!last ? (
          <button className={action ? "btn ghost" : "btn primary"} onClick={() => onGo(step + 1)}>
            Next →
          </button>
        ) : (
          <button className={action ? "btn ghost" : "btn primary"} onClick={onFinish}>
            Finish
          </button>
        )}
      </div>
    </div>
  );
}
