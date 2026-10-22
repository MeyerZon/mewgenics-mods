// Small shared pieces of the art UI: the inline-style helper, the gray ramp, a finding row,
// and an input that commits on the DOM `change` event (blur / Enter / spinner), which is
// what the VanJS `onchange` handlers did — React's per-keystroke onChange is not wanted for
// fields that mutate the scene in place.

import React, { useEffect, useRef } from "react";
import { useStore } from "../store.ts";
import { A, rampColor } from "./art-state.ts";
import type { Finding } from "./types.ts";

/** "a:b;c:d" (the VanJS style strings) → a React style object. */
export function sx(css: string): React.CSSProperties {
  const out: Record<string, string> = {};
  for (const part of css.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    out[k.startsWith("--") ? k : k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
  }
  return out as React.CSSProperties;
}

/** The 16-level ramp with the shape's used levels marked. Re-renders with the palette row / raw-gray toggle. */
export function Ramp({ used }: { used: number[] }) {
  useStore(A, (a) => a.row);
  useStore(A, (a) => a.showGray);
  useStore(A, (a) => a.palette);
  const set = new Set(used);
  return (
    <div className="ramp" title={`gray levels used: ${used.join(", ") || "none"}`}>
      {Array.from({ length: 16 }, (_, level) => (
        <span key={level} className={set.has(level) ? "used" : ""} style={{ background: rampColor(level) }} />
      ))}
    </div>
  );
}

/** Stable keys for a list of scene findings: code + path (a repeat of the pair gets #2, #3, … in report order). */
export function findingKeys(list: readonly Finding[]): string[] {
  const seen = new Map<string, number>();
  return list.map((f) => {
    const k = `${f.code}|${f.path ?? ""}`;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return n === 1 ? k : `${k}#${n}`;
  });
}

/** Scene findings as .finding rows. */
export function FindingRows({ list }: { list: readonly Finding[] }) {
  const keys = findingKeys(list);
  return <>{list.map((f, n) => <FindingRow key={keys[n]} f={f} />)}</>;
}

export function FindingRow({ f }: { f: Finding }) {
  return (
    <div className={`finding ${f.severity}`}>
      <span className="mark">{f.severity === "error" ? "✕" : f.severity === "warning" ? "!" : "i"}</span>
      <div>
        <div>
          <span className="code">{f.code}</span>
          {f.path ? <span className="muted">{`  @ ${f.path}`}</span> : null}
        </div>
        <div>{f.message}</div>
      </div>
    </div>
  );
}

type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "defaultValue">;

/** An uncontrolled input whose `onCommit` fires on the native `change` event with the current value. */
export function CommitInput({ onCommit, initial, ...rest }: InputProps & { onCommit: (value: string, el: HTMLInputElement) => void; initial?: string | number }) {
  const ref = useRef<HTMLInputElement>(null);
  const cb = useRef(onCommit);
  cb.current = onCommit;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = () => cb.current(el.value, el);
    el.addEventListener("change", h);
    return () => el.removeEventListener("change", h);
  }, []);
  return <input ref={ref} defaultValue={initial ?? ""} {...rest} />;
}
