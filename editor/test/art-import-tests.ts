// Importing vanilla symbols (the cat-parts import experiment): scene.imports names a symbol another game SWF exports
// (e.g. catparts.swf's CatTail); the writer emits ImportAssets2(url, [{ id, name }]) and keys place the imported id like
// a sprite — no game bytes copied into the mod. Whether the game resolves such an import is the experiment (T2).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exampleScene, validateScene } from "../src/core/art/scene.ts";
import { readSwf, flattenTags } from "../src/core/art/swf-reader.ts";
import * as emitter from "../src/core/art/swf-emitter.ts";
import { SWF_GATE_VARIANTS } from "../src/core/art/art-io.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const VANILLA_DIR = process.env.MEWGENICS_VANILLA_SWF_DIR || resolve(HERE, "../../.extracted/swfs");

export function runArtImportTests(test: TestFn, assert: AssertFn, eq: EqFn): void {
  console.log("\n# Art: importing vanilla symbols (ImportAssets2 with entries)");
  const fx = JSON.parse(readFileSync(join(HERE, "fixtures", "art", "vanilla-exports.json"), "utf8")) as Record<string, string[]>;
  const withImport = () => {
    const sc = exampleScene("im") as any;
    sc.imports = { vtail: { from: "catparts.swf", name: "CatTail" } };
    sc.sprites.Starter.layers.push({ name: "tail", depth: 60, keys: [{ frame: 0, ref: "vtail", x: -40, y: 0 }] });
    return sc;
  };

  const cp = join(VANILLA_DIR, "catparts.swf");
  if (!existsSync(cp)) console.log(`  (skipped: vanilla catparts.swf not extracted at ${VANILLA_DIR})`);
  else test("T1: vanilla-exports.json matches catparts.swf's SymbolClass (minus generated *_fla.* classes)", () => {
    const sc = (readSwf(new Uint8Array(readFileSync(cp))) as any).tags.find((t: any) => t.name === "SymbolClass");
    eq((sc.entries || sc.symbols).map((e: any) => e.name).filter((n: string) => !n.includes("_fla.")).sort().join(","), fx["catparts.swf"]!.join(","));
  });

  test("validateScene: an import is a placeable character; import-unknown for a name the source does not export, import-from for a non-.swf source, dup-id across imports", () => {
    assert((validateScene(withImport()) as any).ok, JSON.stringify((validateScene(withImport()) as any).findings));
    const bad = withImport();
    bad.imports.nope = { from: "catparts.swf", name: "CatWing" };
    bad.imports.body = { from: "catparts.swf", name: "CatBody" };
    bad.imports.weird = { from: "../x.exe", name: "Y" };
    const codes = (validateScene(bad) as any).findings.filter((f: any) => f.severity === "error").map((f: any) => f.code);
    for (const c of ["import-unknown", "import-from", "dup-id"]) assert(codes.includes(c), `${c}: ${codes.join(",")}`);
  });

  test("emitSwf: ImportAssets2(catparts.swf) with one { id, name: CatTail } entry before the first definition; the sprite places that id; no DefineSprite for it", () => {
    const r = emitter.emitSwf(withImport() as any);
    assert(!r.findings.some((f) => f.severity === "error"), JSON.stringify(r.findings));
    const swf = readSwf(r.bytes) as any;
    const imp = swf.tags.filter((t: any) => t.name === "ImportAssets2");
    eq(imp.length, 1);
    eq(imp[0].importUrl, "catparts.swf"); eq(imp[0].importCount, 1); eq(imp[0].imports[0].name, "CatTail");
    const id = imp[0].imports[0].id;
    const firstDef = swf.tags.findIndex((t: any) => /^Define(Shape|Sprite|Bits|EditText)/.test(t.name));
    assert(swf.tags.indexOf(imp[0]) < firstDef, "import first");
    assert(!swf.tags.some((t: any) => t.id === id && t.name !== "ImportAssets2"), "no local definition for the imported id");
    const places = flattenTags(swf.tags).filter((t: any) => t.place && t.place.characterId === id);
    assert(places.length >= 1, "the sprite places the imported id");
  });

  test("the SWF gate has an import variant (the icon plus an imported catparts.swf CatTail)", () => {
    const v = (SWF_GATE_VARIANTS as Record<string, any>).import;
    assert(!!v, "variant exists");
    const names = flattenTags((readSwf((emitter as any).minimalGateSwf({ withAbc: false, linkage: v.linkage, label: "x", layout: v.layout, importPart: v.importPart })) as any).tags).map((t: any) => t.name);
    assert(names.includes("ImportAssets2"), names.join(","));
  });

  test("OBSERVED fixture (artprobe-cat-summary.json): the import experiment's outcome is recorded", () => {
    const j = JSON.parse(readFileSync(join(HERE, "fixtures", "ingame", "artprobe-cat-summary.json"), "utf8")) as { importParts?: string };
    assert(j.importParts === "drawn" || j.importParts === "not-drawn", `importParts: ${j.importParts}`);
  });
}
