// Data-mode actions (were the module-level functions of app.mjs): plain functions that talk
// to the /api bridge and write into the app store. Components call these; nothing here
// renders. Art-mode actions live in ./art/art-state.ts.

import { S, tpl, lsGet, lsSet, onboarding, type OpenMenu, type Tab } from "./state.ts";
import { getJson, post, url } from "./api.ts";
import { editorCtl } from "./components/Editor.tsx";
import { loadArtForMod } from "./art/art-state.ts";
import { loadRoomsForMod, openLevel } from "./rooms/room-state.ts";
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
} from "./types.ts";

/** Show a status message and clear it after `ms` (app.mjs set S.message + a bare setTimeout). */
export function flash(message: string, ms: number): void {
  S.set({ message });
  setTimeout(() => S.set({ message: "" }), ms);
}

// ---- live validation / preview (debounced) ----------------------------------------------
let liveTimer: ReturnType<typeof setTimeout> | undefined;
export function scheduleLive(): void {
  if (liveTimer) clearTimeout(liveTimer);
  liveTimer = setTimeout(runLive, 350);
}
export async function runLive(): Promise<void> {
  const { mod, file } = S.get();
  if (!mod || !file) return;
  const text = editorCtl.getValue();
  S.set({ report: await post<"/api/validate", Report>("/api/validate", { mod, path: file, text }) });
  S.set({ preview: await post<"/api/preview", PreviewResult>("/api/preview", { mod, path: file, text }) });
}

// ---- actions ------------------------------------------------------------------------------
export async function loadMods(): Promise<void> {
  const r = await getJson<ListModsResult>("/api/mods");
  const mods = r.mods || [];
  S.set({ mods });
  if (!S.get().mod && mods.length) await selectMod(mods[0]!);
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
export async function selectMod(name: string): Promise<void> {
  S.set({ mod: name, file: "", report: null, preview: null });
  const r = await getJson<ReadModResult>(url("/api/mod", { mod: name }));
  const files = r.ok ? r.files : [];
  S.set({ files: files.filter((f) => f.relPath !== "description.json" && f.relPath !== "mod.json") });
  await loadArtForMod(name);
  await loadRoomsForMod(name);
}
export async function openFile(relPath: string): Promise<void> {
  // a level file is binary: it opens in the Room editor, not the text editor
  if (/.lvl$/i.test(relPath)) {
    enterRoomMode();
    await openLevel(relPath);
    return;
  }
  S.set({ file: relPath });
  const r = await getJson<ReadFileResult>(url("/api/mod-file", { mod: S.get().mod, path: relPath }));
  editorCtl.setValue(r.ok ? r.text : `// ${r.error || "could not read file"}`);
  S.set({ saved: true });
  editorCtl.resetScroll();
  editorCtl.repaintNow();
  await runLive();
}
export function closeFile(): void {
  S.set({ file: "", report: null, preview: null });
}
export async function save(): Promise<void> {
  const { mod, file } = S.get();
  if (!mod || !file) return;
  const r = await post<"/api/write", WriteResult>("/api/write", { mod, path: file, content: editorCtl.getValue() });
  if (r.ok) {
    S.set({ saved: true, message: `saved ${r.path} (${r.bytes} bytes)` });
    await selectMod(mod);
    S.set({ file: r.path.split("/").slice(2).join("/") });
  } else {
    S.set({ message: `write refused: ${r.error}` });
  }
  setTimeout(() => S.set({ message: "" }), 4000);
}
export async function selectCategory(category: string): Promise<void> {
  S.set({ baseCategory: category });
  const r = await getJson<ListEntriesResult>(url("/api/base", { category, filter: baseFilter }));
  const all = r.entries || [];
  // Cap the DOM: a category with an empty filter can list thousands of entries.
  // Show the first BASE_ENTRY_CAP and tell the user to refine the search for the rest.
  S.set({ baseEntriesTotal: all.length, baseEntries: all.slice(0, BASE_ENTRY_CAP) });
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
export const BASE_ENTRY_CAP = 300;
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
export function toggleMenu(menu: OpenMenu): void {
  S.set({ openMenu: S.get().openMenu === menu ? "" : menu });
}
export function closeMenu(): void {
  if (S.get().openMenu) S.set({ openMenu: "" });
}

// ---- onboarding -----------------------------------------------------------------------------
export function openTour(): void {
  S.set({ tourStep: 0, openMenu: "", tourOpen: true });
}
export function closeTour(): void {
  S.set({ tourOpen: false });
  lsSet("mewged.onboard.tourSeen", "1");
  if (S.get().tourDontShow) lsSet("mewged.onboard.tourDontShow", "1");
}
export function closeArtTour(): void {
  S.set({ artTourOpen: false });
  lsSet("mewged.onboard.artTourSeen", "1");
  if (S.get().artTourDontShow) lsSet("mewged.onboard.artTourDontShow", "1");
}
// Opened automatically the first time the user enters Art mode (unless dismissed), and
// re-openable from the Help (?) menu — mirrors the data-mode tour exactly.
function maybeOpenArtTour(): void {
  if (onboarding.artTourTriggered) return;
  onboarding.artTourTriggered = true;
  if (lsGet("mewged.onboard.artTourDontShow") !== "1" && lsGet("mewged.onboard.artTourSeen") !== "1") {
    S.set({ artTourStep: 0, artTourOpen: true });
  }
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
}
export function openExample(): void {
  S.set({ openMenu: "", exampleStep: 2, exampleOpen: true });
}
export function openArtExample(): void {
  S.set({ artExampleStep: 0, openMenu: "", artExampleOpen: true });
}
/** Close the art example and land the user in the live Art UI (already onboarding → no auto-tour). */
export function artExampleGoto(go: () => void): void {
  S.set({ artExampleOpen: false, artMode: true });
  onboarding.artTourTriggered = true;
  go();
}
export function openConcepts(): void {
  S.set({ openMenu: "", conceptsOpen: true });
}

export interface TemplatePrefill {
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
    mod: d.mod !== undefined ? d.mod : S.get().mod,
    kind: d.kind || "ability",
    name: d.name || "",
    display: d.display || "",
    desc: d.desc || "",
    parent: d.parent || "Spin",
    status: d.status || "",
    result: null,
  });
  S.set({ openMenu: "", templateOpen: true });
}

