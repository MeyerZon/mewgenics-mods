# Authoring Mewgenics art without Adobe — SWF tooling & strategy options

How to produce and handle Mewgenics' SWF vector art (and its other binary data
formats) for modding **without depending on Adobe Flash / Animate**. This is a
strategy/feasibility survey, not an implementation. Read
[`art-pipeline.md`](art-pipeline.md) first — it establishes the rendering model
(custom `glaiel::swf` runtime, part-indexed cat paper-doll, palette.png, 50 GLSL
shaders, `-modpaths` whole-file override). This document pins down the **exact SWF
subset the engine actually consumes** and ranks the Adobe-free ways to emit it.

Target build 1.1.21239 (Steam build id 25143593), `Mewgenics.exe` SHA-256
`4127cd6a…eb77ea`. **Read-only reconnaissance**: `Mewgenics.exe`, `resources.gpak`,
and saves were never modified. Vanilla SWFs were read out of the pack with the
read-only `tools/gpak.py cat` and parsed with a throwaway built-in-Python scanner
(no third-party libs, no installs); extracted assets live only in the session
scratchpad and are not committed.

Every claim is tagged **OBSERVED** (measured from this build's binary, shaders,
GON, or vanilla SWF bytes on this machine), **INFERRED** (reasoned from that
evidence), or **COMMUNITY-SOURCED** (public tools/docs, with a URL).

---

## TL;DR

- **The engine does NOT need Adobe.** It reads plain **uncompressed (FWS) SWF v17**
  built from a **small, classic tag subset** (shapes + sprites + PlaceObject2
  timelines + bitmap-lossless + one SymbolClass + one DoABC). No AVM1, no buttons,
  no morph shapes. **OBSERVED across 15 vanilla files.**
- **The catch is linkage, not drawing.** Every file carries exactly one
  `SymbolClass` (tag→name) **and** one `DoABC` (AS3 bytecode), and the binary has a
  real **AVM2/ABC** layer (`avm2_i_*`, `AVM2By_*`, `DoABC::*`) plus 184
  `ScriptBindings::bind_function` calls. So ABC is parsed and at least partly run —
  a from-scratch emitter must ship a **valid minimal ABC**, or prove the runtime
  tolerates `SymbolClass` without it. **This is the one must-test gate.** OBSERVED.
- **Recommended no-Adobe pipeline: Strategy A (JPEXS FFDEC) now; invest in Strategy
  C (a small SWF writer on Haxe `format` or Ruffle's `swf` crate, driven from
  SVG/JSON) for a fully programmatic/CI pipeline.** JPEXS edits vanilla files in
  place so the vanilla ABC/SymbolClass stays valid — zero linkage risk — with GUI
  SVG→shape import (free vector editor) and a headless CLI for batch image/shape/
  SymbolClass/XML edits. For from-scratch output, Haxe `format` (MIT) already writes
  the whole subset *including* `SymbolClass` + a `DoABC` blob, and the one DoABC can
  be compiled by Apache Royale/Flex ASC2 (or Haxe `-swf`). See the ranked table.
- **Other formats:** `.wav`/`.ogg`/`.mid` are trivial whole-file drop-ins (MIDI is
  standard `MThd`). `.lvl` (2,361 files) is a tiny, RE'd 10×10-grid binary — a
  custom editor is a weekend job and community level editors exist. `.data`
  (`furniture_info.data`) is a fixed-record binary table, whole-file override only.
  Fonts are `DefineFont3` inside SWFs (same pipeline as art).

---

## 1. The minimal SWF the engine actually requires (OBSERVED)

### 1.1 What the runtime implements
**OBSERVED** (`.analysis/list_names.tsv`, RTTI-named vftables) — the complete set
of SWF tag classes the runtime defines:

`SWFTag` (base), `DefineShape`, `DefineSprite`, `DefineBits`, `DefineBitsJPEG`,
`DefineBitsLoseless` [sic], `JPEGTables`, `DefineFont`, `DefineText`,
`DefineEditText`, `PlaceObject`, `RemoveObject`, `ShowFrame`, `FrameLabel`,
`SetBackgroundColor`, `SymbolClass`, `DoAction`, `DoABC`; display objects
`DisplayObject`, `DisplayObjectContainer`, `…_DynamicBatched`, `MovieClip`,
`Sprite`, `StaticTextBox`, `DynamicTextBox`, `ReferenceRenderer`,
`CallbackOnRender`. There is **no** `DefineButton`, `DefineMorphShape`,
`DefineScalingGrid`, `ExportAssets`, `DefineBinaryData`, `DefineScene…` **class** —
tags without a class are skipped or parsed inline (see 1.3).

