// Playwright config for the Mewgenics mod-editor web UI end-to-end suite.
// Dev-only (devDependency); never shipped with the tool. Headless Chromium.
//
// The webServer runs the real editor server (node web/server.ts) on a fixed free
// port. 4173/4180/4199 are deliberately avoided (the task warns some may be held by
// stale processes); 4191 is used instead. Each test gets a fresh browser context, so
// `first-run` localStorage (mewged.onboard.*) starts clean per test.

import { defineConfig, devices } from "@playwright/test";

const PORT = 4191;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  // One worker + one shared server keeps the (few) tests that scaffold a throwaway mod
  // deterministic and avoids cross-test write races under mods/.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    headless: true,
    viewport: { width: 1366, height: 820 },
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: undefined, // use Playwright's bundled Chromium, not system Chrome
        launchOptions: {
          // Let WebGL use SwiftShader in headless; the preview also has a Canvas2D
          // fallback, so tests assert behaviour that holds for either backend.
          args: [
            "--use-gl=angle",
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--ignore-gpu-blocklist",
          ],
        },
      },
    },
  ],
  webServer: {
    command: "node web/server.ts",
    url: BASE_URL,
    env: { PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
