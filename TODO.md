# TODO — Mewgenics modding toolkit

Living status snapshot (last updated 2026-10-19: SWF gate + emitter fix on `fix/swf-append-frame`). `[x]` done · `[~]` in progress · `[ ]` planned, not started.
Two agents were in flight at last update: Playwright E2E/validation and the SWF-loader-crash RE.

## Done

### Foundations
- [x] Review, validate (no injection, 0 vuln deps) and install REA from reviewed source (Docker-based)
- [x] Audit Mewjector source and build `version.dll` chainloader from source (clang-in-Docker)
- [x] Map the engine: build identity, RVAs, GON/overlay semantics, status model → `docs/engine-map.md`
- [x] Verify data-layer modding (`-modpaths`, `.append/.merge/.patch`) with a dev save suffix
- [x] Native framework `mewframework.dll` (build-gated, fail-closed) on Mewjector
- [x] Sample mod **Joker's Luck** (data + native status) — **verified in combat**
- [x] Save safety: permanent backup + `-savesuffix dev` isolation; main save sha256 `09a68a36…` unchanged

### Data-layer mod editor (`editor/`)
- [x] Core (single source of truth): GON parse/serialize (byte-faithful), overlay merge engine, schema, 4-check validator
- [x] Hand-rolled MCP stdio server (9 tools) — registered with Claude Code as `mewgenics-editor`
- [x] Local web UI (VanJS, vendored, zero runtime deps)
- [x] IDE-style UI redesign + onboarding (first-run tour, empty states, concepts drawer, worked example) — **PR #1 merged to `master`**
- [x] Design canvas (8 artboards: data editor + onboarding + the 3 Art-mode screens)

### Repo / docs / ops
- [x] Private GitHub repo `MeyerZon/mewgenics-mods` created + pushed
- [x] `README.md` landing page + `CLAUDE.md` guidance
- [x] Flag `tcrf.net/Mewgenics` as a do-not-fetch source (prompt injection) in `CLAUDE.md`
- [x] Research: `docs/automation-feasibility.md`, `docs/art-pipeline.md`, `docs/swf-tooling-options.md`

### Art pipeline foundation (uncommitted WIP in working tree)
- [x] Hand-written SWF emitter (DefineShape + DefineSprite timelines + DefineBitsLossless2 PNG + optional stub DoABC)
- [x] SVG import, verification SWF reader, raw-WebGL in-game-faithful preview, Art-mode editor panels
- [x] Art-mode onboarding (dedicated art tour, empty states, concepts, worked example)
- [x] Performance pass: windowed GON highlighting on rAF, debounced + capped base explorer, preview loop suspends off-screen, play/pause bug fixed
- [x] `docs/art-preview-plan.md`; all of the above: typecheck clean, 77/77 unit tests pass

### Testing
- [x] **Playwright E2E suite** (`editor/tests/e2e/`, 33 tests) + real-browser validation — Data + Art flows + onboarding; `test:e2e` script; Chromium dev-only dep (user-authorized). typecheck + 77 unit + 33 e2e all green
- [x] **In-game test harness `mewtest`** (2026-10-18, three stacked PRs) — `docs/ingame-testing.md`. Node runner + MCP `run_ingame_test` + `npm run test:ingame` (68 unit tests via a fake game); framework API v3 (console dispatcher `DebugConsole::Execute`, `FrameBegin`, SDL DYNAPI slots; 13 host tests); `mewtest.dll` (40 host tests). Verified in the real game: console commands executed in-process, output captured, exit codes/verdicts, hidden window keeps ticking, timeout path, real save untouched.
- [x] **TDD rule adopted** (2026-10-18): `docs/tdd-procedure.md` + `CLAUDE.md` section; tiers T0 unit / T1 local data / T2 in-game / T3 human; PRs carry red→green evidence
- [x] **Fixed the real UI bug** the user was seeing: Art-mode Findings/Build tabs rendered JS source as literal text (VanJS binding returned a function into a child slot) — `editor/web/art-ui.mjs`

### Investigations run
- [x] DoABC/SymbolClass **gate test** on dev save → result: **DoABC is NOT the blocker**; our emitted SWF faults the `glaielswf` loader (new crash, distinct stack). Recorded.

## In progress

- [x] **SWF-loader crash RE** → `docs/swf-emitter-fix-spec.md` (final; 6 decompiles in `.analysis/decompiled/`). Crash is NOT a malformed SWF — it parses fine. Our clip merges into the live `AbilityIcon` sprite (`process_animation_merges` 0x9bc070); a **structurally-naive appended frame** triggers a post-load scripted call into the adventure-cutscene handler with no active run → null double-deref. `_Append_AbilityIcon` name CORRECT; **char-ID collision ruled out**. Method: static PE decoding + Ghidra (2nd attempt; 1st lost to memory contention from an orphaned container).

