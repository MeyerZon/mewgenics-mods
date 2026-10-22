// Level files (`levels/**/*.lvl`, the encounter layouts a map's `levels { folder … }` pools draw from):
// the binary codec (src/core/level/lvl.ts), the room builder and the validator's .lvl rules.
//
// T0 runs on synthetic bytes written here (never game bytes); T1 round-trips every vanilla level under
// .extracted/levels/ byte for byte when that copy exists (`python -I tools/gpak.py extract .extracted --prefix levels/`).

import { existsSync, readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decodeLvl, encodeLvl, buildRoom, lvlIds, LvlFormatError } from "../src/core/level/lvl.ts";
import { validateMod } from "../src/core/validate/validator.ts";
import { extractedPath } from "../src/core/repo.ts";
import { newFromTemplate } from "../src/core/templates.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

/** Little-endian byte writer for hand-made fixtures. */
function bytes(parts: Array<["u32" | "u16", number] | ["str", string]>): Uint8Array {
  const out: number[] = [];
  for (const p of parts) {
    if (p[0] === "u32") { const v = p[1]; out.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255); }
    else if (p[0] === "u16") { const v = p[1]; out.push(v & 255, (v >>> 8) & 255); }
    else { const s = String(p[1]); const n = s.length; out.push(n & 255, (n >>> 8) & 255, 0, 0); for (const c of s) out.push(c.charCodeAt(0)); }
  }
  return Uint8Array.from(out);
}

/** A 3x2 v2 level: one water tile, one random tile cell, a player spawn, a Rat and a random prop object. */
function sample(): Uint8Array {
  return bytes([
    ["u32", 2], ["u32", 3], ["u32", 2], ["u32", 1], ["u32", 3], ["u32", 0], ["u32", 0], ["u32", 3], ["u32", 2],
    ["str", "spawns.gon"], ["str", "tiles.gon"], ["u32", 0], ["u32", 0],
    // grid, row-major from (0,0): 0 1 0 / 0 0 <random 2:3, 3:1>
    ["u16", 0], ["u16", 1], ["u16", 0], ["u16", 0], ["u16", 0], ["u16", 0xffff], ["u16", 2], ["u16", 2], ["u16", 3], ["u16", 3], ["u16", 1],
    // objects
    ["u16", 0], ["u16", 0], ["u32", 1],
    ["u16", 2], ["u16", 1], ["u32", 11],
    ["u16", 1], ["u16", 1], ["u32", 0xffff], ["u16", 2], ["u16", 5010], ["u16", 1], ["u16", 0], ["u16", 1],
    ["u32", 0],
  ]);
}

