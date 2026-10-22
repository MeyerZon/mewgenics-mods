// usePref(key, fallback): a component's view of one prefs.ts value; it re-renders when setPref writes any pref.

import React from "react";
import { getPref, subscribePrefs, type PrefKey, type PrefValue } from "../prefs.ts";

export function usePref<T extends PrefValue>(key: PrefKey, fallback: T): T {
  const read = () => getPref(key, fallback);
  return React.useSyncExternalStore(subscribePrefs, read, read);
}
