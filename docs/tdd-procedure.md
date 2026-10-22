# TDD procedure for this repo

Rule (owner, 2026-10-18): **every change, every piece, is done test-first.** This page says what that means per
layer, which tier of test covers what, where a human still has to look, and what evidence a PR must carry.
`CLAUDE.md` holds the short version agents must follow; this is the reference.

## Tiers

| Tier | What | Needs | Runs | Command |
|---|---|---|---|---|
| **T0** pure unit | logic with no game bytes: GON engine, overlays, validator, art model, in-game runner (via the fake game), native pure modules | nothing | every change, could run in CI | `cd editor && npm test`, `native\test-all.bat`, `npm run typecheck` |
| **T1** local data | tests that read `.extracted/`, the real exe or the real DLLs read-only (GON round-trip over base data, real-overlay merges, signature uniqueness) | `.extracted/`, the game install | every change on a dev machine; skipped with a logged `(skipped: …)` elsewhere | same commands; they skip when the inputs are absent |
| **T2** in-game | `.mewtest` scripts run inside the real game by the `mewtest` harness | Steam running, `native/dist/mewframework.dll` + `mewtest.dll`, the `dev` save | per PR that touches a mod, the framework or the harness; on demand otherwise | `cd editor && npm run test:ingame [-- <mod> [<test>]]` or MCP `run_ingame_test` |
| **T3a** agent eye | what a screenshot shows: the scene came up, the icon/art is drawn, text fits, nothing is blank or garbled | a `.mewtest` with `shot "<label>"` and `hide: false`; the agent opens the PNGs in `artifacts.shots` | per PR that changes anything visible | `npm run test:ingame -- <mod> <test>`, then read the PNGs |
| **T3** human play | what no screenshot can judge: feel, pacing, balance, fun, whether the mod reads the way it was meant to | the owner, playing | listed per PR as a checklist with the result filled in; a standing step of every mod's development (see "The loop") | — |

`npm test` never launches the game. T2 is serialized by a lock (one game at a time) and takes ~3.5 s per script.

## What is test-backed today

- **Editor core** (`editor/src/core/`): 145 unit tests (`npm test`), 33 Playwright end-to-end tests (`npm run test:e2e`),
  `tsc --noEmit` (strict TypeScript, no JSDoc typing left). The overlay engine's oracle is the decompiled
  `Gon_PatchMerge_a_0x944cc0.c`, `Gon_PatchMerge_b_0x944f50.c` and `Gon_DeepMerge_0x946680.c` (`.analysis/decompiled/`).
- **Data mods** (`mods/`): the validator (reference integrity, localization, overlay targets, merge preview) is the T0/T1
  test; the harness load smoke is the T2 test (no `NO_*_NAMED` / `GON_ERROR` marker, framework active). Every validator
  finding code is pinned at T0 by `editor/test/validator-tests.ts` on the synthetic base and fixture mods under
  `editor/test/fixtures/validator/` (one mod per code, plus a clean one); the sample mods against the real
  `.extracted/` remain the T1 check.
- **Native framework**: the pure modules have 79 host tests (`native/framework/test/`): the signature scanner (13),
  the build gate + generated tables (6), the status definition rules + alias rewrite (14), the custom-status vtable
  clone + thunk bodies (13, incl. a T1 clone of the real `.analysis/luckup-vtable.hex`), the entity/component walks
  + apply/merge/set-stacks writes over fake objects (11) and symbol resolution / the launch gate / API bounds / the
  hook plan (14) and the per-unit glow rules: registry, pruning, layer vector, pass lookup and writes, and the v2
  colour groups, draw plan, screen-rect stages and per-draw pass writes (21). The glue
  (`framework.c`, `status_engine.c`, `glow_engine.c`: PE header, Mewjector calls, the game-ABI thunks and
  the calls into the game) is verified by the harness run (the symbols resolve, hooks install, Joker's Luck
  registers) and, since 2026-10-20, in a real fight:
  `mods/jokers-luck/tests/luck-rerolls.mewtest` enters a test fight (`enter TacticsTest`), gives the cats the status
  at battle start (`mods/_jokersluck-test/`, test-only) and asserts the stacks change across rounds
  (`expect stacks JokersLuck on 0 varied`).
