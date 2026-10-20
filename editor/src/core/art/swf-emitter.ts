// SWF file assembly: header + tag order exactly as the vanilla files lay them out
// (docs/art-preview-plan.md §1.3): FWS v17, FileAttributes(0x08), SetBackgroundColor,
// DefineSceneAndFrameLabelData, library definitions in `scene.buildOrder`, main-timeline
// PlaceObject2s, [ExportAssets], [DoABC], SymbolClass, ShowFrame, End.
// Owns tag framing/file layout only; shapes come from `shape.ts`, bitmaps from
// `lossless.ts`, the optional ABC from `abc-stub.ts`, baked frames from `timeline.ts`.

import { buildOrder, parseColor } from "./scene.ts";
import type { Scene, Finding } from "./scene.ts";
import { bakeSprite, bakeStage, diffFrames, CXFORM_IDENTITY } from "./timeline.ts";
import type { Cxform, BakedSprite, FrameOp, Placement } from "./timeline.ts";
import { encodeDefineShape } from "./shape.ts";
import { encodeDefineBitsLossless2 } from "./lossless.ts";
import { buildLinkageAbc } from "./abc-stub.ts";
import { BitWriter, TAG, tag, tagName, concat, writeRect, writeMatrix, writeCxformWithAlpha, writeRgb } from "./swf-bits.ts";
import type { Mat } from "./geometry.ts";
import type { RgbaImage } from "./png.ts";
import { BLEND_MODES, hasEffects, writeFilterList } from "./effects.ts";
import { encodeDefineEditText, encodeImportGameFonts, encodeImportAssets2 } from "./text.ts";
import type { SceneFilter } from "./effects.ts";

export const SWF_VERSION = 17;
export const FILE_ATTRIBUTES_AS3 = 0x00000008;
export const DEFAULT_BACKGROUND = { r: 0xff, g: 0xcc, b: 0xff };

export type AbcOption = "none" | "stub" | Uint8Array;

export interface EmitOptions {
  /** DoABC: omit, Flash-faithful stub, or a caller-supplied ABC blob */
  abc?: AbcOption;
  /** decoded PNGs by scene bitmap id */
  bitmaps?: Map<string, RgbaImage>;
  /** also write an ExportAssets tag (vanilla files do not) */
  exportAssets?: boolean;
}

export interface EmitCharacter {
  id: number;
  kind: "bitmap" | "shape" | "sprite" | "text" | "import";
  name: string;
}
export interface EmitExport {
  id: number;
  name: string;
}
export interface EmitTagInfo {
  code: number;
  name: string;
  length: number;
}

export interface EmitReport {
  fileLength: number;
  frameCount: number;
  characters: EmitCharacter[];
  exports: EmitExport[];
  /** top-level tags, body lengths */
  tags: EmitTagInfo[];
  abc: "none" | "stub" | "blob";
}

export interface EmitResult {
  bytes: Uint8Array;
  report: EmitReport;
  findings: Finding[];
}

interface FramedTag {
  code: number;
  bytes: Uint8Array;
}

export interface PlaceObject2Fields {
  move: boolean;
  depth: number;
  characterId?: number;
  matrix?: Mat;
  cxform?: Cxform | null;
  name?: string | null;
  clipDepth?: number | null;
}

export interface PlaceObject3Fields extends PlaceObject2Fields {
  /** a BLEND_MODES name; written when given (normal included, to reset a previous blend) */
  blend?: string | null;
  /** written when given (an empty list resets previous filters) */
  filters?: SceneFilter[] | null;
}

export interface EncodedTimeline {
  bytes: Uint8Array;
  placeCount: number;
  removeCount: number;
  labelCount: number;
}

const EMPTY = new Uint8Array(0);

/**
 * Emit a complete SWF for a validated scene.
 * @param scene output of `validateScene(...).scene` (defaults filled in)
 */
