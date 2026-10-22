# Mewgenics art pipeline (feasibility + how-to)

How Mewgenics represents and uses its art assets — images/textures, SWF vector art,
character rigs/animation, palettes, and shaders — and what a mod can change through the
data layer (`-modpaths`), what needs native code, and what needs external authoring tools.

Target build 1.1.21239 (Steam build id 25143593), `Mewgenics.exe` SHA-256
`4127cd6a…eb77ea`, image base `0x140000000`. Read-only reconnaissance: no game bytes,
`resources.gpak`, or save was modified. Evidence reuses the existing `.analysis/` Ghidra
export (`list_names.tsv`, `decompiled/`), the `.extracted/` GON/shader copies, and
`tools/gpak.py` listings; no new Ghidra session was needed.

Every claim is tagged **OBSERVED** (from the binary, shaders, GON, or a read-only pack
listing on this machine), **INFERRED** (derived reasoning), or **COMMUNITY-SOURCED** (public
docs/mods, with a URL). Where OBSERVED and COMMUNITY-SOURCED facts corroborate, both are noted.

---

## TL;DR — "to mod art, you need…"

| Task | Layer | Difficulty | What it takes |
|---|---|---|---|
| Recolor a cat/class/enemy with an **existing** palette | Data (GON `.merge`) | Trivial | Change `palette N` (or `palette <ClassName>`) / add `tint [r g b a]` in a `graphics` block |
| Flat color-tint any actor | Data (GON `.merge`) | Trivial | `tint [r g b a]` (a color multiply) |
| Replace a **texture PNG** (background, liquid, noise, cursor, palette map) | Data (`-modpaths`, whole-file) | Easy | Drop `textures/<name>.png` in a modpath (match dimensions/format) |
| Replace a **shader's** GLSL | Data (`-modpaths`, whole-file) | Easy–Medium | Drop `shaders/<name>.shader`; must still compile and keep the same uniforms |
| Point a tileset/weather at a **different existing** shader | Data (GON `.merge`) | Easy | e.g. `background_shader meatpulse_ground` |
| Replace existing SWF art (reskin a clip in place) | Data (`-modpaths`, whole-file) | Medium | Re-author the whole `.swf` in Flash and override it |
| **Add new** SWF art (new clips/objects) | Data (`swflist.gon.append`) + Flash authoring | Medium–Hard | New `.swf` + `swflist.gon.append`; address new content via AS linkage/frame labels, `_Append_` prefix |
| Add a **new palette** | Native DLL (or fragile whole-file `palette.png` override) | Medium | MewPaletteExtender registers extra 16-color rows; data-only means overwriting `palette.png` |
| Add **new, non-conflicting cat parts/textures** | Native DLL + Flash authoring | Hard | MewCatPartFramework; raw cat parts are frame-indexed ("Frame Reliance") and not safely data-moddable |
| New shader passes / new render effects / new UI | Native code | Hard | Engine compiles a fixed shader set and drives passes in C++ |
| New animation *systems* / rig behavior | Native code | Hard | Rig/animation logic is C++ (`glaiel::swf`, `glaiel::CatParts`) |

**Bottom line (INFERRED):** Mewgenics' primary art is **vector SWF**, not sprite sheets.
PNGs are a supporting role (backgrounds, liquids, noise, cursors, and palette-lookup maps).
Recoloring (palette/tint) and whole-file asset replacement are genuine data-layer mods via
`-modpaths`. Adding *new* parts/palettes cleanly, or anything touching render passes, needs
native DLLs — which the community already provides.

---

## 1. Rendering model — the custom Flash player ("glaielswf")

**OBSERVED** — the SWF player lives in the nested namespace `glaiel::swf` and is a
near-complete Flash runtime built from standard SWF tag classes (RTTI-named vftables in
`.analysis/list_names.tsv`):

