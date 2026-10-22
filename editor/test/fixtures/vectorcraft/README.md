# VectorCraft re-export fixtures (captured 2026-10-22 from the vendored v0.14.0 web build)

`*-input.svg` is what `svg-export.ts` writes for a shape (a padded `viewBox` around the art, coordinates as in the
scene). `*-reexport.svg` is what `window.vectorcraft.request("app.export", { format: "svg", svg: { styling:
"presentation", outlineText: true } })` returned after `openFile("body.svg", bytes)` of that input, in headless
Chromium (Playwright, SwiftShader WebGL2) — verbatim, nothing edited.

The transform VectorCraft applies: the input's `viewBox` becomes "Artboard 1" (same width × height at 0,0) and every
coordinate is translated by **(−viewBox.x, −viewBox.y)**; the export's `viewBox` is always the artboard
`0 0 w h`, art outside the artboard keeps its (negative or larger) document coordinates — `offset-reexport.svg`
also holds two `shape.rectangle` commands run after the open, one at (−50, −50) and one at (150, 150), which is
how `documents[0].dirty` flipped to true. So `svg-reorigin.ts` undoes it with `translate(+viewBox.x, +viewBox.y)`.

| input viewBox | input path start | re-export viewBox | re-export path start |
|---|---|---|---|
| `96 196 108 108` | `M100 200` | `0 0 108 108` | `M4 4` |
| `-44 -34 88 68` | `M-40 -30` | `0 0 88 68` | `M4 4` |