export function emitSwf(scene: Scene, opts: EmitOptions = {}): EmitResult {
  const findings: Finding[] = [];
  const tags: FramedTag[] = [];
  const push = (code: number, body: Uint8Array, long = false) => {
    tags.push({ code, bytes: tag(code, body, long) });
  };

  const stage = scene.stage || { width: 1280, height: 720 };
  const bg = (stage.background && parseColor(stage.background)) || DEFAULT_BACKGROUND;

  // --- header tags
  {
    const w = new BitWriter(8);
    w.u32(FILE_ATTRIBUTES_AS3);
    push(TAG.FileAttributes, w.finish());
  }
  {
    const w = new BitWriter(4);
    writeRgb(w, bg);
    push(TAG.SetBackgroundColor, w.finish());
  }
  {
    const w = new BitWriter(16);
    w.encodedU32(1);
    w.encodedU32(0);
    w.string("Scene 1");
    w.encodedU32(0);
    push(TAG.DefineSceneAndFrameLabelData, w.finish());
  }

  // --- symbols imported from game SWFs: one ImportAssets2 per source, before any definition (ids from buildOrder)
  const imports = scene.imports || {};
  const importIds = new Map<string, number>();
  {
    const order0 = buildOrder(scene);
    const bySource = new Map<string, Array<{ id: number; name: string }>>();
    for (const [local, im] of Object.entries(imports)) {
      const cid = order0.indexOf(local) + 1;
      importIds.set(local, cid);
      bySource.set(im.from, [...(bySource.get(im.from) || []), { id: cid, name: im.name }]);
    }
    for (const [url, entries] of bySource) tags.push({ code: TAG.ImportAssets2, bytes: encodeImportAssets2(url, entries) });
  }

  // --- the game's fonts, declared like vanilla does (ImportAssets2 "fonts.swf", 0 assets) when the scene has text
  const texts = scene.texts || {};
  if (Object.keys(texts).length) tags.push({ code: TAG.ImportAssets2, bytes: encodeImportGameFonts() });

  // --- library definitions
  const order = buildOrder(scene);
  const ids = new Map<string, number>();
  order.forEach((id, i) => ids.set(id, i + 1));
  const bitmapIds = new Map<string, number>();
  const characters: EmitCharacter[] = [];
  const bitmaps = scene.bitmaps || {};
  for (const id of order) {
    const cid = ids.get(id) as number;
    if (importIds.has(id)) {
      characters.push({ id: cid, kind: "import", name: id });
    } else if (bitmaps[id]) {
      const img = opts.bitmaps ? opts.bitmaps.get(id) : undefined;
      if (!img) {
        findings.push({ severity: "error", code: "bitmap-missing", message: `no decoded image supplied for bitmap "${id}" (${bitmaps[id].file})`, path: `bitmaps.${id}` });
        continue;
      }
      try {
        tags.push({ code: TAG.DefineBitsLossless2, bytes: encodeDefineBitsLossless2(cid, img) });
      } catch (e) {
        findings.push({ severity: "error", code: "bitmap-encode", message: e instanceof Error ? e.message : String(e), path: `bitmaps.${id}` });
        continue;
      }
      bitmapIds.set(id, cid);
      characters.push({ id: cid, kind: "bitmap", name: id });
    } else if (texts[id]) {
      tags.push({ code: TAG.DefineEditText, bytes: encodeDefineEditText(cid, texts[id]!) });
      characters.push({ id: cid, kind: "text", name: id });
    } else if (scene.shapes[id]) {
      const enc = encodeDefineShape(cid, scene.shapes[id], { bitmapIds, shapeName: id, cubicSplits: scene.curveResolution, gradients: scene.gradients });
      findings.push(...enc.findings);
      tags.push({ code: TAG.DefineShape3, bytes: enc.bytes });
      characters.push({ id: cid, kind: "shape", name: id });
    } else if (scene.sprites[id]) {
      const baked = bakeSprite(scene.sprites[id]);
      const inner = encodeTimeline(baked, ids, findings, `sprites.${id}`);
      const w = new BitWriter(8 + inner.bytes.length);
      w.u16(cid);
      w.u16(baked.frames);
      w.bytes(inner.bytes);
      push(TAG.DefineSprite, w.finish(), true);
      characters.push({ id: cid, kind: "sprite", name: id });
    }
  }

  // --- main timeline placements (frame 0, held)
  const stageBaked = bakeStage(scene);
  for (const op of diffFrames([], stageBaked.placements[0] || [])) {
    const t = frameOpToTag(op, ids, findings, "stage_instances");
    if (t) tags.push(t);
  }

  // --- linkage
  const exports: EmitExport[] = [];
  for (const [linkage, ref] of Object.entries(scene.exports || {})) {
    const cid = ids.get(ref);
    if (cid === undefined) {
      findings.push({ severity: "error", code: "export-unresolved", message: `export "${linkage}" points at unknown id "${ref}"`, path: `exports.${linkage}` });
      continue;
    }
    exports.push({ id: cid, name: linkage });
  }
  if (!exports.length) findings.push({ severity: "warning", code: "exports-empty", message: "SymbolClass is empty: nothing in this SWF is addressable from GON", path: "exports" });
  const symbolBody = encodeSymbolList(exports);
  if (opts.exportAssets) push(TAG.ExportAssets, symbolBody);

  const abcMode: AbcOption = opts.abc ?? "none";
  let abcKind: EmitReport["abc"] = "none";
  if (abcMode !== "none") {
    const abc = abcMode === "stub" ? buildLinkageAbc(exports.map((e) => e.name)) : abcMode;
    abcKind = abcMode === "stub" ? "stub" : "blob";
    const w = new BitWriter(8 + abc.length);
    w.u32(1); // kLazyInitializeFlag, as Flash emits
    w.string("");
    w.bytes(abc);
    push(TAG.DoABC, w.finish(), true);
  }
  push(TAG.SymbolClass, symbolBody);
  push(TAG.ShowFrame, EMPTY);
  push(TAG.End, EMPTY);

  // --- header
  const frameCount = Math.max(1, stageBaked.frames);
  const frameRate = scene.frameRate ?? 60;
  const hw = new BitWriter(32);
  hw.u8(0x46); // F
  hw.u8(0x57); // W
  hw.u8(0x53); // S
  hw.u8(SWF_VERSION);
  hw.u32(0); // FileLength, patched below
  writeRect(hw, { xmin: 0, ymin: 0, xmax: Math.round(stage.width * 20), ymax: Math.round(stage.height * 20) });
  hw.u16(Math.round(frameRate * 256));
  hw.u16(frameCount);
  const header = hw.finish();
  const bytes = concat([header, ...tags.map((t) => t.bytes)]);
  const len = bytes.length;
  bytes[4] = len & 0xff;
  bytes[5] = (len >>> 8) & 0xff;
  bytes[6] = (len >>> 16) & 0xff;
  bytes[7] = (len >>> 24) & 0xff;

  const report: EmitReport = {
    fileLength: len,
    frameCount,
    characters,
    exports,
    tags: tags.map((t) => ({ code: t.code, name: tagName(t.code), length: bodyLength(t.bytes) })),
    abc: abcKind,
  };
  return { bytes, report, findings };
}

