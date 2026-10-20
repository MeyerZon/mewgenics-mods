# Art pipeline + in-game-faithful animated preview — plan

Status: **foundation built, pending one dev-save gate test** (see §7). This document is
the architecture and build plan for the editor's art capability: a zero-dependency SWF
emitter that targets the SWF subset the engine verifiably consumes, an in-suite preview
that reproduces the engine's palette-remap look, and the editor panels that drive both.

Inputs this plan is derived from (read them first):
- [`swf-tooling-options.md`](swf-tooling-options.md) — the verified minimal SWF subset
  (OBSERVED across 15 vanilla files) and the ranked strategies. This is the spec; the
  emitter here is its "Strategy C", written from scratch instead of on a library.
- [`art-pipeline.md`](art-pipeline.md) — rendering model: `glaiel::swf` runtime,
  16-level grayscale art remapped through the shared `textures/palette.png` (16×256) by
  `paletted_full.shader`, part-indexed cat paper-doll (`glaiel::CatParts`).
- [`engine-map.md`](engine-map.md), `CLAUDE.md` — build identity, safety rules.

Evidence tags as in the sibling docs: **OBSERVED** (measured on this machine),
**INFERRED**, **COMMUNITY-SOURCED**. New observations made for this plan are in §1.3.

---

## 1. Architecture

```
                 editor/src/core/art/                      (single source of truth)
  SVG text ──► svg-import.ts ──► scene.json model ──► swf-emitter.ts ──► mods/<m>/swfs/<x>.swf
                                       │                     ▲
                                       │ (same model)        │ shape.ts / lossless.ts /
                                       ▼                     │ abc-stub.ts / swf-bits.ts
                 geometry.ts + timeline.ts (pure, shared)  │
                        │                                    │
      browser ◄─────────┘ bundled by Vite (imports the pure modules)  └── swf-reader.ts (self-check)
      editor/web/src/art/preview-gl.ts  (raw WebGL: stencil fill + paletted_full remap)
      editor/web/src/art/*.tsx          Art panel + Preview panel (React; was VanJS, see editor-ts-react-plan.md)
      editor/web/server.ts             additive /api/art/* routes → src/core/api.ts (zod-gated bodies)
```

Dependency direction is unchanged from the rest of the editor: `core` owns parsing,
validation, emission and writes; `web/` and `mcp/` are thin adapters. The browser
preview imports only the **pure** modules (`geometry.ts`, `timeline.ts`,
`scene.ts`) so the pixels on screen are computed from the exact same baked frames the
emitter writes into `PlaceObject2` tags. Nothing in the preview re-interprets SVG or
SWF bytes.

No art-specific dependencies: Node built-ins (`node:zlib` for the `DefineBitsLossless2`
deflate and PNG inflate; `node:fs`) and browser built-ins (WebGL1, Canvas2D fallback).
(Written when the UI was VanJS with no build step; since 2026-10-20 the UI is React built
by Vite — `editor-ts-react-plan.md` — and the preview module is `web/src/art/preview-gl.ts`.)

### 1.1 Why "render from the source model", not from the SWF
The engine tessellates SWF shapes itself (`glaielswf\renderer\Tesselator.cpp`,
OBSERVED in `debug.log`) and samples bitmaps from its own atlas. A browser SWF player
would add a dependency (Ruffle, see §8) and still not be the engine. Rendering the
authoring model directly gives WYSIWYG for the two things the engine does that a stock
Flash player does not: the **grayscale→palette-row remap** and the **premultiplied
bitmap** path, both reproduced in our fragment shader from `paletted_full.shader` +
`swf_lib.shader` (OBSERVED GLSL, quoted in `art-pipeline.md` §5).

### 1.2 Ownership
- `scene.ts` owns the model: schema, defaults, validation, gray quantization. All
  consumers use its parsed facts.
