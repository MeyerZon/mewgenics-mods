// useDialog: the behaviour every overlay shares (modal, drawer, tour card, worked example).
// Returns a ref for the dialog element; while `open` it
//   - sets role="dialog" aria-modal="true" on it,
//   - moves focus in (`initialFocus`: a ref or a selector inside the dialog; else the first focusable),
//   - traps Tab / Shift+Tab inside it,
//   - registers `onClose` on the Esc overlay stack (shortcuts.ts; Esc closes the topmost),
//   - locks body scroll,
// and on close restores focus to whatever was focused before it opened.

import React from "react";
import { pushOverlay, popOverlay, type OverlayKind } from "../shortcuts.ts";

export interface DialogOptions {
  /** what gets focus on open: a ref, or a CSS selector resolved inside the dialog */
  initialFocus?: React.RefObject<HTMLElement | null> | string;
  onClose: () => void;
  /** where it sits on the Esc stack (default "modal") */
  kind?: OverlayKind;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** The focusable, visible elements inside `root`, in DOM order. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

export function useDialog<T extends HTMLElement = HTMLDivElement>(open: boolean, opts: DialogOptions): React.RefObject<T | null> {
  const ref = React.useRef<T | null>(null);
  // the latest options, read by the effect without re-running it on every render (a re-run would steal focus)
  const optsRef = React.useRef(opts);
  optsRef.current = opts;

  React.useEffect(() => {
    if (!open) return;
    const el = ref.current;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (el) {
      el.setAttribute("role", "dialog");
      el.setAttribute("aria-modal", "true");
      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
      const f = optsRef.current.initialFocus;
      let target: HTMLElement | null = null;
      if (typeof f === "string") target = el.querySelector<HTMLElement>(f);
      else if (f && f.current) target = f.current;
      if (!target) target = focusables(el)[0] || el;
      target.focus({ preventScroll: true });
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !el) return;
      const list = focusables(el);
      if (!list.length) { e.preventDefault(); el.focus(); return; }
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const active = document.activeElement;
      const inside = active instanceof Node && el.contains(active);
      if (e.shiftKey && (active === first || !inside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !inside)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    const token = pushOverlay(() => optsRef.current.onClose(), optsRef.current.kind || "modal");
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      popOverlay(token);
      document.body.style.overflow = prevOverflow;
      // restore focus unless something else (a dialog opened in the same commit) already took it
      const now = document.activeElement;
      const lost = !now || now === document.body || (el !== null && !el.isConnected) || (el !== null && el.contains(now));
      if (before && before.isConnected && lost) before.focus({ preventScroll: true });
    };
  }, [open]);

  return ref;
}
