---
name: mewgenics-modding
description: Author, validate, and preview Mewgenics data-layer mods — GON/CSV overlay files loaded via `-modpaths` that recombine existing C++ behavior components — using this repo's editor MCP tools; use when creating or changing abilities, passives, items, characters, classes, difficulties, SWF art, or localization text, and not for native/C++ engine mods under `native/`.
metadata:
  version: "1"
  domain: mewgenics-data-modding
---

# Mewgenics data-layer modding

Mewgenics mods are overlay files that live in `mods/<name>/`, mirror the base
pack layout, and are merged over the base game data at load time. The data
layer only *recombines* behavior that already exists in the game's C++
components; it adds no new runtime logic. Use this skill to author, validate,
and preview those overlays. A mechanic no existing component expresses (new
status tick logic, new systems, new UI) belongs to the native layer
(`native/`), which is out of scope here.

## Use the editor's MCP tools

Prefer the editor's MCP tools over hand-editing GON/CSV. They read base data,
write overlays confined to the mod folder, and validate against the real base
pack, so they prevent the reference and localization mistakes that crash a
modded launch.

Start the stdio JSON-RPC 2.0 server:

```bash
node editor/src/mcp/server.ts
```

Tools, by purpose:

- `list_base_data` — list base game categories/entries (abilities, passives,
  items, characters, classes, difficulties, statuses/keywords, text keys).
- `read_base_entry` — read one base entry (e.g. ability `Spin`) as GON.
- `search_components` — search the ~2,007 `glaiel::<Name>` C++ component class
  names, with where-used.
- `read_mod` — read a mod's overlay files.
- `write_overlay` — create/update an overlay file under `mods/<name>/` (writes
  are confined to the mod folder).
- `validate_mod` — run reference, localization, and overlay-target checks;
  returns ok/warning/error with source locations.
- `preview_merge` — compute the effective merged object (base + overlay).
- `list_registered_native_names` — list native-registered status/ability names
  from `registered-names.json` (seeded with `JokersLuck`).
- `new_from_template` — scaffold an ability/passive/item/status-data overlay
  plus matching localization rows.

A web UI (`node editor/web/server.ts`, opened in a browser) browses base data
and components and shows inline validation and merge-preview. It is for a human;
as an agent, drive the MCP tools.

## How mods load

Each mod is a directory under `mods/<name>/` mirroring the pack
(`data/abilities/...`, `data/text/combined.csv`, `swfs/swflist.gon`, ...). The
loader takes space-separated paths:

```
-modpaths <dirA> <dirB>
```

The base pack is applied first, then each mod path in order; later paths
override earlier ones (since patch 1.0.20941). For structured files (`.gon`,
`.csv`, `.txt`) the overlay *mode* is chosen by the filename suffix. See
[references/gon-overlays.md](references/gon-overlays.md) for the full mode
semantics and CSV guidance.

Mode summary (full rules in the overlay reference):

- `X.gon` — replaces the whole file. Avoid; conflicts with every other mod.
- `X.gon.append` — appends the mod's children; use for **new** entries. An
  existing name is kept twice (never merged); the game then sees the appended copy.
- `X.gon.merge` — deep-merges by field name (arrays element-wise, extra items
  appended; scalars and mismatched types overwritten); use for **value changes**.
  Key suffixes are **not** read here — `foo.overwrite` is a literal field name
  (validator warning `merge-suffix-literal`); per-field policies need `.patch`.
- `X.gon.patch` — per-field policy via a key suffix (`.overwrite`, `.append`,
  `.merge`, `.add`, `.multiply`).
- `combined.csv.append` — add new localization rows (preferred); `.merge` is
  positional-by-column and fragile.

## Content shapes

The pack has an informal per-category schema (abilities, passives, items,
characters, classes, difficulties, the SWF art list, and the localization CSV),
plus GON syntax rules. Read
[references/content-shapes.md](references/content-shapes.md) before authoring,
and confirm real field names with `read_base_entry` rather than guessing.

## Validate and test safely