function bodyLength(framed: Uint8Array): number {
  const header = framed[0] | (framed[1] << 8);
  return (header & 0x3f) === 0x3f ? framed.length - 6 : framed.length - 2;
}

/** SymbolClass / ExportAssets body: u16 count, then (u16 id, STRING name)*. */
export function encodeSymbolList(entries: EmitExport[]): Uint8Array {
  const w = new BitWriter(16);
  w.u16(entries.length);
  for (const e of entries) {
    w.u16(e.id);
    w.string(e.name);
  }
  return w.finish();
}

/**
 * PlaceObject2 tag.
 * @returns framed tag
 */
export function encodePlaceObject2(p: PlaceObject2Fields): Uint8Array {
  let flags = 0;
  if (p.move) flags |= 0x01;
  if (p.characterId !== undefined) flags |= 0x02;
  if (p.matrix) flags |= 0x04;
  if (p.cxform) flags |= 0x08;
  if (p.name) flags |= 0x20;
  if (p.clipDepth !== undefined && p.clipDepth !== null) flags |= 0x40;
  const w = new BitWriter(32);
  w.u8(flags);
  w.u16(p.depth);
  if (p.characterId !== undefined) w.u16(p.characterId);
  if (p.matrix) writeMatrix(w, p.matrix);
  if (p.cxform) writeCxformWithAlpha(w, p.cxform);
  if (p.name) w.string(p.name);
  if (p.clipDepth !== undefined && p.clipDepth !== null) w.u16(p.clipDepth);
  return tag(TAG.PlaceObject2, w.finish());
}

/**
 * PlaceObject3 tag: PlaceObject2's fields plus a filter list and a blend mode.
 * @returns framed tag
 */
