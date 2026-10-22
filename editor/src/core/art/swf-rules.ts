// What the game's SWF loader does with each tag, as rules over a parsed SWF (swf-reader.ts). OBSERVED in the tag
// dispatcher `glaiel::swf::SWFTag::createTag` RVA 0xa2e990 and the decoders it names (RE session disp, 2026-10-21;
// docs/engine-map.md "SWF loader and display path"): what it FATALs on is an error, what it silently drops is a
// warning, what merely behaves differently from Flash is an info. The scene validator (scene.ts) and the emitter
// (swf-emitter.ts) raise the same codes for what a scene can express; this module runs on the bytes — inspect_swf and
// the build self-check — so hand-made SWFs are covered too. Pure (no node, no DOM).

import { TAG, tagName } from "./swf-bits.ts";
import type { Tag } from "./swf-reader.ts";
import type { FillStyle } from "./swf-reader.ts";
import type { Finding } from "./scene.ts";
import { VANILLA_EXPORTS } from "./vanilla-exports.ts";
import { bitmapFitsAtlas, bitmapTooLargeMessage } from "./engine-behaviour.ts";

export interface RuleCode {
  severity: Finding["severity"];
  /** "scene": raised by validateScene / emitSwf; "swf": raised here on parsed bytes */
  where: Array<"scene" | "swf">;
  /** the engine fact behind it */
  why: string;
}

/** Every code this module and the scene-level checks can raise for the display path, for the docs and the skill. */
export const SWF_RULE_CODES: Readonly<Record<string, RuleCode>> = {
  "font-tag-unsupported": { severity: "error", where: ["swf"], why: "DefineFont::decode 0xa2a4a0 accepts DefineFont3 only; tags 10 / 48 are FATAL 'ERROR: DefineFont version unsupported'" },
  "abc-count": { severity: "error", where: ["swf"], why: "DoABC::decode 0xa4a740 is FATAL 'Multiple DoABC tags in one SWF' on a second DoABC" },
  "bitmap-too-large": { severity: "error", where: ["scene", "swf"], why: "fit_texture 0xa24540 is FATAL 'Bitmap Fill could not fit into atlas' when width or height >= texture_atlas_size (4096)" },
  "filter-unsupported": { severity: "error", where: ["scene", "swf"], why: "PlaceObject3::decode 0xb78210 is FATAL 'ERROR: FILTERS NOT SUPPORTED' on a filter list" },
  "import-unsupported": { severity: "error", where: ["scene", "swf"], why: "ImportAssets / ImportAssets2 are skipped by createTag 0xa2e990, so an imported id has no character and placing it crashes (Swf_GetCharacter 0xa4a190)" },
  "scaling-grid-ignored": { severity: "warning", where: ["swf"], why: "DefineScalingGrid (78) is not in createTag's switch: no 9-slice" },
  "gradient-spread-ignored": { severity: "warning", where: ["scene", "swf"], why: "GradientAtlas::RasterizeRow 0xa27de0 and default_gradient.shader have no reflect/repeat arithmetic: every gradient pads" },
  "morph-shape-skipped": { severity: "warning", where: ["swf"], why: "DefineMorphShape / 2 log 'WARNING: SHAPE TWEEN NOT SUPPORTED' and become a generic skipped tag" },
  "place-cxform-ignored": { severity: "warning", where: ["swf"], why: "PlaceObject::decode 0xb77c10 logs 'Warning: color transform not supported on PlaceObject1' and uses the identity cxform" },
  "fill-rule-ignored": { severity: "warning", where: ["scene", "swf"], why: "Tess_tessTesselate 0xa73bb0 is compiled with TESS_WINDING_ODD: every fill style is filled even-odd; the DefineShape4 UsesFillWindingRule flag is never read" },
  "text-loc-key-html": { severity: "warning", where: ["scene"], why: "the text-box ctor 0x98d910 localizes an initial text that is exactly a key only when the DefineEditText has no HTML flag (OBSERVED 2026-10-22, render-loctext.mewtest); in vanilla's <p><font> wrapper the key is drawn as written; an info instead when the text only has the key shape and no such key exists" },
  "export-shadows-vanilla": { severity: "info", where: ["scene", "swf"], why: "App_FindMovieClipByName 0x9bb6f0 scans the loaded files from the last loaded backwards, so a mod SymbolClass / ExportAssets name shadows a vanilla one (INFERRED, not run in-game)" },
  "jpeg-bitmap": { severity: "info", where: ["swf"], why: "DefineBitsJPEG::decode 0xb79d90 decodes JPEG data but logs 'WARNING: TEXTURE ENCODED AS JPG INSTEAD OF PNG'" },
  "tag-ignored": { severity: "info", where: ["swf"], why: "createTag's default case makes a generic SWFTag whose decode is a nop: the tag is skipped without a log line" },
};

