# Data-layer mods (GON overlays)

The developer-built `-modpaths` loader is the official way to change Mewgenics content without touching
`resources.gpak` or the executable. Everything in `mods/<name>/` mirrors the pack layout.

## Launching

Use `launch-dev.bat` (repo root). It starts `Mewgenics.exe` directly with `SteamAppId=686060` in the
environment (same approach as Mewtator), passes `-savesuffix dev` so modded play writes separate save files,
turns on the debug console and dev mode, and points `-modpaths` at `mods/dev-sandbox`. Steam must be running.
Keep Steam's own launch options empty so vanilla launches never see mod data.

Multiple mod folders: `-modpaths <dirA> <dirB>` (space separated, quote paths with spaces). Later paths
override earlier ones (since patch 1.0.20941).

## Overlay file kinds

For structured text files (`.gon`, `.csv`, `.txt`) a mod file is named `<original>.<mode>`:

| File | Semantics (from GON's `gon.h`) |
|---|---|
| `X.gon` (no suffix) | Replaces the whole file. Avoid; conflicts with every other mod touching it. |
| `X.gon.append` | `Append`: objects and arrays get the mod's children added at the end. Use for new entries. |
| `X.gon.merge` | `DeepMerge`: fields with matching names are merged recursively, new fields appended, mismatched types overwritten. Use for value changes. |
| `X.gon.patch` | `PatchMerge`: like merge, but each field in the patch chooses its policy with a suffix: `field.overwrite`, `field.append`, `field.merge` (default), `field.add`, `field.multiply` (numbers). |

Examples in this repo: `mods/dev-sandbox/data/difficulties.gon.merge` (changes `wallet_size` on difficulty 0)
and `mods/dev-sandbox/data/abilities/fighter_abilities.gon.append` (adds `SpinDev`, a `variant_of Spin`).

CSV merge works by position: a `combined.csv.merge` row `,5,,` changes only column 2 of that row, so it is
fragile when the base game adds rows. Prefer `.append` with new localization keys.

## Content shapes seen in the pack

- **Abilities** (`data/abilities/*.gon`): `Name { template ...; class <C++ class>; meta { name KEY; desc KEY; class Fighter }; graphics {...}; sounds {...}; cost { mana N; infcantrip true }; target { target_mode; aoe_mode; knockback_mode; multihit }; damage_instance { damage "3+bonus_melee_ability_damage"; knockback 1 }; temporary_effects { Status N } }`. `variant_of X` inherits and overrides.
- **Passives** (`data/passives/*.gon`): `Name { name KEY; desc KEY; class Butcher; 1 { passives { AddStatusToBasicAttack { Rot 1 } } } 2 { ... } }`, where the inner keys (`AddStatusToBasicAttack`, `UncappedHP`, `StatusOnEatFood`) are C++ component class names.
- **Items** (`data/items/*.gon`): `Name { name KEY; desc KEY; rarity common; kind head|face|neck; frame N; set Scrap; shield 4; passives { Metal 1 } }`.
- **Characters** (`data/characters/*.gon`): `Name { variant_of Base; properties { faction allies; inherit_faction true }; abilities { can_get_bonus true }; ai { brain PlayerBrain }; graphics { tint [r g b a] } }`.
- **Classes** (`data/classes/classes.gon`): `Fighter { meta {...}; graphics { palette 54; alt_animations [...] }; attack_pool [...]; ability_pool [...] }`.
- **Difficulties** (`data/difficulties.gon`): numeric keys `0..N { boss_health_multiplier; wallet_size; easy {...}; hard {...} }`.
- **SWF list** (`swfs/swflist.gon`): `game [ ... ]` array of SWF files; add art with `swflist.gon.append`.
  In this repo `mods/<mod>/swfs/` is **build output** of the editor's art pipeline (the SWF and the generated
  `swflist.gon.append`) and is git-ignored; the source is `mods/<mod>/art/*.scene.json`.
- **Text** (`data/text/combined.csv`): `KEY,en,notes,sp,fr,de,it,pt-br,ru,ko,ja,zh-cn`.

