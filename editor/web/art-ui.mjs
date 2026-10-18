// Art mode for the Mewgenics mod editor: the "Art" authoring panel and the
// "Preview" panel (docs/art-preview-plan.md §4). VanJS, no build step. Talks only
// to the /api/art/* bridge; the WYSIWYG preview renders from the same pure scene /
// timeline modules the emitter uses (served read-only at /src/core/art/*).
//
// Everything here is additive to app.mjs: app.mjs switches its explorer / center /
// right panel to these components when `artMode` is on.

import van from "./vendor/van-1.6.1.min.js";
import { createPreview } from "./art/preview-gl.mjs";
import { shapeGrayUsage, parseFill, grayLevelToByte } from "../src/core/art/scene.mjs";
import { bakeSprite, labelList } from "../src/core/art/timeline.mjs";

const { div, span, button, select, option, textarea, input, p, label, h2, small, b, canvas } = van.tags;

/** @typedef {{ S: any, getJson: (url: string) => Promise<any>, postJson: (url: string, body: any) => Promise<any>, hole: () => Element, openArtTour: () => void }} Ctx */
/** @type {Ctx} */
let ctx;

export const artMode = van.state(false);

// ---- state --------------------------------------------------------------------
const A = {
  scenes: van.state(/** @type {any[]} */ ([])),
  swfs: van.state(/** @type {any[]} */ ([])),
  assets: van.state(/** @type {{svgs: string[], pngs: string[], swflistAppend: string|null}} */ ({ svgs: [], pngs: [], swflistAppend: null })),
  scenePath: van.state(""),
  scene: /** @type {any} */ (null), // plain object, edited in place; bump `rev` to re-render
  rev: van.state(0),
  hasScene: van.state(false), // mirrors (scene != null); flips only on open/close so the
  //                             scene-panel shell isn't rebuilt on every in-place edit

  saved: van.state(true),
  findings: van.state(/** @type {any[]} */ ([])),
  subtab: van.state("overview"), // overview | shapes | sprites | exports | json
  rightTab: van.state("preview"), // preview | findings | build
  abc: van.state("none"),
  buildResult: van.state(/** @type {any} */ (null)),
  inspect: van.state(/** @type {any} */ (null)),
  palette: van.state(/** @type {any} */ (null)), // { ok, rows, hints, hint, source }
  palOpen: van.state(false),
  newSceneOpen: van.state(false),
  // preview controls
  target: van.state("stage"),
  frame: van.state(0),
  frames: van.state(1),
  playing: van.state(false),
  loop: van.state(true),
  showGray: van.state(false),
  row: van.state(54),
  backend: van.state(""),
  jsonText: van.state(""),
  jsonError: van.state(""),
  dropOver: van.state(false),
};

/** @param {Ctx} c */
export function initArtUi(c) {
  ctx = c;
  // Re-fit the preview on window resize, rAF-batched (one layout read/write per frame)
  // and only when the preview canvas is actually on-screen.
  if (typeof window !== "undefined") {
    let resizeRaf = 0;
    window.addEventListener(
      "resize",
      () => {
        if (resizeRaf) return;
        resizeRaf = requestAnimationFrame(() => {
          resizeRaf = 0;
          if (pv && artMode.val && A.rightTab.val === "preview") pv.resize();
        });
      },
      { passive: true },
    );
  }
}

/** @param {string} msg */
function toast(msg) {
  ctx.S.message.val = msg;
  setTimeout(() => (ctx.S.message.val = ""), 5000);
}

// ---- onboarding hooks (driven from app.mjs's Help menu / art worked example) --------
/** Open the "New art scene" dialog (used by the art worked example). */
export function openNewSceneModal() {
  A.newSceneOpen.val = true;
}
/** Jump the center Art panel to a sub-tab (overview | shapes | sprites | exports | json). @param {string} tab */
export function setArtSubtab(tab) {
  A.subtab.val = tab;
}
/** Jump the right Art panel to a tab (preview | findings | build). @param {string} tab */
export function setArtRightTab(tab) {
  A.rightTab.val = tab;
}
function bump() {
  A.rev.val = A.rev.val + 1;
  // Keep the presence flag in sync (van dedupes same-value writes, so this only
  // actually triggers the scene-panel shell to rebuild when a scene opens/closes).
  A.hasScene.val = A.scene != null;
}

// ---- data loading -------------------------------------------------------------
/** @param {string} mod */
export async function loadArtForMod(mod) {
  A.scenePath.val = "";
  A.scene = null;
  A.findings.val = [];
  A.buildResult.val = null;
  A.inspect.val = null;
  if (!mod) {
    A.scenes.val = [];
    A.swfs.val = [];
    return;
  }
  const r = await ctx.getJson(`/api/art/scenes?mod=${encodeURIComponent(mod)}`);
  A.scenes.val = r.scenes || [];
  A.swfs.val = r.swfs || [];
  A.assets.val = { svgs: r.svgs || [], pngs: r.pngs || [], swflistAppend: r.swflistAppend || null };
  if (!A.palette.val) {
    try {
      const pal = await ctx.getJson("/api/art/palette");
      A.palette.val = pal;
      if (pal && pal.defaultAbc) A.abc.val = pal.defaultAbc;
      if (pv) pv.setPalette(pal && pal.ok ? pal.rows : null);
    } catch {
      /* preview falls back to the identity ramp */
    }
  }
}

/** @param {string} relPath */
async function openScene(relPath) {
  const r = await ctx.getJson(`/api/art/scene?mod=${encodeURIComponent(ctx.S.mod.val)}&path=${encodeURIComponent(relPath)}`);
  A.scenePath.val = relPath;
  A.findings.val = r.findings || [];
  A.buildResult.val = null;
  if (r.scene) {
    A.scene = r.scene;
  } else {
    // unparseable JSON: still open it in the JSON tab so it can be repaired
    A.scene = null;
    A.subtab.val = "json";
    A.jsonText.val = r.text || "";
    A.jsonError.val = r.error || "could not read scene";
  }
  A.saved.val = true;
  A.subtab.val = A.scene ? "overview" : "json";
  if (A.scene) {
    A.row.val = A.scene.preview && typeof A.scene.preview.palette === "number" ? A.scene.preview.palette : A.row.val;
    pickDefaultTarget();
    pushSceneToPreview();
  }
  bump();
}

function pickDefaultTarget() {
  if (!A.scene) return;
  const sprites = Object.keys(A.scene.sprites || {});
  const hasStage = (A.scene.stage_instances || []).length > 0;
  A.target.val = hasStage ? "stage" : sprites[0] || Object.keys(A.scene.shapes || {})[0] || "stage";
}

/** @type {number|undefined} */
let liveTimer;
function scheduleValidate() {
  A.saved.val = false;
  if (liveTimer) clearTimeout(liveTimer);
  liveTimer = /** @type {any} */ (setTimeout(runValidate, 300));
}
async function runValidate() {
  if (!A.scene) return;
  const r = await ctx.postJson("/api/art/validate", { scene: A.scene });
  A.findings.val = r.findings || [];
  pushSceneToPreview(r.scene);
  bump();
}

async function saveScene() {
  if (!A.scene || !A.scenePath.val) return;
  const r = await ctx.postJson("/api/art/scene", { mod: ctx.S.mod.val, path: A.scenePath.val, scene: A.scene, force: true });
  if (r.ok) {
    A.saved.val = true;
    toast(`saved ${r.path} (${r.bytes} bytes${r.valid ? "" : " — has errors"})`);
    A.findings.val = r.findings || A.findings.val;
  } else toast(`save refused: ${r.error}`);
}

