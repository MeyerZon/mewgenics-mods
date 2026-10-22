// Cross-mod checks for `_Append_<Target>` exports and mod SWF files (2026-10-22). Pure except vanillaAppendLabels.
//
// What the game does (docs/engine-map.md "Several mods appending to one clip"; OBSERVED in-game with the
// _catappendA/B probe, test/fixtures/ingame/multi-append-summary.json, and in the decompiles):
// - ApplicationBase::process_animation_merges 0x9bc070 runs once per loaded SWF (load order, i.e. vanilla then the
//   mods' swflist entries in -modpaths order) and calls Swf_Merge 0xa58440 once per `_Append_<Target>` SymbolClass
//   entry. Swf_Merge appends the donor's frames to the target's merged timeline (`target+0x130`, created on the first
//   merge), so every mod's frames are kept: two mods appending to CatTest coexist.
// - Labels go into the merged label map by find-or-insert (0x123a00 called at 0xa58a1b) and a plain store
//   (`mov [rcx+0x30], esi` at 0xa58a23): a label defined twice resolves to the LAST merged donor's frame — the later
//   -modpaths mod wins; the earlier mod's frames stay in the timeline, unreachable by that label. The same store
//   overwrites a vanilla label (INFERRED for vanilla: the same instruction; OBSERVED mod vs mod).
// - swflist.gon lists SWFs by file name and each name resolves through the mod paths, later mods first: two mods
//   shipping swfs/<same>.swf both load the later mod's file, so the earlier mod's SWF (all of its exports and
//   appends) never loads (OBSERVED). A mod file named like a vanilla SWF replaces it the same way (INFERRED).

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readSwf, type Tag } from "./swf-reader.ts";
import type { Scene, Finding } from "./scene.ts";

export const APPEND_PREFIX = "_Append_";

export interface AppendExport {
  /** the clip the frames are appended to, e.g. CatTest */
  target: string;
  /** the donor's frame labels, in frame order */
  labels: string[];
}

export interface ModAppendFile {
  /** the SWF's file name as swflist.gon names it */
  file: string;
  appends: AppendExport[];
}

export interface ModAppends {
  mod: string;
  files: ModAppendFile[];
}

export interface VanillaAppendInfo {
  /** vanilla SWF file names (swfs/*.swf) */
  files: string[];
  /** per target: the labels the vanilla clip and vanilla appends already define */
  labels: Record<string, string[]>;
}

function spriteLabels(tags: Tag[]): string[] {
  const out: string[] = [];
  for (const t of tags) if (t.name === "FrameLabel" && typeof t.label === "string") out.push(t.label);
  return out;
}

/** The `_Append_<Target>` exports of a SWF (SymbolClass entries) with the donor sprite's frame labels. */
export function appendsOfSwf(bytes: Uint8Array): AppendExport[] {
  const swf = readSwf(bytes);
  const sprites = new Map<number, Tag>();
  const out: AppendExport[] = [];
  for (const t of swf.tags) if (t.name === "DefineSprite" && typeof t.id === "number") sprites.set(t.id, t);
  for (const t of swf.tags) {
    if (t.name !== "SymbolClass" || !t.entries) continue;
    for (const e of t.entries) {
      if (!e.name.startsWith(APPEND_PREFIX) || e.name.length === APPEND_PREFIX.length) continue;
      const sp = sprites.get(e.id);
      out.push({ target: e.name.slice(APPEND_PREFIX.length), labels: sp ? spriteLabels(sp.tags || []) : [] });
    }
  }
  return out;
}

/** The same from a scene (the source of a SWF the editor builds as `<scene.name>.swf`). */
export function appendsOfScene(scene: Scene): AppendExport[] {
  const out: AppendExport[] = [];
  for (const [name, id] of Object.entries(scene.exports || {})) {
    if (!name.startsWith(APPEND_PREFIX) || name.length === APPEND_PREFIX.length || typeof id !== "string") continue;
    const sp = scene.sprites[id];
    const labels = sp ? Object.entries(sp.labels || {}).sort((a, b) => a[1] - b[1]).map(([l]) => l) : [];
    out.push({ target: name.slice(APPEND_PREFIX.length), labels });
  }
  return out;
}

/** Labels vanilla already defines on `target`: the clip exported as `target` plus every vanilla `_Append_<target>`. */
export function vanillaAppendLabels(target: string, swfDir: string, files: string[] = ["catanis.swf", "catanis2.swf"]): string[] {
  const seen = new Set<string>();
  for (const f of files) {
    const p = join(swfDir, f);
    if (!existsSync(p)) continue;
    const swf = readSwf(new Uint8Array(readFileSync(p)));
    const sprites = new Map<number, Tag>();
    for (const t of swf.tags) if (t.name === "DefineSprite" && typeof t.id === "number") sprites.set(t.id, t);
    for (const t of swf.tags) {
      if (t.name !== "SymbolClass" || !t.entries) continue;
      for (const e of t.entries) {
        if (e.name !== target && e.name !== APPEND_PREFIX + target) continue;
        for (const l of spriteLabels(sprites.get(e.id)?.tags || [])) seen.add(l);
      }
    }
  }
  return [...seen];
}

const list = (xs: string[], n = 8) => (xs.length > n ? `${xs.slice(0, n).join(", ")} … (${xs.length})` : xs.join(", "));

