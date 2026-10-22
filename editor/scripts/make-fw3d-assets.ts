// Writes the generated sample assets of mods/fw-3d from editor/src/core/art/fw3d-assets.ts (Node built-ins only):
//   mods/fw-3d/textures/models/crate.png   the crate's 2-colour checker (grey = a palette index, orange = pass-through)
//   mods/fw-3d/models/pillar.glb           a teal 0.5 x 1.2 x 0.5 box with NORMAL + TEXCOORD_0
// Run from editor/: `node scripts/make-fw3d-assets.ts` (or `--check`: exit 1 when a committed file differs).
// editor/test/fw3d-assets-tests.ts runs the same comparison in `npm test`, so the generator stays the source.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crateTexturePng, pillarGlb } from "../src/core/art/fw3d-assets.ts";

export const FW3D_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "mods", "fw-3d");
export const FW3D_ASSETS: { rel: string; make: () => Uint8Array }[] = [
  { rel: "textures/models/crate.png", make: crateTexturePng },
  { rel: "models/pillar.glb", make: pillarGlb },
];

const check = process.argv.includes("--check");
let bad = 0;
for (const a of FW3D_ASSETS) {
  const path = join(FW3D_DIR, a.rel);
  const bytes = a.make();
  if (check) {
    const same = existsSync(path) && Buffer.compare(readFileSync(path), Buffer.from(bytes)) === 0;
    console.log(`${same ? "ok  " : "DIFF"} mods/fw-3d/${a.rel} (${bytes.length} B)`);
    if (!same) bad++;
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    console.log(`wrote mods/fw-3d/${a.rel} (${bytes.length} B)`);
  }
}
process.exit(bad ? 1 : 0);
