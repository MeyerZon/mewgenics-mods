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
- **Tilesets** (`data/tilesets.gon`): one flat object per tileset (`alley`, `junkyard`, `sewers`, …, `house`,
  `tutorial`, `finalboss`; 22 in this build) of `key value` string pairs plus `global_objects` / `reverb`
  sub-objects, keyed by `default_tileset`. The game also uses it as a per-tileset **clip-name indirection** (below).

### Redirecting a vanilla character's clip via tilesets.gon (OBSERVED 2026-10-22)

Decompiled 2026-10-21 (`ResolveClipName` 0x7bdbb0, called by `CharacterGraphics_build` 0xf1150 with
`(graphics.movieclip, "auto")` before the SymbolClass lookup; `docs/engine-map.md` "SWF loader and display path"):
for every **non-cat** character the game first looks `graphics.movieclip` up as a key in the *current* tileset's
object of `tilesets.gon` and, when the value is a string, uses that string as the clip name instead. Vanilla uses this
for `non_interactive_objects.gon`'s `static_1x1_a` / `static_tall_a`. The table is loaded once at boot
(`SpawnDatabase_init` 0x7a74b0), so a mod overlay applies.

**OBSERVED in-game 2026-10-22** (`mods/_tileprobe`, `npm run test:artprobe -- --tileset`, runs
`20261022-090748-_tileprobe-render-tileset-redirect` and the control `20261022-090756-_artprobe-render-tileset-control`,
both pass with the real save unchanged): with `alley { Rat ArtProbe }` a `spawn Rat` in TacticsTest (tileset alley)
draws `_artprobe`'s ArtProbe clip — the probe marker in both post-spawn shots (scale 1.72, mirrored, the same screen
box as the ArtProbe enemy), none in the pre-spawn baseline; the control without the overlay draws the vanilla Rat (no
marker). Pinned in `editor/test/fixtures/ingame/artprobe-tileset-summary.json` (`art-probes-tests.ts`).

Recipe — reskin a vanilla non-cat character without touching its GON:

```
// data/tilesets.gon.merge — `.merge` recurses into each tileset by name and appends the new key
alley    { Rat MyModRat }
junkyard { Rat MyModRat }
// … one row per tileset the character can appear in (incl. house if it shows there); a tileset you leave out draws vanilla
```

`MyModRat` is an export of your mod SWF (`build_swf`; the clip needs the labels the character plays, as for
`graphics.movieclip`). Caveats: the key namespace is shared with the tileset slots (`combat_background`, `static_*`,
`debris`, `event_piece_frame`, `reverb`, `global_objects`) — no vanilla tileset has a key `Rat` (T1 check in
`art-probes-tests.ts`), check your name the same way; every character whose `graphics.movieclip` is that name is
redirected (variants that keep `movieclip Rat` included); the `_CAT` branch does not pass through this function; the
validator does not model it. Only alley was run. The alternative — a mod SWF exporting the vanilla name itself
(validator info `export-shadows-vanilla`) — stays INFERRED.

Extract reference copies with `python -I tools/gpak.py extract .extracted --prefix data/` (git-ignored).

## Pairing data with a native status (Joker's Luck example)

`mods/jokers-luck/` is the data half of the sample native status: `keyword_tooltips.gon.append` names it,
`text/combined.csv.append` adds the `KEYWORD_JOKERSLUCK_*` and `ABILITY_JOKERSGAMBIT_*` rows, and
`abilities/fighter_abilities.gon.append` adds `JokersGambit`, a Spin variant whose `effects { JokersLuck 1 }`
applies the status. The native half (`native/mods/jokers-luck`) registers the name with the framework, which makes
`effects { JokersLuck N }` valid everywhere the game accepts a status name. Test in battle with the console command
`bind JokersGambit`, then use the ability; carriers should show a luck modifier that changes every turn.

## Lighting and tint knobs

The engine has no per-unit glow or outline a mod can switch on (the combat rim is a hover effect with a constant white
colour, and the SWF player refuses filter lists; `docs/engine-map.md` "Glow and outline passes", OBSERVED 2026-10-21).
What data *can* do, all plain passives on a character / class / item:

- **`CharacterLightSource { color [r g b] glow [r g b a] size N }`** — a `LightSource` on the unit feeding the scene's
  `Lighting` pass: `color` is the light pool that lightens ambient-darkened ground (visible only where a tileset's
  `Lighting { ambient … }` is below 1); `glow` is an **additive disc of colour on the ground tiles around the unit**
  (radius ≈ `size/2` tiles + one soft tile, per-tile resolution, bleeds onto the sprite and its neighbours; it is not
  sprite-shaped). Vanilla: `characters/enemies.gon` `passives { Undead 1  CharacterLightSource { color [.8, .9, 1]
  size 1.5 } }`, `small_enemies.gon` `CharacterLightSource { color [.7, .3, 1] … }`; `glow` is read only when the key
  exists (default 0). Works in combat (`Lighting` is `Instantiatable_InCombat`).
