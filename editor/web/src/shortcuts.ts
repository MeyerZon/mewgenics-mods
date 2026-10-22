// Global keyboard shortcuts: one window keydown listener (initShortcuts, called once from App.tsx).
//   Ctrl/Cmd+S → always preventDefault (the browser's own save dialog never opens), then — unless the key is a
//                repeat, an overlay (.scrim) is open, or a save is already in flight — blur a focused <input> (so
//                commit-on-change inputs like art/Bits.tsx's CommitInput flush) and call the registered save
//                handler (setSaveHandler; PR 2 wires saveCurrent).
//   Esc        → close the topmost overlay of the stack useDialog and Menu push onto (menu > tour > modal > drawer,
//                newest first within a kind).
// Pure parts (matchShortcut, the overlay stack) carry no DOM and are unit-tested in test/web-tests.ts.

export type Shortcut = "save" | "escape";

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  repeat: boolean;
}

/** Which shortcut a keydown is. Ctrl+S matches on repeats too (so the dialog stays suppressed); Esc does not. */
export function matchShortcut(e: KeyLike): Shortcut | null {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") return "save";
  if (e.key === "Escape" && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) return "escape";
  return null;
}

// ---- the overlay stack ----------------------------------------------------------------------
export type OverlayKind = "menu" | "tour" | "modal" | "drawer";
const RANK: Record<OverlayKind, number> = { menu: 4, tour: 3, modal: 2, drawer: 1 };

interface OverlayEntry {
  token: number;
  kind: OverlayKind;
  close: () => void;
}
let overlays: OverlayEntry[] = [];
let nextToken = 1;

/** Register an open overlay; returns the token popOverlay takes. */
export function pushOverlay(close: () => void, kind: OverlayKind = "modal"): number {
  const token = nextToken++;
  overlays = [...overlays, { token, kind, close }];
  return token;
}

/** Unregister an overlay (by its token; with none, the most recently pushed one). */
export function popOverlay(token?: number): void {
  if (token === undefined) overlays = overlays.slice(0, -1);
  else overlays = overlays.filter((o) => o.token !== token);
}

/** Close the topmost overlay (highest kind, newest within it). False when none is open. */
export function closeTopOverlay(): boolean {
  let top: OverlayEntry | null = null;
  for (const o of overlays) if (!top || RANK[o.kind] >= RANK[top.kind]) top = o;
  if (!top) return false;
  top.close();
  return true;
}

// ---- save ----------------------------------------------------------------------------------
type SaveHandler = () => void | Promise<void>;
let onSave: SaveHandler = () => {};
let saving = false;

/** Register what Ctrl/Cmd+S does (a no-op until PR 2 wires saveCurrent). */
export function setSaveHandler(fn: SaveHandler): void {
  onSave = fn;
}

function runSave(): void {
  if (saving) return;
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.tagName === "INPUT") active.blur();
  let r: void | Promise<void>;
  try {
    r = onSave();
  } catch {
    return;
  }
  if (r && typeof r.then === "function") {
    saving = true;
    r.then(
      () => { saving = false; },
      () => { saving = false; },
    );
  }
}

function onKeyDown(e: KeyboardEvent): void {
  const which = matchShortcut(e);
  if (which === "save") {
    e.preventDefault();
    if (e.repeat || document.querySelector(".scrim")) return;
    runSave();
  } else if (which === "escape") {
    if (closeTopOverlay()) e.preventDefault();
  }
}

let installed = false;
/** Install the one window keydown listener (idempotent); returns the uninstall. */
export function initShortcuts(): () => void {
  if (!installed) {
    window.addEventListener("keydown", onKeyDown);
    installed = true;
  }
  return () => {
    window.removeEventListener("keydown", onKeyDown);
    installed = false;
  };
}
