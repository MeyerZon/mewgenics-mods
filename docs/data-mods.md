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

## GON typing fidelity (2026-10-22)

How the game reads a `.gon` file, OBSERVED in `Gon_LoadText` 0x940840 → `Gon_Tokenize` 0x93f090 →
`Gon_ParseTokens` 0x93fcf0 (`.analysis/decompiled/`, notes in `.analysis/notes-gon.md` "Parser scalar typing"), and
how the editor (`editor/src/core/gon/`) compares. The editor's AST keeps every byte (`serialize(parse(x)) === x`
for all 210 vanilla files); its *typing* now follows the game's rules below. Pinned by `editor/test/gon-tests.ts`.

**Tokenizer.** The text is wrapped in `{ … }` and split into tokens: `{` `}` `[` `]` are single-character tokens
(no space needed: `a{b 1}`); `,` `:` `=` are whitespace, exactly like space / tab / CR / LF (`a=5`, `a:5`,
`[1,2,3]`); `#` starts a comment to end of line, even mid-token; `"` opens a quoted token (any pending bare token
is flushed first), inside it `\` escapes the next character — **only `\n` becomes a newline**, `\t` is a plain `t`,
`\"` → `"`, `\\` → `\` — and the closing `"` ends the token. **The quotes are dropped and no "was quoted" flag
survives**: `"5"` and `5` reach the parser as the same token. Unclosed quote / comment → `GON ERROR: didn't close
a quote/comment somewhere`. `//` and `/* */` are **not** in this tokenizer, yet 188 / 35 of the 210 vanilla
`data/*.gon` files use them (comments containing `"`, `{`, `:` that would otherwise break parsing), so an earlier
pass must strip them (INFERRED; not located — a candidate is the text pass at 0xa50bd0 before parsing).

**Parser.** `{` → object (type 3, children are `name value` pairs; `GON ERROR: missing a '}'`), `[` → array
(type 4; `missing a ']'`), anything else is a scalar typed **from its text alone**: type starts as string (1) and
the raw text is stored on the node (`+0x68`); `strtol(text, &end, 0)` → if `*end == 0` the node is a number (2)
with the int view at `+0x50`; `strtod(text, &end)` → if `*end == 0` number with the double view at `+0x58` (both
views are always stored: `1.5` → int 1 + double 1.5, `017` → int 15 + double 17, `1e3` → int 1 + double 1000);
then exactly `null` → null (0), `true` / `false` → bool (5). `Int()` returns the strtol view, `Number()` the
double, `String()` the stored text for strings, numbers and bools alike, `Percent()` reads `5%` as 0.05 from a
string; `.add` / `.multiply` (Gon_DeepMerge 0x946680) add / multiply the **double** views and re-render the text
(integers without a decimal point). `Bool()` on a non-bool logs `is not a bool`.

| Rule | Game (OBSERVED) | Editor before | Editor now |
|---|---|---|---|
| `"5"` vs `5` | identical number nodes (quotes dropped before typing); 12 vanilla `animation_suffix "2"` are numbers whose `String()` is `"2"` | quoted → string, `.add`/`.multiply` refused it, `patch-nonnumeric` warned | **DIVERGED → fixed**: `type: "number"`, `num 5`; `quoted` kept for the pretty-printer only; references still compare text |
| `0x10` / `0X1f` | number 16 / 31 (`strtol` base 0; `strtod` hex float) | string | **DIVERGED → fixed**: number |
| `1e3`, `-3`, `.25`, `5.`, `+7`, `1.5` | numbers (`strtod`) | numbers | MATCH |
| `017` | number; int view 15, double 17 | number 17 | MATCH (double view); the int view is not modelled — editor-only representation (only `Int()` sees it) |
| `""` (104 vanilla uses, e.g. `tooltip ""`) | **number 0** (`strtol` consumes nothing, `*end` is the NUL); `String()` still returns `""` | string | **DIVERGED → fixed**: `type: "number"`, `num 0`, `raw ""` |
| `" 5"` / `"5 "` | number / string (`strtol`/`strtod` skip leading whitespace only) | string / string | **DIVERGED → fixed** |
| `inf`, `-Infinity`, `nan` | numbers (UCRT `strtod`, C99; none in vanilla) | strings | **DIVERGED → fixed** (libc inference) |
| `true` / `false` | bool only with exactly these spellings, quoted or not | no bool type: both were strings | **DIVERGED → fixed**: `type: "bool"`, quoted or not |
| `True`, `TRUE`, `yes`, `no` (46 vanilla `no`), `1` | string / string / string / string / number | same | MATCH |
| `null` / `"null"` | null type (absent for every getter) | string | **DIVERGED → fixed**: `type: "null"` |
| `5%` (463 vanilla), `3+bonus…`, `pt-br`, `2-X`, `1.2.3`, `0x`, `+`, `-` | strings | strings | MATCH |
| `,` as whitespace | yes | yes | MATCH |
| `:` `=` as whitespace (`a=5`, `a:5`, `[1:2=3]`) | yes (no vanilla line has either outside a comment or a quoted string) | no — `a=5` was one bare token | **DIVERGED → fixed**; they live in the trivia, round trip intact; a string holding `=` `:` `,` is now pretty-printed quoted |
| `{ } [ ]` adjacency (`a{b 1}`, `c[2]`, `"a"5`) | single-char tokens; a quote flushes the pending token | same | MATCH |
| `#` line comment, also mid-token (`5#c` → `5`) | yes | yes | MATCH |
| `//` line and `/* */` block comments | not in the tokenizer; stripped earlier (INFERRED from 188 / 35 vanilla files) | comments | MATCH (inferred); editor-only until the pass is located |
| `#include "standard_nodes.gon"` (the 20 `maps/*.gon`, inside `nodes { … }`; the only vanilla `#` use) | to the tokenizer a `#` comment — so the same pre-pass must be a preprocessor that inlines the file (INFERRED) | a comment; the included nodes are invisible to the editor | gap (not fixed here): the editor neither inlines nor validates includes — a mod overlaying `maps/*.gon` nodes sees fewer base children than the game |
| `\n` in quotes | newline (5 vanilla uses) | newline | MATCH |
| `\t`, `\r` in quotes | plain `t`, `r` | tab, CR | **DIVERGED → fixed**; the pretty-printer emits raw tabs / CRs and escapes only `\` `"` `\n` |
| `\"`, `\\`, `\/`, `\z` | `"`, `\`, `/`, `z` | same | MATCH |
| scalar keeps its source text | yes (`+0x68`) | yes (`raw` + the exact token bytes) | MATCH |
| "was quoted" | no such flag | `quoted` drove typing | editor-only representation: `quoted` survives for byte-faithful output, never for typing |
| unclosed `"` / `{` / `[` | `GON ERROR: didn't close …` / `missing a '}'` / `missing a ']'` | `GonParseError` | MATCH (as a `gon-parse-error` finding) |

Consequences for mods: `.add` / `.multiply` work on `"10"`; a quoted numeric is **not** a way to force a string
(write `"5x"` or a non-numeric text if a string is needed, or check how the field is read — `String()` works on a
number node, so `palette "9"` and `animation_suffix "2"` are fine as they are). Reference checks in the validator
compare the text (`raw`), which is what `String()` returns, so quoted numeric names resolve as before.

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
