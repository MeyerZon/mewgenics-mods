# Web UI inventory — the editor's web UI after the 2026-10-22 overhaul

Snapshot of the editor's web UI (`editor/web/`, served by `npm run web`) as it stands at the top of the UX overhaul
stack (PRs #141 → #148, 2026-10-22). It says what each part is and where it lives, so a later review can start
from facts; §7 records what the overhaul resolved or deferred and §8 maps the design boards to the PRs.

Status markers: **[main]** merged · **[ux-N]** in the overhaul stack (`feat/ux-1-primitives` … `feat/ux-6-onboarding`,
`docs/ux-7-inventory`; each PR's base is the previous branch, merge in order) · **[planned]** not built.

## 1. Shell and global UI

Files: `editor/web/src/App.tsx`, `components/TopBar.tsx`, `StatusBar.tsx`, `ui.tsx` (the primitives), `boundary.ts`,
`hooks/`, `shortcuts.ts`, `dirty.ts`, `deeplink.ts`, `prefs.ts`, `actions.ts`, `state.ts`, `store.ts`, `app.css`.

- **Layout** — three panes (explorer · center · right panel; the right panel only with a mod open), a bottom status
  bar, a toast queue. The mode decides what fills the panes; Art and Rooms panes are lazy chunks (`art/ArtPanes.tsx`,
  `rooms/RoomPanes.tsx`), as are the tours, examples and concepts (`components/Onboarding.tsx`). Each pane and overlay
  sits in a `PaneBoundary` (an error boundary with "Reload pane"). **[ux-1, ux-4, ux-5, ux-6]**
- **Primitives** (`ui.tsx`) — `Button`, `IconButton`, `Pill`, `Tabs`/`SubTabs` (`role=tablist`, arrow keys),
  `Segmented`, `SearchBox`, `SectionHeader`, `EmptyState`, `Summary` + `FindingsList`, `Field` (label ↔ control by
  id), `Checkbox`, `Select`, `Modal`, `Drawer`, `Menu` (`aria-expanded`, Esc, arrow keys). Every modal, drawer, tour
  and example goes through `useDialog` (`role=dialog aria-modal`, focus trap, autofocus, focus return, Esc). **[ux-1]**
- **Mode switch: Data | Art | Rooms** — a `Segmented` control; a dot on a mode marks unsaved work there. Deep links
  `?mode=art|rooms`, `?mod=`, `?file=` are read at startup and written back with `replaceState`. **[ux-2]**
- **Mod menu** — lists `mods/`; `New mod…`, `⇩ Export…`, `⇧ Import mod…`. Switching mods while anything is unsaved
  asks first (the dirty guard, below). **[main, ux-2]**
- **Status pill** — `● N errors · M warnings` from the current mode's findings (Data report / Art scene findings /
  Rooms `lvl-*` findings); click opens that mode's findings tab. **[ux-2]**
- **Validate** and **Save** — one of each in every mode; `saveCurrent()` dispatches to the overlay / scene / room;
  `Ctrl+S` saves; Save shows an unsaved dot and its tooltip names what it saves. **[ux-2]**
- **Launch…** — a popover with the exact `launch-dev.bat mods\<mod>` line, a Copy button and the `-savesuffix dev`
  note. The editor never starts the game (owner decision 2026-10-22). **[ux-2]**
- **Help (?) menu** — Data mode: Guided tour (5 steps) · Worked example: Joker's Luck. Art mode: Art mode tour (7
  steps) · Art worked example. Rooms mode: Rooms mode tour (5 steps) · Rooms concepts. Concepts explainer. **[ux-6]**
- **Dirty guard** (`dirty.ts`) — a registry of the four dirty scopes (overlay buffer, scene, VectorCraft drawing,
  room); switching mods, files, scenes or rooms while something is unsaved opens the Unsaved changes dialog (Cancel /
  Discard / Save and continue); `beforeunload` warns too. Mode switches lose nothing, so they are not guarded;
  browsing palette rows does not dirty a scene. **[ux-2]**
- **Status bar** — `<mod>/<file>` (scene or room path per mode) · the overlay-mode note · `build <id>` from
  `GET /api/status` (warn style on an unknown build; the tooltip lists the framework dll, Mewjector, extracted data)
  · `extracted ✓/–` · `framework ✓/–` · `● local server` (red when the last fetch failed) · `save: dev`. **[ux-2]**