export function encodePlaceObject3(p: PlaceObject3Fields): Uint8Array {
  let flags = 0;
  if (p.move) flags |= 0x01;
  if (p.characterId !== undefined) flags |= 0x02;
  if (p.matrix) flags |= 0x04;
  if (p.cxform) flags |= 0x08;
  if (p.name) flags |= 0x20;
  if (p.clipDepth !== undefined && p.clipDepth !== null) flags |= 0x40;
  // flags2: Reserved OpaqueBackground HasVisible HasImage HasClassName HasCacheAsBitmap HasBlendMode HasFilterList
  let flags2 = 0;
  if (p.blend !== undefined && p.blend !== null) flags2 |= 0x02;
  if (p.filters) flags2 |= 0x01;
  const w = new BitWriter(64);
  w.u8(flags);
  w.u8(flags2);
  w.u16(p.depth);
  if (p.characterId !== undefined) w.u16(p.characterId);
  if (p.matrix) writeMatrix(w, p.matrix);
  if (p.cxform) writeCxformWithAlpha(w, p.cxform);
  if (p.name) w.string(p.name);
  if (p.clipDepth !== undefined && p.clipDepth !== null) w.u16(p.clipDepth);
  if (p.filters) writeFilterList(w, p.filters);
  if (p.blend !== undefined && p.blend !== null) w.u8(BLEND_MODES[p.blend] ?? 1);
  return tag(TAG.PlaceObject3, w.finish());
}

/** One timeline frame-op → tag (null when the referenced character is unknown). */
function frameOpToTag(op: FrameOp, ids: Map<string, number>, findings: Finding[], at: string): FramedTag | null {
  if (op.op === "remove") {
    const w = new BitWriter(2);
    w.u16(op.depth);
    return { code: TAG.RemoveObject2, bytes: tag(TAG.RemoveObject2, w.finish()) };
  }
  const p = op.p;
  if (op.op === "move" && op.changedEffects) {
    return {
      code: TAG.PlaceObject3,
      bytes: encodePlaceObject3({
        move: true,
        depth: p.depth,
        matrix: op.changedMatrix ? p.matrix : undefined,
        cxform: op.changedCxform ? p.cxform || CXFORM_IDENTITY : undefined,
        blend: p.blend || "normal",
        filters: p.filters || [],
      }),
    };
  }
  if (op.op === "move") {
    return {
      code: TAG.PlaceObject2,
      bytes: encodePlaceObject2({
        move: true,
        depth: p.depth,
        matrix: op.changedMatrix ? p.matrix : undefined,
        cxform: op.changedCxform ? p.cxform || CXFORM_IDENTITY : undefined,
      }),
    };
  }
  const cid = ids.get(p.ref);
  if (cid === undefined) {
    findings.push({ severity: "error", code: "ref-unresolved", message: `placement references unknown id "${p.ref}"`, path: at });
    return null;
  }
  if (hasEffects(p.blend, p.filters)) {
    return {
      code: TAG.PlaceObject3,
      bytes: encodePlaceObject3({ move: op.op === "replace", depth: p.depth, characterId: cid, matrix: p.matrix, cxform: p.cxform, name: p.name, clipDepth: p.clipDepth, blend: p.blend || null, filters: p.filters && p.filters.length ? p.filters : null }),
    };
  }
  return {
    code: TAG.PlaceObject2,
    bytes: encodePlaceObject2({ move: op.op === "replace", depth: p.depth, characterId: cid, matrix: p.matrix, cxform: p.cxform, name: p.name, clipDepth: p.clipDepth }),
  };
}

/** Baked sprite → inner tag stream: per frame FrameLabel(s), diff ops, ShowFrame; then End. */
export function encodeTimeline(baked: BakedSprite, ids: Map<string, number>, findings: Finding[], at: string): EncodedTimeline {
  const chunks: Uint8Array[] = [];
  let placeCount = 0;
  let removeCount = 0;
  let labelCount = 0;
  let prev: Placement[] = [];
  for (let f = 0; f < baked.frames; f++) {
    for (const label of baked.labels[f] || []) {
      const w = new BitWriter(16);
      w.string(label);
      chunks.push(tag(TAG.FrameLabel, w.finish()));
      labelCount++;
    }
    const cur = baked.placements[f] || [];
    for (const op of diffFrames(prev, cur)) {
      const t = frameOpToTag(op, ids, findings, at);
      if (!t) continue;
      chunks.push(t.bytes);
      if (t.code === TAG.RemoveObject2) removeCount++;
      else placeCount++;
    }
    chunks.push(tag(TAG.ShowFrame, EMPTY));
    prev = cur;
  }
  chunks.push(tag(TAG.End, EMPTY));
  return { bytes: concat(chunks), placeCount, removeCount, labelCount };
}

/**
 * Depth of the icon slot in the game's `AbilityIcon` clip: every labeled icon frame places one bare shape at
 * depth 3 (OBSERVED on swfs/ability_icons.swf; pinned by the T1 test in test/art-emitter-tests.ts and recorded
 * in docs/engine-map.md "Art / SWF subsystem"). An `_Append_AbilityIcon` donor mirrors that slot.
 */