/**
 * Conflicts between mods loaded together, `mods` in -modpaths order. Findings: swf-file-conflict /
 * swf-file-shadows-vanilla (a file name another mod or vanilla also ships), cat-append-conflict (a label two mods
 * append to the same target; the later mod wins), cat-append-shadows-vanilla (a mod label vanilla already defines on
 * the target), cat-append-shared (info: several mods append to one target — fine, all frames are merged).
 */
/** a cross-mod finding plus the mods it involves */
export type CrossModFinding = Finding & { mods: string[] };

export function crossModAppendFindings(mods: ModAppends[], vanilla?: VanillaAppendInfo): CrossModFinding[] {
  const out: CrossModFinding[] = [];
  // 1. file names: the later mod's file is what loads under that name
  const byFile = new Map<string, string[]>();
  const shown = new Map<string, string>(); // lower-case key -> the name as the first mod spells it
  for (const m of mods) for (const f of m.files) if (!shown.has(f.file.toLowerCase())) shown.set(f.file.toLowerCase(), f.file);
  for (const m of mods) for (const f of m.files) byFile.set(f.file.toLowerCase(), [...(byFile.get(f.file.toLowerCase()) || []), m.mod]);
  const loaded = new Set<string>(); // "mod/file" pairs whose file actually loads
  for (const m of mods) for (const f of m.files) {
    const owners = byFile.get(f.file.toLowerCase())!;
    if (owners[owners.length - 1] === m.mod) loaded.add(`${m.mod}/${f.file.toLowerCase()}`);
  }
  for (const [key, owners] of byFile) {
    const file = shown.get(key)!;
    const distinct = [...new Set(owners)];
    if (distinct.length > 1) {
      const winner = distinct[distinct.length - 1]!;
      out.push({ severity: "warning", code: "swf-file-conflict", mods: distinct, message: `${distinct.join(" and ")} both ship swfs/${file}: the game resolves a swflist entry by file name through the mod paths, later mods first, so ${winner}'s file loads for every entry and ${distinct.slice(0, -1).join(", ")}'s SWF never loads (none of its exports or appends exist; OBSERVED 2026-10-22). Give each mod's SWF a distinct name (e.g. prefix the mod name)`, path: `swfs/${file}` });
    }
    if (vanilla && vanilla.files.some((v) => v.toLowerCase() === key)) {
      out.push({ severity: "warning", code: "swf-file-shadows-vanilla", mods: distinct, message: `${[...new Set(owners)].join(" and ")} ship${distinct.length > 1 ? "" : "s"} swfs/${file}, a vanilla SWF's name: the mod file replaces the vanilla one (INFERRED from the same name resolution), dropping every vanilla export in it. Rename the mod's SWF`, path: `swfs/${file}` });
    }
  }
  // 2. labels per target, in merge order (only files that actually load)
  const byTarget = new Map<string, Array<{ mod: string; file: string; labels: string[] }>>();
  for (const m of mods) for (const f of m.files) {
    if (!loaded.has(`${m.mod}/${f.file.toLowerCase()}`)) continue;
    for (const a of f.appends) byTarget.set(a.target, [...(byTarget.get(a.target) || []), { mod: m.mod, file: f.file, labels: a.labels }]);
  }
  for (const [target, donors] of byTarget) {
    const mods_ = [...new Set(donors.map((d) => d.mod))];
    if (mods_.length > 1) out.push({ severity: "info", code: "cat-append-shared", mods: mods_, message: `${mods_.join(", ")} all append to ${target}: every donor's frames are merged in -modpaths order and coexist (OBSERVED 2026-10-22); only a label defined twice is a conflict`, path: `${APPEND_PREFIX}${target}` });
    const owner = new Map<string, string>(); // label -> last mod defining it
    const clashes = new Map<string, { label: string[]; mods: string[] }>(); // "earlier>later" -> labels
    for (const d of donors) {
      for (const l of new Set(d.labels)) {
        const prev = owner.get(l);
        if (prev !== undefined && prev !== d.mod) {
          const k = `${prev}\u0000${d.mod}`;
          const c = clashes.get(k) || { label: [], mods: [prev, d.mod] };
          c.label.push(l);
          clashes.set(k, c);
        }
        owner.set(l, d.mod);
      }
    }
    for (const c of clashes.values()) {
      out.push({ severity: "warning", code: "cat-append-conflict", mods: c.mods, message: `${c.mods[0]} and ${c.mods[1]} both append the label${c.label.length > 1 ? "s" : ""} ${list(c.label)} to ${target}: the merge keeps one frame per label and the later -modpaths mod wins (${c.mods[1]} wins; OBSERVED 2026-10-22, Swf_Merge's label store at 0xa58a23), so ${c.mods[0]}'s animation under that name is never played. Prefix your labels with the mod's name`, path: `${APPEND_PREFIX}${target}` });
    }
    const v = vanilla?.labels[target];
    if (v && v.length) {
      const vs = new Set(v);
      for (const m of mods_) {
        const hit = [...new Set(donors.filter((d) => d.mod === m).flatMap((d) => d.labels))].filter((l) => vs.has(l));
        if (hit.length) out.push({ severity: "warning", code: "cat-append-shadows-vanilla", mods: [m], message: `${m} appends the label${hit.length > 1 ? "s" : ""} ${list(hit)}, which vanilla ${target} already defines: the merge overwrites the label, so every unit playing it gets the mod's frame instead of the vanilla animation (INFERRED from the mod-vs-mod rule). Use a new label and point alt_animations at it`, path: `${APPEND_PREFIX}${target}` });
      }
    }
  }
  return out;
}