- Tag parsers: `SWFTag` (base, vftable `0x1411340b0`), `DefineShape` (`0x14113dab0`),
  `DefineSprite` (`0x141135110`), `DefineBits`, `DefineBitsJPEG`, `DefineBitsLoseless`,
  `JPEGTables`, `DefineFont`, `DefineText`, `DefineEditText`, `DefineButton`-less set,
  `PlaceObject` (`0x14113dc90`), `RemoveObject`, `ShowFrame`, `FrameLabel` (`0x14113dc40`),
  `SetBackgroundColor`, `SymbolClass` (`0x141134088`), `DoAction` (`0x141134df0`),
  `DoABC` (`0x141134bc0`).
- Display list: `DisplayObject` (`0x14112dc08`), `DisplayObjectContainer`,
  `DisplayObjectContainer_DynamicBatched`, `MovieClip` (`0x14112db38`), `Sprite`
  (`0x1411341b0`), `StaticTextBox`, `DynamicTextBox`, `GlyphStyle`.
- Support: `ColorTransform`, `Matrix3x2`, `BitmapFillAtlas` (`BitmapFillAtlas::init`),
  `ReferenceRenderer`, `CallbackOnRender`.

**OBSERVED / INFERRED:** both ActionScript bytecode tags exist — `DoAction` (AVM1) and
`DoABC` (AVM2) — matching the engine-map note about an "ActionScript interpreter"
(`ScriptBindings.cpp`, "ACTIONSCRIPT MOD ON A STRING"). But there is **no scripting VM for
gameplay**; `SymbolClass`/`FrameLabel` are used to bind library symbols and timeline frames
to names that GON data references (see §3).

