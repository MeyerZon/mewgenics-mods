// Rooms mode (the Room editor): New room from the `room` template, paint tiles (click + drag), place a player spawn,
// edit a weighted random list in the inspector, live lvl-* findings, Save, reload — and the bytes on disk are
// asserted with the editor's own codec. A throwaway mod `e2e-rooms` is created under mods/ and removed afterwards.

import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { openApp, seedToursSeen, selectMod, collectConsole } from "./helpers.ts";
import { decodeLvl, encodeLvl, buildRoom } from "../../src/core/level/lvl.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const MOD = "e2e-rooms";
const MOD_DIR = join(REPO_ROOT, "mods", MOD);
const MUD = 9100;
/** a level with what a fresh room lacks: a stacked cell, random tile and object lists, a v1-style header word kept in raw */
const KEEP = encodeLvl(buildRoom({
  objects: [{ x: 1, y: 0, id: 1 }, { x: 2, y: 2, id: 1 }, { x: 2, y: 2, id: [{ id: 1, weight: 3 }, { id: 0, weight: 1 }] }],
  tiles: [{ x: 4, y: 4, id: [{ id: MUD, weight: 2 }, { id: 0, weight: 5 }] }, { x: 0, y: 9, id: MUD }],
}));

/** tileset art: vanilla Water (tile id 1) in the top-left corner, a vanilla Rat (spawns id 11) on it, the mod's MudTile (no clip: swatch) */
const ART = encodeLvl(buildRoom({
  objects: [{ x: 0, y: 0, id: 11 }, { x: 5, y: 5, id: 1 }],
  tiles: [{ x: 0, y: 0, id: 1 }, { x: 1, y: 0, id: 1 }, { x: 0, y: 1, id: 1 }, { x: 9, y: 9, id: MUD }],
}));
const SWFS = process.env.MEWGENICS_EXTRACTED_DATA ? join(process.env.MEWGENICS_EXTRACTED_DATA, "..", "swfs") : join(REPO_ROOT, ".extracted", "swfs");

const cell = (page: Page, x: number, y: number) => page.locator(`.rcell[data-x="${x}"][data-y="${y}"]`);

async function openRooms(page: Page): Promise<void> {
  await openApp(page, "?mode=rooms");
  await selectMod(page, MOD);
  await expect(page.locator(".explorer .exhead .sec", { hasText: "Rooms" })).toBeVisible();
}

test.beforeAll(() => {
  rmSync(MOD_DIR, { recursive: true, force: true });
  mkdirSync(join(MOD_DIR, "data"), { recursive: true });
  mkdirSync(join(MOD_DIR, "levels", "e2e"), { recursive: true });
  writeFileSync(join(MOD_DIR, "description.json"), JSON.stringify({ name: MOD, description: "throwaway mod for the Rooms e2e spec" }, null, 2));
  writeFileSync(join(MOD_DIR, "data", "tiles.gon.append"), `${MUD} {\n    editor {\n        image_tint [brown]\n        name "E2E Mud"\n    }\n    tile MudTile\n}\n`);
  writeFileSync(join(MOD_DIR, "levels", "e2e", "keep.lvl"), KEEP);
  writeFileSync(join(MOD_DIR, "levels", "e2e", "art.lvl"), ART);
});
test.afterAll(() => {
  rmSync(MOD_DIR, { recursive: true, force: true });
});
test.beforeEach(async ({ page }) => {
  await seedToursSeen(page);
});