- `geometry.ts` owns path normalization (SVG `d` → absolute lines + quadratics in
  twips; cubic→quadratic subdivision; arc flattening; transforms). Emitter and preview
  both consume its output; neither re-parses `d`.
- `timeline.ts` owns frame baking (layers + keys → per-frame per-depth placements with
  matrix/cxform; linear tween or hold). Emitter turns baked frames into
  `PlaceObject2`/`RemoveObject2`; preview draws baked frame N.
- `swf-emitter.ts` owns tag framing and file layout; `shape.ts` owns SHAPERECORD
  encoding; `lossless.ts` owns PNG decode + premultiply + zlib; `abc-stub.ts` owns
  the optional `DoABC`.
- `swf-reader.ts` is a verification-only reader (tests, and later vanilla import).

### 1.3 New observations used by this plan (OBSERVED 2026-10-18, read-only)
Parsed `swfs/minecarts.swf` (7,024 B), `testing_stuff.swf`, `ability_icons.swf` from the
gpak into the session scratchpad (never into the repo):
- Header: `FWS`, v17, `FileLength` == byte length, RECT nbits 16, 60 fps (`0x3c00` 8.8),
  then `FileAttributes` flags `0x08` (ActionScript3 only), `SetBackgroundColor`
  `ff cc ff`, `DefineSceneAndFrameLabelData` = 1 scene @0 "Scene 1" + main-timeline
  labels. Library definitions follow, then main-timeline `PlaceObject2`s, then **`DoABC`
  (flags=1 lazy, name "")**, then **`SymbolClass`**, then `ShowFrame`, `End`.
- `PlaceObject2` flag patterns in use: `0x06` (matrix+char), `0x26` (+name — e.g. the
  cat rig slots `body`, `head`, `tail`, `leg1`, `arm1`, `arm2`, `cq1` on `MinecartCat`),
  `0x05` (move + matrix), `0x03` (move + new char = frame swap), `0x16` (char + matrix +
  **HasRatio**, ratio u16 after the matrix), `0x0e`/`0x2e` (+cxform, bit `0x08`),
  `0x46` (+clipDepth = mask). Inside `DefineSprite`: `FrameLabel` ("idle", "duck")
  precede the frame's placements.
- **Fill-side convention confirmed from vanilla bytes:** decoding `minecarts.swf` with
  `swf-reader.ts`, all 17 single-sided sub-paths that run clockwise on screen (positive
  shoelace area in y-down twips) use `FillStyle1` and none use `FillStyle0`. So
  positive area → fill on the right → `FillStyle1`; negative → `FillStyle0`.
  `shape.ts` additionally assigns sides nesting-aware (a hole inside an "O" gets the
  side that leaves the hole unpainted under both nonzero and even-odd), so output
  renders the same whichever rule the engine's tessellator uses — that rule is
  unknown (§8).
- The vanilla **DoABC is Flash's auto-generated linkage ABC** (minor 16, major 46): per
  SymbolClass name one class `Name extends flash.display.MovieClip` with a protected
  namespace, empty traits (or `MovieClip`-typed slots for named children), `cinit` =
  `d0 30 47`, `iinit` = `d0 30 d0 49 00 47`, and a script-init that walks
  `Object→EventDispatcher→DisplayObject→InteractiveObject→DisplayObjectContainer→Sprite→MovieClip`
  with `getlex/pushscope`, `newclass`, 7×`popscope`, `initproperty`. One script per
  class. `abc-stub.ts` reproduces exactly this shape, so the "with-ABC" variant is
  byte-pattern-faithful to Flash output rather than a guess.
- `ability_icons.swf`: `SymbolClass {AbilityIcon, PassiveIcon}`; `AbilityIcon` is a
  sprite with **1,361 `FrameLabel`s named after abilities** (`LongShot`, `Traps`,
  `unknown`…). INFERRED: an ability's icon is the frame labeled with its GON key; a new
  ability shows `unknown`. This gives the §7 visual bind test.

---

