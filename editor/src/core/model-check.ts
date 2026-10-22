// RED stub: the header-level model reader — filled in by the green commit.
export interface ModelIssue { readonly code: string; readonly message: string }
export function checkModelBytes(_path: string, _bytes: Uint8Array): ModelIssue[] { return []; }
