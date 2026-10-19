// SWF file assembly: header + tag order exactly as the vanilla files lay them out
// (docs/art-preview-plan.md §1.3): FWS v17, FileAttributes(0x08), SetBackgroundColor,
// DefineSceneAndFrameLabelData, library definitions in `scene.buildOrder`, main-timeline
// PlaceObject2s, [ExportAssets], [DoABC], SymbolClass, ShowFrame, End.
// Owns tag framing/file layout only; shapes come from `shape.mjs`, bitmaps from
// `lossless.mjs`, the optional ABC from `abc-stub.mjs`, baked frames from `timeline.mjs`.

import { buildOrder, parseColor } from "./scene.mjs";
import { bakeSprite, bakeStage, diffFrames, CXFORM_IDENTITY } from "./timeline.mjs";
import { encodeDefineShape3 } from "./shape.mjs";
import { encodeDefineBitsLossless2 } from "./lossless.mjs";
import { buildLinkageAbc } from "./abc-stub.mjs";
import { BitWriter, TAG, tag, tagName, concat, writeRect, writeMatrix, writeCxformWithAlpha, writeRgb } from "./swf-bits.mjs";

/** @typedef {import('./geometry.mjs').Mat} Mat */
/** @typedef {import('./scene.mjs').Scene} Scene */
/** @typedef {import('./scene.mjs').Finding} Finding */
/** @typedef {import('./timeline.mjs').Cxform} Cxform */
/** @typedef {import('./timeline.mjs').BakedSprite} BakedSprite */
/** @typedef {import('./png.mjs').RgbaImage} RgbaImage */

export const SWF_VERSION = 17;
export const FILE_ATTRIBUTES_AS3 = 0x00000008;
export const DEFAULT_BACKGROUND = { r: 0xff, g: 0xcc, b: 0xff };

/**
 * @typedef {Object} EmitOptions
 * @property {"none"|"stub"|Uint8Array} [abc]          DoABC: omit, Flash-faithful stub, or a caller-supplied ABC blob
 * @property {Map<string, RgbaImage>} [bitmaps]        decoded PNGs by scene bitmap id
 * @property {boolean} [exportAssets]                  also write an ExportAssets tag (vanilla files do not)
 */

/**
 * @typedef {Object} EmitReport
 * @property {number} fileLength
 * @property {number} frameCount
 * @property {Array<{ id: number, kind: 'bitmap'|'shape'|'sprite', name: string }>} characters
 * @property {Array<{ id: number, name: string }>} exports
 * @property {Array<{ code: number, name: string, length: number }>} tags   top-level tags, body lengths
 * @property {"none"|"stub"|"blob"} abc
 */

/** @typedef {{ code: number, bytes: Uint8Array }} FramedTag */

const EMPTY = new Uint8Array(0);

/**
 * Emit a complete SWF for a validated scene.
 * @param {Scene} scene   output of `validateScene(...).scene` (defaults filled in)
 * @param {EmitOptions} [opts]
 * @returns {{ bytes: Uint8Array, report: EmitReport, findings: Finding[] }}
 */
