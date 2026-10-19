import { test, expect } from "@playwright/test";
import { openApp, seedLocalStorage, seedToursSeen, selectMod, LS, collectConsole } from "./helpers.js";

/** Open the Help (?) menu. */
async function openHelp(page) {
  await page.locator('.topbar .dropdown button[aria-label="Help and onboarding"]').click();
}

async function lsValue(page, key) {
  return page.evaluate((k) => window.localStorage.getItem(k), key);
}

test.describe("Onboarding — data-mode first-run tour", () => {
  test("auto-opens on first run, Next/Back navigate, and Skip persists 'seen'", async ({ page }) => {
    await openApp(page); // clean storage → first-run tour
    const card = page.locator(".tourcard");
    await expect(card).toBeVisible();
    await expect(card).toContainText("STEP 1 OF 5");
    await expect(card.locator(".sec", { hasText: "Guided tour" })).toBeVisible();

    await card.getByRole("button", { name: /Next/ }).click();
    await expect(card).toContainText("STEP 2 OF 5");
    await card.getByRole("button", { name: /Back/ }).click();
    await expect(card).toContainText("STEP 1 OF 5");

    await card.getByRole("button", { name: /^Skip$/ }).click();
    await expect(card).toBeHidden();
    expect(await lsValue(page, LS.tourSeen)).toBe("1");

    // reload → does not auto-open again
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.locator(".tourcard")).toBeHidden();
  });

  test("'Don't show again' is persisted to localStorage", async ({ page }) => {
    await openApp(page);
    const card = page.locator(".tourcard");
    await expect(card).toBeVisible();
    await card.getByRole("checkbox").check();
    await card.getByRole("button", { name: /^Skip$/ }).click();
    expect(await lsValue(page, LS.tourDontShow)).toBe("1");
  });
});

test.describe("Onboarding — art-mode tour (persistence)", () => {
  test.beforeEach(async ({ page }) => {
    // suppress only the DATA tour so the ART tour shows its first-run behaviour
    await seedLocalStorage(page, { [LS.tourSeen]: "1", [LS.tourDontShow]: "1" });
  });

  test("auto-opens on first Art entry; Next/Back/Done work and persist 'seen'", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: "Art", exact: true }).click();
    const card = page.locator(".tourcard");
    await expect(card).toBeVisible();
    await expect(card).toContainText("STEP 1 OF 6");
    await expect(card.locator(".sec", { hasText: "Art mode tour" })).toBeVisible();

    // Next through to the last step, where the button becomes "Done"
    for (let i = 2; i <= 6; i++) {
      await card.getByRole("button", { name: /Next/ }).click();
      await expect(card).toContainText(`STEP ${i} OF 6`);
    }
    await card.getByRole("button", { name: /Back/ }).click();
    await expect(card).toContainText("STEP 5 OF 6");
    await card.getByRole("button", { name: /Next/ }).click();
    await card.getByRole("button", { name: /^Done$/ }).click();
    await expect(card).toBeHidden();
    expect(await lsValue(page, LS.artTourSeen)).toBe("1");

    // reload + re-enter Art → does NOT auto-open (persisted "seen")
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Art", exact: true }).click();
    await expect(page.locator(".tourcard")).toBeHidden();
  });

  test("'Don't show again' survives reload", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: "Art", exact: true }).click();
    const card = page.locator(".tourcard");
    await expect(card).toBeVisible();
    await card.getByRole("checkbox").check();
    await card.getByRole("button", { name: /^Skip$/ }).click();
    expect(await lsValue(page, LS.artTourDontShow)).toBe("1");

    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Art", exact: true }).click();
    await expect(page.locator(".tourcard")).toBeHidden();
  });

  test("re-opens from the Help (?) menu after being dismissed", async ({ page }) => {
    await seedLocalStorage(page, { [LS.artTourSeen]: "1", [LS.artTourDontShow]: "1" });
    await openApp(page);
    await page.getByRole("button", { name: "Art", exact: true }).click();
    await expect(page.locator(".tourcard")).toBeHidden(); // dismissed earlier
    await openHelp(page);
    await page.getByRole("button", { name: /Art mode tour/ }).click();
    await expect(page.locator(".tourcard")).toBeVisible();
    await expect(page.locator(".tourcard")).toContainText("Art mode tour");
  });
});