/** @param {string} name */
async function newScene(name) {
  const r = await ctx.postJson("/api/art/new-scene", { mod: ctx.S.mod.val, name, starter: true });
  if (!r.ok) return toast(`could not create scene: ${r.error}`);
  A.newSceneOpen.val = false;
  await loadArtForMod(ctx.S.mod.val);
  await openScene(r.relPath);
  toast(`created ${r.path}`);
}

async function build(dryRun = false) {
  if (!A.scene || !A.scenePath.val) return;
  const r = await ctx.postJson("/api/art/build", { mod: ctx.S.mod.val, path: A.scenePath.val, scene: A.scene, abc: A.abc.val, dryRun });
  A.buildResult.val = r;
  A.rightTab.val = "build";
  if (r.ok) {
    toast(dryRun ? `dry run ok: ${r.bytes} bytes` : `built ${r.swfPath} (${r.bytes} bytes, DoABC: ${r.abc})`);
    if (!dryRun) await loadArtForMod(ctx.S.mod.val);
  } else toast(`build failed: ${r.error}`);
}

/** @param {string} relPath */
async function inspectSwf(relPath) {
  const r = await ctx.getJson(`/api/art/inspect-swf?mod=${encodeURIComponent(ctx.S.mod.val)}&path=${encodeURIComponent(relPath)}`);
  A.inspect.val = { relPath, ...r };
  A.rightTab.val = "build";
}

/**
 * Import an SVG file (from a drop / file picker) as a new shape, and keep the SVG in
 * the mod's art/ folder for provenance.
 * @param {File} file
 */
