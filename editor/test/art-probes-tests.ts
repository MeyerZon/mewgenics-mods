// Two in-game probes (2026-10-22) that turn INFERRED doc paragraphs into OBSERVED ones:
//  A. loc-key text — a DefineEditText whose initial text is exactly a localization key is shown as the localized
//     string (DynamicTextBox ctor 0x98d910 → has_key_current_lang 0x963070 → Loc_Get), for a vanilla key and a key a
//     mod adds through combined.csv.append, with and without vanilla's HTML wrapper;
//  B. the tilesets.gon clip redirect — `alley { Rat ArtProbe }` makes a plain Rat draw our ArtProbe clip
//     (ResolveClipName 0x7bdbb0, called by CharacterGraphics_build 0xf1150 for non-_CAT characters).
// The measures live in src/core/art/probe-outcomes.ts (pure, tested here on synthetic images); the runs are
// `npm run test:artprobe -- --loctext` / `-- --tileset`, whose summaries are pinned as fixtures.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODS_DIR, EXTRACTED_DATA } from "../src/core/repo.ts";
import { validateScene } from "../src/core/art/scene.ts";
import { readSwf, flattenTags } from "../src/core/art/swf-reader.ts";
import { emitSwf } from "../src/core/art/swf-emitter.ts";
import { parse } from "../src/core/gon/parser.ts";
import { toValue } from "../src/core/gon/value.ts";
import { previewMerge } from "../src/core/preview-merge.ts";
import { validateMod } from "../src/core/validate/validator.ts";
import { parseScript } from "../src/core/ingame/script.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

type Img = { width: number; height: number; rgba: Uint8Array };
function blank(w: number, h: number): Img { const rgba = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) { rgba[i * 4] = 40; rgba[i * 4 + 1] = 40; rgba[i * 4 + 2] = 50; rgba[i * 4 + 3] = 255; } return { width: w, height: h, rgba }; }
function paint(img: Img, x0: number, y0: number, w: number, h: number, c: [number, number, number]) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue; const i = (y * img.width + x) * 4; img.rgba[i] = c[0]; img.rgba[i + 1] = c[1]; img.rgba[i + 2] = c[2]; }
}
/** a crude "glyph string": one 6×14 px bar per character code bit pattern, centred on (cx, cy) in screen px */
function fakeText(img: Img, cx: number, cy: number, s: string, c: [number, number, number] = [0, 230, 150]) {
  const adv = 10, w0 = s.length * adv;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const x = Math.round(cx - w0 / 2 + i * adv);
    for (let b = 0; b < 4; b++) if (code & (1 << b)) paint(img, x, Math.round(cy - 8 + b * 4), 7, 3, c);
    paint(img, x, Math.round(cy - 8), 2, 16, c);
  }
}