test.describe("Rooms mode — the Room editor", () => {
  test("New room → paint a tile (click + drag), place a player spawn, Save, reload: the grid and the .lvl bytes hold the edits", async ({ page }) => {
    const errors = collectConsole(page);
    await openRooms(page);
    await page.locator(".explorer button", { hasText: "+ New room" }).click();
    await page.locator("#newroom-folder").fill("e2e");
    await page.locator("#newroom-name").fill("painted");
    await page.locator(".modal button", { hasText: "Create" }).click();
    await expect(page.locator(".rcell")).toHaveCount(100);
    await expect(page.locator(".roompath")).toContainText("levels/e2e/painted.lvl");
    // the template's 4 player spawns + 2 Rats
    await expect(page.locator(".rcell[data-objects]:not([data-objects=''])")).toHaveCount(6);

    // tile brush: the mod's own tile from its tiles.gon.append (palette = base + mod overlays)
    await page.locator(".palette-tile .srow.pal", { hasText: "E2E Mud" }).click();
    await cell(page, 2, 3).click();
    await expect(cell(page, 2, 3)).toHaveAttribute("data-tile", String(MUD));
    // drag across row 9 from x=0 to x=4
    await cell(page, 0, 9).hover();
    await page.mouse.down();
    for (let x = 1; x <= 4; x++) await cell(page, x, 9).hover();
    await page.mouse.up();
    for (let x = 0; x <= 4; x++) await expect(cell(page, x, 9)).toHaveAttribute("data-tile", String(MUD));
    await expect(cell(page, 5, 9)).not.toHaveAttribute("data-tile", String(MUD));

    // object brush: the player spawn (spawns.gon `utility PlayerSpawn`)
    await page.locator(".explorer input[aria-label='Filter objects']").fill("PlayerSpawn");
    const spawnRow = page.locator(".palette-object .srow.pal").first();
    const spawnId = Number(await spawnRow.getAttribute("data-id"));
    await spawnRow.click();
    await cell(page, 5, 5).click();
    await expect(cell(page, 5, 5)).toHaveAttribute("data-objects", String(spawnId));
    await expect(page.locator(".roomfindings")).toContainText("No findings");

    await page.locator(".room-save").click();
    await expect(page.getByText(/saved mods\/e2e-rooms\/levels\/e2e\/painted\.lvl/)).toBeVisible();

    // the bytes on disk, through the editor's own codec
    const f = decodeLvl(readFileSync(join(MOD_DIR, "levels", "e2e", "painted.lvl")));
    expect(f.tiles[3 * 10 + 2]).toBe(MUD);
    expect([0, 1, 2, 3, 4].map((x) => f.tiles[9 * 10 + x])).toEqual([MUD, MUD, MUD, MUD, MUD]);
    expect(f.tiles[9 * 10 + 5]).toBe(0);
    expect(f.objects).toContainEqual({ x: 5, y: 5, id: spawnId });
    expect(f.objects.length).toBe(7);

    // reload: the saved room opens with the same cells
    await page.reload({ waitUntil: "networkidle" });
    await selectMod(page, MOD);
    await page.locator(".rooms-list .srow", { hasText: "e2e/painted.lvl" }).click();
    await expect(cell(page, 2, 3)).toHaveAttribute("data-tile", String(MUD));
    await expect(cell(page, 5, 5)).toHaveAttribute("data-objects", String(spawnId));

    // live findings: erase the 5 player spawns → lvl-no-player-spawn (before any save)
    await page.locator(".roomtools button", { hasText: "Erase" }).click();
    for (const [x, y] of [[1, 0], [3, 0], [5, 0], [7, 0], [5, 5]] as const) await cell(page, x, y).click();
    await expect(page.locator(".roomfindings")).toContainText("lvl-no-player-spawn");
    expect(errors.filter((e) => e.type !== "warning"), JSON.stringify(errors)).toHaveLength(0);
  });

  test("an unedited room saves byte-identically; a weighted random list edited in the inspector lands in the file", async ({ page }) => {
    await openRooms(page);
    await page.locator(".rooms-list .srow", { hasText: "e2e/keep.lvl" }).click();
    await expect(page.locator(".rcell")).toHaveCount(100);
    await expect(cell(page, 4, 4)).toHaveAttribute("data-tile", "random");
    await expect(cell(page, 2, 2)).toHaveAttribute("data-objects", "1,random");
    await page.locator(".room-save").click();
    await expect(page.getByText(/saved mods\/e2e-rooms\/levels\/e2e\/keep\.lvl/)).toBeVisible();
    expect(Buffer.from(readFileSync(join(MOD_DIR, "levels", "e2e", "keep.lvl"))).equals(Buffer.from(KEEP))).toBe(true);

    // select (7,7) without painting, turn its tile into a random list, add a choice, weight it 4
    await page.locator(".roomtools button", { hasText: "Select" }).click();
    await cell(page, 7, 7).click();
    await expect(cell(page, 7, 7)).toHaveAttribute("data-tile", "0");
    await page.getByLabel("tile: weighted random list").check();
    await page.locator(".inspector button", { hasText: "+ choice" }).first().click();
    await page.getByLabel("tile choice 2").selectOption(String(MUD));
    await page.getByLabel("tile weight 2").fill("4");
    await expect(cell(page, 7, 7)).toHaveAttribute("data-tile", "random");
    await page.locator(".room-save").click();
    await expect(page.getByText(/saved mods\/e2e-rooms\/levels\/e2e\/keep\.lvl/)).toBeVisible();
    // the first save's toast may still be up: wait for the file itself
    await expect.poll(() => decodeLvl(readFileSync(join(MOD_DIR, "levels", "e2e", "keep.lvl"))).tiles[7 * 10 + 7]).toEqual([{ id: 0, weight: 1 }, { id: MUD, weight: 4 }]);
    const f = decodeLvl(readFileSync(join(MOD_DIR, "levels", "e2e", "keep.lvl")));
    // everything else is the original level
    const back = { ...f, tiles: f.tiles.map((t, i) => (i === 77 ? 0 : t)) };
    expect(Buffer.from(encodeLvl(back)).equals(Buffer.from(KEEP))).toBe(true);
  });

  test("a vanilla level copied into the mod opens and saves back byte for byte (skips without .extracted/levels)", async ({ page }) => {
    const vanilla = join(REPO_ROOT, ".extracted", "levels", "alley", "easy");
    const src = process.env.MEWGENICS_EXTRACTED_DATA ? join(process.env.MEWGENICS_EXTRACTED_DATA, "..", "levels", "alley", "easy") : vanilla;
    const pick = existsSync(src) ? (await import("node:fs")).readdirSync(src).find((n) => n.endsWith(".lvl")) : undefined;
    test.skip(!pick, "no .extracted/levels/alley/easy here");
    const bytes = readFileSync(join(src, pick!));
    writeFileSync(join(MOD_DIR, "levels", "e2e", "vanilla_copy.lvl"), bytes);
    await openRooms(page);
    await page.locator(".rooms-list .srow", { hasText: "e2e/vanilla_copy.lvl" }).click();
    await expect(page.locator(".rcell")).toHaveCount(100);
    await page.locator(".room-save").click();
    await expect(page.getByText(/saved mods\/e2e-rooms\/levels\/e2e\/vanilla_copy\.lvl/)).toBeVisible();
    expect(Buffer.from(readFileSync(join(MOD_DIR, "levels", "e2e", "vanilla_copy.lvl"))).equals(bytes)).toBe(true);
  });
});