async function importSvgFile(file) {
  if (!A.scene) return toast("open or create a scene first");
  const text = await file.text();
  const base = file.name.replace(/\.svg$/i, "").replace(/[^A-Za-z0-9_]/g, "_") || "shape";
  let id = base;
  let n = 2;
  while (A.scene.shapes[id] || (A.scene.sprites && A.scene.sprites[id])) id = `${base}_${n++}`;
  const rel = `art/${file.name.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
  const r = await ctx.postJson("/api/art/import-svg", { svgText: text, options: {} });
  if (!r.ok) {
    A.findings.val = [...(r.findings || []), ...A.findings.val];
    return toast(`import failed: ${r.error || "see findings"}`);
  }
  A.scene.shapes[id] = { ...r.shape, source: rel };
  try {
    const b64 = btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())));
    await ctx.postJson("/api/art/asset", { mod: ctx.S.mod.val, path: rel, base64: b64 });
  } catch {
    /* provenance copy is best-effort */
  }
  A.findings.val = [...(r.findings || []).map((/** @type {any} */ f) => ({ ...f, path: `shapes.${id}` })), ...A.findings.val];
  A.subtab.val = "shapes";
  A.target.val = id;
  toast(`imported ${file.name} as shape "${id}" (${r.shape.paths.length} paths)`);
  scheduleValidate();
  bump();
}

// ---- preview (wraps web/art/preview-gl.mjs) ----------------------------------
/** @type {any} */
let pv = null;
const pvCanvas = /** @type {HTMLCanvasElement} */ (canvas({ "aria-label": "In-game-faithful preview of the selected sprite", role: "img" }));
const pvStatus = van.state("");

function ensurePreview() {
  if (pv) return pv;
  pv = createPreview(pvCanvas, {
    onStatus: (/** @type {string} */ s) => (pvStatus.val = s),
    onFrame: (/** @type {number} */ f) => (A.frame.val = f),
    // keep the transport's play/pause label truthful, including when playback
    // auto-stops on the last frame with loop off (previously left showing "Pause").
    onPlaying: (/** @type {boolean} */ p) => (A.playing.val = p),
  });
  const pal = A.palette.val;
  pv.setPalette(pal && pal.ok ? pal.rows : null);
  pv.setPaletteRow(A.row.val);
  pv.setLoop(A.loop.val);
  pv.setBackground("checker");
  pushSceneToPreview();
  return pv;
}

/** @param {any} [validated] */
function pushSceneToPreview(validated) {
  if (!pv || !A.scene) return;
  pv.setScene(validated || A.scene);
  const targets = pv.getTargets ? pv.getTargets() : [];
  if (!targets.some((/** @type {any} */ t) => t.id === A.target.val)) pickDefaultTarget();
  pv.setTarget(A.target.val);
  A.frames.val = pv.getFrameCount();
  if (A.frame.val >= A.frames.val) {
    A.frame.val = 0;
    pv.setFrame(0);
  }
  A.backend.val = pv.info().backend;
  loadBitmaps();
  pv.render();
}

function loadBitmaps() {
  if (!pv || !A.scene || !A.scene.bitmaps) return;
  for (const [id, bm] of Object.entries(A.scene.bitmaps)) {
    const img = new Image();
    img.onload = () => {
      pv.setBitmap(id, img);
      pv.render();
    };
    img.src = `/api/art/asset?mod=${encodeURIComponent(ctx.S.mod.val)}&path=${encodeURIComponent(/** @type {any} */ (bm).file)}`;
  }
}

/** @param {string} id */
function setTarget(id) {
  A.target.val = id;
  A.rightTab.val = "preview";
  if (pv) {
    pv.setTarget(id);
    A.frames.val = pv.getFrameCount();
    pv.setFrame(0);
    A.frame.val = 0;
    pv.render();
  }
}

// ---- helpers ------------------------------------------------------------------
/**
 * CSS colour for gray level N through the current palette row (or raw gray).
 * @param {number} level
 */
function rampColor(level) {
  const pal = A.palette.val;
  if (A.showGray.val || !pal || !pal.ok) {
    const v = grayLevelToByte(level);
    return `rgb(${v},${v},${v})`;
  }
  const row = pal.rows[Math.max(0, Math.min(pal.rows.length - 1, A.row.val))] || [];
  const c = row[level] || [0, 0, 0];
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
/** @param {number[]} used */
function Ramp(used) {
  const set = new Set(used);
  return div({ class: "ramp", title: `gray levels used: ${used.join(", ") || "none"}` }, ...Array.from({ length: 16 }, (_, i) => span({ class: set.has(i) ? "used" : "", style: `background:${rampColor(i)}` })));
}
/** @param {any} f */
function FindingRow(f) {
  return div(
    { class: `finding ${f.severity}` },
    span({ class: "mark" }, f.severity === "error" ? "✕" : f.severity === "warning" ? "!" : "i"),
    div(div(span({ class: "code" }, f.code), f.path ? span({ class: "muted" }, `  @ ${f.path}`) : ctx.hole()), div(f.message)),
  );
}

// ---- explorer -----------------------------------------------------------------
export function ArtExplorer() {
  return div(
    { class: "explorer" },
    div(
      { class: "exhead" },
      span({ class: "sec" }, "Art scenes"),
      () => (ctx.S.mod.val ? button({ class: "btn ghost sm", style: "color:var(--acc-ink)", onclick: () => (A.newSceneOpen.val = true) }, "+ New scene") : ctx.hole()),
    ),
    () =>
      !ctx.S.mod.val
        ? div({ class: "dashed" }, div({ style: "font-size:13px" }, "Open a mod to author art."))
        : div(
            { class: "exbody tw" },
            A.scenes.val.length
              ? A.scenes.val.map((s) =>
                  button(
                    { class: () => "srow" + (A.scenePath.val === s.relPath ? " sel" : ""), title: s.relPath, onclick: () => openScene(s.relPath) },
                    span({ class: "fname", style: "flex:1" }, s.name),
                    span({ class: "count" }, `${s.bytes} B`),
                  ),
                )
              : div({ class: "srow", style: "color:var(--muted)" }, "(no scenes — create one)"),
          ),
    div({ class: "exdiv" }),
    div({ class: "exhead" }, span({ class: "sec" }, "Built SWFs"), small({ class: "muted" }, "· swfs/")),
    () =>
      div(
        { class: "exbody tw" },
        A.swfs.val.length
          ? A.swfs.val.map((s) =>
              button({ class: "srow", title: "inspect with the verification reader", onclick: () => inspectSwf(s.relPath) }, span({ class: "fname", style: "flex:1" }, s.relPath.replace(/^swfs\//, "")), span({ class: "count" }, `${(s.bytes / 1024).toFixed(1)} KB`)),
            )
          : div({ class: "srow", style: "color:var(--muted)" }, A.scenePath.val ? "(nothing built — use Build SWF)" : "(nothing built yet)"),
        A.assets.val.swflistAppend ? div({ class: "srow", style: "color:var(--muted)" }, span({ class: "fname" }, "swflist.gon.append"), span({ class: "pill append chip" }, ".append")) : ctx.hole(),
      ),
    div({ class: "exdiv" }),
    div({ class: "exhead" }, span({ class: "sec" }, "Assets"), small({ class: "muted" }, "· art/")),
    () =>
      div(
        { class: "exbody tw" },
        ...A.assets.val.svgs.map((s) => div({ class: "srow", style: "color:var(--ink2)" }, span({ class: "fname" }, s))),
        ...A.assets.val.pngs.map((s) => div({ class: "srow", style: "color:var(--ink2)" }, span({ class: "fname" }, s))),
        !A.assets.val.svgs.length && !A.assets.val.pngs.length ? div({ class: "srow", style: "color:var(--muted)" }, "(drop an SVG onto the Art panel)") : ctx.hole(),
      ),
  );
}

// ---- center: Art authoring panel ------------------------------------------------
export function ArtCenter() {
  return div(
    { class: "center" },
    () => (A.scenePath.val ? SceneTabBar() : ctx.hole()),
    () => (A.scenePath.val ? ScenePanel() : ArtEmpty()),
    () => (A.newSceneOpen.val ? NewSceneModal() : ctx.hole()),
    () => (A.palOpen.val ? PaletteDrawer() : ctx.hole()),
  );
}

function ArtEmpty() {
  return div(
    { class: "emptycenter" },
    div(
      { style: "max-width:680px;width:100%" },
      div({ style: "width:56px;height:56px;border-radius:14px;background:var(--accbg);display:flex;align-items:center;justify-content:center;font-size:24px;margin-bottom:18px;color:var(--acc-ink)" }, "▲"),
      h2({ style: "font-size:24px;margin:0 0 8px" }, "Author art the engine can load"),
      p(
        { style: "margin:0 0 22px;font-size:14.5px;color:var(--ink2);line-height:1.6" },
        "A scene is a JSON model of shapes (16-level grayscale, palette-remapped in game), sprites (timelines with frame labels) and exports (SymbolClass linkage names). The editor builds it into an uncompressed SWF v17 — the exact subset ",
        span({ class: "mono" }, "glaiel::swf"),
        " reads — and previews it with the real ",
        span({ class: "mono" }, "palette.png"),
        " rows.",
      ),
      div(
        { class: "grid2" },
        button({ class: "card plain", style: "text-align:left;cursor:pointer;color:var(--ink)", onclick: () => (A.newSceneOpen.val = true) }, div({ style: "font-weight:700;margin-bottom:4px" }, "+ New scene"), div({ style: "font-size:12.5px;color:var(--ink2)" }, "Starts from a bobbing gray square with two frame labels.")),
        DropZone("Import an SVG (Inkscape, VectorCraft, Illustrator) — creates a scene if none is open."),
      ),
      div(
        { style: "display:flex;gap:12px;align-items:center;margin-top:18px;flex-wrap:wrap" },
        button({ class: "btn ghost sm", onclick: () => ctx.openArtTour() }, "▲ Take the Art tour"),
        !ctx.S.mod.val ? span({ class: "muted", style: "font-size:12.5px" }, "No mod open — pick one from the top-bar mod switcher first.") : ctx.hole(),
        span({ class: "muted", style: "font-size:12.5px" }, "Plan and open items: docs/art-preview-plan.md"),
      ),
    ),
  );
}

/** @param {string} text */
function DropZone(text) {
  const fileInput = /** @type {HTMLInputElement} */ (
    input({
      type: "file",
      accept: ".svg,image/svg+xml",
      id: "art-svg-file",
      onchange: async (/** @type {Event} */ e) => {
        const f = /** @type {HTMLInputElement} */ (e.target).files;
        if (f && f[0]) await importIntoSceneOrNew(f[0]);
      },
    })
  );
  return label(
    {
      class: () => "dropzone" + (A.dropOver.val ? " over" : ""),
      for: "art-svg-file",
      ondragover: (/** @type {DragEvent} */ e) => {
        e.preventDefault();
        A.dropOver.val = true;
      },
      ondragleave: () => (A.dropOver.val = false),
      ondrop: async (/** @type {DragEvent} */ e) => {
        e.preventDefault();
        A.dropOver.val = false;
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) await importIntoSceneOrNew(f);
      },
    },
    div({ style: "font-weight:700;margin-bottom:4px;color:var(--ink)" }, "Import SVG"),
    div({ style: "font-size:12.5px" }, text),
    fileInput,
  );
}
/** @param {File} f */
async function importIntoSceneOrNew(f) {
  if (!/\.svg$/i.test(f.name)) return toast("only .svg files are importable here (PNG bitmaps are referenced from the scene JSON)");
  if (!A.scene) {
    if (!ctx.S.mod.val) return toast("open a mod first");
    const name = f.name.replace(/\.svg$/i, "").replace(/[^A-Za-z0-9_.-]/g, "_") || "art";
    const r = await ctx.postJson("/api/art/new-scene", { mod: ctx.S.mod.val, name, starter: false });
    if (!r.ok) return toast(`could not create scene: ${r.error}`);
    await loadArtForMod(ctx.S.mod.val);
    await openScene(r.relPath);
  }
  await importSvgFile(f);
}

function SceneTabBar() {
  return div(
    { class: "edtabbar" },
    div(
      { class: "filetab" },
      span({ class: "mono", style: "font-size:12.5px" }, A.scenePath.val.split("/").pop() || ""),
      button({ class: "x", "aria-label": "Close scene", onclick: () => { A.scenePath.val = ""; A.scene = null; bump(); } }, "✕"),
    ),
    span({ class: "pill append" }, "scene → .swf"),
    div({ class: "grow" }),
    () => (A.saved.val ? span({ class: "dotok", style: "font-size:12px" }, "● Saved") : span({ class: "muted", style: "font-size:12px" }, "● Unsaved")),
    button({ class: "btn ghost sm", onclick: () => saveScene(), disabled: () => !A.scene }, "Save scene"),
    button({ class: "btn primary sm", onclick: () => build(false), disabled: () => !A.scene, title: "Emit swfs/<name>.swf and swflist.gon.append" }, "Build SWF"),
  );
}

function ScenePanel() {
  const mk = (/** @type {string} */ id, /** @type {string} */ text) => button({ class: () => "btn sm ghost" + (A.subtab.val === id ? " on" : ""), onclick: () => (A.subtab.val = id) }, text);
  // Scoped so a bump() from an in-place edit repaints only the header counts and the
  // active tab — the shell (subtab bar) is built once per scene open, not per keystroke.
  return div(
    { class: "artpanel" },
    () => {
      if (!A.hasScene.val) return div(p({ class: "finding error" }, span({ class: "mark" }, "✕"), div(A.jsonError.val || "scene could not be parsed")), JsonTab());
      return div(
        () => {
          A.rev.val; // header counts track edits
          const sc = A.scene;
          if (!sc) return ctx.hole();
          return div(
            { class: "arthead" },
            h2(sc.name),
            span({ class: "meta" }, `${sc.frameRate || 60} fps · stage ${sc.stage ? sc.stage.width + "×" + sc.stage.height : "?"} · ${Object.keys(sc.shapes || {}).length} shapes · ${Object.keys(sc.sprites || {}).length} sprites · ${Object.keys(sc.exports || {}).length} exports`),
            div({ class: "grow" }),
            () => {
              const e = A.findings.val.filter((f) => f.severity === "error").length;
              const w = A.findings.val.filter((f) => f.severity === "warning").length;
              return span({ class: `pill ${e ? "err" : w ? "warn" : "ok"}`, style: "cursor:pointer", onclick: () => (A.rightTab.val = "findings") }, `● ${e} error${e === 1 ? "" : "s"} · ${w} warning${w === 1 ? "" : "s"}`);
            },
          );
        },
        div({ class: "subtabs" }, mk("overview", "Overview"), mk("shapes", "Shapes"), mk("sprites", "Sprites"), mk("exports", "Exports"), mk("json", "JSON")),
        () => {
          A.rev.val; // active tab tracks edits
          const t = A.subtab.val;
          if (!A.scene) return ctx.hole();
          if (t === "shapes") return ShapesTab();
          if (t === "sprites") return SpritesTab();
          if (t === "exports") return ExportsTab();
          if (t === "json") return JsonTab();
          return OverviewTab();
        },
      );
    },
  );
}

/**
 * @param {string} labelText @param {any} value @param {(v: string) => void} onChange @param {string} [cls]
 */
function Field(labelText, value, onChange, cls = "artinput") {
  const id = "f-" + labelText.replace(/\W+/g, "-") + "-" + Math.random().toString(36).slice(2, 7);
  return [
    label({ class: "k", for: id }, labelText),
    input({ id, class: cls, value: value ?? "", onchange: (/** @type {Event} */ e) => onChange(/** @type {HTMLInputElement} */ (e.target).value) }),
  ];
}

function OverviewTab() {
  const sc = A.scene;
  const num = (/** @type {string} */ v, /** @type {number} */ d) => (Number.isFinite(Number(v)) && v !== "" ? Number(v) : d);
  return div(
    div({ class: "card plain" },
      div({ class: "kv" },
        ...Field("name (→ swfs/<name>.swf)", sc.name, (v) => { sc.name = v; scheduleValidate(); bump(); }, "artinput mono"),
        ...Field("frameRate", sc.frameRate ?? 60, (v) => { sc.frameRate = num(v, 60); scheduleValidate(); }, "artinput num"),
        ...Field("stage width", sc.stage.width, (v) => { sc.stage.width = num(v, 1280); scheduleValidate(); }, "artinput num"),
        ...Field("stage height", sc.stage.height, (v) => { sc.stage.height = num(v, 720); scheduleValidate(); }, "artinput num"),
        ...Field("stage background", sc.stage.background ?? "#ffccff", (v) => { sc.stage.background = v; scheduleValidate(); }, "artinput mono"),
        ...Field("curveResolution (swflist per_file_curve_resolution)", sc.curveResolution ?? "", (v) => { if (v === "") delete sc.curveResolution; else sc.curveResolution = num(v, 1); scheduleValidate(); }, "artinput num"),
      ),
    ),
    div({ class: "artsec" }, span({ class: "sec" }, "Import")),
    DropZone("Drop an SVG here to add it as a shape (fills become gray levels; non-gray colours pass through and are flagged)."),
    div({ class: "artsec" }, span({ class: "sec" }, "How it ships")),
    div({ class: "card plain", style: "font-size:12.5px;color:var(--ink2);line-height:1.6" },
      "Build writes ", span({ class: "mono" }, `mods/${ctx.S.mod.val}/swfs/${sc.name}.swf`), " (FWS v17, DefineShape3 + DefineSprite + PlaceObject2 + SymbolClass",
      () => span({}, A.abc.val === "stub" ? " + a stub DoABC" : ", no DoABC"), ") and appends it to ", span({ class: "mono" }, "swfs/swflist.gon.append"),
      ". GON addresses your art by the export names. Whether a DoABC is required is the open gate test — see the Build tab.",
    ),
  );
}

function ShapesTab() {
  const sc = A.scene;
  const ids = Object.keys(sc.shapes || {});
  return div(
    div({ class: "artsec" }, span({ class: "sec" }, `Shapes (${ids.length}) — DefineShape3, one fill style per path`),
      label({ class: "muted", style: "font-size:12px;display:inline-flex;gap:6px;align-items:center" }, input({ type: "checkbox", checked: () => A.showGray.val, onchange: (/** @type {Event} */ e) => { A.showGray.val = /** @type {HTMLInputElement} */ (e.target).checked; if (pv) { pv.setShowGray(A.showGray.val); pv.render(); } bump(); } }), "show raw gray"),
    ),
    ...ids.map((id) => {
      const sh = sc.shapes[id];
      const use = shapeGrayUsage(sh);
      return div({ class: "artrow" },
        span({ class: "id" }, id),
        Ramp(use.levels),
        span({ class: "meta" }, `${(sh.paths || []).length} path${(sh.paths || []).length === 1 ? "" : "s"}${sh.source ? " · " + sh.source : ""}`),
        use.passthrough ? span({ class: "pill warn chip", title: "non-gray fills are NOT palette-remapped by the engine" }, `${use.passthrough} passthrough`) : ctx.hole(),
        use.bitmaps ? span({ class: "pill muted chip" }, `${use.bitmaps} bitmap`) : ctx.hole(),
        div({ class: "grow" }),
        button({ class: "btn ghost sm", onclick: () => setTarget(id) }, "Preview"),
        button({ class: "btn ghost sm", title: "Wrap this shape in a new 1-frame sprite", onclick: () => { let sid = id + "Clip"; let n = 2; while (sc.sprites[sid] || sc.shapes[sid]) sid = `${id}Clip${n++}`; sc.sprites[sid] = { frames: 1, labels: {}, layers: [{ name: id, depth: 1, keys: [{ frame: 0, ref: id, x: 0, y: 0 }] }] }; if (!Object.values(sc.exports).includes(sid)) sc.exports[sid] = sid; A.subtab.val = "sprites"; scheduleValidate(); bump(); } }, "→ Sprite"),
        button({ class: "btn ghost sm", style: "color:var(--err)", "aria-label": `Delete shape ${id}`, onclick: () => { delete sc.shapes[id]; scheduleValidate(); bump(); } }, "Delete"),
      );
    }),
    ids.length
      ? ctx.hole()
      : div(
          { class: "card plain", style: "padding:16px;color:var(--ink2)" },
          div({ style: "font-weight:700;color:var(--ink);margin-bottom:4px" }, "No shapes yet"),
          div({ style: "font-size:12.5px;line-height:1.6" }, "Import an SVG below (each SVG becomes one shape). Gray fills become 16-level ", span({ class: "mono" }, "gray:0–15"), " the engine recolors through a palette row; non-gray colours pass through and are flagged. Once a shape exists, wrap it in a sprite and Build the SWF."),
        ),
    div({ style: "margin-top:12px" }, DropZone("Drop an SVG to add a shape. Each SVG becomes one shape (many paths).")),
    ids.length ? PathEditor() : ctx.hole(),
  );
}

/** Per-path gray level editing for the selected shape (when the preview target is a shape). */
function PathEditor() {
  const sc = A.scene;
  const id = A.target.val;
  const sh = sc.shapes && sc.shapes[id];
  if (!sh) return p({ class: "muted", style: "margin-top:14px" }, "Click Preview on a shape to edit its paths' gray levels here.");
  return div(
    div({ class: "artsec" }, span({ class: "sec" }, `Paths of "${id}" — fill per path`)),
    ...(sh.paths || []).map((/** @type {any} */ pth, /** @type {number} */ i) => {
      const f = parseFill(pth.fill).fill;
      const sel = select(
        { class: "artinput mono", "aria-label": `fill of path ${i}`, onchange: (/** @type {Event} */ e) => { const v = /** @type {HTMLSelectElement} */ (e.target).value; pth.fill = v === "keep" ? pth.fill : v === "none" ? null : v; scheduleValidate(); bump(); } },
        ...Array.from({ length: 16 }, (_, n) => option({ value: `gray:${n}`, selected: f.kind === "gray" && f.level === n }, `gray:${n}`)),
        option({ value: "keep", selected: f.kind === "rgba" || f.kind === "bitmap" }, f.kind === "rgba" ? `${pth.fill} (passthrough)` : f.kind === "bitmap" ? pth.fill : "(custom)"),
        option({ value: "none", selected: f.kind === "none" }, "none"),
      );
      return div({ class: "artrow" },
        span({ class: "id" }, `#${i}`),
        span({ style: `width:18px;height:18px;border-radius:4px;background:${f.kind === "gray" ? rampColor(f.level) : f.kind === "rgba" ? pth.fill : "transparent"};border:1px solid var(--line2)` }),
        sel,
        span({ class: "meta mono", style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px" }, String(pth.d).slice(0, 60) + (String(pth.d).length > 60 ? "…" : "")),
        pth.stroke ? span({ class: "pill muted chip" }, `stroke ${pth.strokeWidth}px`) : ctx.hole(),
        div({ class: "grow" }),
        button({ class: "btn ghost sm", style: "color:var(--err)", "aria-label": `Delete path ${i}`, onclick: () => { sh.paths.splice(i, 1); scheduleValidate(); bump(); } }, "Delete"),
      );
    }),
  );
}