Extract reference copies with `python -I tools/gpak.py extract .extracted --prefix data/` (git-ignored).

## Pairing data with a native status (Joker's Luck example)

`mods/jokers-luck/` is the data half of the sample native status: `keyword_tooltips.gon.append` names it,
`text/combined.csv.append` adds the `KEYWORD_JOKERSLUCK_*` and `ABILITY_JOKERSGAMBIT_*` rows, and
`abilities/fighter_abilities.gon.append` adds `JokersGambit`, a Spin variant whose `effects { JokersLuck 1 }`
applies the status. The native half (`native/mods/jokers-luck`) registers the name with the framework, which makes
`effects { JokersLuck N }` valid everywhere the game accepts a status name. Test in battle with the console command
`bind JokersGambit`, then use the ability; carriers should show a luck modifier that changes every turn.

**Glows (2026-10-22).** The per-unit glow is a **native-only API in v1**: a native mod calls `FW_SetUnitGlow(Character*,
r, g, b, a)` / `FW_ClearUnitGlow` (framework API v4, `docs/engine-map.md` "Per-unit glow") and the framework draws a
coloured rim around the unit through the game's own outline mask. There is no data-level way to ask for one yet — no
`registered-names.json` kind, no GON key; a `glow` kind that a status or passive could name is the natural v2 once
per-unit colours exist. What the data layer does carry is the rim shader: `mods/fw-glow/shaders/fw_unit_glow.shader`
(`.shader` files in a mod path load like any pack file). A mod whose native half calls the API lists `fw-glow` next to
itself (`mods: <mod>, fw-glow` in a `.mewtest` header, `-modpaths … mods/fw-glow` in a launch); the harness directive
`glow <unit> <r> <g> <b> <a>` exercises it (`mods/dev-sandbox/tests/unit-glow.mewtest`). Static halos that need no
native code remain the editor's baked glow (PR #80).

## Limits of the data layer

Data recombines ~1,750 existing C++ behavior components. A mechanic that no component expresses
(new status tick logic, new systems, new UI) needs the native layer (`native/`).

## Test-only overlays

`mods/_autoplay/` is not content: its one overlay, `data/characters/player_cat.gon.merge`, gives `PlayerCat` the
`Uncontrollable` passive (the status class BrainChip and the disorders use), so in a harness fight the player cat's
turns are taken by the AI and the fight resolves without input. Load it next to the mod under test
(`mods: <mod>, _autoplay` in the `.mewtest` header); never play with it. The validator reports
`merge-target-missing` for `PlayerCat.passives.Uncontrollable` because the base `passives` block is empty — the
merge adds it, which is the point.

`mods/_golden-merge/` (2026-10-20, TDD target 8 "golden through `dump`") pins the overlay policies against the
game itself, differentially: `tests/vanilla.mewtest` and `tests/golden.mewtest` play the same seeded fight
(`seed 42`, `enter TacticsTest`, `spawn Rat` / `Pooter` / `GoldenRat`) without and with the overlays and assert the
units event with `expect unit`. OBSERVED: `enemies.gon.merge` (`Rat { graphics { name "GOLDEN_RAT_NAME" } properties
{ faction allies } }`) → the spawned Rat dumps as `Golden Rat`, faction 1; `enemies.gon.patch` (`Pooter { properties
{ faction.overwrite allies } stats { speed.add 10 } }`) → Pooter faction 1; `enemies.gon.append` (a new entry
`GoldenRat { variant_of Rat … }`) → `spawn GoldenRat` works and it dumps as `Appended Rat`, faction 2 (the vanilla
enemies value); `text/combined.csv.append` rows (no header line in an append file) supply both names. What the dump
cannot see: `.add` / `.multiply` on stats (`speed.add 10` is pinned at T0 only, against the editor's engine, by
`run-tests.ts` 4d) — the units event carries no stat or HP field; the follow-up is in `TODO.md` target 8. Fixtures:
`editor/test/fixtures/ingame/result-golden-{vanilla,merge}.jsonl`.
