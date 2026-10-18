import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { openApp, seedToursSeen, selectMod, collectConsole } from "./helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", ".."); // editor/tests/e2e -> repo root
const MODS_DIR = join(REPO_ROOT, "mods");
const TMP_MOD = "e2e-tmp-mod";

/** The "abilities" base-data category button. Base categories uniquely carry a `.count`
 *  child (mod-tree folders — e.g. dev-sandbox's own "abilities" dir — do not). */
function abilitiesCategory(page) {
  return page
    .locator(".explorer button.srow")
    .filter({ has: page.getByText("abilities", { exact: true }) })
    .filter({ has: page.locator("span.count") });
}

/** Open the template scaffolder with an empty mod via the top-bar "New mod…" item. */
async function openNewModScaffolder(page) {
  const switcher = page.locator(".topbar .dropdown").first().locator("button").first();
  await switcher.click();
  await page.getByRole("button", { name: /New mod/ }).click();
}

test.beforeEach(async ({ page }) => {
  await seedToursSeen(page);
});

test.describe("Data mode — base explorer", () => {
  test("big category shows the 300-of-M cap note and caps the DOM", async ({ page }) => {
    await openApp(page);
    await abilitiesCategory(page).click();
    const entries = page.locator(".explorer .entries");
    await expect(entries).toBeVisible();
    await expect(entries.locator(".srow", { hasText: /showing 300 of 3[,. ]?076/ })).toBeVisible();
    // DOM is capped at 300 entry buttons (the "showing N of M" note is a div, not a button)
    await expect(entries.locator("button.srow")).toHaveCount(300);
  });

  test("filter is debounced (not one fetch per keystroke)", async ({ page }) => {
    await openApp(page);
    await abilitiesCategory(page).click();
    await expect(page.locator(".explorer .entries")).toBeVisible();

    /** @type {string[]} */
    const filterReqs = [];
    page.on("request", (r) => {
      const u = r.url();
      if (u.includes("/api/base?") && u.includes("filter=")) filterReqs.push(u);
    });

    const search = page.locator(".explorer .search input");
    // type 6 chars ~30ms apart (<200ms debounce) — a non-debounced input would fire 6 fetches
    await search.pressSequentially("Shadow", { delay: 30 });
    await page.waitForTimeout(500);
    expect(filterReqs.length, `filter fetches: ${filterReqs.length}`).toBeGreaterThanOrEqual(1);
    expect(filterReqs.length, `filter fetches: ${filterReqs.length}`).toBeLessThanOrEqual(2);
  });

  test("selecting a category / opening an entry does not rebuild the category list", async ({ page }) => {
    await openApp(page);
    await abilitiesCategory(page).click();
    await expect(page.locator(".explorer .entries")).toBeVisible();

    // tag the category buttons + the "components" accent row with a DOM-node marker
    await page.evaluate(() => {
      for (const b of document.querySelectorAll(".explorer button.srow")) {
        const t = (b.textContent || "").trim();
        if (t.startsWith("abilities")) /** @type {any} */ (b).__e2e = "abilities";
      }
      const acc = document.querySelector(".explorer .srow.acc");
      if (acc) /** @type {any} */ (acc).__e2e = "components";
    });

    // filter (rebuilds only the entries), then open an entry (opens a drawer)
    await page.locator(".explorer .search input").fill("Spin");
    await page.waitForTimeout(400);
    await page.locator(".explorer .entries button.srow").first().click();
    await expect(page.locator(".drawer")).toBeVisible();

    // the category list nodes must be the SAME nodes (not rebuilt)
    const markers = await page.evaluate(() => {
      const ab = [...document.querySelectorAll(".explorer button.srow")].find((b) => /** @type {any} */ (b).__e2e === "abilities");
      const acc = /** @type {any} */ (document.querySelector(".explorer .srow.acc"));
      return { abilities: !!ab, components: acc && acc.__e2e === "components" };
    });
    expect(markers.abilities).toBe(true);
    expect(markers.components).toBe(true);
  });
});

