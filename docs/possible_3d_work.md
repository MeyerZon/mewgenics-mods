# Possible 3D work — plan toward full true 3D

Owner's goal (2026-10-22, their words): **"FULL true 3D, so I will be able to put there 3D models, and it will
work."** End state = real meshes (OBJ / glTF shipped by a mod through `-modpaths`) drawn into the tactics scene
through a real perspective camera, depth-tested against the billboarded sprites, picked correctly, shaded so they sit
in the paletted vector look. The orthographic orbit (old "phase 1") is only a stepping stone.

Everything here is native work on `mewframework.dll`, pinned to build 25143593 through `bindings/25143593.json`,
fail-closed on any other build, dev save only. Evidence and the hook table: [`3d-rendering-feasibility.md`](3d-rendering-feasibility.md)
(§1 facts, §6 hooks); camera/layer/pass facts: [`engine-map.md`](engine-map.md) "Glow and outline passes" and
"Per-unit glow (native)"; gameplay is 2D: [`spatial-model.md`](spatial-model.md).

Conventions: `[x]` done · `[~]` in progress · `[ ]` planned. **OBSERVED** = read from a decompile / bytes / a live run
on this machine; **INFERRED** = reasoned from that; **WIPED** = stated by the 2026-10-18 reports whose decompiles
(`r3d_*`, `p2_*`) were lost on 2026-10-19 — believed right, to be re-verified before code relies on it. RVAs are
image-relative (base 0x140000000).

Status 2026-10-22: inventory + gap list written first (this file, as restructured on branch `feat/3d-investigation`),
then RE sessions `r3dA`..`r3dE` sized to the gaps only, then the phase-0 bindings + observer hooks.

---

## 1. Known — do not re-derive