- **`AdvancedTint [ mul_r mul_g mul_b mul_a  add_r add_g add_b add_a ]`** — a full colour transform on the unit's
  sprite including the **additive** term, the only data-level way to brighten a sprite's own pixels. Vanilla:
  `characters/finalboss.gon` `passives { AdvancedTint [ .6, .6, .6, 1  .5, .5, .5, 0 ] }`. Per pixel; no rim.
- **`TintItem { mul [r g b] add [r g b] ignore_if_str_aux_equals <aux> }`** — the item-side form (`items/weapons.gon`
  ModelingClay: `add [0.05 0.05 0.05] mul [0.45 0.3 0.25]`); `EliteTint [r g b a]` / `EliteFlatTint [r g b]`
  (elite_buffs.gon) and `graphics { tint [r g b a] }` are multiplies only.

For a sprite-shaped glow or drop shadow, bake it into the art: the editor's `bake_glow` (`docs/art-pipeline.md` §6)
adds a halo shape under the source; the result is ordinary SWF geometry the game draws like any other.

**Glows (2026-10-22).** The per-unit glow is drawn by the framework: a native mod calls `FW_SetUnitGlow(Character*,
r, g, b, a)` / `FW_ClearUnitGlow` (framework API v4, `docs/engine-map.md` "Per-unit glow") and the framework draws a
coloured rim around the unit through the game's own outline mask; since glow v3 a **data mod asks for it with a status
name** and no DLL (next section). What the data layer always carries is the rim shader: `mods/fw-glow/shaders/fw_unit_glow.shader`
(`.shader` files in a mod path load like any pack file). A mod whose native half calls the API lists `fw-glow` next to
itself (`mods: <mod>, fw-glow` in a `.mewtest` header, `-modpaths … mods/fw-glow` in a launch); the harness directive
`glow <unit> <r> <g> <b> <a>` exercises it (`mods/dev-sandbox/tests/unit-glow.mewtest`). Static halos that need no
native code remain the editor's baked glow (PR #80).

## Asking for a unit glow from data (glow v3, OBSERVED 2026-10-22)

Give the unit a status named **`FwGlow_<rrggbb>`** or **`FwGlow_<rrggbbaa>`** (hex, either case; alpha `ff` when
omitted) and load `fw-glow` next to your mod: the unit glows that colour for exactly as long as it carries the status.
Any vanilla way of applying a status works — the name is the whole request:

```
// data/characters/enemies.gon.append — a unit that glows from the moment it spawns (mods/fw-glow ships this as FwGlowRat)
MyGlowingRat {
    variant_of Rat
    passives {
        StatusOnSpawnIn {          // or StatusOnBattleStart for units present when the fight starts
            FwGlow_ff00ff 1
        }
    }
}
// an ability: damage_instance { effects { FwGlow_00ffff 1 } }, or temporary_effects / Temporary { status FwGlow_00ffff … }
```

- **How it works.** mewframework recognises the name in its `apply_status` hook (no registration, no Mewjector name)
  and builds a LuckUp-template status with the glow vtable, **without** LuckUp's luck bonus; the 13 name-keyed lookups
  read it as LuckUp, so nothing reports `NO STATUS NAMED`. Removing the status by any vanilla route (expiry of a
  Temporary, stacks to 0, a cleanse, death) ends the rim on the next frame. One glow status per unit: a second
  `FwGlow_` apply merges into it and the **latest colour wins**. Several units in different colours work (glow v2).
- **Validator.** `editor/registered-names.json` carries a pattern entry (kind `glow`, `^FwGlow_(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$`),
  so any such name is a valid status; a name in the namespace that does not fit (`FwGlow_ff00f`) is the error
  `invalid-glow-name`; on an exe the bindings do not know, `native-build-unknown` warns (the framework stays off).
- **Display.** The status icon on the unit's bar is LuckUp's (the four-leaf clover, seen in the shot); name and
  tooltip should come from `keyword_tooltips` by the full name (INFERRED from JokersLuck; a T3 look) — `mods/fw-glow` names `FwGlow_ff00ff` "Glowing"; give each
  colour you use an entry, or alias it: `FwGlow_00ffff { alias FwGlow_ff00ff }`.
