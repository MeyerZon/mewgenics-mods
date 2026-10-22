# Possible 3D work — the buildable plan toward full true 3D

Owner's goal (2026-10-22, their words): **"FULL true 3D, so I will be able to put there 3D models, and it will
work."** End state = real meshes (OBJ / glTF shipped by a mod through `-modpaths`) drawn into the tactics scene
through a real perspective camera, depth-tested against the billboarded sprites, picked correctly, shaded so they sit
in the paletted vector look. The orthographic orbit is only a stepping stone, not a deliverable.

Everything here is native work on `mewframework.dll`, pinned to build 25143593 through `bindings/25143593.json`
(the "3D block" at the end of the manifest), fail-closed on any other build, dev save only. Evidence: the RE notes
`.analysis/notes-r3dA.md` … `notes-r3dE.md` (frame model / cameras / iso+picking / RT+shaders / resources), the build
design `.analysis/notes-r3dF.md`, the decompiles they name under `.analysis/decompiled/` (all git-ignored), the T2
fixture `editor/test/fixtures/ingame/observe3d-log.txt`, [`engine-map.md`](engine-map.md) "3D rendering path
(2026-10-22)", and the older [`3d-rendering-feasibility.md`](3d-rendering-feasibility.md) (prior art, design levels).

Tags: **OBSERVED** = decompile / bytes / a live T2 run on this machine; **INFERRED** = reasoned from that; RVAs are
image-relative (base 0x140000000); `Name` in backticks = the manifest entry.

Status 2026-10-22: phase 0 done on branch `feat/3d-investigation` — every function and global the plan hooks or calls
is signed into the manifest (harvest-verified), the log-only observer (`MEWFW_OBSERVE3D=N`) ran in a fight and its
lines are pinned. **2026-10-22 evening (branch `feat/3d-meshes-m1`): M1 done in-game** — a cube and a mod-shipped OBJ
drew in a real fight through a submitted draw functor and the mod shader (`engine-map.md` "Meshes drawn in a fight");
the remaining M work is sprite/mesh occlusion (M2), palette + textures, the per-unit GON `model` walk, glTF in-game.

---

## 1. What is known (the facts the build relies on)

### The frame
- **Record and replay, one thread (OBSERVED, r3dA).** Draws are recorded into the group vector `0x1412f80f0`
  (0x30-byte groups: material +0, VAO +8, flags +0xc, stencil +0xd..0x13, blend +0x14..0x19, mode +0x20, count +0x24,
  functor +0x28) and replayed by `Batch_Replay` 0xa481d0 in FrameEnd (state → shadow copy 0x1412f7160 → functor →
  draw), right before `SDL_GL_SwapWindow`. A pre-group functor list `0x1412f8148` runs first (texture uploads).
- **Inserting our own GL (OBSERVED, r3dA).** `Batch_SubmitFunctor` 0xa47820 `(unused, std::function<void()>*)`:
  allocates a 0x40-byte std::function, calls the argument's impl vtable slot 0 `_Copy(impl, where)` and stores the
  result at `+0x38`, destroys the argument with slot 4 `_Delete_this(impl, impl != arg)`, attaches it to a state-only
  group, pushes a fresh group. Replay calls slot 2 `_Do_call(impl)`. Only slots 0, 2, 4 are used, so a hand-built C
  vtable (`copy`, `move`, `docall`, `target`, `del`, `get`) with ≤ 0x30 bytes of bitwise-copyable captures works.
  While a functor runs `0x1412f80e1` = 1 and a nested submit executes immediately.
- **What a functor must restore (OBSERVED, r3dA).** The applier `Batch_ApplyGroupState` 0xa497d0 always calls
  `Material_Bind`, and re-applies VAO, depth test, stencil, colour+depth mask, stencil func/op and blend whenever the
  force bit (flags bit 0) is set — FrameBegin sets the flags to 0x09 and nothing clears bit 0, so in practice every
  group re-applies them. What it does not re-apply, and a functor must put back or invalidate: `GL_ARRAY_BUFFER` =
  `*(u32*)0x1412f8160` (the instance VBO), `GL_DRAW_INDIRECT_BUFFER` = `*(u32*)0x1412f8164`, the group VAO
  `*(u32*)0x1412f7168`, `glDepthFunc(GL_LESS)` (the game never calls it), `GL_BLEND` on, FBO/viewport/scissor if
  touched; and the caches `0x1413c1980` (last material) = 0, `0x1413c42b8` (glUseProgram cache) = 0,
  `0x1413c19a0[unit]` (texture cache) = 0 for each unit touched, `0x1412f713c` (active unit) = -1. Shortcut: binding a
  mod material through `Material_Bind` keeps those caches consistent.
