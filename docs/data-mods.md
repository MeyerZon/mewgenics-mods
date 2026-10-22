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
| `X.gon.append` | `Append` (0x945410): every mod child is added at the end of the base object (arrays concatenate). A name the base already has is **kept twice** — nothing is merged or replaced, and the game's by-name lookup then sees the appended copy. Key suffixes are not read. Use for new entries. |
| `X.gon.merge` | `DeepMerge` (0x945c30 under the constant MERGE policy): fields with matching names are merged recursively (the nth mod field named X into the nth base field named X), new fields appended, **arrays merged element-wise by index with the extra mod items appended**, strings/numbers and mismatched types overwritten. Key suffixes are **not** read (`foo.overwrite` is a field literally named `foo.overwrite`; the validator warns `merge-suffix-literal`). Use for value changes. |
| `X.gon.patch` | `PatchMerge`: like merge, but each field in the patch chooses its policy with a suffix: `field.overwrite`, `field.append`, `field.merge` (default), `field.add`, `field.multiply` (numbers). |

Examples in this repo: `mods/dev-sandbox/data/difficulties.gon.merge` (changes `wallet_size` on difficulty 0)
and `mods/dev-sandbox/data/abilities/fighter_abilities.gon.append` (adds `SpinDev`, a `variant_of Spin`).

CSV merge works by position: a `combined.csv.merge` row `,5,,` changes only column 2 of that row, so it is
fragile when the base game adds rows. Prefer `.append` with new localization keys.

## Fidelity to the decompiled merges (2026-10-21)

