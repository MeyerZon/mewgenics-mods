# Possible 3D work — action list

Work plan for drawing Mewgenics through a real camera (floor flat, sprites billboarded, board
orbitable, 3D mods possible). Same conventions as `TODO.md`: `[x]` done · `[~]` in progress ·
`[ ]` planned. Each item says **what** to do, **why** it is needed, and **what it takes**. Evidence
and addresses are in [`3d-rendering-feasibility.md`](3d-rendering-feasibility.md) (§6 hook table) and
the git-ignored `.analysis/rea-renderer-report-2026-10-18.md`. Everything here is native work on
`mewframework.dll`, pinned to build 25143593, fail-closed on any other build, dev save only.

Status as of 2026-10-18 (evening): research done including a second Ghidra pass (z range, frame
model, FBO format, cameras, picking, cull/autoflip); nothing built. **Chosen target: true
perspective + genuine 3D meshes** (phases 2–3); phase 1 stays the cheapest way to validate hooks
and classification on the way there.

## Done

- [x] Spatial model: gameplay is strictly 2D (`spatial-model.md`)
- [x] Renderer RE: mvp composition, iso matrix, camera, sort, depth, GL table, shadow placement
      (`.analysis/decompiled/r3d_*`, 108 functions)
- [x] Board geometry measured from vanilla art (2:1 diamonds, feet-registered sprites)
- [x] Prior-art survey (Helix/geo-11, 3dSen, Stardew 3D, Don't Starve, Flash 2.5D, billboard math)
- [x] Feasibility write-up with design levels A–D and hook table
- [x] Ghidra pass 2: pixels→clip base matrix and z range, single-threaded record/replay frame model,
      D24S8 MSAA scene FBO, camera defaults (zoom 60, flip −1) and the three combat cameras, the
      single picking helper, cull-disable counter, autoflip rule, tile = floor(world) OBSERVED
      (`.analysis/rea-renderer-report-pass2-2026-10-18.md`, `.analysis/decompiled/p2_*`)

## Phase 0 — confirm the unknowns (days)

- [ ] **Sign the hook functions into `bindings/25143593.sig.tsv` + `signatures.h`.**
      What: `FUN_14078d600` (iso local mat4), `FUN_1409b4c90` (plain mat4), `FUN_1409b4a30`
      (interpolated transform), `FUN_1409785e0` (camera VP), `FUN_1409787c0` (Camera::render),
      `FUN_14078d480` (iso depth key), `FUN_1409896f0` (layer render), `FUN_140a47e50` (instance
      writer), `FUN_1409b0a50` (DisplayObject render). Data: ISO `0x1412f7a00`, ISO⁻¹ `0x1412f79c0`,
      state flags `0x1412f714c`, mat stack `0x1413c5bd0`, GLEW table `0x1413bc370`.
      Why: the framework only activates on a verified build; code addresses are pattern-scanned, data
      addresses live in `BuildInfo` and are sanity-checked (e.g. ISO m0 ≈ 0.8944).
      Takes: `tools/make-signature.mjs` runs; copy full unique lengths (lesson from the status engine).
- [ ] **Log a few instance records in-process.**
      What: observer hook on `FUN_140a47e50`, dump 10 mat4s + depth_bias to the framework log, once.
      Why: confirms the column-major layout and m14 = 0 for iso objects in a live frame. The z
      mapping itself is now known statically: `window z = 0.5 + 0.5e-4·z_view`, range ±10 000.
      Takes: one `MJ_InstallHook` observer, a dev-save launch, no behaviour change.
- [ ] **Identify the scene camera at runtime.**
      What: log layer bitset (+0xc8), RTT flag (+0x80), HDR (+0x81), zoom (+0x168), flip (+0x170) and
      sort order (+0xa0) for every `Camera::render`; also log `DAT_1413c6d88` and what
      `FUN_1401b1070` returns during a fight.
      Why: the combat scene builds three cameras (RTT+HDR, transform scale 1.15, UI on layers
      0x25..0x30); the perspective hook must fire for exactly one of them. Defaults are zoom 60 /
      flip −1, but `zoomer` / `camera_bounds` GON may change them.
      Takes: observer hook on `FUN_1409787c0`; one fight on the dev save.
- [x] ~~Dump a tile transform to confirm tile = world~~ — OBSERVED statically in pass 2: the tile
      picker `FUN_1408abc50` takes `floor(world x), floor(world z)`. Still worth one log line to see
      whether tile centres sit at `col + 0.5`.
- [ ] **Decide the classification mechanism.**
      What: pick between (a) entity component type (`TacticsTile`/`Shadow` → floor, `Character`/
      `TacticsObject` → standing), (b) render layer index (renderer+0x54), (c) a GON `render3d {}` key.
      Why: floor vs standing is the one thing the matrices cannot tell us; getting it wrong draws
      cats lying on the ground.
      Takes: start with (a)+(b) for the PoC; (c) is phase 2 (editor-validated).

## Phase 1 — orthographic orbit proof of concept (~1 week)

- [ ] **Camera state + input.**
      What: yaw/pitch/zoom struct in the framework; mouse wheel = yaw (or zoom with a modifier),
      drag = pitch, key = reset to 45°/30°. Yaw stepped or clamped to ±45°, pitch clamped to 20–60°.
      Why: free spinning breaks the left/right-only sprite facing and tires the eye (Stardew 3D
      reviews); Don't Starve's 45° steps are the proven model.
      Takes: SDL3 DYNAPI event hook (the framework already hooks DYNAPI slots) or ImGui input; must not
      swallow events the game needs.
- [ ] **Per-frame rewrite of ISO and ISO⁻¹.**
      What: before `RenderCore::render`, write the rotated orthographic basis into `0x1412f7a00`
      (x → (cos y·k, sin y·sin p·k), z → (−sin y·k, cos y·sin p·k), height → (0, h)) and its inverse
      into `0x1412f79c0`. At the default angle it equals the vanilla matrix bit-for-bit.
      Why: this one data write moves every consumer at once: iso renderers, `Shadow` placement,
      `camera_to_world`, and the 23 picking/preview sites. No projection pipeline is needed because
      a rotated orthographic ground view is still a 2D affine map.
      Takes: a frame-begin hook (community `ApplicationBase::FrameBegin` or our `Camera::render`
      hook); restore vanilla values when the mod is disabled; keep the inverse exact.
- [ ] **Floor un-skew hook.**
      What: in `FUN_14078d600`, for floor-class entities, pre-multiply the object's output by
      `ISO_vanilla⁻¹|ground` (diamond art → unit square) and then by the current ground basis.
      Why: tile art is pre-drawn as 2:1 diamonds; without this, tiles move with the camera but keep
      their old diamond shape. At the default angle the correction is the identity.
      Takes: the classification from phase 0; the maths is a 2×2 affine; `Shadow` already does the
      equivalent for its `shadow` child, so the engine's convention is known.
- [ ] **Scene-camera filter.**
      What: in the `Camera::render` hook, apply the rewritten basis only while the scene camera
      renders (pattern from phase 0), never for the UI camera.
      Why: the ISO globals are process-wide; UI floaters and menus that inline the iso projection must
      keep the vanilla values. Rewrite before the scene camera, restore after.
      Takes: two writes per frame around one camera.
- [ ] **Sort-key hook.**
      What: replace `x + z` with `dot((x, z), ground forward)` in `FUN_14078d480` and the two inlined
      copies (slots 6 and 19 of RendererIso), or install a layer key functor (layer+0x60).
      Why: painter's order must stay back-to-front when the board turns; the engine's key is only
      correct for yaw 45°.
      Takes: three small hooks, or one functor swap; keep `depth_offset` as a bias on the new key.
- [ ] **Height factor.**
      What: set the ISO height column to `h = 1.0` at default (the engine's 0.913 squash relative to
      a consistent camera) and decide whether to blend toward `k·cos(pitch)` as the pitch changes.
      Why: pixel identity at the default view; a style choice beyond it.
      Takes: a constant; expose as a setting.
- [ ] **Shader uniform check.**
      What: verify `camera_to_world` (`FUN_14078f820`) and `camera_mat` (`FUN_140891300`) pick up the
      new basis automatically; patch via `-modpaths` only if not.
      Why: ground lighting and water texture mapping are computed from these.
      Takes: visual check on a water map and a cave (lighting) map.
- [ ] **Acceptance.**
      What: screenshot diff vanilla vs mod at 45°/30° = empty; rotate ±45° and tilt: cats stand on a
      flat diamond grid, shadows and targeting previews follow, hover/click picks the right tile.
      Why: the "preserve original look if set correctly" requirement is the whole point.
      Takes: a dev-save fight, two screenshots, a pixel diff script (plain node).

## Phase 2 — perspective, robustness, data model (1–2 months)

- [ ] **Perspective camera path.**
      What: hook `FUN_1409785e0` for the scene camera only; return `P_persp × lookAt` in the
      1280×720 virtual-pixel convention with view z scaled into the ±10 000 range the base ortho
      maps (`m10 = 1e-4`); keep `det(VP) < 0` (flip −1 convention) so the autoflip
      (`FUN_140a082b0`, det < 0 test) does not mirror everything; keep `cam+0x168` constant so
      `FUN_14097ad80` does not rescale every SWF root per frame. In `FUN_14078d600` emit
      `(x, height, z)` into m12/m13/m14 with an upright billboard basis.
      Why: the Octopath/HD-2D look; also what makes real meshes read as 3D.
      Takes: the scene-camera pattern from phase 0; optionally hook `FUN_1409fec80` to change the z
      scale if 24-bit depth over ±10 000 proves too coarse.
- [ ] **Disable the 2D screen-space cull.**
      What: keep the cull-disable counter `DAT_1413c5c90` non-zero (add a large value once; the
      engine's inc/dec pairs are balanced), or hook `FUN_1409b0a50` to divide by w.
      Why: the cull transforms the bbox by the affine part of the matrix and ignores w, so under
      perspective it culls wrongly and objects pop.
      Takes: one data write (data-only fix) — minutes, plus a check that nothing else reads the
      counter.
- [ ] ~~Per-object tessellation LOD~~ → **Distance-dependent sprite sizing (optional).**
      What: pass 2 showed `FUN_14097ac40` is not an LOD: it sets the SWF root scale to
      `(1/zoom, flip/zoom)`, cached per renderer. If perspective makes near sprites look polygonal,
      apply extra scale in the model matrix, not via zoom.
      Why: changing zoom per object thrashes the root rescale; no per-frame curve LOD exists.
      Takes: nothing unless the look demands it.
- [ ] **Depth test for scene layers.**
      What: set bit 1 of `DAT_1412f714c` (state applier `FUN_140a497d0`; bit 3 = colour+depth mask)
      while the scene camera draws; write one depth per object (anchor); keep `depth_bias` for
      sub-shape layering (one unit = 20 view-z units). FrameBegin resets `depth_bias` and the camera's
      RT is cleared COLOR|DEPTH|STENCIL on bind.
      Why: needed for meshes to intersect/occlude billboards; optional for sprites alone.
      Takes: a flag toggle around the scene camera; verify no vanilla type-1 layer relies on the
      default-off state.
- [ ] **Ray picking via the single helper.**
      What: hook `FUN_1409796d0(Camera*, double out[2])` (mouse → camera-2D, 32 callers): cast the
      mouse ray from the perspective camera, intersect the ground plane, and return the **iso-2D
      equivalent** `(a·x + c·z, b·x + d·z)`. Every ISO⁻¹ consumer (tile picker `FUN_1408abc50`, AOE
      origin, cursor tile) then yields the right tile unchanged.
      Why: a perspective ground map is a homography, so the global-matrix trick stops being exact;
      pass 2 found that all screen→world picking funnels through this one function.
      Takes: one hook plus ray maths. World→screen has no shared helper (inlined at ~12 sites), but
      world-anchored objects drawn by the scene camera are correct automatically; only screen-space
      overlays that inline the iso projection (`FUN_14010eef0`, `FUN_1401571f0/78b0/7f40`,
      `FUN_14016c700`, … unclassified) may need attention — classify them in-game first.
- [ ] **Screen-space shader patches (data layer).**
      What: `ground_lighting.shader` (`/w` after `camera_to_world`), `water*.shader` (reflections
      toggle), `textured_tile.shader`, `shadow_occluded*.shader`, shipped as `-modpaths` overrides.
      Why: they assume a flat 1280×720 screen.
      Takes: GLSL edits; the engine does not prepend `#version`, files carry `#version 150`.
- [ ] **Per-asset `render3d {}` GON classification.**
      What: `render3d { mode floor|billboard|upright|screen; offset [x y z]; tilt 0 }` on tiles,
      characters, static objects, particles; the editor validates it (new schema entry + check).
      Why: entity-type heuristics will misclassify some art (floating tiles, flat props, tall tiles);
      data mods need to declare their own.
      Takes: editor schema + validator work in `editor/src/core/`; framework reads the key via the
      existing GON access.
- [ ] **Tall-tile halves and backdrops.**
      What: TallGrass/Bramble/FloatingGlass Back/Front → two billboards at the tile's far/near edge;
      `combat_background` plates camera-locked.
      Why: the halves exist only to fake 2D occlusion; backdrops have no 3D meaning.
      Takes: classification entries; no engine change.
- [ ] **Settings UI + safety.**
      What: ImGui panel (compiled into the game) for mode (off/ortho/perspective), yaw step, pitch
      clamp, height factor, reflections; persisted in the framework's own file, never in
      `settings.txt`; mod active only with `-savesuffix dev` until proven.
      Why: same discipline as everything native here.
      Takes: small; ImGui is already in the exe (`IMGUISceneBase`).

## Phase 3 — genuine 3D mods (weeks, after phase 1; independent of perspective)

- [ ] **Mesh draw hook.**
      What: submit the mesh draw as a `std::function<void()>` through `FUN_140a47820` while the
      frame is recorded (from a `Camera::render`/layer-render/`Renderer::render` hook or a
      `CallbackOnRender` display object, vftable `0x14112ec98`). It replays in `FrameEnd`
      (`FUN_140a481d0`, before `SDL_GL_SwapWindow`) in recorded order with the scene camera's FBO
      `rt+0x1c` and viewport bound. Inside the functor: bind own program/VAO, draw with the current
      view-projection and depth test on, then restore program, VAO, `GL_ARRAY_BUFFER`,
      `GL_DRAW_INDIRECT_BUFFER`, the instance VBO and depth/stencil/blend/mask state (or set the next
      group's force bit).
      Why: everything is single-threaded record-and-replay on the main thread; direct GL calls made
      during recording execute before every batched draw of the frame, i.e. out of order.
      Takes: GLEW table access after `glewInit`; the state save/restore list; the matrix convention
      (virtual pixels, z ±10 000, negative determinant).
- [ ] **Match the scene framebuffer.**
      What: render into the camera's FBO with colour RGBA8 (RGBA16F if `cam+0x81`), depth
      GL_DEPTH24_STENCIL8 **multisampled** at the main RT's sample count; if a later pass needs the
      depth, blit `GL_DEPTH_BUFFER_BIT` before unbind (`FUN_140a29150` resolves colour only).
      Why: the depth buffer is a renderbuffer, not a texture — it can be tested against but not
      sampled, and sample counts must agree or the draw fails.
      Takes: read `rt+0x50` (samples) and `cam+0x81` at hook time; no own FBO needed.
- [ ] **Mesh assets through `-modpaths`.**
      What: minimal OBJ (then glTF) loader; textures as PNG via the existing resource layer.
      Why: mods must ship models as plain files, like SWFs and GON today.
      Takes: a few hundred lines of C; no third-party libs (repo rule).
- [ ] **`FW_*` API + GON binding.**
      What: `FW_Register3DObject(entity|name, model, transform)`, `FW_Set3DCamera(...)`;
      GON `model "models/crate.obj"` on static objects/characters; names registered in
      `editor/registered-names.json` so the validator accepts them.
      Why: this is the seam between data mods and native, same pattern as `JokersLuck`.
      Takes: `framework_api.h` additions (API version bump), editor registered-names support.
- [ ] **Lighting/palette-compatible mesh shader.**
      What: flat/lambert shader that samples the game's `palettemap` so meshes match the paletted
      vector look; optional shadow blob.
      Why: unlit grey meshes next to palette-remapped cats look wrong instantly.
      Takes: shader work; read `paletted_full.shader` for the remap rule.

## Open unknowns (resolve as they block)

- [ ] Pixels→NDC base matrix location (z range for the depth test) — phase 0 logging
- [ ] Scene camera flip sign and zoom — phase 0 logging
- [ ] `TacticsGrid` (col,row) → transform function — phase 0 dump makes it unnecessary for the PoC
- [ ] `glMultiDrawElementsIndirect` call site — only needed for level-A diagnostics
- [ ] How `SetRenderLayer` changes layer +0x54 at runtime — affects classification by layer
- [ ] Whether `depth_offset`'s `(d, 0, d)` also offsets the drawn position — affects the bias mapping
- [ ] Particles: `ParticleSystemDepthSorter` / `DepthTrackingBehindEffect` keys — phase 2 sorting

## Explicitly not planned

- Replacing the SWF renderer (months; forks the art pipeline — levels B/C/D ride on vanilla instead)
- Gameplay verticality (height in rules/LOS/range) — out of scope; see `spatial-model.md`
- Any change to `Mewgenics.exe`, `resources.gpak`, or non-`dev` saves
