// The editor's app-level store (was the `S` and `tpl` objects of van.state in app.mjs) plus
// the few helpers both the data-mode and the art-mode modules need (toast, tours,
// localStorage). Actions that drive the data mode (selectMod, openFile, save, …) live in
// ./actions.ts; art-mode state and actions live in ./art/art-state.ts.

import { createStore } from "./store.ts";
import type {
  ModFileInfo,
  Report,
  Finding,
  PreviewResult,
  ComponentSearchResult,
  BaseCategory,
  BaseEntryView,
  TemplateResult,
  TemplateKindName,
  EditorStatus,
} from "./types.ts";

export type ToastKind = "info" | "ok" | "error";
export interface ToastMessage {
  id: number;
  text: string;
  kind: ToastKind;
}

export type Tab = "validation" | "preview" | "components";
/** A section of the concepts drawer (components/ConceptsDrawer.tsx). */
export type ConceptsSection = "" | "data" | "art" | "rooms";
export type OpenMenu = "" | "mod" | "help" | "launch" | `shape:${string}`;

/** The unsaved-work dialog (dirty.ts guard → App.tsx ConfirmModal); null when closed. */
export interface ConfirmState {
  title: string;
  body: string;
  /** offer "Save and continue" (every dirty scope can save) */
  canSave: boolean;
}

export interface AppState {
  mods: string[];
  mod: string;
  files: ModFileInfo[];
  file: string;
  saved: boolean;
  report: Report | null;
  preview: PreviewResult | null;
  tab: Tab;
  baseCats: BaseCategory[];
  baseCategory: string;
  baseEntries: string[];
  baseEntriesTotal: number;
  baseView: BaseEntryView | null;
  components: ComponentSearchResult | null;
  compTotal: number;
  /** the toast queue (newest last); write through toast(), read by components/StatusBar.tsx Toast */
  messages: ToastMessage[];
  /** per-action in-flight flags (setBusy) */
  busy: Record<string, boolean>;
  docBytes: number;
  docLines: number;
  /** the live validation of the open overlay is pending (the 350 ms debounce or its request) */
  validating: boolean;
  openMenu: OpenMenu;
  // overlays
  templateOpen: boolean;
  conceptsOpen: boolean;
  /** the concepts drawer section to scroll to on open ("" = the top) */
  conceptsSection: ConceptsSection;
  baseDrawer: boolean;
  compDrawer: boolean;
  tourOpen: boolean;
  tourStep: number;
  tourDontShow: boolean;
  exampleOpen: boolean;
  exampleStep: number;
  // art mode (was `artMode` exported from art-ui.mjs) + its onboarding
  artMode: boolean;
  /** Rooms mode (the Room editor: rooms/RoomPanes.tsx); exclusive with artMode */
  roomMode: boolean;
  artTourOpen: boolean;
  artTourStep: number;
  artTourDontShow: boolean;
  artExampleOpen: boolean;
  artExampleStep: number;
  // Rooms mode onboarding (UX PR 6): the Rooms tour, gated like the Art tour
  roomTourOpen: boolean;
  roomTourStep: number;
  roomTourDontShow: boolean;
  confirm: ConfirmState | null;
  /** GET /api/status (null until it answers) */
  status: EditorStatus | null;
  /** the last /api/status fetch reached the server */
  serverOk: boolean;
}

// ---- response shapes the app reads: see ./types.ts (kept under these names for callers) ----
export type ModFile = ModFileInfo;
export type ValidationReport = Report;
export type { Finding, PreviewResult, ComponentSearchResult, BaseCategory, BaseEntryView };

export const S = createStore<AppState>({
  mods: [],
  mod: "",
  files: [],
  file: "",
  saved: true,
  report: null,
  preview: null,
  tab: "validation",
  baseCats: [],
  baseCategory: "",
  baseEntries: [],
  baseEntriesTotal: 0,
  baseView: null,
  components: null,
  compTotal: 0,
  messages: [],
  busy: {},
  docBytes: 0,
  docLines: 1,
  validating: false,
  openMenu: "",
  templateOpen: false,
  conceptsOpen: false,
  conceptsSection: "",
  baseDrawer: false,
  compDrawer: false,
  tourOpen: false,
  tourStep: 0,
  tourDontShow: false,
  exampleOpen: false,
  exampleStep: 0,
  artMode: false,
  roomMode: false,
  artTourOpen: false,
  artTourStep: 0,
  artTourDontShow: false,
  artExampleOpen: false,
  artExampleStep: 0,
  roomTourOpen: false,
  roomTourStep: 0,
  roomTourDontShow: false,
  confirm: null,
  status: null,
  serverOk: true,
});

// ---- base-data paging (GET /api/base?category=&filter=&offset=&limit=) ----------------
/** How many base entries one page lists (the explorer's "Show 300 more"). */
export const BASE_PAGE = 300;

export interface BaseList {
  entries: string[];
  total: number;
}
/**
 * Fold one listing page into the loaded entries (pure): offset 0 replaces them, an offset equal to the loaded
 * length appends, anything else is a stale reply (a newer filter or category won) and returns `cur` unchanged.
 */
export function applyBasePage(cur: BaseList, page: BaseList & { offset: number }): BaseList {
  if (page.offset === 0) return { entries: page.entries, total: page.total };
  if (page.offset !== cur.entries.length) return cur;
  return { entries: [...cur.entries, ...page.entries], total: page.total };
}

