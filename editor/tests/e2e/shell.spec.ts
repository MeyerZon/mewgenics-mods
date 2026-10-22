// The editor shell (docs/editor-ts-react-plan.md "UI primitives and conventions", UX PR 2): one command bar whose
// Validate / Save act on the current mode (Data overlay, Art scene, Rooms room) and Ctrl+S; a mode-aware status pill;
// the unsaved-work guard (mod switch, file / scene / room switches, reload); the Launch… popover; GET /api/status in
// the status bar; deep links (?mode=&mod=&file=); and the two data-loss regressions (saving a GON file closed the
// open scene and room; Build SWF closed the scene). A throwaway mod `e2e-shell` is created under mods/ and removed.

import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rmSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { openApp, seedToursSeen, selectMod } from "./helpers.ts";
import { encodeLvl, buildRoom } from "../../src/core/level/lvl.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const MOD = "e2e-shell";
const MOD_DIR = join(REPO_ROOT, "mods", MOD);
const SANDBOX = join(REPO_ROOT, "mods", "dev-sandbox");
const GON_REL = "data/abilities/fighter_abilities.gon.append";
const GON_LEAF = "fighter_abilities.gon.append";

const saveBtn = (page: Page) => page.locator(".topbar .topbar-save");
const toasts = (page: Page) => page.locator('[role="status"][aria-live="polite"]');
const switcher = (page: Page) => page.locator(".topbar .dropdown").first().locator("button").first();
const frameRate = (page: Page) => page.getByLabel("frameRate", { exact: true });
const modeBtn = (page: Page, name: "Data" | "Art" | "Rooms") => page.locator('.topbar .modeswitch[aria-label="Editor mode"] button', { hasText: name });

async function openGon(page: Page): Promise<void> {
  await openApp(page);
  await selectMod(page, MOD);
  await page.locator(".explorer .srow", { hasText: GON_LEAF }).click();
  await expect(page.locator("textarea.code")).toBeVisible();
  await expect(page.locator(".edtabbar .filetab")).toContainText(GON_LEAF);
}

async function typeAtEnd(page: Page, text: string): Promise<void> {
  await page.locator("textarea.code").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(text);
}

async function openScene(page: Page): Promise<void> {
  await openApp(page, "?mode=art");
  await selectMod(page, MOD);
  await page.locator(".explorer .srow", { hasText: "my_rat" }).first().click();
  await expect(page.locator(".artpanel h2")).toHaveText("my_rat");
}

test.beforeAll(() => {
  rmSync(MOD_DIR, { recursive: true, force: true });
  mkdirSync(join(MOD_DIR, "data", "abilities"), { recursive: true });
  mkdirSync(join(MOD_DIR, "art"), { recursive: true });
  mkdirSync(join(MOD_DIR, "levels", "e2e"), { recursive: true });
  writeFileSync(join(MOD_DIR, "description.json"), JSON.stringify({ name: MOD, description: "throwaway mod for the shell e2e spec" }, null, 2));
  copyFileSync(join(SANDBOX, "data", "abilities", GON_LEAF), join(MOD_DIR, "data", "abilities", GON_LEAF));
  copyFileSync(join(SANDBOX, "art", "my_rat.scene.json"), join(MOD_DIR, "art", "my_rat.scene.json"));
  writeFileSync(join(MOD_DIR, "levels", "e2e", "no_spawn.lvl"), encodeLvl(buildRoom({ objects: [], tiles: [] })));
});
test.afterAll(() => {
  rmSync(MOD_DIR, { recursive: true, force: true });
});
test.beforeEach(async ({ page }) => {
  await seedToursSeen(page);
});

