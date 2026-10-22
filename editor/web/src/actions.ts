// Data-mode actions (were the module-level functions of app.mjs): plain functions that talk
// to the /api bridge and write into the app store. Components call these; nothing here
// renders. Art-mode actions live in ./art/art-state.ts, Rooms-mode ones in ./rooms/room-state.ts.
// The shell's mode-aware commands (saveCurrent / validateCurrent / openFindings), the editor status
// (GET /api/status) and the deep link (?mode=&mod=&file=) live here too.

import { S, tpl, lsGet, lsSet, lsRemove, onboarding, TOUR_KEYS, toast, applyBasePage, BASE_PAGE, type OpenMenu, type Tab, type TemplateIntent, type TemplateForm, type TourKind, type ConceptsSection } from "./state.ts";
import { getJson, post, url } from "./api.ts";
import { editorCtl } from "./components/Editor.tsx";
import { loadArtForMod, refreshArtListings, saveScene, runValidate as runArtValidate, setArtRightTab } from "./art/art-state.ts";
import { R, loadRoomsForMod, refreshLevels, openLevel, saveLevel, runValidate as runRoomValidate, setRightTab as setRoomRightTab } from "./rooms/room-state.ts";
import { registerDirty, guard, isDirty, ALL_SCOPES, type DirtyScope } from "./dirty.ts";
import { readDeepLink, writeDeepLink, type Mode } from "./deeplink.ts";
import type {
  ListModsResult,
  ListBaseResult,
  ListEntriesResult,
  ReadModResult,
  ReadFileResult,
  WriteResult,
  Report,
  PreviewResult,
  BaseEntryView,
  ComponentSearchResult,
  ModFileInfo,
  OverlayMode,
  FileType,
  TemplateKindName,
  TemplateResult,
  EditorStatus,
} from "./types.ts";

export type { Mode } from "./deeplink.ts";

// ---- live validation / preview (debounced) ----------------------------------------------
// S.validating is true from the keystroke that schedules a check until the newest check has answered.
let liveTimer: ReturnType<typeof setTimeout> | undefined;
let liveRun = 0;
export function scheduleLive(): void {
  if (liveTimer) clearTimeout(liveTimer);
  if (S.get().mod && S.get().file) S.set({ validating: true });
  liveTimer = setTimeout(() => {
    liveTimer = undefined;
    void runLive();
  }, 350);
}
export async function runLive(): Promise<void> {
  const { mod, file } = S.get();
  if (!mod || !file) {
    S.set({ validating: false });
    return;
  }
  const run = ++liveRun;
  S.set({ validating: true });
  try {
    const text = editorCtl.getValue();
    S.set({ report: await post<"/api/validate", Report>("/api/validate", { mod, path: file, text }) });
    S.set({ preview: await post<"/api/preview", PreviewResult>("/api/preview", { mod, path: file, text }) });
  } finally {
    // a newer check (running or scheduled) keeps the flag up
    if (run === liveRun && !liveTimer) S.set({ validating: false });
  }
}