## Planned (not started)

### TDD coverage targets — make every layer test-backed (in priority order)
1. [ ] **Enter a run from the main menu through the harness** — the one blocker for in-combat tests. Options to
   evaluate, cheapest first: (a) a console command that exists at the main menu and loads a run (`listcmds` shows
   only the 11 engine built-ins, so probably none); (b) call the game's "continue run" path from the DLL (needs its
   RVA: hook/decompile what the main-menu Continue button invokes, likely `MewDirector::init` or a scene push); (c)
   inject SDL input events through the `SDL_PushEvent` slot to click Continue (brittle, last resort). Red test: a
   `.mewtest` with `cmd load 1` → `wait turns 1` → `expect units >= 2` that currently fails with
   `No command named "load"`.
2. [ ] **Joker's Luck real feature test (T2)** once 1 lands: `bind JokersGambit`, use it, `wait turns 2`,
   `expect status JokersLuck on 0`, `dump` twice and assert the luck stacks differ between turns (needs the stacks
   value in the units event: add `stacks` per status to `MtUnit`/the JSONL, host-tested first).
3. [ ] **Auto-resolve overlay mod** `mods/_autoplay/` (`player_cat.gon.merge` → `passives { Uncontrollable 1 }`) so
   combat scripts run without input; validator test for the overlay, T2 test that a fight reaches round 2 unattended.
4. [ ] **Bindings regression test (T1)**: a node test that scans the real exe read-only and asserts each
   `bindings/25143593.sig.tsv` row matches exactly once at its RVA (skip when the exe is absent). Turns "a game
   update breaks the native layer" into a red test instead of a silent disable.
5. [ ] **Framework pure parts**: extract the build gate (`identify_build` over a synthetic PE header) and the status
   definition table/name rules from `framework.c`/`status_engine.c` into host-testable units like `fw_sig.c`.
6. [ ] **Tools tests (T0)**: `tools/gpak.py` against a synthetic archive built in-test (python `unittest`, stdlib
   only); `tools/make-signature.mjs` against a synthetic PE (uniqueness, min/max length, rel32 note).
7. [ ] **Validator fixtures per check**: one failing fixture per finding code (`unknown-status`, `missing-loc-key`,
   `merge-target-missing`, …) so the four checks are each pinned by a T0 test instead of only by the sample mods.
8. [ ] **Golden merge cases**: freeze the merged output of each `.append/.merge/.patch` policy as observed in-game
   (via a `.mewtest` that reads the live value, once 1 lands) so the overlay engine is tested against the game, not
   only against the decompile.
9. [ ] **`npm test` without `.extracted/`**: the GON round-trip section fails instead of skipping; make it a logged
   `(skipped: …)` so T0 is runnable (and CI-able) without game data. Decision pending: GitHub Actions for T0.
10. [ ] **Test runner ergonomics**: a name filter for `run-tests.mjs` (or migrate to built-in `node:test`, zero deps,
    gives `--test-name-pattern`/`--watch`) so red/green per test is cheap.
11. [ ] **Mechanical enforcement** (decision pending): a PR template with the red/green table + T3 checklist; a check
    that a change under `src/`/`native/*/src/`/`mods/` comes with a test change; CI running T0 on every PR.
12. [ ] **Harness features**: expose `-mewtest_clean` in the runner (`clean: true` header) for a complete `debug.log`;
    named-pipe interactive mode (`node tools/mewtest.mjs exec "<cmd>"` + MCP `exec`); RNG seed pinning via `TLS+0x178`
    for exact numeric assertions; `expect log "<substr>"` against `debug.log` from the runner side.

### Verification still owed (things built but not yet validated in-game)
- [ ] **Unit walk** (`dump` with units, `expect status`, `expect units`): only exercised with `available:false`
  (main menu). Offsets come from the `TurnControl::NextTurn` decompile; confirm name/class/faction decoding on a real
  fight (blocked by target 1).
