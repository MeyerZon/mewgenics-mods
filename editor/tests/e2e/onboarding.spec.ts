import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, seedLocalStorage, seedToursSeen, selectMod, LS, collectConsole } from "./helpers.ts";

/** Open the Help (?) menu. */
async function openHelp(page: Page) {
  await page.locator('.topbar .dropdown button[aria-label="Help and onboarding"]').click();
}

async function lsValue(page: Page, key: string) {
  return page.evaluate((k: string) => window.localStorage.getItem(k), key);
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
    await expect(card).toContainText("STEP 1 OF 7");
    await expect(card.locator(".sec", { hasText: "Art mode tour" })).toBeVisible();

    // Next through to the last step, where the button becomes "Done"
    for (let i = 2; i <= 7; i++) {
      await card.getByRole("button", { name: /Next/ }).click();
      await expect(card).toContainText(`STEP ${i} OF 7`);
    }
    await card.getByRole("button", { name: /Back/ }).click();
    await expect(card).toContainText("STEP 6 OF 7");
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
    // the example opens on step 1 (UX PR 6); the scaffolder jump lives on the ability step
    await example.locator("button.exstep", { hasText: "Add the ability overlay" }).click();
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

// ---- UX PR 6: anchored coachmarks, the Rooms tour, a meaningful "Don't show again", the examples' step lists ----

type Box = { x: number; y: number; width: number; height: number };
const contains = (outer: Box, inner: Box) =>
  outer.x <= inner.x + 0.5 && outer.y <= inner.y + 0.5 && outer.x + outer.width >= inner.x + inner.width - 0.5 && outer.y + outer.height >= inner.y + inner.height - 0.5;
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test.describe("Onboarding — anchored coachmarks (UX PR 6)", () => {
  test("the Data tour's step 1 spotlights the Base data section and the card sits beside it, not on it", async ({ page }) => {
    await openApp(page);
    const card = page.locator(".tourcard");
    await expect(card).toContainText("STEP 1 OF 5");
    const spot = page.locator(".tour-spot");
    await expect(spot).toBeVisible();
    await expect.poll(async () => {
      const t = await page.locator('[data-tour="explorer-base"]').boundingBox();
      const s = await spot.boundingBox();
      return !!t && !!s && contains(s, t);
    }).toBe(true);
    const s = (await spot.boundingBox())!;
    const c = (await card.boundingBox())!;
    expect(overlaps(s, c), JSON.stringify({ s, c })).toBe(false);
    // the next step moves the spotlight onto its own target
    await card.getByRole("button", { name: /Next/ }).click();
    await expect(card).toContainText("STEP 2 OF 5");
    await expect.poll(async () => {
      const t = await page.locator('[data-tour="new-overlay"]').first().boundingBox();
      const sp = await spot.boundingBox();
      return !!t && !!sp && contains(sp, t);
    }).toBe(true);
  });

  test("?tour=center renders today's centred card with no spotlight", async ({ page }) => {
    await openApp(page, "?tour=center");
    await expect(page.locator(".tourcard")).toContainText("STEP 1 OF 5");
    await expect(page.locator(".tour-spot")).toHaveCount(0);
    const c = (await page.locator(".tourcard").boundingBox())!;
    const vw = page.viewportSize()!.width;
    expect(Math.abs(c.x + c.width / 2 - vw / 2)).toBeLessThan(4);
  });

  test("Esc closes a tour and marks it seen", async ({ page }) => {
    await openApp(page);
    await expect(page.locator(".tourcard")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".tourcard")).toBeHidden();
    expect(await lsValue(page, LS.tourSeen)).toBe("1");
  });

  test("'Don't show again' also hides the hero's 'Take the guided tour' card, and it stays hidden after reload", async ({ page }) => {
    // no mods → the Data hero (the empty state with the nudge cards)
    await page.route("**/api/mods", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ mods: [] }) }));
    await openApp(page);
    const hero = page.locator(".emptystate.hero");
    await expect(hero).toContainText("Take the guided tour");
    const card = page.locator(".tourcard");
    await card.getByRole("checkbox").check();
    await expect(hero).not.toContainText("Take the guided tour");
    await card.getByRole("button", { name: /^Skip$/ }).click();
    await page.reload({ waitUntil: "networkidle" });
    await expect(hero).toContainText("Rebuild Joker's Luck");
    await expect(hero).not.toContainText("Take the guided tour");
  });

  test("the Art tour has 7 steps and the last one is Timeline, Rig, VectorCraft", async ({ page }) => {
    await seedToursSeen(page);
    await openApp(page);
    await openHelp(page);
    await page.getByRole("button", { name: /Art mode tour/ }).click();
    const card = page.locator(".tourcard");
    await expect(card).toContainText("STEP 1 OF 7");
    for (let i = 2; i <= 7; i++) await card.getByRole("button", { name: /Next/ }).click();
    await expect(card).toContainText("STEP 7 OF 7");
    await expect(card.locator("h2")).toContainText("VectorCraft");
    // step 2 entered Art mode on the way
    await expect(page.locator('.topbar .modeswitch button[aria-pressed="true"]')).toHaveText(/Art/);
  });
});