**COMMUNITY-SOURCED (corroborates):** modders author in Adobe **Flash Professional CS6**
(Animate also opens the FLAs), decompile vanilla SWFs with **JPEXS Free Flash Decompiler**,
and **publish with "compress movie" OFF and AS "strict" OFF** — "both make the movie
unreadable to the game." So glaielswf reads **uncompressed** SWF and treats ActionScript
only as linkage/label identifiers, not runnable script.
(cvs-otherwise-callie docs: https://cvs-otherwise-callie.github.io/mewgenics-modding-documents/ ,
`TOOLS_home.md` / `SWFOverview.md`.)
**COMMUNITY-SOURCED (first-party):** Tyler Glaiel, on X — "We use Animate for art in
Mewgenics… it's the only part of CC that's irreplaceable to us"
(https://x.com/TylerGlaiel/status/2018467258184671272 — text from search index, re-check if
quoting exactly). Edmund McMillen (TechRaptor interview) — "We're just not using the [Flash]
engine at all, it's just Vector art from Flash that's being imported from SWFs… There are
action script calls that we use… but it's just an art tool for this." So the SWF export keeps
**raw vectors + animation timelines**, not flattened bitmaps. The engine ("Glaiel Game Engine",
lineage from *The End Is Nigh*; stack per wiki: SDL3, FAudio, SQLite, dear_imgui, stb) imports
Flash/vector assets (Wikipedia: https://en.wikipedia.org/wiki/Mewgenics ).

> Naming note: "**glaielswf**" is this project's informal label; it returns no public web
> hits. What is OBSERVED is the `glaiel::swf` C++ namespace and its SWF-tag classes in the
> binary (above), which is a real custom SWF runtime regardless of its published name.

### Rendering: how SWF shapes become pixels
**OBSERVED** (`.extracted/shaders/swf_lib.shader`, included by the SWF shaders): tessellated
vector triangles are drawn with a per-vertex `color`, a `texcoord`, a Flash **color transform**
(`mat2x4 color_xform` = multiply + add), and a `depth_bias` (layer z-ordering). Fills come from:
- a **gradient atlas** (`sampler2D gradient_atlas`) — linear and radial SWF gradients;
- a **bitmap atlas** (`sampler2DArray bitmap_atlas` + `samplerBuffer bitmap_atlas_info`, 5
  texels/bitmap) — SWF bitmap fills, sampled with mip levels (`mip_max`), repeat/clamp and
  linear/nearest modes.
- **OBSERVED:** bitmaps in the atlas are **premultiplied alpha** (shader comment
  "unpremultiply the bitmap", `bitmap_color.rgb /= max(bitmap_color.a,.001)`).

**OBSERVED:** vector curve quality is tessellation-driven and tunable per file:
`swfs/swflist.gon` has `per_file_curve_resolution { furniture.swf 3; npcs.swf 6 }`.

**Shader-side renderer objects (OBSERVED, symbol table):** `glaiel::Renderer`,
`RendererBase`, `RendererIso`, `ImmediateRenderer`, `MaskedRenderer`/`MaskedRendererIso`,
`CombatShaders`, `OwnedMaterial`, `Shader`, `Texture2D`, `Texture2DArray`, `BufferTexture`.
Graphics API is OpenGL via SDL3 (engine-map); SDL3 also exposes `SDL_CreateGPUShader` etc.

---

## 2. Images / textures (PNG)

**OBSERVED (`tools/gpak.py list`):** all **53** `.png` files live under `textures/`
(incl. `textures/cursor/`). There is **no** `images/` or `sprites/` directory — character and
object art is not raster. The PNGs are:
- **Palette-lookup maps:** `textures/palette.png` (**16×256**, 8-bit RGB) and
  `textures/fx_palette.png` (**16×128**) — not pictures, but color tables (see §4).
- **Liquid/effect layers** in bottom/top pairs: `blood{top,bottom,color}`, `water{top,bottom,color}`,
  `lava{top,bottom}`, `oil{top,bottom}`, `freezingwater{top,bottom}`, `mutate{top,bottom}`,
  `creep{top,bottom}`, `flowing_blood/debris`, `ice`, `ice_distortion`.
- **Noise/paper:** `color_noise_large`, `grey_noise`, `perlinnoise`, `largegrain`, `filmdust`,
  `dirt`, `road`, `roadx`, `mewgenics-final boss bg effect v2`.
- **Cat eye strips:** `eyestrip1/2/3.png` (e.g. `eyestrip1.png` **525×2100**) — raster eye art
  used as bitmap fills on the cat rig.
- **Cursors:** `textures/cursor/*.png` (attack, heal, move, spell, grab, pet_frame1-4, …).

**OBSERVED — how they're referenced:** shaders sample these by name (e.g. `palettemap`,
`gradient_atlas`, `bitmap_atlas`), and GON data references some by logical name (e.g.
tilesets/weather shader inputs). Note: GON `image` fields that look like PNGs are **not**
these files — `data/spawns.gon` uses `image ["shadow.png" "cat.png"]`, `image ["rat.png"]`
etc., but **no such PNG exists in the pack**; these are **SWF library symbol names** (a
".png"-style naming convention inside the enemy/portrait SWFs). **INFERRED.**

**Renderer expectations (OBSERVED/INFERRED):** atlas bitmap fills are premultiplied-alpha and
mipmapped (favor power-of-two; `palette.png` 16×256 and `fx_palette.png` 16×128 are pow2).
Palette maps are read with exact `texelFetch` (16 wide, no filtering). Standalone effect
textures (eyestrips, water, noise) are sampled by their own shaders and are not all pow2
(`eyestrip1` is 525×2100), so dimensions there are flexible.

