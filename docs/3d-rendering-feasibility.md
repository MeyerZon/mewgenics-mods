# Turning Mewgenics into "real 3D" with paper-doll sprites — feasibility

Follow-up to [`spatial-model.md`](spatial-model.md) (gameplay is a flat 10×10 grid; nothing in the
rules has a Z axis). That document answers *"is the world 3D?"* (no, for rules). This one answers the
rendering question: **what would it take to draw the existing 2D scene through a real 3D camera —
floor tiles lying flat as a ground plane, every other sprite billboarded Paper-Mario style — so that
(a) the default camera reproduces today's look pixel-for-pixel, (b) the board can be orbited/zoomed
with the mouse, and (c) mods can place genuine 3D objects into that scene.**

Target build 1.1.21239 (Steam build id 25143593). Read-only reconnaissance: `Mewgenics.exe`,
`resources.gpak` and saves were not modified. Claims are tagged **OBSERVED** (read from decompiled
code, raw bytes, shaders, GON, vanilla SWF bytes or the game log on this machine), **INFERRED**
(reasoned from that evidence) or **COMMUNITY-SOURCED** (public material, with a URL). Decompiled
evidence comes from a Ghidra 12.1.4 session (REA, Docker); the functions are kept under the
git-ignored `.analysis/decompiled/r3d_*` and `p2_*` (118 files — **not on disk since the 2026-10-19 worktree wipe**;
re-decompile on demand from the function tables below, the renderer is not current work); the full RE reports are
`.analysis/rea-renderer-report-2026-10-18.md` (pass 1: mvp, camera, sort, board) and
`.analysis/rea-renderer-report-pass2-2026-10-18.md` (pass 2: base matrix and z range, frame model,
FBO format, cameras, picking, cull/autoflip). All addresses are VAs (image base `0x140000000`).

---

## TL;DR

- **The renderer is much closer to 3D than the gameplay is.** Every render transform already holds a
  3D position as doubles `(x, height, z)`; the isometric renderer (`RendererIso`) projects it to the
  screen through **one global 4×4 float matrix** at `0x1412f7a00` (inverse at `0x1412f79c0`):
  world x → screen (0.894, 0.447), world z → (−0.894, 0.447), height → (0, 1). The result lands in a
  per-object `mat4 mvp` that the GPU receives as a **per-instance vertex attribute** (100-byte record:
  mvp, colour transform, depth bias), while the vertices themselves stay in SWF-local 2D space.
  **OBSERVED** (decompiled `FUN_14078d600`, `FUN_140a47e50`, bytes at `0x1412f7a00`).
  In other words the engine is *already* "3D positions + screen-facing sprite planes + a fixed
  dimetric projection"; what is missing is a free camera, a depth row and flat floor art.
- **The board is a classic 2:1 dimetric diamond grid**: `MetalTile`'s polygon is
  `(70,0) (0,35) (-70,0) (0,-35)` px and the projection constants above are exactly `(2, 1)/√5`.
  **OBSERVED** (vanilla `tiles.swf` + the matrix constants). That pins the default camera: an
  orthographic view with **yaw 45°, pitch 30°**, ground scale 1.265 units→screen-units and heights
  drawn at 1.0 (i.e. upright art is shown ~9% *shorter* than a physically consistent camera would —
  keep that factor and the default look is pixel-identical).
- **Draw order today is painter's order, not z-buffering**: each layer CPU-sorts its packets by the
  key `x + z + 2·depth_offset` (largest first); the depth test is switched on only for special
  layers/blend modes. **OBSERVED** (`FUN_1409896f0`, comparator `0x140988dd0`).
- **Two deliverables with very different cost:**
  1. **Orbitable orthographic 2.5D** (rotate/tilt/zoom the board, sprites stay upright, floor flat):
     needs **no new projection pipeline**. Rewrite the global iso matrix (and its inverse) per frame
     with the rotated basis — every world↔screen user (picking, shadows, AOE previews, lighting)
     follows automatically because they all read that matrix — plus one hook that un-skews floor
     art, one hook on the sort key, and shader uniform fix-ups. **~1 week to a proof of concept.**
  2. **True perspective + genuine 3D meshes**: additionally replace the camera view-projection
     (`FUN_1409785e0`) keeping the determinant sign the autoflip expects, disable the w-ignorant 2D
     cull (a single counter, `DAT_1413c5c90`), enable the depth test for scene layers (z is already
     mapped: `window z = 0.5 + 0.5e-4·z_view`, usable range ±10 000 units), hook **one** picking
     helper (`FUN_1409796d0`, 32 callers) with a ray–ground hit, patch four screen-space shaders, and
     draw meshes as recorded GL functors (`FUN_140a47820`) into the camera's D24S8 MSAA framebuffer.
     **~1–2 months to robust, plus weeks for the mod API.** Pass 2 removed the main unknowns
     (z range, thread model, FBO format, camera defaults, picking path); what is left is work, not
     research.
- **Recommended path**: hook at the display-object/renderer level (§4-B), where object identity is
  known; raw-GL interception can rewrite matrices but cannot tell floor from standing art. Upright
  (cylindrical) billboards are the default; limit or step the yaw because the art only has a
  left/right facing. Nobody has done exactly this to a closed 2D game by injection; the closest
  precedents (Stardew "Third Dimension", Don't Starve's `OnGround`/`BillBoard` split, Helix/geo-11
  per-draw depth fixes) agree on the pitfalls: translucency sorting, HUD special-casing, clipping at
  steep pitch, and hooks breaking on every update (§5).

---

## 1. What the renderer actually is (OBSERVED unless marked)

