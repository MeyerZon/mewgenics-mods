# Mewgenics modding — Knowledge Base

The single entry point for this project. It summarizes **what we know**, **what we don't know yet**, and **how to
operate**, and indexes the deep-dive docs. Detailed evidence (tagged OBSERVED / INFERRED / COMMUNITY-SOURCED) lives in
the linked docs; this page is the map. Last refreshed 2026-10-22, after the 2026-10-21/22 parallel RE run (ten Ghidra
sessions, ~500 new decompiles; the PR map is at the top of `TODO.md`). "PR #n" below means the fact lands with that
PR; everything else is on `main`.

---

## What we know

### The game & build
- **Mewgenics**, Steam app **686060**, version **1.1.21239** / Steam build id **25143593**.
  `Mewgenics.exe`: x64 PE, unsigned, MSVC, RTTI retained, image base `0x140000000`, 56,360 procedures,
  sha256 `4127cd6a…`, PE TimeDateStamp `0x6a9c51e5`. `resources.gpak` ≈ 5.1 GB, 19,979 entries (not encrypted).
- Tyler Glaiel's **custom C++ engine**, namespace `glaiel::`. SDL3 (static) + OpenGL; Dear ImGui; FAudio; a bespoke
  SWF player (`glaiel::swf`, "glaielswf"); SQLite saves. **No scripting VM.** SteamUGC is linked but Workshop isn't shipped.
