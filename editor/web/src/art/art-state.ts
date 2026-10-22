// Art mode state + actions (was the `A` object, `ctx` and the module-level functions of
// art-ui.mjs). The scene itself is a plain object edited in place; `rev` is bumped after
// each edit so components that read it re-render, and `hasScene` mirrors `scene != null`
// so the scene-panel shell only remounts when a scene opens or closes (not per keystroke).
// The preview renderer (web/src/art/preview-gl.ts) is created once, lazily, on a single
// persistent canvas that the Preview panel mounts; it suspends/resumes itself when that
// canvas leaves/re-enters the document (IntersectionObserver inside createPreview).

import { createStore } from "../store.ts";
import { S, toast } from "../state.ts";
import { getJson, post, url } from "../api.ts";
import { createPreview, type Preview } from "./preview-gl.ts";
import { grayLevelToByte } from "../../../src/core/art/scene.ts";
import { adoptGradients } from "../../../src/core/art/gradient.ts";
import { shapeToSvg } from "../../../src/core/art/svg-export.ts";
import { parseViewBox, reoriginSvg } from "../../../src/core/art/svg-reorigin.ts";
import type {
  AbcMode,
  ArtAssets,
  ArtRightTab,
  ArtScenesResponse,
  ArtSubtab,
  BuildResponse,
  Finding,
  ImportSvgResponse,
  InspectResponse,
  NewSceneResponse,
  PaletteResponse,
  Scene,
  SceneListing,
  SceneReadResponse,
  SceneValidateResponse,
  SceneWriteResponse,
  SwfListing,
} from "./types.ts";

export interface ArtState {
  scenes: SceneListing[];
  swfs: SwfListing[];
  assets: ArtAssets;
  scenePath: string;
  rev: number;
  hasScene: boolean;
  saved: boolean;
  findings: Finding[];
  subtab: ArtSubtab;
  rightTab: ArtRightTab;
  abc: AbcMode;
  buildResult: BuildResponse | null;
  inspect: InspectResponse | null;
  palette: PaletteResponse | null;
  palOpen: boolean;
  newSceneOpen: boolean;
  // preview controls
  target: string;
  frame: number;
  frames: number;
  playing: boolean;
  loop: boolean;
  showGray: boolean;
  row: number;
  backend: string;
  pvStatus: string;
  jsonText: string;
  jsonError: string;
  dropOver: boolean;
  // VectorCraft tab: the shape it targets and a counter bumped by every "Open in VectorCraft" request
  vcShape: string;
  vcRequest: number;
}

export const A = createStore<ArtState>({
  scenes: [],
  swfs: [],
  assets: { svgs: [], pngs: [], swflistAppend: null },
  scenePath: "",
  rev: 0,
  hasScene: false,
  saved: true,
  findings: [],
  subtab: "overview",
  rightTab: "preview",
  abc: "none",
  buildResult: null,
  inspect: null,
  palette: null,
  palOpen: false,
  newSceneOpen: false,
  target: "stage",
  frame: 0,
  frames: 1,
  playing: false,
  loop: true,
  showGray: false,
  row: 54,
  backend: "",
  pvStatus: "",
  jsonText: "",
  jsonError: "",
  dropOver: false,
  vcShape: "",
  vcRequest: 0,
});

/** The open scene, edited in place; read `A.rev` from a component to track edits. */
let scene: Scene | null = null;
export function getScene(): Scene | null {
  return scene;
}
export function setScene(next: Scene | null): void {
  scene = next;
}

/** A scene as the zod body schemas want it (they take any object). */
export function sceneBody(sc: Scene): Record<string, unknown> {
  return sc as unknown as Record<string, unknown>;
}

export function bump(): void {
  A.set((a) => ({ rev: a.rev + 1, hasScene: scene != null }));
}

function mod(): string {
  return S.get().mod;
}