// ---- actions ------------------------------------------------------------------------------
/** List the mods; with none open, open `prefer` (a deep link's ?mod=) when it exists, else the first. */
export async function loadMods(prefer = ""): Promise<void> {
  const r = await getJson<ListModsResult>("/api/mods");
  const mods = r.mods || [];
  S.set({ mods });
  if (!S.get().mod && mods.length) await selectMod(prefer && mods.includes(prefer) ? prefer : mods[0]!);
}
export async function loadBaseCats(): Promise<void> {
  const r = await getJson<ListBaseResult>("/api/base");
  S.set({ baseCats: r.categories || [] });
  if (r.categories && r.categories.length) void selectCategory(r.categories[0]!.category);
}
export async function loadCompTotal(): Promise<void> {
  try {
    const r = await getJson<ComponentSearchResult>("/api/components?query=&limit=5000");
    if (r && typeof r.count === "number") S.set({ compTotal: r.count });
  } catch {
    /* non-fatal */
  }
}
/** Open a mod (closes its open file, scene and room; callers that come from the user guard first: pickMod). */
export async function selectMod(name: string): Promise<void> {
  S.set({ mod: name, file: "", report: null, preview: null, validating: false });
  void loadStatus();
  await refreshModFiles(name);
  await loadArtForMod(name);
  await loadRoomsForMod(name);
}
/** Re-read the mod's file list only (after a save): the open file, scene, room, report and preview stay. */
export async function refreshModFiles(name: string = S.get().mod): Promise<void> {
  if (!name) return;
  const r = await getJson<ReadModResult>(url("/api/mod", { mod: name }));
  const files = r.ok ? r.files : [];
  if (S.get().mod === name) S.set({ files: files.filter((f) => f.relPath !== "description.json" && f.relPath !== "mod.json") });
}
/** The mod menu: asks first when anything (overlay, scene, VectorCraft drawing, room) is unsaved. */
export async function pickMod(name: string): Promise<void> {
  closeMenu();
  if (!(await guard(ALL_SCOPES, "Switching mods"))) return;
  await selectMod(name);
}
export async function openFile(relPath: string): Promise<void> {
  // a level file is binary: it opens in the Room editor, not the text editor
  if (/.lvl$/i.test(relPath)) {
    if (relPath !== R.get().path && !(await guard(["rooms"], "Opening another room"))) return;
    enterRoomMode();
    await openLevel(relPath);
    return;
  }
  const s = S.get();
  if (s.file && !s.saved) {
    if (relPath === s.file) return; // already open with unsaved edits: keep them (a re-read would drop them)
    if (!(await guard(["data"], "Opening another file"))) return;
  }
  S.set({ file: relPath });
  const r = await getJson<ReadFileResult>(url("/api/mod-file", { mod: S.get().mod, path: relPath }));
  editorCtl.setValue(r.ok ? r.text : `// ${r.error || "could not read file"}`);
  S.set({ saved: true });
  editorCtl.resetScroll();
  editorCtl.repaintNow();
  await runLive();
}
export async function closeFile(): Promise<void> {
  if (!(await guard(["data"], "Closing the file"))) return;
  S.set({ file: "", report: null, preview: null, saved: true, validating: false });
}
/** Write the open overlay (the top-bar Save / Ctrl+S in Data mode). True when written. */
export async function save(): Promise<boolean> {
  const { mod, file } = S.get();
  if (!mod || !file) return false;
  const r = await post<"/api/write", WriteResult>("/api/write", { mod, path: file, content: editorCtl.getValue() });
  if (r.ok) {
    S.set({ saved: true });
    toast(`saved ${r.path} (${r.bytes} bytes)`, { kind: "ok", ms: 4000 });
    // only the file list: re-opening the mod would close the open scene and room (and drop their unsaved edits)
    await refreshModFiles(mod);
    S.set({ file: r.path.split("/").slice(2).join("/") });
    return true;
  }
  toast(`write refused: ${r.error}`, { kind: "error", ms: 4000 });
  return false;
}

// unsaved work (dirty.ts): the open overlay
registerDirty("data", {
  dirty: () => !S.get().saved && !!S.get().file,
  label: () => `the overlay ${S.get().file}`,
  save: () => save(),
});

// ---- the shell's mode-aware commands (TopBar Validate / Save, Ctrl+S, the status pill) ----------
export function currentMode(): Mode {
  const s = S.get();
  return s.roomMode ? "rooms" : s.artMode ? "art" : "data";
}
/** The dirty scopes each mode owns (the mode switch's dot, the Save button's dot). */
export const MODE_SCOPES: Record<Mode, DirtyScope[]> = { data: ["data"], art: ["art", "vc"], rooms: ["rooms"] };
/** Whether a mode holds unsaved work. */
export function modeDirty(m: Mode): boolean {
  return isDirty(MODE_SCOPES[m]);
}
/** Save what the current mode has open: the overlay, the scene or the room. True when written. */
export async function saveCurrent(): Promise<boolean> {
  const m = currentMode();
  if (m === "art") return saveScene();
  if (m === "rooms") return saveLevel();
  return save();
}
/** Validate what the current mode has open, now (no debounce). */
export async function validateCurrent(): Promise<void> {
  const m = currentMode();
  if (m === "art") return runArtValidate();
  if (m === "rooms") return runRoomValidate();
  if (liveTimer) clearTimeout(liveTimer);
  liveTimer = undefined;
  return runLive();
}
/** The status pill: show the current mode's findings (the Data Validation tab, the Art / Rooms Findings tab). */
export function openFindings(): void {
  const m = currentMode();
  if (m === "art") setArtRightTab("findings");
  else if (m === "rooms") setRoomRightTab("findings");
  else setTab("validation");
}