export const ABILITY_ICON_DEPTH = 3;

export interface GateSwfOptions {
  withAbc: boolean;
  linkage: string;
  label: string;
  layout?: "flat" | "nested" | "legacy";
  /** the square's fill: gray:8 (default) or a gray:2 → gray:14 linear gradient */
  fill?: "gray" | "gradient";
  /** "shape4": add a butt-cap, miter-join, non-scaling gray:1 stroke (the shape becomes a DefineShape4) */
  stroke?: "shape4";
  /** PlaceObject3 on the icon: "blend" (blend add only) or "filters" (a red glow only) */
  effects?: "blend" | "filters";
  /** place an instance of a catparts.swf export (e.g. "CatTail") on the icon frame through ImportAssets2 */
  importPart?: string;
  /** add a Peralta DefineEditText ("GATE") on the icon frame (text the way vanilla icons carry it) */
  text?: boolean;
}

/**
 * The SWF-gate fixture (docs/art-preview-plan.md §7, docs/swf-emitter-fix-spec.md §8): a 64×64 `gray:8` square
 * on a one-frame sprite labelled `label`, exported as `linkage`, with or without the stub ABC.
 *
 * `layout` chooses how the icon sits on the labeled frame:
 * - `"flat"` (default): the shape itself at depth 3 with an identity matrix — exactly how `AbilityIcon` lays out
 *   its own 842 labeled frames;
 * - `"nested"`: the shape wrapped in its own one-frame `DefineSprite`, placed at depth 3 — the spec's §8.1
 *   alternative, kept as a gate variant;
 * - `"legacy"`: the shape at depth 1 — the pre-fix donor that crashed the game on 2026-10-18, kept so the gate
 *   can show the crash still reproduces (a negative control).
 */
export function minimalGateSwf(o: GateSwfOptions): Uint8Array {
  const nested = o.layout === "nested";
  const depth = o.layout === "legacy" ? 1 : ABILITY_ICON_DEPTH;
  const scene: Scene = {
    version: 1,
    name: "swf_gate",
    frameRate: 60,
    stage: { width: 1280, height: 720, background: "#ffccff" },
    shapes: { square: { paths: [{ d: "M0 0 L64 0 L64 64 L0 64 Z", fill: o.fill === "gradient" ? "gradient:ramp" : "gray:8", fillRule: "nonzero", ...(o.stroke === "shape4" ? { stroke: "gray:1", strokeWidth: 4, strokeCap: "butt" as const, strokeJoin: "miter" as const, miterLimit: 3, strokeScale: "none" as const } : {}) }] } },
    bitmaps: {},
    ...(o.fill === "gradient" ? { gradients: { ramp: { kind: "linear" as const, x1: 0, y1: 0, x2: 64, y2: 0, stops: [{ offset: 0, color: "gray:2" }, { offset: 1, color: "gray:14" }] } } } : {}),
    sprites: {
      ...(nested ? { Icon: { frames: 1, labels: {}, layers: [{ depth: 1, keys: [{ frame: 0, ref: "square", x: 0, y: 0 }] }] } } : {}),
      Clip: { frames: 1, labels: { [o.label]: 0 }, layers: [{ depth, keys: [{ frame: 0, ref: nested ? "Icon" : "square", x: 0, y: 0, ...(o.effects === "blend" ? { blend: "add" } : o.effects === "filters" ? { filters: [{ type: "glow" as const, color: "#ff2020", blurX: 8, blurY: 8, strength: 2 }] } : {}) }] }].concat(o.text ? [{ depth: depth + 1, keys: [{ frame: 0, ref: "gatetext", x: 32, y: 52 }] }] : []).concat(o.importPart ? [{ depth: depth + 2, keys: [{ frame: 0, ref: "vpart", x: 32, y: 32 }] }] : []) },
    },
    ...(o.importPart ? { imports: { vpart: { from: "catparts.swf", name: o.importPart } } } : {}),
    ...(o.text ? { texts: { gatetext: { text: "GATE", font: "Peralta", size: 12, color: "#000000", align: "center" as const, width: 64, height: 20 } } } : {}),
    exports: { [o.linkage]: "Clip" },
    stage_instances: [],
  };
  return emitSwf(scene, { abc: o.withAbc ? "stub" : "none" }).bytes;
}
