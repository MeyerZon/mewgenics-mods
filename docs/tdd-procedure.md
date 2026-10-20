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
| **T3** human | what no test can see: how art looks in-game, text fit, balance, feel | eyes | listed per PR as a checklist with the result filled in | — |

`npm test` never launches the game. T2 is serialized by a lock (one game at a time) and takes ~3.5 s per script.

## What is test-backed today

- **Editor core** (`editor/src/core/`): 145 unit tests (`npm test`), 33 Playwright end-to-end tests (`npm run test:e2e`),
  `tsc --noEmit` (strict TypeScript, no JSDoc typing left). The overlay engine's oracle is the decompiled
  `Gon_merge_{a,b,c}.c`.
- **Data mods** (`mods/`): the validator (reference integrity, localization, overlay targets, merge preview) is the T0/T1
  test; the harness load smoke is the T2 test (no `NO_*_NAMED` / `GON_ERROR` marker, framework active).
- **Native framework**: the signature scanner is a pure unit with 13 host tests; everything else is verified by the
  harness run (15 symbols resolve, hooks install, Joker's Luck registers).
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
| Visual correctness of SWF art, text fit, UI look | SWF loads without a loader fault (`log-errors` / `crash` verdicts), Playwright asserts behaviour, not appearance | look at it; say so in the PR's T3 list |
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

## Fixtures vs game bytes

Fixtures are hand-written excerpts shaped like the real thing (log lines, JSONL, scripts, synthetic byte buffers).
Never commit game assets, saves or exe bytes; the only game-derived data in git is the short byte signatures in
`bindings/`. T1 tests read the real files in place and skip when they are absent.

## Enforcement (current: convention; see `TODO.md` for the mechanical options)

- PR body must carry the evidence table; a PR without it is sent back.
- `npm test`, `npm run typecheck` and `native\test-all.bat` must be green before `gh pr create`.
- A change to `mods/`, `native/framework/`, `native/mods/` or `bindings/` must include a T2 run (or an explicit
  `cannot-run` reason) in the PR body.
