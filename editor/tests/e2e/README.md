# End-to-end tests (Playwright)

A real-browser end-to-end suite for the editor web UI. It drives the actual
`node web/server.mjs` serving the Vite build (`web/dist/`, built from the React
UI in `web/src/*.tsx`) in headless Chromium and asserts the Data mode, Art mode,
preview, and onboarding flows behave correctly.

**Dev-only.** Playwright is a `devDependency`; it never ships with the tool and
adds zero runtime dependencies. The UI itself still loads no external resources.

## Running

```sh
npm ci                         # installs @playwright/test (dev-only)
npx playwright install chromium   # one-time: downloads Chromium ONLY
npm run test:e2e               # = vite build && playwright test (headless Chromium)
```

`npm run test:e2e` first builds the UI (`vite build` → `web/dist/`), then
launches the editor server itself (via the config's `webServer`) on port
**4191** and tears it down afterward, so you don't need a server running first.
Running `npx playwright test` directly skips the build, so make sure `web/dist/`
is current. Only Chromium is required — the config pins a single
`chromium` project and the browser must be installed with the command above.

Useful variants:

```sh
npx playwright test data-mode           # one spec file
npx playwright test --headed            # watch it in a visible browser
npx playwright test --ui                # the Playwright UI runner
npx playwright show-report              # open the last HTML report
```

## What it covers (`tests/e2e/*.spec.ts`)

- **smoke** — app loads with no console errors in Data and Art mode; the Art
  preview renders a `<canvas>` and plays.
- **data-mode** — base-data explorer (the 300-of-M cap note + DOM cap, debounced
  filter, no category-list rebuild), opening a mod + GON overlay, the
  syntax-highlight overlay staying aligned with the gutter on fast typing +
  vertical/horizontal scroll (windowed, never rebuilt), live validation, merge
  preview, and the template scaffolder (empty-name guard + write-confinement to
  `mods/<name>/`).
- **art-mode** — scenes/shapes/exports explorer, SVG import via the file input,
  the preview (canvas + transport + scrubber, frame counter advancing, suspend on
  tab/mode switch + resume, the truthful play/pause label incl. auto-stop on the
  last frame with loop OFF, resize re-fit, palette row + "show raw grayscale"),
  and the Build tab (no-DoABC/stub radios, dry run, build + inspect).
- **onboarding** — the first-run data tour, the Art tour (auto-open on first Art
  entry, persistence of seen / "don't show again" across reload, re-open from the
  Help menu), the concepts drawer (Art section + 16-swatch ramp, mode-aware
  ordering), and the worked-example jump buttons.

## Notes

- Each test runs in a fresh browser context, so first-run `localStorage`
  (`mewged.onboard.*`) starts clean per test.
- Headless WebGL falls back to SwiftShader (the config enables it); tests assert
  behaviour that holds for either the WebGL or the Canvas2D backend.
- A couple of tests scaffold/build into a throwaway or scratch mod under `mods/`
  and clean up after themselves (`test.afterAll`). They never touch game files or
  saves. Playwright's own output (`test-results/`, `playwright-report/`) is
  git-ignored.