### 1.2 What the gameplay art actually uses
**OBSERVED** — I parsed the real tag streams of 15 vanilla SWFs spanning every
role: `loader, catparts, 2d_catanis, furniture, ability_icons, fonts, portraits,
tiles, effects, enemies, enemies4a_cursedtumor, particles, ui, map`, and a
cutscene (`season_fall_1`). Uniform results:

| Property | Value (all 15 files) |
|---|---|
| Signature | **`FWS` = uncompressed** (never CWS/zlib or ZWS/LZMA) |
| SWF version byte | **17** |
| Frame rate | **60 fps** |
| AVM1 `DoAction` tags | **0** (none, in any file) |
| `DoABC` (AVM2) tags | **exactly 1** per file (empty name string) |
| `SymbolClass` tags | **1** per file (ui/enemies occasionally 2); up to 730 name entries |

Tags observed in use, by frequency (union across files):

- **Vector shapes:** `DefineShape` (tag 2) — *dominant* (9,155 in `catparts`
  alone), `DefineShape3` (32, RGBA), `DefineShape2` (22), `DefineShape4` (83). The
  plain tag-2 dominance matches the palette model: most part art is **flat, solid,
  grayscale** fills (tag 2 has no per-fill alpha) that the `paletted_full` shader
  remaps; alpha/complex fills use 3/4. OBSERVED.
- **Timeline/containers:** `DefineSprite` (39), `PlaceObject2` (26, the workhorse —
  matrix + color-transform + depth + optional clip/name), `RemoveObject2` (28),
  `ShowFrame` (1), `FrameLabel` (43). `PlaceObject3` (70) appears only rarely
  (2× in `ui.swf`, for blend/filters). **No `PlaceObject` (4) or `RemoveObject`
  (5).** OBSERVED.
- **Embedded raster:** `DefineBitsLossless2` (36) and `DefineBitsLossless` (20)
  only — zlib-packed, premultiplied-alpha bitmaps used as bitmap fills (131× in
  `ui`, used by tiles/particles/portraits/effects/map; `catparts` has 5).
  **No `DefineBits`/`DefineBitsJPEG*` in any gameplay file** — raster is PNG-style
  lossless, never JPEG. OBSERVED.
- **Text/fonts:** `DefineFont3` (75), `DefineText` (11), `DefineEditText` (37),
  plus `DefineFontAlignZones` (73), `DefineFontName` (88), `CSMTextSettings` (74).
  OBSERVED.
- **Header/meta (one each, every file):** `FileAttributes` (69, carries the
  "ActionScript3" flag), `SetBackgroundColor` (9),
  `DefineSceneAndFrameLabelData` (86), `End` (0). A few files carry
  `ImportAssets2` (71, cross-SWF symbol import) and `DefineScalingGrid` (78).
  OBSERVED.

**So the minimal SWF a modder must be able to produce** is: an uncompressed v17
header + `FileAttributes` + `SetBackgroundColor` + `DefineSceneAndFrameLabelData`,
then `DefineShape2/3` and `DefineSprite` library definitions, laid out on a
timeline with `PlaceObject2`/`RemoveObject2`/`ShowFrame`/`FrameLabel`, optional
`DefineBitsLossless2` bitmaps, and a terminating `SymbolClass` + `DoABC` + `End`.
That is a **1990s-era tag set** — nothing here requires modern Flash features.
INFERRED (from the OBSERVED tag union).

### 1.3 Compression / version / ActionScript — the decisive facts
- **Uncompressed only, confirmed empirically.** All 15 files begin `46 57 53`
  ("FWS") with `FileLength` == actual byte length. This corroborates the community
  "publish with *compress movie* OFF" rule — the runtime reads **FWS**; CWS/ZWS is
  not needed and (per community) breaks loading. OBSERVED + COMMUNITY-SOURCED.
- **No gameplay ActionScript.** Zero `DoAction` (AVM1) tags anywhere; gameplay
  logic is C++. BUT **AVM2/ABC is not decorative**: the binary defines
  `glaiel::swf::avm2_i_*`, `AVM2By_*`, `DoABC::*` helpers and 184
  `glaiel::ScriptBindings::bind_function` bindings (AS-name → C++ lambda, e.g.
  `AnimationAudioEvents::outer_enterframe`). Each art file ships exactly one DoABC —
  the Flash-generated document/symbol ABC that *declares the classes named by
  SymbolClass*. **INFERRED:** the runtime parses that ABC to register the
  linkage classes and to resolve frame-script hooks to bound natives; it does not
  run author gameplay code. The open question (1.5) is whether a stub/empty ABC, or
  no ABC, still satisfies the SymbolClass binding.