/** Tag codes createTag 0xa2e990 dispatches to a real decoder (OBSERVED: the complete switch). */
export const LOADER_ACCEPTED_TAGS: ReadonlySet<number> = new Set([
  TAG.End, TAG.ShowFrame, TAG.DefineShape, TAG.DefineShape2, TAG.DefineShape3, TAG.DefineShape4, TAG.PlaceObject, TAG.PlaceObject2, TAG.PlaceObject3,
  TAG.RemoveObject, TAG.RemoveObject2, TAG.DefineBits, TAG.JPEGTables, TAG.DefineBitsJPEG2, TAG.DefineBitsJPEG3, TAG.DefineBitsJPEG4, TAG.DefineBitsLossless,
  TAG.DefineBitsLossless2, TAG.SetBackgroundColor, TAG.DefineFont, TAG.DefineFont2, TAG.DefineFont3, TAG.DefineText, TAG.DefineText2, TAG.DoAction,
  TAG.DefineEditText, TAG.DefineSprite, TAG.FrameLabel, TAG.ExportAssets, TAG.SymbolClass, TAG.DoABC, TAG.DefineMorphShape, TAG.DefineMorphShape2,
]);

/** Skipped tags every Flash-authored or emitted file carries (metadata, font hints): not worth a finding. */
const LOADER_SILENT_TAGS: ReadonlySet<number> = new Set([
  TAG.FileAttributes, TAG.Metadata, TAG.DefineSceneAndFrameLabelData, TAG.DefineFontAlignZones, TAG.CSMTextSettings, TAG.DefineFontName,
  TAG.ImportAssets, TAG.ImportAssets2, TAG.DefineScalingGrid,
]);

const JPEG_TAGS: ReadonlySet<number> = new Set([TAG.DefineBits, TAG.DefineBitsJPEG2, TAG.DefineBitsJPEG3, TAG.DefineBitsJPEG4]);

/** The vanilla SWF (if any) that exports `name` (vanilla-exports.ts pins the lists). */
export function vanillaExportSource(name: string): string | null {
  for (const [file, names] of Object.entries(VANILLA_EXPORTS)) if (names.includes(name)) return file;
  return null;
}

/** The `export-shadows-vanilla` message (shared with the scene validator). */
export function exportShadowsMessage(name: string, file: string): string {
  return `"${name}" is also exported by the game's ${file}; the by-name lookup (App_FindMovieClipByName 0x9bb6f0) scans the last-loaded file first, so this mod's clip replaces the vanilla one everywhere it is used by name (INFERRED from the decompile, not run in-game)`;
}

