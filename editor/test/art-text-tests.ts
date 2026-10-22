// Text (art build-out I) the way the base game does it: a DefineEditText that names a font class exported by the
// game's own swfs/fonts.swf (no glyphs in our file) plus an ImportAssets2("fonts.swf") with zero assets, exactly like
// vanilla ability_icons.swf and ui.swf. Pinned against the installed game (T1), written + read back (T0), drawn by
// the game (T2, the art probe).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exampleScene, validateScene } from "../src/core/art/scene.ts";
import { readSwf, readTags, flattenTags } from "../src/core/art/swf-reader.ts";
import * as emitter from "../src/core/art/swf-emitter.ts";
import { SWF_RULE_CODES } from "../src/core/art/swf-rules.ts";
import * as api from "../src/core/api.ts";
import { loadLocalization } from "../src/core/base-data.ts";
import { SWF_GATE_VARIANTS } from "../src/core/art/art-io.ts";
import { vanillaSwfDir } from "../src/core/repo.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const VANILLA_DIR = vanillaSwfDir(); // repo.ts: MEWGENICS_VANILLA_SWF_DIR, else <extracted root>/swfs

export async function runArtTextTests(test: TestFn, assert: AssertFn, eq: EqFn): Promise<void> {
  console.log("\n# Art: text (DefineEditText with a game font class + ImportAssets2 fonts.swf)");
  const fx = JSON.parse(readFileSync(join(HERE, "fixtures", "art", "game-fonts.json"), "utf8")) as { fonts: string[]; abilityIcons: { importUrl: string; importCount: number; editTextFlags: string; fontClass: string; fontHeightTwips: number; align: string } };
  let T: Record<string, any> = {};
  let err = "";
  try { T = await import("../src/core/art/text.ts"); } catch (e) { err = e instanceof Error ? e.message : String(e); }
  const need = () => { if (err) throw new Error(`text.ts: ${err}`); };
  const E = emitter as Record<string, any>;

  test("GAME_FONTS is the fixture's font classes (what swfs/fonts.swf exports)", () => {
    need();
    eq([...T.GAME_FONTS].sort().join(","), fx.fonts.join(","));
  });

  const fontsPath = join(VANILLA_DIR, "fonts.swf"), iconsPath = join(VANILLA_DIR, "ability_icons.swf");
  if (!existsSync(fontsPath) || !existsSync(iconsPath)) console.log(`  (skipped: vanilla fonts.swf / ability_icons.swf not extracted at ${VANILLA_DIR})`);
  else test("T1: the fixture matches the installed game — fonts.swf's SymbolClass, ability_icons.swf's ImportAssets2 (fonts.swf, 0 assets) and its DefineEditText (flags, font class, height, align)", () => {
    const fs = readSwf(new Uint8Array(readFileSync(fontsPath))) as any;
    const sc = fs.tags.find((t: any) => t.name === "SymbolClass");
    eq((sc.entries || sc.symbols).map((e: any) => e.name).sort().join(","), fx.fonts.join(","));
    const ai = flattenTags((readSwf(new Uint8Array(readFileSync(iconsPath))) as any).tags) as any[];
    const imp = ai.find((t) => t.name === "ImportAssets2");
    eq(imp.importUrl, fx.abilityIcons.importUrl); eq(imp.importCount, fx.abilityIcons.importCount);
    const et = ai.find((t) => t.name === "DefineEditText").editText;
    eq(et.flags.toString(16).padStart(4, "0"), fx.abilityIcons.editTextFlags);
    eq(et.fontClass, fx.abilityIcons.fontClass); eq(et.fontHeight, fx.abilityIcons.fontHeightTwips); eq(et.align, fx.abilityIcons.align);
    assert(/^<p align="center">/.test(et.initialText), et.initialText);
  });

  const withText = () => {
    const sc = exampleScene("tx") as any;
    sc.texts = { title: { text: "Hello", font: "Peralta", size: 24, color: "#ffffff", align: "center", width: 200, height: 40 } };
    sc.sprites.Starter.layers.push({ name: "title", depth: 50, keys: [{ frame: 0, ref: "title", x: 0, y: -80 }] });
    return sc;
  };

  test("validateScene: a text is a placeable character; text-font (not a game font class), text-empty, text-size, text-box errors; dup-id across texts", () => {
    assert((validateScene(withText()) as any).ok, JSON.stringify((validateScene(withText()) as any).findings));
    const bad = withText();
    bad.texts.title.font = "Arial";
    bad.texts.empty = { text: "", font: "Peralta", size: 0, width: 0, height: 10 };
    bad.texts.body = { text: "x", font: "Peralta", size: 10, width: 10, height: 10 };
    const codes = (validateScene(bad) as any).findings.filter((f: any) => f.severity === "error").map((f: any) => f.code);
    for (const c of ["text-font", "text-empty", "text-size", "text-box", "dup-id"]) assert(codes.includes(c), `${c}: ${codes.join(",")}`);
  });

  test("encodeDefineEditText round-trips through the reader with vanilla's flags (eca3), the font class, height in twips, colour, align and the HTML initial text", () => {
    need();
    const bytes = T.encodeDefineEditText(9, { text: "Hi <there>", font: "Edmundm", size: 12, color: "#ff2020", align: "right", width: 100, height: 20 });
    const t = readTags(bytes, 0, bytes.length)[0] as any;
    eq(t.name, "DefineEditText");
    const et = t.editText;
    eq(et.id, 9); eq(et.flags.toString(16), fx.abilityIcons.editTextFlags); eq(et.fontClass, "Edmundm"); eq(et.fontHeight, 240);
    eq(et.color.r, 255); eq(et.color.g, 32); eq(et.align, "right");
    eq(et.bounds.xmax - et.bounds.xmin, 2000);
    assert(et.initialText.includes("Hi &lt;there&gt;") && /^<p align="right">/.test(et.initialText), et.initialText);
  });

  test("html: false emits the DefineEditText without the HTML flag (eca1) and with the raw string as its initial text — the loc-key probe's plain variant (a key must reach has_key_current_lang byte-for-byte)", () => {
    need();
    const bytes = T.encodeDefineEditText(3, { text: "ENEMY_TOMTOM_NAME", font: "Peralta", size: 24, color: "#00ffa0", align: "center", width: 300, height: 40, html: false });
    const et = (readTags(bytes, 0, bytes.length)[0] as any).editText;
    eq(et.flags.toString(16), "eca1");
    eq(et.initialText, "ENEMY_TOMTOM_NAME");
    eq(et.fontClass, "Peralta");
    const html = (readTags(T.encodeDefineEditText(3, { text: "A&B", size: 24, width: 300, height: 40, html: true }), 0, 999)[0] as any).editText;
    eq(html.flags.toString(16), "eca3", "html: true is the default shape");
    const raw = (readTags(T.encodeDefineEditText(3, { text: "A&B", size: 24, width: 300, height: 40, html: false }), 0, 999)[0] as any).editText;
    eq(raw.initialText, "A&B", "no entity escaping without HTML");
  });

  test("textProblems: html must be a boolean when given", () => {
    need();
    const codes = T.textProblems({ text: "x", size: 10, width: 10, height: 10, html: "no" }).map((p: any) => p.code);
    assert(codes.includes("text-html"), codes.join(","));
    eq(T.textProblems({ text: "x", size: 10, width: 10, height: 10, html: false }).length, 0);
  });

  test("emitSwf: a scene with text gets one ImportAssets2(fonts.swf, 0 assets) before its first DefineEditText; a scene without text gets none", () => {
    const plain = (readSwf(emitter.emitSwf(exampleScene("tx")).bytes) as any).tags.map((t: any) => t.name);
    assert(!plain.includes("ImportAssets2") && !plain.includes("DefineEditText"), plain.join(","));
    const r = emitter.emitSwf(withText() as any);
    assert(!r.findings.some((f) => f.severity === "error"), JSON.stringify(r.findings));
    const tags = (readSwf(r.bytes) as any).tags;
    const names = tags.map((t: any) => t.name);
    eq(names.filter((n: string) => n === "ImportAssets2").length, 1);
    assert(names.indexOf("ImportAssets2") < names.indexOf("DefineEditText"), names.join(","));
    const imp = tags.find((t: any) => t.name === "ImportAssets2");
    eq(imp.importUrl, "fonts.swf"); eq(imp.importCount, 0);
  });

  test("the SWF gate has a text variant (the icon with a Peralta DefineEditText), expected to boot", () => {
    const v = (SWF_GATE_VARIANTS as Record<string, any>).text;
    assert(!!v, "variant exists");
    eq(v.expect, "pass");
    const names = flattenTags((readSwf(E.minimalGateSwf({ withAbc: false, linkage: v.linkage, label: "x", layout: v.layout, text: v.text })) as any).tags).map((t: any) => t.name);
    assert(names.includes("DefineEditText") && names.includes("ImportAssets2"), names.join(","));
  });

  test("preview-gl.ts draws texts (Canvas2D fillText; the GL path through a text texture)", () => {
    const src = readFileSync(join(HERE, "..", "web", "src", "art", "preview-gl.ts"), "utf8");
    assert(/fillText\(/.test(src), "fillText");
    assert(/scene\.texts/.test(src), "reads scene.texts");
  });

  // ---- text-loc-key-html: a key text must be plain (OBSERVED 2026-10-22, render-loctext.mewtest) ----------------------
  const keyScene = (texts: Record<string, any>) => { const sc = exampleScene("lk") as any; sc.texts = texts; return sc; };
  const box = { font: "Peralta", size: 22, width: 300, height: 40 };
  const lkFindings = (sc: any, opts?: any) => ((validateScene as any)(sc, opts).findings as any[]).filter((f) => f.code === "text-loc-key-html");
  const lookup = (key: string) => (key === "KEYWORD_POISON" ? "base" : key === "mymod_hello" ? "mod" : null);

  test("validateScene: text-loc-key-html (warning) when an HTML text is exactly a key; none when html: false, for a plain word, or for a wrapper of several words that merely contains a key", () => {
    const sc = keyScene({
      htmlKey: { text: "KEYWORD_POISON", ...box },
      plainKey: { text: "KEYWORD_POISON", ...box, html: false },
      htmlWord: { text: "Hello", ...box },
      htmlWords: { text: "Poison KEYWORD_POISON now", ...box },
      htmlModKey: { text: "mymod_hello", ...box },
      htmlShape: { text: "SOME_UNKNOWN_KEY", ...box },
      explicitHtml: { text: "SOME_UNKNOWN_KEY", ...box, html: true },
    });
    const f = lkFindings(sc, { locKey: lookup });
    eq(f.map((x) => x.path).sort().join(","), "texts.explicitHtml,texts.htmlKey,texts.htmlModKey,texts.htmlShape");
    for (const x of f) eq(x.severity, "warning");
    assert((validateScene as any)(sc, { locKey: lookup }).ok, "a warning does not fail the scene");
  });
  test("text-loc-key-html says which test fired (base combined.csv / this mod's combined.csv.append / the key shape) and how to fix it (html: false, the Art-mode plain (localized) box)", () => {
    const f = lkFindings(keyScene({ a: { text: "KEYWORD_POISON", ...box }, b: { text: "mymod_hello", ...box }, c: { text: "SOME_UNKNOWN_KEY", ...box } }), { locKey: lookup });
    const by = Object.fromEntries(f.map((x) => [x.path, x.message as string]));
    assert(/base combined\.csv/.test(by["texts.a"]!) && /key shape/.test(by["texts.a"]!), by["texts.a"]!);
    assert(/combined\.csv\.append/.test(by["texts.b"]!) && !/key shape/.test(by["texts.b"]!), by["texts.b"]!);
    assert(/key shape/.test(by["texts.c"]!) && !/base combined/.test(by["texts.c"]!) && !/csv\.append/.test(by["texts.c"]!), by["texts.c"]!);
    for (const m of Object.values(by)) assert(/"html": false/.test(m) && /plain \(localized\)/.test(m) && /plain text/.test(m), m);
  });
  test("text-loc-key-html without a loc lookup (pure / live editing): only the key shape ^[A-Z][A-Z0-9_]{2,}$ fires", () => {
    const f = lkFindings(keyScene({ a: { text: "KEYWORD_POISON", ...box }, b: { text: "mymod_hello", ...box }, c: { text: "HP", ...box }, d: { text: "Ab_C", ...box } }));
    eq(f.map((x) => x.path).join(","), "texts.a");
  });
  test("SWF_RULE_CODES lists text-loc-key-html (warning, scene)", () => {
    const c = (SWF_RULE_CODES as Record<string, any>)["text-loc-key-html"];
    assert(!!c && c.severity === "warning" && c.where.join("+") === "scene", JSON.stringify(c));
  });

  test("api.validateArtScene(scene, mod) and read_art_scene feed the lookup from the mod's combined.csv.append and the base combined.csv (mods/_artprobe, the loc-key probe)", () => {
    const sc = keyScene({ m: { text: "ARTPROBE_LOCTEST", ...box }, b: { text: "ENEMY_TOMTOM_NAME", ...box } });
    const f = ((api.validateArtScene as any)(sc, "_artprobe").findings as any[]).filter((x) => x.code === "text-loc-key-html");
    const by = Object.fromEntries(f.map((x) => [x.path, x.message as string]));
    assert(/combined\.csv\.append/.test(by["texts.m"] || ""), JSON.stringify(f));
    if (loadLocalization().rows.has("ENEMY_TOMTOM_NAME")) assert(/base combined\.csv/.test(by["texts.b"] || ""), JSON.stringify(f));
    else console.log("  (skipped: the base half of text-loc-key-html — no .extracted/ combined.csv)");
    const rd = api.readArtScene("_artprobe", "art/probe.scene.json") as any;
    const paths = (rd.findings as any[]).filter((x) => x.code === "text-loc-key-html").map((x) => x.path);
    assert(paths.includes("texts.keyModHtml") && paths.includes("texts.keyVanillaHtml"), paths.join(","));
    assert(!paths.some((p: string) => /Plain$/.test(p)) && !paths.includes("texts.valueMod") && !paths.includes("texts.valueVanilla"), paths.join(","));
  });

  test("OBSERVED 2026-10-20 fixture: the game draws our DefineEditText in its own font (the probe's text box has text-coloured pixels)", () => {
    const j = JSON.parse(readFileSync(join(HERE, "fixtures", "ingame", "artprobe-summary.json"), "utf8")) as { summary: { text?: string } };
    eq(j.summary.text, "drawn");
  });
}