// template-scaffolder fields (module-level so onboarding can prefill them)
/** what the modal was opened for: a new mod (the mod menu's New mod) or an overlay in a mod (its title follows) */
export type TemplateIntent = "mod" | "overlay";
export interface TemplateForm {
  intent: TemplateIntent;
  mod: string;
  kind: TemplateKindName;
  name: string;
  display: string;
  desc: string;
  parent: string;
  status: string;
  /** glowing-character: rrggbb[aa] */
  colour: string;
  result: TemplateResult | null;
}
export const tpl = createStore<TemplateForm>({
  intent: "overlay",
  mod: "",
  kind: "ability",
  name: "",
  display: "",
  desc: "",
  parent: "Spin",
  status: "",
  colour: "",
  result: null,
});

// ---- localStorage helpers (per-viewer onboarding memory; always guarded) ----------------
export function lsGet(k: string): string | null {
  try {
    return window.localStorage.getItem(k);
  } catch {
    return null;
  }
}
export function lsSet(k: string, v: string): void {
  try {
    window.localStorage.setItem(k, v);
  } catch {
    /* private mode / blocked storage — onboarding still works, just not remembered */
  }
}
export function lsRemove(k: string): void {
  try {
    window.localStorage.removeItem(k);
  } catch {
    /* as lsSet */
  }
}

// ---- shared helpers -------------------------------------------------------------------
/** How many toasts show at once (older ones drop off first). */
export const TOAST_CAP = 4;

/** Queue a message (pure): a repeat of a showing text replaces it (moves to the end, new id); capped at TOAST_CAP. */
export function pushMessage(list: readonly ToastMessage[], msg: ToastMessage): ToastMessage[] {
  const next = list.filter((m) => m.text !== msg.text);
  next.push(msg);
  return next.length > TOAST_CAP ? next.slice(next.length - TOAST_CAP) : next;
}
/** Drop a message by id (pure); an unknown id returns the list unchanged. */
export function expireMessage(list: readonly ToastMessage[], id: number): ToastMessage[] {
  return list.some((m) => m.id === id) ? list.filter((m) => m.id !== id) : (list as ToastMessage[]);
}

export interface ToastOptions {
  kind?: ToastKind;
  /** how long it shows (default 5 s; 8 s for errors) */
  ms?: number;
}
let toastSeq = 0;
/** Show a transient status message in the Toast queue. */
export function toast(text: string, opts: ToastOptions = {}): void {
  const kind = opts.kind || "info";
  const id = ++toastSeq;
  S.set((s) => ({ messages: pushMessage(s.messages, { id, text, kind }) }));
  const t = setTimeout(() => dismissToast(id), opts.ms ?? (kind === "error" ? 8000 : 5000));
  // Node (the unit tests) must not wait for a toast's timer to exit
  (t as unknown as { unref?: () => void }).unref?.();
}
/** Remove one toast (its timer ran out, or the user clicked it). */
export function dismissToast(id: number): void {
  S.set((s) => ({ messages: expireMessage(s.messages, id) }));
}

/** Mark an action as in flight (on) or done (off). */
export function setBusy(key: string, on: boolean): void {
  S.set((s) => {
    if (on === !!s.busy[key]) return {};
    const busy = { ...s.busy };
    if (on) busy[key] = true;
    else delete busy[key];
    return { busy };
  });
}

/**
 * In-memory onboarding gates: once the Art / Rooms tour has been opened or deliberately suppressed (a deep link),
 * entering that mode no longer auto-opens it. `tourCentered` is the `?tour=center` switch (the card without a
 * spotlight), read once at startup.
 */
export const onboarding = { artTourTriggered: false, roomTourTriggered: false, tourCentered: false };

/** The three tours and their per-viewer localStorage keys (closing one sets *Seen; the checkbox sets *DontShow). */
export type TourKind = "data" | "art" | "rooms";
export const TOUR_KEYS: Record<TourKind, { seen: string; dontShow: string }> = {
  data: { seen: "mewged.onboard.tourSeen", dontShow: "mewged.onboard.tourDontShow" },
  art: { seen: "mewged.onboard.artTourSeen", dontShow: "mewged.onboard.artTourDontShow" },
  rooms: { seen: "mewged.onboard.roomTourSeen", dontShow: "mewged.onboard.roomTourDontShow" },
};

/** Open the Art tour at step 0 (Help menu, the Art empty state, first Art entry). */
export function openArtTour(): void {
  onboarding.artTourTriggered = true;
  S.set({ artTourStep: 0, artTourOpen: true, openMenu: "" });
}
/** Open the Rooms tour at step 0 (Help menu, the Rooms empty state, first Rooms entry). */
export function openRoomTour(): void {
  onboarding.roomTourTriggered = true;
  S.set({ roomTourStep: 0, roomTourOpen: true, openMenu: "" });
}

// ---- the overlay editor's document state (components/Editor.tsx reports through these) ------------------
/** The open document's size, for the status line. */
export function setDocStats(lines: number, bytes: number): void {
  const s = S.get();
  if (s.docLines !== lines || s.docBytes !== bytes) S.set({ docLines: lines, docBytes: bytes });
}
/** The overlay was edited (the Save button's dot, the unsaved-work guard). */
export function markUnsaved(): void {
  if (S.get().saved) S.set({ saved: false });
}
