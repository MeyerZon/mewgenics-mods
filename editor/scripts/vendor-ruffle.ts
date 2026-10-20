// Copy Ruffle's runtime files (the loader *.js, the core *.js chunks, the *.wasm and the licenses) from
// node_modules/@ruffle-rs/ruffle into the git-ignored web/public/ruffle/, which Vite copies into dist/ and the
// dev server serves as-is. Ruffle finds its .wasm next to its own script, so it is never bundled. Source maps,
// the README and package.json stay behind. Run by `npm run build` / `npm run dev` before Vite.
//   node scripts/vendor-ruffle.ts

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME = /^(.*\.js|.*\.wasm|LICENSE.*)$/;

/** Replace `dst` with the runtime files of the Ruffle package at `src`; returns the copied names. */
export function vendorRuffle(src: string, dst: string): { copied: string[] } {
  if (!existsSync(src)) throw new Error(`Ruffle package not found at ${src} (run npm install in editor/)`);
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  const copied: string[] = [];
  for (const f of readdirSync(src, { withFileTypes: true })) {
    if (!f.isFile() || !RUNTIME.test(f.name) || f.name.endsWith(".map")) continue;
    copyFileSync(join(src, f.name), join(dst, f.name));
    copied.push(f.name);
  }
  return { copied };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const editor = join(dirname(fileURLToPath(import.meta.url)), "..");
  const r = vendorRuffle(join(editor, "node_modules", "@ruffle-rs", "ruffle"), join(editor, "web", "public", "ruffle"));
  console.log(`vendored Ruffle: ${r.copied.length} file(s) into web/public/ruffle/`);
}