## 2. The emitter's source model (`*.scene.json`)

Stored under `mods/<mod>/art/<name>.scene.json` (JSON, hand-editable, diff-friendly).
Units are **pixels** (SWF twips = px × 20, computed at the boundary). `y` is down.

```jsonc
{
  "version": 1,
  "name": "rat_reskin",                 // output file: mods/<mod>/swfs/rat_reskin.swf
  "frameRate": 60,                      // OBSERVED vanilla: 60
  "stage": { "width": 1280, "height": 720, "background": "#ffccff" },
  "preview": { "palette": 54 },         // preview-only default palette row
  "shapes": {                           // static library shapes → DefineShape3
    "body": {
      "source": "art/body.svg",         // provenance only; not re-read at build
      "paths": [
        { "d": "M0 0 L120 0 L120 80 L0 80 Z",
          "fill": "gray:8",             // gray:N (0..15) is palette-remapped by the engine
          "fillRule": "nonzero",        // or "evenodd" (preview + tessellation hint)
          "stroke": null, "strokeWidth": 0,
          "transform": [1,0,0,1,0,0] }  // SVG matrix a,b,c,d,e,f (px)
      ]
    },
    "eye": { "paths": [ { "d": "...", "fill": "#ff2020" } ] }   // non-gray = passthrough
  },
  "bitmaps": {                          // → DefineBitsLossless2 (fmt 5, premultiplied, zlib)
    "eyestrip": { "file": "art/eyestrip.png" }
  },
  "sprites": {                          // → DefineSprite timelines
    "Rat": {
      "frames": 12,
      "labels": { "idle": 0, "attack": 6 },        // → FrameLabel (0-based here)
      "layers": [                                   // one layer = one depth
        { "name": "body", "depth": 1,
          "keys": [
            { "frame": 0, "ref": "body", "x": 0, "y": 0, "sx": 1, "sy": 1, "rot": 0,
              "tween": "linear" },                 // interpolate until next key
            { "frame": 6, "ref": "body", "x": 10, "y": -4, "rot": -5 },
            { "frame": 9, "ref": null }            // → RemoveObject2
          ] },
        { "name": "eye", "depth": 2, "clip": false,
          "keys": [ { "frame": 0, "ref": "eye", "x": 80, "y": 20,
                      "cxform": { "mul": [1,1,1,1], "add": [0,0,0,0] } } ] }
      ]
    }
  },
  "exports": { "Rat": "Rat", "rat.png": "Rat" },   // SymbolClass: linkage name → shape|sprite id
  "stage_instances": [ { "ref": "Rat", "x": 640, "y": 360 } ]  // optional main-timeline placements
}
```

Rules enforced by `scene.ts`:
- Fills: `gray:N` → emitted RGB `(17N,17N,17N)`; the shader computes
  `floor(r*15+.5)` = N exactly (OBSERVED formula). Any `#rrggbb` with r==g==b is
  quantized to the nearest level with a warning; non-gray colors pass through unchanged
  (the shader skips the remap when channels differ) and are flagged `passthrough-fill`.
- `ref` names must resolve to `shapes` or `sprites`; `exports` keys are the SymbolClass
  strings (the `"x.png"` GON convention is just a string here — OBSERVED).
- `frames` ≥ 1; labels within range; depths unique per sprite; keys sorted by frame.
- Character IDs are assigned deterministically at build (shapes, bitmaps, sprites in
  dependency order) so rebuilding the same scene yields identical bytes.

Tool-agnostic import (`svg-import.ts`): accepts an SVG document (VectorCraft,
Inkscape, Illustrator export…) and produces `shapes[<id>].paths[]`: `<path d>`,
`<rect>`, `<circle>`, `<ellipse>`, `<polygon>`, `<polyline>`, `<line>` and `<g>`
transforms (translate/scale/rotate/skew/matrix), `fill`/`stroke` from attributes or
inline `style`. Unsupported features (gradients, filters, text, `<use>`, masks) are
reported as findings, never silently dropped.

