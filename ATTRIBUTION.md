# Attribution — a request, not a condition

This toolkit is MIT-licensed (`LICENSE`). The MIT terms are the whole of what you must do, and they only concern
copies of the toolkit itself.

**Mods you make with it are yours.** Nothing in the license reaches into your mod, and no credit is required.

That said, if the editor, the validator, the in-game harness or the native framework helped you ship a mod, we would
like it if you mentioned it — one line in the mod's description, README, Workshop page or credits is plenty, for
example:

> Made with mewgenics-mods (https://github.com/MeyerZon/mewgenics-mods).

This is an ask, not a term: nobody will check, nothing is enforced, and a mod without the line is in no way less
legitimate.

## What is and is not covered

- **Covered by the MIT license:** everything in this repository — the editor (`editor/`), the native framework and
  harness (`native/`), the tools (`tools/`), the sample mods (`mods/`), the docs, and the short byte signatures in
  `bindings/` that locate game functions.
- **Not ours and not covered:** Mewgenics itself (Glaiel Games), its executable, assets and data. The repo tracks no
  game bytes beyond those short signatures; everything game-derived is read from your own install at runtime and is
  git-ignored. Mewjector (`version.dll`) and the vendored third-party runtimes the editor downloads at build time
  (Ruffle, VectorCraft) carry their own licenses, which travel with them.
