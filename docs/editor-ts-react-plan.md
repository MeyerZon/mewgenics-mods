# Editor: TypeScript + React + Vite + zod (migration plan and record)

Owner request (2026-10-20): switch the editor from JavaScript to TypeScript and, where it makes sense, from the
vendored VanJS UI to React + Vite with zod. This page is the plan, the decisions, and what each PR of the stack
contains. `CLAUDE.md` and `README.md` carry the short version; this is the reference.

## Decisions

| Question | Decision | Why |
|---|---|---|
| TypeScript everywhere? | **Yes.** Every `.mjs`/`.js` the editor owns becomes `.ts`/`.tsx` with real type annotations; the JSDoc-typed style is retired. | The code was already `tsc --strict`-checked through JSDoc; the move is mechanical and the types become first-class (generics, discriminated unions, `satisfies`) instead of comment syntax. |
| A build step for the Node side? | **No.** Node ≥ 22.18 (this machine: 26) strips types natively, so `node src/mcp/server.ts` and `node test/run-tests.ts` run the source as-is. | Keeps the "run it from the checkout" property the MCP server, the scripts and the tools rely on. Constraints that follow: explicit `.ts` import extensions and `erasableSyntaxOnly` (no `enum`, `namespace`, parameter properties). `tsc --noEmit` stays the type gate. |
| Vite? | **Yes, for the browser only.** `vite build` bundles `web/index.html` → `web/dist/` (git-ignored); `web/server.ts` serves that next to `/api`. `vite dev` is the hot-reload option with `/api` proxied to the node server. | TypeScript in the browser needs a transform step no matter what; given one, Vite is the standard choice and it also lets the UI import the core's pure art modules directly instead of through a server allowlist. |
| React instead of VanJS? | **Yes.** React 19, TSX, no router, no state library: a 40-line `createStore` + `useSyncExternalStore` replaces `van.state` one-for-one. | The UI is an IDE-style app (three panes, drawers, modals, two tours, an art editor with a live preview) where typed components pay off; VanJS types are weak. The 34-test Playwright suite pins the DOM (class names, roles, flows), so the rewrite is verified rather than trusted. |
| zod? | **Yes, at the boundaries only.** One schema per POST route in `src/core/api-schemas.ts`, shared by the server (parse → 400 + issues) and the client (`post(route, body)` is typed from the same schema). MCP tool inputs follow in the second PR. The core keeps its own hand-written validators (GON, scenes, manifests): those are the product, not transport. | The server used to pass `b.mod`, `b.path` through untyped; the MCP tools hand-rolled `str()/bool()` checks. zod gives one declaration that types both ends and documents the wire. |
| "Zero runtime dependencies"? | **Retired as a slogan, kept as a habit.** Runtime deps are exactly `react`, `react-dom`, `zod`; dev deps add `vite`, `@vitejs/plugin-react`, `@types/*`. The vendored `web/vendor/van-*.js` is deleted. | The docs that said "no bundler by design" described a constraint the owner has now lifted. |

## What does not change

- The core's behaviour and the test oracle: GON tokenizer/parser/serializer, overlay merge semantics (faithful to the
  decompiled `Gon_PatchMerge_a_0x944cc0.c`, `Gon_PatchMerge_b_0x944f50.c` and `Gon_DeepMerge_0x946680.c`), validator, art model, SWF emitter, bindings, in-game runner. Renames and type
  annotations only; the 260 unit checks and the 34 e2e checks must stay green through every commit.
- The MCP server remains hand-rolled JSON-RPC over stdio, no SDK. `src/mcp/server.ts` stays as a two-line shim
  importing `server.ts`, because `~/.claude.json` registers the server by that absolute path and other sessions use
  it concurrently; new registrations should point at `server.ts`.
- `tools/rea-mcp.mjs` (the Ghidra driver) is **not** converted: it is shared infrastructure other agents' sessions
  are running right now, and `docs/engine-map.md` documents its exact invocation.
- The safety rules (writes confined to `mods/<name>/`, never `saves/`, never the game files) live in the core and are
  untouched; the zod gate sits in front of them, not instead of them.

## Layout after the migration

