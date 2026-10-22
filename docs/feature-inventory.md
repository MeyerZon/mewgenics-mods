# Feature inventory — what this toolkit can do today

Snapshot of `main` at b2e13b7 (2026-10-22), game build 1.1.21239 / Steam build `25143593`. Every item below was
checked against the code on `main` (the source file named on its line). The deep docs are cited instead of being
repeated here. Work that is still in open PRs is listed in §11 only.

Tags in §1: **OBSERVED** = proven in the real game (a T2 `.mewtest` run, real save unchanged), with the doc section
that records the run · **DOC** = decompiled or documented, not yet run in the game.

Line format: **name** — what it does — where it lives / how to invoke.

---

## 1. Data modding (what a data mod can do in the game)

A data mod is a folder `mods/<name>/` that mirrors the pack layout. The game loads it with `-modpaths`
(`launch-dev.bat`, or the harness). No code is injected.

### Overlays and GON text

- **`X.gon.append`** — appends entries (arrays are concatenated; a duplicate name is kept twice, and a by-name lookup finds the last copy) — OBSERVED: `_golden-merge` `GoldenRat` (data-mods.md "Test-only overlays").
- **`X.gon.merge`** — deep merge: objects by name (the nth to the nth), arrays element by element, scalars overwritten; key suffixes are literal — OBSERVED: `_golden-merge` Rat name + faction (data-mods.md "Fidelity to the decompiled merges").
- **`X.gon.patch`** — per-field policy suffixes `.overwrite` / `.append` / `.merge` / `.add` / `.multiply` — OBSERVED: `.overwrite`, `.add`, `.multiply` via `expect gon` (`_golden-merge/numeric`; data-mods.md "Test-only overlays").
- **Whole-file replace (`X.gon`, no suffix)** — replaces a base file (the validator warns `whole-file-replace`) — DOC (data-mods.md "Overlay file kinds").
- **CSV `.append` / positional `.merge`** — adds rows; `.merge` changes columns by row position (fragile) — OBSERVED: `combined.csv.append` names (`_golden-merge`).
- **Comments `#`, `//`, `/* */`** — stripped by the game's pre-pass in base files and in every overlay — OBSERVED (data-mods.md "Comments and `#include`").
- **`#include "file.gon"`** — a mod can ship the included file and include it from an overlay — OBSERVED: `_incprobe` `IncProbe` (same section).
- **`#define NAME(args) … #end` / `#NAME a b`** — macros, expanded per file — OBSERVED: a two-argument macro, `_incprobe` `IncProbeMacro` (same section).
- **GON scalar typing** (`"5"` = 5, hex, `""` = 0, `true`/`false`/`null`) — the editor types scalars the way the game does — DOC from decompiles, pinned by `gon-tests.ts` (data-mods.md "GON typing fidelity").

### Content kinds

- **Abilities** (`data/abilities/*.gon`, `variant_of`) — OBSERVED: `SpinDev` (dev-sandbox), `JokersGambit` (jokers-luck) (data-mods.md "Content shapes seen in the pack").
- **Passives / component blocks** (`passives { <Component> { … } }`) — OBSERVED through many probes (`StatusOnSpawnIn`, `EliteParticle`, `LoopingSoundWhileAlive`, `Uncontrollable`); the keys each component reads are in §5 "Component key schema".
- **Items** (`data/items/*.gon`) — DOC (scaffolded by `new_from_template item`; no T2 run).
- **Statuses** (data side: `keyword_tooltips.gon.append` + text) — OBSERVED together with native JokersLuck and `FwGlow_` (data-mods.md "Pairing data with a native status").
- **Characters / enemies** (`data/characters/*.gon`, `variant_of`) — OBSERVED: `GoldenRat`, `IncProbe`, `RoomProbeRat`, `FwGlowRat`, `AudioProbeRat`.
- **Classes, difficulties** (`data/classes/classes.gon`, `data/difficulties.gon`) — DOC (dev-sandbox `difficulties.gon.merge`; no expect).
- **Lighting and tint knobs** (`CharacterLightSource`, `AdvancedTint`, `TintItem`, `graphics.tint`) — DOC (data-mods.md "Lighting and tint knobs").
- **Combat speed knobs** (`bypass_combatspeed`, `movieclip_timescale`) — DOC (data-mods.md "Combat speed knobs").

### Localization

- **New keys in `data/text/combined.csv.append`** (12 columns) — OBSERVED: `_golden-merge` unit names (data-mods.md "Test-only overlays").
- **Loc-key texts inside a mod SWF** — a `DefineEditText` whose initial text is exactly a key is localized, but only when it is plain (`html: false`) — OBSERVED: `render-loctext` (data-mods.md "Localized text for mods").

### SWF art (built by the editor, loaded through `swfs/swflist.gon.append`)

