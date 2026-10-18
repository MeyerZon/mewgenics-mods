// Shared helpers for the editor e2e suite.
import { expect } from "@playwright/test";

/** onboarding localStorage keys the app reads at first run. */
export const LS = {
  tourSeen: "mewged.onboard.tourSeen",
  tourDontShow: "mewged.onboard.tourDontShow",
  artTourSeen: "mewged.onboard.artTourSeen",
  artTourDontShow: "mewged.onboard.artTourDontShow",
};

/**
 * Attach a console/pageerror collector. Returns an array that fills with
 * {type,text} for console errors/warnings and uncaught exceptions.
 * @param {import('@playwright/test').Page} page
 */
export function collectConsole(page) {
  /** @type {{type:string,text:string}[]} */
  const errors = [];
  page.on("console", (msg) => {
    const type = msg.type();
    if (type === "error" || type === "warning") errors.push({ type, text: msg.text() });
  });
  page.on("pageerror", (err) => errors.push({ type: "pageerror", text: String(err && err.message ? err.message : err) }));
  return errors;
}

/**
 * Seed onboarding keys before any app script runs, so a test that isn't about
 * onboarding never has a tour modal pop over the UI.
 * @param {import('@playwright/test').Page} page
 * @param {Record<string,string>} entries
 */
export async function seedLocalStorage(page, entries) {
  await page.addInitScript((kv) => {
    try {
      for (const [k, v] of Object.entries(kv)) window.localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  }, entries);
}

/** Seed both tours as already-seen (used by non-onboarding tests). */
export async function seedToursSeen(page) {
  await seedLocalStorage(page, {
    [LS.tourSeen]: "1",
    [LS.tourDontShow]: "1",
    [LS.artTourSeen]: "1",
    [LS.artTourDontShow]: "1",
  });
}

/**
 * Open the app and wait for the initial data loads (mods + base categories).
 * @param {import('@playwright/test').Page} page
 * @param {string} [query] e.g. "?mode=art"
 */
export async function openApp(page, query = "") {
  await page.goto("/" + query, { waitUntil: "networkidle" });
  await expect(page.locator(".shell")).toBeVisible();
}

/**
 * Switch the top-bar mod switcher to a given mod.
 * @param {import('@playwright/test').Page} page
 * @param {string} mod
 */
export async function selectMod(page, mod) {
  // the mod switcher button shows the current mod name or "No mod open"
  const switcher = page.locator(".topbar .dropdown").first().locator("button").first();
  await switcher.click();
  await page.locator(".menu .item", { hasText: new RegExp(`^${mod}$`) }).first().click();
  await expect(switcher).toContainText(mod);
}

/**
 * Read the current preview frame counter ("N / M") as [frame, total].
 * @param {import('@playwright/test').Page} page
 */
export async function readFrame(page) {
  const txt = (await page.locator(".transport .frame").innerText()).trim();
  const m = /(\d+)\s*\/\s*(\d+)/.exec(txt);
  return m ? [Number(m[1]), Number(m[2])] : [NaN, NaN];
}
