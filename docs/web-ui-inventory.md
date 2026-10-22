# Web UI inventory — input for the design / UX review

Snapshot of the editor's web UI (`editor/web/`, served by `npm run web`) as of 2026-10-22: what ships on `main`
(95dcaa5), what each open PR adds, and what is planned. Written for a later design and UX review, so each item says
what it is and where it lives; the last section collects the UX issues already visible.

Status markers: **[main]** on `main` · **[PR #N]** in an open, unmerged PR · **[planned]** not built.

## 1. Shell and global UI [main]

Files: `editor/web/src/App.tsx`, `components/TopBar.tsx`, `components/StatusBar.tsx`, `actions.ts`.

- **Layout** — three panes (explorer · center · right panel; the right panel only shows with a mod open), a bottom
  status bar, and a toast. Data or Art mode decides what fills the panes.
- **Brand** — "Mewgenics Mod Editor".
- **Mode switch: Data | Art** — the first entry into Art mode opens the Art tour automatically (remembered in
  localStorage `mewged.onboard.artTour*`). Deep link `?mode=art` opens Art mode with no tours.
- **Mod switcher dropdown** — lists `mods/`; picking one loads its files and art. Also **＋ New mod…**, which opens
  the template modal with an empty mod name.
- **Status pill** — "● N errors · M warnings" from the last validation, or "idle".
- **Validate** — runs validation and the merge preview on the open file; disabled with no file open.
- **Save** — writes the open overlay (`POST /api/write`) and reloads the mod.
- **Launch dev ▸** — shows a toast telling you to run `launch-dev.bat` with `-modpaths mods/<mod> -savesuffix dev`;
  it does not launch anything.
- **Help (?) menu** — Guided tour (Data, 5 steps) · Worked example: Joker's Luck · Art mode tour (6 steps) · Art
  worked example (SVG → preview → SWF, 5 steps) · Concepts explainer.
- **First-run Data tour** — shown once unless "don't show again" is ticked.
- **Status bar** — `mod/file`, the overlay-mode note (e.g. ".merge → deep-merge onto base"), and the static labels
  "build dev · ● local server · save: dev".

## 2. Data mode [main]

- **Explorer → Mod files** — collapsible folder tree of the mod's overlays with `.append` / `.merge` / `.patch` chips
  (`description.json` hidden). **+ New overlay** opens the template modal. With no mod open: a **+ New mod** card.
- **Explorer → Base data (read-only)** — debounced filter; category rows with counts; a category lists its entries
  (capped at 300 with a "refine the search" note); an entry opens the **Base entry drawer** (read-only GON).
- **Explorer → components row** — opens the Components tab (or the Components drawer with no mod open).
- **Center → empty states** — no mod: hero with four cards (Create your first overlay · Browse base data · Take the
  guided tour · Rebuild Joker's Luck) and a concepts link. No file: "+ New overlay" and "How overlays work".
- **Center → file tab bar** — filename with ✕, a mode chip (".merge → Merge"), and a breadcrumb.
- **GON editor** (`Editor.tsx` + `gon-highlight.ts`) — textarea with a syntax-highlight overlay and line gutter
  (only visible lines painted, once per frame); typing re-validates and re-previews after 350 ms.
- **Editor status line** — Saved/Unsaved, byte count, UTF-8, file type (GON/CSV/TXT), "Live validation on".
- **Right → Validation tab** — summary badge and findings (code, path, line, message).
- **Right → Preview tab** — merge preview: GON base vs effective per touched key with added/changed chips; CSV
  added and changed rows.
- **Right → Components tab** — debounced search of `glaiel::` component class names (limit 40); clicking a name
  searches that exact name. Shows names only: the where-used data the API returns is not rendered.
- **Template modal "Scaffold an overlay"** — mod, kind (`ability` / `passive` / `item` / `status-data`), entry name,
  display name, description; ability only: `variant_of` parent and an optional status effect. **Scaffold** shows
  the result as raw JSON.
- **Drawers** — Base entry viewer; Components drawer (same search, used with no mod open).
- **Concepts drawer** — cards for append / merge / patch and the validation checks, plus Art concepts.
- **Worked example (Joker's Luck)** — step list; one step pre-fills the template modal with JokersGambit.

## 3. Art mode [main]

- **Art explorer** — **Art scenes** (`art/*.scene.json`) with **+ New scene**; **Built SWFs** (click to inspect in
  the Build tab) with a `swflist.gon.append` chip; **Assets** (`art/` SVGs and PNGs).
- **New scene modal** — name; creates `art/<name>.scene.json` from a starter (a bobbing gray square).
- **Empty hero** — "+ New scene" card, an SVG drop zone (creates a scene if none is open), "Take the Art tour".
- **Scene tab bar** — name with ✕, "scene → .swf" chip, Saved/Unsaved, **Save scene**, **Build SWF**.
- **Scene header** — name, fps, stage size, shape/sprite/export counts; a findings pill jumps to Findings.
- **Overview sub-tab** — name, frameRate, stage width/height/background, curveResolution; SVG drop zone; a "How
  it ships" note.
- **Shapes sub-tab**
  - Per shape: 16-level gray-ramp usage strip; chips baked / passthrough / bitmap / gradient.
  - Per-shape buttons: **Preview** · **→ Sprite** (wrap in a 1-frame sprite and export) · **VectorCraft** ·
    **Export SVG** (`art/<shape>.svg`) · **Bake glow…** (inline form: glow or drop shadow, colour, blur, dx/dy;
    Bake / Re-bake) · **Replace…** (from SVG) · **Delete**.
  - "show raw gray" checkbox; SVG drop zone.
  - **Texts** — **New text**; per text: words, game font (fixed `GAME_FONTS` list), size, colour, align, Delete.
  - **Path editor** for the previewed shape — per-path fill (gray 0–15, gradients, keep, none), stroke chip,
    Delete path.
- **Sprites sub-tab** — **+ New sprite**; per sprite: frames, labels (`idle:0, attack:6`), Preview, Delete; layer
  rows (depth, keys summary, mask chip, Delete); "+ layer from" a shape/sprite; baked-frames count.
- **Timeline sub-tab** — sprite select; label pills (click to seek, × to remove); frame ruler; layer × frame grid
  (key / hold / tween cells; click scrubs the preview); key inspector: Add key, Delete key, Insert frame, Delete
  frame, Layer up/down; key fields ref, x, y, sx, sy, rot, alpha, "to next" hold/tween; **Add label**.
- **Rig sub-tab** — **New cat rig** (7 slots tail, leg2, arm2, body, leg1, arm1, head, with placeholder parts); per
  rig: Preview, Animate, `rig-*` findings, per-slot select (disabled for `parts: game` rigs). **Cat animations**:
  name + **New cat animation** (adds `<name>F/B` on the `_Append_CatTest` donor); donor card with Preview, Timeline,
  `cat-anim*` findings, facing pills, **Animate pose**.
- **VectorCraft sub-tab** — the vendored VectorCraft web build in an iframe (stays mounted across tabs); shape
  select, **Open in VectorCraft**, **Apply to shape** (enabled when changed), **Retry with WebGL2**, status line,
  "not vendored" message when missing.
- **Exports sub-tab** — export → ref list with Remove; new linkage name + target + **+ Add export**.
- **JSON sub-tab** — the whole scene as editable JSON; **Apply**; parse errors shown.
- **Right → Preview** — engine-faithful renderer (WebGL, canvas2d fallback); target select; **Fit**; transport
  (|◀ ◀ Play/Pause ▶, frame counter, loop); scrubber with label ticks and label chips; palette row (number,
  **Browse rows…**, 16-colour ramp, hint), "show raw gray", background (checker / stage / black / white).
- **Palette drawer** — `palette.png` row browser with a filter; clicking a row sets the preview row.
- **Right → Findings** — scene validation summary and findings.
- **Right → Build** — DoABC radio (none / stub); **Build SWF**, **Dry run**, **Prepare SWF gate**; result card
  (bytes, frames, characters, exports, tag histogram, `swflist.gon.append` text, findings); Inspect card for a built
  SWF (header, DoABC, exports, labels, tags, loader findings).
- **Right → Ruffle** — pick a mod SWF or an extracted vanilla SWF, **Load**, play it, show its metadata.
- **Dev page** — `web/art/preview-dev.html`: a standalone renderer harness (second Vite entry).

## 4. Added by open PRs (not merged)

- **[PR #96] "plain (localized)" checkbox** on each text row (Shapes tab) — sets `html: false` so the game swaps a
  localization key for its text; the new `text-loc-key-html` finding points at it.
- **[PR #97] "ghost cat" checkbox** in the Preview target row — only for `parts: "game"` rigs; draws translucent
  grey part outlines with slot labels in the empty slots, preview only; outlines from `catparts.swf` when extracted,
  else built-in shapes; remembered in localStorage `mewged.art.ghostCat`.
- **[PR #98]** Rig tab note reworded to "OBSERVED in the game"; no new controls.
- **[PR #105] "Four-way" checkbox** next to New cat animation (`<name>LF/RF/LB/RB`); New cat animation also makes a
  back rig (`<name>PoseBack` with `head_back`); rig cards show "back-facing"; slot rows follow the rig's facing;
  animation rows list four-way quartets.
- **[PR #116] Mod menu ⇩ Export…** — packs the mod into a zip and downloads it; offers to draft a `mod.json` if
  missing and to force past validation / SWF / DLL refusals. **⇧ Import mod…** — zip picker that installs into
  `mods/<name>/`, confirming on a game-build mismatch (limit ~6 MB in the browser). `mod.json` hidden from the tree.
- **[PR #120] Template kinds `particle` and `vfx-ability`** in the template dropdown. No particle editor.
- **[PR #124] Import PNG… row** (Shapes tab) — mode: sprite (origin at the feet) / background plate (top-left) /
  bitmap fill; scale; "pixel art" (no smoothing); "tile" (repeat). The drop zone accepts PNG too. The preview honours
  repeat and pixel-snap. Texts using a scene-embedded font draw from its glyphs in the preview (no font-import UI;
  the font select still lists only game fonts).
- **[PR #125] Rooms mode** (third mode; `?mode=rooms`; clicking a `.lvl` in Data mode opens it)
  - **Room explorer** — `levels/` list, **+ New room**; **Tiles** palette (`tiles.gon`) and **Objects** palette
    (`spawns.gon`), base plus the mod's overlays, each with a filter, a 200-row cap and tint-colour letter swatches.
  - **Toolbar** — path with a dirty dot; tools Select / Tile / Object / Erase; brush label; **Close**; **Save room**.
    Validate and Save of the top bar are hidden in Rooms mode.
  - **10×10 grid painter** — click or drag to paint; cell tooltips; markers for random cells and object stacks.
  - **Cell inspector** (right) — tile pick with a "random" toggle and a weighted-list table (+ choice, weight, ✕);
    per-object pick editor, Remove, "+ add <brush> here".
  - **Findings** (right) — live `lvl-*` findings while painting.
  - **New room modal** — folder and name; uses the room template (4 player spawns, 2 Rats).
- **[PR #126] Component "reads" box** (Components tab) — when the search equals one class name, lists the GON keys
  that class reads: type, default, required, inherited-from, children kind, and an "open" note when the list may
  be incomplete.
- **[PR #130, in progress] Tile art in Rooms** — palette rows and grid cells show rendered clip thumbnails (frame 1,
  cached in `editor/data/level-art/`), swatches stay as the fallback with the reason in the tooltip; a **tileset
  select**; a **Flat | Iso** switch (2:1 diamonds, sprites on cell centres, nearer cells drawn last, paintable).

PRs with no web UI change: #99–#104, #106–#115, #117–#119, #121–#123, #127–#129.

## 5. Planned, not built

- **[planned] 3D model card in Data mode** — wireframe and bounds next to a `model` key, with `model-*` findings
  (`docs/3d-importer-design.md` §3.3; the SVG builder exists in `editor/src/core/art/model-read.ts` on PR #128).
  MCP `read_model` and `extract_model_texture` come with it.
- **[planned] TTF/OTF font import** into scene fonts (PR #124 TODO).
- **[planned] "Swap rig for <entry>" control** for the native cat-rig redirect (plan A3; PR #118 TODO).
- **[planned] Particle editor** — only the templates exist (PR #120 notes the gap; not scheduled).
- **[planned] Room and tileset-variant kinds in the template modal** — the core and MCP have them (PR #121); the UI
  dropdown does not; Rooms uses its own New room dialog.
- **[planned] Design artboards** for Art mode, Preview and the Palette drawer (`docs/art-preview-plan.md` §6, §8
  item 4) — need the owner to run `/design`.
- **[planned, partly stale] Part-indexed cat assembly preview** (art-preview-plan §8 item 12) — mostly covered by
  the Rig tab and the ghost cat (#97).

## 6. MCP tools (they share `editor/src/core/api.ts` with the UI)

- **[main] 26** — list_base_data, read_base_entry, search_components, read_mod, write_overlay, validate_mod,
  preview_merge, list_registered_native_names, new_from_template, list_ingame_tests, list_art_scenes,
  read_art_scene, write_art_scene, new_art_scene, import_svg, export_svg, bake_glow, build_swf, inspect_swf,
  run_ingame_test, check_game_build, start_ingame_session, ingame_exec, stop_ingame_session, port_bindings,
  vectorcraft_exec.
- **[PRs] +5 → 31** — `pack_mod`, `install_mod` (#116) · `import_bitmap` (#124) · `read_level`, `write_level`
  (#125). #126 extends `search_components` with the key schema.
- **[planned]** `read_model`, `extract_model_texture`.

## 7. UX issues already visible (for the review)

- **Launch dev ▸ does not launch** — it only shows a toast with a command to run by hand; the in-game runner already
  knows how to launch safely (`-savesuffix dev`, save hashing).
- **Components tab shows names only** — the API returns where-used data that is never rendered; #126's reads box
  helps but only on an exact name match.
- **Template result is raw JSON** — Scaffold shows the API response instead of opening the written files.
- **Template dropdown is incomplete** — `room` and `tileset-variant` exist in the core but not in the UI; #120 and
  #121 edit the same dropdown line (merge conflict).
- **Font select ignores embedded fonts** — after #124 a scene can carry its own font, but the text row's select
  still lists only the game fonts.
- **Mode-specific top bar** — Validate and Save disappear in Rooms mode in favour of the Rooms toolbar's own Save;
  three modes now use three save patterns (top-bar Save, Save scene, Save room).
- **Static status bar labels** — "build dev · ● local server · save: dev" never change, so they carry no state.
- **Base data list capped at 300** with only a "refine the search" note; no paging.
- **Import mod… limited to ~6 MB** in the browser (request body limit); larger zips need the CLI.
- **Validation without key help in Data mode** — no autocomplete or inline hints for component keys while typing,
  although the key schema (#126) now exists.
- **Many separate checkboxes in Art mode** ("show raw gray" in two places, ghost cat, plain (localized), Four-way,
  pixel art, tile) — candidates for a consistent options pattern.
- **Human look-checks** — `editor/t3-looks.json` and the gallery (`npm run t3`) list the T3 checks per PR; the
  design review can reuse them as its checklist.
