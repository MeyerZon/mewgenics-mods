// Rooms mode: the input both grids (flat and iso) share. Pointer events paint (down starts a stroke, entering
// another cell while the button is held continues it, ONE window pointerup / pointercancel listener ends it); the
// keyboard paints too (the grid is role=grid with one roving tabbable cell: arrows move the selection, Enter / Space
// apply the current tool there).

import React, { useEffect } from "react";
import { strokeStart, strokeEnter, strokeEnd, moveSelection, applyAtSelection, type CellPos } from "./room-state.ts";

/** pointerdown on a cell: a primary press starts a stroke there. */
export function cellPointerDown(e: React.PointerEvent<HTMLElement>, x: number, y: number): void {
  if (e.button !== 0) return;
  e.preventDefault();
  const el = e.currentTarget;
  // touch and pen capture the pointer implicitly, which would keep pointerenter off the other cells: release it so a
  // drag paints across cells as it does with a mouse
  if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
  el.focus({ preventScroll: true });
  strokeStart(x, y);
}

/** pointerenter on a cell: continues a stroke while the button is held. */
export function cellPointerEnter(x: number, y: number): void {
  strokeEnter(x, y);
}

const MOVES: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/** keydown on the grid: arrows move the selection, Enter / Space apply the tool at it. */
export function gridKeyDown(e: React.KeyboardEvent<HTMLElement>): void {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const mv = MOVES[e.key];
  if (mv) {
    e.preventDefault();
    moveSelection(mv[0], mv[1]);
  } else if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    applyAtSelection();
  }
}

/** The one window listener that ends a stroke (mounted once by the Rooms centre pane). */
export function useStrokeEnd(): void {
  useEffect(() => {
    const up = () => strokeEnd();
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);
}

/** Roving focus: when the selection moves while focus is in the grid, the selected cell takes the focus. */
export function useRovingFocus(ref: React.RefObject<HTMLElement | null>, sel: CellPos | null): void {
  const x = sel ? sel.x : -1;
  const y = sel ? sel.y : -1;
  useEffect(() => {
    const root = ref.current;
    if (!root || x < 0 || !root.contains(document.activeElement)) return;
    const el = root.querySelector<HTMLElement>(`[role="gridcell"][data-x="${x}"][data-y="${y}"]`);
    if (el && el !== document.activeElement) el.focus({ preventScroll: false });
  }, [ref, x, y]);
}

/** The one tabbable cell: the selection, else (0, 0). */
export function isTabStop(sel: CellPos | null, x: number, y: number): boolean {
  return sel ? sel.x === x && sel.y === y : x === 0 && y === 0;
}