- Details: **[engine-map.md](engine-map.md)**. Its sections, one fact each:
  - *Command line / Verified behavior* — `-modpaths` resolution and the overlay dispatch: `.append` → `Gon_Append`
    0x945410 (a clashing name is kept twice), `.merge` → `Gon_DeepMerge_plain` 0x945c30 under a constant MERGE policy
    (never reads key suffixes), `.patch` → 0x946680 (PR #75, #78).
  - *Data model* — the GON parser types a scalar from its text alone: quotes are dropped, `"5"` is a number, `,` `:`
    `=` are whitespace (PR #83).
  - *Functions and signatures* — every native binding lives in `bindings/25143593.json`; `.analysis/list_names.tsv`
    (452,868 rows) is back on disk since 2026-10-22.
  - *Debug console and application loop* — `DebugConsole::Execute` 0xa14aa0 is what the harness calls; the RNG
    state is `TLS+0x178` and `seed <N>` pins it.
  - *REA / Ghidra sessions* — one container + queue dir per agent; the 2026-10-21/22 lessons (30 GB Docker VM, the
    inventory export recipe, `search_bytes` for short strings).
  - *Status effects* — a status is a 0xF0-byte `glaiel::<Name> : Status : Passive`; the 13 name-keyed lookups the
    framework aliases; `LuckUp_ctor` / `Status_ApplyLuckUp` have no relocation-free signature and port by witnesses
    (PR #82); the framework's logic is host-tested pure modules (PR #79).
  - *Native loading* — Mewjector built from audited source chainloads `mewframework.dll`, which fails closed.
  - *Art / SWF subsystem* — `_Append_<Target>` merges a mod clip into a live sprite at boot; `AbilityIcon` places a
    bare shape at depth 3; an unknown target stalls the boot; imports are never linked.
  - *CatTest and the cat animation clips* (PR #74) — `CatParts::prerender` 0x742350 fills every slot-named instance of
    whatever clip a `_CAT` unit plays, provided the slot is an EMPTY sprite; appended cat animations are data-only.
  - *SWF loader and display path* (PR #81) — the complete tag switch of `createTag` 0xa2e990 (what is FATAL, what is
    skipped), even-odd fills, cxform after the palette remap, pad-only gradients, the last-loaded-first registry.
  - *Glow and outline passes* (PR #80) — no filter renderer; the combat rim is a hover effect with a compile-time white
    colour; data has only `CharacterLightSource.glow` (ground disc) and `AdvancedTint`; hence baked halos.
  - *Per-unit glow (native)* — in PR (branch `feat/native-unit-glow`, stacked on #79): the mask + post-process route
    for an always-on per-unit rim.
  - *Dev scenes and run entry* — `enter TacticsTest` / `enter Campaign` replay the dev-menu and save-slot buttons
    inside the DLL.
  - *GON at runtime* — in PR (branch `feat/harness-hp-gon`): `Character+0x240` is the entry's GON node, `+0x4b0` the
    HP, the seven stats at `+0x5a0..+0x5b8`; `expect gon` reads them with no game call.
  - *Save safety* — `-savesuffix` reaches no save path; the harness's whole-dir hash is the real guard.
  - *Cat parts: entry path, palette, faces, mirroring* (this run) — `_CAT` is the `graphics.movieclip` default, both
    branches of 0xf1150 build the same `MaskedRendererIso`, the only difference is the clip name `CatTest`; one
    `paletted` material per doll inherited by the whole subtree; faces are game-made sprites positioned by
    `CatHeadPlacements`; the x-flip is a scale(−1) the engine writes on the root node.
  - *Localization and text fields* (this run) — every `data/text/*.csv` is loaded; `StringsDatabase::get` 0x9616d0
    returns the key itself on a miss; a DefineEditText whose initial text is a loc key is localized at creation
    (0x98d910) — the data-only route for mod text, OBSERVED in-game 2026-10-22 for a plain (non-HTML) text box.

### Space is strictly 2D
- Gameplay is a flat tile grid indexed by `iVec2D` (col,row). `Vec3D`/`height`/jump arcs exist only for **rendering**;
  `layer` = object-category channel, `flying` = a flag — **no real third gameplay axis**. Details: **[spatial-model.md](spatial-model.md)**.

### Data layer (the sanctioned path)
- The dev-built `-modpaths` loader overlays GON/CSV/text files; `X.gon.append/.merge/.patch` = GON
  Append / DeepMerge / PatchMerge; any binary can be **whole-file overridden**. Content is composed from ~1,750 named
  C++ behavior components. The editor's engine is pinned row by row against the decompiled merges (PR #75, #78:
  `.append` keeps duplicates, `.merge` is suffix-blind and merges arrays element-wise) and against the game's scalar
  typing (PR #83: `"5"` is a number, `""` is 0, only `true`/`false` are bools). Details + content shapes:
  **[data-mods.md](data-mods.md)** ("Fidelity to the decompiled merges", "GON typing fidelity", "Lighting and tint
  knobs", "Localized text for mods").
- **Sounds and music are data-moddable** (OBSERVED 2026-10-22, `mods/_audioprobe`): a file at the mirrored path
  (`mods/<m>/audio/combat_sfx/pickup_coin.wav`, `audio/music/<area>/*.ogg`) replaces the vanilla one (mod paths are
  searched first); new sounds are new groups merged into a loaded set (`audio/combat_sfx.gon.merge` →
  `SoundEffectGroups { MyGroup { files [x.wav] } }`, `.merge` never `.append`) referenced by name from data (`sounds {
  ontrigger MyGroup }`, `LoopingSoundWhileAlive`, `sfx`, …). WAV PCM16 / Ogg Vorbis, lower-case extension; music Ogg
  only, same rate/channels as the track it replaces. Backend FAudio + stb_vorbis. **[data-mods.md](data-mods.md)**
  "Sounds and music", engine facts in [engine-map.md](engine-map.md) "Audio".

### Native layer
- The Mewjector `version.dll` chainloader loads our `mewframework.dll`, which **gates on `-savesuffix` + the build id
  and fails closed** on any other build. Custom statuses = vtable clone + hooking name-keyed property lookups. Byte
  signatures/RVAs/offsets for this build live in `bindings/25143593.json` (generated into `signatures.h`/`offsets.h`);
  every entry is anchored, the port ladder has nine rungs (PR #82), and the framework's logic outside the game ABI is
  pure, host-tested C (PR #79: 149 host checks). Sample **Joker's Luck** status is verified in combat.
  Details: **[engine-map.md](engine-map.md)**, **[binding-port.md](binding-port.md)**.

### Art pipeline
- Primary art is **vector SWF** (uncompressed FWS, SWF v17, a small tag subset) via `glaiel::swf`; cats are a
  **part-indexed paper-doll**; recoloring is a **shared `palette.png` grayscale remap** (`paletted_full.shader`); 50 GLSL
  shaders. Authoring without Adobe is viable (JPEXS edits, or our emitter). Details:
  **[art-pipeline.md](art-pipeline.md)**, **[swf-tooling-options.md](swf-tooling-options.md)**.
- The editor authors it end to end: shapes (SVG import / export round trip), gradients, LineStyle2, blend modes,
  bitmaps, DefineSprite timelines (Timeline tab), the seven-slot cat rig (Rig tab), text in a game font class,
  **cat animations** as `_Append_CatTest` frames placing an empty-slot rig as the child `ani` (PR #76), and **baked
  glows / drop shadows** (PR #80). What the game does with all of it is OBSERVED in-game (`npm run test:artprobe`) and
  in the decompiled display path (PR #81: the validator reports what the loader would do — FATAL filters, fonts 1/2, a
  second DoABC, oversized bitmaps; skipped scaling grids, morph shapes, PlaceObject1 cxforms, imports).
- **Cat parts in a mod animation are data-only** (OBSERVED 2026-10-22, experiment A0, PR #74): the game draws the
  cat's own parts — palette, texture, face — into the empty slots of an appended frame. A native hook would only serve
  a non-`_CAT` character that should wear a cat's parts (engine-map "Cat parts: entry path, palette, faces,
  mirroring", hook seam S1, parked).

### Automation / testing levers
- Debug console (`-enable_debugconsole`, backtick): `load <n|path.lvl>` launches a specific fight; `bind <Ability>`.
  **AI-brain auto-resolve** of combat is achievable *data-only* (e.g. `Uncontrollable` passive / `ai{brain GenericBrain}`).
  The game itself has **no** RNG-seed command and **no** headless/startup-macro mode; both are supplied by the harness
  (`seed <N>` pins `TLS+0x178` through `Rng_SeedState` 0x94ee40 — PR #48; the window is hidden through the SDL3
  DYNAPI slots). Details: **[automation-feasibility.md](automation-feasibility.md)**.
- **The `mewtest` harness closes the headless/autoexec gap** (2026-10-18): the console dispatcher
  `DebugConsole::Execute` (`0xa14aa0`) is called in-process from a `FrameBegin` hook, output is read from the console's
  own vector, the window is hidden through the SDL3 DYNAPI slots (the sim keeps ticking), and a JSON-lines result +
  exit code become a verdict. `npm run test:ingame` / MCP `run_ingame_test`; interactive sessions via
  `start_ingame_session` / `ingame_exec`. Only the engine's 11 commands exist at the main menu; `enter TacticsTest`
  (84 commands, a real fight, `dump` / `expect unit` / `expect status`) and `enter Campaign [house]` (the real House on
  a disposable slot) are the harness's own run entries. Details: **[ingame-testing.md](ingame-testing.md)**.
- **How we work**: every change test-first, four tiers (T0 unit, T1 local data, T2 in-game, T3 human):
  **[tdd-procedure.md](tdd-procedure.md)** (incl. how to run the editor from a git worktree — PR #77).

### The toolkit we built (`editor/`)
- A data-layer mod editor: a GON engine + overlay/merge engine + 4-check validator as the single source of truth, a
  hand-rolled **MCP server** (`mewgenics-editor`: 23 tools on `main`, 24 with `export_svg` after PR #73's count fix,
  25 with `bake_glow` after PR #80, 26 with `vectorcraft_exec` after PR #89 — data, art, in-game testing, bindings, the VectorCraft agent channel), and a React + TypeScript **web UI** built
  by Vite (Data + Art modes, IDE-style, with onboarding; zod at the `/api` boundary — `editor-ts-react-plan.md`).
  **Art mode** has a hand-written SWF emitter, SVG import/export, a WebGL in-game-faithful preview and a Ruffle
  reference tab. Validated: ~630 unit + 44 Playwright e2e tests, typecheck clean, T0 in CI. Overview:
  **[../README.md](../README.md)**; art design/plan: **[art-preview-plan.md](art-preview-plan.md)**.

### The SWF-emitter crash — closed
- Our hand-emitted SWF parses cleanly and the `_Append_AbilityIcon` merge into the live `AbilityIcon` sprite
  (`process_animation_merges` 0x9bc070) survives boot with every donor layout (`npm run test:swfgate -- <variant>`).
  The donor mirrors the vanilla frame (a bare shape at depth 3, `ABILITY_ICON_DEPTH`); the owner saw the icon inside a
  run on 2026-10-19 (T3 ticked). An unknown `_Append_` target is logged and then **stalls the boot** before the
  console. Spec + gate table: **[swf-emitter-fix-spec.md](swf-emitter-fix-spec.md)** §0.

---

## What we don't know yet / open

- [x] **Localized mod text — OBSERVED 2026-10-22** (`render-loctext.mewtest`): a `DefineEditText` whose initial text
  is exactly a key (vanilla's or one a mod adds via `combined.csv.append`) is shown localized **only when emitted
  without the HTML flag** (`scene.texts[].html: false`); in vanilla's `<p><font>` wrapper the key is drawn as
  written. Left: the editor does not yet switch key texts to plain by itself (`data-mods.md` "Localized text for mods").
- [x] **`tilesets.gon` clip redirect — OBSERVED 2026-10-22** (`mods/_tileprobe`): `alley { Rat ArtProbe }` in a
  `tilesets.gon.merge` makes a plain Rat draw the mod clip in the alley tileset; the control run without the overlay
  draws the vanilla Rat (`data-mods.md` "Redirecting a vanilla character's clip via tilesets.gon").
- **GON pre-pass not located:** the tokenizer handles only `#` comments, yet vanilla relies on `//`, `/* */` and
  `#include "standard_nodes.gon"` (the 20 `maps/*.gon`); an earlier pass must strip / inline them (candidate 0xa50bd0).
  The editor neither inlines nor validates includes (PR #83).
- **Font-class → font lookup RVA:** PR #81 lists it as unknown (candidates 0x9bb910 / 0x98d910); session `loc`
  OBSERVED it as `Swf_FindCharacterByClassName` 0x9bb910, called from the text-box init 0x98d910 (engine-map
  "Localization and text fields"). Treat #81's line as superseded.
- **LineStyle2 joins / miter / hairline:** parsed by `LineStyle_read` 0xb6f220, not traced through the outline builder
  (caps are OBSERVED honoured). Also open in the preview: blend modes other than normal / layer / multiply / add /
  overlay / erase, and the `per_file_curve_resolution` tolerance.
- **Max-HP getter:** `Character+0x4b0` is the current HP and `+0x5e8 + 4·constitution` the base formula (the `1hp`
  lambda and `Character::init` witness them), but no stored max-HP field or getter was found; the harness reads
  current HP right after spawn instead (branch `feat/harness-hp-gon`).
- **`.merge` / `.patch` child lookup with `nth == 0`:** the helpers 0x942910 / 0x942b50 defer to the undecompiled name
  index for the first occurrence; the n-th-occurrence reading is INFERRED from the counter (PR #78). A probe with
  duplicate keys would confirm.
- **VectorCraft's agent channel:** approved in principle by the owner (2026-10-21, at least for testing) so agents can
  draw parts headlessly; **install decision pending** — nothing is installed without the owner's say-so.
- **VectorCraft (WASM) vendored** — owner decision 2026-10-22 (YES to a build-time download, nothing installed):
  `editor/scripts/vendor-vectorcraft.ts` downloads the one pinned release asset `vectorcraft-web-0.14.0.zip`
  (27,734,185 bytes, SHA-256 `6f28a8bc…ba075e`, MIT OR Apache-2.0, from GitHub Releases) at `npm run build` / `dev`,
  verifies size + hash BEFORE extracting, unpacks it with its own zip reader (central directory, `inflateRawSync`,
  CRC-32, path-escape refusal) into the git-ignored `editor/web/public/vectorcraft/` (35 files, 75.4 MB on disk:
  a 73.7 MB `.wasm`, the 176 KB wasm-bindgen glue, `index.html`, three Noto `.ttf` + every licence text) and writes
  `VENDORED.json` (per-file SHA-256; `npm run vendor:vectorcraft:check`). The zip is cached in `editor/data/vendor/`;
  offline the script prints `(skipped: …)` and the build goes on. Served from the editor's own origin (`.wasm` as
  `application/wasm`, `.ttf` as `font/ttf`), embedded as a same-origin `<iframe>` per upstream `HOSTING.md`.
  **Agent channel (2026-10-22):** MCP `vectorcraft_exec` serves that folder from a throwaway loopback server, boots it
  in Playwright's headless Chromium (the devDependency; SwiftShader WebGL2, ~0.5–4 s to `window.vectorcraft`) and
  drives the same promise API the Art tab uses (`execute` over ~1,090 engine commands, `app.export` → SVG, Playwright's
  `page.screenshot` for the PNG — the web build's own `ui.screenshot` answers only `{ width, height }`). Observed
  re-origin: our `viewBox="x y w h"` becomes the artboard at 0,0, coordinates shift by (−x, −y), exports are always
  `viewBox="0 0 w h"`; `svg-reorigin.ts` undoes it. `vectorcraft-cli mcp --headless` (the native route) would need an
  install and was not asked for.
- **T3 looks** (owner, later): the art-probe shots in `editor/data/ingame-runs/` — gradient, LineStyle2 caps, blend
  square, Timeline / Rig tabs, PROBE lettering, the SVG round trip, the Ruffle tab, the baked glow, the appended cat
  frame with the real cat in it.
- **Per-build fragility** (a procedure, not a dead end): everything native is pinned to build `25143593` through
  `bindings/25143593.json`; a game update disables the framework (fails closed) until the manifest is ported —
  `docs/binding-port.md` / the `port-bindings` skill. The cross-build run onto the older build 23372843 was clean, but
  it was a relink around unchanged bodies; a body-changing build is still wanted to exercise the new rungs (PR #82).
- Whether an **official Workshop/launcher** ships (the dev intends to; not yet).

---

## How to operate

### Daily modding (no reverse engineering needed)
- `launch-dev.bat` — runs the game with `-savesuffix dev`, debug console, dev mode, and the sample mod paths.
- `editor/`: `npm install` → `npm run build:index`, then `npm run web` (UI) / `npm run mcp` (agent server) /
  `npm test` / `npm run test:e2e` / `npm run test:ingame` (real game, T2). Native host tests: `native\test-all.bat`.
- `python -I tools/gpak.py list|cat|extract|stats` — read-only pack access.
- Author/validate mods in the editor (or via the `mewgenics-editor` MCP tools); overlays live in `mods/<name>/`.
  Art, cat animations and glows the same way (`new_art_scene`, `bake_glow`, `build_swf`, `inspect_swf`).
- In a secondary git worktree, point at the main checkout's inputs with `MEWGENICS_EXTRACTED_DATA` /
  `MEWGENICS_EDITOR_DATA` / `MEWGENICS_ANALYSIS_DIR` (the vanilla SWFs and textures follow the first;
  `MEWGENICS_VANILLA_SWF_DIR` is only an override) and one `node_modules` junction (`tdd-procedure.md`); never
  junction `.analysis` or `.extracted`.

### Hard safety rules (never violate)
- **Never** modify or write `Mewgenics.exe`, `resources.gpak`, or any save file. The real 83%-complete save is
  guarded by the harness's whole-saves-dir hash (not by `-savesuffix`, which renames nothing on this build); back up
  `%APPDATA%\Glaiel Games\Mewgenics\<steamid>` before new mod builds.
- Editor/MCP writes are confined to `mods/<name>/`. Never commit extracted assets or game bytes beyond short signatures
  (`.extracted/`, `.analysis/`, `editor/node_modules/`, `editor/data/`, binaries are git-ignored).

### Reverse engineering (only for maintenance — see [README](../README.md#reverse-engineering-optional--maintenance-only))
- REA + Ghidra via `tools/rea-mcp.mjs` (Docker image `rea-ghidra:12.1.4`). **Gotcha that cost us two agent runs:** a
  full import of the 22 MB exe takes ~17 min but REA's default call deadline is **330000 ms** — you **must** set
  `REA_GHIDRA_STARTUP_TIMEOUT_MS` ≥ **1800000** in the container env and use `watch` mode (one import, reused).
- One container (`rea_ghidra_<tag>`) and one queue dir (`.analysis/queue-<tag>`) per agent; stop only your own by
  name. Up to seven sessions ran at once on 2026-10-21/22 on a Docker VM capped at 30 GB; the limit is a single
  oversized decompile (`TacticsTest::init`, 345 KB), not concurrency. `list_names` / `list_procedures` exceed the MCP
  budget — use the evidence-bundle export in `engine-map.md` "REA / Ghidra sessions". Check
  `.analysis/decompiled/` and `.analysis/notes-<tag>.md` before decompiling anything.
- Much is answerable **without** Ghidra: parse the PE export table + `.analysis/list_names.tsv` /
  `list_procedures.tsv` to resolve addresses (that's how the SWF crash was solved). On a game update run the
  `port-bindings` skill (`docs/binding-port.md`): `check_game_build` → `port_bindings` → `npm run bindings:gen` →
  rebuild → `npm test` → `npm run test:ingame`; REA/Ghidra only for entries the ladder reports as ambiguous.

### Flagged source — do not fetch
- **`tcrf.net/Mewgenics`** served prompt-injection content and a false "gpak is encrypted" claim. Do not fetch or act
  on it (also in `CLAUDE.md`). The gpak is not encrypted.

---

## Document index

| Doc | What it covers |
|---|---|
| [engine-map.md](engine-map.md) | Build identity, engine subsystems, RVAs, data model, native status pipeline, SWF loader / display / cat parts / glows / localization, dev scenes, save safety |
| [data-mods.md](data-mods.md) | `-modpaths` + GON overlay semantics (fidelity tables, typing), content shapes, lighting/tint knobs, localized text, data↔native pairing |
| [spatial-model.md](spatial-model.md) | 2D-vs-3D verdict and the coordinate/grid/rendering evidence |
| [art-pipeline.md](art-pipeline.md) | How images / SWF / rigs / palettes / shaders work and what's moddable |
| [swf-tooling-options.md](swf-tooling-options.md) | The minimal SWF subset the engine needs; no-Adobe authoring strategies |
| [swf-emitter-fix-spec.md](swf-emitter-fix-spec.md) | Why the emitted SWF crashed; the exact emitter fixes (closed) |
| [art-preview-plan.md](art-preview-plan.md) | Art-mode architecture, source model, preview render path, onboarding, perf, what the game does with our art |
| [automation-feasibility.md](automation-feasibility.md) | Launching fights, AI auto-resolve, seeding, headless; tiered testing plan |
| [ingame-testing.md](ingame-testing.md) | The `mewtest` harness: script grammar, JSONL events, exit codes, verdicts, verified facts |
| [binding-port.md](binding-port.md) | The bindings manifest, anchors, the port ladder, how a game update is ported |
| [tdd-procedure.md](tdd-procedure.md) | The TDD rule in practice: tiers T0–T3, the red/green loop, PR evidence, worktrees |
| [../README.md](../README.md) | Project overview + quickstart |
| [../TODO.md](../TODO.md) | Living status checklist; the 2026-10-21/22 PR map at the top |
| [../CLAUDE.md](../CLAUDE.md) | Guidance for AI agents + safety rules + flagged sources |