### 1.4 How SymbolClass / FrameLabel bind to GON (OBSERVED on both ends)
- **`SymbolClass` is the primary linkage.** It maps each character tag ID to a
  **string name**; GON references art by that name. Confirmed by matching names:
  `enemies.swf` exports `Rat`, `Fly`, `Worm`; `data/spawns.gon` references
  `image ["rat.png"]`, `["fly.png"]` (the `.png`-style GON names are **SWF symbol
  names, not files** — no such PNGs exist in the pack). `ability_icons.swf` exports
  `AbilityIcon`/`PassiveIcon`; `furniture.swf` exports `Furniture`;
  `portraits.swf` exports `FighterCatPortrait`, `…Portrait`; `ui.swf` exports
  `MewCursor`, `DamageNumber`, `TurnOrderPortraitAlly`; `tiles.swf` exports
  `GrassTile`, `FireTile`; `map.swf` exports `Map_Alley`, `MapNode_Boss`. OBSERVED.
  The exact case/suffix normalization (`rat.png` ↔ `Rat`) is a convention —
  INFERRED.
- **`FrameLabel` marks timeline sections / addresses clips by label.** `effects.swf`
  labels frames `PROJECTILES`, `FIRE`, `ICE`…; `portraits.swf` labels `ALLEY`,
  `JUNKYARD`… (chapter sections); `tiles.swf` labels `TILES`, `TRAPS`. Abilities and
  classes name a clip/label to play — `data/abilities/fighter_abilities.gon` Dash:
  `dash_animation dash`, `dash_attack_animation dashatk`; `data/classes/*.gon`
  `alt_animations [ … ]`, `portrait_face <name>`. OBSERVED. This is the community's
  "Referencing Moviescripts / Moviescript Reliance / Frame Reliance" model
  (cvs-otherwise-callie `SWF_home.md`, COMMUNITY-SOURCED) — the last of which
  (raw frame index, e.g. cat parts/tiles) is why new parts need a native framework.

### 1.5 The single validation gate for any from-scratch emitter
**Does the runtime require a valid `DoABC` for `SymbolClass` to bind, or does the
SymbolClass name string suffice alone?** This cannot be settled from static symbols
(the SWF loader is not in the current `.analysis/decompiled/` set). It is cheap to
settle empirically and should be step 1 of any Strategy-C work:
1. Build the smallest possible SWF: header + one `DefineShape3` + `SymbolClass`
   {thatShape → `_Append_SomeKnownName`} + `End`, **no DoABC**.
2. Ship via `-modpaths` + `swflist.gon.append` on the `dev` save; launch with
   `launch-dev.bat`; grep `logs/debug.log` for a "no symbol / class not found"
   error vs. successful bind.
3. If it fails, add a templated minimal ABC that declares the class, retest.
This directly determines whether Strategy C needs an ABC assembler. (Read-only to
game files; only the dev-sandbox modpath is written.)

---

## 2. Open tooling to author SWF without Adobe — ranked strategies

*Current-status and capability claims for third-party tools are COMMUNITY-SOURCED;
URLs are listed in §6. They are judged against the §1 subset. The two web-sourced
survey legs (authoring tools; converters + references) feed this section.*