The GON decompiles on disk (`.analysis/decompiled/`, build 25143593) are, for the `.patch` side:
`Gon_PatchMerge_a_0x944cc0.c`, the **key-suffix → policy parser** (returns 3 `.overwrite`, 1 `.append`, 2 `.merge`,
4 `.add`, 5 `.multiply`, 0 none — checked in that order, and a key whose length *equals* the suffix length counts),
`Gon_PatchMerge_b_0x944f50.c`, the **recursive suffix stripper** (removes each of the five once, in that order, on
a node's own name and, for objects, all descendants; for arrays it recurses into the items), and
`Gon_DeepMerge_0x946680.c`, the **policy-driven merge** `(this, other)` that reads `other`'s suffix. A GON node is
0xb0 bytes: children vector at `+0x38/+0x40`, `int` at `+0x50`, `double` at `+0x58`, `bool` at `+0x60`, string
value at `+0x68`, name at `+0x88`, type at `+0xa8` (0 null, 1 string, 2 number, 3 object, 4 array, 5 bool).

The second pass (Ghidra session `loc`, `.analysis/notes-loc.md` "GON overlay functions") added the dispatch and the
other two engines. The file manager (`FileManager_ResolveWithOverlays_0x9a09f0.c`) tags each overlay path by
file-name suffix (`.append` → 1, `.merge` → 2, `.patch` → 3; `Gon_overlay_suffix_dispatch_0x9a1790.c` is only the
"has one of the three suffixes" predicate), and **`Gon_overlay_apply` 0x9a64a0** (`Gon_overlay_apply_0x9a64a0.c`)
parses each overlay and applies it to the resource's root: mode 0 swaps the whole object in, **mode 1 →
`Gon_Append` 0x945410**, **mode 2 → `Gon_DeepMerge_plain` 0x945c30** with the `MergeMode` callback
**`Gon_DefaultMergeMode` 0x9451c0, which returns the constant 2 (MERGE) for every node**, and **mode 3 →
0x946680**. The helpers both engines share are `GonObject_assign` 0x30cd0 (copy-assign: children, int, double,
bool, string, name, type), `GonObject_has_child_name` 0x942910 and `GonObject_child_by_name` 0x942b50 (`(this,
name, nth)` — an occurrence counter; with `nth == 0` they defer to the undecompiled 0x942880 / 0x942da0, presumably
the name index) and `FUN_14012a310(this, name) = index` (the name index write, repointed at every pushed child).

The editor's engine is `editor/src/core/overlay/merge.ts` (+ `policy.ts`); the table is pinned by
`editor/test/overlay-tests.ts` over `editor/test/fixtures/overlay/<case>/` (base + overlay → expected, compared
structurally). Rows marked *fixed* diverged before an audit and were brought in line test-first.

| Aspect | Decompiled behaviour (0x946680 unless noted) | Editor | Verdict |
|---|---|---|---|
| Which function serves which file kind | 0x9a64a0: `.append` → 0x945410, `.merge` → 0x945c30 with the constant policy 2, `.patch` → 0x946680. | `.append` → `append`; `.merge` → `deepMerge`; `.patch` → `patchMerge` (`overlay.ts`). | **MATCH** (was UNKNOWN). |
| `.append` file, object + object (0x945410) | Every overlay child is pushed as a copy (`FUN_140028830` / `FUN_140947a30`) and the name index repointed at it. A name the base has is **kept twice**: nothing recurses, merges or overwrites; a by-name lookup resolves to the appended (last) child. No suffix is read. | `append` pushes every entry; the value model keeps both; `preview_merge` / `touchedEntries` resolve a name to its last occurrence and report `occurrences`. | **MATCH** (pinned by `append-duplicate-name-keeps-both`); the by-name resolution of the preview was *fixed* (first occurrence). |
| `.append` file, array + array | Push a copy of every overlay item (concatenate). | Concatenate. | **MATCH** |
| `.append` file, string + string | `std::string::append` (`FUN_140051920`) — concatenation. | Concatenate. | **MATCH** (*fixed*: overlay won). Only reachable below a file root, i.e. never through a file, since a root is an object. |
| `.append` file, any other pair (number + number, object + array, …) | Logs `GON ERROR: Append incompatible types`, `this` unchanged. (A null `this` is first copy-assigned from `other` — INFERRED, Ghidra dropped the call's arguments — and would then append `other` onto itself; a parsed file root is never null.) | Base returned unchanged. | **MATCH** (*fixed*: overlay won). |
| `.merge` file, policy | `Gon_DefaultMergeMode` 0x9451c0 returns 2 for every node, so 0x945c30 never runs the suffix parser: `foo.overwrite` is a child literally named `foo.overwrite` (pushed if absent), at any depth. | `deepMerge` never parses suffixes; the validator warns `merge-suffix-literal` on any suffixed key in a `.merge`/`.append` file and registers the literal key as the mod-local name. | **MATCH** (pinned by `merge-suffix-is-literal`; was UNKNOWN). The validator's mod-local name was *fixed* (it stripped suffixes for every mode). |
| `.merge` file, object + object (0x945c30, mode 2 = mask `0x25` branch) | Per-call map name → count (`FUN_140123a00`); `has_child_name(this, name, nth)` → recurse `0x945c30(child_by_name(this, name, nth), other child, policy, policy)`; absent → push a copy + name index; the count bumps either way. | `mergeValue` with the same counter (`findNthIndex`). | **MATCH** (*fixed*: first occurrence always; pinned by `merge-duplicate-keys-nth-occurrence`). Same caveat as the `.patch` row: the `nth == 0` helpers are not decompiled. |
| `.merge` file, array + array | Mode 2: for each overlay index `i`, `i < this.size` → recurse into `this[i]`; else push a copy. Neither replace nor concatenate (public GON's `DeepMerge(other, OVERWRITE, APPEND)` would concatenate — the game does not). | Element-wise by index, extras appended. | **MATCH** (pinned by `merge-array-elementwise-appends-extras`; was UNKNOWN). |
| `.merge` file, string + string / number + number | Mode 2 is neither 4 nor 5: string assign; number copies double, int, string and bool views. | Overwrite. | **MATCH** |
| `.merge` file, type mismatch (object vs array/scalar, bool, null) | Falls to `GonObject_assign` 0x30cd0: `this = other` whole (children, scalars, name, type). | `clone(overlay)`. | **MATCH** |
| Suffix parser (`.patch`) | Order `.overwrite`, `.append`, `.merge`, `.add`, `.multiply`; first hit wins; `len >= suffix` (so a key that is exactly `.add` has the add policy and an empty name). | `policyOf` — same order, `>=`. | **MATCH** (*fixed*: was `>`). |
| Stacked suffixes | Policy from the parser (first hit on the full key); lookup name from the sequential strip (0x944f50 order, each once): `x.add.overwrite` → overwrite, `x`; `x.overwrite.add` → add, `x.overwrite`. | `parsePolicy` = `policyOf` + `stripName`. | **MATCH** (*fixed*: one suffix was stripped). |
| Key matching | Exact `std::string` compare on the stripped name; case-sensitive (the suffix compare is byte-exact; the lookup `FUN_140942910` is not decompiled but is keyed by the string). | `===` on the decoded key. | **MATCH** |
| Duplicate keys | Per-call map name → count (`FUN_140123a00` `operator[]`, `+1` after each child); `FUN_140942910(this, name, nth)` / `FUN_140942b50(this, name, nth)`: the nth patch child named X merges into the nth base child named X, past the base's count it is appended. Suffixed children count under their stripped name. Children appended under an `.append`/`.add` parent do not touch the map. | `findNthIndex` + the same counter. | **MATCH** (*fixed*: first occurrence always). Inference: the two helpers' `(name, nth)` reading is the only one consistent with the counter; a probe (base `a a`, patch `a a`) would confirm. |
| Type mismatch (obj/arr/scalar/bool/null in any mix) | Falls through every typed branch to `LAB_140947159`: copy-assign the patch node, then 0x944f50 strips its suffixes. | `overwriteWith` = clone + `stripPolicySuffixes`. | **MATCH** (*fixed*: suffixes were kept). |
| Object, `.overwrite` | Same copy + strip. | Same. | **MATCH** (*fixed*). |
| Object, default / `.merge` / `.multiply` | Per child: own suffix → own policy; no suffix → nth lookup, recurse (default) if present else push + strip. `.multiply` on an object is the default behaviour (mask `0x25` = {0, 2, 5}). | Same. | **MATCH** |
| Object, `.append` / `.add` | Unsuffixed children pushed (+ strip) even when the name exists (duplicates); suffixed children still follow their own policy. `.add` on an object is `.append` (`uVar4 == 1 || uVar4 == 4`). | Same. | **MATCH** |
| New field (absent in base) | Pushed with suffixes stripped recursively (object keys at every depth, including inside array items). | `stripPolicySuffixes(clone)`. | **MATCH** |
| Bare suffix key (`.add { … }`) | Stripped name empty → `FUN_140946680(this, child)`: the child's value is merged into the parent itself under the child's policy (so `o { .add { a 5 } }` appends a duplicate `a`). A self-`.overwrite` also renames the node to `""` and later children land on whatever the node became. | Same recursion; the entry keeps its key, and once the node stops being an object the remaining children are dropped (they would be invisible on the game's side too). | **MATCH** (*fixed*: was a field named `.add`); the post-self-overwrite tail is a documented approximation. |
| Array, `.append` / `.add` | Push copies of every item (`FUN_140028830` / `FUN_140947a30`) — **no** suffix strip on array branches. | Concat, no strip. | **MATCH** (pinned by `patch-array-push-keeps-item-suffixes`). |
| Array, default / `.merge` / `.multiply` | Element-wise by index (`FUN_140942f30` = size): `merge(this[i], other[i])` with the item's own (empty) name → default; extra items pushed, not stripped. | Same. | **MATCH** |
| Array, `.overwrite` | Copy + strip. | `overwriteWith`. | **MATCH** (*fixed*). |
| Numbers, `.add` / `.multiply` | `double` arithmetic on `+0x58` (`other + this`, `other * this`); `int_data = (int)result`; string re-rendered as an integer when `result == (double)(int)result`, else as a double; `bool = result != 0`. Ints vs floats are the same double path. | JS doubles; `numberNode` renders `String(n)`. | **MATCH** on value. Text of a non-integral result (preview only) may differ from the game's formatting — irrelevant to the game, which reads `number_data`. |
| Numbers, other policies | `.append`/`.merge`/`.overwrite`/default → copy value, int, string, bool. | Overwrite. | **MATCH** |
| Strings, `.append` / `.add` | `std::string::append` (`FUN_140051920`) — concatenation. Other policies assign. | Concatenate when both sides are GON strings; else overwrite. | **MATCH** (*fixed*: was overwrite). |
| Bools | No type-5 branch → any policy overwrites. | Bare `true`/`false` are treated as bools and overwrite. | **MATCH**, assuming the parser makes bare `true`/`false` bools (public GON does). |
| Scalar typing (`"5"` quoted, `true`) | Decided by the GON parser, not by these three functions. | Quoted tokens are strings (`num: null`); bare numerics are numbers. | **UNKNOWN**: public GON's tokenizer drops the quotes, so `"5"` may be a number for `.add`. Settle by decompiling the tokenizer/`LoadFromTokens`, or a `.patch` `.add` on a numeric the units event shows (`move`). |
| Recursion depth | Unbounded recursion. | Unbounded. | **MATCH** |
| Order and comments | GON nodes carry no comments (dropped at tokenize); children keep insertion order, new ones at the end. | Value model drops trivia, pretty-prints; order preserved, new fields appended. Comments survive only in the AST used for file editing. | **MATCH** (the merged preview having no comments is by design — the game sees none either). |
| Root policy | The file root has an empty name → default. | `patchMerge` starts at `default`. | **MATCH** |
| Null type (0) | Counted as having no children; null vs anything → overwrite. | No null node exists in the value model. | n/a |

Probe recipe for the remaining UNKNOWN row (scalar typing) and for the inferred `nth == 0` lookup: a test-only mod
under `mods/_golden-merge/` (see "Test-only overlays") with the overlay in question, `seed 42`, `enter TacticsTest`,
`spawn`, `dump`, and `expect unit` on `faction` / `move`; compare with MCP `preview_merge` for the same file. Keep
this section in sync with `merge.ts` and the fixtures.

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
