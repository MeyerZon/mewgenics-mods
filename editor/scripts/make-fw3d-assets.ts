// Writes the generated sample assets of mods/fw-3d from editor/src/core/art/fw3d-assets.ts and the PNG fixtures of the
// DLL's own decoder from editor/src/core/art/png-fixtures.ts (Node built-ins only):
//   mods/fw-3d/textures/models/crate.png   the crate's 2-colour checker (grey = a palette index, orange = pass-through)
//   mods/fw-3d/models/pillar.glb           a teal 0.5 x 1.2 x 0.5 box with NORMAL + TEXCOORD_0
//   mods/fw-3d/models/totem.glb            the same box textured by a PNG EMBEDDED in the .glb (purple / lime checker)
//   native/framework/test/fixtures/png/<name>.png (+ <name>.rgba.hex: the expected straight RGBA8 as hex text, 16 pixels
//   per line — text so git's autocrlf cannot touch binary bytes; compared with CR stripped)   PNGs for test_png.c
// Run from editor/: `node scripts/make-fw3d-assets.ts` (or `--check`: exit 1 when a committed file differs).
// editor/test/mesh-tex-tests.ts and editor/test/glb-texture-tests.ts run the same comparison in `npm test`, so the
// generators stay the source.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crateTexturePng, pillarGlb, totemGlb } from "../src/core/art/fw3d-assets.ts";
import { pngFixtures, rgbaHex } from "../src/core/art/png-fixtures.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FW3D_DIR = join(REPO, "mods", "fw-3d");
export const PNG_FIXTURE_DIR = "native/framework/test/fixtures/png";
/** every generated file, repo-relative */
export function generatedAssets(): { rel: string; make: () => Uint8Array }[] {
  const out: { rel: string; make: () => Uint8Array }[] = [
    { rel: "mods/fw-3d/textures/models/crate.png", make: crateTexturePng },
    { rel: "mods/fw-3d/models/pillar.glb", make: pillarGlb },
    { rel: "mods/fw-3d/models/totem.glb", make: totemGlb },
  ];
  for (const f of pngFixtures()) {
    out.push({ rel: `${PNG_FIXTURE_DIR}/${f.name}.png`, make: () => f.png });
    if (f.rgba) { const hex = new TextEncoder().encode(rgbaHex(f.rgba)); out.push({ rel: `${PNG_FIXTURE_DIR}/${f.name}.rgba.hex`, make: () => hex }); }
  }
  return out;
}

/** committed == generated: byte for byte, except a .hex text file, compared with CRs stripped (autocrlf checkouts) */
export function sameAsset(rel: string, onDisk: Uint8Array, generated: Uint8Array): boolean {
  if (rel.endsWith(".hex")) return Buffer.from(onDisk).toString("latin1").replace(/\r/g, "") === Buffer.from(generated).toString("latin1");
  return Buffer.compare(Buffer.from(onDisk), Buffer.from(generated)) === 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes("--check");
  let bad = 0;
  for (const a of generatedAssets()) {
    const path = join(REPO, a.rel);
    const bytes = a.make();
    if (check) {
      const same = existsSync(path) && sameAsset(a.rel, readFileSync(path), bytes);
      console.log(`${same ? "ok  " : "DIFF"} ${a.rel} (${bytes.length} B)`);
      if (!same) bad++;
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
      console.log(`wrote ${a.rel} (${bytes.length} B)`);
    }
  }
  process.exit(bad ? 1 : 0);
}
