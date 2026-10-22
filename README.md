# mewgenics-mods

A modding toolkit for **Mewgenics** (Steam app 686060, build 1.1.21239). The game ships no scripting runtime — its
content is GON-data-driven C++ — so this repo mods it at three layers and adds an editor to make the data layer safe
and fast to author.

- **Data layer** (`mods/`) — GON/CSV overlays loaded through the game's own `-modpaths` loader. Zero injection; this
  is the sanctioned path. New abilities, items, passives, events, balance, localization, art.
- **Native layer** (`native/`) — `mewframework.dll`, chainloaded by [Mewjector](https://github.com/githubuser508/mewjector)
  (`version.dll`), for mechanics the data layer can't express (new per-turn status logic, etc.). Activates **only** on
  `-savesuffix` launches and **only** on a recognized game build; otherwise it stays inert.
- **Editor** (`editor/`) — a local **data-layer mod editor**: a GON engine, overlay/merge engine, a four-check
  validator, an MCP server (for agents), and a web UI (for humans). **Zero runtime dependencies.**

> **Legal/ethics.** For your own single-player copy. Never redistribute game executables or assets; mods load from the
> user's own install at runtime. This repo tracks no game bytes beyond short function signatures.

> **License.** MIT (`LICENSE`). Mods you make with the toolkit are yours and owe nothing; if it helped, a one-line
> "Made with mewgenics-mods" in your mod's description would be appreciated — a request, not a condition
> (`ATTRIBUTION.md`).

## Repository layout

| Path | What |
|---|---|
| `mods/` | Data-layer mods (GON/CSV overlays). Sample: `jokers-luck`, plus a `dev-sandbox`. |
| `native/` | Native framework (`framework/`), the `version.dll` chainloader setup, and native mods (`mods/`). |
| `editor/` | The data-layer mod editor (core + MCP server + web UI). See [editor usage](#the-editor). |
| `tools/` | `gpak.py` (read-only pack reader), `bindings/make-signature.ts` + `bindings/gen-headers.ts` (signature + header generators), `rea-mcp.mjs` (REA/Ghidra driver). |
| `bindings/` | Per-build manifest `<steamBuildId>.json` (signatures, RVAs, offsets + the anchors that re-find them); `signatures.h`/`offsets.h` are generated from it. See [`docs/binding-port.md`](docs/binding-port.md). |
| `docs/` | The authoritative notes — start here. |

## Start here (docs)

- **[`docs/engine-map.md`](docs/engine-map.md)** — what the binary is, verified facts, build identity, function RVAs,
  the status-system model.
- **[`docs/data-mods.md`](docs/data-mods.md)** — GON overlay semantics (`.append`/`.merge`/`.patch`), content shapes
  for abilities/items/passives/etc., and how a data mod pairs with a native status.
- **[`docs/automation-feasibility.md`](docs/automation-feasibility.md)** — whether the game can be driven for
  automated testing (launching fights, AI auto-resolve, seeding, headless).
- **[`docs/ingame-testing.md`](docs/ingame-testing.md)** — the in-game test harness: `.mewtest` scripts that run
  debug-console commands inside the game and come back with a verdict (`npm run test:ingame`, MCP `run_ingame_test`).
- **[`docs/tdd-procedure.md`](docs/tdd-procedure.md)** — how work is done here: test-first, four tiers (unit, local
  data, in-game, human), and the evidence every PR carries.

## Sample mod: Joker's Luck

A new status that rerolls the carrier's luck modifier to a non-zero value between −10 and +10 at the start of each of
its turns — the full two-layer loop in one feature. The data half (`mods/jokers-luck/`) defines the ability, tooltip,
and localization; the native half (`native/mods/jokers-luck/`) supplies the per-turn behavior; the registered name
`JokersLuck` joins them. Grant it in a battle with the console command `bind JokersGambit`. Verified in combat.

## The editor

A tool whose **core is the single source of truth** — the MCP server and web UI are thin adapters over it, so there
is one GON engine and one validator. The validator catches the mistake class that actually crashed the game once (a
referenced name that doesn't resolve, a missing localization key, a `.merge` onto a non-existent key). The web UI is
React + TypeScript built by Vite; zod types the `/api` request bodies at both ends; the Node side (core, MCP server,
scripts) runs straight from the checkout with no bundler. Runtime dependencies are exactly `react`, `react-dom` and
`zod` (`docs/editor-ts-react-plan.md`).

```sh
cd editor
npm install          # react, react-dom, zod + dev-only vite, typescript, playwright
npm run build:index  # generate the git-ignored data/ caches (component list + base-data index)
npm test             # unit suite (GON, overlays, validator, art, in-game runner against a fake game, MCP smoke, web layer)
npm run test:ingame  # T2: launch the real game per mods/<mod>/tests/*.mewtest (needs Steam + native/dist/mewtest.dll)
npm run build        # Vite build of the web UI → web/dist/ (git-ignored)
npm run web          # http://127.0.0.1:4173/ (serves web/dist + the /api bridge)
npm run dev          # hot-reloading UI at http://127.0.0.1:5173/ (proxies /api to `npm run web`)
npm run test:e2e     # vite build && playwright test (46 browser checks)
npm run mcp          # MCP stdio server (register with Claude Code as `mewgenics-editor`)
npm run pack -- <mod>               # ship it: build SWFs, validate, write data/dist/<mod>-<version>.zip
npm run pack -- --install <zip>     # install a mod zip into mods/<name>/ (checked first, never overwrites)
```

**Shipping a mod.** Give the mod a `mods/<mod>/mod.json` (name, version, author, description, the Steam build id it
was tested on, its native DLLs + framework API version if any, license; `npm run pack -- <mod> --init` drafts it), then
`npm run pack -- <mod>`: it rebuilds the SWFs, refuses while `validate_mod` reports errors (`--force` overrides), and
writes a zip of the mod folder (without `tests/` and the `art/` sources) plus a generated `README-INSTALL.txt` (unzip,
the `-modpaths` launch line, save advice, the native step) and a `MANIFEST.sha256`. The receiving side installs it with
`--install`, MCP `install_mod` or the web UI's *Import mod…*: path traversal, oversize zips, a missing manifest and
tampered files are refused, and a game-build mismatch is asked about first. The repo's own mods each carry a `mod.json` (the `_`-prefixed
test-only mods do not), so `npm run pack -- jokers-luck` works out of the box once `native/dist/` holds its DLL. Details: [`docs/data-mods.md`
"Shipping a mod"](docs/data-mods.md#shipping-a-mod).

Register the MCP server so agents can author and validate mods through it:

```sh
claude mcp add mewgenics-editor -- node "<repo>/editor/src/mcp/server.ts"
```

**Art mode** (web UI, top-bar switch *Data | Art*): author vector art as a JSON scene (`mods/<mod>/art/*.scene.json`,
imported from any SVG), preview it exactly as the engine draws it (16-level grayscale remapped through the real
`textures/palette.png` row, timeline playback with frame labels; raw WebGL, no dependencies), and build it into the
uncompressed SWF v17 subset `glaiel::swf` reads (`mods/<mod>/swfs/<name>.swf` + `swflist.gon.append`), all with a
zero-dependency emitter. Extract the palette first with `python -I tools/gpak.py extract .extracted --prefix
textures/palette.png`. First-run onboarding covers both sides — a Data-mode tour and a dedicated Art-mode tour (with
empty states, an Art section in the concepts drawer, and an illustrative SVG→preview→build worked example), all
re-openable from the Help (`?`) menu. Plan, source model and open items: [`docs/art-preview-plan.md`](docs/art-preview-plan.md);
the SWF append gate (`npm run test:swfgate -- <variant>` from `editor/`) boots the game through the in-game harness
with a generated `_Append_AbilityIcon` donor and reports the verdict (`docs/swf-emitter-fix-spec.md` §0).

## Daily use (game)

- `launch-dev.bat` — launches the game with `-savesuffix dev`, debug console, dev mode, and the sample mod paths.
  Keep Steam launch options empty so plain launches stay vanilla.
- `python -I tools/gpak.py list|cat|extract|stats` — read-only access to `resources.gpak`
  (`extract .extracted --prefix data/` populates the reference copy the editor reads).
- `native/framework/build.bat` — builds `mewframework.dll` (w64devkit GCC) into `native/framework/build/`; copy to
  `native/dist/`. `tools/install-mewjector.bat` installs the chainloader into the game folder.
- `cd editor && npm run test:ingame` — runs each mod's `tests/*.mewtest` in the real game on the `dev` save and
  reports a verdict per script; see [`docs/ingame-testing.md`](docs/ingame-testing.md).

## Reverse engineering (optional — maintenance only)

Day-to-day use — the editor, data-layer mods, and running the sample — needs none of this. But a few tasks require a
reverse-engineering pass with **[REA](https://github.com/morluto/rea)** + Ghidra (driven by `tools/rea-mcp.mjs`,
Dockerized): **re-deriving the `bindings/` byte-signatures when Mewgenics updates** (the native layer fails closed
until they are), and low-level binary analysis such as the SWF loader or new hook points. So **REA is a conditional
requirement for those cases only**, not for normal modding. A full Ghidra import of the ~22 MB exe takes ~17 min, so
raise `REA_GHIDRA_STARTUP_TIMEOUT_MS` (default 330000) well above that when starting a session.

## Rules

Never modify `Mewgenics.exe` or `resources.gpak`. Never touch save files — back up
`%APPDATA%\Glaiel Games\Mewgenics\<steamid>` before any new mod build, and run modded play only through a save suffix.
Never commit extracted assets or game bytes beyond short signatures. Everything native is pinned to Steam build
`25143593` through `bindings/25143593.json`; when the game updates, the framework fails closed until the manifest is
ported (`docs/binding-port.md`, the `port-bindings` skill).
