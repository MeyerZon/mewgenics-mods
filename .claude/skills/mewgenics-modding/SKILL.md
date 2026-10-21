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
- `X.gon.append` — appends the mod's children; use for **new** entries.
- `X.gon.merge` — deep-merges by field name; use for **value changes**.
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
clamped (`npm run test:artprobe` shows the game drawing a probe; `docs/art-preview-plan.md` §8).

New cat animation (the engine's shape: `_Append_CatTest` frames `<name>F` / `<name>B` on the root, each placing a cat
rig as the child `ani` at depth 1 — the instance the engine restarts on every play; the rig's seven slots are EMPTY
sprites, `parts: "game"`): `new_art_scene { mod, name, template: "cat-animation", animation: "<name>" }` → pose the
empty slots over the frames if you want (never put art in them: the game draws the cat's own parts — palette, texture,
face — into empty slots, and a visible non-empty slot crashes it; placeholder art is preview-only) → `build_swf` →
refer to it bare from GON: `alt_animations [[idle <name>]]` on a character or `animation <name>` on an ability (the
engine adds the facing suffix; a missing F or B label is a silent no-op, so keep both). `write_art_scene { dryRun: true }`
reports the `cat-anim-*` findings (`cat-anim-slot-not-empty` when a slot holds art; the info `cat-anim-untested` says
what the game draws, OBSERVED in PR #74 once its empty-slot run lands). Never export a clip named `CatTest` itself:
clips resolve through a global last-loaded-first registry and it would replace the cat for every cat
(`cat-clip-override`).

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