---

## 3. The preview's render path (WebGL, hand-written)

Per frame N of a sprite: `timeline.bake(sprite, N)` → ordered placements
`{ref, matrix, cxform, clipDepth}`. For each placement that is a shape:

1. **Flatten** each path (`geometry.flatten`, curve tolerance in px) into closed
   polygons in stage px, with the placement matrix applied.
2. **Stencil fill** (no triangulation code): draw a triangle fan from each polygon's
   first vertex with color writes off and `STENCIL_OP INVERT` (even-odd) or
   `INCR_WRAP/DECR_WRAP` by winding (nonzero); then draw the polygon's bounding quad
   with `STENCIL_FUNC NOTEQUAL 0`, which runs the fragment shader once per covered
   pixel. This is exact for any path with holes and self-intersections.
3. **Fragment shader = `paletted_full.shader`**, ported literally:
   ```glsl
   vec4 c = u_fill;                       // gray:N → (17N,17N,17N)/255, or passthrough
   vec4 pal = texelFetch-equivalent: texture2D(u_palette, vec2((floor(c.r*15.0+.5)+.5)/16.0, (u_row+.5)/256.0));
   if (!(abs(c.r-c.g)<.001 && abs(c.r-c.b)<.001)) pal = c;
   gl_FragColor = vec4(pal.rgb, c.a) * u_cxmul + u_cxadd;
   ```
   `u_palette` is `textures/palette.png` uploaded as a 16×256 `NEAREST` texture
   (rows read by the core from the git-ignored `.extracted/` copy; never committed).
4. Bitmaps are uploaded premultiplied and un-premultiplied in the shader exactly as
   `swf_lib.shader` does (`rgb /= max(a, .001)`), so what the atlas would show is what
   the preview shows.
5. Sprites nest: a placement whose `ref` is a sprite recurses with the child's own frame
   counter (child frame = parent frame mod child.frames, matching Flash's default
   looping semantics; INFERRED for the engine — flagged in §8).

Fallback: when WebGL is unavailable the panel draws with Canvas2D (`fill()` with the
palette color resolved on the CPU) and says so in its status line; the palette remap is
still exact because the lookup is a table read.

Controls: play/pause, frame scrubber, frame-label jump list, loop toggle, palette-row
picker (visual 16-swatch ramps from the real table), gray-level overlay (shows the
un-remapped 16-level art), background colour, zoom/fit. Playback runs at the scene's
`frameRate` (60) using `requestAnimationFrame` with frame accumulation.

---

## 4. Editor integration

- **Core (`src/core/api.ts`, additive):** `listArtScenes(mod)`, `readArtScene(mod,
  rel)`, `writeArtScene(mod, rel, scene)` (validates first), `importSvgToScene(svgText,
  opts)`, `buildSwf(mod, rel, {abc:"none"|"stub"})` → writes `swfs/<name>.swf` and
  returns a tag report + findings, `writeSwflistAppend(mod, names)`,
  `readPalette()` (rows from `.extracted/textures/palette.png`),
  `prepareSwfGate({ mod, variant })` (writes or removes the §7 gate files). All writes go through
  `resolveModWritePath`, so they stay inside `mods/<mod>/` and can never touch saves or
  game files. `.swf` outputs are git-ignored already (`*.swf`).
- **Web server (`web/server.ts`, additive):** `/api/art/*` routes over those calls,
  plus (then) a read-only static mount `/core-art/<file>.mjs` for the pure shared modules — since the Vite
  build the browser bundle imports them directly — and
  `/api/art/asset` to stream a mod's PNG for the preview. No existing route changes.
- **MCP (`src/mcp/tools.ts`):** untouched in this pass (the existing 9-tool test pins
  the count). Exposing `build_swf`/`import_svg` as MCP tools is a follow-up.
