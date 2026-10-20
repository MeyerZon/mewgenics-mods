// A tiny external store for the editor UI: plain objects, `set(patch)` merges, React reads
// through `useStore(store, selector)` (useSyncExternalStore). It replaces VanJS `van.state`
// one-for-one: `S.mod.val = x` became `S.set({ mod: x })`, `S.mod.val` became
// `useStore(S, (s) => s.mod)` inside a component or `S.get().mod` outside one.
//
// Same-value writes do not notify (van deduped those too), which keeps effects that
// write back into the store from looping. Selectors must return primitives or values
// already held by the state (not fresh objects/arrays) or React re-renders forever.

import React from "react";

export type Patch<T> = Partial<T> | ((current: T) => Partial<T>);

export interface Store<T extends object> {
  get(): T;
  set(patch: Patch<T>): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state: T = initial;
  const listeners = new Set<() => void>();
  const get = () => state;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const set = (patch: Patch<T>) => {
    const next = typeof patch === "function" ? patch(state) : patch;
    let changed = false;
    for (const key of Object.keys(next) as (keyof T)[]) {
      if (!Object.is(next[key], state[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    state = { ...state, ...next };
    for (const l of [...listeners]) l();
  };
  return { get, set, subscribe };
}

/** Subscribe a component to one slice of a store. */
export function useStore<T extends object, R>(store: Store<T>, selector: (state: T) => R): R {
  return React.useSyncExternalStore(
    store.subscribe,
    () => selector(store.get()),
    () => selector(store.get()),
  );
}
