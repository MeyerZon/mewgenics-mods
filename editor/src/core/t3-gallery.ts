// T3 looks gallery — red stub (the tests in test/t3-gallery-tests.ts define the contract).

export type T3Status = "open" | "done";
export interface T3Item { id: string; pr: number; question: string; shots: string[]; regenerate: string; status: T3Status }
export interface ResolvedItem extends T3Item { found: { pattern: string; file: string }[]; missing: string[] }
export type T3Answer = "yes" | "no" | "unsure";
export interface ShotFs { exists: (rel: string) => boolean; list: (relDir: string) => string[] }

export function parseLooks(_text: string): { items: T3Item[]; errors: string[] } { return { items: [], errors: ["not implemented"] }; }
export function resolveShot(_pattern: string, _fs: ShotFs): string | null { return null; }
export function copiedName(rel: string): string { return rel; }
export function summarize(_items: ResolvedItem[]): { total: number; withShots: number; needsRerun: number; handsOn: number } { return { total: 0, withShots: 0, needsRerun: 0, handsOn: 0 }; }
export function buildAnswersExport(_items: { id: string; pr: number; question: string }[], _answers: Record<string, string>, _exportedAt: string): unknown { return null; }
export function renderGallery(_items: ResolvedItem[], _opts: { generatedAt: string; repoUrl: string }): string { return ""; }