function SpritesTab() {
  const sc = A.scene;
  const ids = Object.keys(sc.sprites || {});
  const shapeIds = Object.keys(sc.shapes || {});
  return div(
    div({ class: "artsec" }, span({ class: "sec" }, `Sprites (${ids.length}) — DefineSprite timelines`),
      button({ class: "btn ghost sm", onclick: () => { let sid = "Sprite"; let n = 2; while (sc.sprites[sid] || sc.shapes[sid]) sid = `Sprite${n++}`; sc.sprites[sid] = { frames: 12, labels: { idle: 0 }, layers: [] }; scheduleValidate(); bump(); } }, "+ New sprite"),
    ),
    ...ids.map((id) => {
      const sp = sc.sprites[id];
      const baked = safeBake(sp);
      const labels = Object.entries(sp.labels || {}).map(([k, v]) => `${k}:${v}`).join(", ");
      return div({ class: "card plain" },
        div({ style: "display:flex;align-items:center;gap:10px;flex-wrap:wrap" },
          span({ class: "id mono", style: "font-weight:700" }, id),
          label({ class: "muted", style: "font-size:12px;display:inline-flex;gap:6px;align-items:center" }, "frames", input({ class: "artinput num", type: "number", min: 1, value: sp.frames, onchange: (/** @type {Event} */ e) => { sp.frames = Math.max(1, Number(/** @type {HTMLInputElement} */ (e.target).value) | 0); scheduleValidate(); bump(); } })),
          label({ class: "muted", style: "font-size:12px;display:inline-flex;gap:6px;align-items:center;flex:1" }, "labels", input({ class: "artinput mono", style: "flex:1", value: labels, placeholder: "idle:0, attack:6", onchange: (/** @type {Event} */ e) => { sp.labels = parseLabels(/** @type {HTMLInputElement} */ (e.target).value); scheduleValidate(); bump(); } })),
          button({ class: "btn ghost sm", onclick: () => setTarget(id) }, "Preview"),
          button({ class: "btn ghost sm", style: "color:var(--err)", "aria-label": `Delete sprite ${id}`, onclick: () => { delete sc.sprites[id]; for (const k of Object.keys(sc.exports)) if (sc.exports[k] === id) delete sc.exports[k]; scheduleValidate(); bump(); } }, "Delete"),
        ),
        div({ style: "margin-top:10px" },
          ...(sp.layers || []).map((/** @type {any} */ layer, /** @type {number} */ li) =>
            div({ class: "artrow" },
              span({ class: "id" }, layer.name || `(depth ${layer.depth})`),
              span({ class: "meta mono" }, `depth ${layer.depth}`),
              span({ class: "meta" }, `${(layer.keys || []).length} key${(layer.keys || []).length === 1 ? "" : "s"}: ${(layer.keys || []).map((/** @type {any} */ k) => `${k.frame}${k.ref ? "→" + k.ref : "→∅"}${k.tween === "linear" ? "~" : ""}`).join("  ")}`),
              layer.clip ? span({ class: "pill muted chip" }, `mask ≤${layer.clipDepth}`) : ctx.hole(),
              div({ class: "grow" }),
              button({ class: "btn ghost sm", style: "color:var(--err)", "aria-label": `Delete layer ${li}`, onclick: () => { sp.layers.splice(li, 1); scheduleValidate(); bump(); } }, "Delete"),
            ),
          ),
          div({ style: "display:flex;gap:8px;align-items:center;margin-top:6px" },
            span({ class: "muted", style: "font-size:12px" }, "+ layer from"),
            select({ class: "artinput", "aria-label": `add a layer to ${id}`, onchange: (/** @type {Event} */ e) => { const ref = /** @type {HTMLSelectElement} */ (e.target).value; if (!ref) return; const depth = Math.max(0, ...(sp.layers || []).map((/** @type {any} */ l) => l.depth)) + 1; sp.layers.push({ name: ref, depth, keys: [{ frame: 0, ref, x: 0, y: 0 }] }); /** @type {HTMLSelectElement} */ (e.target).value = ""; scheduleValidate(); bump(); } },
              option({ value: "" }, "shape or sprite…"),
              ...shapeIds.map((s) => option({ value: s }, s)),
              ...ids.filter((s) => s !== id).map((s) => option({ value: s }, s + " (sprite)")),
            ),
            span({ class: "muted", style: "font-size:11.5px" }, baked ? `${baked.frames} frames baked · ${baked.placements.reduce((n, f) => n + f.length, 0)} placements` : "invalid"),
            span({ class: "muted", style: "font-size:11.5px" }, "— keys are edited in the JSON tab (x y sx sy rot alpha tween)"),
          ),
        ),
      );
    }),
    ids.length ? ctx.hole() : p({ class: "muted" }, "No sprites. A sprite is what GON animates (frame labels like idle / attack)."),
  );
}
/** @param {any} sp */
function safeBake(sp) {
  try {
    return bakeSprite(sp);
  } catch {
    return null;
  }
}
/** @param {string} text */
function parseLabels(text) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const part of text.split(",")) {
    const m = /^\s*([^:\s]+)\s*:\s*(\d+)\s*$/.exec(part);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

function ExportsTab() {
  const sc = A.scene;
  const targets = [...Object.keys(sc.sprites || {}), ...Object.keys(sc.shapes || {})];
  let newName = "";
  let newRef = targets[0] || "";
  return div(
    div({ class: "artsec" }, span({ class: "sec" }, "Exports — SymbolClass linkage names GON can address")),
    p({ class: "muted", style: "margin:0 0 10px;font-size:12.5px;line-height:1.6" },
      "Vanilla GON refers to symbols by these strings (e.g. ", span({ class: "mono" }, '"rat.png"'), " → ", span({ class: "mono" }, "Rat"), "). To extend a vanilla clip use the ",
      span({ class: "mono" }, "_Append_<Clip>"), " convention (community-documented). You may export one sprite under several names.",
    ),
    ...Object.entries(sc.exports || {}).map(([name, ref]) =>
      div({ class: "artrow" },
        span({ class: "id" }, name),
        span({ class: "meta" }, "→"),
        span({ class: "mono", style: "font-size:12.5px" }, String(ref)),
        div({ class: "grow" }),
        button({ class: "btn ghost sm", style: "color:var(--err)", "aria-label": `Remove export ${name}`, onclick: () => { delete sc.exports[name]; scheduleValidate(); bump(); } }, "Remove"),
      ),
    ),
    div({ style: "display:flex;gap:8px;align-items:center;margin-top:8px" },
      input({ class: "artinput mono", placeholder: "linkage name (e.g. MyRat or myrat.png)", "aria-label": "new export linkage name", oninput: (/** @type {Event} */ e) => (newName = /** @type {HTMLInputElement} */ (e.target).value) }),
      select({ class: "artinput", "aria-label": "export target", onchange: (/** @type {Event} */ e) => (newRef = /** @type {HTMLSelectElement} */ (e.target).value) }, ...targets.map((t) => option({ value: t }, t))),
      button({ class: "btn sm", onclick: () => { if (!newName || !newRef) return; sc.exports[newName] = newRef; scheduleValidate(); bump(); } }, "+ Add export"),
    ),
  );
}

function JsonTab() {
  const text = A.scene ? JSON.stringify(A.scene, null, 2) : A.jsonText.val;
  const ta = /** @type {HTMLTextAreaElement} */ (textarea({ class: "scenejson", spellcheck: false, "aria-label": "scene JSON", value: text }));
  return div(
    div({ class: "artsec" }, span({ class: "sec" }, "Scene JSON — the whole source model (docs/art-preview-plan.md §2)"),
      button({ class: "btn primary sm", onclick: () => { try { const obj = JSON.parse(ta.value); A.scene = obj; A.jsonError.val = ""; scheduleValidate(); bump(); toast("JSON applied — validating"); } catch (e) { A.jsonError.val = String(e instanceof Error ? e.message : e); bump(); } } }, "Apply"),
    ),
    () => (A.jsonError.val ? div({ class: "finding error" }, span({ class: "mark" }, "✕"), div(A.jsonError.val)) : ctx.hole()),
    ta,
  );
}

function NewSceneModal() {
  let name = "";
  return div(
    { class: "scrim center", onclick: () => (A.newSceneOpen.val = false) },
    div(
      { class: "modal", onclick: (/** @type {MouseEvent} */ e) => e.stopPropagation() },
      div({ class: "mhead" }, span({ style: "font-size:18px" }, "＋"), div({ class: "t" }, "New art scene"), button({ class: "iconbtn", "aria-label": "Close", onclick: () => (A.newSceneOpen.val = false) }, "✕")),
      div({ class: "mbody" },
        p({ class: "muted", style: "margin:0 0 6px" }, `Creates mods/${ctx.S.mod.val}/art/<name>.scene.json from the starter (a bobbing gray square with idle/blink labels).`),
        label({ class: "fld", for: "newscene-name" }, "scene name (→ swfs/<name>.swf)"),
        input({ id: "newscene-name", class: "mono", placeholder: "my_rat", oninput: (/** @type {Event} */ e) => (name = /** @type {HTMLInputElement} */ (e.target).value), onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === "Enter" && name) newScene(name); } }),
      ),
      div({ class: "mfoot" }, div({ class: "grow" }), button({ class: "btn ghost", onclick: () => (A.newSceneOpen.val = false) }, "Cancel"), button({ class: "btn primary", onclick: () => name && newScene(name) }, "Create")),
    ),
  );
}

