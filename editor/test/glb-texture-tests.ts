// 3D phase M3, a model's OWN texture: the image a .glb embeds is drawn by the DLL (native/framework/src/fw_png.c +
// fw_mesh_embtex.c) and can be extracted to a file by the editor (core api.extractModelTexture, MCP
// extract_model_texture). Here: the generated sample mods/fw-3d/models/totem.glb and the DLL decoder's PNG fixtures
// (native/framework/test/fixtures/png/) stay what the generators make; the editor's decoder agrees with every expected
// pixel file the C suite uses; the embedded-image pick (glb-texture.ts, the DLL's rule) and the extraction (write
// guard, no overwrite, dry run, the convention path); the OBSERVED T2 run pinned as fixtures.
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";
import { decodePng } from "../src/core/art/png.ts";
import { TOTEM, totemGlb, totemTexturePng, totemTexturePixels, pillarGlb } from "../src/core/art/fw3d-assets.ts";
import { pngFixtures, editorDecodes, rgbaHex } from "../src/core/art/png-fixtures.ts";
import { embeddedBaseColorImage, conventionTexturePath } from "../src/core/art/glb-texture.ts";
import { generatedAssets, sameAsset } from "../scripts/make-fw3d-assets.ts";
import { checkModelBytes } from "../src/core/model-check.ts";
import { MODS_DIR } from "../src/core/repo.ts";
import * as api from "../src/core/api.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

/** a .glb like totemGlb() but with its JSON edited (the BIN chunk kept) */
function editGlb(glb: Uint8Array, edit: (j: any) => void): Uint8Array {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jlen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jlen)));
  edit(json);
  const jb = new TextEncoder().encode(JSON.stringify(json));
  const nj = (jb.length + 3) & ~3;
  const bin = glb.subarray(20 + jlen);
  const out = new Uint8Array(20 + nj + bin.length);
  const o = new DataView(out.buffer);
  o.setUint32(0, 0x46546c67, true); o.setUint32(4, 2, true); o.setUint32(8, out.length, true);
  o.setUint32(12, nj, true); o.setUint32(16, 0x4e4f534a, true);
  out.set(jb, 20); out.fill(0x20, 20 + jb.length, 20 + nj); out.set(bin, 20 + nj);
  return out;
}