| # | Strategy | Available today | We'd have to build | Effort | Payoff / risk |
|---|---|---|---|---|---|
| **A** | **JPEXS FFDEC, editing vanilla SWFs** | GPLv3 Java decompiler/editor; **GUI** SVG→shape import + image replace; **headless `-cli`** `importShapes`/`importImages`/`importSymbolClass`/`replace`/`xml2swf`; round-trips these exact files | A batch script + a free vector editor (Inkscape) for SVG parts; `_Append_`/framework conventions for new symbols; hand-authored XML for fully-headless builds | **Low–Med** | **Highest feasibility, lowest risk.** Vanilla ABC/SymbolClass preserved → linkage "just works". Best for reskins/replacements and most additions. (SVG import is GUI, not headless) |
| **C** | **Custom minimal SWF writer — Haxe `format` (MIT) or Ruffle `swf` crate — driven from SVG/JSON** | Both libs serialize the whole §1 subset **including `SymbolClass` + a `DoABC` blob**; official SWF spec + Kaitai as reference; ABC obtainable from Apache Royale/Flex ASC2 or Haxe `-swf` | SVG-path→shape-record converter; the scene/timeline emitter; a **templated/compiled minimal DoABC** (unless §1.5 says unneeded); `DefineBitsLossless2` premultiply+zlib helper | **Med–High** | **Highest ceiling, fully Adobe-free & CI-able.** Writer is small (few hundred LOC on a lib; ~1–2k from scratch). Risks: SVG→shape fidelity; the ABC gate (§1.5) |
| **B** | **swfmill / SWFTools (swfc, png2swf) for bitmap-first or simple content** | XML↔SWF and PNG→SWF assemblers; emit libraries + placements | Shims for AS3 `SymbolClass` linkage (these are AVM1-era); accept raster-only or simple vector | **Low–Med** | **Narrow.** Fine for bitmap-atlas SWFs; weak on freeform vector and AS3 linkage. Useful as a *helper*, not the cat-part path |
| **D** | **Native modern-renderer DLL alongside `glaiel::swf`** | Mewjector / ParaboxAPI native hook stack already in `native/` | A C++ sprite/atlas/skeletal renderer + display-list/GON/palette integration; a loader for modern formats (atlas/Spine/Lottie) | **High** | **Unlocks modern pipelines** (skeletal, atlases) but large effort; only benefits art routed through it; vanilla art stays SWF |
| **E** | **Stay on Adobe Animate (baseline to beat)** | What devs & community use; perfect compatibility | Nothing | **Zero** | Requires the proprietary Adobe CC we're trying to avoid; the correctness bar for A–D |

*(Per-tool capabilities vs the §1 subset — JPEXS SVG-import & CLI, SWFTools/swfc
tag coverage, Ming's AVM1-only linkage, swfmill's PNG-library model, Haxe `format`
/ `as3swf` writers, Ruffle `swf` crate write support, Apache Royale for ABC, and
the SWF-spec/Ruffle references for a hand-written emitter — are detailed from the
two web survey legs in §5, with URLs.)*

### Why A is the daily driver
Editing a vanilla file in place means the **vanilla DoABC + SymbolClass are
untouched**, so the §1.5 gate never bites — linkage is guaranteed. FFDEC's GUI
SVG-import-into-shape lets you author vector parts in a free editor (Inkscape) and
bring them in; its headless `-cli` batches image/shape/`importSymbolClass`/`replace`
/`xml2swf` edits (SVG import itself is GUI-only, so scripted builds lean on the XML
round-trip). This is the community Adobe pipeline with Animate swapped for
FFDEC+Inkscape. COMMUNITY-SOURCED (see §5/§6).

### Why C is the strategic investment
A small writer that emits only the §1 subset, fed from SVG (or a JSON scene), gives
a fully scriptable, Adobe-free, CI-friendly pipeline with no Java/GUI in the loop.
The two hard parts are the **SVG-path → `DefineShape` edge/curve + fill-style**
conversion (directed-edge fill-on-left/right model; cubic→quadratic; flatten arcs)
and the **one DoABC** — settle §1.5 first; if a real ABC is needed, compile a
minimal AS3 stub with **Apache Royale/Flex ASC2** (or **Haxe `-swf`**), or reuse a
templated vanilla ABC blob. The **Haxe `format` library (MIT)** already serializes
the whole subset *including* `SymbolClass` and a `DoABC` blob in one place (with the
text/font-aux tags written as raw `TUnknown`); **Ruffle's `swf` crate** is the Rust
equivalent (remember to premultiply + zlib `DefineBitsLossless2` yourself). Either
means you start from a working tag serializer, not raw bit-packing. See §5.

### Converters from modern formats (Q3 — summary; detail + URLs in §5)
- **SVG → SWF:** no actively-maintained standalone converter exists; the practical
  routes are **FFDEC's SVG import** (GUI, Strategy A) or a **custom SVG→shape pass**
  (Strategy C). The SVG path/fill model maps onto SWF shape records reasonably
  directly (moveto/lineto + fills), but note three gotchas: SWF uses *directed edges*
  with a fill-style pair (fill-on-left/right) rather than whole-subpath fills, SWF
  curves are quadratic-only (cubic béziers must be subdivided/approximated), and SVG
  arcs must be flattened to curves. COMMUNITY-SOURCED + INFERRED.
- **Lottie / Rive / Spine / DragonBones → SWF:** no credible direct exporter;
  these are runtime-animation formats whose timing/deformation model doesn't map
  onto SWF's frame timeline cleanly. They're relevant to **Strategy D** (bring a
  modern runtime in natively), not to producing SWF. COMMUNITY-SOURCED/INFERRED.