### Projection and the matrix stack
- **K1 Iso local mat4 = `Renderer_GetScreenMatrix` 0x78d600** (the old `FUN_14078d600`; FwSymbol 35 since PR #99).
  Reads the interpolated transform `0x9b4a30(Position = renderer+0x40, out[6], alpha = (renderer+0x28)->+0x30)` →
  `(x, height, z, sx, sy, rot°)`; writes a rotation/scale 2×2 into m0/m1/m4/m5, **m12 = ISO[0]·x + ISO[4]·h + ISO[8]·z,
  m13 = ISO[1]·x + ISO[5]·h + ISO[9]·z, m14 = 0**, m10 = m15 = 1. ISO is read as floats at `0x1412f7a00/04` (x column),
  `0x1412f7a10/14` (height), `0x1412f7a20/24` (z). OBSERVED (`Renderer_GetScreenMatrix_0x78d600.c`).
- **K2 ISO values** m0 = 0.8944, m1 = 0.4472, m4 = 0, m5 = 1, m8 = −0.8944, m9 = 0.4472 (= (2,1)/√5); inverse at
  `0x1412f79c0`; static init `0x140025700`; 23 other readers. WIPED (feasibility §1); values re-read in r3dC.
- **K3 Camera VP and the stack.** `Camera_render` 0x9787c0 pushes a copy of the stack top (`0x9feaf0(&0x1413c5bd0)`;
  stack data `DAT_1413c5bd8`, top index `DAT_1413c5c00`, 0x40-byte column-major floats) and **post-multiplies it by
  `0x9785e0(cam, out)`** (the camera VP), then draws every enabled layer with `Layer_Draw` 0x9896f0, then pops.
  OBSERVED (`Camera_render_0x9787c0.c` lines 221-325). Hooking 0x9785e0 for one camera therefore changes that
  camera's VP and nothing else.
- **K4 VP decomposition** (PR #99, OBSERVED in `TacticsTest::LateRender` 0x88d780 asm): `VP = K × inverse(V)` with
  `V = Position_GetViewMatrix 0x9b4c90(cam+0x38, out, interp)` (inverse = leaf 0xa07c70) and
  `K = {zoom,0,0,0 / 0,zoom·zi,0,0 / 0,0,1,0 / 640,360,0,1}`, `zoom` = double `cam+0x168` (default 60), `zi` = int
  `cam+0x170` (default −1 = y-flip); K's rows 2/3 are the .rdata vectors 0x141140520 / 0x141140960; canvas 1280×720
  (`CONST_GLOW_CANVAS_W/H`). z passes through K unscaled.
- **K5 Base ortho**: `FrameBegin` 0x9b7870 resets the stack bottom and calls `0x9fec80(&stack)` (OBSERVED,
  `ApplicationBase_FrameBegin_0x9b7870.c:169`); its `m10 = 1e-4` ⇒ `window z = 0.5 + 0.5e-4·z_view`, |z| ≤ 10 000,
  one `depth_bias` unit = 20 z units (WIPED, disassembly `0x1409b7d25`).
- **K6 Autoflip** `0xa082b0` = `det4x4 < 0`, column 0 negated when the sign differs from the base ortho's (WIPED).
  Root scale `0x97ac40` → `0x9b16c0(root, 1/zoom, flip/zoom)`, re-run by `0x97ad80` whenever the camera zoom/flip
  differs from the renderer's cache (renderer `+0x98/+0xa0` zoom copy, OBSERVED in rim notes) ⇒ keep `cam+0x168/+0x170`
  constant under perspective.

### Cameras (combat)
- **K7 Camera struct** (0x178, OBSERVED rim notes + `Camera_render_0x9787c0.c`): `+0x38` Position*, `+0x40`
  RenderQueue*, `+0x48` RenderTarget*, `+0x50` Texture2D*, `+0x60..+0x78` scissor, `+0x80` RTT byte, `+0x81` HDR byte
  (1 or 4 bytes/channel), `+0x82` skip-when-empty, `+0x88` RTT scale, `+0x90/+0x94` explicit size, `+0x98` bind unit,
  `+0x9c` had-content, `+0xa4` current layer, `+0xa8` primary, `+0xb0` per-layer pass vectors, `+0xc8` layer bitset
  (all on by default), `+0x120` item filter fn, `+0x160` post-item fn, `+0x168` zoom double, `+0x170` flip int.
  `DAT_1413c6d88` = the camera currently rendering (set/cleared by `Camera_render`).
- **K8 The world camera is `TacticsTest+0x68` and it is NOT render-to-texture** (OBSERVED, TacticsTest::init asm
  0x140833573..0x140833b76, rim notes §4): layers = all minus 0x25..0x30 minus {1,2,3,0x15,0x16,0x17,0x18,0x1d} plus
  0x2a; its passes composite at 0x1a and the battlefield effect at 0x22. `+0x60` = UI (0x25..0x2f). `+0x40/+0x48/+0x50
  /+0x58/+0x70` are RTT side cameras (layers 0x16, 0x15, 1+3, 0x18 mask, 0x17 cursor). Units draw on layer **0x19**.
  This **corrects** feasibility §1 "scene camera to a texture … RTT+HDR": the old reading came from `0x764da0`, which
  is not what combat uses for the world. Predicate for hooks: `cam == *(Camera**)(TacticsTest + 0x68)` (TacticsTest is
  already found by the glow engine's LateRender hook).
- **K9 RT handling in `Camera_render`** (OBSERVED): an RTT camera binds `cam+0x48` via a `RenderTarget::bind` lambda
  submitted through `0xa47820`, creating it with `0xa28a80(rt, w, h, samples = *(int*)(App + 0xc60), 2, hdr = cam+0x81,
  1)`; full-screen non-HDR RTT cameras share one global RT `DAT_1413c6d80` (refcount `DAT_1413c6d90`); the current RT
  global is `DAT_1413c1a28`. `FrameEnd` 0x9b7d80 unbinds the app's main RT at **`App+0xc10`** (`0xa28fb0(App+0xc10,1)`),
  submits its blit lambda, replays (`0xa481d0(&0x1412f80f0)`), then `SDL_GL_SwapWindow` (OBSERVED,
  `ApplicationBase_FrameEnd_0x9b7d80.c:66-115`). So `App+0xc60` = main RT `+0x50` = the MSAA sample count, and the
  non-RTT world camera draws into the main RT `App+0xc10` (INFERRED — r3dD confirms its depth attachment).

### Draw order, depth, layers
- **K10 Layer** (0xe8 bytes, `RenderQueue+0x38 + i·0xe8`, 0x30 layers in combat): `+0x08` items `{renderable*,
  Position*, double key, u32 flags}` ×0x20, `+0x18` material, `+0x20` sorted byte, **`+0x24` draw mode**, `+0x28` sort-key
  `std::function<double(const RenderPacket&)>` (impl `+0x60`), `+0x68` fn (impl `+0xa0`), **`+0xa8` custom draw
  `std::function` (impl `+0xe0`)**. `Layer_Draw` 0x9896f0 sorts with comparator 0x988dd0 (descending), sets the queue's
  current mode, and draws each item by renderable vtable slot 20 or the layer's custom draw functor. **Mode 1 = the
  depth-tested layer: draws the items in reverse with `DAT_1412f714c |= 2`, then `depth_bias` (`DAT_1413c5c40`) += 1.0.**
  OBSERVED (`Layer_Draw_0x9896f0.c`, rim notes).
- **K11 Sort key** = `Position+0xb0 = z + x + offset_z(renderer+0x118) + offset_x(+0x108)`, copied to `+0x68`
  (`MaskedRendererIso_RefreshSortKey` 0x78d480, slot 25). OBSERVED. GON `depth_offset d` writes `(d,0,d)` (WIPED, asm
  0x1400f2f92).
- **K12 Depth state**: bit 1 (value 2) of `DAT_1412f714c` = depth test, bit 3 = colour+depth mask; applier 0xa497d0;
  `glDepthFunc`/`glDepthRange`/`glClipControl` never called (GL_LESS, [0,1]); vanilla iso objects sit at z = 0.5;
  fragment shaders write `gl_FragDepth = gl_FragCoord.z - depth_bias*.001` (WIPED except the `|= 2`, OBSERVED in K10).
- **K13 Cull**: `Swf_DisplayObject_Render` 0x9b0a50 culls (affine bbox vs NDC bounds `0x1413c5c20..38`) only while
  `DAT_1413c5c90 == 0`. OBSERVED (`Swf_DisplayObject_Render_0x9b0a50.c:119`).

### Frame model and GL
- **K14 Record-and-replay**: `0xa47820(x, std::function<void()>*)` appends to the group vector `0x1412f80f0`;
  `0xa481d0` replays all groups (state → functor → draw) in FrameEnd. Every `Camera_render` RT bind / scissor pop /
  texture bind is itself such a functor. The std::function as built by the game: a 0x40-byte object whose first qword
  is a `std::_Func_impl_no_alloc<lambda,void>` vftable, captures after it, the impl pointer at `+0x38` (= the object
  itself) (OBSERVED, `Camera_render_0x9787c0.c:204-212, 314-318, 330-337`). Draws are `glMultiDrawElementsIndirect`
  (WIPED: GLEW slot 0x1413bd5f0, call 0x140a486fd).
- **K15 Per-instance record** (100 B: mat4 mvp, mat2x4 colour transform, float depth_bias; attribs 0–2 vertex, 3–6 mvp,
  7–8 colour, 9 depth) written by 0xa47e50; vertices are SWF-local 2D, `gl_Position = mvp * vec4(pos.xy, 0, 1)`. WIPED.
- **K16 GL 3.2 core / GLSL 1.50, GLEW static** (table 0x1413bc370..0x1413bdea0; `glUniformMatrix4fv` 0x1413bc5a8,
  `glVertexAttribPointer` 0x1413bc6e0, `glVertexAttribDivisor` 0x1413bc908; IAT `glEnable` 0x140e3f858, `glDisable`
  0x140e3f7f8, `glDepthMask` 0x140e3f898). WIPED.

### Materials, shaders, mod-shipped assets
- **K17 A mod-shipped shader becomes a material with one call**: `ShaderManager_GetOrCreateMaterial` 0x9bb5d0
  `(App 0x13c4a30, name, "file.shader")` loads `shaders/<file>` through the resource layer, so `-modpaths` serves it;
  `Material_SetUniformVec4/Float/SetTexture` set uniforms. OBSERVED in-game (PR #86/#99 `fw_unit_glow.shader`).
- **K18 The framework already hooks the frame**: `TacticsTest::LateRender` 0x88d780 (vftable 0xf0f4b8 slot 19) via
  `MJ_InstallHook`, finds the cameras at `TacticsTest+0x58/+0x68`, adds passes with `Camera_AddPostProcessPass`
  0x979880 — the template for every 3D hook (`glow_engine.c`).

### Picking
- **K19** Screen→world funnels through `0x9796d0(Camera*, double out[2])` (mouse → camera-2D, 32 callers), then ISO⁻¹;
  tile picker `0x8abc50` = `floor(x), floor(z)` (1 world unit = 1 tile). World→screen is inlined at ~12 sites
  (`0x10eef0`, `0x1571f0`, `0x1578b0`, `0x157f40`, `0x16c700`, …). WIPED.

---

## 2. Gaps — what is genuinely unknown, and whether it blocks real meshes

"Blocks" = blocks *meshes drawn + depth-tested + picked + palette-shaded*; "polish" = needed for the full perspective
experience but not for a first mesh on screen.

| # | Gap | Blocks? | Session |
|---|---|---|---|
| G1 | `0xa47820` exact ABI (first arg, copy vs move, which `_Func_impl` vtable slots replay calls: copy / move / call / delete) and whether a hand-built C vtable is enough | **blocks** (mesh draw insertion) | r3dA |
| G2 | What replay `0xa481d0` re-applies per group after a functor (program, VAO, buffers, textures, blend, depth, mask, scissor), and the applier `0xa497d0`'s cached shadow state (must be invalidated if a functor changes GL state) | **blocks** (state restore list) | r3dA |
| G3 | GLEW slot addresses for a mesh renderer (UseProgram, BindVertexArray, Gen/BindBuffer, BufferData, VertexAttribPointer, EnableVertexAttribArray, DrawElements, UniformMatrix4fv, GetUniformLocation, Bind/ActiveTexture, GetIntegerv, BindFramebuffer, BlitFramebuffer, Create/Compile/Link) or the material path that lets us skip them | **blocks** | r3dA |
| G4 | Instance record layout 0xa47e50 (re-verify K15) + call rate | observer only | r3dA |
| G5 | The main RT `App+0xc10`: creator, depth attachment (D24S8?), sample count, clear per frame — i.e. what depth buffer the world camera's layers can test against | **blocks** (depth test) | r3dD |
| G6 | Do the sprite fragment shaders `discard` transparent pixels (else sprites write depth over their whole quad) and does every one write `gl_FragDepth`? Is the depth bit's state honoured per group (K12)? | **blocks** (sprite/mesh occlusion) | r3dD |
| G7 | `0xa55470`: Shader::compile (feasibility) vs `Swf_RenderBatch_BuildVertices` (disp session); where `MATRICES_AS_ATTRIBS` is set; the sprite VAO attribute layout | blocks only if meshes reuse the sprite VAO (plan: they don't) | r3dD |
| G8 | Palette remap rule (`paletted_full.shader`), what `ground_lighting` / `water*` / `textured_tile` / `shadow_occluded*` assume about a flat screen; how `camera_to_world` (`0x78f820`) and `camera_mat` (`0x891300`) are fed | **blocks** palette shading; polish for the rest | r3dD |
| G9 | `0x9785e0` exact body + callers (does picking or LateRender re-derive the VP independently of it? — PR #99 replicates it from K4, so a perspective hook must be mirrored there), the base ortho 0x9fec80 (re-verify m10), autoflip callers, root-rescale trigger | **blocks** perspective | r3dB |
| G10 | Which `Camera*` gameplay calls "the scene camera" (`0x1b1070`, component type 7) and whether it equals `TacticsTest+0x68`; does zoom change at runtime (`zoomer` / `camera_bounds` GON, mouse wheel) | blocks the camera predicate | r3dB |
| G11 | `0x9796d0` math + its 32 callers classified; ISO/ISO⁻¹ section writable? every ISO consumer classified (world / shadow / pick / UI floater / uniform) | **blocks** picking under perspective; floaters = polish | r3dC |
| G12 | Floor vs standing classification: renderer/owner vftables for tiles, shadows, characters, objects, splatters; `SetRenderLayer` / `render_layer` → layer index; layer ids per class | blocks billboarding under perspective | r3dC |
| G13 | Resource layer: a getter for **arbitrary file bytes by path** (`models/x.obj`, `.gltf`, `.bin`, `.glb`) through `-modpaths` (text getter `0x7c10e0` is known), and the PNG → GL texture path | **blocks** mesh assets | r3dE |
| G14 | ImGui callable for a settings panel; free inputs (mouse wheel / right drag) in fights; particle depth sorters | polish | r3dE |

Not gaps any more (closed by K-items): the scene camera identity (K8), the RT sample source (K9), the per-layer custom
draw seam (K10), the VP push point (K3), the matrix decomposition (K4), the sort-key formula (K11), the cull gate (K13),
the std::function shape (K14), the shader/material route (K17).

## 3. RE sessions (2026-10-22, one Ghidra container each, run in parallel)

| Tag | Gaps | Out of scope (already known) |
|---|---|---|
| `r3dA` | G1, G2, G3, G4 | FrameBegin/End, cull, Camera_render (on disk) |
| `r3dB` | G9, G10 | Camera struct, combat cameras, K4 decomposition |
| `r3dC` | G11, G12 (+ re-read K2 bytes, K11's `depth_offset`) | sort-key formula, iso local mat4 |
| `r3dD` | G5, G6, G7, G8 | RT bind path in Camera_render, the material API |
| `r3dE` | G13, G14 | the text getter |
| `r3dF` (no Ghidra) | build design: C99 OBJ/glTF loaders, GL state save list, mesh shader, math module, editor keys, ordered tasks | — |

Each writes `.analysis/notes-<tag>.md` (OBSERVED/INFERRED, manifest-ready rows, hook-site assessment).

## 4. Build steps toward full 3D

The mesh path does **not** depend on perspective; perspective does not depend on meshes. Order chosen so every step is
visible in-game and T2-testable.

### Phase 0 — bindings + observers (this branch)
- [ ] Sign every function/data address of K1–K19 + the session results into `bindings/25143593.json`
      (`make-signature.ts`, witnesses, evidence paths; `npm run bindings:gen`), red tests on counts/goldens first.
- [ ] Observer hooks (log-only, framework setting `observe3d`, off by default): every `Camera_render` (pointer,
      `+0x80/+0x81/+0x168/+0x170`, layer bitset, `== TacticsTest+0x68?`), the VP returned by 0x9785e0 for the world
      camera, one unit's `Renderer_GetScreenMatrix`, N instance records. Pure parts host-tested; one T2 run; log lines
      pinned as a fixture.

### Phase M — a mesh in the vanilla (orthographic) scene (first owner-visible 3D)
- [ ] M1 Mesh draw functor: from the world-camera `Camera_render` (or a free layer's custom draw functor `+0xa8`,
      K10), submit a `std::function` through `0xa47820` (G1) that binds a mod-shipped program, draws a VAO with
      `VP × model`, restores state (G2), all through GLEW slots (G3). Proof: a cube on a tile.
- [ ] M2 Depth: give the mesh layer and the unit layer the depth test (G5, G6), z from the camera's view depth inside
      ±10 000 (K5); meshes occlude and are occluded by cats.
- [ ] M3 Assets: OBJ then glTF/glb loaded from `-modpaths` (G13), textures via the PNG path; `FW_Register3DObject`,
      GON `model "models/x.glb"` on objects, `registered-names.json` kind, validator checks.
- [ ] M4 Palette-compatible shader (G8): lambert/flat + the palettemap remap; shipped as a mod `.shader` (K17).

### Phase P — true perspective
- [ ] P1 VP hook on `0x9785e0` for the world camera only (K3, K8, G9): `P_persp × lookAt` in the 1280×720 pixel
      convention, `det < 0` kept (K6), zoom fields untouched; mirror it in the glow rect math (K4).
- [ ] P2 Billboards: in `Renderer_GetScreenMatrix` emit `(x, height, z)` into m12/m13/m14 with an upright basis for
      standing classes, floor un-skew for floor classes (G12).
- [ ] P3 Cull off (`DAT_1413c5c90` += large, K13); view-depth sort key (K11) or the layer key functor.
- [ ] P4 Picking: hook `0x9796d0` with a ray–ground hit returning the iso-2D equivalent (G11).
- [ ] P5 Screen-space shader patches via `-modpaths` (G8); UI floaters (G11).
- [ ] P6 Camera control + settings (G14): yaw stepped/clamped, pitch clamped, reset; ImGui or a key; never `settings.txt`.

### Explicitly not planned
- Replacing the SWF renderer; gameplay verticality (`spatial-model.md`); any change to `Mewgenics.exe`,
  `resources.gpak` or non-`dev` saves.
