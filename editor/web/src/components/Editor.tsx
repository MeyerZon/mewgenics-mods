// The persistent GON editor: one uncontrolled <textarea> plus a highlight overlay (pre.hl) and
// a line-number gutter, painted on a single requestAnimationFrame (keystroke/scroll bursts
// coalesce into one paint per frame) and windowed to the on-screen slice ± a buffer. Nothing
// here goes through React state: typing never rebuilds the element. highlightGon() is
// line-local (strings and // comments never cross a newline), so highlighting a window of
// lines is byte-identical to highlighting the whole buffer — a keystroke stays
// O(visible lines) instead of O(whole file).
//
// `editorCtl` is the imperative handle the actions use (openFile sets the text, runLive/save
// read it). The component attaches its nodes on mount and detaches on unmount; the text
// survives a remount (switching to Art mode and back replaces the center pane).

import React from "react";
import { setDocStats, markUnsaved } from "../state.ts";
import { highlightGon, esc } from "../gon-highlight.ts";
import { useS } from "./ui.tsx";
import { scheduleLive } from "../actions.ts";

const EDITOR_BUFFER_LINES = 24; // lines rendered above/below the viewport so small scrolls stay covered

let ta: HTMLTextAreaElement | null = null;
let hlPre: HTMLElement | null = null;
let gutterPre: HTMLElement | null = null;
let detachedText = "";
let editorLines: string[] = [""];
let editorTextDirty = true;
let editorLineH = 0;
let editorRaf = 0;

function editorLineHeight(): number {
  if (editorLineH > 0 || !ta) return editorLineH || 13 * 1.7;
  try {
    const cs = getComputedStyle(ta);
    const lh = parseFloat(cs.lineHeight);
    const fs = parseFloat(cs.fontSize) || 13;
    // Use the computed px line-height; fall back to fs×1.7 if it's "normal"/absent or
    // implausibly small (a bad value would mis-size the visible-line window).
    editorLineH = Number.isFinite(lh) && lh >= 6 ? lh : fs * 1.7;
  } catch {
    editorLineH = 13 * 1.7;
  }
  return editorLineH;
}

// Recompute the cached line split + status-bar counts (O(n), only when text changed).
function recomputeEditorText(): void {
  const text = ta ? ta.value : detachedText;
  editorLines = text.length ? text.split("\n") : [""];
  let docBytes: number;
  try {
    docBytes = new TextEncoder().encode(text).length;
  } catch {
    docBytes = text.length;
  }
  setDocStats(editorLines.length, docBytes);
}

// One paint: reads geometry first, then writes DOM (no read-after-write thrash).
function paintEditor(): void {
  if (editorTextDirty) {
    recomputeEditorText();
    editorTextDirty = false;
  }
  if (!ta || !hlPre || !gutterPre) return;
  const total = editorLines.length;
  const lh = editorLineHeight();
  const st = ta.scrollTop;
  const sl = ta.scrollLeft;
  const viewH = ta.clientHeight || 1;
  const first = Math.max(0, Math.floor(st / lh) - EDITOR_BUFFER_LINES);
  const windowCount = Math.ceil(viewH / lh) + EDITOR_BUFFER_LINES * 2;
  const last = Math.min(total, first + windowCount);
  const slice = editorLines.slice(first, last).join("\n");
  let html = first > 0 ? "\n".repeat(first) : "";
  try {
    html += highlightGon(slice);
  } catch {
    html += esc(slice);
  }
  if (last >= total) html += "\n";
  hlPre.innerHTML = html;
  let g = first > 0 ? "\n".repeat(first) : "";
  for (let i = first; i < last; i++) g += i + 1 + "\n";
  gutterPre.textContent = g;
  hlPre.style.transform = `translate(${-sl}px, ${-st}px)`;
  gutterPre.style.transform = `translateY(${-st}px)`;
}

function schedulePaint(): void {
  if (editorRaf) return;
  editorRaf = requestAnimationFrame(() => {
    editorRaf = 0;
    paintEditor();
  });
}

// Paint immediately (used when a file is loaded, so the overlay is correct at once).
function repaintNow(): void {
  editorTextDirty = true;
  if (editorRaf) {
    cancelAnimationFrame(editorRaf);
    editorRaf = 0;
  }
  paintEditor();
}

export interface EditorController {
  /** Current buffer text (the textarea's value, or the retained text while unmounted). */
  getValue(): string;
  /** Replace the buffer text (does not repaint; call repaintNow). */
  setValue(text: string): void;
  /** Scroll to the top-left. */
  resetScroll(): void;
  repaintNow(): void;
  schedulePaint(): void;
  /** Called by the Editor component; returns the detach function. */
  attach(textarea: HTMLTextAreaElement, hl: HTMLElement, gutter: HTMLElement): () => void;
}

export const editorCtl: EditorController = {
  getValue: () => (ta ? ta.value : detachedText),
  setValue(text) {
    detachedText = text;
    if (ta) ta.value = text;
    editorTextDirty = true;
  },
  resetScroll() {
    if (ta) {
      ta.scrollTop = 0;
      ta.scrollLeft = 0;
    }
  },
  repaintNow,
  schedulePaint,
  attach(textarea, hl, gutter) {
    ta = textarea;
    hlPre = hl;
    gutterPre = gutter;
    ta.value = detachedText;
    editorTextDirty = true;
    const onInput = () => {
      markUnsaved();
      editorTextDirty = true;
      schedulePaint();
      scheduleLive();
    };
    const onScroll = () => schedulePaint();
    ta.addEventListener("input", onInput);
    ta.addEventListener("scroll", onScroll);
    repaintNow();
    return () => {
      detachedText = ta ? ta.value : detachedText;
      ta?.removeEventListener("input", onInput);
      ta?.removeEventListener("scroll", onScroll);
      if (editorRaf) {
        cancelAnimationFrame(editorRaf);
        editorRaf = 0;
      }
      ta = null;
      hlPre = null;
      gutterPre = null;
    };
  },
};

export function Editor(): React.JSX.Element {
  const file = useS((s) => s.file);
  const taRef = React.useRef<HTMLTextAreaElement>(null);
  const hlRef = React.useRef<HTMLPreElement>(null);
  const gutRef = React.useRef<HTMLPreElement>(null);
  React.useLayoutEffect(() => editorCtl.attach(taRef.current!, hlRef.current!, gutRef.current!), []);
  return (
    <div className="edcode" style={file ? undefined : { display: "none" }}>
      <div className="edgutter">
        <pre ref={gutRef} />
      </div>
      <div className="edmain">
        <pre ref={hlRef} className="hl" aria-hidden="true" />
        <textarea ref={taRef} className="code" spellCheck={false} aria-label="GON overlay source editor" />
      </div>
    </div>
  );
}