- **Limits.** Combat only (the glow engine rides `TacticsTest`); up to 16 glowing units; native mods may not register
  a `FwGlow_` name (`FW_STATUS_ERR_RESERVED`); a native `FW_SetUnitGlow` / `FW_ClearUnitGlow` on the same unit takes it
  over (the status then no longer drives it). Proven by `mods/fw-glow/tests/data-glow.mewtest` (`npm run test:unitglow --
  --data`; fixture `editor/test/fixtures/ingame/data-glow-summary.json`: a 5620 px magenta rim around the spawned
  FwGlowRat, none before the spawn).

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
enemies value); `text/combined.csv.append` rows (no header line in an append file) supply both names. Fixtures:
`editor/test/fixtures/ingame/result-golden-{vanilla,merge}.jsonl`.

The numeric policies (2026-10-22, `tests/numeric.mewtest` / `tests/numeric-vanilla.mewtest`): the harness's `expect
gon` reads the merged entry the game holds for a spawned unit (`Character+0x240`, `docs/ingame-testing.md`), so
`.add` / `.multiply` are pinned against the game itself. OBSERVED on build 25143593 (`enemies.gon.patch`: `Pooter {
properties { faction.overwrite allies  health.multiply 2 } stats { speed.add 10 } }`): `properties.health` = number 12
(int 12, double 12, text "12"; vanilla 6/6/"6"), `stats.speed` = number 15 (vanilla 5) — PatchMerge rewrites the int,
the double **and** the token text of the node; `properties.faction` = string "allies"; and what `Character::init` made
of it in the units event: `hp` 12 (vanilla 6: current HP right after a spawn is `properties.health`), `speed` 15,
`constitution` 5. The `.merge`d Rat keeps `health` 5 / `hp` 5 / `strength` 4 while its `namekey` is `GOLDEN_RAT_NAME`.
The editor's preview agrees (`run-tests.ts` 4d: speed 15, health 12). Fixtures:
`editor/test/fixtures/ingame/result-golden-numeric{,-vanilla}.jsonl`.

## Localized text for mods (OBSERVED 2026-10-22 — plain text boxes only)

Decompiled 2026-10-21 (session `loc`; `docs/engine-map.md` "Localization and text fields"): the game loads **every**
`data/text/*.csv` the file manager sees (`StringsDatabase_load_csv` 0x9610a0 — so a `combined.csv.append` row is in the
same table as vanilla's), and the text-box constructor `DynamicTextBox_init_from_DefineEditText` 0x98d910 passes a
`DefineEditText`'s initial text to `has_key_current_lang` 0x963070: an initial text that is exactly a key of the
current language becomes that key's localized text at creation (gendered `_M/_F/_N` rows and `{TOKEN}` replacements
included, INFERRED; a miss shows the key itself). `SetText(…, localize = 1)` 0x98e790 does the same at runtime.

**OBSERVED in-game 2026-10-22** (`mods/_artprobe/tests/render-loctext.mewtest`, `npm run test:artprobe -- --loctext`,
run `20261022-090100-_artprobe-render-loctext`, pass, real save unchanged; fixture
`editor/test/fixtures/ingame/artprobe-loctext-summary.json`): the `ArtProbeLoc` clip carries four key texts next to
one-letter-off look-alike literals and the English values. Result, the same in every readable shot:

| initial text | HTML flag | drawn as |
|---|---|---|
| `ENEMY_TOMTOM_NAME` (vanilla key) | off (`html: false`) | **Tom Tom** — localized |
| `ARTPROBE_LOCTEST` (this mod's `combined.csv.append` row) | off | **LOCALIZED OK** — localized |
| `ENEMY_TOMTOM_NAME` | on (vanilla's `<p align><font …>` wrapper) | `ENEMY_TOMTOM_NAME` — as written |
| `ARTPROBE_LOCTEST` | on | `ARTPROBE_LOCTEST` — as written |

So the key must be the initial text **byte-for-byte without HTML**: in the wrapper the string the constructor tests is
not the bare key (INFERRED: the raw HTML, or the stripped text with the `<p>` newline). Plain texts draw in the same
font, size and colour as HTML ones (the DefineEditText fields carry them; T3 look owed).

Recipe:
1. `data/text/combined.csv.append`: `MY_MOD_LABEL,Hello,notes,Hola,Bonjour,…` — fill **every** language column
   (the key must exist in the current language's table; the empty-cell fallback to `en` is INFERRED).
2. `scene.texts.label = { "text": "MY_MOD_LABEL", "html": false, "font": "Peralta", "size": 24, … }`, placed by a key.
3. `build_swf`. The text is resolved once at instance creation (not on a language switch).

Not done: the editor does not switch a key text to plain by itself, and the validator does not warn about an
HTML-wrapped key (follow-up); the preview draws the key, not the localized value. Measure and its limits:
`editor/src/core/art/probe-outcomes.ts` (ink masks per box on a clip-space grid, key vs value vs look-alike,
min over ±3 px shifts; a box under 60 % of its best ink — the "Battle Start!" banner, the unit — does not vote).