| Fact | Evidence |
|---|---|
| OpenGL **3.2 core / GLSL 1.50** via SDL3; GLEW statically linked | game log `Application.cpp:212-215`; GLEW pointer table at `0x1413bc370…` |
| Vertex input is **2D, SWF-local**: `in vec2 position; vec4 color; vec4 texcoord;` stride 40 B; vertices are **not** pre-transformed on the CPU | `std_in.shader`; VBO fill `FUN_1409ff2f0` |
| Per-object transform is a **`mat4 mvp`** (+ `mat2x4 color_xform`, `float depth_bias`). On any GPU with `GL_ARB_base_instance` (this one) `MATRICES_AS_ATTRIBS` is textually set to 1 by `Shader::compile` and the three travel as a **per-instance attribute record** (100 B, divisor 1; attrib locations 0–2 vertex, 3–6 mvp, 7–8 colour, 9 depth). Otherwise they are uniforms. | `Shader::compile` `FUN_140a55470`, gate `FUN_140a49d20`, instance layout `FUN_140a479d0` |
| Every vanilla vertex shader: `gl_Position = mvp * vec4(position.xy, 0.0, 1.0);` fragment shaders: `gl_FragDepth = gl_FragCoord.z - depth_bias*.001` | `swf_lib.shader` |
| **mvp is composed on a CPU mat4 stack** (`0x1413c5bd0`): `Camera VP` × `Renderer local mat4` × `each DisplayObject's Matrix3x2` (a,b,c,d,tx,ty at DisplayObject+0x60; it **never touches z**). The batcher snapshots the stack top per draw. | `FUN_1409787c0` (Camera::render), `FUN_14098cbb0`/`FUN_14078cf10` (Renderer/RendererIso::render), `FUN_1409b0a50` (DisplayObject render), `FUN_140a47e50` (instance writer) |
| **Render transforms are 3D**: current `x,height,z` doubles at +0x80/+0x88/+0x90, `sx,sy,rot` after, previous state blended by the fixed-update alpha | `FUN_1409b4a30` |
| Plain `Renderer` local mat4 puts `x,y,z` into m12/m13/**m14** (real z). `RendererIso` puts the **projected** point into m12/m13 and **m14 = 0**: `m12 = ISO[0]·x + ISO[4]·h + ISO[8]·z`, `m13 = ISO[1]·x + ISO[5]·h + ISO[9]·z` | `FUN_1409b4c90`, `FUN_14078d600` |
| **ISO matrix** `0x1412f7a00` (column-major): m0=0.8944, m1=0.4472 (x); m4=0, m5=1 (height); m8=−0.8944, m9=0.4472 (z); inverse at `0x1412f79c0`; 23 other code sites read it directly (picking, AOE previews, …) | static init `0x140025700`, constants `0x141140af0` |
| **Camera is orthographic 2D**: view-projection = `P × inverse(cameraTransform)` with `P = [zoom 0 0 640; 0 zoom·flip 0 360; 0 0 1 0; 0 0 0 1]` — world → virtual **1280×720 pixels**, z passed through. Fields: zoom at cam+0x168, y-flip at +0x170, layer bitmask +0xc8, sort order +0xa0, render-to-texture flags +0x80… | `FUN_1409785e0`, camera ctor `FUN_140055120` |
| **Several cameras per frame**: `RenderCore::render` sorts all Camera components by +0xa0, each renders only the layers in its bitmask (scene camera to a texture, UI camera composites it) | `FUN_140989020`, assert "seen by multiple cameras" |
| **Sorting**: each layer sorts its packets by `transform+0xb0`, **descending** (largest first). `RendererIso` sets that key to `x + z + offset.x + offset.z`; GON `depth_offset d` writes `(d,0,d)` into those offsets (so it shifts the key by 2d) | `FUN_1409896f0`, `0x140988dd0`, `FUN_14078d480`, asm `0x1400f2f92` |
| **Depth test is mostly off**: enabled (bit 1 of state flags `0x1412f714c`) only for "type 1" layers and blend-mode-2 subtrees; bit 3 drives both colour and depth mask; `depth_bias` is a global counter bumped +1.0 per such layer and reset in FrameBegin. `glDepthFunc`, `glDepthRange*` and `glClipControl` are never called (GL defaults: range [0,1], GL_LESS) | state applier `FUN_140a497d0`, bind lambda `0x140a29d90` |
| **Pixels→clip base matrix and z range**: `FrameBegin` (`FUN_1409b7870`) overwrites the bottom of the mat4 stack with an ortho from `FUN_1409fec80(L,R,B,T)` over the letterboxed 1280×720 virtual pixels (floats at `0x1413c5c04..c10`); `m10 = 1e-4`, so **`window z = 0.5 + 0.5e-4 · z_view`**, visible range \|z\| ≤ 10 000, one `depth_bias` unit = 20 z units. Camera VP passes z through unscaled; vanilla iso objects all sit at z = 0.5 | disassembly `0x1409b7d25`, `0x1409fec80` |
| **Frame model is single-threaded record-and-replay**: GL context made current once at init; `FUN_140a47820` stores a `std::function` into the batcher's draw-group vector (`0x1412f80f0`), **not** a cross-thread queue; `FrameEnd` (`0x1409b7d80`) replays all groups via `FUN_140a481d0` (state → functor → draw) right before `SDL_GL_SwapWindow` (`0x1409b8024`). Draws are `glMultiDrawElementsIndirect` (GLEW slot `0x1413bd5f0`, call `0x140a486fd`) with a per-command fallback | disassembly; `FUN_140a480a0`, `FUN_140a485a0` |
| **Scene framebuffer**: `FUN_140a28a80` builds colour RGBA8 (RGBA16F when the camera's HDR flag `cam+0x81` is set) + **GL_DEPTH24_STENCIL8 multisampled renderbuffer** at the depth-stencil attachment, sample count = the main RT's (settings), clamped to `GL_MAX_SAMPLES`; the MSAA resolve (`FUN_140a29150`) blits **colour only**, depth stays in FBO `rt+0x1c` and cannot be sampled as a texture | `p2_RTResolve`, `p2_RTMakeResolveFBO` |
| **Camera defaults** (ctor `FUN_140055120`): zoom **60.0** virtual px per world unit, flip **−1** (world +y up), output layer −1, full viewport; layer bitset at `cam+0xc8` set by `FUN_140979c30(cam, lo, hi)`. The combat scene builder `FUN_140764da0` creates **three cameras**: one render-to-texture HDR camera, one with transform scale 1.15, and one on layers 0x25..0x30 (the UI). `DAT_1413c6d88` is the camera currently rendering; `FUN_1401b1070` returns "the scene camera" (component type 7) to gameplay code | disassembly `0x140764e4d…`, `p2_GetSceneCam` |
| **Picking**: screen→world goes through **one helper**, `FUN_1409796d0(Camera*, double out[2])` (mouse → camera-2D, 32 callers); callers then apply ISO⁻¹ (a 2×2 ground inverse) to get `(x, z)`. The tile picker `FUN_1408abc50` takes `floor(x), floor(z)` → **1 world unit = 1 tile, OBSERVED**. World→screen has no shared helper: the iso projection is inlined at ~12 sites | `p2_MouseLocal`, `p2_IsoUserA` |
| **2D cull** in `FUN_1409b0a50` transforms the object's bbox by the affine part of the stack top only (w ignored) and tests against NDC bounds `0x1413c5c20..38` written by `FUN_1409febb0`; it runs only while the counter `DAT_1413c5c90` is 0. **Autoflip** `FUN_140a082b0` = `det4x4 < 0`; column 0 is negated when the sign differs from the base ortho's (negative) | `r3d_*FUN_1409b0a50*`, disassembly |
| Correction to pass 1: `FUN_14097ac40` is **not** a tessellation LOD; it sets the SWF root scale to `(1/zoom, flip/zoom)`, cached per renderer and recomputed on every draw whose camera zoom/flip differs from the cache (`FUN_14097ad80`). No per-frame curve LOD exists on this path | disassembly |
| **Shadows are already ground-plane world objects**: `glaiel::Shadow` owns a second transform that copies the owner's x,z and forces height 0; an SWF child named `shadow` is mapped back into world through the inverse ISO matrix | `FUN_140794850`, `FUN_140794800` |
| Screen-space helpers: `camera_to_world` = ISO⁻¹ × VP⁻¹ (ground lighting), `camera_mat` (water, textured tiles), `shaded`/`reflections`/clip textures; post-process chain; render-to-texture with MSAA from settings | `FUN_14078f820`, `FUN_140891300`, shader sources |
| Shaders load as `"shaders/"+name` through the include-aware resource loader → **replaceable via `-modpaths`**; the engine does **not** prepend `#version` | `FUN_1409bb220`, `FUN_140a56ca0` |
| 2D **screen-space frustum cull** per display object (see the cull row above) | `FUN_1409b0a50` |

**Reading:** a Flash-style display list flattened into instanced, indirect draws, where the GPU gets
a 4×4 per object that the engine fills as `ortho(1280×720) × camera2D × [iso-projected 3D position
+ 2D scale/rot] × SWF affine`. Every ingredient of a 3D pipeline is present except a camera that
produces depth and floor art that lies down.

---

## 2. The board's geometry (OBSERVED)

From the vanilla SWFs (read with the repo's `editor/src/core/art/swf-reader.ts`; px = twips/20 at
authoring scale) and the projection constants:

| Symbol | Bounds / shape | Meaning |
|---|---|---|
| `MetalTile` | 140 × 71, polygon `(70,0) (0,35) (-70,0) (0,-35)` | **2:1 diamond centred on the tile centre** |
| `RoadTile` | 4 × (70 × 35 diamonds) | quarter-tile sub-diamonds |
| `ShadowTile` | 144 × 75 ellipse | ground blob |
| `TallGrassBack` / `Front`, `TallBrambleTileBack/Front`, `FloatingGlassTileBottom/Front` | split halves above / around the centre | **back half behind the character, front half in front** — 2D occlusion faked by splitting |
| `CharacterMask` | 800 × 1616, y[-1600, +16] | stencil mask above the feet line; drives `water_mask small/medium/medmed/big/square` sinking |
| `Rat` 61 × 63, y[-44.5, +18.7]; `Fly` y[-54, +8] | **registration at the feet** | sprites hang from their tile's world point |
| `Tree` 525 × 664, `PowerPole` 162 × 661, `TallPipe` 111 × 628 | feet-registered tall props | standing class |
| `AlleyBGTest`, `SewerBG`, … | 1533 × 1150 plates at (0,0) | painted backdrops |

Projection constants `(0.894, 0.447) = (2,1)/√5` mean one world unit along x or z projects to a
unit-length screen vector at slope 1:2, and one unit of height projects straight up by 1.0. As a
real camera that is:

```
orthographic, yaw 45° (looking along a grid diagonal), pitch 30° (sin 30° = 0.5 gives the 2:1 ratio)
ground scale  k = 0.894 / cos 45° = 1.265 screen units per world unit
height scale     = 1.0   (a consistent camera would give k·cos 30° = 1.095)
```

So the engine's iso projection is a yaw-45°/pitch-30° orthographic camera **with heights squashed by
0.913**. Any 3D camera that wants to reproduce today's frame exactly must keep that squash on upright
sprites at the default angle (then blend it toward 1.0 as the pitch changes, or keep it — it is a
style constant, not a bug). World units are tiles (`ground_lighting.shader` divides by the 10-tile
board), so tile `(col,row)` ≈ world `(col, 0, row)` — **INFERRED**; the exact `TacticsGrid`
(col,row)→transform function and the tactics camera's zoom were not recovered (§6).

GON already speaks this language: `projectile_spawn_offset [.5 1]` (x, height in tiles),
`uifloaters_offset 1.7`, `depth_offset .01/-.1/5`, `scale .75`, `size 2x2`, `shadow none`,
`render_layer background|splatters|sorted_distortions|top`, and the AI preset
`keep_distance_face_camera { face_camera 1000 }`.

---

## 3. What "actual 3D, paper-style" has to mean for this scene

World frame: ground plane `height = 0`, tile `(col,row)` at `(col, 0, row)`, board in `[0,10]²`.
Four render classes:

| Class | Members | 3D treatment | How the default camera reproduces today |
|---|---|---|---|
| **Floor** | tile art, `Shadow` blobs/`ShadowTile`, splatters, movement/targeting highlights, cursor diamonds, ground particles, water/lava/gas surfaces, lighting quad | Lie flat on the ground. The art is *pre-skewed* diamonds, so pre-multiply the object's SWF affine by **ISO⁻¹ restricted to the ground** (diamond → unit square; the engine already does this for `shadow` children), then place on the ground plane with the new basis. | Projecting the unit square back through the default basis yields the identical diamond — pixel-identical by construction. |
| **Standing** | characters, enemies, props, pickups, projectiles, hit effects, UI floaters, tall-tile halves, text | **Billboard anchored at the feet** at the transform's `(x, height, z)`. Default **upright / cylindrical** (world-up, yaws to the camera) with the 0.913 height factor; per-asset option view-plane-aligned. Visual height offsets (`projectile_spawn_offset.y`, lob arcs, `KnockUp height`) already live in the transform's `height`. | Same anchor pixel, same size → same pixels. |
| **Screen** | HUD (`ui.swf`), menus, tooltips, post-process, `combat_ui_background` | Untouched: they are drawn by other cameras (layer bitmask), so hooking only the tactics camera leaves them alone. | Untouched. |
| **Backdrop** | `combat_background` plates | Camera-locked plate behind everything (or a far billboard); parallax under rotation is inherently fake. | Untouched at default. |

**Why upright rather than camera-facing.** Vertical planes standing on one ground never intersect
each other, so with a depth buffer they can never occlude in the wrong order, and they stay correct
next to genuine meshes (§4-D). A camera-facing (spherical) billboard anchored at the feet leans back
and its top clips into whatever stands behind it — the classic 2.5D bug (bgolus thread, §5).
Octopath and Don't Starve keep sprites upright; Don't Starve steps its rotation and *flips* sprites
rather than rotating them, which fits this art (it only has `art_flip`). The hybrid "draw
camera-facing, write depth as if upright" is a later refinement.

**Depth and order.** Keep the engine's per-layer CPU sort (it handles translucent anti-aliased vector
edges correctly) but **replace the key**: today `x + z` *is* the view depth of the default camera, so
the general form is "dot(position, camera forward)" — hook the key recompute (`FUN_14078d480` and
its two inlined copies) or install a layer key functor (layer+0x60). Write **one depth per object**
(the anchor's) so a symbol's sub-shapes keep their display-list layering, and keep `depth_bias` as
the tiny intra-layer offset it is. Enable the depth test (bit 1 of `0x1412f714c`) only when meshes
join the scene, otherwise painter's order suffices as it does today.

**Shadows, lighting, water, masks.** `Shadow` is already a ground-plane world object (height forced
to 0) → floor class for free. `shadow_occluded.shader` samples a screen-space `shaded` texture by
`gl_Position` → fine under any camera as long as the shadow pass uses the same camera.
`ground_lighting.shader` maps screen → ground via `camera_to_world = ISO⁻¹ × VP⁻¹`: still an affine
map for any orthographic camera (no shader change), a homography under perspective (one-line `/w`
patch, data layer). `water.shader` reflections are a vertical screen flip: exact only at the default
pitch — disable or accept off-angle. `CharacterMask`/stencil masks are display objects under the
same renderer → they follow their sprite. Tall-tile front/back halves become two billboards at the
tile's near/far edge (identical at default, no longer a cardboard sandwich off-angle).

**Camera control.** Yaw/pitch/zoom state lives in the mod; input via the SDL3 DYNAPI event path (the
framework already hooks DYNAPI slots) or ImGui (compiled in). Mouse wheel = zoom or yaw per setting;
"reset" snaps to 45°/30°/ortho. **Limit or step the yaw** (Don't Starve uses 45° steps): beyond ±45°
"facing the enemy" stops reading, and reviewers of the Stardew 3D mod found free-spinning billboards
tiring. Clamp the pitch (steep angles make upright sprites clip the floor).

**Perspective vs orthographic.** Orthographic is what the art was made for, keeps every screen-space
trick affine, keeps the engine's 2D cull and zoom-driven tessellation valid, and — decisively — keeps
**all 23 direct readers of the ISO matrix correct** (mouse picking, AOE previews, UI floater
placement) because a rotated orthographic ground view is still one 2D affine map. Perspective is the
Octopath look; it needs the real `P·V` path and the fix-ups listed in §4-B2.

---

## 4. Where to inject: levels, with the decompiled hooks

### A. Pure OpenGL interception
Because `mvp` is a per-instance attribute and vertices are SWF-local, a wrapper on the GLEW slots
(`glVertexAttribPointer` `0x1413bc6e0`, buffer uploads, the indirect draw) or on the instance writer
`FUN_140a47e50` *can* rewrite every object's matrix. What it cannot do is **classify**: at that level
there is no entity, only a matrix snapshot. Heuristics (2:1-symmetric bounds = floor?) give the
Helix/3DMigoto "pop-up book" at best. Useful as a diagnostic to validate the matrix layout
(log the first few instance records), not as the product.

### B1. Orthographic orbit — hook the engine's own projection (recommended first deliverable)
The engine already projects 3D positions through one global matrix, so a rotated orthographic
camera is **a data change plus three small hooks**:

1. **Per frame, rewrite `ISO` (`0x1412f7a00`) and `ISO⁻¹` (`0x1412f79c0`)** with the basis of the
   current yaw/pitch: x → (cos y·k, sin y·sin p·k), z → (−sin y·k, cos y·sin p·k), height → (0, h).
   Every consumer follows: `RendererIso` positions (`FUN_14078d600`), `Shadow` placement,
   `camera_to_world`, and the 23 picking/preview sites. Zoom stays the camera's own (cam+0x168).
2. **Floor hook** in `FUN_14078d600` (or in the DisplayObject matrix for the tile's root): for
   floor-class objects pre-multiply the SWF affine by `ISO_default⁻¹|ground` so the diamond art is
   un-skewed, then by the new ground basis — the result is still a 2D affine, which is why no
   shader or vertex change is needed. Classify by walking the Renderer's entity components
   (`TacticsTile`, `Shadow`, splatter layers → floor; `Character`/`TacticsObject` → standing; the
   known `Entity_FindComponentsByTypeId` at `0x969f90` does this).
3. **Sort-key hook**: replace `x + z` with `dot((x,z), ground forward)` (same three sites as above),
   so back-to-front stays right when the board turns.
4. **Billboards need nothing**: sprites are already screen-facing planes whose height axis is the
   ISO matrix's `(0, h)` column; set `h` to keep the 0.913 squash at the default pitch (or
   `cos(pitch)/cos 30°·…` if you prefer physically consistent foreshortening).
5. Shader fix-ups: `camera_to_world` is derived from the same matrices (automatic);
   `camera_mat` users (water/textured tile) get the new basis via the same hook as `FUN_140891300`.

Everything stays within the engine's 2D-affine batching, culling and tessellation. Expected cost:
**about a week** to a PoC once the signatures are added to `bindings/` (§7 phase 0).

### B2. True perspective — hook the camera view-projection (pass-2 facts applied)
Replace `FUN_1409785e0` for the scene camera only (recognise it in `Camera::render`
`FUN_1409787c0`: render-to-texture flag `cam+0x80` set and the board layers in its bitset; the UI
camera is the one on layers 0x25..0x30) with `P_persp × lookAt` expressed in the **1280×720
virtual-pixel convention** the base ortho expects, with view z scaled so the scene fits ±10 000
units (`m10 = 1e-4` in the base ortho is the only z knob; depth is 24-bit over that range). In
`FUN_14078d600` emit `(x, height, z)` into m12/m13/**m14** with an upright billboard basis instead
of the pre-projected point. Then:
- **cull**: keep the cull-disable counter `DAT_1413c5c90` non-zero (data-only; the inc/dec pairs are
  balanced so it stays non-zero), or hook `FUN_1409b0a50` to divide by w;
- **autoflip**: keep `sign(det(VP_new)) == sign(det(VP_vanilla))`, which is negative with
  flip −1; a GL-style perspective may come out positive — negate the z row if so;
- **zoom**: keep `cam+0x168` constant ("pixels per unit at the focal plane") so `FUN_14097ad80` does
  not rescale every SWF root each frame; distance-dependent sizing belongs in the model matrix;
- **depth test**: set bit 1 of `0x1412f714c` for scene layers once meshes are present; write one
  depth per object and keep `depth_bias` (20 z units per unit) as the sub-shape offset;
- **picking**: hook `FUN_1409796d0` to cast the mouse ray, intersect the ground plane and return the
  **iso-2D equivalent** `(a·x + c·z, b·x + d·z)` — every ISO⁻¹ consumer (tile picker, AOE origin,
  cursor) then works unchanged; one hook instead of 23 sites;
- **floaters**: world-anchored objects drawn by the scene camera are correct automatically (they go
  through the matrix stack); only screen-space overlays that inline the iso projection
  (`FUN_14010eef0`, `FUN_1401571f0/78b0/7f40`, `FUN_14016c700`, … unclassified) may need a hook;
- **shaders**: patch `ground_lighting` (`/w`), `water*`, `textured_tile`, `shadow_occluded*` via
  `-modpaths`.

### C. Flash-Player-10 2.5D semantics on top of B
Flash Player 10 added `DisplayObject.z`, `rotationX/Y/Z`, `transform.matrix3D` and a per-root
`PerspectiveProjection`; this engine's SWF player stopped at `Matrix3x2`. Adding an optional 3D
transform per display object (side table keyed by pointer — the class layout is frozen) and
concatenating it in the B hook gives **data-level 3D placement**: a GON key per movieclip/tile/
character such as `render3d { mode floor|billboard|upright|screen; offset [x y z]; tilt 0 }`, which
the editor's validator can check like any other key. Borrow Flash's *data model*, not its
painter-only compositing (Flash never depth-sorted; §5). A few weeks beyond B.

### D. Genuine 3D objects (meshes)
Vanilla art stays planes; meshes need their own draw calls, and pass 2 pinned down exactly how:
- **Submission**: wrap the GL calls in a `std::function<void()>` and submit it through
  `FUN_140a47820` while the frame is being recorded (from a `Camera::render`, layer-render or
  `Renderer::render` hook, or a `CallbackOnRender` display object, vftable `0x14112ec98`). It runs
  at replay in `FrameEnd`, in recorded order, with the camera's FBO and viewport bound. Direct GL
  calls made during recording execute **before** every batched draw of the frame — do not do that.
- **Target**: the camera's FBO `rt+0x1c`, between its bind and unbind lambdas; colour RGBA8 or
  RGBA16F (HDR flag), depth **GL_DEPTH24_STENCIL8 multisampled** with the main RT's sample count.
  The depth buffer is a renderbuffer: a mesh pass can test against it but cannot sample it (blit
  `GL_DEPTH_BUFFER_BIT` yourself before unbind if you need it).
- **State**: inside the functor save/restore program, VAO, `GL_ARRAY_BUFFER`,
  `GL_DRAW_INDIRECT_BUFFER`, the instance VBO and depth/stencil/blend/mask state, or set the next
  group's force bit; the batcher otherwise re-applies only changed state.
- **Matrix**: the same `P·V` the hook feeds the sprites (in B1 the rewritten ISO basis plus a depth
  row), with the ±10 000 z convention and the negative determinant.
Needs a small mesh loader (OBJ/glTF via `-modpaths`), a palette/lighting-compatible shader,
`FW_Register3DObject`-style registration, and a GON binding so a data mod can say "this prop is
`models/crate.glb`". Weeks; independent of C once B exists.

### Why not "replace the renderer"?
Re-implementing the SWF display list + instanced batching + stencil masks + post chain is months of
work and forks the art pipeline. B/C/D ride on the vanilla renderer and inherit every future art
change for free.

---

## 5. Prior art and what it says about the pitfalls (COMMUNITY-SOURCED)

Web research pass, 2026-10-18; tcrf.net skipped. No public project re-projects a batched 2D GL
game into a full 3D scene by injection; the useful neighbours:

| Precedent | Injection point | Lesson for us |
|---|---|---|
| **Helix Mod / 3DMigoto / geo-11** stereo fixes for 2D games (Hollow Knight, Silksong) — https://helixmod.blogspot.com/2017/06/hollow-knight.html , https://github.com/bo3b/3Dmigoto/wiki/Using-3Dmigoto-to-find-and-fix-shaders | DX wrapper DLL; replace shaders by hash, push each layer to a depth, HUD on a hotkey preset | The "depth per draw call" family is our level A. Needs a HUD special case and **breaks on every game update** — same discipline as our fail-closed signatures. |
| **NVIDIA stereo rules** — GTC 2010 "Implementing Stereoscopic 3D" (cgvr.informatik.uni-bremen.de PDF), nv3dva docs | driver | `parallax = sep·(1 − conv/W)`: an orthographic pass has W = 1 everywhere, hence "flat". Any 3D-ification must synthesise real depth per object — which replacing `mvp` does. |
| **3dSen / 3DNes** — https://geodstudio.net/ ; **snes9x-3ds-parallax** — https://github.com/rcmz/snes9x-3ds-parallax-3d | emulator, intercepts PPU tiles/sprites | Classifying draws **without object identity** needs hand-written per-game profiles and "can never be 100% perfect". Argues for hooking where identity is known (B). |
| **Stardew Valley "The Third Dimension"** (spacechase0, 2026) — https://www.pcgamer.com/games/life-sim/help-i-cant-decide-if-stardew-valley-in-3d-is-amazing-or-horrifying/ | in-engine mod (SMAPI/MonoGame) | Closest architecture: true-3D terrain, **billboards for nearly everything else**, real models per object later. Reviewers found freely rotating billboards unsettling → limit/step the yaw. |
| **Don't Starve** — https://forums.kleientertainment.com/klei-bug-tracker/dont-starve-together/onground-deployables-have-wrong-sort-order-r33195/ | shipped engine | `AnimState:SetOrientation(OnGround | BillBoard)`, `SetLayer`, `SetSortOrder`: exactly the floor/upright split; camera rotates in steps; sprites flip instead of having backs. |
| **Cult of the Lamb** — https://steamcommunity.com/app/1313140/discussions/0/3448087385671383167/ | shipped (Unity) | "All the art is drawn in 2D, then we put it in a 3D world. The 2D objects are also writing to depth … then we rotate them towards the camera." Fixed shallow tilt; custom sorting was needed. |
| **Octopath / HD-2D** — https://dev.to/gaurav_de/creating-an-hd-2d-rendering-pipeline-on-dx12-205k | shipped / rebuild | Upright sprites in a polygon world; alpha-tested shadow pass or invisible proxy casters so sprites do not float; tilt-shift DoF sells the diorama. |
| **Billboard math & clipping** — Lighthouse3D billboarding tutorial; bgolus, https://discussions.unity.com/t/problem-solving-2d-billboard-sprites-clipping-into-3d-environment/743786 ; raylib `DrawBillboardPro`; Godot `BILLBOARD_FIXED_Y` | reference | Cylindrical = world-up + yaw; spherical = view rows. Feet-anchored spherical sprites lean into geometry behind them; fixes: upright, or **camera-facing with depth written as on the upright plane**. For a tilted orthographic camera, scale sprite height to restore the 2D look. FFT/Disgaea sort everything as 2D with the depth test off (which is what this engine does today). |
| **Matrix-only 2D→3D in open engines** — LÖVE g3d, libGDX `DecalBatch` + `CameraGroupStrategy`, Unity `TransparencySortMode.Perspective` | reference | A renderer whose shader is `mvp·(x,y,0,1)` goes 3D by changing only the matrix composition **as long as one draw = one object** — here one *instance* = one object, which is equivalent. |
| **Flash Player 10 2.5D** — Adobe AS3 dev guide (`DisplayObject.z`, `rotationX/Y`, `transform.matrix3D`, `PerspectiveProjection`), Scaleform 3Di notes, Ruffle PR #24473 | reference for level C | x right, y down, z into the screen; `focalLength = (w/2)·cot(fov/2)`; `p' = c + (p−c)·f/(f+z)`; **an object at z = 0 renders identically at any FOV**. But Flash did **no depth sorting and no culling** and forced `cacheAsBitmap`; no open-source player renders it faithfully yet. |
| **Mewgenics itself** — https://simonparzer.com/projects/mewgenics/ (console port notes), Glaiel's engine essay on gamedeveloper.com | first-party | "A newer version of TEIN's rendering engine" on SDL3; load-time tessellation + bitmap atlas; consoles use pre-baked PSWF. Nothing public on `RendererIso`, depth or the camera; no community rendering mods exist. |

**Pitfalls the precedents agree on** (each maps to a line in §7): translucent anti-aliased edges
need sorted blending or cutout/prepass; the HUD must keep its own matrix; feet-anchored sprites clip
at steep pitch (clamp it); shadows need a floor blob or an alpha-tested pass or sprites float; Flash
affines carry shear/non-uniform scale that must be applied *inside* the sprite plane, never to the
billboard basis; every update breaks the hooks.

---

## 6. Hook points (decompiled, build 25143593)

| Function / data | VA (RVA) | Signature (guess) | What a 3D mod does there |
|---|---|---|---|
| **ISO matrix** (data) | `0x1412f7a00` (`0x12f7a00`), float[16] col-major; inverse `0x1412f79c0` | — | B1 step 1: rewrite per frame with the rotated orthographic basis (keep the inverse consistent). Read by `RendererIso`, `Shadow`, `camera_to_world` and 23 picking/preview sites |
| **RendererIso local mat4** | `FUN_14078d600` (`0x78d600`) | `float* (RendererIso*, float out[16])` | **Primary hook.** B1: floor un-skew for floor-class entities. B2: write `(x, height, z)` into m12/m13/m14 with a billboard basis |
| Plain transform mat4 | `FUN_1409b4c90` (`0x9b4c90`) | `float* (Transform*, float out[16])` | Same for non-iso renderers; also used by the camera VP and `Shadow` — filter by caller |
| Interpolated transform | `FUN_1409b4a30` (`0x9b4a30`) | `double* (Transform*, double out[6], double alpha)` → x,height,z,sx,sy,rot | Read interpolated positions, never raw +0x80 |
| Camera view-projection | `FUN_1409785e0` (`0x9785e0`) | `float* (Camera*, float out[16])` | B2: return `P_persp × lookAt` (keep the 1280×720 pixel convention). Zoom +0x168, flip +0x170 live here |
| Camera::render | `FUN_1409787c0` (`0x9787c0`) | `void (Camera*)` | Tell the tactics camera from UI cameras (layer mask +0xc8, order +0xa0); enable depth test for its layers |
| Renderer / RendererIso render | `FUN_14098cbb0` / `FUN_14078cf10` | `void (Renderer*)` | Alternative seam: push your own model matrix |
| Iso depth key | `FUN_14078d480`; inlined in `FUN_14078d3d0`, `FUN_14078d4c0` | `void (RendererIso*)` | Replace `x + z` with view-space depth |
| Layer render / sort | `FUN_1409896f0`; comparator `0x140988dd0`; key `0x140988d30`; key functor at layer+0x60 | `void (Layer*, Camera*)` | Swap the key functor or comparator; force type-1 (depth-tested) layers when meshes are present |
| Instance writer | `FUN_140a47e50` (`0xa47e50`) | `void (Batch*, u32 key, u32, int firstIdx, int count, int baseVtx)` | Last resort per-draw matrix rewrite; also the place to log instance records in phase 0 |
| DisplayObject render | `FUN_1409b0a50` (`0x9b0a50`) | `void (swf::DisplayObject*)` | B2: fix/disable the 2D screen-space cull (`DAT_1413c5c20..38`) |
| Tessellation LOD | `FUN_14097ac40` | — | B2: per-object curve resolution instead of `1/zoom` |
| Shadow placement | `FUN_140794850`, `FUN_140794800` | — | Already ground-plane; verify the `shadow`-child mapping under the new ISO⁻¹ |
| `depth_offset` writer | asm `0x1400f2f92` in `FUN_1400f1150` (character graphics init) | — | Keep: becomes a view-depth bias |
| Shader::compile | `FUN_140a55470` (`0xa55470`); gate `FUN_140a49d20` | `void (Shader*)` | Not needed (GLSL replaceable via `-modpaths`); hook only to inject defines |
| GLEW table | `0x1413bc370…0x1413bdea0` (`glUniformMatrix4fv` `0x1413bc5a8`, `glVertexAttribPointer` `0x1413bc6e0`, `glVertexAttribDivisor` `0x1413bc908`) | — | Level A / D: wrap entries after `glewInit` (after the "Initiating Graphics" log line) |
| IAT GL | `glEnable` `0x140e3f858`, `glDisable` `0x140e3f7f8`, `glDepthMask` `0x140e3f898` | — | Force `GL_DEPTH_TEST` for the 3D scene camera |
| Render-state flags | `DAT_1412f714c` (bit1 depth test, bit2 stencil, bit3 depth mask) | — | Set bit1 for scene layers when z-buffering is wanted |
| `CallbackOnRender` | vftable `0x14112ec98` | — | Level D: custom mesh draws inside the display-list order |
| **Base ortho** | `FUN_1409fec80` (`0x9fec80`) | `void (MatStack*, float L, float R, float B, float T)` | Sole pixels→NDC map; `m10 = 1e-4` is the z scale; sets the autoflip base flag. Hook it, or patch the stack top after FrameBegin |
| FrameBegin / FrameEnd | `FUN_1409b7870` / `0x1409b7d80` | `void (ApplicationBase*)` | Resets depth_bias, stack and letterbox floats; FrameEnd replays the batch (`0x1409b7f15`) then swaps (`0x1409b8024`) |
| **Enqueue GL functor** | `FUN_140a47820` (`0xa47820`) | `void (void*, std::function<void()>&)` | **The** way to insert custom draws in order (level D) |
| Batch replay | `FUN_140a481d0`; groups at `0x1412f80f0` (0x30 B each: material, VAO, flags, blend, mode, count, functor) | `void (Batch*)` | Group state → functor → draw |
| Indirect draw | call `0x140a486fd`, GLEW slot `0x1413bd5f0`; fallback slot `0x1413bccc8` at `0x140a48321` | — | Per-batch draw interception (diagnostics) |
| State applier | `FUN_140a497d0` | `void (Group*)` | bit1 depth test, bit2 stencil, bit3 colour+depth mask |
| RT create / resolve | `FUN_140a28a80(RT*, w, h, samples, type, hdr, depth)`; resolve `FUN_140a29150`; bind/unbind lambdas `0x140a29d90` / `0x140a29d20` | — | D24S8 MSAA renderbuffer; colour-only resolve; FBO `rt+0x1c` current between bind and unbind |
| Cull bounds / disable | `FUN_1409febb0` writes NDC bounds `0x1413c5c20..38`; counter `DAT_1413c5c90` | — | Non-zero counter ⇒ no DisplayObject culling (data-only perspective fix) |
| Handedness | `FUN_140a082b0` | `bool (float m[16])` = det < 0 | Keep the VP determinant negative |
| **Mouse → camera-2D** | `FUN_1409796d0` (`0x9796d0`) | `double* (Camera*, double out[2])` | **Single picking hook** for perspective: return the iso-2D equivalent of the ray/ground hit (32 callers follow) |
| Mouse → virtual px | `FUN_140986ee0` | `void (Input*, double out[2])` | Letterbox-aware; hook only if the virtual space changes |
| Scene camera lookup / current camera | `FUN_1401b1070` (component type 7) / `DAT_1413c6d88` | `Camera* (Component*)` | What gameplay calls "the scene camera"; the camera rendering right now |
| Layer-range setter | `FUN_140979c30` | `void (Camera*, int lo, int hi)` | Layer bitset `cam+0xc8`; the UI camera is 0x25..0x30 |
| Scene camera builder | `FUN_140764da0` (called from `FUN_14031d200`) | — | Creates the three combat cameras (RTT+HDR, scale 1.15, UI) |
| Root scale from zoom | `FUN_14097ac40` → `FUN_1409b16c0(root, 1/zoom, flip/zoom)`, trigger `FUN_14097ad80` | — | Not an LOD; keep zoom constant per camera |
| Tile picker | `FUN_1408abc50` | `int2* (TacticsGrid*, int2* out, double off[3])` | Confirms tile = floor(world x, z) |

**Resolved by pass 2**: the pixels→NDC base matrix and z range; the camera defaults (zoom 60,
flip −1); the `glMultiDrawElementsIndirect` call site; the thread model; the FBO format; the picking
helper; tile = floor(world) (so the exact (col,row)→transform writer is no longer needed for the PoC).
Pass-1 corrections: `FUN_140a295e0` is `RenderTarget::blit_with_shader`, not bind; `FUN_14097ac40`
is a root-scale update, not tessellation LOD; render-state bit 3 drives colour **and** depth mask;
ISO⁻¹ is a 2×2 ground inverse.

**Still not determined** (and why): the scene-vs-UI roles inside `FUN_140764da0` and its owning
class (its decompile was queued behind a hung call); `FUN_140833390` (two ISO reads, hung Ghidra at
30 GiB — skipped); which of the ~12 inlined world→screen sites are UI floaters vs world objects; the
FrameEnd blit lambda body (`0x1409bc9f0`) and `FUN_140a20710`; which extensions `FUN_140a49de0` /
`FUN_140a49eb0` test (MDI vs persistent mapping); GON defaults for `zoomer` / `camera_bounds`; the
particle depth sorter and `DepthTrackingBehindEffect`; the uniform-path upload at `0x140a5543b`
(irrelevant with `ARB_base_instance`); how `SetRenderLayer` changes a renderer's layer at runtime.

---

## 7. Plan, effort and risks

**Phase 0 — confirm (days).** Sign the §6 functions into `bindings/25143593.json` (then `npm run bindings:gen`) /
`signatures.h` (data addresses go in `BuildInfo`, as the vtables do today). Log a few instance
records from `FUN_140a47e50` to confirm the mat4 layout in a live frame, and log each
`Camera::render` (layer bitset, RTT flag, zoom) to confirm which of the three combat cameras is the
scene camera. The z range, camera defaults and tile mapping are now known statically.

**Phase 1 — orthographic orbit PoC (~1 week).** B1: per-frame ISO/ISO⁻¹ rewrite from a yaw/pitch
state; floor-class un-skew in `FUN_14078d600` with entity-based classification; view-depth sort
key; mouse-wheel yaw/zoom through the DYNAPI event hook; UI untouched. Acceptance: at 45°/30° a
screenshot diff against vanilla is empty; turning the board shows cats standing on a flat diamond
grid, shadows and targeting previews following, picking still correct.

**Phase 2 — perspective + robustness (1–2 months).** B2 (camera VP, cull, tessellation, depth test,
ray-picking for the 23 ISO readers, shader patches via `-modpaths`), per-asset `render3d {}` GON
classification validated by the editor, tall-tile halves, reflections toggle, settings UI (ImGui),
save-safe launch only (`-savesuffix dev`), fail-closed on unknown builds.

**Phase 3 — 3D mods (weeks).** `CallbackOnRender`/draw-slot hook, mesh loader, `FW_*` API, GON
binding, editor validation of model references via `registered-names.json`-style registration.

**Risks / unknowns.**
- Everything is pinned to one build; an update means re-deriving ~10 signatures plus the ISO data
  address (same discipline as the status engine; a broken signature disables the mod, never crashes).
- Translucency sorting under free rotation is the classic 2.5D problem; upright constant-depth
  billboards and the per-frame back-to-front sort handle the common cases, intersecting billboards
  never look perfect (Don't Starve, Paper Mario and Octopath all live with it).
- Screen-space art (backgrounds, reflections, some full-screen effects) can only be approximated
  off-angle.
- Perspective's picking cost shrank to one hook (`FUN_1409796d0`) plus a handful of inlined
  world→screen overlay sites still to classify; orthographic avoids even that, which is why B1 ships
  first.
- Depth precision: 24 bits over ±10 000 view units with the stock base ortho; a perspective hook
  should either scale z into a few hundred units or hook `FUN_1409fec80` to change `m10`.
- Text and UI floaters are vector shapes in the same display list; keep them view-aligned regardless
  of the global billboard mode so they stay readable.

---

*Static + decompiled analysis; nothing executed in the game yet. Companion docs:
[`engine-map.md`](engine-map.md) (build identity, hooks, REA sessions), [`art-pipeline.md`](art-pipeline.md)
(shaders, SWF runtime), [`spatial-model.md`](spatial-model.md) (gameplay is 2D). Full RE notes:
`.analysis/rea-renderer-report-2026-10-18.md` (git-ignored).*