- **Toast** — one queue (`toast()`), `role=status aria-live=polite`, click to dismiss. **[ux-1]**
- **Shortcuts** (`shortcuts.ts`) — `Ctrl/Cmd+S` save (never the browser's save page), `Esc` closes the topmost
  overlay (menu > tour > modal > drawer). **[ux-1]**

## 2. Data mode

- **Explorer → Mod files** — collapsible tree (`aria-expanded`) with `.append` / `.merge` / `.patch` chips; `.lvl`
  rows carry a `room ↗` chip ("Opens in Rooms mode"). **+ New overlay** opens the template modal. No mod: a
  **+ New mod** card. **[main, ux-2, ux-3]**
- **Explorer → Base data (read-only)** — the filter names the selected category ("Filter entries in abilities…");
  categories with counts; a category lists its entries paged 300 at a time (`showing 300 of 3,076 · Show 300 more`);
  an entry opens the **Base entry drawer**. **[ux-3]**
- **Center → empty states** — `EmptyState` cards: Create your first overlay · Browse base data (focuses the filter,
  expands the first category) · Take the guided tour (hidden once "Don't show again" is ticked) · Rebuild Joker's
  Luck; a concepts button. No file: "+ New overlay" and "How overlays work". **[ux-3, ux-6]**
- **Center → file tab bar** — filename with ✕, a mode chip, breadcrumb. **GON editor** (`Editor.tsx` +
  `gon-highlight.ts`): textarea + windowed highlight overlay + gutter; typing re-validates after 350 ms. **Editor
  status line** — Saved/Unsaved · byte count · GON/CSV/TXT · `validating…` / `validated` / `validation off`. **[ux-3]**
- **Right → Validation** — `Summary` card + `FindingsList` (code, path, line, message). **Preview** — merge preview
  per touched key with added/changed chips; CSV rows. **Components** — debounced search of `glaiel::` class names;
  each result shows a where-used count with the first entries ("show all"); an exact match shows the **reads** box
  (`data-testid=component-keys`: key, type, default, required, inherited-from, children, "vanilla writes it; the
  game ignores it" for unread keys). **[ux-3]**
- **Template modal** — title "New mod" from the mod menu / explorer card, "Scaffold an overlay" otherwise; fields
  mod, kind, entry name, display name, description, plus per-kind extras (`variant_of` + status effect for abilities,
  colour for `glowing-character`, source tileset for `tileset-variant`); the kind list is the one shared constant
  `src/core/template-kinds.ts` (`ability, passive, item, status-data, room, tileset-variant, particle, vfx-ability,
  glowing-character`). **Scaffold** (Enter submits) shows "Created N files in mods/<name>" with an **Open** button per
  file, "Open first file & validate", and the raw response behind a disclosure. **[ux-3]**
- **Drawers** — Base entry viewer; Components drawer (same search, with no mod open). **Concepts drawer** — the
  current mode's section first: Data (append / merge / patch, the four checks, the data ↔ native seam), Art, Rooms.

## 3. Art mode

- **Art explorer** — **Art scenes** (`art/*.scene.json`, **+ New scene**); **Built SWFs** (click → Build tab's
  Inspect); **Assets** (`art/` SVGs and PNGs). Switching scenes while one is unsaved asks first.
- **Scene tab bar** — name with ✕, "scene → .swf" chip, Saved/Unsaved, **Build SWF** (Save lives in the top bar).
- **Scene header** — name, fps, stage size, counts; a findings button jumps to Findings. **Sub-tabs** (`SubTabs`):
  Overview · Shapes · Sprites · Timeline · Rig · VectorCraft · Exports · JSON.
- **Shapes** — per shape: id, chips (baked / passthrough / bitmap / gradient), the 16-level ramp, meta, **Preview**,
  and a `…` menu (`More actions for <id>`): Open in VectorCraft · Export SVG · Bake glow… (inline form: kind, colour,
  blur, dx/dy) · Replace from SVG… · Wrap in a sprite · Delete. **Import** card: drop or pick an SVG or PNG; a PNG
  shows its options (mode sprite / background plate / bitmap fill, scale, pixel art, tile) and an **Import** button —
  the options apply to dropped PNGs too. **Texts** — New text; per text words, font, size, colour, align, plain
  (localized), Delete. **Path editor** for the previewed shape. **[ux-4]**
- **Sprites** — New sprite; per sprite frames, labels, Preview, Delete; layers (depth, keys, mask, Delete); "+ layer
  from". **Timeline** — label pills, frame ruler, layer × frame grid, key inspector (Add key, Delete key, Insert /
  Delete frame, Layer up/down, key fields, Add label). **Rig** — New cat rig (7 slots), per rig Preview / Open in
  Timeline / findings / slot selects; **Cat animations**: name + Four-way + New cat animation, the donor card with
  Preview, Open in Timeline, findings, facing pills, Animate pose. **VectorCraft** — the vendored app in an iframe
  mounted once per Art session (it survives scene switches and a broken scene file); Apply to shape is disabled
  when the drawing belongs to another scene. **Exports** — export → ref list, Remove, New export (a controlled form).
  **JSON** — the scene as editable JSON; unapplied text is kept when the scene changes underneath (a Reload / Keep
  banner). **[ux-4]**
- **Right → Preview** — target select, **Fit**, the engine-faithful canvas (WebGL, canvas2d fallback), transport
  (first / previous / Play–Pause / next, frame counter, loop), scrubber with label ticks, label chips, **View
  options** (show raw gray · background checker/stage/black/white · ghost cat for `parts: game` rigs; all remembered
  under `mewged.prefs.art.*`), palette row (number input, Browse rows… → the **Palette drawer**, the 16-colour ramp;
  browsing never marks the scene unsaved). **Findings** — scene validation. **Build** — DoABC radio (none / stub),
  **Build SWF**, **Dry run**, **Prepare SWF gate**; the result card and the Inspect card; one sentence on
  SymbolClass/DoABC instead of the old gate prose. **Ruffle** — a mod SWF or an extracted vanilla SWF, Load, play,
  metadata. **[main, ux-4]**
- **Dev page** — `web/art/preview-dev.html`, a standalone renderer harness.

## 4. Rooms mode

Files: `editor/web/src/rooms/` (`RoomPanes.tsx`, `RoomExplorer.tsx`, `RoomToolbar.tsx`, `RoomGrid.tsx`, `RoomIso.tsx`,
`RoomInspector.tsx`, `NewRoomModal.tsx`, `RoomBits.tsx`, `grid-input.ts`, `room-state.ts`). **[main #125/#130, ux-5]**

- **Room explorer** — **Rooms** (`levels/*.lvl`, **+ New room**) and one **Palette** with a `Tiles | Objects`
  switch, a filter, thumbnails (from `/api/level-tile-art`, cached in `editor/data/level-art/`) or tint swatches.
  Picking the Tile / Object tool or a brush switches the palette to that kind.
- **Toolbar** — path with a dirty dot · Select / Tile / Object / Erase · Flat | Iso · tileset select · brush label ·
  Close. The status line under the grid reads `10×10 · tileset <name>` and the input hints.
- **Grid** — click or drag to paint (pointer events, one shared `pointerup`), keyboard painting (arrows move the
  selection, Enter / Space apply the tool), cell tooltips, random-cell and object-stack markers; the Iso view (2:1
  diamonds, sprites on cell centres, nearer cells last) paints the same way. Cells are memoised, so painting one cell
  re-renders one cell.
- **Right → Inspector | Findings** — real tabs; the Inspector has the tile pick with "random" + the weighted list
  (+ choice, weight, ✕) and per-object pick editors; Findings shows a `Summary` card and the live `lvl-*` rows, with
  the count in the tab label. The status pill opens Findings.
- **New room modal** — folder + name, Enter creates (the room template: 4 player spawns, 2 Rats).

## 5. Onboarding **[ux-6]**

- **Anchored tours** — one `GuidedTour` for the three tours; a step may name a `data-tour` target
  (`tour-anchors.ts`, 20 anchors on the real controls); when it is on screen the step spotlights it and the card sits
  beside it (flipping when it would overflow, re-measured on resize); off-screen targets are scrolled into view once;
  otherwise, or with `?tour=center`, the centred card. Skip / Done / Esc mark the tour seen; "Don't show again" also
  hides the empty-state "Take the tour" nudge. Keys `mewged.onboard.{tour,artTour,roomTour}{Seen,DontShow}`.
- **Data tour** (5) — Browse the base game · Create an overlay · Edit with live validation · Read the merge preview ·
  Launch on the dev save (the Launch… popover). Auto-opens on the first run.
- **Art tour** (7) — Switch to Art · Scenes & shapes explorer · Import an SVG or PNG · Grayscale → palette ·
  In-game-faithful preview · Build the SWF · Timeline, Rig, VectorCraft. Auto-opens on the first Art entry.
- **Rooms tour** (5) — Switch to Rooms, open or create a room · Pick a brush · Paint the grid · Inspect a cell ·
  Findings, save, test it in a fight. Auto-opens on the first Rooms entry. `?mode=art|rooms` suppress the auto-open.
- **Worked examples** — `components/examples/` (`steps.ts` holds the step data; `Stepper.tsx` renders it). Data:
  Create the mod folder · Add the ability overlay ("Insert this overlay (open scaffolder)") · Add localization rows
  (a real `combined.csv.append` row) · Register the native name · Validate & launch dev; it opens on step 1. Art:
  Switch to Art mode · Create a scene · Import an SVG · Preview it faithfully · Build the SWF; each step drops into
  the live Art UI (it opens a mod first when none is open).
- **Concepts drawer** — Data, Art and Rooms sections, the current mode's first; Help → Rooms concepts scrolls to
  Rooms. The stale "no gradients/text" and "DoABC unresolved" cards are gone.

## 6. MCP tools (they share `editor/src/core/api.ts` with the UI)

**32** on `main` (#144): list_base_data, read_base_entry, search_components, read_mod, write_overlay, validate_mod,
preview_merge, list_registered_native_names, new_from_template, list_ingame_tests, list_art_scenes, read_art_scene,
write_art_scene, new_art_scene, import_svg, export_svg, bake_glow, build_swf, inspect_swf, run_ingame_test,
check_game_build, start_ingame_session, ingame_exec, stop_ingame_session, port_bindings, vectorcraft_exec, pack_mod,
install_mod, import_bitmap, read_level, write_level, extract_model_texture. The UI's `GET /api/status`
(`api.editorStatus`) and the paged `GET /api/base` (`offset`/`limit`) are web routes over the same core; the MCP
tools are unchanged by the overhaul.

## 7. The 2026-10-22 UX issues — resolved or deferred

| Issue (as listed before the overhaul) | Outcome |
|---|---|
| Launch dev ▸ does not launch | Replaced by the Launch… copy-command popover (owner's choice: no process from the browser) |
| Components tab shows names only | Where-used rendered next to the reads box **[ux-3]** |
| Template result is raw JSON | "Created N files" with Open buttons; raw response behind a disclosure **[ux-3]** |
| Template dropdown incomplete | All kinds from one shared constant (`src/core/template-kinds.ts`) **[ux-3]** |
| Font select ignores embedded fonts | **Deferred** — font import is its own feature (see §8 planned) |
| Mode-specific top bar, three save patterns | One command bar; `saveCurrent()` by mode; Ctrl+S **[ux-2]** |
| Static status bar labels | Real values from `/api/status`; a real server dot **[ux-2]** |
| Base data capped at 300 | Paged: Show 300 more **[ux-3]** |
| Import mod… limited to ~6 MB | **Deferred** (server body limit; the CLI path `npm run pack -- --install` is documented) |
| No key help while typing GON | **Deferred** — the key schema exists (`editor/component-schema.json`); wiring it into the editor is a follow-up |
| Many separate checkboxes in Art mode | One View options row + persisted prefs; the Shapes-tab duplicate removed **[ux-4]** |
| Human look-checks | `editor/t3-looks.json` entries `ux-*` (12) **[ux-7]** |

Also fixed on the way: saving a GON file closed the open scene and room (Data `save()` re-ran `selectMod`) and
Build SWF closed the open scene (`build()` reloaded the mod's art) — both **[ux-2]**; the Data worked example opened
on the wrong step **[ux-6]**; the VectorCraft iframe reloaded on every scene switch **[ux-4]**.

## 8. Overhaul 2026-10-22 — the design boards and where each landed

The design canvas "Mewgenics Mod Editor UI" (https://claude.ai/artifact/WmQ9kVrbuCvEc72uNgJuSa) gained a fourth row
on 2026-10-22 (title note "Overhaul 2026-10-22"); each board is the spec for one PR. Owner decisions the same day:
artboards first, then code; "Launch dev" becomes a copy-command popover; a stack of seven PRs, each TDD red → green;
the UI follows the React conventions in `docs/editor-ts-react-plan.md` "UI primitives and conventions" (enforced by
`editor/test/web-conventions-tests.ts`, whose allow-list shrank from 65 store writes in views to 0 across the stack).

| Board | PR |
|---|---|
| `Shell.dc.html` — one command bar for Data \| Art \| Rooms, status bar, dirty guard, Launch… | #142 `feat/ux-2-shell` |
| `TemplateResult.dc.html` — files, not JSON; the full kind list | #145 `feat/ux-3-data-mode` |
| `ArtOptions.dc.html` — shape row menu, Import card, View options | #146 `feat/ux-4-art-mode` |
| `RoomsMode.dc.html` — one palette, real tabs, keyboard painting | #147 `feat/ux-5-rooms-mode` |
| `Coachmark.dc.html` — anchored tours, the Rooms tour | #148 `feat/ux-6-onboarding` |
| (no board) primitives, dialogs, shortcuts, toast, boundaries, StrictMode, apiFetch, conventions test | #141 `feat/ux-1-primitives` |
| (no board) this inventory, counts, T3 looks | `docs/ux-7-inventory` |

Bundle: the eager bundle went from 509 kB to about 318 kB; Art, Rooms and onboarding are lazy chunks.

**[planned]** — unchanged from before: the 3D model card in Data mode (`docs/3d-importer-design.md` §3.3), TTF/OTF
font import into scene fonts, "Swap rig for <entry>", a particle editor, room / tileset-variant kinds in the Rooms
New room dialog (the template modal has them), GON key help while typing.