// ---- editor status (GET /api/status) --------------------------------------------------------------
/** Refresh S.status; a failed fetch marks the server unreachable (no toast: this runs on every window focus). */
export async function loadStatus(): Promise<void> {
  try {
    const r = await fetch(url("/api/status", { mod: S.get().mod }));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    S.set({ status: (await r.json()) as EditorStatus, serverOk: true });
  } catch {
    S.set({ serverOk: false });
  }
}

/** The Launch… popover's command line (run from the repo root). */
export function launchCommand(mod: string): string {
  return mod ? `launch-dev.bat mods\\${mod}` : "launch-dev.bat";
}
/** Copy the launch command (Clipboard API; falls back to selecting `input` + execCommand). */
export async function copyLaunchCommand(text: string, input: HTMLInputElement | null): Promise<void> {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    if (input) {
      input.focus();
      input.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
    }
  }
  if (ok) toast(`copied: ${text}`, { kind: "ok", ms: 4000 });
  else toast("could not copy — select the command and copy it by hand", { kind: "error" });
}
// Base-data listing, one BASE_PAGE at a time: a category with an empty filter can list thousands of entries,
// so the explorer shows the first page and "Show 300 more" appends the next (applyBasePage folds them in).
let baseSeq = 0;
async function loadBasePage(category: string, offset: number): Promise<void> {
  const seq = offset === 0 ? ++baseSeq : baseSeq;
  const r = await getJson<ListEntriesResult>(url("/api/base", { category, filter: baseFilter, offset, limit: BASE_PAGE }));
  // a newer category / filter answered first: drop this reply
  if (seq !== baseSeq || S.get().baseCategory !== category) return;
  const entries = r.entries || [];
  const s = S.get();
  const next = applyBasePage({ entries: s.baseEntries, total: s.baseEntriesTotal }, { entries, total: typeof r.total === "number" ? r.total : entries.length, offset: typeof r.offset === "number" ? r.offset : offset });
  S.set({ baseEntries: next.entries, baseEntriesTotal: next.total });
}
export async function selectCategory(category: string): Promise<void> {
  S.set({ baseCategory: category });
  await loadBasePage(category, 0);
}
/** The explorer's "Show 300 more": append the selected category's next page. */
export async function showMoreBase(): Promise<void> {
  const s = S.get();
  if (!s.baseCategory || s.baseEntries.length >= s.baseEntriesTotal) return;
  await loadBasePage(s.baseCategory, s.baseEntries.length);
}
/** The hero's "Browse base data": open the first category when none is, then put the cursor in the filter. */
export async function browseBaseData(): Promise<void> {
  const { baseCategory, baseCats } = S.get();
  if (!baseCategory && baseCats.length) await selectCategory(baseCats[0]!.category);
  if (typeof document === "undefined") return;
  const input = document.querySelector<HTMLInputElement>(".explorer .search input");
  input?.focus();
  document.querySelector(".explorer .srow.sel")?.scrollIntoView({ block: "nearest" });
}
export function closeBaseDrawer(): void {
  S.set({ baseDrawer: false });
}
export function closeComponentsDrawer(): void {
  S.set({ compDrawer: false });
}
export async function viewBaseEntry(name: string): Promise<void> {
  const r = await getJson<BaseEntryView>(url("/api/base-entry", { category: S.get().baseCategory, name }));
  S.set({ baseView: r, baseDrawer: true });
}
export async function searchComponents(query: string): Promise<void> {
  if (!query) {
    S.set({ components: null });
    return;
  }
  S.set({ components: await getJson<ComponentSearchResult>(url("/api/components", { query, whereUsed: 1, limit: 40 })) });
}
let compSearchTimer: ReturnType<typeof setTimeout> | undefined;
/** Debounce the component search so typing doesn't fire a fetch per keystroke. */
export function scheduleComponentSearch(query: string): void {
  if (compSearchTimer) clearTimeout(compSearchTimer);
  compSearchTimer = setTimeout(() => searchComponents(query), 200);
}

