// RED stub: the shared model code list (design §2.6) — filled in by the green commit.
export type ModelCodeSeverity = "error" | "warning" | "info";
export interface ModelCode { readonly code: string; readonly severity: ModelCodeSeverity; readonly meaning: string }
export const MODEL_CODES: readonly ModelCode[] = [];
export function modelCodeInfo(code: string): ModelCode | undefined { return MODEL_CODES.find((c) => c.code === code); }