// ---- right panel: Preview | Findings | Build --------------------------------------
export function ArtRightPanel() {
  const mk = (/** @type {string} */ id, /** @type {string} */ text) => button({ class: () => "tab" + (A.rightTab.val === id ? " active" : ""), onclick: () => (A.rightTab.val = id) }, text);
  return div(
    { class: "rightpanel" },
    div({ class: "tabs" }, mk("preview", "Preview"), mk("findings", "Findings"), mk("build", "Build")),
    div({ class: "panelbody" }, () => {
      const t = A.rightTab.val;
      if (t === "findings") return FindingsPanel();
      if (t === "build") return BuildPanel();
      return PreviewPanel();
    }),
  );
}

function FindingsPanel() {
  // Returned from ArtRightPanel's panelbody binding, so this must be a DOM node, not a
  // bare function (van stringifies a function a binding returns). The reactive body is a
  // bound child of the wrapper div — the same pattern PreviewPanel uses.
  return div(() => {
    const list = A.findings.val;
    if (!A.scene) return p({ class: "muted" }, "Open a scene to see findings.");
    const e = list.filter((f) => f.severity === "error").length;
    const w = list.filter((f) => f.severity === "warning").length;
    const level = e ? "err" : w ? "warn" : "ok";
    return div(
      div({ class: `summary ${level}` }, div({ class: "badge" }, level === "ok" ? "✓" : "!"), div(div({ class: "t" }, e ? `${e} error${e === 1 ? "" : "s"}` : w ? `${w} warning${w === 1 ? "" : "s"}` : "Scene is buildable"), div({ class: "d" }, `${e} errors · ${w} warnings · ${list.length - e - w} info`))),
      div({ style: "margin-top:14px" }, list.length ? list.map(FindingRow) : p({ class: "dotok" }, "No findings.")),
    );
  });
}