test.describe("Data mode — editor, validation, preview, save", () => {
  async function openJokersFile(page) {
    await openApp(page);
    await selectMod(page, "jokers-luck");
    await page.locator(".explorer button.srow", { hasText: "fighter_abilities.gon.append" }).first().click();
    await expect(page.locator("textarea.code")).toBeVisible();
    await expect(page.locator(".edtabbar .filetab")).toContainText("fighter_abilities.gon.append");
  }

  test("opening a mod + overlay file shows the editor with highlight + gutter", async ({ page }) => {
    const errors = collectConsole(page);
    await openJokersFile(page);
    await expect(page.locator(".edmain pre.hl")).not.toBeEmpty();
    const gutter = (await page.locator(".edgutter pre").innerText()).trim();
    expect(gutter.split("\n").filter((s) => /^\d+$/.test(s)).length).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    expect(errors, JSON.stringify(errors, null, 2)).toHaveLength(0);
  });

  test("live validation panel updates after editing", async ({ page }) => {
    await openJokersFile(page);
    await expect(page.locator(".rightpanel .summary")).toBeVisible();
    // introduce an obvious error by typing a bad reference, confirm the panel reacts
    await page.locator("textarea.code").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\nBrokenEntry { variant_of ThisParentDoesNotExist_ZZZ }\n");
    await expect
      .poll(async () => (await page.locator(".topbar .pill").last().innerText()).trim(), { timeout: 6000 })
      .toMatch(/error|warning|●/i);
  });

  test("merge preview renders the effective entry", async ({ page }) => {
    await openJokersFile(page);
    await page.locator(".rightpanel .tab", { hasText: "Preview" }).click();
    await expect(page.locator(".rightpanel .panelbody")).toContainText("Merge preview");
    await expect(page.locator(".rightpanel .panelbody")).toContainText("JokersGambit");
    await expect(page.locator(".rightpanel .panelbody")).toContainText("append");
  });

  test("GON highlight overlay stays aligned with gutter on fast typing + scroll, and is windowed", async ({ page }) => {
    await openJokersFile(page);

    // mark the persistent editor nodes so we can prove they are never rebuilt
    await page.evaluate(() => {
      /** @type {any} */ (document.querySelector("textarea.code")).__e2e = 1;
      /** @type {any} */ (document.querySelector(".edmain pre.hl")).__e2e = 1;
      /** @type {any} */ (document.querySelector(".edgutter pre")).__e2e = 1;
    });

    // inject a large GON buffer (3000 wide lines) and fire input, like a big file loaded
    const total = await page.evaluate((n) => {
      const ta = /** @type {HTMLTextAreaElement} */ (document.querySelector("textarea.code"));
      const lines = [];
      for (let i = 0; i < n; i++) lines.push(`Entry_${i} { variant_of Spin; cost { mana ${i} } meta { name "ABILITY_${i}_NAME" } } // row ${i} ${"x".repeat(80)}`);
      ta.value = lines.join("\n");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      return n;
    }, 3000);
    expect(total).toBe(3000);

    // after a paint, the gutter is windowed (far fewer than 3000 numbers rendered)
    const windowed = await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const g = /** @type {HTMLElement} */ (document.querySelector(".edgutter pre"));
      const nums = (g.textContent || "").split("\n").filter((s) => /^\d+$/.test(s));
      res(nums.length);
    }))));
    expect(windowed, `gutter rendered ${windowed} line numbers`).toBeGreaterThan(0);
    expect(windowed, `gutter rendered ${windowed} line numbers (expected windowed, not all 3000)`).toBeLessThan(400);

    // scroll both axes, then assert the overlay + gutter transforms track the scroll exactly
    const align = await page.evaluate(() => new Promise((res) => {
      const ta = /** @type {HTMLTextAreaElement} */ (document.querySelector("textarea.code"));
      ta.scrollTop = 4000;
      ta.scrollLeft = 140;
      ta.dispatchEvent(new Event("scroll", { bubbles: true }));
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const hl = /** @type {HTMLElement} */ (document.querySelector(".edmain pre.hl"));
        const gut = /** @type {HTMLElement} */ (document.querySelector(".edgutter pre"));
        const mh = new DOMMatrixReadOnly(getComputedStyle(hl).transform);
        const mg = new DOMMatrixReadOnly(getComputedStyle(gut).transform);
        const csTa = getComputedStyle(ta), csHl = getComputedStyle(hl), csGut = getComputedStyle(gut);
        res({
          st: ta.scrollTop, sl: ta.scrollLeft,
          hlX: mh.m41, hlY: mh.m42, gutY: mg.m42,
          sameFont: csTa.fontSize === csHl.fontSize && csTa.lineHeight === csHl.lineHeight,
          samePadTop: parseFloat(csTa.paddingTop) === parseFloat(csHl.paddingTop) && parseFloat(csTa.paddingTop) === parseFloat(csGut.paddingTop),
          samePadLeft: parseFloat(csTa.paddingLeft) === parseFloat(csHl.paddingLeft),
        });
      }));
    }));
    expect(Math.abs(align.hlX - -align.sl)).toBeLessThanOrEqual(1);
    expect(Math.abs(align.hlY - -align.st)).toBeLessThanOrEqual(1);
    expect(Math.abs(align.gutY - -align.st)).toBeLessThanOrEqual(1);
    expect(align.sameFont).toBe(true);
    expect(align.samePadTop).toBe(true);
    expect(align.samePadLeft).toBe(true);

    // the editor nodes were never rebuilt by typing/scrolling
    const stable = await page.evaluate(() => ({
      ta: /** @type {any} */ (document.querySelector("textarea.code")).__e2e === 1,
      hl: /** @type {any} */ (document.querySelector(".edmain pre.hl")).__e2e === 1,
      gut: /** @type {any} */ (document.querySelector(".edgutter pre")).__e2e === 1,
    }));
    expect(stable).toEqual({ ta: true, hl: true, gut: true });
  });
});

