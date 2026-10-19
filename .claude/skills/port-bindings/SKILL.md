---
name: port-bindings
description: Port the native layer's bindings (bindings/<steamBuildId>.json, from which native/framework/src/signatures.h and offsets.h are generated) to a new Mewgenics build after a Steam update, using tools/bindings/*, the editor MCP tools check_game_build / port_bindings and, only for entries the ladder cannot settle, REA/Ghidra with a seed file; use when the in-game runner reports `unknown-build`, the validator warns `native-build-unknown`, check_game_build says known:false, or the owner says the game updated. Not for data-layer mods under mods/ (string-keyed overlays need no porting).
metadata:
  version: "1"
  domain: mewgenics-native-bindings
---

# Porting the native bindings to a new game build

Data mods are text merged by the game's own loader and refer to everything by name: a game
update does not touch them. The native layer (`native/`) is pinned to one build: byte
signatures, raw hook RVAs, data/vtable addresses, a type id and ~30 struct offsets. All of it
lives in **`bindings/<steamBuildId>.json`** (the manifest; `native/framework/src/signatures.h`
and `offsets.h` are generated from it) together with *anchors*: the evidence that finds each
value again in a rebuilt exe. Reference: `docs/binding-port.md`.

The framework fails closed on an unknown build (logs `unknown build: ...`, installs nothing),
so a stale manifest is a disabled mod, never a crash. Your job is to produce
`bindings/<newBuild>.json` with every entry ported or honestly reported.

## Before you start

- Confirm the situation: MCP `check_game_build {}` (or `node tools/bindings/check-build.mjs`).
  `known:true` and all signatures `ok` means nothing to port. `known:false` prints the identity
  and how many signatures survived the relink (the first porting signal).
- You need: the new `Mewgenics.exe` (installed, or a copy; Steam console `download_depot 686060
  <depot> <manifest>` fetches a specific build), the newest manifest (`bindings/*.json`, already
  harvested: PR "harvest" must have landed before the update), and the new Steam build id.
- Work on a branch `feat/bindings-<newBuild>`. Never write the exe, never commit game bytes
  (`.analysis/` is git-ignored: keep a copy of the old exe at `.analysis/exe/<oldBuild>/`).
- Every change is TDD (`docs/tdd-procedure.md`); the port tool's own tests are the T0 layer,
  `npm test` against the new exe is T1, `npm run test:ingame` is T2.

## Procedure

1. **Dry run.** `node tools/bindings/port.mjs --from bindings/<old>.json --exe <new exe>
   --build <newBuild> [--version <gameVersion>]` or MCP `port_bindings { build, exe?, version?,
   dryRun: true }`. Read the report: one row per entry with a status from the closed set
   `ported-exact | ported-rescan | ported-anchor | ported-witness | ported-derived | proposed |
   ambiguous | failed | needs-human`.
2. **Resolve what the ladder could not.** Only `ambiguous` and `failed` rows need you:
   - For each, the report lists candidates (RVA, size, call count, how found) and the old
     entry's evidence (`anchors`, `evidence[]` paths under `.analysis/decompiled/`).
   - Cheap first: compare the candidate's decoded bytes/strings with the old decompile; check
     callers/callees against already-ported neighbours.
   - REA/Ghidra only when needed (one ~17 min import per exe): start **your own** containers
     (`rea_ghidra_<tag>`, own queue dir, read-only mounts: `docs/engine-map.md` "REA / Ghidra
     sessions"; never stop anyone else's). Windows Ghidra is read-only, so name things with seed
     files: `node tools/bindings/seed-file.mjs --manifest bindings/<old>.json --out
     .analysis/seeds-<old>.tsv` for the OLD exe, and after a `--apply` dry run on the new side,
     `--manifest bindings/<newBuild>.json` which emits `Name__cand_<rva>` seeds for every
     candidate. Then `analyze_function` old + candidates, `compare_functions` (only `cfg` and
     `strings_names` are meaningful on a stripped exe), `record_unknown` for what stays open.
     Save every decompile you rely on to `.analysis/decompiled/`.
   - Re-run with `--resolve Name=0xRVA` (or MCP `resolve: { Name: "0xRVA" }`) for each answer.
3. **`proposed` struct offsets are never applied by the tool.** Apply one only with
   `--resolve` after a green T2 run that exercises it; otherwise leave the old value and say so.
4. **`needs-human` entries** are carried over unchanged (unanchored offsets, vtable slot
   constants, SDL slots when the SDL version changed). List them in the PR; verify what you can
   (`.analysis/decompiled/`, the harness `dump` output, a played fight).
5. **Apply.** `--apply` (or `dryRun: false`) writes `bindings/<newBuild>.json` and
   `bindings/<newBuild>.port-report.md`, nothing else. Then, from `editor/`:
   `npm run bindings:gen` → build `native/framework`, `native/mods/test-harness`,
   `native/mods/jokers-luck` → copy the DLLs to `native/dist/` → `npm test` (T1: every signature
   matches once on the new exe, anchors re-verified) → `npm run test:ingame` (T2: the verdict
   must be `pass`, never `unknown-build`).
6. **Harvest the new build** so the *next* update has anchors: `node tools/bindings/harvest.mjs
   <new exe> --manifest bindings/<newBuild>.json --write` (0 mismatches expected), regenerate
   headers, re-run the tests.
7. **PR.** Include the port report, the red→green evidence table, the T2 verdict lines, the
   list of resolved entries with how each was decided, and the human-decision list. Stop and
   report; never merge.

## Ledger discipline

- Every entry ends in exactly one status; nothing is guessed silently. If you cannot decide an
  `ambiguous` entry, leave it `ambiguous` and say which candidates remain and why.
- Values of `ambiguous`/`failed` entries keep the OLD RVA in the manifest; the generated headers
  for such a build are not shippable until they are resolved (the DLL would hook a wrong
  address). Say so in the PR if you stop early.
- Record the facts you establish (new RVAs, changed offsets, SDL version) in
  `docs/engine-map.md` and in the manifest's `evidence[]`; a fact only in prose is not done.

## What stays a human decision

A changed SDL version (DYNAPI slot order), a compiler/CRT change (`MsvcString` layout,
`_Allocate<16>`), a changed vtable slot count or slot index, a changed arity of the 13 status
lookups (shapes A–E in `status_engine.c`), any `proposed` offset, and raising `sigCap` /
`FW_SIG_MAX_BYTES` beyond 128.