function BuildPanel() {
  // Same fix as FindingsPanel: return a DOM node (wrapper div with a bound child), because
  // ArtRightPanel's panelbody binding renders a returned bare function as literal text.
  return div(() => {
    const r = A.buildResult.val;
    const ins = A.inspect.val;
    return div(
      div({ class: "sec", style: "margin-bottom:8px" }, "Emit"),
      div({ class: "card plain" },
        div({ style: "font-size:12.5px;color:var(--ink2);line-height:1.6;margin-bottom:8px" }, "Every vanilla file carries one Flash-generated DoABC. Whether the engine needs it to bind SymbolClass names is the open gate test (plan §7). Build both ways and run the dev-save procedure."),
        div({ class: "pvrow" },
          label(input({ type: "radio", name: "abcmode", checked: () => A.abc.val === "none", onchange: () => (A.abc.val = "none") }), "no DoABC"),
          label(input({ type: "radio", name: "abcmode", checked: () => A.abc.val === "stub", onchange: () => (A.abc.val = "stub") }), "stub DoABC (Flash-faithful linkage classes)"),
        ),
        div({ style: "display:flex;gap:8px;margin-top:10px;flex-wrap:wrap" },
          button({ class: "btn primary sm", disabled: () => !A.scene, onclick: () => build(false) }, "Build SWF"),
          button({ class: "btn sm", disabled: () => !A.scene, onclick: () => build(true) }, "Dry run"),
          button({ class: "btn ghost sm", title: "Writes the two gate-test SWFs + swflist candidates into mods/dev-sandbox/swfs/", onclick: async () => { const g = await ctx.postJson("/api/art/prepare-abc-gate", { mod: "dev-sandbox" }); toast(g.ok ? `gate fixtures written: ${g.written.length} files (see plan §7.2)` : `failed: ${g.error}`); } }, "Prepare gate test"),
        ),
      ),
      !r && !ins
        ? div({ class: "card plain", style: "color:var(--ink2);font-size:12.5px;line-height:1.6" }, span({ class: "muted" }, "Nothing built yet. "), A.scene ? "Click Build SWF to emit mods/" + ctx.S.mod.val + "/swfs/" + ((A.scene && A.scene.name) || "<name>") + ".swf (self-checked with the verification reader) and append it to swflist.gon.append." : "Open a scene, then build it.")
        : ctx.hole(),
      r ? div(
        div({ class: "sec", style: "margin:14px 0 8px" }, r.ok ? (r.dryRun ? "Dry run" : "Built") : "Build failed"),
        div({ class: `summary ${r.ok ? "ok" : "err"}` }, div({ class: "badge" }, r.ok ? "✓" : "✕"), div(div({ class: "t" }, r.ok ? `${r.bytes} bytes · DoABC ${r.abc}` : r.error || "error"), div({ class: "d" }, r.swfPath || ""))),
        r.report ? div({ class: "card", style: "margin-top:10px" },
          div({ class: "kv" },
            span({ class: "k" }, "frames"), span(String(r.report.frameCount)),
            span({ class: "k" }, "characters"), span(String((r.report.characters || []).length)),
            span({ class: "k" }, "exports"), span((r.report.exports || []).map((/** @type {any} */ e) => `${e.name}→#${e.id}`).join(", ") || "(none)"),
            span({ class: "k" }, "tags"), span(histogramText(r.report.tags || [])),
          ),
        ) : ctx.hole(),
        r.swflist && r.swflist.ok ? div({ class: "card", style: "margin-top:10px" }, div({ class: "sec", style: "margin-bottom:6px" }, r.swflist.path), pre(r.swflist.text)) : ctx.hole(),
        (r.findings || []).length ? div({ style: "margin-top:10px" }, ...r.findings.map(FindingRow)) : ctx.hole(),
      ) : ctx.hole(),
      ins ? div(
        div({ class: "sec", style: "margin:14px 0 8px" }, `Inspect · ${ins.relPath}`),
        ins.ok ? div({ class: "card" },
          div({ class: "kv" },
            span({ class: "k" }, "header"), span({ class: "mono", style: "font-size:12px" }, `${ins.header.signature} v${ins.header.version} · ${ins.bytes} B · ${ins.header.frameRate} fps · ${ins.header.frameCount} frames`),
            span({ class: "k" }, "DoABC"), span(String(ins.doAbc)),
            span({ class: "k" }, "exports"), span((ins.exports || []).map((/** @type {any} */ e) => `${e.name}→#${e.id}`).join(", ") || "(none)"),
            span({ class: "k" }, "labels"), span((ins.labels || []).join(", ") || "(none)"),
            span({ class: "k" }, "tags"), span(Object.entries(ins.histogram || {}).map(([k, v]) => `${k}×${v}`).join(" ")),
          ),
        ) : div({ class: "finding error" }, span({ class: "mark" }, "✕"), div(ins.error)),
      ) : ctx.hole(),
    );
  });
}
/** @param {string} text */
function pre(text) {
  const el = /** @type {HTMLElement} */ (van.tags.pre({ class: "mergecode" }));
  el.textContent = text;
  return el;
}
/** @param {any[]} tags */
function histogramText(tags) {
  /** @type {Record<string, number>} */
  const h = {};
  for (const t of tags) h[t.name] = (h[t.name] || 0) + 1;
  return Object.entries(h).map(([k, v]) => `${k}×${v}`).join(" ");
}