test.describe("shell — one command bar", () => {
  test("Data mode: the top-bar Save writes the open overlay (unsaved dot, toast) and the edit survives a reload", async ({ page }) => {
    await openGon(page);
    await expect(saveBtn(page)).toHaveAttribute("title", "Save overlay (Ctrl+S)");
    await expect(saveBtn(page).locator(".dot")).toHaveCount(0);
    await typeAtEnd(page, "\n// shell-e2e-a\n");
    await expect(saveBtn(page).locator(".dot")).toHaveCount(1);
    await expect(modeBtn(page, "Data").locator(".dot")).toHaveCount(1);
    await saveBtn(page).click();
    await expect(toasts(page)).toContainText(`saved mods/${MOD}/${GON_REL}`);
    await expect(saveBtn(page).locator(".dot")).toHaveCount(0);
    expect(readFileSync(join(MOD_DIR, GON_REL), "utf8")).toContain("// shell-e2e-a");
    await page.reload({ waitUntil: "networkidle" });
    await selectMod(page, MOD);
    await page.locator(".explorer .srow", { hasText: GON_LEAF }).click();
    await expect(page.locator("textarea.code")).toHaveValue(/shell-e2e-a/);
  });

  test("Ctrl+S saves the open overlay through the same command", async ({ page }) => {
    await openGon(page);
    await typeAtEnd(page, "\n// shell-e2e-c\n");
    await page.keyboard.press("Control+s");
    await expect(toasts(page)).toContainText(`saved mods/${MOD}/${GON_REL}`);
    expect(readFileSync(join(MOD_DIR, GON_REL), "utf8")).toContain("// shell-e2e-c");
  });

  test("Art mode: the top-bar Save writes the scene (the scene tab bar keeps only Build SWF) and the value survives a reload", async ({ page }) => {
    await openScene(page);
    await expect(page.locator(".edtabbar button", { hasText: "Save scene" })).toHaveCount(0);
    await expect(page.locator(".edtabbar button", { hasText: "Build SWF" })).toHaveCount(1);
    await expect(saveBtn(page)).toHaveAttribute("title", "Save scene (Ctrl+S)");
    await expect(page.locator(".topbar .topbar-validate")).toBeEnabled();
    await frameRate(page).fill("30");
    await frameRate(page).press("Tab");
    await expect(saveBtn(page).locator(".dot")).toHaveCount(1);
    await saveBtn(page).click();
    await expect(toasts(page)).toContainText(`saved mods/${MOD}/art/my_rat.scene.json`);
    await expect.poll(() => (JSON.parse(readFileSync(join(MOD_DIR, "art", "my_rat.scene.json"), "utf8")) as { frameRate: number }).frameRate).toBe(30);
    await openScene(page);
    await expect(frameRate(page)).toHaveValue("30");
  });

  test("browsing palette rows does not mark the scene unsaved", async ({ page }) => {
    await openScene(page);
    await expect(page.locator(".edtabbar")).toContainText("● Saved");
    await page.locator("#pv-row").fill("12");
    await page.locator("#pv-row").press("Tab");
    await expect(page.locator(".edtabbar")).toContainText("● Saved");
    await expect(saveBtn(page).locator(".dot")).toHaveCount(0);
  });

  test("Rooms mode: Validate and Save show in the top bar (disabled without a room); the status pill counts the room's findings", async ({ page }) => {
    await openApp(page, "?mode=rooms");
    await selectMod(page, MOD);
    await expect(saveBtn(page)).toBeVisible();
    await expect(saveBtn(page)).toBeDisabled();
    await expect(saveBtn(page)).toHaveAttribute("title", "Save room (Ctrl+S)");
    await expect(page.locator(".topbar .topbar-validate")).toBeDisabled();
    await page.locator(".rooms-list .srow", { hasText: "e2e/no_spawn.lvl" }).click();
    await expect(page.locator(".rcell")).toHaveCount(100);
    await expect(page.locator(".room-save")).toHaveCount(0);
    await expect(saveBtn(page)).toBeEnabled();
    // the findings live in the right panel's Findings tab (UX PR 5)
    await page.locator(".rightpanel [role=tablist] [role=tab]", { hasText: "Findings" }).click();
    await expect(page.locator(".roomfindings")).toContainText("lvl-no-player-spawn");
    await expect(page.locator(".topbar .pill").last()).toContainText("1 warning");
  });

  test("Art mode: the status pill counts the scene's findings and opens the Findings tab", async ({ page }) => {
    await openScene(page);
    await expect(page.locator(".topbar .pill").last()).toContainText(/\d+ errors? · \d+ warnings?/);
    await page.locator(".topbar .pill").last().click();
    await expect(page.locator(".rightpanel .tabs .tab.active")).toHaveText("Findings");
  });
});

