// Tests for the art pipeline's pure core (scene model, geometry, timeline, SVG
// importer, palette reader, mod IO). The emitter/reader/ABC/PNG tests live in
// art-emitter-tests.ts. Wired into run-tests.ts.

import { existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MODS_DIR, REPO_ROOT } from "../src/core/repo.ts";
import { parsePathData, normalizePath, flattenSubpath, signedArea, subpathBounds, matrixFromTransform, parseSvgTransform, multiply, apply, invert } from "../src/core/art/geometry.ts";
import { validateScene, exampleScene, parseFill, grayLevelToByte, byteToGrayLevel, buildOrder, shapeGrayUsage, DEFAULT_ABC_MODE } from "../src/core/art/scene.ts";
import { bakeSprite, bakeStage, diffFrames, labelList } from "../src/core/art/timeline.ts";
import { importSvg, parseXml } from "../src/core/art/svg-import.ts";
import { readPalette, remapGray, identityRows } from "../src/core/art/palette.ts";
import * as api from "../src/core/api.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

/** A scene edited as plain JSON (the "garbage in" tests mutate it freely). */
type LooseScene = Record<string, any>;

export function runArtCoreTests(test: TestFn, assert: AssertFn, eq: EqFn): void {
  console.log("\n# Art: geometry (SVG path → L/Q edges)");
  test("parsePathData absolutizes relative commands and shorthands", () => {
    const c = parsePathData("m10 10 h5 v5 l-5 0 z M0 0 c1 1 2 2 3 3 s1 1 2 2 q1 1 2 2 t1 1 a1 1 0 0 1 2 2") as Record<string, any>[];
    eq(c[0]!.t, "M");
    eq(c[1]!.x, 15, "h5 → L 15");
    eq(c[2]!.y, 15, "v5 → L y 15");
    eq(c[4]!.t, "Z");
    eq(c[6]!.t, "C");
    eq(c[7]!.t, "C", "S → C");
    eq(c[7]!.x1, 4, "S reflects the previous control point");
    eq(c[8]!.t, "Q");
    eq(c[9]!.t, "Q", "T → Q");
    eq(c[10]!.t, "A");
  });
  test("normalizePath yields closed subpaths with only L/Q edges; cubics → 4 quads", () => {
    const subs = normalizePath("M0 0 L10 0 L10 10 L0 10 Z M20 0 C 25 0 30 5 30 10");
    eq(subs.length, 2);
    eq(subs[0]!.closed, true);
    eq(subs[0]!.edges.length, 3, "Z does not add an edge; the fill closes implicitly");
    eq(subs[1]!.edges.length, 4, "one cubic → 4 quadratics");
    assert(subs[1]!.edges.every((e) => e.t === "Q"), "all quadratic");
  });
  test("arcs flatten to quadratics and reach the end point", () => {
    const subs = normalizePath("M0 0 A10 10 0 0 1 20 0");
    const last = subs[0]!.edges[subs[0]!.edges.length - 1]!;
    assert(Math.abs(last.x - 20) < 1e-6 && Math.abs(last.y) < 1e-6, `arc ends at (20,0), got (${last.x},${last.y})`);
    assert(subs[0]!.edges.length >= 4, "a 180° arc needs ≥2 cubics → ≥8 quads");
  });
  test("signed area is positive for a clockwise-on-screen square (y down)", () => {
    const flat = flattenSubpath(normalizePath("M0 0 L10 0 L10 10 L0 10 Z")[0]!);
    assert(signedArea(flat) > 0, "clockwise (TL→TR→BR→BL) → positive");
    const ccw = flattenSubpath(normalizePath("M0 0 L0 10 L10 10 L10 0 Z")[0]!);
    assert(signedArea(ccw) < 0, "counter-clockwise → negative");
  });
  test("bounds include quadratic control points (safe superset)", () => {
    const b = subpathBounds(normalizePath("M0 0 Q 50 -40 100 0"));
    assert(b !== null && b.ymin === -40 && b.xmax === 100, JSON.stringify(b));
  });
  test("matrix helpers: transform → matrix, svg transform parse, multiply/apply/invert", () => {
    const m = matrixFromTransform({ x: 10, y: 20, sx: 2, sy: 3, rot: 90 });
    const p = apply(m, 1, 0);
    assert(Math.abs(p[0] - 10) < 1e-6 && Math.abs(p[1] - 22) < 1e-6, `rot 90 maps (1,0) → (0,2)+t, got ${p}`);
    const t = parseSvgTransform("translate(10,20) scale(2)");
    eq(JSON.stringify(apply(t, 1, 1)), "[12,22]");
    const inv = invert(t);
    assert(inv !== null, "invertible");
    const back = apply(inv!, 12, 22);
    assert(Math.abs(back[0] - 1) < 1e-9 && Math.abs(back[1] - 1) < 1e-9, "inverse round-trips");
    eq(JSON.stringify(multiply([1, 0, 0, 1, 5, 5], [2, 0, 0, 2, 0, 0])), "[2,0,0,2,5,5]");
  });

  console.log("\n# Art: scene model");
  test("gray level ↔ byte matches the paletted_full.shader rule exactly for all 16 levels", () => {
    for (let n = 0; n < 16; n++) eq(byteToGrayLevel(grayLevelToByte(n)), n, `level ${n}`);
    eq(grayLevelToByte(8), 136);
  });
  test("parseFill: gray:N, near-gray hex quantizes with a flag, colour passes through, bitmap:, none", () => {
    eq(JSON.stringify(parseFill("gray:12").fill), '{"kind":"gray","level":12}');
    const q = parseFill("#808080");
    eq((q.fill as { level?: number }).level, 8);
    eq(q.quantized, true, "0x80 is not 8*17=0x88 → quantized");
    eq(parseFill("#888888").quantized, false);
    eq(parseFill("#ff2020").fill.kind, "rgba");
    eq(JSON.stringify(parseFill("bitmap:eye").fill), '{"kind":"bitmap","id":"eye"}');
    eq(parseFill(null).fill.kind, "none");
    assert(!!parseFill("gray:16").error, "gray:16 is out of range");
    assert(!!parseFill("blurple").error, "unknown colour is an error");
  });
  test("exampleScene validates (only the passthrough-fill warning) and has a deterministic build order", () => {
    const r = validateScene(exampleScene());
    assert(r.ok, JSON.stringify(r.findings));
    eq(r.findings.map((f) => f.code).join(","), "passthrough-fill");
    eq(buildOrder(r.scene).join(","), "body,eye,Starter");
    eq(shapeGrayUsage(r.scene.shapes.body!).levels.join(","), "8,12");
    eq(shapeGrayUsage(r.scene.shapes.eye!).passthrough, 1);
  });
  test("validateScene flags bad refs, dup depths, label range, unsorted keys, cycles, bad exports", () => {
    const s = exampleScene() as LooseScene;
    s.sprites.Starter.layers[0].keys[1].ref = "nope";
    s.sprites.Starter.layers[1].depth = 1;
    s.sprites.Starter.labels.far = 99;
    s.sprites.Starter.layers[0].keys.push({ frame: 3, ref: "body" });
    s.sprites.Loop = { frames: 1, layers: [{ depth: 1, keys: [{ frame: 0, ref: "Loop2" }] }] };
    s.sprites.Loop2 = { frames: 1, layers: [{ depth: 1, keys: [{ frame: 0, ref: "Loop" }] }] };
    s.exports.ghost = "missing";
    const r = validateScene(s);
    assert(!r.ok, "should fail");
    const codes = new Set(r.findings.map((f) => f.code));
    for (const c of ["ref-missing", "layer-depth-dup", "label-frame", "key-order", "sprite-cycle", "export-ref"]) assert(codes.has(c), `expected ${c}, got ${[...codes].join(",")}`);
  });
  test("validateScene never throws on garbage input", () => {
    assert(!validateScene(null).ok, "null");
    assert(!validateScene([]).ok, "array");
    assert(!validateScene({ name: "x y", shapes: { a: 5 }, sprites: { b: null } }).ok, "junk");
  });
  test("DEFAULT_ABC_MODE is 'none' until the gate test says otherwise", () => eq(DEFAULT_ABC_MODE, "none"));

  console.log("\n# Art: timeline baking");
  test("bakeSprite holds keys, tweens linearly, removes on ref:null, sorts by depth", () => {
    const baked = bakeSprite({
      frames: 10,
      labels: { a: 0, b: 5 },
      layers: [
        { depth: 2, keys: [{ frame: 0, ref: "s", x: 0, tween: "linear" }, { frame: 4, ref: "s", x: 8 }, { frame: 6, ref: null }] },
        { depth: 1, keys: [{ frame: 2, ref: "t", alpha: 0.5 }] },
      ],
    });
    eq(baked.frames, 10);
    eq(baked.placements[0]!.length, 1);
    eq(baked.placements[2]![0]!.depth, 1, "sorted by depth");
    eq(baked.placements[2]![1]!.matrix[4], 4, "frame 2 of a 0→4 tween over x 0→8 = 4");
    eq(baked.placements[5]!.find((p) => p.depth === 2)?.matrix[4], 8, "hold after the last tween key");
    eq(baked.placements[6]!.some((p) => p.depth === 2), false, "removed at frame 6");
    eq(baked.placements[2]![0]!.cxform?.mul[3], 0.5, "alpha shorthand → cxform.mul[3]");
    eq(labelList(baked).map((l) => `${l.label}@${l.frame}`).join(","), "a@0,b@5");
  });
  test("diffFrames produces place / move / replace / remove ops", () => {
    const baked = bakeSprite({
      frames: 4,
      layers: [
        { depth: 1, keys: [{ frame: 0, ref: "a", x: 0, tween: "linear" }, { frame: 2, ref: "a", x: 10 }, { frame: 3, ref: "b" }] },
        { depth: 5, keys: [{ frame: 0, ref: "c" }, { frame: 2, ref: null }] },
      ],
    });
    const f0 = diffFrames([], baked.placements[0]!);
    eq(f0.map((o) => o.op).join(","), "place,place");
    const f1 = diffFrames(baked.placements[0]!, baked.placements[1]!);
    eq(f1.map((o) => o.op).join(","), "move", "only the tweened layer moves");
    const f2 = diffFrames(baked.placements[1]!, baked.placements[2]!);
    eq(f2.map((o) => o.op).sort().join(","), "move,remove");
    const f3 = diffFrames(baked.placements[2]!, baked.placements[3]!);
    eq(f3.map((o) => o.op).join(","), "replace", "character swap at the same depth");
  });
  test("bakeStage places stage_instances on one frame", () => {
    const b = bakeStage(exampleScene());
    eq(b.frames, 1);
    eq(b.placements[0]![0]!.ref, "Starter");
    eq(b.placements[0]![0]!.matrix[4], 640);
  });

  console.log("\n# Art: SVG importer (tool-agnostic)");
  test("parseXml handles prolog, comments, CDATA, entities, self-closing and namespaced tags", () => {
    const d = parseXml(`<?xml version="1.0"?><!-- c --><svg xmlns:inkscape="x"><inkscape:label>a &amp; b</inkscape:label><g id="q&quot;"><![CDATA[<raw>]]></g><path d="M0 0"/></svg>`);
    const svg = d.children[0]!;
    eq(svg.name, "svg");
    eq(svg.children[0]!.children[0]!.text, "a & b");
    eq(svg.children[1]!.attrs.id, 'q"');
    eq(svg.children[1]!.children[0]!.text, "<raw>");
    eq(svg.children[2]!.attrs.d, "M0 0");
  });
  test("importSvg: shapes, groups, inline style, viewBox matrix, gray snapping, passthrough, paint servers, text", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 100 50">
      <defs><linearGradient id="g"/></defs>
      <g transform="translate(10,5)" style="fill:#888888">
        <rect x="0" y="0" width="20" height="10" rx="2"/>
        <circle cx="5" cy="5" r="3" fill="#ff0000" fill-opacity="0.5"/>
        <path d="M0 0 L5 5" fill="none" stroke="#333" stroke-width="2"/>
        <path d="M1 1 h2" fill="url(#g)"/>
        <text>hi</text>
        <polygon points="0,0 10,0 5,5" fill="#808081"/>
        <ellipse cx="1" cy="1" rx="2" ry="1" display="none"/>
      </g></svg>`;
    const r = importSvg(svg);
    assert(r.ok, JSON.stringify(r.findings));
    eq(r.paths.length, 5);
    eq(r.paths[0]!.fill, "gray:8", "inherited style fill → gray level");
    eq(JSON.stringify(r.paths[0]!.transform), "[2,0,0,2,20,10]", "viewBox scale ∘ group translate");
    eq(r.paths[1]!.fill, "#ff000080", "colour with fill-opacity passes through with alpha");
    eq(r.paths[2]!.stroke, "gray:3");
    eq(r.paths[2]!.strokeWidth, 2);
    eq(r.paths[3]!.fill, "gray:8", "a gradient with no stops is replaced (gradients with stops import as gradient fills: art-gradient-tests.ts)");
    eq(r.paths[4]!.fill, "gray:8", "near-gray snapped");
    const codes = r.findings.map((f) => f.code);
    assert(codes.includes("svg-gradient-empty") && codes.includes("svg-unsupported") && codes.includes("svg-gray-snapped"), codes.join(","));
    const pat = importSvg(`<svg xmlns="http://www.w3.org/2000/svg"><defs><pattern id="p"/></defs><rect width="4" height="4" fill="url(#p)"/></svg>`);
    eq(pat.paths[0]!.fill, "gray:8", "a pattern is still replaced");
    assert(pat.findings.some((f) => f.code === "svg-paint-server"), JSON.stringify(pat.findings));
    eq(r.info.skipped.text, 1);
    eq(r.info.skipped["display:none"], 1);
  });
  test("importSvg reports a missing root as an error and never throws on junk", () => {
    assert(!importSvg("<html/>").ok, "no svg root");
    assert(!importSvg("not xml at all <<<").ok, "junk");
  });

  console.log("\n# Art: palette.png reader");
  test("identityRows mirrors the shader's gray ramp; remapGray clamps", () => {
    const rows = identityRows(4);
    eq(rows.length, 4);
    eq(JSON.stringify(rows[0]![15]), "[255,255,255]");
    eq(JSON.stringify(remapGray(rows, 99, 8)), "[136,136,136]");
  });
  const palAbs = join(REPO_ROOT, ".extracted", "textures", "palette.png");
  if (existsSync(palAbs)) {
    test("reads the extracted palette.png as 16×256 RGB rows (not committed; read-only)", () => {
      const p = readPalette("palette", { noCache: true });
      assert(p.ok, p.error || "");
      eq(p.width, 16);
      eq(p.height, 256);
      eq(p.rows.length, 256);
      assert(p.rows[54]!.some((c) => c[0] !== c[1] || c[1] !== c[2]), "a class row is not plain gray");
    });
  } else {
    test("palette.png not extracted → identity ramp + hint (skipping real-table check)", () => {
      const p = readPalette("palette", { noCache: true });
      assert(!p.ok && !!p.hint, "hint present");
      eq(p.rows.length, 256);
    });
  }

  console.log("\n# Art: mod IO through the core API (confined to mods/<name>/)");
  const tmpMod = "__art_test_tmp";
  const tmpDir = join(MODS_DIR, tmpMod);
  rmSync(tmpDir, { recursive: true, force: true });
  test("newArtScene writes art/<name>.scene.json and lists it", () => {
    const r = api.newArtScene(tmpMod, "starter");
    assert(r.ok, r.error || "");
    const l = api.listArtScenes(tmpMod);
    eq(l.scenes.length, 1);
    eq(l.scenes[0]!.relPath, "art/starter.scene.json");
    const again = api.newArtScene(tmpMod, "starter");
    assert(!again.ok, "refuses to overwrite");
  });
  test("writeArtScene refuses invalid scenes unless forced; readArtScene validates", () => {
    const bad = { ...exampleScene("starter"), exports: { x: "missing" } };
    const r = api.writeArtScene(tmpMod, "art/starter.scene.json", bad);
    assert(!r.ok, "invalid refused");
    const f = api.writeArtScene(tmpMod, "art/starter.scene.json", bad, { force: true });
    assert(f.ok && f.valid === false, "forced write records invalidity");
    const rd = api.readArtScene(tmpMod, "art/starter.scene.json");
    assert(!rd.ok && rd.findings.some((x) => x.code === "export-ref"), "read reports the error");
    api.writeArtScene(tmpMod, "art/starter.scene.json", exampleScene("starter"));
  });
  test("buildSwf writes swfs/<name>.swf + swflist.gon.append, self-checks with the reader, is idempotent", () => {
    const r = api.buildSwf(tmpMod, "art/starter.scene.json", { abc: "none" });
    assert(r.ok, r.error + " " + JSON.stringify(r.findings));
    assert(existsSync(join(tmpDir, "swfs", "starter.swf")), "swf written");
    const bytes = readFileSync(join(tmpDir, "swfs", "starter.swf"));
    eq(bytes.length, r.bytes);
    eq(String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!), "FWS");
    eq(bytes[3], 17);
    const list = readFileSync(join(tmpDir, "swfs", "swflist.gon.append"), "utf8");
    assert(/game \[\n\s+starter\.swf\n\]/.test(list), list);
    const r2 = api.buildSwf(tmpMod, "art/starter.scene.json", { abc: "none" });
    const list2 = readFileSync(join(tmpDir, "swfs", "swflist.gon.append"), "utf8");
    eq(list2, list, "swflist append is idempotent");
    eq(r2.bytes, r.bytes);
    const ins = api.inspectSwf(tmpMod, "swfs/starter.swf");
    assert(ins.ok, ins.error || "");
    eq(ins.doAbc, 0);
    eq(ins.exports!.map((e) => e.name).sort().join(","), "Starter,starter.png");
    assert(ins.labels!.includes("idle") && ins.labels!.includes("blink"), ins.labels!.join(","));
    const stub = api.buildSwf(tmpMod, "art/starter.scene.json", { abc: "stub" });
    assert(stub.ok, stub.error || "");
    eq(api.inspectSwf(tmpMod, "swfs/starter.swf").doAbc, 1, "stub mode adds exactly one DoABC");
  });
  test("prepareSwfGate writes swfs/gate.swf + a one-entry swflist.gon.append per variant; 'control' removes both", () => {
    const expectLinkage = { flat: "_Append_AbilityIcon", nested: "_Append_AbilityIcon", legacy: "_Append_AbilityIcon", probe: "GateProbe", missing: "_Append_NoSuchClipXYZ" } as const;
    const expectLayout = { flat: "flat", nested: "nested", legacy: "legacy", probe: "flat", missing: "flat" } as const;
    // what the harness boot must report for the variant to count as expected (OBSERVED 2026-10-19):
    // every real target boots to the menu; an unknown append target stalls the boot before the console appears
    const expectVerdict = { flat: "pass", nested: "pass", legacy: "pass", probe: "pass", missing: "harness-error" } as const;
    for (const variant of ["flat", "nested", "legacy", "probe", "missing"] as const) {
      const r = api.prepareSwfGate({ mod: tmpMod, variant });
      assert(r.ok, `${variant}: ${r.error || ""}`);
      eq(r.variant, variant);
      eq(r.written!.join(","), `mods/${tmpMod}/swfs/gate.swf,mods/${tmpMod}/swfs/swflist.gon.append`, variant);
      const list = readFileSync(join(tmpDir, "swfs", "swflist.gon.append"), "utf8");
      assert(/game \[\n\s+gate\.swf\n\]/.test(list), `${variant}: swflist lists exactly gate.swf: ${list}`);
      const swf = api.inspectSwf(tmpMod, "swfs/gate.swf");
      eq(swf.doAbc, 0, `${variant}: no DoABC`);
      eq(swf.exports!.map((e) => e.name).join(","), expectLinkage[variant], `${variant}: linkage`);
      assert(swf.labels!.includes("JokersGambit"), `${variant}: frame label present`);
      eq(r.linkage, expectLinkage[variant]);
      eq(r.layout, expectLayout[variant]);
      eq(r.expect, expectVerdict[variant], `${variant}: expected harness verdict`);
    }
    const c = api.prepareSwfGate({ mod: tmpMod, variant: "control" });
    assert(c.ok, c.error || "");
    eq(c.removed!.join(","), `mods/${tmpMod}/swfs/gate.swf,mods/${tmpMod}/swfs/swflist.gon.append`);
    eq(c.expect, "pass", "control: expected harness verdict");
    assert(!existsSync(join(tmpDir, "swfs", "gate.swf")) && !existsSync(join(tmpDir, "swfs", "swflist.gon.append")), "control leaves no gate files");
    const again = api.prepareSwfGate({ mod: tmpMod, variant: "control" });
    assert(again.ok && again.removed!.length === 0, "control is idempotent");
    const bad = api.prepareSwfGate({ mod: tmpMod, variant: "stub" as "flat" }); // deliberately not a variant
    assert(!bad.ok && /variant/.test(bad.error ?? ""), "unknown variant refused");
    assert(!api.prepareSwfGate({ mod: "../evil", variant: "flat" }).ok, "mod path confinement holds");
  });
  test("mods/swf-gate: the boot .mewtest the gate runs parses and loads only swf-gate", () => {
    const l = api.listIngameTests("swf-gate");
    const boot = l.tests.find((t) => t.name === "boot");
    assert(!!boot, `mods/swf-gate/tests/boot.mewtest listed (have: ${l.tests.map((t) => t.name).join(",") || "none"})`);
    if (!boot) return;
    assert(boot.plan.ok, boot.plan.errors.map((e) => e.message).join("; "));
    eq(boot.plan.mods.join(","), "swf-gate");
    assert(boot.plan.directives.some((d) => d.kind === "quit"), "script quits on its own");
  });
  test("art writes cannot escape mods/<mod>/ (path traversal, saves, protected files)", () => {
    assert(!api.writeArtScene(tmpMod, "../evil.scene.json", exampleScene("x")).ok, "traversal refused");
    assert(!api.writeArtAsset(tmpMod, "saves/x.png", new Uint8Array(1)).ok, "saves refused");
    assert(!api.writeArtAsset(tmpMod, "art/Mewgenics.exe", new Uint8Array(1)).ok, "non-asset extension refused");
    assert(!api.readArtAsset(tmpMod, "../../editor/package.json").ok, "read traversal refused");
  });
  rmSync(tmpDir, { recursive: true, force: true });
}