// ---- onboarding hooks (driven from the Help menu / art worked example) ----------------
/** Open the "New art scene" dialog (used by the art worked example). */
export function openNewSceneModal(): void {
  A.set({ newSceneOpen: true });
}
/** Jump the center Art panel to a sub-tab (overview | shapes | sprites | exports | json). */
export function setArtSubtab(tab: string): void {
  A.set({ subtab: tab as ArtSubtab });
}
/** Jump the right Art panel to a tab (preview | findings | build). */
export function setArtRightTab(tab: string): void {
  A.set({ rightTab: tab as ArtRightTab });
}

/** Window-resize → re-fit the preview, rAF-batched and only while the preview canvas is on-screen. */
export function initArtUi(): void {
  if (typeof window === "undefined") return;
  let resizeRaf = 0;
  window.addEventListener(
    "resize",
    () => {
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        if (pv && S.get().artMode && A.get().rightTab === "preview") pv.resize();
      });
    },
    { passive: true },
  );
}

// ---- data loading -------------------------------------------------------------------
export async function loadArtForMod(modName: string): Promise<void> {
  A.set({ scenePath: "", findings: [], buildResult: null, inspect: null });
  scene = null;
  if (!modName) {
    A.set({ scenes: [], swfs: [] });
    bump();
    return;
  }
  const r = await getJson<ArtScenesResponse>(url("/api/art/scenes", { mod: modName }));
  A.set({
    scenes: r.scenes || [],
    swfs: r.swfs || [],
    assets: { svgs: r.svgs || [], pngs: r.pngs || [], swflistAppend: r.swflistAppend || null },
  });
  if (!A.get().palette) {
    try {
      const pal = await getJson<PaletteResponse>("/api/art/palette");
      A.set({ palette: pal });
      if (pal && pal.defaultAbc) A.set({ abc: pal.defaultAbc });
      if (pv) pv.setPalette(pal && pal.ok ? pal.rows : null);
    } catch {
      /* preview falls back to the identity ramp */
    }
  }
  bump();
}

export async function openScene(relPath: string): Promise<void> {
  const r = await getJson<SceneReadResponse>(url("/api/art/scene", { mod: mod(), path: relPath }));
  A.set({ scenePath: relPath, findings: r.findings || [], buildResult: null });
  if (r.scene) {
    scene = r.scene;
  } else {
    // unparseable JSON: still open it in the JSON tab so it can be repaired
    scene = null;
    A.set({ subtab: "json", jsonText: r.text || "", jsonError: r.error || "could not read scene" });
  }
  A.set({ saved: true, subtab: scene ? "overview" : "json" });
  if (scene) {
    const sc = scene;
    if (sc.preview && typeof sc.preview.palette === "number") A.set({ row: sc.preview.palette });
    pickDefaultTarget();
    pushSceneToPreview();
  }
  bump();
}

export function closeScene(): void {
  A.set({ scenePath: "" });
  scene = null;
  bump();
}

function pickDefaultTarget(): void {
  if (!scene) return;
  const sprites = Object.keys(scene.sprites || {});
  const hasStage = (scene.stage_instances || []).length > 0;
  A.set({ target: hasStage ? "stage" : sprites[0] || Object.keys(scene.shapes || {})[0] || "stage" });
}

let liveTimer: ReturnType<typeof setTimeout> | undefined;
/** Mark the scene dirty and re-validate it after a 300 ms quiet period. */
export function scheduleValidate(): void {
  A.set({ saved: false });
  if (liveTimer) clearTimeout(liveTimer);
  liveTimer = setTimeout(runValidate, 300);
}
async function runValidate(): Promise<void> {
  if (!scene) return;
  const r = await post<"/api/art/validate", SceneValidateResponse>("/api/art/validate", { scene: sceneBody(scene) });
  A.set({ findings: r.findings || [] });
  pushSceneToPreview(r.scene);
  bump();
}

export async function saveScene(): Promise<void> {
  if (!scene || !A.get().scenePath) return;
  const r = await post<"/api/art/scene", SceneWriteResponse>("/api/art/scene", { mod: mod(), path: A.get().scenePath, scene: sceneBody(scene), force: true });
  if (r.ok) {
    A.set({ saved: true });
    toast(`saved ${r.path} (${r.bytes} bytes${r.valid ? "" : " — has errors"})`);
    A.set({ findings: r.findings || A.get().findings });
  } else toast(`save refused: ${r.error}`);
}