test.describe("shell — data-loss regressions", () => {
  test("saving a GON file in Data mode keeps the unsaved scene open with its edit; Build SWF keeps it open too", async ({ page }) => {
    await openScene(page);
    await frameRate(page).fill("48");
    await frameRate(page).press("Tab");
    await expect(page.locator(".edtabbar")).toContainText("● Unsaved");
    await expect(modeBtn(page, "Art").locator(".dot")).toHaveCount(1);
    // Data: edit + save a GON file in the same mod (no guard on mode switches)
    await modeBtn(page, "Data").click();
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await page.locator(".explorer .srow", { hasText: GON_LEAF }).click();
    await typeAtEnd(page, "\n// shell-e2e-e\n");
    await saveBtn(page).click();
    await expect(toasts(page)).toContainText(`saved mods/${MOD}/${GON_REL}`);
    // back to Art: the scene and its unsaved edit are still there
    await modeBtn(page, "Art").click();
    await expect(page.locator(".artpanel h2")).toHaveText("my_rat");
    await expect(frameRate(page)).toHaveValue("48");
    await expect(page.locator(".edtabbar")).toContainText("● Unsaved");
    // Build SWF (right panel) builds and leaves the scene open
    await page.locator(".rightpanel .tabs .tab", { hasText: "Build" }).click();
    await page.locator(".rightpanel").getByRole("button", { name: "Build SWF", exact: true }).click();
    await expect(page.locator(".explorer .srow", { hasText: /my_rat\.swf/ })).toBeVisible();
    await expect(page.locator(".artpanel h2")).toHaveText("my_rat");
    await expect(frameRate(page)).toHaveValue("48");
  });
});

test.describe("shell — unsaved-work guard", () => {
  test("switching mods with an unsaved overlay asks first: Cancel (focused) keeps the edit and the mod, Esc cancels, Discard switches", async ({ page }) => {
    await openGon(page);
    await typeAtEnd(page, "\n// shell-e2e-f\n");
    await switcher(page).click();
    await page.locator(".menu .item", { hasText: /^jokers-luck$/ }).click();
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(GON_REL);
    await expect(dialog.locator(".confirm-cancel")).toBeFocused();
    await expect(dialog.locator(".confirm-discard")).toBeVisible();
    await expect(dialog.locator(".confirm-save")).toBeVisible();
    await dialog.locator(".confirm-cancel").click();
    await expect(dialog).toHaveCount(0);
    await expect(switcher(page)).toContainText(MOD);
    await expect(page.locator("textarea.code")).toHaveValue(/shell-e2e-f/);
    // Esc is Cancel
    await switcher(page).click();
    await page.locator(".menu .item", { hasText: /^jokers-luck$/ }).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(switcher(page)).toContainText(MOD);
    // Discard switches
    await switcher(page).click();
    await page.locator(".menu .item", { hasText: /^jokers-luck$/ }).click();
    await dialog.locator(".confirm-discard").click();
    await expect(switcher(page)).toContainText("jokers-luck");
    expect(readFileSync(join(MOD_DIR, GON_REL), "utf8")).not.toContain("shell-e2e-f");
  });

  test("closing an unsaved file asks; reloading with unsaved work raises the browser's beforeunload prompt", async ({ page }) => {
    await openGon(page);
    await typeAtEnd(page, "\n// shell-e2e-g\n");
    await page.locator('.edtabbar .filetab button[aria-label]').first().click();
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();
    await dialog.locator(".confirm-cancel").click();
    await expect(page.locator(".edtabbar .filetab")).toContainText(GON_LEAF);
    let kind = "";
    page.on("dialog", (d) => {
      kind = d.type();
      void d.accept();
    });
    await page.reload({ waitUntil: "networkidle" });
    expect(kind).toBe("beforeunload");
  });
});