- **Vector shapes** (gray:N palette fills, solid colours) — OBSERVED: `_artprobe` `render-probe` (art-preview-plan.md; art-pipeline.md §3).
- **Gradients** (linear / radial, `DefineShape3/4`) — OBSERVED in the art probe (art-preview-plan.md "what the game does with our art").
- **Strokes** — OBSERVED in the art probe (same).
- **Sprites / timelines** (keyed layers, tweens, frame labels, masks) — OBSERVED: probe clips, cat wave (engine-map.md "CatTest and the cat animation clips").
- **Raster bitmaps** (PNG → `DefineBitsLossless2`; smoothing, repeat, mipmaps, 4096 atlas limit) — OBSERVED: `render-raster` (art-pipeline.md "Raster art inside SWFs").
- **A whole PNG as a character clip** — OBSERVED: `ArtProbeRaster` (same).
- **Mod combat backgrounds** (`tilesets.gon.merge` `combat_background <clip>`) — OBSERVED: `_bgprobe` (same).
- **Mod fonts** (`DefineFont3`, exported by name) — OBSERVED: `ProbeBlocks`; a missing glyph falls back to another font; an unknown font class crashes the game, so the validator refuses it (art-pipeline.md "Fonts").
- **Texts in game fonts** (`DefineEditText`) — OBSERVED (art-pipeline.md §3 "Text").
- **Baked glow / drop shadow** (a halo shape; SWF filters crash the game) — OBSERVED: `--glow-arena` (art-pipeline.md §6).
- **`_Append_<Target>` donor clips** — append frames to a vanilla clip — OBSERVED: `_Append_AbilityIcon` (swf-gate), `_Append_CatTest` (art-pipeline.md §4).
- **Cat animations `<name>F` / `<name>B`** with the cat's own parts (empty slot sprites) — OBSERVED: experiment A0 (`--cat-append`) and an animated pose (`--cat-wave`) (engine-map.md "CatTest and the cat animation clips").
- **Back-facing cat rig** (`<name>PoseBack` with `head_back`, the back slot order) — OBSERVED: `--cat-back`, also on a unit turned with `face` (engine-map.md "The back facing and the four-way quartet").
- **Four-way quartet `LF/RF/LB/RB`** — DOC only: authored by the editor and checked by the validator, never run in the game (same section).
- **Several mods appending to one clip** — the appends coexist; a shared label goes to the later `-modpaths` mod; the same `swfs/<name>.swf` from two mods = only the later one loads — OBSERVED: `--multi-append` (data-mods.md "Several mods appending to one clip").
- **Tileset clip redirect** (`tilesets.gon.merge` `alley { Rat MyClip }` reskins a non-cat character) — OBSERVED: `_tileprobe` (data-mods.md "Redirecting a vanilla character's clip via tilesets.gon").
- **Whole cat clip for one entry** (`_CatRig_<Entry>` export; needs mewframework) — OBSERVED: `--rig` (data-mods.md "A whole cat rig for one character").
- **Replace a vanilla PNG / shader / SWF** at its mirrored path — DOC (art-pipeline.md §2, §3, §6).
- **Mod-shipped shaders** (`shaders/<name>.shader`, loaded by native code by name) — OBSERVED: `fw_unit_glow.shader`, `fw_mesh.shader` (data-mods.md "Mod-shipped shaders").

### Particles and VFX

- **Re-point a vanilla particle system's `movieclip`** (`particles.gon.merge`) — OBSERVED: `SparkleBuff` → mod clip (data-mods.md "Particles and VFX").
- **New particle system** (`particles.gon.append`) worn via `passives { EliteParticle <system> }` — OBSERVED: `VfxProbeAura` (same).
- **Ability hit effect with a mod clip** (`graphics.particle <clip>`) — DOC (INFERRED: same registry).

### Sounds and music

- **Replace a vanilla sound** (mirrored `audio/<set>/<file>.wav`) — OBSERVED: `pickup_coin.wav` (data-mods.md "Sounds and music").
- **Add a sound group** (`audio/combat_sfx.gon.merge` `SoundEffectGroups`) used from data (`play_sound`, `LoopingSoundWhileAlive`, …) — OBSERVED: `AudioProbe_New` (same).
- **Replace music / ambience; new music track (`music_info.gon.append`); new cat voice set** — DOC (same).

### Maps, rooms, spawns, tilesets

- **New room** (`levels/<path>.lvl`, played with `load`) — OBSERVED: `_roomprobe/new-room` (data-mods.md "Maps, rooms and encounters").
- **A mod-only room found through the recursive `levels/` listing** — OBSERVED: `find-room`.
- **New spawn id** (`data/spawns.gon.append`) — OBSERVED: id 9001.
- **New tileset name** (`data/tilesets.gon.append`) — OBSERVED: `roomprobe_yard`.
- **A campaign battle draws a mod room from a map's level pool** (`alley.gon.merge` `levels { easy [...] }`) — OBSERVED: `walk-battle`.
- **New map file reached from an exit's `next_map`** — DOC (decompiled).
- **New tile id** — data only; it must name an existing C++ tile class — DOC.
- **Not extendable:** node `type` (19 names hard-coded), new `chapter_id`, the run's first map — DOC (same section).

### Unit glow from data

- **`FwGlow_<rrggbb[aa]>` status** — a coloured rim for as long as the unit carries the status; needs `mods/fw-glow` + mewframework — OBSERVED: `fw-glow/data-glow` (data-mods.md "Asking for a unit glow from data").
- **Timed glow** (granted as a `Temporary`) — OBSERVED: `data-glow-expiry` (same).

### 3D models from data (preview; see §3)

- **`graphics.model "models/x.obj|.gltf|.glb"`** and the `model { … }` block — OBSERVED: `_unitmodel`, vanilla `Crate` via `fw-3d` (data-mods.md "3D models in a mod (preview)").

### Mod manifests and packaging

- **`mods/<name>/mod.json`** (name, version, author, description, gameBuild, native, frameworkApi, license, attribution) — `editor/src/core/mod-manifest.ts`; the game ignores it (T2 smoke tests pass with it) (data-mods.md "Shipping a mod").
- **Pack** — rebuilds the SWFs, validates, copies the DLLs, writes a deterministic zip with `README-INSTALL.txt` + `MANIFEST.sha256` — `npm run pack -- <mod>`, MCP `pack_mod`, web *Export…* (`editor/src/core/pack.ts`, `zip.ts`).
- **Install** — size, path, layout and CRC checks before any write; never overwrites; prompts on a build mismatch — `npm run pack -- --install <zip>`, MCP `install_mod`, web *Import mod…*.
- **Mods with a manifest:** `dev-sandbox`, `fw-glow`, `jokers-luck`, `swf-gate` (plus `catrig-sample`, `fw-3d` with `description.json`). The `_`-prefixed mods are test-only and never packed.

### Repo mods (22)

- **Content / samples:** `dev-sandbox`, `jokers-luck`, `fw-glow`, `fw-3d`, `catrig-sample`, `swf-gate`.
- **Test-only probes:** `_artprobe`, `_audioprobe`, `_autoplay`, `_bgprobe`, `_catappendA`, `_catappendB`, `_catappendSame`, `_effective-stats`, `_golden-merge`, `_incprobe`, `_jokersluck-merge`, `_jokersluck-test`, `_roomprobe`, `_tileprobe`, `_unitmodel`, `_vfxprobe` (each `description.json` says what it proves).