function PreviewPanel() {
  // mount: the canvas element is persistent; the renderer is created once
  const box = div({ class: "pvcanvasbox" }, pvCanvas, () => span({ class: "pvstatus" }, `${A.backend.val || "…"}${pvStatus.val ? " · " + pvStatus.val : ""}`));
  queueMicrotask(() => {
    const p = ensurePreview();
    p.resize();
    pushSceneToPreview();
    p.render();
  });
  return div(
    { class: "pvwrap" },
    () => {
      if (!A.scene) return p({ class: "muted", style: "margin:0" }, "Open a scene to preview it as the engine draws it: 16-level gray → palette.png row.");
      const targets = pv ? pv.getTargets() : [];
      return div({ class: "pvrow" },
        label({ for: "pv-target" }, "target"),
        select({ id: "pv-target", class: "artinput", onchange: (/** @type {Event} */ e) => setTarget(/** @type {HTMLSelectElement} */ (e.target).value) },
          ...targets.map((/** @type {any} */ t) => option({ value: t.id, selected: t.id === A.target.val }, `${t.id}${t.kind === "sprite" ? ` (${t.frames}f)` : t.kind === "stage" ? " (main timeline)" : ""}`)),
        ),
        div({ class: "grow" }),
        button({ class: "btn ghost sm", onclick: () => { if (pv) { pv.setZoom("fit"); pv.render(); } } }, "Fit"),
      );
    },
    box,
    Transport(),
    Scrubber(),
    LabelChips(),
    PaletteRow(),
  );
}