- **GL entry points (OBSERVED, r3dA, `.analysis/r3dA-glew-slots.tsv`, 2608 GLEW slots ~0x1413bc060..0x1413c11d0).**
  e.g. glUseProgram `0x1413bc5b0`, glBindVertexArray `0x1413bde78`, glBindBuffer `0x1413bc370`, glBufferData
  `0x1413bc378`, glVertexAttribPointer `0x1413bc6e0`, glUniformMatrix4fv `0x1413bc5a8`, glDrawElementsBaseVertex
  `0x1413bd128`, glBindFramebuffer `0x1413bd178`, glBlitFramebuffer `0x1413bd188`; OPENGL32 IAT glEnable `0x140e3f858`,
  glDisable `0x140e3f7f8`, glGetIntegerv `0x140e3f810`, glBindTexture `0x140e3f848`, glDepthMask `0x140e3f898`.
  **glDrawElements and glDepthFunc are not imported**: take them from `GetProcAddress(opengl32)` or
  `wglGetProcAddress` (the r3dF route, which needs no slot rows at all).
- **Instances (OBSERVED, r3dA).** `Batch_AddInstance` 0xa47e50 `(Batch*, mode, vao, firstIndex, count, baseVertex)`
  writes a 100-byte record — mvp = the matrix-stack top, column-major, at +0; colour-transform mul +0x40 / add +0x50;
  depth_bias +0x60 — into the instance VBO `0x1412f8160` (persistent-mapped, 3 × 0x8000 records, CPU pointer
  `0x1412f8120`), attribs 3–9 with divisor 1, merging identical consecutive commands; a full segment forces a mid-frame
  replay. Thousands of calls per frame: not worth an observer hook (the game's own counters `0x1413c1998`… measure it).

### Cameras and the matrices
- **Which camera draws the world, and how (OBSERVED, T2 2026-10-22 + `RenderCore` 0x989020 asm).** RenderCore has
  two camera lists. List 1 → `Camera_render` 0x9787c0 per camera: the **5 RTT side cameras** (layers 0x16, 0x15, 1+3,
  0x18 mask, 0x17 cursor). List 2 → for every layer index × every camera, `Camera_RenderOneLayer` 0x979210
  `(Camera*, int layer)`: the **world camera `TacticsTest+0x68`** and the UI camera (plus other scenes' cameras —
  14 list-2 cameras were alive in the run). Each call pushes `stack top × Camera_GetViewProjection` and draws that one
  layer. So the world is drawn layer-interleaved across cameras, and its VP is pushed once per layer.
- **The VP (OBSERVED, r3dB + T2).** `Camera_GetViewProjection` 0x9785e0 `(Camera*, float out[16])` =
  `K × inverse(Position_GetViewMatrix(cam+0x38, (cam+0x28)->+0x30))`, `K` = (zoom,0,0,0)(0,flip·zoom,0,0)(0,0,1,0)
  (640,360,0,1), zoom = double `+0x168`, flip = int `+0x170` (the y-flip, −1 for world cameras; PR #99 calls it
  `Camera_zoomY`). In the fight the world camera ran at **zoom 78.2624, flip −1** and its VP had m0 = 68.0542 =
  zoom / 1.15 (the camera Position's scale, animated by `TacticsTest` slot 10 0x88d290 during the intro) and a moving
  y translation (664 → 751 → 695): the camera moves through its Position, never through zoom. det(VP) < 0 in every
  frame. 18 callers, incl. `Camera_render`, `Camera_RenderOneLayer`, picking `Camera_MouseToCamera2D` 0x9796d0 and
  `CombatShaders` slot 19 0x891300 (`camera_mat`); K is also inlined in `TacticsTest_LateRender` (twice) and in
  `Lighting::init` 0x78f820.
- **Base ortho and z (OBSERVED, r3dB).** `MatStack_Ortho` 0x9fec80 `(MatStack*, L, R, B, T)`: m10 = 1e-4, m14 = −0,
  then `flags[top] = det < 0`; callers FrameBegin and CombatShaders slot 19. ⇒ `window z = 0.5 + 0.5e-4·z_view`,
  usable |z| ≤ 10 000. `Mat4_IsMirrored` 0xa082b0 (det < 0) negates column 0 for autoflip objects when the sign differs
  from the level flag; `MatStack_Push` 0x9feaf0 copies the flag. Rule: keep det(VP) negative.
- **Root rescale (OBSERVED, r3dB).** 0x97ad80 re-runs 0x97ac40 → `0x9b16c0(root, 1/zoom, flip/zoom)` only when the
  camera's `+0x168/+0x170` differ from the renderer's cached `+0x98/+0xa0`: leave those two fields alone.
- **Gameplay's "scene camera"** `Component_GetSceneCamera` 0x1b1070 = the first enabled Camera in registration order
  (INFERRED in combat: `TacticsTest+0x40`, a side camera that mirrors +0x68 — LateRender copies +0x68's Position into
  the five side cameras every frame). Perspective state must be keyed to the TacticsTest, not to one Camera*.
- `zoomer` / `camera_bounds` are SWF clip names (inventory/house, adventure map), not GON keys. Mouse wheel = zoomin /
  zoomout bindings (r3dE) — but the world zoom did not change in the run.

### The iso projection, sort and picking
- **ISO (OBSERVED, r3dC + T2).** `Iso` 0x12f7a00 (writable `.data`): x column (0.894427, 0.447214), height (0, 1),
  z (−0.894427, 0.447214); `IsoInverse` 0x12f79c0 = the 2×2 ground inverse (0.559017, −0.559017; 1.118034,
  1.118034). Written only by the static initializers 0x140025720 / 0x1400257c0; 19 + 10 reader functions (classified
  in notes-r3dC). **TacticsTest::init copies ISO into the particle core at `+0x190`** (rep movsb 0x140834101) — a
  per-frame ISO rewrite would miss that copy.
- **Model matrix (OBSERVED, T2).** `Renderer_GetScreenMatrix` 0x78d600: m12/m13 = the ISO projection of
  (x, height, z), **m14 = 0**, m0 = ±1 (facing). The T2 unit at world (2.5, 5.5) — a tile centre — had m12 = −2.68328,
  m13 = 3.57771. The same iso math is inlined in the reflection draw 0x78d140 (height × −1) and 0x16c700.
- **Sort (OBSERVED).** `Layer_Draw` 0x9896f0 sorts each layer's 0x20-byte items descending by the key the renderer
  wrote: `Position+0xb0 = z + x + offset_z(+0x118) + offset_x(+0x108)` (`MaskedRendererIso` slot 25 0x78d480, a
  pdata-less leaf, and inlined in slots 6 and 19 when `+0x120`); `depth_offset d` writes (d, 0, d) to the offsets:
  sort only, never the drawn position. Particles copy the same key (`ParticleSystemDepthSorter_Update` 0x78dfe0);
  `DepthTrackingBehindEffect_Update` 0x8d08a0 slides along the writable vector 0x1413c4728 = (0.7071, 0, 0.7071).
- **Layers (OBSERVED, r3dC + T2).** Tiles 7, shadows 0xa, units/objects/tall-tile halves 0x19 (`CONST_UNITS_LAYER`),
  flat units 0x13 (`CONST_FLAT_LAYER`), overlay 0x1c, particles default 0x19, splatters 0xb, distortions 3,
  sorted_distortions 1, top 0x21, background 5. In the run the world camera's bitset was 0x41fde1ffff1 and its
  non-empty layers were 0x0 (1), 0xa (9–10), 0xd (15), 0x12 (1), 0x19 (10–11), 0x23 (1) — all draw mode 0 (no layer
  was depth-tested). `Character_SetRenderLayer` 0xf4890 (SWF script `SetRenderLayer`) moves a unit between 0x13 /
  0x19 / 0x1c.
- **Picking (OBSERVED, r3dC).** `Camera_MouseToCamera2D` 0x9796d0 `(Camera*, double out[2])` = inverse(VP) × mouse
  (no w divide), so a perspective VP breaks it silently. 27 caller functions; combat world picking = the tile picker
  `TacticsGrid_PickTileUnderMouse` 0x8abc50 (`floor(ISO⁻¹·(u, v) + offset)`, ±0.4-tile hysteresis on `grid+0x1a0`,
  tile centres col+0.5 / row+0.5), ability targeting 0x778da0, StatusMenu slot 16 0x81eaa0. The inlined world→screen
  sites are projectile-sprite helpers (0x10eef0, 0x1571f0/0x1578b0/0x157f40) and a layer-3 RTT draw (0x16c700); one UI
  floater over a unit reads ISO (0x811980).
- **Classification (OBSERVED, r3dC).** Renderer vftables: Renderer 0x140ed3f10, RendererIso 0x140ed82e0,
  **MaskedRendererIso 0x140ed81e8** (`MaskedRendererIso_vftable`, units), MaskedRenderer 0x140efdec8; owners
  TacticsTile 0x140ed4fc0, TacticsObject 0x140ede320, Character 0x140f12b58, Shadow 0x140edefb0, Splatter 0x140edecf8;
  `renderer+0x18` = the owning entity. `Shadow_Update` 0x794850 = (owner.x + dx, 0, owner.z + dz).

### Render targets, depth and shaders
- **The world camera's depth buffer (OBSERVED, r3dD + T2).** Non-RTT cameras draw into the main RT `App+0xc10`
  (`App_mainRT`), created only by FrameBegin (`RenderTarget_create` 0xa28a80 `(rt, w, h, samples = App+0xdf4
  "antialias", type = render_scale > 1, hdr 0, depth 1)`): RGBA8 colour renderbuffer `+0x14` + **D24S8 renderbuffer
  `+0x18`**, FBO `+0x1c`, multisampled at `+0x50`. FrameBegin clears it once per frame with the mask from
  `App+0xd98/0xd99/0xd9a` — **observed 1/1/1 = COLOR|DEPTH|STENCIL**; antialias and the RT's samples were 32 on the
  owner's machine. `RenderTarget_resolve` 0xa29150 blits colour only (depth never leaves the MSAA FBO; test against it,
  never sample it).
- **Sprites vs depth (OBSERVED, r3dD).** No sprite shader discards on alpha; every `swf_lib` sprite shader writes
  `gl_FragDepth = gl_FragCoord.z − depth_bias·.001` (except `distortion_ring/_scream`). Depth is tested and written
  only while flags bit 2 is set (`Layer_Draw` sets it for mode-1 layers, which it also draws in **reverse** order);
  normal layers neither test nor write depth.
- **Shaders (OBSERVED, r3dD).** `Shader_compile` 0xa55470 (the on-disk name `Swf_RenderBatch_BuildVertices` was
  wrong): one `.shader` source, copied twice and text-replaced (`" vert()"`/`" frag()"` → `" main()"`,
  `COMPILING_VERTEX/FRAGMENT_PROGRAM` → 1/0, `MATRICES_AS_ATTRIBS` → 1 with ARB_base_instance); attribs position 0,
  color 1, texcoord 2, mvp 3, color_xform 7, depth_bias 9 (meshes need their own VAO). The GL program of a material is
  `*(int*)(*(Material+0x18)+8)`. A mod-shipped shader becomes a material with `ShaderManager_GetOrCreateMaterial`
  (proven by the glow).
- **Palette (OBSERVED, r3dD).** Grey fill (r≈g≈b within .001) → `texelFetch(palettemap, ivec2(int(r·15+.5), palette))`
  (column = round(r·15), row = int uniform `palette`), else pass-through; then the colour transform. `palettemap` =
  `palette.png` (TacticsTest::init); each cat clones the `paletted` material at `CatParts+0x160`, `palette` =
  `CatParts+0x1b4`.
- **Flat-screen shaders (OBSERVED, r3dD).** `ground_lighting` (camera_to_world `.xy`, no /w), `water*`,
  `textured_tile`, `shadow_occluded*` (`gl_Position.xy`, no /w); none reads `gl_FragCoord.xy`. `camera_to_world` =
  ISO⁻¹·VP⁻¹ and `camera_mat` = inverse(base ortho · VP), both recomputed per frame by CombatShaders slot 19.

### Assets and UI
- **Mesh bytes (OBSERVED, r3dE).** `ResourceManager_GetBinaryResource` 0x973750 `(unused, std::string path by value)`
  → `BinaryResource*` (data `+0x28`, int32 size `+0x30`, NULL when missing), borrowed from the FileManager cache
  (key `"bin_"+path`). Lookup: **the first** `-modpaths` entry that has the file, then the gpak (only overlays apply
  last-to-first); no extension filter — `models/crate.glb` is served.
- **Textures (OBSERVED, r3dE).** stb_image is linked; `App_GetTexture` 0x9bb490 `(unused, std::string name)` → cached
  `Texture2D*` (GL id `+8`) of `"textures/"+name` (premultiplied RGBA, LINEAR, REPEAT); a missing file is dereferenced
  — check `FileManager_FileExists` 0x9a14c0 first; ship RGB/RGBA PNGs only.
- **ImGui (OBSERVED, r3dE).** Dear ImGui 1.91.0 (context 0x1413c1990; NewFrame 0x9e1050, Begin 0x9e60d0, Render
  0x9e2e30, Checkbox 0x9f6060, SliderScalar 0x9f76c0, draw-queue 0x9da540) is driven only by test scenes; a framework
  panel must run its own frame from the LateRender hook. Free inputs in fights: horizontal wheel, X2, modifier combos.

---

## 2. Unknowns that remain — each with its exact next step

| What | Blocks | Next step |
|---|---|---|
| ~~Does a hand-built C `_Func_impl` vtable survive the game's copy/replay?~~ | M1 | **settled 2026-10-22: yes** (T2 cube run, no dealloc, no GL error; `fw_functor.c`) |
| Translucent sprite pixels write depth when a unit layer is depth-tested (no discard) | M2 | M2: patch `swf_lib.shader`'s fragment with `if (a < 0.02) discard;` via `-modpaths` and compare shots |
| Depth precision of the stock 1e-4 z scale under perspective | P1 | P1: put near/far tight around the board; if layering breaks, rewrite m10 of the base ortho after FrameBegin |
| The 12 unclassified `Camera_GetViewProjection` callers | P1 | key the VP override to the world camera + `Camera_RenderOneLayer`/`Camera_render` return addresses; log the rest with the observer |
| Splatter renderer's own layer (no `+0x54` write found) | P2 | observer: log layer 0xb items' owner vftables |
| Which particle systems read the ISO copy at core `+0x190` | P3 | rewrite the copy together with ISO, or leave particles iso (they are billboards) |
| ImGui `Text` / `End` addresses (End INFERRED) | P6 | one decompile pass when the settings panel is built |
| `Component_GetSceneCamera` in combat really = `TacticsTest+0x40` | — (harmless) | one observer line |

## 3. Hook table (manifest names; FwSymbol = resolved into `g_sym[]`, the rest are signed reference entries)

| Purpose | Entry (RVA) | Phase |
|---|---|---|
| Observer: RTT cameras | `Camera_render` 0x9787c0 (FwSymbol 37) | 0 (done) |
| Observer + mesh insertion point + per-layer VP push of the world camera | `Camera_RenderOneLayer` 0x979210 (FwSymbol 39) | 0 (done), M1, P1 |
| Perspective VP | `Camera_GetViewProjection` 0x9785e0 (FwSymbol 38) | P1 |
| Billboards / floor un-skew / m14 depth | `Renderer_GetScreenMatrix` 0x78d600 (FwSymbol 35) | M2, P2 |
| Submit our GL | `Batch_SubmitFunctor` 0xa47820 (call, not hook) | M1 |
| Replay / state | `Batch_Replay` 0xa481d0, `Batch_ApplyGroupState` 0xa497d0, `Material_Bind` 0x9bda20 | M1 (reference) |
| Depth-tested layer mode | `Layer_Draw` 0x9896f0; `RenderStateFlags` 0x12f714c; `DepthBias` 0x13c5c40 | M2 |
| Cull off | `CullDisableCounter` 0x13c5c90 (data write) | P3 |
| Sort key | `MaskedRendererIso_vftable` slot 25 (leaf 0x78d480), `ParticleSystemDepthSorter_Update` 0x78dfe0, `DepthTrackingBehindEffect_Update` 0x8d08a0 | P3 |
| Picking | `Camera_MouseToCamera2D` 0x9796d0; `TacticsGrid_PickTileUnderMouse` 0x8abc50 | P4 |
| Autoflip / base ortho | `Mat4_IsMirrored` 0xa082b0, `MatStack_Ortho` 0x9fec80, `MatStack_Push` 0x9feaf0 | P1 (reference) |
| Iso basis | `Iso` 0x12f7a00, `IsoInverse` 0x12f79c0 (FwData 11/12) | P2 (reference) |
| Main RT | `RenderTarget_create` 0xa28a80, `RenderTarget_resolve` 0xa29150, `App_mainRT` +0xc10, `RenderTarget_samples` +0x50 | M2 |
| Shaders | `Shader_compile` 0xa55470 | M4 (reference) |
| Assets | `ResourceManager_GetBinaryResource` 0x973750, `App_GetTexture` 0x9bb490, `FileManager_FileExists` 0x9a14c0 | M3 |
| Unit layer moves | `Character_SetRenderLayer` 0xf4890; `CONST_UNITS_LAYER` 0x19, `CONST_FLAT_LAYER` 0x13 | P2 |
| Shadows | `Shadow_Update` 0x794850 | P2 |

## 4. Build steps toward full 3D

The mesh path (M) does not depend on perspective (P); perspective does not depend on meshes. M first: it is what the
owner asked for and what proves the frame-model facts in-game. Each step: red → green → T2 (and a T3 shot where the
look matters). Task-level detail (files, red test names, gotchas) is in `.analysis/notes-r3dF.md` §6.

### Phase 0 — bindings + observers — done (2026-10-22)
- [x] The 3D block in `bindings/25143593.json` (3 FwSymbol, 27 signed reference functions incl. 2 witness-host
      `.pdata` chunks, 7 FwData globals, the MaskedRendererIso vftable, 19 offsets, 4 constants), harvest-verified;
      `npm run bindings:gen`.
- [x] `obs3d_engine.c` / `fw_obs3d_rules.c` (11 host checks): off unless `MEWFW_OBSERVE3D=N`; hooks `Camera_render`
      and `Camera_RenderOneLayer`, logs N windows of 60 world frames; T2 `mods/dev-sandbox/tests/observe3d.mewtest`
      passed with the real save unchanged; lines pinned in `editor/test/fixtures/ingame/observe3d-log.txt`, parsed by
      `editor/src/core/ingame/obs3d.ts`.

### Phase M — a real mesh in the vanilla (orthographic) scene
- [x] **M0 pure modules (no RE dependency)** — done 2026-10-22 except the perspective half of the maths (P1): `fw_mesh_rules.c` (OBJ, registry, paths), `fw_mesh_gltf.c` + `fw_json.c` (glTF 2.0 .gltf/.glb, node transforms, multi-primitive), `fw_m4.c`, `fw_functor.c`, `fw_gl_state.c`, `fw_mesh_draw.c` (`fw_shader_stage`); planned as: `fw_mesh_obj.c`, `fw_json.c` + `fw_mesh_gltf.c` (.gltf/.bin/.glb, one
      mesh/primitive, POSITION/NORMAL/TEXCOORD_0, u8/u16/u32 indices, z mirrored + winding reversed on import: the
      game's (x, height, z) is left-handed), `fw_3d_math.c` (perspective/lookAt in the 1280×720 convention, det < 0,
      billboard bases, ray–ground pick → iso-2D, view-depth key), `fw_functor.c` (the MSVC std::function in C),
      `fw_gl_state.c` (save/restore against a fake GL), `fw_shader_src.c` (the game's text-replacement dialect).
- [x] **M1 a cube on a tile — OBSERVED 2026-10-22** (`MEWFW_MESH_PROBE`, `mods/dev-sandbox/tests/mesh-probe.mewtest`, `npm run test:artprobe -- --mesh`; fixtures `mesh-probe-log.txt` / `mesh-probe-summary.json`; the functor is submitted after `Camera_RenderOneLayer(world, 0x19)` and restores state by glGet, not by poisoning the caches). Planned as: post-hook `Camera_RenderOneLayer` for the world camera at layer `CONST_UNITS_LAYER`
      (or a free layer's custom draw functor `Layer+0xa8`): capture the stack top (base ortho × VP) at record time,
      submit one functor via `Batch_SubmitFunctor`; in `_Do_call` bind our program/VAO, draw, restore per §1 "What a
      functor must restore". Proof: T2 `shot` + a T3 picture.
- [ ] **M2 depth against sprites** (OBSERVED need, 2026-10-22: a cube on a farther tile is drawn over the cats; `engine-map.md` "Sprites vs meshes"): around the unit layer set `RenderStateFlags` bit 2 (not mode 1: that reverses the
      draw order), give sprites a view depth through m14 in `Renderer_GetScreenMatrix` (scaled into ±10 000), patch the
      sprite fragment's `discard` via `-modpaths` if translucent edges punch holes; draw meshes before the unit layer
      with depth writes on. The main RT already has a cleared D24S8 buffer (§1).
- [~] **M3 assets + data seam** — done: model bytes via `ResourceManager_GetBinaryResource` (OBSERVED, `mesh-model-log.txt`), OBJ + glTF parsing, API v6 `FW_Register3DObject` / `FW_Place3DObjectOnTile` / `FW_Unregister3DObject` drawn by the mesh engine (tile objects OBSERVED; unit-attached follow the unit's Position, not yet seen in-game), GON `graphics.model` validated by the editor and ignored by vanilla (OBSERVED: no GON error); open: the per-unit GON walk (`obj3d_engine_unit_model` exists), textures, `@Name` models, `render3d {}`. Planned as: bytes via `ResourceManager_GetBinaryResource`, textures via `App_GetTexture`
      (`textures/models/…png`, existence-checked); API v5 `FW_Register3DObject` / `FW_Attach3DObject`; GON `model` /
      `render3d {}` keys validated by the editor (schema + checks + a `model3d` kind in `registered-names.json`).
- [~] **M4 palette shader** — `mods/fw-3d/shaders/fw_mesh.shader` ships and compiles in-game through our own compile path (`fw_shader_stage`, OBSERVED); Lambert lighting draws; open: the `palettemap` texture (`App_GetTexture("palette.png")` + `Texture+8`, an offset to add) so `palette >= 0` remaps, the T3 side-by-side. Planned as: `mods/fw-mesh/shaders/fw_mesh.shader` — lambert + the palettemap rule (§1) + the colour
      transform; T3 side-by-side with a cat of the same palette.

### Phase P — true perspective
- [ ] **P1 VP hook** on `Camera_GetViewProjection` for the world camera's draw pushes only (callers
      `Camera_RenderOneLayer` / `Camera_render`, world camera and its five mirrors), det kept negative, zoom fields
      untouched; mirror the change in the glow rect math (PR #99 rebuilds K × inverse(view) itself).
- [ ] **P2 billboards + floor:** `Renderer_GetScreenMatrix` emits (x, height, z) into m12/m13/m14 with an upright
      basis for standing renderers (MaskedRendererIso on 0x19/0x1c), the ISO⁻¹-unskewed ground basis for floor layers
      (7, 0xa, 0xb, 5, 0x13), classification by layer + owner vftable, `render3d {}` overriding.
- [ ] **P3 cull + sort:** `CullDisableCounter` += 0x10000 while active; view-depth keys in slot 25 / the inlined copies
      (or the layer key functor), the particle sorter and the DepthTracking vector; rewrite the ISO copy at the particle
      core `+0x190` if ISO changes.
- [ ] **P4 picking:** hook `Camera_MouseToCamera2D` for world cameras: ray–ground hit → the iso-2D point the vanilla
      callers expect (tile picker, targeting, StatusMenu).
- [ ] **P5 screen-space shaders + floaters:** `/w` and camera fixes in `ground_lighting`, `water*`, `textured_tile`,
      `shadow_occluded*` via `-modpaths`; the UI floater 0x811980.
- [ ] **P6 camera control + settings:** yaw steps / pitch clamp, horizontal wheel or a modifier, an own ImGui frame
      from LateRender; settings in the framework's own file, never `settings.txt`.

### Explicitly not planned
- Replacing the SWF renderer; gameplay verticality (`spatial-model.md`); any change to `Mewgenics.exe`,
  `resources.gpak` or non-`dev` saves.
