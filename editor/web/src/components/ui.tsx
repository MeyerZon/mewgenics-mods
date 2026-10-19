// Small shared pieces for the components: the store hook, the inline-style helper, and the
// read-only highlighted code block.

import React from "react";
import { S, type AppState } from "../state.ts";
import { useStore } from "../store.ts";
import { highlightGon } from "../gon-highlight.ts";

/** Subscribe to one slice of the app store (primitives or values already held in state). */
export function useS<R>(selector: (s: AppState) => R): R {
  return useStore(S, selector);
}

/**
 * Inline style string → React style object. The VanJS UI carried its one-off styles as
 * `style="a:b;c:d"` strings; the ported markup keeps them verbatim through this helper so the
 * rendered styles stay identical.
 */
export function sx(style: string): React.CSSProperties {
  const out: Record<string, string> = {};
  for (const part of style.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k || !v) continue;
    out[k.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = v;
  }
  return out as React.CSSProperties;
}

/** A read-only highlighted code block (pre.mergecode.hl). */
export function CodeView({ text, extraClass }: { text: string; extraClass?: string }): React.JSX.Element {
  let html: string | null = null;
  try {
    html = highlightGon(text);
  } catch {
    html = null;
  }
  const cls = "mergecode hl" + (extraClass ? " " + extraClass : "");
  if (html === null) return <pre className={cls}>{text}</pre>;
  return <pre className={cls} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Pretty-printed JSON in a plain pre.mergecode. */
export function JsonView({ value }: { value: unknown }): React.JSX.Element {
  return <pre className="mergecode">{JSON.stringify(value, null, 2)}</pre>;
}
