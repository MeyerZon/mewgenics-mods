// The 3D data seam (preview, mewframework API v6): the GON key `model` inside a data/characters entry's `graphics`
// block names the 3D model the framework draws for that unit (docs/data-mods.md "3D models in a mod (preview)").
// Two forms:
//   - a mod path "models/<...>.obj": a file in the mod folder (mods/<mod>/models/...), served to the game through
//     -modpaths like any other file; models are mod-only (the pack has none), so nothing is looked up in base data;
//   - "@Name": a model a native mod registers with the mesh engine, declared in editor/registered-names.json with
//     kind "model" so the data layer can reference it.
// The path rule is the native one, fw_obj3d_model_path_ok (native/framework/src/fw_obj3d_rules.c); both are tested
// with the same cases (editor/test/model3d-tests.ts, native/framework/test/test_obj3d_rules.c). OBJ only for now.

/** The key, and the block it lives in on a character entry (next to `movieclip`, the 2D fallback). */
export const MODEL_KEY = "model";
export const MODEL_PARENT = "graphics";

/** True for an "@Name" reference to a native-registered model. */
export function isRegisteredModelRef(value: string): boolean {
  return value.length > 1 && value.startsWith("@");
}

/** Why `path` is not an acceptable mod model path, or null when it is (`models/<segments>/<name>.obj`). */
export function modelPathProblem(path: string): string | null {
  if (path === "") return "the path is empty";
  if (path.includes("\\")) return "use forward slashes, not a backslash";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes(":")) return "the path must be relative to the mod folder, not absolute";
  if (!path.startsWith("models/")) return "a model must live under the mod's models/ folder (models/<name>.obj)";
  const segs = path.split("/");
  if (segs.some((s) => s === "")) return "the path has an empty segment (//)";
  if (segs.some((s) => s === "..")) return "the path must not contain .. segments";
  if (!path.endsWith(".obj")) return "only .obj models are supported for now";
  if (segs[segs.length - 1] === ".obj") return "the file name is missing (models/<name>.obj)";
  if (/[^\x20-\x7e]/.test(path)) return "the path must be printable ASCII";
  if (path.length >= 64) return "the path is too long (the framework stores at most 63 bytes)";
  return null;
}
