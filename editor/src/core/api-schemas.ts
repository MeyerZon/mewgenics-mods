// Request-body schemas for the editor's HTTP bridge (web/server) — one zod schema per POST
// route, shared with the browser client so a request is typed at both ends. The server
// answers a body that fails here with 400 + the zod issues; the handlers then only ever see
// data of the declared shape. The core API itself keeps its own safety checks (repo.ts):
// this is the transport gate, not the authority.
//
// Pure TS, no DOM: Node runs it directly for the web server and the tests; Vite bundles it
// for the browser.

import { z } from "zod";

const str = z.string();
const anyObject = z.record(z.string(), z.unknown());

export const WriteBody = z.object({ mod: str, path: str, content: str });

export const ValidateBody = z
  .object({ mod: str, path: str.optional(), text: str.optional() })
  .refine((b) => (b.path === undefined) === (b.text === undefined), {
    message: "path and text are an override pair: send both or neither",
    path: ["text"],
  });

export const PreviewBody = z.object({
  mod: str,
  path: str,
  text: str.optional(),
  includeFullGon: z.boolean().optional(),
});

/** Mirrors TemplateKind in src/core/templates. */
export const TemplateKind = z.enum(["ability", "passive", "item", "status-data", "room", "tileset-variant", "particle", "vfx-ability"]);
/** Mirrors the abc modes buildSwf accepts (src/core/art/art-io). */
export const AbcMode = z.enum(["none", "stub"]);
/** Mirrors SWF_GATE_VARIANTS in src/core/art/art-io. */
export const SwfGateVariant = z.enum(["flat", "nested", "legacy", "control", "missing", "probe"]);

export const TemplateBody = z.object({
  mod: str,
  kind: TemplateKind,
  name: str,
  options: anyObject.default({}),
});

export const ArtSceneWriteBody = z.object({
  mod: str,
  path: str,
  scene: anyObject,
  force: z.boolean().optional(),
});

export const ArtNewSceneBody = z.object({
  mod: str,
  name: str,
  starter: z.boolean().optional(),
  /** "cat-animation": a rig + the _Append_CatTest donor with <animation>F / <animation>B frames */
  template: z.enum(["cat-animation"]).optional(),
  animation: str.optional(),
});

export const ArtValidateBody = z.object({ scene: anyObject, mod: str.optional() });

export const ArtExportSvgBody = z.object({
  mod: str,
  path: str,
  shapeId: str,
});

export const ArtImportSvgBody = z.object({
  svgText: str,
  mod: str.optional(),
  path: str.optional(),
  options: anyObject.default({}),
});

export const ArtBuildBody = z.object({
  mod: str,
  path: str,
  abc: AbcMode.optional(),
  scene: anyObject.optional(),
  writeSwflist: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});

export const ArtAssetBody = z.object({ mod: str, path: str, base64: str });

export const PrepareSwfGateBody = z.object({
  mod: str.optional(),
  variant: SwfGateVariant.default("flat"),
});

/** Export… (docs/data-mods.md "Shipping a mod"): pack mods/<mod>/ into editor/data/dist/. */
export const ModPackBody = z.object({ mod: str, force: z.boolean().optional(), init: z.boolean().optional() });
/** Import mod…: the zip's bytes; always installs into the repo's mods/ (strict: no `into`). */
export const ModInstallBody = z.strictObject({ base64: str, fileName: str.optional(), acceptBuildMismatch: z.boolean().optional() });
// ---- rooms (src/core/level/lvl.ts LvlFile; ranges are checked by the core's structuralErrors) ----
const int = z.number().int();
export const LvlChoiceSchema = z.object({ id: int, weight: int });
/** A palette id, or a weighted random list (0xffff + list in the file). */
export const LvlPickSchema = z.union([int, z.array(LvlChoiceSchema)]);
export const LvlFileSchema = z.object({
  version: int,
  width: int,
  height: int,
  objectPalette: str,
  tilePalette: str,
  tiles: z.array(LvlPickSchema),
  objects: z.array(z.object({ x: int, y: int, id: LvlPickSchema })),
  raw: z.object({ layers: int, a: int, b: int, width2: int, height2: int, pad1: int, pad2: int, trailer: int }).optional(),
});

export const LevelWriteBody = z.object({ mod: str, path: str, level: LvlFileSchema, dryRun: z.boolean().optional() });
export const LevelValidateBody = z.object({ mod: str, path: str, level: LvlFileSchema });

/** Route → body schema. Keys are the exact POST paths web/server serves. */
export const API_BODY = {
  "/api/write": WriteBody,
  "/api/validate": ValidateBody,
  "/api/preview": PreviewBody,
  "/api/template": TemplateBody,
  "/api/art/scene": ArtSceneWriteBody,
  "/api/art/new-scene": ArtNewSceneBody,
  "/api/art/validate": ArtValidateBody,
  "/api/art/import-svg": ArtImportSvgBody,
  "/api/art/export-svg": ArtExportSvgBody,
  "/api/art/build": ArtBuildBody,
  "/api/art/asset": ArtAssetBody,
  "/api/art/prepare-swf-gate": PrepareSwfGateBody,
  "/api/mod/pack": ModPackBody,
  "/api/mod/install": ModInstallBody,
  "/api/level": LevelWriteBody,
  "/api/level/validate": LevelValidateBody,
} as const;

export type PostRoute = keyof typeof API_BODY;
/** What a client may send for a route (defaults still optional). */
export type ApiBodyInput<R extends PostRoute> = z.input<(typeof API_BODY)[R]>;
/** What a handler receives for a route (defaults applied). */
export type ApiBody<R extends PostRoute> = z.output<(typeof API_BODY)[R]>;

export interface BodyIssue {
  path: (string | number)[];
  message: string;
}

export class BodyError extends Error {
  readonly issues: BodyIssue[];
  constructor(route: string, issues: BodyIssue[]) {
    super(`invalid request body for ${route}: ${issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
    this.name = "BodyError";
    this.issues = issues;
  }
}

/** Parse a raw JSON body for a route; throws BodyError (→ HTTP 400) when it does not fit. */
export function parseBody<R extends PostRoute>(route: R, raw: unknown): ApiBody<R> {
  const r = API_BODY[route].safeParse(raw);
  if (r.success) return r.data as ApiBody<R>;
  throw new BodyError(
    route,
    r.error.issues.map((i) => ({ path: i.path.map((p) => (typeof p === "symbol" ? String(p) : p)), message: i.message })),
  );
}