- **UI (then `web/app.mjs`; now `web/src/**/*.tsx`, `web/index.html`):** a top-bar mode switch **Data | Art**. In Art
  mode the explorer lists `art/*.scene.json` + `swfs/*.swf` + `swflist.gon.append`; the
  center hosts the **Art authoring** panel (scene summary, shapes with gray-level
  swatches, sprites/layers/keys, import-SVG drop zone + file picker, "Build SWF"
  with/without stub ABC, findings list); the right panel hosts **Preview** (WebGL
  canvas, timeline scrubber with label ticks, palette picker, gray overlay). Same tokens
  as the rest of the IDE-dark theme; real `<button>`/`<label>`; no external resources.

---

## 5. Ranked build steps

| # | Step | Status |
|---|---|---|
| 1 | This plan | done |
| 2 | UX artboards on the "Mewgenics Mod Editor UI" design canvas | **blocked for the agent — see §6** |
| 3 | `swf-bits.ts` (bit writer, RECT/MATRIX/CXFORM, tag framing), `shape.ts` (DefineShape3 from normalized paths), `swf-emitter.ts` (header, FileAttributes, SceneAndFrameLabelData, shapes, SymbolClass, End), `swf-reader.ts` + tests | built |
| 4 | `DefineSprite` timelines: `timeline.ts` baking → `PlaceObject2`/`RemoveObject2`/`ShowFrame`/`FrameLabel`; masks via clipDepth | built |
| 5 | `lossless.ts`: PNG decode (8-bit, non-interlaced) → premultiply → zlib → `DefineBitsLossless2` fmt 5; bitmap fills | built |
| 6 | `abc-stub.ts`: Flash-faithful linkage ABC behind `abc: "stub"`; `abc: "none"` default until §7 settles | built |
| 7 | `svg-import.ts` + `geometry.ts` (SVG path → lines/quads; cubic→quad; arcs) | built |
| 8 | WebGL preview (`web/art/preview-gl.ts`) with palette remap, stencil fill, cxform, nesting, Canvas2D fallback | built |
| 9 | Editor wiring: `/api/art/*`, Art + Preview panels | built |
| 10 | §7 SWF gate | `npm run test:swfgate -- <variant>` (T2, agents may run); visual half is the owner's T3 |
| 11 | Follow-ups: MCP tools, vanilla-SWF import via `swf-reader.ts`, gradients, DefineShape4 line styles, part-indexed cat assembly UI | open |

---

## 6. UX design (artboards) — status and brief