// base-data entry filter (kept outside the store; drives selectCategory)
let baseFilter = "";
let baseFilterTimer: ReturnType<typeof setTimeout> | undefined;
/** Debounce the base-data filter so each keystroke doesn't fire a fetch + list rebuild. */
export function setBaseFilter(value: string): void {
  baseFilter = value;
  if (baseFilterTimer) clearTimeout(baseFilterTimer);
  baseFilterTimer = setTimeout(() => {
    const cat = S.get().baseCategory;
    if (cat) void selectCategory(cat);
  }, 200);
}

// ---- small helpers ------------------------------------------------------------------------
export type CurrentFile = Pick<ModFileInfo, "relPath" | "mode" | "fileType">;
/** Info for the currently open overlay file (from the mod's file list, or inferred from the name). */
export function currentFile(file: string, files: ModFileInfo[]): CurrentFile | null {
  if (!file) return null;
  const found = files.find((f) => f.relPath === file);
  if (found) return found;
  const leaf = file.split("/").pop() || file;
  const m = /\.(append|merge|patch|replace)$/.exec(leaf);
  const fileType: FileType = leaf.includes(".csv") ? "csv" : leaf.includes(".gon") ? "gon" : "other";
  return { relPath: file, mode: (m ? m[1] : "replace") as OverlayMode, fileType };
}
const MODE_NAMES: Record<string, string> = { append: "Append", merge: "Merge", patch: "Patch", replace: "Replace" };
export function modeChipLabel(mode: string): string {
  return `.${mode} → ${MODE_NAMES[mode] || mode}`;
}
export function modeNote(mode: string): string {
  if (mode === "append") return ".append → Append (later paths override)";
  if (mode === "merge") return ".merge → deep-merge onto base";
  if (mode === "patch") return ".patch → per-field policy";
  return ".replace → full replace";
}
export function fileTypeLabel(ft: string): string {
  return ft === "gon" ? "GON" : ft === "csv" ? "CSV" : ft === "txt" ? "TXT" : "TEXT";
}

export function setTab(tab: Tab): void {
  S.set({ tab });
}
/** Data mode's components tab, or (no mod open) the components drawer. */
export function openComponents(): void {
  if (S.get().mod) S.set({ tab: "components" });
  else S.set({ compDrawer: true });
}
export function toggleMenu(menu: OpenMenu): void {
  S.set({ openMenu: S.get().openMenu === menu ? "" : menu });
}
export function closeMenu(): void {
  if (S.get().openMenu) S.set({ openMenu: "" });
}

// ---- onboarding (the three tours, the worked examples, the concepts drawer; UX PR 6) ----------------------
/** Open the Data tour at step 0 (Help menu, the Data hero). */
export function openTour(): void {
  S.set({ tourStep: 0, openMenu: "", tourOpen: true });
}
/** Move a tour to step `n`. */
export function setTourStep(kind: TourKind, n: number): void {
  if (kind === "data") S.set({ tourStep: n });
  else if (kind === "art") S.set({ artTourStep: n });
  else S.set({ roomTourStep: n });
}
/**
 * The tour card's "Don't show again": remembered at once (not only on close), so the empty states' "Take the … tour"
 * nudges hide too. Unticking forgets it.
 */
