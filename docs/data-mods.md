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

**Glows (2026-10-22).** The per-unit glow is a **native-only API in v1**: a native mod calls `FW_SetUnitGlow(Character*,
r, g, b, a)` / `FW_ClearUnitGlow` (framework API v4, `docs/engine-map.md` "Per-unit glow") and the framework draws a
coloured rim around the unit through the game's own outline mask. There is no data-level way to ask for one yet — no
`registered-names.json` kind, no GON key; a `glow` kind that a status or passive could name is the natural v2 once
per-unit colours exist. What the data layer does carry is the rim shader: `mods/fw-glow/shaders/fw_unit_glow.shader`
(`.shader` files in a mod path load like any pack file). A mod whose native half calls the API lists `fw-glow` next to
itself (`mods: <mod>, fw-glow` in a `.mewtest` header, `-modpaths … mods/fw-glow` in a launch); the harness directive
`glow <unit> <r> <g> <b> <a>` exercises it (`mods/dev-sandbox/tests/unit-glow.mewtest`). Static halos that need no
native code remain the editor's baked glow (PR #80).

### Mod-shipped shaders (validator, 2026-10-22)

A file `mods/<mod>/shaders/<name>.shader` is compiled by the game when native code asks for it by name
(`ShaderManager_GetOrCreateMaterial(mgr, "<material>", "<name>.shader")`; `fw-glow`'s `fw_unit_glow.shader`, `fw-3d`'s
`fw_mesh.shader`). It is not a data overlay, so the validator checks it against the game's shader dialect
(`editor/src/core/shader/dialect.ts`, from `Shader::compile` 0xa55470; `docs/engine-map.md`) instead of warning
`whole-file-replace`:

| Code | Severity | Meaning |
|---|---|---|
| `shader-version-first` | error | the first non-comment line is not `#version` (the engine adds none) |
| `shader-entry-missing` | error | no `" vert()"` / `" frag()"`: that stage gets no `main()` |
| `shader-entry-shadowed` | error | the first `" vert()"` / `" frag()"` (e.g. in a comment) is not the `void vert() {` definition; only the first is renamed |
| `shader-guard-missing` | error | no `#if`/`#elif COMPILING_VERTEX_PROGRAM` (or `..._FRAGMENT_...`) guard |
| `shader-include-missing` | error | an `#include` that is neither in the mod's `shaders/` nor a base shader |
| `shader-include-unchecked` | info | no `.extracted/shaders` to look in (CI) |
| `shader-uniform-missing` / `shader-uniform-type` | error | a uniform native code sets by name is undeclared / of another type (`EXPECTED_UNIFORMS`: `fw_mesh.shader` → `FW_MESH_UNIFORMS`) |
| `shader-attribute-unbound` | warning | a vertex `in` not named `position`/`color`/`texcoord`/`mvp`/`color_xform`/`depth_bias` (the engine binds locations by those names only) |
| `whole-file-replace` | warning | the name is a base shader: the mod replaces it for every material |

A shader that another shader in the same mod `#include`s is a library: it needs no `#version`, entry points or
guards. Not settled: whether the loader resolves an `#include` against the `-modpaths` as well as the pack (the
validator accepts both); `fw_mesh.shader` avoids the question by including nothing.
## 3D models in a mod (preview)

Phase M of `docs/possible_3d_work.md`: real meshes in the vanilla (orthographic) combat scene, drawn by mewframework.
This section is the **data seam and the API**; what draws today is listed at the end.

**The GON key.** A `data/characters/*.gon` entry (inanimate objects such as `Crate` are characters there) names its
model inside its `graphics { }` block, next to `movieclip`:

```
Crate {
    graphics {
        movieclip Crate           // vanilla, stays: the 2D fallback whenever the framework is inactive
        model "models/crate.obj"  // the 3D model mewframework draws for this unit
    }
}
```

Why `graphics`: that block is where the game keeps everything about how a unit looks (`movieclip`, `name`,
`water_mask`, `tooltip`, `depth_offset`), so the 3D look sits next to its 2D fallback and a `.merge` touches one block.
The game's own GON getters look keys up by name and never ask for `model`, so vanilla ignores it — **INFERRED** (no
reader of the key exists in the pack's data or the decompiles seen so far; no T2 run has checked the GON log for it
yet). Add it with a `.merge` (`mods/fw-3d/data/characters/inanimate_objects.gon.merge`); the validator knows
`graphics.model` is a framework key and does not warn `merge-target-missing` for it.

