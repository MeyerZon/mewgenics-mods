// The Room editor (web UI "Rooms" mode, MCP read_level / write_level): the pure grid-edit helpers
// (src/core/level/edit.ts, bundled into the browser too), the level I/O on the one app surface
// (src/core/level/level-io.ts via api.ts: listLevels / readLevel / writeLevel / validateLevel / levelPalette),
// the zod body of the /api/level routes and the two MCP tools.
//
// T0 runs on synthetic bytes and a synthetic base (never game bytes), in a throwaway mod under mods/ that is removed
// at the end. T1 sends every vanilla level under .extracted/levels/ through the editor's wire path
// (decode → JSON → zod → encode) and wants the bytes back unchanged.

import { existsSync, readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decodeLvl, encodeLvl, buildRoom } from "../src/core/level/lvl.ts";
import type { LvlFile } from "../src/core/level/lvl.ts";
import { MODS_DIR, extractedPath } from "../src/core/repo.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

/** A failing import becomes a failing test, not a crashed runner. */
async function load(rel: string): Promise<Record<string, any> & { __error?: string }> {
  try {
    return (await import(rel)) as Record<string, any>;
  } catch (e) {
    return { __error: String(e instanceof Error ? e.message : e) };
  }
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

export async function runLevelEditorTests(test: TestFn, assert: AssertFn, eq: EqFn): Promise<void> {
  console.log("\n# Room editor (level edit helpers, level I/O, /api/level, MCP read_level / write_level)");
  const same = (a: unknown, b: unknown, msg?: string): void => eq(JSON.stringify(a), JSON.stringify(b), msg);
  const ed = await load("../src/core/level/edit.ts");
  const need = (m: Record<string, any> & { __error?: string }, what: string): void => {
    if (m.__error) throw new Error(`${what} did not load: ${m.__error}`);
  };
  const room = (): LvlFile => buildRoom({ objects: [{ x: 1, y: 0, id: 1 }, { x: 3, y: 8, id: 11 }], tiles: [{ x: 0, y: 5, id: 1 }] });

  // ---- pure grid-edit helpers ----
  test("level edit: paintTiles sets row-major cells, leaves the input untouched, and repainting the same cells changes nothing", () => {
    need(ed, "src/core/level/edit.ts");
    const a = room();
    const before = hex(encodeLvl(a));
    const b = ed.paintTiles(a, [{ x: 2, y: 3 }, { x: 4, y: 3 }], 2) as LvlFile;
    same(b.tiles[3 * 10 + 2], 2, "index = y * width + x");
    same(b.tiles[3 * 10 + 4], 2);
    same(hex(encodeLvl(a)), before, "the input level is not mutated");
    const c = ed.paintTiles(b, [{ x: 2, y: 3 }, { x: 2, y: 3 }], 2) as LvlFile;
    same(hex(encodeLvl(c)), hex(encodeLvl(b)), "a drag back over painted cells is idempotent");
    same(ed.cellAt(b, 4, 3), 2);
    const d = ed.paintTiles(b, [{ x: 10, y: 0 }, { x: -1, y: 2 }], 3) as LvlFile;
    same(hex(encodeLvl(d)), hex(encodeLvl(b)), "cells outside the grid are ignored");
  });

  test("level edit: placeObject replaces the first object on a cell (keeping its list position) or appends; removeObjects clears the cell", () => {
    need(ed, "src/core/level/edit.ts");
    const a = room();
    const b = ed.placeObject(a, 1, 0, 11) as LvlFile;
    same(b.objects, [{ x: 1, y: 0, id: 11 }, { x: 3, y: 8, id: 11 }], "replaced in place");
    const c = ed.placeObject(b, 5, 5, [{ id: 11, weight: 2 }, { id: 0, weight: 1 }]) as LvlFile;
    same(c.objects.length, 3);
    same(c.objects[2], { x: 5, y: 5, id: [{ id: 11, weight: 2 }, { id: 0, weight: 1 }] }, "appended with a random list");
    const stacked: LvlFile = { ...c, objects: [...c.objects, { x: 5, y: 5, id: 1 }] };
    same(ed.objectsAt(stacked, 5, 5).map((o: { index: number }) => o.index), [2, 3], "objectsAt lists every object on a cell (vanilla has 26 stacked cells)");
    const d = ed.removeObjects(stacked, 5, 5) as LvlFile;
    same(d.objects, [{ x: 1, y: 0, id: 11 }, { x: 3, y: 8, id: 11 }]);
    same(ed.setObjectPick(d, 1, 1).objects[1], { x: 3, y: 8, id: 1 });
  });

  test("level edit: random lists — asChoices / addChoice / updateChoice / removeChoice; removing the last choice leaves id 0 (empty)", () => {
    need(ed, "src/core/level/edit.ts");
    same(ed.asChoices(7), [{ id: 7, weight: 1 }]);
    same(ed.asChoices([{ id: 2, weight: 3 }]), [{ id: 2, weight: 3 }]);
    const l = ed.addChoice([{ id: 2, weight: 3 }], 5);
    same(l, [{ id: 2, weight: 3 }, { id: 5, weight: 1 }]);
    same(ed.updateChoice(l, 1, { weight: 9 }), [{ id: 2, weight: 3 }, { id: 5, weight: 9 }]);
    same(ed.removeChoice(l, 0), [{ id: 5, weight: 1 }]);
    same(ed.removeChoice([{ id: 5, weight: 1 }], 0), 0);
    same(ed.firstId([{ id: 4, weight: 1 }, { id: 6, weight: 1 }]), 4);
    same(ed.firstId(9), 9);
  });

  test("level edit: structuralErrors names out-of-grid objects, a wrong cell count, ids above 0xfffe, an empty random list and bad weights", () => {
    need(ed, "src/core/level/edit.ts");
    same(ed.structuralErrors(room()), []);
    const bad: LvlFile = { ...room(), objects: [{ x: 10, y: 0, id: 1 }, { x: 0, y: 0, id: 0xffff }, { x: 1, y: 1, id: [] }], tiles: [...room().tiles.slice(0, 99), [{ id: 1, weight: 70000 }]] };
    const errs = (ed.structuralErrors(bad) as string[]).join(" | ");
    assert(/\(10,0\).*outside/.test(errs), errs);
    assert(/0xffff|65535/.test(errs), errs);
    assert(/empty random list/.test(errs), errs);
    assert(/weight 70000/.test(errs), errs);
    const short: LvlFile = { ...room(), tiles: room().tiles.slice(1) };
    assert((ed.structuralErrors(short) as string[]).some((e) => /99 cells/.test(e)), "cell count");
  });

  test("level edit: isLevelPath accepts levels/<folder…>/<name>.lvl only", () => {
    need(ed, "src/core/level/edit.ts");
    for (const ok of ["levels/mymod/room.lvl", "levels/a/b/c-1.lvl", "levels/x.lvl"]) assert(ed.isLevelPath(ok) === true, ok);
    for (const bad of ["data/room.lvl", "levels/../x.lvl", "levels\\a\\x.lvl", "levels/a/x.lvl.bak", "levels/a/x.gon", "/levels/a.lvl", "levels/a b/x.lvl", "levels//x.lvl"]) assert(ed.isLevelPath(bad) === false, bad);
  });

  test("level edit: swatchColor maps image_tint names and [r g b] floats to CSS; paletteLetter takes the name's initials", () => {
    need(ed, "src/core/level/edit.ts");
    same(ed.swatchColor("blue"), "#3b6fd8");
    same(ed.swatchColor(["green", "green"]), "#3f9b45");
    same(ed.swatchColor([[0, 0.5, 0], [0, 0.5, 0]]), "rgb(0, 128, 0)");
    same(ed.swatchColor(["none", "cyan"]), "#36c3cf", "a 'none' layer is skipped");
    same(ed.swatchColor(undefined), null);
    same(ed.swatchColor("mauve-ish"), null);
    same(ed.paletteLetter("Tall Grass"), "TG");
    same(ed.paletteLetter("Water"), "W");
    same(ed.paletteLetter(""), "?");
  });

  test("level edit: an edit and its undo re-encode to the original bytes", () => {
    need(ed, "src/core/level/edit.ts");
    const a = room();
    const orig = hex(encodeLvl(a));
    const b = ed.removeObjects(ed.placeObject(ed.paintTiles(a, [{ x: 7, y: 7 }], 3), 6, 6, 11), 6, 6) as LvlFile;
    const c = ed.paintTiles(b, [{ x: 7, y: 7 }], 0) as LvlFile;
    same(hex(encodeLvl(c)), orig);
  });

  // ---- level I/O through the app API (a throwaway mod under mods/, synthetic base) ----
  const api = await load("../src/core/api.ts");
  const base = join(mkdtempSync(join(tmpdir(), "mewged-roomed-")), "data");
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "spawns.gon"), '0 { editor { name "Empty" } }\n1 { editor { category 1 image_tint [blue none] name "Player Cat Spawn" } utility PlayerSpawn }\n11 { editor { category 3 name "Rat" } object Rat }\n');
  writeFileSync(join(base, "tiles.gon"), '0 { editor { name "Empty" } }\n1 { editor { image_tint [blue blue] name "Water" } tile WaterTile }\n2 { editor { image_tint [green green] name "Grass" } tile { GrassTile 80 TallGrassTile 15 BlankTile 5 } }\n');
  const tmpMod = `_roomed-test-${process.pid}`;
  const modDir = join(MODS_DIR, tmpMod);
  mkdirSync(join(modDir, "data"), { recursive: true });
  writeFileSync(join(modDir, "data", "tiles.gon.append"), '9100 { editor { image_tint [brown] name "Mud" } tile MudTile }\n');
  writeFileSync(join(modDir, "data", "spawns.gon.append"), '9001 { editor { category 3 name "Big Rat" } object BigRat }\n');
  const opts = { extractedData: base };
  try {
    test("api: listLevels / readLevel / writeLevel / validateLevel / levelPalette are on the one app surface", () => {
      need(api, "src/core/api.ts");
      for (const f of ["listLevels", "readLevel", "writeLevel", "validateLevel", "levelPalette"]) assert(typeof api[f] === "function", `api.${f}`);
    });

    test("level io: writeLevel writes only levels/**.lvl inside mods/<mod>/ (refuses data/x.lvl, .., saves, a bad level) and returns the lvl findings", () => {
      need(api, "src/core/api.ts");
      for (const p of ["data/room.lvl", "levels/../../x.lvl", "levels/saves/x.lvl.bak", "x.lvl"]) {
        const r = api.writeLevel(tmpMod, p, room(), opts);
        assert(r.ok === false && /levels\//.test(r.error), `${p}: ${JSON.stringify(r)}`);
      }
      const bad = api.writeLevel(tmpMod, "levels/t/bad.lvl", { ...room(), objects: [{ x: 99, y: 0, id: 1 }] }, opts);
      assert(bad.ok === false && /outside/.test(bad.error), JSON.stringify(bad));
      assert(!existsSync(join(modDir, "levels", "t", "bad.lvl")), "nothing written on a refusal");
      const evil = api.writeLevel("../evil", "levels/t/x.lvl", room(), opts);
      assert(evil.ok === false, JSON.stringify(evil));
      const r = api.writeLevel(tmpMod, "levels/t/room.lvl", room(), opts);
      assert(r.ok === true, JSON.stringify(r));
      same(r.path, `mods/${tmpMod}/levels/t/room.lvl`);
      same(r.bytes, encodeLvl(room()).length);
      same(hex(readFileSync(join(modDir, "levels", "t", "room.lvl"))), hex(encodeLvl(room())));
      assert(Array.isArray(r.findings) && !r.findings.some((f: { severity: string }) => f.severity === "error"), JSON.stringify(r.findings));
      const dry = api.writeLevel(tmpMod, "levels/t/dry.lvl", room(), { ...opts, dryRun: true });
      assert(dry.ok === true && dry.dryRun === true && typeof dry.base64 === "string" && !existsSync(join(modDir, "levels", "t", "dry.lvl")), JSON.stringify(dry));
    });

    test("level io: readLevel → JSON → writeLevel round-trips byte-identically (stacked objects, random lists); listLevels lists it", () => {
      need(api, "src/core/api.ts");
      const odd: LvlFile = { ...room(), objects: [{ x: 2, y: 2, id: 1 }, { x: 2, y: 2, id: [{ id: 11, weight: 3 }, { id: 0, weight: 1 }] }], tiles: room().tiles.map((t, i) => (i === 42 ? [{ id: 1, weight: 1 }, { id: 2, weight: 4 }] : t)) };
      const bytes = encodeLvl(odd);
      mkdirSync(join(modDir, "levels", "t"), { recursive: true });
      writeFileSync(join(modDir, "levels", "t", "odd.lvl"), bytes);
      const r = api.readLevel(tmpMod, "levels/t/odd.lvl");
      assert(r.ok === true, JSON.stringify(r));
      same(r.base64, Buffer.from(bytes).toString("base64"));
      const wire = JSON.parse(JSON.stringify(r.level)) as LvlFile;
      const w = api.writeLevel(tmpMod, "levels/t/odd.lvl", wire, opts);
      assert(w.ok === true, JSON.stringify(w));
      same(hex(readFileSync(join(modDir, "levels", "t", "odd.lvl"))), hex(bytes));
      const l = api.listLevels(tmpMod);
      assert(l.ok === true, JSON.stringify(l));
      same(l.levels.map((x: { relPath: string }) => x.relPath), ["levels/t/odd.lvl", "levels/t/room.lvl"]);
      const miss = api.readLevel(tmpMod, "levels/t/none.lvl");
      assert(miss.ok === false && /not found/.test(miss.error), JSON.stringify(miss));
      const out = api.readLevel(tmpMod, "data/tiles.gon.append");
      assert(out.ok === false, "readLevel reads levels/**.lvl only");
    });

    test("level io: levelPalette merges base tiles.gon / spawns.gon with the mod's .append (name, class, weights, tint colour, letter, source)", () => {
      need(api, "src/core/api.ts");
      const p = api.levelPalette(tmpMod, opts);
      same(p.tiles.map((t: { id: number }) => t.id), [0, 1, 2, 9100]);
      const grass = p.tiles.find((t: { id: number }) => t.id === 2);
      same([grass.name, grass.cls, grass.color, grass.letter, grass.source], ["Grass", "GrassTile 80 · TallGrassTile 15 · BlankTile 5", "#3f9b45", "G", "base"]);
      same(grass.classes, [{ name: "GrassTile", weight: 80 }, { name: "TallGrassTile", weight: 15 }, { name: "BlankTile", weight: 5 }]);
      const mud = p.tiles.find((t: { id: number }) => t.id === 9100);
      same([mud.name, mud.cls, mud.source, mud.color], ["Mud", "MudTile", "mod", "#8a5a2b"]);
      same(p.objects.map((o: { id: number }) => o.id), [0, 1, 11, 9001]);
      const spawn = p.objects.find((o: { id: number }) => o.id === 1);
      same([spawn.kind, spawn.cls, spawn.name], ["utility", "PlayerSpawn", "Player Cat Spawn"]);
      const big = p.objects.find((o: { id: number }) => o.id === 9001);
      same([big.kind, big.cls, big.source, big.category], ["object", "BigRat", "mod", 3]);
    });

    test("level io: validateLevel runs the lvl-* rules on unsaved content (no player spawn, unknown tile id; mod ids resolve)", () => {
      need(api, "src/core/api.ts");
      const lv = buildRoom({ objects: [{ x: 0, y: 0, id: 9001 }], tiles: [{ x: 1, y: 1, id: 77 }, { x: 2, y: 2, id: 9100 }] });
      const r = api.validateLevel(tmpMod, "levels/t/unsaved.lvl", lv, opts);
      const codes = r.findings.map((f: { severity: string; code: string }) => `${f.severity}:${f.code}`);
      assert(codes.includes("warning:lvl-no-player-spawn"), codes.join(", "));
      assert(codes.includes("error:lvl-unknown-tile-id"), codes.join(", "));
      assert(!codes.includes("error:lvl-unknown-spawn-id"), `9001 is the mod's own spawn: ${codes.join(", ")}`);
      assert(r.findings.every((f: { location?: { file?: string } }) => !f.location || f.location.file === `mods/${tmpMod}/levels/t/unsaved.lvl`), "findings point at the edited file only");
      const broken = api.validateLevel(tmpMod, "levels/t/unsaved.lvl", { ...lv, objects: [{ x: 50, y: 0, id: 1 }] }, opts);
      assert(broken.findings.some((f: { code: string }) => f.code === "lvl-bad-format"), JSON.stringify(broken.findings));
    });

    // ---- the HTTP body schema (shared by web/server.ts and the browser client) ----
    const sch = await load("../src/core/api-schemas.ts");
    test("api-schemas: /api/level and /api/level/validate take { mod, path, level } with a zod-checked level (tiles: number | [{id, weight}])", () => {
      need(sch, "src/core/api-schemas.ts");
      assert(!!sch.API_BODY["/api/level"] && !!sch.API_BODY["/api/level/validate"], "routes have schemas");
      const ok = sch.parseBody("/api/level", { mod: "m", path: "levels/a/b.lvl", level: JSON.parse(JSON.stringify(room())) });
      same(ok.level.tiles.length, 100);
      let msg = "";
      try { sch.parseBody("/api/level", { mod: "m", path: "levels/a/b.lvl", level: { ...room(), tiles: ["x"] } }); } catch (e) { msg = String(e instanceof Error ? e.message : e); }
      assert(/level\.tiles/.test(msg), msg);
    });

    // ---- MCP tools ----
    const tools = await load("../src/mcp/tools.ts");
    let listed: any = null, edited: any = null, refused = "";
    if (!tools.__error && tools.TOOL_INPUT?.read_level) {
      // self-contained under --only: the two files this test reads, as the level io tests leave them
      mkdirSync(join(modDir, "levels", "t"), { recursive: true });
      writeFileSync(join(modDir, "levels", "t", "room.lvl"), encodeLvl(room()));
      if (!existsSync(join(modDir, "levels", "t", "odd.lvl"))) writeFileSync(join(modDir, "levels", "t", "odd.lvl"), encodeLvl(room()));
      listed = await tools.callTool("read_level", { mod: tmpMod });
      edited = await tools.callTool("write_level", { mod: tmpMod, path: "levels/t/room.lvl", edits: [{ op: "tile", x: 9, y: 9, id: 9100 }, { op: "object", x: 4, y: 4, object: "BigRat" }, { op: "remove", x: 3, y: 8 }] });
      try { await tools.callTool("write_level", { mod: tmpMod, path: "data/evil.lvl", edits: [] }); } catch (e) { refused = String(e instanceof Error ? e.message : e); }
    }
    test("MCP read_level (no path: the mod's levels) / write_level (edits: tile, object by name, remove) exist; a path outside levels/ is refused", () => {
      need(tools, "src/mcp/tools.ts");
      assert(!!tools.TOOL_INPUT.read_level && !!tools.TOOL_INPUT.write_level, "zod schemas");
      assert(listed && listed.ok === true && listed.levels.length >= 2, JSON.stringify(listed));
      assert(edited && edited.ok === true, JSON.stringify(edited));
      const f = decodeLvl(readFileSync(join(modDir, "levels", "t", "room.lvl")));
      same(f.tiles[99], 9100);
      same(f.objects, [{ x: 1, y: 0, id: 1 }, { x: 4, y: 4, id: 9001 }]);
      assert(/levels\//.test(refused), refused);
    });
  } finally {
    rmSync(modDir, { recursive: true, force: true });
  }

  // ---- T1: every vanilla level through the editor's wire path ----
  const root = extractedPath("levels");
  if (!existsSync(root)) {
    console.log("  (skipped: no .extracted/levels — the Room editor's vanilla wire round-trip needs `python -I tools/gpak.py extract .extracted --prefix levels/`)");
    return;
  }
  const sch = await load("../src/core/api-schemas.ts");
  test("room editor (T1): every vanilla level survives the wire path (decode → JSON → zod /api/level body → encode) byte for byte", () => {
    need(sch, "src/core/api-schemas.ts");
    const files: string[] = [];
    const walk = (d: string): void => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".lvl")) files.push(p); } };
    walk(root);
    assert(files.length > 2000, `expected the ~2361 vanilla levels, found ${files.length}`);
    const bad: string[] = [];
    for (const p of files) {
      const b = readFileSync(p);
      try {
        const body = sch.parseBody("/api/level", JSON.parse(JSON.stringify({ mod: "m", path: "levels/x.lvl", level: decodeLvl(b) })));
        if (!Buffer.from(encodeLvl(body.level)).equals(b)) bad.push(p);
      } catch (e) { bad.push(`${p}: ${String(e)}`); }
    }
    same(bad.slice(0, 5), [], `${bad.length} of ${files.length} did not survive the wire`);
  });
}
