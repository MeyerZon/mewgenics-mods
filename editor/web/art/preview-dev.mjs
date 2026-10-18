// Dev harness for preview-gl.mjs: plain DOM, no VanJS, no app state.
// Loads exampleScene(), the real palette from /api/art/palette (falls back to the
// identity ramp), and drives the renderer through its public API only.

import { createPreview, paletteBytes } from "./preview-gl.mjs";
import { exampleScene, validateScene } from "../../src/core/art/scene.mjs";

/** @typedef {import('./preview-gl.mjs').PaletteRows} PaletteRows */

/**
 * @template {HTMLElement} T
 * @param {string} id
 * @returns {T}
 */
function el(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return /** @type {T} */ (node);
}

const canvas = /** @type {HTMLCanvasElement} */ (el("canvas"));
const targetSel = /** @type {HTMLSelectElement} */ (el("target"));
const playBtn = /** @type {HTMLButtonElement} */ (el("play"));
const playText = el("playText");
const playIcon = el("playIcon");
const stepBack = /** @type {HTMLButtonElement} */ (el("stepBack"));
const stepFwd = /** @type {HTMLButtonElement} */ (el("stepFwd"));
const loopBox = /** @type {HTMLInputElement} */ (el("loop"));
const frameRange = /** @type {HTMLInputElement} */ (el("frame"));
const frameNow = el("frameNow");
const frameMax = el("frameMax");
const ticks = el("ticks");
const rowInput = /** @type {HTMLInputElement} */ (el("row"));
const ramp = el("ramp");
const grayBox = /** @type {HTMLInputElement} */ (el("gray"));
const palStatus = el("palStatus");
const fitBtn = /** @type {HTMLButtonElement} */ (el("fit"));
const zoom1Btn = /** @type {HTMLButtonElement} */ (el("zoom1"));
const zoomText = el("zoomText");
const bgSel = /** @type {HTMLSelectElement} */ (el("bg"));
const backendOut = el("backend");
const statsOut = el("stats");
const statusOut = el("status");

const PLAY_PATH = "M2 1l9 5-9 5z";
const PAUSE_PATH = "M2 1h3v10H2zM7 1h3v10H7z";

/** @type {PaletteRows | null} */
let paletteRows = null;

const validated = validateScene(exampleScene("devpage"));
const scene = validated.scene;

const preview = createPreview(canvas, {
  onStatus: (s) => {
    statusOut.textContent = s;
    statusOut.className = /lost|failed|unavailable|unknown/i.test(s) ? "warn" : "ok";
  },
  onFrame: (f) => {
    frameRange.value = String(f);
    frameRange.setAttribute("aria-valuenow", String(f));
    frameNow.textContent = String(f);
    refreshStats();
  },
});

preview.setScene(scene);
preview.setLoop(loopBox.checked);

// ---- targets ----
function fillTargets() {
  targetSel.textContent = "";
  for (const t of preview.getTargets()) {
    const o = document.createElement("option");
    o.value = t.id;
    o.textContent = `${t.id} (${t.kind}, ${t.frames} frame${t.frames === 1 ? "" : "s"})`;
    targetSel.appendChild(o);
  }
  targetSel.value = preview.getTarget() || "stage";
}
targetSel.addEventListener("change", () => {
  preview.setTarget(targetSel.value);
  refreshTimeline();
});

// ---- timeline ----
function refreshTimeline() {
  const n = preview.getFrameCount();
  frameRange.max = String(Math.max(0, n - 1));
  frameRange.setAttribute("aria-valuemax", String(Math.max(0, n - 1)));
  frameRange.value = String(preview.getFrame());
  frameNow.textContent = String(preview.getFrame());
  frameMax.textContent = `/ ${n - 1}`;
  ticks.textContent = "";
  const labels = preview.getLabels();
  for (const { frame, label } of labels) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.setAttribute("aria-label", `Go to label ${label} (frame ${frame})`);
    b.title = `frame ${frame}`;
    b.style.left = n > 1 ? `${(frame / (n - 1)) * 100}%` : "0%";
    b.addEventListener("click", () => preview.gotoLabel(label));
    ticks.appendChild(b);
  }
  refreshStats();
}
frameRange.addEventListener("input", () => {
  preview.pause();
  setPlayUi(false);
  preview.setFrame(Number(frameRange.value));
});

// ---- transport ----
/** @param {boolean} playing */
function setPlayUi(playing) {
  playBtn.setAttribute("aria-pressed", String(playing));
  playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
  playText.textContent = playing ? "Pause" : "Play";
  const path = playIcon.querySelector("path");
  if (path) path.setAttribute("d", playing ? PAUSE_PATH : PLAY_PATH);
}
playBtn.addEventListener("click", () => {
  if (preview.isPlaying()) preview.pause();
  else preview.play();
  setPlayUi(preview.isPlaying());
});
stepBack.addEventListener("click", () => {
  preview.pause();
  setPlayUi(false);
  preview.step(-1);
});
stepFwd.addEventListener("click", () => {
  preview.pause();
  setPlayUi(false);
  preview.step(1);
});
loopBox.addEventListener("change", () => preview.setLoop(loopBox.checked));