export async function newScene(name: string): Promise<void> {
  const r = await post<"/api/art/new-scene", NewSceneResponse>("/api/art/new-scene", { mod: mod(), name, starter: true });
  if (!r.ok) return toast(`could not create scene: ${r.error}`);
  A.set({ newSceneOpen: false });
  await loadArtForMod(mod());
  await openScene(r.relPath);
  toast(`created ${r.path}`);
}

export async function build(dryRun = false): Promise<void> {
  if (!scene || !A.get().scenePath) return;
  const r = await post<"/api/art/build", BuildResponse>("/api/art/build", { mod: mod(), path: A.get().scenePath, scene: sceneBody(scene), abc: A.get().abc, dryRun });
  A.set({ buildResult: r, rightTab: "build" });
  if (r.ok) {
    toast(dryRun ? `dry run ok: ${r.bytes} bytes` : `built ${r.swfPath} (${r.bytes} bytes, DoABC: ${r.abc})`);
    if (!dryRun) await loadArtForMod(mod());
  } else toast(`build failed: ${r.error}`);
}

export async function inspectSwf(relPath: string): Promise<void> {
  const r = await getJson<Omit<InspectResponse, "relPath">>(url("/api/art/inspect-swf", { mod: mod(), path: relPath }));
  A.set({ inspect: { relPath, ...r }, rightTab: "build" });
}

/**
 * Import an SVG file (from a drop / file picker) as a new shape, and keep the SVG in
 * the mod's art/ folder for provenance.
 */
