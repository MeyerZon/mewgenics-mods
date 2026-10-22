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

Not every file in a mod folder is an overlay: `tests/` (the harness's `.mewtest` scripts), `art/` (the editor's
scene sources; the built SWFs go under `swfs/`) and dotfiles are never loaded by the game (the pack has no such
root), so the validator skips them (`isPackPath` in `editor/src/core/validate/validator.ts`; before 2026-10-22 each
`.mewtest` drew a `whole-file-replace` warning). The one exception is `art/*.scene.json`, which the validator runs
through the scene validator (`text-loc-key-html` and the other scene codes) instead of skipping.

### Comments and `#include` (OBSERVED 2026-10-22, engine-map "GON text pre-pass")

Every `.gon` the game loads — base files **and** every mod `.gon`, `.gon.append`, `.gon.merge`, `.gon.patch` — goes
through the same pre-pass before parsing, so a mod file may use all of these:

- `# …`, `// …` comments to end of line, `/* … */` block comments (no nesting: the first `*/` closes; an unclosed
  `/*` silently swallows the rest of the file — the validator warns `comment-unclosed` at its line). Comment markers
  inside `"…"` are text.
- `#include "file.gon"` (quotes optional; the name may not contain a quote; anything after it on the line stays):
  the file's text — its own comments stripped, its own includes expanded — is pasted in place, so put it where its
  content belongs (vanilla: `nodes { #include "standard_nodes.gon" … }` in the 19 `maps/*.gon`).
- **Where it resolves:** `<directory of the file being loaded>/<name>`, by the pack path. For an overlay that is the
  directory of its **base** file: in `mods/m/data/maps/alley.gon.append`, `#include "x.gon"` means `data/maps/x.gon`,
  looked up in the mod folders first and then the pack — so a mod can ship `mods/m/data/maps/x.gon` and include it
  (**OBSERVED in-game 2026-10-22**: `mods/_incprobe` — `IncProbe { variant_of Rat  #include "incprobe_props.gon" }`
  in `data/characters/enemies.gon.append`, the included file only in the mod's `data/characters/`; the spawned unit
  has the included `health 77`). A helper the mod ships only to be included is an include fragment: the validator
  does not call it a `whole-file-replace` when the base has no file of that name.
  A nested include resolves against the **top-level** file's directory, not the included file's.
- **Write the name as a plain relative path** (`x.gon`, `sub/x.gon`). The game joins `directory + name` and never
  normalises it (OBSERVED, `.analysis/notes-inc2.md`): the pack is searched for that exact string (lower-cased), a
  mod folder through the OS. So `../maps/x.gon`, `./x.gon`, `a//b.gon`, a leading `/`, a drive letter or a
  backslash never find a pack file (fatal, see below) and, for loose files, let the OS resolve the path — a `..` can
  reach outside the mod folder. The validator reports these as `include-path-unsafe` (error) and never reads them.
- **A missing include is fatal:** the game shows an error message box `Could not locate include file: <name>` and
  exits. The validator
  reports it as `include-missing` (error) at the directive's line.
- **Overlays and included files:** the includer's overlays apply after inlining (an `alley.gon.merge` sees the
  included nodes as part of the base). An overlay *on the included file's own name* (`standard_nodes.gon.append`)
  is picked up, but included files are read as plain text, so its text is just **pasted after** the base text —
  `.append` behaves as expected inside the including object, while `.merge` / `.patch` do **not** merge (their keys
  arrive as extra children, `.patch` suffixes literally). To change shared nodes, overlay each including file.
