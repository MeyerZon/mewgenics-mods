// Where a GON `#include` resolves (GonResource::decode's include lambda 0x9a7610) — skeleton.

import type { PreprocessResult } from "./gon/preprocess.ts";

export interface IncludeContext {
  resource: string;
  dataRoot?: string;
  modDir?: string;
}

export interface IncludeTarget {
  packPath: string;
  outside: boolean;
  source: "mod" | "base" | null;
  overlays: string[];
  text: string | null;
}

export function locateInclude(_ctx: IncludeContext, _name: string): IncludeTarget {
  throw new Error("not implemented");
}

export function preprocessFile(_text: string, _ctx: IncludeContext): PreprocessResult {
  throw new Error("not implemented");
}
