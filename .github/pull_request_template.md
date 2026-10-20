## What

<!-- One paragraph: the change and why. Link the TODO item or decision it comes from. -->

## TDD evidence

<!-- Every change is test-first (docs/tdd-procedure.md). Quote the exact summary lines. -->

| step | command | result |
|---|---|---|
| red | `cd editor && npm test` (or `native\test-all.bat`, `npx playwright test <spec>`) | `N passed, M failed` |
| green | same | `N+M passed, 0 failed` |
| T0 | `npm run typecheck` | clean |
| T1 | `npm test` with `.extracted/` present | `… passed` / `(skipped: …)` |
| T2 | `npm run test:ingame -- <mod> [<test>]` | verdict per script / `(skipped: …)` |

- T2 is required for any change under `mods/`, `native/` or `bindings/`.
- CI (`T0` workflow) must be green. A source change with no test change fails the `test-change` job unless this body
  (or a commit) carries `[no-test-change: <reason>]`.
- A reverse-engineering fact the change relies on is in `docs/engine-map.md` **and** a test or fixture.
- Docs-only PRs: say so here and delete the table.

## T3 — human checklist

<!-- What no test can see: look, feel, balance, a play-check. One line each; the owner ticks them. Delete if none. -->

- [ ] …

## Safety

- [ ] No write to `Mewgenics.exe`, `resources.gpak` or any save; modded play used `-savesuffix dev`.
- [ ] No game bytes or assets committed (only short signatures under `bindings/`).
- [ ] Branch, not `main`/`master`; the owner merges.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
