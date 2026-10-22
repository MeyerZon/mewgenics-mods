// Accessibility + keyboard foundations (docs/editor-ts-react-plan.md "UI primitives and conventions"): dialogs are
// real modal dialogs (role, focus trap, Esc, focus restore), menus expose aria-expanded and close on Esc, toasts
// queue in a polite live region, and Ctrl+S never reaches the browser's own save dialog.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, seedToursSeen } from "./helpers.ts";

function modSwitcher(page: Page) {
  return page.locator(".topbar .dropdown").first().locator("button").first();
}

async function openNewModScaffolder(page: Page) {
  await modSwitcher(page).click();
  await page.getByRole("button", { name: /New mod/ }).click();
}

test.beforeEach(async ({ page }) => {
  await seedToursSeen(page);
});

test.describe("a11y — dialogs, menus, toasts, shortcuts", () => {
  test("the template modal is an aria-modal dialog; Esc closes it and focus returns to the mod switcher that opened it", async ({ page }) => {
    await openApp(page);
    await openNewModScaffolder(page);
    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog).toHaveCount(1);
    await expect(dialog).toContainText("Scaffold an overlay");
    // focus moved into the dialog
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.locator(".modal")).toHaveCount(0);
    await expect(modSwitcher(page)).toBeFocused();
  });

  test("Tab from the last focusable in the modal wraps to the first (and Shift+Tab back)", async ({ page }) => {
    await openApp(page);
    await openNewModScaffolder(page);
    const modal = page.locator(".modal");
    await expect(modal).toBeVisible();
    await modal.getByRole("button", { name: "Scaffold" }).focus();
    await page.keyboard.press("Tab");
    await expect(modal.locator(".mhead .iconbtn")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(modal.getByRole("button", { name: "Scaffold" })).toBeFocused();
  });

  test("the Help menu exposes aria-expanded and closes on Esc", async ({ page }) => {
    await openApp(page);
    const help = page.locator('.topbar .dropdown button[aria-label="Help and onboarding"]');
    await expect(help).toHaveAttribute("aria-expanded", "false");
    await expect(help).toHaveAttribute("aria-haspopup", "menu");
    await help.click();
    await expect(help).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".menu")).toBeVisible();
    await page.keyboard.press("ArrowDown");
    expect(await page.evaluate(() => document.activeElement?.classList.contains("item") ?? false)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.locator(".menu")).toHaveCount(0);
    await expect(help).toHaveAttribute("aria-expanded", "false");
  });

  test("toasts live in a role=status region and two fired close together both show", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openApp(page);
    await page.locator(".topbar button", { hasText: "Launch…" }).click();
    await page.locator(".launchpop").getByRole("button", { name: "Copy" }).click();
    await modSwitcher(page).click();
    await page.locator('.menu input[type="file"]').setInputFiles({ name: "not-a-mod.zip", mimeType: "application/zip", buffer: Buffer.from("just text") });
    const region = page.locator('[role="status"][aria-live="polite"]');
    await expect(region).toHaveCount(1);
    await expect(region).toContainText("import refused (not-a-zip)");
    await expect(region).toContainText(/copied/i);
  });

  test("Ctrl+S never opens the browser's save dialog: the keydown is default-prevented and the page stays responsive", async ({ page }) => {
    await openApp(page);
    await page.keyboard.press("Control+s");
    await expect(page.locator(".shell")).toBeVisible();
    const notCancelled = await page.evaluate(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true })),
    );
    expect(notCancelled, "dispatchEvent returns false when the listener called preventDefault()").toBe(false);
    const plain = await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true, cancelable: true })));
    expect(plain, "a bare 's' is left alone").toBe(true);
  });
});
