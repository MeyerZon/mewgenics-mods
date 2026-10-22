import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { openApp, seedToursSeen, selectMod, readFrame, collectConsole } from "./helpers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const SANDBOX = join(REPO_ROOT, "mods", "dev-sandbox");
const SVG_FIXTURE = join(HERE, "fixtures", "e2e_import.svg");
const GRADIENT_FIXTURE = join(HERE, "fixtures", "e2e_gradient.svg");

/** Enter Art mode on dev-sandbox and open the my_rat starter scene (24 frames). */
async function openSandboxScene(page: Page) {
  await openApp(page, "?mode=art");
  await selectMod(page, "dev-sandbox");
  await page.locator(".explorer .srow", { hasText: "my_rat" }).first().click();
  await expect(page.locator(".pvcanvasbox canvas")).toBeVisible();
  // wait for the preview singleton to ingest the scene (frame count 24) before asserting
  await expect.poll(async () => (await readFrame(page)).join("/"), { timeout: 5000 }).toBe("1/24");
}

test.beforeEach(async ({ page }) => {
  await seedToursSeen(page);
});

test.describe("Art mode — Ruffle reference player", () => {
  test("the Ruffle tab plays a built mod SWF from bytes, with no request leaving the editor's origin", async ({ page }) => {
    const errors = collectConsole(page);
    const foreign: string[] = [];
    page.on("request", (r) => { const u = new URL(r.url()); if (u.hostname !== "127.0.0.1" && u.protocol !== "data:" && u.protocol !== "blob:") foreign.push(r.url()); });
    await openSandboxScene(page);
    // build my_rat so a mod SWF exists, then load it in the Ruffle tab
    await page.locator(".rightpanel .tabs button", { hasText: "Build" }).click();
    await page.locator(".rightpanel button", { hasText: "Build SWF" }).click();
    await expect(page.locator(".explorer")).toContainText("my_rat.swf", { timeout: 15000 });
    await page.locator(".rightpanel .tabs button", { hasText: "Ruffle" }).click();
    await expect(page.locator(".ruffle-caption")).toContainText("not glaiel::swf");
    await page.locator(".ruffle-source").selectOption({ label: "mod: my_rat.swf" });
    await page.locator(".ruffle-load").click();
    // the root timeline holds one frame; the 24-frame clip is a sprite inside it (Ruffle reports the root's header)
    await expect(page.locator(".ruffle-status")).toContainText("1 frames, 60 fps", { timeout: 30000 });
    await expect(page.locator(".ruffle-status")).toContainText("SWF v17");
    await expect(page.locator("ruffle-player")).toBeVisible();
    // vanilla files that are not extracted are listed but disabled
    const opts = await page.locator(".ruffle-source option").allTextContents();
    assert_ok(opts.some((t) => /vanilla:/.test(t)), `vanilla entries listed: ${opts.join(" | ")}`);
    // where the vanilla SWFs are extracted (not in CI), one plays too: CWS-compressed, with its own frame count
    const extracted = await page.locator(".ruffle-source option:not([disabled])", { hasText: "vanilla: minecarts.swf" }).count();
    if (extracted) {
      await page.locator(".ruffle-source").selectOption({ label: "vanilla: minecarts.swf" });
      await page.locator(".ruffle-load").click();
      await expect(page.locator(".ruffle-status")).toContainText(/minecarts\.swf: \d+ frames, \d+ fps/, { timeout: 30000 });
    }
    expect(foreign, foreign.join(", ")).toEqual([]);
    const bad = errors.filter((e) => e.type !== "warning" && !/WebGL|SwiftShader|GL_|ANGLE|GPU/i.test(e.text));
    expect(bad, JSON.stringify(errors, null, 2)).toHaveLength(0);
  });
});