test.describe("Rooms mode — tileset art and the iso view", () => {
  test("a tile or object without a clip keeps the tint swatch, in the flat grid and in the iso view (runs everywhere)", async ({ page }) => {
    await openRooms(page);
    await page.locator(".rooms-list .srow", { hasText: "e2e/art.lvl" }).click();
    await expect(page.locator(".rcell")).toHaveCount(100);
    // the mod's MudTile has no clip in any SWF: the swatch stays, with the reason in the tooltip
    await expect(cell(page, 9, 9)).toHaveAttribute("data-art", "swatch");
    await expect(cell(page, 9, 9).locator("img")).toHaveCount(0);
    // the PlayerSpawn utility has no art either: the object stays a round swatch
    await expect(cell(page, 5, 5).locator(".obj")).toBeVisible();
    await page.locator(".roomtools button", { hasText: "Iso" }).click();
    await expect(page.locator(".roomiso .icell")).toHaveCount(100);
    await expect(page.locator(`.roomiso .icell[data-x="9"][data-y="9"]`)).toHaveAttribute("data-art", "swatch");
    // painting works on the diamonds too
    await page.locator(".palette-tile .srow.pal", { hasText: "E2E Mud" }).click();
    await page.locator(`.roomiso .icell[data-x="4"][data-y="6"]`).click({ force: true });
    await expect(page.locator(`.roomiso .icell[data-x="4"][data-y="6"]`)).toHaveAttribute("data-tile", String(MUD));
    await page.locator(".roomtools button", { hasText: "Flat" }).click();
    await expect(cell(page, 4, 6)).toHaveAttribute("data-tile", String(MUD));
  });

  test("with the game's SWFs the grid shows tileset art and the iso view draws the images, feet-registered (skips without .extracted/swfs)", async ({ page }) => {
    test.skip(!existsSync(join(SWFS, "tiles.swf")), "no .extracted/swfs/tiles.swf here");
    const errors = collectConsole(page);
    await openRooms(page);
    await page.locator(".rooms-list .srow", { hasText: "e2e/art.lvl" }).click();
    await expect(page.locator(".roomtools select[aria-label='Tileset']")).toHaveValue("alley");
    // flat grid: Water (tile id 1) shows its clip; the Rat on (0,0) too
    await expect(cell(page, 0, 0)).toHaveAttribute("data-art", "clip");
    await expect(cell(page, 0, 0).locator("img.cellart")).toHaveCount(2);
    // iso view
    await page.locator(".roomtools button", { hasText: "Iso" }).click();
    await expect(page.locator(".roomiso .icell")).toHaveCount(100);
    const imgs = page.locator(".roomiso img.isoart");
    await expect(imgs.first()).toBeVisible();
    await expect.poll(async () => imgs.count()).toBeGreaterThanOrEqual(4); // 3 water tiles + the Rat
    await expect.poll(async () => imgs.evaluateAll((els) => els.every((e) => (e as HTMLImageElement).complete && (e as HTMLImageElement).naturalWidth > 0))).toBe(true);
    // the Rat is drawn after (over) its tile
    const rat = page.locator(`.roomiso img.isoart[data-kind="object"][data-x="0"][data-y="0"]`);
    await expect(rat).toHaveCount(1);
    const order = await imgs.evaluateAll((els) => els.map((e) => `${e.getAttribute("data-kind")}@${e.getAttribute("data-x")},${e.getAttribute("data-y")}`));
    expect(order.indexOf("object@0,0")).toBeGreaterThan(order.indexOf("tile@0,0"));
    // another tileset re-resolves the art (the select drives /api/level-art)
    await page.locator(".roomtools select[aria-label='Tileset']").selectOption("sewers");
    await expect(page.locator(".roomiso img.isoart").first()).toBeVisible();
    expect(errors.filter((e) => e.type !== "warning"), JSON.stringify(errors)).toHaveLength(0);
  });
});