/** Every finding the game's loader and renderer would raise for a parsed SWF's tag tree. */
export function swfFindings(tags: Tag[]): Finding[] {
  const out: Finding[] = [];
  let abcCount = 0;
  const walk = (list: Tag[], prefix: string) => {
    list.forEach((t, i) => {
      const path = `${prefix}[${i}]`;
      const push = (severity: Finding["severity"], code: string, message: string) => out.push({ severity, code, message, path });
      switch (t.code) {
        case TAG.DefineFont:
        case TAG.DefineFont2:
          push("error", "font-tag-unsupported", `${t.name} (tag ${t.code}, id ${t.id ?? "?"}): the game stops with "ERROR: DefineFont version unsupported" — only DefineFont3 decodes (DefineFont::decode 0xa2a4a0); use a game font class (scene.texts) or a DefineFont3`);
          break;
        case TAG.DoABC:
          abcCount++;
          if (abcCount === 2) push("error", "abc-count", `a second DoABC: the game stops with "Multiple DoABC tags in one SWF" (DoABC::decode 0xa4a740); keep at most one`);
          break;
        case TAG.DefineBitsLossless:
        case TAG.DefineBitsLossless2:
          if (t.bitmap && !bitmapFitsAtlas(t.bitmap.width, t.bitmap.height)) push("error", "bitmap-too-large", bitmapTooLargeMessage(`${t.name} id ${t.bitmap.id}`, t.bitmap.width, t.bitmap.height));
          break;
        case TAG.PlaceObject3:
          if (t.place && t.place.filters && t.place.filters.length) push("error", "filter-unsupported", `PlaceObject3 at depth ${t.place.depth} carries ${t.place.filters.length} filter(s): the game stops with "ERROR: FILTERS NOT SUPPORTED" (PlaceObject3::decode 0xb78210); bake glows/shadows into the art`);
          break;
        case TAG.ImportAssets:
        case TAG.ImportAssets2:
          if ((t.importCount ?? 0) > 0) push("error", "import-unsupported", `${t.name} from ${t.importUrl ?? "?"} declares ${t.importCount} symbol(s): the loader skips import tags, so the ids have no character and placing one crashes the game (Swf_GetCharacter 0xa4a190; OBSERVED 2026-10-20); only the zero-asset fonts.swf declaration is harmless`);
          break;
        case TAG.DefineScalingGrid:
          push("warning", "scaling-grid-ignored", `DefineScalingGrid for id ${t.id ?? "?"} is ignored: the loader has no case for tag 78 (createTag 0xa2e990), so there is no 9-slice scaling in-game`);
          break;
        case TAG.DefineMorphShape:
        case TAG.DefineMorphShape2:
          push("warning", "morph-shape-skipped", `${t.name} id ${t.id ?? "?"} is skipped: the game logs "WARNING: SHAPE TWEEN NOT SUPPORTED" and draws nothing for it; key the shapes on a timeline instead`);
          break;
        case TAG.PlaceObject:
          if (t.place && t.place.cxform) push("warning", "place-cxform-ignored", `PlaceObject (v1) at depth ${t.place.depth} has a colour transform the game ignores ("Warning: color transform not supported on PlaceObject1", PlaceObject::decode 0xb77c10); use PlaceObject2`);
          break;
        case TAG.DefineShape:
        case TAG.DefineShape2:
        case TAG.DefineShape3:
        case TAG.DefineShape4: {
          if (t.code === TAG.DefineShape4 && t.shape && ((t.shape.flags ?? 0) & 0x04)) push("warning", "fill-rule-ignored", `DefineShape4 id ${t.shape.id} sets UsesFillWindingRule: the engine never reads the flag and fills every fill style even-odd (libtess2 TESS_WINDING_ODD, 0xa73bb0)`);
          if (t.shape) {
            const spread = (f: FillStyle | undefined) => f && f.gradient && (f.spread ?? 0) !== 0;
            const any = t.shape.fillStyles.some((f) => spread(f)) || t.shape.lineStyles.some((l) => spread(l.fill));
            if (any) push("warning", "gradient-spread-ignored", `${t.name} id ${t.shape.id} has a gradient with spread reflect/repeat: the game pads every gradient (no reflect/repeat in GradientAtlas::RasterizeRow 0xa27de0 or default_gradient.shader)`);
          }
          break;
        }
        case TAG.SymbolClass:
        case TAG.ExportAssets:
          for (const e of t.entries || []) {
            const file = vanillaExportSource(e.name);
            if (file) push("info", "export-shadows-vanilla", exportShadowsMessage(e.name, file));
          }
          break;
        case TAG.DefineSprite:
          if (t.tags) walk(t.tags, `${path}.tags`);
          break;
        default:
          if (JPEG_TAGS.has(t.code)) push("info", "jpeg-bitmap", `${t.name} id ${t.id ?? "?"}: decoded, but the game logs "WARNING: TEXTURE ENCODED AS JPG INSTEAD OF PNG"; prefer DefineBitsLossless2 (PNG)`);
          else if (!LOADER_ACCEPTED_TAGS.has(t.code) && !LOADER_SILENT_TAGS.has(t.code)) push("info", "tag-ignored", `${tagName(t.code)} (tag ${t.code}) is skipped by the loader (createTag 0xa2e990 default case) and draws nothing`);
      }
    });
  };
  walk(tags, "tags");
  return out;
}