test.describe("shell — launch, status, deep links, rooms rows", () => {
  test("Launch… shows the launch command for the open mod and Copy puts it on the clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openApp(page);
    await selectMod(page, "jokers-luck");
    await page.locator(".topbar button", { hasText: "Launch…" }).click();
    const pop = page.locator(".launchpop");
    await expect(pop).toBeVisible();
    await expect(pop.locator('[aria-label="Launch command"]')).toHaveValue("launch-dev.bat mods\\jokers-luck");
    await expect(pop).toContainText("-savesuffix dev");
    await pop.getByRole("button", { name: "Copy" }).click();
    await expect(toasts(page)).toContainText(/copied/i);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("launch-dev.bat mods\\jokers-luck");
  });

  test("GET /api/status reports saveSuffix dev; the status bar shows the build, the server dot and save: dev", async ({ page }) => {
    const r = await page.request.get("/api/status");
    expect(r.status()).toBe(200);
    const j = (await r.json()) as { saveSuffix: string; exeFound: boolean; known: boolean; gameBuild: string | null };
    expect(j.saveSuffix).toBe("dev");
    await openApp(page);
    const bar = page.locator(".statusbar");
    await expect(bar).toContainText("save: dev");
    await expect(bar).toContainText(j.exeFound ? (j.gameBuild ? `build ${j.gameBuild}` : "build") : "build unknown");
    await expect(bar).not.toContainText("build dev");
    await expect(bar.locator(".dotok", { hasText: "local server" })).toBeVisible();
    await expect(bar).toContainText(/extracted [✓–]/);
    await expect(bar).toContainText(/framework [✓–]/);
  });

  test("deep links: ?mode=art&mod=dev-sandbox opens Art on that mod; opening a file writes file= into the URL; ?file= opens it", async ({ page }) => {
    await openApp(page, "?mode=art&mod=dev-sandbox");
    await expect(modeBtn(page, "Art")).toHaveAttribute("aria-pressed", "true");
    await expect(switcher(page)).toContainText("dev-sandbox");
    await expect(page.locator(".explorer")).toContainText("my_rat");
    await expect(page.locator(".tourcard, .tour")).toHaveCount(0);
    await openApp(page, `?mod=${MOD}`);
    await expect(switcher(page)).toContainText(MOD);
    await page.locator(".explorer .srow", { hasText: GON_LEAF }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("file")).toBe(GON_REL);
    expect(new URL(page.url()).searchParams.get("mod")).toBe(MOD);
    expect(new URL(page.url()).searchParams.get("mode")).toBe("data");
    await openApp(page, `?mode=data&mod=${MOD}&file=${encodeURIComponent(GON_REL)}`);
    await expect(page.locator(".edtabbar .filetab")).toContainText(GON_LEAF);
  });

  test("a .lvl row in the Data tree carries a 'room ↗' chip and opens in Rooms mode", async ({ page }) => {
    await openApp(page);
    await selectMod(page, MOD);
    const row = page.locator(".explorer .srow", { hasText: "no_spawn.lvl" });
    const chip = row.locator(".pill", { hasText: "room ↗" });
    await expect(chip).toHaveAttribute("title", "Opens in Rooms mode");
    await row.click();
    await expect(modeBtn(page, "Rooms")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".rcell")).toHaveCount(100);
  });

  test("the Help menu has a Rooms mode group whose Rooms concepts opens the Concepts drawer", async ({ page }) => {
    await openApp(page);
    await page.locator('.topbar .dropdown button[aria-label="Help and onboarding"]').click();
    await expect(page.locator(".menu .label", { hasText: "Rooms mode" })).toBeVisible();
    await page.locator(".menu .item", { hasText: "Rooms concepts" }).click();
    await expect(page.locator(".drawer")).toBeVisible();
  });
});