export async function importSvgFile(file: File): Promise<void> {
  if (!scene) return toast("open or create a scene first");
  const sc = scene;
  const text = await file.text();
  const base = file.name.replace(/\.svg$/i, "").replace(/[^A-Za-z0-9_]/g, "_") || "shape";
  let id = base;
  let n = 2;
  while (sc.shapes[id] || (sc.sprites && sc.sprites[id])) id = `${base}_${n++}`;
  const rel = `art/${file.name.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
  const r = await post<"/api/art/import-svg", ImportSvgResponse>("/api/art/import-svg", { svgText: text, options: {} });
  if (!r.ok) {
    A.set((a) => ({ findings: [...(r.findings || []), ...a.findings] }));
    return toast(`import failed: ${r.error || "see findings"}`);
  }
  sc.shapes[id] = { ...adoptGradients(sc, r.shape, r.gradients), source: rel };
  try {
    const b64 = btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())));
    await post("/api/art/asset", { mod: mod(), path: rel, base64: b64 });
  } catch {
    /* provenance copy is best-effort */
  }
  A.set((a) => ({
    findings: [...(r.findings || []).map((f) => ({ ...f, path: `shapes.${id}` })), ...a.findings],
    subtab: "shapes",
    target: id,
  }));
  toast(`imported ${file.name} as shape "${id}" (${r.shape.paths.length} paths)`);
  scheduleValidate();
  bump();
}

/**
 * Write one shape of the open scene (unsaved edits included) as art/<id>.svg in the mod, for an external vector editor
 * (VectorCraft, Inkscape, …: static drawing; animation stays in this editor's timeline).
 */
export async function exportShapeSvgFile(id: string): Promise<void> {
  const sc = scene;
  if (!sc || !sc.shapes[id]) return toast(`no shape "${id}"`);
  const out = shapeToSvg(sc.shapes[id]!, sc.gradients || {});
  const rel = `art/${id.replace(/[^A-Za-z0-9_.-]/g, "_")}.svg`;
  const bytes = new TextEncoder().encode(out.svg);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const r = await post<"/api/art/asset", { ok: boolean; error?: string }>("/api/art/asset", { mod: mod(), path: rel, base64: btoa(bin) });
  if (!r.ok) return toast(`export failed: ${r.error || "?"}`);
  if (out.findings.length) A.set((a) => ({ findings: [...out.findings.map((f) => ({ ...f, path: `shapes.${id}` })), ...a.findings] }));
  toast(`wrote mods/${mod()}/${rel} — edit it in VectorCraft or any SVG editor, then Replace… brings it back`);
}

/** An edited SVG replaces shape `id` in place (viewBox not applied, so the exported coordinates come back unchanged). */
export async function replaceShapeFromSvg(id: string, file: File): Promise<void> {
  const sc = scene;
  if (!sc || !sc.shapes[id]) return toast(`no shape "${id}"`);
  const r = await post<"/api/art/import-svg", ImportSvgResponse>("/api/art/import-svg", { svgText: await file.text(), options: { applyViewBox: false } });
  if (!r.ok) {
    A.set((a) => ({ findings: [...(r.findings || []), ...a.findings] }));
    return toast(`replace failed: ${r.error || "see findings"}`);
  }
  const prev = sc.shapes[id]!;
  sc.shapes[id] = { ...adoptGradients(sc, r.shape, r.gradients), ...(prev.source ? { source: prev.source } : {}) };
  scheduleValidate();
  bump();
  toast(`replaced shape "${id}" from ${file.name} (${r.shape.paths.length} paths)`);
}

// ---- VectorCraft tab (web/src/art/VectorcraftPanel.tsx) -----------------------------------------------------
/** A shape as the SVG the exporter writes plus its viewBox (what the re-origin undo needs later). */
export function shapeSvgFor(id: string): { svg: string; viewBox: number[] } | null {
  const sc = scene;
  if (!sc || !sc.shapes[id]) return null;
  const out = shapeToSvg(sc.shapes[id]!, sc.gradients || {});
  const viewBox = parseViewBox(out.svg);
  return viewBox ? { svg: out.svg, viewBox } : null;
}

/** "Open in VectorCraft" (a Shapes row or the tab's Open button): switch to the tab and ask it to open the shape. */
export function openShapeInVectorcraft(id: string): void {
  if (!scene || !scene.shapes[id]) return toast(`no shape "${id}"`);
  A.set((a) => ({ subtab: "vectorcraft", vcShape: id, vcRequest: a.vcRequest + 1 }));
}

/** VectorCraft's exported SVG replaces shape `id` in place after the artboard re-origin is undone (in memory; Save scene writes it). */
export async function applyVectorcraftSvg(id: string, exportedSvg: string, originalViewBox: number[]): Promise<void> {
  const sc = scene;
  if (!sc || !sc.shapes[id]) return toast(`no shape "${id}"`);
  const re = reoriginSvg(exportedSvg, originalViewBox);
  const r = await post<"/api/art/import-svg", ImportSvgResponse>("/api/art/import-svg", { svgText: re.svg, options: { applyViewBox: false } });
  if (!r.ok) {
    A.set((a) => ({ findings: [...(r.findings || []), ...a.findings] }));
    return toast(`apply failed: ${r.error || "see findings"}`);
  }
  const prev = sc.shapes[id]!;
  sc.shapes[id] = { ...adoptGradients(sc, r.shape, r.gradients), ...(prev.source ? { source: prev.source } : {}) };
  if (r.findings && r.findings.length) A.set((a) => ({ findings: [...r.findings.map((f) => ({ ...f, path: `shapes.${id}` })), ...a.findings] }));
  scheduleValidate();
  bump();
  toast(`applied VectorCraft's drawing to shape "${id}" (${r.shape.paths.length} paths${re.dx || re.dy ? `, re-origined by ${re.dx},${re.dy}` : ""})`);
}

/** Drop / file-picker entry: an SVG becomes a shape of the open scene, or of a new scene if none is open. */
export async function importIntoSceneOrNew(f: File): Promise<void> {
  if (!/\.svg$/i.test(f.name)) return toast("only .svg files are importable here (PNG bitmaps are referenced from the scene JSON)");
  if (!scene) {
    if (!mod()) return toast("open a mod first");
    const name = f.name.replace(/\.svg$/i, "").replace(/[^A-Za-z0-9_.-]/g, "_") || "art";
    const r = await post<"/api/art/new-scene", NewSceneResponse>("/api/art/new-scene", { mod: mod(), name, starter: false });
    if (!r.ok) return toast(`could not create scene: ${r.error}`);
    await loadArtForMod(mod());
    await openScene(r.relPath);
  }
  await importSvgFile(f);
}