/** The Scaffold button of the template modal. */
export async function scaffold(): Promise<void> {
  const t = tpl.get();
  if (!t.mod) {
    tpl.set({ result: { ok: false, error: "enter a mod name first" } });
    return;
  }
  const options = { displayName: t.display, desc: t.desc, parent: t.parent, statusEffect: t.status || undefined };
  const res = await post<"/api/template", TemplateResult>("/api/template", { mod: t.mod, kind: t.kind, name: t.name, options });
  tpl.set({ result: res });
  if (res && res.ok) {
    flash(`scaffolded ${t.name} in mods/${t.mod}`, 4000);
    await loadMods();
    await selectMod(t.mod);
  }
}

/** App startup (was the tail of app.mjs after mounting). */
export function startup(): void {
  editorCtl.repaintNow();
  void loadMods();
  void loadBaseCats();
  void loadCompTotal();
  // First-run guided tour (shows once unless dismissed with "don't show again").
  if (lsGet("mewged.onboard.tourDontShow") !== "1" && lsGet("mewged.onboard.tourSeen") !== "1") {
    S.set({ tourOpen: true });
  }
  // Deep link: http://127.0.0.1:4173/?mode=art opens straight into Art mode (skips the tours,
  // e.g. for demos/screenshots). Both onboarding tours stay reachable from the Help (?) menu.
  if (typeof location !== "undefined" && new URLSearchParams(location.search).get("mode") === "art") {
    S.set({ artMode: true, tourOpen: false });
    onboarding.artTourTriggered = true; // don't auto-pop the art tour over a deep-linked session
  }
  // ?mode=rooms opens straight into the Room editor (no tour over it)
  if (typeof location !== "undefined" && new URLSearchParams(location.search).get("mode") === "rooms") {
    S.set({ roomMode: true, tourOpen: false });
  }
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
    flash(`export refused (${r.refused?.code ?? "error"}): ${r.refused?.message ?? ""}`, 8000);
    return;
  }
  flash(`exported ${r.zipPath} (${r.bytes} bytes)${r.forced ? " — forced" : ""}`, 8000);
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
    if (!window.confirm(r.prompt)) { flash("import cancelled", 4000); return; }
    r = await post<"/api/mod/install", InstallReply>("/api/mod/install", { base64, fileName: file.name, acceptBuildMismatch: true });
  }
  if (r.ok) {
    flash(`installed ${r.name} ${r.version} into mods/${r.name}${r.notes.length ? ` — ${r.notes.join("; ")}` : ""}`, 8000);
    await loadMods();
    await selectMod(r.name);
  } else if (r.verdict === "refused") flash(`import refused (${r.code}): ${r.reason}`, 8000);
}