- **Harness DLL**: 46 host tests for the pure modules (incl. the watchdog's exit decision); the glue by the real runs
  recorded in `docs/ingame-testing.md`.
- **Bindings** (`bindings/<build>.json`): T0 on fake PE images (scanner parity with `fw_sig.c`, wildcarder, RTTI /
  witness / table derivations, the port ladder, the report), T1 against the installed exe (every signature matches
  once at its RVA, every anchor re-verifies, a self-port changes nothing, the generated headers are current), a native
  host test re-validates every generated pattern, and the framework's own activation is the T2 check (`unknown-build`
  / `harness-error` naming the signature when it is not). Cross-build T1 is opt-in (`BINDINGS_OLD_EXE`/`BINDINGS_NEW_EXE`).

## What cannot be automated, and the closest substitute

| Gap | Closest automated check | Human step |
|---|---|---|
| Visual correctness of SWF art, text fit, UI look | `shot "<label>"` screenshots (T3a): the agent checks the icon is drawn, the scene is the expected one, text fits; SWF loads without a loader fault (`log-errors` / `crash`); Playwright asserts behaviour, not appearance | feel and style: look at it in play; say so in the PR's T3 list |
| Combat behaviour of a mod (e.g. "luck rerolls every turn") | `enter TacticsTest` puts the harness into a test fight (`docs/ingame-testing.md`); then `expect status` / `expect units` / `dump` per turn | feel and balance: play it |
| Balance, fun | none | play |
| Reverse-engineering claims | none as claims; they become tests when turned into a signature row, a golden merge case, a log-marker fixture or an offset the harness reads | — |

## The loop, per change

1. **Red.** Write the test that describes the behaviour and run it. It must fail for the right reason: a missing
   module, a wrong value, a `fail` verdict, a `NO_ABILITY_NAMED` marker. Commit it (`test(scope): red …`).
   - Editor: a `test(...)` in `editor/test/*.ts` (wire new suites like `runIngameTests`); UI behaviour in
     `editor/tests/e2e/*.spec.ts` (Playwright).
   - Data mod: a `.mewtest` under `mods/<mod>/tests/` and, for validator-visible mistakes, a validator fixture.
   - Native: a `TEST(...)` in the module's host suite; the game-facing part gets a `.mewtest`.
   - Docs-only PRs are exempt from red/green but not from T3.
2. **Green.** The smallest change that passes. Run the full tier(s) the change touches, not just the new test.
   Commit (`feat|fix(scope): …`), quoting the pass counts.
3. **Refactor** with the tests green; commit separately.
4. **Evidence in the PR body**: a table of red → green per commit with the exact summary lines (`0 passed, 6 failed`
   → `34 passed, 0 failed`), the T2 verdict lines when a mod or native code changed, and the T3 checklist with what was
   looked at and what was not.
5. **Facts from reverse engineering** that the change relies on land in `docs/engine-map.md` *and* in a test or
   fixture (`editor/test/fixtures/ingame/`, `bindings/`, a host test). A fact that lives only in prose is not done.
6. **The human play-check is a step of every mod, not an afterthought** (owner, 2026-10-20). Agents build and
   validate alone through T0–T3a; when a mod (or a feature of one) is complete and green, the PR's T3 list names
   exactly what the owner should play and look for (the new ability in a fight, the icon in the ability bar, the
   tooltip text, the balance question), and the owner's verdict closes the loop. Keep the list short and specific;
   a screenshot the agent already checked does not go on it.

## Fixtures vs game bytes

Fixtures are hand-written excerpts shaped like the real thing (log lines, JSONL, scripts, synthetic byte buffers).
Never commit game assets, saves or exe bytes; the only game-derived data in git is the short byte signatures in
`bindings/`. T1 tests read the real files in place and skip when they are absent.

## Running the editor from a git worktree

Several agents work in this repo at once, each in its own `git worktree` under `.claude/worktrees/<tag>`. A fresh
worktree has none of the git-ignored inputs the main checkout accumulated — `editor/node_modules/`, `.extracted/`,
`editor/data/` (the `build:index` caches) — so point it at the main checkout's copies instead of rebuilding them:

1. **One junction, for the dependencies only** (PowerShell):
   `New-Item -ItemType Junction -Path "<worktree>\editor\node_modules" -Target "<main>\editor\node_modules"`.
   Do not junction `.extracted`, `.analysis` or `editor/data`: the variables below replace those, and every junction
   is a removal hazard (`CLAUDE.md` "Worktrees with junctions are a data-loss trap").