**The value.** Either a file in the mod — `models/<name>.obj` (sub-folders allowed: `models/props/tire.obj`) — or
`"@Name"`, a model a native mod registers with the mesh engine and declares in `editor/registered-names.json` as
`{ "name": "Name", "kind": "model", "mod": "<mod>" }` (kind `model` names resolve only `@` references, never a status
or ability). Path rule (the editor's `editor/src/core/model3d.ts` and the DLL's `fw_obj3d_model_path_ok` apply the
same one): relative to the mod folder, starts `models/`, ends `.obj`, `.gltf` or `.glb` (lowercase; one rule with the DLL's loader, `fw_mesh_model_kind`, so a path that validates also loads; see "glTF models" below), no `..`, no empty
segment, no backslash, not absolute, printable ASCII, under 64 bytes. Model files are served through `-modpaths` like
any pack file (`ResourceManager_GetBinaryResource`, the first mod path that has the file; `possible_3d_work.md` §1
"Mesh bytes") and are **mod-only**: the pack has none, so nothing is looked up in base data. Files under a mod's
`models/` are assets, not overlays (no `whole-file-replace`). World units: 1 = one tile, axes = the game's
(x, height, z), +height up, the model's origin = the anchor (tile centre / the unit's position) on the ground.

**Validator codes** (all errors, on `<Entry>.graphics.model`): `model-path-invalid` (the rule above, or not a
string), `model-file-missing` (`mods/<mod>/models/...` is not a file), `model-unregistered` (`@Name` without a
`kind: "model"` registration). A `model` key anywhere else is not checked.

**The native API (framework API v6, `native/framework/src/framework_api.h`).** A native mod places objects itself:

| Function | Does |
|---|---|
| `int FW_Register3DObject(void *character, const char *model, const float transform[16])` | attach a model to a unit (it follows the unit); one per unit, registering again replaces it; dropped when the unit's pool slot is reused (the glow registry's generation check). Handle > 0, 0 refused. |
| `int FW_Place3DObjectOnTile(int col, int row, const char *model, const float transform[16])` | place a model on a tile, anchored at the tile centre (col + 0.5, 0, row + 0.5); any number per tile. Handle > 0. |
| `int FW_Unregister3DObject(void *character_or_null, int handle)` | remove a unit's object (character given) or the object with `handle` (character NULL). 1 when removed. |

