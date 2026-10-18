// Mewgenics mod editor — browser UI (VanJS, vendored, no build step).
// Talks to the local server's /api bridge, which routes to the shared core.
// The visual design (3-pane IDE + onboarding) is ported from the approved
// artboards; every /api call and behavior of the prior UI is preserved.

import van from "./vendor/van-1.6.1.min.js";
import { artMode, initArtUi, loadArtForMod, ArtExplorer, ArtCenter, ArtRightPanel, openNewSceneModal, setArtSubtab, setArtRightTab } from "./art-ui.mjs";

const {
  div, span, button, select, option, textarea, input, pre, h1, h2, h3,
  p, label, a, small, strong, b, br,
} = van.tags;

// ---- tiny fetch helpers -----------------------------------------------------
/** @param {string} url */
async function getJson(url) {
  const r = await fetch(url);
  return r.json();
}
/** @param {string} url @param {any} body */
async function postJson(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

// ---- localStorage helpers (per-viewer onboarding memory; always guarded) ----
/** @param {string} k @returns {string|null} */
function lsGet(k) {
  try {
    return window.localStorage.getItem(k);
  } catch {
    return null;
  }
}
/** @param {string} k @param {string} v */
function lsSet(k, v) {
  try {
    window.localStorage.setItem(k, v);
  } catch {
    /* private mode / blocked storage — onboarding still works, just not remembered */
  }
}

// ---- state ------------------------------------------------------------------
const S = {
  mods: van.state(/** @type {string[]} */ ([])),
  mod: van.state(""),
  files: van.state(/** @type {any[]} */ ([])),
  file: van.state(""),
  saved: van.state(true),
  report: van.state(/** @type {any} */ (null)),
  preview: van.state(/** @type {any} */ (null)),
  tab: van.state("validation"),
  baseCats: van.state(/** @type {any[]} */ ([])),
  baseCategory: van.state(""),
  baseEntries: van.state(/** @type {string[]} */ ([])),
  baseEntriesTotal: van.state(0),
  baseView: van.state(/** @type {any} */ (null)),
  components: van.state(/** @type {any} */ (null)),
  compTotal: van.state(0),
  message: van.state(""),
  docBytes: van.state(0),
  docLines: van.state(1),
  openMenu: van.state(""), // "", "mod", "help"
  // overlays
  templateOpen: van.state(false),
  conceptsOpen: van.state(false),
  baseDrawer: van.state(false),
  compDrawer: van.state(false),
  tourOpen: van.state(false),
  tourStep: van.state(0),
  tourDontShow: van.state(false),
  exampleOpen: van.state(false),
  exampleStep: van.state(2),
  // Art-mode onboarding (same components/keys/pattern as the data-mode tour above)
  artTourOpen: van.state(false),
  artTourStep: van.state(0),
  artTourDontShow: van.state(false),
  artExampleOpen: van.state(false),
  artExampleStep: van.state(0),
};

// template-scaffolder fields (module-level so onboarding can prefill them)
const tpl = {
  mod: van.state(""),
  kind: van.state("ability"),
  name: van.state(""),
  display: van.state(""),
  desc: van.state(""),
  parent: van.state("Spin"),
  status: van.state(""),
  result: van.state(/** @type {any} */ (null)),
};

// ---- GON syntax highlighting ------------------------------------------------
/** @param {string} s */
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
const GON_KW = new Set(["variant_of", "true", "false", "null"]);
/**
 * Lexical GON highlighter. Produces HTML with <span> classes matching the
 * design palette. Capitalized identifiers read as class/status refs (orange),
 * keywords blue, strings green, numbers purple, comments muted, punctuation.
 * Always returns the full (escaped) text so nothing is ever hidden if a token
 * class can't be decided.
 * @param {string} text
 * @returns {string}
 */
function highlightGon(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "\n") { out += "\n"; i++; continue; }
    if (c === " " || c === "\t" || c === "\r") { out += c; i++; continue; }
    // line comment
    if (c === "/" && text[i + 1] === "/") {
      let j = i;
      while (j < n && text[j] !== "\n") j++;
      out += `<span class="c">${esc(text.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    // string
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === '"') { j++; break; }
        if (text[j] === "\n") break;
        j++;
      }
      out += `<span class="s">${esc(text.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    // number
    if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(text[i + 1] || ""))) {
      let j = i + 1;
      while (j < n && /[0-9eExXa-fA-F.+_-]/.test(text[j])) j++;
      out += `<span class="n">${esc(text.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    // punctuation
    if (c === "{" || c === "}" || c === "=" || c === ";" || c === "," || c === "[" || c === "]") {
      out += `<span class="p">${esc(c)}</span>`;
      i++;
      continue;
    }
    // identifier
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(text[j])) j++;
      const word = text.slice(i, j);
      let k = "k";
      if (GON_KW.has(word)) k = "kw";
      else if (/^[A-Z]/.test(word)) k = "cls";
      out += `<span class="${k}">${esc(word)}</span>`;
      i = j;
      continue;
    }
    out += esc(c);
    i++;
  }
  return out;
}

/**
 * A read-only highlighted code block.
 * @param {string} text @param {string} [extraClass]
 */
function codeView(text, extraClass) {
  const el = /** @type {HTMLElement} */ (pre({ class: "mergecode hl" + (extraClass ? " " + extraClass : "") }));
  try {
    el.innerHTML = highlightGon(text);
  } catch {
    el.textContent = text;
  }
  return el;
}

// A hidden, zero-footprint placeholder. VanJS reactive child functions must
// return a real node (not null/undefined): a null _dom is dropped by van's
// keepConnected pass, so the binding could never toggle back to an element.
// Returning this (display:none, not a grid/flex item) renders nothing safely.
function hole() {
  return span({ style: "display:none" });
}

// ---- the persistent editor (single element; typing never rebuilds it) -------
// Performance: the highlight overlay and gutter are painted on a single
// requestAnimationFrame (coalescing bursts of keystrokes/scroll into one paint per
// frame), and only the on-screen slice of lines is tokenized. highlightGon() is
// line-local (strings and // comments never cross a newline), so highlighting a
// window of lines is byte-identical to highlighting the whole buffer — which keeps
// a keystroke O(visible lines) instead of O(whole file).
const hlPre = /** @type {HTMLElement} */ (pre({ class: "hl", "aria-hidden": "true" }));
const gutterPre = /** @type {HTMLElement} */ (pre());
const editor = /** @type {HTMLTextAreaElement} */ (
  textarea({
    class: "code",
    spellcheck: false,
    "aria-label": "GON overlay source editor",
    oninput: () => {
      S.saved.val = false;
      editorTextDirty = true;
      scheduleEditorPaint();
      scheduleLive();
    },
    onscroll: () => scheduleEditorPaint(),
  })
);

const EDITOR_BUFFER_LINES = 24; // lines rendered above/below the viewport so small scrolls stay covered
/** @type {string[]} */
let editorLines = [""];
let editorTextDirty = true;
let editorLineH = 0;
let editorRaf = 0;

function editorLineHeight() {
  if (editorLineH > 0) return editorLineH;
  try {
    const cs = getComputedStyle(editor);
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
function recomputeEditorText() {
  const text = editor.value;
  editorLines = text.length ? text.split("\n") : [""];
  S.docLines.val = editorLines.length;
  try {
    S.docBytes.val = new TextEncoder().encode(text).length;
  } catch {
    S.docBytes.val = text.length;
  }
}

// One paint: reads geometry first, then writes DOM (no read-after-write thrash).
function paintEditor() {
  if (editorTextDirty) {
    recomputeEditorText();
    editorTextDirty = false;
  }
  const total = editorLines.length;
  const lh = editorLineHeight();
  const st = editor.scrollTop;
  const sl = editor.scrollLeft;
  const viewH = editor.clientHeight || 1;
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

function scheduleEditorPaint() {
  if (editorRaf) return;
  editorRaf = /** @type {any} */ (requestAnimationFrame(() => {
    editorRaf = 0;
    paintEditor();
  }));
}

// Paint immediately (used when a file is loaded, so the overlay is correct at once).
function repaintEditorNow() {
  editorTextDirty = true;
  if (editorRaf) {
    cancelAnimationFrame(editorRaf);
    editorRaf = 0;
  }
  paintEditor();
}

const editorStack = div(
  { class: "edcode", style: () => (S.file.val ? "" : "display:none") },
  div({ class: "edgutter" }, gutterPre),
  div({ class: "edmain" }, hlPre, editor),
);

// ---- live validation / preview (debounced) ----------------------------------
/** @type {number|undefined} */
let liveTimer;
function scheduleLive() {
  if (liveTimer) clearTimeout(liveTimer);
  liveTimer = /** @type {any} */ (setTimeout(runLive, 350));
}
async function runLive() {
  if (!S.mod.val || !S.file.val) return;
  const text = editor.value;
  S.report.val = await postJson("/api/validate", { mod: S.mod.val, path: S.file.val, text });
  S.preview.val = await postJson("/api/preview", { mod: S.mod.val, path: S.file.val, text });
}

// ---- actions ----------------------------------------------------------------
async function loadMods() {
  const r = await getJson("/api/mods");
  S.mods.val = r.mods || [];
  if (!S.mod.val && S.mods.val.length) await selectMod(S.mods.val[0]);
}
async function loadBaseCats() {
  const r = await getJson("/api/base");
  S.baseCats.val = r.categories || [];
  if (r.categories && r.categories.length) selectCategory(r.categories[0].category);
}
async function loadCompTotal() {
  try {
    const r = await getJson("/api/components?query=&limit=5000");
    if (r && typeof r.count === "number") S.compTotal.val = r.count;
  } catch {
    /* non-fatal */
  }
}
/** @param {string} name */
async function selectMod(name) {
  S.mod.val = name;
  S.file.val = "";
  S.report.val = null;
  S.preview.val = null;
  const r = await getJson(`/api/mod?mod=${encodeURIComponent(name)}`);
  S.files.val = (r.files || []).filter((/** @type {any} */ f) => f.relPath !== "description.json");
  await loadArtForMod(name);
}
/** @param {string} relPath */
async function openFile(relPath) {
  S.file.val = relPath;
  const r = await getJson(`/api/mod-file?mod=${encodeURIComponent(S.mod.val)}&path=${encodeURIComponent(relPath)}`);
  editor.value = r.ok ? r.text : `// ${r.error || "could not read file"}`;
  S.saved.val = true;
  editor.scrollTop = 0;
  editor.scrollLeft = 0;
  repaintEditorNow();
  await runLive();
}
function closeFile() {
  S.file.val = "";
  S.report.val = null;
  S.preview.val = null;
}
async function save() {
  if (!S.mod.val || !S.file.val) return;
  const r = await postJson("/api/write", { mod: S.mod.val, path: S.file.val, content: editor.value });
  if (r.ok) {
    S.saved.val = true;
    S.message.val = `saved ${r.path} (${r.bytes} bytes)`;
    await selectMod(S.mod.val);
    S.file.val = r.path.split("/").slice(2).join("/");
  } else {
    S.message.val = `write refused: ${r.error}`;
  }
  setTimeout(() => (S.message.val = ""), 4000);
}
/** @param {string} category */
async function selectCategory(category) {
  S.baseCategory.val = category;
  const filter = baseFilter;
  const url = filter
    ? `/api/base?category=${encodeURIComponent(category)}&filter=${encodeURIComponent(filter)}`
    : `/api/base?category=${encodeURIComponent(category)}`;
  const r = await getJson(url);
  const all = r.entries || [];
  S.baseEntriesTotal.val = all.length;
  // Cap the DOM: a category with an empty filter can list thousands of entries.
  // Show the first BASE_ENTRY_CAP and tell the user to refine the search for the rest.
  S.baseEntries.val = all.slice(0, BASE_ENTRY_CAP);
}
/** @param {string} name */
async function viewBaseEntry(name) {
  const r = await getJson(
    `/api/base-entry?category=${encodeURIComponent(S.baseCategory.val)}&name=${encodeURIComponent(name)}`,
  );
  S.baseView.val = r;
  S.baseDrawer.val = true;
}
/** @param {string} query */
async function searchComponents(query) {
  if (!query) {
    S.components.val = null;
    return;
  }
  S.components.val = await getJson(`/api/components?query=${encodeURIComponent(query)}&whereUsed=1&limit=40`);
}
/** @type {number|undefined} */
let compSearchTimer;
/** Debounce the component search so typing doesn't fire a fetch per keystroke. @param {string} query */
function scheduleComponentSearch(query) {
  if (compSearchTimer) clearTimeout(compSearchTimer);
  compSearchTimer = /** @type {any} */ (setTimeout(() => searchComponents(query), 200));
}

// base-data entry filter (kept outside van state; drives selectCategory)
let baseFilter = "";
const BASE_ENTRY_CAP = 300;
/** @type {number|undefined} */
let baseFilterTimer;
/** Debounce the base-data filter so each keystroke doesn't fire a fetch + list rebuild. */
function scheduleBaseFilter() {
  if (baseFilterTimer) clearTimeout(baseFilterTimer);
  baseFilterTimer = /** @type {any} */ (setTimeout(() => {
    if (S.baseCategory.val) selectCategory(S.baseCategory.val);
  }, 200));
}

// ---- small helpers ----------------------------------------------------------
/** @returns {any|null} info for the currently open overlay file */
function currentFile() {
  const rel = S.file.val;
  if (!rel) return null;
  const found = S.files.val.find((/** @type {any} */ f) => f.relPath === rel);
  if (found) return found;
  const leaf = rel.split("/").pop() || rel;
  const m = /\.(append|merge|patch|replace)$/.exec(leaf);
  return { relPath: rel, mode: m ? m[1] : "replace", fileType: leaf.includes(".csv") ? "csv" : leaf.includes(".gon") ? "gon" : "other" };
}
/** @param {string} mode */
function modeChipLabel(mode) {
  const names = { append: "Append", merge: "Merge", patch: "Patch", replace: "Replace" };
  return `.${mode} → ${names[/** @type {keyof typeof names} */ (mode)] || mode}`;
}
/** @param {string} mode */
function modeNote(mode) {
  if (mode === "append") return ".append → Append (later paths override)";
  if (mode === "merge") return ".merge → deep-merge onto base";
  if (mode === "patch") return ".patch → per-field policy";
  return ".replace → full replace";
}
/** @param {string} ft */
function fileTypeLabel(ft) {
  return ft === "gon" ? "GON" : ft === "csv" ? "CSV" : ft === "txt" ? "TXT" : "TEXT";
}
function openTour() {
  S.tourStep.val = 0;
  S.openMenu.val = "";
  S.tourOpen.val = true;
}
function closeTour() {
  S.tourOpen.val = false;
  lsSet("mewged.onboard.tourSeen", "1");
  if (S.tourDontShow.val) lsSet("mewged.onboard.tourDontShow", "1");
}
// ---- Art-mode onboarding entry points ---------------------------------------
// Opened automatically the first time the user enters Art mode (unless dismissed),
// and re-openable from the Help (?) menu — mirrors the data-mode tour exactly.
let artTourTriggered = false;
function openArtTour() {
  artTourTriggered = true;
  S.artTourStep.val = 0;
  S.openMenu.val = "";
  S.artTourOpen.val = true;
}
function closeArtTour() {
  S.artTourOpen.val = false;
  lsSet("mewged.onboard.artTourSeen", "1");
  if (S.artTourDontShow.val) lsSet("mewged.onboard.artTourDontShow", "1");
}
function maybeOpenArtTour() {
  if (artTourTriggered) return;
  artTourTriggered = true;
  if (lsGet("mewged.onboard.artTourDontShow") !== "1" && lsGet("mewged.onboard.artTourSeen") !== "1") {
    S.artTourStep.val = 0;
    S.artTourOpen.val = true;
  }
}
function enterArtMode() {
  artMode.val = true;
  maybeOpenArtTour();
}
function openArtExample() {
  S.artExampleStep.val = 0;
  S.openMenu.val = "";
  S.artExampleOpen.val = true;
}
/** @param {{mod?:string,kind?:string,name?:string,display?:string,desc?:string,parent?:string,status?:string}} [p] */
function openTemplate(p) {
  const d = p || {};
  tpl.mod.val = d.mod !== undefined ? d.mod : S.mod.val;
  tpl.kind.val = d.kind || "ability";
  tpl.name.val = d.name || "";
  tpl.display.val = d.display || "";
  tpl.desc.val = d.desc || "";
  tpl.parent.val = d.parent || "Spin";
  tpl.status.val = d.status || "";
  tpl.result.val = null;
  S.openMenu.val = "";
  S.templateOpen.val = true;
}

// ---- build a file tree from the flat relPath list ---------------------------
/**
 * @typedef {{ name:string, path:string, dirs:Map<string,TreeNode>, files:any[] }} TreeNode
 */
/** @param {any[]} files @returns {TreeNode} */
function buildTree(files) {
  /** @type {TreeNode} */
  const root = { name: "", path: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = String(f.relPath).split("/");
    const leaf = parts.pop();
    let node = root;
    let acc = "";
    for (const part of parts) {
      acc = acc ? acc + "/" + part : part;
      let child = node.dirs.get(part);
      if (!child) {
        child = { name: part, path: acc, dirs: new Map(), files: [] };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.push({ ...f, leaf });
  }
  return root;
}
const collapsed = van.state(/** @type {Record<string, boolean>} */ ({}));
/** @param {string} path */
function toggleDir(path) {
  const next = { ...collapsed.val };
  next[path] = !next[path];
  collapsed.val = next;
}
/** @param {TreeNode} node @param {number} depth @returns {any[]} */
function renderTree(node, depth) {
  const rows = [];
  for (const [name, child] of node.dirs) {
    const isCollapsed = !!collapsed.val[child.path];
    rows.push(
      button(
        { class: "srow dir", style: `padding-left:${8 + depth * 14}px`, onclick: () => toggleDir(child.path) },
        span({ class: "caret" }, isCollapsed ? "▸" : "▾"),
        span(name),
      ),
    );
    if (!isCollapsed) rows.push(...renderTree(child, depth + 1));
  }
  for (const f of node.files) {
    rows.push(
      button(
        {
          class: () => "srow" + (S.file.val === f.relPath ? " sel" : ""),
          style: `padding-left:${8 + depth * 14 + 14}px`,
          title: `${f.mode} · ${f.fileType}`,
          onclick: () => openFile(f.relPath),
        },
        span({ class: "fname", style: "flex:1" }, f.leaf),
        f.mode && f.mode !== "replace" ? span({ class: `pill ${f.mode} chip` }, "." + f.mode) : hole(),
      ),
    );
  }
  return rows;
}

// ---- top bar ----------------------------------------------------------------
function TopBar() {
  return div(
    { class: "topbar" },
    div({ class: "brand" }, div({ class: "logo" }), span({ class: "title" }, "Mewgenics Mod Editor")),
    div({ class: "vdiv" }),
    // Data (GON overlays) | Art (scenes → SWF + in-game-faithful preview)
    div(
      { class: "modeswitch", role: "group", "aria-label": "Editor mode" },
      button({ class: () => "btn sm" + (artMode.val ? "" : " on"), "aria-pressed": () => String(!artMode.val), onclick: () => (artMode.val = false) }, "Data"),
      button({ class: () => "btn sm" + (artMode.val ? " on" : ""), "aria-pressed": () => String(artMode.val), onclick: () => enterArtMode() }, "Art"),
    ),
    div({ class: "vdiv" }),
    // mod switcher
    div(
      { class: "dropdown" },
      button(
        {
          class: "btn ghost",
          style: "color:var(--ink2)",
          "aria-haspopup": "menu",
          onclick: (/** @type {MouseEvent} */ e) => {
            e.stopPropagation();
            S.openMenu.val = S.openMenu.val === "mod" ? "" : "mod";
          },
        },
        () => (S.mod.val || "No mod open"),
        span({ style: "color:var(--muted)" }, " ▾"),
      ),
      () =>
        S.openMenu.val === "mod"
          ? div(
              { class: "menu", onclick: (/** @type {MouseEvent} */ e) => e.stopPropagation() },
              div({ class: "label" }, "Switch mod"),
              S.mods.val.length
                ? S.mods.val.map((m) =>
                    button(
                      {
                        class: () => "item" + (m === S.mod.val ? " sel" : ""),
                        onclick: () => {
                          S.openMenu.val = "";
                          selectMod(m);
                        },
                      },
                      m,
                    ),
                  )
                : div({ class: "item", style: "color:var(--muted)" }, "(no mods yet)"),
              div({ class: "sep" }),
              button({ class: "item", onclick: () => openTemplate({ mod: "" }) }, "＋ New mod…"),
            )
          : hole(),
    ),
    div({ class: "grow" }),
    // live status pill
    () => {
      const rep = S.report.val;
      if (!rep || !rep.counts) return span({ class: "pill muted" }, "idle");
      const e = rep.counts.errors | 0;
      const w = rep.counts.warnings | 0;
      const cls = e > 0 ? "err" : w > 0 ? "warn" : "ok";
      return span({ class: `pill ${cls}` }, `● ${e} error${e === 1 ? "" : "s"} · ${w} warning${w === 1 ? "" : "s"}`);
    },
    button({ class: "btn ghost", onclick: () => runLive(), disabled: () => !S.file.val }, "Validate"),
    button({ class: "btn primary", onclick: () => save(), disabled: () => !S.file.val }, "Save"),
    button(
      {
        class: "btn ghost",
        onclick: () => {
          S.message.val =
            "Launch dev is illustrative here — run launch-dev.bat (Mewgenics -modpaths mods/" +
            (S.mod.val || "<mod>") +
            " -savesuffix dev) outside the editor.";
          setTimeout(() => (S.message.val = ""), 6000);
        },
      },
      "Launch dev ▸",
    ),
    div({ class: "vdiv" }),
    // help menu
    div(
      { class: "dropdown" },
      button(
        {
          class: "btn ghost",
          "aria-label": "Help and onboarding",
          onclick: (/** @type {MouseEvent} */ e) => {
            e.stopPropagation();
            S.openMenu.val = S.openMenu.val === "help" ? "" : "help";
          },
        },
        "?",
      ),
      () =>
        S.openMenu.val === "help"
          ? div(
              { class: "menu right", onclick: (/** @type {MouseEvent} */ e) => e.stopPropagation() },
              div({ class: "label" }, "Data mode"),
              button({ class: "item", onclick: () => openTour() }, "✦ Guided tour"),
              button(
                {
                  class: "item",
                  onclick: () => {
                    S.openMenu.val = "";
                    S.exampleStep.val = 2;
                    S.exampleOpen.val = true;
                  },
                },
                "★ Worked example — Joker's Luck",
              ),
              div({ class: "sep" }),
              div({ class: "label" }, "Art mode"),
              button({ class: "item", onclick: () => openArtTour() }, "▲ Art mode tour"),
              button({ class: "item", onclick: () => openArtExample() }, "★ Art worked example"),
              div({ class: "sep" }),
              button(
                {
                  class: "item",
                  onclick: () => {
                    S.openMenu.val = "";
                    S.conceptsOpen.val = true;
                  },
                },
                "✦ Concepts explainer",
              ),
            )
          : hole(),
    ),
  );
}

// ---- explorer ---------------------------------------------------------------
function ModFilesSection() {
  return div(
    div(
      { class: "exhead" },
      span({ class: "sec" }, "Mod files"),
      () =>
        S.mod.val
          ? button({ class: "btn ghost sm", style: "color:var(--acc-ink)", onclick: () => openTemplate({ mod: S.mod.val }) }, "+ New overlay")
          : hole(),
    ),
    () =>
      !S.mod.val
        ? div(
            { class: "dashed" },
            div({ style: "font-size:13px;margin-bottom:12px" }, "No mod open yet."),
            button({ class: "btn primary", style: "width:100%", onclick: () => openTemplate({ mod: "" }) }, "+ New mod"),
          )
        : div(
            { class: "exbody tw" },
            S.files.val.length ? renderTree(buildTree(S.files.val), 0) : div({ class: "srow", style: "color:var(--muted)" }, "(no overlay files)"),
          ),
  );
}

function BaseDataSection() {
  return div(
    div(
      { class: "exhead" },
      span({ class: "sec" }, "Base data"),
      small({ class: "muted" }, "· read-only"),
    ),
    div(
      { class: "search" },
      span({ "aria-hidden": "true" }, "⌕"),
      input({
        placeholder: "Search abilities, items, components…",
        "aria-label": "Filter base-data entries in the selected category",
        oninput: (/** @type {Event} */ e) => {
          baseFilter = /** @type {HTMLInputElement} */ (e.target).value;
          scheduleBaseFilter();
        },
      }),
    ),
    div(
      { class: "exbody" },
      // The category list is built once (depends only on baseCats). Each category's
      // entries live in their own reactive child so that selecting a category or
      // filtering only rebuilds that one category's rows — not every category.
      () =>
        div(
          { class: "tw" },
          ...S.baseCats.val.map((/** @type {any} */ c) =>
            div(
              { class: "tw" },
              button(
                { class: () => "srow" + (c.category === S.baseCategory.val ? " sel" : ""), onclick: () => selectCategory(c.category) },
                span({ style: "flex:1" }, c.category),
                span({ class: "count" }, String(c.count)),
              ),
              () => (S.baseCategory.val === c.category ? BaseEntriesList() : hole()),
            ),
          ),
          button(
            {
              class: "srow acc",
              onclick: () => {
                if (S.mod.val) S.tab.val = "components";
                else S.compDrawer.val = true;
              },
            },
            span({ style: "flex:1" }, "components"),
            () => span({ class: "count" }, S.compTotal.val ? S.compTotal.val.toLocaleString() : "search"),
          ),
        ),
    ),
  );
}

// Entries of the currently-selected base category. Reactive on baseEntries only, so an
// async category/filter result repaints these rows without touching the category list.
function BaseEntriesList() {
  const entries = S.baseEntries.val;
  const total = S.baseEntriesTotal.val;
  if (!entries.length) return div({ class: "entries" }, div({ class: "srow", style: "color:var(--muted)" }, "(no entries)"));
  return div(
    { class: "entries" },
    ...entries.map((n) => button({ class: "srow", style: "padding-left:22px", onclick: () => viewBaseEntry(n) }, span({ class: "fname" }, n))),
    total > entries.length
      ? div({ class: "srow", style: "color:var(--muted);padding-left:22px;font-size:11.5px" }, `showing ${entries.length} of ${total.toLocaleString()} — refine the search`)
      : hole(),
  );
}

function Explorer() {
  return div({ class: "explorer" }, ModFilesSection(), div({ class: "exdiv" }), BaseDataSection());
}
// Explorer / center / right panel swap wholesale between Data and Art mode.
function ExplorerSwitch() {
  return () => (artMode.val ? ArtExplorer() : Explorer());
}
function CenterSwitch() {
  return () => (artMode.val ? ArtCenter() : Center());
}
function RightSwitch() {
  return () => (S.mod.val ? (artMode.val ? ArtRightPanel() : RightPanel()) : hole());
}

// ---- center: editor + empty states ------------------------------------------
function FileTabBar() {
  const f = currentFile();
  const mode = f ? f.mode : "replace";
  const dirs = S.file.val.split("/");
  dirs.pop();
  const crumb = [S.mod.val, ...dirs].filter(Boolean).join(" › ");
  return div(
    { class: "edtabbar" },
    div(
      { class: "filetab" },
      span({ class: "mono", style: "font-size:12.5px" }, S.file.val.split("/").pop() || S.file.val),
      button({ class: "x", "aria-label": "Close file", onclick: () => closeFile() }, "✕"),
    ),
    mode && mode !== "replace" ? span({ class: `pill ${mode}` }, modeChipLabel(mode)) : span({ class: "pill replace" }, modeChipLabel(mode)),
    div({ class: "grow" }),
    span({ class: "breadcrumb" }, crumb),
  );
}

function EditorStatusBar() {
  const f = currentFile();
  const ft = f ? f.fileType : "other";
  return div(
    { class: "edstatus" },
    () => (S.saved.val ? span({ class: "dotok" }, "● Saved") : span({ class: "muted" }, "● Unsaved")),
    () => span({ class: "mono" }, `${S.docBytes.val} bytes`),
    span({ class: "mono" }, "UTF-8"),
    span({ class: "mono" }, fileTypeLabel(ft)),
    div({ class: "grow" }),
    span("Live validation on"),
  );
}

function HeroEmpty() {
  return div(
    { class: "emptycenter" },
    div(
      { style: "max-width:720px;width:100%" },
      div({ style: "width:56px;height:56px;border-radius:14px;background:var(--accbg);display:flex;align-items:center;justify-content:center;font-size:26px;margin-bottom:18px" }, "◆"),
      h1({ style: "margin:0 0 8px;font-size:26px;font-weight:700" }, "Start a mod, or study the base game"),
      p(
        { style: "margin:0 0 26px;font-size:15px;color:var(--ink2);line-height:1.6;max-width:600px" },
        "This editor authors the GON/CSV overlays Mewgenics loads through ",
        span({ class: "mono", style: "color:var(--acc-ink)" }, "-modpaths"),
        ". Everything you write lands in ",
        span({ class: "mono" }, "mods/<name>/"),
        " — your saves are never touched.",
      ),
      div(
        { class: "grid2" },
        HeroCard("＋", "Create your first overlay", "Scaffold an ability, item, passive, or status from a template — localization rows included.", () => openTemplate({ mod: "" })),
        HeroCard("⌕", "Browse base data", "Read the base-game data files and components to see what you can recombine or override.", () => {
          if (!S.baseCategory.val && S.baseCats.val.length) selectCategory(S.baseCats.val[0].category);
        }),
        HeroCard("✦", "Take the guided tour", "A 5-step walkthrough of browse → edit → validate → preview.", () => openTour(), "Start tour →"),
        HeroCard("★", "Rebuild Joker's Luck", "Follow the worked example end to end.", () => { S.exampleStep.val = 2; S.exampleOpen.val = true; }, "Open example →"),
      ),
      div(
        { style: "margin-top:22px;font-size:13px;color:var(--muted)" },
        "New to GON overlays? ",
        a({ onclick: () => (S.conceptsOpen.val = true) }, "Read the concepts explainer →"),
      ),
    ),
  );
}
/** @param {string} icon @param {string} title @param {string} body @param {() => void} onclick @param {string} [link] */
function HeroCard(icon, title, body, onclick, link) {
  return button(
    { class: "card plain", style: "text-align:left;cursor:pointer;border-color:var(--line)", onclick },
    div({ style: "font-size:20px;margin-bottom:10px" }, icon),
    div({ style: "font-weight:700;font-size:15px;margin-bottom:6px;color:var(--ink)" }, title),
    div({ style: "font-size:13px;color:var(--ink2);line-height:1.6" }, body, link ? span({ style: "color:var(--acc-ink)" }, " " + link) : hole()),
  );
}

function FileEmpty() {
  return div(
    { class: "emptycenter" },
    div(
      { style: "text-align:center;max-width:420px" },
      div({ style: "width:52px;height:52px;border-radius:14px;background:var(--accbg);display:flex;align-items:center;justify-content:center;font-size:24px;margin:0 auto 16px" }, "◆"),
      h2({ style: "margin:0 0 8px;font-size:18px;color:var(--ink)" }, "No overlay file open"),
      p({ style: "margin:0 0 18px;color:var(--ink2);line-height:1.6" }, "Pick an overlay from the tree on the left, or scaffold a new one."),
      div(
        { class: "row", style: "display:flex;gap:10px;justify-content:center" },
        button({ class: "btn primary", onclick: () => openTemplate({ mod: S.mod.val }) }, "+ New overlay"),
        button({ class: "btn ghost", onclick: () => (S.conceptsOpen.val = true) }, "How overlays work"),
      ),
    ),
  );
}

function Center() {
  return div(
    { class: "center" },
    () => (S.file.val ? FileTabBar() : hole()),
    div(
      { style: "flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden" },
      editorStack,
      () => (!S.file.val ? (S.mod.val ? FileEmpty() : HeroEmpty()) : hole()),
    ),
    () => (S.file.val ? EditorStatusBar() : hole()),
  );
}

// ---- right panel ------------------------------------------------------------
function RightPanel() {
  const mk = (/** @type {string} */ id, /** @type {string} */ labelText) =>
    button({ class: () => "tab" + (S.tab.val === id ? " active" : ""), onclick: () => (S.tab.val = id) }, labelText);
  return div(
    { class: "rightpanel" },
    div({ class: "tabs" }, mk("validation", "Validation"), mk("preview", "Preview"), mk("components", "Components")),
    div(
      { class: "panelbody" },
      () => {
        const t = S.tab.val;
        if (t === "preview") return PreviewPanel();
        if (t === "components") return ComponentSearch();
        return ValidationPanel();
      },
    ),
  );
}

function ValidationPanel() {
  const rep = S.report.val;
  if (!rep || !rep.counts) return p({ class: "muted" }, "Edit a file to see validation.");
  const e = rep.counts.errors | 0;
  const w = rep.counts.warnings | 0;
  const infos = rep.counts.infos | 0;
  const level = e > 0 ? "err" : w > 0 ? "warn" : "ok";
  const title = e > 0 ? `${e} error${e === 1 ? "" : "s"}` : w > 0 ? `${w} warning${w === 1 ? "" : "s"}` : "Valid overlay";
  return div(
    div(
      { class: `summary ${level}` },
      div({ class: "badge" }, level === "ok" ? "✓" : "!"),
      div(div({ class: "t" }, title), div({ class: "d" }, `${e} errors · ${w} warnings · ${infos} info`)),
    ),
    div(
      { style: "margin-top:14px" },
      rep.findings && rep.findings.length
        ? rep.findings.map((/** @type {any} */ f) =>
            div(
              { class: `finding ${f.severity}` },
              span({ class: "mark" }, f.severity === "error" ? "✕" : f.severity === "warning" ? "!" : "i"),
              div(
                div(span({ class: "code" }, f.code), f.location && f.location.path ? span({ class: "muted" }, `  @ ${f.location.path}`) : hole(), f.location && f.location.line ? span({ class: "muted" }, `  line ${f.location.line}`) : hole()),
                div(f.message),
              ),
            ),
          )
        : p({ class: "dotok", style: "margin:2px 0" }, "No findings — looks good."),
    ),
  );
}

function PreviewPanel() {
  const pv = S.preview.val;
  if (!pv) return p({ class: "muted" }, "Edit a file to see the merge preview.");
  if (!pv.ok) return div({ class: "finding error" }, span({ class: "mark" }, "✕"), div(pv.error || "preview failed"));
  if (pv.kind === "csv") {
    return div(
      p({ class: "muted" }, `CSV ${pv.mode} · base ${pv.baseExists ? "found" : "missing"} · ${pv.note || ""}`),
      pv.addedRows ? codeView(pv.addedRows.map((/** @type {string[]} */ r) => r.join(",")).join("\n")) : hole(),
      pv.changedRows
        ? codeView(pv.changedRows.map((/** @type {any} */ c) => `row ${c.rowIndex}:\n  - ${c.before.join(",")}\n  + ${c.after.join(",")}`).join("\n"))
        : hole(),
    );
  }
  return div(
    div({ class: "sec", style: "margin-bottom:8px" }, "Merge preview"),
    p({ class: "muted" }, `GON ${pv.mode} · base ${pv.baseExists ? "found" : "missing"} · ${pv.effectiveEntryCount} effective entries`),
    ...pv.touched.map((/** @type {any} */ t) =>
      div(
        { class: "card" },
        div({ style: "display:flex;align-items:center;gap:8px;margin-bottom:8px" }, span({ class: "mono", style: "color:var(--ink)" }, t.key), span({ class: `pill ${t.status === "added" ? "ok" : t.status === "changed" ? "warn" : "muted"} chip` }, t.status === "added" ? "+ added" : t.status)),
        div({ class: "cols" }, div(div({ class: "sec", style: "margin-bottom:4px" }, "base"), codeView(t.base || "(absent)")), div(div({ class: "sec", style: "margin-bottom:4px" }, "effective"), codeView(t.effective || "(removed)"))),
      ),
    ),
  );
}

function ComponentSearch() {
  return div(
    div(
      { class: "search", style: "margin:0 0 10px" },
      span({ "aria-hidden": "true" }, "⌕"),
      input({
        placeholder: "search glaiel:: class names…",
        "aria-label": "Search C++ component class names",
        oninput: (/** @type {Event} */ e) => scheduleComponentSearch(/** @type {HTMLInputElement} */ (e.target).value.trim()),
      }),
    ),
    () =>
      S.components.val
        ? div(
            small({ class: "muted" }, `${S.components.val.count} match`),
            div(
              { class: "complist" },
              (S.components.val.names || []).map((/** @type {string} */ n) => button({ class: "ci", onclick: () => searchComponents(n) }, n)),
            ),
          )
        : p({ class: "muted" }, "Search the 2,000+ behavior component names the native layer exposes."),
  );
}

// ---- status bar -------------------------------------------------------------
function StatusBar() {
  return div(
    { class: "statusbar" },
    () => span({ class: "mono" }, S.mod.val && S.file.val ? `${S.mod.val}/${S.file.val}` : S.mod.val ? S.mod.val : "Ready"),
    div({ class: "grow" }),
    () => {
      const f = currentFile();
      return f ? span({ class: "mono" }, modeNote(f.mode)) : hole();
    },
    () => (S.file.val ? span({ class: "sep" }, "|") : hole()),
    span({ class: "mono" }, "build dev"),
    span({ class: "dotok", title: "Connected to the local editor server" }, "● local server"),
    span({ class: "mono" }, "save: dev"),
  );
}

// ---- toast ------------------------------------------------------------------
function Toast() {
  return () =>
    S.message.val
      ? div(
          { style: "position:fixed;left:50%;bottom:44px;transform:translateX(-50%);z-index:120;background:var(--elev);border:1px solid var(--line2);border-radius:10px;padding:10px 16px;box-shadow:0 18px 50px rgba(0,0,0,.5);font-size:13px;max-width:min(620px,92vw);color:var(--ink)" },
          S.message.val,
        )
      : hole();
}

// ---- template scaffolder modal ---------------------------------------------
function TemplateModal() {
  return div(
    { class: "scrim center", onclick: () => (S.templateOpen.val = false) },
    div(
      { class: "modal", onclick: (/** @type {MouseEvent} */ e) => e.stopPropagation() },
      div(
        { class: "mhead" },
        span({ style: "font-size:18px" }, "＋"),
        div({ class: "t" }, "Scaffold an overlay"),
        button({ class: "iconbtn", "aria-label": "Close", onclick: () => (S.templateOpen.val = false) }, "✕"),
      ),
      div(
        { class: "mbody" },
        p({ class: "muted", style: "margin:0 0 6px" }, "Generates a GON .append entry plus matching localization rows under mods/<name>/."),
        label({ class: "fld" }, "mod (folder under mods/)"),
        input({ value: tpl.mod.val, oninput: (/** @type {Event} */ e) => (tpl.mod.val = /** @type {HTMLInputElement} */ (e.target).value) }),
        label({ class: "fld" }, "kind"),
        select(
          { onchange: (/** @type {Event} */ e) => (tpl.kind.val = /** @type {HTMLSelectElement} */ (e.target).value) },
          ["ability", "passive", "item", "status-data"].map((k) => option({ value: k, selected: tpl.kind.val === k }, k)),
        ),
        label({ class: "fld" }, "entry name (GON key)"),
        input({ value: tpl.name.val, oninput: (/** @type {Event} */ e) => (tpl.name.val = /** @type {HTMLInputElement} */ (e.target).value) }),
        label({ class: "fld" }, "display name"),
        input({ value: tpl.display.val, oninput: (/** @type {Event} */ e) => (tpl.display.val = /** @type {HTMLInputElement} */ (e.target).value) }),
        label({ class: "fld" }, "description"),
        input({ value: tpl.desc.val, oninput: (/** @type {Event} */ e) => (tpl.desc.val = /** @type {HTMLInputElement} */ (e.target).value) }),
        () => (tpl.kind.val === "ability" ? label({ class: "fld" }, "variant_of (parent)") : hole()),
        () => (tpl.kind.val === "ability" ? input({ value: tpl.parent.val, oninput: (/** @type {Event} */ e) => (tpl.parent.val = /** @type {HTMLInputElement} */ (e.target).value) }) : hole()),
        () => (tpl.kind.val === "ability" ? label({ class: "fld" }, "status effect (optional)") : hole()),
        () => (tpl.kind.val === "ability" ? input({ value: tpl.status.val, oninput: (/** @type {Event} */ e) => (tpl.status.val = /** @type {HTMLInputElement} */ (e.target).value) }) : hole()),
        () => (tpl.result.val ? div({ class: tpl.result.val.ok ? "finding info" : "finding error", style: "margin-top:12px" }, span({ class: "mark" }, tpl.result.val.ok ? "✓" : "✕"), div(codeViewJson(tpl.result.val))) : hole()),
      ),
      div(
        { class: "mfoot" },
        div({ class: "grow" }),
        button({ class: "btn ghost", onclick: () => (S.templateOpen.val = false) }, "Close"),
        button(
          {
            class: "btn primary",
            onclick: async () => {
              if (!tpl.mod.val) {
                tpl.result.val = { ok: false, error: "enter a mod name first" };
                return;
              }
              const options = { displayName: tpl.display.val, desc: tpl.desc.val, parent: tpl.parent.val, statusEffect: tpl.status.val || undefined };
              const res = await postJson("/api/template", { mod: tpl.mod.val, kind: tpl.kind.val, name: tpl.name.val, options });
              tpl.result.val = res;
              if (res && res.ok) {
                S.message.val = `scaffolded ${tpl.name.val} in mods/${tpl.mod.val}`;
                setTimeout(() => (S.message.val = ""), 4000);
                await loadMods();
                await selectMod(tpl.mod.val);
              }
            },
          },
          "Scaffold",
        ),
      ),
    ),
  );
}
/** @param {any} obj */
function codeViewJson(obj) {
  const el = /** @type {HTMLElement} */ (pre({ class: "mergecode" }));
  el.textContent = JSON.stringify(obj, null, 2);
  return el;
}

// ---- concepts explainer drawer ----------------------------------------------
function ConceptsDrawer() {
  return div(
    { class: "scrim right", onclick: () => (S.conceptsOpen.val = false) },
    div(
      { class: "drawer", onclick: (/** @type {MouseEvent} */ e) => e.stopPropagation() },
      div({ class: "dhead" }, span({ style: "font-size:20px" }, "✦"), div({ class: "t" }, "How modding works here"), button({ class: "iconbtn", "aria-label": "Close", onclick: () => (S.conceptsOpen.val = false) }, "✕")),
      // Both halves of the tool are explained; the current editor mode is shown first.
      artMode.val ? div({ class: "dbody" }, ArtConceptsSection(), DataConceptsSection()) : div({ class: "dbody" }, DataConceptsSection(), ArtConceptsSection()),
      div(
        { class: "dfoot" },
        span({ class: "muted", style: "flex:1;font-size:12.5px" }, "More in ", span({ class: "mono" }, artMode.val ? "docs/art-preview-plan.md" : "docs/data-mods.md")),
        button({ class: "btn ghost", onclick: () => { lsSet("mewged.onboard.conceptsDontShowStart", "1"); S.conceptsOpen.val = false; } }, "Don't show on start"),
        button({ class: "btn primary", onclick: () => (S.conceptsOpen.val = false) }, "Got it"),
      ),
    ),
  );
}
/** @param {string} kind @param {string} tag @param {string} title @param {string} body */
function ConceptCard(kind, tag, title, body) {
  return div({ class: "card plain" }, span({ class: `tag pill ${kind}` }, tag), div({ style: "font-weight:700;font-size:14px;margin:10px 0 6px;color:var(--ink)" }, title), div({ style: "font-size:12.5px;color:var(--ink2);line-height:1.6" }, body));
}
/** @param {string} title @param {string} body */
function CheckCard(title, body) {
  return div({ class: "card plain", style: "display:flex;gap:12px" }, span({ class: "dotok", style: "font-size:16px" }, "✓"), div(b({ style: "font-size:13.5px" }, title), div({ style: "font-size:12.5px;color:var(--ink2);line-height:1.6;margin-top:3px" }, body)));
}

// The data-layer concepts (unchanged content, now grouped under a heading so the drawer
// can also carry the Art-mode section below/above it).
function DataConceptsSection() {
  return div(
    { style: "margin-bottom:30px" },
    div({ style: "font-weight:700;font-size:15px;color:var(--ink);margin:0 0 14px" }, "Data mode — GON/CSV overlays"),
    div({ class: "sec", style: "margin-bottom:12px" }, "Overlay kinds — how a mod file changes base data"),
    div(
      { class: "grid3", style: "margin-bottom:26px" },
      ConceptCard("append", ".append", "Add new entries", "Children are added at the end. Use it for a brand-new ability, item, or status. Safest — rarely collides."),
      ConceptCard("merge", ".merge", "Change values", "Deep-merges onto an existing entry — only the fields you name change. Use it to rebalance."),
      ConceptCard("patch", ".patch", "Per-field policy", "Each field picks .overwrite / .append / .add / .multiply. Use it for precise numeric tweaks."),
    ),
    div({ class: "sec", style: "margin-bottom:12px" }, "What the validator checks — before the game ever sees it"),
    div(
      { class: "grid2", style: "margin-bottom:12px" },
      CheckCard("Reference integrity", "Every status / ability / component name you mention actually resolves."),
      CheckCard("Localization", "Text keys exist in all 12 language columns."),
      CheckCard("Overlay target", "A .merge/.patch points at a key that exists."),
      CheckCard("Merge preview", "Shows the effective result, base + overlay."),
    ),
    p({ class: "muted", style: "margin:0 0 26px;font-size:12.5px" }, "This is the check that would have caught the crash from a status name that didn't resolve."),
    div({ class: "sec", style: "margin-bottom:12px" }, "Data ↔ native — where a name becomes real"),
    div(
      { class: "card plain", style: "padding:20px" },
      div(
        { class: "seam" },
        div({ class: "box" }, div({ class: "sec", style: "color:var(--acc-ink)" }, "Data layer"), div({ class: "mono", style: "font-size:12.5px;margin-top:8px;color:var(--ink)" }, "effects { JokersLuck 1 }"), div({ style: "font-size:11.5px;color:var(--muted);margin-top:6px" }, "GON overlay references a name")),
        span({ class: "arrow" }, "→"),
        div({ class: "box", style: "flex:0 0 150px;background:var(--accbg)" }, div({ class: "mono", style: "font-size:12px;color:var(--acc-ink)" }, "registered-names.json"), div({ style: "font-size:11.5px;color:var(--ink2);margin-top:6px" }, "the seam")),
        span({ class: "arrow" }, "→"),
        div({ class: "box" }, div({ class: "sec", style: "color:#ffa657" }, "Native layer"), div({ class: "mono", style: "font-size:12.5px;margin-top:8px;color:var(--ink)" }, 'FW_RegisterStatus("JokersLuck")'), div({ style: "font-size:11.5px;color:var(--muted);margin-top:6px" }, "DLL supplies the behavior")),
      ),
      p({ style: "font-size:12.5px;color:var(--ink2);line-height:1.6;margin:14px 0 0" }, "A native mod registers a name; the editor reads that list so your data overlay validates against it. That's how new mechanics the data layer can't express still plug into GON by name."),
    ),
  );
}

// Art-mode concepts: grayscale→palette recolor, the minimal SWF subset, the faithful
// preview, and the open DoABC/SymbolClass gate (docs/art-preview-plan.md §2–3, §7).
function ArtConceptsSection() {
  return div(
    { style: "margin-bottom:8px" },
    div({ style: "font-weight:700;font-size:15px;color:var(--ink);margin:0 0 14px" }, "Art mode — vector scenes the engine recolors"),
    div({ class: "sec", style: "margin-bottom:12px" }, "Grayscale art, recolored at runtime"),
    div(
      { class: "card plain", style: "padding:18px;margin-bottom:22px" },
      p({ style: "font-size:12.5px;color:var(--ink2);line-height:1.6;margin:0 0 12px" }, "You author in 16 levels of gray (", span({ class: "mono", style: "color:var(--acc-ink)" }, "gray:0–15"), "). The engine remaps each level through one row of the shared ", span({ class: "mono" }, "textures/palette.png"), " (16×256) — so the same art reskins per cat / class / UI just by changing the row. Non-gray colours pass through unremapped and are flagged ", span({ class: "mono" }, "passthrough-fill"), "."),
      div({ class: "ramp big", role: "img", "aria-label": "a 16-step gray ramp becomes a 16-colour palette row", style: "margin-bottom:6px" }, ...Array.from({ length: 16 }, (_, i) => span({ style: `background:rgb(${i * 17},${i * 17},${i * 17})` }))),
      div({ style: "font-size:11.5px;color:var(--muted)" }, "authored gray:0 → gray:15 — the Preview shows the real palette row in these 16 slots"),
    ),
    div(
      { class: "grid2", style: "margin-bottom:22px" },
      ConceptCard("append", "scene.json", "The source model", "Shapes (DefineShape3 paths), sprites (DefineSprite timelines with frame labels), and exports (SymbolClass linkage names GON addresses). Hand-editable and diff-friendly."),
      ConceptCard("append", ".swf v17", "The minimal subset", "Build emits an uncompressed FWS v17 with exactly what glaiel::swf reads — DefineShape3 + DefineSprite + PlaceObject2 + SymbolClass — plus a swflist.gon.append. No gradients/filters/text yet."),
    ),
    div({ class: "sec", style: "margin-bottom:12px" }, "The in-game-faithful preview"),
    div(
      { class: "grid2", style: "margin-bottom:22px" },
      CheckCard("Same code as the emitter", "The preview bakes frames and normalizes paths with the same pure modules the SWF emitter uses, then runs a literal port of paletted_full.shader — so what you see is what the engine draws."),
      CheckCard("Scrub, recolor, inspect", "Timeline scrubber with frame-label ticks, a palette-row picker, and a 'show raw grayscale' toggle to see the authored levels before the remap."),
    ),
    div({ class: "sec", style: "margin-bottom:12px" }, "The open gate — DoABC / SymbolClass"),
    div(
      { class: "card plain", style: "padding:18px" },
      p({ style: "font-size:12.5px;color:var(--ink2);line-height:1.6;margin:0" }, "Every vanilla SWF ships one Flash-generated ", span({ class: "mono", style: "color:#ffa657" }, "DoABC"), " that declares its ", span({ class: "mono" }, "SymbolClass"), " linkage classes. Whether ", span({ class: "mono" }, "glaiel::swf"), " ", b("requires"), " it to bind those names is the one unresolved question. Build both ways (", span({ class: "mono" }, "no DoABC"), " / ", span({ class: "mono" }, "stub DoABC"), ") and run the dev-save gate test from the Build tab; the default flips once it's answered. Until then the emitter defaults to ", span({ class: "mono" }, "none"), " and the toggle stays visible."),
    ),
  );
}

// ---- base entry drawer ------------------------------------------------------
function BaseEntryDrawer() {
  return div(
    { class: "scrim right", onclick: () => (S.baseDrawer.val = false) },
    div(
      { class: "drawer", style: "width:min(640px,96vw)", onclick: (/** @type {MouseEvent} */ e) => e.stopPropagation() },
      () => {
        const bv = S.baseView.val;
        const titleText = bv && bv.ok ? bv.name || "Base entry" : "Base entry";
        return div({ class: "dhead" }, span({ style: "font-size:18px" }, "⌕"), div({ class: "t" }, titleText), span({ class: "pill muted" }, "read-only"), button({ class: "iconbtn", "aria-label": "Close", onclick: () => (S.baseDrawer.val = false) }, "✕"));
      },
      div(
        { class: "dbody" },
        () => {
          const bv = S.baseView.val;
          if (!bv) return p({ class: "muted" }, "Pick a base entry.");
          if (!bv.ok) return div({ class: "finding error" }, span({ class: "mark" }, "✕"), div(bv.error || "not found"));
          return div(p({ class: "muted" }, `${bv.category} · ${bv.file}`), codeView(bv.gon));
        },
      ),
    ),
  );
}

// ---- components drawer (no-mod fallback) ------------------------------------
function ComponentsDrawer() {
  return div(
    { class: "scrim right", onclick: () => (S.compDrawer.val = false) },
    div(
      { class: "drawer", style: "width:min(560px,96vw)", onclick: (/** @type {MouseEvent} */ e) => e.stopPropagation() },
      div({ class: "dhead" }, span({ style: "font-size:18px" }, "⌕"), div({ class: "t" }, "Components"), button({ class: "iconbtn", "aria-label": "Close", onclick: () => (S.compDrawer.val = false) }, "✕")),
      div({ class: "dbody" }, ComponentSearch()),
    ),
  );
}

// ---- first-run guided tour --------------------------------------------------
const TOUR = [
  { t: "Browse the base game", b: "Every ability, item, passive, and the behavior components live in the left panel, read-only. Open one to see the exact shape your overlay will extend or override." },
  { t: "Create an overlay", b: "Scaffold a new ability, item, passive, or status from a template, or add an overlay file. .append adds new entries, .merge changes values, .patch sets per-field policy." },
  { t: "Edit with live validation", b: "Type in the GON editor. Every keystroke is re-checked — reference integrity, localization, overlay target, and GON syntax — before the game ever sees it." },
  { t: "Read the merge preview", b: "The Preview tab shows the effective entry: base data plus your overlay, so you can see exactly what the game will load." },
  { t: "Launch the dev save", b: "Launch Mewgenics with -modpaths pointing at your mod and a -savesuffix dev, so your real saves are never touched." },
];
// Art-mode first-run tour. Triggered the first time the user enters Art mode (and
// re-openable from Help), persisted under the same onboarding key family as the data tour.
const ART_TOUR = [
  { t: "Switch Data → Art", b: "The top-bar Data | Art switch flips the whole editor. Data mode edits GON/CSV overlays; Art mode authors vector scenes and builds them into the SWF subset the engine loads. Both only ever write under mods/<name>/ — your saves are never touched." },
  { t: "Scenes & shapes explorer", b: "The left panel lists your art/*.scene.json scenes, the swfs/ you've built, and imported assets. A scene holds shapes (vector paths), sprites (timelines with frame labels), and exports (the SymbolClass names GON addresses)." },
  { t: "Import an SVG", b: "Drop an SVG (Inkscape, Illustrator, VectorCraft…) onto the Art panel, or use the picker. Each SVG becomes one shape; unsupported features (gradients, filters, text) are reported as findings, never dropped silently." },
  { t: "Grayscale → palette", b: "The engine stores art as 16-level grayscale and recolors it at runtime through one shared textures/palette.png row. Author fills as gray:0–15; non-gray colours pass through unremapped and are flagged. Each shape's gray ramp shows the levels it uses." },
  { t: "In-game-faithful preview", b: "The Preview panel draws the scene exactly as the engine does — the same grayscale→palette-row remap, timeline playback with the frame-label scrubber, a palette-row picker, and a 'show raw grayscale' toggle to see the authored levels." },
  { t: "Build the SWF", b: "Build emits mods/<mod>/swfs/<name>.swf (uncompressed v17) plus a swflist.gon.append. Build with no DoABC or a stub DoABC — which the engine requires is the one open gate test; run the dev-save procedure from the Build tab. Nothing launches the game for you." },
];

/**
 * Shared guided-tour card. Both the data and art tours render through this so they stay
 * byte-identical in look and behavior; only the steps/state/title/onClose differ.
 * @param {{ steps: { t: string, b: string }[], step: import("./vendor/van-1.6.1.min.js").State<number>, dontShow: import("./vendor/van-1.6.1.min.js").State<boolean>, title: string, onClose: () => void }} cfg
 */
function GuidedTour(cfg) {
  const steps = cfg.steps;
  const step = cfg.step.val;
  const last = step >= steps.length - 1;
  return div(
    { class: "scrim center" },
    div(
      { class: "tourcard" },
      div({ style: "display:flex;align-items:center;gap:8px;margin-bottom:10px" }, span({ class: "chip", style: "color:var(--acc-ink);background:var(--accbg)" }, `STEP ${step + 1} OF ${steps.length}`), span({ class: "sec" }, cfg.title)),
      h2({ style: "margin:0 0 8px;font-size:18px" }, steps[step].t),
      p({ style: "margin:0 0 18px;font-size:13.5px;color:var(--ink2);line-height:1.6" }, steps[step].b),
      div(
        { class: "steplist", style: "margin-bottom:18px" },
        ...steps.map((s, i) =>
          div(
            { style: "display:flex;gap:10px;align-items:center;font-size:13px;color:" + (i === step ? "var(--ink)" : "var(--muted)") },
            span({ class: "stepnum " + (i < step ? "done" : i === step ? "on" : "off") }, i < step ? "✓" : String(i + 1)),
            s.t,
          ),
        ),
      ),
      div(
        { style: "display:flex;align-items:center;gap:14px" },
        div({ class: "dots", style: "flex:1" }, ...steps.map((_s, i) => span({ class: "dot" + (i === step ? " on" : "") }))),
        label(
          { style: "display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);cursor:pointer" },
          input({ type: "checkbox", checked: () => cfg.dontShow.val, onchange: (/** @type {Event} */ e) => (cfg.dontShow.val = /** @type {HTMLInputElement} */ (e.target).checked) }),
          "Don't show again",
        ),
      ),
      div(
        { style: "display:flex;gap:10px;margin-top:16px" },
        step > 0 ? button({ class: "btn ghost", onclick: () => (cfg.step.val = step - 1) }, "← Back") : hole(),
        div({ class: "grow" }),
        button({ class: "btn ghost", onclick: cfg.onClose }, "Skip"),
        last
          ? button({ class: "btn primary", onclick: cfg.onClose }, "Done")
          : button({ class: "btn primary", onclick: () => (cfg.step.val = step + 1) }, "Next →"),
      ),
    ),
  );
}
function TourModal() {
  return GuidedTour({ steps: TOUR, step: S.tourStep, dontShow: S.tourDontShow, title: "Guided tour", onClose: closeTour });
}
function ArtTourModal() {
  return GuidedTour({ steps: ART_TOUR, step: S.artTourStep, dontShow: S.artTourDontShow, title: "Art mode tour", onClose: closeArtTour });
}

// ---- worked example (Joker's Luck) ------------------------------------------
const EXAMPLE_STEPS = [
  { t: "Create the mod folder", sub: "mods/jokers-luck" },
  { t: "Add the ability overlay", sub: "JokersGambit, a Spin variant" },
  { t: "Add localization rows", sub: "name + tooltip, 12 languages" },
  { t: "Register the native name", sub: "so JokersLuck validates" },
  { t: "Validate & launch dev", sub: "bind JokersGambit in battle" },
];
const EXAMPLE_GON = `JokersGambit {
    variant_of Spin
    meta { name "ABILITY_JOKERSGAMBIT_NAME"; desc "ABILITY_JOKERSGAMBIT_DESC" }
    cost { infcantrip true; mana 0 }
    damage_instance { damage 0; effects { JokersLuck 1 } }
}`;
/** @param {number} step */
function exampleBody(step) {
  if (step === 2) {
    return div(
      div({ class: "sec", style: "color:var(--acc-ink);margin-bottom:6px" }, "Step 2"),
      h1({ style: "margin:0 0 10px;font-size:24px" }, "Add the ability overlay"),
      p(
        { style: "margin:0 0 20px;font-size:14px;color:var(--ink2);line-height:1.65;max-width:720px" },
        "We append a new ability to the fighters' table. ",
        span({ class: "mono", style: "color:#79c0ff" }, "variant_of Spin"),
        " inherits everything from the base Spin attack, then we point its on-hit ",
        span({ class: "mono" }, "effects"),
        " at our status. Because this is an ",
        span({ style: "color:var(--acc-ink);font-weight:600" }, ".append"),
        ", no existing ability is touched.",
      ),
      div(
        { class: "codeblock" },
        div({ class: "cbhead" }, span({ class: "mono", style: "font-size:12px" }, "mods/jokers-luck/data/abilities/fighter_abilities.gon.append"), div({ class: "grow" }), span({ class: "pill append chip" }, ".append")),
        codeView(EXAMPLE_GON, "cbcode"),
      ),
      div(
        { style: "display:flex;align-items:center;gap:10px;margin-top:16px;max-width:760px;background:var(--okbg);border:1px solid rgba(63,185,80,.3);border-radius:10px;padding:12px 14px" },
        span({ class: "dotok", style: "font-size:15px" }, "✓"),
        span({ style: "font-size:13px;color:var(--ink2)" }, "Validates now — except ", span({ class: "mono", style: "color:#ffa657" }, "JokersLuck"), " is still unknown. You'll register it in step 4."),
      ),
      div(
        { style: "display:flex;gap:12px;margin-top:26px;flex-wrap:wrap" },
        button({ class: "btn ghost", onclick: () => (S.exampleStep.val = Math.max(0, step - 1)) }, "← Back"),
        button(
          {
            class: "btn primary",
            onclick: () => {
              S.exampleOpen.val = false;
              openTemplate({ mod: S.mod.val || "jokers-luck-tutorial", kind: "ability", name: "JokersGambit", display: "Joker's Gambit", desc: "A Spin variant that applies JokersLuck", parent: "Spin", status: "JokersLuck" });
            },
          },
          "Insert this overlay (open scaffolder) →",
        ),
        button({ class: "btn ghost", onclick: () => (S.exampleStep.val = Math.min(EXAMPLE_STEPS.length - 1, step + 1)) }, "I'll do it myself"),
      ),
    );
  }
  const s = EXAMPLE_STEPS[step];
  return div(
    div({ class: "sec", style: "color:var(--acc-ink);margin-bottom:6px" }, `Step ${step + 1}`),
    h1({ style: "margin:0 0 10px;font-size:24px" }, s.t),
    p({ style: "margin:0 0 20px;font-size:14px;color:var(--ink2);line-height:1.65;max-width:720px" }, s.sub + "."),
    p(
      { style: "margin:0 0 20px;font-size:13.5px;color:var(--muted);line-height:1.65;max-width:720px" },
      step === 0 ? "A mod is just a folder under mods/. Creating any overlay (via + New overlay) makes the folder for you — nothing outside mods/<name>/ is ever written." :
        step === 1 ? "The overlay file carries a .append suffix so it adds a new entry without touching the base table. See step 2's code for the shape." :
        step === 3 ? "A native mod registers JokersLuck in registered-names.json. The validator reads that list, so the data overlay's reference resolves. (Illustrative — editing registered-names.json is a native-mod task.)" :
        "Re-run Validate, then launch the dev save with -modpaths/-savesuffix outside the editor (Launch dev shows the exact command). Bind JokersGambit in battle to see JokersLuck reroll luck.",
    ),
    div(
      { style: "display:flex;gap:12px;margin-top:10px" },
      step > 0 ? button({ class: "btn ghost", onclick: () => (S.exampleStep.val = step - 1) }, "← Back") : hole(),
      step < EXAMPLE_STEPS.length - 1 ? button({ class: "btn primary", onclick: () => (S.exampleStep.val = step + 1) }, "Next →") : button({ class: "btn primary", onclick: () => (S.exampleOpen.val = false) }, "Finish"),
    ),
  );
}
function WorkedExample() {
  const step = S.exampleStep.val;
  const pct = Math.round(((step + 1) / EXAMPLE_STEPS.length) * 100);
  return div(
    { class: "example" },
    div({ class: "exhdr" }, span({ style: "font-size:18px" }, "★"), div({ style: "font-weight:700;font-size:15px" }, "Worked example — build Joker's Luck"), span({ class: "pill append chip" }, "tutorial"), div({ class: "grow" }), button({ class: "btn ghost", onclick: () => (S.exampleOpen.val = false) }, "Exit example")),
    div(
      { class: "exgrid" },
      div(
        { class: "stepper" },
        div({ style: "display:flex;align-items:center;gap:10px;margin-bottom:6px" }, div({ class: "progress" }, div({ style: `width:${pct}%` })), span({ style: "font-size:12px;color:var(--muted)" }, `Step ${step + 1} / ${EXAMPLE_STEPS.length}`)),
        p({ style: "font-size:12.5px;color:var(--muted);margin:0 0 18px" }, "A new status that rerolls luck to ±10 every turn."),
        div(
          { style: "display:flex;flex-direction:column;gap:6px" },
          ...EXAMPLE_STEPS.map((s, i) =>
            button(
              { class: "exstep" + (i === step ? " cur" : ""), style: "border:0;background:" + (i === step ? "var(--accbg)" : "transparent") + ";text-align:left;cursor:pointer", onclick: () => (S.exampleStep.val = i) },
              span({ class: "stepnum " + (i < step ? "done" : i === step ? "on" : "off") }, i < step ? "✓" : String(i + 1)),
              div(div({ style: "font-weight:" + (i === step ? "700" : "600") + ";font-size:13.5px;color:" + (i <= step ? "var(--ink)" : "var(--muted)") }, s.t), div({ style: "font-size:12px;color:var(--muted)" }, s.sub)),
            ),
          ),
        ),
      ),
      div({ class: "stepcontent" }, () => exampleBody(S.exampleStep.val)),
    ),
  );
}

// ---- art worked example (import an SVG → preview → build) -------------------
// Illustrative (like the data example): it explains the pipeline and drops you into the
// real Art UI at each step. It never writes to disk on its own — the New scene dialog and
// the drop zone do that, confined to mods/<mod>/.
const ART_EXAMPLE_STEPS = [
  { t: "Switch to Art mode", sub: "Data | Art top-bar switch" },
  { t: "Create a scene", sub: "art/<name>.scene.json" },
  { t: "Import an SVG", sub: "becomes a grayscale shape" },
  { t: "Preview it faithfully", sub: "palette row + scrubber" },
  { t: "Build the SWF", sub: "swfs/<name>.swf" },
];
const ART_SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect x="8" y="8" width="48" height="48" rx="10" fill="#888888"/>
  <circle cx="24" cy="28" r="5" fill="#222222"/>
  <circle cx="40" cy="28" r="5" fill="#222222"/>
  <path d="M20 42 Q32 52 44 42" fill="none" stroke="#dddddd" stroke-width="3"/>
</svg>`;
/** Close the example and land the user in the live Art UI (already onboarding → no auto-tour). @param {() => void} go */
function artExampleGoto(go) {
  S.artExampleOpen.val = false;
  artMode.val = true;
  artTourTriggered = true;
  go();
}
/** @param {string} text */
function artSamplePre(text) {
  const el = /** @type {HTMLElement} */ (pre({ class: "mergecode", style: "max-width:620px" }));
  el.textContent = text;
  return el;
}
/** @param {number} step */
function artExampleBody(step) {
  const s = ART_EXAMPLE_STEPS[step];
  /** @type {any[]} */
  const action = [];
  /** @type {any[]} */
  let detail = [];
  if (step === 0) {
    detail = [
      p({ style: "margin:0 0 18px;font-size:13.5px;color:var(--ink2);line-height:1.65;max-width:720px" }, "The top-bar ", span({ class: "mono" }, "Data | Art"), " switch flips the whole editor. Art mode authors vector scenes and builds them into the SWF subset the engine loads — all writes still land only under ", span({ class: "mono" }, "mods/<name>/"), ", so your saves are never touched."),
    ];
    action.push(button({ class: "btn primary", onclick: () => artExampleGoto(() => {}) }, "Enter Art mode →"));
  } else if (step === 1) {
    detail = [
      p({ style: "margin:0 0 18px;font-size:13.5px;color:var(--ink2);line-height:1.65;max-width:720px" }, "A scene is an ", span({ class: "mono" }, "art/<name>.scene.json"), " file — the hand-editable source model of shapes, sprites and exports. Open a mod first (top-bar mod switcher), then create one. The starter is a bobbing gray square with idle/blink labels."),
    ];
    action.push(button({ class: "btn primary", onclick: () => artExampleGoto(() => openNewSceneModal()) }, "Open the New scene dialog →"));
  } else if (step === 2) {
    detail = [
      p({ style: "margin:0 0 16px;font-size:13.5px;color:var(--ink2);line-height:1.65;max-width:720px" }, "Drop an SVG onto the Art panel (or use the file picker). Each SVG becomes one shape. Fills that are gray become ", span({ class: "mono" }, "gray:0–15"), " levels the engine recolors; non-gray colours pass through and are flagged. Here's a tiny sample — the ", span({ class: "mono" }, "#888888"), "/", span({ class: "mono" }, "#222222"), "/", span({ class: "mono" }, "#dddddd"), " fills land on gray levels 8, 2 and 13:"),
      artSamplePre(ART_SAMPLE_SVG),
    ];
    action.push(button({ class: "btn primary", onclick: () => artExampleGoto(() => setArtSubtab("shapes")) }, "Go to the Shapes panel to import →"));
  } else if (step === 3) {
    detail = [
      p({ style: "margin:0 0 18px;font-size:13.5px;color:var(--ink2);line-height:1.65;max-width:720px" }, "The Preview draws the scene exactly as the engine does: the 16-level gray is remapped through a ", span({ class: "mono" }, "palette.png"), " row you pick, with timeline playback, a frame-label scrubber, and a ", span({ class: "mono" }, "show raw grayscale"), " toggle to see the authored levels before the remap."),
    ];
    action.push(button({ class: "btn primary", onclick: () => artExampleGoto(() => setArtRightTab("preview")) }, "Open the Preview →"));
  } else {
    detail = [
      p({ style: "margin:0 0 18px;font-size:13.5px;color:var(--ink2);line-height:1.65;max-width:720px" }, "Build emits ", span({ class: "mono" }, "mods/<mod>/swfs/<name>.swf"), " plus a ", span({ class: "mono" }, "swflist.gon.append"), ". Build with no DoABC or a stub DoABC — which one the engine needs is the one open gate test (run the dev-save procedure from the Build tab). GON then addresses your art by its export names."),
    ];
    action.push(button({ class: "btn primary", onclick: () => artExampleGoto(() => setArtRightTab("build")) }, "Open the Build tab →"));
  }
  return div(
    div({ class: "sec", style: "color:var(--acc-ink);margin-bottom:6px" }, `Step ${step + 1}`),
    h1({ style: "margin:0 0 10px;font-size:24px" }, s.t),
    ...detail,
    div(
      { style: "display:flex;gap:12px;margin-top:24px;flex-wrap:wrap;align-items:center" },
      step > 0 ? button({ class: "btn ghost", onclick: () => (S.artExampleStep.val = step - 1) }, "← Back") : hole(),
      ...action,
      div({ class: "grow" }),
      step < ART_EXAMPLE_STEPS.length - 1
        ? button({ class: "btn ghost", onclick: () => (S.artExampleStep.val = step + 1) }, "Next →")
        : button({ class: "btn ghost", onclick: () => (S.artExampleOpen.val = false) }, "Finish"),
    ),
  );
}
function ArtWorkedExample() {
  const step = S.artExampleStep.val;
  const pct = Math.round(((step + 1) / ART_EXAMPLE_STEPS.length) * 100);
  return div(
    { class: "example" },
    div({ class: "exhdr" }, span({ style: "font-size:18px" }, "▲"), div({ style: "font-weight:700;font-size:15px" }, "Art worked example — SVG → preview → SWF"), span({ class: "pill append chip" }, "tutorial"), div({ class: "grow" }), button({ class: "btn ghost", onclick: () => (S.artExampleOpen.val = false) }, "Exit example")),
    div(
      { class: "exgrid" },
      div(
        { class: "stepper" },
        div({ style: "display:flex;align-items:center;gap:10px;margin-bottom:6px" }, div({ class: "progress" }, div({ style: `width:${pct}%` })), span({ style: "font-size:12px;color:var(--muted)" }, `Step ${step + 1} / ${ART_EXAMPLE_STEPS.length}`)),
        p({ style: "font-size:12.5px;color:var(--muted);margin:0 0 18px" }, "Author grayscale vector art the engine recolors, and build it into a loadable SWF."),
        div(
          { style: "display:flex;flex-direction:column;gap:6px" },
          ...ART_EXAMPLE_STEPS.map((es, i) =>
            button(
              { class: "exstep" + (i === step ? " cur" : ""), style: "border:0;background:" + (i === step ? "var(--accbg)" : "transparent") + ";text-align:left;cursor:pointer", onclick: () => (S.artExampleStep.val = i) },
              span({ class: "stepnum " + (i < step ? "done" : i === step ? "on" : "off") }, i < step ? "✓" : String(i + 1)),
              div(div({ style: "font-weight:" + (i === step ? "700" : "600") + ";font-size:13.5px;color:" + (i <= step ? "var(--ink)" : "var(--muted)") }, es.t), div({ style: "font-size:12px;color:var(--muted)" }, es.sub)),
            ),
          ),
        ),
      ),
      div({ class: "stepcontent" }, () => artExampleBody(S.artExampleStep.val)),
    ),
  );
}

// ---- mount ------------------------------------------------------------------
if (typeof window !== "undefined") {
  window.addEventListener("click", () => {
    if (S.openMenu.val) S.openMenu.val = "";
  });
}

initArtUi({ S, getJson, postJson, hole, openArtTour });

const shell = div(
  { class: "shell" },
  TopBar(),
  div(
    { class: "body", style: () => (S.mod.val ? (artMode.val ? "grid-template-columns:282px 1fr 420px" : "grid-template-columns:302px 1fr 384px") : "grid-template-columns:302px 1fr") },
    ExplorerSwitch(),
    CenterSwitch(),
    RightSwitch(),
  ),
  StatusBar(),
);

van.add(
  /** @type {HTMLElement} */ (document.getElementById("app")),
  shell,
  Toast(),
  () => (S.templateOpen.val ? TemplateModal() : hole()),
  () => (S.conceptsOpen.val ? ConceptsDrawer() : hole()),
  () => (S.baseDrawer.val ? BaseEntryDrawer() : hole()),
  () => (S.compDrawer.val ? ComponentsDrawer() : hole()),
  () => (S.tourOpen.val ? TourModal() : hole()),
  () => (S.exampleOpen.val ? WorkedExample() : hole()),
  () => (S.artTourOpen.val ? ArtTourModal() : hole()),
  () => (S.artExampleOpen.val ? ArtWorkedExample() : hole()),
);

repaintEditorNow();
loadMods();
loadBaseCats();
loadCompTotal();

// First-run guided tour (shows once unless dismissed with "don't show again").
if (lsGet("mewged.onboard.tourDontShow") !== "1" && lsGet("mewged.onboard.tourSeen") !== "1") {
  S.tourOpen.val = true;
}

// Deep link: http://127.0.0.1:4173/?mode=art opens straight into Art mode (skips the tours,
// e.g. for demos/screenshots). Both onboarding tours stay reachable from the Help (?) menu.
if (typeof location !== "undefined" && new URLSearchParams(location.search).get("mode") === "art") {
  artMode.val = true;
  S.tourOpen.val = false;
  artTourTriggered = true; // don't auto-pop the art tour over a deep-linked session
}
