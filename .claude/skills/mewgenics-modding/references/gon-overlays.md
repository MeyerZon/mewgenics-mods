# GON/CSV overlay semantics

Mods live in `mods/<name>/` and mirror the base pack layout
(`data/abilities/...`, `data/items/...`, `data/text/combined.csv`,
`swfs/swflist.gon`, and so on). The loader applies the base pack first, then
each mod path, so an overlay only needs to describe its change — not restate
the base file.

## The loader

```
-modpaths <dirA> <dirB>
```

Paths are space-separated. Later paths override earlier ones (since patch
1.0.20941). `launch-dev.bat` supplies the mod paths for dev play; do not pass
mod arguments through Steam launch options.

## Choosing an overlay by filename suffix

For structured files (`.gon`, `.csv`, `.txt`), the overlay mode is encoded in
the filename: `<original>.<mode>`. The mode decides how the mod's content is
combined with the matching base file.

### `X.gon` — Replace

No suffix. Replaces the entire base file. **Avoid this.** It conflicts with
every other mod that touches the same file and drops future base-game additions
to that file. Use it only when you genuinely intend to own the whole file.

### `X.gon.append` — Append

The mod's children are added at the **end** of the matching object/array. Use
this for **new** entries (a new ability, a new item, a new row), because it does
not touch existing keys and composes cleanly with other mods. A name the base
already has is **not** merged or replaced: both copies stay in the file and the
game's by-name lookup sees the appended one (the validator warns
`append-collision`). Key suffixes such as `.overwrite` are not read in an
`.append` file (`merge-suffix-literal`).

```gon
// data/abilities/offense.gon.append
MyNewStrike {
  template basic_attack
  class glaiel::BasicAttackAbility
  meta { name ABILITY_MyNewStrike_name; desc ABILITY_MyNewStrike_desc; class Fighter }
  // ...
}
```

### `X.gon.merge` — DeepMerge

Fields with matching names are merged recursively (the nth mod field named X
into the nth base field named X); new fields are appended; arrays are merged
element-wise by index with the extra mod items appended (not replaced, not
concatenated); strings, numbers and mismatched types are overwritten. Use this
for **value changes** to existing entries. Key suffixes are **not** interpreted
in a `.merge` file: `faction.overwrite allies` adds a field literally named
`faction.overwrite` (the validator warns `merge-suffix-literal`) — use `.patch`
for per-field policies.

```gon
// data/abilities/offense.gon.merge
Spin {
  cost { mana 1 }          // changes only mana; other cost fields untouched
  damage_instance { knockback 2 }
}
```

### `X.gon.patch` — PatchMerge

Like `.merge`, but each field in the patch selects its own policy through a key
**suffix**:

- `field.overwrite` — replace the base value outright.
- `field.append` — append (concatenate on arrays).
- `field.merge` — recursive merge (this is the default when no suffix is given).
- `field.add` — numeric add: `result = base + patch`.
- `field.multiply` — numeric multiply: `result = base * patch`.

`field.add` / `field.multiply` only make sense on numeric fields. On arrays,
`.append` / `.add` concatenate, `.merge` (default) merges element-by-element by
index, and `.overwrite` replaces the whole array.

```gon
// data/difficulties.gon.patch
3 {
  boss_health_multiplier.multiply 1.5   // base * 1.5
  wallet_size.add 100                    // base + 100
}
```

### Picking a mode

- Adding something new → `.append`.
- Nudging a few values on an existing entry → `.merge`.
- Scaling or offsetting numbers, or mixing policies in one change → `.patch`.
- Replacing a whole file → avoid unless you must; prefer the three above.

### Comments and `#include` in a mod file

Every mod `.gon` / `.gon.append` / `.merge` / `.patch` goes through the game's pre-pass: `#`, `//` and
`/* */` comments work (no nesting; an unclosed `/*` drops the rest of the file — `comment-unclosed`), and `#include "x.gon"` pastes `<directory of the BASE file>/x.gon` (mod
folder first, then the pack) in place. A missing include is **fatal** in the game (error box, then exit; `include-missing` in the
validator). Write include names as plain relative paths: `..`, `./`, a leading `/`, a drive letter or a backslash are
never normalised by the game (`include-path-unsafe`, error). A mod may ship the file it includes (in-game verified,
`mods/_incprobe`). An overlay on an included file's own name is pasted as text, not merged — overlay the including
files instead. `#define NAME(a, b) … #end` macros, used as `#NAME x y` (blank after the name, not `#NAME(x,y)`), are
expanded by the game and by the editor (`gon-macro-runaway` past 256 rounds). Details:
`docs/data-mods.md` "Comments and `#include`".

## CSV overlays (`data/text/combined.csv`)

The localization table has **12 columns**:

```
KEY,en,notes,sp,fr,de,it,pt-br,ru,ko,ja,zh-cn
```

- `combined.csv.append` — adds new rows. **Preferred.** Use it to add new
  `KEYWORD_*` / `ABILITY_*` keys for your content.
- `combined.csv.merge` — **positional by column** and **fragile**. A row like
  `,5,,` changes only column 2 of that row, and it breaks when the base game
  adds or reorders rows. Avoid it; prefer appending new keys over editing
  existing rows in place.

```csv
# data/text/combined.csv.append
ABILITY_MyNewStrike_name,My New Strike,,,,,,,,,,
ABILITY_MyNewStrike_desc,Deal 5 damage and knock back.,,,,,,,,,,
```

Keep all 12 columns present on every appended row (empty translation cells are
fine); the validator warns on missing translations and errors on a missing key.