```
editor/
  vite.config.ts              root = web/, build → web/dist/, dev proxy /api → 127.0.0.1:4173
  tsconfig.json               strict, nodenext, jsx react-jsx, allowImportingTsExtensions, erasableSyntaxOnly
  src/core/**/*.ts            the core (unchanged behaviour); api-schemas.ts = zod bodies for /api POSTs
  src/mcp/server.ts, tools.ts MCP server; server.ts = compatibility shim
  web/index.html              Vite entry → src/main.tsx
  web/src/main.tsx            createRoot; imports app.css (the former inline stylesheet)
  web/src/store.ts            createStore / useStore
  web/src/api.ts              getJson / postJson / post(route, body) typed from api-schemas
  web/src/state.ts            the app store (S, tpl) + actions (selectMod, openFile, save, …)
  web/src/components/*.tsx    TopBar, Explorer, Center (+ Editor), RightPanel, StatusBar, Toast, modals, drawers, tours
  web/src/art/*.ts(x)         art-state.ts, ArtExplorer, ArtCenter, ArtRightPanel, NewSceneModal, preview-gl.ts
  web/src/rooms/*.ts(x)       Rooms mode (2026-10-22): room-state.ts (store + actions), RoomPanes.tsx (the lazy chunk: explorer, grid / iso, inspector, findings)
  web/art/preview-dev.html    second Vite page (the standalone preview harness) → preview-dev.ts
  web/server.ts → server.ts  static dist + /api bridge with the zod gate
  scripts/*.ts, test/*.ts     node runs them directly
tools/bindings/*.ts           node runs them directly (they import editor/src/core)
```

## Commands