// ---- preview (wraps web/src/art/preview-gl.ts) -------------------------------------------
let pv: Preview | null = null;
/** The one persistent canvas the Preview panel mounts (created lazily; null outside a browser). */
let pvCanvas: HTMLCanvasElement | null = null;
export function previewCanvas(): HTMLCanvasElement {
  if (!pvCanvas) {
    pvCanvas = document.createElement("canvas");
    pvCanvas.setAttribute("aria-label", "In-game-faithful preview of the selected sprite");
    pvCanvas.setAttribute("role", "img");
  }
  return pvCanvas;
}
/** The renderer, if it has been created (the Preview panel creates it on first mount). */
export function getPreview(): Preview | null {
  return pv;
}

export function ensurePreview(): Preview {
  if (pv) return pv;
  pv = createPreview(previewCanvas(), {
    onStatus: (s: string) => A.set({ pvStatus: s }),
    onFrame: (f: number) => A.set({ frame: f }),
    // keep the transport's play/pause label truthful, including when playback
    // auto-stops on the last frame with loop off.
    onPlaying: (p: boolean) => A.set({ playing: p }),
  });
  const a = A.get();
  pv.setPalette(a.palette && a.palette.ok ? a.palette.rows : null);
  pv.setPaletteRow(a.row);
  pv.setLoop(a.loop);
  pv.setBackground("checker");
  pushSceneToPreview();
  return pv;
}

export function pushSceneToPreview(validated?: Scene): void {
  if (!pv || !scene) return;
  pv.setScene(validated || scene);
  const targets = pv.getTargets ? pv.getTargets() : [];
  if (!targets.some((t) => t.id === A.get().target)) pickDefaultTarget();
  pv.setTarget(A.get().target);
  const frames = pv.getFrameCount();
  A.set({ frames });
  if (A.get().frame >= frames) {
    A.set({ frame: 0 });
    pv.setFrame(0);
  }
  A.set({ backend: pv.info().backend });
  loadBitmaps();
  pv.render();
}

function loadBitmaps(): void {
  if (!pv || !scene || !scene.bitmaps) return;
  const p = pv;
  for (const [id, bm] of Object.entries(scene.bitmaps)) {
    const img = new Image();
    img.onload = () => {
      p.setBitmap(id, img);
      p.render();
    };
    img.src = url("/api/art/asset", { mod: mod(), path: bm.file });
  }
}

export function setTarget(id: string): void {
  A.set({ target: id, rightTab: "preview" });
  if (pv) {
    pv.setTarget(id);
    A.set({ frames: pv.getFrameCount() });
    pv.setFrame(0);
    A.set({ frame: 0 });
    pv.render();
  }
}

export function setShowGray(v: boolean): void {
  A.set({ showGray: v });
  if (pv) {
    pv.setShowGray(v);
    pv.render();
  }
  bump();
}

export function setRow(n: number): void {
  const row = Math.max(0, Math.min(255, n | 0));
  A.set({ row });
  if (scene) {
    scene.preview = scene.preview || {};
    scene.preview.palette = row;
    A.set({ saved: false });
  }
  const p = ensurePreview();
  p.setPaletteRow(row);
  p.render();
  bump();
}

/** CSS colour for gray level N through the current palette row (or raw gray). */
export function rampColor(level: number): string {
  const a = A.get();
  const pal = a.palette;
  if (a.showGray || !pal || !pal.ok) {
    const v = grayLevelToByte(level);
    return `rgb(${v},${v},${v})`;
  }
  const row = pal.rows[Math.max(0, Math.min(pal.rows.length - 1, a.row))] || [];
  const c = row[level] || [0, 0, 0];
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