export function runGlbTextureTests(test: TestFn, assert: AssertFn, eq: EqFn, fixture?: (name: string) => string | null): void {
  console.log("\n# a model's own (embedded) texture: totem.glb, the DLL's PNG fixtures, extract_model_texture (3D phase M3)");

  test("every generated asset is committed byte for byte (mods/fw-3d crate.png / pillar.glb / totem.glb, native/framework/test/fixtures/png/*: node scripts/make-fw3d-assets.ts)", () => {
    const all = generatedAssets();
    assert(all.some((a) => a.rel === "mods/fw-3d/models/totem.glb"), "totem.glb is generated");
    assert(all.filter((a) => a.rel.startsWith("native/framework/test/fixtures/png/")).length >= 30, "the PNG fixtures are generated");
    for (const a of all) {
      const p = join(REPO, a.rel);
      assert(existsSync(p), `${a.rel} committed`);
      if (existsSync(p)) assert(sameAsset(a.rel, readFileSync(p), a.make()), `${a.rel}: committed == generated`);
    }
    eq(sameAsset("x.hex", new TextEncoder().encode("ab\r\ncd\r\n"), new TextEncoder().encode("ab\ncd\n")), true, "a .hex compares with CRs stripped (autocrlf)");
    eq(sameAsset("x.png", new Uint8Array([1, 13, 10]), new Uint8Array([1, 10])), false, "binary compares byte for byte");
  });

  test("the DLL decoder's PNG fixtures: the editor's own decoder agrees with every expected .rgba.hex; the broken ones are what they say", () => {
    const fx = pngFixtures();
    const kinds = new Set(fx.map((f) => f.expect));
    for (const k of ["ok", "corrupt", "unsupported", "size", "not-png"]) assert(kinds.has(k as never), `a ${k} fixture`);
    for (const f of fx.filter((g) => g.expect === "ok")) assert(editorDecodes(f), `${f.name}: decodePng == expected pixels`);
    const throws = (n: string, re: RegExp) => { let m = ""; try { decodePng(fx.find((f) => f.name === n)!.png); } catch (e) { m = String(e); } assert(re.test(m), `${n}: ${m}`); };
    throws("interlaced", /interlaced/); throws("depth16", /bit depth 16/); throws("not-png", /not a PNG/); throws("bad-filter", /filter 7/);
    eq(rgbaHex(new Uint8Array([0, 255, 16, 1])), "00ff1001\n");
  });

  test("totem.glb: one material whose baseColorTexture image lives in the BIN chunk (bufferView 4, image/png) = the purple / lime checker; the header check finds nothing wrong", () => {
    const glb = totemGlb();
    const img = embeddedBaseColorImage(glb);
    assert(img.ok, JSON.stringify(img));
    if (!img.ok) return;
    eq(img.source, "bufferView 4"); eq(img.material, 0); eq(img.image, 0);
    eq(Buffer.compare(Buffer.from(img.bytes), Buffer.from(totemTexturePng())), 0, "the embedded bytes are totemTexturePng()");
    const d = decodePng(img.bytes);
    eq(`${d.width}x${d.height}`, "16x16");
    eq(Buffer.compare(Buffer.from(d.rgba), Buffer.from(totemTexturePixels())), 0);
    eq([...d.rgba.subarray(0, 4)].join(","), `${TOTEM.purple.join(",")},255`);
    eq([...d.rgba.subarray(32, 36)].join(","), `${TOTEM.lime.join(",")},255`);
    eq(checkModelBytes("models/totem.glb", glb).filter((i) => i.code !== "model-texture-embedded").length, 0, "no errors / warnings at header level");
    eq(glb.length < 4096, true);
  });

  test("embeddedBaseColorImage refuses with the model codes: no texture, a JPEG, a dangling or out-of-range bufferView, an external uri; a data: URI works", () => {
    const code = (b: Uint8Array) => { const r = embeddedBaseColorImage(b); return r.ok ? "ok" : r.code; };
    eq(code(pillarGlb()), "model-texture-missing", "the pillar's material has only a factor");
    eq(code(editGlb(totemGlb(), (j) => { j.images[0].mimeType = "image/jpeg"; })), "model-image-format");
    eq(code(editGlb(totemGlb(), (j) => { j.images[0].bufferView = 9; })), "model-image-embedded-invalid");
    eq(code(editGlb(totemGlb(), (j) => { j.bufferViews[4].byteLength = 99999; })), "model-image-embedded-invalid");
    eq(code(editGlb(totemGlb(), (j) => { j.images[0] = { uri: "totem.png" }; })), "model-texture-missing");
    eq(code(editGlb(totemGlb(), (j) => { j.textures[0].source = 3; })), "model-node-invalid");
    eq(code(new TextEncoder().encode("{nope")), "model-parse-error");
    const b64 = Buffer.from(totemTexturePng()).toString("base64");
    const gltf = new TextEncoder().encode(JSON.stringify({ asset: { version: "2.0" }, meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }], materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }], textures: [{ source: 0 }], images: [{ uri: `data:image/png;base64,${b64}` }] }));
    const r = embeddedBaseColorImage(gltf);
    assert(r.ok && r.source === "data-uri" && Buffer.compare(Buffer.from(r.bytes), Buffer.from(totemTexturePng())) === 0, JSON.stringify(r).slice(0, 200));
    eq(conventionTexturePath("models/totem.glb"), "textures/models/totem.png");
    eq(conventionTexturePath("models/props/barrel.gltf"), "textures/models/barrel.png", "sub-folders dropped, like fw_tex_default_name");
  });

  test("api.extractModelTexture writes mods/<mod>/textures/models/<stem>.png once (dry run writes nothing, no overwrite without overwrite:true), refuses OBJ / bad paths / a missing file, and notes that an explicit texture is needed to draw the file", () => {
    const tmpMod = "__glb_texture_tmp";
    const dir = join(MODS_DIR, tmpMod);
    rmSync(dir, { recursive: true, force: true });
    try {
      mkdirSync(join(dir, "models"), { recursive: true });
      writeFileSync(join(dir, "models", "totem.glb"), totemGlb());
      const out = join(dir, "textures", "models", "totem.png");
      const dry = api.extractModelTexture(tmpMod, "models/totem.glb", { dryRun: true });
      assert(dry.ok && dry.written === false && dry.width === 16 && dry.source === "bufferView 4", JSON.stringify(dry));
      eq(existsSync(out), false, "dry run wrote nothing");
      const w = api.extractModelTexture(tmpMod, "models/totem.glb");
      assert(w.ok && w.written === true, JSON.stringify(w));
      eq(w.path, `mods/${tmpMod}/textures/models/totem.png`);
      eq(Buffer.compare(readFileSync(out), Buffer.from(totemTexturePng())), 0, "the PNG bytes as embedded");
      assert(/texture "models\/totem\.png"/.test(w.note ?? ""), `note: ${w.note}`);
      eq(w.findings.length, 0);
      const again = api.extractModelTexture(tmpMod, "models/totem.glb");
      assert(!again.ok && /already exists/.test(again.error ?? ""), JSON.stringify(again));
      assert(api.extractModelTexture(tmpMod, "models/totem.glb", { overwrite: true }).ok, "overwrite:true replaces it");
      eq(api.extractModelTexture(tmpMod, "models/none.glb").code, "model-file-missing");
      eq(api.extractModelTexture(tmpMod, "models/crate.obj").code, "model-extension");
      eq(api.extractModelTexture(tmpMod, "../escape.glb").code, "model-path-invalid");
      eq(api.extractModelTexture("../x", "models/totem.glb").ok, false, "a bad mod name is refused by the write guard");
      writeFileSync(join(dir, "models", "plain.glb"), pillarGlb());
      eq(api.extractModelTexture(tmpMod, "models/plain.glb").code, "model-texture-missing");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