Always run `validate_mod` and inspect `preview_merge` before any in-game test.
Validation checks reference integrity, localization completeness, and
overlay-target existence; the [validation reference](references/validation-and-testing.md)
covers what each check catches and the in-game smoke-test pattern.

Save safety — hard rules:

- Launch modded play **only** via `launch-dev.bat` (repo root), which passes
  `-savesuffix dev` so modded play writes **separate** save files.
- **Never** launch mods against the main save.
- **Never** modify `Mewgenics.exe` or `resources.gpak`.
- **Never** read or write any file under a `saves/` directory.

The editor only reads base data and writes into `mods/<name>/`. The user keeps
an ~83%-complete main save that must stay untouched.

## Art without the UI

The MCP art tools cover the whole loop: `new_art_scene` → `import_svg { svgText, mod, into: { scene, shapeId } }` (or
`write_art_scene` with a whole scene; `dryRun` validates) → `build_swf` → `inspect_swf`. Gray fills (`gray:0..15`) are
palette-remapped by the game for cats; enemy clips are not paletted and are drawn mirrored; bitmaps are smoothed and
clamped (`npm run test:artprobe` shows the game drawing a probe; `docs/art-preview-plan.md` §8). The server has 24
tools; the art ones are `list_art_scenes`, `read_art_scene`, `write_art_scene`, `new_art_scene`, `import_svg`,
`export_svg`, `build_swf`, `inspect_swf`.

What the game does with a mod's SWF (OBSERVED 2026-10-20/21, build 25143593; `editor/src/core/art/engine-behaviour.ts`):

- **The root timeline is game-driven.** A character's root clip stays near its first frames (the game restarts it);
  nested sprites run on their own clock. Put free-running animation in a nested sprite; the root's frame labels are
  what the game selects.
- **No filters.** Any PlaceObject3 filter list (blur / glow / drop shadow) stops the game with
  "ERROR: FILTERS NOT SUPPORTED <swf>"; the validator refuses them (`filter-unsupported`). Bake glows and shadows into
  the art. Blend modes are fine.
- **No imports.** `ImportAssets2` entries are never linked: the SWF loads, but placing an imported symbol (e.g.
  catparts.swf's `CatHead`) crashes the game (engine-map "Imports are not linked"); the validator refuses any
  `scene.imports` (`import-unsupported`). Draw your own parts (the seven-slot cat rig: the Rig tab, `src/core/art/cat-rig.ts`).
- **Text the base game's way.** `scene.texts { id: { text, font, size, color, align, width, height } }`, placed by
  keys like a shape → a `DefineEditText` naming one of the game's eight font classes in `fonts.swf` (default
  `Peralta`; e.g. `Swanky`, `Edmundm`) plus a zero-asset `ImportAssets2("fonts.swf")`, no glyphs in the file. The
  string is literal: no loc keys, so the text is the same in every language.