export function emitSwf(scene, opts = {}) {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {FramedTag[]} */
  const tags = [];
  const push = (/** @type {number} */ code, /** @type {Uint8Array} */ body, /** @type {boolean} */ long = false) => {
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

  // --- library definitions
  const order = buildOrder(scene);
  /** @type {Map<string, number>} */
  const ids = new Map();
  order.forEach((id, i) => ids.set(id, i + 1));
  /** @type {Map<string, number>} */
  const bitmapIds = new Map();
  /** @type {EmitReport['characters']} */
  const characters = [];
  const bitmaps = scene.bitmaps || {};
  for (const id of order) {
    const cid = /** @type {number} */ (ids.get(id));
    if (bitmaps[id]) {
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
    } else if (scene.shapes[id]) {
      const enc = encodeDefineShape3(cid, scene.shapes[id], { bitmapIds, shapeName: id, cubicSplits: scene.curveResolution });
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
  /** @type {EmitReport['exports']} */
  const exports = [];
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

  const abcMode = opts.abc ?? "none";
  /** @type {EmitReport['abc']} */
  let abcKind = "none";
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

  /** @type {EmitReport} */
  const report = {
    fileLength: len,
    frameCount,
    characters,
    exports,
    tags: tags.map((t) => ({ code: t.code, name: tagName(t.code), length: bodyLength(t.bytes) })),
    abc: abcKind,
  };
  return { bytes, report, findings };
}

/** @param {Uint8Array} framed */
function bodyLength(framed) {
  const header = framed[0] | (framed[1] << 8);
  return (header & 0x3f) === 0x3f ? framed.length - 6 : framed.length - 2;
}

/**
 * SymbolClass / ExportAssets body: u16 count, then (u16 id, STRING name)*.
 * @param {Array<{ id: number, name: string }>} entries
 */
export function encodeSymbolList(entries) {
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
 * @param {{ move: boolean, depth: number, characterId?: number, matrix?: Mat, cxform?: Cxform | null, name?: string | null, clipDepth?: number | null }} p
 * @returns {Uint8Array} framed tag
 */
export function encodePlaceObject2(p) {
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
 * One timeline frame-op → tag (null when the referenced character is unknown).
 * @param {import('./timeline.mjs').FrameOp} op
 * @param {Map<string, number>} ids
 * @param {Finding[]} findings
 * @param {string} at
 * @returns {FramedTag | null}
 */
function frameOpToTag(op, ids, findings, at) {
  if (op.op === "remove") {
    const w = new BitWriter(2);
    w.u16(op.depth);
    return { code: TAG.RemoveObject2, bytes: tag(TAG.RemoveObject2, w.finish()) };
  }
  const p = op.p;
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
  return {
    code: TAG.PlaceObject2,
    bytes: encodePlaceObject2({ move: op.op === "replace", depth: p.depth, characterId: cid, matrix: p.matrix, cxform: p.cxform, name: p.name, clipDepth: p.clipDepth }),
  };
}

/**
 * Baked sprite → inner tag stream: per frame FrameLabel(s), diff ops, ShowFrame; then End.
 * @param {BakedSprite} baked
 * @param {Map<string, number>} ids
 * @param {Finding[]} findings
 * @param {string} at
 * @returns {{ bytes: Uint8Array, placeCount: number, removeCount: number, labelCount: number }}
 */
export function encodeTimeline(baked, ids, findings, at) {
  /** @type {Uint8Array[]} */
  const chunks = [];
  let placeCount = 0;
  let removeCount = 0;
  let labelCount = 0;
  /** @type {import('./timeline.mjs').Placement[]} */
  let prev = [];
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
 * depth 3 (OBSERVED on swfs/ability_icons.swf; pinned by the T1 test in test/art-emitter-tests.mjs and recorded
 * in docs/engine-map.md "Art / SWF subsystem"). An `_Append_AbilityIcon` donor mirrors that slot.
 */
export const ABILITY_ICON_DEPTH = 3;

/**
 * The SWF-gate fixture (docs/art-preview-plan.md §7, docs/swf-emitter-fix-spec.md §8): a 64×64 `gray:8` square
 * on a one-frame sprite labelled `label`, exported as `linkage`, with or without the stub ABC.
 *
 * `layout` chooses how the icon sits on the labeled frame:
 * - `"flat"` (default): the shape itself at depth 3 with an identity matrix — exactly how `AbilityIcon` lays out
 *   its own 842 labeled frames;
 * - `"nested"`: the shape wrapped in its own one-frame `DefineSprite`, placed at depth 3 — the spec's §8.1
 *   alternative, kept as a gate variant.
 * @param {{ withAbc: boolean, linkage: string, label: string, layout?: "flat" | "nested" }} o
 * @returns {Uint8Array}
 */
export function minimalGateSwf(o) {
  const nested = o.layout === "nested";
  /** @type {Scene} */
  const scene = {
    version: 1,
    name: "swf_gate",
    frameRate: 60,
    stage: { width: 1280, height: 720, background: "#ffccff" },
    shapes: { square: { paths: [{ d: "M0 0 L64 0 L64 64 L0 64 Z", fill: "gray:8", fillRule: "nonzero" }] } },
    bitmaps: {},
    sprites: {
      ...(nested ? { Icon: { frames: 1, labels: {}, layers: [{ depth: 1, keys: [{ frame: 0, ref: "square", x: 0, y: 0 }] }] } } : {}),
      Clip: { frames: 1, labels: { [o.label]: 0 }, layers: [{ depth: ABILITY_ICON_DEPTH, keys: [{ frame: 0, ref: nested ? "Icon" : "square", x: 0, y: 0 }] }] },
    },
    exports: { [o.linkage]: "Clip" },
    stage_instances: [],
  };
  return emitSwf(scene, { abc: o.withAbc ? "stub" : "none" }).bytes;
}
