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
- **Tilesets** (`data/tilesets.gon`): one flat object per tileset (`alley`, `junkyard`, `sewers`, …, `house`,
  `tutorial`, `finalboss`; 22 in this build) of `key value` string pairs plus `global_objects` / `reverb`
  sub-objects, keyed by `default_tileset`. The game also uses it as a per-tileset **clip-name indirection** (below).

### Redirecting a vanilla character's clip via tilesets.gon (INFERRED, untested)

Decompiled 2026-10-21 (`ResolveClipName` 0x7bdbb0, called by `CharacterGraphics_build` 0xf1150 with
`(graphics.movieclip, "auto")` before the SymbolClass lookup; `docs/engine-map.md` "SWF loader and display path"):
for every **non-cat** character the game first looks `graphics.movieclip` up as a key in the *current* tileset's
object of `tilesets.gon` and, when the value is a string, uses that string as the clip name instead. Vanilla uses this
for `non_interactive_objects.gon`'s `static_1x1_a` / `static_tall_a`. Since the table is loaded once at boot
(`SpawnDatabase_init` 0x7a74b0), a mod overlay applies, so a data-only redirect should exist:

```
// data/tilesets.gon.patch — draw the Rat with the mod's SymbolClass MyModRat, without touching enemies.gon
alley    { Rat MyModRat }
junkyard { Rat MyModRat }
// … one row per tileset the character can appear in (incl. house if it shows there)
```

Caveats: the key namespace is shared with the tileset slots (`combat_background`, `static_*`, `debris`,
`event_piece_frame`, `reverb`, `global_objects`), the `_CAT` branch does not pass through this function, and the
validator does not model it. Not run in-game yet; the alternative is a mod SWF exporting the vanilla name itself
(by-name lookup prefers the last-loaded file; validator info `export-shadows-vanilla`), equally INFERRED.

Extract reference copies with `python -I tools/gpak.py extract .extracted --prefix data/` (git-ignored).

## Pairing data with a native status (Joker's Luck example)

`mods/jokers-luck/` is the data half of the sample native status: `keyword_tooltips.gon.append` names it,
`text/combined.csv.append` adds the `KEYWORD_JOKERSLUCK_*` and `ABILITY_JOKERSGAMBIT_*` rows, and
`abilities/fighter_abilities.gon.append` adds `JokersGambit`, a Spin variant whose `effects { JokersLuck 1 }`
applies the status. The native half (`native/mods/jokers-luck`) registers the name with the framework, which makes
`effects { JokersLuck N }` valid everywhere the game accepts a status name. Test in battle with the console command
`bind JokersGambit`, then use the ability; carriers should show a luck modifier that changes every turn.

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
