# Mewgenics modding — Knowledge Base

The single entry point for this project. It summarizes **what we know**, **what we don't know yet**, and **how to
operate**, and indexes the deep-dive docs. Detailed evidence (tagged OBSERVED / INFERRED / COMMUNITY-SOURCED) lives in
the linked docs; this page is the map.

---

## What we know

### The game & build
- **Mewgenics**, Steam app **686060**, version **1.1.21239** / Steam build id **25143593**.
  `Mewgenics.exe`: x64 PE, unsigned, MSVC, RTTI retained, image base `0x140000000`, 56,359 functions,
  sha256 `4127cd6a…`, PE TimeDateStamp `0x6a9c51e5`. `resources.gpak` ≈ 5.1 GB, 19,979 entries (not encrypted).
- Tyler Glaiel's **custom C++ engine**, namespace `glaiel::`. SDL3 (static) + OpenGL; Dear ImGui; FAudio; a bespoke
  SWF player (`glaiel::swf`, "glaielswf"); SQLite saves. **No scripting VM.** SteamUGC is linked but Workshop isn't shipped.
- Details: **[engine-map.md](engine-map.md)**.

### Space is strictly 2D
- Gameplay is a flat tile grid indexed by `iVec2D` (col,row). `Vec3D`/`height`/jump arcs exist only for **rendering**;
  `layer` = object-category channel, `flying` = a flag — **no real third gameplay axis**. Details: **[spatial-model.md](spatial-model.md)**.

### Data layer (the sanctioned path)
- The dev-built `-modpaths` loader overlays GON/CSV/text files; `X.gon.append/.merge/.patch` = GON
  Append / DeepMerge / PatchMerge; any binary can be **whole-file overridden**. Content is composed from ~1,750 named
  C++ behavior components. Details + content shapes: **[data-mods.md](data-mods.md)**.

### Native layer
- The Mewjector `version.dll` chainloader loads our `mewframework.dll`, which **gates on `-savesuffix` + the build id
  and fails closed** on any other build. Custom statuses = vtable clone + hooking name-keyed property lookups. Byte
  signatures/RVAs for this build live in `bindings/25143593.sig.tsv`. Sample **Joker's Luck** status is verified in combat.
  Details: **[engine-map.md](engine-map.md)**.

### Art pipeline
- Primary art is **vector SWF** (uncompressed FWS, SWF v17, a small tag subset) via `glaiel::swf`; cats are a
  **part-indexed paper-doll**; recoloring is a **shared `palette.png` grayscale remap** (`paletted_full.shader`); 50 GLSL
  shaders. Authoring without Adobe is viable (JPEXS edits, or our emitter). Details:
  **[art-pipeline.md](art-pipeline.md)**, **[swf-tooling-options.md](swf-tooling-options.md)**.

### Automation / testing levers
- Debug console (`-enable_debugconsole`, backtick): `load <n|path.lvl>` launches a specific fight; `bind <Ability>`.
  **AI-brain auto-resolve** of combat is achievable *data-only* (e.g. `Uncontrollable` passive / `ai{brain GenericBrain}`).
  **No** RNG-seed command and **no** headless/startup-macro mode in the game itself. Details:
  **[automation-feasibility.md](automation-feasibility.md)**.
- **The `mewtest` harness closes the headless/autoexec gap** (2026-10-18): the console dispatcher
  `DebugConsole::Execute` (`0xa14aa0`) is called in-process from a `FrameBegin` hook, output is read from the console's
  own vector, the window is hidden through the SDL3 DYNAPI slots (the sim keeps ticking), and a JSON-lines result +
  exit code become a verdict. `npm run test:ingame` / MCP `run_ingame_test`. Only the engine's 11 commands exist at
  the main menu; game commands need a run in progress. Details: **[ingame-testing.md](ingame-testing.md)**.
- **How we work**: every change test-first, four tiers (T0 unit, T1 local data, T2 in-game, T3 human):
  **[tdd-procedure.md](tdd-procedure.md)**.

### The toolkit we built (`editor/`)
- A **zero-runtime-dependency** data-layer mod editor: a GON engine + overlay/merge engine + 4-check validator as the
  single source of truth, a hand-rolled **MCP server** (`mewgenics-editor`, 9 tools, for agents), and a VanJS **web UI**
  (Data + Art modes, IDE-style, with onboarding). **Art mode** has a hand-written SWF emitter, SVG import, and a
  WebGL in-game-faithful preview. Validated: 77 unit + 33 Playwright e2e tests, typecheck clean. Overview:
  **[../README.md](../README.md)**; art design/plan: **[art-preview-plan.md](art-preview-plan.md)**.

