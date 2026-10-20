// Shapes the art UI reads: the core's scene model (re-exported from the JSDoc typedefs in
// src/core/art/scene.ts) and the /api/art/* response shapes (src/core/art/art-io.ts,
// src/core/art/palette.ts, src/core/api.ts).

import type { Scene, SceneShape, SceneSprite, SceneLayer, SceneKey, ScenePath, Finding, Fill } from "../../../src/core/art/scene.ts";

export type { Scene, SceneShape, SceneSprite, SceneLayer, SceneKey, ScenePath, Finding, Fill };

export type ArtSubtab = "overview" | "shapes" | "sprites" | "exports" | "json";
export type ArtRightTab = "preview" | "findings" | "build" | "ruffle";
export type AbcMode = "none" | "stub";

export interface SceneListing {
  relPath: string;
  name: string;
  bytes: number;
}
export interface SwfListing {
  relPath: string;
  bytes: number;
  mtimeMs: number;
}
export interface ArtAssets {
  svgs: string[];
  pngs: string[];
  swflistAppend: string | null;
}

/** GET /api/art/scenes */
export interface ArtScenesResponse {
  ok: boolean;
  error?: string;
  scenes: SceneListing[];
  swfs: SwfListing[];
  svgs: string[];
  pngs: string[];
  swflistAppend: string | null;
}

/** GET /api/art/scene */
export interface SceneReadResponse {
  ok: boolean;
  relPath: string;
  scene?: Scene;
  findings: Finding[];
  error?: string;
  text?: string;
}

/** POST /api/art/scene */
export interface SceneWriteResponse {
  ok: boolean;
  path?: string;
  bytes?: number;
  findings: Finding[];
  valid?: boolean;
  error?: string;
}

/** POST /api/art/new-scene */
export interface NewSceneResponse extends SceneWriteResponse {
  relPath: string;
  scene?: Scene;
}

/** POST /api/art/validate (validateScene) */
export interface SceneValidateResponse {
  ok: boolean;
  scene: Scene;
  findings: Finding[];
}

/** POST /api/art/import-svg */
export interface ImportSvgResponse {
  ok: boolean;
  shape: SceneShape;
  findings: Finding[];
  error?: string;
  info?: unknown;
}

export interface SwfReportExport {
  id: number;
  name: string;
}
export interface SwfReport {
  frameCount: number;
  characters?: unknown[];
  exports?: SwfReportExport[];
  tags?: { name: string }[];
}

/** POST /api/art/build */
export interface BuildResponse {
  ok: boolean;
  dryRun?: boolean;
  swfPath?: string;
  bytes?: number;
  report?: SwfReport;
  findings?: Finding[];
  abc?: AbcMode;
  error?: string;
  swflist?: { ok: boolean; path: string; text: string } | null;
}

/** GET /api/art/inspect-swf, plus the relPath the UI asked about */
export interface InspectResponse {
  relPath: string;
  ok: boolean;
  error?: string;
  header?: { signature: string; version: number; frameRate: number; frameCount: number };
  histogram?: Record<string, number>;
  labels?: string[];
  exports?: SwfReportExport[];
  doAbc?: number;
  bytes?: number;
}

export type PaletteRow = [number, number, number][];

/** GET /api/art/palette */
export interface PaletteResponse {
  ok: boolean;
  which: "palette" | "fx_palette";
  rows: PaletteRow[];
  width: number;
  height: number;
  source: string;
  error?: string;
  hint?: string;
  hints: Record<number, string>;
  defaultAbc: AbcMode;
}

/** POST /api/art/prepare-swf-gate */
export interface PrepareGateResponse {
  ok: boolean;
  written?: string[];
  next?: string;
  error?: string;
}