export function setTourDontShow(kind: TourKind, on: boolean): void {
  if (kind === "data") S.set({ tourDontShow: on });
  else if (kind === "art") S.set({ artTourDontShow: on });
  else S.set({ roomTourDontShow: on });
  if (on) lsSet(TOUR_KEYS[kind].dontShow, "1");
  else lsRemove(TOUR_KEYS[kind].dontShow);
}
/** Close a tour (Skip / Done / Esc): it is then seen and no longer auto-opens. */
function closeTourOf(kind: TourKind): void {
  if (kind === "data") S.set({ tourOpen: false });
  else if (kind === "art") S.set({ artTourOpen: false });
  else S.set({ roomTourOpen: false });
  lsSet(TOUR_KEYS[kind].seen, "1");
}
export function closeTour(): void {
  closeTourOf("data");
}
export function closeArtTour(): void {
  closeTourOf("art");
}
export function closeRoomTour(): void {
  closeTourOf("rooms");
}
function tourDismissed(kind: TourKind): boolean {
  return lsGet(TOUR_KEYS[kind].dontShow) === "1" || lsGet(TOUR_KEYS[kind].seen) === "1";
}
// The Art / Rooms tour opens automatically the first time the user enters that mode (unless seen or dismissed),
// and is re-openable from the Help (?) menu and the mode's empty state.
function maybeOpenArtTour(): void {
  if (onboarding.artTourTriggered) return;
  onboarding.artTourTriggered = true;
  if (!tourDismissed("art")) S.set({ artTourStep: 0, artTourOpen: true });
}
function maybeOpenRoomTour(): void {
  if (onboarding.roomTourTriggered) return;
  onboarding.roomTourTriggered = true;
  if (!tourDismissed("rooms")) S.set({ roomTourStep: 0, roomTourOpen: true });
}
export function enterArtMode(): void {
  S.set({ artMode: true, roomMode: false });
  maybeOpenArtTour();
}
export function leaveArtMode(): void {
  S.set({ artMode: false, roomMode: false });
}
/** Rooms mode: the Room editor (levels/**.lvl grid painter). */
export function enterRoomMode(): void {
  S.set({ roomMode: true, artMode: false });
  maybeOpenRoomTour();
}
/** Put the editor in mode `m` when it is not there already (a tour step that points into another mode). */
export function ensureMode(m: Mode): void {
  if (currentMode() === m) return;
  if (m === "art") enterArtMode();
  else if (m === "rooms") enterRoomMode();
  else leaveArtMode();
}
/** Help ▸ Worked example — Joker's Luck: opens at step 1. */
export function openExample(): void {
  S.set({ openMenu: "", exampleStep: 0, exampleOpen: true });
}
export function setExampleStep(n: number): void {
  S.set({ exampleStep: n });
}
export function openArtExample(): void {
  S.set({ artExampleStep: 0, openMenu: "", artExampleOpen: true });
}
export function setArtExampleStep(n: number): void {
  S.set({ artExampleStep: n });
}
export function closeExample(): void {
  S.set({ exampleOpen: false });
}
export function closeArtExample(): void {
  S.set({ artExampleOpen: false });
}
/** Open a top-bar menu after the current click has finished bubbling (the window click listener closes menus). */
function openMenuSoon(menu: OpenMenu): void {
  setTimeout(() => S.set({ openMenu: menu }), 0);
}
/**
 * Close the art example and land the user in the live Art UI (already onboarding → no auto-tour), then run `go`.
 * With `needsMod` and no mod open, it opens the mod switcher instead and says so.
 */
export function artExampleGoto(go: () => void, needsMod = true): void {
  S.set({ artExampleOpen: false, artMode: true, roomMode: false });
  onboarding.artTourTriggered = true;
  if (needsMod && !S.get().mod) {
    toast("pick a mod first — the mod switcher is open", { ms: 5000 });
    openMenuSoon("mod");
    return;
  }
  go();
}
/** Focus the first element matching `selector` once it renders (a jump that switches a tab first). */
export function focusWhenShown(selector: string, frames = 30): void {
  if (typeof document === "undefined") return;
  const tick = (left: number) => {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) {
      el.scrollIntoView({ block: "nearest" });
      el.focus({ preventScroll: true });
    } else if (left > 0) requestAnimationFrame(() => tick(left - 1));
  };
  requestAnimationFrame(() => tick(frames));
}
/** Open the concepts drawer, scrolled to `section` ("" = the top; Help ▸ Rooms concepts passes "rooms"). */
export function openConcepts(section: ConceptsSection = ""): void {
  S.set({ openMenu: "", conceptsOpen: true, conceptsSection: section });
}
export function closeConcepts(): void {
  S.set({ conceptsOpen: false, conceptsSection: "" });
}
/** Open the Launch… popover (the Data example's last step). */
export function openLaunchMenu(): void {
  openMenuSoon("launch");
}