**Modding:**
- **OBSERVED — replace a PNG via `-modpaths`: YES.** The file manager resolver
  (`FUN_1409a09f0`, RVA `0x9a09f0`; `.analysis/decompiled/FileManager_ResolveWithOverlays_0x9a09f0.c`)
  resolves *every* requested relative path the same way: it takes the pack copy
  (`GetFileRawPak` `0x9a0670`) as a base, then for each `-modpaths` dir pushes a **plain-file**
  candidate (`GetFileRawLoose` `0x9a0300`) plus `.append`/`.merge`/`.patch` variants. The
  returned base is the **last plain-file override found**, so a plain `textures/foo.png` in a
  modpath **replaces** the pack copy. (Multi-modpath precedence — "later overrides earlier" —
  is per engine-map's live check.)
- **Caveat (INFERRED):** for binaries the override is **whole-file only** (no append/merge),
  and the renderer still indexes into atlases by original layout, so a replacement PNG should
  keep the original's dimensions, channel layout, and premultiplied alpha. Replacing
  `palette.png` wholesale changes *every* palette and conflicts with other mods — prefer the
  native palette extender (§4).
- **Native/authoring:** adding a genuinely new texture that the engine will sample needs a
  code path that requests it; most textures are engine-driven.

---

## 3. SWF pipeline and how the game loads it

**OBSERVED — the SWF manifest** `swfs/swflist.gon` (`.extracted/swfs/swflist.gon`) lists one
`loader` SWF and a `game [ … ]` array of ~37 SWFs plus cutscenes. Art is split by role:
`catparts.swf` (cat body parts), `catanis.swf`/`catanis2.swf`/`2d_catanis.swf` (cat
animations), `portraits.swf`, `enemies*.swf`, `bosses*.swf`, `familiars.swf`, `ui.swf`,
`ability_icons.swf`, `furniture.swf`, `tiles.swf`, `backgrounds.swf`, `effects.swf`,
`particles.swf`, `events.swf`, `house*.swf`, `map.swf`, `familytree.swf`, fonts, and
`cutscenes/*.swf`. The pack holds **115** `.swf` (116 entries incl. `loader.swf`).

**COMMUNITY-SOURCED — three ways GON binds to SWF content**
(cvs-otherwise-callie `SWF_home.md`):
1. **Referencing Moviescripts** — GON names a movieclip to play as an animation.
2. **Moviescript Reliance** — a GON object is defined from a movieclip that has a labeled
   frame; this is **appendable** by giving your clip the main clip's AS linkage name prefixed
   with `_Append_` (e.g. `Furniture` → `_Append_Furniture`).
3. **Frame Reliance** — objects addressed by **raw frame index** with no label/AS name (tiles,
   random stray body parts); documented as **"impossible to mod as of now"** because multi-mod
   frame order isn't guaranteed. (This is why new *cat parts* need a native framework — §5.)

**Authoring (COMMUNITY-SOURCED):** Flash CS6 (or Animate) FLA → JPEXS to copy vanilla
structure → Publish uncompressed, strict-AS off → ship the `.swf`.

**Modding:**
- **Add new SWF art — data layer, via `swflist.gon.append`** (OBSERVED path + COMMUNITY-SOURCED
  how-to): place your `.swf` next to a `swflist.gon.append` adding its filename to `game [ ]`
  (and, if a vector object, a `per_file_curve_resolution` entry). The file manager's `.append`
  overlay merges it into the base list. New content is addressed by AS linkage name / frame
  label; use the `_Append_` convention to extend a file-specific clip.
- **Replace an existing SWF in place** (OBSERVED): drop a whole `.swf` at the same
  `swfs/<name>.swf` path in a modpath (whole-file override, same resolver as §2). Practical only
  if you re-author the whole file in Flash.
- **Native:** the SWF *player itself* (`glaiel::swf::*`) and which SWFs load are C++; new load
  behavior or new tag support is native.

---

## 4. Rigs / animation — what a "rig" is here

There are **no bones/skeleton/mesh** classes (symbol sweep for `Rig`/`Bone`/`Skeleton`/
`SkinnedMesh` returns only unrelated gameplay names like `BoneArmorPassive`). **OBSERVED.**
A cat "rig" is a **part-indexed paper-doll** assembled by `glaiel::CatParts`
(vftable `0x140ed6a30`; also `CatPartID`), posed parametrically, and animated by named SWF
timeline clips.

**OBSERVED — part model (`.extracted/data/catgen.gon`):** `num_bodies/heads/legs/tails/ears/
eyes/brows/mouths = 250` each, `num_textures 250`, `num_claws 10`, `num_palettes 49`,
`num_wrinkles/grayhair 10`. A specific cat selects a part per slot — e.g.
`.extracted/data/custom_cats.gon`: `body`, `head`, `tail`, `leg1`, `leg2`, `arm1`, `arm2`,
`lefteye`, `righteye`, `lefteyebrow`, `righteyebrow`, `leftear`, `rightear`, `mouth`, plus
`texture` (fur pattern), `claws`, `palette`, and `default_frame`. Each value is an integer
index into a `catparts.swf` symbol (procedural parts ~1–250; named/custom parts in the 1000+
range). So appearance = **parts (SWF) + fur texture + palette**.
**COMMUNITY-SOURCED corroboration (wiki /Breed, https://mewgenics.wiki.gg/wiki/Breed):** a cat
is **15 parts across 11 groups** — 5 symmetric (Body, Head, Tail, Mouth, Fur Texture), 5
asymmetric pairs (Legs, Arms, Eyes, Eyebrows, Ears), and 1 fur palette — matching catgen.gon.
Modders who decompiled `catparts.swf` (Nexus articles/9, mods/41) found a `sprites` library of
labeled parts (`CatBody`, `CatLeg`, `CatTexture`) addressed by **SWF frame number** — the same
frame-index model, and the reason new parts need a native framework (§6).

**OBSERVED — parametric faces (`catgen.gon` `faces { … }`):** ~120 named expression presets
(`happy`, `angry`, `shock`, `dead`, `wince`, class `*_portrait`, …), each setting `eyebrow_up`,
`eyebrow_rotation`, `ear_rotation`, `mouth` (open/closed/smile), `eyes` (open/closed), and
`face_offset [x y]`. These are numeric poses applied to the eye/brow/ear/mouth parts, not
separate drawn frames.

**OBSERVED — animations are named SWF clips, triggered from GON:**
- Classes map generic animation names to class-specific clips via `graphics { alt_animations
  [...] }` in `data/classes/*.gon` — e.g. Fighter: `[idle, FighterIdle]`, `[StartTurn,
  FighterStartTurn]`, `[Victory, fighterVictory]`, plus `default_face`/`portrait_face`.
- Abilities name the clip(s) to play in their `graphics` block — e.g. `data/abilities/
  fighter_abilities.gon` Dash: `dash_start_animation dashstart`, `dash_animation dash`,
  `dash_attack_animation dashatk`; others use `animation <name>` (`uppercutatk`, `tailwhip`,
  `quarterswipe`, `falconPunch`, `land`, …). These names are frame labels / symbols in
  `catanis.swf`.

So "trigger animation `dash`" = play the `dash`-labeled clip on the assembled cat rig; the
rig's parts move via the SWF timeline while faces/poses layer on top. **INFERRED** for the
layering detail; the naming/trigger wiring is **OBSERVED**.

**Modding:**
- **Data layer:** retarget which clip an ability/class plays (`.merge` the `graphics` block to
  an existing clip name); pick different existing part indices / `default_face` for a custom
  cat; add a custom cat via `custom_cats.gon.append` using existing part indices + palette.
- **Authoring + native:** new part art or new animation clips are SWF (Flash) work; because raw
  parts are **Frame Reliance** (§3), adding *new, non-conflicting* parts needs
  **MewCatPartFramework** (native) to register them (§6).
- **Appending cat animation frames (OBSERVED 2026-10-22, experiment A0):** the vanilla cat clip is
  `CatTest` (catanis.swf) and vanilla itself extends it with catanis2.swf's `_Append_CatTest`; a mod
  SWF's `_Append_CatTest` merges at boot too, and a `_CAT` unit whose `alt_animations` picks the
  appended label is drawn in that frame with the cat's own parts — provided every slot-named instance
  (`tail leg2 arm2 body leg1 arm1 head`) is an EMPTY 1-frame sprite (`CatParts` fills a hidden or
  empty slot; a visible non-empty one crashes at `Mewgenics.exe+0x741f5d`) — see `docs/engine-map.md`
  "CatTest and the cat animation clips".

---

## 5. Palettes / recoloring

**OBSERVED — exact mechanism (`.extracted/shaders/paletted_full.shader`):**
```
uniform sampler2D palettemap;   // = textures/palette.png (16 x 256)
uniform int palette;            // selected palette row
vec4 outcolor = compute_color_full(v);
vec4 palettechoice = texelFetch(palettemap, ivec2(outcolor.r*15.0+.5, palette), 0);
if(!(abs(outcolor.x-outcolor.y)<.001 && abs(outcolor.x-outcolor.z)<.001)) palettechoice = outcolor;
frag_color = vec4(palettechoice.xyz, outcolor.w) * v.color_xform[0] + v.color_xform[1];
```
So art is drawn in **grayscale (16 levels)**; the gray level (red channel ×15) picks a
**column 0–15**, and the `palette` integer picks a **row**, in `palette.png`. **Only grayscale
pixels are remapped** — already-colored pixels pass through. A palette is therefore a
**16-color ramp** (one PNG row). `palette.png` is 16×256 → up to **256 palette rows**;
`fx_palette.png` (16×128) is the effects equivalent. **OBSERVED.**
**COMMUNITY-SOURCED corroboration:** MewPaletteExtender defines each palette as exactly
"16 hex colors" or a "16×1-pixel PNG strip."

**OBSERVED — the `palette N` field (`data/classes/*.gon`, `data/characters/*.gon`,
`data/custom_cats.gon`):** selects a row. It accepts an **integer** (Fighter `palette 54`,
others 50–55; advanced classes 62–68, `hud_palette 11`; minibosses 76–78; champions up to 137,
144, 145) **or a class name** (`palette Fighter`, `palette Hunter`, …). Random cats use rows
0–48 (`num_palettes 49`); rows ≈49–145 are used by classes/named cats, leaving ~150 free.

**OBSERVED — other recolor levers:** `tint [r g b a]` (and `tint green`) in a character's
`graphics` block is a flat **color multiply** (the SWF `color_xform`), independent of the
palette; components `glaiel::OverridePalette` (vftable `0x14101adb0`) and
`glaiel::JesterPaletteCycler` (`0x140f00008`, the Jester's rainbow cycle) drive palette changes
in C++.

**CRITICAL gotcha (COMMUNITY-SOURCED, Nexus mods/130):** `palette.png` is **one shared table
for cats, abilities AND UI**. Editing a "cat" row can accidentally recolor e.g. fire abilities
or the Necromancer HUD. The "Palette Lab Mod Example" works around this by shipping GON `.merge`
files that relocate the affected uses to free rows (202/203). Plan around the shared table.

**Modding:**
- **Data layer (trivial):** change `palette N` / `palette <Class>` or add `tint [...]` via a
  GON `.merge`. Reusing one of the ~100 unused built-in rows is free if the row's colors suit you.
- **Add a NEW palette:** two real options. (a) **Native (cleanest, COMMUNITY-SOURCED):**
  **MewPaletteExtender** registers extra named rows so GON can say `palette @myMod.paletteID`
  (Nexus 369, https://github.com/Pseudonym-Tim/mew-palette-extender). (b) **Data-only
  (COMMUNITY-SOURCED, done in practice):** overwrite `textures/palette.png` wholesale via
  `-modpaths` (e.g. exported from the web "Palette Lab", loaded via Mewtator, Nexus mods/130),
  optionally with `.merge` files to relocate conflicting ability/UI uses. Works, but a binary
  whole-file replace conflicts with every other palette mod — hence the shared-table caveat.

---

## 6. Shaders

**OBSERVED (`tools/gpak.py list`, `.extracted/shaders/`):** 50 `.shader` files, GLSL
`#version 150`, with a small include system (`std_in.shader`, `swf_lib.shader`). Roles:
- **SWF core rendering:** `swf_lib.shader` (shared), `default`, `default_full`,
  `default_full_clipped`, `default_gradient`, `paletted_full`, `transparent_texture`,
  `textured_tile`.
- **Post/FX:** `chromatic_aberration`/`hq_*`, `distortion_*`, `glitchvignette`,
  `shimmervignette`, `noise_and_vignette`, `vignette_only`, `composite_glow`,
  `variable_piecewise_glow`/`_blur`, `postprocess_blur`, `supersampler*` (AA),
  `jump_flood_init`/`_loop`/`_composite` (jump-flood SDF, for outlines/glow), `water*`, `ice`,
  `ground_lighting`, `shadow_occluded*`, `fog_with_noise`, `godray_with_noise`, `paintify`,
  `saturation_boost`, `overexpose`, `meatpulse`, `crazyeyebackground`, `jester_ui_rainbow`,
  `cursor_basic`/`_latched`, `to_distortion_map_full`.

**OBSERVED — referenced by logical name from data:** `data/tilesets.gon`
(`background_shader meatpulse_ground`, `background_extra_shader water|crazyeye`,
`water_alt_shader blood`) and `data/weather.gon` (`shader shimmervignette`). Note some GON
shader names (`blood`, `crazyeye`, `meatpulse_ground`) don't map 1:1 to filenames, so the
engine maps logical IDs internally — **INFERRED: new shader names are not freely addable from
data.**

**Modding:**
- **Data layer (OBSERVED):** replace an existing `.shader` file via `-modpaths` (whole-file
  override, same resolver as §2) — e.g. tweak `water.shader`. It must still compile and keep the
  same uniform/attribute contract (`std_in.shader` / `swf_lib.shader` interface). You can also
  `.merge` a tileset/weather to point at a **different existing** shader.
- **Native (INFERRED):** new shader passes, new post-process effects, or new logical shader
  names driven by the renderer (`glaiel::CombatShaders`, `Renderer*`) require C++.

---

## 7. Community tooling and frameworks (how modders actually make art)

**COMMUNITY-SOURCED.** Hubs: community wiki **mewgenics.wiki.gg/wiki/Modding**; mods on
**Nexus Mods** (https://www.nexusmods.com/mewgenics, large active community) + GitHub; Discords
discord.gg/Mewgenics and the wiki server. A **Thunderstore community page exists but is empty**
(https://thunderstore.io/c/mewgenics/); **no Steam Workshop yet** (official support said to be
planned). The authoritative **art** guide is cvs-otherwise-callie's docs site
(https://cvs-otherwise-callie.github.io/mewgenics-modding-documents/ , repo
https://github.com/CVS-otherwise-Callie/mewgenics-modding-documents ); see also the Nexus
modding article (https://www.nexusmods.com/mewgenics/articles/2) and wiki Modding page.

**Loaders / managers (COMMUNITY-SOURCED):** data mods are enabled through **Mewtator** (mod
manager; unpacks `resources.gpak`, toggles mods, launches with `-modpaths`; Nexus mods/1).
Native DLL mods load through one of two `version.dll`-proxy stacks: **Mewjector** (used by the
Pseudonym-Tim/ParaboxAPI frameworks; already installed built-from-source in this repo's
`native/`), and **Pilout's Mewgenics Mod Framework** (NativeAOT loader + a C#/.NET 8 SDK
`MewgenicsModSdk.dll`, Nexus mods/183).

- **MewCatPartFramework** (native DLL; Nexus 489, https://github.com/Pseudonym-Tim/mew-cat-part-framework):
  adds non-conflicting cat parts/textures. A part mod ships custom SWF art + a `cat_parts.txt`
  registration (`id = kind appendBatch logicalPartIndex`, 1-based) + a `swfs/swflist.gon.append`;
  parts are referenced in GON as `@myMod.bodyA`. FLA linkage markers:
  `_Append_<Target>__MCPF__<appendBatch>` (items `__MIF__`). Kinds: body/head/leg/arm/tail/ear/
  eye/eyebrow/mouth/texture + weapon/trinket/headItem/neckItem/faceItem. (Solves the Frame-
  Reliance limit of §3/§4.)
- **MewPaletteExtender** (native DLL; Nexus 369, https://github.com/Pseudonym-Tim/mew-palette-extender):
  adds palettes via `palette_rows.txt` (16 hex colors **or** a 16×1 PNG strip), referenced as
  `palette @myMod.paletteID`. (Matches the §5 shader mechanism exactly.)
- **Catstructor** (native DLL; https://github.com/Pseudonym-Tim/mewgenics-catstructor):
  in-game cat editor (needs Dev Mode / `-dev_mode true`) — assemble parts/texture/palette, live-
  preview `@myPart`/`@myPalette`, save `.catstruct`, **export PNG**, and **copy the full `.gon`
  entry** to clipboard. The practical "author a cat" GUI.
- **MewUI** (native helper lib; https://github.com/Pseudonym-Tim/mewgenics-ui-api): for DLL mods
  adding/altering in-game UI; UI art is custom SWF in a 1280×720 FLA loaded via
  `swflist.gon.append`.
- **ParaboxAPI** (native hooking framework inside TheMegax/Mewtiplayer,
  https://github.com/TheMegax/Mewtiplayer): Mewjector + kiero + MinHook, event-driven API,
  plus **`GameSymbols.h`** — a reverse-engineered symbol table **for this exact build 1.1.21239**
  (e.g. `FileManagerClass_GetFile = 0x0099FF50`, `Ability_trigger = 0x000320A0`), which matches
  this repo's `.analysis` RVAs. Gameplay/logic oriented, **not** an art pipeline.
- **Custom Stray Framework** (Pseudonym-Tim, Nexus mods/434, native): add fully custom stray
  cats that spawn naturally.
- **MewgenicsSaveEditor + ModCreator** (Wawax007, Nexus mods/20): a GUI with a live-preview
  **Cat Customize** dialog that sets any body-part frame by number (0–999), edits palettes, and
  **imports textures, SWF animations, audio and binaries**, exporting a Mewtator-ready mod.
- **Supporting tools:** GPAK unpacker **ShootMe/GPAK-Extractor**
  (https://github.com/ShootMe/GPAK-Extractor); web **Palette Lab**
  (https://mewgenics-palette-lab.netlify.app/) and **Kitty Editor**
  (https://mewgenics.kittyeditor.com/) for palettes/appearance; **JPEXS** for SWF↔FLA
  (https://github.com/jindrapetrik/jpexs-decompiler); **MewVoice** for voices; community level
  editors. (This repo's own `tools/gpak.py` is the read-only equivalent used for recon.)

---

## 8. Evidence index

- **GON/shaders/pack (OBSERVED, read-only on this machine):** `.extracted/swfs/swflist.gon`;
  `.extracted/shaders/{swf_lib,paletted_full,default,std_in}.shader`; `.extracted/data/catgen.gon`,
  `classes/{classes,advanced_classes}.gon`, `custom_cats.gon`, `abilities/fighter_abilities.gon`,
  `tilesets.gon`, `weather.gon`, `spawns.gon`; `tools/gpak.py list` (53 png under `textures/`,
  115 swf, 50 shader). Palette PNG dimensions read from IHDR: `palette.png` 16×256,
  `fx_palette.png` 16×128, `eyestrip1.png` 525×2100.
- **Symbols/decompile (OBSERVED):** `.analysis/list_names.tsv` (`glaiel::swf::*` tag/display
  classes with vftable RVAs above; `glaiel::CatParts` `0x140ed6a30`, `OverridePalette`
  `0x14101adb0`, `JesterPaletteCycler` `0x140f00008`; `Renderer*`, `CombatShaders`, `Shader`,
  `Texture2DArray`); `.analysis/decompiled/FileManager_ResolveWithOverlays_0x9a09f0.c` (resolver
  `0x9a09f0`, pack `0x9a0670`, loose `0x9a0300`).
- **Community (COMMUNITY-SOURCED):** URLs inline in §1, §5, §7.

**Open items:** exact SWF tag subset glaielswf accepts is not published (inferred from the tag
classes); the precise grayscale→ramp index rounding is from the shader (OBSERVED) but the
authored-art convention isn't documented; multi-modpath precedence direction is per engine-map's
live test, not re-derived here.
