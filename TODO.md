# TODO — Mewgenics modding toolkit

Living status snapshot (last updated 2026-10-22: the 2026-10-21/22 parallel RE run is in PRs #73–#83 + two in flight, none merged yet; everything through #72 is merged). `[x]` done · `[~]` in progress · `[ ]` planned, not started.

## Requires a human (T3 looks) — open the gallery: `cd editor && npm run t3`, then open `editor/data/t3-gallery/index.html`

What no test can see (look, feel, usability), collected from the PR bodies' T3 sections. One line per item; the
shots, the regenerate command and the status live in `editor/t3-looks.json` (tick an item there with
`"status": "done"` and here). The page shows each item's shots (copied from the run dirs), Yes / No / Not sure,
and **Export answers** (a JSON to hand back to an agent). Decisions that are not looks stay under "Open decisions".

- [ ] `pr63-gradient` (#63) — In the probe shot, does the leftmost square fade smoothly red → black (mirrored, like every enemy clip)?
- [ ] `pr64-caps` (#64) — In the probe shot, is the top green line (butt caps) visibly shorter than the bottom one (square caps)?
- [ ] `pr65-add-blend` (#65) — In the probe shot, does the add-blend square look like a lightened dark red over the arena (not a flat #600000)?
- [ ] `pr69-probe-text` (#69) — In the probe shot, does the mint word PROBE read in the game's own lettering, mirrored like every enemy clip?
- [ ] `pr67-cat-rig` (#67) — Does the CatProbe rig read as a cat — orange tail, blue body, peach head with ears — mirrored like every enemy?
- [ ] `pr74-tomtom` (#74) — In shot-rig-1, does the cat under our yellow checker marker look like TomTom — the same gray textured parts, grumpy face and tail as the control TomTom — standing upright on its tile?
- [ ] `pr74-size-facing` (#74) — Is the appended-frame cat the same size and facing as the control TomTom (both scale 1.1, both mirrored), with nothing missing — two legs, two arms, body, head, tail?
- [ ] `pr74-hit` (#74) — In shot-rig-3, does the hit reaction look like a normal enemy hit (the vanilla animation taking over our idle), not a glitch?
- [ ] `pr80-glow-preview` (#80) — Before → after: does the banded orange 6 px halo around the starter's gray square read as a glow at game scale (No = the default needs more bands or a wider blur)?
- [ ] `pr86-unit-glow` (#86) — In shot-glow, does the Rat at the right of the arena carry a magenta band hugging its sprite, with no wash over its body (and none in shot-noglow)?
- [ ] `pr86-glow-width` (#86) — Is glow_radius 12 the band width you want for the per-unit rim (and is the white hover rim being off while a unit glows acceptable)?
- [ ] `pr99-glow-colours` (#99) — In shot-two, does the cat carry a cyan rim and the Rat a magenta one, each hugging its own sprite (no cross-colour bleed), and is the cat's rim whole among the other cats (no straight scissor edge)?
- [ ] `pr104-data-glow` (#104) — In shot-glow, does FwGlowRat (glowing from DATA: the status FwGlow_ff00ff, no DLL) carry the same magenta band hugging its sprite as the native-API Rat, with nothing over its body (and none in shot-noglow)?
- [ ] `pr104-glow-icon` (#104) — The glow status shows LuckUp's four-leaf clover on the unit's status bar (and should tooltip "Glowing"): acceptable for a cosmetic status, or should hiding the icon be a follow-up?
- [ ] `glow-decide-icon` (glow v3) — **Decide:** a FwGlow_ status shows LuckUp's four-leaf clover on the unit's status bar (see shot-glow of `*-fw-glow-data-glow`). Keep the clover, or ask for a follow-up that hides the icon (or gives the glow status its own)?
- [ ] `glow-decide-hover` (glow v3) — **Decide:** while a unit glows the game's white hover rim stays off for it. Leave it off, or ask for a follow-up that redraws the hover rim on top of the glow?
- [ ] `pr109-rig-cat` (#109) — In shot-rig-1, does the cat under the yellow marker (our _CatRig_ clip) look like a real cat with Mangy's parts in the idle pose, the same cat as the marker-less control in shot-vanilla?
- [ ] `pr109-rig-labels` (#109) — A swap rig without a label for an animation (hits, attack) keeps the cat on its frame: acceptable, or should a swap rig fall back to the vanilla labels it lacks?
- [ ] `pr118-rig-sample` (#118) — In shot-rig-1 (rig-dll), is the cat beside the small yellow marker (bound only by catrig_sample.dll) a real cat with Mangy's parts, the same as the marker-less control?
- [ ] `pr118-rig-dead` (#118) — A killed swap-rig cat with no death label stays STANDING (rig-labels shot-l20) where the vanilla cat lies dead (rig-labels-ctl shot-l20): acceptable, or should a swap rig fall back to the vanilla labels it lacks?
- [ ] `pr59-ruffle-tab` (#59) — Art mode → Ruffle tab → vanilla ability_icons.swf or catparts.swf: is it useful as a reference next to your art?
- [ ] `pr63-svg-gradient` (#63) — Dropping an SVG with a gradient into Art mode: does the preview show a smooth ramp, with gray stops mapped to the palette row?
- [ ] `pr64-svg-corners` (#64) — Importing an SVG with thick butt and miter strokes: are the preview corners sharp, not rounded?
- [ ] `pr66-timeline-tab` (#66) — Timeline tab on dev-sandbox/my_rat: can you click cells, add a key, move it in the inspector, and does the preview follow with marks readable in your theme?
- [ ] `pr67-rig-tab` (#67) — Rig tab: does New cat rig → assign a shape to head → Animate it in the Timeline work and read clearly?
- [ ] `pr70-svg-roundtrip` (#70) — Export SVG → edit mods/<mod>/art/<shape>.svg in VectorCraft or Inkscape → save as plain SVG → Replace…: does the shape change in place?
- [ ] `pr76-cat-anim-ui` (#76) — Rig tab → type a name → New cat animation: do the donor card and the <name>F / <name>B pills read well, with the under-test note visible but not alarming?
- [ ] `pr76-animate-pose` (#76) — Does Animate pose land on the rig in the Timeline tab, and does Timeline on the donor show the two labeled frames?
- [ ] `pr-cat-back` (#105, re-shot by the facing PR) — In shot-shown-2, do the three big cats (one turned away by `face 9 back`, one data-locked `properties.lock_orientation [1 0]`, the shown one) read as TomTom seen from behind (head from behind with both ears, body, tail in front), nothing missing? shot-turned-back shows the turned one facing the camera again.
- [ ] `pr76-wave-in-game` (#76) — Measured (run 20261022-101117, `npm run test:artprobe -- --cat-wave`): an animated `wave` pose authored with newCatAnimation, played via `alt_animations [[idle wave]]` on a TomTom, gets the cat's own parts (outline ~10.7k px vs TomTom's 11.0k) and moves (outline change 10773 px between shots vs 4380 for the idle control). Eyeball: in shot-wave-1 vs shot-wave-3, does the lower TomTom's arm wave read as a wave, not a twitch?
- [ ] `pr80-glow-in-game` (#80) — Measured (run 20261022-101249, `npm run test:artprobe -- --glow-arena`): the baked halo is drawn in the arena — inner band = the #ff8000 swatch, alpha falling off outward on 4/4 rays, the unglowed control unlit — and its 4 bands show as 4 plateaus (alpha ~.86/.66/.44/.21). Eyeball: in shot-glow-1, does the rim read as a glow, or are the bands too visible (then more default steps)?
- [ ] `pr80-bake-form` (#80) — The Bake glow… form: are kind / colour / blur / offset the right knobs (No = strength and bands should be exposed too)?
- [ ] `pr81-fill-rule` (#81) — Two overlapping same-fill squares on one path (fillRule nonzero): does Findings show fill-rule-ignored and the preview a hole, and does evenodd clear the warning?
- [ ] `pr81-inspect-card` (#81) — Build tab → inspect a built SWF: does the Inspect card list the loader's findings (or "The game's loader accepts every tag.") clearly?
- [ ] `pr87-vendor-online` (#87) — Online once: does `npm run build` print the VectorCraft download line, and does `npm run vendor:vectorcraft:check` then say verified?
- [ ] `pr88-vectorcraft-tab` (#88) — my_rat → Shapes → VectorCraft on body: does the app appear, and after drawing + Apply to shape does Preview show it where the body is (and Build SWF / Ruffle look right)?
- [ ] `pr88-shortcuts` (#88) — Do keyboard shortcuts reach VectorCraft after a click into the iframe, while the editor's own inputs still work when the tab is not active?
- [ ] `pr89-vectorcraft-exec` (#89) — From Claude Code, vectorcraft_exec on dev-sandbox my_rat body with a shape.ellipse, then Build SWF: does the ellipse look right (Ruffle tab / art probe)?
- [ ] **Loc-text shot** (`npm run test:artprobe -- --loctext`, run `20261022-090100-_artprobe-render-loctext`,
      `shot-loc-2.png`): is the substituted string ("Tom Tom", "LOCALIZED OK") rendered in the right font / size — the
      same lettering as the HTML boxes beside it?
- [ ] **Redirected Rat** (`npm run test:artprobe -- --tileset`, run `20261022-090748-_tileprobe-render-tileset-redirect`,
      `shot-rat-2.png`): any wrong offset or mirroring of the ArtProbe clip drawn for a plain Rat, against the ArtProbe
      enemy in `render-probe` and the vanilla Rat in the control run `20261022-090756-_artprobe-render-tileset-control`?
- [ ] **New tileset shot** (`cd editor && npm run test:ingame -- _roomprobe new-tileset`, run
      `20261022-131707-_roomprobe-new-tileset`, `shot-roomprobe-yard.png`): does the probe room sit in the junkyard
      art (the new tileset `roomprobe_yard`), with the three water puddles and the trash bag where `probe.lvl` puts them?
- [ ] `pr-room-editor` (#125) — Rooms mode on `_roomprobe` → `probe.lvl`: does the grid read as the room, can you paint / place a spawn / edit a random list unaided, and are the tint swatches (not tileset art) enough?
- [ ] `pr130-room-tile-art` (#130) — Rooms mode on `_roomprobe` → `probe.lvl`, Flat and **Iso**: do the tile/object thumbnails read as the game's (water/lava drawn in their tint, not magenta), is the Iso view the room as the in-game shot shows it (which corner is row 0?), and is painting on the diamonds comfortable?
- [ ] **Listen to the audio probe** (`feat/audio-mods`; no test can hear): `cd editor && node scripts/audio-probe-tones.ts`, then launch with `-modpaths <repo>/mods/_audioprobe` (or `npm run test:ingame -- _audioprobe sounds` with `hide: false`): in a fight, does a coin pickup / `play_sound PickupCoin` give a short high beep (1320 Hz) instead of the coin jingle, and `play_sound AudioProbe_New` a lower 660 Hz tone, at a sane volume?
- [ ] **Ship a mod end to end** (PR feat/mod-packaging): `cd editor && npm run pack -- jokers-luck` (review the
      committed `mods/jokers-luck/mod.json`: license, description), then read the zip's `README-INSTALL.txt` as a player
      would — clear enough? — and install it on another folder (`npm run pack -- --install <zip> --into <dir>`) and
      launch with the README's `-modpaths` line: does the mod load? Also try *Export…* / *Import mod…* in the web UI.
- [ ] `pr120-vfx-aura` / `pr120-vfx-repoint` (#120) — **VFX probe shots** (`npm run test:artprobe -- --vfx`, run `20261022-131810-_vfxprobe-vfx-probe`, `shot-aura-2.png`,
      `shot-repoint-1.png`): does the NEW aura read as a rising cloud of pink discs on the Rat (not a flat blob), and does the
      re-pointed SparkleBuff show our yellow-bordered marker clip (streaked along the motion) on the second Rat? Note: that
      run used PR #117's in-process GL capture (its `mewtest.dll` swapped in and restored); with the window capture every
      shot came back as the loading screen (stale-shots, refused by the measure) — re-run after #117 merges.
- [ ] `pr124-raster-look` (#124) — In the raster shot, do the PNG sprite, the photo blocks and the orange block-font text look right at game scale, and is the soft 0x41 stripe acceptable next to the crisp 0x43 one?
- [ ] `pr124-backdrop` (#124) — In the backdrop shot, does the purple / teal mod plate read as the arena background, with the tileset foreground on top?
- [ ] `pr124-import-png` (#124) — Art mode → Shapes → Import PNG…: is the row clear, and does the preview show the PNG where the game would?
- [ ] **Look at the unit-glow shots** — produced 2026-10-22 by the glow v2 agent (`cd editor && npm run test:unitglow`,
      run `20261022-102435-dev-sandbox-unit-glow`: shot-glow, shot-noglow and the v2 shot-two); `npm run t3` fills the
      gallery's `pr86-unit-glow` / `pr86-glow-width` / `pr99-glow-colours` cards. In shot-two, does the cat carry a cyan rim and the
      Rat a magenta one, each hugging its own sprite (no cyan on the Rat, no magenta on the cat), and is the cat's rim
      whole where it stands among the other cats (a scissor cut would show as a straight edge)?

## Open decisions — return to these next time (parked 2026-10-21, status as of 2026-10-22)

- **Track `editor/component-schema.json`?** (component-schema PR, 2026-10-22) It is RE-derived (1741 `glaiel::` class
  names, ~1.3k key names, `.analysis/` evidence paths; ~0.9 MB) and tracked so CI and fresh clones get the
  validator checks. CLAUDE.md says the only tracked game-derived data is byte signatures in `bindings/`; this is names
  and format facts, not game bytes, but it is your call: keep it tracked, or git-ignore it and build it in
  `npm run build:index` from `.analysis/` (then CI skips the checks).
- **Vanilla typos the game ignores** (component-schema PR): `LowHealthAllyDodgeChanceAura { theshold }`,
  `AbilityOnRoundEndOnce { even_of_stunned }`, `TourettesMeows { cooldown }`, `DamageReductionAura { allies_only }`,
  `MoveTowardsDamageSource { ability }`. A mod could fix them with a .patch; worth a sample mod?

Owner: "we will decide on it later". Everything through PR #72 is merged; the 2026-10-21/22 run answered most of
these without a decision (status per bullet below; the PR map follows).

- [ ] **Campaign-walk save backups (2026-10-22, branch `feat/harness-campaign-walk`).** Starting an adventure
      (`run start`) makes the game back the disposable slot up as `saves/backups/mewtest01_<date>_<time>.savbackup`
      (one per minute of runs; two exist from the T2 runs of 2026-10-22). The real save is never touched. Options:
      leave them (they are the harness slot's own backups), or extend the owner-approved slot exception so the runner
      also moves `backups/mewtest01_*.savbackup` into the run dir (a rename, never a delete). Agents may not touch
      `saves/` beyond the existing exception, so this needs your say-so.

- [x] **Cat parts in a rig — which route, if any?** **Resolved 2026-10-22 as data-only for cat animations** (PR #74:
      experiment A0 — a `_Append_CatTest` frame placing a rig whose seven slots are EMPTY 1-frame sprites is filled by
      the game with the cat's own parts, palette, texture and face; the 2026-10-21 crash at `+0x741f5d` was a visible
      non-empty placeholder — `CatParts::prerender` decompile, session catB; PR #76: the editor authors exactly that
      shape — `new_art_scene template cat-animation`, `parts: "game"` rigs, `cat-anim-*` validator codes, the Rig tab).
      The import route stays closed (#71). What remains native or copied: a non-`_CAT` character wearing a cat's parts
      (hook seam S1 in engine-map "Cat parts: entry path, palette, faces, mirroring" — parked, optional) and new part
      art in catparts.swf. **S1 built 2026-10-22 (framework API v7, `feat/native-catrig-redirect`):** a SWF export
      `_CatRig_<Entry>` (or `FW_RegisterCatRig`) gives one `movieclip _CAT` entry its own whole cat clip; T2
      `render-rig.mewtest` redirected (engine-map "Cat rig redirect", data-mods "A whole cat rig for one character").
      **Sample pairing (plan A2.4) done 2026-10-22** (`native/mods/catrig-sample` + `mods/catrig-sample`, `npm run
      test:catrigsample`, data-mods "Pairing a cat rig with a DLL"): `FW_RegisterCatRig` from a mod DLL redirected an
      export with no `_CatRig_` prefix; `<Entry>_Champion` / `_Elite` names get the entry's rig; a rig's `hitF/B` plays on
      a non-lethal hit and every label it lacks is a silent no-op — a killed rig cat with no death label stays STANDING.
      Next: an editor "swap rig for <entry>" control / MCP template (plan A3). 2026-10-22: the back facing's `head_back` layout (`<name>PoseBack`, `facing: "back"`)
      and the four-way `LF/RF/LB/RB` quartet (`newCatAnimation { fourWay }`, Rig tab checkbox) are authored and
      validated (engine-map "The back facing and the four-way quartet"; probe `render-cat-back`: the back rig drawn with the cat's own parts, OBSERVED run 20261022-114912). Turning a unit away is
      solved (2026-10-22, #105 stack): the harness's `face <unit> back` calls `Character::Face` 0x10ce50 (engine-map
      "Facing: Character::Face"; #105's `lock_orientation [0 -1]` asked for a FRONT facing and a lock overrides every
      turn; the orientation keys are `properties.*`, #105 had them under `graphics`). ~~Open: the back rig's non-slot marker is not drawn~~ — resolved 2026-10-22 (backmarker, `fix/back-rig-marker`): it was drawn but out of frame (a marker at clip y −330 in a rig placed at 1.5x sits above the window's top edge; the slot visitor 0x742bd0 never touches a non-slot child). The probe marker moved to y −220 and is found above the back-facing unit in run 20261022-132159 (engine-map "The back facing and the four-way quartet"). Open: a four-way cat in the game.
      Done 2026-10-22: a ghost cat in the preview for empty slots (`ghost-cat.ts`; catparts.swf outlines when
      extracted, built-in otherwise; toggle "ghost cat"; docs/art-preview-plan.md §3.1).
- [x] **Localized text?** **Owner, 2026-10-21: deferred; Peralta is fine as the default font.** Since then session
      `loc` found it **looks data-only** (the text-box ctor 0x98d910 localizes an initial text that is a loc key; every
      `data/text/*.csv` is loaded — engine-map "Localization and text fields"). **Probed 2026-10-22 (OBSERVED,
      `mods/_artprobe/tests/render-loctext.mewtest`):** a DefineEditText whose initial text is exactly a key is shown
      localized — for a vanilla key and for a key a mod adds via `combined.csv.append` — **only when it is emitted
      without the HTML flag** (`scene.texts[].html: false`); in vanilla's `<p><font>` wrapper the key is drawn as
      written. **Done 2026-10-22: validator rule `text-loc-key-html`** (warning: an HTML text that is exactly a key —
      base `combined.csv` or the mod's own csv overlays; an info for the key shape alone; scene findings and
      `validate_mod`) and a
      **plain (localized)** box on Art mode's text row that writes `html: false`. Not automatic by design.
- [x] **`tilesets.gon` clip redirect** — probed 2026-10-22 (OBSERVED, `mods/_tileprobe`): `alley { Rat ArtProbe }`
      makes every plain Rat in the alley tileset draw the mod clip `ArtProbe` (marker found after `spawn Rat`, none
      in the overlay-free control). `docs/data-mods.md` "Redirecting a vanilla character's clip via tilesets.gon".
- [x] **Filters / glows** — answered 2026-10-21 (PR #80): the game refuses any PlaceObject3 filter (the loader has no
      filter renderer; `PlaceObject::decode3` 0xb78210 stops on the flag bit), so the validator keeps blocking them and
      the **bake helper is done**: `bakeGlow` / `bakeDropShadow` (`editor/src/core/art/glow.ts`), MCP `bake_glow`, the
      shape row's "Bake glow…"; engine-side data has only `CharacterLightSource.glow` (ground disc) and `AdvancedTint`
      (brightness) — engine-map "Glow and outline passes", `data-mods` "Lighting and tint knobs". A **native per-unit
      rim** (a mask + the game's blur/composite passes with a per-unit colour) is in PR (branch
      `feat/native-unit-glow`, session rim).
- [ ] **Native per-unit glow — what next?** The rim landed (#86, stacked on #79): `FW_SetUnitGlow(Character*, rgba)`
      draws a rim through the game's outline mask (combat only, the rim shader shipped by `mods/fw-glow`). Decide: (a)
      a data-level way to ask for it — **done (glow v3, `feat/glow-data-seam`)**: a status named `FwGlow_<rrggbb[aa]>`
      granted by any vanilla mechanism (StatusOnSpawnIn, an ability's effects, …) glows its carrier while it lasts, no DLL;
      `registered-names.json` kind `glow` (a pattern) + validator `invalid-glow-name`; sample `FwGlowRat` in
      `mods/fw-glow`, proven in-game (`npm run test:unitglow -- --data`; `docs/data-mods.md` "Asking for a unit glow from
      data"); its **removal** too: a Temporary `FwGlow_` that expires ends the rim, OBSERVED (`--data-expiry`), and
      `new_from_template` kind `glowing-character` scaffolds one) — and per-unit colours — **done (glow v2, `feat/native-unit-glow-v2`)**: one material per colour, one pass per unit
      scissored to its screen rect (LateRender's hovered-unit math), proven in-game (magenta Rat + cyan cat); (b)
      whether the hover rim should stay off while units glow (it is now) or be redrawn by us.
- [x] **Stale shots (seen 2026-10-22, glowexp / #107):** in about half of the `hide: false` runs that afternoon every `shot`
      of a run came back byte-identical, the game's loading screen, while the fight ran normally. **Done
      (`fix/harness-stale-shots`):** cause OBSERVED — every such run had taken its shots through the runner's screen
      fallback (PrintWindow dark with the game in front, then a screen copy that was one frozen frame for the whole run);
      no good run used it. `mewtest.dll` now reads the GL back buffer itself at `SDL_GL_SwapWindow` (shot events with
      `source: "gl"`), which also works with the window hidden; the runner flags a run whose shots are all
      byte-identical as `shots: stale` (`artifacts.shotsCheck`) and the probes exit 3 instead of measuring them
      (`docs/ingame-testing.md` "Shots").
- [x] **VectorCraft's agent channel:** VectorCraft has an MCP server / JSON control port (alpha). Use it later so agents
      draw parts headlessly, or stay with plain SVG round trips (#70)?
      **Owner, 2026-10-21: approved in principle, at least for testing** (agents drawing parts headlessly).
      **2026-10-22, owner's YES to a build-time download (nothing installed):** the pinned web build is vendored at
      `npm run build` (hash-verified, `scripts/vendor-vectorcraft.ts`) and Art mode's **VectorCraft** sub-tab draws on
      a shape in place — VectorCraft on a Shapes row → draw → Apply to shape, the artboard re-origin undone by
      `svg-reorigin.ts` (`docs/art-preview-plan.md` "VectorCraft in-editor"). The agent channel is MCP
      `vectorcraft_exec` (the same `window.vectorcraft` API in Playwright's headless Chromium, ~0.5–4 s to boot;
      skips when not vendored). The native `vectorcraft-cli mcp --headless` route needs an install and stays unasked.
      Remaining: T3 — the owner's look at the tab and at a `vectorcraft_exec` drawing in game.
- [x] **T3 looks** (owner, 2026-10-21: he will do these later) — moved to **"Requires a human (T3 looks)"** at the
      top of this file (the gallery: `cd editor && npm run t3`; the list: `editor/t3-looks.json`).
- [ ] **Game speed — what to use it for?** (2026-10-22, PR "feat: game speed") The vanilla Combat Speed dropdown
      offers 1..4, but the game reads `combat_speed` as an unclamped float (engine-map "Frame timing and game speed").
      Decisions: (1) **for your own play**: try `combat_speed 8` in `settings.txt` (close the game first; it rewrites
      the file on exit) — untested in-game by an agent; it speeds combat only, keeps `bypass_combatspeed` animations
      at 1x, and opening the Settings menu may show a blank/odd dropdown entry for 8 (unknown). Steam launch options
      stay empty per the repo rules, so `-combat_speed 8` is for dev launches only. Is the feel acceptable, and what
      factor breaks readability? (2) **for T2**: `speed 8` in a script cut the seeded fight from ~12 s to ~2 s with
      identical results (`luck-seeded-speed8.mewtest`); should agents add `speed 8` to the existing fight scripts
      (≤ 12x keeps `wait turns|rounds` sampling exact), or should the runner grow a `speed:` header / default?
      (3) the dev fast mode (`App+0xe1d`, CPU-bound, used by the dev menu's fuzz/stress tests) is decoded but not
      exposed — worth a `speed max` later?
- [x] **Agent, next session (no decision needed):** the deferred docs sweep — done 2026-10-21 in PR #73 (the modding
      skill's art section, binding-port.md "Known limits", KNOWLEDGE-BASE's Ruffle line, CLAUDE.md's tool count; also
      ticked the stale "46 unanchored entries" items, closed by #53–#56). The RE notes of 2026-10-21/22 are folded by
      the docs PR in the map below.

### 2026-10-21/22 parallel run — PR map (merge in this order; stacks noted)

All open against `main` unless noted; CI is T0 only. Each line: what it ships, and the RE session behind it.

- **#73** `docs/sweep-art-bindings` — the deferred docs sweep (skill art section, binding-port limits, KB Ruffle line,
  tool count 24). Docs only.
- **#74** `feat/cat-append-probe` — experiment A0 resolved: `_Append_CatTest` frames with EMPTY slot sprites get the
  cat's own parts; parts `"game"` rigs; engine-map "CatTest and the cat animation clips" (session catB).
- **#75** `fix/overlay-deepmerge-fidelity` — `.patch` engine fidelity to 0x946680 / 0x944cc0 / 0x944f50; the
  row-by-row table in `data-mods.md`.
- **#76** `feat/cat-animation-authoring` — cat animation authoring in the engine's shape (`newCatAnimation`,
  `template: cat-animation`, `cat-anim-*` codes, Rig tab control); catA's animation driver facts in
  art-preview-plan / the skill.
- **#77** `fix/worktree-env-paths` — `MEWGENICS_EXTRACTED_DATA` honoured by the merge preview, `MEWGENICS_EDITOR_DATA`
  added; tdd-procedure "Running the editor from a git worktree".
- **#78** `fix/overlay-append-merge-fidelity` — **stacked on #75**: `.append` / `.merge` fidelity to `Gon_Append`
  0x945410 / `Gon_DeepMerge_plain` 0x945c30 (dispatch 0x9a64a0, session loc's extra task); `merge-suffix-literal`.
- **#79** `refactor/framework-pure-parts` — the framework's vtable clone + thunks, entity/component walks, symbol
  resolution + hook plan become host-tested modules (149 native checks).
- **#80** `feat/glow-bake` — baked glows / drop shadows (`bake_glow`, 25 MCP tools); engine-map "Glow and outline
  passes"; `data-mods` "Lighting and tint knobs" (session glow).
- **#81** `feat/swf-engine-rules` — the closed SWF display path as editor rules (`swf-rules.ts`, 12 codes, even-odd
  preview); engine-map "SWF loader and display path"; the `tilesets.gon` redirect note (session disp).
- **#82** `feat/bindings-hardening` — siggen fixes, null signatures as raw RVAs, five new port rungs with harvest
  verification, `FrameBegin` body signature; engine-map "Status effects" additions (session bind).
- **#83** `fix/gon-parser-fidelity` — editor GON typing matches the game's parser (quotes never type, `: =`
  whitespace, strtol/strtod numbers, bool/null); engine-map "Data model", `data-mods` "GON typing fidelity"
  (session gon).
- **in flight** `feat/harness-hp-gon` — "GON at runtime": Character HP / shield / stats / GON entry + the GonObject
  node layout in the manifest (15 offsets, 7 witness functions); `expect gon <unit> <path> …` and `expect unit … hp`
  in the harness; engine-map "GON at runtime" (session gon). Against `main`.
- **in flight** `feat/native-unit-glow` — **stacked on #79**: the per-unit glow bindings (7 FwSymbol functions, the
  ShaderManager global, the TacticsTest vftable, 16 offsets) and the native rim; engine-map "Per-unit glow (native)"
  (session rim).
- **this PR** `docs/re-notes-2026-10-21` — folds what no PR above covers: engine-map "Cat parts: entry path, palette,
  faces, mirroring" (catA + catC) and "Localization and text fields" (loc), the REA session lessons, the KB refresh,
  `data-mods` "Localized text for mods", art-pipeline §4, this block. **Merge it last**: its TODO / KB / skill / §4
  edits already fold in #73, #74, #76 and #80's wording, so on a conflict take this PR's version of those hunks.

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
- [x] **Binding-port series** (second build, decisions, play-checks): the detailed checklist is the next section
  (pointer only; its open items are indexed in "Still open (owner)" at the end, 2026-10-22).
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
- [x] **After the TypeScript switch (T3 of PR #37)**: restart the `mewgenics-editor` MCP server in Claude Code once and
  call `list_base_data` / `validate_mod` (your registration still names `editor/src/mcp/server.mjs`, now a 4-line shim);
  optionally re-register with `claude mcp add mewgenics-editor -- node "<repo>/editor/src/mcp/server.ts"`. Run
  `npm run test:ingame` once with Steam up (the runner is typed, not changed). **Done** (checked 2026-10-22): the
  registered server has been restarted on the TypeScript core since (it serves #62/#70's art tools such as
  `export_svg`), and `npm run test:ingame` has run green many times since #44.

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
- [x] **Keep a copy of the current exe** at `.analysis/exe/25143593/Mewgenics.exe` — was done 2026-10-19 (sha256
  `4127cd6a…`) but the worktree-junction wipe of 2026-10-19 took `.analysis/exe/` with it (checked 2026-10-20: the
  dir does not exist). An agent redoes the copy with the decompile rebuild (queued); redo it yourself before every
  Steam update: the anchors are committed, the binary is not, and the self-port/harvest tests need it once the
  install moves on. **Back since 2026-10-20** (decompile rebuild, #57; present 2026-10-22). The "redo before every
  Steam update" part is a standing step of a port, not an open box.

### Decisions
- [x] **`sigCap` / `FW_SIG_MAX_BYTES` stays at 128** (owner, 2026-10-19): wait until a port actually reports a pattern
  over the cap, then raise `fw_sig.h` + `native/framework/test/test_sig.c` together (`docs/binding-port.md` "Known
  limits"). Nothing needs more than 86 bytes since 2026-10-22 (`Status_GetCategory`'s 126-byte pattern is gone).
- [x] **One DLL per build** (owner, 2026-10-19): the manifest set and `signatures.h` carry only the current build;
  `offsets.h` stays shared `#define`s and the generator keeps refusing mixed manifests.
- [x] **SDL version policy**: when `port_bindings` reports the 8 SDL slots as `needs-human` (SDL version changed), the
  DYNAPI slot order must be re-verified by hand (`SDL_dynapi_procs.h` of that SDL version) before trusting the indices. Standing rule, recorded in `docs/binding-port.md` "Known limits"; acts only
  on an SDL upgrade.
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
- [x] **A `proposed` struct offset is never applied by the tool**: when a port reports one, apply it only with
  `--resolve Name=0x..` after a green `npm run test:ingame` that exercises it (`docs/binding-port.md` "The ladder").
  Standing rule, enforced by the tool and recorded in `docs/binding-port.md` "Known limits".

### Known gaps you are accepting for now
- [x] 46 entries (40 struct offsets — the 32 of the cross-build run plus the 8 added for dev scenes and the RNG on
  2026-10-20 — and 6 vtable slot constants) are still `unanchored`: every port reports them as `needs-human`
  instead of guessing. Follow-up below ("Witness patterns for the 46 unanchored entries"); agent work, queued.
  **Closed 2026-10-20** (PRs #53–#56; ticked in the 2026-10-21 docs sweep): every entry is anchored; the witnesses
  are verified on the installed exe, not yet on a second build.
- [x] A changed arity of the 13 status lookups (shapes A–E in `status_engine.c`), a compiler/CRT change (`MsvcString`
  layout, `_Allocate<16>`), or a changed vtable layout cannot be ported mechanically; the port will say so.
  Accepted gap, recorded in `docs/binding-port.md` "Known limits".


## Done
- [x] **Maps, rooms and encounters** (2026-10-22, branch `feat/rooms-and-encounters`): `.lvl` codec (all 2361
  vanilla levels round-trip), validator rules for a mod's levels and maps, `new_from_template` kinds `room` and
  `tileset-variant`, `mods/_roomprobe` proven in-game (new room + new spawn id, nested-name search, new tileset). Docs:
  `data-mods.md` "Maps, rooms and encounters", `engine-map.md` "Maps, rooms and level files".
  - [x] **Room editor** (2026-10-22, branch `feat/room-editor-ui`, stacked on the rooms PR): the web UI's Rooms mode
    (10x10 grid painter, tile/object palettes from tiles.gon/spawns.gon + the mod's overlays, weighted random lists in
    the inspector, live `lvl-*` findings, New room from the `room` template, byte-identical save under `levels/**`)
    and MCP `read_level` / `write_level`. Docs: `editor-ts-react-plan.md` "Rooms mode", `data-mods.md`.
    - [x] Tileset art in the swatches (2026-10-22, branch `feat/room-editor-tile-art`): tile/spawn id → clip in the
      chosen tileset → frame-1 PNG thumbnails (`/api/level-tile-art`, cached in `editor/data/level-art/`), an **Iso** view
      (2:1 diamonds, feet-registered sprites, x+y order); swatches stay the fallback with a named reason.
      `editor-ts-react-plan.md` "Tileset art and the Iso view", `engine-map.md` "Tile art".
  - [x] A **campaign** battle node draws a mod room from a map pool — OBSERVED 2026-10-22 (branch
    `feat/harness-campaign-walk`): the harness walks a run with `run start` / `run travel battle` / `run fight`
    (MewDirector::GoOnAnAdventure debug start → MapScreen::EnterNode → StartMapBattle), `_roomprobe/walk-battle` drew
    `levels/alley/walkprobe/wp_alley.lvl` (the vanilla control `levels/alley/easy/ch1-82.lvl`). Docs: `engine-map.md`
    "Campaign walk", `ingame-testing.md` "Campaign walk".
  - [ ] Open: a new map behind alley's exit (`next_map`) — needs a `run travel exit` + the next map's load (EnterNode
    type 3 runs a cutscene lambda 0x39c8f0, not decoded); node rewards after the fight; the class chooser (the debug
    start skips it).

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

- [x] **Component key schema** (2026-10-22, branch `feat/component-schema`): `editor/component-schema.json` maps the GON keys
  each of 1741 component classes reads (RE runs compA..compE; `docs/data-mods.md` "Component keys"); validator
  `unknown-key` / `missing-required-key`, MCP `search_components` keys, web key hints, `npm run build:component-schema`.
  Follow-ups: the 39 vanilla-used components still `open` (their `vanillaMissed` keys are mostly in unlocated lambdas;
  `FinalBossHitCountdown` base has no vftable row), `AddAdvantageToEvent` unresolved, 369 tier-3 classes carry
  only objdump seed keys.
- [x] **Shipping a mod** (PR feat/mod-packaging, 2026-10-22; `docs/data-mods.md` "Shipping a mod"): `mods/<name>/mod.json`
  (+ validator `manifest-missing` / `manifest-invalid` / `manifest-build-mismatch`), `npm run pack -- <mod>` / MCP
  `pack_mod` / web *Export…* (SWF build, validate-or-refuse, zip minus `tests/` + `art/`, `README-INSTALL.txt`,
  `MANIFEST.sha256`), `npm run pack -- --install <zip>` / MCP `install_mod` / web *Import mod…* (traversal, size,
  manifest, checksum, build-mismatch checks; never overwrites). Hand-written zip writer + the shared reader in
  `src/core/zip.ts` (Node built-ins only).
  - [x] Follow-up: `mod.json` for the sample mods (PR feat/sample-mod-manifests): `dev-sandbox`, `fw-glow`, `jokers-luck`,
    `swf-gate` (every non-`_` folder; the `_` test-only mods carry none — data-mods.md "Shipping a mod"); T2
    `jokers-luck/smoke` + `dev-sandbox/console-smoke` pass with the file present; each packs.
  - [x] (done by PR #110) Follow-up (pre-existing, seen while packing): the validator reads `tests/*.mewtest` as whole-file overlays and
    warns `whole-file-replace` for each script; skip `tests/` (and `art/`) in `collectOverlays`.

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
- [x] **Sounds and music for data mods** (2026-10-22, `feat/audio-mods`): RE session `audio` (`.analysis/notes-audio.md`) + T2 `mods/_audioprobe` (3 scripts: replaced `pickup_coin.wav` +24000 vs vanilla +44714, new mod-only group +35280, absent file +0, a mod character loading the new file). Editor: audio index (`npm run build:index` → `editor/data/audio-index.json`), validator `sound-missing` and 9 other audio codes, `list_base_data` `sounds`/`music`/`sound_files`, runner-side `expect deltas`. Docs: data-mods.md "Sounds and music", engine-map.md "Audio". Open: music/ambience replacement and a new voice set not run in game; no `expect sound <group>` hook (the memory counter made it unnecessary).
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
   - [x] Follow-up 2026-10-22 (`fix/extracted-env-paths`): #77's "palette.ts / Ruffle list" note
     (`art/palette.ts` read `<repo>/.extracted/textures`, the Ruffle tab's vanilla list `<repo>/.extracted/swfs`)
     and #83's "build:index writes `editor/data` into the worktree" report (it already wrote to `DATA_CACHE_DIR`;
     the report was a run without `MEWGENICS_EDITOR_DATA`; now pinned by a test): every game-data / cache path goes
     through `repo.ts` `EXTRACTED_ROOT` / `extractedPath` / `vanillaSwfDir` / `DATA_CACHE_DIR`, so
     `MEWGENICS_EXTRACTED_DATA` + `MEWGENICS_EDITOR_DATA` are the whole worktree setup.
8. [x] **Golden merge cases** (owner 2026-10-20: "tdd 8 - ok" — the "golden through `dump`" sub-item is approved and
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
     (`run-tests.ts` 4d, incl. `speed.add 10` → 15).
   - [x] numeric `.add` / `.multiply` in-game (2026-10-22): the `1hp` lambda gave `OFF_CH_HP` (+0x4b0) and
     `Character::init` the stats (+0x5a0..) and the merged entry pointer (+0x240, `docs/engine-map.md` "GON at
     runtime"); the harness's units event carries `hp` / `shield` / the seven stats / `namekey`, and `expect gon
     <unit> <path> <op> <value>` walks the merged entry itself. `tests/numeric.mewtest` vs `numeric-vanilla.mewtest`
     pin `health.multiply 2` → `properties.health` 12 / `hp` 12 (vanilla 6) and `speed.add 10` → `stats.speed` 15 /
     `speed` 15 (vanilla 5); fixtures `result-golden-numeric{,-vanilla}.jsonl`. Found on the way: `Character+0x248` is
     the `graphics.name` loc key, not the entry name (the entry name's home is still unknown). Target 8 is complete;
     `.append` on an existing key (duplicate children) stays untested in-game (indexed in "Still open (agent-doable)").
   - [x] effective stats in-game (2026-10-22, `feat/harness-effective-stats`, stacked on #104): the units event's
     `effective` block (`Character+0x5bc..` + max HP `+0x4bc`, written by `Character::recompute_stats` 0x102520, found
     through the RTTI of its std::function lambdas) and `expect unit <unit> <stat>.effective|maxhp.effective <op> N`.
     `mods/_effective-stats/tests/effective-luck.mewtest`: LuckUp 3 on a Rat → luck 5 / luck.effective 8, the data glow
     `FwGlow_ff00ff` → luck.effective 5 (the #104 regression, now asserted); fixture `result-effective-stats.jsonl`.
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
- [x] **`-savesuffix` gives no save isolation on this build** (finding of the decode above): a dev launch that enters a
  Steam-cloud slot would write the real `steamcampaign0N.sav`. The hash check catches it after the fact; decide whether
  dev play should go through `test00.sav` only (test director) or a copied slot, and whether to ask the developer what
  the suffix is meant to do. Harness side settled 2026-10-20: scripted meta-flow tests use the disposable
  `mewtest01.sav` (`enter Campaign`, moved aside per run); the human dev-play policy is still yours — tracked as the owner item "Dev-play policy after the save-suffix
  decode" above (2026-10-22: this box is the finding, recorded in `docs/engine-map.md` "Save safety").
- [x] **`FrameBegin` signature on a future build** — 2026-10-22: the 19 generic prologue bytes are replaced by a body
  window from +45 (86 bytes, 4 rip refs masked) keyed on the per-frame defaults FrameBegin stores (`0xffffff09`,
  `0x0be2`, `02 02 02 04`, `05 04 05 02`, `02`; 1 hit image-wide on 25143593), plus `before: ApplicationBase_FrameEnd`
  and `FrameEnd.after: FrameBegin` (`.pdata` 25655 → 25656) as the rung behind it. It lea's no funcsig/file string
  (71 rip refs, all globals — `.analysis/decompiled/ApplicationBase_FrameBegin_0x9b7870.c`). `ApplicationBase_Step`
  stays the fallback hook point; `make-signature --manifest` would regenerate the prologue window, so keep the body
  one by hand (noted in the entry and in `docs/binding-port.md`).
- [x] **Hidden window on other machines**: verified on this PC (NVIDIA, ~180 fps hidden); confirm elsewhere before
  relying on it in CI-like setups. Duplicate (2026-10-22) of the owner check "Hidden window on another machine".
- [x] **In-run console command set**: captured 2026-10-20 after `enter TacticsTest` — 84 commands, pinned verbatim in
  `editor/test/fixtures/ingame/console-tacticstest-listcmds.txt` and listed in `ingame-testing.md`.

### Next, directly queued
- [x] **Validator: `tests/*.mewtest` no longer warn `whole-file-replace`** (#103's hand-back, 2026-10-22, branch
  `fix/validator-mewtest-whole-file`): `tests/`, `art/` and dotfiles are not overlays. Left as is: a NEW pack file
  (`mods/fw-glow/shaders/fw_unit_glow.shader`, no base copy) still warns `whole-file-replace`; a mod whose only pack
  files are build output (`swf-gate`, swfs git-ignored) now warns `mod-empty` until they are built.

- [x] **Particles / VFX from data** (2026-10-22, branch `feat/particles-data`): mapped (`docs/data-mods.md` "Particles and VFX",
      engine-map "Particle systems and effect clips") and proven in-game (`mods/_vfxprobe`: a NEW particles.gon system with a
      mod clip worn through `EliteParticle`, and vanilla `SparkleBuff` re-pointed to a mod clip). Editor: `new_from_template
      particle` / `vfx-ability`, validator `particle-missing` / `clip-missing` / `particle-unknown-key` / `clip-list-missing`.
      Open: run an ability whose `graphics.particle` is a mod clip, and `ParticleBurst` / `global_particles` with a mod
      system, in-game (INFERRED to work: same registry / loader); the web UI has no particle editor (templates only).
- [x] **JokersLuck never merged** (found in #104, fixed 2026-10-22, branch `fix/jokers-luck-context`): apply_status's ctx
  is a Component in every shape and its +0x20 is the Scene, so the merge lookup through ctx+0x20 missed and a second
  JokersLuck built a second object. `fw_walk_apply_existing` walks ctx+0x18; manifest `ApplyCtx_character` ->
  `ApplyCtx_scene`; T2 `mods/jokers-luck/tests/merge-contexts.mewtest` (both shapes, 3 stacks per unit).
- [x] **`jokers-luck/luck-seeded` is no longer deterministic** (OBSERVED 2026-10-22, 4 launches in a row, with this
  branch's framework and with #104's: first rerolls -9/+5/+9/-7 instead of the +10, -2, +3, +9 every earlier run had).
  `jokers_luck.c` calls `srand(GetTickCount())` in DllMain and `rand()` on the game thread; msvcrt keeps that state per
  thread (INFERRED: the test was deterministic only while DllMain ran on another thread). Fix: a per-mod LCG seeded from the
  harness `seed` (or from the game RNG), not the CRT `rand`. `luck-rerolls` (`varied`) still passes.
  Fixed 2026-10-22 (branch `fix/jokers-luck-rng`): framework API v5 `FW_Random(bound)` / `FW_SeedRandom(seed)`
  (splitmix64, `fw_rng.c`, host-tested), seeded from QPC at load and re-seeded by the harness `seed` directive; the
  sample rolls through `jl_roll.c` (host test: same seed, same rerolls) and no longer touches `srand`/`rand`.
  T2 `luck-seeded` now pins 1 -> 5 -> (<0, Webster 8, Christine 7), identical on two runs.
- [x] **`.mewtest` numbers cannot be negative** (found 2026-10-22, `fix/jokers-luck-rng`): `expect stacks X on 0 == -10`
  was a script error, so `luck-seeded` could only assert Wengar's round-3 -10 as `< 0`. Fixed 2026-10-22
  (`fix/harness-negative-numbers`): `expect stacks` takes a signed integer in both parsers (`mt_script.c` parse_int,
  `script.ts`), as `expect unit` and `expect gon` (`-0.5`) already did; host tests on both pin `-`, `--1`, `- 1`,
  `1-` as errors. `luck-seeded` now pins round 3 as Wengar `== -10`, Flint `== -6` (T2 pass).
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
- [x] Ruffle (WASM) dependency for previewing *vanilla* SWFs in-editor — **approved in principle**. Still goes through
  the skeptic dep-gate (source review, no injection, vuln scan) and the owner's explicit per-install go before anything
  is added to `editor/package.json`. **Done in #59** (2026-10-20): dep-gate in the PR body, install approved
  2026-10-20, `@ruffle-rs/ruffle` vendored at build time.
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
- [x] Animation-clip authoring workflow (DefineSprite timelines end-to-end) once the emitter is engine-valid — done in #66
  (Timeline tab, 2026-10-20) and, for cats, #76 (`_Append_CatTest` frames)
- [x] Part-indexed **cat-rig** authoring UI (model already supports named layers) — done in #67 (Rig tab, 2026-10-20)
- [x] Cat parts in a rig: the import route is closed (2026-10-20: ImportAssets2 entries are never linked; placing one crashes — engine-map "Imports are not linked"). Remaining routes: copy part geometry into the mod (~1 day, frozen copies, redistributes game art) or native swap (several RE sessions). Owner's call. 2026-10-22: the append route (`_Append_CatTest` frame placing a rig with EMPTY slot sprites, experiment A0) works — the game draws the cat's own parts into our frame; the 2026-10-21 crash was the visible non-empty placeholder (engine-map "CatTest and the cat animation clips"). Resolved as data-only in #74 / #76 (see "Open decisions").
- [~] **3D — full true 3D (owner's goal: "put there 3D models, and it will work")**: the buildable plan is
      `docs/possible_3d_work.md` (known facts, remaining unknowns with their next step, the hook table by manifest name,
      phases M meshes / P perspective). Agent-doable next, in order: **M0** pure modules (OBJ/glTF loaders, JSON, 3D math,
      the std::function-in-C, GL state save/restore, shader dialect; files and red tests in `.analysis/notes-r3dF.md` §6)
      → **M1** a cube on a tile (functor through `Batch_SubmitFunctor` from a `Camera_RenderOneLayer` post-hook, T2 shot)
      → **M2** depth against sprites → **M3** assets + `FW_Register3DObject` + GON `model` / `render3d {}` →
      **M4** palette shader → P1..P6. Phase 0 done 2026-10-22 (branch `feat/3d-investigation`): the 3D block in the
      manifest, the `MEWFW_OBSERVE3D` observer, its T2 run pinned in `editor/test/fixtures/ingame/observe3d-log.txt`.
- [ ] Animation-clip authoring workflow (DefineSprite timelines end-to-end) once the emitter is engine-valid
- [ ] Part-indexed **cat-rig** authoring UI (model already supports named layers)
- [ ] Cat parts in a rig: the import route is closed (2026-10-20: ImportAssets2 entries are never linked; placing one crashes — engine-map "Imports are not linked"). Remaining routes: copy part geometry into the mod (~1 day, frozen copies, redistributes game art) or native swap (several RE sessions). Owner's call. 2026-10-22: the append route (`_Append_CatTest` frame placing a rig with EMPTY slot sprites, experiment A0) works — the game draws the cat's own parts into our frame; the 2026-10-21 crash was the visible non-empty placeholder (engine-map "CatTest and the cat animation clips").
- [x] Clip authoring (Timeline tab, timeline-edit.ts) and the cat rig (Rig tab, cat-rig.ts) — 2026-10-20, art build-out G + H; the game drives a character's root timeline, units are tinted by position
- [x] Emitter (all four done: #63, #64, #69, #65): ~~gradient fills~~ (done 2026-10-20, art build-out C: gradient.ts, gate `gradient`, probe square drawn in-game), ~~LineStyle2~~ (done 2026-10-20, art build-out E: DefineShape4, stroke.ts, gate `shape4`, caps honoured in-game), ~~fonts/text~~ (done 2026-10-21: DefineEditText in a game font class + ImportAssets2 fonts.swf, like vanilla; drawn in-game), ~~PlaceObject3~~ (done 2026-10-20, art build-out F: blends load and apply in-game; filters crash the game and are a validation error)
- [x] MCP tools for art (so agents can author art, not just data) — done in #62 (16 → 23 tools, 2026-10-20), then
  `export_svg` (#70), `bake_glow` (#80), `vectorcraft_exec` (#89)
- [x] External vector editor round trip (2026-10-21): VectorCraft (github.com/storytold/vectorcraft) is a static vector editor without timeline or player, so it edits single shapes through plain SVG — Export SVG / Replace… on Shapes rows, MCP `export_svg`, `svg-export.ts`; animation stays in the Timeline tab
- [x] Testing frontier from `automation-feasibility.md`: AI-brain auto-resolve to smoke-test mods in a real fight (tiers B/C) → now TDD targets 1–3 above; an IPC action layer (tier D) → the named-pipe mode in target 12 (done: #43–#46, #52)

### Raster art and fonts — follow-ups (PR #124, 2026-10-22)

- [ ] **Cat ramp frame in-game:** `render-raster-cat` shows ArtProbeRasterCat (and A0's ArtProbeCatReal spawned first
      in the same script) in the vanilla idle, not the appended frame, though A0's own `render-cat-append` still passes.
      Find what makes the appended idle show (spawn order, a hit / turn re-playing idle?), then read the gray ramps
      (`measureCatRamp`) to move "gray texels are remapped on a cat" from shader source to in-game OBSERVED.
      2026-10-22 (multi-append PR): the appended frame does play on a fresh spawn. A0's marker at clip y −330 is off the
      top of the screen for a back-row cat, so "vanilla idle" was the marker out of frame (engine-map "Several mods
      appending to one clip"). Re-run with the ramp placed lower (or the cat further forward), then measure.
- [x] **Two mod SWFs exporting `_Append_CatTest`** (2026-10-22, `npm run test:artprobe -- --multi-append`): they coexist in
      either `-modpaths` order. A label both define resolves to the later mod (Swf_Merge's label store at 0xa58a23). Two
      mods shipping the same `swfs/<name>.swf` load only the later file. Validator: `validate_mod { modpaths }` →
      `cat-append-conflict`, `swf-file-conflict`, `cat-append-shadows-vanilla`, `swf-file-shadows-vanilla`. The #124
      observation was A0's marker off screen. Optional native follow-up: log label overwrites at 0xa58a23.
- [ ] **TTF/OTF → scene.fonts:** a font importer (cmap + glyf quadratic contours, pure TS) so modders need not draw
      glyph paths by hand.

### Open engine unknowns to resolve
- [x] **GON pre-pass (`//`, `/* */`, `#include`)** — located 2026-10-22 (RE session `inc`, `.analysis/notes-inc.md`):
  `Gon_Preprocess` 0xa50bd0 (comments 0xa4eb80, includes 0xa4edf0, `#define` macros 0xa4f4a0/0xa501c0), includes resolve
  against the loaded resource's directory as a `TextResource` (overlays on the included name concatenated as text),
  a miss is fatal. Editor port: `gon/preprocess.ts` + `gon-includes.ts`, validator `include-missing` /
  `comment-unclosed`, merge preview inlines includes (`docs/data-mods.md` "Comments and `#include`").
  Follow-ups closed 2026-10-22 (RE session `inc2`, `.analysis/notes-inc2.md`; `feat/gon-include-followups`): a mod
  `#include`s a file it ships — OBSERVED in-game (`mods/_incprobe`, T2 pass); include names are never normalised
  (pack = exact lower-cased string, loose = `<modpath> + name` through the OS) → validator `include-path-unsafe` for
  `..` / `.` / empty segments / leading `/` / drive letters / backslashes; `#define NAME(a, b) … #end` / `#NAME x y`
  derived from 0xa4f4a0 / 0xa501c0 / 0xa4e0b0 and ported (`gon-define-unmodelled` replaced by real expansion and
  `gon-macro-runaway`), in-game check for a two-argument macro.
- [x] Exact SWF-format + `_Append_`/SymbolClass convention the loader requires — binding needs no DoABC; `_Append_<Target>` merges at boot; an unknown target stalls the boot (OBSERVED 2026-10-19). **Display path closed 2026-10-21** (RE session `disp`; `docs/engine-map.md` "SWF loader and display path"): the complete tag switch of `createTag` 0xa2e990 (DefineFont 1/2, a second DoABC, PlaceObject3 filters, an over-page bitmap are FATAL; scaling grids, morph shapes, PlaceObject1 cxforms, imports are skipped), even-odd per fill style, cxform after the palette remap, pad-only gradients, by-name lookup last-loaded-first, the `tilesets.gon` clip-name remap. Editor rules: `swf-rules.ts` + `scene.ts` codes `font-tag-unsupported`, `abc-count`, `bitmap-too-large`, `scaling-grid-ignored`, `gradient-spread-ignored`, `morph-shape-skipped`, `place-cxform-ignored`, `fill-rule-ignored`, `export-shadows-vanilla`, `jpeg-bitmap`, `tag-ignored`. Still open: LineStyle2 joins / miter / hairline in the outline builder, the font-class → font lookup RVA, the `tilesets.gon` redirect in-game (INFERRED).
- [x] RNG seeding for deterministic test runs — done 2026-10-20 (target 12, PR #48): `seed <N>` pins `TLS+0x178`
  through `Rng_SeedState` once the game's startup is over; `luck-seeded.mewtest` asserts exact values run to run.
- [x] Headless / startup-macro mode — solved by the harness (in-process console execution + hidden window), not by the game
- [x] Verify the INFERRED preview behaviors (nested-sprite framing, cxform-after-remap, engine fill rule, bitmap sampling) — done 2026-10-21: all four OBSERVED (nested sprites own-clock: in-game + `MovieClip::update` 0x9a8720; cxform after the remap: `paletted_full.shader`; fill rule even-odd per style: `tessTesselate` 0xa73bb0; bitmap sampling by fill type, 0x41 = LINEAR + clamp: `swf_lib.shader`) and the preview follows them (`engine-behaviour.ts`, `art-engine-rules-tests.ts`). Remaining preview unknowns: LineStyle2 joins / miter / hairline, the blend modes other than normal / layer / multiply / add / overlay / erase (drawn normally in-game — INFERRED), the `per_file_curve_resolution` tolerance.
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
- [x] **Witness patterns for the 46 unanchored entries** (40 struct offsets, 6 vtable slot constants) so the port stops
  reporting them as `needs-human`; the witness function + byte pattern per offset, verified by `harvest.ts`. The
  second witness for `LuckUp_typeid` (the `mov r8d, imm32` before `Entity_FindComponentsByTypeId` in
  `Status_ApplyLuckUp`) landed in PR #32; harvest and port now require every source of a constant to agree.
  Done 2026-10-20: offset witness harvest (#53), batch 1 — 19 harness/app/scene offsets (#54), batch 2 — 21
  status_engine offsets (#55), the six vtable-slot constants derived (#56); nothing in the manifest is unanchored.
- [x] **Runtime anchor locator in the DLL** (optional): string → lea xref → `.pdata` so anchored-but-unsigned entries
  survive a relink before anyone runs the port. **Dropped** by owner decision 2026-10-19 (see "Decisions").

## Still open — index (2026-10-22 sweep)

Every unticked box below "Requires a human (T3 looks)" is open; this is the short list of them, plus the open
leftovers that live inside ticked items. The boxes stay where they are (history kept); tick them there.

### Still open (agent-doable)
- Cat animations not authored yet: the back facing's `head_back` layout and the four-way `LF/RF/LB/RB` quartet
  ("Open decisions" → "Cat parts in a rig").
- `.append` on an existing key (duplicate children) in-game (TDD target 8's last gap).
- SWF display leftovers: LineStyle2 joins / miter / hairline in the outline builder, the font-class → font lookup RVA,
  the blend modes other than normal / layer / multiply / add / overlay / erase, the `per_file_curve_resolution`
  tolerance ("Open engine unknowns").
- Bindings: follow chained `.pdata` chunks in `readOffsetWitness`; the callee-set rung (not needed by any entry today)
  (`docs/binding-port.md` "Known limits").
- Watch for the one-off early exit ("Verification still owed").

### Still open (owner)
- Native per-unit glow — what next? (a data-level way to ask for it; the hover rim while units glow) — "Open decisions".
- Hidden window on a non-NVIDIA machine; dev-play policy after the save-suffix decode; eyeball the saves dir after a
  dev run; watch one clean-mode run end; a fuller `debug.log`; the optional `gh pr merge` permission rule; the merge
  policy for autonomy — "Owner checks".
- Re-fetch build 23372843 (and optionally rerun the cross-build); a body-changing second build to exercise the port
  rungs on a real recompile.
- Remove the leftover agent worktree `agent-ac7ac5f970624f89d` safely (junctions first).
- `FW_API_VERSION` bump policy for new `FW_SYM_*` / `FW_DATA_*` entries; does the `port-bindings` skill trigger on
  "the game updated"; read `docs/binding-port.md` once as the next porter — "Owner checklist".