export interface TemplatePrefill {
  /** "mod": the mod menu's New mod (title "New mod"); default "overlay" ("Scaffold an overlay") */
  intent?: TemplateIntent;
  mod?: string;
  kind?: TemplateKindName;
  name?: string;
  display?: string;
  desc?: string;
  parent?: string;
  status?: string;
}
export function openTemplate(p?: TemplatePrefill): void {
  const d = p || {};
  tpl.set({
    intent: d.intent || "overlay",
    mod: d.mod !== undefined ? d.mod : S.get().mod,
    kind: d.kind || "ability",
    name: d.name || "",
    display: d.display || "",
    desc: d.desc || "",
    parent: d.parent || "Spin",
    status: d.status || "",
    colour: "",
    result: null,
  });
  S.set({ openMenu: "", templateOpen: true });
}
export function closeTemplate(): void {
  S.set({ templateOpen: false });
}
/** The kind dropdown: a tileset variant copies a tileset (default alley), an ability varies an ability (Spin). */
export function setTemplateKind(kind: TemplateKindName): void {
  const t = tpl.get();
  const parent = kind === "tileset-variant" ? (t.parent === "Spin" || !t.parent ? "alley" : t.parent) : t.kind === "tileset-variant" && t.parent === "alley" ? "Spin" : t.parent;
  tpl.set({ kind, parent, result: null });
}
/** The options POST /api/template gets for the form's kind (only the knobs that kind reads). */
export function templateOptions(t: Pick<TemplateForm, "kind" | "display" | "desc" | "parent" | "status" | "colour">): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (t.display) o.displayName = t.display;
  if (t.desc) o.desc = t.desc;
  if ((t.kind === "ability" || t.kind === "tileset-variant") && t.parent) o.parent = t.parent;
  if (t.kind === "ability" && t.status) o.statusEffect = t.status;
  if (t.kind === "glowing-character" && t.colour) o.colour = t.colour;
  return o;
}
/** A written path of a scaffold result ("mods/<mod>/<rel>") → the path inside the mod (null when it is not one). */
export function scaffoldRelPath(mod: string, written: string): string | null {
  const prefix = `mods/${mod}/`;
  return written.startsWith(prefix) ? written.slice(prefix.length) : null;
}
/** A scaffold result's Open: open that file of the scaffolded mod (a .lvl opens in Rooms mode) and close the modal. */
export async function openScaffolded(written: string, opts: { validate?: boolean } = {}): Promise<void> {
  const mod = tpl.get().mod;
  const rel = scaffoldRelPath(mod, written);
  if (!rel) return;
  if (S.get().mod !== mod) {
    if (!(await guard(ALL_SCOPES, `Opening mods/${mod}`))) return;
    await selectMod(mod);
  }
  closeTemplate();
  if (!/\.lvl$/i.test(rel)) leaveArtMode();
  await openFile(rel);
  if (opts.validate) await validateCurrent();
}

/** The Scaffold button (or Enter) of the template modal. */
export async function scaffold(): Promise<void> {
  const t = tpl.get();
  if (!t.mod) {
    tpl.set({ result: { ok: false, error: "enter a mod name first" } });
    return;
  }
  const options = templateOptions(t);
  const res = await post<"/api/template", TemplateResult>("/api/template", { mod: t.mod, kind: t.kind, name: t.name, options });
  tpl.set({ result: res });
  if (res && res.ok) {
    toast(`scaffolded ${t.name} in mods/${t.mod}`, { kind: "ok", ms: 4000 });
    await loadMods();
    if (t.mod === S.get().mod) {
      // the open mod: re-list its files, scenes and rooms; whatever is open (and unsaved) stays open
      await refreshModFiles(t.mod);
      await refreshArtListings(t.mod);
      await refreshLevels(t.mod);
    } else if (await guard(ALL_SCOPES, `Opening mods/${t.mod}`)) await selectMod(t.mod);
  }
}

/** Keep ?mode=&mod=&file= in the address bar in step with the store (replaceState: no history entry, no reload). */
function syncDeepLink(): void {
  if (typeof location === "undefined" || typeof history === "undefined") return;
  let last = location.search;
  S.subscribe(() => {
    const s = S.get();
    const next = writeDeepLink(location.search, { mode: currentMode(), mod: s.mod, file: s.file });
    if (next === last) return;
    last = next;
    history.replaceState(history.state, "", `${location.pathname}${next}${location.hash}`);
  });
}

