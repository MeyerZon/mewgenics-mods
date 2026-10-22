// The model codes (design §2.6, docs/data-mods.md "3D models: error codes"): ONE list for the DLL and the editor.
// - editor/src/core/model-codes.ts (MODEL_CODES) must equal native/framework/src/fw_mesh_rules.c's FW_MESH_CODES
//   (code, severity, order) — parsed here from the C source, so the two cannot drift;
// - editor/src/core/model-check.ts is the header-level reader the validator runs over a model file that exists
//   (extension, GLB container, glTF asset.version / extensionsRequired, OBJ faces); every code it emits is in the list;
// - the validator reports those codes at <Entry>.graphics.model with the list's severity.
// All models here are synthetic bytes built in-test (no third-party files).

import { join, dirname } from "node:path";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { MODEL_CODES, modelCodeInfo } from "../src/core/model-codes.ts";
import { checkModelBytes } from "../src/core/model-check.ts";
import { validateMod } from "../src/core/validate/validator.ts";
import { REPO_ROOT } from "../src/core/repo.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = join(HERE, "fixtures", "validator", "base");
const COMPONENTS = ["PlayerBrain", "Uncontrollable", "Metal"];

/** the C table, one `[FW_MC_X] = { "model-x", "error" },` per line, in source order */
export function parseNativeCodeTable(src: string): Array<{ code: string; severity: string }> {
  const start = src.indexOf("FW_MESH_CODES[FW_MC_COUNT] = {");
  if (start < 0) return [];
  const end = src.indexOf("};", start);
  const body = src.slice(start, end);
  return [...body.matchAll(/\[FW_MC_[A-Z0-9_]+\]\s*=\s*\{\s*"(model-[a-z0-9-]+)"\s*,\s*"(error|warning|info)"\s*\}/g)].map((m) => ({ code: m[1]!, severity: m[2]! }));
}

const enc = new TextEncoder();
function u32(n: number): Uint8Array { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; }
function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
/** a GLB: header + JSON chunk (space-padded to 4 unless `misalign`) + optional BIN chunk */
function glb(json: string, opts: { version?: number; misalign?: boolean; chunkType?: number; totalDelta?: number; bin?: Uint8Array } = {}): Uint8Array {
  let j: Uint8Array = enc.encode(json);
  if (!opts.misalign) { const pad = (4 - (j.length % 4)) % 4; j = cat(j, enc.encode(" ".repeat(pad))); }
  else if (j.length % 4 === 0) j = cat(j, enc.encode(" "));
  const chunk0 = cat(u32(j.length), u32(opts.chunkType ?? 0x4e4f534a), j);
  const chunk1 = opts.bin ? cat(u32(opts.bin.length), u32(0x004e4942), opts.bin) : new Uint8Array(0);
  const total = 12 + chunk0.length + chunk1.length;
  return cat(enc.encode("glTF"), u32(opts.version ?? 2), u32(total + (opts.totalDelta ?? 0)), chunk0, chunk1);
}
const ASSET = `{"asset":{"version":"2.0"}}`;

