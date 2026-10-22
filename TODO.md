# TODO — Mewgenics modding toolkit

Living status snapshot (last updated 2026-10-19 evening: owner ran the game-side checks; every PR through #23 is merged, none open). `[x]` done · `[~]` in progress · `[ ]` planned, not started.

## Open decisions — return to these next time (parked 2026-10-21)

Owner: "we will decide on it later". Everything through PR #71 is merged; the docs sweep at the end of this list is
done (2026-10-21). Owner's answers of 2026-10-21 are recorded under each item; cat parts and filters stay open.

- [ ] **Cat parts in a rig — which route, if any?** Still under discussion (owner, 2026-10-21). The import route is closed (#71: `ImportAssets2` entries are never
      linked, placing one crashes — engine-map "Imports are not linked"). Options:
      (a) copy part geometry from catparts.swf into the mod — ~1 day, 1–2 PRs; frozen copies that do not follow each
      cat's look, and publishing the mod redistributes game art;
      (b) native swap (the game puts its own per-cat parts into our rig's slots) — several RE sessions, 3–6 PRs,
      uncertain;
      (c) neither — keep drawing our own parts (Rig tab + SVG round trip).
- [x] **Localized text?** Texts (#69) are the literal initial string in a game font. Should mods get localized text
      (loc keys / per-language strings), and is Peralta the right default font?
      **Owner, 2026-10-21: deferred; Peralta is fine as the default for now.** No work queued.
- [ ] **Filters / glows:** the game refuses any PlaceObject3 filter ("FILTERS NOT SUPPORTED", #65), so the validator
      blocks them. Want a "bake glow / shadow into the art" helper, or leave it? Still under discussion (owner,
      2026-10-21).
- [x] **VectorCraft's agent channel:** VectorCraft has an MCP server / JSON control port (alpha). Use it later so agents
      draw parts headlessly, or stay with plain SVG round trips (#70)?
      **Owner, 2026-10-21: approved in principle, at least for testing** (agents drawing parts headlessly). Not
      started; scope and install go to the owner before any work (nothing gets installed without the owner's say-so).
- [ ] **T3 looks** (owner, 2026-10-21: he will do these later) still unticked from the art PRs — the shots are in `editor/data/ingame-runs/` (`npm run
      test:artprobe`, `npm run test:artprobe -- --cat` rebuild them):
      gradient square red → black (#63); top green line shorter than the bottom one (#64); the add square a lightened
      dark red (#65); Timeline and Rig tabs readable and usable (#66, #67); PROBE in the game's lettering (#69); an
      Export SVG → edit in VectorCraft/Inkscape → Replace… round trip (#70); the Ruffle tab (#59).
- [x] **Agent, next session (no decision needed):** the deferred docs sweep — the modding skill's art section (root
      timeline is game-driven, filters crash, imports crash, text, SVG round trip, export_svg = 24 MCP tools),
      binding-port.md "Known limits", KNOWLEDGE-BASE's Ruffle line, CLAUDE.md's tool count. Done 2026-10-21
      (`docs/sweep-art-bindings`); the sweep also found the "46 unanchored entries" items stale (closed by #53–#56:
      every manifest entry is anchored) and ticked them below.

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
  only `campaign0N.sav` / `test00.sav` / the harness's `mewtest01.sav` may have moved; `steamcampaign01.sav` keeps its 2026-03-31 mtime.
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
- [x] **Delete the merged local/remote branches** — pruned 2026-10-20 (29 remote branches, every one 0 commits
  ahead of `main` per `git branch -r --merged origin/main`; nothing unmerged existed). The leftover agent worktree
  is still yours (item above).
- [ ] **A fuller `debug.log`**: clean mode does not make the game shut down or flush its log. If you still want load-time
  diagnostics past the truncation, the lever has to come from you (a game setting, a console command that flushes,
  or asking the developer); agents have no safe handle on the game's log stream.
- [ ] **Permission rule for merges** (optional): the harness's auto-mode classifier blocked `gh pr merge` once tonight
  even with your go-ahead in the chat; if you want agents to merge on your word without a retry, add a Bash allow rule
  for `gh pr merge` in `.claude/settings.json` — otherwise keep merging yourself.
- [ ] **Merge policy for autonomy** (your goal 2026-10-20: out of the loop except for viewing results). Today your
  global rule is "never merge without my per-PR word"; on 2026-10-20 you merged the whole stack #39–#48 on one word.
  If you want agents to merge on their own, the rule to put in `~/.claude/CLAUDE.md` is: *agents may merge a PR
  when the T0 workflow is green, the PR body carries the T2 verdict lines (`in-game: N passed, 0 failed`) and its
  T3 list is empty or marked "none"; a PR with a human play-check item waits for your tick.* Until you write that,
  agents keep stopping at "PR open".

## Owner checklist — what only you can check (binding-port series, merged 2026-10-19)

Things no test on this machine can decide. Tick them off here; each links to where the detail lives.

### Needs a second game build
- [x] **Run the real cross-build port.** Done 2026-10-19 against build 23372843 (`download_depot 686060 686061
  8229879464648565847`, exe kept at `.analysis/exe/23372843/`): `0 non-offset entries ambiguous/failed`, exit 0;
  opt-in `npm test` `235 passed, 0 failed`. Only `LuckUp_typeid` differs (`0x4d5` vs `0x4d6`) and the derivation
  caught it. Caveat: every anchored function had identical size/call counts on both builds, so only the relink case
  is proven. Result and the ladder candidates it suggests: `docs/binding-port.md` "T1 cross-build result". Repeat
  with any build that changes SDL or function bodies.
- [ ] **Keep a copy of the current exe** at `.analysis/exe/25143593/Mewgenics.exe` — was done 2026-10-19 (sha256
  `4127cd6a…`) but the worktree-junction wipe of 2026-10-19 took `.analysis/exe/` with it (checked 2026-10-20: the
  dir does not exist). An agent redoes the copy with the decompile rebuild (queued); redo it yourself before every
  Steam update: the anchors are committed, the binary is not, and the self-port/harvest tests need it once the
  install moves on.

### Decisions
- [x] **`sigCap` / `FW_SIG_MAX_BYTES` stays at 128** (owner, 2026-10-19): wait until a port actually reports a pattern
  over the cap, then raise `fw_sig.h` + `native/framework/test/test_sig.c` together (`docs/binding-port.md` "Known
  limits"). Nothing needs more than 86 bytes since 2026-10-22 (`Status_GetCategory`'s 126-byte pattern is gone).
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
- [x] 46 entries (40 struct offsets — the 32 of the cross-build run plus the 8 added for dev scenes and the RNG on
  2026-10-20 — and 6 vtable slot constants) are still `unanchored`: every port reports them as `needs-human`
  instead of guessing. Follow-up below ("Witness patterns for the 46 unanchored entries"); agent work, queued.
  **Closed 2026-10-20** (PRs #53–#56; ticked in the 2026-10-21 docs sweep): every entry is anchored; the witnesses
  are verified on the installed exe, not yet on a second build.
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
1. [x] **Enter a run from the main menu through the harness** (2026-10-20): the `.mewtest` directive `enter
   TacticsTest` replays the dev menu's test-fight button inside `mewtest.dll` (owner's hint: the dev menu has
   "straight into a fight" entries). The game's dev-mode startup makes the test director (`test00.sav`) itself;
   `enter` waits for it, flags it (party generated, not read from a saved winning team), creates the `Battle` scene
   with the `TacticsTest` driver. `mods/dev-sandbox/tests/enter-fight.mewtest`: run commands registered, a turn,
   `dump` with 6 units, `expect units >= 2` — pass, saves untouched. Facts: `docs/engine-map.md` "Dev scenes and
   run entry"; bindings v4 (`FW_SYM_SceneManager_CreateScene`, `Scene_CreateEntity`, `AddComponent_TacticsTest`,
   `Component_GetGame`, `FW_DATA_MewDirector`, …). Same day, second route: `enter Campaign` replays the save-slot click on the harness-owned disposable slot
   `mewtest01.sav` (the runner moves it aside before each such run; `mods/dev-sandbox/tests/enter-campaign.mewtest`:
   new-game cutscene reached and seen in a shot, slot created, real saves unchanged). The intro skip is done too:
   `enter Campaign house` marks the slot `game_began 1` so `MewDirector::start` resumes into the real House
   (`mods/dev-sandbox/tests/enter-house.mewtest`, the campaign director's 57 commands pinned, `set_day` executes). Not taken: SDL input injection. Bonus: the watchdog now closes the game's modal
   WARNING/ERROR boxes and reports them as `popup` events, so a run never hangs on a dialog.
2. [x] **Joker's Luck real feature test (T2)** (2026-10-20): `mods/jokers-luck/tests/luck-rerolls.mewtest` — `enter
   TacticsTest`, `bind JokersGambit` (accepted), `expect status JokersLuck on 0`, `expect stacks JokersLuck on 0 >= 1`,
   four `dump`s across three rounds, `expect stacks JokersLuck on 0 varied`: **pass** (stacks 1 → 10 → 7 → 9). The
   status is put on the cats at battle start by the test-only overlay `mods/_jokersluck-test/`
   (`StatusOnBattleStart { JokersLuck 1 }`); `stacks` per status is in the units event (host-tested). Found: the
   harness had refused the status's cloned vtable (framework thunks outside the exe) — fixed.
3. [x] **Auto-resolve overlay mod** `mods/_autoplay/` (`data/characters/player_cat.gon.merge` → `PlayerCat { passives {
   Uncontrollable 1 } }`), 2026-10-20: validator + merge-preview tests (`run-tests.ts` 4c, PR #43), T2 load smoke, and
   `tests/round2.mewtest` — `enter TacticsTest`, `spawn Rat`, `wait rounds 1`, `expect round >= 2`: **pass**, the
   generated player cats take their own turns (turns 2..6 in ~17 s); without the overlay the same fight sits at the
   player's turn until the timeout.
4. [x] **Bindings regression test (T1)** — `editor/test/bindings-tests.ts`: every manifest signature matches exactly
   once at its RVA in the installed exe, every function RVA begins a `.pdata` entry, anchors re-verify, self-port
   changes nothing; `check_game_build` reports it live. (2026-10-19, binding-port series)
5. [x] **Framework pure parts**: the build gate is `fw_build.c` (host-tested with the generated tables, `test_build.c`);
   the status definition table / name rules / alias rewrite / hierarchy rewrite are `fw_status_rules.c` since
   2026-10-20 (`test_status_rules.c`, 14 checks; one cap of 8 shared by `framework.c` and `status_engine.c`, which
   had disagreed 16 vs 8). Since 2026-10-21 the rest is pure too: the vtable clone + thunk bodies are `fw_vtable.c`
   (`test_vtable.c`, 12 checks incl. a golden-bytes clone and a T1 clone of the real dump
   `.analysis/luckup-vtable.hex`), the entity/component walks and the apply/merge/set-stacks writes are `fw_walk.c`
   (`test_walk.c`, 11 checks over fake objects shaped by `offsets.h`), symbol resolution over the executable
   sections, the `-savesuffix` gate, the `FW_GetSymbol`/`FW_GetData` bounds and the hook plan (order, priorities,
   failure policy) are `fw_resolve.c` (`test_resolve.c`, 14 checks). Still game-bound by nature: the PE header
   read, the Mewjector calls, the per-definition C thunks and lookup wrappers (fixed game ABI), the calls into the
   template constructor / vtable slots / `Status_Remove` / the string destructor, and logging — `status_engine.c`
   and `framework.c` are the thin glue around the pure modules.
6. [x] **Tools tests (T0)**: `tools/bindings/make-signature.ts` is covered by the siggen section of
   `bindings-tests.ts` (uniqueness, cap, negative offsets, rel32/rip wildcards); `tools/gpak.py` by
   `editor/test/gpak-tests.ts` on a synthetic archive (2026-10-19; list/cat/extract/stats, truncation, path escapes).
7. [x] **Validator fixtures per check** (2026-10-20): `editor/test/validator-tests.ts` + `editor/test/fixtures/validator/`
   — a synthetic base and one minimal mod per finding code (all 20: `mod-missing` … `csv-column-count`, plus a clean
   mod), driven through injectable `ValidateOptions` (`modDir`, `extractedData`, `components`, `registeredNames`), so
   the checks run at T0 without game data. Found on the way: the overlay-target check joined a hardcoded `.extracted/`
   and ignored `MEWGENICS_EXTRACTED_DATA` (fixed). Follow-up done 2026-10-21 (`fix/worktree-env-paths`):
   `preview-merge.ts` resolves the base through the shared `packPath` / `EXTRACTED_DATA` with an injectable
   `extractedData` (`editor/test/preview-merge-tests.ts`); `MEWGENICS_EDITOR_DATA` redirects the `editor/data`
   caches and a missing component list is one `component-list-missing` info / a logged skip
   (`docs/tdd-procedure.md` "Running the editor from a git worktree").
8. [ ] **Golden merge cases** (owner 2026-10-20: "tdd 8 - ok" — the "golden through `dump`" sub-item is approved and
   queued as agent work, first of the 2026-10-20 run): freeze the merged output of each `.append/.merge/.patch` policy as observed in-game
   so the overlay engine is tested against the game, not only against the decompile. **Still blocked after target 1
   (2026-10-20):** no console command reads a live GON value — the full in-run command set (84, pinned in
   `editor/test/fixtures/ingame/console-tacticstest-listcmds.txt`) has `spawn`/`load`/`status`/`passive`/`equip`
   but nothing that prints a field, and the decompiled file resolver works on parsed GON trees, so an in-game golden
   needs the GON object layout (new RE). The weaker sub-item is done:
   - [x] "golden through `dump`" (2026-10-20): `mods/_golden-merge/` + `expect unit <unit> <field> <op> <value>`;
     `vanilla.mewtest` / `golden.mewtest` play the same seeded fight and pin `.merge` (Rat → "Golden Rat", faction
     allies), `.patch` `faction.overwrite` (Pooter → allies) and `.append` (a new spawnable `GoldenRat`) through the
     units event; fixtures `result-golden-{vanilla,merge}.jsonl`; the editor's previews of the same overlays at T0
     (`run-tests.ts` 4d, incl. `speed.add 10` → 15). Not observable in-game yet: numeric `.add`/`.multiply` — the
     units event has no stat/HP field. Follow-up (agent): decompile the `1hp` / `999` console lambdas registered by
     `TacticsTest::init` (string xref, never the whole init) for `OFF_CH_HP`, add `hp` to `MtUnit`, then pin
     `properties.health.multiply` the same way.
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
    ~~`expect log "<substr>"` against `debug.log` from the runner side~~ done 2026-10-20 (`report.logExpects`; the DLL
    gets a `# runner: …` comment in its place). ~~named-pipe interactive mode~~ done 2026-10-20 (`interactive: true` /
    `-mewtest_pipe 1`, `mt_queue.c`, `MT_S_IDLE`, `editor/src/core/ingame/{pipe,session}.ts`, MCP `start_ingame_session` /
    `ingame_exec` / `stop_ingame_session`; `docs/ingame-testing.md` "Interactive mode"). Was: named-pipe interactive mode
    (`node tools/mewtest.mjs exec "<cmd>"` + MCP `exec`) is a native IPC feature — a pipe thread marshalling commands
    onto the frame hook — with its own DLL host tests and T2, not a runner change. ~~RNG seed pinning via
    `TLS+0x178`~~ done 2026-10-20: `seed <N>` (bindings `Rng_SeedState` / `Rng_Reseed`, offset `Tls_rngState`);
    `mods/jokers-luck/tests/luck-seeded.mewtest` asserts exact stacks (1 → 10 → 7) and the generated party by name,
    identical across runs. Also done: `shot "<label>"` screenshots the agent reads (T3a).

### Verification still owed (things built but not yet validated in-game)
- [x] **Unit walk** (`dump` with units, `expect status`, `expect units`): verified on a real fight 2026-10-20
  (`enter TacticsTest`: 6 units with names, classes and factions decoded — `editor/test/fixtures/ingame/result-enter-fight.jsonl`).
- [x] **Crash path**: ran against a real fault 2026-10-20 (an access violation inside `TacticsTest::init` during an
  early entry attempt): `crash` event, `end code 3`, the game's own `crash_*.txt`, no WER dialog, exit 3.
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
  the suffix is meant to do. Harness side settled 2026-10-20: scripted meta-flow tests use the disposable
  `mewtest01.sav` (`enter Campaign`, moved aside per run); the human dev-play policy is still yours.
- [x] **`FrameBegin` signature on a future build** — 2026-10-22: the 19 generic prologue bytes are replaced by a body
  window from +45 (86 bytes, 4 rip refs masked) keyed on the per-frame defaults FrameBegin stores (`0xffffff09`,
  `0x0be2`, `02 02 02 04`, `05 04 05 02`, `02`; 1 hit image-wide on 25143593), plus `before: ApplicationBase_FrameEnd`
  and `FrameEnd.after: FrameBegin` (`.pdata` 25655 → 25656) as the rung behind it. It lea's no funcsig/file string
  (71 rip refs, all globals — `.analysis/decompiled/ApplicationBase_FrameBegin_0x9b7870.c`). `ApplicationBase_Step`
  stays the fallback hook point; `make-signature --manifest` would regenerate the prologue window, so keep the body
  one by hand (noted in the entry and in `docs/binding-port.md`).
- [ ] **Hidden window on other machines**: verified on this PC (NVIDIA, ~180 fps hidden); confirm elsewhere before
  relying on it in CI-like setups.
- [x] **In-run console command set**: captured 2026-10-20 after `enter TacticsTest` — 84 commands, pinned verbatim in
  `editor/test/fixtures/ingame/console-tacticstest-listcmds.txt` and listed in `ingame-testing.md`.

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
  - [x] **Rebuild `.analysis/decompiled/`** (done 2026-10-20, session `rea_ghidra_house`): the nine missing manifest
    functions (`TurnControl_NextTurn`, the `ApplicationBase` frame/step/appmain set, `Gon_DeepMerge`, `Rng_SeedState`, …),
    the four LuckUp slot bodies + `.analysis/luckup-vtable.hex`, the SWF-crash pair (`Swf_Merge_0xa58440.c`,
    `Swf_MovieClipAdvance_0x9a8f30.c`); the manifest's 27 stale evidence names now point at the files on disk (a test
    pins it); the exe copy is back in `.analysis/exe/25143593/`. Deliberately not regenerated: `r3d_*` / `p2_*` (3D
    renderer, not current work) and `Status_AttachPassive` (232 KB; only its callers/size are kept).
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
- [x] GitHub Actions running T0 — done 2026-10-20 (PR #40, target 11): `.github/workflows/t0.yml` on Linux runners
  (editor typecheck + `npm test` + `bindings:check`; native host suites via `native/test-all.sh`; the game never)
  for PRs touching `editor/`, `native/`, `bindings/`, `tools/`, `mods/`; docs-only PRs skip it.
- [x] PR template with the red→green table and the T3 checklist (`.github/pull_request_template.md`) — PR #26, 2026-10-19.

### The 2026-10-20 run — "proceed over every agent task" (owner), in this order, one PR each, owner merges
TODO truth (this PR) → golden through `dump` (target 8) → named-pipe `exec` (target 12) → intro skip after
`enter Campaign` → witnesses for the 46 unanchored entries (4 PRs) → `.analysis/decompiled/` rebuild + evidence
truth → Ruffle (install approved 2026-10-20) → in-game probe of the renderer's INFERRED behaviours → gradients →
MCP art tools → DefineShape4/LineStyle2 → PlaceObject3 → animation-clip authoring → cat-rig UI → fonts/text
(owner decision first) → VectorCraft handoff (owner info first). Plan: the session's plan file; progress: the PR list.

### Larger build-out
- [ ] Animation-clip authoring workflow (DefineSprite timelines end-to-end) once the emitter is engine-valid
- [ ] Part-indexed **cat-rig** authoring UI (model already supports named layers)
- [ ] Cat parts in a rig: the import route is closed (2026-10-20: ImportAssets2 entries are never linked; placing one crashes — engine-map "Imports are not linked"). Remaining routes: copy part geometry into the mod (~1 day, frozen copies, redistributes game art) or native swap (several RE sessions). Owner's call.
- [x] Clip authoring (Timeline tab, timeline-edit.ts) and the cat rig (Rig tab, cat-rig.ts) — 2026-10-20, art build-out G + H; the game drives a character's root timeline, units are tinted by position
- [ ] Emitter: ~~gradient fills~~ (done 2026-10-20, art build-out C: gradient.ts, gate `gradient`, probe square drawn in-game), ~~LineStyle2~~ (done 2026-10-20, art build-out E: DefineShape4, stroke.ts, gate `shape4`, caps honoured in-game), ~~fonts/text~~ (done 2026-10-21: DefineEditText in a game font class + ImportAssets2 fonts.swf, like vanilla; drawn in-game), ~~PlaceObject3~~ (done 2026-10-20, art build-out F: blends load and apply in-game; filters crash the game and are a validation error)
- [ ] MCP tools for art (so agents can author art, not just data)
- [x] External vector editor round trip (2026-10-21): VectorCraft (github.com/storytold/vectorcraft) is a static vector editor without timeline or player, so it edits single shapes through plain SVG — Export SVG / Replace… on Shapes rows, MCP `export_svg`, `svg-export.ts`; animation stays in the Timeline tab
- [ ] Testing frontier from `automation-feasibility.md`: AI-brain auto-resolve to smoke-test mods in a real fight (tiers B/C) → now TDD targets 1–3 above; an IPC action layer (tier D) → the named-pipe mode in target 12

### Open engine unknowns to resolve
- [~] Exact SWF-format + `_Append_`/SymbolClass convention the loader requires — binding needs no DoABC; `_Append_<Target>` merges at boot; an unknown target stalls the boot (OBSERVED 2026-10-19); what the display path needs is the open half
- [x] RNG seeding for deterministic test runs — done 2026-10-20 (target 12, PR #48): `seed <N>` pins `TLS+0x178`
  through `Rng_SeedState` once the game's startup is over; `luck-seeded.mewtest` asserts exact values run to run.
- [x] Headless / startup-macro mode — solved by the harness (in-process console execution + hidden window), not by the game
- [ ] Verify the INFERRED preview behaviors (nested-sprite framing, cxform-after-remap, engine fill rule, bitmap sampling)
- [x] Per-build fragility: `docs/binding-port.md` + the `port-bindings` skill (manifest `bindings/<build>.json`, generated
  headers, harvest/port/check/seed tools, `unknown-build` verdict, `native-build-unknown` validator warning). 2026-10-19.
- [x] **Cross-build port, for real**: done 2026-10-19, 25143593 → 23372843, clean (see the owner checklist above and
  `docs/binding-port.md` "T1 cross-build result"). Proves anchors survive a relink; a body-changing build is still wanted.
- [x] **Port-report `old` column bug** (found by the cross-build run) — fixed in PR #29 (2026-10-19): `finish` now takes
  the pre-port value from the caller; anchor-ported rows also record `size +N / calls +M vs old`.
- [x] **Harden rung 3 (caller ordinal)** — done 2026-10-22 (bindings hardening PR, from `.analysis/notes-bind.md`):
  vtables port first; new rungs `vtable-store` (`LuckUp_ctor` = the only lea of `LuckUp_vftable`), `imm32-witness`
  (`Status_ApplyLuckUp` = `mov r8d, LuckUp_typeid` before `Entity_FindComponentsByTypeId`, the id re-derived on the
  new image), `caller-after-lea` (the first in-tolerance E8 after `lea rdx,["LuckUp"]` in `apply_status` /
  `attach_passive`), `pdata-predecessor` and `shared-data-ref` (`NameExists` shares `GetValue`'s map); multi-candidate
  string hits are filtered by the tolerance before `ambiguous`; the 11 lookups carry the `.pdata` chain. The harvest
  verifies every one of these anchors on the current exe. The caller ordinal is the last rung for both LuckUp
  entries, not the only one. Also fixed on the way: `decodeRelocs` dropped a reloc straddling the window end, the
  decoder ignored the `66` prefix, and window starts fell inside instructions — three signatures were unique only
  through unmasked relocation / type-id / `__LINE__` bytes and are `null` now (the DLL takes the raw RVA). Still
  wanted: a body-changing build to exercise the rungs on a real recompile (the T1 cross-build only relinked).
- [ ] **Witness patterns for the 46 unanchored entries** (40 struct offsets, 6 vtable slot constants) so the port stops
  reporting them as `needs-human`; the witness function + byte pattern per offset, verified by `harvest.ts`. The
  second witness for `LuckUp_typeid` (the `mov r8d, imm32` before `Entity_FindComponentsByTypeId` in
  `Status_ApplyLuckUp`) landed in PR #32; harvest and port now require every source of a constant to agree.
  Done 2026-10-20: offset witness harvest (#53), batch 1 — 19 harness/app/scene offsets (#54), batch 2 — 21
  status_engine offsets (#55), the six vtable-slot constants derived (#56); nothing in the manifest is unanchored.
- [x] **Runtime anchor locator in the DLL** (optional): string → lea xref → `.pdata` so anchored-but-unsigned entries
  survive a relink before anyone runs the port. **Dropped** by owner decision 2026-10-19 (see "Decisions").