### The SWF-emitter crash — understood
- Our hand-emitted minimal SWF **parses cleanly**; the in-game crash is a **post-load null-deref**, not malformation.
  Under linkage `_Append_AbilityIcon` the clip is merged into the live `AbilityIcon` sprite (`process_animation_merges`
  0x9bc070); a **structurally-naive appended frame** (a bare shape instead of the clip's per-frame movieclip structure)
  perturbs it so a post-load scene update fires a scripted call into the adventure-cutscene handler with no active run
  → null double-deref. **Leading fix: wrap the icon in a nested `DefineSprite` mirroring `AbilityIcon`'s per-frame
  structure** (not a bare `DefineShape3`), default `abc:"none"`, keep FWS + `_Append_<name>`. The `_Append_AbilityIcon`
  name is correct; char-ID collision was ruled out. Full spec (with 6 decompiles): **[swf-emitter-fix-spec.md](swf-emitter-fix-spec.md)**.

---

## What we don't know yet / open

- **SWF emitter**: fixes are *specified* but not yet *implemented* or re-tested in-game.
- A few preview behaviors are **INFERRED** (nested-sprite framing, cxform-after-remap, the engine's fill rule, bitmap sampling).
- **RNG seeding**: no user-facing control; the global state is `TLS+0x178`, so pinning it from our DLL is possible but
  not built. The **headless** gap is covered by the harness's hidden window, not by a game mode.
- **Entering a run from the main menu through the console**: no command does it (the menu is mouse-driven), which
  blocks in-combat harness assertions. Also unresolved: which file `-savesuffix dev` actually writes (dev launches
  changed `campaign02.sav`; `steamcampaign01.sav` stayed untouched, which the harness verifies by hash every run).
- **Ruffle (WASM)** as an optional dep to preview *vanilla* SWFs in-editor — not decided (would go through the dep-gate).
- Not built: **animation-clip authoring** (DefineSprite timelines end-to-end), a **cat-rig** (part-indexed) UI, art MCP tools.
- **Per-build fragility**: everything native (signatures, the status pipeline) is pinned to build `25143593`; a game
  update breaks it until signatures are re-derived (framework fails closed, so it won't crash/corrupt meanwhile).
- Whether an **official Workshop/launcher** ships (the dev intends to; not yet).

---

## How to operate

### Daily modding (no reverse engineering needed)
- `launch-dev.bat` — runs the game with `-savesuffix dev`, debug console, dev mode, and the sample mod paths.
- `editor/`: `npm install` → `npm run build:index`, then `npm run web` (UI) / `npm run mcp` (agent server) /
  `npm test` / `npm run test:e2e` / `npm run test:ingame` (real game, T2). Native host tests: `native\test-all.bat`.
- `python -I tools/gpak.py list|cat|extract|stats` — read-only pack access.
- Author/validate mods in the editor (or via the `mewgenics-editor` MCP tools); overlays live in `mods/<name>/`.

### Hard safety rules (never violate)
- **Never** modify or write `Mewgenics.exe`, `resources.gpak`, or any save file. The real 83%-complete save is
  isolated by `-savesuffix dev`; back up `%APPDATA%\Glaiel Games\Mewgenics\<steamid>` before new mod builds.
- Editor/MCP writes are confined to `mods/<name>/`. Never commit extracted assets or game bytes beyond short signatures
  (`.extracted/`, `.analysis/`, `editor/node_modules/`, `editor/data/`, binaries are git-ignored).

### Reverse engineering (only for maintenance — see [README](../README.md#reverse-engineering-optional--maintenance-only))
- REA + Ghidra via `tools/rea-mcp.mjs` (Docker image `rea-ghidra:12.1.4`). **Gotcha that cost us two agent runs:** a
  full import of the 22 MB exe takes ~17 min but REA's default call deadline is **330000 ms** — you **must** set
  `REA_GHIDRA_STARTUP_TIMEOUT_MS` ≥ **1800000** in the container env and use `watch` mode (one import, reused).
- Much is answerable **without** Ghidra: parse the PE export table + `.analysis/list_names.tsv` /
  `list_procedures.tsv` to resolve addresses (that's how the SWF crash was solved). Re-derive `bindings/` signatures on a
  game update with `tools/bindings/make-signature.mjs --manifest bindings/<build>.json --write`, then `npm run bindings:gen`.

### Flagged source — do not fetch
- **`tcrf.net/Mewgenics`** served prompt-injection content and a false "gpak is encrypted" claim. Do not fetch or act
  on it (also in `CLAUDE.md`). The gpak is not encrypted.

---

## Document index

| Doc | What it covers |
|---|---|
| [engine-map.md](engine-map.md) | Build identity, engine subsystems, RVAs, data model, native status pipeline |
| [data-mods.md](data-mods.md) | `-modpaths` + GON overlay semantics, content shapes, data↔native pairing |
| [spatial-model.md](spatial-model.md) | 2D-vs-3D verdict and the coordinate/grid/rendering evidence |
| [art-pipeline.md](art-pipeline.md) | How images / SWF / rigs / palettes / shaders work and what's moddable |
| [swf-tooling-options.md](swf-tooling-options.md) | The minimal SWF subset the engine needs; no-Adobe authoring strategies |
| [swf-emitter-fix-spec.md](swf-emitter-fix-spec.md) | Why the emitted SWF crashes; the exact emitter fixes |
| [art-preview-plan.md](art-preview-plan.md) | Art-mode architecture, source model, preview render path, onboarding, perf |
| [automation-feasibility.md](automation-feasibility.md) | Launching fights, AI auto-resolve, seeding, headless; tiered testing plan |
| [ingame-testing.md](ingame-testing.md) | The `mewtest` harness: script grammar, JSONL events, exit codes, verdicts, verified facts |
| [tdd-procedure.md](tdd-procedure.md) | The TDD rule in practice: tiers T0–T3, the red/green loop, PR evidence |
| [../README.md](../README.md) | Project overview + quickstart | 
| [../TODO.md](../TODO.md) | Living status checklist |
| [../CLAUDE.md](../CLAUDE.md) | Guidance for AI agents + safety rules + flagged sources |