export function runLevelTests(test: TestFn, assert: AssertFn, eq: EqFn): void {
  /** the harness eq is strict (===): compare structure through JSON */
  const same = (a: unknown, b: unknown, msg?: string): void => eq(JSON.stringify(a), JSON.stringify(b), msg);
  test("lvl: decodes the header, both palettes, the grid and the objects", () => {
    const f = decodeLvl(sample());
    same(f.version, 2);
    same([f.width, f.height], [3, 2]);
    same(f.objectPalette, "spawns.gon");
    same(f.tilePalette, "tiles.gon");
    same(f.tiles.length, 6);
    same(f.tiles[1], 1);
    same(f.tiles[5], [{ id: 2, weight: 3 }, { id: 3, weight: 1 }], "0xffff cell = weighted random tile list");
    same(f.objects.length, 3);
    same(f.objects[0], { x: 0, y: 0, id: 1 });
    same(f.objects[1], { x: 2, y: 1, id: 11 });
    same(f.objects[2], { x: 1, y: 1, id: [{ id: 5010, weight: 1 }, { id: 0, weight: 1 }] }, "0xffff object = weighted random spawn list (0 = nothing)");
  });

  test("lvl: encode(decode(x)) is byte-identical", () => {
    const b = sample();
    same(Buffer.from(encodeLvl(decodeLvl(b))).toString("hex"), Buffer.from(b).toString("hex"));
  });

  test("lvl: version 1 has an empty tile palette string", () => {
    const b = bytes([
      ["u32", 1], ["u32", 1], ["u32", 1], ["u32", 1], ["u32", 1], ["u32", 0], ["u32", 0], ["u32", 1], ["u32", 1],
      ["str", "spawns.gon"], ["str", ""], ["u32", 0], ["u32", 0], ["u16", 2], ["u16", 0], ["u16", 0], ["u32", 1], ["u32", 0],
    ]);
    const f = decodeLvl(b);
    same(f.version, 1);
    same(f.tilePalette, "");
    same(f.tiles, [2]);
    same(f.objects, [{ x: 0, y: 0, id: 1 }]);
    same(Buffer.from(encodeLvl(f)).toString("hex"), Buffer.from(b).toString("hex"));
  });

  test("lvl: truncated or trailing bytes are a format error", () => {
    const b = sample();
    let threw = "";
    try { decodeLvl(b.slice(0, b.length - 3)); } catch (e) { threw = e instanceof LvlFormatError ? "fmt" : String(e); }
    same(threw, "fmt", "truncated");
    threw = "";
    try { decodeLvl(Uint8Array.from([...b, 0])); } catch (e) { threw = e instanceof LvlFormatError ? "fmt" : String(e); }
    same(threw, "fmt", "trailing byte");
  });

  test("lvl: buildRoom writes the vanilla v2 shape (10x10 default) and round-trips", () => {
    const f = buildRoom({ objects: [{ x: 1, y: 0, id: 1 }, { x: 5, y: 8, id: 9001 }], tiles: [{ x: 0, y: 5, id: 1 }] });
    same([f.version, f.width, f.height, f.objectPalette, f.tilePalette], [2, 10, 10, "spawns.gon", "tiles.gon"]);
    same(f.tiles[5 * 10 + 0], 1, "row-major: index = y * width + x");
    const again = decodeLvl(encodeLvl(f));
    same(again, f);
    same(lvlIds(f), { objects: [1, 9001], tiles: [0, 1] });
  });

  test("lvl: buildRoom rejects out-of-grid positions and ids above 0xfffe", () => {
    let msg = "";
    try { buildRoom({ objects: [{ x: 10, y: 0, id: 1 }] }); } catch (e) { msg = String(e instanceof Error ? e.message : e); }
    assert(/outside the 10x10 grid/.test(msg), msg);
    msg = "";
    try { buildRoom({ objects: [{ x: 0, y: 0, id: 0xffff }] }); } catch (e) { msg = String(e instanceof Error ? e.message : e); }
    assert(/0xffff/.test(msg), msg);
  });

  // ---- the validator's .lvl rules (synthetic base + fixture mod) ----
  const base = join(mkdtempSync(join(tmpdir(), "mewged-lvl-")), "data");
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "spawns.gon"), "0 { editor { name Empty } }\n1 { utility PlayerSpawn }\n11 { object Rat }\n5010 { object TrashBag }\n");
  writeFileSync(join(base, "tiles.gon"), "0 { editor { name Empty } }\n1 { tile WaterTile }\n2 { tile GrassTile }\n3 { tile BlankTile }\n");
  const mkMod = (files: Record<string, Uint8Array | string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "mewged-lvlmod-"));
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    return dir;
  };
  const codes = (dir: string): string[] => validateMod("lvlfixture", undefined, { modDir: dir, extractedData: base, nativeBuild: null, components: [], registeredNames: [] }).findings.map((f) => `${f.severity}:${f.code}`);

  test("validator: a new .lvl with known ids is clean (no whole-file-replace)", () => {
    const c = codes(mkMod({ "levels/mine/room.lvl": sample() }));
    assert(!c.some((x) => x.includes("whole-file-replace") || x.startsWith("error")), c.join(", "));
  });

  test("validator: lvl ids resolve against the mod's own spawns.gon.append", () => {
    const lv = encodeLvl(buildRoom({ objects: [{ x: 0, y: 0, id: 1 }, { x: 3, y: 3, id: 9001 }] }));
    const without = codes(mkMod({ "levels/mine/room.lvl": lv }));
    assert(without.includes("error:lvl-unknown-spawn-id"), without.join(", "));
    const withAppend = codes(mkMod({ "levels/mine/room.lvl": lv, "data/spawns.gon.append": "9001 { object Rat }\n" }));
    assert(!withAppend.includes("error:lvl-unknown-spawn-id"), withAppend.join(", "));
  });

  test("validator: unknown tile id, no player spawn and a broken file are reported", () => {
    const c1 = codes(mkMod({ "levels/mine/a.lvl": encodeLvl(buildRoom({ objects: [{ x: 0, y: 0, id: 11 }], tiles: [{ x: 1, y: 1, id: 77 }] })) }));
    assert(c1.includes("error:lvl-unknown-tile-id"), c1.join(", "));
    assert(c1.includes("warning:lvl-no-player-spawn"), c1.join(", "));
    const c2 = codes(mkMod({ "levels/mine/b.lvl": Uint8Array.from([2, 0, 0]) }));
    assert(c2.includes("error:lvl-bad-format"), c2.join(", "));
  });

  test("validator: a .lvl outside levels/ is flagged (the game only reads levels/<path>.lvl)", () => {
    const c = codes(mkMod({ "data/room.lvl": sample() }));
    assert(c.includes("warning:lvl-outside-levels"), c.join(", "));
  });

  // ---- new_from_template kinds `room` and `tileset-variant` (dry runs: nothing is written) ----
  test("template room: a dry run plans levels/<folder>/<name>.lvl that decodes, with object names resolved to spawn ids", () => {
    const r = newFromTemplate("anymod", "room", "my_room", {
      dryRun: true, folder: "mymod", extractedData: base,
      objects: [{ x: 1, y: 0, object: "PlayerSpawn" }, { x: 4, y: 7, object: "Rat" }, { x: 5, y: 5, id: 5010 }],
      tiles: [{ x: 0, y: 4, id: 1 }],
    });
    assert(r.ok && "dryRun" in r, JSON.stringify(r));
    if (!r.ok || !("dryRun" in r)) return;
    same(r.files.map((f) => f.relPath), ["levels/mymod/my_room.lvl"]);
    const b64 = r.files[0]!.base64;
    assert(typeof b64 === "string", "binary plan file carries base64");
    const f = decodeLvl(Buffer.from(b64 ?? "", "base64"));
    same(f.objects, [{ x: 1, y: 0, id: 1 }, { x: 4, y: 7, id: 11 }, { x: 5, y: 5, id: 5010 }]);
    same(f.tiles[4 * 10], 1);
    assert(/load mymod\/my_room/.test(r.hint ?? ""), `hint names the console command: ${r.hint}`);
  });

  test("template room: an unknown object name and a bad file name are refused", () => {
    const r1 = newFromTemplate("anymod", "room", "r", { dryRun: true, extractedData: base, objects: [{ x: 0, y: 0, object: "NoSuchThing" }] });
    assert(!r1.ok && /NoSuchThing/.test(r1.error), JSON.stringify(r1));
    const r2 = newFromTemplate("anymod", "room", "../evil", { dryRun: true, extractedData: base });
    assert(!r2.ok, JSON.stringify(r2));
  });

  test("template room: with no objects it scaffolds 4 player spawns and 2 Rats", () => {
    const r = newFromTemplate("anymod", "room", "starter", { dryRun: true, extractedData: base });
    assert(r.ok && "dryRun" in r, JSON.stringify(r));
    if (!r.ok || !("dryRun" in r)) return;
    const f = decodeLvl(Buffer.from(r.files[0]!.base64 ?? "", "base64"));
    same(lvlIds(f).objects, [1, 11]);
    same(f.objects.filter((o) => o.id === 1).length, 4);
  });

  writeFileSync(join(base, "tilesets.gon"), ["default_tileset alley", "", "alley {", "    combat_background AlleyBGTest", "    static_1x1_a Rubble", "    reverb {", "        battle {", "            preset Alley", "        }", "    }", "}", ""].join("\n"));
  test("template tileset-variant: copies a vanilla tileset under a new name into data/tilesets.gon.append", () => {
    const r = newFromTemplate("anymod", "tileset-variant", "my_yard", { dryRun: true, parent: "alley", extractedData: base });
    assert(r.ok && "dryRun" in r, JSON.stringify(r));
    if (!r.ok || !("dryRun" in r)) return;
    same(r.files.map((f) => f.relPath), ["data/tilesets.gon.append"]);
    const text = r.files[0]!.content;
    assert(/^my_yard \{/m.test(text) && /combat_background AlleyBGTest/.test(text) && /preset Alley/.test(text), text);
    assert(/tileset my_yard/.test(r.hint ?? ""), `hint names the console command: ${r.hint}`);
    const bad = newFromTemplate("anymod", "tileset-variant", "x", { dryRun: true, parent: "nope", extractedData: base });
    assert(!bad.ok && /nope/.test(bad.error), JSON.stringify(bad));
    const clash = newFromTemplate("anymod", "tileset-variant", "alley", { dryRun: true, parent: "alley", extractedData: base });
    assert(!clash.ok && /already/.test(clash.error), JSON.stringify(clash));
  });

  // ---- T1: every vanilla level round-trips ----
  const root = extractedPath("levels");
  if (!existsSync(root)) {
    console.log("  (skipped: no .extracted/levels — `python -I tools/gpak.py extract .extracted --prefix levels/` for the vanilla round-trip)");
    return;
  }
  test("lvl (T1): every vanilla .lvl decodes and re-encodes byte for byte", () => {
    const files: string[] = [];
    const walk = (d: string): void => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".lvl")) files.push(p); } };
    walk(root);
    assert(files.length > 2000, `expected the ~2361 vanilla levels, found ${files.length}`);
    const bad: string[] = [];
    for (const p of files) {
      const b = readFileSync(p);
      try { if (!Buffer.from(encodeLvl(decodeLvl(b))).equals(b)) bad.push(p); } catch (e) { bad.push(`${p}: ${String(e)}`); }
    }
    same(bad.slice(0, 5), [], `${bad.length} of ${files.length} did not round-trip`);
  });
}