---

## 3. The other binary data formats (Q5)

| Format | Count | What it is (OBSERVED) | Moddability |
|---|---|---|---|
| `.wav` | 16,076 | PCM audio | **Trivial** whole-file drop-in via `-modpaths` (match path). COMMUNITY: MewVoice does exactly this |
| `.ogg` | 835 | Ogg Vorbis audio | **Trivial** whole-file drop-in |
| `.mid` | 21 | **Standard MIDI** — header `4D 54 68 64` ("MThd"), format 1, multi-track | **Trivial** drop-in; author in any free MIDI tool |
| `.lvl` | 2,361 | **Custom binary grid**, RE'd: `u32 version=2, u32 W=10, u32 H=10`, header counts, length-prefixed table refs (`spawns.gon`, `tiles.gon`), then a 10×10 cell grid of indices into those tables | **Easy–Med**: whole-file override; schema is simple enough for a small reader/writer. Community level editors exist (COMMUNITY) |
| `.data` (`furniture_info.data`) | 1 | **Fixed-record binary table**: `u32 version=1, u32 count=634`, then 634 × ~607-byte records (length-prefixed name + numeric fields, e.g. `Small_candle_black`) | **Med, low-priority**: whole-file override + a small struct writer. Most furniture tuning is in `furniture_effects.gon` (GON-editable) instead |
| `DefineFont3` (in SWFs) | — | Fonts live inside `fonts.swf` / `international_fonts.swf` / `unicodefont.swf` as `DefineFont3`+`DefineFontName` | Same SWF pipeline as art (Strategies A/C); glyph outlines are shapes |

**`.lvl` detail (OBSERVED, two samples `creeptest2.lvl` 307 B and
`theinfinite/easy/infinite4.lvl` 503 B):** both decode identically as
version 2, 10×10, referencing `spawns.gon` + `tiles.gon`, differing only in a
header count and the per-cell index payload. A level is therefore a **10×10
tactics grid of (tile, spawn) indices** plus a short table-reference list — a
clean, documentable schema. A dedicated editor (or a JSON↔.lvl converter) is a
small, self-contained project; no Adobe, no SWF involved. INFERRED (schema) from
OBSERVED bytes.

---

## 4. "Something else" — sidestepping SWF (Q6, honest trade-offs)

- **PNG / paletted-texture path (data-only).** The renderer already samples PNGs
  (backgrounds, liquids, eyestrips) and does palette lookup from `palette.png`. You
  can add/replace **textures** freely via `-modpaths` (match dims/premultiplied
  alpha). But this path is **engine-driven** — it draws what the C++ asks for; it is
  not a general "new animated sprite" surface. It covers reskins of existing texture
  slots, not new characters. OBSERVED (art-pipeline §2) + INFERRED.
- **Native modern-renderer DLL (Strategy D).** The native hook stack (Mewjector +
  ParaboxAPI, already built in `native/`) could host a second renderer — PNG
  atlases + a modern animation runtime (Spine/Rive/Lottie) — drawn alongside
  `glaiel::swf` and bound to the part/GON systems. **Unlocks:** modern authoring
  tools, skeletal animation, texture atlases, no SWF for new content. **Costs:**
  substantial C++ (integrate with `glaiel::Renderer*`/`CombatShaders`, the
  display list, palette/tint color-transform, depth/z-ordering, and GON binding);
  it only benefits art you route through it, and must coexist with the SWF path for
  everything vanilla. **Honest verdict:** higher ceiling than SWF but far more work
  than Strategies A/C, and it duplicates a renderer the game already has. Worth it
  only if skeletal/atlas animation is a hard requirement. INFERRED.

---

## 5. Tooling survey detail (web-sourced)

*All tool/status/URL claims here are COMMUNITY-SOURCED.*

### 5.1 Authoring tools (COMMUNITY-SOURCED), by ability to emit the §1 subset

Only three tools can emit **both** the shape/sprite/timeline **and** the AVM2
`SymbolClass`+`DoABC` linkage the game uses:

- **Haxe `format` library (`format.swf.Writer`)** — MIT, HaxeFoundation
  (https://github.com/HaxeFoundation/format, `format/swf/Writer.hx`). Verified from
  source to serialize **DefineShape1–4, DefineSprite, PlaceObject2/3, RemoveObject2,
  ShowFrame, FrameLabel, SetBackgroundColor, DefineSceneAndFrameLabelData,
  FileAttributes, DefineBitsLossless/2, DefineFont3, `SymbolClass`, and `DoABC`**
  (as a blob) — the whole §1 skeleton in one library, with byte-level control over
  uncompressed FWS / version byte / fps. **Gaps:** `DefineText`, `DefineEditText`,
  `DefineFontAlignZones`, `DefineFontName`, `CSMTextSettings` are *not* in the writer
  switch — emit them via the generic `TUnknown(id, bytes)` raw passthrough. No
  SVG→shape importer (you build shape records programmatically). It does **not**
  compile AS3 — you supply the ABC bytes. **The single best self-contained writer.**
- **JPEXS FFDec** — GPLv3 app / LGPLv3 library, actively maintained (v26.x)
  (https://github.com/jindrapetrik/jpexs-decompiler,
  https://github.com/jindrapetrik/jpexs-decompiler/wiki/Features). Can **create new
  SWFs**, add tags/frames, edit `DefineShape1–4`, import fonts/images, edit
  `DoABC/DoABC2`, and round-trips **every tag** through its XML (`-swf2xml`/
  `-xml2swf`). **Correction to earlier assumption:** SVG→shape import is a **GUI**
  feature and historically experimental
  (https://www.free-decompiler.com/flash/issues/522-shape-replacement-svg-import);
  the **headless `-cli`** has `-importShapes` (folder format **not** documented as
  SVG; there is **no `-importSvg`**), `-importImages`, `-importSprites`,
  **`-importSymbolClass`**, `-replace`, `-replaceCharacterId`, and the XML
  round-trip (https://github.com/jindrapetrik/jpexs-decompiler/wiki/Commandline-arguments).
  So a *fully headless* build means authoring its XML (which models all required
  tags incl. SymbolClass + DoABC); AS3 authoring is "unstable/experimental."
- **Apache Royale / Apache Flex SDK (ASC2 compiler)** — Apache-2.0, based on Adobe's
  donated ASC 2.0; Royale 0.9.12 (Dec 2024, beta)
  (https://apache.github.io/royale-docs/compiler). The **only open-source compiler
  that produces correct `DoABC` + `SymbolClass` glue automatically** (the Flex
  `[Embed]`/linkage model; `-frames.frame label classname` maps frame→class). Can
  bake embedded **SVG** (basic paths/CSS/transforms, no animation) and PNG/JPEG.
  **Best used to generate the one DoABC (and linkage) stub**, paired with a
  shape/sprite tool — not for byte-level timeline control, and SWF-target output
  historically needs bring-your-own Adobe `playerglobal`/AIR libs.

**AVM1-only (cannot emit SymbolClass or DoABC — mismatched to the game):**
- **SWFTools `swfc`** (GPL; unmaintained since ~0.9.2 2012, many CVEs —
  https://github.com/swftools/swftools) — excellent shape/sprite/gradient/bitmap-fill
  authoring with an SVG-style path syntax and PlaceObject2 matrix+cxform, but `.action`
  emits **DoAction (AVM1)** and it emits neither SymbolClass nor DoABC. Ships a
  separate `as3compile` that *can* emit a DoABC, but `swfc` won't weld a SymbolClass
  to it. Useful only as geometry reference / helper.
- **libming/Ming** (LGPL-2.1; last 0.4.8 2017 — https://github.com/libming/libming) —
  Flash-4-era AVM1 generator; shapes/morphs/sprites/gradients/bitmaps but **no
  DoABC/SymbolClass**. Mismatched.
- **swfmill** (GPL; low activity — https://www.swfmill.org/) — its `simple` dialect
  is a **PNG/TTF/JPEG asset packer** with AVM1 `id`→`attachMovie` linkage; the full
  `swfml` dialect exposes `DefineShape/2/3` XML but is pre-AS3, no SymbolClass.
  Asset-wrapping only.

**Other:** open-flash **`swf-emitter`** (Rust/TS) models the full tag set incl.
SymbolClass/DoABC but has no authoring helpers, is **AGPL-3.0**, and inactive since
~2022 (https://crates.io/crates/swf-emitter). `claus/as3swf` (alpha, needs Flash
runtime), `pyswf` (Py2-era, dated write support) — reference-grade only.

### 5.2 Converters from modern formats → SWF (COMMUNITY-SOURCED)

- **SVG → SWF: no maintained general converter exists.** Legacy only: `svg2swf`
  (libming-based, old, https://svg2swf.sourceforge.net/); Inkscape never had native
  SWF export (https://bugs.launchpad.net/bugs/170430); commercial tools
  (Aspose, reaConverter) rasterize or route via PPTX rather than emit clean
  `DefineShape`. Batik/librsvg have no SWF transcoder.
- **A custom SVG-path → shape-record converter is "very doable"** (the Strategy-C
  core). Three known gotchas: (1) **fill model** — SWF shapes are *directed edges*,
  each carrying a line-style index and a **pair** of fill-style indices
  (fill-on-left / fill-on-right); you must track inside/outside as you emit edges,
  whereas SVG fills whole subpaths. (2) **Curves** — SWF curved edges are
  **quadratic** (one control point); SVG cubic `C` segments must be subdivided to
  quadratics. (3) **Arcs** (`A`) have no exact SWF form and must be flattened to
  curves. Gradients and bitmap fills map directly; solid fills are trivial. For
  flat/solid cartoon art the converter is modest. (SWF directed-edge fill model:
  https://patents.google.com/patent/US8810578 ; cubic→quadratic:
  https://medium.com/nerd-for-tech/normalizing-absolute-svg-paths-with-cubic-b%C3%A9zier-conversions-ed3920d65423)
- **Lottie → SWF: nothing, and a poor match** — Lottie is a keyframe/expression
  model run by a player, not a static shape+timeline container; only a frame-raster
  route exists (loses vector). (https://forum.lottiefiles.com/t/export-as-animated-svg/3488)
- **Rive / Spine / DragonBones → SWF: nothing usable.** Rive/Spine have no SWF
  export; DragonBones came *from* Flash and only emits its own `.dfswf`
  texture/XML-packed containers, not general `DefineShape`/`DefineSprite`
  (http://dragonbones.effecthub.com/features.html). These belong to **Strategy D**
  (bring the runtime in natively), not to producing SWF.
- **Living vector tools with SWF export:** only **Adobe Animate** (proprietary) and
  **Moho/Anime Studio** (commercial, lossy export,
  https://www.lostmarble.com/moho/manual/flashtips.html). Open-source **Synfig** and
  **Wick Editor** have **no** SWF export
  (https://github.com/Wicklets/wick-editor/issues/350).

### 5.3 References for a from-scratch emitter, and the DoABC solution (COMMUNITY-SOURCED)

- **Adobe SWF File Format Spec v19** (2012, last public) documents every tag in the
  §1 subset (shape records, fill/line styles, gradients, bitmap fills, DefineSprite,
  PlaceObject2/3, RemoveObject2, DefineBitsLossless/2, SymbolClass, DoABC, tag-code
  table). Mirrors: https://archive.org/details/swf-file-format-spec ,
  https://open-flash.github.io/mirrors/swf-spec-19.pdf , LoC format registry
  https://www.loc.gov/preservation/digital/formats/fdd/fdd000629.shtml ;
  machine-readable Kaitai `.ksy`: https://formats.kaitai.io/swf/ . Note: the ABC
  bytecode *inside* DoABC is specified separately (AVM2 Overview).
- **Ruffle `swf` Rust crate** (MIT/Apache-2.0, latest 0.3.0; https://docs.rs/swf ,
  https://crates.io/crates/swf) — **has read AND write.** The agent read
  `swf/src/write.rs` and confirmed `write_swf` serializes the **entire subset**:
  `DefineShape1–4`, `DefineSprite`, `PlaceObject2/3`, `RemoveObject2`, `ShowFrame`,
  `FrameLabel`, `SetBackgroundColor`, `DefineBitsLossless/2`, **`DefineFont3`**,
  `DefineText/2`, `DefineEditText`, **`SymbolClass`**, **`DoAbc`**. This is the best
  writer foundation. **Caveat:** its `DefineBitsLossless` writer does **not** zlib
  the pixels or premultiply — the caller must premultiply ARGB and zlib-compress the
  buffer first. (Alternative Rust writer: open-flash `swf-emitter`,
  https://crates.io/crates/swf-emitter ; readable parsers for reference: Shumway
  (archived) https://github.com/mozilla/shumway , pyswf/as3swf
  https://pypi.org/project/pyswf/ , https://github.com/claus/as3swf .)
- **DefineBitsLossless2 encoding** (tag 36, long header): header = id u16, format
  byte, width u16, height u16. **Format 5** = 32-bit **premultiplied ARGB**, no row
  padding; **Format 3** = 8-bit colormap (count byte + RGBA map + index/pixel, rows
  padded to 4 bytes). The colormap+indices or the ARGB array is **zlib-compressed as
  one block**. Premultiplication is consistent with the §1 shader evidence
  ("unpremultiply the bitmap") and with Ruffle leaving premultiply+zlib to the
  caller. (Layout/zlib/padding: https://www.m2osw.com/swf_tag_definebitslossless2 ,
  https://www.madetoorder.software/swf_tag_definebitslossless2 ; verify premult
  wording against the v19 spec.)
- **Solving the DoABC (the §1.5 gate) without hand-encoding bytecode:** **Haxe
  still has a direct `-swf` target that emits AVM2 ABC** (its `as3` source target
  was removed, but SWF bytecode output remains; OpenFL uses it) — so the single
  per-file DoABC can be *generated* by Haxe (or a fixed prebuilt ABC blob reused)
  rather than written by hand. (https://community.haxe.org/t/targeting-flash-in-fact-ruffle-for-new-code-in-2025/4727/2)

### 5.4 Size estimate for a Strategy-C writer (COMMUNITY-SOURCED judgment)

Riding on the Ruffle `swf` crate, the shape/sprite/PlaceObject2 emitter is mostly
populating typed structs — **a few hundred lines** of Rust (plus a
`DefineBitsLossless2` helper that does the premultiply+zlib the crate omits).
Written **from scratch** (own bit-writer, SHAPERECORD encoder with per-field nbits,
fill/line styles, matrix/color-transform fixed-point, tag framing), a
minimal-but-correct writer for the same tag set is **~1,000–2,000 lines**,
dominated by the shape-record bit encoder; `DefineFont3`/text add a few hundred.
The DoABC is generated/borrowed, not hand-encoded.

---

## 6. Evidence index

- **Vanilla SWF bytes (OBSERVED, read-only via `tools/gpak.py cat`):** 15 files
  parsed — all FWS, v17, 60 fps, 0× DoAction, 1× DoABC, 1–2× SymbolClass; tag
  histograms and SymbolClass/FrameLabel name samples recorded in session scratchpad
  (`scripts/swfscan.py`). Files: loader, catparts, 2d_catanis, furniture,
  ability_icons, fonts, portraits, tiles, effects, enemies, enemies4a_cursedtumor,
  particles, ui, map, cutscenes/season_fall_1.
- **Binary symbols (OBSERVED, `.analysis/list_names.tsv`):** `glaiel::swf::*` tag
  classes (§1.1); AVM2/ABC helpers `avm2_i_14113eba0`, `AVM2By_14113dfd0/dee0`,
  `DoABC::*`; `glaiel::ScriptBindings::bind_function` (184×), `build_lambda_helper`;
  `glaiel::LocalizedMovieclips`. SWF loader itself is not yet in
  `.analysis/decompiled/` — the §1.5 gate is the one unresolved static question.
- **Format bytes (OBSERVED):** `.lvl` header/grid decode (2 samples);
  `furniture_info.data` record-stride probe; `.mid` `MThd` header; gpak stats
  (16,076 wav / 835 ogg / 2,361 lvl / 21 mid / 115 swf).
- **GON ↔ SWF binding (OBSERVED):** `spawns.gon` `rat.png` ↔ `enemies.swf` `Rat`;
  `fighter_abilities.gon` clip names; `classes/*.gon` `alt_animations`;
  `swfs/swflist.gon` manifest + `per_file_curve_resolution`.
- **Community (COMMUNITY-SOURCED):** cvs-otherwise-callie modding docs
  (https://cvs-otherwise-callie.github.io/mewgenics-modding-documents/); JPEXS FFDEC
  (https://github.com/jindrapetrik/jpexs-decompiler); all tool/reference URLs in §5.
  **Do not consult tcrf.net/Mewgenics** (flagged prompt-injection + false "gpak is
  encrypted" claim; the gpak is plainly not encrypted — OBSERVED).

**Open items (unverified):** (1) the §1.5 DoABC-requirement gate — whether the
runtime needs a valid/stub `DoABC` or binds on the `SymbolClass` strings alone
(empirical `-modpaths` test needed; community refs treat `SymbolClass` as AVM2-only
pointing at DoABC classes, and Gnash rejects `SymbolClass` in a non-AS3 SWF, so a
standard player would need the ABC — the custom loader's behavior is the unknown);
(2) exact `rat.png`↔`Rat` normalization rule; (3) the SWF loader/tag-dispatch
function is not yet in `.analysis/decompiled/`, so the accepted-vs-ignored tag
boundary is inferred from the RTTI class set + observed tag usage, not from the
parser itself.
