import { test, expect } from "@playwright/test";
import { openApp, seedToursSeen, selectMod, collectConsole } from "./helpers.ts";

test.describe("smoke", () => {
  test("app loads with no console errors (data mode)", async ({ page }) => {
    const errors = collectConsole(page);
    await seedToursSeen(page);
    await openApp(page);
    await expect(page.locator(".topbar .title")).toHaveText("Mewgenics Mod Editor");
    // base categories loaded
    await expect(page.locator(".explorer .srow", { hasText: "abilities" }).first()).toBeVisible();
    await page.waitForTimeout(500);
    expect(errors, JSON.stringify(errors, null, 2)).toHaveLength(0);
  });

  test("entering art mode loads with no console errors", async ({ page }) => {
    const errors = collectConsole(page);
    await seedToursSeen(page);
    await openApp(page);
    await selectMod(page, "dev-sandbox");
    await page.getByRole("button", { name: "Art", exact: true }).click();
    await expect(page.locator(".explorer .sec", { hasText: "Art scenes" })).toBeVisible();
    await page.waitForTimeout(500);
    expect(errors, JSON.stringify(errors, null, 2)).toHaveLength(0);
  });

  test("art preview renders a canvas and plays", async ({ page }) => {
    const errors = collectConsole(page);
    await seedToursSeen(page);
    await openApp(page, "?mode=art");
    await selectMod(page, "dev-sandbox");
    await page.locator(".explorer .srow", { hasText: "my_rat" }).first().click();
    // right panel preview tab is default in art mode
    const canvas = page.locator(".pvcanvasbox canvas");
    await expect(canvas).toBeVisible();
    await page.getByRole("button", { name: /^(Play|Pause)$/ }).click();
    // frame counter advances
    await expect
      .poll(async () => (await page.locator(".transport .frame").innerText()).trim(), { timeout: 5000 })
      .not.toBe("1 / 24");
    await page.waitForTimeout(300);
    const glErrors = errors.filter((e) => !/WebGL|SwiftShader|GL_|ANGLE/i.test(e.text));
    expect(glErrors, JSON.stringify(errors, null, 2)).toHaveLength(0);
  });
});