test.describe("Onboarding — Rooms tour (UX PR 6)", () => {
  test.beforeEach(async ({ page }) => {
    await seedLocalStorage(page, { [LS.tourSeen]: "1", [LS.tourDontShow]: "1", [LS.artTourSeen]: "1", [LS.artTourDontShow]: "1" });
  });

  test("auto-opens on the first Rooms entry, reads STEP 1 OF 5 'Rooms mode tour', and does not reopen after reload", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: "Rooms", exact: true }).click();
    const card = page.locator(".tourcard");
    await expect(card).toContainText("STEP 1 OF 5");
    await expect(card.locator(".sec", { hasText: "Rooms mode tour" })).toBeVisible();
    await card.getByRole("button", { name: /^Skip$/ }).click();
    expect(await lsValue(page, LS.roomTourSeen)).toBe("1");
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Rooms", exact: true }).click();
    await expect(page.locator(".tourcard")).toBeHidden();
  });

  test("?mode=rooms suppresses it; Help → Rooms mode tour opens it", async ({ page }) => {
    await openApp(page, "?mode=rooms");
    await expect(page.locator(".explorer .exhead .sec", { hasText: "Rooms" })).toBeVisible();
    await expect(page.locator(".tourcard")).toHaveCount(0);
    await openHelp(page);
    await page.getByRole("button", { name: /Rooms mode tour/ }).click();
    const card = page.locator(".tourcard");
    await expect(card).toContainText("STEP 1 OF 5");
    await expect(card).toContainText("Rooms mode tour");
  });

  test("the Concepts drawer in ?mode=rooms lists the Rooms section first", async ({ page }) => {
    await openApp(page, "?mode=rooms");
    await openHelp(page);
    await page.getByRole("button", { name: /Concepts explainer/ }).click();
    const drawer = page.locator(".drawer");
    await expect(drawer.locator(".dbody > div").first()).toContainText("Rooms mode");
    await expect(drawer).toContainText("Data mode — GON/CSV overlays");
    await expect(drawer).toContainText("Art mode — vector scenes the engine recolors");
  });
});

test("Help → Rooms concepts opens the Concepts drawer scrolled to the Rooms section", async ({ page }) => {
  await seedToursSeen(page);
  await openApp(page);
  await openHelp(page);
  await page.getByRole("button", { name: /Rooms concepts/ }).click();
  const drawer = page.locator(".drawer");
  await expect(drawer.locator(".dbody > div").first()).toContainText("Data mode — GON/CSV overlays");
  await expect(drawer.locator('[data-section="rooms"]')).toBeInViewport();
});

test.describe("Onboarding — the Data worked example's step list (UX PR 6)", () => {
  test.beforeEach(async ({ page }) => {
    await seedToursSeen(page);
  });

  test("opens on 'Create the mod folder' (step 1 of 5); step 3 shows the combined.csv.append row", async ({ page }) => {
    await openApp(page);
    await openHelp(page);
    await page.getByRole("button", { name: /Worked example — Joker's Luck/ }).click();
    const example = page.locator(".example");
    await expect(example.locator(".stepcontent h1")).toHaveText("Create the mod folder");
    await expect(example).toContainText("Step 1 / 5");
    await example.locator("button.exstep", { hasText: "Add localization rows" }).click();
    await expect(example.locator(".stepcontent h1")).toHaveText("Add localization rows");
    await expect(example.locator(".stepcontent")).toContainText("combined.csv.append");
    await expect(example.locator(".stepcontent")).toContainText("ABILITY_JOKERSGAMBIT_NAME");
  });
});