export async function runArtProbesTests(test: TestFn, assert: AssertFn, eq: EqFn): Promise<void> {
  console.log("\n# Art probes 2026-10-22: loc-key text and the tilesets.gon clip redirect");
  let P: Record<string, any> = {};
  let err = "";
  try { P = await import("../src/core/art/probe-outcomes.ts"); } catch (e) { err = e instanceof Error ? e.message : String(e); }
  const need = () => { if (err) throw new Error(`probe-outcomes.ts: ${err}`); };

  // ---- A. loc-key text: the measure ----
  const geom = { box: { x0: 1400, y0: 900, x1: 1400 + 96 * 2 - 1, y1: 900 + 64 * 2 - 1 }, scale: 2, mirrored: false };
  /** screen centre of a LOC_PROBE_BOXES entry under `geom` */
  const at = (b: { x: number; y: number }) => ({ x: geom.box.x0 + b.x * geom.scale, y: geom.box.y0 + b.y * geom.scale });
  const synth = (shown: (b: { id: string; text: string; html: boolean }) => string | null) => {
    const img = blank(2600, 1440);
    for (const b of P.LOC_PROBE_BOXES as Array<{ id: string; text: string; html: boolean; x: number; y: number }>) { const s = shown(b); if (s) { const c = at(b); fakeText(img, c.x, c.y, s); } }
    return img;
  };
  const english: Record<string, string> = { ENEMY_TOMTOM_NAME: "Tom Tom", ARTPROBE_LOCTEST: "LOCALIZED OK" };

  test("LOC_PROBE_BOXES: four key boxes (vanilla / mod key × HTML / plain), each with a same-mode look-alike literal one letter off, and the two English values as HTML literals", () => {
    need();
    const B = P.LOC_PROBE_BOXES as Array<{ id: string; text: string; html: boolean }>;
    const by = (id: string) => B.find((b) => b.id === id)!;
    for (const [id, text, html] of [["keyVanillaHtml", "ENEMY_TOMTOM_NAME", true], ["keyVanillaPlain", "ENEMY_TOMTOM_NAME", false], ["keyModHtml", "ARTPROBE_LOCTEST", true], ["keyModPlain", "ARTPROBE_LOCTEST", false], ["valueVanilla", "Tom Tom", true], ["valueMod", "LOCALIZED OK", true]] as const) {
      assert(!!by(id), id); eq(by(id).text, text, id); eq(by(id).html, html, id);
    }
    for (const k of ["VanillaHtml", "VanillaPlain", "ModHtml", "ModPlain"]) {
      const key = by("key" + k), lit = by("lit" + k);
      assert(!!lit, "lit" + k);
      eq(lit.html, key.html, `lit${k} same mode`); eq(lit.text.length, key.text.length, `lit${k} same length`);
      eq(lit.text.slice(0, -1), key.text.slice(0, -1), `lit${k} differs only in its last letter`);
      assert(lit.text !== key.text, `lit${k} is not the key`);
    }
  });

  test("measureLocText: a key box drawn like its English value is `substituted`, drawn like its look-alike literal is `literal`, an empty one `unreadable`; plainRenders follows the plain look-alike's ink", () => {
    need();
    const sub = P.measureLocText(synth((b) => english[b.text] || b.text), geom);
    for (const k of ["vanillaHtml", "vanillaPlain", "modHtml", "modPlain"]) eq(sub.outcomes[k], "substituted", `all substituted: ${k} ${JSON.stringify(sub.pairs[k])}`);
    eq(sub.plainRenders, true);
    const lit = P.measureLocText(synth((b) => b.text), geom);
    for (const k of ["vanillaHtml", "vanillaPlain", "modHtml", "modPlain"]) eq(lit.outcomes[k], "literal", `none substituted: ${k} ${JSON.stringify(lit.pairs[k])}`);
    const mixed = P.measureLocText(synth((b) => (b.html ? english[b.text] || b.text : b.text.startsWith("ARTPROBE") ? null : b.text)), geom);
    eq(mixed.outcomes.vanillaHtml, "substituted"); eq(mixed.outcomes.modHtml, "substituted");
    eq(mixed.outcomes.vanillaPlain, "literal"); eq(mixed.outcomes.modPlain, "unreadable");
    assert(mixed.boxes.keyModPlain.ink === 0, "no ink in the empty box");
    assert(sub.boxes.keyVanillaHtml.ink > 40 && sub.boxes.keyVanillaHtml.inkWidth > 0, JSON.stringify(sub.boxes.keyVanillaHtml));
  });

  test("measureLocText mirrors the box layout with the clip (enemy clips are drawn mirrored: OBSERVED 2026-10-20)", () => {
    need();
    const g = { ...geom, mirrored: true };
    const img = blank(2600, 1440);
    for (const b of P.LOC_PROBE_BOXES as Array<{ text: string; x: number; y: number }>) fakeText(img, g.box.x1 + 1 - b.x * g.scale, g.box.y0 + b.y * g.scale, english[b.text] || b.text);
    const m = P.measureLocText(img, g);
    for (const k of ["vanillaHtml", "vanillaPlain", "modHtml", "modPlain"]) eq(m.outcomes[k], "substituted", k);
  });

  test("inkDifference: identical masks 0, disjoint masks 1, empty masks 0", () => {
    need();
    const a = { w: 4, h: 1, mask: new Uint8Array([1, 1, 0, 0]) }, b = { w: 4, h: 1, mask: new Uint8Array([0, 0, 1, 1]) };
    eq(P.inkDifference(a, a), 0); eq(P.inkDifference(a, b), 1); eq(P.inkDifference({ w: 1, h: 1, mask: new Uint8Array([0]) }, { w: 1, h: 1, mask: new Uint8Array([0]) }), 0);
  });

  // ---- B. the tileset redirect: the verdict ----
  test("tilesetOutcome: our marker on screen after `spawn Rat` with the overlay and not in its pre-spawn shot, none in the control → redirected; no marker with the overlay → not-redirected; a marker before the spawn or in the control → inconclusive; a failed run → its verdict", () => {
    need();
    const s = (found: boolean) => ({ found });
    eq(P.tilesetOutcome({ verdict: "pass", baseline: s(false), after: [s(true), s(true)] }, { verdict: "pass", baseline: s(false), after: [s(false), s(false)] }), "redirected");
    eq(P.tilesetOutcome({ verdict: "pass", baseline: s(false), after: [s(false), s(false)] }, { verdict: "pass", baseline: s(false), after: [s(false)] }), "not-redirected");
    eq(P.tilesetOutcome({ verdict: "pass", baseline: s(true), after: [s(true)] }, { verdict: "pass", baseline: s(false), after: [s(false)] }), "inconclusive");
    eq(P.tilesetOutcome({ verdict: "pass", baseline: s(false), after: [s(true)] }, { verdict: "pass", baseline: s(false), after: [s(true)] }), "inconclusive");
    eq(P.tilesetOutcome({ verdict: "crash", baseline: null, after: [] }, { verdict: "pass", baseline: s(false), after: [s(false)] }), "crash");
  });

  // ---- the probe's files ----
  const scenePath = join(MODS_DIR, "_artprobe", "art", "probe.scene.json");
  const scene = JSON.parse(readFileSync(scenePath, "utf8")) as any;
  test("probe.scene.json: ArtProbeLoc is exported; it places the marker at the origin, the cxform orientation square at (310, 30) and one text per LOC_PROBE_BOXES entry at its (x, y) with its text / html; the scene validates", () => {
    need();
    eq(scene.exports.ArtProbeLoc, "ArtProbeLoc");
    const sp = scene.sprites.ArtProbeLoc;
    assert(!!sp, "sprite ArtProbeLoc");
    const keys = sp.layers.map((l: any) => l.keys[0]);
    assert(keys.some((k: any) => k.ref === "checker" && k.x === 0 && k.y === 0), "marker at the origin");
    assert(keys.some((k: any) => k.ref === "sq" && k.x === 310 && k.y === 30 && k.cxform && k.cxform.mul.join(",") === "1,0,0,1"), "cxform square");
    for (const b of P.LOC_PROBE_BOXES as Array<{ id: string; text: string; html: boolean; x: number; y: number; width: number; height: number }>) {
      const k = keys.find((k: any) => k.ref === b.id);
      assert(!!k && k.x === b.x && k.y === b.y, `${b.id} placed at ${b.x},${b.y}`);
      const t = scene.texts[b.id];
      eq(t.text, b.text, b.id); eq(t.html !== false, b.html, b.id); eq(t.width, b.width, b.id); eq(t.height, b.height, b.id);
    }
    const v = validateScene(scene) as any;
    assert(v.ok, JSON.stringify(v.findings.filter((f: any) => f.severity === "error")));
  });

  test("the built probe.swf: the plain key boxes' DefineEditText initial text is the key byte-for-byte, the HTML ones wrap it in vanilla's <p><font>", () => {
    const tags = flattenTags((readSwf(emitSwf(scene).bytes) as any).tags) as any[];
    const texts = tags.filter((t) => t.name === "DefineEditText").map((t) => t.editText.initialText as string);
    assert(texts.includes("ENEMY_TOMTOM_NAME") && texts.includes("ARTPROBE_LOCTEST"), texts.join(" | "));
    assert(texts.some((s) => /^<p align="center"><font [^>]*>ENEMY_TOMTOM_NAME<\/font><\/p>$/.test(s)), "HTML vanilla key");
    assert(texts.some((s) => /^<p align="center"><font [^>]*>ARTPROBE_LOCTEST<\/font><\/p>$/.test(s)), "HTML mod key");
  });

  test("_artprobe: combined.csv.append adds ARTPROBE_LOCTEST (12 columns, en \"LOCALIZED OK\"); enemies.gon.append defines ArtProbeLoc (a Rat drawn by ArtProbeLoc); render-loctext.mewtest seeds 42, enters TacticsTest and spawns ArtProbeLoc", () => {
    const csv = readFileSync(join(MODS_DIR, "_artprobe", "data", "text", "combined.csv.append"), "utf8").split(/\r?\n/).filter((l) => l.startsWith("ARTPROBE_LOCTEST,"));
    eq(csv.length, 1);
    const cells = csv[0]!.split(",");
    eq(cells.length, 12); eq(cells[1], "LOCALIZED OK");
    const gon = readFileSync(join(MODS_DIR, "_artprobe", "data", "characters", "enemies.gon.append"), "utf8");
    assert(/ArtProbeLoc\s*\{[\s\S]*?variant_of Rat[\s\S]*?movieclip ArtProbeLoc/.test(gon), "ArtProbeLoc in enemies.gon.append");
    const plan = parseScript(readFileSync(join(MODS_DIR, "_artprobe", "tests", "render-loctext.mewtest"), "utf8"), { owningMod: "_artprobe", name: "render-loctext" });
    assert(plan.ok, JSON.stringify(plan.errors));
    assert(/seed 42/.test(plan.body) && /enter TacticsTest/.test(plan.body) && /cmd spawn ArtProbeLoc/.test(plan.body), plan.body);
    assert(!plan.mods.includes("_tileprobe"), "no tileset overlay in the loc probe");
  });

  test("_tileprobe: data/tilesets.gon.merge is exactly `alley { Rat ArtProbe }`; render-tileset-redirect.mewtest (mods _artprobe + _tileprobe) and the control render-tileset-control.mewtest (no _tileprobe) both seed 42, enter TacticsTest, shoot a pre-spawn baseline and spawn a plain Rat", () => {
    const v = toValue(parse(readFileSync(join(MODS_DIR, "_tileprobe", "data", "tilesets.gon.merge"), "utf8"))) as any;
    eq(v.t, "obj"); eq(v.entries.length, 1); eq(v.entries[0].key, "alley");
    const alley = v.entries[0].value;
    eq(alley.entries.length, 1); eq(alley.entries[0].key, "Rat"); eq(alley.entries[0].value.raw, "ArtProbe");
    for (const [mod, name, withOverlay] of [["_tileprobe", "render-tileset-redirect", true], ["_artprobe", "render-tileset-control", false]] as const) {
      const plan = parseScript(readFileSync(join(MODS_DIR, mod, "tests", `${name}.mewtest`), "utf8"), { owningMod: mod, name });
      assert(plan.ok, `${name}: ${JSON.stringify(plan.errors)}`);
      assert(plan.mods.includes("_artprobe"), `${name}: _artprobe (the ArtProbe clip)`);
      eq(plan.mods.includes("_tileprobe"), withOverlay, `${name}: _tileprobe`);
      assert(/seed 42/.test(plan.body) && /enter TacticsTest/.test(plan.body) && /shot "baseline"/.test(plan.body) && /cmd spawn Rat\n/.test(plan.body), `${name}: ${plan.body}`);
      assert(plan.body.indexOf('shot "baseline"') < plan.body.indexOf("cmd spawn Rat"), `${name}: baseline before the spawn`);
    }
  });

  const BASE_TILESETS = join(EXTRACTED_DATA, "tilesets.gon");
  if (!existsSync(BASE_TILESETS)) console.log(`  (skipped: base tilesets.gon not extracted at ${BASE_TILESETS})`);
  else {
    test("T1: no vanilla tileset has a key `Rat` (the redirect key does not collide with the slot names), alley exists, and the _tileprobe merge preview changes alley only (it gains Rat ArtProbe; Rubble etc. kept)", () => {
      const base = toValue(parse(readFileSync(BASE_TILESETS, "utf8"))) as any;
      assert(base.entries.some((e: any) => e.key === "alley"), "alley");
      for (const e of base.entries) if (e.value.t === "obj") assert(!e.value.entries.some((x: any) => x.key === "Rat"), `${e.key} has no Rat key`);
      const p = previewMerge("_tileprobe", "data/tilesets.gon.merge") as any;
      assert(p.ok && p.kind === "gon", JSON.stringify(p).slice(0, 300));
      eq(p.touched.map((t: any) => `${t.key}:${t.status}`).join(","), "alley:changed");
      assert(/Rat\s+ArtProbe/.test(p.touched[0].effective) && /static_1x1_a\s+Rubble/.test(p.touched[0].effective), p.touched[0].effective);
    });
    test("T1: _tileprobe and _artprobe validate with zero errors (ARTPROBE_LOCTEST has every column; the overlay target tilesets.gon exists)", () => {
      for (const m of ["_tileprobe", "_artprobe"]) { const r = validateMod(m); assert(r.ok, `${m}: ${JSON.stringify(r.findings.filter((f) => f.severity === "error"))}`); }
    });
  }

  // ---- the observed outcomes (T2 fixtures) ----
  test("OBSERVED 2026-10-22 fixture (artprobe-loctext-summary.json): the loc probe passed with the real save unchanged, the marker and every box were found, and the four outcomes are recorded", () => {
    const p = join(HERE, "fixtures", "ingame", "artprobe-loctext-summary.json");
    assert(existsSync(p), "written by npm run test:artprobe -- --loctext");
    const j = JSON.parse(readFileSync(p, "utf8")) as any;
    eq(j.verdict, "pass");
    assert(/real save file\(s\) unchanged/.test(j.reason), j.reason);
    assert(j.marker && j.marker.found, "marker found");
    for (const k of ["vanillaHtml", "vanillaPlain", "modHtml", "modPlain"]) assert(["substituted", "literal", "unreadable"].includes(j.outcomes[k]), `${k}: ${j.outcomes[k]}`);
    eq(j.outcomes.vanillaHtml, "substituted", "a vanilla key in vanilla's HTML wrapper is localized");
    eq(j.outcomes.modHtml, "substituted", "a key added by combined.csv.append is localized too");
  });

  test("OBSERVED 2026-10-22 fixture (artprobe-tileset-summary.json): with `alley { Rat ArtProbe }` a spawned plain Rat draws our ArtProbe clip (marker after the spawn, not before); the control without the overlay shows no marker; both runs passed with the real save unchanged", () => {
    const p = join(HERE, "fixtures", "ingame", "artprobe-tileset-summary.json");
    assert(existsSync(p), "written by npm run test:artprobe -- --tileset");
    const j = JSON.parse(readFileSync(p, "utf8")) as any;
    eq(j.redirect.verdict, "pass"); eq(j.control.verdict, "pass");
    assert(/real save file\(s\) unchanged/.test(j.redirect.reason) && /real save file\(s\) unchanged/.test(j.control.reason), "saves unchanged");
    eq(j.outcome, "redirected");
  });
}