- **`#define` macros** (unused by vanilla — 0 of 210 files —; derived from `Gon_Pre_CollectDefines` 0xa4f4a0,
  `Gon_Pre_ExpandMacros` 0xa501c0, `Gon_Pre_SubstituteArgs` 0xa4e0b0; **OBSERVED in-game 2026-10-22** for a
  two-argument macro, `mods/_incprobe` `IncProbeMacro`). Only in the file being loaded and what it includes (each
  file — the base and each overlay — has its own macro table; a base file's macros are invisible to its overlays).

  ```
  #define NODE(name, kind)          // parameters: tokens in ( ), separated by blanks or , (a space before ( is fine)
      name { type kind }           // the body: from right after ) up to #end, newlines included
  #end
  nodes {
      #NODE shop1 shop             // use: #NAME, then one token per parameter (blanks or , between them)
      #NODE camp1, camp
  }
  ```
  becomes `nodes { shop1 { type shop } camp1 { type camp } }`. The rules: the whole `#define … #end` is removed
  (definitions anywhere in the file count, later ones replace earlier ones); a use is a `#`-word exactly equal to
  `#NAME` — **`#NODE(shop1, shop)` is not a use** (no blank after the name: the tokenizer then reads it as a `#`
  comment), and `#NODE (shop1, shop)` works but leaves the `)` in the text; arguments and parameter names are
  tokens delimited by blanks and `( ) , : = [ ] { }` (no quotes, no spaces inside an argument); in the body only
  whole tokens equal to a parameter are replaced (`name_x`, `"name"`, `#name` are not), and the body's last
  token is replaced only when a blank or delimiter follows it (end the body with a newline before `#end`). Macro
  names and calls are not looked for inside `"…"`. Without parameters the body starts at its first non-blank
  character. Expansion repeats over the whole text until nothing changes, at most 256 rounds (a macro may use another;
  a self-using one stops there — the validator warns `gon-macro-runaway`). An unknown `#NAME` stays and is a `#`
  comment to the tokenizer. The editor expands macros exactly this way before validating and previewing.

The editor mirrors this in `editor/src/core/gon/preprocess.ts` + `editor/src/core/gon-includes.ts`; the validator and
the merge preview check the text the game would actually parse, while the GON editor keeps comments and `#include`
lines as written.

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
a quote/comment somewhere`. `//`, `/* */` and `#include` are **not** in this tokenizer (188 / 35 / 19 of the 210
vanilla `data/*.gon` files use them): the pre-pass `Gon_Preprocess` 0xa50bd0 strips the comments and inlines the
includes first (OBSERVED; "Comments and `#include`" above, engine-map "GON text pre-pass").

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
| `//` line and `/* */` block comments | stripped by the pre-pass `Gon_Pre_StripComments` 0xa4eb80 (OBSERVED): `//` keeps its newline, `/* */` drops its newlines, no nesting, `/*/` closes at once, never inside `"…"` | comments (trivia); `/*/` ran to the next `*/` | **`/*/` DIVERGED → fixed**; otherwise MATCH. The semantic readers (validator, merge preview) parse `preprocess()` output, which is the exact port — the trivia tokenizer still differs where the pre-pass ignores `#` comments (a `/*` or `"` inside a `#` comment counts to the game; none in vanilla) |
| `#include "standard_nodes.gon"` (19 `maps/*.gon`, inside `nodes { … }`; the only vanilla `#` directive) | inlined by `Gon_Pre_ExpandIncludes` 0xa4edf0 from `<dir of the resource>/<name>` as a TextResource (OBSERVED; missing = fatal) | a `#` comment; the included nodes were invisible | **DIVERGED → fixed**: `preprocess()` + `gon-includes.ts` inline it for the validator and the merge preview (mod copy first, the mod's overlays on the included name concatenated as text); `include-missing` when it resolves nowhere; the editing AST keeps the line as trivia |
| `#define NAME … #end` / `#NAME` macros | expanded by the pre-pass, top level only (OBSERVED: decompiles + one in-game 2-argument macro; none in vanilla) | not modelled | **DIVERGED → fixed** (2026-10-22): `preprocess()` expands them (passes 3/4, synthetic tests in `gon-tests.ts` "gon macros"); `gon-macro-runaway` past 256 rounds |
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
  A **new** tileset name is an `.append` entry (OBSERVED, "Maps, rooms and encounters").
- **Maps and rooms** (`data/maps/*.gon`, `levels/**/*.lvl`, `data/spawns.gon`, `data/tiles.gon`): see "Maps, rooms
  and encounters" below.

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

## Component keys (2026-10-22)

A component block is `passives { <Component> { key value … } }` (also `bonus_passives` / `additional_passives`, a
component nested inside another, and a status under `effects` / `temporary_effects`). The game has no schema: a key
the component never reads is **silently ignored** — the commonest silent mod bug. `editor/component-schema.json`
(tracked) maps, per `glaiel::` class, the keys it reads from its own block: type as read, default when absent,
whether it is required, inherited base keys, and the decompile that witnesses each one. MCP `search_components`
returns it for the top matches; the web UI's component search shows it when you click a class name.

- **What the validator does with it.** `unknown-key` (warning): a child of a component block that the component (or
  its base classes, or a shared parser it includes) never reads. `missing-required-key` (error): a required key absent
  from a complete block — `.append` files and new files only; `.merge` / `.patch` blocks are partial and the base may
  supply the key. `.patch` keys are checked without their policy suffix (`chance.multiply` → `chance`). A component
  that is `open` (its key set may be incomplete) is never flagged; a component whose `children` are `effects` or
  `passives` also accepts status / effect / passive names as children (`AddStatusToBasicAttack { Bleed 1 }`), and
  `children: any` accepts every key (an arbitrary map: `FormChanger { 0 {…} 1 {…} }`, element names, part names).
- **Proof on vanilla (T1).** Every vanilla component block passes with zero findings (`editor/test/
  component-schema-tests.ts`: 210 files, 7728 component blocks, 2204 object blocks checked, 0 findings; and four
  vanilla files copied as renamed `.append` mods give 0 `unknown-key` / `missing-required-key`). The generator
  enforces it by construction: a key vanilla writes that RE did not find **opens** the component and is listed in its
  `vanillaMissed`; a `required` key some vanilla block omits is demoted.
- **Patterns the RE found (OBSERVED; `docs/engine-map.md` "Component GON keys").** A Passive's data node is
  `this+0x68`; most classes read keys lazily in event slots or in `std::function` lambdas, not in an init. The
  scalar form `Comp N` is the stacks for most components (`Passive` reads `stacks`, the logging `Int` on a number
  node), but many inline lookups are **child-or-self**: `ChanceToBlock 0.3` is `chance`, `DeathRattle X` is
  `ability`, `MovementReaction X` is its ability (the `scalar` field says which). `statuses` / `passives` /
  `damage_instance` / `pattern` sub-blocks are optional: absent, the component's own node is used, so
  `MeleeRevengeDamage { damage 2 type melee }` and `MeleeRevengeDamage { damage_instance { … } }` are both valid.
  Shared parsers (`shared` in the schema): `@DamageInstance` (`DamageInstance::FromGon` 0x2ba080, 30+ keys),
  `@StatusesBlock` / `@StatusList` (`Passive_ApplyStatusChildren` 0x76a160: every child except the class's own keys
  is a status application — scalar = stacks, `[stacks chance]`, or `{ stacks chance }`), `@BrainGon` (0x134400:
  `decision_weights move_weights animate_choice auto_orient`), `@FormChangerForm`, `@Passive_QueueAbility`
  (`even_if_stunned`, `force_display_name`, which every ability-casting passive reads).
- **Vanilla quirks it surfaced** (the game ignores these vanilla values): `LowHealthAllyDodgeChanceAura { theshold … }`
  (the engine reads `threshold`, default 5), `AbilityOnRoundEndOnce { even_of_stunned … }` (reads `even_if_stunned`),
  `TourettesMeows { cooldown … }` (reads `pool`, `duration`), `DamageReductionAura { allies_only … }` (hard-coded),
  `MoveTowardsDamageSource { ability … }` (reads `move_ability`). They stay `open` so vanilla stays clean.
- **Coverage (build 25143593).** 1741 classes with a vftable (of the 2007 `glaiel::` names; the other 266 are not
  components: templates, lambdas, helpers): 473 mapped from decompiles, 898 read no keys of their own, 369 carry only
  the objdump seed keys (engine / UI / ability-hierarchy classes that never appear as a block; `confidence:
  inferred`), 1 unresolved (`AddAdvantageToEvent`). 1314 keys: 767 observed with a decompile, 547 inferred. Vanilla:
  of 384 components vanilla writes as object blocks, 345 are closed (unknown keys flagged), 39 open; vanilla literal
  keys found 589 / 635 (+188 keys of arbitrary maps).
- **Regenerating.** Fragments are `.analysis/component-schema-<tag>.json` (one per RE session, shape checked by
  `validateFragment` in `editor/src/core/component-schema-build.ts`; `.analysis/compmap/` holds the work lists and
  `dispatch-names.json`, the names the by-name dispatch chains accept). `cd editor && npm run build:component-schema`
  merges them, runs the vanilla cross-check and writes the file; `-- --check` fails when the tracked file is stale.
  After a game update the keys are string literals and usually survive; re-run the RE for classes whose vftable
  changed and regenerate.

## Maps, rooms and encounters (2026-10-22)

**Yes: a data mod can add a new room (encounter layout), a new spawn entry, a new tileset and a new map file.**
OBSERVED in-game for the first three (`mods/_roomprobe`, below); the map pools and new map files rest on the
decompiles (engine-map "Maps, rooms and level files").

### The content model

1. **Map** = `data/maps/<name>.gon` (19 vanilla + `standard_nodes.gon` + `world.gon`). Top-level keys:
   `chapter_id`, `tileset`, `graphics`, `music`, `act` / `chapter`, `levels { folder <dir> easy [..] hard [..]
   rare [..] boss [..] miniboss [..] special [..] }`, `bosses { <name> auto }`, `minibosses { … }`, `events`,
   `enemy_pools`, `item_pools`, `nodes { #include "standard_nodes.gon" … }` and `flags { <SaveFlag> { <node> {…} } }`.
2. **Nodes** are the map's node kinds, not a laid-out graph: `nodes { battle { type battle } exit0 { type exit
   next_map sewers.gon locked true } … }`. `type` is one of 19 hard-coded names (below); an exit's `next_map` is a
   file name the run loads as `"data/maps/" + next_map`. The node graph itself is generated by the game.
3. **Level pools**: a battle picks a room from `levels/<folder>/<pool>/*.lvl`, `<pool>` from the map's `easy` / `hard`
   / `rare` arrays (sub-folder names); bosses and minibosses from `levels/<folder>/boss|miniboss/<boss name>/`.
4. **Room** = one binary `.lvl` file: a grid (10x10 in every vanilla level) of tile ids into `data/tiles.gon` plus
   objects `(x, y, id)` whose ids index `data/spawns.gon` (`<id> { editor {…} object <Character> }`,
   `utility PlayerSpawn` for the party). A cell or an object can instead be a weighted random list (id 0 = nothing).
   Format: `editor/src/core/level/lvl.ts` (every vanilla level re-encodes byte for byte).
5. **Spawn palette** `data/spawns.gon`: numeric id → `object <data/characters entry>` (enemies 11+, props 5000+).
   **Tile palette** `data/tiles.gon`: id 0..26 → `tile <TileClass>` (Water, Grass, …; C++ tile classes).
6. **Tileset** = one object in `data/tilesets.gon` (art slots `combat_background`, `static_1x1_a` …, `debris`,
   `global_objects`, `reverb`, plus clip-name redirects); a map names it with `tileset <name>`.
7. **Run order** (INFERRED from the strings and the map files): the run starts on `data/maps/alley.gon` (a literal in
   the exe, `.rdata` 0xf0c250) and follows `next_map`; `world.gon` lists the areas for the world map;
   `chapter_id_enum.gon` maps chapter names to positions (SpawnDatabase_init 0x7a74b0 fills a name → index map).

### What is extendable (by `.append` / a new file) and what is hard-coded

| Thing | Extendable? | How / why |
|---|---|---|
| New room `levels/<path>.lvl` | **Yes — OBSERVED** | the file manager reads `levels/<name>.lvl` from every mod path; `load <path>` plays it |
| New room picked by a map's pool | **Yes (decompiled)** | the pool lists `levels/<folder>/<pool>/` with FileManager_ListDir 0x9a1900, which walks the mod paths; drop a `.lvl` into `levels/alley/easy/` or point a pool at your own sub-folder |
| New spawn id (`data/spawns.gon.append`) | **Yes — OBSERVED** | id 9001 → `object RoomProbeRat` placed by the mod's `.lvl` |
| New tileset name (`data/tilesets.gon.append`) | **Yes — OBSERVED** | `tileset roomprobe_yard` then `load …` builds the fight in it |
| New map file `data/maps/<x>.gon` | **Yes (decompiled)** | loaded as `"data/maps/" + next_map`; reach it from an exit node's `next_map` (a `.merge` on a vanilla map) |
| New tile id (`data/tiles.gon.append`) | data yes, behaviour no | `tile <Class>` must be an existing C++ tile class |
| Node `type` | **No** | MapNode::str_to_type 0x225680 knows exactly `none npc enter exit home battle hard miniboss boss event optional_event special_event shop treasure furniturebox foodbox bonus empty any`; anything else is a fatal "No node type named" |
| New `chapter_id` | **No (in practice)** | `chapter_id_enum.gon` "must match the order of the enum in MewDirector.h"; reuse a vanilla chapter id for a new map |
| The first map of a run | **No (INFERRED)** | `data/maps/alley.gon` is a literal; a mod changes alley (or its exits), not the entry |

### Recipes

```
// a new room: new_from_template { kind: "room", name: "my_room", options: { folder: "alley/easy",
//   objects: [{ x: 1, y: 0, object: "PlayerSpawn" }, { x: 5, y: 8, object: "Rat" }], tiles: [{ x: 0, y: 5, id: 1 }] } }
// → mods/<mod>/levels/alley/easy/my_room.lvl — alley's easy pool now includes it; try it with
//   `enter TacticsTest` + `cmd load alley/easy/my_room`
// a new enemy placed by id: data/spawns.gon.append
9001 { editor { category 3 image ["rat.png"] paint false name "My Rat" } object MyRat }
// a new tileset: new_from_template { kind: "tileset-variant", name: "my_yard", options: { parent: "junkyard" } }
// a new map behind alley's first exit: data/maps/alley.gon.merge
nodes { exit0 { next_map mymap.gon } }
```

The validator checks rooms (`lvl-bad-format`, `lvl-unknown-spawn-id`, `lvl-unknown-tile-id`, `lvl-no-player-spawn`,
`lvl-outside-levels`, `whole-file-replace` when a room shadows a vanilla one) and maps (`map-node-type-unknown`,
`map-next-map-missing`, `map-tileset-unknown`, `map-chapter-id-unknown`, `map-level-pool-empty` for easy/hard pools).

### Proven in-game (T2, 2026-10-22, `mods/_roomprobe`, real save unchanged in every run)

- `new-room.mewtest` (run `20261022-131655`): `enter TacticsTest`, `cmd load roomprobe/probe` — the fight becomes the
  mod's room: 4 cats, two Lil' Rats with the RoomProbeRat entry's 77 hp (`expect gon 4/5 properties.health == 77`;
  one rolled a champion buff, 154 hp), the Pooter and the Trash Bag, and the three water tiles where the grid puts them.
- `find-room.mewtest` (run `20261022-131734`): `cmd load rp_nested_find` names no file; the console searches the
  recursive `levels/` listing and finds the mod-only `levels/roomprobe/deep/rp_nested_find.lvl` (three 77-hp rats) —
  the listing walks the mod paths.
- `new-tileset.mewtest` (run `20261022-131707`): `cmd tileset roomprobe_yard` + `load` — the junkyard art around the
  probe room (shot `roomprobe_yard`) where TacticsTest's default is alley.
- Pinned in `editor/test/fixtures/ingame/roomprobe-summary.json` (`level-tests.ts`).
- Not reached: a campaign battle node drawing the new room from a pool. `enter Campaign` stops at the intro / the
  house; walking a run needs UI input the harness does not have yet (TODO).

## Limits of the data layer

Data recombines ~1,750 existing C++ behavior components (the keys each one reads: "Component keys" above). A mechanic that no component expresses
(new status tick logic, new systems, new UI) needs the native layer (`native/`).

## Shipping a mod

A mod folder is all a player needs, but handing one over takes three more things: a manifest that says what it is and
which game build it was tested on, a zip with the right contents, and install steps. The editor does all three
(`editor/src/core/mod-manifest.ts`, `pack.ts`, `zip.ts`; Node built-ins only).

**`mods/<name>/mod.json`** — the game never reads it (like `description.json`, a root file no pack file is named
after); the validator, `pack` and `install` do:

```json
{
  "name": "jokers-luck",
  "version": "0.1.0",
  "author": "MeyerZon",
  "description": "A status that rerolls luck every turn.",
  "gameBuild": "25143593",
  "native": ["jokers_luck.dll"],
  "frameworkApi": 4,
  "license": "MIT",
  "attribution": "Made with mewgenics-mods (https://github.com/MeyerZon/mewgenics-mods)."
}
```

`name` must equal the folder; `version` is semver; `gameBuild` is the **Steam build id** the mod was tested on (the
`bindings/<id>.json` name, not the version string); `native` lists the mod's own DLLs and then needs `frameworkApi`
(mewframework's `FW_API_VERSION`); `license` and `attribution` are optional — the attribution line is the
`ATTRIBUTION.md` ask, suggested, never required. `npm run pack -- <mod> --init` (MCP `pack_mod { init: true }`, the web
UI offers it) drafts one from `description.json`, the installed build and, for a repo mod with
`native/mods/<mod>/build.bat`, its DLL name and the framework's API version. Validator findings:
`manifest-missing` (info — the mod loads, it just cannot be packed), `manifest-invalid` (error, every bad field named),
`manifest-build-mismatch` (warning — the installed exe is another known build, or one no `bindings/*.json` knows; said
only when an exe is installed, `check_game_build`'s identity).

**Which repo mods carry one** (pinned by `editor/test/pack-tests.ts` "repo mods"): every `mods/<name>/` whose name
does not start with `_` has a `mod.json` (`dev-sandbox`, `fw-glow`, `jokers-luck`, `swf-gate`; author MeyerZon, license MIT,
`gameBuild` a `bindings/<id>.json` build, `native`/`frameworkApi` exactly what `--init` detects from `native/mods/<mod>/`);
the `_`-prefixed folders are test-only harness overlays and never get one (their `manifest-missing` info is expected —
they are never packed). The game ignores the file: T2 `jokers-luck/smoke` and `dev-sandbox/console-smoke` pass with it.

**Pack** — `cd editor && npm run pack -- <mod> [--force] [--init] [--out <dir>]`, MCP `pack_mod { mod, force?, init? }`,
web UI mod menu → *Export…*:
1. rebuilds every `art/**/*.scene.json` through `build_swf` (so `swfs/` matches the sources);
2. runs `validate_mod` and **refuses on any error** unless `--force` (warnings pass);
3. copies each `native` DLL from `native/dist/` (refuses when one is missing, unless `--force`);
4. writes `editor/data/dist/<name>-<version>.zip` (git-ignored) holding `<name>/` — the mod folder **minus** `tests/`,
   `art/` (scene sources; the game loads the built `swfs/`), dot-files and editor clutter, plus `native/<dll>` — and at
   the zip root `README-INSTALL.txt` (where to unzip, the `-modpaths` launch line, the save advice, the Mewjector /
   mewframework step when there is a native part; CRLF) and `MANIFEST.sha256` (`sha256sum -c` format, every other
   entry). Entries are timestamped 1980-01-01, so the same mod packs to the same bytes.
Refusal codes: `mod-missing`, `manifest-missing`, `manifest-invalid`, `swf-build-failed`, `validation-errors`,
`native-dll-missing`, `out-dir-unsafe` (an output dir under `saves/` or inside the mod).

**Install** — `npm run pack -- --install <zip> [--into <dir>] [--yes]`, MCP `install_mod { zip, acceptBuildMismatch? }`
(always into `mods/`), web UI → *Import mod…* (zips up to ~6 MB, the `/api` body cap; bigger ones through the CLI).
Everything is checked before a byte is written, and a refusal writes nothing:
- size: the zip ≤ 64 MiB, the declared unpacked total ≤ 256 MiB, ≤ 5000 entries; each entry inflates at most to its
  declared size (a zip bomb stops there) and must match its CRC-32;
- names: no absolute path, drive letter, backslash, `.`/`..`/empty segment, NUL, symlink entry, `saves` segment, or two
  names that differ only by case;
- layout: exactly one top folder `<name>/` holding a valid `mod.json` whose `name` is that folder, and nothing else at the
  root but `README-INSTALL.txt` / `MANIFEST.sha256`; when `MANIFEST.sha256` is present every file must be listed and match;
- the destination `<into>/<name>/` must not exist (install never overwrites; remove or rename the old version first),
  `<into>` must not be under `saves/` or the game folder.
Then the game build: `mod.json` `gameBuild` vs the installed exe. On a mismatch install returns
`{ verdict: "build-mismatch", prompt }` and writes nothing — the CLI asks `[y/N]` on a terminal (or needs `--yes`, exit
3 otherwise), the web UI shows a confirm, an MCP caller shows the prompt to the user and calls again with
`acceptBuildMismatch: true`. Files are written into a temp sibling and renamed into place; the installed mod is then
validated and the report returned. `README-INSTALL.txt` and `MANIFEST.sha256` stay out of the mod folder.

**Saves.** The generated README tells players to back up the saves folder and to pass `-savesuffix`, and says plainly
that the suffix is not a protection on the builds examined (`docs/engine-map.md` "Save safety": it never reaches a save
path); the framework does need it to activate.

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

The validator warns **`text-loc-key-html`** (scene findings in `read_art_scene` / `write_art_scene` / Art mode, and
`validate_mod` for every `art/*.scene.json`) when a text is exactly a key and not `"html": false`: a key of the base
`combined.csv` (that half is empty without `.extracted/`) or one this mod's `data/text/*.csv` overlays add; the message
names which matched. A text that only has the key shape `^[A-Z][A-Z0-9_]{2,}$` and is in neither table is an
**info** ("looks like a loc key but no such key exists …; if it is meant to be localized, add the key and set
html: false"), so plain capitals like `PROBE` do not raise a warning. A wrapper of several words that merely
contains a key is not a key text. Fix it with `"html": false` or Art mode's **plain (localized)** box on the text row.
Not done: the editor does not switch a key text to plain by itself (the warning asks instead); the preview draws the
key, not the localized value. Measure and its limits:
`editor/src/core/art/probe-outcomes.ts` (ink masks per box on a clip-space grid, key vs value vs look-alike,
min over ±3 px shifts; a box under 60 % of its best ink — the "Battle Start!" banner, the unit — does not vote).
