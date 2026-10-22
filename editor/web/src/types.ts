// Response shapes of the /api bridge as the data-mode UI reads them. Derived from the core's
// JSDoc (src/core/api.ts → mod-io, validate/result, preview-merge, base-data, components,
// templates). Type aliases (not interfaces) where a value must also satisfy an index-signature
// parameter such as buildTree's.

export type OverlayMode = "append" | "merge" | "patch" | "replace";
export type FileType = "gon" | "csv" | "txt" | "other";
export type TemplateKindName = "ability" | "passive" | "item" | "status-data" | "room" | "tileset-variant" | "particle" | "vfx-ability" | "glowing-character";

/** One file of a mod (mod-io ModFileInfo). */
export type ModFileInfo = {
  relPath: string;
  bytes: number;
  baseName: string;
  mode: OverlayMode;
  fileType: FileType;
};

export type ReadModResult =
  | { ok: true; name: string; description: unknown; files: ModFileInfo[] }
  | { ok: false; error: string };

export type ReadFileResult = { ok: true; text: string } | { ok: false; error: string };

export type WriteResult = { ok: true; path: string; bytes: number } | { ok: false; error: string };

export interface ListModsResult {
  mods: string[];
}

// ---- validation (validate/result) -------------------------------------------------------
export type Severity = "error" | "warning" | "info";

export interface SourceLocation {
  file?: string;
  line?: number;
  col?: number;
  path?: string;
}

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
  location?: SourceLocation;
}

export interface Report {
  ok: boolean;
  findings: Finding[];
  counts: { errors: number; warnings: number; infos: number };
}

// ---- merge preview (preview-merge) ---------------------------------------------------------
export interface TouchedEntry {
  key: string;
  status: "added" | "changed" | "unchanged";
  base: string | null;
  effective: string | null;
  /** set when the key now occurs more than once (an `.append` of an existing name); `effective` is the last copy, the one the game's by-name lookup sees */
  occurrences?: number;
}

export interface GonPreview {
  ok: true;
  kind: "gon";
  mode: OverlayMode;
  baseExists: boolean;
  touched: TouchedEntry[];
  effectiveEntryCount: number;
  effectiveText?: string;
}

export interface CsvPreview {
  ok: true;
  kind: "csv";
  mode: OverlayMode;
  baseExists: boolean;
  note?: string;
  addedRows?: string[][];
  changedRows?: { rowIndex: number; before: string[]; after: string[] }[];
  effectiveRowCount?: number;
}

export type PreviewResult = { ok: false; error: string } | GonPreview | CsvPreview;

// ---- base data (base-data) -----------------------------------------------------------------
export interface BaseCategory {
  category: string;
  count: number;
}

export interface ListBaseResult {
  hasBaseData: boolean;
  categories: BaseCategory[];
}

export interface ListEntriesResult {
  category: string;
  entries: string[];
}

export type BaseEntryView =
  | { ok: true; category: string; name: string; file: string; gon: string }
  | { ok: false; error: string };

// ---- components (components) ---------------------------------------------------------------
export interface ComponentUsage {
  file: string;
  hits: number;
  sample: string[];
}

export interface ComponentSearchResult {
  query: string;
  count: number;
  names: string[];
  whereUsed?: { name: string; usedIn: ComponentUsage[] }[];
  /** the GON keys the top matches read (editor/component-schema.json) */
  schema?: ComponentKeyInfo[];
}
export interface ComponentKeyInfo {
  name: string;
  chain: string[];
  open: boolean;
  children: string | null;
  required: string[];
  keys: Record<string, { type: string; default: number | boolean | string | null; required: boolean; from: string; unread?: boolean }>;
}

// ---- template scaffolder (templates) -------------------------------------------------------
export type TemplateResult =
  | { ok: true; kind?: string; name?: string; written?: string[]; localizationKeys?: string[]; dryRun?: boolean; hint?: string }
  | { ok: false; error: string; partial?: string[] };

// ---- editor status (GET /api/status: src/core/api.ts editorStatus) --------------------------
export interface BuildComparison {
  status: "match" | "mismatch" | "unknown";
  modBuild: string;
  installedBuild: string | null;
  installedKnown: boolean | null;
  installedTimeDateStamp?: string;
}
export interface EditorStatus {
  gameDir: string;
  exeFound: boolean;
  known: boolean;
  gameBuild: string | null;
  timeDateStamp: string | null;
  knownBuilds: string[];
  extracted: boolean;
  extractedSwfs: boolean;
  frameworkDll: boolean;
  mewtestDll: boolean;
  mewjector: boolean;
  saveSuffix: string;
  modsDir: string;
  mod?: { name: string; gameBuild: string | null; compare: BuildComparison | null };
}
