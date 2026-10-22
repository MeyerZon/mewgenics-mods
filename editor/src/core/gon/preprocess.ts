// The game's GON text pre-pass (Gon_Preprocess 0xa50bd0) — skeleton; see docs/engine-map.md "GON parser".

/** Resolves an `#include` name (as written) to the included file's text, or null when it does not exist. */
export type IncludeResolver = (name: string) => string | null;

export interface IncludeUse {
  name: string;
  found: boolean;
  depth: number;
  line: number;
  col: number;
  chain: string[];
  cycle?: boolean;
}

export interface PreprocessResult {
  text: string;
  includes: IncludeUse[];
  defines: string[];
}

export function stripComments(_src: string): { text: string; map: number[] } {
  throw new Error("not implemented");
}

export function preprocess(_src: string, _resolve: IncludeResolver = () => null): PreprocessResult {
  throw new Error("not implemented");
}
