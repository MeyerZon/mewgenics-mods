// Per-viewer view preferences (docs/editor-ts-react-plan.md "Art mode (PR 4)"): small JSON values under
// `mewged.prefs.<key>` in localStorage (state.ts lsGet / lsSet, which already swallow a blocked or absent storage).
// They are conveniences — the preview's raw-gray toggle, background, loop, ghost cat — never data a mod depends on,
// so a missing or unreadable value simply reads as the fallback. The pre-prefs key `mewged.art.ghostCat` ("0" = off)
// is migrated on the first read. `subscribePrefs` feeds the usePref hook (hooks/usePref.ts).

import { lsGet, lsSet } from "./state.ts";

export type PrefKey = "art.showGray" | "art.background" | "art.loop" | "art.ghostCat";
export type PrefValue = boolean | string | number;

export const PREF_PREFIX = "mewged.prefs.";

/** Keys that existed before prefs.ts, read once when the new key is unset. */
const LEGACY: Partial<Record<PrefKey, { key: string; decode: (raw: string) => PrefValue }>> = {
  "art.ghostCat": { key: "mewged.art.ghostCat", decode: (raw) => raw !== "0" },
};

export interface PrefStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const LOCAL: PrefStorage = { get: lsGet, set: lsSet };
let storage: PrefStorage = LOCAL;

/** Swap the backing storage (tests); null restores localStorage. */
export function setPrefStorage(next: PrefStorage | null): void {
  storage = next || LOCAL;
}

const listeners = new Set<() => void>();
export function subscribePrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The stored value of `key`, or `fallback` when it is unset, unparseable or of another type than the fallback. */
export function getPref<T extends PrefValue>(key: PrefKey, fallback: T): T {
  const raw = storage.get(PREF_PREFIX + key);
  if (raw === null) {
    const legacy = LEGACY[key];
    const old = legacy ? storage.get(legacy.key) : null;
    if (legacy && old !== null) {
      const v = legacy.decode(old);
      if (typeof v === typeof fallback) {
        storage.set(PREF_PREFIX + key, JSON.stringify(v));
        return v as T;
      }
    }
    return fallback;
  }
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === typeof fallback ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

export function setPref(key: PrefKey, value: PrefValue): void {
  storage.set(PREF_PREFIX + key, JSON.stringify(value));
  for (const l of [...listeners]) l();
}