function Transport() {
  const play = () => { const p = ensurePreview(); if (p.isPlaying()) { p.pause(); A.playing.val = false; } else { p.play(); A.playing.val = true; } };
  return div({ class: "transport" },
    button({ class: "btn ghost sm", "aria-label": "First frame", onclick: () => { const p = ensurePreview(); p.setFrame(0); A.frame.val = 0; p.render(); } }, "|◀"),
    button({ class: "btn ghost sm", "aria-label": "Previous frame", onclick: () => { const p = ensurePreview(); p.step(-1); A.frame.val = p.getFrame(); p.render(); } }, "◀"),
    button({ class: "btn primary sm", "aria-label": () => (A.playing.val ? "Pause" : "Play"), style: "min-width:64px;justify-content:center", onclick: play }, () => (A.playing.val ? "Pause" : "Play")),
    button({ class: "btn ghost sm", "aria-label": "Next frame", onclick: () => { const p = ensurePreview(); p.step(1); A.frame.val = p.getFrame(); p.render(); } }, "▶"),
    span({ class: "frame" }, () => `${A.frame.val + 1} / ${A.frames.val}`),
    div({ class: "grow" }),
    label({ style: "display:inline-flex;gap:6px;align-items:center;font-size:12px;color:var(--ink2)" }, input({ type: "checkbox", checked: () => A.loop.val, onchange: (/** @type {Event} */ e) => { A.loop.val = /** @type {HTMLInputElement} */ (e.target).checked; ensurePreview().setLoop(A.loop.val); } }), "loop"),
  );
}

function Scrubber() {
  return div({ class: "scrub" },
    input({
      type: "range", min: 0, max: () => Math.max(0, A.frames.val - 1), value: () => A.frame.val, step: 1, "aria-label": "Frame scrubber",
      oninput: (/** @type {Event} */ e) => { const f = Number(/** @type {HTMLInputElement} */ (e.target).value); const p = ensurePreview(); p.pause(); A.playing.val = false; p.setFrame(f); A.frame.val = f; p.render(); },
    }),
    () => {
      const n = Math.max(1, A.frames.val);
      const labels = pv && A.scene ? pv.getLabels() : [];
      return div({ class: "ticks" }, ...labels.map((/** @type {any} */ l) => span({ title: `${l.label} @ ${l.frame}`, style: `left:${n > 1 ? (l.frame / (n - 1)) * 100 : 0}%` })));
    },
  );
}

function LabelChips() {
  return () => {
    const labels = pv && A.scene ? pv.getLabels() : [];
    if (!labels.length) return ctx.hole();
    return div({ class: "labelchips" }, ...labels.map((/** @type {any} */ l) => button({ class: "btn ghost sm", title: `go to frame ${l.frame}`, onclick: () => { const p = ensurePreview(); p.gotoLabel(l.label); A.frame.val = p.getFrame(); p.render(); } }, `${l.label} · ${l.frame}`)));
  };
}

function PaletteRow() {
  return () => {
    const pal = A.palette.val;
    return div({ class: "card plain", style: "margin:0" },
      div({ style: "display:flex;align-items:center;gap:8px;margin-bottom:8px" },
        span({ class: "sec", style: "flex:1" }, "Palette row"),
        label({ for: "pv-row", class: "muted", style: "font-size:12px" }, "palette N"),
        input({ id: "pv-row", class: "artinput num", type: "number", min: 0, max: 255, value: () => A.row.val, onchange: (/** @type {Event} */ e) => setRow(Number(/** @type {HTMLInputElement} */ (e.target).value)) }),
        button({ class: "btn ghost sm", onclick: () => (A.palOpen.val = true) }, "Browse rows…"),
      ),
      div({ class: "ramp big", role: "list", "aria-label": "16-colour ramp of the selected palette row" }, ...Array.from({ length: 16 }, (_, i) => span({ role: "listitem", title: `gray:${i}`, style: `background:${rampColor(i)}` }))),
      div({ style: "display:flex;gap:10px;align-items:center;margin-top:8px;font-size:12px;color:var(--muted);flex-wrap:wrap" },
        pal && pal.ok ? span(`${pal.source} · ${pal.rows.length} rows${pal.hints && pal.hints[A.row.val] ? " · " + pal.hints[A.row.val] : ""}`) : span({ class: "warn" }, pal ? `${pal.error || "palette unavailable"} — identity ramp shown. ${pal.hint || ""}` : "loading palette…"),
        label({ style: "display:inline-flex;gap:6px;align-items:center" }, input({ type: "checkbox", checked: () => A.showGray.val, onchange: (/** @type {Event} */ e) => { A.showGray.val = /** @type {HTMLInputElement} */ (e.target).checked; const p = ensurePreview(); p.setShowGray(A.showGray.val); p.render(); bump(); } }), "show raw gray"),
        label({ style: "display:inline-flex;gap:6px;align-items:center" }, "background", select({ class: "artinput", "aria-label": "preview background", onchange: (/** @type {Event} */ e) => { const v = /** @type {HTMLSelectElement} */ (e.target).value; const p = ensurePreview(); p.setBackground(v === "stage" ? (A.scene && A.scene.stage && A.scene.stage.background) || "#ffccff" : v === "none" ? null : v); p.render(); } }, option({ value: "checker" }, "checker"), option({ value: "stage" }, "stage colour"), option({ value: "#000000" }, "black"), option({ value: "#ffffff" }, "white"))),
      ),
    );
  };
}
/** @param {number} n */
function setRow(n) {
  const row = Math.max(0, Math.min(255, n | 0));
  A.row.val = row;
  if (A.scene) {
    A.scene.preview = A.scene.preview || {};
    A.scene.preview.palette = row;
    A.saved.val = false;
  }
  const p = ensurePreview();
  p.setPaletteRow(row);
  p.render();
  bump();
}

function PaletteDrawer() {
  const pal = A.palette.val;
  let filter = "";
  const list = van.state(0);
  return div(
    { class: "scrim right", onclick: () => (A.palOpen.val = false) },
    div(
      { class: "drawer", style: "width:min(620px,96vw)", onclick: (/** @type {MouseEvent} */ e) => e.stopPropagation() },
      div({ class: "dhead" }, div({ class: "t" }, "palette.png rows"), span({ class: "pill muted" }, pal && pal.ok ? pal.source : "identity ramp"), button({ class: "iconbtn", "aria-label": "Close", onclick: () => (A.palOpen.val = false) }, "✕")),
      div({ class: "dbody" },
        div({ class: "search", style: "margin:0 0 12px" }, span({ "aria-hidden": "true" }, "⌕"), input({ placeholder: "filter by row number or hint (Fighter, random cat…)", "aria-label": "filter palette rows", oninput: (/** @type {Event} */ e) => { filter = /** @type {HTMLInputElement} */ (e.target).value.toLowerCase(); list.val++; } })),
        p({ class: "muted", style: "margin:0 0 12px;font-size:12.5px" }, "One shared table for cats, abilities and UI: rows 0–48 random cats, ~49–145 classes/named cats; ~150 rows are free. Pick a row to preview with."),
        () => {
          list.val;
          const rows = pal ? pal.rows : [];
          const hints = (pal && pal.hints) || {};
          return div({ class: "palgrid" },
            ...rows.flatMap((/** @type {any[]} */ row, /** @type {number} */ i) => {
              const hint = hints[i] || "";
              if (filter && !(String(i).includes(filter) || hint.toLowerCase().includes(filter))) return [];
              const cur = i === A.row.val;
              return [
                button({ class: "rowpick" + (cur ? " cur" : ""), "aria-label": `use palette row ${i}`, onclick: () => { setRow(i); A.palOpen.val = false; } },
                  span({ class: "r" }, String(i)),
                  div({ class: "ramp" }, ...row.map((/** @type {number[]} */ c) => span({ style: `background:rgb(${c[0]},${c[1]},${c[2]})` }))),
                  span({ class: "hint" }, hint),
                ),
              ];
            }),
          );
        },
      ),
    ),
  );
}

void b;