The task asked for the new panels to be designed on the existing design canvas
("Mewgenics Mod Editor UI", https://claude.ai/artifact/WmQ9kVrbuCvEc72uNgJuSa) via the
`design` skill. **The harness refuses model invocation of that skill** ("reserved for
explicit user invocation; do not replicate its workflow by other means"), so no
artboards were added by the agent. The panels were built directly in the editor using
the existing design tokens (`index.html` `:root`), which were themselves ported from
that canvas, so visual cohesion is preserved. To get the artboards, run `/design` with
this brief:

> Extend the canvas "Mewgenics Mod Editor UI" with three artboards in the same IDE-dark
> style: (1) **Art mode** — the 3-pane shell with the explorer listing
> `art/*.scene.json` and `swfs/*.swf`, the center "Art" panel (scene header with name +
> frame rate + stage size; a Shapes list where each row shows a 16-step gray ramp with
> the used levels highlighted and a "passthrough colour" warning chip; a Sprites section
> with layers→keys as a compact table; an Import SVG drop zone; a "Build SWF" button
> with a "stub DoABC" toggle; a findings list reusing the validation `finding` rows);
> (2) **Preview panel** — the right pane: WebGL canvas with checker/background,
> transport bar (⏮ ▶/⏸ ⏭, frame counter `12 / 40`, loop), a scrubber with frame-label
> ticks, a label chip row, a palette-row picker showing the real 16-colour ramps for
> rows 0–255 with the current row highlighted, a "show gray levels" toggle, zoom/fit;
> (3) **Palette picker drawer** — a searchable grid of ramps (row number, used-by hints
> such as "Fighter 54"). Use real `<button>`/`<label>`; no emoji; no external fonts.

---

## 7. The SWF gate (settled 2026-10-19; re-run with `npm run test:swfgate`)

The original question here — does `SymbolClass` bind without a `DoABC`? — is answered: it does
(`DEFAULT_ABC_MODE = "none"`; the no-DoABC donor merges exactly like the stub one). The gate now
checks the thing that actually went wrong on 2026-10-18: does an `_Append_AbilityIcon` donor
survive the boot-time merge? See `swf-emitter-fix-spec.md` §0 for the findings.

**Safety:** writes only under `mods/swf-gate/` (`swfs/gate.swf` + `swfs/swflist.gon.append`,
both git-ignored); the game is launched through the in-game harness on `-savesuffix dev`,
which hashes the real save before and after. Agents may run it.

### 7.1 Variants (`editor/src/core/art/art-io.ts` `SWF_GATE_VARIANTS`)
`flat` (the fix: icon shape at depth 3, like every `AbilityIcon` frame) · `nested` (icon in a
nested movieclip at depth 3) · `legacy` (depth 1, the pre-fix donor) · `probe` (same bytes under
the non-append linkage `GateProbe`: load only) · `missing` (`_Append_NoSuchClipXYZ`: must
stall the boot — the proof the merge ran) · `control` (removes the gate files).

### 7.2 Procedure
1. From `editor/`: `npm run test:swfgate -- <variant>` — writes the files, boots the game
   through `mods/swf-gate/tests/boot.mewtest`, prints the verdict against the variant's
   expected one, and the run dir (`editor/data/ingame-runs/<ts>-swf-gate-boot`).
2. Visual half (owner, T3): `npm run test:swfgate -- flat --prepare-only`, then
   `launch-dev.bat mods\swf-gate`, enter the dev run and look at `JokersGambit`: the flat
   gray square instead of `unknown`, and no new `crash_*.txt` in
   `%APPDATA%\Glaiel Games\Mewgenics\<steamid>\logs\`.
3. Finish with `npm run test:swfgate -- control` so the mod is vanilla again.

---

## 7a. Onboarding (Data + Art)

Art mode has first-run guidance that mirrors the data-mode tour, reusing the same
components, tokens, and `localStorage` key family (`mewged.onboard.*`):

- **Art-mode tour** — a dedicated 6-step tour (switch Data→Art, the scenes/shapes
  explorer, import SVG, grayscale→palette, the in-game-faithful preview, Build + the
  gate test). It opens automatically the first time the user enters Art mode (unless
  dismissed), persisted under `mewged.onboard.artTourSeen` / `artTourDontShow`, and is
  re-openable from the Help (`?`) menu. The data and art tours render through one shared
  `GuidedTour` component so they stay identical in look and behavior. A `?mode=art`
  deep link still skips both tours (for demos/screenshots) but leaves them in the menu.
- **Empty states** — no scene open (New scene / Import SVG / Take the Art tour),
  scene with no shapes yet (import guidance), and no built SWF (Build hint in the Build
  tab and the explorer's Built SWFs list).
- **Concepts drawer** — gains an Art section (grayscale→palette recolor with a live
  16-swatch ramp, the minimal SWF subset we emit, the faithful preview, and the open
  `DoABC`/`SymbolClass` gate). The current editor mode's section is shown first; the
  data-layer concepts are unchanged.
- **Art worked example** — an illustrative full-page walkthrough (SVG → preview →
  build) reusing the data example's shell. It explains the pipeline and drops the user
  into the live Art UI at each step; it never writes to disk on its own (the New scene
  dialog and the drop zone do, confined to `mods/<mod>/`).

## 7b. Performance

The web UI was VanJS with no build step when this was written (it is React now, with the
same DOM and the same imperative hot paths), so performance work is about scoping reactive
updates and coalescing event work (all with built-ins):

- **GON highlight overlay** — previously re-tokenized the whole buffer on every
  keystroke and wrote scroll transforms on every scroll event. It now paints on a single
  `requestAnimationFrame` (coalescing keystroke/scroll bursts) and tokenizes only the
  on-screen slice of lines plus a buffer. `highlightGon()` is line-local (strings and
  `//` comments never cross a newline), so a windowed highlight is byte-identical to a
  full-buffer one — a keystroke is now O(visible lines), not O(file). The gutter and the
  overlay transform are synced in the same rAF (reads before writes, no layout thrash).
- **Base-data explorer** — the filter input is debounced (was a fetch + full list
  rebuild per keystroke); the category list is built once and each category's entries
  live in their own reactive child, so selecting/filtering repaints only that one
  category rather than all of them; entries are capped (300) with a "showing N of M —
  refine the search" note so the DOM stays small on big categories (abilities ≈ 3,076).
- **Component search** — debounced (was a fetch per keystroke); results already cap at 40.
- **Art scene panel** — a presence flag (`A.hasScene`) lets the panel shell (subtab bar)
  build once per scene open; a `bump()` from an in-place edit now repaints only the
  header counts and the active tab, not the whole panel.
- **WebGL preview loop** — already on `requestAnimationFrame` with frame accumulation; it
  now also pauses whenever the canvas is off-screen or the tab is hidden (Page Visibility
  + `IntersectionObserver`), preserving the user's play intent so it resumes on its own
  when visible again. This stops the loop from rendering to a detached canvas after
  switching to Data mode or another right-panel tab. The preview is a singleton reused
  across scene switches (no per-scene GL context), and its context/observers are released
  in `destroy()`. A window-resize re-fit is rAF-batched and only runs when the preview is
  on-screen.

**Bug fixed along the way:** with loop off, playback that auto-stopped on the last frame
left the preview's internal `playing=false` but the transport button still showing
"Pause". The preview now reports play-state transitions through an `onPlaying` callback,
so the button label stays truthful (including the auto-stop case).

Not measured in a browser here (no headless GL in this environment); these are
structural changes validated by `npm run typecheck`, `npm test`, and a running server.
Real-browser profiling is a follow-up.

## 8. Open items

**Needs the user / a decision**
1. §7 gate result → default ABC mode. Until then `abc: "none"` is the default and the
   UI shows the toggle.
2. **Installed 2026-10-20 (owner's go; dep-gate in the PR):** `@ruffle-rs/ruffle@0.7.1` (WASM, MIT/Apache-2.0,
   exact pin, no install scripts, no dependencies, `npm audit` clean), browser-only: `scripts/vendor-ruffle.ts`
   copies its `.js`/`.wasm`/licenses into the git-ignored `web/public/ruffle/` at `npm run build` / `dev`; the Art
   right panel's **Ruffle** tab plays a built mod SWF or an extracted vanilla SWF from bytes with
   `allowNetworking: "none"`, `allowScriptAccess: false`, `openUrlMode: "deny"` (the e2e test asserts no request
   leaves the editor's origin). It is a reference player, not glaiel::swf (no palette remap, no `_Append_` merge).
   Vanilla SWFs come from `/api/art/vanilla-swfs` / `vanilla-swf` (`art-io.ts` `listVanillaSwfs` / `readVanillaSwf`,
   names from `swflist.gon`, read-only, traversal and saves paths refused). Was: proposed, not installed. Without it, vanilla import is limited to what `swf-reader.ts`
   decodes (DefineShape/Sprite/PlaceObject2 → our model), which is the planned no-dep
   route.
3. **External tool (optional, not a dependency):** JPEXS FFDEC remains the recommended
   way to *edit vanilla files in place* (Strategy A). The editor can document it, not
   bundle it.
4. Design artboards: run `/design` with the §6 brief.

**OBSERVED in the game 2026-10-20** (`npm run test:artprobe`: an ArtProbe enemy whose `graphics.movieclip` is our SWF,
spawned in a seeded harness fight and screenshot six times; `editor/src/core/art/probe-compare.ts` reads the shots;
the summary is pinned in `editor/test/fixtures/ingame/artprobe-summary.json`):
- a character's art is the SymbolClass named by `graphics.movieclip` — a mod SWF listed in `swflist.gon.append` works;
- enemy clips are drawn **mirrored** (they face left);
- a nested sprite under a one-frame parent **runs on its own clock** (the blink cycled red → green → blue); the
  preview's "parent frame mod child frames" was wrong;
- bitmap fills are sampled **smoothly** (bilinear-looking blends inside 8× magnified texels) and **clamped** at the
  bitmap's edge (the border colour streaks across the rest of the path); the preview's NEAREST was wrong;
- `PlaceObject` cxform **applies** (gray:8 × mul [1,0,0,1] → (136,0,0));
- enemies carry **no palette row** (only cats have one), so gray:8 drew as plain 136 gray and the order
  "cxform before/after the palette remap" cannot be decided on an enemy (both give the same pixels) — still open;
  a cat-part probe would need the native MewCatPartFramework.

**Unverified engine behaviors (INFERRED, flagged in the UI as such)**
5. ~~Nested sprite frame advance = parent frame mod child frames~~ — wrong, see OBSERVED above (own clock). The
   preview follows the observations since 2026-10-20: `src/core/art/engine-behaviour.ts` holds them (a test ties it to
   the probe fixture), `preview-gl.ts` runs nested sprites on a clock and samples bitmaps LINEAR + clamped.
6. `_Append_<Clip>` applies to `AbilityIcon` the way it does to `Furniture`.
7. The exact case/suffix rule mapping GON `"rat.png"` → SymbolClass `Rat`; the emitter
   writes whatever string the scene's `exports` key says, so both spellings can be
   exported at once (as the example does). Caveat for `abc: "stub"`: a dotted linkage
   name follows Flash's package rule, so `"starter.png"` declares class `png` in
   package `starter` — harmless as a linkage string, but vanilla files export the
   class-style name (`Rat`), so prefer that spelling once the mapping is known.
   The engine's fill rule (nonzero vs even-odd) is also unknown; `shape.ts` emits
   shapes that render identically under both (§1.3).
8. Whether the engine honors `PlaceObject2` cxform on palette-remapped art the same way
   the shader suggests (`* mul + add` after the remap) — the preview does exactly that. The cxform itself is
   OBSERVED to apply; the order relative to the remap is undecidable on an (unpaletted) enemy.
9. Tessellation tolerance: engine `per_file_curve_resolution` vs. our preview flatten
   tolerance; a `swflist.gon.append` `per_file_curve_resolution { <name>.swf N }` entry
   is written when the scene sets `curveResolution`.

**Not in this pass**
10. Gradient fills (gradient atlas), `DefineShape4` LineStyle2, fonts/text, `PlaceObject3`
    blend/filters, `ImportAssets2`, `DefineScalingGrid`.
11. **Done 2026-10-20:** MCP tools `list_art_scenes`, `read_art_scene`, `write_art_scene` (dryRun validates), `new_art_scene`,
    `import_svg` (with `into { scene, shapeId }` it saves the shape), `build_swf`, `inspect_swf`. Was: MCP tool surface for art (`build_swf`, `import_svg`), kept out to leave the 9-tool
    contract and `src/mcp/` untouched.
12. Part-indexed cat assembly as a first-class preview mode (slots `body/head/tail/leg1/
    leg2/arm1/arm2`, OBSERVED as named instances on `MinecartCat`): the data model
    supports it as a sprite with named layers; a dedicated "cat rig" UI is a follow-up.