/** App startup (was the tail of app.mjs after mounting). */
let started = false;
export function startup(): void {
  // once per page: StrictMode (dev) mounts App's effect twice
  if (started) return;
  started = true;
  editorCtl.repaintNow();
  // Deep link: ?mode=data|art|rooms&mod=<name>&file=<relPath> (deeplink.ts)
  const link = readDeepLink(typeof location !== "undefined" ? location.search : "");
  void loadMods(link.mod).then(() => {
    if (link.file && link.mod && S.get().mod === link.mod && !S.get().file) return openFile(link.file);
  });
  void loadBaseCats();
  void loadCompTotal();
  // the tours' "Don't show again" (it also hides the empty states' tour nudges) and ?tour=center (no spotlight)
  S.set({ tourDontShow: lsGet(TOUR_KEYS.data.dontShow) === "1", artTourDontShow: lsGet(TOUR_KEYS.art.dontShow) === "1", roomTourDontShow: lsGet(TOUR_KEYS.rooms.dontShow) === "1" });
  onboarding.tourCentered = typeof location !== "undefined" && new URLSearchParams(location.search).get("tour") === "center";
  // First-run guided tour (shows once unless seen or dismissed with "Don't show again").
  if (!tourDismissed("data")) S.set({ tourOpen: true });
  // ?mode=art opens straight into Art mode (skips the tours, e.g. for demos/screenshots). Both onboarding tours
  // stay reachable from the Help (?) menu.
  if (link.mode === "art") {
    S.set({ artMode: true, tourOpen: false });
    onboarding.artTourTriggered = true; // don't auto-pop the art tour over a deep-linked session
  }
  // ?mode=rooms opens straight into the Room editor (no tour over it; the Rooms tour stays in the Help menu)
  if (link.mode === "rooms") {
    S.set({ roomMode: true, tourOpen: false });
    onboarding.roomTourTriggered = true;
  }
  syncDeepLink();
}

// ---- shipping a mod: Export… / Import mod… (docs/data-mods.md "Shipping a mod") ----------
interface PackReply {
  ok: boolean;
  refused?: { code: string; message: string };
  zipName?: string;
  zipPath?: string;
  bytes?: number;
  forced?: boolean;
}
type InstallReply =
  | { ok: true; verdict: "installed"; name: string; version: string; notes: string[] }
  | { ok: false; verdict: "refused"; code: string; reason: string }
  | { ok: false; verdict: "build-mismatch"; prompt: string };

/** Pack the open mod into editor/data/dist/ and download the zip. Offers init (no mod.json) and force (errors). */
export async function exportMod(): Promise<void> {
  const mod = S.get().mod;
  if (!mod) return;
  S.set({ openMenu: "" });
  let r = await post<"/api/mod/pack", PackReply>("/api/mod/pack", { mod });
  if (!r.ok && r.refused?.code === "manifest-missing" && window.confirm(`mods/${mod} has no mod.json (name, version, author, gameBuild…). Draft one from description.json and pack?`)) {
    r = await post<"/api/mod/pack", PackReply>("/api/mod/pack", { mod, init: true });
  }
  if (!r.ok && (r.refused?.code === "validation-errors" || r.refused?.code === "swf-build-failed" || r.refused?.code === "native-dll-missing") && window.confirm(`${r.refused.message}\n\nPack anyway?`)) {
    r = await post<"/api/mod/pack", PackReply>("/api/mod/pack", { mod, force: true });
  }
  if (!r.ok || !r.zipName) {
    toast(`export refused (${r.refused?.code ?? "error"}): ${r.refused?.message ?? ""}`, { kind: "error", ms: 8000 });
    return;
  }
  toast(`exported ${r.zipPath} (${r.bytes} bytes)${r.forced ? " — forced" : ""}`, { kind: "ok", ms: 8000 });
  const a = document.createElement("a");
  a.href = url("/api/dist", { file: r.zipName });
  a.download = r.zipName;
  a.click();
}

/** Install a mod zip the user picked into mods/<name>/; a build mismatch asks before installing. */
export async function importModFile(file: File): Promise<void> {
  S.set({ openMenu: "" });
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const base64 = btoa(bin);
  let r = await post<"/api/mod/install", InstallReply>("/api/mod/install", { base64, fileName: file.name });
  if (!r.ok && r.verdict === "build-mismatch") {
    if (!window.confirm(r.prompt)) { toast("import cancelled", { ms: 4000 }); return; }
    r = await post<"/api/mod/install", InstallReply>("/api/mod/install", { base64, fileName: file.name, acceptBuildMismatch: true });
  }
  if (r.ok) {
    toast(`installed ${r.name} ${r.version} into mods/${r.name}${r.notes.length ? ` — ${r.notes.join("; ")}` : ""}`, { kind: "ok", ms: 8000 });
    await loadMods();
    if (await guard(ALL_SCOPES, `Opening mods/${r.name}`)) await selectMod(r.name);
  } else if (r.verdict === "refused") toast(`import refused (${r.code}): ${r.reason}`, { kind: "error", ms: 8000 });
}