export function runModelCodesTests(test: TestFn, assert: AssertFn, eq: EqFn): void {
  test("model-codes: MODEL_CODES is identical to the DLL's FW_MESH_CODES table (native/framework/src/fw_mesh_rules.c): same codes, severities, order", () => {
    const native = parseNativeCodeTable(readFileSync(join(REPO_ROOT, "native", "framework", "src", "fw_mesh_rules.c"), "utf8"));
    assert(native.length >= 40, `parsed ${native.length} entries from the C table`);
    eq(MODEL_CODES.map((c) => `${c.code}:${c.severity}`).join("\n"), native.map((c) => `${c.code}:${c.severity}`).join("\n"));
  });
  test("model-codes: every code is unique, model-*, and has a one-line meaning; the §2.6 anchors have their severities", () => {
    const seen = new Set<string>();
    for (const c of MODEL_CODES) {
      assert(/^model-[a-z0-9-]+$/.test(c.code), c.code);
      assert(!seen.has(c.code), `duplicate ${c.code}`);
      seen.add(c.code);
      assert(c.meaning.length > 10 && !c.meaning.includes("\n"), `${c.code} meaning`);
    }
    eq(modelCodeInfo("model-glb-header")?.severity, "error");
    eq(modelCodeInfo("model-file-missing")?.severity, "error");
    eq(modelCodeInfo("model-multi-material")?.severity, "warning");
    eq(modelCodeInfo("model-no-normals")?.severity, "info");
    eq(modelCodeInfo("model-nope"), undefined);
  });

  const codesOf = (path: string, bytes: Uint8Array | string): string =>
    checkModelBytes(path, typeof bytes === "string" ? enc.encode(bytes) : bytes).map((i) => i.code).join(",");
  test("model-check: OBJ — faces load clean; no face is model-empty; mtllib / usemtl are model-mtl-ignored (info)", () => {
    eq(codesOf("models/a.obj", "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"), "");
    eq(codesOf("models/a.obj", "# only points\nv 0 0 0\nv 1 0 0\n"), "model-empty");
    eq(codesOf("models/a.obj", ""), "model-empty");
    eq(codesOf("models/a.obj", "mtllib a.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl wood\n  f 1 2 3\n"), "model-mtl-ignored");
    eq(codesOf("models/a.fbx", "anything"), "model-extension");
  });
  test("model-check: GLB container — the DLL's header rules (magic, version 2, length, JSON first chunk, 4-byte alignment)", () => {
    eq(codesOf("models/a.glb", glb(ASSET)), "");
    eq(codesOf("models/a.glb", glb(ASSET, { bin: new Uint8Array(8) })), "");
    eq(codesOf("models/a.glb", ASSET), "model-glb-header");                         // a .glb without the magic
    eq(codesOf("models/a.glb", glb(ASSET).slice(0, 16)), "model-glb-header");       // shorter than its header
    eq(codesOf("models/a.glb", glb(ASSET, { version: 1 })), "model-glb-header");
    eq(codesOf("models/a.glb", glb(ASSET, { totalDelta: 4 })), "model-glb-header"); // header length past the file
    eq(codesOf("models/a.glb", glb(ASSET, { chunkType: 0x12345678 })), "model-glb-header");
    eq(codesOf("models/a.glb", glb(ASSET, { misalign: true })), "model-glb-header");
    eq(codesOf("models/a.glb", glb(ASSET, { bin: new Uint8Array(6) })), "model-glb-header");   // BIN chunk not aligned
    eq(codesOf("models/a.glb", glb(`{"asset":`)), "model-parse-error");
    const msg = checkModelBytes("models/a.glb", glb(ASSET, { version: 1 }))[0]!.message;
    assert(/version 1/.test(msg), msg);
  });
  test("model-check: glTF JSON — parse error, asset.version 2.x, extensionsRequired by name, ignored extensions / skins / animations", () => {
    eq(codesOf("models/a.gltf", ASSET), "");
    eq(codesOf("models/a.gltf", `{"asset":{"version":"2.0"}`), "model-parse-error");
    eq(codesOf("models/a.gltf", `[1]`), "model-parse-error");
    eq(codesOf("models/a.gltf", `{"meshes":[]}`), "model-gltf-version");
    eq(codesOf("models/a.gltf", `{"asset":{"version":"1.0"}}`), "model-gltf-version");
    eq(codesOf("models/a.gltf", `{"asset":{"version":"2.0"},"extensionsUsed":["KHR_draco_mesh_compression"],"extensionsRequired":["KHR_draco_mesh_compression"]}`), "model-extension-required");
    const req = checkModelBytes("models/a.gltf", enc.encode(`{"asset":{"version":"2.0"},"extensionsRequired":["EXT_meshopt_compression"]}`))[0]!;
    assert(/EXT_meshopt_compression/.test(req.message), req.message);
    eq(codesOf("models/a.gltf", `{"asset":{"version":"2.0"},"extensionsUsed":["KHR_materials_emissive_strength"]}`), "model-extension-ignored");
    eq(codesOf("models/a.gltf", `{"asset":{"version":"2.0"},"skins":[{"joints":[0]}],"animations":[{"channels":[],"samplers":[]}]}`), "model-skin-ignored,model-animation-ignored");
    // a JSON chunk inside a .glb gets the same checks
    eq(codesOf("models/a.glb", glb(`{"asset":{"version":"1.1"}}`)), "model-gltf-version");
  });
  test("model-check: every code it can emit is in MODEL_CODES", () => {
    const samples: Array<[string, Uint8Array | string]> = [
      ["models/a.obj", ""], ["models/a.obj", "mtllib x\nf 1 2 3"], ["models/a.fbx", ""], ["models/a.glb", "x"],
      ["models/a.glb", glb(`{`)], ["models/a.gltf", `{}`], ["models/a.gltf", `{"asset":{"version":"2.0"},"extensionsRequired":["X"],"extensionsUsed":["Y"],"skins":[1],"animations":[1]}`],
    ];
    for (const [p, b] of samples) for (const i of checkModelBytes(p, typeof b === "string" ? enc.encode(b) : b)) assert(modelCodeInfo(i.code) !== undefined, `${i.code} from ${p}`);
  });

  test("model-check in the validator: a model file that exists but would not load is reported at <Entry>.graphics.model with the list's severity", () => {
    const dir = mkdtempSync(join(tmpdir(), "mewmodel-"));
    try {
      mkdirSync(join(dir, "data", "characters"), { recursive: true });
      mkdirSync(join(dir, "models"), { recursive: true });
      writeFileSync(join(dir, "data", "characters", "inanimate_objects.gon.merge"),
        `Crate {\n\tgraphics {\n\t\tmodel "models/broken.glb"\n\t}\n}\nRock {\n\tgraphics {\n\t\tmodel "models/draco.gltf"\n\t}\n}\nTire {\n\tgraphics {\n\t\tmodel "models/lines.obj"\n\t}\n}\n`);
      writeFileSync(join(dir, "models", "broken.glb"), glb(ASSET, { version: 1 }));
      writeFileSync(join(dir, "models", "draco.gltf"), `{"asset":{"version":"2.0"},"extensionsUsed":["KHR_materials_variants"],"extensionsRequired":["KHR_draco_mesh_compression"]}`);
      writeFileSync(join(dir, "models", "lines.obj"), "mtllib x.mtl\nv 0 0 0\nv 1 0 0\n");
      const r = validateMod("model-codes-tmp", undefined, { modDir: dir, extractedData: BASE, components: COMPONENTS, registeredNames: [], registeredModels: [], nativeBuild: null });
      const got = r.findings.filter((f) => f.code.startsWith("model-")).map((f) => `${f.severity}:${f.code}@${f.location?.path ?? ""}`).sort();
      eq(got.join("\n"), [
        "error:model-empty@Tire.graphics.model",
        "error:model-extension-required@Rock.graphics.model",
        "error:model-glb-header@Crate.graphics.model",
        "info:model-mtl-ignored@Tire.graphics.model",
      ].join("\n"));
      eq(r.ok, false);
      const glbMsg = r.findings.find((f) => f.code === "model-glb-header")!.message;
      assert(/models\/broken\.glb/.test(glbMsg) && /version 1/.test(glbMsg), glbMsg);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
