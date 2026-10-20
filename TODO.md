# TODO — Mewgenics modding toolkit

Living status snapshot (last updated 2026-10-19 evening: owner ran the game-side checks; every PR through #23 is merged, none open). `[x]` done · `[~]` in progress · `[ ]` planned, not started.

## Owner checks — only you can do these (agents cannot)

Things no test can see: they need a human at the game, a decision, or an account. Tick them here; the agent-side work they unblock is named.

- [x] **SWF gate, visual half (T3 of PR #21).** Owner, 2026-10-19: the `flat` variant shows a flat gray square for
  `JokersGambit` inside a run, no new `crash_*.txt`, and `npm run test:swfgate -- control` passed. The emitter fix is
  verified end to end (boot via the harness, display by eye).
- [x] **The 2026-10-18 crash context.** Owner was not at the PC when it happened, so boot-vs-display is unknown.
  Closed: unreproducible with the pre-fix donor at the main menu, and not seen since the fix (gate result above).
- [x] **Joker's Luck in combat on the current framework build**: owner play-check 2026-10-19 — the cat's luck changes
  at the start of each turn on the rebuilt DLLs.
- [x] **Vanilla-launch gate** of the framework: owner decision 2026-10-19 — accept the unchanged code path (the
  `-savesuffix` check in `framework.c` has not changed since it was verified; no plain launch will be run for this).
- [ ] **Hidden window on another machine**: confirm the harness keeps ticking hidden on a non-NVIDIA PC before any
  CI-like use.
- [ ] **Binding-port series** (second build, decisions, play-checks): the detailed checklist is the next section.
- [x] **Decisions pending** — all decided 2026-10-19 (see "Decisions" and "Decisions made" below): GitHub Actions
  for T0 **yes, path-filtered**; Ruffle **yes, via the dep-gate**; dead `conceptsDontShowStart` key **remove the
  button**; mechanical TDD enforcement **yes** (PR template + CI).
- [ ] **Re-fetch the older build exe** into `.analysis/exe/23372843/Mewgenics.exe` (Steam console
  `download_depot 686060 686061 8229879464648565847`, then copy): lost on 2026-10-19 when a worktree removal followed a
  junction and emptied `.analysis/` (`CLAUDE.md` "Worktrees with junctions"). Needed again only for the opt-in
  cross-build T1 (`BINDINGS_NEW_EXE`).
- [x] **Merges.** The leftovers stack (#28–#33, #32) was merged on your word, 2026-10-19 night; PR #27 (docs,
  cross-build port) merged after its rebase; the editor's TypeScript/React stack (#36, #37) merged 2026-10-20 on your
  word. Say so per PR as always (`CLAUDE.md`).
- [ ] **After the TypeScript switch (T3 of PR #37)**: restart the `mewgenics-editor` MCP server in Claude Code once and
  call `list_base_data` / `validate_mod` (your registration still names `editor/src/mcp/server.mjs`, now a 4-line shim);
  optionally re-register with `claude mcp add mewgenics-editor -- node "<repo>/editor/src/mcp/server.ts"`. Run
  `npm run test:ingame` once with Steam up (the runner is typed, not changed).

### Only you can do these — added 2026-10-19 night (after the leftovers stack)

- [ ] **Dev-play policy after the save-suffix decode.** `-savesuffix` does not rename or relocate saves on build
  25143593 (`docs/engine-map.md` "Save safety"); a dev session that enters a Steam-cloud slot writes the real
  `steamcampaign0N.sav`, and the harness only catches it after the fact. Decide: dev play only through the test director
  (`test00.sav`) / a copied local slot / ask the developer what the suffix is for. Until then: do not enter a Steam slot
  in a dev launch.
- [ ] **Eyeball the saves dir after one dev run** (T3 of PR #33): `%APPDATA%\Glaiel Games\Mewgenics\<id>\saves\` —
  only `campaign0N.sav` / `test00.sav` may have moved; `steamcampaign01.sav` keeps its 2026-03-31 mtime.
- [ ] **Watch one clean-mode run end** (T3 of PR #31): `cd editor && npm run test:ingame -- dev-sandbox
  console-smoke-clean` should finish ~3 s after "script finished" (the DLL grace), never the old 7-minute hang, and
  leave no stray `Mewgenics.exe` in Task Manager.
- [ ] **Re-fetch build 23372843** (item above) — then, optionally, rerun the cross-build:
  `node tools/bindings/cross-build.ts --old <installed exe> --new .analysis/exe/23372843/Mewgenics.exe --build 23372843
  --gameVersion 1.1.21039` and confirm the `old` column shows 25143593's values, the 14 anchor rows read `size +0 /
  calls +0 vs old`, and `LuckUp_typeid` is `ported-derived … (agree)` with `0x4d5` from both sources (T3 of #29, #32).
- [ ] **Remove the leftover agent worktree safely**: `.claude/worktrees/agent-ac7ac5f970624f89d` (PR #27's branch) still
  holds junctions to `.analysis` and `.extracted`. Only after #27 is merged: `cmd /c rmdir` each junction, confirm the
  targets still have contents, then `git worktree remove` (`CLAUDE.md` "Worktrees with junctions"). Never before.
- [ ] **Delete the merged local/remote branches** when convenient: `chore/leftovers-hygiene`, `fix/port-report-old-column`,
  `test/t0-skips-gpak-filter`, `fix/harness-clean-exit`, `docs/save-suffix-mapping`, `feat/bindings-typeid-witness`
  (all 0 commits ahead of `main`; `git branch -d` refuses anything unmerged).
- [ ] **A fuller `debug.log`**: clean mode does not make the game shut down or flush its log. If you still want load-time
  diagnostics past the truncation, the lever has to come from you (a game setting, a console command that flushes,
  or asking the developer); agents have no safe handle on the game's log stream.
- [ ] **Permission rule for merges** (optional): the harness's auto-mode classifier blocked `gh pr merge` once tonight
  even with your go-ahead in the chat; if you want agents to merge on your word without a retry, add a Bash allow rule
  for `gh pr merge` in `.claude/settings.json` — otherwise keep merging yourself.

## Owner checklist — what only you can check (binding-port series, merged 2026-10-19)

Things no test on this machine can decide. Tick them off here; each links to where the detail lives.

### Needs a second game build
- [x] **Run the real cross-build port.** Done 2026-10-19 against build 23372843 (`download_depot 686060 686061
  8229879464648565847`, exe kept at `.analysis/exe/23372843/`): `0 non-offset entries ambiguous/failed`, exit 0;
  opt-in `npm test` `235 passed, 0 failed`. Only `LuckUp_typeid` differs (`0x4d5` vs `0x4d6`) and the derivation
  caught it. Caveat: every anchored function had identical size/call counts on both builds, so only the relink case
  is proven. Result and the ladder candidates it suggests: `docs/binding-port.md` "T1 cross-build result". Repeat
  with any build that changes SDL or function bodies.
- [x] **Keep a copy of the current exe** at `.analysis/exe/25143593/Mewgenics.exe` (done 2026-10-19, git-ignored,
  sha256 `4127cd6a…`). Redo this before every Steam update: the anchors are committed, the binary is not, and the
  self-port/harvest tests need it once the install moves on.

### Decisions
- [x] **`sigCap` / `FW_SIG_MAX_BYTES` stays at 128** (owner, 2026-10-19): wait until a port actually reports a pattern
  over the cap, then raise `fw_sig.h` + `native/framework/test/test_sig.c` together (`docs/binding-port.md` "Known
  limits"). `Status_GetCategory` needs 126 bytes today.
- [x] **One DLL per build** (owner, 2026-10-19): the manifest set and `signatures.h` carry only the current build;
  `offsets.h` stays shared `#define`s and the generator keeps refusing mixed manifests.
- [ ] **SDL version policy**: when `port_bindings` reports the 8 SDL slots as `needs-human` (SDL version changed), the
  DYNAPI slot order must be re-verified by hand (`SDL_dynapi_procs.h` of that SDL version) before trusting the indices.
- [x] **Optional PR 15 — runtime anchor locator in the DLL**: **skipped** (owner, 2026-10-19). The offline port tool
  plus the fail-closed build gate already give "broken binding = disabled mod, not a crash"; a game update needs a
  rebuild and a T2 pass anyway, so in-process string→xref resolution is not worth the native surface.
- [ ] **`FW_API_VERSION` bump policy** when the manifest exposes new `FW_SYM_*`/`FW_DATA_*` entries (append-only enums).

### Verify by eye / by playing
- [x] **Joker's Luck still rerolls luck every turn** on the `dev` save after the rebuilt DLLs (owner play-check
  2026-10-19; combat assertions stay blocked until TDD target 1, so this remains the T3 for every PR touching `native/`).
- [ ] **The `port-bindings` skill triggers when you say "the game updated"** (and on `unknown-build` /
  `native-build-unknown`); fix the description wording in `.claude/skills/port-bindings/SKILL.md` if it does not.
- [ ] **Read `docs/binding-port.md` once as the person who will run the next port**; anything unclear is a doc bug.
- [x] **`check_game_build` from Claude Code** returned `known: true`, 35 `ok` / 0 moved / 0 missing / 0 ambiguous on
  the install (2026-10-19; MCP `mewgenics-editor`, 13 tools).
- [ ] **A `proposed` struct offset is never applied by the tool**: when a port reports one, apply it only with
  `--resolve Name=0x..` after a green `npm run test:ingame` that exercises it (`docs/binding-port.md` "The ladder").

### Known gaps you are accepting for now
- [ ] 38 entries (32 struct offsets, 6 vtable slot constants) are still `unanchored`: every port reports them as
  `needs-human` instead of guessing. Follow-up below ("Witness patterns for the 38 unanchored entries").
- [ ] A changed arity of the 13 status lookups (shapes A–E in `status_engine.c`), a compiler/CRT change (`MsvcString`
  layout, `_Allocate<16>`), or a changed vtable layout cannot be ported mechanically; the port will say so.


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
- [x] Local web UI (VanJS, vendored, zero runtime deps) — replaced 2026-10-20, see the TypeScript entry below
- [x] IDE-style UI redesign + onboarding (first-run tour, empty states, concepts drawer, worked example) — **PR #1 merged to `master`**
- [x] Design canvas (8 artboards: data editor + onboarding + the 3 Art-mode screens)
- [x] **Whole editor to TypeScript; web UI to React + Vite; zod at the boundaries** (PRs #36 + #37, 2026-10-20;
  `docs/editor-ts-react-plan.md`). Every `.mjs` under `editor/{src,scripts,test,web}` and `tools/bindings` is `.ts`
  with real types (JSDoc retired, `@types/node`); Node runs the sources directly (no bundler; explicit `.ts` imports,
  `erasableSyntaxOnly`); the UI is TSX built by Vite into `web/dist/` (VanJS removed); one zod schema per `/api` POST
  body shared by server and client; MCP tool inputs are zod schemas with the published JSON Schema generated from them
  and pinned to a golden fixture. `src/mcp/server.mjs` stays as a shim for existing registrations; `tools/rea-mcp.mjs`
  deliberately untouched. End state: typecheck clean, 288 unit + 35 e2e green. Found on the way: the swf-gate CLI read
  an always-empty crash-report field (fixed); the SVG drop zone rendered as inline border fragments (fixed).

### Repo / docs / ops
- [x] Private GitHub repo `MeyerZon/mewgenics-mods` created + pushed
- [x] `README.md` landing page + `CLAUDE.md` guidance
- [x] Flag `tcrf.net/Mewgenics` as a do-not-fetch source (prompt injection) in `CLAUDE.md`
- [x] Research: `docs/automation-feasibility.md`, `docs/art-pipeline.md`, `docs/swf-tooling-options.md`

### Art pipeline foundation (landed 2026-10-18/19)
- [x] Hand-written SWF emitter (DefineShape + DefineSprite timelines + DefineBitsLossless2 PNG + optional stub DoABC)
- [x] SVG import, verification SWF reader, raw-WebGL in-game-faithful preview, Art-mode editor panels
- [x] Art-mode onboarding (dedicated art tour, empty states, concepts, worked example)
- [x] Performance pass: windowed GON highlighting on rAF, debounced + capped base explorer, preview loop suspends off-screen, play/pause bug fixed
- [x] `docs/art-preview-plan.md`; all of the above: typecheck clean, 77/77 unit tests pass

### Testing
- [x] **Playwright E2E suite** (`editor/tests/e2e/`, 33 tests then, 35 now in `.spec.ts`) + real-browser validation — Data + Art flows + onboarding; `test:e2e` script; Chromium dev-only dep (user-authorized). typecheck + 77 unit + 33 e2e all green
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
4. [x] **Bindings regression test (T1)** — `editor/test/bindings-tests.ts`: every manifest signature matches exactly
   once at its RVA in the installed exe, every function RVA begins a `.pdata` entry, anchors re-verify, self-port
   changes nothing; `check_game_build` reports it live. (2026-10-19, binding-port series)
5. [~] **Framework pure parts**: the build gate is `fw_build.c` (host-tested with the generated tables, `test_build.c`);
   the status definition table / name rules are still inside `status_engine.c`.
6. [x] **Tools tests (T0)**: `tools/bindings/make-signature.ts` is covered by the siggen section of
   `bindings-tests.ts` (uniqueness, cap, negative offsets, rel32/rip wildcards); `tools/gpak.py` by
   `editor/test/gpak-tests.ts` on a synthetic archive (2026-10-19; list/cat/extract/stats, truncation, path escapes).
7. [ ] **Validator fixtures per check**: one failing fixture per finding code (`unknown-status`, `missing-loc-key`,
   `merge-target-missing`, …) so the four checks are each pinned by a T0 test instead of only by the sample mods.
8. [ ] **Golden merge cases**: freeze the merged output of each `.append/.merge/.patch` policy as observed in-game
   (via a `.mewtest` that reads the live value, once 1 lands) so the overlay engine is tested against the game, not
   only against the decompile.
9. [x] **`npm test` without `.extracted/`** (done 2026-10-19, leftovers PR 3: round-trip, real-overlay, validator and the two
   base-data MCP calls skip with a logged `(skipped: …)`; a nested run with `MEWGENICS_EXTRACTED_DATA` = empty dir is
   itself a test). Was: the GON round-trip section fails instead of skipping; make it a logged
   `(skipped: …)` so T0 is runnable (and CI-able) without game data. Decided 2026-10-19: GitHub Actions for T0, **yes**,
   triggered only when relevant paths change (`editor/`, `native/`, `bindings/`, `tools/`, `mods/`), not on docs-only PRs.
10. [x] **Test runner ergonomics** (done 2026-10-19, leftovers PR 3: `npm test -- --only <substring>` / `TEST_ONLY`): a name filter for `run-tests.ts` (or migrate to built-in `node:test`, zero deps,
    gives `--test-name-pattern`/`--watch`) so red/green per test is cheap.
11. [x] **Mechanical enforcement** (decided **yes** 2026-10-19; done 2026-10-20): PR template with the red/green table +
    T3 checklist (PR #26); `.github/workflows/t0.yml` runs T0 on Linux runners (editor typecheck + `npm test` +
    `bindings:check`; native host suites via `native/test-all.sh`; the game is never part of CI) for PRs touching
    `editor/`, `native/`, `bindings/`, `tools/`, `mods/`; the `test-change` job fails a source change without a test
    change unless `[no-test-change: <reason>]` is in the PR body or a commit (`editor/scripts/check-test-change.ts`,
    classifier unit-tested). Owner: keep the jobs non-required in branch protection (docs-only PRs do not trigger them).
12. [~] **Harness features**: ~~expose `-mewtest_clean` in the runner (`clean: true` header)~~ done 2026-10-19 (leftovers
    PR 4) — but it does not yield a complete `debug.log` (the game never shuts itself down; see `ingame-testing.md`
    "Clean mode"), so a log flush needs another lever;
    named-pipe interactive mode (`node tools/mewtest.mjs exec "<cmd>"` + MCP `exec`); RNG seed pinning via `TLS+0x178`
    for exact numeric assertions; `expect log "<substr>"` against `debug.log` from the runner side.

### Verification still owed (things built but not yet validated in-game)
- [ ] **Unit walk** (`dump` with units, `expect status`, `expect units`): only exercised with `available:false`
  (main menu). Offsets come from the `TurnControl::NextTurn` decompile; confirm name/class/faction decoding on a real
  fight (blocked by target 1).
- [ ] **Crash path**: VEH + top-level filter + watchdog never ran against a real fault (`cmd crash` is in-run only).
  Expect: `crash` event, `end code 3`, Mewjector dump in `mod_logs\crashes\`, no WER dialog, exit 3.
- [x] **`-mewtest_clean 1`** never exited (OBSERVED 2026-10-19: no "grace elapsed" line, killed after 7 min). Fixed in
  leftovers PR 4: the decision is the pure `mt_exit_decide` (no dependence on `g_active`), the watchdog leaves via
  `TerminateProcess`, the runner kills 5 s after the `end` record as a fallback. T2 `dev-sandbox/console-smoke-clean`:
  `pass`, 6.5 s, `clean exit grace elapsed … exiting 0` — the game still does not shut itself down when its running
  flag is cleared, and `debug.log` stays truncated.
- [x] **Vanilla-launch gate** of framework 0.3.0: not re-run; owner accepted the unchanged code path 2026-10-19 (the
  inactive-without-`-savesuffix` branch in `framework.c` is untouched since it was verified).
- [ ] **One-off early exit**: the very first 0.3.0 launch exited with code 1 after ~5 s during loading with no crash
  report; never reproduced in 8 later launches. Watch for it (`clean: true` does not give a fuller `debug.log`, see above).
- [x] **Which file `-savesuffix dev` writes** — decoded 2026-10-19 (leftovers PR 5): the suffix is not part of any save
  path; names come from the slot list (`campaign0N` / `steamcampaign0N`), `test00.sav`, `housetest01.sav`
  (`engine-map.md` "Save safety"). The harness now hashes every `*.sav` and allows only the local/test families to change.
- [ ] **`-savesuffix` gives no save isolation on this build** (finding of the decode above): a dev launch that enters a
  Steam-cloud slot would write the real `steamcampaign0N.sav`. The hash check catches it after the fact; decide whether
  dev play should go through `test00.sav` only (test director) or a copied slot, and whether to ask the developer what
  the suffix is meant to do.
- [ ] **`FrameBegin` signature on a future build**: 19 generic prologue bytes; fallback is `ApplicationBase_Step`
  (both in the manifest). The port ladder regenerates them; if `FrameBegin` ends up `ambiguous`, switch the harness
  hook to `Step`.
- [ ] **Hidden window on other machines**: verified on this PC (NVIDIA, ~180 fps hidden); confirm elsewhere before
  relying on it in CI-like setups.
- [ ] **In-run console command set**: `listcmds` at the main menu lists 11 commands; capture the in-run list once
  target 1 lands and pin it in `ingame-testing.md`.

### Next, directly queued
- [x] **Knowledge base** `docs/KNOWLEDGE-BASE.md` — what we know / what we don't / how to operate (indexes all deep-dive docs)
- [x] Docs consolidation pass — gate-test + SWF-crash findings folded into `engine-map.md` (new "Art / SWF subsystem" section) and `KNOWLEDGE-BASE.md`; Ghidra timeout-env gotcha + concurrency rules live in `engine-map.md`
- [x] Scrub tree for public — name + PC paths removed (see "Go public")
- [x] Emitter fix from `swf-emitter-fix-spec.md` (PR #21, 2026-10-19): `AbilityIcon` places a bare shape at **depth 3** per labeled frame (not nested clips) — donor mirrors it; T2 gate `npm run test:swfgate -- <variant>` boots every layout (incl. the pre-fix one) without crashing, and `missing` proves the merge runs. T3 done the same day: owner saw the gray square for `JokersGambit` inside a run, no crash.
- [x] Commit the uncommitted WIP (art pipeline + docs + `CLAUDE.md` flag) — landed; `mods/*/swfs/` is build output
  and git-ignored since the leftovers stack (2026-10-19).
- **Leftovers stack (2026-10-19 night)** — one PR per concern, stacked, owner merges:
  - [x] PR 1 `chore/leftovers-hygiene`: ignore `mods/*/swfs/`, TODO truth, prune merged branches + stale worktree
    (the removal emptied `.analysis/`, `.extracted/data`, `editor/node_modules`, `native/dist` through junctions;
    data and DLLs regenerated the same night, decompiles and the old exe are not — rule added to `CLAUDE.md`)
  - [~] **Rebuild `.analysis/decompiled/`**: 2026-10-19 PR 5's import (`rea_ghidra_leftovers`) re-decompiled every
    bindings function (46), `process_animation_merges` + caller, `ProcessCmds`, the save chain (`MewSaveFile_*`,
    `SaveSelection_Build`, `MewDirector::init` and its 3 callers) — 60+ files. Still missing: `Gon_merge_{a,b,c}` under
    those names (the bindings names are `Gon_PatchMerge_a/b`, `Gon_DeepMerge`), `FileManager_resolve_overlays`
    (= `FileManager_ResolveWithOverlays`), `p2_*`, `r3d_*`, the SWF-crash set (`0xa58440`, `0x9a8f30`).
  - [x] PR 2 `fix/port-report-old-column`: port report `old` column, `--gameVersion`, size/call drift on anchor rows
    (rung-3 hardening — callee-set / vftable-store rungs — stays open; needs a body-changing build to test against)
  - [x] PR 3 `test/t0-skips-gpak-filter`: targets 9 + 10, `tools/gpak.py` T0 suite (characterization: no defect found)
  - [x] PR 4 `fix/harness-clean-exit`: `-mewtest_clean` exits (pure `mt_exit.c` + runner end-grace), `clean:` header,
    unique run dirs for same-second runs; finding: clean mode does not make the game shut down or flush `debug.log`
  - [x] PR 5 `docs/save-suffix-mapping`: decode `MewSaveFile::open_or_create`, savecheck over every real save
    (finding: the suffix never reaches a save path; the whole-dir hash is the real guard)
  - [x] PR 6 `feat/bindings-typeid-witness`: second witness for `LuckUp_typeid` (call-arg before Entity_FindComponentsByTypeId
    in Status_ApplyLuckUp); harvest and port require every source of a constant to agree, else needs-human

### Go public (do LAST, after everything else lands — approved 2026-10-18)
- [x] Scrub complete: mod `author` → "MeyerZon"; test scratch path → env/`""`; save-backup doc path → `%USERPROFILE%`; `chainloader.ini` personal path → `__REPO__` placeholder resolved at install time; `build.bat`/`CLAUDE.md` toolchain path made `GCC`-env-overridable. (Tyler Glaiel's `__FILE__` asserts embedded in the game binary are RE evidence, kept.)
- [x] Fresh single clean commit under a public-safe identity (GitHub noreply email; no private session URL in the commit trailer)
- [x] New **public** repo created + pushed; verified clean history identity, tree grep = 0 for name tokens, nothing ignored/binary slipped in
- [x] Old private repo renamed + **archived** (not deleted — per user); its email-bearing history is retired

### Decisions made (2026-10-19) — work items that fall out of them
- [ ] Ruffle (WASM) dependency for previewing *vanilla* SWFs in-editor — **approved in principle**. Still goes through
  the skeptic dep-gate (source review, no injection, vuln scan) and the owner's explicit per-install go before anything
  is added to `editor/package.json`.
- [x] Dead key `mewged.onboard.conceptsDontShowStart` — button and key removed (PR #25, 2026-10-19, red unit test first).
- [ ] GitHub Actions running T0 (`npm test`, `npm run typecheck`, `native\test-all.bat` where a Windows runner allows)
  on PRs that touch `editor/`, `native/`, `bindings/`, `tools/` or `mods/`; docs-only PRs skip it. Depends on target 9
  (T0 must skip, not fail, without `.extracted/`).
- [x] PR template with the red→green table and the T3 checklist (`.github/pull_request_template.md`) — PR #26, 2026-10-19.

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
- [x] Per-build fragility: `docs/binding-port.md` + the `port-bindings` skill (manifest `bindings/<build>.json`, generated
  headers, harvest/port/check/seed tools, `unknown-build` verdict, `native-build-unknown` validator warning). 2026-10-19.
- [x] **Cross-build port, for real**: done 2026-10-19, 25143593 → 23372843, clean (see the owner checklist above and
  `docs/binding-port.md` "T1 cross-build result"). Proves anchors survive a relink; a body-changing build is still wanted.
- [x] **Port-report `old` column bug** (found by the cross-build run) — fixed in PR #29 (2026-10-19): `finish` now takes
  the pre-port value from the caller; anchor-ported rows also record `size +N / calls +M vs old`.
- [~] **Harden rung 3 (caller ordinal)**: `Status_ApplyLuckUp` / `LuckUp_ctor` port only by call ordinal with no fallback.
  Candidates from the cross-build run: a callee-set rung, a tolerant ordinal window, a vftable-store rung for
  constructors (needs the RTTI phase before the function rungs). Done in PR #29: `--gameVersion` on `cross-build.ts`
  and the rung-2 size/call drift in the report. The new rungs themselves need a body-changing build to test against.
- [ ] **Witness patterns for the 38 unanchored entries** (struct offsets, vtable slot constants) so the port stops
  reporting them as `needs-human`; the witness function + byte pattern per offset, verified by `harvest.ts`. The
  second witness for `LuckUp_typeid` (the `mov r8d, imm32` before `Entity_FindComponentsByTypeId` in
  `Status_ApplyLuckUp`) landed in PR #32; harvest and port now require every source of a constant to agree.
- [x] **Runtime anchor locator in the DLL** (optional): string → lea xref → `.pdata` so anchored-but-unsigned entries
  survive a relink before anyone runs the port. **Dropped** by owner decision 2026-10-19 (see "Decisions").
