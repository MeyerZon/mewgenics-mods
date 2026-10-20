// Vite config for the editor web UI (docs/editor-ts-react-plan.md).
//
// `vite build` bundles web/index.html (+ the art preview dev page) into web/dist/, which
// web/server.ts serves next to its /api bridge — that is what `npm run web` and the e2e
// suite use. `vite dev` is the hot-reloading alternative for UI work: it proxies /api to the
// node server, so run `npm run web` in a second terminal.

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const EDITOR = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(EDITOR, "web");

export default defineConfig({
  root: WEB,
  base: "./",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": `http://127.0.0.1:${process.env.API_PORT || 4173}` },
    // the UI imports pure core modules from ../src/core (same code the emitter/validator run)
    fs: { allow: [EDITOR] },
  },
  build: {
    outDir: resolve(WEB, "dist"),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        index: resolve(WEB, "index.html"),
        "preview-dev": resolve(WEB, "art", "preview-dev.html"),
      },
    },
  },
});
