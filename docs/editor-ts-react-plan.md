# Editor: TypeScript + React + Vite + zod (migration plan and record)

Owner request (2026-10-20): switch the editor from JavaScript to TypeScript and, where it makes sense, from the
vendored VanJS UI to React + Vite with zod. This page is the plan, the decisions, and what each PR of the stack
contains. `CLAUDE.md` and `README.md` carry the short version; this is the reference.

## Decisions

| Question | Decision | Why |
|---|---|---|
| TypeScript everywhere? | **Yes.** Every `.mjs`/`.js` the editor owns becomes `.ts`/`.tsx` with real type annotations; the JSDoc-typed style is retired. | The code was already `tsc --strict`-checked through JSDoc; the move is mechanical and the types become first-class (generics, discriminated unions, `satisfies`) instead of comment syntax. |
| A build step for the Node side? | **No.** Node ≥ 22.18 (this machine: 26) strips types natively, so `node src/mcp/server.ts` and `node test/run-tests.ts` run the source as-is. | Keeps the "run it from the checkout" property the MCP server, the scripts and the tools rely on. Constraints that follow: explicit `.ts` import extensions and `erasableSyntaxOnly` (no `enum`, `namespace`, parameter properties). `tsc --noEmit` stays the type gate. |
| Vite? | **Yes, for the browser only.** `vite build` bundles `web/index.html` → `web/dist/` (git-ignored); `web/server.mjs` serves that next to `/api`. `vite dev` is the hot-reload option with `/api` proxied to the node server. | TypeScript in the browser needs a transform step no matter what; given one, Vite is the standard choice and it also lets the UI import the core's pure art modules directly instead of through a server allowlist. |
| React instead of VanJS? | **Yes.** React 19, TSX, no router, no state library: a 40-line `createStore` + `useSyncExternalStore` replaces `van.state` one-for-one. | The UI is an IDE-style app (three panes, drawers, modals, two tours, an art editor with a live preview) where typed components pay off; VanJS types are weak. The 34-test Playwright suite pins the DOM (class names, roles, flows), so the rewrite is verified rather than trusted. |
| zod? | **Yes, at the boundaries only.** One schema per POST route in `src/core/api-schemas.ts`, shared by the server (parse → 400 + issues) and the client (`post(route, body)` is typed from the same schema). MCP tool inputs follow in the second PR. The core keeps its own hand-written validators (GON, scenes, manifests): those are the product, not transport. | The server used to pass `b.mod`, `b.path` through untyped; the MCP tools hand-rolled `str()/bool()` checks. zod gives one declaration that types both ends and documents the wire. |
| "Zero runtime dependencies"? | **Retired as a slogan, kept as a habit.** Runtime deps are exactly `react`, `react-dom`, `zod`; dev deps add `vite`, `@vitejs/plugin-react`, `@types/*`. The vendored `web/vendor/van-*.js` is deleted. | The docs that said "no bundler by design" described a constraint the owner has now lifted. |

## What does not change

- The core's behaviour and the test oracle: GON tokenizer/parser/serializer, overlay merge semantics (faithful to the
  decompiled `Gon_merge_{a,b,c}.c`), validator, art model, SWF emitter, bindings, in-game runner. Renames and type
  annotations only; the 260 unit checks and the 34 e2e checks must stay green through every commit.
- The MCP server remains hand-rolled JSON-RPC over stdio, no SDK. `src/mcp/server.mjs` stays as a two-line shim
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
  src/mcp/server.ts, tools.ts MCP server; server.mjs = compatibility shim
  web/index.html              Vite entry → src/main.tsx
  web/src/main.tsx            createRoot; imports app.css (the former inline stylesheet)
  web/src/store.ts            createStore / useStore
  web/src/api.ts              getJson / postJson / post(route, body) typed from api-schemas
  web/src/state.ts            the app store (S, tpl) + actions (selectMod, openFile, save, …)
  web/src/components/*.tsx    TopBar, Explorer, Center (+ Editor), RightPanel, StatusBar, Toast, modals, drawers, tours
  web/src/art/*.ts(x)         art-state.ts, ArtExplorer, ArtCenter, ArtRightPanel, NewSceneModal, preview-gl.ts
  web/art/preview-dev.html    second Vite page (the standalone preview harness) → preview-dev.ts
  web/server.mjs → server.ts  static dist + /api bridge with the zod gate
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

1. **`feat/editor-vite-react`** (this PR): the web layer. Red test first (`test/web-tests.mjs`: store, highlighter,
   tree, zod schemas, server gate), then the infrastructure (Vite, tsconfig, scripts, server), then the React port of
   `app.mjs` + `art-ui.mjs`, the TS port of `preview-gl.mjs` / `preview-dev.mjs`, the e2e suite as `.ts`, VanJS
   removed, docs updated.
2. **`feat/editor-ts-core`** (stacked on 1): every remaining `.mjs` under `editor/src`, `editor/scripts`,
   `editor/test`, `tools/bindings` → `.ts` with TS types; `@types/node` replaces `types/node-shims.d.ts`;
   `src/core/api-schemas.ts` grows the MCP tool input schemas (`z.toJSONSchema` feeds `tools/list`); the structural
   test "no `.mjs` left except the shim" goes red → green; docs paths updated.

## TDD evidence (filled per PR)

See each PR body for the red → green table with the exact summary lines.

## Follow-ups (not in this stack)

- Response-shape schemas for the `/api` GETs (today the client types them by hand in `web/src/types.ts`).
- `.analysis/userdata-xrefs.mjs` (git-ignored scratch) imports `editor/src/core/bindings/pe.mjs`; it needs its import
  changed to `pe.ts` by whoever next uses it.
