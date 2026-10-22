// Deep links: ?mode=data|art|rooms&mod=<name>&file=<relPath>. Read once at startup (actions.ts startup) and written
// back with history.replaceState whenever the mode, mod or open file changes (no history entries, no reload). Pure.

export type Mode = "data" | "art" | "rooms";

export interface DeepLink {
  mode: Mode | null;
  mod: string;
  file: string;
}

const MODES: readonly string[] = ["data", "art", "rooms"];

export function readDeepLink(search: string): DeepLink {
  const q = new URLSearchParams(search);
  const m = q.get("mode");
  return { mode: m && MODES.includes(m) ? (m as Mode) : null, mod: q.get("mod") || "", file: q.get("file") || "" };
}

/** `search` with mode / mod / file set (empty values removed); other params are kept in place. */
export function writeDeepLink(search: string, link: { mode: Mode; mod: string; file: string }): string {
  const q = new URLSearchParams(search);
  for (const k of ["mode", "mod", "file"] as const) {
    const v = link[k];
    if (v) q.set(k, v);
    else q.delete(k);
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}
