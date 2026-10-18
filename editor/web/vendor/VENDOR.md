# Vendored third-party code

This directory holds third-party browser code committed into the repo intentionally
(no `npm install` at runtime). Each entry records the exact upstream source, version,
and a SHA-256 so the bytes can be re-verified.

## van-1.6.1.min.js

- **Library:** VanJS (`vanjs-core`), a ~reactive DOM UI framework, zero sub-dependencies, no build step.
- **Version:** `1.6.1` (version-exact, pinned).
- **Source URL:** `https://cdn.jsdelivr.net/npm/vanjs-core@1.6.1/src/van.min.js`
  - Mirror (same bytes): `https://unpkg.com/vanjs-core@1.6.1/src/van.min.js`
- **Local file name:** `van-1.6.1.min.js` (renamed from upstream `van.min.js` so the on-disk
  name carries the exact version).
- **SHA-256:** `299abf3dd7f28f2105ba62329163523cd629746e5ae86524c5eabe0b79f2e03a`
- **Size:** 3579 bytes.
- **License:** MIT (Tao Xin / vanjs-org).
- **Form:** Minified ESM (Terser v5.48.0), NOT obfuscated. The whole file was read before use;
  it is the canonical VanJS source and ends in
  `export default {tags:new Proxy(...),hydrate:...,add:add,state:state,derive:derive};`.
- **Usage:** loaded locally via `<script type="module">`; served from this folder by the
  editor's local web server. No CDN fetch at runtime.

### Deviation note

The build brief named `https://unpkg.com/vanjs-core@1.6.1/dist/van-1.6.1.min.js`. In the
`vanjs-core@1.6.1` package there is no `dist/` directory; the published minified ESM is
`src/van.min.js` (confirmed via the jsDelivr package file listing API). The real
version-exact file was downloaded from `src/van.min.js` and saved under the requested
local name `van-1.6.1.min.js`. The brief also estimated ~1 KB; VanJS has grown and the
1.6.1 minified build is ~3.5 KB. Bytes verified by the SHA-256 above.

### Re-verify

```sh
curl -fsSL https://cdn.jsdelivr.net/npm/vanjs-core@1.6.1/src/van.min.js | sha256sum
# -> 299abf3dd7f28f2105ba62329163523cd629746e5ae86524c5eabe0b79f2e03a
```