`transform` is the object's own model matrix (column-major, world units), applied after the translation to the anchor;
NULL = identity. Up to 64 objects; they belong to the current fight scene (a new `TacticsTest` clears them); main
thread only. The registry is `native/framework/src/fw_obj3d_rules.c` (host-tested by `test_obj3d_rules.c`) behind
`obj3d_engine.c`. The GON key is read at run time from the unit's live, overlay-merged entry at
`Character+OFF_CH_GON_ENTRY` (0x240, the pointer the harness's `expect gon` walks) by `fw_gon.c`'s walker
(`fw_gon_model`, promoted from the harness's `mt_gon.c`, host-tested by `test_gon.c`) through a VirtualQuery-guarded
reader (`obj3d_engine_unit_model`).

**What draws today vs not (2026-10-22, OBSERVED in a fight).** The mesh engine (`native/framework/src/mesh_engine.c`)
draws every object of the API v6 registry: tile objects (`FW_Place3DObjectOnTile`) and unit objects
(`FW_Register3DObject`, following the unit's position), with `mods/fw-3d/shaders/fw_mesh.shader` (Lambert, base colour;
an inline flat shader when `fw-3d` is not on the mod path). Seen in-game: `models/crate.obj` read from `mods/fw-3d`
through the mod path and drawn on a tile next to the probe cube (`docs/engine-map.md` "Mod models and the mod shader").
Since phase M2 (below): per-unit GON models, sorting with the sprites, textures and the palette. Not yet: `@Name` models; animation; `render3d` modes (floor / billboard / upright); perspective (phase P). Tile entries
(`data/tiles.gon`) have no runtime entry pointer yet, so tiles get models through `FW_Place3DObjectOnTile` only.

**glTF models (the DLL's loader, `fw_mesh_gltf.c`).** What a `.gltf` / `.glb` must be to load on the first try:
- glTF **2.0** (`asset.version` "2.x"); one `.glb` (preferred), or `.gltf` + `.bin` side by side in `mods/<mod>/models/`,
  or a `.gltf` with the buffer as a `data:` URI; name `<name>.gltf|.glb`, letters/digits/`_`/`-`, at most 63 bytes
  for the whole `models/...` path, lowercase extension, sub-folders fine; OBJ texture v is flipped on load (`v' = 1 - v`).
- **Triangles only** (Blender: Triangulate modifier or the exporter's option); points/lines/strips are refused.
- At most 1 048 576 vertices / 3 145 728 indices for the whole model (a prop: a few thousand).
- **Y up** (the glTF / Blender exporter default "+Y Up"); **1 unit = 1 m = 1 tile**; origin = the feet / ground contact,
  centred on the tile, nothing below y = 0. The loader mirrors z (the game's axes are left-handed) and keeps the winding.
- Node transforms and hierarchies are baked (applying transforms first is optional; mirrors are handled); several
  meshes / primitives are merged into one model.
- POSITION (float) required; NORMAL recommended (else flat shading); TEXCOORD_0 float or normalized u8/u16.
- **Refused by name:** Draco (`KHR_draco_mesh_compression`), meshopt, `KHR_texture_transform`,
  `KHR_mesh_quantization`, KTX2/Basis/WebP textures, any other *required* extension, sparse accessors, morph targets.
  **Ignored:** skins (bind pose drawn), animations, cameras, lights, a second UV set, vertex colours, tangents.
- One material: only `baseColorFactor` and the `baseColorTexture` image are read (metallic/roughness/normal/occlusion/
  emissive ignored); the texture is drawn from `textures/models/<name>.png` (see "What draws (phase M2)"), not from the glTF's own image
  yet.

**Loading.** Needs a framework built with API v6 (mewframework 0.6) on a known build, and `mods/fw-3d` on the mod
path next to the mod that uses it (`mods: <mod>, fw-3d` in a `.mewtest` header, `-modpaths … mods/fw-3d` in a
launch): `mods/fw-3d` ships `models/crate.obj` (a hand-written 0.8-unit crate with normals and UVs) and gives the
vanilla `Crate` its `graphics.model`. The API version is v6 because two open PRs (#109 CatRig, #111 `FW_Random`)
each claim v5; their `FwApi` fields go before the v6 ones when they merge (the owner settles the order).

### The block form (phase M2)

The value of `model` may also be a block, so one `.merge` still touches one key and the string form stays valid:

```
Rat {
    graphics {
        model {
            file "models/rat.glb"      // required: models/<...>.obj|.gltf|.glb, or "@Name"
            scale 1                    // uniform, > 0; 1 model unit (1 Blender metre) = 1 tile
            yaw 45                     // degrees about the height axis; 0 = the model's front (glTF +Z, Blender -Y)
                                       // faces the lower right; +45 = straight down, +90 = lower left (clockwise on
                                       // screen); multiples of 45 match the iso view
            offset [0 0 0]             // (x, height, z) in tiles, applied after scale and yaw
            texture "models/rat.png"   // under the mod's textures/ (default: textures/models/<model name>.png)
            tint [1 1 1 1]             // multiplies the base colour (3 numbers = alpha 1)
            palette true               // a cat's own palette row (phase M3, see below); no row on non-cats
            double_sided false         // stored
        }
    }
}
```

Validator codes for the block: `model-path-invalid` (also a block without `file`), `model-file-missing`,
`model-unregistered`, `model-scale`, `model-yaw` (error; warning when not a multiple of 45), `model-offset`,
`model-tint`, `model-flag` (palette / double_sided not a bool), `model-texture-missing` (warning),
`model-key-unknown` (warning).

### What draws (phase M2, OBSERVED in fights 2026-10-22)

- **Per unit from GON:** every unit of the fight whose entry has `graphics.model` (string or block) gets its model,
  anchored at the unit's position on the floor and following it as it moves (the position is interpolated, so the
  model slides with the sprite); it turns with the unit (phase M3: the yaw follows Character::Face, see "Facing" below). Units present at the start of a fight are picked
  up at the first turn, units spawned later on the next frame. The 2D sprite still draws next to the model unless the block says `hide_sprite true` (phase M3).
  Try it: `mods/_unitmodel` (the vanilla Rat with a magenta box), `npm run test:ingame -- _unitmodel unit-model`.
- **Sorting with the sprites:** a model takes its place in the units layer like a unit standing at its origin — a
  model on a tile is hidden behind units nearer to the camera and drawn over units farther away; a model on a unit is
  drawn right after that unit's sprite. A model larger than one tile is sorted by its origin only, so a long model can
  still be drawn over a unit next to its far end; a model and a unit on the same tile: the model is on top. Models are
  drawn under the HUD and anything on the layers above the units layer.
- **Textures:** a model `models/<...>/<name>.obj|.gltf|.glb` uses `textures/models/<name>.png` of the same mod when
  that file exists (sub-folders dropped), or the block's `texture`. Ship **8-bit RGB or RGBA PNGs**, at most 2048 px a
  side (grey / indexed / 16-bit PNGs are refused, `model-texture-format`). Texels are used as stored (the game
  premultiplies alpha on load); alpha < 0.5 is cut out. glTF uvs as exported; OBJ `vt` is flipped on load. The glTF's
  embedded image is not read yet — put the PNG at the conventional path. A named texture that is missing = one
  `model-texture-missing` line and the base colour.
- **The palette rule** (like cat art): with a palette row ≥ 0, every pixel whose colour (texel × base colour, before
  lighting) is grey (r, g, b within 0.001) becomes `palette.png`'s texel at column `round(grey × shade × 15)` of that
  row (shade = the face's light, 0.45..1); coloured pixels pass through. Paint the parts that should take a cat's
  colours in exact greys. Today a row is set by the probe (`MEWFW_MESH_PROBE_PALETTE`) and inside the framework
  (`fw_obj3d_set_material`); an exported API call and a cat's own row for GON units come next.
- **Probe knobs** (`mods/dev-sandbox/tests/mesh-probe.mewtest`, `mods: dev-sandbox, fw-3d`): `MEWFW_MESH_PROBE=1`
  (or `<col>,<row>`) draws the magenta cube; `MEWFW_MESH_PROBE_MODEL=models/crate.obj|models/pillar.glb` places that
  model one tile to the right; `MEWFW_MESH_PROBE_TEXTURE=models/x.png`, `MEWFW_MESH_PROBE_PALETTE=<row>` set its
  material. `cd editor && node scripts/make-fw3d-assets.ts` regenerates `mods/fw-3d/textures/models/crate.png` and
  `mods/fw-3d/models/pillar.glb` (`--check` compares).

### 3D models: error codes


A model that cannot be loaded is a missing model, never a crash: the unit keeps drawing its 2D `movieclip`. The
framework writes **one line per model per game session** to `mod_logs/mewframework.log`, and the editor's validator
reports the same codes at `<Entry>.graphics.model`. One list serves both (`native/framework/src/fw_mesh_rules.c`
`FW_MESH_CODES` = `editor/src/core/model-codes.ts`, pinned identical by a test).

What the log says:

```
mesh: models/crate.glb: model-glb-header: glb version 1 is not 2 — drawing the 2D clip
mesh: models/crate.obj: model-parse-error: face index 7 out of range (3 vertices) at line 4 — drawing the 2D clip
mesh: models/crate.obj: loaded 24 vertices, 12 triangles, bounds x -0.40..0.40 h 0.00..0.80 z -0.40..0.40
mesh: models/tree.gltf: loaded 812 vertices, 1204 triangles, bounds x -0.42..0.42 h -0.20..0.90 z -0.40..0.40; model-no-normals, model-below-floor
```

A loaded model's warnings / info codes are appended to its `loaded` line after `; `.

Errors (the model is refused; the unit draws its 2D clip):

| Code | Log (mewframework.log) | Validator | How to fix |
|---|---|---|---|
| `model-path-invalid` | `mesh: <path>: model-path-invalid: not a models/<name>.obj\|.gltf\|.glb path ...` | error, with the reason | Use `models/<sub/folders/>name.obj\|.gltf\|.glb`, forward slashes, relative to the mod folder, < 64 bytes. |
| `model-file-missing` | `... not found on the mod path (mods/<mod>/<path>) nor in the game's resources, or empty` | error | Put the file at `mods/<mod>/<path>` (exact case); a 0-byte file counts as missing in the game. |
| `model-unregistered` | (editor only) | error | Declare the `@Name` in `editor/registered-names.json` with `kind: "model"`, or use a file path. |
| `model-parse-error` | the parser's words, OBJ with `at line N` | error (JSON / GLB JSON only) | Fix the OBJ line named; re-export a glTF whose JSON parses. |
| `model-extension` | `not a .obj, .gltf or .glb file` | error | Export OBJ, glTF (.gltf) or GLB. |
| `model-glb-header` | `glb version N is not 2`, `not a GLB file (no glTF magic ...)`, `... not 4-byte aligned`, `... past the end` | error | Re-export the .glb (glTF 2.0 binary); a truncated download or a renamed .gltf gives this. |
| `model-gltf-version` | `no asset object (not a glTF file)` / `asset.version must be 2.x` | error | Export glTF 2.0. |
| `model-extension-required` | `glTF extension required but not supported: KHR_draco_mesh_compression` | error, naming it | Export without that compression / extension (Blender: untick Draco). |
| `model-uri-unsupported` | `buffer N: uri '...' is not a safe relative path`, `data URI is not base64` | — (game only, until #128) | Keep buffers / images relative to the model, no `..`, no `http:`; or export .glb. |
| `model-buffer-missing` | `buffer N: no reader for x.bin` / `... has no uri and there is no .glb BIN chunk` | — | v1 does not read external `.bin` files: export .glb or "glTF Embedded". |
| `model-buffer-range` | `bufferView N ... is outside buffer`, `accessor N ... is outside bufferView` | — | The file is truncated or corrupt: re-export. |
| `model-accessor-invalid` | `accessor N: bad componentType`, `byteStride ...`, `accessor N does not exist` | — | Re-export; this is an exporter bug. |
| `model-sparse-unsupported` | `accessor N: sparse accessors are not supported` | — | Apply morphs / disable sparse output on export. |
| `model-primitive-mode` | `mode 1 is not TRIANGLES (4)`, `unsupported OBJ statement 'l'` | — | Export triangles only (no loose edges / points). |
| `model-attribute-missing` | `mesh N primitive N has no POSITION` | — | Re-export. |
| `model-attribute-format` | `POSITION accessor N must be VEC3 float`, `TEXCOORD_0 ... integer components must be normalized` | — | Turn off mesh quantization (KHR_mesh_quantization) on export. |
| `model-index-range` | `index 7 out of range (3 vertices)`, `N indices is not a multiple of 3` | — | Re-export / triangulate. |
| `model-node-invalid` | `node N does not exist`, `mesh N does not exist`, `material N does not exist` | — | Re-export; a dangling index. |
| `model-node-cycle` | `node N is reached twice (a cycle or a shared child)` | — | Give every node one parent. |
| `model-empty` | `no faces` (OBJ) / `no triangles to draw` | error (OBJ with no `f`) | Make sure the mesh object is exported (selection only? hidden?). |
| `model-limit` | `more than 1048576 vertices (limit)`, `node tree is too deep`, `the model registry is full (32 models per process)` | — | Decimate the model; use fewer distinct models. |

Warnings / info (the model loads):

| Code | Sev. | Where | Meaning / fix |
|---|---|---|---|
| `model-multi-material` | warning | game | More than one material: v1 draws every part with the first one. Join materials / bake to one texture. |
| `model-morph-ignored` | warning | game | Morph targets (shape keys) are skipped: the base mesh draws. |
| `model-skin-ignored` | warning | game + validator | Skins are skipped: the bind pose draws. |
| `model-animation-ignored` | warning | game + validator | Animations are skipped: the model draws still. |
| `model-below-floor` | warning | game | Part of the model is under height 0 (more than 0.01): the origin is the ground point, so it sinks into the floor. Move the origin to the feet. |
| `model-texture-no-uvs` | warning | game | A texture is named but the model has no UVs. Unwrap it. |
| `model-no-normals` | info | game | No normals in the file: flat ones are computed. |
| `model-texture-embedded` | info | game | The texture is inside the file (GLB bufferView / data URI). |
| `model-mtl-ignored` | info | game + validator | OBJ `mtllib` / `usemtl`: .mtl files are not read. |
| `model-extension-ignored` | info | game + validator | `extensionsUsed` (not required): ignored by v1. |
| (reserved) `model-ngon-concave`, `model-texcoord-set`, `model-texture-transform-ignored`, `model-alpha-blend`, `model-image-format`, `model-heavy`, `model-footprint`, `model-texture-missing`, `model-texture-format`, `model-texture-size`, `model-attribute-ignored` | | — | In the list (so both halves agree) but not raised yet: they arrive with the texture / budget phases and PR #128's reader. |

"—" in the Validator column: the editor's reader is header-level for now (extension, GLB container, `asset.version`,
`extensionsRequired`, OBJ faces, ignored extensions / skins / animations / mtl); these codes appear only in
mewframework.log until PR #128's full reader lands. Note: a refused model reports its error only — warnings are not
listed for it (the log has one line).


### 3D models: phase M3 (2026-10-22)

#### hide_sprite — the model replaces the 2D sprite

| key | type | default | meaning |
| --- | --- | --- | --- |
| `hide_sprite` | bool | false | `true`: the unit's 2D sprite is not drawn while its model is drawn (the mesh replaces the sprite). The shadow, HUD (health bar, status icons) stay. If the model fails to load (any `model-*` error code in the log) the sprite draws as usual. A value that is not `true`/`false` is the validator's `model-flag` error and the DLL logs `model-flag hide_sprite` and keeps the sprite. |

Modder notes: only the unit's own body sprite is hidden; the hover outline and a native glow still trace the sprite's
silhouette (a known limit), and hit flashes do not reach the mesh yet. Tile objects (`FW_Place3DObjectOnTile`) have no
sprite, so the flag does nothing there; API-registered unit models (`FW_Register3DObject`) never hide the sprite (no
API for it in v6/v7 — GON only).

Example:
```
Rat { graphics { model { file "models/rat.glb"  hide_sprite true } } }
```

#### Palette row for `palette true` — a cat's own row

- In the block: `palette true   // grey pixels take the unit's palette row: a cat's own row (as its 2D body); none on
  a non-cat unit`.
- **Which row (M3):** with `palette true` on a **cat** (any unit with the `_CAT` clip: player cats, enemy cats such as
  TomTom or Mangy) the model's grey pixels take exactly the palette row the cat's 2D body uses — its `custom_cats` /
  class `graphics.palette`, or an `OverridePalette` passive's row while it is active (the row follows changes live,
  e.g. the Jester's cycling). A cat with the multi-palette sentinel (−69, the rainbow cats) uses its base row on the
  model. On a **non-cat** unit (a Rat, a Crate) `palette true` has no row: the game never palette-remaps those units,
  so the model's greys stay grey (use `tint` to recolour it, as `graphics.tint` does for the sprite). `palette false`
  or no `palette` key = colours as authored. A row set by a native mod (`fw_obj3d_set_material`) is kept unless the
  block says `palette true`.
- Try it: `mods/_unitpal` (test-only: TomTom, Mangy and the Rat wear a grey box with `palette true`),
  `npm run test:ingame -- _unitpal unit-palette` (`mods: dev-sandbox, fw-3d, _unitpal`).

#### Named models (`@Name`, data/models.gon)

##### Named models ("@Name")

Declare a model once by name and use it on any number of units:

```
// mods/<mod>/data/models.gon.append
Crate   { file "models/crate.obj"  scale 0.8  yaw 45  texture "models/crate.png" }
Pillar  "models/pillar.glb"
```

```
// mods/<mod>/data/characters/enemies.gon.merge
Rat    { graphics { model "@Crate" } }                       // the entry as declared
Pooter { graphics { model { file "@Crate"  scale 1.5 } } }   // the entry, with this unit's scale
```

- An entry is a model value: a `models/<...>.obj|.gltf|.glb` path, or a block with that `file` and any graphics.model keys
  (`scale yaw offset texture tint palette double_sided`). A unit's block keys override the entry's. `file "@Name"` in the unit names the entry.
- An entry cannot name another `@Name`, so there are no chains.
- **mods/fw-3d ships the base `data/models.gon`.** The game only loads overlays of a file whose plain base exists on the mod path.
  Declare your models with `data/models.gon.append` (or `.merge` / `.patch`), never a plain copy. The validator warns
  `whole-file-replace` on a plain copy, because it replaces the base and everything merged before it.
- **List fw-3d before your mod** in `-modpaths` / a `.mewtest`'s `mods:`, e.g. `mods: fw-3d, <your mod>`. The loader drops overlays
  from mod paths listed before the one that holds the base (observed). With fw-3d listed after your mod, your names are unknown in game.
- Codes (one list with the DLL):
  - `model-name-unknown` (error): the name is declared in no data/models.gon entry and registered by no native mod. In game, the unit
    keeps its 2D clip and one line per reference is logged.
  - `model-registry-entry` (error): the entry is not a model. Causes: no string file, an `@` chain, not a models/ path, or neither a
    string nor a block.
  - The entry's other keys get the block codes (`model-scale`, …). Its file gets the path, file and reader codes.
  - `model-unregistered` is no longer raised.
- The validator resolves `@Name` against this mod's registry, mods/fw-3d's, and `editor/registered-names.json` kind model. In game,
  any mod on the path counts.

#### A .glb's embedded image as the model texture

##### A model's own texture (`.glb` with an embedded image)

A `.glb` exported with its texture packed in (Blender: *glTF Binary*, Images = Automatic / PNG) now draws with that
texture with nothing else to do — no `textures/models/<name>.png` needed. Which texture a model draws with:

1. `texture "models/<file>.png"` in the GON `model { }` block (or a native mod's `FW_Set3DObjectMaterial`) — always wins;
2. otherwise the image embedded in the model file (the base-colour texture of the first material, a PNG in the
   `.glb`'s binary chunk or a `data:image/png;base64,` URI in a `.gltf`);
3. otherwise `textures/models/<model name>.png` in your mod, when it exists.

The DLL decodes the PNG itself, in memory (nothing is written anywhere). It reads 8-bit PNGs: RGB, RGBA, palette,
grey, grey+alpha; not interlaced; up to 2048 px a side. JPEG textures are not read (`model-image-format`): export PNG.
Problems with the embedded image never stop the model from drawing: you get one warning in `mewframework.log` and the
convention file (or the base colour) is used:

| code | meaning |
| --- | --- |
| `model-image-embedded-invalid` (warning) | the image cannot be read: a broken bufferView, bad base64, or a corrupt PNG |
| `model-image-embedded-unsupported` (warning) | 16-bit, interlaced, an unknown critical chunk, or larger than 2048 px — re-export |

To edit the texture as a file: MCP `extract_model_texture { mod, path: "models/<name>.glb" }` writes it to
`mods/<mod>/textures/models/<name>.png` (it refuses to overwrite unless `overwrite: true`; `dryRun: true` only checks).
Because the embedded image wins over that file, name it explicitly to draw your edited copy:
`model { file "models/<name>.glb"  texture "models/<name>.png" }` (or re-export the .glb).

#### Facing — the model turns with Character::Face

- **Facing (M3):** a unit's model turns with the unit. When the game turns the unit (moving, attacking, the harness's
  `face`), the model rotates about its origin so its **front** (glTF +Z / Blender −Y, the side `yaw 0` puts to the
  lower right) points the way the unit faces: lower right, lower left, upper left or upper right on screen. Author
  the model facing +Z (Blender: facing −Y) and leave `yaw` at 0; `yaw` and `offset` are still applied, on top of the
  turn (e.g. `yaw 180` for a model authored facing backwards). Units that never turned (direction (0,0)) follow their
  sprite's mirror instead. Try it: `mods/_unitface` (a box with a cyan front and a yellow back on the vanilla Rat),
  `npm run test:ingame -- _unitface unit-face` once PR #114 (the `face` directive) is merged.


#### Multi-tile meshes (per-band slices) and the mesh/unit tie

- A model placed on a tile is drawn row by row: the engine cuts it along the board's depth (x + z) into one slice per
  diagonal row of tiles it covers and slots each slice into the sprites' painter order at that row, so a model larger
  than one tile (a 2x1 wall, a 3x3 platform) hides the cats standing behind each of its rows and is hidden by the cats
  standing in front of them. No GON setting is needed: the footprint is the model's bounds (the `model-footprint`
  warning stays a warning: a big model is now supported, the warning says it overlaps neighbouring tiles).
- A unit standing on the same tile as a model: the part of the model behind the unit's feet is drawn under the unit,
  the part in front over it. Put props meant to stand behind a unit on the back half of their tile (+x / +z in game
  axes; an OBJ file's z is negated on load, so that is -z in the file).
- Models attached to a unit (per-unit models) are not cut: they are drawn right after their unit.
- Requires `mods/fw-3d` (its `fw_mesh.shader` declares `uniform vec2 fw_clip`); a mod's own `fw_mesh.shader` must
  declare it too (validator `shader-uniform-missing`), and keep the clip: `if (fw_clip.y > fw_clip.x && (d < fw_clip.x
  || d >= fw_clip.y)) discard;` with `d` = world x + z.

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
