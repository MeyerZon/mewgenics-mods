# Validation and testing

Always run `validate_mod` and inspect `preview_merge` before testing a mod
in-game. Validation catches the mistakes that crash a modded launch; the
merge preview shows the object the game will actually see.

## What `validate_mod` checks

1. **Reference integrity.** Every status, ability, passive, item, component,
   or character name referenced must resolve against base data **or** a
   native-registered name in `registered-names.json`. A referenced name that is
   neither is the crash class the validator exists to prevent.
2. **Localization completeness.** Referenced `KEYWORD_*` / `ABILITY_*` keys must
   exist in `combined.csv` with all 12 columns. A missing key is an **error**; a
   missing translation (empty non-`en` column) is a **warning**.
3. **Overlay-target existence.** `.merge` / `.patch` must target an existing
   path/key; `.append` must add non-colliding keys. A positional CSV `.merge`
   is flagged as fragile.
4. **Merge preview.** `preview_merge` computes the real effective object
   (base + overlay) so you can confirm the result before launching.

Results come back as ok / warning / error with source locations. Resolve every
error, and understand each warning, before an in-game test.

## Native-registered names

Some status and ability names are registered by the native layer rather than
defined in base data. `list_registered_native_names` lists them (from
`registered-names.json`, seeded with `JokersLuck`).

The Joker's Luck example: a data mod that references the status `JokersLuck`
validates **only because** `JokersLuck` is in `registered-names.json`. Without
that entry the reference would fail check (1). So when a mod depends on a native
status, the name must be registered there; otherwise the reference is treated as
a crash risk and flagged.

## Save safety (hard rules)

- Launch modded play **only** via `launch-dev.bat` (repo root). It passes
  `-savesuffix dev`, so modded play writes **separate** save files.
- **Never** launch mods against the main save.
- **Never** modify `Mewgenics.exe` or `resources.gpak`.
- **Never** read or write any file under a `saves/` directory.
- The editor only reads base data and writes into `mods/<name>/`.

The user keeps an ~83%-complete main save that must stay untouched. Treat these
as non-negotiable.

## In-game smoke test

After `validate_mod` passes and `preview_merge` looks right, launch through
`launch-dev.bat` (which runs under `-savesuffix dev`). Then, using the debug
console (backtick key), bind and trigger the content — the pattern from the
Joker's Luck sample:

```
bind <AbilityName>
```

Use the ability and observe the effect. This exercises the merged data in a
real session without touching the main save.
