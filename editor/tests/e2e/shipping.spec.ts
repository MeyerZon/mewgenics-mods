// Shipping a mod from the UI (docs/data-mods.md "Shipping a mod"): the mod menu's Export… and Import mod… items.
// Both flows here end in a refusal, so nothing is written: a mod without mod.json (the "draft one?" confirm is
// dismissed) and a file that is not a zip.
import { test, expect } from "@playwright/test";
import { openApp, seedToursSeen, selectMod } from "./helpers.ts";

test.beforeEach(async ({ page }) => {
  await seedToursSeen(page);
});

test.describe("Shipping — Export… / Import mod…", () => {
  test("Export… on a mod without mod.json asks to draft one; dismissing reports manifest-missing", async ({ page }) => {
    await openApp(page);
    await selectMod(page, "_golden-merge");   // a test-only mod: no mod.json (every non-`_` mod ships one since #119)
    const asked: string[] = [];
    page.on("dialog", (d) => {
      asked.push(d.message());
      void d.dismiss();
    });
    await page.locator(".topbar .dropdown").first().locator("button").first().click();
    await page.getByRole("button", { name: /Export/ }).click();
    await expect(page.getByText(/export refused \(manifest-missing\)/)).toBeVisible();
    expect(asked.join("\n")).toMatch(/no mod\.json/);
  });

  test("Import mod… with a file that is not a zip is refused (not-a-zip)", async ({ page }) => {
    await openApp(page);
    await page.locator(".topbar .dropdown").first().locator("button").first().click();
    await page.locator('.menu input[type="file"]').setInputFiles({ name: "not-a-mod.zip", mimeType: "application/zip", buffer: Buffer.from("just text") });
    await expect(page.getByText(/import refused \(not-a-zip\)/)).toBeVisible();
  });
});
