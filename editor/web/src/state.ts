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
} from "./types.ts";

export type Tab = "validation" | "preview" | "components";
export type OpenMenu = "" | "mod" | "help";

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
  message: string;
  docBytes: number;
  docLines: number;
  openMenu: OpenMenu;
  // overlays
  templateOpen: boolean;
  conceptsOpen: boolean;
  baseDrawer: boolean;
  compDrawer: boolean;
  tourOpen: boolean;
  tourStep: number;
  tourDontShow: boolean;
  exampleOpen: boolean;
  exampleStep: number;
  // art mode (was `artMode` exported from art-ui.mjs) + its onboarding
  artMode: boolean;
  artTourOpen: boolean;
  artTourStep: number;
  artTourDontShow: boolean;
  artExampleOpen: boolean;
  artExampleStep: number;
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
  message: "",
  docBytes: 0,
  docLines: 1,
  openMenu: "",
  templateOpen: false,
  conceptsOpen: false,
  baseDrawer: false,
  compDrawer: false,
  tourOpen: false,
  tourStep: 0,
  tourDontShow: false,
  exampleOpen: false,
  exampleStep: 2,
  artMode: false,
  artTourOpen: false,
  artTourStep: 0,
  artTourDontShow: false,
  artExampleOpen: false,
  artExampleStep: 0,
});

// template-scaffolder fields (module-level so onboarding can prefill them)
export interface TemplateForm {
  mod: string;
  kind: TemplateKindName;
  name: string;
  display: string;
  desc: string;
  parent: string;
  status: string;
  result: TemplateResult | null;
}
export const tpl = createStore<TemplateForm>({
  mod: "",
  kind: "ability",
  name: "",
  display: "",
  desc: "",
  parent: "Spin",
  status: "",
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

// ---- shared helpers -------------------------------------------------------------------
let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** Show a transient status message (5 s) in the Toast. */
export function toast(msg: string): void {
  S.set({ message: msg });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => S.set({ message: "" }), 5000);
}

/** Once the Art tour has been opened or deliberately suppressed, entering Art mode no longer auto-opens it. */
export const onboarding = { artTourTriggered: false };

/** Open the Art tour at step 0 (Help menu, art worked example, first Art entry). */
export function openArtTour(): void {
  onboarding.artTourTriggered = true;
  S.set({ artTourStep: 0, artTourOpen: true, openMenu: "" });
}