test.describe("Onboarding — concepts drawer (ramp + mode-aware ordering)", () => {
  test.beforeEach(async ({ page }) => {
    await seedToursSeen(page);
  });

  test("Data mode: Data section first, Art section present with a 16-swatch ramp", async ({ page }) => {
    await openApp(page);
    await openHelp(page);
    await page.getByRole("button", { name: /Concepts explainer/ }).click();
    const drawer = page.locator(".drawer");
    await expect(drawer).toBeVisible();
    // ordering: first section is the Data section
    await expect(drawer.locator(".dbody > div").first()).toContainText("Data mode — GON/CSV overlays");
    // Art section present
    await expect(drawer).toContainText("Art mode — vector scenes the engine recolors");
    // the Art section's 16-swatch palette ramp
    await expect(drawer.locator(".ramp.big").first().locator("span")).toHaveCount(16);
  });

  test("Art mode: Art section is shown first (mode-aware ordering)", async ({ page }) => {
    await openApp(page, "?mode=art");
    await openHelp(page);
    await page.getByRole("button", { name: /Concepts explainer/ }).click();
    const drawer = page.locator(".drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(".dbody > div").first()).toContainText("Art mode — vector scenes the engine recolors");
    await expect(drawer.locator(".ramp.big").first().locator("span")).toHaveCount(16);
  });

  // The drawer never auto-opens, so a "Don't show on start" switch has nothing to switch off. The button and the
  // mewged.onboard.conceptsDontShowStart key it wrote are gone (owner decision 2026-10-19); "Got it" is the only
  // dismiss control in the footer.
  test("footer has no dead 'Don't show on start' button and writes no conceptsDontShowStart key", async ({ page }) => {
    await openApp(page);
    await openHelp(page);
    await page.getByRole("button", { name: /Concepts explainer/ }).click();
    const drawer = page.locator(".drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("button", { name: /Don't show on start/ })).toHaveCount(0);
    await expect(drawer.locator(".dfoot button")).toHaveCount(1);
    await drawer.getByRole("button", { name: /^Got it$/ }).click();
    await expect(drawer).toBeHidden();
    expect(await lsValue(page, "mewged.onboard.conceptsDontShowStart")).toBeNull();
  });
});

test.describe("Onboarding — worked examples (jump buttons land in the right place)", () => {
  test.beforeEach(async ({ page }) => {
    await seedToursSeen(page);
  });

  test("data worked example: 'Insert this overlay' jumps into the scaffolder", async ({ page }) => {
    await openApp(page);
    await openHelp(page);
    await page.getByRole("button", { name: /Worked example — Joker's Luck/ }).click();
    const example = page.locator(".example");
    await expect(example).toBeVisible();
    await expect(example).toContainText("Add the ability overlay");
    await example.getByRole("button", { name: /Insert this overlay \(open scaffolder\)/ }).click();
    await expect(example).toBeHidden();
    await expect(page.locator(".modal", { hasText: "Scaffold an overlay" })).toBeVisible();
  });

  test("art worked example: jump buttons land in the matching right-panel / center tab", async ({ page }) => {
    await openApp(page, "?mode=art");
    await selectMod(page, "dev-sandbox");
    await page.locator(".explorer .srow", { hasText: "my_rat" }).first().click();
    await expect(page.locator(".pvcanvasbox canvas")).toBeVisible();

    // move the right panel off "Preview" first so the jump is observable
    await page.locator(".rightpanel .tab", { hasText: "Findings" }).click();
    await expect(page.locator(".rightpanel .tab.active")).toHaveText("Findings");

    // open the art worked example, go to the Preview step, jump
    await openHelp(page);
    await page.getByRole("button", { name: /Art worked example/ }).click();
    const example = page.locator(".example");
    await expect(example).toBeVisible();
    await example.locator("button.exstep", { hasText: "Preview it faithfully" }).click();
    await example.getByRole("button", { name: /Open the Preview/ }).click();
    await expect(example).toBeHidden();
    await expect(page.locator(".rightpanel .tab.active")).toHaveText("Preview");

    // Build step → Build tab
    await openHelp(page);
    await page.getByRole("button", { name: /Art worked example/ }).click();
    await example.locator("button.exstep", { hasText: "Build the SWF" }).click();
    await example.getByRole("button", { name: /Open the Build tab/ }).click();
    await expect(example).toBeHidden();
    await expect(page.locator(".rightpanel .tab.active")).toHaveText("Build");

    // Import step → center "Shapes" subtab
    await openHelp(page);
    await page.getByRole("button", { name: /Art worked example/ }).click();
    await example.locator("button.exstep", { hasText: "Import an SVG" }).click();
    await example.getByRole("button", { name: /Go to the Shapes panel/ }).click();
    await expect(example).toBeHidden();
    await expect(page.locator(".subtabs .btn.on")).toHaveText("Shapes");
  });
});