- **SVG round trip** for an external vector editor (VectorCraft, Inkscape; static drawing only, animation stays in
  the scene's sprites): `export_svg { mod, path, shapeId }` writes `mods/<mod>/art/<shapeId>.svg`; bring the edit back
  with `import_svg { mod, path: "art/<shapeId>.svg", options: { applyViewBox: false }, into: { scene, shapeId,
  replace: true } }` to keep its coordinates. The UI has the same as Export SVG / Replace… on Shapes rows.

The display path is decompiled (`docs/engine-map.md` "SWF loader and display path"), so the validator and `inspect_swf`
report what the game's loader would do (`editor/src/core/art/swf-rules.ts`; errors stop a build):
- `font-tag-unsupported` (error, SWF): a DefineFont / DefineFont2 tag is FATAL in-game; only DefineFont3 decodes — use `scene.texts` with a game font class.
- `abc-count` (error, SWF): a second DoABC tag is FATAL; keep at most one.
- `bitmap-too-large` (error, scene + SWF): a bitmap with width or height >= 4096 (`texture_atlas_size`) is FATAL; keep both below it.
- `filter-unsupported` (error, scene + SWF): any PlaceObject3 filter list is FATAL; bake glows / shadows into the art.
- `import-unsupported` (error, scene + SWF): ImportAssets / ImportAssets2 entries are never linked; placing one crashes.
- `scaling-grid-ignored` (warning, SWF): DefineScalingGrid is skipped; there is no 9-slice.
- `gradient-spread-ignored` (warning, scene + SWF): spread reflect / repeat is written but the game pads every gradient.
- `morph-shape-skipped` (warning, SWF): DefineMorphShape is skipped (no shape tweens); key shapes on a timeline instead.
- `place-cxform-ignored` (warning, SWF): a PlaceObject (v1) colour transform is ignored; use PlaceObject2.
- `fill-rule-ignored` (warning, scene + SWF): the engine fills each fill style even-odd; a `nonzero` path whose sub-paths cross or self-overlap gets a hole in-game — set `fillRule` `evenodd` or split the overlap into separate paths.
- `export-shadows-vanilla` (info, scene + SWF): an export named like a vanilla export (e.g. `CatTail`) replaces it for every by-name lookup, last-loaded file first (INFERRED, untested).
- `jpeg-bitmap` (info, SWF): JPEG bitmaps decode but the game logs a warning; prefer PNG (DefineBitsLossless2).
- `tag-ignored` (info, SWF): a tag outside the loader's switch is skipped silently.
The preview draws what the engine does: even-odd fills over the sub-paths the emitter keeps, the cxform after the palette
remap, padded gradients, smoothed + clamped bitmaps.

Glows and drop shadows: **bake them** — `bake_glow { mod, path, shapeId, color, blur, kind?: glow|dropShadow, dx?, dy?,
strength?, steps?, replace? }` adds the halo shape `<shapeId>_glow` under the source on every layer that places it
(ordinary geometry the game draws like anything else; re-bake after editing the source). Never put SWF filters on a
key: the loader crashes on any filter list (`filter-unsupported`). For engine-side light or tint instead, give the
character the passives `CharacterLightSource { glow [r g b a] size N }` (an additive ground disc around the unit) or
`AdvancedTint [mul r g b a  add r g b a]` (a brightness lift of its pixels) — `docs/data-mods.md` "Lighting and tint
knobs"; neither is a rim.

## The mod-development loop (agent alone until the last step)

1. Author the overlays (`new_from_template`, `write_overlay`); `validate_mod` and
   `preview_merge` until clean.
2. Write `mods/<mod>/tests/<name>.mewtest` first, red, then make it green
   (`docs/tdd-procedure.md`). For combat behaviour: `enter TacticsTest`, load
   `_autoplay` next to the mod so the fight runs unattended, `spawn Rat` for an
   opponent, then `expect status` / `expect stacks … varied` / `expect round`
   (`docs/ingame-testing.md`). Run it with `run_ingame_test`. To poke at a live fight instead of scripting it
   (try a command, read the units, try another), `start_ingame_session` on `dev-sandbox/interactive-smoke`, then
   `ingame_exec { cmd }` / `{ op: "dump" }`, then `stop_ingame_session` — every exchange lands in the report.
3. Look at it: a script with `hide: false` and `shot "<label>"` lines; open the
   PNGs from `artifacts.shots` and check the scene, the icon, the text (T3a).
4. Open the PR with the red→green table and the T2 verdict lines.
5. **Human play-check, always the last step of a mod:** the PR's T3 list names
   exactly what the owner should play and judge (the ability in a fight, feel,
   pacing, balance). The owner's verdict closes the loop; nothing else needs them.

## References

- [references/gon-overlays.md](references/gon-overlays.md) — overlay modes,
  merge/patch policies, the loader, and CSV rules.
- [references/content-shapes.md](references/content-shapes.md) — per-category
  schemas, GON syntax, and the component-recombination boundary.
- [references/validation-and-testing.md](references/validation-and-testing.md) —
  the `validate_mod` checks, merge preview, save safety, and smoke testing.