---

## 2. Native framework (`mewframework.dll`)

Version 0.6.0, `FW_API_VERSION 8` (`native/framework/src/framework_api.h`). Mods resolve the table with
`FW_Resolve(&api)`. Fields are append-only, so a mod built against an older version keeps working.

### Exported API (19 functions)

- **`FW_GetVersion`** (v1) — the API version.
- **`FW_IsActive`** (v1) — 1 only on a `-savesuffix` launch, a known build and every signature found.
- **`FW_GetSymbol(FwSymbol)`** (v1) — the absolute address of a signed function (52 `FwSymbol` values).
- **`FW_GetBuildName`** (v1) — e.g. `1.1.21239 (steam 25143593)`.
- **`FW_RegisterStatus(FwStatusDef*)`** (v2) — a new named status cloned from a template status's vtable, with turn begin/end callbacks.
- **`FW_SetStatusStacks(status, n)`** (v2) — sets a custom status instance's stacks; 0 removes it.
- **`FW_CharacterHasStatus(character, name)`** (v2) — checks whether a unit carries a status.
- **`FW_GetData(FwData)`** (v3) — the address of a global or SDL DYNAPI slot (19 `FwData` values).
- **`FW_SetUnitGlow(character, r, g, b, a)`** (v4) — a coloured rim around a unit (combat; up to 16 units, several colours).
- **`FW_ClearUnitGlow(character)`** (v4) — removes the rim.
- **`FW_Random(bound)`** (v5) — uniform `[0, bound)` from the framework's splitmix64 stream; use it instead of CRT `rand`.
- **`FW_SeedRandom(seed)`** (v5) — restarts the stream (the harness `seed` directive calls it).
- **`FW_SetTimeScale(factor)`** (v6) — multiplies the game's time scale, clamped to [1/16, 64]; returns the kept factor.
- **`FW_GetTimeScale`** (v6) — the current factor (1.0 = off).
- **`FW_RegisterCatRig({character, rig_clip})`** (v7) — one cat entry is drawn by its own rig clip.
- **`FW_CatRigFor(character)`** (v7) — reads back a registered rig.
- **`FW_Register3DObject(character, model, transform)`** (v8) — attaches a model to a unit; the model follows the unit.
- **`FW_Place3DObjectOnTile(col, row, model, transform)`** (v8) — places a model on a tile centre.
- **`FW_Unregister3DObject(character_or_null, handle)`** (v8) — removes a unit's object or a handle (up to 64 objects per fight).

### Engines (`native/framework/src/`)

- **Status engine** — `status_engine.c` + `fw_status_rules.c`, `fw_vtable.c`, `fw_walk.c`: vtable clone + thunks; hooks all 13 name-keyed lookups; merges a second application through the unit's entity.
- **Glow engine** — `glow_engine.c` + `fw_glow_rules.c`: rides the combat outline mask with `fw_unit_glow.shader`; per-unit colours by scissor rect (glow v2); `FwGlow_` status names, no DLL needed (glow v3).
- **Cat rig engine** — `catrig_engine.c` + `fw_catrig_rules.c`: registers `_CatRig_<Entry>` exports at SWF load and answers `CatTest` lookups during that entry's `Character::init`; champion/elite suffixes are stripped.
- **Speed engine** — `speed_engine.c` + `fw_speed_rules.c`: the time-scale multiplier at `App+0xdc0`.
- **RNG** — `fw_rng.c`: splitmix64 + an unbiased bounded draw, seeded from QPC.
- **3D observer** — `obs3d_engine.c` + `fw_obs3d_rules.c`: log-only, active with `MEWFW_OBSERVE3D=N`.
- **Mesh engine** — `mesh_engine.c` + `fw_mesh_rules.c` (OBJ, paths, `FW_MESH_CODES`), `fw_mesh_gltf.c` + `fw_json.c` (glTF 2.0 / GLB), `fw_mesh_draw.c`, `fw_mesh_tex.c` (PNG + palette), `fw_mesh_order.c` (painter-order interleave), `fw_m4.c`, `fw_functor.c` (MSVC `std::function` in C), `fw_gl_state.c`.
- **3D object registry** — `obj3d_engine.c` + `fw_obj3d_rules.c`; GON model reader `fw_gon.c` + `fw_unit_model.c`.
- **Build gate / fail-closed** — `fw_build.c`: checks the PE TimeDateStamp `0x6a9c51e5` and SizeOfImage; on any other build it logs `unknown build: …; framework disabled` and installs no hooks. A launch without `-savesuffix` is inactive too (`framework.c`).
- **Signature scanner + symbol resolution** — `fw_sig.c`, `fw_resolve.c`; tables generated into `signatures.h` / `offsets.h`.

### Bindings manifest (`bindings/25143593.json`, format 1, `sigCap` 128)

- **299 entries:** 125 functions (52 exposed as `FwSymbol`, 13 in the `FW_LK` name-lookup table with 2 overlapping, 62 signed reference-only), 21 data (19 `FwData` + 2 others), 4 vtables, 22 constants, 127 struct offsets.
- Generated headers: `npm run bindings:gen` / `bindings:check` (a golden test fails while they are stale).
- Porting to a new build: §8 "Bindings tools" and the `port-bindings` skill (`docs/binding-port.md`).

### Sample native mods (`native/mods/`)

- **`jokers-luck`** — registers the `JokersLuck` status (rerolls luck −10..+10 each turn through `FW_Random`); pure roll rule `jl_roll.c`, host-tested; data half `mods/jokers-luck`.
- **`catrig-sample`** — `FW_RegisterCatRig({"RigSampleCat", "RigSampleCatClip"})` from `DllMain`; pure bind loop `catrig_sample_rules.c`; data half `mods/catrig-sample`.
- **`test-harness`** — `mewtest.dll`, the T2 harness (§4).
- Loader: Mewjector `version.dll` + `native/chainloader.ini` (`tools/install-mewjector.bat`); DLLs go in `native/dist/`.