| Task | Command (from `editor/`) |
|---|---|
| typecheck | `npm run typecheck` |
| unit suite (T0/T1) | `npm test` |
| build the UI | `npm run build` (→ `web/dist/`) |
| serve the UI + API | `npm run web` (serves the build; 503 with instructions if not built) |
| hot-reload UI dev | `npm run web` in one terminal, `npm run dev` in another (http://127.0.0.1:5173/) |
| e2e | `npm run test:e2e` (= `vite build && playwright test`) |
| MCP server | `npm run mcp` |

## PR stack

1. **`feat/editor-vite-react`** (PR #36): the web layer. Red test first (`test/web-tests.ts`: store, highlighter,
   tree, zod schemas, server gate), then the infrastructure (Vite, tsconfig, scripts, server), then the React port of
   `app.mjs` + `art-ui.mjs`, the TS port of `preview-gl.ts` / `preview-dev.ts`, the e2e suite as `.ts`, VanJS
   removed, docs updated.
2. **`feat/editor-ts-core`** (stacked on 1, PR #37 or next): every remaining `.mjs` under `editor/src`, `editor/scripts`,
   `editor/test`, `tools/bindings` → `.ts` with TS types; `@types/node` replaces `types/node-shims.d.ts`;
   `src/core/api-schemas.ts` grows the MCP tool input schemas (`z.toJSONSchema` feeds `tools/list`); the structural
   test "no `.mjs` left except the shim" goes red → green; docs paths updated.

## TDD evidence

See each PR body for the red → green table with the exact summary lines. End state of the stack (2026-10-20):
`npm run typecheck` clean over the whole editor + `tools/bindings`, `npm test` 288 passed / 0 failed,
`npm run test:e2e` 34 passed, `npm run bindings:check` current, zero JSDoc type tags left, zero `.mjs` sources
except the MCP shim.

## Rooms mode (the Room editor, 2026-10-22)

A third mode beside Data and Art (top bar Data | Art | **Rooms**, deep link `?mode=rooms`; a `.lvl` clicked in the
Data-mode explorer opens there). It follows the same split as the other two modes: the browser holds a store
(`web/src/rooms/room-state.ts`, `S.roomMode` in the app store) and calls the `/api` bridge; every edit goes through
the pure helpers of `src/core/level/edit.ts`, which Vite bundles into the UI and MCP `write_level` runs on the server,
so a click and an agent edit change a level identically. The core owns the disk side (`src/core/level/level-io.ts`:
`listLevels` / `readLevel` / `writeLevel` / `validateLevel` / `levelPalette` on `api.ts`; writes only
`mods/<mod>/levels/**.lvl`), the routes are `GET /api/levels`, `GET /api/level`, `GET /api/level-palette`,
`POST /api/level`, `POST /api/level/validate` (zod `LvlFileSchema` in `api-schemas.ts`). Tests:
`test/level-editor-tests.ts` (helpers, I/O, schema, MCP tools; T1: all 2361 vanilla levels through the JSON wire path)
and `tests/e2e/rooms.spec.ts`.

### Tileset art and the Iso view (2026-10-22)

The grid, the palette rows and an optional **Iso** view show the game's own art instead of the dev editor's tint
swatches, in a tileset picked in the toolbar (default: the tileset of the map whose `levels { folder }` holds the
room, else `default_tileset`, i.e. `alley`).

- **Resolve** (`src/core/level/tile-art.ts`, pure): a tile id → its `tiles.gon` class (the heaviest of a weighted
  list) → the clip of that name, through `TILE_CLIP_ALIASES` (`ToxicTile` → `ToxTile`, `TallGrassTile` →
  `TallGrassBack`, …) and the tileset's `water_alt_tile`; a spawn id → its `spawns.gon` object → the character's
  `graphics.movieclip` (`variant_of` chains, `Name_Elite` → `Name`) → the tileset's clip remap (`static_1x1_a` →
  the alley's `Rubble`, a mod's `alley { Rat ArtProbe }`); enemy factions draw mirrored. Then the SWF that exports
  the clip: the mod's `swfs/*.swf` first, then the vanilla SWFs in `swflist.gon` order. Everything that does not
  resolve is a named reason (`ART_REASONS`: `empty`, `not-in-palette`, `blank-tile`, `no-tile-class`, `utility`,
  `no-character`, `cat-rig`, `no-clip`, `no-swfs`) shown in the cell tooltip, and that cell keeps its swatch.
- **Render** (`src/core/art/swf-library.ts` + `swf-raster.ts`): a tag-header walk indexes each SWF's exports and
  character offsets (the vanilla files are up to 170 MB; nothing is parsed in full), then only the clip's tags are
  parsed and frame 1 is rasterised in software (supersampled scanlines: even-odd fills, stroke polygons from
  `stroke.ts`, padded gradients, bitmap fills, cxforms, clip layers; no text/morphs/filters, no palette remap — cats
  are not drawn). Scale 0.5 px per clip px (a 140 px tile diamond → 70 px) times `graphics.scale`. The pure-magenta
  `#ff00ff` surface of the shader-filled tiles (water, lava, ice, creep, oil, …) is painted in the tile's tint.
- **Serve + cache** (`src/core/level/level-art.ts`): `GET /api/level-art?mod&tileset&path` (every palette id's
  resolution + the tileset list), `GET /api/level-tile-art?mod&tileset&tile=<id>|object=<id>` (the PNG; `&meta=1`
  gives its size and the clip's registration point in it). Thumbnails and the export index are cached in
  `editor/data/level-art/` (git-ignored, keyed by the SWF's size + mtime); no game art is ever committed.
- **Iso view** (`rooms/RoomIso.tsx`, `edit.ts` `isoCellCenter` / `isoDrawOrder`): 2:1 diamonds (the engine's
  projection: `docs/3d-rendering-feasibility.md`), cell (x, y) at ((x−y)·w/2, (x+y)·w/4), tile art on the cell centre,
  objects feet-registered on it, drawn in x+y order (back first). Painting, erasing and selecting work on the diamonds.
- Tests: `test/level-art-tests.ts` (T0 on a SWF built by the editor's emitter + a synthetic base: resolver, reasons,
  rasteriser origin / mirror / scale, the cache, no-`.extracted` fallback; T1: every vanilla tile id of `alley`
  resolves to a clip or a named reason and every clip renders non-empty, the Rat and a static) and the two
  "tileset art and the iso view" specs in `tests/e2e/rooms.spec.ts` (the swatch fallback runs everywhere; the art
  check skips without `.extracted/swfs`).

## UI primitives and conventions (2026-10-22)

PR 1 of the UX overhaul adds the shared building blocks; later PRs move the screens onto them.

- **Tokens** (`web/src/app.css` `:root`, with light-theme values): spacing `--sp-1..6` (4–32 px), radii
  `--r-sm/md/lg`, stacking `--z-menu/scrim/example/toast`, `--shadow-pop`, and the colours that used to be
  hard-coded (`--gutter`, `--link-hover`, `--vc-bg`, `--merge`, the GON syntax palette `--syn-*`, used once by
  `.hl .*`).
- **Primitives** (`web/src/components/ui.tsx`): `Button`, `IconButton` (needs `aria-label`), `Pill`, `Tabs` /
  `SubTabs` (`role=tablist`, ←/→), `Segmented` (`.modeswitch`, `aria-pressed`), `SearchBox`, `SectionHeader`,
  `EmptyState`, `Summary`, `FindingsList`, `Field` (label then control, `useId`), `Checkbox`, `Select`, `Modal`,
  `Drawer`, `Menu`, `PaneBoundary`. They render the existing classes, so a screen moved onto them keeps its DOM.
  `EmptyState` and `PaneBoundary` live JSX-free in `components/boundary.ts` so Node can unit-test them.
- **Hooks / modules**: `hooks/useDialog.ts` (role + aria-modal, focus in, Tab trap, focus restore, Esc, scroll
  lock); `shortcuts.ts` (the one window keydown listener: Ctrl/Cmd+S is always default-prevented, then the handler
  set with `setSaveHandler`; Esc closes the topmost overlay of the `pushOverlay` stack, menu > tour > modal >
  drawer); `toast(text, {kind, ms})` over the `S.messages` queue (`state.ts`); `apiFetch` (`api.ts`) throws an
  `ApiError {status, message, issues}` and toasts it; `useStoreShallow` (`store.ts`) for selectors that build
  objects or arrays; `S.busy` / `setBusy`. `main.tsx` renders under `React.StrictMode`.
- **Conventions test** (`test/web-conventions-tests.ts`, run by `npm test`): source-text rules over `web/src`:
  no `S./A./R.set(` in `components/`, `art/`, `rooms/` views (the `*-state.ts` actions may), no `window.confirm`
  outside `actions.ts`, no clickable `<span>`/`<div>` (the scrim click-outside shells are exempt), no
  `defaultValue`/`defaultChecked` outside `art/Bits.tsx`, every `useEffect` has a dependency array, no index keys.
  Today's violations are listed per file in `test/fixtures/web-conventions-allow.json`. **The allow-list only
  shrinks:** a file over its allowance fails, and so does an allowance above the real count, so fixing a violation
  means lowering its number in the same PR. It never grows; the goal is an empty list.
- e2e: `tests/e2e/a11y.spec.ts` pins the dialog, menu, toast and Ctrl+S behaviour.
- **The shell (PR 2)**: one command bar. The top bar's Validate / Save (`.topbar-validate` / `.topbar-save`) and
  Ctrl+S act on what the current mode has open (`actions.ts` `currentMode` / `saveCurrent` / `validateCurrent`:
  the overlay, the scene, the room); the scene tab bar keeps only Build SWF and the room toolbar has no Save. The
  status pill counts the current mode's findings and opens them. `web/src/dirty.ts` is the unsaved-work registry
  (scopes `data`, `art`, `vc`, `rooms`, registered by `actions.ts`, `art-state.ts`, `room-state.ts`); `guard(scopes,
  action)` opens the ConfirmModal (`S.confirm`: Cancel / Discard / Save and continue) before a mod switch, another
  file / scene / room, a close or a new scene / room, and `beforeunload` asks on reload. Mode switches never ask
  (nothing is lost). Saving a GON file only re-lists the mod's files (`refreshModFiles`) and a build only re-lists the
  art (`refreshArtListings`), so neither closes an open scene or room. `GET /api/status` (`editorStatus` in
  `src/core/api.ts`: PE headers only via the validator's memoized `installedNativeBuild`, `existsSync` checks) feeds
  the status bar; `web/src/deeplink.ts` reads and writes `?mode=&mod=&file=` (`history.replaceState`). Launch… shows
  the `launch-dev.bat mods\<mod>` command with Copy; the editor never starts the game. e2e: `tests/e2e/shell.spec.ts`.
- **Data mode (PR 3)**: the base explorer pages instead of capping: `GET /api/base?category=&filter=&offset=&limit=`
  answers `{entries, total, offset}` (`api.listBaseEntries`' optional page; junk offset → 0, limit clamped 1..5000;
  no page → everything, as the MCP tool reads it), the UI asks for `BASE_PAGE` (300) and "Show 300 more" appends the
  next page through `applyBasePage` (`state.ts`: offset 0 replaces, offset = loaded length appends, anything else is a
  stale reply). The filter's placeholder names the category it filters. The scaffold kinds are one list,
  `src/core/template-kinds.ts` (pure): the zod `TemplateKind` enum is built from it and the template modal imports
  it. The modal is titled "New mod" from the mod menu (`openTemplate({intent: "mod"})`), "Scaffold an overlay"
  otherwise; it is a `<form>` (Enter scaffolds) and the result is the written-file list with Open (a `.lvl` opens in
  Rooms), "Open first file & validate" and the raw JSON behind `<details>`. The Components tab shows the where-used
  files `/api/components?whereUsed=1` returns (first 8, "show all"). The editor status line reads `S.validating`
  (`validating…` from the keystroke until the newest check answers, then `validated`; `validation off` without a mod).
- **Art mode (PR 4)**: Art is its own chunk: `App.tsx` `React.lazy`-loads `art/ArtPanes.tsx` (the three panes,
  `preview-gl.ts` and the Ruffle host) behind an `EmptyState` fallback; `art-state.ts` stays in the shell (actions.ts
  imports it) and gets `createPreview` through `registerPreviewFactory`. `web/src/prefs.ts` keeps per-viewer view
  options as JSON under `mewged.prefs.<key>` (`art.showGray | background | loop | ghostCat`; the old
  `mewged.art.ghostCat` migrates on first read), read by `hooks/usePref.ts` and applied to the renderer when it is
  created. The Preview panel has one View options card (raw gray — the Shapes tab's copy is gone —, a controlled
  background select, ghost cat on a `parts: game` rig; loop stays in the transport), a controlled palette-row box and
  the note that browsing rows never dirties the scene. A shape row is id · chips · ramp · meta · Preview · `…` (the
  `Menu` primitive, open state `S.openMenu = "shape:<id>"`; `ShapeRowMenu.tsx`), whose items keep the old
  aria-labels; Replace clicks the row's hidden file input. One "Import SVG or PNG" drop zone: a PNG picked or dropped on
  any Art zone waits in `A.pendingPng` for the Import PNG strip (mode, scale, pixel art, tile) and Import. The
  VectorCraft panel is mounted once in `ArtCenter`, after and outside the `key={scenePath}` scene panel, so its
  iframe survives scene switches (`.artpanel.vc-on` shrinks the scene panel to its header); a document remembers its
  mod + scene and Apply is off in another scene. `SceneTabs.tsx` is the Shapes tab (rows, Bake glow form, path fills)
  and re-exports `SpritesTab` / `ExportsTab` / `JsonTab`; the views edit the scene through art-state actions that
  replace the edited object, so the `React.memo` shape / sprite / layer rows re-render only when theirs changes. The
  JSON tab keeps typed text when the scene moves underneath (a Reload / Keep banner). Every Art file is off the
  conventions allow-list but one positional path-row key in `SceneTabs.tsx`.
- **Rooms mode (PR 5)**: Rooms is its own chunk too: `App.tsx` `React.lazy`-loads `rooms/RoomPanes.tsx` (the
  explorer, the centre, the right panel) behind an `EmptyState` fallback; `room-state.ts` stays in the shell. The old
  `Rooms.tsx` is split into `RoomExplorer`, `RoomToolbar`, `RoomGrid`, `RoomIso`, `RoomInspector`, `NewRoomModal`,
  `RoomBits` (labels, art lookup, the self-hiding thumbnail) and `grid-input.ts`. The explorer has the Rooms list and
  ONE Palette list with a `Tiles | Objects` Segmented switch (`R.paletteKind`; only the active kind is in the DOM, the
  list fills the rest of the explorer; choosing the Tile / Object tool or a brush shows that kind). The toolbar uses
  `Segmented` for the tool and the view, a dirty dot after the path and an `IconButton` Close. The right panel is
  `Inspector | Findings` tabs (`R.rightTab`; the Findings label carries the count, `Findings · 1`; the status pill
  opens it) and Findings is a `Summary` (`findingsLevel(counts)`) + `FindingsList`. Grid input is pointer events (a
  touch / pen press releases its implicit capture so a drag reaches the next cells) with ONE window `pointerup` /
  `pointercancel` listener (`useStrokeEnd`, mounted by `RoomCenter`); both grids are `role=grid` with
  `role=gridcell` buttons and one roving tab stop (the selection): arrows `moveSelection` (clamped, `clampSel`),
  Enter / Space `applyAtSelection`. Cells (`Cell`, `IsoCell`) and palette rows are `React.memo` with primitive props
  (tile id, objects summary, art src, selected, random), so painting one cell re-renders that cell. The New room dialog
  is a `<form>` (Enter creates). Every `rooms/*` file is off the conventions allow-list. e2e: `tests/e2e/rooms.spec.ts`
  "the explorer, the panes and the grid input (UX PR 5)".

## Follow-ups (not in this stack)

- Response-shape schemas for the `/api` GETs (today the client types them by hand in `web/src/types.ts`).
- `.analysis/userdata-xrefs.mjs` (git-ignored scratch) imports `editor/src/core/bindings/pe.ts`; it needs its import
  changed to `pe.ts` by whoever next uses it.