test.describe("Art mode — VectorCraft panel", () => {
  test("Open in VectorCraft boots the vendored app in a same-origin iframe; a drawing made through window.vectorcraft is applied back onto the shape at its own coordinates", async ({ page }) => {
    test.setTimeout(240_000); // the 74 MB wasm compiles under SwiftShader
    const errors = collectConsole(page);
    const foreign: string[] = [];
    page.on("request", (r) => { const u = new URL(r.url()); if (u.hostname !== "127.0.0.1" && u.protocol !== "data:" && u.protocol !== "blob:") foreign.push(r.url()); });
    await openSandboxScene(page);
    await page.locator(".subtabs .btn", { hasText: "Shapes" }).click();
    await page.getByRole("button", { name: "Open body in VectorCraft" }).click();
    await expect(page.locator(".subtabs .btn.on")).toHaveText("VectorCraft");
    const status = page.locator(".vc-status");
    await expect(status).toBeVisible();
    await expect(page.locator(".vc-caption")).toContainText("MIT OR Apache-2.0");
    if (/not vendored/.test(await status.innerText())) {
      test.skip(true, "VectorCraft is not vendored here (cd editor && npm run build online once)");
      return;
    }
    await expect(page.locator("iframe.vc-frame")).toBeVisible();
    // the app booted, window.vectorcraft appeared and the shape's SVG was opened as a document
    await expect(status).toContainText(/body\.svg open/, { timeout: 180_000 });
    await expect(status).toContainText("viewBox -44 -34 88 68");
    const apply = page.locator(".vc-apply");
    await expect(apply).toBeDisabled();
    // draw through the control API exactly as an agent would (shape.rectangle, per test/fixtures/vectorcraft/README.md)
    const frame = page.frame({ url: /\/vectorcraft\/index\.html/ });
    expect(frame, "the iframe is the vendored index.html").not.toBeNull();
    const res = await frame!.evaluate(() => (window as unknown as { vectorcraft: { execute(c: string, p: unknown): Promise<unknown> } }).vectorcraft.execute("shape.rectangle", { x: 0, y: 0, width: 10, height: 10 }));
    expect(res).toMatchObject({ id: expect.any(Number) });
    // the dirty-flag poll enables Apply
    await expect(apply).toBeEnabled({ timeout: 15_000 });
    await expect(status).toContainText("edited");
    await apply.click();
    await expect(page.getByText(/applied VectorCraft's drawing to shape "body" \(3 paths, re-origined by -44,-34\)/)).toBeVisible({ timeout: 20_000 });
    await page.locator(".subtabs .btn", { hasText: "JSON" }).click();
    const sc = JSON.parse(await page.locator("textarea").first().inputValue());
    const paths = sc.shapes.body.paths as { d: string; transform?: number[]; fill: string }[];
    expect(paths).toHaveLength(3);
    // VectorCraft re-origined the artboard to 0,0 (our viewBox was -44 -34 88 68): the undo rides on each path's transform
    expect(paths[0]!.d).toBe("M4 4 L84 4 L84 64 L4 64 Z");
    expect(paths[0]!.transform).toEqual([1, 0, 0, 1, -44, -34]);
    expect(paths[0]!.fill).toBe("gray:8");
    expect(paths[2]!.d).toBe("M0 0 L10 0 L10 10 L0 10 Z");
    expect(paths[2]!.transform).toEqual([1, 0, 0, 1, -44, -34]);
    expect(foreign, foreign.join(", ")).toEqual([]);
    const bad = errors.filter((e) => e.type !== "warning" && !/WebGL|SwiftShader|GL_|ANGLE|GPU|wgpu|egui|eframe/i.test(e.text));
    expect(bad, JSON.stringify(errors, null, 2)).toHaveLength(0);
  });
});

function assert_ok(cond: boolean, msg: string) { if (!cond) throw new Error(msg); }

test.describe("Art mode — explorer & scene authoring", () => {
  test("scenes / built-SWFs / assets explorer and scene tabs", async ({ page }) => {
    const errors = collectConsole(page);
    await openApp(page, "?mode=art");
    await selectMod(page, "dev-sandbox");
    await expect(page.locator(".explorer .sec", { hasText: "Art scenes" })).toBeVisible();
    await expect(page.locator(".explorer .sec", { hasText: "Built SWFs" })).toBeVisible();
    await expect(page.locator(".explorer .sec", { hasText: "Assets" })).toBeVisible();

    await page.locator(".explorer .srow", { hasText: "my_rat" }).first().click();
    await expect(page.locator(".artpanel h2")).toHaveText("my_rat");
    // scene summary counts (2 shapes, 1 sprite, 2 exports)
    await expect(page.locator(".arthead .meta")).toContainText("2 shapes");
    await expect(page.locator(".arthead .meta")).toContainText("1 sprites");
    await expect(page.locator(".arthead .meta")).toContainText("2 exports");

    await page.locator(".subtabs .btn", { hasText: "Shapes" }).click();
    await expect(page.locator(".artrow .id", { hasText: /^body$/ })).toBeVisible();
    await expect(page.locator(".artrow .id", { hasText: /^eye$/ })).toBeVisible();

    await page.locator(".subtabs .btn", { hasText: "Sprites" }).click();
    await expect(page.locator(".artpanel")).toContainText("Starter");

    await page.locator(".subtabs .btn", { hasText: "Exports" }).click();
    await expect(page.locator(".artrow .id", { hasText: "starter.png" })).toBeVisible();

    await page.waitForTimeout(300);
    const glErrors = errors.filter((e) => !/WebGL|SwiftShader|GL_|ANGLE|GPU/i.test(e.text));
    expect(glErrors, JSON.stringify(errors, null, 2)).toHaveLength(0);
  });

  test("the SVG drop zone is one block box (display:block, spanning its container), not inline fragments", async ({ page }) => {
    await openSandboxScene(page);
    const dz = page.locator(".dropzone").first();
    await expect(dz).toBeVisible();
    expect(await dz.evaluate((el) => getComputedStyle(el).display)).toBe("block");
    const box = (await dz.boundingBox())!;
    const parentWidth = await dz.evaluate((el) => el.parentElement!.getBoundingClientRect().width);
    expect(box.width).toBeGreaterThan(parentWidth * 0.9);
  });

  test("empty states: no scene (jokers-luck) shows the Art empty hero", async ({ page }) => {
    await openApp(page, "?mode=art");
    await selectMod(page, "jokers-luck");
    await expect(page.locator(".explorer")).toContainText("no scenes — create one");
    await expect(page.locator(".emptycenter")).toContainText("Author art the engine can load");
  });

  test("empty state: a scene with no shapes shows the 'No shapes yet' guidance", async ({ page }) => {
    await openSandboxScene(page);
    await page.locator(".subtabs .btn", { hasText: "Shapes" }).click();
    // delete both shapes in-memory (not saved to disk)
    const deletes = page.locator('.artrow button[aria-label^="Delete shape"]');
    await expect(deletes).toHaveCount(2);
    await deletes.first().click();
    await page.locator('.artrow button[aria-label^="Delete shape"]').first().click();
    await expect(page.locator(".artpanel")).toContainText("No shapes yet");
  });

  test("Timeline tab: rows per layer with key marks, a click scrubs the preview, + key at a frame, edit its y, a label pill (in memory, not saved)", async ({ page }) => {
    const errors = collectConsole(page);
    await openSandboxScene(page);
    await page.locator(".subtabs .btn", { hasText: "Timeline" }).click();
    await expect(page.locator(".tl-row", { hasText: "body" })).toBeVisible();
    await expect(page.locator(".tl-row", { hasText: "eye" })).toBeVisible();
    // the label pills of the sprite (idle at 0, blink at 12)
    await expect(page.locator(".tl-label", { hasText: "blink" })).toBeVisible();
    // a key mark where body has a key (frame 12), none at 6
    await expect(page.locator('[aria-label="layer body, frame 12"]')).toHaveClass(/key/);
    await expect(page.locator('[aria-label="layer body, frame 6"]')).not.toHaveClass(/key/);
    await page.locator('[aria-label="layer body, frame 6"]').click();
    await expect.poll(async () => (await readFrame(page)).join("/")).toBe("7/24");
    await page.getByRole("button", { name: "Add key" }).click();
    await expect(page.locator('[aria-label="layer body, frame 6"]')).toHaveClass(/key/);
    const y = page.locator('input[aria-label="key y"]');
    await y.fill("33");
    await y.press("Enter");
    await page.locator('input[aria-label="label name"]').fill("wave");
    await page.getByRole("button", { name: "Add label" }).click();
    await expect(page.locator(".tl-label", { hasText: "wave" })).toBeVisible();
    await page.locator(".subtabs .btn", { hasText: "JSON" }).click();
    const json = await page.locator("textarea").first().inputValue();
    const sc = JSON.parse(json);
    const k6 = sc.sprites.Starter.layers.find((l: any) => l.name === "body").keys.find((k: any) => k.frame === 6);
    expect(k6 && k6.y).toBe(33);
    expect(sc.sprites.Starter.labels.wave).toBe(6);
    const real = errors.filter((e) => !/WebGL|SwiftShader|GL_|ANGLE|GPU/i.test(e.text));
    expect(real, JSON.stringify(errors, null, 2)).toHaveLength(0);
  });

  test("Rig tab: New cat rig adds a rig sprite with the seven vanilla slots; assigning a slot shows in the JSON (in memory)", async ({ page }) => {
    const errors = collectConsole(page);
    await openSandboxScene(page);
    await page.locator(".subtabs .btn", { hasText: "Rig" }).click();
    await page.getByRole("button", { name: "New cat rig" }).click();
    for (const slot of ["tail", "leg2", "arm2", "body", "leg1", "arm1", "head"]) await expect(page.locator(".rig-slot .id", { hasText: new RegExp(`^${slot}$`) })).toBeVisible();
    await page.locator('select[aria-label="slot head"]').selectOption("eye");
    await page.locator(".subtabs .btn", { hasText: "JSON" }).click();
    const sc = JSON.parse(await page.locator("textarea").first().inputValue());
    const rig = Object.values(sc.sprites).find((s: any) => s.rig === "cat") as any;
    expect(rig && rig.layers.find((l: any) => l.name === "head").keys[0].ref).toBe("eye");
    const real = errors.filter((e) => !/WebGL|SwiftShader|GL_|ANGLE|GPU/i.test(e.text));
    expect(real, JSON.stringify(errors, null, 2)).toHaveLength(0);
  });

  test("Export SVG writes art/<shape>.svg for an external editor; Replace from SVG brings an edited file back over the same shape", async ({ page }) => {
    const errors = collectConsole(page);
    await openSandboxScene(page);
    await page.locator(".subtabs .btn", { hasText: "Shapes" }).click();
    await page.getByRole("button", { name: "Export SVG of body" }).click();
    await expect(page.getByText(/art\/body\.svg/)).toBeVisible();
    const file = join(SANDBOX, "art", "body.svg");
    await expect.poll(() => existsSync(file)).toBe(true);
    // "edit" it externally: recolour the first path to gray level 3 (#333333)
    const edited = readFileSync(file, "utf8").replace(/fill="#[0-9a-f]{6}"/, 'fill="#333333"');
    writeFileSync(file, edited);
    await page.locator('input[aria-label="Replace body from SVG"]').setInputFiles(file);
    await expect(page.getByText(/replaced shape "body"/)).toBeVisible();
    await page.locator(".subtabs .btn", { hasText: "JSON" }).click();
    const sc = JSON.parse(await page.locator("textarea").first().inputValue());
    expect(sc.shapes.body.paths[0].fill).toBe("gray:3");
    const real = errors.filter((e) => !/WebGL|SwiftShader|GL_|ANGLE|GPU/i.test(e.text));
    expect(real, JSON.stringify(errors, null, 2)).toHaveLength(0);
  });

  test("Bake glow… on a shape row bakes body_glow (4 bands) under body in the Starter sprite (in memory); the row then shows it as a baked glow", async ({ page }) => {
    const errors = collectConsole(page);
    await openSandboxScene(page);
    await page.locator(".subtabs .btn", { hasText: "Shapes" }).click();
    // before/after shots of the preview canvas for the PR's T3 look (editor/data/ is git-ignored)
    const shots = join(REPO_ROOT, "editor", "data", "glow-shots");
    mkdirSync(shots, { recursive: true });
    const before = await page.locator(".pvcanvasbox canvas").screenshot({ path: join(shots, "before.png") });
    await page.getByRole("button", { name: "Bake glow of body" }).click();
    await page.locator('input[aria-label="glow colour of body"]').fill("#ff8000");
    await page.locator('input[aria-label="glow blur of body"]').fill("6");
    await page.getByRole("button", { name: "Bake glow now for body" }).click();
    await expect(page.getByText(/baked "body_glow"/)).toBeVisible();
    await page.waitForTimeout(400);
    const after = await page.locator(".pvcanvasbox canvas").screenshot({ path: join(shots, "after.png") });
    expect(Buffer.compare(before, after), "the preview changed once the halo was baked").not.toBe(0);
    await expect(page.locator(".artrow", { hasText: "body_glow" })).toContainText("glow of body");
    await page.locator(".subtabs .btn", { hasText: "JSON" }).click();
    const sc = JSON.parse(await page.locator("textarea").first().inputValue());
    expect(sc.shapes.body_glow.paths).toHaveLength(4);
    expect(sc.shapes.body_glow.baked).toMatchObject({ kind: "glow", of: "body", blur: 6, color: "#ff8000" });
    const layers = sc.sprites.Starter.layers.slice().sort((a: any, b: any) => a.depth - b.depth).map((l: any) => l.keys[0].ref);
    expect(layers.indexOf("body_glow")).toBe(layers.indexOf("body") - 1);
    const real = errors.filter((e) => !/WebGL|SwiftShader|GL_|ANGLE|GPU/i.test(e.text));
    expect(real, JSON.stringify(errors, null, 2)).toHaveLength(0);
  });

  test("Texts: + New text adds a game-font text (font picker lists the game's font classes); editing its words shows in the JSON (in memory)", async ({ page }) => {
    const errors = collectConsole(page);
    await openSandboxScene(page);
    await page.locator(".subtabs .btn", { hasText: "Shapes" }).click();
    await page.getByRole("button", { name: "New text" }).click();
    const row = page.locator(".text-row").first();
    await expect(row).toBeVisible();
    const fonts = await row.locator('select[aria-label^="font of"] option').allInnerTexts();
    expect(fonts).toContain("Peralta");
    expect(fonts).toContain("Edmundm");
    const words = row.locator('input[aria-label^="words of"]');
    await words.fill("Hello cats");
    await words.press("Enter");
    await page.locator(".subtabs .btn", { hasText: "JSON" }).click();
    const sc = JSON.parse(await page.locator("textarea").first().inputValue());
    const t = Object.values(sc.texts || {})[0] as any;
    expect(t && t.text).toBe("Hello cats");
    const real = errors.filter((e) => !/WebGL|SwiftShader|GL_|ANGLE|GPU/i.test(e.text));
    expect(real, JSON.stringify(errors, null, 2)).toHaveLength(0);
  });

  test("import an SVG via the file input adds a shape", async ({ page }) => {
    await openSandboxScene(page);
    await page.locator(".subtabs .btn", { hasText: "Shapes" }).click();
    await page.locator("input#art-svg-file").first().setInputFiles(SVG_FIXTURE);
    // toast confirms the import, and a new shape row appears
    await expect(page.getByText(/imported e2e_import\.svg as shape/)).toBeVisible();
    await expect(page.locator(".artrow .id", { hasText: "e2e_import" })).toBeVisible();
  });

  test("an SVG with a linear gradient imports as a gradient fill (not gray:8): the shape shows a gradient chip, its path select reads gradient:ramp, the preview draws without errors", async ({ page }) => {
    const errors = collectConsole(page);
    await openSandboxScene(page);
    await page.locator(".subtabs .btn", { hasText: "Shapes" }).click();
    await page.locator("input#art-svg-file").first().setInputFiles(GRADIENT_FIXTURE);
    await expect(page.getByText(/imported e2e_gradient\.svg as shape/)).toBeVisible();
    const row = page.locator(".artrow", { has: page.locator(".id", { hasText: "e2e_gradient" }) });
    await expect(row.locator(".chip", { hasText: "1 gradient" })).toBeVisible();
    await expect(page.locator('select[aria-label="fill of path 0"]')).toHaveValue("gradient:ramp");
    await expect(page.locator(".pvcanvasbox canvas")).toBeVisible();
    await page.waitForTimeout(300);
    const real = errors.filter((e) => !/WebGL|SwiftShader|GL_|ANGLE|GPU/i.test(e.text) || /shader|compile|link/i.test(e.text));
    expect(real, JSON.stringify(errors, null, 2)).toHaveLength(0);
  });
});

test.describe("Art mode — preview (loop/suspend/resume, play-pause, resize, palette)", () => {
  test("canvas + transport + scrubber render; frame counter advances when playing", async ({ page }) => {
    await openSandboxScene(page);
    await expect(page.locator(".transport")).toBeVisible();
    await expect(page.locator(".scrub input[type=range]")).toBeVisible();
    expect(await readFrame(page)).toEqual([1, 24]);

    await page.getByRole("button", { name: /^(Play|Pause)$/ }).click();
    await expect(page.getByRole("button", { name: /^(Play|Pause)$/ })).toHaveText("Pause");
    await expect.poll(async () => (await readFrame(page))[0], { timeout: 5000 }).toBeGreaterThan(1);
  });

  test("playback suspends on right-panel tab switch and resumes with a truthful button", async ({ page }) => {
    await openSandboxScene(page);
    await page.getByRole("button", { name: /^(Play|Pause)$/ }).click();
    await expect.poll(async () => (await readFrame(page))[0], { timeout: 5000 }).toBeGreaterThan(1);

    // switch to Findings — the canvas detaches (the condition that suspends the rAF loop)
    await page.locator(".rightpanel .tab", { hasText: "Findings" }).click();
    await expect(page.locator(".pvcanvasbox canvas")).toHaveCount(0);

    // back to Preview — intent preserved (button still "Pause", onPlaying NOT fired on suspend)
    await page.locator(".rightpanel .tab", { hasText: "Preview" }).click();
    await expect(page.locator(".pvcanvasbox canvas")).toBeVisible();
    await expect(page.getByRole("button", { name: /^(Play|Pause)$/ })).toHaveText("Pause");
    // and it resumes on its own (frame keeps moving)
    const f1 = (await readFrame(page))[0];
    await expect.poll(async () => (await readFrame(page))[0], { timeout: 5000 }).not.toBe(f1);
  });

  test("playback suspends when leaving Art mode and resumes on return", async ({ page }) => {
    await openSandboxScene(page);
    await page.getByRole("button", { name: /^(Play|Pause)$/ }).click();
    await expect.poll(async () => (await readFrame(page))[0], { timeout: 5000 }).toBeGreaterThan(1);

    await page.getByRole("button", { name: "Data", exact: true }).click();
    await expect(page.locator(".pvcanvasbox canvas")).toHaveCount(0);

    await page.getByRole("button", { name: "Art", exact: true }).click();
    await expect(page.locator(".pvcanvasbox canvas")).toBeVisible();
    await expect(page.getByRole("button", { name: /^(Play|Pause)$/ })).toHaveText("Pause");
  });

  test("play/pause label is truthful: auto-stops on the last frame with loop OFF", async ({ page }) => {
    await openSandboxScene(page);
    // uncheck loop
    const loop = page.locator(".transport label", { hasText: "loop" }).locator('input[type="checkbox"]');
    await loop.uncheck();
    // scrub to near the end
    await page.evaluate(() => {
      const r = (document.querySelector(".scrub input[type=range]") as HTMLInputElement);
      r.value = "22";
      r.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect.poll(async () => (await readFrame(page))[0]).toBe(23); // "23 / 24"

    await page.getByRole("button", { name: /^(Play|Pause)$/ }).click();
    // it should run to the last frame and then STOP, flipping the button back to "Play"
    await expect(page.getByRole("button", { name: /^(Play|Pause)$/ })).toHaveText("Play", { timeout: 5000 });
    expect(await readFrame(page)).toEqual([24, 24]);
  });

  test("resize re-fits: the canvas backing store tracks its element size", async ({ page }) => {
    await openSandboxScene(page);
    const before = await page.evaluate(() => {
      const c = (document.querySelector(".pvcanvasbox canvas") as HTMLCanvasElement);
      return { cw: c.clientWidth, w: c.width, dpr: window.devicePixelRatio || 1 };
    });
    expect(before.cw).toBeGreaterThan(0);
    expect(Math.abs(before.w - Math.round(before.cw * before.dpr))).toBeLessThanOrEqual(2);

    // collapse to single-column layout (<=1040px), which widens the right panel a lot
    await page.setViewportSize({ width: 900, height: 820 });
    await expect
      .poll(async () => page.evaluate(() => {
        const c = (document.querySelector(".pvcanvasbox canvas") as HTMLCanvasElement);
        const dpr = window.devicePixelRatio || 1;
        return c.clientWidth > 0 && Math.abs(c.width - Math.round(c.clientWidth * dpr)) <= 2 ? c.clientWidth : 0;
      }), { timeout: 5000 })
      .toBeGreaterThan(before.cw);
  });

  test("palette row + 'show raw grayscale' toggle recolor the ramp", async ({ page }) => {
    await openSandboxScene(page);
    const swatches = page.locator(".pvwrap .ramp.big").first().locator("span");
    await expect(swatches).toHaveCount(16);

    const readRamp = () => page.evaluate(() => {
      const spans = document.querySelectorAll(".pvwrap .ramp.big span");
      return [...spans].map((s) => getComputedStyle(s).backgroundColor);
    });
    const parse = (c: string) => (c.match(/\d+/g) || []).map(Number);

    // palette row 54 (from the scene) is not fully grayscale
    const colored = await readRamp();
    expect(colored.some((c) => { const [r, g, b] = parse(c); return r !== g || g !== b; })).toBe(true);

    // show raw grayscale → every swatch becomes grayscale (r==g==b)
    await page.locator(".pvwrap label", { hasText: "show raw gray" }).locator('input[type="checkbox"]').check();
    await expect.poll(async () => {
      const gray = await readRamp();
      return gray.every((c) => { const [r, g, b] = parse(c); return r === g && g === b; });
    }).toBe(true);

    // toggle back off, then changing the palette row changes the swatches
    await page.locator(".pvwrap label", { hasText: "show raw gray" }).locator('input[type="checkbox"]').uncheck();
    const row54 = await readRamp();
    await page.locator("#pv-row").fill("0");
    await page.locator("#pv-row").blur();
    await expect.poll(async () => JSON.stringify(await readRamp()) !== JSON.stringify(row54)).toBe(true);
  });

  test("Browse rows… opens the palette drawer and picking a row updates the input", async ({ page }) => {
    await openSandboxScene(page);
    await page.getByRole("button", { name: /Browse rows/ }).click();
    const drawer = page.locator(".drawer", { hasText: "palette.png rows" });
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(".palgrid .rowpick").first()).toBeVisible();
    await drawer.locator(".palgrid .rowpick").first().click();
    await expect(drawer).toBeHidden();
    await expect(page.locator("#pv-row")).toHaveValue("0"); // first row is 0
  });
});

test.describe("Art mode — build tab", () => {
  test("DoABC radios, dry run, and inspect of a built SWF", async ({ page }) => {
    // clean any prior build output
    rmSync(join(SANDBOX, "swfs"), { recursive: true, force: true });
    await openSandboxScene(page);
    await page.locator(".rightpanel .tab", { hasText: "Build" }).click();

    // default DoABC mode is "none"; the radios toggle
    const none = page.locator('.rightpanel input[name="abcmode"]').first();
    const stub = page.locator('.rightpanel input[name="abcmode"]').nth(1);
    await expect(none).toBeChecked();
    await stub.check();
    await expect(stub).toBeChecked();
    await none.check();

    // "nothing built yet" empty state before any build
    await expect(page.locator(".rightpanel .panelbody")).toContainText("Nothing built yet");

    // dry run reports bytes without writing
    await page.getByRole("button", { name: /Dry run/ }).click();
    await expect(page.locator(".rightpanel .panelbody .summary")).toContainText(/bytes · DoABC/);
    await expect(page.locator(".rightpanel .panelbody")).toContainText("Dry run");

    // a real build, then inspect the emitted SWF from the explorer
    // ("Build SWF" also appears in the scene tab bar, so scope to the Build panel)
    await page.locator(".rightpanel").getByRole("button", { name: "Build SWF", exact: true }).click();
    await expect(page.locator(".rightpanel .panelbody .summary")).toContainText(/bytes · DoABC/);
    await expect(page.locator(".explorer .srow", { hasText: /my_rat\.swf/ })).toBeVisible();
    await page.locator(".explorer .srow", { hasText: /my_rat\.swf/ }).click();
    await expect(page.locator(".rightpanel .panelbody")).toContainText("Inspect");
    await expect(page.locator(".rightpanel .panelbody")).toContainText(/FWS|CWS/); // SWF signature
  });
});

test.afterAll(() => {
  // remove build output + the imported SVG provenance copy from dev-sandbox
  try {
    rmSync(join(SANDBOX, "swfs"), { recursive: true, force: true });
    rmSync(join(SANDBOX, "art", "e2e_import.svg"), { force: true });
    rmSync(join(SANDBOX, "art", "body.svg"), { force: true });
    rmSync(join(SANDBOX, "art", "e2e_gradient.svg"), { force: true });
  } catch {
    /* non-fatal */
  }
});