test.describe("Data mode — template scaffolder", () => {
  test("scaffolder opens and guards an empty mod name (dry validation)", async ({ page }) => {
    await openApp(page);
    await openNewModScaffolder(page);
    const modal = page.locator(".modal", { hasText: "Scaffold an overlay" });
    await expect(modal).toBeVisible();
    // clicking Scaffold with an empty mod name must not write — it shows the guard
    await modal.getByRole("button", { name: "Scaffold", exact: true }).click();
    await expect(modal).toContainText("enter a mod name first");
  });

  test("save/scaffold writes only under mods/<name>/", async ({ page }) => {
    rmSync(join(MODS_DIR, TMP_MOD), { recursive: true, force: true });
    await openApp(page);
    await openNewModScaffolder(page);
    const modal = page.locator(".modal", { hasText: "Scaffold an overlay" });
    await expect(modal).toBeVisible();
    await modal.locator("label.fld", { hasText: "mod (folder under mods/)" }).locator("xpath=following-sibling::input[1]").fill(TMP_MOD);
    await modal.locator("label.fld", { hasText: "entry name (GON key)" }).locator("xpath=following-sibling::input[1]").fill("E2ETestAbility");
    await modal.getByRole("button", { name: "Scaffold", exact: true }).click();
    // the scaffolder reports the paths it wrote; they must be under mods/<TMP_MOD>/
    const resultPre = modal.locator("pre.mergecode");
    await expect(resultPre).toBeVisible();
    const resultText = await resultPre.innerText();
    expect(resultText).toContain(TMP_MOD);
    const paths = resultText.match(/mods\/[^\s"]+/g) || [];
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(p.startsWith(`mods/${TMP_MOD}/`)).toBe(true);
    expect(existsSync(join(MODS_DIR, TMP_MOD))).toBe(true);
  });
});

test.afterAll(() => {
  try {
    rmSync(join(MODS_DIR, TMP_MOD), { recursive: true, force: true });
  } catch {
    /* non-fatal */
  }
});