---

## 3. 3D (phase M, preview)

On `main` (OBSERVED in fights 2026-10-22; data-mods.md "3D models in a mod (preview)", possible_3d_work.md phase M):

- **Draw path** — a draw functor submitted after the world camera's units layer (`Batch_SubmitFunctor`); GL state is restored by `glGet`.
- **Formats** — OBJ (`v/vt/vn/f`, `vt` flipped) and glTF 2.0 `.gltf` (embedded or data-URI buffers) / `.glb`; node transforms baked; primitives merged; z mirrored into the game's left-handed axes.
- **Shading** — `mods/fw-3d/shaders/fw_mesh.shader` (Lambert + base colour); an inline flat shader when `fw-3d` is not loaded.
- **Textures** — `textures/models/<name>.png` (or the block's `texture`), 8-bit RGB/RGBA, ≤ 2048 px; alpha < 0.5 is a cut-out.
- **Palette rule** — exact-grey texels map to a `palette.png` row, like cat art (row set by the probe / inside the framework).
- **Per-unit GON models** — `graphics.model` string or block `{ file scale yaw offset texture tint palette double_sided }`; the model follows the unit's interpolated position and mirrors with its sprite.
- **API objects** — `FW_Place3DObjectOnTile` / `FW_Register3DObject` (§2).
- **Occlusion** — painter-order interleave in the units layer, using the world camera's per-item filter at `Camera+0x120`; no depth test. Measured: behind 0.748, in front 1.009.
- **Error codes** — one table shared by the DLL and the editor (`fw_mesh_rules.c` `FW_MESH_CODES` = `editor/src/core/model-codes.ts`): 42 `model-*` codes; a refused model logs one line and the unit draws its 2D clip.
- **Probes** — `MEWFW_MESH_PROBE=1|c,r` (magenta cube), `_MODEL`, `_TEXTURE`, `_PALETTE`; `mods/dev-sandbox/tests/mesh-probe|mesh-occlusion|mesh-model-codes.mewtest`; `npm run test:artprobe -- --mesh`.
- **Sample assets** — `mods/fw-3d`: `models/crate.obj`, `models/pillar.glb`, crate texture (`node scripts/make-fw3d-assets.ts`).
- **Blender export recipe** — data-mods.md "3D models: exporting from Blender"; importer design: `docs/3d-importer-design.md`.

Not yet on `main`:

- **In open PR #138:** `hide_sprite`, cat palette rows, `@Name` models (`data/models.gon`), `.glb` embedded textures, facing yaw, multi-tile slices, same-tile ties.
- **Later:** animation/skins, `render3d` modes, an exported material call.
- **Phase P (true perspective):** P1 VP hook, P2 billboards + floor, P3 cull + sort, P4 picking, P5 screen-space shaders, P6 camera control (possible_3d_work.md "Phase P").

---

## 4. In-game test harness (T2)

`mewtest.dll` runs a `.mewtest` script inside the game; the Node runner launches the game, reads the results and
decides the verdict. Contracts: `docs/ingame-testing.md`. The parser is `editor/src/core/ingame/script.ts`; the DLL
side is `native/mods/test-harness/src/mt_script.c`. There are 65 scripts under `mods/*/tests/`.

### Header keys

- **`mods`, `savesuffix`** (default `dev`), **`timeout`** (`ms|s|m`), **`hide`**, **`clean`**, **`interactive`**.

### Directives (13 words)

- **`cmd <console line>`** — runs a debug-console command through the game's own dispatcher (≤ 4078 bytes).
- **`wait frames|turns|rounds|ms N`** — waits.
- **`enter TacticsTest | Campaign | Campaign house`** — replays the dev menu's scene entry; Campaign uses the disposable slot `mewtest01.sav`.
- **`seed N`** — pins the game RNG (TLS+0x178) and `FW_SeedRandom`.
- **`speed <factor>|off`** — `FW_SetTimeScale`.
- **`glow <unit> r g b a | off`** — `FW_SetUnitGlow` / `FW_ClearUnitGlow`.
- **`face <unit> dx dy | front | back`** — `Character::Face`.
- **`run start [<map>.gon] | travel <node type> | fight`** — the campaign walk (19 node types).
- **`shot "<label>"`** — a screenshot (in-process GL capture).
- **`dump`** — emits the units event.
- **`log "<text>"`** — writes a log line.
- **`quit [code]`** — ends the run.
- **`expect …`** — 12 kinds:
  - `console` / `noconsole "<substr>" [within N]`;
  - `status <S> on <unit>`;
  - `units <op> N`, `round <op> N`;
  - `stacks <S> on <unit> (<op> N | varied)`;
  - `unit <unit> <field> <op> <value>` — 31 fields: name, class, namekey, faction, move, act, turnkind, hp, shield, divineshield, the 7 stats, facing/dirx/diry/flip/sign, and 8 `.effective` values;
  - `gon <unit> <path> (<op> value | exists | missing)`;
  - `level "<substr>"`;
  - runner-side: `log "<substr>"` (debug.log), `deltas "<prefix>" d1 d2 …`, `fwlog "<substr>"` (mewframework.log).

### Events, exit codes, verdicts

- **Events (JSONL):** `start`, `script_error`, `cmd`, `enter`, `console`, `turn`, `wait`, `expect`, `units` (incl. `effective` and facing fields), `log`, `shot`, `seed`, `run`, `glow`, `face`, `speed`, `idle`, `exec`, `popup`, `crash`, `end` (ingame-testing.md "Result file").
- **Harness exit codes:** 0 pass, 1 expect failed, 2 timeout, 3 crash, 4 harness error, N from `quit N`.
- **Runner verdicts (first match wins):** `skipped`, `cannot-run`, `launch-error`, `unknown-build`, `backstop-timeout`, `safety-violation`, `crash`, `harness-error`, `timeout`, `fail`, `no-result`, `log-errors`, `pass`.

### Runners

- **`npm run test:ingame [-- <mod> [<test>]]`** — every script, one game at a time (`--json --timeout --no-hide --clean --no-savecheck`) (`scripts/ingame.ts`).
- **`npm run test:artprobe`** — art probes with shot measurement. Modes: default, `--cat`, `--cat-append`, `--cat-wave`, `--cat-back`, `--rig`, `--loctext`, `--tileset`, `--glow-arena`, `--raster`, `--vfx`, `--multi-append`, `--mesh [--tile c,r]`; `--from <runDir>` re-measures an earlier run (`scripts/art-probe.ts`).
- **`npm run test:unitglow [-- --data | --data-expiry]`** — glow rim proofs (`scripts/unit-glow-probe.ts`).
- **`npm run test:catrigsample`** — the cat rig sample's five scripts (`scripts/catrig-sample-probe.ts`).
- **`npm run test:swfgate`** — the SWF append gate (`scripts/swf-gate.ts`).
- **`npm run t3`** — the T3 looks gallery: one HTML page of yes/no cards over the shots listed in `editor/t3-looks.json` (`scripts/t3-gallery.ts`).
- **Interactive sessions** — `interactive: true` serves a named pipe (`exec`, `dump`, `quit`); MCP `start_ingame_session` / `ingame_exec` / `stop_ingame_session` (`editor/src/core/ingame/session.ts`, `pipe.ts`).

### Save protection and capture

- **Save protection** — hashes the whole saves dir before and after a run (`savecheck.ts`); refuses any path under `saves/`; a `debug.log` suffix mismatch = `safety-violation`; one machine-wide run lock; `resetCampaignSlot` renames only `mewtest01.sav` aside, never deletes (`-savesuffix` itself is no isolation: engine-map.md "Save safety").
- **In-process GL capture** — `mewtest.dll` swaps the `SDL_GL_SwapWindow` slot and reads the back buffer, so hidden runs get real shots; falls back to `PrintWindow` / screen; the stale-shot check marks a run whose shots are byte-identical (ingame-testing.md "Shots").
- **Crash and popup handling** — a vectored exception handler logs the crash RVA; a watchdog closes modal popups and enforces grace periods (`mt_exit.c`).

---

## 5. Editor core and validator (`editor/src/core/`)

`api.ts` is the single app surface; the MCP server and the web UI only adapt it.

### GON engine and overlays

- **GON engine** — tokenizer → parser → AST with comments and positions → byte-faithful serializer, with the game's scalar typing — `gon/` (round-trips all 210 vanilla files).
- **Pre-pass** — comments, `#include`, `#define` exactly as the game does them — `gon/preprocess.ts`, `gon-includes.ts`.
- **Overlay engines** — `append` / `deepMerge` / `patchMerge` + CSV, faithful to the decompiled merges — `overlay/` (fixtures `test/fixtures/overlay/`).
- **Merge preview** — base vs effective per touched entry (GON) or changed rows (CSV) — `preview-merge.ts`, MCP `preview_merge`.
- **Component key schema** — `editor/component-schema.json`: per `glaiel::` class, the keys read, their type, default, required flag, inherited keys and evidence (1741 classes, 1314 keys); `npm run build:component-schema [-- --check]` — `component-schema.ts`, `component-schema-build.ts`.
- **Base-data index** — categories + entries, component names, audio index, SWF clip list — `base-data.ts`, `gpak-index.ts`, `npm run build:index`.

### Templates (`new_from_template`, `templates.ts`; 9 kinds)

- `ability`, `passive`, `item`, `status-data`, `room`, `tileset-variant`, `particle`, `vfx-ability`, `glowing-character`.

### Validator check families (`validate/validator.ts`, `validate/audio.ts`, `shader/dialect.ts`, `art/*`)

Families:
- reference integrity (base + mod + `registered-names.json` names and patterns)
- localization completeness
- overlay-target existence
- component keys
- GON parse / pre-pass
- rooms + maps
- particles + clips
- audio
- 3D models
- shaders
- cat rigs + cat animations
- art scenes
- cross-mod checks (`modpaths`)
- manifests + game build

Finding codes found in the code, by group:

- **GON / overlays (14):** `gon-parse-error`, `comment-unclosed`, `include-missing`, `include-path-unsafe`, `gon-macro-runaway`, `whole-file-replace`, `merge-target-missing`, `patch-target-missing`, `merge-suffix-literal`, `patch-nonnumeric`, `append-collision`, `base-missing`, `modpath-missing`, `mod-empty`.
- **References and components (9):** `unknown-status`, `unknown-parent`, `unknown-class`, `unknown-template`, `unknown-component`, `unknown-key`, `missing-required-key`, `component-list-missing`, `invalid-glow-name`.
- **Localization (5):** `missing-loc-key`, `missing-translation`, `incomplete-loc-row`, `csv-column-count`, `csv-positional-merge-fragile`.
- **Rooms and maps (11):** `lvl-bad-format`, `lvl-unknown-spawn-id`, `lvl-unknown-tile-id`, `lvl-no-player-spawn`, `lvl-outside-levels`, `lvl-palette-unusual`, `map-node-type-unknown`, `map-next-map-missing`, `map-tileset-unknown`, `map-chapter-id-unknown`, `map-level-pool-empty`.
- **Particles and clips (4):** `particle-missing`, `particle-unknown-key`, `clip-missing`, `clip-list-missing`.
- **Audio (13):** `audio-index-missing`, `sound-missing`, `sound-not-wav`, `sound-not-ogg`, `sound-unsupported`, `sound-format`, `sound-event-unknown`, `sound-replaces`, `sound-set-append`, `sound-set-not-loaded`, `sound-set-folder-unknown`, `music-not-ogg`, `music-unknown`.
- **3D models:**
  - 42 shared `model-*` codes (`model-codes.ts`);
  - plus the GON block checks `model-scale`, `model-yaw`, `model-offset`, `model-tint`, `model-flag`, `model-key-unknown`.
- **Shaders (9):** `shader-version-first`, `shader-entry-missing`, `shader-entry-shadowed`, `shader-guard-missing`, `shader-include-missing`, `shader-include-unchecked`, `shader-uniform-missing`, `shader-uniform-type`, `shader-attribute-unbound`.
- **Native seam (5):**
  - `native-build-unknown`;
  - the cat rig codes `cat-rig-target-unknown`, `cat-rig-slot-missing`, `cat-rig-idle-missing`, `cat-rig-export-name`.
- **Cat rigs / cat animations (art, 19):** `cat-rig`, `cat-anim`, `cat-anim-back-facing`, `cat-anim-depth`, `cat-anim-donor`, `cat-anim-four-way`, `cat-anim-four-way-incomplete`, `cat-anim-layer-name`, `cat-anim-layer-not-rig`, `cat-anim-missing-facing`, `cat-anim-slot-not-empty`, `cat-anim-untested`, `rig-back-head`, `rig-depth-order`, `rig-slot-dup`, `rig-slot-missing`, `rig-slot-not-empty`, plus `cat-rig-export-name` / `cat-rig-idle-missing` / `cat-rig-slot-missing` in the scene form.
- **Cross-mod (5):** `cat-append-conflict`, `cat-append-shadows-vanilla`, `cat-append-shared`, `swf-file-conflict`, `swf-file-shadows-vanilla`.
- **Art scene / emitter / SVG (≈70):**
  - scene (`scene.ts`, `shape.ts`): `scene-json`, `scene-version`, `self-check`, `shape-empty`, `shape-no-edges`, `path-parse`, `path-invisible`, `subpath-dropped`, `fill`, `fill-quantized`, `fill-rule-ignored`, `passthrough-fill`, `stroke-dropped`, `stroke-style-dropped`, `stroke-width`, `curve-resolution`, `frame-rate-vanilla`, `stage-background`, `preview-palette`, `label-name`, `layer-name`, `no-exports`, `import-unpinned`, `blend-not-previewed`;
  - gradients: `gradient-geometry`, `gradient-kind`, `gradient-stops`, `gradient-missing`, `gradient-shape4-dropped`, `gradient-spread-ignored`;
  - bitmaps: `bitmap-missing`, `bitmap-read`, `bitmap-encode`, `bitmap-too-large`, `bitmap-unsupported-format`, `bitmap-upscaled`;
  - text and fonts: `text-box`, `text-color`, `text-empty`, `text-font`, `text-html`, `text-size`, `text-loc-key-html`, `font-empty`, `font-glyph`, `font-glyph-missing`, `font-metrics`;
  - glow: `glow-baked`, `glow-orphan`, `glow-unplaced`;
  - exports: `export-shadows-vanilla`, `export-unresolved`, `exports-empty`, `ref-unresolved`;
  - timeline edits: `label-removed`, `layer-removed`, `mask-depths`;
  - SVG import: `svg-parse`, `svg-root`, `svg-empty`, `svg-viewbox`, `svg-viewbox-aspect`, `svg-transform`, `svg-color`, `svg-gray-alpha`, `svg-gray-snapped`, `svg-invisible`, `svg-paint-server`, `svg-gradient-bbox`, `svg-gradient-empty`, `svg-gradient-stops`, `svg-skipped`, `svg-unsupported`;
  - SVG export: `svg-export-bitmap`, `svg-export-gradient`.
- **Manifest / pack (5):**
  - findings: `manifest-missing`, `manifest-invalid`, `manifest-build-mismatch`, `mod-missing`;
  - pack refusals: `swf-build-failed`, `validation-errors`, `native-dll-missing`, `out-dir-unsafe`.

### Art pipeline (`art/`)

- **Scene model** — `art/<name>.scene.json`: shapes, bitmaps, fonts, gradients, texts, imports, sprites, exports — `scene.ts`.
- **SWF emitter** — `DefineShape3/4`, `DefineBitsLossless2`, `DefineFont3`, `DefineEditText`, `DefineSprite`, `PlaceObject2/3`, `RemoveObject2`, `FrameLabel`, `DefineSceneAndFrameLabelData`, `SymbolClass`, `ImportAssets2`, optional `DoABC` stub — `swf-emitter.ts`, `lossless.ts`, `font.ts`, `text.ts`.
- **SWF verification reader** — header, tag histogram, labels, exports — `swf-reader.ts`, MCP `inspect_swf`.
- **SVG import / export** — `svg-import.ts`, `svg-export.ts`, `svg-reorigin.ts`.
- **PNG import** — modes sprite / background plate / bitmap fill — `raster.ts`, `png.ts`, MCP `import_bitmap`.
- **Glow bake** — `glow.ts`, MCP `bake_glow`.
- **Timeline editing** — `timeline-edit.ts`, `timeline.ts`.
- **Cat rigs and cat animations** (front + back rig, four-way quartet), ghost cat preview — `cat-rig.ts`, `ghost-cat.ts`.
- **VectorCraft headless** — draws on a shape in Playwright's Chromium, nothing installed — `vectorcraft-headless.ts`, MCP `vectorcraft_exec`.
- **Probe analyzers** — `probe-compare.ts`, `probe-outcomes.ts`, `glow-measure.ts`, `mesh-measure.ts`, `probe-raster.ts`, `probe-vfx.ts`, `probe-multiappend.ts`.

### Other core modules

- **Level codec** — `.lvl` read/write, byte-identical for all 2361 vanilla files; edit ops; templates; tile/spawn clip thumbnails + Iso — `level/`.
- **Audio** — sound sets, music table, WAV header reader, the audio index — `audio/`, `validate/audio.ts`.
- **Model readers** — OBJ / glTF / GLB readers, header checks, codes — `art/obj-read.ts`, `art/gltf-read.ts`, `art/model-read.ts`, `model-check.ts`, `model3d.ts`.
- **Particles key list** — `particles.ts`.
- **Shader dialect checker** — `shader/dialect.ts`.
- **Bindings library** — PE parse, scan, signature generation, harvest, port, seed, header generation — `bindings/`.
- **In-game runner** — `ingame/`.
- **Pack / install** — `pack.ts`, `zip.ts`, `mod-manifest.ts`.
- **Repo paths and worktree env vars** — `repo.ts`.

---

## 6. MCP server (`editor/src/mcp/tools.ts`, 31 tools)

`npm run mcp`, registered as `mewgenics-editor`.

**Base data and mods**
1. `list_base_data` — data categories with counts, or one category's entries (incl. sounds / music / sound_files).
2. `read_base_entry` — one base entry as GON text.
3. `search_components` — `glaiel::` class names + the keys each reads (+ where used).
4. `read_mod` — a mod's files (or the list of mods).
5. `write_overlay` — write a file under `mods/<name>/` only.
6. `validate_mod` — all validator checks; `modpaths` for cross-mod checks.
7. `preview_merge` — the effective merged result of one overlay.
8. `list_registered_native_names` — native-registered names and patterns (glow, catrig, model).
9. `new_from_template` — scaffold one of the 9 kinds + loc rows.

**In-game**
10. `list_ingame_tests` — `.mewtest` scripts with parsed headers.
11. `run_ingame_test` — launch, run one script, return the report.
12. `start_ingame_session` — interactive session on a named pipe.
13. `ingame_exec` — a console line / dump / quit over the pipe.
14. `stop_ingame_session` — end the session, return the report.

**Art**
15. `list_art_scenes` — scenes, built SWFs, assets.
16. `read_art_scene` — read + validate a scene.
17. `write_art_scene` — validated write (`dryRun`, `force`).
18. `new_art_scene` — new scene, or the `cat-animation` template.
19. `import_svg` — SVG → scene shape.
20. `import_bitmap` — PNG → raster art (sprite / plate / fill).
21. `export_svg` — one shape → `art/<id>.svg`.
22. `bake_glow` — halo / drop-shadow shape.
23. `build_swf` — scene → `swfs/<name>.swf` + `swflist.gon.append`.
24. `inspect_swf` — read a built SWF.
25. `vectorcraft_exec` — headless VectorCraft drawing on a shape.

**Native bindings**
26. `check_game_build` — is the installed exe a known build; do all signatures match.
27. `port_bindings` — port the manifest to a new exe (the resolution ladder).

**Shipping**
28. `pack_mod` — build, validate, zip.
29. `install_mod` — checked install into `mods/<name>/`.

**Rooms**
30. `read_level` — read a `.lvl` room.
31. `write_level` — write a room (whole, bytes or edit ops).

---

## 7. Web UI (`editor/web/`)

`npm run web` serves the built UI on `http://127.0.0.1:4173/` (`PORT` overrides it); `npm run build` builds it.
`npm run dev` runs Vite on port 5173 and proxies `/api` to 4173 (`API_PORT`). The full control-by-control list is in
[`web-ui-inventory.md`](web-ui-inventory.md) and is not repeated here. Everything that document marks "open PR"
up to #130 is on `main` now.

- **Shell** — top bar, mode switch **Data | Art | Rooms**, mod switcher, Validate, Save, mod menu ⇩ **Export…** / ⇧ **Import mod…**, Help (tours, worked examples, concepts), status bar.
- **Data mode** — overlay tree, base-data browser, GON editor with live validation, Validation / Preview / Components tabs (the components tab shows the keys each class reads), template modal.
- **Art mode**:
  - scene explorer; sub-tabs Overview, Shapes (Import PNG…, texts with plain-localized, Bake glow…, VectorCraft, SVG export), Sprites, Timeline, Rig (cat rigs, cat animations, Four-way, back rigs), VectorCraft, Exports, JSON;
  - right panel: engine-faithful Preview (palette rows, ghost cat), Findings, Build, Ruffle.
- **Rooms mode** — `levels/` explorer, tile and object palettes, 10×10 grid painter, cell inspector, live `lvl-*` findings, New room, tileset art thumbnails, Flat | Iso view.
- **Dev page** — `web/art/preview-dev.html`.

---

## 8. Tooling

### `tools/`

- **`gpak.py list|cat|extract|stats`** — read-only `resources.gpak` access — `python -I tools/gpak.py …`.
- **`rea-mcp.mjs`** — MCP stdio client for REA/Ghidra: `list-tools`, `run <batch.json>`, `watch <queueDir>` (one long-lived session per agent).
- **`strings-rtti.js`** — dumps printable exe strings with context (RE helper).
- **`install-mewjector.bat`** — installs a user-verified Mewjector `version.dll` + `chainloader.ini`.
- **`mewjector-build/`** — sources of a Mewjector-compatible `version.dll` (`build.sh`).
- **Bindings tools** (`tools/bindings/`):
  - `check-build.ts` — is this exe known; does every signature hold;
  - `make-signature.ts` — derive unique wildcarded signatures;
  - `harvest.ts` — verify and write anchors;
  - `port.ts` — port a manifest to a new build (`--dry-run|--apply`);
  - `seed-file.ts` — write a Ghidra seed file;
  - `gen-headers.ts` — generate `signatures.h` / `offsets.h` (`--check`);
  - `cross-build.ts` (+ `cross-build-args.ts`) — a real two-exe port check, writes nothing.

### npm scripts (`editor/package.json`, 22)

- `typecheck` — `tsc --noEmit`, strict, over everything.
- `build:index` — writes the `editor/data/` caches (component names, base-data index, audio index, clip list).
- `build:component-schema` — merges the RE fragments into `component-schema.json` (`-- --check`).
- `build` — vendors Ruffle + VectorCraft, then `vite build`.
- `dev` — the same vendoring, then the Vite dev server (5173).
- `vendor:vectorcraft` / `vendor:vectorcraft:check` — the one pinned VectorCraft zip, SHA-256 verified / re-hash.
- `mcp` — the MCP server.
- `web` — the local web server (4173).
- `test` — the unit suite (`--only <substr>`).
- `test:ingame` — T2 runner.
- `test:swfgate` — SWF append gate.
- `test:artprobe` — art probes (modes in §4).
- `test:unitglow` — glow proofs.
- `test:catrigsample` — cat rig sample proof.
- `test:e2e` — vendor + `vite build` + Playwright.
- `bindings:gen` / `bindings:check` — generate / verify the native headers.
- `t3` — the T3 looks gallery.
- `pack` — pack / install / `--init` a mod.
- Other scripts run directly with node (no npm alias):
  - `scripts/check-test-change.ts` — CI's test-change rule;
  - `scripts/audio-probe-tones.ts` — the probe WAVs;
  - `scripts/make-fw3d-assets.ts` — the `fw-3d` assets;
  - `scripts/vendor-ruffle.ts`.

### Native and launch

- **`native\test-all.bat`** / **`native/test-all.sh`** — every host-side native suite (framework, jokers-luck, test-harness, catrig-sample); `-Werror`; CI runs the `.sh`.
- **`native/framework/build.bat`**, **`native/mods/*/build.bat`** — w64devkit GCC (`GCC` env var overrides it).
- **`launch-dev.bat [extra mod dirs]`** — `SteamAppId=686060`, `-savesuffix dev`, debug console, dev mode, `-modpaths mods/dev-sandbox …`.
- **CI** — `.github/workflows/t0.yml` (Linux): T0 on PRs touching `editor/`, `native/`, `bindings/`, `tools/`, `mods/`; plus the test-change rule.

### Claude Code skills (`.claude/skills/`)

- **`mewgenics-modding`** — author, validate and preview data-layer mods with the MCP tools.
- **`port-bindings`** — port the bindings to a new game build (`check_game_build` → `port_bindings` → `bindings:gen` → rebuild → T1/T2).

---

## 9. Knowledge base (`docs/`)

- [`KNOWLEDGE-BASE.md`](KNOWLEDGE-BASE.md) — the entry point: what we know, what is open, how to operate, document index.
- [`engine-map.md`](engine-map.md) — binary facts: build identity, RVAs, data model, statuses, SWF/cat parts, glow, GON at runtime, facing, audio, particles, 3D path, save safety.
- [`data-mods.md`](data-mods.md) — overlay semantics + fidelity tables, content shapes, every data-mod recipe in §1, shipping.
- [`ingame-testing.md`](ingame-testing.md) — harness grammar, events, verdicts, runners, shots, campaign walk, pipe mode.
- [`art-pipeline.md`](art-pipeline.md) — how SWF / PNG / fonts / rigs / palettes / shaders work and what is moddable.
- [`art-preview-plan.md`](art-preview-plan.md) — Art mode architecture, preview render path, cat rig work log.
- [`swf-tooling-options.md`](swf-tooling-options.md) — the SWF subset the engine needs; authoring without Adobe.
- [`swf-emitter-fix-spec.md`](swf-emitter-fix-spec.md) — why the first emitted SWF crashed; the fixes (closed).
- [`binding-port.md`](binding-port.md) — the manifest, anchors, the port ladder, cross-build results.
- [`possible_3d_work.md`](possible_3d_work.md) — the 3D build plan: phases 0 / M (done) / P.
- [`3d-importer-design.md`](3d-importer-design.md) — OBJ + glTF importer rules for the DLL and the editor.
- [`3d-rendering-feasibility.md`](3d-rendering-feasibility.md) — prior 3D feasibility study.
- [`spatial-model.md`](spatial-model.md) — the game is strictly 2D: coordinates, grid, layers.
- [`automation-feasibility.md`](automation-feasibility.md) — levers for driving the game in tests.
- [`editor-ts-react-plan.md`](editor-ts-react-plan.md) — the editor's TS/React/Vite/zod migration record.
- [`tdd-procedure.md`](tdd-procedure.md) — tiers T0–T3, the red/green loop, worktrees, enforcement.
- [`web-ui-inventory.md`](web-ui-inventory.md) — every web UI control.
- `feature-inventory.md` — this file.

**Where RE facts live:**
- `docs/engine-map.md` — the facts;
- `bindings/25143593.json` — the addresses, with their anchors;
- `.analysis/decompiled/*.c` and `.analysis/notes-*.md` — git-ignored, local only;
- fixtures under `editor/test/fixtures/ingame/` — the observed runs.

---

## 10. Test coverage at a glance

- **`npm test`** — `1196 passed, 0 failed` when run on b2e13b7 for this doc, with the three `MEWGENICS_*` data env vars set (the integration commit 9f7738f quotes 1198; CLAUDE.md still says "~250").
- **Native host suites** — 441 checks in 23 suites (CLAUDE.md "Native layer"); on Windows `native\test-all.bat` needs PR #139 to run them all.
- **Playwright e2e** — 54 checks (counted: art-mode 25, data-mode 9, onboarding 10, rooms 5, shipping 2, smoke 3).
- **MCP tools** — 31 (counted in `tools.ts`).
- **In-game scripts** — 65 `.mewtest` files across 19 mods.
- **Unit test files** — 58 suites in `editor/test/*-tests.ts`.

---

## 11. Pending (open PRs, not on `main`)

From `gh pr list` on 2026-10-22. Several older PRs (#103–#135) still show as open on GitHub, but their commits
reached `main` through the integration merge #136. Only the five below carry work that is not on `main`.

- **#133** `feat/component-schema-close` — closes every vanilla-open component: `amend` fragments, `unread` keys (new `ignored-key` info), map-aware traversal.
- **#134** `fix/component-schema-defaults` (stacked on #133) — key defaults re-read from the disassembly: 328 rows checked, 42 corrected.
- **#137** `docs/dev-stance-on-mods` — `docs/legal-and-community.md`: the developers' stance on mods, comparable cases, repo audit.
- **#138** `feat/3d-meshes-m3` — 3D phase M5: `hide_sprite`, cat palette rows, `@Name` models (`data/models.gon`), `.glb` embedded textures, facing yaw, multi-tile slices, same-tile ties.
- **#139** `fix/test-bat-mesh-order` — restores the `test_mesh_order` build and check lines that the integration merge dropped from `native/framework/test.bat`.