- [ ] **Crash path**: VEH + top-level filter + watchdog never ran against a real fault (`cmd crash` is in-run only).
  Expect: `crash` event, `end code 3`, Mewjector dump in `mod_logs\crashes\`, no WER dialog, exit 3.
- [ ] **`-mewtest_clean 1`**: OBSERVED 2026-10-19 — the DLL logs `script finished with code N (clean exit)` and the game then **never exits** (killed after 7 min; no "grace elapsed" line). Fix the clean path before exposing it in the runner.
- [ ] **Vanilla-launch gate** of framework 0.3.0: not re-verified (a vanilla launch opens the real save; verify with a
  copy of the install or accept the unchanged code path).
- [ ] **One-off early exit**: the very first 0.3.0 launch exited with code 1 after ~5 s during loading with no crash
  report; never reproduced in 8 later launches. Watch for it; if it recurs, capture `debug.log` with `-mewtest_clean`.
- [ ] **Which file `-savesuffix dev` writes**: dev launches changed `campaign02.sav`, not a `*dev*` file; the real
  `steamcampaign01.sav` stays untouched (hash-verified every run). Resolve the suffix→filename mapping from
  `MewSaveFile::open_or_create` (`0x229cd0`) and document it in `engine-map.md` "Save safety".
- [ ] **`FrameBegin` signature on a future build**: 20 generic prologue bytes; fallback is `ApplicationBase_Step`
  (recorded in `bindings/`). Re-derive both when the game updates.
- [ ] **Hidden window on other machines**: verified on this PC (NVIDIA, ~180 fps hidden); confirm elsewhere before
  relying on it in CI-like setups.
- [ ] **In-run console command set**: `listcmds` at the main menu lists 11 commands; capture the in-run list once
  target 1 lands and pin it in `ingame-testing.md`.

### Next, directly queued
- [x] **Knowledge base** `docs/KNOWLEDGE-BASE.md` — what we know / what we don't / how to operate (indexes all deep-dive docs)
- [x] Docs consolidation pass — gate-test + SWF-crash findings folded into `engine-map.md` (new "Art / SWF subsystem" section) and `KNOWLEDGE-BASE.md`; Ghidra timeout-env gotcha + concurrency rules live in `engine-map.md`
- [x] Scrub tree for public — name + PC paths removed (see "Go public")
- [~] Emitter fix from `swf-emitter-fix-spec.md` (PR `fix/swf-append-frame`, 2026-10-19): `AbilityIcon` places a bare shape at **depth 3** per labeled frame (not nested clips) — donor now mirrors it; T2 gate `npm run test:swfgate -- <variant>` boots every layout (incl. the pre-fix one) without crashing, and `missing` proves the merge runs. **Owed:** the owner's T3 look at `JokersGambit` inside a run (the crash is display-time, not boot-time) — *emitter frontier*
- [ ] Commit the uncommitted WIP (art pipeline + docs + `CLAUDE.md` flag) + open a PR for review (not merge)

### Go public (do LAST, after everything else lands — approved 2026-10-18)
- [x] Scrub complete: mod `author` → "MeyerZon"; test scratch path → env/`""`; save-backup doc path → `%USERPROFILE%`; `chainloader.ini` personal path → `__REPO__` placeholder resolved at install time; `build.bat`/`CLAUDE.md` toolchain path made `GCC`-env-overridable. (Tyler Glaiel's `__FILE__` asserts embedded in the game binary are RE evidence, kept.)
- [x] Fresh single clean commit under a public-safe identity (GitHub noreply email; no private session URL in the commit trailer)
- [x] New **public** repo created + pushed; verified clean history identity, tree grep = 0 for name tokens, nothing ignored/binary slipped in
- [x] Old private repo renamed + **archived** (not deleted — per user); its email-bearing history is retired

### Decisions pending
- [ ] Ruffle (WASM) dependency — only if we want to preview *vanilla* SWFs in-editor; would go through the skeptic dep-gate
- [ ] Dead key `mewged.onboard.conceptsDontShowStart` — the concepts drawer's "Don't show on start" button writes it but nothing reads it (concepts never auto-opens). Decide: wire concepts auto-open-on-start, or remove the button/key (recommend: remove the dead button)

### Larger build-out
- [ ] Animation-clip authoring workflow (DefineSprite timelines end-to-end) once the emitter is engine-valid
- [ ] Part-indexed **cat-rig** authoring UI (model already supports named layers)
- [ ] Emitter: gradient fills, LineStyle2, fonts/text, PlaceObject3
- [ ] MCP tools for art (so agents can author art, not just data)
- [ ] "Draw in VectorCraft →" SVG import handoff
- [ ] Testing frontier from `automation-feasibility.md`: AI-brain auto-resolve to smoke-test mods in a real fight (tiers B/C) → now TDD targets 1–3 above; an IPC action layer (tier D) → the named-pipe mode in target 12

### Open engine unknowns to resolve
- [~] Exact SWF-format + `_Append_`/SymbolClass convention the loader requires — binding needs no DoABC; `_Append_<Target>` merges at boot; an unknown target stalls the boot (OBSERVED 2026-10-19); what the display path needs is the open half
- [ ] RNG seeding for deterministic test runs (no user-facing command; the state is `TLS+0x178`, pin it from the harness → target 12)
- [x] Headless / startup-macro mode — solved by the harness (in-process console execution + hidden window), not by the game
- [ ] Verify the INFERRED preview behaviors (nested-sprite framing, cxform-after-remap, engine fill rule, bitmap sampling)
- [ ] Per-build fragility: process to re-derive `bindings/` signatures when Mewgenics updates (framework fails closed meanwhile)