2. **Env vars, for every `npm` command run in the worktree** — three, one per git-ignored tree:
   - `MEWGENICS_EXTRACTED_DATA=<main>\.extracted\data` — the whole extracted pack. Its parent is the extracted root
     (`repo.ts` `EXTRACTED_ROOT` / `extractedPath(...)`), so the base data (T1 tests, the validator, the merge
     preview), the vanilla SWFs (`swfs/`: the art T1 tests, the Ruffle tab's list) and the palette textures
     (`textures/`: the art palette reader) all follow this one variable.
   - `MEWGENICS_EDITOR_DATA=<main>\editor\data` — the caches (`repo.ts` `DATA_CACHE_DIR`): `component-names.json`
     (the component class list; `build:index` rebuilds it only from `.analysis/list_names.tsv`, found through
     `MEWGENICS_ANALYSIS_DIR` below — without it the existing list is kept) and
     `base-index.json`, plus `ingame-runs/` and the VectorCraft zip cache (`vendor/`, so `npm run build` vendors
     offline). Without it the component-dependent check logs `(skipped: editor/data/component-names.json missing …)`,
     the validator reports one `component-list-missing` info instead of an `unknown-component` warning per passive,
     and `npm run build:index` writes a fresh `base-index.json` into the worktree's own `editor/data/`. It always
     writes to this directory (pinned in `editor/test/repo-tests.ts`). An override under any `saves/` path is
     refused at load.
   - `MEWGENICS_ANALYSIS_DIR=<main>\.analysis` — the reverse-engineering store (read only): `build:index` and the
     component loader distill the component list from its `list_names.tsv`, and it also lets a worktree see the main
     checkout's decompile store (the bindings "evidence paths exist" check resolves `.analysis/...` under it and
     skips without it).
   - Override only, not needed in a worktree: `MEWGENICS_VANILLA_SWF_DIR` points the vanilla SWF reads somewhere
     other than `<extracted root>/swfs` (the art tests use it with a temp dir).

   Every game-data / cache path resolves through `editor/src/core/repo.ts`; never join `REPO_ROOT` with `.extracted`
   or `editor/data` anywhere else.
3. **Before removing the worktree:** `cmd /c rmdir "<worktree>\editor\node_modules"` (unlinks the junction without
   following it), confirm `<main>\editor\node_modules` still has contents, then `git worktree remove`. The full rule
   and the incident behind it: `CLAUDE.md` "Worktrees with junctions are a data-loss trap".

With the two variables set, `npm test`, `npm run typecheck` and `npm run test:e2e` in a worktree match the main
checkout (after one `npm run build`, which also clears the `web/dist` skip; the one extra line is
`(skipped: .analysis/decompiled absent …)` — the RE decompile store stays per checkout by design); without them the
suite still exits 0 with `(skipped: …)` lines (the nested runs in `run-tests.ts` sections 4 and 10 check both
variables on every run).

## Enforcement (mechanical since 2026-10-20, plus convention)

- **CI runs T0** (`.github/workflows/t0.yml`) on every PR and push to `main` that touches `editor/`, `native/`,
  `bindings/`, `tools/` or `mods/`, on Linux runners: `npm run typecheck`, `npm test`, `npm run bindings:check` and
  the native host suites via `native/test-all.sh` (the POSIX twin of `test-all.bat`). The game is never part of CI;
  everything that needs the exe, `.extracted/` or Steam prints `(skipped: …)` there. Docs-only PRs do not trigger
  it, so the jobs are not "required" checks.
- **A source change needs a test change**: the `test-change` job runs `editor/scripts/check-test-change.ts` over
  the PR's diff. A file under `editor/src/`, `native/*/src/` or `mods/<mod>/` (outside `tests/`) must come with a
  file under `editor/test/`, `editor/tests/`, `native/**/test/` or `mods/<mod>/tests/`, or the PR body / a commit
  message carries `[no-test-change: <reason>]`. Run it locally with
  `node editor/scripts/check-test-change.ts --base origin/main --head HEAD`.
- PR body must carry the evidence table; a PR without it is sent back.
- `npm test`, `npm run typecheck` and `native\test-all.bat` must be green before `gh pr create`.
- A change to `mods/`, `native/framework/`, `native/mods/` or `bindings/` must include a T2 run (or an explicit
  `cannot-run` reason) in the PR body.