// ---- palette ----
function refreshRamp() {
  const row = preview.getPaletteRow();
  const bytes = paletteBytes(paletteRows);
  ramp.textContent = "";
  for (let col = 0; col < 16; col++) {
    const o = (row * 16 + col) * 3;
    const s = document.createElement("span");
    s.style.background = `rgb(${bytes[o]},${bytes[o + 1]},${bytes[o + 2]})`;
    s.title = `gray:${col} → rgb(${bytes[o]}, ${bytes[o + 1]}, ${bytes[o + 2]})`;
    ramp.appendChild(s);
  }
}
rowInput.value = String(preview.getPaletteRow());
rowInput.addEventListener("input", () => {
  const v = Number(rowInput.value);
  if (Number.isInteger(v) && v >= 0 && v <= 255) {
    preview.setPaletteRow(v);
    refreshRamp();
    refreshStats();
  }
});
grayBox.addEventListener("change", () => {
  preview.setShowGray(grayBox.checked);
  refreshStats();
});

async function loadPalette() {
  try {
    const res = await fetch("/api/art/palette");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json && json.ok && Array.isArray(json.rows)) {
      paletteRows = /** @type {PaletteRows} */ (json.rows);
      preview.setPalette(paletteRows);
      palStatus.textContent = `palette: ${paletteRows.length} rows from /api/art/palette`;
    } else {
      throw new Error(json && json.error ? String(json.error) : "palette unavailable");
    }
  } catch (e) {
    paletteRows = null;
    preview.setPalette(null);
    palStatus.textContent = `palette: identity ramp (${e instanceof Error ? e.message : String(e)})`;
  }
  refreshRamp();
  refreshStats();
}

// ---- view ----
fitBtn.addEventListener("click", () => {
  preview.setZoom("fit");
  refreshStats();
});
zoom1Btn.addEventListener("click", () => {
  const c = preview.getCenter();
  preview.setZoom(1);
  preview.setCenter(c[0], c[1]);
  refreshStats();
});
bgSel.addEventListener("change", () => {
  const v = bgSel.value;
  if (v === "none") preview.setBackground(null);
  else if (v === "stage") preview.setBackground((scene.stage && scene.stage.background) || "#ffccff");
  else preview.setBackground(v);
});

// drag to pan, wheel to zoom (dev-page conveniences built on setZoom/setCenter)
/** @type {{ x: number, y: number, cx: number, cy: number } | null} */
let drag = null;
canvas.addEventListener("pointerdown", (e) => {
  const c = preview.getCenter();
  drag = { x: e.clientX, y: e.clientY, cx: c[0], cy: c[1] };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const z = preview.getZoom();
  preview.setCenter(drag.cx - (e.clientX - drag.x) / z, drag.cy - (e.clientY - drag.y) / z);
  refreshStats();
});
canvas.addEventListener("pointerup", () => {
  drag = null;
});
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const z = preview.getZoom();
    const factor = Math.exp(-e.deltaY * 0.0015);
    const next = Math.max(0.05, Math.min(64, z * factor));
    // zoom about the cursor: keep the stage point under the pointer fixed
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left - rect.width / 2;
    const py = e.clientY - rect.top - rect.height / 2;
    const c = preview.getCenter();
    const sx = c[0] + px / z;
    const sy = c[1] + py / z;
    preview.setZoom(next);
    preview.setCenter(sx - px / next, sy - py / next);
    refreshStats();
  },
  { passive: false },
);

// ---- readouts ----
function refreshStats() {
  const i = preview.info();
  backendOut.textContent = `backend: ${i.backend} · masks: ${i.masks}`;
  backendOut.className = i.backend === "webgl" ? "ok" : i.backend === "canvas2d" ? "warn" : "err";
  statsOut.textContent = `frames ${i.frames} · frame ${i.frame} · draw calls ${i.drawCalls} · fills ${i.fillsDrawn} · row ${i.paletteRow}${i.maskOverflow ? ` · mask overflow ${i.maskOverflow}` : ""}${i.missingBitmaps ? ` · missing bitmaps ${i.missingBitmaps}` : ""}`;
  zoomText.textContent = `zoom ${i.zoom.toFixed(2)}`;
}

window.addEventListener("resize", () => {
  preview.resize();
  refreshStats();
});

// keyboard: space toggles play, arrows step (when focus is not in a form control)
window.addEventListener("keydown", (e) => {
  const t = /** @type {HTMLElement | null} */ (e.target);
  if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "BUTTON")) return;
  if (e.key === " ") {
    e.preventDefault();
    playBtn.click();
  } else if (e.key === "ArrowLeft") stepBack.click();
  else if (e.key === "ArrowRight") stepFwd.click();
});

fillTargets();
refreshTimeline();
refreshRamp();
setPlayUi(false);
void loadPalette();
preview.play();
setPlayUi(true);
